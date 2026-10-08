/**
 * Bidirectional path tracing, and vertex merging on top of it — the path tracer's 'bidirectional' and 'vcm'
 * integrators, an add-on (rayzee/addons/bidirectional). The path tracer calls it at fixed points of a frame (its
 * "Integrator hooks"): light subpaths before the camera chunks, connections and merges after each Shade, the light
 * tracing image before FinalWrite. Shade and Generate receive `uniforms`, whose `lib` carries the bidirectional
 * shading functions, so the core imports none of them. See CLAUDE.md, "Bidirectional integrator".
 */

import { uniform, uniformArray, texture, storage, Fn, uint, atomicStore, atomicLoad, instanceIndex, If, Return } from 'three/tsl';
import { DataTexture, FloatType, RedFormat, Vector3 } from 'three';
import { gpuOnlyStorageAttribute } from '../TSL/patches.js';
import { LIGHT_FLOATS } from '../managers/UniformManager.js';
import { HIT_STRIDE_BIDIRECTIONAL, LIGHT_VERTEX_STRIDE, freeStorageAttribute } from '../Processor/PackedRayBuffer.js';
import { COUNTER, ENERGY_SCALE } from '../Processor/QueueManager.js';
import { CAMERA_PROJECTION_IDS } from '../EngineDefaults.js';
import { BVH_MAX_INDEX, BVH_LEAF_MARKERS, CLUSTER_COUNT_SHIFT, CLUSTER_COPY_HIDDEN } from '../Processor/BufferLayout.js';
import { BOUNCE_KERNELS, LIST_WG_SIZE } from '../Stages/PathTracer.js';
import { buildLightGenerateKernel, LIGHT_GENERATE_WG_SIZE } from '../TSL/LightGenerateKernel.js';
import { buildGuideKernel, buildGuideClearKernel, guidedDiscPdf, recordEscape, GUIDE_BINS, GUIDE_ROW_STRIDE, GUIDE_TEXTURE_WIDTH } from '../TSL/LightGuide.js';
import { buildConnectKernel, CONNECT_WG_SIZE } from '../TSL/ConnectKernel.js';
import { buildMergeClearKernel, buildMergeInsertKernel, buildMergeKernel, MERGE_WG_SIZE } from '../TSL/MergeKernel.js';
import { buildLightSplatKernel, buildSplatResolveKernel, LIGHT_SPLAT_WG_SIZE, SPLAT_RESOLVE_WG_SIZE } from '../TSL/LightSplatKernel.js';
import * as Bidirectional from '../TSL/Bidirectional.js';
import * as BidirectionalLamps from '../TSL/BidirectionalLamps.js';

const { PASS_TAG_BIT, STRATEGY, STRATEGY_ALONE, SOURCE, mergeVmAt } = Bidirectional;

// What Shade and Generate call when the integrator is on: they take it from `uniforms.lib`.
const SHADING_LIB = { ...Bidirectional, ...BidirectionalLamps, guidedDiscPdf, recordEscape };

// Light vertex cache for the bidirectional integrator, at most this much of the hit buffer.
const LIGHT_CACHE_BYTES = 256 * 1024 * 1024;
const INFINITE_LIGHT_PATH_SHARE = 0.05;
// Light paths cost more than camera paths and help fewer pixels: at equal time half a pixel's worth beat one.
const LIGHT_PATHS_PER_PIXEL = 0.5;
const LIGHT_TAG_MAX = ( 1 << 24 ) - 1;
// Vertex merging: the radius at the first sample, in pixels' footprint where it gathers, shrinking as
// n^((α − 1) / 2) so the estimate converges (Knaus & Zwicker 2011).
const MERGE_RADIUS_PIXELS = 1;
const MERGE_ALPHA = 0.75;
const MERGE_TRUST = 0.25;

export class BidirectionalIntegrator {

