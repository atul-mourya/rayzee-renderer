import { EventDispatcher } from 'three';
import { OIDNDenoiser } from '../Passes/OIDNDenoiser.js';
import { AIUpscaler } from '../Passes/AIUpscaler.js';
import { EngineEvents } from '../EngineEvents.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE, ASVGF_QUALITY_PRESETS, NRD_DEFAULTS, NRD_QUALITY_PRESETS, NRD_PRESET_KEYS } from '../EngineDefaults.js';

// A refresh slower than this is a slideshow, not a live view, so the cadence swaps to a cheaper
// model and puts the chosen one back for the finished image. Resolution-aware by construction:
// at 512² every tier is under budget, at 1024² only `high` trips it.
//
// This replaced a second, time-based trigger ("downgrade once the render passes 2 s"), which
// measured identically at 1024² for balance and high because the cost rule had already tripped —
// but which also downgraded tiers that were affordable, on machines fast enough to run them.
const CADENCE_COST_BUDGET_MS = 120;

// Start-to-start gap as a multiple of what the last denoise actually cost. This is the whole
// throttle: it spends half the wall clock on denoising at most, at any resolution, on any GPU.
// A fixed millisecond floor cannot do that — the same tier measures 14 ms at 512², 48 ms at
// 1024² and 800 ms at 2048².
//
// It replaced a sample-growth rule (refresh only once the sample count had grown 1.4x), which
// was written when a denoise cost 100-330 ms. Measured after the denoise got cheap, that rule
// only ever cost refreshes: 512² 2/s -> 32/s and 1024² 2/s -> 8.6/s, both at unchanged sample
// rate, while 1536²/2048² did not move at all because this floor already bound there.
//
// 3x measured 97 % of the sample rate at 1536² against 89 % for 2x, but at a quarter of the
// refreshes — 2x is the better trade while a person is watching the image resolve.
const CADENCE_DENOISE_PERIODS = 2;

// The first refresh of a fresh accumulation is the one replacing a held frame that is now stale, so
// it waits one denoise rather than two. Measured over a 2 s reset storm (a slider being dragged):
// 8.4 -> 12.5-15.3 refreshes/sec for 75.5 -> 70-73 fps.
const CADENCE_FIRST_REFRESH_PERIODS = 1;

// While the camera moves, the denoised frames ARE the picture — the raw render is never shown — so
// the refresh rate is the frame rate a person sees, and back to back is the right cadence. Path
// tracing costs little there (1 bounce, no accumulation), and `isDenoising` serialises the runs.
const CADENCE_INTERACTION_PERIODS = 0;

// A denoise slower than this cannot follow a camera: holding the last one would turn navigation
// into a slideshow, so it goes back to the raw render instead. Measured on a 1.9M-triangle scene
// at `fast`: 512² 59 ms (35 refreshes/sec while moving, 121 fps), 1024² 135 ms (7/sec, 47 fps),
// 1536² 1.46 s. Set to keep 1024² on the clean side of the line and reject 1536².
const INTERACTION_HOLD_BUDGET_MS = 300;

// How many refresh timings the navigation decision is taken over. A single denoise is easily twice
// its own typical cost — a GC pause, a texture upload, another tab — and deciding on one of those
// left the next camera move entirely raw. The median of a few is stable and still cheap.
//
// Only refreshes taken WHILE MOVING count: that is a different regime, because the render loop
// stops tracing frames nobody will see (skipsTrace) and hands the GPU to the denoise. Measured
// inside a room at 1024², the same denoise is 596 ms with the loop tracing over it and ~95 ms
// without, so a still-camera timing would rule out navigation that in fact works.
//
// Taken as the MINIMUM, not the median, and reset for each move. The first refresh of a move is
// always slow — the GPU is still finishing the frame before it — and the estimate has to survive
// that, because a demoted move stops refreshing and so stops measuring: one unlucky reading used
// to pin navigation to the raw render for the rest of the session.
const DENOISE_COST_SAMPLES = 5;

// A refresh this far past the budget is not a warm-up reading, it is the wrong resolution for
// denoised navigation. Remembered until the size changes, so only the first move pays for finding
// out; anything short of it gets a second reading before navigation is given back to the raw render.
const INTERACTION_HOPELESS_FACTOR = 3;

// Consecutive refreshes that deliver nothing before the held frame is given up and the raw render
// comes back. Counted in runs, not milliseconds: the loop stops while a finished render sits on
// screen, so any clock would read a perfectly good frame as abandoned the moment it woke.
const HELD_FRAME_MAX_FAILURES = 3;

/**
 * Orchestrates all denoising, post-processing, and AI upscaling:
 *   - Real-time denoiser strategy switching (ASVGF / NRD / EdgeAware / None)
 *   - OIDN (offline denoise on render completion)
 *   - AI Upscaler
 *   - Auto-exposure coordination
 *   - Adaptive sampling coordination
 *   - Render-completion chain (denoise → upscale)
 *
 * Extracted from PathTracerApp to keep the facade slim.
 */
export class DenoisingManager extends EventDispatcher {

