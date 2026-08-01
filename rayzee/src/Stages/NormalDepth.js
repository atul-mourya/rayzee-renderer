import { Fn, vec3, vec4, float, int, uint, uvec2, uniform, normalize, mat3, min, storage, If,
	textureStore, workgroupId, localId } from 'three/tsl';
import { RenderTarget, StorageTexture } from 'three/webgpu';
import { HalfFloatType, RGBAFormat, NearestFilter, Matrix4, Box2, Vector2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { MAX_STORAGE_TEXTURE_SIZE } from '../EngineDefaults.js';
import { Ray, HitInfo, RayTracingMaterial, UVCache } from '../TSL/Struct.js';
import { traverseBVH } from '../TSL/BVHTraversal.js';
import { getMaterial } from '../TSL/Common.js';
import { computeUVCache, processNormal, processBump, buildBucketTextureNodes, refreshBucketTextureNodes, setMaterialBucketTextures } from '../TSL/TextureSampling.js';

/**
 * NormalDepth — primary-ray G-buffer for SVGF gates.
 *
 * RGB = geometric world normal · 0.5 + 0.5, A = linear ray distance (sky=65504, the
 * max HalfFloat value — a finite sentinel so miss−miss depth diffs stay 0, not Inf−Inf=NaN).
 * Geometric (not shading) normals because shading normals carry sub-pixel
 * jitter that breaks the temporal gate's same-pixel-across-frames comparison.
 * The path tracer's MRT already carries shading normals for OIDN; this stage
 * is a separate, cheap, jitter-free signal for the denoiser.
 *
 * Ping-pong RenderTargets hold current/prev. On a dispatch we swap so prev
 * is last frame's geometry. On a skipped dispatch (static camera) prev
 * aliases current — without that aliasing prev would point at older data
 * while this frame's motion vector reflects zero motion → false rejection.
 *
 * Also emits a SHADING normal (geometric normal perturbed by the normal/bump
 * map, recomputed from the SAME deterministic hit — no extra ray) so the
 * spatial denoiser's edge-stop can see normal-map detail the flat geometric
 * normal hides. Deterministic ⇒ jitter-free, so it's safe for the gates.
 *
 * Publishes: pathtracer:normalDepth, pathtracer:prevNormalDepth,
 *            pathtracer:shadingNormal
 */
export class NormalDepth extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'NormalDepth', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;
		this.pathTracer = options.pathTracer;

		this._dirty = true;

		this.cameraWorldMatrix = uniform( new Matrix4(), 'mat4' );
		this.cameraProjectionMatrixInverse = uniform( new Matrix4(), 'mat4' );
		this.resolutionWidth = uniform( options.width || 1 );
		this.resolutionHeight = uniform( options.height || 1 );

		const w = options.width || 1;
		const h = options.height || 1;

		// StorageTexture stays at max alloc — see resize crash fix (three.js #33061).
		this._outputStorageTex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._outputStorageTex.type = HalfFloatType;
		this._outputStorageTex.format = RGBAFormat;
		this._outputStorageTex.minFilter = NearestFilter;
		this._outputStorageTex.magFilter = NearestFilter;

		// Shading-normal output (geometric normal perturbed by normal/bump map).
		// Single buffer — only the spatial filter (current frame) consumes it.
		this._shadingStorageTex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._shadingStorageTex.type = HalfFloatType;
		this._shadingStorageTex.format = RGBAFormat;
		this._shadingStorageTex.minFilter = NearestFilter;
		this._shadingStorageTex.magFilter = NearestFilter;
		this._shadingRT = new RenderTarget( w, h, {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		// Ping-pong RTs share format with the StorageTexture so copyTextureToTexture works.
		const rtOpts = {
			type: HalfFloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false
		};
		this._rtA = new RenderTarget( w, h, rtOpts );
		this._rtB = new RenderTarget( w, h, rtOpts );
		this._currentIdx = 0;
		this._hasHistory = false;

		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		this._triStorageNode = null;
		this._bvhStorageNode = null;
		this._matStorageNode = null;
		this._lastTriAttr = null;
		this._lastBvhAttr = null;
		this._lastMatAttr = null;
		this._computeNode = null;
		this._computeBuilt = false;

		// Independent linear-pool bucket nodes for this pipeline (normal + bump live in the
		// linear pool). Built lazily in _buildCompute from the path tracer's materialData;
		// value-swapped on model load. processNormal/processBump runtime-guard on map indices.
		this._linearBuckets = null;

	}

	setupEventListeners() {

		this.on( 'camera:moved', () => {

			this._dirty = true;

		} );

		this.on( 'pipeline:reset', () => {

			// _hasHistory is deliberately NOT cleared, mirroring MotionVector.reset(): the
			// prev-frame G-buffer tracks camera motion, not accumulation, and a camera move
			// resets accumulation every frame of a drag. Clearing it made render() overwrite
			// prevRT with the current frame, so ASVGF's temporal gate could never reject.
			this._dirty = true;

		} );

	}

	_syncStorageBuffers() {

		const pt = this.pathTracer;
		if ( ! pt ) return false;

		const matAttr = pt.materialData?.materialStorageAttr;
		const triSwapped = pt.triangleStorageAttr && pt.triangleStorageAttr !== this._lastTriAttr;
		const bvhSwapped = pt.bvhStorageAttr && pt.bvhStorageAttr !== this._lastBvhAttr;
		const matSwapped = matAttr && matAttr !== this._lastMatAttr;

		if ( triSwapped || bvhSwapped || matSwapped ) {

			// Buffer identity changed → compute's bind group is stale; rebuild.
			this._computeNode?.dispose?.();
			this._computeNode = null;
			this._computeBuilt = false;
			this._triStorageNode = null;
			this._bvhStorageNode = null;
			this._matStorageNode = null;
			this._dirty = true;
			// New geometry — the previous frame describes a scene that is no longer there.
			this._hasHistory = false;

		}

		if ( pt.triangleStorageAttr && ! this._triStorageNode ) {

			this._triStorageNode = storage(
				pt.triangleStorageAttr, 'vec4', pt.triangleStorageAttr.count
			).toReadOnly();

		}

		if ( pt.bvhStorageAttr && ! this._bvhStorageNode ) {

			this._bvhStorageNode = storage(
				pt.bvhStorageAttr, 'vec4', pt.bvhStorageAttr.count
			).toReadOnly();

		}

		if ( matAttr && ! this._matStorageNode ) {

			this._matStorageNode = storage( matAttr, 'vec4', matAttr.count ).toReadOnly();

		}

		// In-place bucket swaps (model change) — graph closes over the nodes, only .value changes.
		if ( this._linearBuckets ) refreshBucketTextureNodes( this._linearBuckets, pt.materialData?.linearBuckets );

		this._lastTriAttr = pt.triangleStorageAttr || this._lastTriAttr;
		this._lastBvhAttr = pt.bvhStorageAttr || this._lastBvhAttr;
		this._lastMatAttr = matAttr || this._lastMatAttr;

		return !! ( this._triStorageNode && this._bvhStorageNode && this._matStorageNode );

	}

	_buildCompute() {

		const triStorage = this._triStorageNode;
		const bvhStorage = this._bvhStorageNode;
		const matStorage = this._matStorageNode;
		// Independent linear-pool bucket nodes for this pipeline (normal + bump). The sRGB pool
		// is never sampled here, so it gets placeholders. Publish to the sampling module before
		// the graph is built so processNormal/processBump bake in THESE (per-pipeline) nodes.
		this._linearBuckets = buildBucketTextureNodes( this.pathTracer?.materialData?.linearBuckets );
		setMaterialBucketTextures( buildBucketTextureNodes( null ), this._linearBuckets );
		const camWorld = this.cameraWorldMatrix;
		const camProjInv = this.cameraProjectionMatrixInverse;
		const resW = this.resolutionWidth;
		const resH = this.resolutionHeight;
		const outputTex = this._outputStorageTex;
		const shadingTex = this._shadingStorageTex;

		const WG_SIZE = 8;

		// mat4 uniforms as Fn parameters so TSL emits bracket indexing
		// (closure captures don't get this).
		const computeFn = Fn( ( [ camWorldMat, camProjInvMat ] ) => {

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				// Pixel center → NDC, Y negated for Three.js WebGPU.
				const ndcX = float( gx ).add( 0.5 ).div( resW ).mul( 2.0 ).sub( 1.0 );
				const ndcY = float( gy ).add( 0.5 ).div( resH ).mul( 2.0 ).sub( 1.0 ).negate();
				const ndcPos = vec3( ndcX, ndcY, 1.0 );

				// No jitter — deterministic per-pixel ray so the temporal gate
				// sees stable per-pixel normals across frames.
				const rayDirCS = camProjInvMat.mul( vec4( ndcPos, 1.0 ) );
				const rayDirWorld = normalize(
					mat3(
						camWorldMat[ 0 ].xyz,
						camWorldMat[ 1 ].xyz,
						camWorldMat[ 2 ].xyz
					).mul( rayDirCS.xyz.div( rayDirCS.w ) )
				);
				const rayOrigin = vec3( camWorldMat[ 3 ] );

				const ray = Ray( { origin: rayOrigin, direction: rayDirWorld } );
				const hit = HitInfo.wrap( traverseBVH( ray, bvhStorage, triStorage ) );

				const encodedNormal = hit.normal.mul( 0.5 ).add( 0.5 );
				// Clamp to the max finite HalfFloat: a hit farther than 65504 units would otherwise
				// round to +Inf in the f16 texture (on backends that don't clamp), reintroducing the
				// Inf-Inf=NaN in the denoiser depth weights that the finite miss-sentinel avoids.
				const depth = min( hit.dst, float( 65504.0 ) );

				const result = hit.didHit.select(
					vec4( encodedNormal, depth ),
					vec4( 0.0, 0.0, 0.0, float( 65504.0 ) )
				);

				textureStore(
					outputTex,
					uvec2( uint( gx ), uint( gy ) ),
					result
				).toWriteOnly();

				// Shading normal: perturb the geometric normal by the normal/bump map
				// from the SAME hit (deterministic UV → jitter-free). Miss → geo default.
				const shadingNormal = hit.normal.toVar();
				If( hit.didHit, () => {

					const material = RayTracingMaterial.wrap(
						getMaterial( hit.materialIndex, matStorage )
					).toVar();
					const uvCache = UVCache.wrap( computeUVCache( hit.uv, material ) ).toVar();
					const mapped = processNormal( hit.normal, material, uvCache ).toVar();
					shadingNormal.assign( processBump( mapped, material, uvCache ) );

				} );

				const shadingResult = hit.didHit.select(
					vec4( shadingNormal.mul( 0.5 ).add( 0.5 ), depth ),
					vec4( 0.0, 0.0, 0.0, float( 65504.0 ) )
				);

				textureStore(
					shadingTex,
					uvec2( uint( gx ), uint( gy ) ),
					shadingResult
				).toWriteOnly();

			} );

		} );

		this._computeNode = computeFn( camWorld, camProjInv ).compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

		this._computeBuilt = true;

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const buffersReady = this._syncStorageBuffers();
		if ( ! buffersReady ) return;

		if ( ! this._computeBuilt ) this._buildCompute();

		const pt = this.pathTracer;
		if ( pt ) {

			this.cameraWorldMatrix.value.copy( pt.uniforms.get( 'cameraWorldMatrix' ).value );
			this.cameraProjectionMatrixInverse.value.copy( pt.uniforms.get( 'cameraProjectionMatrixInverse' ).value );

		}

		// Static camera: republish current and alias prev to current. Without
		// the alias, prev would still hold older geometry while motion vector
		// reflects zero motion → false rejection at every pixel.
		if ( ! this._dirty && this._hasHistory ) {

			const currentRT = this._currentIdx === 0 ? this._rtA : this._rtB;
			context.setTexture( 'pathtracer:normalDepth', currentRT.texture );
			context.setTexture( 'pathtracer:prevNormalDepth', currentRT.texture );
			context.setTexture( 'pathtracer:shadingNormal', this._shadingRT.texture );
			return;

		}

		const ptColor = context.getTexture( 'pathtracer:color' );
		if ( ptColor && ptColor.image ) {

			const img = ptColor.image;
			if ( img.width > 0 && img.height > 0 &&
				( img.width !== this._rtA.width || img.height !== this._rtA.height ) ) {

				this.setSize( img.width, img.height );

			}

		}

		// Swap roles: what was current becomes prev, write into the free slot.
		if ( this._hasHistory ) this._currentIdx = 1 - this._currentIdx;
		const writeRT = this._currentIdx === 0 ? this._rtA : this._rtB;
		const prevRT = this._currentIdx === 0 ? this._rtB : this._rtA;

		this.renderer.compute( this._computeNode );

		// Copy only the active region out of the over-allocated StorageTextures.
		this._srcRegion.max.set( writeRT.width, writeRT.height );
		this.renderer.copyTextureToTexture( this._outputStorageTex, writeRT.texture, this._srcRegion );
		this.renderer.copyTextureToTexture( this._shadingStorageTex, this._shadingRT.texture, this._srcRegion );

		// First dispatch: seed prev from current so ASVGF doesn't see false
		// disocclusion on frame 1.
		if ( ! this._hasHistory ) {

			this.renderer.copyTextureToTexture( this._outputStorageTex, prevRT.texture, this._srcRegion );
			this._hasHistory = true;

		}

		context.setTexture( 'pathtracer:normalDepth', writeRT.texture );
		context.setTexture( 'pathtracer:prevNormalDepth', prevRT.texture );
		context.setTexture( 'pathtracer:shadingNormal', this._shadingRT.texture );

		this._dirty = false;

	}

	// Free the 2048² StorageTextures when disabled (no consumer); three.js re-creates them on the next
	// dispatch after re-enable, and reset() re-arms the dirty/history fast-path. See ASVGF.releaseGPUMemory.
	releaseGPUMemory() {

		this._outputStorageTex?.dispose();
		this._shadingStorageTex?.dispose();
		this.reset();
		// The textures backing the ping-pong are gone, so the prev-frame G-buffer is too.
		this._hasHistory = false;

	}

	// Accumulation reset only — _hasHistory survives on purpose (see the pipeline:reset
	// listener). It is invalidated by setSize(), a geometry swap, and releaseGPUMemory().
	reset() {

		this._dirty = true;

	}

	setSize( width, height ) {

		// StorageTexture stays at its max allocation (see constructor).
		// RenderTarget.setSize() updates width/height but does NOT bump
		// texture.version, so copyTextureToTexture's GPU texture would stay at
		// the old size — needsUpdate forces the resize to take effect.
		this._rtA.setSize( width, height );
		this._rtA.texture.needsUpdate = true;
		this._rtB.setSize( width, height );
		this._rtB.texture.needsUpdate = true;
		this._shadingRT.setSize( width, height );
		this._shadingRT.texture.needsUpdate = true;
		this._hasHistory = false;
		this.resolutionWidth.value = width;
		this.resolutionHeight.value = height;

		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		if ( this._computeNode ) {

			this._computeNode.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

		}

		this._dirty = true;

	}

	// Reserved-storage change (e.g. 4K toggle): recreate the MAX-preallocated StorageTextures at the new live
	// reserved size. The compute node rebuilds lazily on the next execute (guarded by _computeBuilt).
	reallocateReservedStorage() {

		this._computeNode?.dispose();
		this._computeNode = null;
		this._outputStorageTex?.dispose();
		this._shadingStorageTex?.dispose();
		const mk = () => {

			const t = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
			t.type = HalfFloatType; t.format = RGBAFormat; t.minFilter = NearestFilter; t.magFilter = NearestFilter;
			return t;

		};

		this._outputStorageTex = mk();
		this._shadingStorageTex = mk();
		this._computeBuilt = false;

	}

	dispose() {

		this._computeNode?.dispose();
		this._outputStorageTex?.dispose();
		this._shadingStorageTex?.dispose();
		this._shadingRT?.dispose();
		this._rtA?.dispose();
		this._rtB?.dispose();

	}

}
