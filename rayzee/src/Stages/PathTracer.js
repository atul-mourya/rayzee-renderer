/**
 * Wavefront path tracer — decomposed kernel dispatch (Extend → [Sort] → Shade → Compact per
 * bounce, bookended by Generate + FinalWrite; DebugKernel for visMode). Extends PathTracerStage
 * for shared engine/scene infrastructure (managers, uniforms, camera, lights, BVH, accumulation).
 */

import { uniform, uniformArray, texture, storage } from 'three/tsl';
import { DataTexture, FloatType, RedFormat, Vector3 } from 'three';
import { gpuOnlyStorageAttribute } from '../TSL/patches.js';
import { PathTracerStage } from './PathTracerStage.js';
import { LIGHT_FLOATS } from '../managers/UniformManager.js';
import {
	PackedRayBuffer, GBUFFER_STRIDE, RAY_STRIDE, HIT_STRIDE, HIT_STRIDE_BIDIRECTIONAL, LIGHT_VERTEX_STRIDE, freeStorageAttribute,
} from '../Processor/PackedRayBuffer.js';
import { QueueManager, COUNTER, ENERGY_SCALE } from '../Processor/QueueManager.js';
import { VRAMTracker } from '../Processor/VRAMTracker.js';
import { KernelManager } from '../Processor/KernelManager.js';
import { buildGenerateKernel, GENERATE_WG_SIZE } from '../TSL/GenerateKernel.js';
import { buildExtendKernel, EXTEND_WG_SIZE } from '../TSL/ExtendKernel.js';
import { buildShadeKernel, SHADE_WG_SIZE } from '../TSL/ShadeKernel.js';
import { buildCompactKernel, buildCompactSubgroupKernel, COMPACT_WG_SIZE } from '../TSL/CompactKernel.js';
import { buildFinalWriteKernel, FINALWRITE_WG_SIZE } from '../TSL/FinalWriteKernel.js';
import { buildDebugKernel, DEBUG_WG_SIZE } from '../TSL/DebugKernel.js';
import { buildLightGenerateKernel, LIGHT_GENERATE_WG_SIZE } from '../TSL/LightGenerateKernel.js';
import { buildGuideKernel, buildGuideClearKernel, GUIDE_BINS, GUIDE_ROW_STRIDE, GUIDE_TEXTURE_WIDTH } from '../TSL/LightGuide.js';
import { buildConnectKernel, CONNECT_WG_SIZE } from '../TSL/ConnectKernel.js';
import { buildMergeClearKernel, buildMergeInsertKernel, buildMergeKernel, MERGE_WG_SIZE } from '../TSL/MergeKernel.js';
import {
	buildLightSplatKernel, buildSplatResolveKernel, LIGHT_SPLAT_WG_SIZE, SPLAT_RESOLVE_WG_SIZE,
} from '../TSL/LightSplatKernel.js';
import { PASS_TAG_BIT, STRATEGY, STRATEGY_ALONE, SOURCE, mergeVmAt } from '../TSL/Bidirectional.js';
import { setMaterialBucketTextures, buildBucketTextureNodes, refreshBucketTextureNodes } from '../TSL/TextureSampling.js';
import { setShadowAlbedoMaps } from '../TSL/LightsDirect.js';
import {
	buildResetGlobalHistKernel, buildGlobalHistKernel, buildGlobalPrefixKernel, buildGlobalScatterKernel,
	SORT_GLOBAL_WG_SIZE, SORT_GLOBAL_MAX_BINS,
} from '../TSL/SortGlobalKernels.js';
import { ENGINE_DEFAULTS, MAX_STORAGE_TEXTURE_SIZE, CAMERA_PROJECTION_IDS, BVH_MAX_INDEX } from '../EngineDefaults.js';
import { createLogger, fmt } from '../utils/Logger.js';
import { deviceMemoryGB } from '../Processor/HostMemory.js';
import {
	Fn, uint, int, atomicStore, atomicLoad, atomicAdd, instanceIndex, If, Return,
} from 'three/tsl';

const log = createLogger( 'wavefront' );

// Shared by the 1D index-list kernels built inline below.
const LIST_WG_SIZE = 256;

// Resized per bounce iteration, each from its own registered workgroup size. Unregistered entries
// (the sort passes when _sortMaterials is off) are skipped by setDispatchForCount.
const BOUNCE_KERNELS = [ 'extend', 'shade', 'connect', 'merge', 'globalHist', 'globalScatter', 'compact', 'compactCopyback', 'lightCopyback' ];

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

export class PathTracer extends PathTracerStage {