	/** @param {import('../Stages/PathTracer.js').PathTracer} pathTracer */
	constructor( pathTracer ) {

		this.pt = pathTracer;
		this.merging = false;
		this._mergeRadiusPixels = MERGE_RADIUS_PIXELS;
		this._mergeHeadAttr = null;
		this._lightCacheSlots = 0;
		this._splatAttr = null;
		this._lightTag = 0;
		this._passTag = 0;
		this._lightTraced = false;
		this._lastLightBounceCounts = null;
		this._lastLightBounceEnergy = null;
		this._lastLightCurveKey = null;
		this._lightCurveKey = null;
		this.uniforms = {
			lib: SHADING_LIB,
			lightPaths: uniform( 0, 'uint' ),
			slotsPerPath: uniform( 1, 'uint' ),
			lightTag: uniform( 1, 'uint' ),
			passTag: uniform( 0, 'uint' ),
			lightTrace: uniform( 0, 'uint' ),
			strategyView: uniform( 0, 'uint' ),
			pixelArea: uniform( 1, 'float' ),
			cameraPosition: uniform( new Vector3(), 'vec3' ),
			cameraForward: uniform( new Vector3( 0, 0, - 1 ), 'vec3' ),
			sunPick: uniform( 0, 'float' ),
			emitterPick: uniform( 0, 'float' ),
			envPick: uniform( 0, 'float' ),
			// 1 while the CDF texture carries the environment's exact table.
			envTable: uniform( 0, 'uint' ),
			// Running sum over SOURCE, then each lamp list at sourceOffsets[ type ], sized to the lists' capacity.
			sourceCdf: uniformArray( new Float32Array( SOURCE.LAMPS ), 'float' ),
			sourceCount: SOURCE.LAMPS,
			sourceOffsets: [ SOURCE.LAMPS, SOURCE.LAMPS, SOURCE.LAMPS, SOURCE.LAMPS ],
			sceneCenter: uniform( new Vector3(), 'vec3' ),
			sceneRadius: uniform( 1, 'float' ),
			// The light guide (TSL/LightGuide.js): 1 once a table has been built since the last reset; and
			// whether camera paths count their escapes.
			guide: uniform( 0, 'uint' ),
			guideLearning: uniform( 1, 'uint' ),
			guideTexture: null,
			// Vertex merging (integrator 'vcm', MergeKernel.js), fixed at build: the radius at a point is
			// mergeConst + mergeSlope · its distance from the camera, at least mergeMin (Bidirectional.js mergeRadiusAt).
			merging: false,
			mergeConst: uniform( 0, 'float' ),
			mergeSlope: uniform( 0, 'float' ),
			mergeMin: uniform( 1, 'float' ),
			// How far the weights take a merge's density at its word (Bidirectional.js mergeVmAt).
			mergeTrust: uniform( MERGE_TRUST, 'float' ),
			hashMask: uniform( 0, 'uint' ),
		};
		this._lightGuiding = true;
		this._guideTexture = null;
		this._guideBuildAttr = null;
		this._u32Views = new WeakMap();

	}

	/** 'bidirectional', or 'vcm' with vertex merging. */
	get name() {

		return this.merging ? 'vcm' : 'bidirectional';

	}

	/** Called by PathTracer.setIntegrator() with the name chosen; the kernels rebuild after. */
	select( name ) {

		this.merging = name === 'vcm';
		this.uniforms.merging = this.merging;
		this._lastLightCurveKey = null;

	}

	// ── Integrator hooks: PathTracer calls these, in this order of a frame's life ──

	/** The hit buffer's stride a path needs: its pending connection rides in four more slots. */
	get hitStride() {

		return HIT_STRIDE_BIDIRECTIONAL;

	}

	/** Bytes of the hit buffer the light vertex cache takes beside the paths; sets the slot count. */
	cacheBytes( maxBinding, deviceMemBytes ) {

		const lightVertexBytes = LIGHT_VERTEX_STRIDE * 16;
		const bytes = Math.floor( Math.min( LIGHT_CACHE_BYTES, maxBinding * 0.45, deviceMemBytes * 0.05 ) / lightVertexBytes ) * lightVertexBytes;
		this._lightCacheSlots = bytes / lightVertexBytes;
		return bytes;

	}

	/** Light vertex cache slots, at the hit buffer's tail. */
	get lightVertices() {

		return this._lightCacheSlots;

	}

	/** Before the kernels build: their source table's layout is baked in. */
	beforeKernelBuild() {

		this._sizeSourceTable();

	}

	/** Its own buffers, for a frame of at most `maxPixels`. */
	allocate( maxPixels ) {

		// Light tracing's image: a u32 per channel per pixel, fixed point (LightSplatKernel).
		if ( ! this._splatAttr || this._splatAttr.count < maxPixels * 3 ) {

			freeStorageAttribute( this.pt.renderer, this._splatAttr );
			this._splatAttr = gpuOnlyStorageAttribute( maxPixels * 3, 1, Uint32Array );

		}

		// Vertex merging's list heads: at least one a light vertex slot, a power of two (the hash's mask).
		const hashSize = this.merging ? 2 ** Math.ceil( Math.log2( Math.max( this._lightCacheSlots, 1024 ) ) ) : 0;
		if ( this._mergeHeadAttr?.count !== hashSize ) {

			freeStorageAttribute( this.pt.renderer, this._mergeHeadAttr );
			this._mergeHeadAttr = hashSize > 0 ? gpuOnlyStorageAttribute( hashSize, 1, Uint32Array ) : null;

		}

		this.uniforms.hashMask.value = Math.max( hashSize - 1, 0 );

		// The light guide's table: built into a buffer, copied into a texture Shade can read (it has no buffer to spare).
		if ( ! this._guideTexture ) {

			this._guideTexture = new DataTexture( null, GUIDE_TEXTURE_WIDTH, GUIDE_BINS, RedFormat, FloatType );
			this._guideTexture.source.dataReady = false;
			this._guideTexture.needsUpdate = true;
			this._guideBuildAttr = gpuOnlyStorageAttribute( GUIDE_ROW_STRIDE * GUIDE_BINS, 1, Float32Array );

		}

		this.uniforms.guideTexture = texture( this._guideTexture );
		this.uniforms.guide.value = 0;

	}

