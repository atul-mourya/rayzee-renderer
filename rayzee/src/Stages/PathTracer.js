/**
 * Wavefront path tracer — decomposed kernel dispatch (Extend → [Sort] → Shade → Compact per
 * bounce, bookended by Generate + FinalWrite; DebugKernel for visMode). Extends PathTracerStage
 * for shared engine/scene infrastructure (managers, uniforms, camera, lights, BVH, accumulation).
 */

import { uniform, texture, storage } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { PathTracerStage } from './PathTracerStage.js';
import { PackedRayBuffer, GBUFFER_STRIDE, RAY_STRIDE, HIT_STRIDE, freeStorageAttribute } from '../Processor/PackedRayBuffer.js';
import { QueueManager, COUNTER } from '../Processor/QueueManager.js';
import { VRAMTracker } from '../Processor/VRAMTracker.js';
import { KernelManager } from '../Processor/KernelManager.js';
import { buildGenerateKernel, GENERATE_WG_SIZE } from '../TSL/GenerateKernel.js';
import { buildExtendKernel, EXTEND_WG_SIZE } from '../TSL/ExtendKernel.js';
import { buildShadeKernel, SHADE_WG_SIZE } from '../TSL/ShadeKernel.js';
import { buildCompactKernel, buildCompactSubgroupKernel, COMPACT_WG_SIZE } from '../TSL/CompactKernel.js';
import { buildFinalWriteKernel, FINALWRITE_WG_SIZE } from '../TSL/FinalWriteKernel.js';
import { buildDebugKernel, DEBUG_WG_SIZE } from '../TSL/DebugKernel.js';
import { setMaterialBucketTextures, buildBucketTextureNodes, refreshBucketTextureNodes } from '../TSL/TextureSampling.js';
import { setShadowAlbedoMaps } from '../TSL/LightsDirect.js';
import {
	buildResetGlobalHistKernel, buildGlobalHistKernel, buildGlobalPrefixKernel, buildGlobalScatterKernel,
	SORT_GLOBAL_WG_SIZE, SORT_GLOBAL_MAX_BINS,
} from '../TSL/SortGlobalKernels.js';
import { ENGINE_DEFAULTS, MAX_STORAGE_TEXTURE_SIZE } from '../EngineDefaults.js';
import { createLogger, fmt } from '../utils/Logger.js';
import {
	Fn, uint, int, atomicStore, atomicLoad, atomicAdd, instanceIndex, If, Return,
} from 'three/tsl';