	constructor( renderer, scene, camera, options = {} ) {

		super( renderer, scene, camera, options );
		this.name = 'PathTracer';

		this._packedBuffers = null;
		this._queueManager = null;
		this._kernelManager = null;
		this._gBufferAttr = null; // per-pixel first-hit MRT (ND + albedo); see _buildWavefrontKernels
		this._m2Attr = null; // per-pixel running mean of luminance² for the Tier-1 convergence early-stop
		this._streakAttr = null; // Tier-2: per-pixel freeze-candidate streak (u32); frozen := streak >= K
		// Tier-2 dilation: per-pixel frozen mask (1=skip), written race-free in buildActivePixels; a frozen pixel
		// stays active if any 8-neighbour is still active (Cycles box-filter) to avoid hard frozen/active seams.
		this._frozenMaskAttr = null;
		this._convDebugSource = null; // memoized handle set for the Compositor's convergence overlay
		this._dilateFrozenUniform = uniform( 1, 'int' ); // 1 = dilate (default); 0 = plain per-pixel freeze
		this._wavefrontReady = false;

		// Aux MRT (normalDepth + albedo) feeds only the denoiser/OIDN. When no denoiser is active the
		// wavefront skips those writes (Generate/Shade G-buffer + FinalWrite stores). Gated by a live
		// uniform — NOT baked — so DenoisingManager can toggle it without a (UI-freezing) kernel rebuild.
		this._auxGBufferEnabled = false;
		this._auxGBufferUniform = uniform( 0, 'uint' );
		// Clean-aux mode: temporally accumulate + renormalize the aux NORMAL (like albedo) so a clean-aux
		// OIDN model (calb_cnrm/high, alb_nrm/balanced) gets the prefiltered-ish normal it expects instead
		// of the point-sampled per-frame value that leaks noise. Off for fast/ASVGF (they want the bump normal).
		this._cleanAuxNormalEnabled = false;
		this._cleanAuxNormalUniform = uniform( 0, 'uint' );
		// Aux MRT accumulates on an epoch of its own: enabling the denoiser at colour frame N must not leave
		// the stale aux pinned by the colour's 1/(N+1) alpha.
		this._auxSamples = 0;
		this._auxSeedPending = false;

		// CPU sizes per-bounce kernels from last frame's survivor curve; kernels bound on ENTERING_COUNT so over-sizing is safe. (indirect dispatch not viable — three.js doesn't sync compute-written indirect buffers across submissions)
		this._useDynamicDispatch = true;

		// Global material-coherence sort: set per-build from ENGINE_DEFAULTS + material count (>8).
		// Reorders entering rays into material-pure workgroups before Shade; runs under dynamic dispatch
		// (compact reads the unsorted active list, so the survivor set is unchanged). Measured −8% at 1024²/8b.
		this._sortMaterials = false;

		// Flag-gated off: perf-neutral vs atomic-append and adds a 'subgroups' feature dependency.
		this._useSubgroupCompact = false;

		this._lastBounceCounts = null;
		this._lastBounceEnergy = null;
		// maxBounces the curve was measured at; the curve is ignored once this no longer matches (-1 = none).
		this._lastBounceCountsBudget = - 1;
		// Loop length the curve covers; maxBounces alone is not it (free bounces extend the loop).
		this._lastBounceCountsLoopBound = - 1;
		this._readbackPending = false;
		this._readbackEveryNFrames = 4;
		this._readbackFrameCounter = 0;
		// Bumped on resolution change; a readback that resolves with a stale generation is dropped.
		this._readbackGeneration = 0;
		// Whether the survivor curve may be trusted to SIZE the dispatch. False during/after camera motion
		// (or resize) until a readback measured at the settled view re-validates it — full-size until then so
		// a stale/mid-motion curve can't under-size the row-major list and drop the bottom rows. The curve is
		// still used for the per-bounce early-exit regardless (it only trims bounces holding negligible energy).
		this._curveSizingValid = false;
		// Early exit once the survivors' summed throughput is below this fraction of a full frame's; -1
		// disables. Never a ray count: after Russian roulette a handful of survivors carry real weight.
		this._bounceEarlyExitThreshold = 1e-4;

		// Tier-1 convergence early-stop: fraction of pixels converged in the last settled-view readback, and a
		// single-flight guard for its async counter read. Zeroed on reset/camera-move/resize; never refreshed
		// mid-motion (the readback early-return + frozen frameCount keep the stop from firing while moving).
		this._convergedFraction = 0;
		// Subject-only convergence, from the same eroded bits. Starts at 0 so the stop cannot fire unmeasured.
		this._convergedGeometryFraction = 0;
		this._geometryPixelCount = 0;
		this._convergedReadbackPending = false;

		// Lockstep: readbacks issued on a fixed cadence and applied a fixed number of frames later,
		// so when one lands cannot change the image. { due, read, apply } while one is in flight.
		this._lockstep = false;
		this._lockstepRead = null;
		this._accumulationLockstep = false;

		// Tier-2: last settled active-pixel count (maxRays − frozen), sizes next frame's bounce-0 grid.
		// 0 until a settled readback lands (and on reset/camera-move/resize) → grid stays full-size until then.
		this._lastActivePixelCount = 0;

		this._wfRenderWidth = uniform( 1920, 'int' );
		this._wfRenderHeight = uniform( 1080, 'int' );
		this._wfMaxRayCount = uniform( 0, 'uint' );
		this._wfCurrentBounce = uniform( 0, 'int' );

		// Blender-style chunked path pool (docs/internal/specs/wavefront-chunked-pool.md): the per-path SoA
		// pool holds a fixed device-budget B of paths-in-flight, decoupled from resolution. The image is
		// streamed through it in row bands; these uniforms carry the current band's offset so kernels map
		// local path slot r ↔ global pixel p = pixelBase + r (pixelBase = _wfChunkRowBase · renderWidth).
		this._wfChunkRowBase = uniform( 0, 'int' ); // first GLOBAL row of the current chunk
		this._wfChunkRows = uniform( 0, 'int' ); // number of rows in the current chunk (≤ chunkRows)
		this._wfIsFirstChunk = uniform( 1, 'uint' ); // 1 → zero frame-scoped counters (CONVERGED/FROZEN)
		this._pathBudget = 0; // B, paths-in-flight; computed once from device limits in _buildWavefrontKernels
		this._pathBudgetOverride = 0; // test hook: force B (0 = derive from device)
		this.hostMemoryGB = options.hostMemoryGB;
		this._chunkRows = 0; // rows per chunk = floor(B / renderWidth), clamped ≥1
		this._numChunks = 1; // ceil(renderHeight / chunkRows)

		// Outputs a later stage asked for (requestOutput), compiled into Shade only while asked.
		this._outputs = new Map();
		this._outputsChanged = false;

		// Bidirectional integrator (setIntegrator). Off builds exactly the unidirectional kernels.
		this._bidirectionalEnabled = false;
		this._mergingEnabled = false;
		this._mergeRadiusPixels = MERGE_RADIUS_PIXELS;
		this._mergeHeadAttr = null;
		this._lightCacheSlots = 0;
		this._splatAttr = null;
		this._lightTag = 0;
		this._passTag = 0;
		this._lastLightBounceCounts = null;
		this._lastLightBounceEnergy = null;
		this._lastLightCurveKey = null;
		this._lightCurveKey = null;
		this._bidirectional = {
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

		// VRAM accounting — providers are thunks reading CURRENT live resources,
		// so they survive buffer/texture reallocation (resize, scene/material reload).
		this.vramTracker = new VRAMTracker( this.renderer );
		this._registerVRAMProviders();

		log.debug( 'initialized (wavefront)' );

	}

	_registerVRAMProviders() {

		const t = this.vramTracker;

		// Wavefront ray-state SoA buffers (rw/ro nodes share one GPU buffer per attr)
		t.register( 'rays', () => {

			const a = this._packedBuffers?._attrs;
			return a ? [ a.ray, a.rng, a.hit ] : null;

		} );

		// Light tracing's splat image (the light vertex cache rides in the hit buffer, under 'rays')
		t.register( 'bidirectional', () => ( this._splatAttr ? [ this._splatAttr, this._mergeHeadAttr ].filter( Boolean ) : null ) );

		// Queue indices + atomic counters
		t.register( 'queues', () => {

			const qm = this._queueManager;
			if ( ! qm ) return null;
			return [
				qm._countersAttr, qm._bounceCountsAttr,
				qm._attrA, qm._attrB, qm._sortAttr,
			];

		} );

		// Per-pixel first-hit G-buffer (normal/depth + albedo) + convergence m2 buffer + Tier-2 freeze streak
		t.register( 'gbuffer', () => {

			const a = [];
			if ( this._gBufferAttr ) a.push( this._gBufferAttr );
			if ( this._m2Attr ) a.push( this._m2Attr );
			if ( this._streakAttr ) a.push( this._streakAttr );
			if ( this._frozenMaskAttr ) a.push( this._frozenMaskAttr );
			return a.length ? a : null;

		} );

		// Accumulation pool: 3 write StorageTextures (2048²) + readable MRT RenderTarget
		t.register( 'accum', () => {

			const sp = this.storageTextures;
			return sp ? [ sp.writeColor, sp.writeNormalDepth, sp.writeAlbedo, sp.readTarget ] : null;

		} );

		// Scene geometry (triangle data, two-level BVH, light BVH + emissive)
		t.register( 'geometry', () => [ this.triangleGeoAttr, this.triangleShadeAttr, this.bvhStorageAttr, this.lightStorageAttr ] );

		// Material storage buffer + per-property texture arrays
		t.register( 'materials', () => {

			const m = this.materialData;
			if ( ! m ) return null;
			return [
				m.materialStorageAttr,
				...( m.srgbBuckets || [] ).filter( Boolean ),
				...( m.linearBuckets || [] ).filter( Boolean ),
			];

		} );

		// Environment map + importance-sampling CDF
		t.register( 'environment', () => {

			const e = this.environment;
			return e ? [ e.environmentTexture, e.envCDFTexture ] : null;

		} );

	}

	setupMaterial() {

		super.setupMaterial();

		// First setupMaterial call has 0 triangles/materials — skip it.
		if ( this.materialData?.materialCount > 0 ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		}

	}

	/**
	 * Asks Shade for an extra per-pixel output, compiled in only while someone asks for it; the kernels rebuild
	 * before the next frame. `'hitDistance'`: the first bounce's segment plus any alpha-skip run, at camera
	 * depth 1, as `encode( distance, viewZ )` returns it — a [0, 1] value, in `pathtracer:albedo.w`. Written only
	 * while the aux outputs are on.
	 * @param {'hitDistance'} name
	 * @param {{encode: function(Node, Node): Node}} options
	 * @returns {function(): void} withdraws the request
	 */
	requestOutput( name, options ) {

		this._outputs.set( name, options );
		this._outputsChanged = true;

		return () => {

			if ( this._outputs.get( name ) !== options ) return;
			this._outputs.delete( name );
			this._outputsChanged = true;

		};

	}

	/**
	 * Switching rebuilds the kernels: only the bidirectional ones bind the light vertex cache and splat image.
	 * 'vcm' is bidirectional with vertex merging (photon mapping) added as a strategy.
	 * @param {'path'|'bidirectional'|'vcm'} name
	 */
	setIntegrator( name ) {

		const enabled = name === 'bidirectional' || name === 'vcm';
		const merging = name === 'vcm';
		if ( enabled === this._bidirectionalEnabled && merging === this._mergingEnabled ) return;
		this._bidirectionalEnabled = enabled;
		this._mergingEnabled = merging;
		this._bidirectional.merging = merging;
		this._pathBudget = 0;
		this._lastLightCurveKey = null;

		if ( this._packedBuffers && this.materialData?.materialCount > 0 ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		}

	}

	/**
	 * Verification only: keep one bidirectional strategy, MIS-weighted, or alone at full weight.
	 * @param {'all'|'hit'|'nee'|'connect'|'lightTrace'|'merge'} strategy
	 */
	setBidirectionalStrategy( strategy = 'all', { alone = false } = {} ) {

		const code = { all: STRATEGY.ALL, hit: STRATEGY.HIT, nee: STRATEGY.NEE, connect: STRATEGY.CONNECT, lightTrace: STRATEGY.LIGHT_TRACE, merge: STRATEGY.MERGE }[ strategy ] ?? STRATEGY.ALL;
		this._bidirectional.strategyView.value = code === STRATEGY.ALL ? code : code + ( alone ? STRATEGY_ALONE : 0 );

	}

	get integrator() {

		return this._mergingEnabled ? 'vcm' : this._bidirectionalEnabled ? 'bidirectional' : 'path';

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

		this._bidirectional.mergeTrust.value = Math.max( trust, 1e-4 );

	}

	render( context ) {

		// Kernels not built yet (first frame / mid-resize) — skip until ready.
		if ( ! this.isReady || ! this._wavefrontReady ) return;

		// The packed light buffer was grow-reallocated at runtime (emissive set grew) or a light list grew —
		// the compiled kernels still bind the old one, so rebuild before rendering. Likewise a changed output request.
		if ( this._lightBufferRealloc || this._outputsChanged ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();
			if ( ! this._wavefrontReady ) return;

		}

		const lockstepRead = this._lockstepRead;
		if ( lockstepRead && this.frameCount >= lockstepRead.due ) {

			if ( ! lockstepRead.apply ) return; // see readbackWait()
			this._lockstepRead = null;
			lockstepRead.apply();

		}

		if ( this.isComplete || this.frameCount >= this.completionThreshold || this._isConvergedComplete() ) {

			// Denoiser switched on after the render finished — spend one more frame to fill the aux MRT.
			if ( this._auxSeedPending ) {

				this.isComplete = false;

			} else {

				if ( ! this.isComplete ) this.isComplete = true;
				return;

			}

		}

		this.performanceMonitor?.start();

		const frameValue = this.frameCount;
		const renderMode = this.renderMode.value;

		let originalMaxBounces = null;

		if ( renderMode === 1 && frameValue === 0 ) {

			originalMaxBounces = this.maxBounces.value;
			this.maxBounces.value = 1;

		}

		this._handleResize();
		this.manageASVGFForRenderMode( renderMode );

		// Full-frame render is always a complete cycle (PER_CYCLE stages gate on this).
		if ( context ) context.setState( 'tileRenderingComplete', true );

		this.cameraChanged = this._updateCameraUniforms();
		this.cameraOptimizer?.updateInteractionMode( this.cameraChanged );
		// While the camera moves, the survivor curve reflects a pose we're leaving (async readback lag), so
		// trusting it to SIZE the dispatch would under-size the row-major list and drop the tail (bottom
		// rows) — the streaks during motion and the flash when it stops. Mark the curve untrusted-for-sizing
		// (→ full-size those frames) until a readback measured at the settled view re-validates it; bump the
		// generation so any in-flight readback is discarded. The curve itself is kept for the early-exit.
		if ( this.cameraChanged ) {

			this._curveSizingValid = false;
			this._readbackGeneration ++;
			// Drop the stale converged fraction so the early-stop can't fire on the pose we're leaving.
			this._convergedFraction = 0;
			this._convergedGeometryFraction = 0;
			// Tier-2: drop the stale active-pixel count so bounce 0 full-sizes until the new pose re-measures.
			this._lastActivePixelCount = 0;

		}

		this._updateAccumulationUniforms( frameValue );
		const auxMixes = this._updateAuxAccumulationUniforms( frameValue );
		this.frame.value = frameValue;
		this.seedFrame.value = this._seedTick ++;
		this.tracedFrames ++;
		if ( ! this._lockstep ) this._accumulationLockstep = false;

		this._setWfDispatch();

		const readTextures = this.storageTextures.getReadTextures();
		if ( this.shaderBuilder.prevColorTexNode ) {

			this.shaderBuilder.prevColorTexNode.value = readTextures.color;
			this.shaderBuilder.prevAlbedoTexNode.value = readTextures.albedo;
			this.shaderBuilder.prevNormalDepthTexNode.value = readTextures.normalDepth;

		}

		// Wavefront's texture nodes are independent; monolithic's updateSceneTextures doesn't reach them.
		this._refreshWfTextureNodes();

		const km = this._kernelManager;

		// Debug visualization (visMode 1-10): single-pass primary-ray kernel — no bounce loop or
		// accumulation. Mode 11 (NaN/Inf) flows through the normal pipeline below; FinalWrite flags it.
		if ( ( this.visMode?.value | 0 ) > 0 && this.visMode.value !== 11 ) {

			km.dispatch( 'debug' );

			this.storageTextures.copyToReadTargets( this.renderer );
			const dbgReadTex = this.storageTextures.getReadTextures();
			if ( context ) this._publishTexturesToContext( context, dbgReadTex );

			this._emitStateEvents();
			// Don't count interaction-mode (1-SPP feedback) frames toward completion (megakernel parity Stages/PathTracer.js:1240) — else a continuous orbit "completes" on noise.
			if ( ! this.cameraOptimizer?.isInInteractionMode() ) this.frameCount ++;

			if ( originalMaxBounces !== null ) this.maxBounces.value = originalMaxBounces;

			this.performanceMonitor?.end();
			return;

		}

		const maxBounces = this.maxBounces.value;
		// Transmissive/SSS steps consume iterations without advancing camera-bounce depth, so the loop must run far enough for deep glass/subsurface walks (mirror PathTracerCore); the survivor curve + early-exit break it early on non-SSS scenes.
		const loopBound = this._bounceLoopBound();

		const frameHeight = this._wfRenderHeight.value;
		const chunkRows = this._chunkRows;
		const singleChunk = this._numChunks <= 1;

		// The survivor curve is a single per-frame buffer; multi-chunk bands would overwrite each other's
		// counts, so curve-based sizing AND the per-bounce early-exit apply only in the single-chunk regime
		// (the common case → behaviour identical to before). Multi-chunk (huge frame / small budget) runs full
		// dispatch over every bounce — correct, mildly slower.
		//
		// The curve survives a maxBounces change (reset() preserves it): for iterations below BOTH the old and
		// new camera-bounce caps the counts are cap-independent, so trust it up to that cutoff (whole curve when
		// same/decreasing budget; only the [0, oldBudget) overlap when increasing). budget=-1 → cutoff 0 → full
		// dispatch everywhere. This avoids the full-work spike on every bounce-count change.
		// A curve measured with a smaller free-bounce budget under-counts survivors at EVERY depth, not
		// just past its tail, so sizing off it drops the deep glass paths the bigger budget bought.
		if ( loopBound > this._lastBounceCountsLoopBound ) this._curveSizingValid = false;

		const curve = this._lastBounceCounts;
		const curveMeasuredThisFar = maxBounces <= this._lastBounceCountsBudget
			&& loopBound <= this._lastBounceCountsLoopBound;
		const curveReliableUpto = ( singleChunk && curve )
			? ( curveMeasuredThisFar
				? loopBound + 1
				: Math.min( this._lastBounceCountsBudget, this._lastBounceCountsLoopBound ) )
			: 0;

		// Light subpaths first, through the same pool; every camera chunk then connects to them.
		const bidirectional = this._bidirectionalEnabled && this._updateBidirectionalUniforms();
		const lightTraced = bidirectional && this._bidirectional.lightTrace.value > 0;
		if ( bidirectional ) {

			this._updateLightGuide();
			this._traceLightPaths( loopBound );

		}

		// Blender-style row-band streaming: the fixed-budget path pool processes the image in bands of ≤ chunkRows
		// rows (one chunk when the frame fits the budget → identical to the pre-chunking path). See spec.
		for ( let chunkIndex = 0, rowBase = 0; rowBase < frameHeight; rowBase += chunkRows, chunkIndex ++ ) {

			const rows = Math.min( chunkRows, frameHeight - rowBase );
			const maxRays = this._setChunk( rowBase, rows, chunkIndex ); // this band's pixel count + per-chunk grids

			// Tier-2 bounce-0 grid size from the stale settled active-pixel count (single-chunk only; else full).
			// Monotonic freeze ⇒ a stale count is a safe over-estimate; reset/camera-move → _curveSizingValid=false.
			// An aux seed frame must trace every pixel: Generate/Shade skip the G-buffer for frozen ones.
			const adaptiveFreeze = this.usePixelFreeze.value > 0 && ! this._auxSeedPending;
			const activeBounce0 = ( singleChunk && adaptiveFreeze && this._curveSizingValid && this._lastActivePixelCount > 0 )
				? this._lastActivePixelCount : maxRays;

			if ( adaptiveFreeze ) {

				// reset counters → compact non-frozen pixel IDs → publish count → list-driven 1D generate.
				const genSized = Math.min( maxRays, Math.ceil( activeBounce0 * 1.5 ) + 1024 );
				km.setDispatchForCount( 'generateList', genSized );
				km.dispatch( 'resetFrameCounters' );
				km.dispatch( 'buildActivePixels' );
				km.dispatch( 'seedEnter' );
				km.dispatch( 'generateList' );

			} else {

				km.dispatch( 'generate' );
				// Generate traces every pixel in the band; initActiveIndices seeds the identity active list + counts
				// (it overwrites ACTIVE + ENTERING, so no separate frame-start reset is needed).
				km.dispatch( 'initActiveIndices' );

			}

			// Full-frame kernel, so first chunk only, after the zeroing above. Frame 0 skips it — those bits
			// still belong to the pre-reset view. Only on frames whose counters are actually read back.
			if ( chunkIndex === 0 && frameValue > 0 && this.useAdaptiveSampling.value > 0 && this._willReadCountersThisFrame() ) {

				km.dispatch( 'countConvergedDilated' );

			}

			const energyCurve = this._lastBounceEnergy;
			const exitEnergy = this._bounceEarlyExitThreshold >= 0 ? this._bounceEarlyExitThreshold * maxRays * ENERGY_SCALE : - 1;

			for ( let bounce = 0; bounce <= loopBound; bounce ++ ) {

				this._wfCurrentBounce.value = bounce;

				// Functional-compaction path (dynamic dispatch): copyback keeps the read buffer dense, kernels sized to live survivors. Dynamic-off uses the full path (ENTERING=maxRays, identity buffer).
				// Material sort is compatible: shade reads sortedIndices while compact still reads the UNSORTED active list (getActiveReadRO), so the survivor set is unchanged.
				const useFunctionalCompaction = this._useDynamicDispatch;
				if ( useFunctionalCompaction ) {

					// ENTERING_COUNT already set (bounce 0 by initActiveIndices, N>0 by snapshotBounceCount); size from last frame's survivor curve with a 1.5×+1024 margin (single-chunk only).
					let entering = maxRays;
					if ( singleChunk && bounce > 0 && this._curveSizingValid ) {

						const idx = bounce - 1;
						let prev;
						if ( idx < curveReliableUpto && curve[ idx ] !== undefined ) {

							prev = curve[ idx ]; // trusted exact count

						} else if ( curveReliableUpto > 0 ) {

							// Untrusted tail after a maxBounces increase: survivor counts are monotonically
							// non-increasing (rays only terminate), so the last trusted count is a safe upper bound.
							prev = curve[ curveReliableUpto - 1 ];

						}

						entering = prev > 0 ? prev : maxRays;

					} else if ( bounce === 0 && adaptiveFreeze ) {

						// Bounce 0 traces only non-frozen pixels — size from the stale active count (full until a readback).
						entering = activeBounce0;

					}

					const sized = Math.min( maxRays, Math.ceil( entering * 1.5 ) + 1024 );
					for ( const k of BOUNCE_KERNELS ) km.setDispatchForCount( k, sized );

				} else {

					km.dispatch( 'enterFull' );
					for ( const k of BOUNCE_KERNELS ) km.setDispatchForCount( k, maxRays );

				}

				// Extend/Shade kept separate (not fused): a fused kernel's register pressure drops occupancy more than fusion saves.
				km.dispatch( 'extend' );
				if ( this._sortMaterials ) {

					// Global material counting sort (material-pure workgroups): reset, histogram, prefix-sum, scatter.
					km.dispatch( 'resetGlobalHist' );
					km.dispatch( 'globalHist' );
					km.dispatch( 'globalPrefix' );
					km.dispatch( 'globalScatter' );

				}

				if ( bidirectional ) this._bidirectional.passTag.value = this._nextPassTag();
				km.dispatch( 'shade' ); // shade thread 0 folds resetActiveCounter (zeroes ACTIVE_RAY_COUNT before compact)
				if ( bidirectional ) km.dispatch( 'connect' );
				if ( bidirectional && this._mergingEnabled ) km.dispatch( 'merge' );
				km.dispatch( 'compact' );
				if ( useFunctionalCompaction ) {

					// compactCopyback thread 0 folds snapshotBounceCount (records the survivor curve + seeds ENTERING).
					km.dispatch( 'compactCopyback' );

				} else {

					km.dispatch( 'snapshotBounceCount' );

				}
				// No swap: pingPong stays 0 (kernels are build-time-bound to buffer A).

				// Early-exit on last frame's per-bounce snapshot (single-chunk only; curveReliableUpto=0 disables it for multi-chunk).
				if (
					exitEnergy >= 0
					&& bounce < curveReliableUpto
					&& bounce < loopBound
					&& energyCurve?.[ bounce ] !== undefined
					&& energyCurve[ bounce ] <= exitEnergy
				) {

					break;

				}

			}

			if ( lightTraced ) km.dispatch( 'splatResolve' );
			km.dispatch( 'finalWrite' );

		}

		this._maybeReadbackCounters();

		// Skip the normalDepth/albedo copies when aux is off — the wavefront didn't write them and
		// no stage reads them; saves two full-res GPU copies/frame in the default interactive path.
		this.storageTextures.copyToReadTargets( this.renderer, this._auxGBufferEnabled );

		const readTex = this.storageTextures.getReadTextures();
		if ( context ) this._publishTexturesToContext( context, readTex );

		this._emitStateEvents();
		// Don't count interaction-mode (1-SPP feedback) frames toward completion (megakernel parity Stages/PathTracer.js:1240) — else a continuous orbit "completes" on noise.
		if ( ! this.cameraOptimizer?.isInInteractionMode() ) this.frameCount ++;

		if ( this._auxGBufferEnabled ) this._auxSamples = auxMixes ? this._auxSamples + 1 : 1;
		this._auxSeedPending = false;

		if ( originalMaxBounces !== null ) this.maxBounces.value = originalMaxBounces;

		this.performanceMonitor?.end();

	}

	// False when nothing can start a light path.
	_updateBidirectionalUniforms() {

		const bd = this._bidirectional;
		const w = this._wfRenderWidth.value;
		const h = this._wfRenderHeight.value;
		const slots = this.maxBounces.value + 1;
		const total = this._updateSourceTable();
		const paths = total > 0
			? Math.min( Math.ceil( w * h * LIGHT_PATHS_PER_PIXEL ), this._packedBuffers.capacity, Math.floor( this._lightCacheSlots / slots ) )
			: 0;

		bd.lightPaths.value = paths;
		bd.slotsPerPath.value = slots;
		this._lightCurveKey = `${paths}:${slots}:${this._bounceLoopBound()}`;
		if ( paths === 0 ) {

			bd.lightTrace.value = 0;
			return false;

		}

		this._lightTag = this._lightTag % LIGHT_TAG_MAX + 1;
		bd.lightTag.value = this._lightTag;

		const world = this.cameraWorldMatrix.value.elements;
		bd.cameraPosition.value.set( world[ 12 ], world[ 13 ], world[ 14 ] );
		bd.cameraForward.value.set( - world[ 8 ], - world[ 9 ], - world[ 10 ] ).normalize();
		const projection = this.cameraProjectionMatrix.value.elements;
		bd.pixelArea.value = 4 / ( projection[ 0 ] * projection[ 5 ] * w * h );
		// Light tracing needs a pinhole camera.
		const pinhole = this.cameraProjection.value === CAMERA_PROJECTION_IDS.perspective && ! this.enableDOF.value;
		bd.lightTrace.value = pinhole ? 1 : 0;
		if ( this._mergingEnabled ) this._updateMergeRadius( w, h );
		return true;

	}

	// A pixel's footprint: grows with the distance from a perspective or panoramic camera, constant for an orthographic one.
	_updateMergeRadius( w, h ) {

		const bd = this._bidirectional;
		const pixels = this._mergeRadiusPixels * Math.pow( this.frameCount + 1, ( MERGE_ALPHA - 1 ) / 2 );
		const projection = this.cameraProjection.value;
		const p = this.cameraProjectionMatrix.value.elements;
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

		const bd = this._bidirectional;
		let at = SOURCE.LAMPS;
		[ 'directional', 'area', 'point', 'spot' ].forEach( ( type, i ) => {

			bd.sourceOffsets[ i ] = at;
			at += this[ `${type}LightsBufferNode` ].array.length / LIGHT_FLOATS[ type ];

		} );
		bd.sourceCount = at;
		if ( bd.sourceCdf.array.length !== at ) bd.sourceCdf.array = new Float32Array( at );

	}

	/**
	 * Each source's chance of starting a light path, by the luminous flux it sends into the scene.
	 * @returns {number} the total flux, 0 when nothing emits
	 */
	_updateSourceTable() {

		const bd = this._bidirectional;
		const cdf = bd.sourceCdf.array;
		const flux = new Float64Array( cdf.length );
		const lum = ( a, i ) => Math.max( 0.2126 * a[ i ] + 0.7152 * a[ i + 1 ] + 0.0722 * a[ i + 2 ], 0 );
		const lights = ( type ) => ( { a: this[ `${type}LightsBufferNode` ].array, n: this[ `num${type[ 0 ].toUpperCase()}${type.slice( 1 )}Lights` ].value, f: LIGHT_FLOATS[ type ] } );
		const directional = lights( 'directional' );

		const environmentOn = this.enableEnvironment.value > 0;
		const table = this.environment.exactTable;
		bd.envTable.value = table ? 1 : 0;
		const atInfinity = environmentOn && ( this.hasSun.value > 0 || table ) || directional.n > 0;
		// What a light at infinity sends through the scene's disc mostly lands where its NEE does better: next to
		// lamps or emitters it gets this share of its flux in light paths (alone, it gets them all regardless).
		// Vertex merging sizes its radius by the scene, so it measures the disc too.
		const disc = atInfinity || this._mergingEnabled ? this._sceneDisc() : 0;
		const discArea = atInfinity ? disc * INFINITE_LIGHT_PATH_SHARE : 0;
		if ( environmentOn && table ) flux[ SOURCE.ENVIRONMENT ] = Math.max( table.radianceIntegral, 0 ) * this.environmentIntensity.value * discArea;

		if ( this.emissiveTriangleCount.value > 0 ) flux[ SOURCE.EMITTERS ] = Math.PI * this.emissiveBoost.value * this.emissiveTotalPower.value;
		if ( environmentOn && this.hasSun.value > 0 ) {

			const { x: r, y: g, z: b } = this.sunRadiance.value;
			flux[ SOURCE.SUN ] = Math.max( 0.2126 * r + 0.7152 * g + 0.0722 * b, 0 ) * this.environmentIntensity.value * this.sunParams.value.y * discArea;

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

		const bd = this._bidirectional;
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

		const records = this._bvhRecords;
		const flat = records ? null : this.bvhStorageAttr?.array;
		if ( ! records && ! ( flat?.length >= 16 ) ) return null;

		const view = ( f ) => {

			let u = this._u32Views.get( f );
			if ( ! u ) this._u32Views.set( f, u = new Uint32Array( f.buffer, f.byteOffset, f.length ) );
			return u;

		};

		const node = ( i ) => {

			const f = records ? records.chunkFor( i ) : flat;
			return { f, u: view( f ), o: records ? records.baseOf( i ) : i * 16 };

		};

		const root = node( 0 );
		if ( root.u[ root.o + 3 ] >= BVH_MAX_INDEX ) return null;

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
			while ( stack.length ) {

				const s = stack.pop(), index = stack.pop();
				if ( s <= best ) continue;
				const n = node( index );
				if ( n.u[ n.o + 3 ] >= BVH_MAX_INDEX ) {

					if ( n.f[ n.o + 2 ] !== 0 ) best = s;

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
		this._bidirectional.guide.value = 0;
		this.reset();

	}

	_updateLightGuide() {

		const bd = this._bidirectional;
		const km = this._kernelManager;
		bd.guideLearning.value = this._lightGuiding ? 1 : 0;
		const f = this.frameCount;
		if ( f === 0 ) {

			km.dispatch( 'guideClear' );
			bd.guide.value = 0;
			return;

		}

		if ( ! this._lightGuiding || ! ( f <= 32 ? ( f & ( f - 1 ) ) === 0 : f % 32 === 0 ) ) return;
		km.dispatch( 'guideBuild' );

		const backend = this.renderer.backend;
		this.renderer.initTexture( this._guideTexture );
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

		freeStorageAttribute( this.renderer, this._guideBuildAttr );
		this._guideTexture?.dispose();
		this._guideTexture = this._guideBuildAttr = null;
		this._bidirectional.guideTexture = null;

	}

	_nextPassTag() {

		this._passTag = ( this._passTag + 1 ) & 0x7FFFFFFF;
		return ( PASS_TAG_BIT | this._passTag ) >>> 0;

	}

	// Sized and cut short off its own survivor curve, as the camera loop is.
	_traceLightPaths( loopBound ) {

		const km = this._kernelManager;
		const paths = this._bidirectional.lightPaths.value;

		this._wfChunkRowBase.value = 0;
		this._wfMaxRayCount.value = paths;
		km.setDispatchForCount( 'lightGenerate', paths );
		km.dispatch( 'lightGenerate' );

		const dynamic = this._useDynamicDispatch;
		const curveValid = this._lastLightCurveKey === this._lightCurveKey;
		const counts = curveValid ? this._lastLightBounceCounts : null;
		const energy = curveValid ? this._lastLightBounceEnergy : null;
		const exitEnergy = this._bounceEarlyExitThreshold >= 0 ? this._bounceEarlyExitThreshold * paths * ENERGY_SCALE : - 1;

		for ( let bounce = 0; bounce <= loopBound; bounce ++ ) {

			this._wfCurrentBounce.value = bounce;

			const prev = bounce > 0 ? counts?.[ bounce - 1 ] : undefined;
			const sized = dynamic && prev > 0 ? Math.min( paths, Math.ceil( prev * 1.5 ) + 1024 ) : paths;
			for ( const k of BOUNCE_KERNELS ) km.setDispatchForCount( k, sized );
			if ( ! dynamic ) km.dispatch( 'enterFull' );

			km.dispatch( 'extend' );
			if ( this._sortMaterials ) {

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

		if ( this._bidirectional.lightTrace.value > 0 ) {

			km.setDispatchForCount( 'lightSplat', paths * this._bidirectional.slotsPerPath.value );
			km.dispatch( 'lightSplat' );

		}

		if ( this._mergingEnabled ) {

			km.dispatch( 'mergeClear' );
			km.setDispatchForCount( 'mergeInsert', paths * this._bidirectional.slotsPerPath.value );
			km.dispatch( 'mergeInsert' );

		}

	}

	// Tier-1 convergence early-stop: retire the WHOLE frame once enough samples have accumulated AND ~all pixels
	// hit the relative-error floor. Keeps the global 1/(frame+1) alpha untouched — only the stop condition
	// changes. Naturally gated off while moving: frameCount is frozen in interaction mode (< minSamples) and
	// _convergedFraction is zeroed on camera-move and never refreshed mid-motion (readback early-returns).
	_isConvergedComplete() {

		// BOTH fractions must clear the bar. The whole-frame one counts every pixel, so it is diluted by
		// however much easy background is in shot — the bar effectively becomes (bar−bgShare)/(1−bgShare) on
		// the subject, which makes it framing-dependent. The geometry-only fraction gates that. Neither
		// replaces the other: background can be genuinely noisy (DOF, sharp env under AA jitter), and then
		// the whole-frame fraction is the binding one.
		return this.useAdaptiveSampling.value > 0
			&& this.frameCount >= this.adaptiveMinSamples.value
			&& this._convergedFraction >= this.adaptiveStopFraction.value
			&& this._convergedGeometryFraction >= this.adaptiveStopFraction.value;

	}

	/**
	 * The accumulation as it stands, for a checkpoint: the three MRT attachments (aux only while it
	 * holds samples), the per-pixel convergence buffers, and the counters that decide the next
	 * sample — together what a later frame reads, so restoring them continues the same sequence.
	 * @returns {Promise<Object>} typed arrays, tight rows, top row first as the textures hold them
	 */
	async captureAccumulation() {

		const pool = this.storageTextures;
		const width = pool.renderWidth;
		const height = pool.renderHeight;
		const pixels = width * height;

		const readAttachment = async index => {

			const padded = await this.renderer.readRenderTargetPixelsAsync( pool.readTarget, 0, 0, width, height, index );
			const stride = Math.ceil( width * 16 / 256 ) * 64;
			if ( stride === width * 4 ) return new Float32Array( padded.buffer, padded.byteOffset, pixels * 4 ).slice();
			const tight = new Float32Array( pixels * 4 );
			for ( let y = 0; y < height; y ++ ) tight.set( padded.subarray( y * stride, y * stride + width * 4 ), y * width * 4 );
			return tight;

		};

		const readBuffer = async ( attr, Type ) => attr ? new Type( await this.renderer.getArrayBufferAsync( attr, null, 0, pixels * 4 ) ) : null;
		const aux = this._auxGBufferEnabled && this._auxSamples > 0;

		// Every copy is submitted here, in this task, before any await: a frame rendered between two of
		// them would give a checkpoint whose parts disagree.
		const state = {
			frameCount: this.frameCount,
			seedTick: this._seedTick,
			auxSamples: aux ? this._auxSamples : 0,
			convergedFraction: this._convergedFraction,
			convergedGeometryFraction: this._convergedGeometryFraction,
			isComplete: this.isComplete,
		};
		const reads = [
			readAttachment( 0 ),
			aux ? readAttachment( 1 ) : null,
			aux ? readAttachment( 2 ) : null,
			readBuffer( this._m2Attr, Float32Array ),
			readBuffer( this._streakAttr, Uint32Array ),
			readBuffer( this._frozenMaskAttr, Uint32Array ),
		];
		const [ color, normalDepth, albedo, m2, streak, frozenMask ] = await Promise.all( reads );

		return { width, height, state, color, normalDepth, albedo, m2, streak, frozenMask };

	}

	/**
	 * Writes a {@link captureAccumulation} back, so the next frame continues it. The render size must
	 * match; nothing may reset accumulation after this.
	 */
	restoreAccumulation( checkpoint ) {

		const pool = this.storageTextures;
		const { width, height, state } = checkpoint;
		if ( pool.renderWidth !== width || pool.renderHeight !== height ) {

			throw new Error( `checkpoint is ${width}×${height}; the render is ${pool.renderWidth}×${pool.renderHeight}` );

		}

		const backend = this.renderer.backend;
		const device = backend.device;
		if ( ! backend.get( pool.readTarget.textures[ 0 ] ).texture ) this.renderer.initRenderTarget( pool.readTarget );

		const writeAttachment = ( index, data ) => device.queue.writeTexture(
			{ texture: backend.get( pool.readTarget.textures[ index ] ).texture },
			data,
			{ bytesPerRow: width * 16, rowsPerImage: height },
			{ width, height },
		);

		const writeBuffer = ( attr, data ) => {

			if ( attr && data ) device.queue.writeBuffer( backend.get( attr ).buffer, 0, data );

		};

		writeAttachment( 0, checkpoint.color );
		if ( checkpoint.normalDepth ) writeAttachment( 1, checkpoint.normalDepth );
		if ( checkpoint.albedo ) writeAttachment( 2, checkpoint.albedo );
		writeBuffer( this._m2Attr, checkpoint.m2 );
		writeBuffer( this._streakAttr, checkpoint.streak );
		writeBuffer( this._frozenMaskAttr, checkpoint.frozenMask );

		this.frameCount = state.frameCount;
		this.frame.value = state.frameCount;
		this._seedTick = state.seedTick;
		this.hasPreviousAccumulated.value = state.frameCount > 0 ? 1 : 0;
		this._auxSamples = checkpoint.normalDepth ? state.auxSamples : 0;
		this._auxSeedPending = this._auxGBufferEnabled && ! checkpoint.normalDepth;
		this._convergedFraction = state.convergedFraction ?? 0;
		this._convergedGeometryFraction = state.convergedGeometryFraction ?? 0;
		this.isComplete = false;
		// The survivor curve is not in a checkpoint, so a continuation is not the lockstep render.
		this._accumulationLockstep = false;

	}

	reset() {

		super.reset();
		this._convergedFraction = 0;
		this._convergedGeometryFraction = 0;
		this._lastActivePixelCount = 0;
		this._auxSamples = 0;
		this._auxSeedPending = false;

		if ( this._lockstep ) {

			// Nothing measured by the previous render may steer this one.
			this._lockstepRead = null;
			this._readbackGeneration ++;
			this._lastBounceCounts = null;
			this._lastBounceEnergy = null;
			this._lastBounceCountsBudget = - 1;
			this._lastBounceCountsLoopBound = - 1;
			this._curveSizingValid = false;

		}

	}

	/**
	 * Lockstep readbacks: the survivor curve and the convergence counters are read every N frames
	 * and applied exactly N frames later, waiting when they have not landed, and every reset starts
	 * from nothing measured and from seed 0. The same input then renders the same image however fast
	 * frames are submitted. Off by default: waiting costs a stall whenever the GPU falls N frames behind.
	 * @param {boolean} enabled
	 */
	setLockstepReadbacks( enabled ) {

		enabled = !! enabled;
		if ( enabled === this._lockstep ) return;
		this._lockstep = enabled;
		this._lockstepRead = null;
		this._readbackGeneration ++;

	}

	get lockstepReadbacks() {

		return this._lockstep;

	}

	/** Whether the current image was traced in lockstep from a reset made in it; with no sample yet, the setting. */
	get accumulationLockstep() {

		return this.frameCount > 0 ? this._accumulationLockstep : this._lockstep;

	}

	/**
	 * While a lockstep readback is due and has not landed, render() traces nothing: await this
	 * before the next frame. Null otherwise.
	 * @returns {?Promise<void>}
	 */
	readbackWait() {

		const pending = this._lockstepRead;
		return pending && ! pending.apply && this.frameCount >= pending.due ? pending.read : null;

	}

	/**
	 * Per-pixel convergence state for the Compositor's debug overlay: the buffers FinalWrite maintains
	 * plus the uniforms needed to re-derive its predicate. Read-only — the overlay never writes back.
	 * Null until the wavefront kernels exist.
	 */
	getConvergenceDebugSource() {

		if ( ! this._m2Attr || ! this._frozenMaskAttr ) return null;
		// Polled every frame while the overlay is on — rebuild only when the buffers actually change.
		if ( this._convDebugSource?.m2 === this._m2Attr && this._convDebugSource.frozenMask === this._frozenMaskAttr ) {

			return this._convDebugSource;

		}

		this._convDebugSource = {
			m2: this._m2Attr,
			frozenMask: this._frozenMaskAttr,
			frame: this.frame,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			noiseThreshold: this.noiseThreshold,
			pixelFreezeThreshold: this.pixelFreezeThreshold,
			usePixelFreeze: this.usePixelFreeze,
			adaptiveMinSamples: this.adaptiveMinSamples,
		};

		return this._convDebugSource;

	}

	/**
	 * Whole-frame adaptive-sampling telemetry, from the counters readback (settled views only).
	 * `converged` is the fraction that met the noise threshold; `activePixels` is the count the
	 * frozen-compaction path actually traced last settled frame.
	 */
	getConvergenceStats() {

		const total = this._wfRenderWidth.value * this._wfRenderHeight.value;

		return {
			converged: this._convergedFraction,
			convergedGeometry: this._convergedGeometryFraction,
			geometryPixels: this._geometryPixelCount,
			activePixels: this._lastActivePixelCount,
			totalPixels: total,
			frame: this.frameCount,
		};

	}

	// Parent resizes storageTextures/shaderBuilder; wavefront also needs its buffers/uniforms/kernels rebuilt.
	_handleResize() {

		const oldW = this.storageTextures.renderWidth;
		const oldH = this.storageTextures.renderHeight;

		super._handleResize();

		this._rebuildKernelsIfResized( oldW, oldH );

	}

	// Aux MRT (normalDepth/albedo) is needed only by the denoiser/OIDN; DenoisingManager calls this to
	// turn the wavefront's aux writes on/off. It's a live uniform, so toggling is just a value flip —
	// no kernel rebuild, no UI freeze.
	setAuxGBufferEnabled( enabled ) {

		enabled = !! enabled;
		if ( this._auxGBufferEnabled === enabled ) return;
		this._auxGBufferEnabled = enabled;
		this._auxGBufferUniform.value = enabled ? 1 : 0;
		this.restartAuxAccumulation();

	}

	// Clean-aux normal: when a clean-aux OIDN model is active (calb_cnrm/high, alb_nrm/balanced), FinalWrite
	// temporally accumulates + renormalizes the aux normal so the model isn't fed per-frame point-sampled
	// noise. DenoisingManager calls this on OIDN enable + quality change. The two modes write the normal in
	// incompatible ways, so the aux buffer has to refill.
	setCleanAuxNormal( enabled ) {

		enabled = !! enabled;
		if ( this._cleanAuxNormalEnabled === enabled ) return;
		this._cleanAuxNormalEnabled = enabled;
		this._cleanAuxNormalUniform.value = enabled ? 1 : 0;
		this.restartAuxAccumulation();

	}

	/** Drops the aux MRT's history, leaving the colour's accumulation intact. */
	restartAuxAccumulation() {

		this._auxSamples = 0;
		this._auxSeedPending = this._auxGBufferEnabled;

	}

	/**
	 * @returns {boolean} whether FinalWrite will MIX the aux this frame rather than seed it.
	 *
	 * colorAccumulates mirrors FinalWrite's outer gate: when that gate is false the aux is written verbatim
	 * regardless, which restarts the epoch. A mismatch costs aux quality only — the shader also reads
	 * hasPreviousAux, so it can never mix against textures this epoch has not written.
	 */
	_updateAuxAccumulationUniforms( frameValue ) {

		const colorAccumulates = this.accumulationEnabled
			&& ! this.cameraIsMoving.value
			&& frameValue > 0
			&& this.hasPreviousAccumulated.value > 0
			&& this.visMode.value !== 11;

		const mixes = this._auxGBufferEnabled && colorAccumulates
			&& ! this._auxSeedPending && this._auxSamples > 0;

		this.hasPreviousAux.value = mixes ? 1 : 0;
		this.auxAccumulationAlpha.value = mixes ? 1 / ( this._auxSamples + 1 ) : 1.0;

		return mixes;

	}

	// UI-driven resize (Resolution dropdown) — parent bypasses _handleResize(), so hook here too.
	setSize( width, height ) {

		const oldW = this.storageTextures.renderWidth;
		const oldH = this.storageTextures.renderHeight;

		super.setSize( width, height );

		this._rebuildKernelsIfResized( oldW, oldH );

	}

	/**
	 * Whether THIS frame's counters will actually be read back, evaluated before the dispatches that fill
	 * them. Mirrors _maybeReadbackCounters' guards exactly; both run inside the same synchronous render()
	 * call, so no async continuation can flip a flag between them.
	 *
	 * countConvergedDilated is a full-frame pass whose only consumer is that readback, and the readback is
	 * on a 4-frame cadence — counting every frame threw ~75% of the work away.
	 */
	_willReadCountersThisFrame() {

		if ( this.cameraChanged || this.cameraOptimizer?.isInInteractionMode() ) return false;
		if ( this._lockstep ) return ! this._lockstepRead && this.frameCount % this._readbackEveryNFrames === 0;
		if ( this._readbackPending || this._convergedReadbackPending ) return false;
		return this._readbackFrameCounter + 1 >= this._readbackEveryNFrames;

	}

	_bounceLoopBound() {

		// Camera paths take one segment past their last bounce (ShadeKernel, EMISSION_ONLY).
		return this.maxBounces.value + this.transmissiveBounces.value + this.maxSubsurfaceSteps.value + 1;

	}

	// Async readback of the per-bounce snapshot every N frames; never awaited, so the early-exit uses past-frame data.
	_maybeReadbackCounters() {

		if ( this._lockstep ) {

			this._issueLockstepReadback();
			return;

		}

		// Never sample the survivor curve mid-motion, nor while the CameraOptimizer is holding maxBounces
		// down to its interaction value (1): mid-motion counts belong to a pose we're leaving, and a curve
		// measured at the interaction budget stores _lastBounceCountsBudget=1 — when the real (high) budget
		// is restored on exit that stale curve forces curveReliableUpto=1, killing the per-bounce early-exit
		// and full-sizing the whole loopBound for a few frames (the dramatic FPS drop right when movement
		// ends, worst at high maxBounces). Prime the counter so the first settled frame re-measures promptly.
		if ( this.cameraChanged || this.cameraOptimizer?.isInInteractionMode() ) {

			this._readbackFrameCounter = this._readbackEveryNFrames;
			return;

		}

		if ( this._readbackPending ) return;

		// A curve measured at a different budget has an untrusted tail, so curveReliableUpto collapses
		// to the old budget: the per-bounce early exit is off past that point and every remaining
		// iteration full-sizes off curve[curveReliableUpto - 1]. Measured on a 1024² interior, raising
		// the budget 3 -> 20 doubles the frame's dispatch work (13 -> 26 bounce iterations, 109 -> 214
		// compute passes) for as long as that lasts. Waiting out the N-frame cadence just extends it, so
		// re-measure on the next frame instead — same idiom as the mid-motion priming above.
		if ( this.maxBounces.value !== this._lastBounceCountsBudget
			|| this._bounceLoopBound() !== this._lastBounceCountsLoopBound ) {

			this._readbackFrameCounter = this._readbackEveryNFrames;

		}

		this._readbackFrameCounter ++;
		if ( this._readbackFrameCounter < this._readbackEveryNFrames ) return;
		this._readbackFrameCounter = 0;

		const attr = this._queueManager?.getBounceCountsAttribute();
		if ( ! attr ) return;

		this._readbackPending = true;
		const gen = this._readbackGeneration;
		const budget = this.maxBounces.value;
		const measuredLoopBound = this._bounceLoopBound();
		const n = this._queueManager.MAX_BOUNCE_SNAPSHOTS;
		const lightKey = this._lightCurveKey;
		this.renderer.getArrayBufferAsync( attr ).then( ( buf ) => {

			// Drop counts measured at a now-stale generation (a resize or camera move happened mid-flight).
			// A surviving readback was initiated while settled (init is skipped mid-motion) and no motion
			// happened before it resolved, so its counts match the current view — safe to size from.
			if ( gen === this._readbackGeneration ) this._applyBounceCounts( buf, budget, measuredLoopBound, n, lightKey );

			this._readbackPending = false;

		} ).catch( ( e ) => {

			log.warn( 'bounceCounts readback failed:', e );
			this._readbackPending = false;

		} );

		// Tier-1 convergence: on the SAME settled-view cadence, read the converged-pixel count and derive the
		// fraction that drives the whole-frame early-stop. Separate single-flight flag (different buffer) + the
		// same _readbackGeneration guard so a count measured before a camera-move/resize is dropped when stale.
		if ( ! this._convergedReadbackPending ) {

			const cAttr = this._queueManager?.getCountersAttribute();
			if ( cAttr ) {

				this._convergedReadbackPending = true;
				const cgen = this._readbackGeneration;
				// Full-FRAME pixel count (CONVERGED_COUNT sums across all chunks) — not _wfMaxRayCount, which
				// after the chunk loop holds only the last band's pixel count.
				const total = this._wfRenderWidth.value * this._wfRenderHeight.value;
				this.renderer.getArrayBufferAsync( cAttr, null, 0, COUNTER.COUNT * 4 ).then( ( buf ) => {

					if ( cgen === this._readbackGeneration && total > 0 ) this._applyCounters( buf, total );

					this._convergedReadbackPending = false;

				} ).catch( () => {

					this._convergedReadbackPending = false;

				} );

			}

		}

	}

	_issueLockstepReadback() {

		// One in flight, and none mid-motion: frames there do not count, so frameCount stands still.
		if ( this._lockstepRead || this.frameCount % this._readbackEveryNFrames !== 0 ) return;
		if ( this.cameraChanged || this.cameraOptimizer?.isInInteractionMode() ) return;

		const bounceAttr = this._queueManager?.getBounceCountsAttribute();
		const counterAttr = this._queueManager?.getCountersAttribute();
		if ( ! bounceAttr || ! counterAttr ) return;

		const gen = this._readbackGeneration;
		const budget = this.maxBounces.value;
		const loopBound = this._bounceLoopBound();
		const n = this._queueManager.MAX_BOUNCE_SNAPSHOTS;
		const total = this._wfRenderWidth.value * this._wfRenderHeight.value;
		const lightKey = this._lightCurveKey;

		const entry = { due: this.frameCount + this._readbackEveryNFrames, read: null, apply: null };
		entry.read = Promise.all( [
			this.renderer.getArrayBufferAsync( bounceAttr ),
			this.renderer.getArrayBufferAsync( counterAttr, null, 0, COUNTER.COUNT * 4 ),
		] ).then( ( [ bounceBuf, counterBuf ] ) => {

			entry.apply = () => {

				if ( gen !== this._readbackGeneration ) return;
				this._applyBounceCounts( bounceBuf, budget, loopBound, n, lightKey );
				if ( total > 0 ) this._applyCounters( counterBuf, total );

			};

		}, ( e ) => {

			log.warn( 'lockstep readback failed:', e );
			entry.apply = () => {};

		} );

		this._lockstepRead = entry;

	}

	_applyBounceCounts( buf, budget, loopBound, n, lightKey = null ) {

		const all = new Uint32Array( buf.slice( 0 ) );
		this._lastBounceCounts = all.subarray( 0, n );
		this._lastBounceEnergy = all.subarray( n, 2 * n );
		this._lastLightBounceCounts = all.subarray( 2 * n, 3 * n );
		this._lastLightBounceEnergy = all.subarray( 3 * n, 4 * n );
		this._lastLightCurveKey = lightKey;
		this._lastBounceCountsBudget = budget;
		this._lastBounceCountsLoopBound = loopBound;
		this._curveSizingValid = true;

	}

	_applyCounters( buf, total ) {

		const c = new Uint32Array( buf );
		this._convergedFraction = c[ COUNTER.CONVERGED_COUNT ] / total;
		// No geometry at all (pure environment) leaves nothing to gate on — 1 lets the
		// whole-frame fraction decide alone.
		const geo = c[ COUNTER.GEOMETRY_COUNT ];
		this._geometryPixelCount = geo;
		this._convergedGeometryFraction = geo > 0 ? c[ COUNTER.CONVERGED_GEOMETRY_COUNT ] / geo : 1;
		// Tier-2: bounce-0 active-pixel count measured this settled frame → sizes next frame's grid.
		this._lastActivePixelCount = c[ COUNTER.ACTIVE_PIXEL_COUNT ];

	}

	// Sync wavefront's texture nodes with current env/material textures; only a changed ref triggers GPU rebind.
	_refreshWfTextureNodes() {

		const t = this._wfTexNodes;
		if ( ! t ) return;

		const env = this.environment?.environmentTexture;
		if ( env && t.envTex ) t.envTex.value = env;
		// CDF texture is replaced (new DataTexture) on each HDRI/env build — repoint the node.
		if ( this.environment?.envCDFTexture && t.envCDFTex ) t.envCDFTex.value = this.environment.envCDFTexture;

		const mat = this.materialData;
		if ( ! mat ) return;
		refreshBucketTextureNodes( t.srgbBuckets, mat.srgbBuckets );
		refreshBucketTextureNodes( t.linearBuckets, mat.linearBuckets );

	}

	_rebuildKernelsIfResized( oldW, oldH ) {

		const newW = this.storageTextures.renderWidth;
		const newH = this.storageTextures.renderHeight;
		if ( ( newW === oldW && newH === oldH ) || ! ( this.materialData?.materialCount > 0 ) ) return;

		// A survivor curve from the old resolution mis-sizes the per-bounce dispatch at the new one
		// (row-major active list → under-coverage of the lower rows → GI band). Force full coverage
		// until the readback re-measures at the new size; bump the generation so any readback already
		// in flight (carrying the old-resolution counts) is discarded when it resolves.
		// The early exit only compares energy against a per-pixel threshold, so the curve rescaled to the
		// new pixel count keeps it working — nothing re-measures while the camera moves, and the moving-camera
		// resolution drop would otherwise run every bounce slot. A multi-chunk curve holds only the last band.
		if ( this._lastBounceCounts && this._numChunks <= 1 && oldW > 0 && oldH > 0 ) {

			const ratio = ( newW * newH ) / ( oldW * oldH );
			const rescale = ( v ) => Math.min( 0xFFFFFFFF, Math.round( v * ratio ) );
			this._lastBounceCounts = this._lastBounceCounts.map( rescale );
			this._lastBounceEnergy = this._lastBounceEnergy.map( rescale );

		} else {

			this._lastBounceCounts = null;
			this._lastBounceEnergy = null;
			this._lastBounceCountsBudget = - 1;
			this._lastBounceCountsLoopBound = - 1;

		}

		this._curveSizingValid = false;
		this._readbackFrameCounter = 0;
		this._readbackGeneration ++;
		this._convergedFraction = 0;
		this._convergedGeometryFraction = 0;
		this._lastActivePixelCount = 0;

		// Chunked path pool: the wavefront buffers are sized to the fixed device budget B (not the
		// resolution), and the per-pixel persistent buffers to the reserved max, so a resolution change
		// reallocates NOTHING and rebuilds NO kernels — it only updates the render-size uniforms + the
		// row-band chunk layout. The one-time build happens on model load / light realloc. This is the fix
		// for the resize freeze (was: capacity-grow → recreate all compute nodes → WGSL regen, ~1.8 s on
		// complex scenes). See docs/internal/specs/wavefront-chunked-pool.md.
		if ( ! this._packedBuffers ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();

		} else {

			this._resizeWavefrontInPlace( newW, newH );

		}

	}

	// Resolution change with a fixed-budget pool: update render-size uniforms + recompute the row-band chunk
	// layout + rescale the early-exit threshold. No buffer realloc, no kernel recompile.
	_resizeWavefrontInPlace( w, h ) {

		this._wfRenderWidth.value = w;
		this._wfRenderHeight.value = h;
		this._updateChunkLayout();

	}

	// Device-adaptive paths-in-flight budget B (Blender path-pool). Constrained by:
	//  (1) each single storage buffer ≤ maxStorageBufferBindingSize — the RAY buffer (B·RAY_STRIDE·16 B) binds
	//      largest, so B·RAY_STRIDE·16 ≤ 0.9·maxStorageBufferBindingSize;
	//  (2) total pool ≤ a fraction of device memory;
	//  (3) floor at 512² of paths, cap at the reserved max pixels (no point pooling more paths than pixels).
	// B is resolution-INDEPENDENT, so _cap is fixed and the kernels build once. The render-loop chunking streams
	// any resolution through this pool, so a small B just means more row-bands (works on weak / small-VRAM GPUs).
	_computePathBudget() {

		const RAY_BYTES = RAY_STRIDE * 16;
		const HIT_BYTES = ( this._bidirectionalEnabled ? HIT_STRIDE_BIDIRECTIONAL : HIT_STRIDE ) * 16;
		const bytesPerPath = RAY_BYTES + HIT_BYTES + 4 /* rng */ + GBUFFER_STRIDE * 16
			+ 4 + 4 /* activeIndices A/B */ + 4;

		const limits = this.renderer?.backend?.device?.limits;
		const maxBinding = limits?.maxStorageBufferBindingSize || ( 128 * 1024 * 1024 );
		const maxBuffer = limits?.maxBufferSize || maxBinding;
		const deviceMemBytes = deviceMemoryGB( this.hostMemoryGB ).gb * 1024 * 1024 * 1024;

		// The light vertex cache shares the hit buffer's binding with the paths.
		const lightVertexBytes = LIGHT_VERTEX_STRIDE * 16;
		const cacheBytes = this._bidirectionalEnabled
			? Math.floor( Math.min( LIGHT_CACHE_BYTES, maxBinding * 0.45, deviceMemBytes * 0.05 ) / lightVertexBytes ) * lightVertexBytes
			: 0;
		this._lightCacheSlots = cacheBytes / lightVertexBytes;

		if ( this._pathBudgetOverride > 0 ) return this._pathBudgetOverride;

		const bByBinding = Math.floor( Math.min( ( maxBinding * 0.9 ) / RAY_BYTES, ( maxBinding * 0.9 - cacheBytes ) / HIT_BYTES ) );
		const poolVramBudget = Math.min( deviceMemBytes * 0.25, maxBuffer * 4 ) - cacheBytes;
		const bByVram = Math.floor( poolVramBudget / bytesPerPath );

		const MIN_B = 512 * 512;
		// Working-set ceiling — deliberately DECOUPLED from the reserved framebuffer size. Capping the pool at
		// ~2048² paths (~940 MB) keeps VRAM bounded; frames larger than B (e.g. 4K) just stream in more row-band
		// chunks rather than reserving a giant pool (4K single-chunk would be ~3 GB of path state for ~no speedup).
		const MAX_B = 2048 * 2048;
		let B = Math.min( bByBinding, bByVram, MAX_B );
		B = Math.max( MIN_B, B );
		return B;

	}

	// Row-aligned chunk layout for the current resolution and budget B. A chunk is `_chunkRows` full rows so the
	// 2D ray-gen grid stays cache-coherent and pixelBase = rowBase·W is exact. chunkPixels = _chunkRows·W ≤ B.
	_updateChunkLayout() {

		const w = Math.max( 1, this.storageTextures.renderWidth );
		const h = this.storageTextures.renderHeight;
		const B = this._pathBudget || ( w * h );
		this._chunkRows = Math.max( 1, Math.min( Math.floor( B / w ), h ) );
		this._numChunks = Math.max( 1, Math.ceil( h / this._chunkRows ) );

	}

	// Reserved-storage change (e.g. enabling 4K): the MRT StorageTextures are pre-allocated at
	// MAX_STORAGE_TEXTURE_SIZE and can't be resized, so recreate the pool at the (new) live reserved size and
	// rebuild the wavefront kernels in place. The stage OBJECT is unchanged, so manager/event refs stay valid;
	// only GPU textures + compute pipelines are rebuilt. Scene buffers (BVH/tri/material) are resolution-
	// independent and untouched. Caller must have rendering paused.
	reallocateReservedStorage() {

		if ( ! this.storageTextures.writeColor ) return;

		// Clamp into the (possibly just-lowered) reserve: create() sizes the write StorageTextures at
		// MAX_STORAGE_TEXTURE_SIZE but the readTarget at what's passed here, and the tracked render size still
		// holds the pre-change value — unclamped, copyToReadTargets reads past the write textures.
		const w = Math.min( this.storageTextures.renderWidth || 1, MAX_STORAGE_TEXTURE_SIZE );
		const h = Math.min( this.storageTextures.renderHeight || 1, MAX_STORAGE_TEXTURE_SIZE );

		// Recreate the MRT pool at the new reserved size (create() reallocates the write StorageTextures at the
		// live MAX_STORAGE_TEXTURE_SIZE; the read RenderTarget follows the current render size).
		this.storageTextures.create( w, h );
		this.resolution.value.set( w, h );

		// No kernels before the first scene with materials — nothing to rebuild, and a build here would compile
		// against 0 materials. The pool above is recreated regardless: it is allocated at construction, so a
		// reserve raised before the first model load must still reach it or every later copy overflows it.
		if ( ! this._packedBuffers || ! ( this.materialData?.materialCount > 0 ) ) return;

		// Rebuild kernels: re-references the fresh write textures + recreates the per-pixel aux buffers
		// (m2/streak/frozenMask) at the new maxPixels. Prev-frame nodes are repointed per-frame in render().
		if ( this._kernelManager ) this._kernelManager.dispose();
		this._wavefrontReady = false;
		this._buildWavefrontKernels();

	}

	_buildWavefrontKernels() {

		const texNodes = this.shaderBuilder.getSceneTextureNodes();
		if ( ! texNodes ) return;

		// A fresh build binds the current lightStorageAttr — any pending realloc is covered.
		this._lightBufferRealloc = false;
		this._outputsChanged = false;
		if ( this._bidirectionalEnabled ) this._sizeSourceTable();

		const w = this.storageTextures.renderWidth;
		const h = this.storageTextures.renderHeight;

		// Fixed device-budget path pool B (resolution-independent) + the row-band chunk layout for this frame.
		if ( ! this._pathBudget ) this._pathBudget = this._computePathBudget();
		const B = this._pathBudget;
		this._updateChunkLayout();

		// Rays in one row-band chunk — the initial dispatch bound for kernel registration. render() overrides
		// every per-ray kernel's dispatch per chunk; this is just a valid starting grid (always ≤ B).
		const maxRays = this._chunkRows * w;


		// Per-path buffers (RAY/HIT/rng) sized to the budget B and indexed by LOCAL slot r ∈ [0,B). _cap = B is
		// baked into the SoA stride but never changes with resolution, so this build happens once (model load).
		const lightVertices = this._bidirectionalEnabled ? this._lightCacheSlots : 0;
		if ( ! this._packedBuffers ) {

			this._packedBuffers = new PackedRayBuffer( B, this.renderer, lightVertices );

		} else {

			this._packedBuffers.resize( B, lightVertices );

		}

		// Per-CHUNK first-hit G-buffer (LOCAL slot r, size B), 1 uvec4/slot half-packed (pack2x16). Written by
		// Generate + Shade(bounce 0), read by Shade + FinalWrite within the SAME chunk, so per-chunk suffices.
		// uint (not f32): packed lanes can hit the NaN exponent range (snorm 1.0 → 0x7FFF) that an f32 store may
		// canonicalize; u32 stores the bits verbatim.
		const gBufferVec4s = B * GBUFFER_STRIDE;
		freeStorageAttribute( this.renderer, this._gBufferAttr );
		this._gBufferAttr = gpuOnlyStorageAttribute( gBufferVec4s, 4, Uint32Array );
		const gBufferRW = storage( this._gBufferAttr, 'uvec4' );
		const gBufferRO = storage( this._gBufferAttr, 'uvec4' ).toReadOnly();

		// Per-PIXEL persistent buffers (m2/streak/frozenMask) are GLOBAL-pixel-indexed (p = pixelBase + r) and
		// must span the whole frame across chunks AND persist across frames, so they're sized to the reserved
		// max resolution (small — 12 B/pixel) and NEVER realloc on a resize.
		const maxPixels = MAX_STORAGE_TEXTURE_SIZE * MAX_STORAGE_TEXTURE_SIZE;

		// Only reallocated on growth, never on a plain rebuild: the Compositor's overlay binds m2/frozenMask
		// read-only and a fresh attribute would strand its bind group. Surviving contents are safe — every
		// consumer re-seeds at frame 0.
		if ( ! this._m2Attr || this._m2Attr.count < maxPixels ) {

			// Tier-1 convergence: per-pixel running mean of luminance² (Welford second moment), read+written by FinalWrite.
			freeStorageAttribute( this.renderer, this._m2Attr );
			this._m2Attr = gpuOnlyStorageAttribute( maxPixels, 1 );

			// Tier-2: per-pixel freeze-candidate streak. FinalWrite writes (RW), buildActivePixels reads (RO).
			freeStorageAttribute( this.renderer, this._streakAttr );
			this._streakAttr = gpuOnlyStorageAttribute( maxPixels, 1, Uint32Array );

			// Tier-2: dilated frozen mask (1 = skip). buildActivePixels writes; active-list + FinalWrite read → race-free.
			freeStorageAttribute( this.renderer, this._frozenMaskAttr );
			this._frozenMaskAttr = gpuOnlyStorageAttribute( maxPixels, 1, Uint32Array );

		}

		// Light tracing's image: a u32 per channel per pixel, fixed point (LightSplatKernel).
		if ( this._bidirectionalEnabled ) {

			if ( ! this._splatAttr || this._splatAttr.count < maxPixels * 3 ) {

				freeStorageAttribute( this.renderer, this._splatAttr );
				this._splatAttr = gpuOnlyStorageAttribute( maxPixels * 3, 1, Uint32Array );

			}

		} else if ( this._splatAttr ) {

			freeStorageAttribute( this.renderer, this._splatAttr );
			this._splatAttr = null;

		}

		// Vertex merging's list heads: at least one a light vertex slot, a power of two (the hash's mask).
		const hashSize = this._mergingEnabled ? 2 ** Math.ceil( Math.log2( Math.max( this._lightCacheSlots, 1024 ) ) ) : 0;
		if ( this._mergeHeadAttr?.count !== hashSize ) {

			freeStorageAttribute( this.renderer, this._mergeHeadAttr );
			this._mergeHeadAttr = hashSize > 0 ? gpuOnlyStorageAttribute( hashSize, 1, Uint32Array ) : null;

		}

		this._bidirectional.hashMask.value = Math.max( hashSize - 1, 0 );

		// The light guide's table: built into a buffer, copied into a texture Shade can read (it has no buffer to spare).
		if ( this._bidirectionalEnabled ) {

			if ( ! this._guideTexture ) {

				this._guideTexture = new DataTexture( null, GUIDE_TEXTURE_WIDTH, GUIDE_BINS, RedFormat, FloatType );
				this._guideTexture.source.dataReady = false;
				this._guideTexture.needsUpdate = true;
				this._guideBuildAttr = gpuOnlyStorageAttribute( GUIDE_ROW_STRIDE * GUIDE_BINS, 1, Float32Array );

			}

			this._bidirectional.guideTexture = texture( this._guideTexture );
			this._bidirectional.guide.value = 0;

		} else {

			this._disposeLightGuide();

		}

		const m2RW = storage( this._m2Attr, 'float' );
		const streakRW = storage( this._streakAttr, 'uint' );
		const streakRO = storage( this._streakAttr, 'uint' ).toReadOnly();
		const frozenMaskRW = storage( this._frozenMaskAttr, 'uint' );
		const frozenMaskRO = storage( this._frozenMaskAttr, 'uint' ).toReadOnly();

		if ( ! this._queueManager ) {

			this._queueManager = new QueueManager( this._packedBuffers.capacity, this.renderer );

		} else {

			this._queueManager.resize( this._packedBuffers.capacity );

		}

		if ( ! this._kernelManager ) {

			this._kernelManager = new KernelManager( this.renderer );

		}

		const pb = this._packedBuffers;
		const qm = this._queueManager;

		this._wfRenderWidth.value = w;
		this._wfRenderHeight.value = h;
		// _wfMaxRayCount is the CURRENT chunk's pixel count; set per-chunk in render(). Seed with the first chunk.
		this._wfMaxRayCount.value = Math.min( B, this._chunkRows * w );

		const prevColor = this.shaderBuilder.prevColorTexNode;
		const prevAlbedo = this.shaderBuilder.prevAlbedoTexNode;
		const prevNormalDepth = this.shaderBuilder.prevNormalDepthTexNode;
		const writeTex = this.storageTextures.getWriteTextures();

		const counters = qm.getCounters();

		// Copy ACTIVE_RAY_COUNT into bounceCounts[currentBounce] for the readback survivor curve.
		// Standalone kernel is dispatched only on the non-dynamic path; the dynamic path folds this
		// into compactCopyback's thread 0.
		const bounceCountsBuf = qm.getBounceCounts();
		const wfCurrentBounce = this._wfCurrentBounce;
		const snapshotFn = Fn( () => {

			const cnt = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
			const slot = uint( wfCurrentBounce ).clamp( uint( 0 ), uint( qm.MAX_BOUNCE_SNAPSHOTS - 1 ) );
			bounceCountsBuf.element( slot ).assign( cnt );
			bounceCountsBuf.element( slot.add( uint( qm.MAX_BOUNCE_SNAPSHOTS ) ) ).assign( atomicLoad( counters.element( uint( COUNTER.ACTIVE_ENERGY ) ) ) );
			// Also set ENTERING_COUNT for the next bounce; the full-dispatch path's enterFull overrides it.
			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), cnt );

		} );
		this._kernelManager.register( 'snapshotBounceCount',
			snapshotFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		const activeWriteA = qm.activeIndices.a;
		const initFn = Fn( () => {

			const tid = instanceIndex;
			// LOCAL-slot identity for this chunk's active list. Bounded on _wfMaxRayCount (= chunkPixels): the
			// pool has no over-allocation margin now, so the dispatch-grid overshoot must not write past it.
			If( tid.lessThan( this._wfMaxRayCount ), () => {

				activeWriteA.element( tid ).assign( tid );

			} );
			// Seed ACTIVE/ENTERING from this chunk's ray count. CONVERGED is a per-FRAME counter (summed across
			// chunks in FinalWrite), so zero it only on the first chunk of the frame.
			If( tid.equal( uint( 0 ) ), () => {

				atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), this._wfMaxRayCount );
				atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), this._wfMaxRayCount );
				If( this._wfIsFirstChunk.greaterThan( uint( 0 ) ), () => {

					atomicStore( counters.element( uint( COUNTER.CONVERGED_COUNT ) ), uint( 0 ) );
					atomicStore( counters.element( uint( COUNTER.GEOMETRY_COUNT ) ), uint( 0 ) );
					atomicStore( counters.element( uint( COUNTER.CONVERGED_GEOMETRY_COUNT ) ), uint( 0 ) );

				} );

			} );

		} );
		this._kernelManager.register( 'initActiveIndices',
			initFn().compute( [ Math.ceil( ( this._chunkRows * w ) / LIST_WG_SIZE ), 1, 1 ], [ LIST_WG_SIZE, 1, 1 ] )
		);

		const genParams = {
			rayBufferRW: pb.rayBuffer.rw,
			hitBufferRW: pb.hitBuffer.rw,
			gBufferRW,
			resolution: this.resolution,
			// RNG axis only (baseSeed + stratified jitter) — takes the seed counter, not the
			// accumulation index. FinalWrite keeps `frame`.
			frame: this.seedFrame,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			cameraProjection: this.cameraProjection,
			panoLonRange: this.panoLonRange,
			panoLatRange: this.panoLatRange,
			panoLevelHorizon: this.panoLevelHorizon,
			enableDOF: this.enableDOF,
			focalLength: this.focalLength,
			aperture: this.aperture,
			focusDistance: this.focusDistance,
			unitsPerMetre: this.unitsPerMetre,
			apertureScale: this.apertureScale,
			anamorphicRatio: this.anamorphicRatio,
			dofMode: this.dofMode,
			dofBlur: this.dofBlur,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			chunkRowBase: this._wfChunkRowBase,
			chunkRows: this._wfChunkRows,
			transmissiveBounces: this.transmissiveBounces,
			transparentBackground: this.transparentBackground,
			auxGBufferEnabled: this._auxGBufferUniform,
			bidirectional: this._bidirectionalEnabled ? this._bidirectional : null,
		};
		const genFn = buildGenerateKernel( genParams );
		this._kernelManager.register( 'generate',
			genFn().compute(
				[ Math.ceil( w / GENERATE_WG_SIZE ), Math.ceil( this._chunkRows / GENERATE_WG_SIZE ), 1 ],
				[ GENERATE_WG_SIZE, GENERATE_WG_SIZE, 1 ]
			)
		);

		// --- Tier-2 freeze seed path (gated by usePixelFreeze in render()) ---
		// Replaces generate+initActiveIndices with: reset counters → scatter non-frozen pixel IDs into the active
		// list → publish count → 1D list-driven generate. Split so ACTIVE_RAY_COUNT is zeroed BEFORE the scatter.
		const freezeK = this.pixelFreezeStability;
		const resetFrameFn = Fn( () => {

			// ACTIVE is per-chunk (zeroed before every chunk's scatter). CONVERGED is a per-FRAME counter
			// summed across chunks in FinalWrite → zero it only on the first chunk of the frame.
			atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 0 ) );
			If( this._wfIsFirstChunk.greaterThan( uint( 0 ) ), () => {

				atomicStore( counters.element( uint( COUNTER.CONVERGED_COUNT ) ), uint( 0 ) );
				atomicStore( counters.element( uint( COUNTER.GEOMETRY_COUNT ) ), uint( 0 ) );
				atomicStore( counters.element( uint( COUNTER.CONVERGED_GEOMETRY_COUNT ) ), uint( 0 ) );

			} );

		} );
		this._kernelManager.register( 'resetFrameCounters',
			resetFrameFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		const buildActiveFn = Fn( () => {

			const tid = instanceIndex;
			If( tid.lessThan( this._wfMaxRayCount ), () => {

				// tid is the LOCAL slot in this chunk; p is its GLOBAL pixel (streak/frozenMask are full-res,
				// global-indexed and persist across frames). pixelBase = chunkRowBase · renderWidth.
				const p = uint( int( tid ).add( this._wfChunkRowBase.mul( this._wfRenderWidth ) ) ).toVar();

				// frozen=1 skips the pixel this frame. Frame 0 seeds all (streak may be stale post-reset). A pixel
				// freezes once streak>=K; with dilation ON it stays active if any 8-neighbour is still active
				// (streak<K), softening the boundary. Mask is read by FinalWrite too → race-free.
				const frozen = uint( 0 ).toVar();

				// Bits 31/30 of the streak word are the converged + geometry flags — mask them off wherever the streak is read.
				If( this.frame.greaterThan( uint( 0 ) ).and( streakRO.element( p ).bitAnd( uint( 0x3FFFFFFF ) ).greaterThanEqual( uint( freezeK ) ) ), () => {

					frozen.assign( uint( 1 ) );

					If( this._dilateFrozenUniform.greaterThan( int( 0 ) ), () => {

						const px = int( p ).mod( this._wfRenderWidth );
						const py = int( p ).div( this._wfRenderWidth );

						for ( const [ dx, dy ] of [[ - 1, - 1 ], [ 0, - 1 ], [ 1, - 1 ], [ - 1, 0 ], [ 1, 0 ], [ - 1, 1 ], [ 0, 1 ], [ 1, 1 ]] ) {

							const nx = px.add( int( dx ) );
							const ny = py.add( int( dy ) );
							If( nx.greaterThanEqual( int( 0 ) ).and( nx.lessThan( this._wfRenderWidth ) )
								.and( ny.greaterThanEqual( int( 0 ) ) ).and( ny.lessThan( this._wfRenderHeight ) ), () => {

								If( streakRO.element( uint( ny.mul( this._wfRenderWidth ).add( nx ) ) ).bitAnd( uint( 0x3FFFFFFF ) ).lessThan( uint( freezeK ) ), () => {

									frozen.assign( uint( 0 ) ); // a still-active neighbour keeps this pixel active

								} );

							} );

						}

					} );

				} );

				frozenMaskRW.element( p ).assign( frozen );

				If( frozen.equal( uint( 0 ) ), () => {

					const slot = atomicAdd( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 1 ) );
					// Scatter the LOCAL slot (path state + list are local); generateList maps it back to global p.
					activeWriteA.element( slot ).assign( tid );

				} );

			} );

		} );
		this._kernelManager.register( 'buildActivePixels',
			buildActiveFn().compute( [ Math.ceil( ( this._chunkRows * w ) / LIST_WG_SIZE ), 1, 1 ], [ LIST_WG_SIZE, 1, 1 ] )
		);