	/**
	 * @param {Object} params
	 * @param {import('three/webgpu').WebGPURenderer} params.renderer
	 * @param {HTMLCanvasElement}                      params.mainCanvas  - The primary rendering canvas
	 * @param {Object}                                 params.stages     - Named references to pipeline stages
	 * @param {import('../Pipeline/RenderPipeline.js').RenderPipeline} params.pipeline
	 * @param {Function}                               params.getExposure       - () => current exposure value
	 * @param {Function}                               params.getSaturation     - () => current saturation value
	 */
	constructor( { renderer, mainCanvas, stages, pipeline, getExposure, getSaturation } ) {

		super();

		this.renderer = renderer;
		this.mainCanvas = mainCanvas;
		this.upscalerCanvas = this._createUpscalerCanvas( mainCanvas );
		this.pipeline = pipeline;

		// Stage references — only used internally for orchestration
		this._stages = stages; // { pathTracer, asvgf, nrd, variance, bilateralFilter, edgeFilter, autoExposure, compositor }

		this._getExposure = getExposure;
		this._getSaturation = getSaturation;

		this.denoiser = null;
		this.upscaler = null;
		// Which model the AI upscaler runs. 'esrgan' is the ONNX chain; 'dlss' is the neural
		// super-resolution pass, which is fixed at 2x and needs a denoised source.
		this.upscalerBackend = 'esrgan';
		this._dlssUpscaler = null;
		// The neural-rendering (detail) pass is independent of the upscaler: it changes appearance,
		// not resolution, and runs last because its result cannot be read back.
		this.neuralRendering = false;
		this.neuralRenderingSettings = {};
		this._dlssNeural = null;
		this._neuralPostBusy = false;
		// The detail pass presents through WebGPU, and a canvas's context type is permanent — it
		// cannot share the 2D overlay the upscalers draw into. See `_neuralPresentCanvas()`.
		this._neuralCanvas = null;

		// The tier the finished image uses. The loaded tier is not always this one: while the
		// image is still accumulating we run a cheaper model (see previewQuality).
		this._finalQuality = DEFAULT_STATE.oidnQuality;
		// Two independent decisions. `finalDenoise` is the OIDN pass on the finished image;
		// `continuousDenoise` is OIDN as the live-view denoiser. `denoiser.enabled` means only
		// "OIDN is in use at all", which is what the aux G-buffer wiring needs.
		this.finalDenoise = DEFAULT_STATE.enableOIDN;
		this.continuousDenoise = DEFAULT_STATE.continuousDenoise;
		this.continuousDenoiseInterval = DEFAULT_STATE.continuousDenoiseInterval;
		// -Infinity, not 0: 0 reads as "denoised at time zero", which blocks the first cadence
		// denoise while performance.now() is still below the interval.
		this._lastCadenceAt = - Infinity;
		this._lastCadenceSamples = 0;
		// Consecutive refreshes that delivered nothing, for the held-frame health check.
		this._failedRefreshes = 0;
		// A final render suspends the live-view refresh without forgetting that the host chose it.
		this._cadenceSuspended = false;
		// Refresh timings from the current camera move, and whether this resolution has already
		// proved far too slow to navigate denoised.
		this._movingDenoiseMs = [];
		this._movingHopeless = false;
		// Whether this camera move is being shown denoised. Decided once per move; null between.
		this._holdWhileMoving = null;
		this._onReset = null;
		this._onPostProcessRefresh = null;

		// Resolution tracking — used for canvas restoration on reset
		this._lastRenderWidth = 0;
		this._lastRenderHeight = 0;

		// Track the current completion-chain listeners so they can be removed on re-trigger
		this._pendingStartUpscaler = null;
		this._pendingCloseDenoise = null;

		// Bound event forwarding handlers (stored for removal on re-setup / dispose)
		this._denoiserStartHandler = null;
		this._denoiserEndHandler = null;
		this._upscalerResChangedHandler = null;
		this._upscalerStartHandler = null;
		this._upscalerProgressHandler = null;
		this._upscalerEndHandler = null;

	}

	/**
	 * The one canvas the engine keeps besides the renderer's own, for the AI upscaler: it works in
	 * ordinary pixels and shows a picture larger than the render, neither of which the renderer's
	 * canvas can do. Hidden until the upscaler has something to show.
	 */
	_createUpscalerCanvas( mainCanvas ) {

		const parent = mainCanvas.parentNode;
		if ( ! parent ) return null;

		const dc = document.createElement( 'canvas' );
		dc.width = mainCanvas.width;
		dc.height = mainCanvas.height;
		dc.style.position = 'absolute';
		dc.style.inset = '0';
		dc.style.width = '100%';
		dc.style.height = '100%';
		dc.style.display = 'none';

		parent.insertBefore( dc, mainCanvas );
		return dc;

	}

	/**
	 * Updates the render resolution and propagates to denoiser/upscaler.
	 * @param {number} width
	 * @param {number} height
	 */
	setRenderSize( width, height ) {

		this._lastRenderWidth = width;
		this._lastRenderHeight = height;
		// Sticky across resets: the device does not get faster between camera moves, and
		// re-deciding per accumulation cost one slow denoise every time the camera stopped.
		// Cleared only when the tier or the resolution changes — a denoise costs 14 ms at 512²
		// and 800 ms at 2048², so the affordability verdict does not survive a resize.
		this._cadenceDowngraded = false;
		this._holdWhileMoving = null;
		this._movingDenoiseMs.length = 0;
		this._movingHopeless = false;
		// A run in flight was sized for the old resolution and setSize rebuilds the network under
		// it. Resets no longer cancel a run while its frame is on screen, so this has to.
		this.denoiser?.abort();
		// The picture on screen is the old size, and the Compositor would stretch it over the new
		// frame until a denoise lands. Back to the raw render until then.
		this._unpublishOutput();
		this.denoiser?.setSize( width, height );

		// The 2D canvas exists for the upscaler alone, and sizing it here keeps that ownership in
		// one place. Assigning width or height clears it, so only do it when it actually changed.
		if ( this.upscalerCanvas && ( this.upscalerCanvas.width !== width || this.upscalerCanvas.height !== height ) ) {

			this.upscalerCanvas.width = width;
			this.upscalerCanvas.height = height;

		}

		this.upscaler?.setBaseSize( width, height );

	}


	/**
	 * Puts the upscaler's canvas back to the render size — it leaves it two or four times larger.
	 * @returns {boolean} true if the canvas was resized
	 */
	restoreBaseResolution() {

		if ( ! this.upscalerCanvas || ! this._lastRenderWidth || ! this._lastRenderHeight ) return false;

		const wasResized = this.upscalerCanvas.width !== this._lastRenderWidth
			|| this.upscalerCanvas.height !== this._lastRenderHeight;

		if ( ! wasResized ) return false;

		this.upscalerCanvas.width = this._lastRenderWidth;
		this.upscalerCanvas.height = this._lastRenderHeight;

		return true;

	}

	/**
	 * Initialises the OIDN denoiser for the WebGPU backend.
	 */
	setupDenoiser() {

		if ( ! this.upscalerCanvas ) return;

		const pt = this._stages.pathTracer;

		// No canvas: the denoiser hands its result to the pipeline as a picture, and the
		// Compositor decides what the single canvas shows. The exposure, grade and tone curve
		// come from the renderer's own output pass, so it is not told about them either.
		this.denoiser = new OIDNDenoiser( this.renderer, {
			...DEFAULT_STATE,

			backendParams: () => ( {
				device: this.renderer.backend.device,
				adapterInfo: null
			} ),

			getGPUTextures: () => {

				if ( ! pt?.storageTextures?.readTarget ) return null;
				const readTextures = pt.storageTextures.getReadTextures();
				const { backend } = this.renderer;
				return {
					color: backend.get( readTextures.color ).texture,
					normal: backend.get( readTextures.normalDepth ).texture,
					albedo: backend.get( readTextures.albedo ).texture
				};

			},
		} );

		this._syncOIDNInUse();

		// Forward lifecycle events (store refs for removal on re-setup / dispose)
		this._denoiserStartHandler = e =>
			this.dispatchEvent( { type: EngineEvents.DENOISING_START, continuous: !! e.continuous } );
		this._denoiserEndHandler = e => {

			if ( this.denoiser?.hasOutput ) this._publishOutput();
			this.dispatchEvent( { type: EngineEvents.DENOISING_END, continuous: !! e.continuous } );

		};

		this.denoiser.addEventListener( 'start', this._denoiserStartHandler );
		this.denoiser.addEventListener( 'end', this._denoiserEndHandler );

	}