const log = createLogger( 'wavefront' );

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

		// CPU sizes per-bounce kernels from last frame's survivor curve; kernels bound on ENTERING_COUNT so over-sizing is safe. (indirect dispatch not viable — three.js doesn't sync compute-written indirect buffers across submissions)
		this._useDynamicDispatch = true;

		// Global material-coherence sort: set per-build from ENGINE_DEFAULTS + material count (>8).
		// Reorders entering rays into material-pure workgroups before Shade; runs under dynamic dispatch
		// (compact reads the unsorted active list, so the survivor set is unchanged). Measured −8% at 1024²/8b.
		this._sortMaterials = false;

		// Flag-gated off: perf-neutral vs atomic-append and adds a 'subgroups' feature dependency.
		this._useSubgroupCompact = false;

		this._lastBounceCounts = null;
		// maxBounces the curve was measured at; the curve is ignored once this no longer matches (-1 = none).
		this._lastBounceCountsBudget = - 1;
		this._readbackPending = false;
		this._readbackEveryNFrames = 4;
		this._readbackFrameCounter = 0;
		// Bumped on resolution change; a readback that resolves with a stale generation is dropped.
		this._readbackGeneration = 0;
		// Whether the survivor curve may be trusted to SIZE the dispatch. False during/after camera motion
		// (or resize) until a readback measured at the settled view re-validates it — full-size until then so
		// a stale/mid-motion curve can't under-size the row-major list and drop the bottom rows. The curve is
		// still used for the per-bounce early-exit regardless (a stale early-exit only trims empty deep bounces).
		this._curveSizingValid = false;
		// 0.1% of primary ray count, floored at 100; -1 to disable. Updated per-scene in _buildWavefrontKernels.
		this._bounceEarlyExitThreshold = 100;

		// Tier-1 convergence early-stop: fraction of pixels converged in the last settled-view readback, and a
		// single-flight guard for its async counter read. Zeroed on reset/camera-move/resize; never refreshed
		// mid-motion (the readback early-return + frozen frameCount keep the stop from firing while moving).
		this._convergedFraction = 0;
		this._convergedReadbackPending = false;

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
		this._chunkRows = 0; // rows per chunk = floor(B / renderWidth), clamped ≥1
		this._numChunks = 1; // ceil(renderHeight / chunkRows)

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
		t.register( 'geometry', () => [ this.triangleStorageAttr, this.bvhStorageAttr, this.lightStorageAttr ] );

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

	render( context ) {

		// Kernels not built yet (first frame / mid-resize) — skip until ready.
		if ( ! this.isReady || ! this._wavefrontReady ) return;

		// The packed light buffer was grow-reallocated at runtime (emissive set grew) —
		// the compiled kernels still bind the old attribute, so rebuild before rendering.
		if ( this._lightBufferRealloc ) {

			if ( this._kernelManager ) this._kernelManager.dispose();
			this._wavefrontReady = false;
			this._buildWavefrontKernels();
			if ( ! this._wavefrontReady ) return;

		}

		if ( this.isComplete || this.frameCount >= this.completionThreshold || this._isConvergedComplete() ) {

			if ( ! this.isComplete ) this.isComplete = true;
			return;

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
			// Tier-2: drop the stale active-pixel count so bounce 0 full-sizes until the new pose re-measures.
			this._lastActivePixelCount = 0;

		}

		this._updateAccumulationUniforms( frameValue, renderMode );
		this.frame.value = frameValue;
		this.seedFrame.value = this._seedTick ++;

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
		const loopBound = maxBounces + this.transmissiveBounces.value + this.maxSubsurfaceSteps.value;

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
		const curve = this._lastBounceCounts;
		const curveReliableUpto = ( singleChunk && curve )
			? ( maxBounces <= this._lastBounceCountsBudget ? loopBound + 1 : this._lastBounceCountsBudget )
			: 0;

		// Blender-style row-band streaming: the fixed-budget path pool processes the image in bands of ≤ chunkRows
		// rows (one chunk when the frame fits the budget → identical to the pre-chunking path). See spec.
		for ( let chunkIndex = 0, rowBase = 0; rowBase < frameHeight; rowBase += chunkRows, chunkIndex ++ ) {

			const rows = Math.min( chunkRows, frameHeight - rowBase );
			const maxRays = this._setChunk( rowBase, rows, chunkIndex ); // this band's pixel count + per-chunk grids

			// Tier-2 bounce-0 grid size from the stale settled active-pixel count (single-chunk only; else full).
			// Monotonic freeze ⇒ a stale count is a safe over-estimate; reset/camera-move → _curveSizingValid=false.
			const adaptiveFreeze = this.usePixelFreeze.value > 0;
			const activeBounce0 = ( singleChunk && adaptiveFreeze && this._curveSizingValid && this._lastActivePixelCount > 0 )
				? this._lastActivePixelCount : maxRays;

			if ( adaptiveFreeze ) {

				// reset counters → compact non-frozen pixel IDs → publish count → list-driven 1D generate.
				const genSized = Math.min( maxRays, Math.ceil( activeBounce0 * 1.5 ) + 1024 );
				km.setDispatchCount( 'generateList', [ Math.ceil( genSized / 256 ), 1, 1 ] );
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
					const wg = [ Math.ceil( sized / 256 ), 1, 1 ];
					km.setDispatchCount( 'extend', wg );
					km.setDispatchCount( 'shade', wg );
					km.setDispatchCount( 'globalHist', wg );
					km.setDispatchCount( 'globalScatter', wg );
					km.setDispatchCount( 'compact', wg );
					km.setDispatchCount( 'compactCopyback', wg );

				} else {

					km.dispatch( 'enterFull' );
					const full = [ Math.ceil( maxRays / 256 ), 1, 1 ];
					km.setDispatchCount( 'extend', full );
					km.setDispatchCount( 'shade', full );
					km.setDispatchCount( 'compact', full );
					km.setDispatchCount( 'globalHist', full );
					km.setDispatchCount( 'globalScatter', full );

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

				km.dispatch( 'shade' ); // shade thread 0 folds resetActiveCounter (zeroes ACTIVE_RAY_COUNT before compact)
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
					bounce < curveReliableUpto
					&& bounce < loopBound
					&& curve[ bounce ] !== undefined
					&& curve[ bounce ] <= this._bounceEarlyExitThreshold
				) {

					break;

				}

			}

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

		if ( originalMaxBounces !== null ) this.maxBounces.value = originalMaxBounces;

		this.performanceMonitor?.end();

	}

	// Tier-1 convergence early-stop: retire the WHOLE frame once enough samples have accumulated AND ~all pixels
	// hit the relative-error floor. Keeps the global 1/(frame+1) alpha untouched — only the stop condition
	// changes. Naturally gated off while moving: frameCount is frozen in interaction mode (< minSamples) and
	// _convergedFraction is zeroed on camera-move and never refreshed mid-motion (readback early-returns).
	_isConvergedComplete() {

		return this.useAdaptiveSampling.value > 0
			&& this.frameCount >= this.adaptiveMinSamples.value
			&& this._convergedFraction >= this.adaptiveStopFraction.value;

	}

	reset() {

		super.reset();
		this._convergedFraction = 0;
		this._lastActivePixelCount = 0;

	}

	// Parent resizes storageTextures/shaderBuilder; wavefront also needs its buffers/uniforms/kernels rebuilt.
	_handleResize() {

		const oldW = this.storageTextures.renderWidth;
		const oldH = this.storageTextures.renderHeight;

		super._handleResize();

		this._rebuildKernelsIfResized( oldW, oldH );

	}

	// Aux MRT (normalDepth/albedo) is needed only by the denoiser/OIDN; DenoisingManager calls this to
	// turn the wavefront's aux writes on/off. It's a live uniform, so toggling is just a value flip +
	// accumulation reset — no kernel rebuild, no UI freeze.
	setAuxGBufferEnabled( enabled ) {

		enabled = !! enabled;
		if ( this._auxGBufferEnabled === enabled ) return;
		this._auxGBufferEnabled = enabled;
		this._auxGBufferUniform.value = enabled ? 1 : 0;
		this.reset();

	}

	// Clean-aux normal: when a clean-aux OIDN model is active (calb_cnrm/high, alb_nrm/balanced), FinalWrite
	// temporally accumulates + renormalizes the aux normal so the model isn't fed per-frame point-sampled
	// noise. DenoisingManager calls this on OIDN enable + quality change. Live uniform → value flip + reset.
	setCleanAuxNormal( enabled ) {

		enabled = !! enabled;
		if ( this._cleanAuxNormalEnabled === enabled ) return;
		this._cleanAuxNormalEnabled = enabled;
		this._cleanAuxNormalUniform.value = enabled ? 1 : 0;
		this.reset();

	}

	// UI-driven resize (Resolution dropdown) — parent bypasses _handleResize(), so hook here too.
	setSize( width, height ) {

		const oldW = this.storageTextures.renderWidth;
		const oldH = this.storageTextures.renderHeight;

		super.setSize( width, height );

		this._rebuildKernelsIfResized( oldW, oldH );

	}

	// Async readback of the per-bounce snapshot every N frames; never awaited, so the early-exit uses past-frame data.
	_maybeReadbackCounters() {

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

		this._readbackFrameCounter ++;
		if ( this._readbackFrameCounter < this._readbackEveryNFrames ) return;
		this._readbackFrameCounter = 0;

		const attr = this._queueManager?.getBounceCountsAttribute();
		if ( ! attr ) return;

		this._readbackPending = true;
		const gen = this._readbackGeneration;
		const budget = this.maxBounces.value;
		this.renderer.getArrayBufferAsync( attr ).then( ( buf ) => {

			// Drop counts measured at a now-stale generation (a resize or camera move happened mid-flight).
			// A surviving readback was initiated while settled (init is skipped mid-motion) and no motion
			// happened before it resolved, so its counts match the current view — safe to size from.
			if ( gen === this._readbackGeneration ) {

				this._lastBounceCounts = new Uint32Array( buf.slice( 0 ) );
				this._lastBounceCountsBudget = budget;
				this._curveSizingValid = true;

			}

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
				this.renderer.getArrayBufferAsync( cAttr ).then( ( buf ) => {

					if ( cgen === this._readbackGeneration && total > 0 ) {

						const c = new Uint32Array( buf );
						this._convergedFraction = c[ COUNTER.CONVERGED_COUNT ] / total;
						// Tier-2: bounce-0 active-pixel count measured this settled frame → sizes next frame's grid.
						this._lastActivePixelCount = c[ COUNTER.ACTIVE_PIXEL_COUNT ];

					}

					this._convergedReadbackPending = false;

				} ).catch( () => {

					this._convergedReadbackPending = false;

				} );

			}

		}

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
		this._lastBounceCounts = null;
		this._lastBounceCountsBudget = - 1;
		this._curveSizingValid = false;
		this._readbackFrameCounter = 0;
		this._readbackGeneration ++;
		this._convergedFraction = 0;
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
		if ( this._bounceEarlyExitThreshold !== - 1 ) {

			this._bounceEarlyExitThreshold = Math.max( 100, Math.floor( ( w * h ) / 1000 ) );

		}

	}

	// Device-adaptive paths-in-flight budget B (Blender path-pool). Constrained by:
	//  (1) each single storage buffer ≤ maxStorageBufferBindingSize — the RAY buffer (B·RAY_STRIDE·16 B) binds
	//      largest, so B·RAY_STRIDE·16 ≤ 0.9·maxStorageBufferBindingSize;
	//  (2) total pool ≤ a fraction of device memory;
	//  (3) floor at 512² of paths, cap at the reserved max pixels (no point pooling more paths than pixels).
	// B is resolution-INDEPENDENT, so _cap is fixed and the kernels build once. The render-loop chunking streams
	// any resolution through this pool, so a small B just means more row-bands (works on weak / small-VRAM GPUs).
	_computePathBudget() {

		if ( this._pathBudgetOverride > 0 ) return this._pathBudgetOverride;

		const RAY_BYTES = RAY_STRIDE * 16;
		const bytesPerPath = RAY_STRIDE * 16 + HIT_STRIDE * 16 + 4 /* rng */ + GBUFFER_STRIDE * 16
			+ 4 + 4 /* activeIndices A/B */ + 4;

		const limits = this.renderer?.backend?.device?.limits;
		const maxBinding = limits?.maxStorageBufferBindingSize || ( 128 * 1024 * 1024 );
		const maxBuffer = limits?.maxBufferSize || maxBinding;

		const bByBinding = Math.floor( ( maxBinding * 0.9 ) / RAY_BYTES );
		const deviceMemBytes = ( ( typeof navigator !== 'undefined' && navigator.deviceMemory ) || 4 ) * 1024 * 1024 * 1024;
		const poolVramBudget = Math.min( deviceMemBytes * 0.25, maxBuffer * 4 );
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
	// independent and untouched. Caller must have rendering paused. No-op before the first build.
	reallocateReservedStorage() {

		if ( ! this._packedBuffers || ! ( this.materialData?.materialCount > 0 ) ) return;

		// Clamp into the (possibly just-lowered) reserve: create() sizes the write StorageTextures at
		// MAX_STORAGE_TEXTURE_SIZE but the readTarget at what's passed here, and the tracked render size still
		// holds the pre-change value — unclamped, copyToReadTargets reads past the write textures.
		const w = Math.min( this.storageTextures.renderWidth || 1, MAX_STORAGE_TEXTURE_SIZE );
		const h = Math.min( this.storageTextures.renderHeight || 1, MAX_STORAGE_TEXTURE_SIZE );

		// Recreate the MRT pool at the new reserved size (create() reallocates the write StorageTextures at the
		// live MAX_STORAGE_TEXTURE_SIZE; the read RenderTarget follows the current render size).
		this.storageTextures.create( w, h );
		this.resolution.value.set( w, h );

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

		const w = this.storageTextures.renderWidth;
		const h = this.storageTextures.renderHeight;

		// Fixed device-budget path pool B (resolution-independent) + the row-band chunk layout for this frame.
		if ( ! this._pathBudget ) this._pathBudget = this._computePathBudget();
		const B = this._pathBudget;
		this._updateChunkLayout();

		// Rays in one row-band chunk — the initial dispatch bound for kernel registration. render() overrides
		// every per-ray kernel's dispatch per chunk; this is just a valid starting grid (always ≤ B).
		const maxRays = this._chunkRows * w;

		if ( this._bounceEarlyExitThreshold !== - 1 ) {

			this._bounceEarlyExitThreshold = Math.max( 100, Math.floor( ( w * h ) / 1000 ) );

		}

		// Per-path buffers (RAY/HIT/rng) sized to the budget B and indexed by LOCAL slot r ∈ [0,B). _cap = B is
		// baked into the SoA stride but never changes with resolution, so this build happens once (model load).
		if ( ! this._packedBuffers ) {

			this._packedBuffers = new PackedRayBuffer( B, this.renderer );

		} else {

			this._packedBuffers.resize( B );

		}

		// Per-CHUNK first-hit G-buffer (LOCAL slot r, size B), 1 uvec4/slot half-packed (pack2x16). Written by
		// Generate + Shade(bounce 0), read by Shade + FinalWrite within the SAME chunk, so per-chunk suffices.
		// uint (not f32): packed lanes can hit the NaN exponent range (snorm 1.0 → 0x7FFF) that an f32 store may
		// canonicalize; u32 stores the bits verbatim.
		const gBufferVec4s = B * GBUFFER_STRIDE;
		freeStorageAttribute( this.renderer, this._gBufferAttr );
		this._gBufferAttr = new StorageInstancedBufferAttribute( new Uint32Array( gBufferVec4s * 4 ), 4 );
		const gBufferRW = storage( this._gBufferAttr, 'uvec4' );
		const gBufferRO = storage( this._gBufferAttr, 'uvec4' ).toReadOnly();

		// Per-PIXEL persistent buffers (m2/streak/frozenMask) are GLOBAL-pixel-indexed (p = pixelBase + r) and
		// must span the whole frame across chunks AND persist across frames, so they're sized to the reserved
		// max resolution (small — 12 B/pixel) and NEVER realloc on a resize.
		const maxPixels = MAX_STORAGE_TEXTURE_SIZE * MAX_STORAGE_TEXTURE_SIZE;

		// Tier-1 convergence: per-pixel running mean of luminance² (Welford second moment), read+written by FinalWrite.
		freeStorageAttribute( this.renderer, this._m2Attr );
		this._m2Attr = new StorageInstancedBufferAttribute( new Float32Array( maxPixels ), 1 );
		const m2RW = storage( this._m2Attr, 'float' );

		// Tier-2: per-pixel freeze-candidate streak. FinalWrite writes (RW), buildActivePixels reads (RO).
		freeStorageAttribute( this.renderer, this._streakAttr );
		this._streakAttr = new StorageInstancedBufferAttribute( new Uint32Array( maxPixels ), 1 );
		const streakRW = storage( this._streakAttr, 'uint' );
		const streakRO = storage( this._streakAttr, 'uint' ).toReadOnly();

		// Tier-2: dilated frozen mask (1 = skip). buildActivePixels writes; active-list + FinalWrite read → race-free.
		freeStorageAttribute( this.renderer, this._frozenMaskAttr );
		this._frozenMaskAttr = new StorageInstancedBufferAttribute( new Uint32Array( maxPixels ), 1 );
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

				} );

			} );

		} );
		this._kernelManager.register( 'initActiveIndices',
			initFn().compute( [ Math.ceil( ( this._chunkRows * w ) / 256 ), 1, 1 ], [ 256, 1, 1 ] )
		);

		const genParams = {
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			gBufferRW,
			resolution: this.resolution,
			// RNG axis only (baseSeed + stratified jitter) — takes the seed counter, not the
			// accumulation index. FinalWrite keeps `frame`.
			frame: this.seedFrame,
			cameraWorldMatrix: this.cameraWorldMatrix,
			cameraProjectionMatrixInverse: this.cameraProjectionMatrixInverse,
			enableDOF: this.enableDOF,
			focalLength: this.focalLength,
			aperture: this.aperture,
			focusDistance: this.focusDistance,
			sceneScale: this.sceneScale,
			apertureScale: this.apertureScale,
			anamorphicRatio: this.anamorphicRatio,
			renderWidth: this._wfRenderWidth,
			renderHeight: this._wfRenderHeight,
			chunkRowBase: this._wfChunkRowBase,
			chunkRows: this._wfChunkRows,
			transmissiveBounces: this.transmissiveBounces,
			transparentBackground: this.transparentBackground,
			auxGBufferEnabled: this._auxGBufferUniform,
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

			// ACTIVE is per-chunk (zeroed before every chunk's scatter). CONVERGED/FROZEN are per-FRAME counters
			// summed across chunks in FinalWrite → zero them only on the first chunk of the frame.
			atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 0 ) );
			If( this._wfIsFirstChunk.greaterThan( uint( 0 ) ), () => {

				atomicStore( counters.element( uint( COUNTER.CONVERGED_COUNT ) ), uint( 0 ) );
				atomicStore( counters.element( uint( COUNTER.FROZEN_COUNT ) ), uint( 0 ) );

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

				If( this.frame.greaterThan( uint( 0 ) ).and( streakRO.element( p ).greaterThanEqual( uint( freezeK ) ) ), () => {

					frozen.assign( uint( 1 ) );

					If( this._dilateFrozenUniform.greaterThan( int( 0 ) ), () => {

						const px = int( p ).mod( this._wfRenderWidth );
						const py = int( p ).div( this._wfRenderWidth );

						for ( const [ dx, dy ] of [[ - 1, - 1 ], [ 0, - 1 ], [ 1, - 1 ], [ - 1, 0 ], [ 1, 0 ], [ - 1, 1 ], [ 0, 1 ], [ 1, 1 ]] ) {

							const nx = px.add( int( dx ) );
							const ny = py.add( int( dy ) );
							If( nx.greaterThanEqual( int( 0 ) ).and( nx.lessThan( this._wfRenderWidth ) )
								.and( ny.greaterThanEqual( int( 0 ) ) ).and( ny.lessThan( this._wfRenderHeight ) ), () => {

								If( streakRO.element( uint( ny.mul( this._wfRenderWidth ).add( nx ) ) ).lessThan( uint( freezeK ) ), () => {

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
			buildActiveFn().compute( [ Math.ceil( ( this._chunkRows * w ) / 256 ), 1, 1 ], [ 256, 1, 1 ] )
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
			genListFn().compute( [ Math.ceil( maxRays / 256 ), 1, 1 ], [ 256, 1, 1 ] )
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
			materialBuffer: freshMat,
			rayBufferRO: pb.rayBuffer.ro,
			hitBufferRW: pb.hitBuffer.rw,
			activeIndicesRO: qm.getActiveReadRO(),
			counters,
			maxRayCount: this._wfMaxRayCount,
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
			envCompensationDelta: this.envCompensationDelta,
			bvhBuffer: freshBvh,
			triangleBuffer: freshTri,
			materialBuffer: freshMat,
			envCDFTexture: freshEnvCDF,
			lightBuffer: freshLight,
			rayBufferRW: pb.rayBuffer.rw,
			rngBufferRW: pb.rngBuffer.rw,
			hitBufferRO: pb.hitBuffer.ro,
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
			// RNG axis only (keys STBN via frame & 63).
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
				atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), active );

			} );

			If( tid.greaterThanEqual( active ), () => {

				Return();

			} );
			copyWriteA.element( tid ).assign( copyReadB.element( tid ) );

		} );
		this._kernelManager.register( 'compactCopyback',
			copyFn().compute( [ Math.ceil( maxRays / 256 ), 1, 1 ], [ 256, 1, 1 ] )
		);

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
			counters,
			m2BufferRW: m2RW,
			useAdaptiveSampling: this.useAdaptiveSampling,
			noiseThreshold: this.noiseThreshold,
			adaptiveMinSamples: this.adaptiveMinSamples,
			// Tier-2 freeze (stamp + pass-through)
			usePixelFreeze: this.usePixelFreeze,
			pixelFreezeThreshold: this.pixelFreezeThreshold,
			pixelFreezeStability: this.pixelFreezeStability,
			streakBufferRW: streakRW,
			frozenMaskRO, // dilated frozen mask (read-only; matches the active-list decision)
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
			enableDOF: this.enableDOF,
			focalLength: this.focalLength,
			aperture: this.aperture,
			focusDistance: this.focusDistance,
			sceneScale: this.sceneScale,
			apertureScale: this.apertureScale,
			anamorphicRatio: this.anamorphicRatio,
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
		] ) );

	}

	// Debug viz is a single full-frame pass (no chunking, no ray pool). generate/finalWrite are sized
	// per row-band chunk inside render()'s chunk loop, not here.
	_setWfDispatch() {

		const w = this._wfRenderWidth.value;
		const h = this._wfRenderHeight.value;

		this._kernelManager.setDispatchCount( 'debug', [
			Math.ceil( w / DEBUG_WG_SIZE ),
			Math.ceil( h / DEBUG_WG_SIZE ), 1
		] );

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
		km.setDispatchCount( 'generate', [ Math.ceil( w / GENERATE_WG_SIZE ), Math.ceil( rows / GENERATE_WG_SIZE ), 1 ] );
		km.setDispatchCount( 'finalWrite', [ Math.ceil( w / FINALWRITE_WG_SIZE ), Math.ceil( rows / FINALWRITE_WG_SIZE ), 1 ] );
		km.setDispatchCount( 'initActiveIndices', [ Math.ceil( chunkPixels / 256 ), 1, 1 ] );
		km.setDispatchCount( 'buildActivePixels', [ Math.ceil( chunkPixels / 256 ), 1, 1 ] );

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
		this._packedBuffers = null;
		this._queueManager = null;
		this._kernelManager = null;
		this._gBufferAttr = null;
		this._m2Attr = null;
		this._streakAttr = null;
		this._frozenMaskAttr = null;
		this._wavefrontReady = false;

	}

}