		// Whole-frame converged count, eroded 3×3 (Cycles film_adaptive_sampling_filter_x/y parity): a pixel
		// counts only if it AND its 8 in-bounds neighbours carry last frame's converged bit. A pointwise count
		// is blind to undiscovered energy — all-zero pixels have zero variance and pass any threshold, so on
		// indirect-dominant scenes it peaks on a black image and retires the frame at ~10 spp. Erosion lets
		// each discovered speckle poison its neighbourhood while energy is still being found.
		// Reads the PREVIOUS frame's bits, which costs nothing: the stop already lags by the readback cadence.
		const countConvergedFn = Fn( () => {

			const tid = instanceIndex;
			const W = this._wfRenderWidth;
			const H = this._wfRenderHeight;
			If( tid.lessThan( uint( W.mul( H ) ) ), () => {

				const px = int( tid ).mod( W );
				const py = int( tid ).div( W );
				const CONV_BIT = uint( 0x80000000 );
				const GEOM_BIT = uint( 0x40000000 );

				const word = streakRO.element( tid ).toVar();
				const isGeometry = word.bitAnd( GEOM_BIT ).notEqual( uint( 0 ) );
				const allConverged = word.bitAnd( CONV_BIT ).notEqual( uint( 0 ) ).toVar();

				If( allConverged, () => {

					for ( const [ dx, dy ] of [[ - 1, - 1 ], [ 0, - 1 ], [ 1, - 1 ], [ - 1, 0 ], [ 1, 0 ], [ - 1, 1 ], [ 0, 1 ], [ 1, 1 ]] ) {

						const nx = px.add( int( dx ) );
						const ny = py.add( int( dy ) );
						If( nx.greaterThanEqual( int( 0 ) ).and( nx.lessThan( W ) )
							.and( ny.greaterThanEqual( int( 0 ) ) ).and( ny.lessThan( H ) ), () => {

							If( streakRO.element( uint( ny.mul( W ).add( nx ) ) ).bitAnd( CONV_BIT ).equal( uint( 0 ) ), () => {

								allConverged.assign( false );

							} );

						} );

					}

				} );

				If( allConverged, () => {

					atomicAdd( counters.element( uint( COUNTER.CONVERGED_COUNT ) ), uint( 1 ) );

				} );

				// Same eroded verdict, restricted to subject pixels — the framing-independent view.
				If( isGeometry, () => {

					atomicAdd( counters.element( uint( COUNTER.GEOMETRY_COUNT ) ), uint( 1 ) );
					If( allConverged, () => {

						atomicAdd( counters.element( uint( COUNTER.CONVERGED_GEOMETRY_COUNT ) ), uint( 1 ) );

					} );

				} );

			} );

		} );
		this._kernelManager.register( 'countConvergedDilated',
			countConvergedFn().compute( [ Math.ceil( ( w * h ) / LIST_WG_SIZE ), 1, 1 ], [ LIST_WG_SIZE, 1, 1 ] )
		);