	/**
	 * Initialises the AI upscaler for post-render super-resolution.
	 */
	setupUpscaler() {

		if ( ! this.upscalerCanvas ) return;

		const pt = this._stages.pathTracer;

		this.upscaler = new AIUpscaler( this.upscalerCanvas, this.renderer, {
			scaleFactor: DEFAULT_STATE.upscalerScale || 2,
			quality: DEFAULT_STATE.upscalerQuality || 'fast',

			// One source: the render canvas shows whatever the Compositor picked — the denoised
			// picture when OIDN is on, the raw render otherwise — so the upscaler always enlarges
			// what the viewer is actually looking at. It used to read its own canvas when the
			// denoiser was on, which only worked while the denoiser painted there.
			getSourceCanvas: () => this.renderer.domElement,

			refreshInput: () => {

				const ctx = this.pipeline?.context;
				if ( this._stages.compositor && ctx ) this._stages.compositor.render( ctx );

			},

			getGPUTextures: () => {

				if ( ! pt?.storageTextures?.readTarget ) return null;
				const readTextures = pt.storageTextures.getReadTextures();
				return { color: this.renderer.backend.get( readTextures.color ).texture };

			},

			getExposure: () => this._getEffectiveExposure(),
			getToneMapping: () => this._getToneMapping(),
			getSaturation: () => this._getSaturation(),
		} );

		this.upscaler.enabled = DEFAULT_STATE.enableUpscaler || false;

		// Forward lifecycle events (store refs for removal on re-setup / dispose)
		this._upscalerResChangedHandler = ( e ) =>
			this.dispatchEvent( { type: 'resolution_changed', width: e.width, height: e.height } );
		this._upscalerStartHandler = () =>
			this.dispatchEvent( { type: EngineEvents.UPSCALING_START } );
		this._upscalerProgressHandler = ( e ) =>
			this.dispatchEvent( { type: EngineEvents.UPSCALING_PROGRESS, progress: e.progress } );
		this._upscalerEndHandler = () =>
			this.dispatchEvent( { type: EngineEvents.UPSCALING_END } );
		this.upscaler.addEventListener( 'resolution_changed', this._upscalerResChangedHandler );
		this.upscaler.addEventListener( 'start', this._upscalerStartHandler );
		this.upscaler.addEventListener( 'progress', this._upscalerProgressHandler );
		this.upscaler.addEventListener( 'end', this._upscalerEndHandler );

	}

	// ── Denoiser Strategy ─────────────────────────────────────────

	/**
	 * Active real-time denoiser, derived from stage state so it can't drift from
	 * setDenoiserStrategy / setASVGFEnabled.
	 * @returns {'asvgf'|'nrd'|'edgeaware'|'none'}
	 */
	get denoiserStrategy() {

		// OIDN refreshing the accumulating image is a live-view denoiser like the others, so it
		// belongs in the same one-of-N choice. Two of these running at once would mean paying for
		// a per-frame denoise whose result the OIDN overlay then covers.
		if ( this.continuousDenoise ) return 'oidn';
		if ( this._stages.asvgf?.enabled ) return 'asvgf';
		if ( this._stages.nrd?.enabled ) return 'nrd';
		if ( this._stages.edgeFilter?.enabled ) return 'edgeaware';
		return 'none';

	}

	/**
	 * Switches the real-time denoiser strategy.
	 * @param {string} strategy - 'none' | 'asvgf' | 'nrd' | 'edgeaware'
	 * @param {string} [preset] - quality preset for 'asvgf' (ASVGF_QUALITY_PRESETS) or 'nrd' (NRD_QUALITY_PRESETS)
	 */
	setDenoiserStrategy( strategy, preset ) {

		const s = this._stages;

		// Disable all real-time denoisers first
		if ( s.asvgf ) s.asvgf.enabled = false;
		if ( s.nrd ) s.nrd.enabled = false;
		if ( s.variance ) s.variance.enabled = false;
		if ( s.bilateralFilter ) s.bilateralFilter.enabled = false;
		if ( s.edgeFilter ) s.edgeFilter.setFilteringEnabled( false );

		this._clearDenoiserTextures();

		// Which denoiser owns the live view. Deliberately says nothing about the finished image:
		// wanting OIDN on the viewport is not the same as opting into a final pass.
		this.setContinuousDenoise( strategy === 'oidn' );

		switch ( strategy ) {

			case 'asvgf':
				s.asvgf.enabled = true;
				if ( s.variance ) s.variance.enabled = true;
				if ( s.bilateralFilter ) s.bilateralFilter.enabled = true;
				s.asvgf.setTemporalEnabled?.( true );
				this._applyASVGFPreset( preset || 'medium' );
				break;

			case 'nrd':
				if ( s.nrd ) {

					s.nrd.enabled = true;
					// Stale history from the last time it ran describes another view.
					s.nrd.resetHistory?.();
					this._applyNRDPreset( preset || 'medium' );

				}

				break;

			case 'edgeaware':
				// EdgeAware is a spatial-only SVGF à-trous — it consumes the Variance
				// stage's per-pixel variance to drive its luminance edge-stop.
				if ( s.variance ) s.variance.enabled = true;
				if ( s.edgeFilter ) s.edgeFilter.setFilteringEnabled( true );
				break;

		}

		this._syncGBufferStages();

	}

	/**
	 * Enables/disables ASVGF denoising with coordination of related stages.
	 * @param {boolean} enabled
	 * @param {string}  [qualityPreset]
	 */
	setASVGFEnabled( enabled, qualityPreset ) {

		const s = this._stages;
		if ( s.asvgf ) s.asvgf.enabled = enabled;
		if ( s.variance ) s.variance.enabled = enabled;
		if ( s.bilateralFilter ) s.bilateralFilter.enabled = enabled;

		if ( enabled ) {

			// One real-time denoiser at a time.
			if ( s.nrd ) s.nrd.enabled = false;
			s.asvgf?.setTemporalEnabled?.( true );
			this._applyASVGFPreset( qualityPreset || 'medium' );

		}

		// Coordinate with EdgeAware filtering
		if ( s.edgeFilter ) s.edgeFilter.setFilteringEnabled( ! enabled );

		this._syncGBufferStages();

	}

	/**
	 * Applies an ASVGF quality preset.
	 * @param {string} presetName - 'low' | 'medium' | 'high'
	 */
	applyASVGFPreset( presetName ) {

		this._applyASVGFPreset( presetName );

	}

	/**
	 * @param {boolean} enabled
	 * @param {number}  manualExposure - Restored to renderer.toneMappingExposure when disabling.
	 */
	setAutoExposureEnabled( enabled, manualExposure ) {

		const s = this._stages;
		if ( ! s.autoExposure ) return;

		s.autoExposure.enabled = enabled;

		// AutoExposure overwrites renderer.toneMappingExposure each frame; restore manual on disable.
		if ( ! enabled && this.renderer ) {

			this.renderer.toneMappingExposure = manualExposure;

		}

	}