	/**
	 * Its kernels, beside the path tracer's. `ctx` carries what _buildWavefrontKernels built: the kernel manager and
	 * the buffers, the scene nodes (fresh*) and `own`, which hands a kernel this renderer's scene resources.
	 */
	registerKernels( ctx ) {

		const {
			km, qm, pb, counters, bounceCountsBuf, wfCurrentBounce, copyReadB, copyWriteA, maxRays, w, own,
			freshLight, freshTri, freshBvh, freshMat, freshEnvTex, freshEnvCDF, materialLayers,
		} = ctx;
		// Whether some material passes light through diffusely: its strategies then cross surfaces.
		const transmits = materialLayers?.diffuseTransmission ?? true;

		const bd = this.uniforms;
		const n = qm.MAX_BOUNCE_SNAPSHOTS;

		// The light pass keeps its own survivor curve, after the camera's: [2n, 3n) counts, [3n, 4n) energy.
		const recordLightCurve = ( active ) => {

			const slot = uint( wfCurrentBounce ).clamp( uint( 0 ), uint( n - 1 ) );
			bounceCountsBuf.element( slot.add( uint( 2 * n ) ) ).assign( active );
			bounceCountsBuf.element( slot.add( uint( 3 * n ) ) ).assign( atomicLoad( counters.element( uint( COUNTER.ACTIVE_ENERGY ) ) ) );
			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), active );

		};

		km.register( 'lightSnapshot', Fn( () => {

			recordLightCurve( atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) ) );

		} )().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] ) );

		km.register( 'lightCopyback', Fn( () => {

			const tid = instanceIndex;
			const active = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
			If( tid.equal( uint( 0 ) ), () => {

				recordLightCurve( active );

			} );
			If( tid.greaterThanEqual( active ), () => {

				Return();

			} );
			copyWriteA.element( tid ).assign( copyReadB.element( tid ) );

		} )().compute( [ Math.ceil( maxRays / LIST_WG_SIZE ), 1, 1 ], [ LIST_WG_SIZE, 1, 1 ] ) );

		km.register( 'guideClear', buildGuideClearKernel( { counters } ) );
		km.register( 'guideBuild', buildGuideKernel( { counters, out: storage( this._guideBuildAttr, 'float' ) } ) );

		km.register( 'lightGenerate', own( buildLightGenerateKernel( {
			rayBufferRW: pb.rayBuffer.rw,
			hitBufferRW: pb.hitBuffer.rw,
			activeIndicesRW: qm.activeIndices.a,
			counters,
			lightBuffer: freshLight,
			triangleBuffer: freshTri,
			bvhBuffer: freshBvh,
			emissiveTriangleCount: this.pt.emissiveTriangleCount,
			emissiveVec4Offset: this.pt.emissiveVec4Offset,
			emissiveTotalPower: this.pt.emissiveTotalPower,
			emissiveBoost: this.pt.emissiveBoost,
			sunDirection: this.pt.sunDirection,
			sunRadiance: this.pt.sunRadiance,
			sunParams: this.pt.sunParams,
			environmentIntensity: this.pt.environmentIntensity,
			envTexture: freshEnvTex,
			envCDFTexture: freshEnvCDF,
			envMatrix: this.pt.environmentMatrix,
			envResolution: this.pt.envResolution,
			directionalLightsBuffer: this.pt.directionalLightsBufferNode,
			areaLightsBuffer: this.pt.areaLightsBufferNode,
			pointLightsBuffer: this.pt.pointLightsBufferNode,
			spotLightsBuffer: this.pt.spotLightsBufferNode,
			bidirectional: bd,
			resolution: this.pt.resolution,
			frame: this.pt.seedFrame,
			transmissiveBounces: this.pt.transmissiveBounces,
		} )() ).compute( [ Math.ceil( maxRays / LIGHT_GENERATE_WG_SIZE ), 1, 1 ], [ LIGHT_GENERATE_WG_SIZE, 1, 1 ] ) );

		km.register( 'connect', own( buildConnectKernel( {
			rayBufferRW: pb.rayBuffer.rw,
			hitBufferRO: pb.hitBuffer.ro,
			activeIndicesRO: qm.getActiveReadRO(),
			counters,
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			resolution: this.pt.resolution,
			frame: this.pt.seedFrame,
			accumFrame: this.pt.frame,
			currentBounce: this.pt._wfCurrentBounce,
			chunkRowBase: this.pt._wfChunkRowBase,
			lightPaths: bd.lightPaths,
			slotsPerPath: bd.slotsPerPath,
			lightTag: bd.lightTag,
			passTag: bd.passTag,
			strategyView: bd.strategyView,
			maxBounceCount: this.pt.maxBounces,
			globalIlluminationIntensity: this.pt.globalIlluminationIntensity,
			fireflyThreshold: this.pt.fireflyThreshold,
			mergeVm: bd.merging ? ( p ) => mergeVmAt( bd, p ) : null,
			diffuseTransmission: transmits,
		} )() ).compute( [ Math.ceil( maxRays / CONNECT_WG_SIZE ), 1, 1 ], [ CONNECT_WG_SIZE, 1, 1 ] ) );

		if ( bd.merging ) {

			const head = storage( this._mergeHeadAttr, 'uint' ).toAtomic();
			km.register( 'mergeClear', buildMergeClearKernel( { head, hashSize: this._mergeHeadAttr.count } ) );
			km.register( 'mergeInsert', buildMergeInsertKernel( {
				hitBufferRW: pb.hitBuffer.rw,
				head,
				bidirectional: bd,
			} )().compute( [ Math.ceil( this._lightCacheSlots / MERGE_WG_SIZE ), 1, 1 ], [ MERGE_WG_SIZE, 1, 1 ] ) );
			km.register( 'merge', own( buildMergeKernel( {
				rayBufferRW: pb.rayBuffer.rw,
				hitBufferRO: pb.hitBuffer.ro,
				activeIndicesRO: qm.getActiveReadRO(),
				counters,
				head,
				materialBuffer: freshMat,
				bidirectional: bd,
				maxBounceCount: this.pt.maxBounces,
				globalIlluminationIntensity: this.pt.globalIlluminationIntensity,
				fireflyThreshold: this.pt.fireflyThreshold,
				accumFrame: this.pt.frame,
				diffuseTransmission: transmits,
			} )() ).compute( [ Math.ceil( maxRays / MERGE_WG_SIZE ), 1, 1 ], [ MERGE_WG_SIZE, 1, 1 ] ) );

		}

		const splatBuffer = storage( this._splatAttr, 'uint' ).toAtomic();

		km.register( 'lightSplat', own( buildLightSplatKernel( {
			hitBufferRO: pb.hitBuffer.ro,
			splatBuffer,
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			lightPaths: bd.lightPaths,
			slotsPerPath: bd.slotsPerPath,
			lightTag: bd.lightTag,
			strategyView: bd.strategyView,
			cameraPosition: bd.cameraPosition,
			cameraForward: bd.cameraForward,
			cameraViewMatrix: this.pt.cameraViewMatrix,
			cameraProjectionMatrix: this.pt.cameraProjectionMatrix,
			pixelArea: bd.pixelArea,
			renderWidth: this.pt._wfRenderWidth,
			renderHeight: this.pt._wfRenderHeight,
			globalIlluminationIntensity: this.pt.globalIlluminationIntensity,
			fireflyThreshold: this.pt.fireflyThreshold,
			accumFrame: this.pt.frame,
			frame: this.pt.seedFrame,
			mergeVm: bd.merging ? ( p ) => mergeVmAt( bd, p ) : null,
			diffuseTransmission: transmits,
		} )() ).compute( [ Math.ceil( this._lightCacheSlots / LIGHT_SPLAT_WG_SIZE ), 1, 1 ], [ LIGHT_SPLAT_WG_SIZE, 1, 1 ] ) );

		km.register( 'splatResolve', buildSplatResolveKernel( {
			rayBufferRW: pb.rayBuffer.rw,
			splatBuffer,
			renderWidth: this.pt._wfRenderWidth,
			chunkRowBase: this.pt._wfChunkRowBase,
			chunkRows: this.pt._wfChunkRows,
		} )().compute(
			[ Math.ceil( w / SPLAT_RESOLVE_WG_SIZE ), Math.ceil( this.pt._chunkRows / SPLAT_RESOLVE_WG_SIZE ), 1 ],
			[ SPLAT_RESOLVE_WG_SIZE, SPLAT_RESOLVE_WG_SIZE, 1 ]
		) );

	}

	/**
	 * Start of a frame: the source table, the light guide, then the light subpaths. False when nothing can start a
	 * light path, and the frame runs as the path tracer's own.
	 */
	beginFrame( loopBound ) {

		const active = this._updateBidirectionalUniforms();
		this._lightTraced = active && this.uniforms.lightTrace.value > 0;
		if ( active ) {

			this._updateLightGuide();
			this._traceLightPaths( loopBound );

		}

		return active;

	}

	/** Before each Shade of an active frame. */
	beforeShade() {

		this.uniforms.passTag.value = this._nextPassTag();

	}

	/** After each Shade of an active frame. */
	afterShade( km ) {

		km.dispatch( 'connect' );
		if ( this.merging ) km.dispatch( 'merge' );

	}

	/** Before FinalWrite, each chunk of an active frame. */
	resolve( km ) {

		if ( this._lightTraced ) km.dispatch( 'splatResolve' );

	}

	/** What the light pass's survivor curve was measured for; the readback keeps it with the curve. */
	get curveKey() {

		return this._lightCurveKey;

	}

	/** The light pass's survivor curve, read back with the camera's. */
	applyLightCurve( counts, energy, key ) {

		this._lastLightBounceCounts = counts;
		this._lastLightBounceEnergy = energy;
		this._lastLightCurveKey = key;

	}

	/** For the build's log line. */
	describe() {

		return `${this.name}: ${this._lightCacheSlots.toLocaleString( 'en-US' )} light vertex slots`;

	}

	/** GPU memory of its own, for the VRAM tracker. */
	gpuResources() {

		return this._splatAttr ? [ this._splatAttr, this._mergeHeadAttr ].filter( Boolean ) : null;

	}

	/** Frees its buffers; the path tracer calls it when another integrator is chosen, and on dispose. */
	dispose() {

		freeStorageAttribute( this.pt.renderer, this._splatAttr );
		this._splatAttr = null;
		freeStorageAttribute( this.pt.renderer, this._mergeHeadAttr );
		this._mergeHeadAttr = null;
		this._disposeLightGuide();

	}

	// ── Controls ──

	/**
	 * Verification only: keep one bidirectional strategy, MIS-weighted, or alone at full weight.
	 * @param {'all'|'hit'|'nee'|'connect'|'lightTrace'|'merge'} strategy
	 */
	setBidirectionalStrategy( strategy = 'all', { alone = false } = {} ) {

		const code = { all: STRATEGY.ALL, hit: STRATEGY.HIT, nee: STRATEGY.NEE, connect: STRATEGY.CONNECT, lightTrace: STRATEGY.LIGHT_TRACE, merge: STRATEGY.MERGE }[ strategy ] ?? STRATEGY.ALL;
		this.uniforms.strategyView.value = code === STRATEGY.ALL ? code : code + ( alone ? STRATEGY_ALONE : 0 );

	}

	/**
	 * Vertex merging's radius at the first sample, in pixels: the footprint where it gathers, so the blur is the same
	 * on screen at any scene scale. It shrinks with every sample after. Larger gathers more light vertices — less
	 * noise in caustics, more blur — at more cost.
	 */
	setMergeRadius( pixels = MERGE_RADIUS_PIXELS ) {

		this._mergeRadiusPixels = Math.max( pixels, 1e-3 );

	}

	/**
	 * How much of the light other strategies can also reach vertex merging takes: 1 weighs merges by their density,
	 * less hands that light back to the unblurred strategies. Light only merging reaches is all merging's either way.
	 */
	setMergeTrust( trust = MERGE_TRUST ) {

		this.uniforms.mergeTrust.value = Math.max( trust, 1e-4 );

	}

	// False when nothing can start a light path.
	_updateBidirectionalUniforms() {

		const bd = this.uniforms;
		const w = this.pt._wfRenderWidth.value;
		const h = this.pt._wfRenderHeight.value;
		const slots = this.pt.maxBounces.value + 1;
		const total = this._updateSourceTable();
		const paths = total > 0
			? Math.min( Math.ceil( w * h * LIGHT_PATHS_PER_PIXEL ), this.pt._packedBuffers.capacity, Math.floor( this._lightCacheSlots / slots ) )
			: 0;

		bd.lightPaths.value = paths;
		bd.slotsPerPath.value = slots;
		this._lightCurveKey = `${paths}:${slots}:${this.pt._bounceLoopBound()}`;
		if ( paths === 0 ) {

			bd.lightTrace.value = 0;
			return false;

		}

		this._lightTag = this._lightTag % LIGHT_TAG_MAX + 1;
		bd.lightTag.value = this._lightTag;

		const world = this.pt.cameraWorldMatrix.value.elements;
		bd.cameraPosition.value.set( world[ 12 ], world[ 13 ], world[ 14 ] );
		bd.cameraForward.value.set( - world[ 8 ], - world[ 9 ], - world[ 10 ] ).normalize();
		const projection = this.pt.cameraProjectionMatrix.value.elements;
		bd.pixelArea.value = 4 / ( projection[ 0 ] * projection[ 5 ] * w * h );
		// Light tracing needs a pinhole camera.
		const pinhole = this.pt.cameraProjection.value === CAMERA_PROJECTION_IDS.perspective && ! this.pt.enableDOF.value;
		bd.lightTrace.value = pinhole ? 1 : 0;
		if ( this.merging ) this._updateMergeRadius( w, h );
		return true;

	}

	// A pixel's footprint: grows with the distance from a perspective or panoramic camera, constant for an orthographic one.
	_updateMergeRadius( w, h ) {

		const bd = this.uniforms;
		const pixels = this._mergeRadiusPixels * Math.pow( this.pt.frameCount + 1, ( MERGE_ALPHA - 1 ) / 2 );
		const projection = this.pt.cameraProjection.value;
		const p = this.pt.cameraProjectionMatrix.value.elements;
		let slope = 0, constant = 0;
		if ( projection === CAMERA_PROJECTION_IDS.orthographic ) constant = pixels * 2 / ( p[ 5 ] * h );
		else if ( projection === CAMERA_PROJECTION_IDS.equirectangular ) slope = pixels * 2 * Math.PI / w;
		else slope = pixels * Math.sqrt( bd.pixelArea.value );
		bd.mergeSlope.value = Math.min( slope, 0.1 );
		bd.mergeConst.value = constant;
		// Nearer than a thousandth of the scene, the radius stops shrinking: shells start there.
		bd.mergeMin.value = Math.max( constant, slope * 1e-3 * bd.sceneRadius.value, 1e-9 );

	}

	/** Sizes the source table to the lamp lists' capacity; its layout is baked into the kernels. */
	_sizeSourceTable() {

		const bd = this.uniforms;
		let at = SOURCE.LAMPS;
		[ 'directional', 'area', 'point', 'spot' ].forEach( ( type, i ) => {

			bd.sourceOffsets[ i ] = at;
			at += this.pt[ `${type}LightsBufferNode` ].array.length / LIGHT_FLOATS[ type ];

		} );
		bd.sourceCount = at;
		if ( bd.sourceCdf.array.length !== at ) bd.sourceCdf.array = new Float32Array( at );

	}

	/**
	 * Each source's chance of starting a light path, by the luminous flux it sends into the scene.
	 * @returns {number} the total flux, 0 when nothing emits
	 */
	_updateSourceTable() {

		const bd = this.uniforms;
		const cdf = bd.sourceCdf.array;
		const flux = new Float64Array( cdf.length );
		const lum = ( a, i ) => Math.max( 0.2126 * a[ i ] + 0.7152 * a[ i + 1 ] + 0.0722 * a[ i + 2 ], 0 );
		const lights = ( type ) => ( { a: this.pt[ `${type}LightsBufferNode` ].array, n: this.pt[ `num${type[ 0 ].toUpperCase()}${type.slice( 1 )}Lights` ].value, f: LIGHT_FLOATS[ type ] } );
		const directional = lights( 'directional' );

		const environmentOn = this.pt.enableEnvironment.value > 0;
		const table = this.pt.environment.exactTable;
		bd.envTable.value = table ? 1 : 0;
		const atInfinity = environmentOn && ( this.pt.hasSun.value > 0 || table ) || directional.n > 0;
		// What a light at infinity sends through the scene's disc mostly lands where its NEE does better: next to
		// lamps or emitters it gets this share of its flux in light paths (alone, it gets them all regardless).
		// Vertex merging sizes its radius by the scene, so it measures the disc too.
		const disc = atInfinity || this.merging ? this._sceneDisc() : 0;
		const discArea = atInfinity ? disc * INFINITE_LIGHT_PATH_SHARE : 0;
		if ( environmentOn && table ) flux[ SOURCE.ENVIRONMENT ] = Math.max( table.radianceIntegral, 0 ) * this.pt.environmentIntensity.value * discArea;

		if ( this.pt.emissiveTriangleCount.value > 0 ) flux[ SOURCE.EMITTERS ] = Math.PI * this.pt.emissiveBoost.value * this.pt.emissiveTotalPower.value;
		if ( environmentOn && this.pt.hasSun.value > 0 ) {

			const { x: r, y: g, z: b } = this.pt.sunRadiance.value;
			flux[ SOURCE.SUN ] = Math.max( 0.2126 * r + 0.7152 * g + 0.0722 * b, 0 ) * this.pt.environmentIntensity.value * this.pt.sunParams.value.y * discArea;

		}

		for ( let i = 0; i < directional.n; i ++ ) flux[ bd.sourceOffsets[ 0 ] + i ] = lum( directional.a, i * directional.f + 3 ) * directional.a[ i * directional.f + 6 ] * discArea;

		const area = lights( 'area' );
		for ( let i = 0; i < area.n; i ++ ) {

			const a = area.a, o = i * area.f;
			const cx = a[ o + 4 ] * a[ o + 8 ] - a[ o + 5 ] * a[ o + 7 ], cy = a[ o + 5 ] * a[ o + 6 ] - a[ o + 3 ] * a[ o + 8 ], cz = a[ o + 3 ] * a[ o + 7 ] - a[ o + 4 ] * a[ o + 6 ];
			const size = 4 * Math.hypot( cx, cy, cz ) * ( a[ o + 15 ] > 0.5 ? Math.PI / 4 : 1 );
			flux[ bd.sourceOffsets[ 1 ] + i ] = size > 0 ? lum( a, o + 9 ) * Math.max( a[ o + 12 ], 0 ) * ( a[ o + 13 ] > 0.5 ? 1 : size ) : 0;

		}

		const point = lights( 'point' );
		for ( let i = 0; i < point.n; i ++ ) flux[ bd.sourceOffsets[ 2 ] + i ] = 4 * Math.PI * lum( point.a, i * point.f + 3 ) * Math.max( point.a[ i * point.f + 6 ], 0 );

		const spot = lights( 'spot' );
		for ( let i = 0; i < spot.n; i ++ ) {

			const o = i * spot.f;
			flux[ bd.sourceOffsets[ 3 ] + i ] = 2 * Math.PI * ( 1 - Math.cos( spot.a[ o + 10 ] ) ) * lum( spot.a, o + 6 ) * Math.max( spot.a[ o + 9 ], 0 );

		}

		let total = 0;
		for ( let i = 0; i < flux.length; i ++ ) total += Number.isFinite( flux[ i ] ) ? flux[ i ] : 0;
		let sum = 0;
		for ( let i = 0; i < flux.length; i ++ ) {

			sum += Number.isFinite( flux[ i ] ) ? flux[ i ] : 0;
			cdf[ i ] = total > 0 ? sum / total : 0;

		}

		if ( total > 0 ) cdf[ cdf.length - 1 ] = 1;

		// The shaders difference the stored sum, so these are taken from it the same way.
		const pick = ( i ) => Math.fround( cdf[ i ] - ( i > 0 ? cdf[ i - 1 ] : 0 ) );
		bd.sunPick.value = pick( SOURCE.SUN );
		bd.emitterPick.value = pick( SOURCE.EMITTERS );
		bd.envPick.value = pick( SOURCE.ENVIRONMENT );
		return total;

	}

	// The disc a light at infinity starts its paths on: the visible scene's bounding sphere, facing it. Its area, or 0.
	_sceneDisc() {

		const bd = this.uniforms;
		const bounds = this._visibleSceneBounds();
		if ( ! bounds ) return 0;

		const [ x0, y0, z0 ] = bounds.min;
		const [ x1, y1, z1 ] = bounds.max;
		const radius = 0.5 * Math.hypot( x1 - x0, y1 - y0, z1 - z0 );
		if ( ! ( radius > 0 && Number.isFinite( radius ) ) ) return 0;
		bd.sceneCenter.value.set( ( x0 + x1 ) / 2, ( y0 + y1 ) / 2, ( z0 + z1 ) / 2 );
		bd.sceneRadius.value = radius;
		return Math.PI * radius * radius;

	}

	/**
	 * The visible placements' world box, read from the TLAS as uploaded; hidden meshes are left out.
	 * @returns {?{min: number[], max: number[]}}
	 */
	_visibleSceneBounds() {

		const records = this.pt._bvhRecords;
		const flat = records ? null : this.pt.bvhStorageAttr?.array;
		if ( ! records && ! ( flat?.length >= 16 ) ) return null;
		// A spilled TLAS comes back for the next frame's disc.
		const blasBase = this.pt._instanceTable?.blasBase ?? 1;
		if ( records && ! records.isResident( 0, blasBase ) ) {

			this.pt._whenTLASResident( () => {} );
			return null;

		}

		const view = ( f ) => {

			let u = this._u32Views.get( f );
			if ( ! u ) this._u32Views.set( f, u = new Uint32Array( f.buffer, f.byteOffset, f.length ) );
			return u;

		};

		const node = ( i ) => {

			const f = records ? records.chunkFor( i ) : flat;
			return { f, u: view( f ), o: records ? records.baseOf( i ) : i * 16 };

		};

		// A copy cluster is visible while any of its copies is (BufferLayout CLUSTER_LEAF).
		const leafVisible = ( n ) => {

			if ( n.u[ n.o + 3 ] !== BVH_LEAF_MARKERS.CLUSTER_LEAF ) return n.f[ n.o + 2 ] !== 0;
			const count = ( ( n.u[ n.o ] >>> CLUSTER_COUNT_SHIFT ) & 3 ) + 1;
			for ( let k = 0; k < count; k ++ ) if ( ! ( n.u[ n.o + 12 + k ] & CLUSTER_COPY_HIDDEN ) ) return true;
			return false;

		};

		const root = node( 0 );
		if ( root.u[ root.o + 3 ] >= BVH_MAX_INDEX ) return null;
		// A tree that reaches a node twice is malformed; no search visits more nodes than the tree holds.
		const nodeCount = records ? records.recordCount : flat.length / 16;

		const min = [], max = [];
		for ( let axis = 0; axis < 3; axis ++ ) for ( const sign of [ 1, - 1 ] ) {

			// Inner node: [leftMin, left, leftMax, right, rightMin, -, rightMax, -]; a child no further out than the best visible leaf is skipped.
			const score = ( n, child ) => sign > 0 ? n.f[ n.o + child * 8 + 4 + axis ] : - n.f[ n.o + child * 8 + axis ];
			const childIndex = ( n, child ) => n.u[ n.o + 3 + child * 4 ];
			let best = - Infinity;
			const stack = [];
			const push = ( n ) => {

				const a = score( n, 0 ), b = score( n, 1 );
				const first = a <= b ? 0 : 1;
				stack.push( childIndex( n, first ), first === 0 ? a : b, childIndex( n, 1 - first ), first === 0 ? b : a );

			};

			push( root );
			let visits = 0;
			while ( stack.length ) {

				const s = stack.pop(), index = stack.pop();
				if ( s <= best ) continue;
				if ( index >= nodeCount || ++ visits > nodeCount ) return null;
				const n = node( index );
				if ( n.u[ n.o + 3 ] >= BVH_MAX_INDEX ) {

					if ( leafVisible( n ) ) best = s;

				} else push( n );

			}

			if ( best === - Infinity ) return null;
			( sign > 0 ? max : min )[ axis ] = sign > 0 ? best : - best;

		}

		return { min, max };

	}

	/**
	 * Lights at infinity start their light paths where camera paths escaped (TSL/LightGuide.js). Each reset forgets
	 * the counts; the table is rebuilt from them at frames 1, 2, 4 … 32 and every 32nd after, so a render of the same
	 * input learns the same table. Off: light paths start uniformly over the scene's disc, as before.
	 * @param {boolean} enabled
	 */
	setLightGuiding( enabled ) {

		this._lightGuiding = enabled !== false;
		this.uniforms.guide.value = 0;
		this.pt.reset();

	}

	_updateLightGuide() {

		const bd = this.uniforms;
		const km = this.pt._kernelManager;
		bd.guideLearning.value = this._lightGuiding ? 1 : 0;
		const f = this.pt.frameCount;
		if ( f === 0 ) {

			km.dispatch( 'guideClear' );
			bd.guide.value = 0;
			return;

		}

		if ( ! this._lightGuiding || ! ( f <= 32 ? ( f & ( f - 1 ) ) === 0 : f % 32 === 0 ) ) return;
		km.dispatch( 'guideBuild' );

		const backend = this.pt.renderer.backend;
		this.pt.renderer.initTexture( this._guideTexture );
		const encoder = backend.device.createCommandEncoder( { label: 'LightGuide' } );
		encoder.copyBufferToTexture(
			{ buffer: backend.get( this._guideBuildAttr ).buffer, bytesPerRow: GUIDE_ROW_STRIDE * 4, rowsPerImage: GUIDE_BINS },
			{ texture: backend.get( this._guideTexture ).texture },
			[ GUIDE_TEXTURE_WIDTH, GUIDE_BINS ],
		);
		backend.device.queue.submit( [ encoder.finish() ] );
		bd.guide.value = 1;

	}

	_disposeLightGuide() {

		freeStorageAttribute( this.pt.renderer, this._guideBuildAttr );
		this._guideTexture?.dispose();
		this._guideTexture = this._guideBuildAttr = null;
		this.uniforms.guideTexture = null;

	}

	_nextPassTag() {

		this._passTag = ( this._passTag + 1 ) & 0x7FFFFFFF;
		return ( PASS_TAG_BIT | this._passTag ) >>> 0;

	}

	// Sized and cut short off its own survivor curve, as the camera loop is.
	_traceLightPaths( loopBound ) {

		const km = this.pt._kernelManager;
		const paths = this.uniforms.lightPaths.value;

		this.pt._wfChunkRowBase.value = 0;
		this.pt._wfMaxRayCount.value = paths;
		km.setDispatchForCount( 'lightGenerate', paths );
		km.dispatch( 'lightGenerate' );

		const dynamic = this.pt._useDynamicDispatch;
		const curveValid = this._lastLightCurveKey === this._lightCurveKey;
		const counts = curveValid ? this._lastLightBounceCounts : null;
		const energy = curveValid ? this._lastLightBounceEnergy : null;
		const exitEnergy = this.pt._bounceEarlyExitThreshold >= 0 ? this.pt._bounceEarlyExitThreshold * paths * ENERGY_SCALE : - 1;

		for ( let bounce = 0; bounce <= loopBound; bounce ++ ) {

			this.pt._wfCurrentBounce.value = bounce;

			const prev = bounce > 0 ? counts?.[ bounce - 1 ] : undefined;
			const sized = dynamic && prev > 0 ? Math.min( paths, Math.ceil( prev * 1.5 ) + 1024 ) : paths;
			for ( const k of BOUNCE_KERNELS ) km.setDispatchForCount( k, sized );
			if ( ! dynamic ) km.dispatch( 'enterFull' );

			km.dispatch( 'extend' );
			if ( this.pt._sortMaterials ) {

				km.dispatch( 'resetGlobalHist' );
				km.dispatch( 'globalHist' );
				km.dispatch( 'globalPrefix' );
				km.dispatch( 'globalScatter' );

			}

			km.dispatch( 'shade' );
			km.dispatch( 'compact' );
			km.dispatch( dynamic ? 'lightCopyback' : 'lightSnapshot' );

			if ( exitEnergy >= 0 && bounce < loopBound && energy?.[ bounce ] !== undefined && energy[ bounce ] <= exitEnergy ) break;

		}

		if ( this.uniforms.lightTrace.value > 0 ) {

			km.setDispatchForCount( 'lightSplat', paths * this.uniforms.slotsPerPath.value );
			km.dispatch( 'lightSplat' );

		}

		if ( this.merging ) {

			km.dispatch( 'mergeClear' );
			km.setDispatchForCount( 'mergeInsert', paths * this.uniforms.slotsPerPath.value );
			km.dispatch( 'mergeInsert' );

		}

	}

}