		const seedEnterFn = Fn( () => {

			const active = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
			// ENTERING_COUNT drives the bounce loop; ACTIVE_PIXEL_COUNT is a stable snapshot for the sizing readback.
			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), active );
			atomicStore( counters.element( uint( COUNTER.ACTIVE_PIXEL_COUNT ) ), active );

		} );
		this._kernelManager.register( 'seedEnter',
			seedEnterFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		// 1D list-driven generate: one thread per active-list slot, bounded on ENTERING_COUNT.
		const genListFn = buildGenerateKernel( {
			...genParams,
			listDriven: true,
			activeIndicesRO: qm.activeIndicesRO.a,
			counters,
		} );
		this._kernelManager.register( 'generateList',
			genListFn().compute( [ Math.ceil( maxRays / LIST_WG_SIZE ), 1, 1 ], [ LIST_WG_SIZE, 1, 1 ] )
		);

		const freshBvh = this.bvhStorageNode;
		const freshTri = this.triangleStorageNode;
		const freshMat = this.materialData.materialStorageNode;
		const freshEnvCDF = texture( this.environment.envCDFTexture ); // independent CDF texture node; refreshed in _refreshWfTextureNodes
		const freshLight = this.lightStorageNode;
		// Independent texture nodes (never compiled elsewhere) avoid Three.js TextureNode caching across pipelines; refreshed via _refreshWfTextureNodes.
		const _mat = this.materialData;
		const _env = this.environment;
		// Consolidated size-bucket nodes (K sRGB + K linear). Empty buckets get placeholders so
		// every runtime branch references a valid node. Published to the sampling module before
		// the Shade/Debug graphs are built so they bake in these (per-pipeline) nodes.
		const freshSrgbBuckets = buildBucketTextureNodes( _mat.srgbBuckets );
		const freshLinearBuckets = buildBucketTextureNodes( _mat.linearBuckets );
		setMaterialBucketTextures( freshSrgbBuckets, freshLinearBuckets );
		// Alpha-cutout shadow rays sample albedo (sRGB pool) — emitted into the shade graph now.
		setShadowAlbedoMaps( freshSrgbBuckets );
		const freshEnvTex = _env.environmentTexture ? texture( _env.environmentTexture ) : texNodes.envTex;

		this._wfTexNodes = {
			envTex: freshEnvTex,
			envCDFTex: freshEnvCDF,
			srgbBuckets: freshSrgbBuckets,
			linearBuckets: freshLinearBuckets,
		};

		// Material-coherence sort gate (experiment): only worthwhile above a few materials.
		this._sortMaterials = ( ENGINE_DEFAULTS.wavefrontSortMaterials ?? false )
			&& ( this.materialData?.materialCount ?? 0 ) > 8;

		const extFn = buildExtendKernel( {
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			rayBufferRO: pb.rayBuffer.ro,
			hitBufferRW: pb.hitBuffer.rw,
			activeIndicesRO: qm.getActiveReadRO(),
			counters,
			maxRayCount: this._wfMaxRayCount,
			shadowTerminatorOffset: this.shadowTerminatorOffset,
		} );
		this._kernelManager.register( 'extend',
			extFn().compute(
				[ Math.ceil( maxRays / EXTEND_WG_SIZE ), 1, 1 ],
				[ EXTEND_WG_SIZE, 1, 1 ]
			)
		);

		// Material-coherence sort: reorder the entering-ray indices by material between
		// Extend and Shade. Histogram is workgroup-shared (patches.js §4); Shade reads the output.
		if ( this._sortMaterials ) {

			const sgHist = qm.getSortGlobalHistogram();
			const sortBins = Math.min( SORT_GLOBAL_MAX_BINS, this.materialData?.materialCount ?? SORT_GLOBAL_MAX_BINS );
			this._kernelManager.register( 'resetGlobalHist',
				buildResetGlobalHistKernel( { sortGlobalHistogram: sgHist, bins: sortBins } )().compute(
					[ 1, 1, 1 ], [ SORT_GLOBAL_WG_SIZE, 1, 1 ]
				)
			);
			this._kernelManager.register( 'globalHist',
				buildGlobalHistKernel( {
					hitBufferRO: pb.hitBuffer.ro,
					activeIndicesReadRO: qm.getActiveReadRO(),
					sortGlobalHistogram: sgHist,
					counters,
					bins: sortBins,
				} )().compute(
					[ Math.ceil( maxRays / SORT_GLOBAL_WG_SIZE ), 1, 1 ],
					[ SORT_GLOBAL_WG_SIZE, 1, 1 ]
				)
			);
			this._kernelManager.register( 'globalPrefix',
				buildGlobalPrefixKernel( { sortGlobalHistogram: sgHist, bins: sortBins } )().compute(
					[ 1, 1, 1 ], [ 1, 1, 1 ]
				)
			);
			this._kernelManager.register( 'globalScatter',
				buildGlobalScatterKernel( {
					hitBufferRO: pb.hitBuffer.ro,
					activeIndicesReadRO: qm.getActiveReadRO(),
					sortedIndicesRW: qm.getSortedRW(),
					sortGlobalHistogram: sgHist,
					counters,
					bins: sortBins,
				} )().compute(
					[ Math.ceil( maxRays / SORT_GLOBAL_WG_SIZE ), 1, 1 ],
					[ SORT_GLOBAL_WG_SIZE, 1, 1 ]
				)
			);

		}

		const shadeFn = buildShadeKernel( {
			gBufferRW,
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			envCDFTexture: freshEnvCDF,
			lightBuffer: freshLight,
			rayBufferRW: pb.rayBuffer.rw,
			hitBufferRW: pb.hitBuffer.rw,
			counters,
			activeIndicesRO: this._sortMaterials ? qm.getSortedRO() : qm.getActiveReadRO(),
			envTexture: freshEnvTex,
			environmentIntensity: this.environmentIntensity,
			envMatrix: this.environmentMatrix,
			enableEnvironmentLight: this.enableEnvironment,
			groundProjectionEnabled: this.groundProjectionEnabled,
			groundProjectionRadius: this.groundProjectionRadius,
			groundProjectionHeight: this.groundProjectionHeight,
			groundProjectionLevel: this.groundProjectionLevel,
			enableGroundCatcher: this.enableGroundCatcher,
			groundCatcherHeight: this.groundCatcherHeight,
			envTotalSum: this.envTotalSum,
			envResolution: this.envResolution,
			directionalLightsBuffer: this.directionalLightsBufferNode,
			numDirectionalLights: this.numDirectionalLights,
			areaLightsBuffer: this.areaLightsBufferNode,
			numAreaLights: this.numAreaLights,
			pointLightsBuffer: this.pointLightsBufferNode,
			numPointLights: this.numPointLights,
			spotLightsBuffer: this.spotLightsBufferNode,
			numSpotLights: this.numSpotLights,
			maxBounceCount: this.maxBounces,
			maxSubsurfaceSteps: this.maxSubsurfaceSteps,
			maxTransparentBounces: this.maxTransparentBounces,
			transparentBackground: this.transparentBackground,
			backgroundIntensity: this.backgroundIntensity,
			backgroundColor: this.backgroundColor,
			backgroundBlurriness: this.backgroundBlurriness,
			backgroundBlurSamples: this.backgroundBlurSamples,
			showBackground: this.showBackground,
			globalIlluminationIntensity: this.globalIlluminationIntensity,
			cameraProjectionMatrix: this.cameraProjectionMatrix,
			cameraViewMatrix: this.cameraViewMatrix,
			fireflyThreshold: this.fireflyThreshold,
			shadowTerminatorOffset: this.shadowTerminatorOffset,
			// RNG axis only.
			frame: this.seedFrame,
			accumFrame: this.frame,
			resolution: this.resolution,
			emissiveTriangleCount: this.emissiveTriangleCount,
			emissiveVec4Offset: this.emissiveVec4Offset,
			emissiveTotalPower: this.emissiveTotalPower,
			emissiveBoost: this.emissiveBoost,
			totalTriangleCount: this.totalTriangleCount,
			enableEmissiveTriangleSampling: this.enableEmissiveTriangleSampling,
			lightBVHNodeCount: this.lightBVHNodeCount,
			reverseMapVec4Offset: this.reverseMapVec4Offset,
			currentBounce: this._wfCurrentBounce,
			maxRayCount: this._wfMaxRayCount,
			chunkRowBase: this._wfChunkRowBase,
			auxGBufferEnabled: this._auxGBufferUniform,
			hasSun: this.hasSun,
			sunDirection: this.sunDirection,
			sunRadiance: this.sunRadiance,
			sunParams: this.sunParams,
			bidirectional: this._bidirectionalEnabled ? this._bidirectional : null,
			hitDistanceEncode: this._outputs.get( 'hitDistance' )?.encode ?? null,
		} );
		this._kernelManager.register( 'shade',
			shadeFn().compute(
				[ Math.ceil( maxRays / SHADE_WG_SIZE ), 1, 1 ],
				[ SHADE_WG_SIZE, 1, 1 ]
			)
		);

		// Subgroup prefix-sum variant when supported.
		const subgroupsOK = this._useSubgroupCompact
			&& ( this.renderer.hasFeature ? this.renderer.hasFeature( 'subgroups' ) : false );
		this._compactIsSubgroup = subgroupsOK;
		const compactBuilder = subgroupsOK ? buildCompactSubgroupKernel : buildCompactKernel;
		const compactFn = compactBuilder( {
			rayBufferRO: pb.rayBuffer.ro,
			activeIndicesReadRO: qm.getActiveReadRO(),
			activeIndicesWriteRW: qm.getActiveWrite(),
			counters,
			currentActiveCount: this._wfMaxRayCount,
		} );
		this._kernelManager.register( 'compact',
			compactFn().compute(
				[ Math.ceil( maxRays / COMPACT_WG_SIZE ), 1, 1 ],
				[ COMPACT_WG_SIZE, 1, 1 ]
			)
		);

		// Storage nodes bind buffer A at build time, so compactCopyback copies the dense survivor list B→A for the next bounce.
		// Full-dispatch path: ENTERING_COUNT = maxRays, kernels read the identity buffer over [0,maxRays).
		const enterFullFn = Fn( () => {

			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), this._wfMaxRayCount );

		} );
		this._kernelManager.register( 'enterFull',
			enterFullFn().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] )
		);

		const copyReadB = qm.activeIndicesRO.b; // compact writes B (pingPong fixed at 0)
		const copyWriteA = qm.activeIndices.a;
		const copyFn = Fn( () => {

			const tid = instanceIndex;
			const active = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );

			// Folds snapshotBounceCount: thread 0 records the survivor count for the readback curve and
			// seeds ENTERING_COUNT for the next bounce. Above the guard so it runs even when active is 0.
			If( tid.equal( uint( 0 ) ), () => {

				const slot = uint( wfCurrentBounce ).clamp( uint( 0 ), uint( qm.MAX_BOUNCE_SNAPSHOTS - 1 ) );
				bounceCountsBuf.element( slot ).assign( active );
				bounceCountsBuf.element( slot.add( uint( qm.MAX_BOUNCE_SNAPSHOTS ) ) ).assign( atomicLoad( counters.element( uint( COUNTER.ACTIVE_ENERGY ) ) ) );
				atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), active );

			} );

			If( tid.greaterThanEqual( active ), () => {

				Return();

			} );
			copyWriteA.element( tid ).assign( copyReadB.element( tid ) );

		} );
		this._kernelManager.register( 'compactCopyback',
			copyFn().compute( [ Math.ceil( maxRays / LIST_WG_SIZE ), 1, 1 ], [ LIST_WG_SIZE, 1, 1 ] )
		);

		if ( this._bidirectionalEnabled ) {

			const bd = this._bidirectional;
			const n = qm.MAX_BOUNCE_SNAPSHOTS;

			// The light pass keeps its own survivor curve, after the camera's: [2n, 3n) counts, [3n, 4n) energy.
			const recordLightCurve = ( active ) => {

				const slot = uint( wfCurrentBounce ).clamp( uint( 0 ), uint( n - 1 ) );
				bounceCountsBuf.element( slot.add( uint( 2 * n ) ) ).assign( active );
				bounceCountsBuf.element( slot.add( uint( 3 * n ) ) ).assign( atomicLoad( counters.element( uint( COUNTER.ACTIVE_ENERGY ) ) ) );
				atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), active );

			};

			this._kernelManager.register( 'lightSnapshot', Fn( () => {

				recordLightCurve( atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) ) );

			} )().compute( [ 1, 1, 1 ], [ 1, 1, 1 ] ) );

			this._kernelManager.register( 'lightCopyback', Fn( () => {

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

			this._kernelManager.register( 'guideClear', buildGuideClearKernel( { counters } ) );
			this._kernelManager.register( 'guideBuild', buildGuideKernel( { counters, out: storage( this._guideBuildAttr, 'float' ) } ) );

			this._kernelManager.register( 'lightGenerate', buildLightGenerateKernel( {
				rayBufferRW: pb.rayBuffer.rw,
				hitBufferRW: pb.hitBuffer.rw,
				activeIndicesRW: qm.activeIndices.a,
				counters,
				lightBuffer: freshLight,
				triangleBuffer: freshTri,
				bvhBuffer: freshBvh,
				emissiveTriangleCount: this.emissiveTriangleCount,
				emissiveVec4Offset: this.emissiveVec4Offset,
				emissiveTotalPower: this.emissiveTotalPower,
				emissiveBoost: this.emissiveBoost,
				sunDirection: this.sunDirection,
				sunRadiance: this.sunRadiance,
				sunParams: this.sunParams,
				environmentIntensity: this.environmentIntensity,
				envTexture: freshEnvTex,
				envCDFTexture: freshEnvCDF,
				envMatrix: this.environmentMatrix,
				envResolution: this.envResolution,
				directionalLightsBuffer: this.directionalLightsBufferNode,
				areaLightsBuffer: this.areaLightsBufferNode,
				pointLightsBuffer: this.pointLightsBufferNode,
				spotLightsBuffer: this.spotLightsBufferNode,
				bidirectional: bd,
				resolution: this.resolution,
				frame: this.seedFrame,
				transmissiveBounces: this.transmissiveBounces,
			} )().compute( [ Math.ceil( maxRays / LIGHT_GENERATE_WG_SIZE ), 1, 1 ], [ LIGHT_GENERATE_WG_SIZE, 1, 1 ] ) );

			this._kernelManager.register( 'connect', buildConnectKernel( {
				rayBufferRW: pb.rayBuffer.rw,
				hitBufferRO: pb.hitBuffer.ro,
				activeIndicesRO: qm.getActiveReadRO(),
				counters,
				bvhBuffer: freshBvh,
				triangleBuffer: freshTri,
				materialBuffer: freshMat,
				resolution: this.resolution,
				frame: this.seedFrame,
				accumFrame: this.frame,
				currentBounce: this._wfCurrentBounce,
				chunkRowBase: this._wfChunkRowBase,
				lightPaths: bd.lightPaths,
				slotsPerPath: bd.slotsPerPath,
				lightTag: bd.lightTag,
				passTag: bd.passTag,
				strategyView: bd.strategyView,
				maxBounceCount: this.maxBounces,
				globalIlluminationIntensity: this.globalIlluminationIntensity,
				fireflyThreshold: this.fireflyThreshold,
				mergeVm: bd.merging ? ( p ) => mergeVmAt( bd, p ) : null,
			} )().compute( [ Math.ceil( maxRays / CONNECT_WG_SIZE ), 1, 1 ], [ CONNECT_WG_SIZE, 1, 1 ] ) );

			if ( bd.merging ) {

				const head = storage( this._mergeHeadAttr, 'uint' ).toAtomic();
				this._kernelManager.register( 'mergeClear', buildMergeClearKernel( { head, hashSize: this._mergeHeadAttr.count } ) );
				this._kernelManager.register( 'mergeInsert', buildMergeInsertKernel( {
					hitBufferRW: pb.hitBuffer.rw,
					head,
					bidirectional: bd,
				} )().compute( [ Math.ceil( this._lightCacheSlots / MERGE_WG_SIZE ), 1, 1 ], [ MERGE_WG_SIZE, 1, 1 ] ) );
				this._kernelManager.register( 'merge', buildMergeKernel( {
					rayBufferRW: pb.rayBuffer.rw,
					hitBufferRO: pb.hitBuffer.ro,
					activeIndicesRO: qm.getActiveReadRO(),
					counters,
					head,
					materialBuffer: freshMat,
					bidirectional: bd,
					maxBounceCount: this.maxBounces,
					globalIlluminationIntensity: this.globalIlluminationIntensity,
					fireflyThreshold: this.fireflyThreshold,
					accumFrame: this.frame,
				} )().compute( [ Math.ceil( maxRays / MERGE_WG_SIZE ), 1, 1 ], [ MERGE_WG_SIZE, 1, 1 ] ) );

			}

			const splatBuffer = storage( this._splatAttr, 'uint' ).toAtomic();

			this._kernelManager.register( 'lightSplat', buildLightSplatKernel( {
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
				cameraViewMatrix: this.cameraViewMatrix,
				cameraProjectionMatrix: this.cameraProjectionMatrix,
				pixelArea: bd.pixelArea,
				renderWidth: this._wfRenderWidth,
				renderHeight: this._wfRenderHeight,
				globalIlluminationIntensity: this.globalIlluminationIntensity,
				fireflyThreshold: this.fireflyThreshold,
				accumFrame: this.frame,
				frame: this.seedFrame,
				mergeVm: bd.merging ? ( p ) => mergeVmAt( bd, p ) : null,
			} )().compute( [ Math.ceil( this._lightCacheSlots / LIGHT_SPLAT_WG_SIZE ), 1, 1 ], [ LIGHT_SPLAT_WG_SIZE, 1, 1 ] ) );

			this._kernelManager.register( 'splatResolve', buildSplatResolveKernel( {
				rayBufferRW: pb.rayBuffer.rw,
				splatBuffer,
				renderWidth: this._wfRenderWidth,
				chunkRowBase: this._wfChunkRowBase,
				chunkRows: this._wfChunkRows,
			} )().compute(
				[ Math.ceil( w / SPLAT_RESOLVE_WG_SIZE ), Math.ceil( this._chunkRows / SPLAT_RESOLVE_WG_SIZE ), 1 ],
				[ SPLAT_RESOLVE_WG_SIZE, SPLAT_RESOLVE_WG_SIZE, 1 ]
			) );

		}

		const fwFn = buildFinalWriteKernel( {
			rayBufferRO: pb.rayBuffer.ro,
			gBufferRO,
			writeColorTex: writeTex.color,
			writeNDTex: writeTex.normalDepth,
			writeAlbedoTex: writeTex.albedo,
			resolution: this.resolution,
			frame: this.frame,
			enableAccumulation: this.enableAccumulation,
			hasPreviousAccumulated: this.hasPreviousAccumulated,
			accumulationAlpha: this.accumulationAlpha,
			hasPreviousAux: this.hasPreviousAux,
			auxAccumulationAlpha: this.auxAccumulationAlpha,
			cameraIsMoving: this.cameraIsMoving,
			transparentBackground: this.transparentBackground,
			prevAccumTexture: prevColor,
			prevAlbedoTexture: prevAlbedo,
			prevNormalDepthTexture: prevNormalDepth,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			visMode: this.visMode,
			auxGBufferEnabled: this._auxGBufferUniform,
			cleanAuxNormalEnabled: this._cleanAuxNormalUniform,
			m2BufferRW: m2RW,
			useAdaptiveSampling: this.useAdaptiveSampling,
			noiseThreshold: this.noiseThreshold,
			adaptiveMinSamples: this.adaptiveMinSamples,
			// Tier-2 freeze (stamp + pass-through)
			usePixelFreeze: this.usePixelFreeze,
			pixelFreezeThreshold: this.pixelFreezeThreshold,
			streakBufferRW: streakRW,
			frozenMaskRO, // dilated frozen mask (read-only; matches the active-list decision)
			convergenceOverlay: this.convergenceOverlay,
			chunkRowBase: this._wfChunkRowBase,
			chunkRows: this._wfChunkRows,
		} );
		this._kernelManager.register( 'finalWrite',
			// Per-pixel (w×h) — kernel averages the S sample-slots internally.
			fwFn().compute(
				[ Math.ceil( w / FINALWRITE_WG_SIZE ), Math.ceil( this._chunkRows / FINALWRITE_WG_SIZE ), 1 ],
				[ FINALWRITE_WG_SIZE, FINALWRITE_WG_SIZE, 1 ]
			)
		);

		// Debug visualization (visMode 1-10): single-pass primary-ray kernel. Reuses the same fresh*
		// scene nodes so _refreshWfTextureNodes keeps it current; mode 11 (NaN/Inf) is FinalWrite's branch.
		const debugFn = buildDebugKernel( {
			writeColorTex: writeTex.color,
			writeNDTex: writeTex.normalDepth,
			writeAlbedoTex: writeTex.albedo,
			resolution: this.resolution,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			cameraProjectionMatrix: this.cameraProjectionMatrix,
			cameraViewMatrix: this.cameraViewMatrix,
			cameraProjection: this.cameraProjection,
			panoLonRange: this.panoLonRange,
			panoLatRange: this.panoLatRange,
			panoLevelHorizon: this.panoLevelHorizon,
			enableDOF: this.enableDOF,
			focalLength: this.focalLength,
			aperture: this.aperture,
			focusDistance: this.focusDistance,
			unitsPerMetre: this.unitsPerMetre,
			apertureScale: this.apertureScale,
			anamorphicRatio: this.anamorphicRatio,
			dofMode: this.dofMode,
			dofBlur: this.dofBlur,
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			envTexture: freshEnvTex,
			environmentMatrix: this.environmentMatrix,
			environmentIntensity: this.environmentIntensity,
			enableEnvironmentLight: this.enableEnvironment,
			visMode: this.visMode,
			debugVisScale: this.debugVisScale,
			frame: this.frame,
		} );
		this._kernelManager.register( 'debug',
			debugFn().compute(
				[ Math.ceil( w / DEBUG_WG_SIZE ), Math.ceil( h / DEBUG_WG_SIZE ), 1 ],
				[ DEBUG_WG_SIZE, DEBUG_WG_SIZE, 1 ]
			)
		);

		this._wavefrontReady = true;

		const bufferBytes = ( this._packedBuffers?.totalBytes ?? 0 ) + ( this._queueManager?.totalBytes ?? 0 );

		log.info( fmt.list( [
			fmt.px( w, h ),
			`${fmt.mb( bufferBytes )} wavefront buffers`,
			`budget ${fmt.n( B )} paths`,
			this._numChunks > 1 ? `${this._numChunks} chunks of ≤${this._chunkRows} rows` : null,
			this._bidirectionalEnabled ? `bidirectional: ${fmt.n( this._lightCacheSlots )} light vertex slots${this._mergingEnabled ? ' + merging' : ''}` : null,
		] ) );

	}

	// Debug viz is a single full-frame pass (no chunking, no ray pool). generate/finalWrite are sized
	// per row-band chunk inside render()'s chunk loop, not here.
	_setWfDispatch() {

		const w = this._wfRenderWidth.value;
		const h = this._wfRenderHeight.value;

		this._kernelManager.setDispatchForGrid( 'debug', w, h );
		// Full-frame (not per-chunk); sized from live values so an in-place resize can't strand its grid.
		this._kernelManager.setDispatchForCount( 'countConvergedDilated', w * h );

	}

	// Program the per-chunk dispatch grids + chunk uniforms for one row band, then return its pixel count.
	// rowBase/rows are the band's GLOBAL first row + row count; chunkIndex 0 ⇒ first chunk (frame-scoped
	// counter reset). Generate/FinalWrite run 2D over (w × rows); initActiveIndices/buildActivePixels 1D.
	_setChunk( rowBase, rows, chunkIndex ) {

		const w = this._wfRenderWidth.value;
		const chunkPixels = rows * w;
		this._wfChunkRowBase.value = rowBase;
		this._wfChunkRows.value = rows;
		this._wfIsFirstChunk.value = chunkIndex === 0 ? 1 : 0;
		this._wfMaxRayCount.value = chunkPixels;

		const km = this._kernelManager;
		km.setDispatchForGrid( 'generate', w, rows );
		km.setDispatchForGrid( 'finalWrite', w, rows );
		km.setDispatchForGrid( 'splatResolve', w, rows );
		km.setDispatchForCount( 'initActiveIndices', chunkPixels );
		km.setDispatchForCount( 'buildActivePixels', chunkPixels );

		return chunkPixels;

	}

	dispose() {

		super.dispose();
		this._packedBuffers?.dispose();
		this._queueManager?.dispose();
		this._kernelManager?.dispose();
		this._gBufferAttr?.dispose?.();
		this._m2Attr?.dispose?.();
		this._streakAttr?.dispose?.();
		this._frozenMaskAttr?.dispose?.();
		freeStorageAttribute( this.renderer, this._splatAttr );
		this._splatAttr = null;
		freeStorageAttribute( this.renderer, this._mergeHeadAttr );
		this._mergeHeadAttr = null;
		this._disposeLightGuide();
		this._packedBuffers = null;
		this._queueManager = null;
		this._kernelManager = null;
		this._gBufferAttr = null;
		this._m2Attr = null;
		this._streakAttr = null;
		this._frozenMaskAttr = null;
		this._convDebugSource = null;
		this._wavefrontReady = false;

	}

}