	/**
	 * Gate the G-buffer stages (NormalDepth, MotionVector) on demand: they only
	 * need to run when a real-time denoiser consumes their output. Idling them
	 * otherwise skips MotionVector's per-frame compute + copies during preview
	 * navigation and frees their textures. Call after any consumer toggle.
	 *
	 * MotionVector requires NormalDepth (reads pathtracer:normalDepth) and its
	 * consumers (ASVGF, NRD) are a subset of NormalDepth's, so NormalDepth is
	 * always enabled whenever MotionVector is. Adaptive sampling / Variance / OIDN
	 * do NOT read these signals, so they don't keep the G-buffer alive.
	 */
	/** True while a strategy that reprojects through motion vectors is active. */
	get requiresMotionVectors() {

		return !! ( this._stages.asvgf?.enabled || this._stages.nrd?.enabled );

	}

	_syncGBufferStages() {

		const s = this._stages;
		const nd = s.normalDepth;
		const mv = s.motionVector;

		const motionNeeded = this.requiresMotionVectors;
		// pathtracer:normalDepth consumed by ASVGF, NRD, EdgeFilter, BilateralFilter
		const normalNeeded = motionNeeded || !! ( s.edgeFilter?.enabled || s.bilateralFilter?.enabled );

		if ( nd ) {

			// On disabled→enabled, re-arm dirty/history so the first frame recomputes
			// (not the stale static fast-path) and seeds prev = current.
			if ( normalNeeded && ! nd.enabled ) nd.reset();
			nd.enabled = normalNeeded;

		}

		if ( mv ) {

			// On re-enable, force a camera-history reseed (matricesInitialized survives
			// normal resets) so the first frame reports zero motion, not a spike.
			if ( motionNeeded && ! mv.enabled ) {

				mv.matricesInitialized = false;
				mv.isFirstFrame = true;
				mv.frameCount = 0;

			}

			mv.enabled = motionNeeded;

		}

		// PathTracer's aux MRT (normalDepth + albedo) is consumed by the real-time denoisers (ASVGF/
		// BilateralFilter read albedo; ASVGF/EdgeFilter read normalDepth) and by OIDN (reads the
		// MRT read-targets directly). When none are active the wavefront skips those writes entirely.
		s.pathTracer?.setAuxGBufferEnabled?.( normalNeeded || !! this.denoiser?.enabled );

		// Clean-aux normal: temporally accumulate the aux normal only for OIDN clean-aux models
		// (balanced/high). 'fast' and the real-time denoisers keep the point-sampled bump normal.
		// Keyed on the chosen tier, not the loaded one — the loaded tier dips to a cheaper model
		// during refreshes, and following that would restart the aux accumulation mid-render.
		s.pathTracer?.setCleanAuxNormal?.(
			!! this.denoiser?.enabled && !! this.denoiser?.expectsCleanAux( this._finalQuality )
		);

		// Reclaim VRAM: free the big 2048² StorageTextures of any denoiser/G-buffer stage that ended up
		// disabled (lazily re-created on the next dispatch after re-enable). Every strategy/denoiser
		// toggle funnels through here after the enabled flags above are settled, so this is the one
		// choke point. dispose() is idempotent, so re-running it for an already-released stage is a no-op.
		for ( const stage of [ s.asvgf, s.nrd, s.variance, s.bilateralFilter, s.edgeFilter, nd, mv ] ) {

			if ( stage && ! stage.enabled ) stage.releaseGPUMemory?.();

		}

	}

	// ── Render Completion Chain ───────────────────────────────────

	/**
	 * Called when the path tracer render is complete.
	 * Triggers the denoise → upscale chain.
	 *
	 * @param {Object} params
	 * @param {HTMLCanvasElement} params.canvas           - Main renderer canvas
	 * @param {Function}         params.isStillComplete   - () => boolean, guard for async race
	 * @param {import('../Pipeline/PipelineContext.js').PipelineContext} params.context
	 */
	_cleanupCompletionListener() {

		if ( this.denoiser ) {

			if ( this._pendingStartUpscaler ) this.denoiser.removeEventListener( 'end', this._pendingStartUpscaler );
			if ( this._pendingCloseDenoise ) this.denoiser.removeEventListener( 'end', this._pendingCloseDenoise );

		}

		this._pendingStartUpscaler = null;
		this._pendingCloseDenoise = null;

	}

	/**
	 * Whether the view is moving and the denoiser is quick enough to be that view — in which case the
	 * raw render is never shown and every reset keeps the last denoised frame up.
	 *
	 * Decided once per move rather than per frame, which would flip the viewport between clean and
	 * noisy mid-drag. Nothing is known at the first move of a size, so it tries once and then knows.
	 * Demotion is the exception: a move that turns out to be a slideshow gives the view back rather
	 * than finishing at 1.5 refreshes a second.
	 */
	get holdsWhileMoving() {

		if ( ! this._stages.pathTracer?.viewIsChanging ) return false;
		if ( ! this.continuousDenoise || this._cadenceSuspended || ! this.denoiser?.enabled ) return false;
		if ( this._movingHopeless ) return false;

		const best = this.movingCostMs;
		const seen = this._movingDenoiseMs.length;

		if ( best > INTERACTION_HOLD_BUDGET_MS * INTERACTION_HOPELESS_FACTOR ) this._movingHopeless = true;

		// One reading is a warm-up; two that are both over budget are the answer.
		const affordable = ! this._movingHopeless && ( seen < 2 || best <= INTERACTION_HOLD_BUDGET_MS );
		this._holdWhileMoving = this._holdWhileMoving === null ? affordable : this._holdWhileMoving && affordable;

		return this._holdWhileMoving;

	}

	/**
	 * Whether the render loop should leave this frame untraced. True only while the denoised frame
	 * is the live view and a denoise is running — the one case where a traced frame reaches nobody:
	 * accumulation is off while the camera moves, the canvas is hidden, and the next denoise reads
	 * whatever the newest frame is. Measured inside a room at 512²: 19 -> 32 refreshes/sec.
	 */
	skipsTrace() {

		return this.holdsWhileMoving && !! this.denoiser?.state.isDenoising;

	}

	// The best a refresh has managed during this camera move. Zero until one has been timed, which
	// reads as free and buys a first attempt rather than a verdict from the wrong regime.
	get movingCostMs() {

		return this._movingDenoiseMs.length ? Math.min( ...this._movingDenoiseMs ) : 0;

	}

	/**
	 * Hands the denoised picture to the pipeline. The Compositor prefers it over the raw render
	 * from the next frame on, and keeps drawing it until it is taken away again — which is what
	 * makes "hold the last clean frame" free rather than a rule.
	 */
	_publishOutput() {

		const ctx = this.pipeline?.context;
		const tex = this.denoiser?.outputTexture;
		if ( ctx && tex ) ctx.setTexture( 'oidn:output', tex );

	}

	// Gives the viewport back to the raw render.
	_unpublishOutput() {

		this.pipeline?.context?.removeTexture( 'oidn:output' );
		this.denoiser?.invalidateOutput();

	}

	// A picture the denoiser has stopped replacing describes a view that is long gone, so the raw
	// render takes the viewport back until a refresh delivers again.
	_checkHeldFrameHealthy() {

		if ( ! this.denoiser?.hasOutput || this._failedRefreshes < HELD_FRAME_MAX_FAILURES ) return;

		this._unpublishOutput();

	}

