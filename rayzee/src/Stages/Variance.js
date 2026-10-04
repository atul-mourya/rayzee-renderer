import { Fn, wgslFn, float, int, uint, ivec2, uvec2, uniform, If, max, select,
	textureLoad, textureStore, workgroupArray, workgroupBarrier, localId, workgroupId } from 'three/tsl';
import { RenderTarget, TextureNode, StorageTexture } from 'three/webgpu';
import { FloatType, RGBAFormat, LinearFilter, Box2, Vector2 } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { luminance } from '../TSL/Common.js';
import { MAX_STORAGE_TEXTURE_SIZE } from '../Processor/StorageTexturePool.js';

// NaN/±Inf guard: a poisoned luminance would otherwise corrupt the moment EMA forever
// (mean/meanSq → variance → BilateralFilter sigmaL). NaN (x!=x) → 0, ±Inf → [0,1e7].
const sanitizeLum = ( x ) => select( x.equal( x ), x, float( 0.0 ) ).clamp( 0.0, 1e7 );

// ── wgslFn helpers ──────────────────────────────────────────

/**
 * Temporal moment accumulation via exponential moving average.
 *
 * Returns vec4f(newMean, newMeanSq, temporalVariance * boost, spatialVariance * boost).
 */
const temporalAccumulate = /*@__PURE__*/ wgslFn( `
	fn temporalAccumulate(
		lum: f32,
		prevMean: f32,
		prevMeanSq: f32,
		alpha: f32,
		spatialVariance: f32,
		varianceBoost: f32
	) -> vec4f {

		let newMean = prevMean + ( lum - prevMean ) * alpha;
		let newMeanSq = prevMeanSq + ( lum * lum - prevMeanSq ) * alpha;
		let temporalVariance = max( newMeanSq - newMean * newMean, 0.0 );

		return vec4f(
			newMean,
			newMeanSq,
			temporalVariance * varianceBoost,
			spatialVariance * varianceBoost
		);

	}
` );

/**
 * WebGPU Variance Estimation Stage (Compute Shader)
 *
 * Computes temporal and spatial variance from the path tracer output.
 * Used by BilateralFilter for variance-guided filtering.
 *
 * Uses compute shader with workgroup shared memory for the 3×3
 * spatial variance computation. Each 8×8 workgroup loads a 10×10
 * luminance tile into shared memory.
 *
 * Ping-pong between two StorageTextures for temporal moment
 * accumulation — two compute nodes, one for each write direction.
 *
 * Algorithm:
 *   1. Cooperative tile loading → shared memory (luminance from color)
 *   2. Barrier
 *   3. Spatial variance from 3×3 shared memory neighbourhood
 *   4. Temporal accumulation via textureLoad on previous moments
 *   5. Write (mean, meanSq, temporalVar, spatialVar) to StorageTexture
 *
 * Output format (RGBA HalfFloat):
 *   R — mean luminance
 *   G — second moment (mean of squared luminance)
 *   B — temporal variance
 *   A — spatial variance
 *
 * Execution: ALWAYS
 *
 * Textures published:  variance:output
 * Textures read:       configurable (default pathtracer:color)
 */
