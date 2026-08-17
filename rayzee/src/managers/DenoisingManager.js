import { EventDispatcher } from 'three';
import { OIDNDenoiser } from '../Passes/OIDNDenoiser.js';
import { AIUpscaler } from '../Passes/AIUpscaler.js';
import { EngineEvents } from '../EngineEvents.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE, ASVGF_QUALITY_PRESETS } from '../EngineDefaults.js';

/**
 * Orchestrates all denoising, post-processing, and AI upscaling:
 *   - Real-time denoiser strategy switching (ASVGF / EdgeAware / None)
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
	 * @param {import('three').Scene}                  params.scene
	 * @param {import('three').PerspectiveCamera}      params.camera
	 * @param {Object}                                 params.stages     - Named references to pipeline stages
	 * @param {import('../Pipeline/RenderPipeline.js').RenderPipeline} params.pipeline
	 * @param {Function}                               params.getExposure       - () => current exposure value
	 * @param {Function}                               params.getSaturation     - () => current saturation value
	 * @param {Function}                               params.getTransparentBg  - () => boolean
	 */
	constructor( { renderer, mainCanvas, scene, camera, stages, pipeline, getExposure, getSaturation, getTransparentBg } ) {

		super();

		this.renderer = renderer;
		this.mainCanvas = mainCanvas;
		this.denoiserCanvas = this._createDenoiserCanvas( mainCanvas );
		this.scene = scene;
		this.camera = camera;
		this.pipeline = pipeline;

		// Stage references — only used internally for orchestration
		this._stages = stages; // { pathTracer, asvgf, variance, bilateralFilter, edgeFilter, autoExposure, compositor }

		this._getExposure = getExposure;
		this._getSaturation = getSaturation;
		this._getTransparentBg = getTransparentBg;

		this.denoiser = null;
		this.upscaler = null;

		this._onReset = null;
		this._onPostProcessRefresh = null;

		// Resolution tracking — used for canvas restoration on reset
		this._lastRenderWidth = 0;
		this._lastRenderHeight = 0;

		// Track the current completion-chain listener so it can be removed on re-trigger
		this._pendingStartUpscaler = null;

		// Bound event forwarding handlers (stored for removal on re-setup / dispose)
		this._denoiserStartHandler = null;
		this._denoiserEndHandler = null;
		this._upscalerResChangedHandler = null;
		this._upscalerStartHandler = null;
		this._upscalerProgressHandler = null;
		this._upscalerEndHandler = null;

	}

	_createDenoiserCanvas( mainCanvas ) {

		const parent = mainCanvas.parentNode;
		if ( ! parent ) return null;

		const dc = document.createElement( 'canvas' );
		dc.width = mainCanvas.width;
		dc.height = mainCanvas.height;
		dc.style.position = 'absolute';
		dc.style.inset = '0';
		dc.style.width = '100%';
		dc.style.height = '100%';

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
		this.denoiser?.setSize( width, height );
		this.upscaler?.setBaseSize( width, height );

	}


	/**
	 * Restores the denoiser canvas to base render resolution after upscaling.
	 * @returns {boolean} true if the canvas was resized
	 */
	restoreBaseResolution() {

		if ( ! this.denoiserCanvas || ! this._lastRenderWidth || ! this._lastRenderHeight ) return false;

		const wasResized = this.denoiserCanvas.width !== this._lastRenderWidth
			|| this.denoiserCanvas.height !== this._lastRenderHeight;

		this.denoiserCanvas.width = this._lastRenderWidth;
		this.denoiserCanvas.height = this._lastRenderHeight;

		return wasResized;

	}

	/**
	 * Initialises the OIDN denoiser for the WebGPU backend.
	 */
	setupDenoiser() {

		if ( ! this.denoiserCanvas ) return;

		const pt = this._stages.pathTracer;

		this.denoiser = new OIDNDenoiser( this.denoiserCanvas, this.renderer, this.scene, this.camera, {
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

			getExposure: () => this._getEffectiveExposure(),
			getToneMapping: () => this._getToneMapping(),
			getSaturation: () => this._getSaturation(),
			getTransparentBackground: () => this._getTransparentBg(),
			getMRTRenderTarget: () => pt?.storageTextures?.readTarget ?? null,
		} );

		this.denoiser.enabled = DEFAULT_STATE.enableOIDN;

		// Forward lifecycle events (store refs for removal on re-setup / dispose)
		this._denoiserStartHandler = () =>
			this.dispatchEvent( { type: EngineEvents.DENOISING_START } );
		this._denoiserEndHandler = () =>
			this.dispatchEvent( { type: EngineEvents.DENOISING_END } );
		this.denoiser.addEventListener( 'start', this._denoiserStartHandler );
		this.denoiser.addEventListener( 'end', this._denoiserEndHandler );

	}

	/**
	 * Initialises the AI upscaler for post-render super-resolution.
	 */
	setupUpscaler() {

		if ( ! this.denoiserCanvas ) return;

		const pt = this._stages.pathTracer;

		this.upscaler = new AIUpscaler( this.denoiserCanvas, this.renderer, {
			scaleFactor: DEFAULT_STATE.upscalerScale || 2,
			quality: DEFAULT_STATE.upscalerQuality || 'fast',

			getSourceCanvas: () => {

				if ( this.denoiser?.enabled ) return null;
				return this.renderer.domElement;

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
	 * Switches the real-time denoiser strategy.
	 * @param {string} strategy   - 'none' | 'asvgf' | 'edgeaware'
	 * @param {string} [asvgfPreset] - ASVGF quality preset when strategy is 'asvgf'
	 */
	/**
	 * Active real-time denoiser, derived from stage state so it can't drift from
	 * setDenoiserStrategy / setASVGFEnabled.
	 * @returns {'asvgf'|'edgeaware'|'none'}
	 */
	get denoiserStrategy() {

		if ( this._stages.asvgf?.enabled ) return 'asvgf';
		if ( this._stages.edgeFilter?.enabled ) return 'edgeaware';
		return 'none';

	}

	setDenoiserStrategy( strategy, asvgfPreset ) {

		const s = this._stages;

		// Disable all real-time denoisers first
		if ( s.asvgf ) s.asvgf.enabled = false;
		if ( s.variance ) s.variance.enabled = false;
		if ( s.bilateralFilter ) s.bilateralFilter.enabled = false;
		if ( s.edgeFilter ) s.edgeFilter.setFilteringEnabled( false );

		this._clearDenoiserTextures();

		switch ( strategy ) {

			case 'asvgf':
				s.asvgf.enabled = true;
				if ( s.variance ) s.variance.enabled = true;
				if ( s.bilateralFilter ) s.bilateralFilter.enabled = true;
				s.asvgf.setTemporalEnabled?.( true );
				this._applyASVGFPreset( asvgfPreset || 'medium' );
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
	 * consumers (ASVGF) are a subset of NormalDepth's, so NormalDepth is
	 * always enabled whenever MotionVector is. Adaptive sampling / Variance / OIDN
	 * do NOT read these signals, so they don't keep the G-buffer alive.
	 */
	_syncGBufferStages() {

		const s = this._stages;
		const nd = s.normalDepth;
		const mv = s.motionVector;

		// motionVector:* consumed by ASVGF
		const motionNeeded = !! ( s.asvgf?.enabled );
		// pathtracer:normalDepth consumed by ASVGF, EdgeFilter, BilateralFilter
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
		s.pathTracer?.setCleanAuxNormal?.( !! this.denoiser?.enabled && this.denoiser?.quality !== 'fast' );

		// Reclaim VRAM: free the big 2048² StorageTextures of any denoiser/G-buffer stage that ended up
		// disabled (lazily re-created on the next dispatch after re-enable). Every strategy/denoiser
		// toggle funnels through here after the enabled flags above are settled, so this is the one
		// choke point. dispose() is idempotent, so re-running it for an already-released stage is a no-op.
		for ( const stage of [ s.asvgf, s.variance, s.bilateralFilter, s.edgeFilter, nd, mv ] ) {

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

		if ( this._pendingStartUpscaler && this.denoiser ) {

			this.denoiser.removeEventListener( 'end', this._pendingStartUpscaler );

		}

		this._pendingStartUpscaler = null;

	}

	onRenderComplete( { isStillComplete, context } ) {

		// Remove any stale completion-chain listener from a previous render cycle
		this._cleanupCompletionListener();

		// Show post-process canvas if any post-process is enabled
		if ( ( this.denoiser?.enabled || this.upscaler?.enabled ) && this.denoiserCanvas ) {

			this.denoiserCanvas.style.display = 'block';

		}

		// Chain: denoise first (if enabled), then upscale (if enabled)
		const startUpscaler = () => {

			this._pendingStartUpscaler = null;

			if ( ! isStillComplete() ) return;

			if ( this.upscaler?.enabled ) {

				this.upscaler.start();

			}

		};

		if ( this.denoiser?.enabled ) {

			this._pendingStartUpscaler = startUpscaler;
			this.denoiser.addEventListener( 'end', startUpscaler, { once: true } );
			this.denoiser.start();

		} else {

			// Re-render compositor stage so WebGPU canvas has valid content
			if ( this.upscaler?.enabled && this._stages.compositor && context ) {

				this._stages.compositor.render( context );

			}

			startUpscaler();

		}

	}

	/**
	 * Aborts any in-progress denoising/upscaling (called on reset).
	 * @param {HTMLCanvasElement} canvas
	 */
	abort( mainCanvas ) {

		// Remove stale completion-chain listener before aborting
		this._cleanupCompletionListener();

		if ( mainCanvas ) mainCanvas.style.opacity = '1';

		if ( this.upscaler ) this.upscaler.abort();

		if ( this.denoiser ) {

			if ( this.denoiser.enabled ) this.denoiser.abort();
			if ( this.denoiser.output ) this.denoiser.output.style.display = 'none';

		}

	}

	dispose() {

		// Remove pending completion-chain listener
		this._cleanupCompletionListener();

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

		}

		this._denoiserStartHandler = null;
		this._denoiserEndHandler = null;
		this._upscalerResChangedHandler = null;
		this._upscalerStartHandler = null;
		this._upscalerProgressHandler = null;
		this._upscalerEndHandler = null;

		if ( this.denoiserCanvas?.parentNode ) {

			this.denoiserCanvas.parentNode.removeChild( this.denoiserCanvas );
			this.denoiserCanvas = null;

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
	setOIDNEnabled( enabled ) {

		if ( this.denoiser ) this.denoiser.enabled = enabled;
		// OIDN reads the PathTracer aux MRT; re-sync so the wavefront produces it while OIDN is on.
		this._syncGBufferStages();
		this._onPostProcessRefresh?.();

	}

	/** Sets OIDN denoiser quality. */
	setOIDNQuality( quality ) {

		this.denoiser?.updateQuality( quality );
		// Clean-aux normal follows the model: balanced/high (clean-aux models) → accumulate; fast → keep bump.
		this._stages.pathTracer?.setCleanAuxNormal?.( !! this.denoiser?.enabled && quality !== 'fast' );
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
	 * @param {'none'|'asvgf'|'edgeaware'} strategy
	 * @param {string} [asvgfPreset]
	 */
	setStrategy( strategy, asvgfPreset ) {

		this.setDenoiserStrategy( strategy, asvgfPreset );
		this._onReset?.();

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
			'edgeFiltering:output',
		];
		keys.forEach( k => ctx.removeTexture( k ) );

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