	/**
	 * Denoises the accumulating mean on a cadence, so a preview shows a clean image while it
	 * refines instead of only once it finishes. Driven from the render loop; call every frame.
	 *
	 * @param {number} sampleCount - accumulated samples (PathTracer.frameCount)
	 * @returns {boolean} whether a denoise was started this call
	 */
	tickContinuousDenoise( sampleCount ) {

		const dn = this.denoiser;
		if ( ! this.continuousDenoise || this._cadenceSuspended || ! dn ) return false;

		this._checkHeldFrameHealthy();

		// Moving with a denoise too slow to follow: the raw render owns the view, and a refresh
		// would only paint a stale clean frame over a moving one.
		const interacting = !! this._stages.pathTracer?.viewIsChanging;
		if ( ! interacting ) {

			this._holdWhileMoving = null;
			this._movingDenoiseMs.length = 0;

		} else if ( ! this.holdsWhileMoving ) return false;

		if ( dn.state.isDenoising || dn.state.isLoading ) return false;

		// frameCount is frozen while the camera moves — those frames are 1-SPP feedback and do not
		// count toward completion — so this gate would refuse every tick. The clock governs there.
		if ( ! interacting && sampleCount <= this._lastCadenceSamples ) return false;

		const now = performance.now();
		// `continuousDenoiseInterval` is only the floor's lower bound: on a cheap denoise it is
		// what binds, and past ~1024² the denoise's own cost is.
		const periods = interacting ? CADENCE_INTERACTION_PERIODS
			: this._lastCadenceSamples === 0 ? CADENCE_FIRST_REFRESH_PERIODS : CADENCE_DENOISE_PERIODS;
		const minGap = Math.max( this.continuousDenoiseInterval, dn.lastDenoiseMs * periods );
		if ( now - this._lastCadenceAt < minGap ) return false;

		this._lastCadenceAt = now;
		this._lastCadenceSamples = sampleCount;

		// A tier too slow to be a live view refreshes with a cheaper model and is put back for the
		// finished image. One-way: letting it flip back would reload weights on every tick.
		if ( dn.lastDenoiseMs > CADENCE_COST_BUDGET_MS ) this._cadenceDowngraded = true;

		// updateQuality flags the load synchronously, and start() below defers itself until the
		// weights land.
		const want = this._cadenceDowngraded ? this.previewQuality() : this._finalQuality;
		if ( dn.quality !== want ) dn.updateQuality( want );

		dn.start( { continuous: true } ).then( ok => {

			this._failedRefreshes = ok ? 0 : this._failedRefreshes + 1;
			if ( ! ok || ! interacting ) return;

			this._movingDenoiseMs.push( dn.lastDenoiseMs );
			if ( this._movingDenoiseMs.length > DENOISE_COST_SAMPLES ) this._movingDenoiseMs.shift();

		} );

		return true;

	}

	/**
	 * The tier used for refreshes while the image is still accumulating: the cheapest model that
	 * reads the same kind of aux buffer as the final one.
	 *
	 * Matching the aux kind is not optional. `setCleanAuxNormal()` throws away the accumulated
	 * albedo/normal, so if the refreshes and the final denoise disagreed about it, the final
	 * denoise would run against an aux buffer one sample deep.
	 */
	previewQuality() {

		return this.denoiser?.expectsCleanAux( this._finalQuality ) ? 'fast-clean' : 'fast';

	}

	/**
	 * Stops the live-view refresh for the duration of a final render, without changing what the
	 * host picked in the denoiser list. A final render shows the accumulation and denoises once at
	 * the end, so refreshing through it spends samples on frames nobody keeps — and a refresh
	 * landing while the renderer resizes itself on the way in raced its output pass, which the
	 * device reported as a write to a destroyed buffer.
	 *
	 * @param {boolean} suspended
	 */
	setCadenceSuspended( suspended ) {

		this._cadenceSuspended = !! suspended;
		if ( ! this._cadenceSuspended ) return;

		// The accumulation is what a final render shows; a held preview frame would otherwise sit
		// over it until the render finished.
		this.denoiser?.abort();
		this._unpublishOutput();

	}

	setContinuousDenoise( enabled ) {

		this.continuousDenoise = !! enabled;
		this._syncOIDNInUse();
		this._lastCadenceAt = - Infinity;
		this._resetCadence();

	}

	// Puts the finished image back on the tier the user asked for, after the refreshes ran a
	// cheaper one. A no-op when they match, which is the common case in preview.
	_useFinalQuality() {

		const dn = this.denoiser;
		if ( dn && dn.quality !== this._finalQuality ) dn.updateQuality( this._finalQuality );

	}

	// Only the sample gate resets, so a fresh accumulation denoises promptly. The clock is
	// deliberately kept: reset() runs every frame of a camera drag, and rearming it there
	// would spend a denoise per frame on views that are already stale.
	_resetCadence() {

		this._lastCadenceSamples = 0;

	}

	/**
	 * Selects the AI upscaler's model. 'dlss' is fixed at 2x and reads the denoised picture, so it
	 * is a no-op without a denoiser — feeding it raw Monte-Carlo noise measurably loses to bilinear.
	 *
	 * @param {'esrgan'|'dlss'} backend
	 */
	setUpscalerBackend( backend ) {

		const next = backend === 'dlss' ? 'dlss' : 'esrgan';
		if ( next === this.upscalerBackend ) return;

		this.upscalerBackend = next;
		// Whatever is on screen came from the model being switched away from.
		this._restoreRenderDisplay();
		if ( next !== 'dlss' ) this._releaseDLSSUpscaler();

	}

	/**
	 * Puts the render canvas back in front and tells the host the output is the render size again.
	 *
	 * Guarded on the overlay actually being visible: `abort()` runs on every reset, which is every
	 * frame of a camera drag, and an unguarded event there would be a per-frame storm.
	 *
	 * @returns {boolean} whether anything was actually restored
	 */
	_restoreRenderDisplay() {

		const wasShowing = ( this.upscalerCanvas && this.upscalerCanvas.style.display !== 'none' )
			|| ( this._neuralCanvas && this._neuralCanvas.style.display !== 'none' );

		if ( this.upscalerCanvas ) this.upscalerCanvas.style.display = 'none';
		if ( this._neuralCanvas ) this._neuralCanvas.style.display = 'none';
		if ( this.mainCanvas ) this.mainCanvas.style.opacity = '1';

		if ( wasShowing ) {

			const stage = this._stages?.pathTracer;
			if ( stage?.width && stage?.height ) {

				this.dispatchEvent( { type: 'resolution_changed', width: stage.width, height: stage.height } );

			}

		}

		return !! wasShowing;

	}

	_releaseDLSSUpscaler() {

		this._dlssUpscaler?.dispose();
		this._dlssUpscaler = null;

	}