export class Variance extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'VarianceEstimation', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;
		this.inputTextureName = options.inputTextureName || 'pathtracer:color';

		// Parameters
		this.varianceBoost = uniform( options.varianceBoost ?? 1.0 );
		this.temporalAlpha = uniform( options.temporalAlpha ?? 0.1 );
		this.resW = uniform( options.width || 1 );
		this.resH = uniform( options.height || 1 );

		// Input texture node
		this._colorTexNode = new TextureNode();

		// Ping-pong StorageTextures for temporal moments
		const w = options.width || 1;
		const h = options.height || 1;

		// LinearFilter so downstream fragment shaders can sample these without hitting
		// Three.js WGSL codegen bug (textureLoad without level for StorageTextures)
		// FloatType (f32) required — HalfFloat's ~3.3 decimal digits cause catastrophic
		// cancellation in (meanSq - mean²) for converged pixels, producing a variance
		// floor of ~0.0001 that the (frame+1)² scaling amplifies to enormous values.
		// StorageTextures over-allocated at max — defensive against three.js #33061
		// (TSL compute pipeline keeps stale GPUTextureView after StorageTexture.setSize).
		this._storageTexA = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._storageTexA.type = FloatType;
		this._storageTexA.format = RGBAFormat;
		this._storageTexA.minFilter = LinearFilter;
		this._storageTexA.magFilter = LinearFilter;

		this._storageTexB = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
		this._storageTexB.type = FloatType;
		this._storageTexB.format = RGBAFormat;
		this._storageTexB.minFilter = LinearFilter;
		this._storageTexB.magFilter = LinearFilter;

		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		// Right-sized RenderTarget published to downstream (UV-sampled). The
		// over-allocated StorageTexture itself must not be published — UV
		// sampling a 2048 texture would read the wrong region.
		this._outputTarget = new RenderTarget( w, h, {
			type: FloatType,
			format: RGBAFormat,
			minFilter: LinearFilter,
			magFilter: LinearFilter,
			depthBuffer: false,
			stencilBuffer: false
		} );

		this.currentMoments = 0; // 0 = write A, read B; 1 = write B, read A
		this._compiled = false;
		this._needsWarmReset = false;

		// Dispatch dimensions
		this._dispatchX = Math.ceil( w / 8 );
		this._dispatchY = Math.ceil( h / 8 );

		this._buildCompute();

	}

	setupEventListeners() {

		this.on( 'pathtracer:viewpointChanged', () => this.reset() );

	}

	/**
	 * Build two compute nodes — one for each ping-pong direction.
	 *
	 * _computeNodeA: writes to StorageTexA, reads previous moments from StorageTexB
	 * _computeNodeB: writes to StorageTexB, reads previous moments from StorageTexA
	 *
	 * Read-side textures wrapped in TextureNode so compile-time type is regular Texture
	 * (avoids Three.js WGSL codegen bug: textureLoad without level for StorageTexture).
	 * Values are set to actual StorageTextures in render().
	 */
	_buildCompute() {

		// TextureNode wrappers for reading ping-pong textures
		// Default to EmptyTexture at compile time → codegen includes level parameter
		this._readTexNodeA = new TextureNode();
		this._readTexNodeB = new TextureNode();

		// A writes to StorageTexA, reads previous moments from B
		this._computeNodeA = this._buildComputeForDirection( this._storageTexA, this._readTexNodeB );
		// B writes to StorageTexB, reads previous moments from A
		this._computeNodeB = this._buildComputeForDirection( this._storageTexB, this._readTexNodeA );

	}

	_buildComputeForDirection( writeStorageTex, readTexNode ) {

		const colorTex = this._colorTexNode;
		const alpha = this.temporalAlpha;
		const varianceBoost = this.varianceBoost;
		const resW = this.resW;
		const resH = this.resH;

		const TILE_W = 10;
		const TILE_TOTAL = TILE_W * TILE_W; // 100
		const WG_SIZE = 8;
		const WG_THREADS = WG_SIZE * WG_SIZE; // 64
		const EXTRA_LOAD = TILE_TOTAL - WG_THREADS; // 36

		const sharedLum = workgroupArray( 'float', TILE_TOTAL );

		const computeFn = Fn( () => {

			const lx = localId.x;
			const ly = localId.y;
			const linearIdx = ly.mul( WG_SIZE ).add( lx );

			// Tile origin in global image coords (1px border before the core)
			const tileOriginX = int( workgroupId.x ).mul( WG_SIZE ).sub( 1 );
			const tileOriginY = int( workgroupId.y ).mul( WG_SIZE ).sub( 1 );

			// ── Cooperative tile loading ─────────────────────

			// Load #1: all 64 threads load positions 0-63
			const sx1 = linearIdx.mod( TILE_W );
			const sy1 = linearIdx.div( TILE_W );
			const gx1 = tileOriginX.add( int( sx1 ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
			const gy1 = tileOriginY.add( int( sy1 ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );

			const sColor1 = textureLoad( colorTex, ivec2( gx1, gy1 ) ).xyz;
			sharedLum.element( linearIdx ).assign( sanitizeLum( luminance( sColor1 ) ) );

			// Load #2: threads 0-35 load positions 64-99
			If( linearIdx.lessThan( uint( EXTRA_LOAD ) ), () => {

				const idx2 = linearIdx.add( uint( WG_THREADS ) );
				const sx2 = idx2.mod( TILE_W );
				const sy2 = idx2.div( TILE_W );
				const gx2 = tileOriginX.add( int( sx2 ) ).clamp( int( 0 ), int( resW ).sub( 1 ) );
				const gy2 = tileOriginY.add( int( sy2 ) ).clamp( int( 0 ), int( resH ).sub( 1 ) );

				const sColor2 = textureLoad( colorTex, ivec2( gx2, gy2 ) ).xyz;
				sharedLum.element( idx2 ).assign( sanitizeLum( luminance( sColor2 ) ) );

			} );

			workgroupBarrier();

			// ── Per-thread computation ───────────────────────

			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( lx ) );
			const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( ly ) );

			If( gx.lessThan( int( resW ) ).and( gy.lessThan( int( resH ) ) ), () => {

				// ── Spatial variance from 3×3 shared memory ──

				const spatMean = float( 0.0 ).toVar();
				const spatMeanSq = float( 0.0 ).toVar();

				for ( let dy = - 1; dy <= 1; dy ++ ) {

					for ( let dx = - 1; dx <= 1; dx ++ ) {

						const val = sharedLum.element(
							ly.add( 1 + dy ).mul( TILE_W ).add( lx.add( 1 + dx ) )
						);
						spatMean.addAssign( val );
						spatMeanSq.addAssign( val.mul( val ) );

					}

				}

				spatMean.divAssign( 9.0 );
				spatMeanSq.divAssign( 9.0 );
				const spatialVariance = max( spatMeanSq.sub( spatMean.mul( spatMean ) ), float( 0.0 ) );

				// ── Temporal accumulation ─────────────────────
				// Current luminance from center of shared memory tile
				const lum = sharedLum.element( ly.add( 1 ).mul( TILE_W ).add( lx.add( 1 ) ) );

				// Previous moments via textureLoad (per-pixel, not tiled)
				const prevMoments = textureLoad( readTexNode, ivec2( gx, gy ) );

				// ── Write output ──────────────────────────────

				textureStore(
					writeStorageTex,
					uvec2( uint( gx ), uint( gy ) ),
					temporalAccumulate(
						lum, prevMoments.x, prevMoments.y,
						alpha, spatialVariance, varianceBoost
					)
				).toWriteOnly();

			} );

		} );

		return computeFn().compute(
			[ this._dispatchX, this._dispatchY, 1 ],
			[ WG_SIZE, WG_SIZE, 1 ]
		);

	}

	render( context ) {

		if ( ! this.enabled ) return;

		const colorTex = context.getTexture( this.inputTextureName );
		if ( ! colorTex ) return;

		// Auto-size
		const img = colorTex.image;
		if ( img && img.width > 0 && img.height > 0 ) {

			if ( img.width !== this._outputTarget.width ||
				img.height !== this._outputTarget.height ) {

				this.setSize( img.width, img.height );

			}

		}

		this._colorTexNode.value = colorTex;

		// Force-compile both compute nodes on first frame while _readTexNodeA/B
		// still hold EmptyTexture. This ensures WGSLNodeBuilder.generateTextureLoad()
		// sees isStorageTexture=false and emits the required level parameter.
		// The throwaway dispatches initialise both StorageTextures to near-zero,
		// which is correct for temporal moment accumulation on frame 0.
		if ( ! this._compiled ) {

			this.renderer.compute( this._computeNodeA );
			this.renderer.compute( this._computeNodeB );
			this._compiled = true;

		}

		// Set read-side TextureNode values to actual StorageTextures.
		// Shaders are already compiled — this only updates the uniform binding.
		this._readTexNodeA.value = this._storageTexA;
		this._readTexNodeB.value = this._storageTexB;

		// Warm reset: initialize BOTH ping-pong textures to current scene data
		// using alpha=1.0 so mean=currentLum, meanSq=currentLum², variance=0.
		// This avoids ~30 frames of EMA convergence from stale pre-reset data.
		if ( this._needsWarmReset ) {

			const savedAlpha = this.temporalAlpha.value;
			this.temporalAlpha.value = 1.0;
			this.renderer.compute( this._computeNodeA );
			this.renderer.compute( this._computeNodeB );
			this.temporalAlpha.value = savedAlpha;
			this._needsWarmReset = false;

		}

		// Dispatch correct ping-pong direction
		const computeNode = this.currentMoments === 0
			? this._computeNodeA // write A, read B
			: this._computeNodeB; // write B, read A

		this.renderer.compute( computeNode );

		// The write target this frame
		const writeTarget = this.currentMoments === 0
			? this._storageTexA
			: this._storageTexB;

		// Swap for next frame
		this.currentMoments = 1 - this.currentMoments;

		// Copy the active region out of the over-allocated StorageTexture into the
		// right-sized RenderTarget; downstream stages UV-sample the latter.
		this._srcRegion.max.set( this._outputTarget.width, this._outputTarget.height );
		this.renderer.copyTextureToTexture( writeTarget, this._outputTarget.texture, this._srcRegion );

		// Publish the RenderTarget (not the over-allocated StorageTexture)
		context.setTexture( 'variance:output', this._outputTarget.texture );

	}

	// Free the 2048² StorageTextures when disabled; three.js re-creates them on the next dispatch
	// after re-enable, and reset() re-anchors the EMA. See ASVGF.releaseGPUMemory.
	releaseGPUMemory() {

		this._storageTexA?.dispose();
		this._storageTexB?.dispose();
		// Render-res RT texture (dispose .texture, not the RT — RT.dispose() doesn't free it here).
		this.context?.removeTexture( 'variance:output' );
		this._outputTarget?.texture?.dispose();
		this.reset();

	}

	reset() {

		this.currentMoments = 0;
		// Defer initialization to next render() when fresh scene data is available.
		// Using alpha=1.0 on the first post-reset frame immediately anchors the EMA
		// to the new scene, avoiding ~30 frames of convergence from stale data.
		this._needsWarmReset = true;

		if ( this.context ) this.context.removeTexture( 'variance:output' );

	}

	setSize( width, height ) {

		// StorageTextures stay at their max allocation (see constructor).
		this._outputTarget.setSize( width, height );
		this._outputTarget.texture.needsUpdate = true;
		this.resW.value = width;
		this.resH.value = height;

		// Update dispatch dimensions
		this._dispatchX = Math.ceil( width / 8 );
		this._dispatchY = Math.ceil( height / 8 );
		this._computeNodeA.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];
		this._computeNodeB.dispatchSize = [ this._dispatchX, this._dispatchY, 1 ];

	}

	// Reserved-storage change (e.g. 4K toggle): recreate the MAX-preallocated StorageTextures at the new live
	// reserved size + rebuild the compute nodes in place. Same stage object, so refs/wiring stay valid.
	reallocateReservedStorage() {

		this._computeNodeA?.dispose();
		this._computeNodeB?.dispose();
		this._storageTexA?.dispose();
		this._storageTexB?.dispose();
		const mk = () => {

			const t = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
			t.type = FloatType; t.format = RGBAFormat; t.minFilter = LinearFilter; t.magFilter = LinearFilter;
			return t;

		};

		this._storageTexA = mk();
		this._storageTexB = mk();
		this._buildCompute();
		this._compiled = false;

	}

	dispose() {

		this._computeNodeA?.dispose();
		this._computeNodeB?.dispose();
		this._storageTexA?.dispose();
		this._storageTexB?.dispose();
		this._outputTarget?.dispose();
		this._colorTexNode?.dispose();
		this._readTexNodeA?.dispose();
		this._readTexNodeB?.dispose();

	}

}