	/** Turns the neural-rendering (detail) pass on or off, and sets its appearance controls. */
	setNeuralRendering( enabled, settings = null ) {

		this.neuralRendering = !! enabled;
		if ( settings ) this.neuralRenderingSettings = { ...this.neuralRenderingSettings, ...settings };
		if ( ! this.neuralRendering ) {

			this._releaseDLSSNeural();
			this._restoreRenderDisplay();

		}

	}

	_releaseDLSSNeural() {

		this._dlssNeural?.dispose();
		this._dlssNeural = null;

	}

	/**
	 * A second overlay, for the detail pass alone.
	 *
	 * `getContext()` binds a canvas to one context type for its lifetime, so a canvas that has ever
	 * handed out a 2D context can never acquire WebGPU — it returns null and the runtime throws
	 * "The DLSS-NR output canvas could not acquire WebGPU". The upscalers draw in 2D, this pass
	 * presents in WebGPU, so they cannot share one.
	 */
	_neuralPresentCanvas() {

		if ( this._neuralCanvas ) return this._neuralCanvas;

		const parent = this.mainCanvas?.parentNode;
		if ( ! parent ) return null;

		const dc = document.createElement( 'canvas' );
		dc.style.position = 'absolute';
		dc.style.inset = '0';
		dc.style.width = '100%';
		dc.style.height = '100%';
		dc.style.display = 'none';
		parent.insertBefore( dc, this.mainCanvas );

		this._neuralCanvas = dc;
		return dc;

	}

	/**
	 * The neural post-chain over the picture the closing denoise just produced: super resolution
	 * first, then the detail pass, either or both.
	 *
	 * Order is forced by the models. Super resolution hands back a linear image that can be fed
	 * onward; the detail pass writes an `rgba8unorm` texture with no `COPY_SRC`, so nothing can read
	 * its result and it has to be last — and it presents in its own display space rather than the
	 * engine's tone curve.
	 *
	 * Deliberately fire-and-forget: the render is already finished and a failure must not break it.
	 */
	async _runNeuralPost( isStillComplete ) {

		const wantSR = this.upscaler?.enabled && this.upscalerBackend === 'dlss';
		const wantNR = this.neuralRendering;
		if ( ! wantSR && ! wantNR ) return;

		// A second completion can land while the first pass is still in flight — the models are
		// created lazily and reused through fields, so two runs would race over the same handles.
		if ( this._neuralPostBusy ) return;

		if ( ! this.upscalerCanvas ) {

			console.warn( 'DLSS neural pass skipped: the engine has no overlay canvas to present on' );
			return;

		}

		if ( wantNR && ! this._neuralPresentCanvas() ) {

			console.warn( 'DLSS neural pass skipped: no parent to attach its WebGPU canvas to' );
			return;

		}

		if ( ! this.pipeline?.context?.getTexture( 'oidn:output' ) ) {

			console.warn( 'DLSS neural pass skipped: no denoised picture — it needs OIDN' );
			return;

		}

		this._neuralPostBusy = true;
		this.dispatchEvent( { type: EngineEvents.UPSCALING_START } );

		try {

			const sr = await import( '../dlss/DLSSSuperRes.js' );
			let image = await sr.readDenoisedLinear( this.denoiser );

			if ( wantSR ) {

				if ( this._dlssUpscaler
					&& ( this._dlssUpscaler.inputWidth !== image.width || this._dlssUpscaler.inputHeight !== image.height ) ) {

					this._releaseDLSSUpscaler();

				}

				if ( ! this._dlssUpscaler ) {

					this._dlssUpscaler = await sr.DLSSSuperRes.create( { width: image.width, height: image.height } );

				}

				image = await this._dlssUpscaler.upscale( image );

			}

			if ( ! isStillComplete() ) {

				this.dropDisplay();
				return;

			}

			// Must be the effective value, not the settings one: AutoExposure overwrites
			// `renderer.toneMappingExposure` every frame and never touches settings, so reading
			// settings — as this did — silently ignores auto-exposure. Same helper OIDN uses.
			const exposure = this._getEffectiveExposure();

			if ( wantNR ) {

				// The detail pass presents through a plain blit and has no display controls, so the
				// engine's curve and saturation have to be baked into what it receives or they are
				// lost. Exposure is already inside that, hence 1 below.
				const display = sr.toneMappedLinear( image, {
					exposure,
					toneMapping: this._getToneMapping(),
					saturation: this._getSaturation?.() ?? 1,
				} );

				const { enhanceLinearFrame } = await import( '../dlss/DLSSNeural.js' );
				const result = await enhanceLinearFrame( {
					source: display,
					canvas: this._neuralPresentCanvas(),
					settings: this.neuralRenderingSettings,
					instance: this._dlssNeural,
					exposure: 1,
				} );
				this._dlssNeural = result.instance;
				// Only one overlay may be up, and this pass owns the other one.
				this.upscalerCanvas.style.display = 'none';

			} else {

				sr.presentLinear( this.upscalerCanvas, image, {
					exposure,
					toneMapping: this._getToneMapping(),
					saturation: this._getSaturation?.() ?? 1,
				} );
				if ( this._neuralCanvas ) this._neuralCanvas.style.display = 'none';

			}

			if ( ! isStillComplete() ) {

				this.dropDisplay();
				return;

			}

			// The 2D canvas sits BEHIND the render canvas in the DOM (`insertBefore`), so making it
			// `display:block` is not enough — the render canvas has to get out of the way. This is
			// what `AIUpscaler._revealOutput` does for the other backend, and `abort()` already
			// restores both sides.
			if ( this.mainCanvas ) this.mainCanvas.style.opacity = '0';

			// The host shows the output dimensions; without this they keep reading the render size.
			this.dispatchEvent( { type: 'resolution_changed', width: image.width, height: image.height } );

		} catch ( error ) {

			console.warn( 'DLSS neural pass failed', error );

		} finally {

			this._neuralPostBusy = false;
			this.dispatchEvent( { type: EngineEvents.UPSCALING_END } );

		}

	}

	onRenderComplete( { isStillComplete, context } ) {

		// Remove any stale completion-chain listener from a previous render cycle
		this._cleanupCompletionListener();

		// What closes the render, if anything. A full pass at the chosen tier when that switch is
		// on; otherwise, if OIDN owns the live view, one last cheap refresh — the cadence's last
		// tick lands a few samples short, and the picture should match the render that finished.
		const closing = this.finalDenoise ? 'final' : this.continuousDenoise ? 'refresh' : null;

		// Registered only once the closing denoise has been launched, so the next 'end' is
		// unambiguously that one — a cadence run's end can look identical otherwise.
		const startUpscaler = () => {

			this.denoiser?.removeEventListener( 'end', startUpscaler );
			this._pendingStartUpscaler = null;

			if ( ! isStillComplete() ) return;

			// One owner of the overlay canvas, so the neural chain and the ONNX upscaler are
			// exclusive. The neural chain also runs on its own when only its detail pass is on.
			if ( this.neuralRendering || ( this.upscaler?.enabled && this.upscalerBackend === 'dlss' ) ) {

				this._runNeuralPost( isStillComplete );
				return;

			}

			if ( this.upscaler?.enabled ) this.upscaler.start();

		};

		if ( ! closing ) {

			startUpscaler();
			return;

		}

		const launchClosing = () => {

			if ( ! isStillComplete() ) return;

			this._pendingStartUpscaler = startUpscaler;
			this.denoiser.addEventListener( 'end', startUpscaler );

			if ( closing === 'final' ) {

				this._useFinalQuality();
				this.denoiser.start();

			} else {

				// Whatever model the refreshes have been using — no reload for a picture the user
				// never asked to be denoised at full quality.
				this.denoiser.start( { continuous: true } );

			}

		};

		this._resetCadence();

		if ( this.denoiser.state.isDenoising ) {

			// A cadence run is mid-flight against a lower sample count. Let it finish first —
			// start() would be refused right now.
			// three.js EventDispatcher.addEventListener takes (type, listener) and silently
			// ignores an options object, so a listener that restarts the denoiser MUST remove
			// itself: `{ once: true }` here re-fired on its own end, forever.
			const onCadenceEnd = () => {

				this.denoiser?.removeEventListener( 'end', onCadenceEnd );
				if ( this._pendingCloseDenoise === onCadenceEnd ) this._pendingCloseDenoise = null;
				launchClosing();

			};

			this._pendingCloseDenoise = onCadenceEnd;
			this.denoiser.addEventListener( 'end', onCadenceEnd );

		} else {

			launchClosing();

		}

	}

	/**
	 * Aborts any in-progress denoising/upscaling (called on reset).
	 *
	 * @param {HTMLCanvasElement} mainCanvas
	 * @param {Object}  [options]
	 * @param {boolean} [options.keepDisplay] - The viewpoint did not move, so the frame already on
	 *   screen still describes this view. It stays up until the next denoise replaces it, instead
	 *   of dropping back to the raw render for one denoise. Ignored unless OIDN owns the live view:
	 *   nothing else would ever replace the held frame.
	 */
	abort( mainCanvas, { keepDisplay = false } = {} ) {

		// Remove stale completion-chain listener before aborting
		this._cleanupCompletionListener();

		// The 2D canvas is the upscaler's alone: a reset means its enlarged result no longer
		// describes anything, so the render canvas comes back.
		this._restoreRenderDisplay();
		if ( mainCanvas && mainCanvas !== this.mainCanvas ) mainCanvas.style.opacity = '1';
		if ( this.upscaler ) this.upscaler.abort();

		const moving = !! this._stages.pathTracer?.viewIsChanging;
		const hold = keepDisplay && this.continuousDenoise && ! this._cadenceSuspended && !! this.denoiser?.hasOutput
			&& ( ! moving || this.holdsWhileMoving );

		if ( this.denoiser && ! hold ) {

			// A held picture means the run in flight is the frame that replaces what is on screen.
			// Cancelling it every time reset() runs — which is every frame of a camera drag — means
			// none of them ever lands.
			if ( this.denoiser.enabled ) this.denoiser.abort();
			this._unpublishOutput();

		}

		this._resetCadence();

	}

	/**
	 * Takes the denoised frame off screen and throws it away. For a change that makes the frame
	 * wrong rather than stale — the scene it describes is gone — where holding it would leave the
	 * previous model on screen over an empty or half-built one.
	 */
	dropDisplay() {

		this._unpublishOutput();
		this._restoreRenderDisplay();

	}

	dispose() {

		// Remove pending completion-chain listener
		this._cleanupCompletionListener();
		// Owns a second GPUDevice plus 3 MB of weights, so it must not outlive the manager.
		this._releaseDLSSUpscaler();
		this._releaseDLSSNeural();
		this._neuralCanvas?.remove();
		this._neuralCanvas = null;

		// Before the denoiser destroys the picture the Compositor would otherwise still sample.
		this._unpublishOutput();

		if ( this.denoiser ) {

			if ( this._denoiserStartHandler ) this.denoiser.removeEventListener( 'start', this._denoiserStartHandler );
			if ( this._denoiserEndHandler ) this.denoiser.removeEventListener( 'end', this._denoiserEndHandler );
			this.denoiser.dispose();
			this.denoiser = null;

		}

		if ( this.upscaler ) {

			if ( this._upscalerResChangedHandler ) this.upscaler.removeEventListener( 'resolution_changed', this._upscalerResChangedHandler );
			if ( this._upscalerStartHandler ) this.upscaler.removeEventListener( 'start', this._upscalerStartHandler );
			if ( this._upscalerProgressHandler ) this.upscaler.removeEventListener( 'progress', this._upscalerProgressHandler );
			if ( this._upscalerEndHandler ) this.upscaler.removeEventListener( 'end', this._upscalerEndHandler );
			this.upscaler.dispose();
			this.upscaler = null;
			// Which model the AI upscaler runs. 'esrgan' is the ONNX chain; 'dlss' is the neural
			// super-resolution pass, which is fixed at 2x and needs a denoised source.
			this.upscalerBackend = 'esrgan';
			this._dlssUpscaler = null;

		}

		this._denoiserStartHandler = null;
		this._denoiserEndHandler = null;
		this._upscalerResChangedHandler = null;
		this._upscalerStartHandler = null;
		this._upscalerProgressHandler = null;
		this._upscalerEndHandler = null;

		if ( this.upscalerCanvas?.parentNode ) {

			this.upscalerCanvas.parentNode.removeChild( this.upscalerCanvas );
			this.upscalerCanvas = null;

		}

	}

	// ── Injected Dependencies (set after construction) ───────────

	/** @param {import('./OverlayManager.js').OverlayManager} overlayManager */
	setOverlayManager( overlayManager ) {

		this._overlayManager = overlayManager;

	}

	/** @param {Function} fn - () => void, triggers accumulation reset */
	setResetCallback( fn ) {

		this._onReset = fn;

	}

	/** @param {Function} fn - () => void, re-runs the completion chain on the accumulated image */
	setPostProcessRefreshCallback( fn ) {

		this._onPostProcessRefresh = fn;

	}

	/** @param {import('../RenderSettings.js').RenderSettings} settings */
	setSettings( settings ) {

		this._settings = settings;

	}

	// ── Stage Parameter Forwarding ───────────────────────────────
	// These methods match the DenoisingAPI surface so call sites need
	// zero or minimal changes after facade removal.

	/** Updates ASVGF stage parameters. */
	setASVGFParams( params ) {

		this._stages.asvgf?.updateParameters( params );

	}

	/**
	 * Toggle the ASVGF heatmap compute pass. When enabled, the stage writes
	 * the heatmap to its public `heatmapTarget` RenderTarget — the host is
	 * responsible for rendering it.
	 */
	toggleASVGFHeatmap( enabled ) {

		this._stages.asvgf?.setHeatmapEnabled?.( enabled );

	}

	/**
	 * Configures ASVGF for a specific render mode (multi-stage coordination).
	 * @param {Object} config - { enabled, temporalAlpha, atrousIterations, ... }
	 */
	configureASVGFForMode( config ) {

		if ( ! this._stages.asvgf ) return;

		this._stages.asvgf.enabled = config.enabled;
		if ( this._stages.variance ) this._stages.variance.enabled = config.enabled;
		if ( this._stages.bilateralFilter ) this._stages.bilateralFilter.enabled = config.enabled;

		if ( config.enabled ) {

			this._stages.asvgf.updateParameters( config );

		}

		this._syncGBufferStages();

	}

	/** Updates edge-aware filtering parameters. */
	setEdgeAwareParams( params ) {

		this._stages.edgeFilter?.updateUniforms( params );

	}

	/** Updates auto-exposure stage parameters. */
	setAutoExposureParams( params ) {

		this._stages.autoExposure?.updateParameters( params );

	}

	// ── OIDN ─────────────────────────────────────────────────────

	/** Enables or disables Intel OIDN denoiser. */
	/**
	 * Records the final-pass decision and syncs `enabled`. No host refresh — for callers like
	 * configureForMode that drive the whole change themselves.
	 */
	applyOIDNEnabled( enabled ) {

		this.finalDenoise = !! enabled;
		this._syncOIDNInUse();

	}

	/** The tier the finished image uses — not `denoiser.quality`, which dips during refreshes. */
	get oidnQuality() {

		return this._finalQuality;

	}

	/** Denoise the finished image with OIDN. Independent of which denoiser owns the live view. */
	setOIDNEnabled( enabled ) {

		this.applyOIDNEnabled( enabled );
		// OIDN reads the PathTracer aux MRT; re-sync so the wavefront produces it while OIDN is on.
		this._syncGBufferStages();
		this._onPostProcessRefresh?.();

	}

	// `enabled` on the denoiser is the union of its two jobs — everything downstream (the aux MRT,
	// VRAM retention) only needs to know whether OIDN runs at all.
	_syncOIDNInUse() {

		if ( this.denoiser ) this.denoiser.enabled = this.finalDenoise || this.continuousDenoise;

	}

	/**
	 * Records the tier the finished image should use, and loads it. No host refresh — for callers
	 * like configureForMode that drive the whole tier change themselves.
	 */
	applyOIDNQuality( quality ) {

		this._finalQuality = quality;
		this._cadenceDowngraded = false;
		this.denoiser?.updateQuality( quality );

	}

	setOIDNQuality( quality ) {

		this.applyOIDNQuality( quality );
		// _syncGBufferStages owns the clean-aux decision (it follows the model, not the tier name —
		// see OIDNDenoiser.QUALITY_MODELS). Inlining a second copy here let the two disagree.
		this._syncGBufferStages();
		this._onPostProcessRefresh?.();

	}

	/** Enables or disables the denoise/upscale progress overlay. */
	setTileHelperEnabled( enabled ) {

		this._setTileHelper( enabled );

	}

	// ── AI Upscaler ──────────────────────────────────────────────

	/** Enables or disables the AI upscaler. */
	setUpscalerEnabled( enabled ) {

		if ( this.upscaler ) this.upscaler.enabled = enabled;
		// The enlarged picture describes a setting that is no longer on.
		if ( ! enabled ) this._restoreRenderDisplay();

	}

	/** Sets the upscaler scale factor. */
	setUpscalerScaleFactor( factor ) {

		this.upscaler?.setScaleFactor( factor );

	}

	/** Sets the upscaler quality level. */
	setUpscalerQuality( quality ) {

		this.upscaler?.setQuality( quality );

	}

	// ── Convenience (match DenoisingAPI names with reset) ────────

	/**
	 * Enables or disables auto-exposure (convenience wrapper).
	 * @param {boolean} enabled
	 */
	setAutoExposure( enabled ) {

		this.setAutoExposureEnabled( enabled, this._getExposure() );
		this._onReset?.();

	}

	/**
	 * Switches strategy with automatic reset (convenience wrapper).
	 * @param {'none'|'asvgf'|'nrd'|'edgeaware'} strategy
	 * @param {string} [preset]
	 */
	setStrategy( strategy, preset ) {

		this.setDenoiserStrategy( strategy, preset );
		this._onReset?.();

	}

	// ── NRD (ReBLUR) ─────────────────────────────────────────────

	/** Updates NRD stage parameters (nrd::ReblurSettings names, see NRD_DEFAULTS). */
	setNRDParams( params ) {

		this._stages.nrd?.updateParameters( params );

	}

	/**
	 * Applies an NRD quality preset.
	 * @param {string} presetName - 'low' | 'medium' | 'high'
	 */
	applyNRDPreset( presetName ) {

		this._applyNRDPreset( presetName );

	}

	/** Selects the NRD debug view (0 = beauty; see NRD.js for the others). */
	setNRDDebugMode( mode ) {

		this._stages.nrd?.updateParameters( { debugMode: mode } );

	}

	// ── Private ───────────────────────────────────────────────────

	_setTileHelper( enabled ) {

		const tileHelper = this._overlayManager?.getHelper( 'tiles' );
		if ( tileHelper ) {

			tileHelper.enabled = enabled;
			if ( ! enabled ) tileHelper.hide();

		}

	}

	_getEffectiveExposure() {

		return this._stages.autoExposure?.enabled
			? this.renderer.toneMappingExposure
			: this._getExposure();

	}

	_getToneMapping() {

		return this.renderer.toneMapping;

	}

	_clearDenoiserTextures() {

		const ctx = this.pipeline?.context;
		if ( ! ctx ) return;

		const keys = [
			'asvgf:output', 'asvgf:demodulated', 'asvgf:gradient',
			'variance:output', 'bilateralFiltering:output',
			'edgeFiltering:output', 'nrd:output', 'oidn:output',
		];
		keys.forEach( k => ctx.removeTexture( k ) );

	}

	_applyNRDPreset( presetName ) {

		const preset = NRD_QUALITY_PRESETS[ presetName ];
		if ( ! preset ) return;

		const params = {};
		for ( const key of NRD_PRESET_KEYS ) params[ key ] = NRD_DEFAULTS[ key ];
		this._stages.nrd?.updateParameters( { ...params, ...preset } );

	}

	_applyASVGFPreset( presetName ) {

		const preset = ASVGF_QUALITY_PRESETS[ presetName ];
		if ( ! preset ) return;
		// ASVGF consumes temporalAlpha / gradientStrength / maxAccumFrames.
		// BilateralFilter consumes phi* edge-stopping params and atrousIterations.
		// Variance consumes varianceBoost. Each stage cherry-picks what it needs.
		this._stages.asvgf?.updateParameters( preset );
		this._stages.bilateralFilter?.updateParameters( preset );
		if ( this._stages.variance && preset.varianceBoost !== undefined ) {

			this._stages.variance.varianceBoost.value = preset.varianceBoost;

		}

	}

}
