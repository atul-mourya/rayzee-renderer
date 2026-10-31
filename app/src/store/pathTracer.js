import { create } from 'zustand';
import * as THREE from 'three';
import { DEFAULT_STATE, NRD_QUALITY_PRESETS, computeOutputDimensions, isPanorama, DENOISER_STRATEGIES, SKY_PRESETS } from '@/Constants';
import { PRODUCTION_RENDER_CONFIG, INTERACTIVE_RENDER_CONFIG, sunPosition, dayOfYearForMonth, timeForSunElevation } from 'rayzee';
import { getApp } from '@/lib/appProxy';
import { useCameraStore } from './camera.js';
import { handleChange, useStore, useEnvironmentStore, useAssetsStore } from './ui.js';

// Path tracer store with handlers
//
// RENDERING MODE ARCHITECTURE:
// This application has a two-level rendering optimization system:
//
// 1. GLOBAL RENDERING MODES (Store Level):
//    - PREVIEW_STATE: Fast preview rendering for interactive scene exploration
//    - FINAL_RENDER_STATE: High-quality rendering for final output
//    - Results mode: View completed renders
//
// 2. DYNAMIC CAMERA OPTIMIZATION (CameraOptimizer Level):
//    - Temporarily reduces quality during camera movement within any global mode
//    - Automatically restores quality when camera movement stops
//    - Provides smooth interaction without interrupting the global rendering quality
//
// MODE VALUES:
//    - 'preview': Uses PREVIEW_STATE configuration
//    - 'final-render': Uses FINAL_RENDER_STATE configuration
//    - 'results': Pauses rendering for viewing completed images
//
// This clean separation eliminates naming confusion and provides clear,
// self-documenting code for the rendering pipeline.

// Aliases for store spreading (single source of truth in EngineDefaults.js).
// App appMode 'preview'/'final-render' tabs map to engine 'interactive'/'production' quality tiers.
const FINAL_RENDER_STATE = PRODUCTION_RENDER_CONFIG;

const PREVIEW_STATE = INTERACTIVE_RENDER_CONFIG;

// Never debounced: slider events come faster than any debounce fires. The engine collapses the
// requests of one task into one bake.
const generateSky = () => getApp()?.environmentManager.generateProcedural();

const sunDirection = ( azimuthDeg, elevationDeg ) => {

	const azimuth = azimuthDeg * ( Math.PI / 180 );
	const elevation = elevationDeg * ( Math.PI / 180 );
	return new THREE.Vector3(
		Math.cos( elevation ) * Math.sin( azimuth ),
		Math.sin( elevation ),
		Math.cos( elevation ) * Math.cos( azimuth )
	).normalize();

};

// Solar azimuth runs clockwise from north; north lies along −Z (east along +X), turned by skyNorthOffset.
const sunAnglesFromTime = s => {

	const { azimuth, elevation } = sunPosition( { hours: s.skyTime, dayOfYear: dayOfYearForMonth( s.skyMonth ), latitude: s.skyLatitude } );
	return { skySunAzimuth: ( ( 180 - azimuth + s.skyNorthOffset ) % 360 + 360 ) % 360, skySunElevation: elevation };

};

// The Angles controls stay in step, so switching to them starts from where the sun is.
const applySunPath = ( set, get ) => {

	const angles = sunAnglesFromTime( get() );
	set( angles );
	const app = getApp();
	if ( ! app ) return;
	app.environmentManager.params.skySunDirection.copy( sunDirection( angles.skySunAzimuth, angles.skySunElevation ) );
	if ( get().environmentMode === 'procedural' ) generateSky();

};

// Where the haze has thinned to half, as a share of the models' height above their floor.
const FOG_HALF_HEIGHT = { low: 0.25, ground: 0.06 };

// Thickness is the share of light crossing the models' longest side the haze stops, the same at any scene scale. Lying
// low, the same haze gathers toward the floor: as much of it stands over each spot of the floor as when it is even. A
// room seen from inside is filled to its bounds; an object seen from outside gets a cube holding the camera too, as a box
// looked into shows its edges.
const fogVolume = ( thickness, height, app ) => {

	const box = app.getModelBounds();
	if ( box.isEmpty() ) return { density: 0, bounds: null, falloff: 0 };
	const size = box.getSize( new THREE.Vector3() );
	const span = Math.max( size.x, size.y, size.z );
	let density = span > 0 ? - Math.log( 1 - 0.95 * Math.min( Math.max( thickness, 0 ), 1 ) ) / span : 0;
	let falloff = 0;
	if ( FOG_HALF_HEIGHT[ height ] && span > 0 ) {

		const rise = Math.max( size.y, span * 0.05 );
		falloff = Math.LN2 / ( FOG_HALF_HEIGHT[ height ] * rise );
		density *= falloff * rise / ( 1 - Math.exp( - falloff * rise ) );

	}

	const camera = app.camera?.position;
	if ( ! camera || box.containsPoint( camera ) ) return { density, bounds: null, falloff };

	const center = box.getCenter( new THREE.Vector3() );
	const half = Math.max( span, 3 * center.distanceTo( camera ) );
	return { density, bounds: { min: center.clone().subScalar( half ).toArray(), max: center.clone().addScalar( half ).toArray() }, falloff };

};

const scalar = val => Number( Array.isArray( val ) ? val[ 0 ] : val );

const sunPathHandler = ( set, get, key ) => val => {

	set( { [ key ]: Number( Array.isArray( val ) ? val[ 0 ] : val ) } );
	applySunPath( set, get );

};

// Written to the engine in every mode, so switching to the sky bakes what the panel shows.
const skyHandler = ( set, get, key, apply ) => handleChange(
	val => set( { [ key ]: Array.isArray( val ) ? val[ 0 ] : val } ),
	( val, app ) => {

		apply( app.environmentManager.params, Array.isArray( val ) ? val[ 0 ] : val );
		if ( get().environmentMode === 'procedural' ) generateSky();

	},
	false,
);

export const usePathTracerStore = create( ( set, get ) => ( {
	...DEFAULT_STATE,
	GIIntensity: DEFAULT_STATE.globalIlluminationIntensity,
	backgroundIntensity: DEFAULT_STATE.backgroundIntensity,

	// Which model the AI upscaler runs. App-local: 'neural' is fixed 2x and needs a denoised source.
	upscalerBackend: 'esrgan',

	// Neural rendering (Retouch): a detail pass on the traced image, before any upscale. Hidden
	// because its model is not distributed; `rayzee.showRetouch()` reveals it until the next reload.
	retouchVisible: false,
	neuralRendering: false,
	nrIntensity: 1,
	nrLocalTone: 1,
	nrLocalStructure: 1,
	// 0 keeps the renderer's own chroma. See RETOUCH_COLOR_STRENGTH.
	nrColorStrength: 0,

	showInspector: false,


	// Simple setters
	setMaxSamples: val => set( { maxSamples: val } ),
	setEnablePathTracer: val => set( { enablePathTracer: val } ),
	setEnableAccumulation: val => set( { enableAccumulation: val } ),
	setBounces: val => set( { bounces: val } ),
	setEnableEmissiveTriangleSampling: val => set( { enableEmissiveTriangleSampling: val } ),
	setEmissiveBoost: val => set( { emissiveBoost: val } ),
	setShowInspector: val => set( { showInspector: val } ),
	setFireflyThreshold: val => set( { fireflyThreshold: val } ),
	setTilesHelper: val => set( { tilesHelper: val } ),
	setResolution: val => set( { resolution: parseInt( val, 10 ) } ),
	setOrientation: val => set( { orientation: val } ),
	setFinalRenderResolution: val => set( { finalRenderResolution: parseInt( val, 10 ) } ),
	setEnableOIDN: val => set( { enableOIDN: val } ),
	setRenderLimitMode: val => set( { renderLimitMode: val } ),
	setRenderTimeLimit: val => set( { renderTimeLimit: val } ),
	setDebugMode: val => set( { debugMode: val } ),
	setDebugThreshold: val => set( { debugThreshold: val } ),
	setOidnQuality: val => set( { oidnQuality: val } ),
	setEnableUpscaler: val => set( { enableUpscaler: val } ),
	setUpscalerScale: val => set( { upscalerScale: val } ),
	setUpscalerQuality: val => set( { upscalerQuality: val } ),
	setUpscalerBackend: val => set( { upscalerBackend: val } ),
	setNeuralRendering: val => set( { neuralRendering: val } ),
	setUpscalerHdr: val => set( { upscalerHdr: val } ),
	setExposure: val => set( { exposure: val } ),
	setSaturation: val => set( { saturation: val } ),
	setEnableEnvironment: val => set( { enableEnvironment: val } ),
	setShowBackground: val => set( { showBackground: val } ),
	setBackgroundIntensity: val => set( { backgroundIntensity: val } ),
	setBackgroundColor: val => set( { backgroundColor: val } ),
	setBackgroundBlurriness: val => set( { backgroundBlurriness: val } ),
	setBackgroundBlurSamples: val => set( { backgroundBlurSamples: val } ),
	setEnvironmentIntensity: val => set( { environmentIntensity: val } ),
	setEnvironmentRotation: val => set( { environmentRotation: val } ),
	setGIIntensity: val => set( { GIIntensity: val } ),
	setToneMapping: val => set( { toneMapping: val } ),

	// Environment Mode (HDRI, Procedural Sky, Color)
	setEnvironmentMode: val => set( { environmentMode: val } ),

	// Solid Color Sky
	setSolidSkyColor: val => set( { solidSkyColor: val } ),


	setInteractionModeEnabled: val => set( { interactionModeEnabled: val } ),

	// Canvas dimension setters
	setAspectRatioPreset: val => set( { aspectRatioPreset: val } ),

	setDenoiserStrategy: val => set( { denoiserStrategy: val } ),

	// NRD (ReBLUR) handlers. Presets rewrite the slider state so the UI shows what the engine runs.
	handleNrdQualityPresetChange: handleChange(
		val => set( { nrdQualityPreset: val } ),
		( val, app ) => {

			if ( ! NRD_QUALITY_PRESETS[ val ] ) return;

			app.denoisingManager.applyNRDPreset( val );
			// Mirror the values the engine actually resolved, so the sliders can't drift from it.
			const live = app.stages.nrd?.settings;
			if ( live ) set( {
				nrdMaxAccumulatedFrameNum: live.maxAccumulatedFrameNum,
				nrdMaxBlurRadius: live.maxBlurRadius,
				nrdPrepassBlurRadius: live.prepassBlurRadius,
				nrdAntiFirefly: live.enableAntiFirefly,
			} );
			// Hard reset drops the denoiser history built under the old settings.
			app.reset();

		},
		false
	),

	handleNrdDebugModeChange: handleChange(
		val => set( { nrdDebugMode: parseInt( val ) } ),
		( val, app ) => app.denoisingManager.setNRDDebugMode( parseInt( val ) ),
		false
	),

	handleNrdMaxAccumulatedFrameNumChange: handleChange(
		val => set( { nrdMaxAccumulatedFrameNum: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => app.denoisingManager.setNRDParams( { maxAccumulatedFrameNum: Array.isArray( val ) ? val[ 0 ] : val } ),
		false
	),

	handleNrdMaxBlurRadiusChange: handleChange(
		val => set( { nrdMaxBlurRadius: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => app.denoisingManager.setNRDParams( { maxBlurRadius: Array.isArray( val ) ? val[ 0 ] : val } ),
		false
	),

	handleNrdPrepassBlurRadiusChange: handleChange(
		val => set( { nrdPrepassBlurRadius: Array.isArray( val ) ? val[ 0 ] : val } ),
		( val, app ) => app.denoisingManager.setNRDParams( { prepassBlurRadius: Array.isArray( val ) ? val[ 0 ] : val } ),
		false
	),

	handleNrdAntiFireflyChange: handleChange(
		val => set( { nrdAntiFirefly: val } ),
		( val, app ) => app.denoisingManager.setNRDParams( { enableAntiFirefly: val } ),
		false
	),

	// Handlers
	handlePathTracerChange: handleChange(
		val => set( { enablePathTracer: val } ),
		( val, app ) => {

			app.pathTracerEnabled = val;

		}
	),

	handleAccumulationChange: handleChange(
		val => set( { enableAccumulation: val } ),
		( val, app ) => app.stages.pathTracer?.setAccumulationEnabled( val )
	),

	// These three are summed into the wavefront loop bound, so an un-unwrapped [n] from a
	// Slider turns `a + b + c` into string concatenation ([20] + 5 + 8 === '2058') and the
	// bounce loop runs to 2058 whenever the survivor curve can't early-exit it.
	handleBouncesChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { bounces: v } );
		getApp()?.settings.set( 'maxBounces', v );

	},

	handleTransmissiveBouncesChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { transmissiveBounces: v } );
		getApp()?.settings.set( 'transmissiveBounces', v );

	},
	handleMaxSubsurfaceStepsChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { maxSubsurfaceSteps: v } );
		getApp()?.settings.set( 'maxSubsurfaceSteps', v );

	},

	handleMaxTransparentBouncesChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { maxTransparentBounces: v } );
		getApp()?.settings.set( 'maxTransparentBounces', v );

	},

	setMaxTextureSize: val => set( { maxTextureSize: parseInt( val, 10 ) } ),
	handleMaxTextureSizeChange: async val => {

		const size = parseInt( val, 10 );
		set( { maxTextureSize: size } );
		const app = getApp();
		if ( ! app ) return;

		// Reprocessing the scene rebuilds the texture arrays at the new cap.
		const { setLoading, resetLoading } = useStore.getState();
		setLoading( { isLoading: true, title: 'Reprocessing', status: 'Rebuilding textures…' } );
		try {

			await app.setMaxTextureSize( size );

		} catch ( error ) {

			console.error( 'Failed to apply max texture size:', error );

		} finally {

			resetLoading();

		}

	},

	handleEnableEmissiveTriangleSamplingChange: val => {

		set( { enableEmissiveTriangleSampling: val } );
		getApp()?.setEmissiveTriangleSampling( val );

	},

	handleEmissiveBoostChange: val => {

		set( { emissiveBoost: val } );
		getApp()?.settings.set( 'emissiveBoost', val );

	},

	// --- Output dimension handlers (resolution + aspect ratio + orientation) ---

	// Helper: recompute canvas dims from current state and apply to app
	_applyCanvasDimensions: ( overrides = {} ) => {

		const state = { ...get(), ...overrides };
		const res = useStore.getState().appMode === 'final-render' ? state.finalRenderResolution : state.resolution;
		const { width, height } = computeOutputDimensions( state, res );

		set( { ...overrides, canvasWidth: width, canvasHeight: height } );

		const app = getApp();
		if ( app ) {

			// Ensure the reserved (pre-allocated) storage can hold this resolution before applying it. For sizes
			// above the 2048 default (4K) this device-caps + re-inits the pipeline's reserved textures in place;
			// on GPUs that can't afford it the request clamps to 2048 and the larger setCanvasSize is ignored.
			app.setReservedRenderResolution?.( Math.max( width, height ) );
			app.setCanvasSize( width, height );
			app.reset();

		}

	},

	handleResolutionChange: ( val ) => {

		const resolution = parseInt( val, 10 );
		get()._applyCanvasDimensions( { resolution } );

	},

	handleAspectPresetChange: ( preset ) => {

		get()._applyCanvasDimensions( { aspectRatioPreset: preset } );

	},

	handleOrientationToggle: () => {

		const current = get().orientation;
		get()._applyCanvasDimensions( { orientation: current === 'landscape' ? 'portrait' : 'landscape' } );

	},

	handleFinalRenderResolutionChange: ( val ) => {

		get()._applyCanvasDimensions( { finalRenderResolution: parseInt( val, 10 ) } );

	},

	// --- Camera projection (perspective / 360 panorama) ---

	handleCameraProjectionChange: ( val ) => {

		const app = getApp();

		if ( app ) {

			app.settings.set( 'cameraProjection', val );

			// The engine owns which features panorama is incompatible with — mirror the
			// outcome rather than restating the rule here.
			set( { denoiserStrategy: app.denoisingManager.denoiserStrategy } );
			useCameraStore.setState( { autoFocusMode: app.cameraManager.autoFocusMode } );

		}

		// Panorama locks the output to 2:1, so the canvas has to be re-derived.
		get()._applyCanvasDimensions( { cameraProjection: val } );

	},

	// A camera switch can change the projection: its own is orthographic, or it leaves one that was.
	syncCameraProjection: cameraProjection => {

		if ( ! cameraProjection ) return;
		// Only a panorama's 2:1 changes the output size.
		if ( isPanorama( cameraProjection ) !== isPanorama( get().cameraProjection ) ) get()._applyCanvasDimensions( { cameraProjection } );
		else set( { cameraProjection } );

	},

	handlePanoramaLonRangeChange: ( val ) => {

		set( { panoramaLonRange: val } );
		getApp()?.settings.set( 'panoramaLonRange', val );

	},

	handlePanoramaLatRangeChange: ( val ) => {

		set( { panoramaLatRange: val } );
		getApp()?.settings.set( 'panoramaLatRange', val );

	},

	handlePanoramaLevelHorizonChange: ( val ) => {

		set( { panoramaLevelHorizon: val } );
		getApp()?.settings.set( 'panoramaLevelHorizon', val );

	},

	_inspectorInstance: null,
	handleInspectorToggle: async val => {

		set( { showInspector: val } );
		const app = getApp();
		if ( ! app ) return;

		let inspector = get()._inspectorInstance;

		if ( val && ! inspector ) {

			const { Inspector } = await import( 'three/addons/inspector/Inspector.js' );
			inspector = new Inspector();
			// Vite dev server serves index.html (not JSON) for raw fetches of files
			// under node_modules, which breaks the Inspector's extensions probe.
			inspector.settings._getExtensions = async () => [];
			// Mount to <body> so the profiler panel escapes the viewport wrapper's
			// `transform: scale()` (which re-parents `position: fixed` children).
			document.body.appendChild( inspector.domElement );
			app.renderer.inspector = inspector;
			set( { _inspectorInstance: inspector } );

		}

		// Toggle DOM visibility directly — Inspector.show()/.hide() in r184 call
		// Profiler.show(tab) which requires a tab argument and throws otherwise.
		if ( inspector ) {

			inspector.domElement.style.display = val ? '' : 'none';

		}

	},

	handleFireflyThresholdChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { fireflyThreshold: v } );
		getApp()?.settings.set( 'fireflyThreshold', v );

	},

	handleIntegratorChange: val => {

		set( { integrator: val } );
		getApp()?.settings.set( 'integrator', val );

	},

	handleShadowTerminatorOffsetChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { shadowTerminatorOffset: v } );
		getApp()?.settings.set( 'shadowTerminatorOffset', v );

	},

	handleEnableAlphaShadowsChange: val => {

		set( { enableAlphaShadows: val } );
		getApp()?.settings.set( 'enableAlphaShadows', val );

	},

	// One switch, both tiers — the whole-frame early-stop and the per-pixel freeze are halves of one feature.
	handleUseAdaptiveSamplingChange: val => {

		set( { useAdaptiveSampling: val, usePixelFreeze: val } );
		getApp()?.settings.setMany( { useAdaptiveSampling: val, usePixelFreeze: val } );

	},

	handleNoiseThresholdChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { noiseThreshold: v } );
		getApp()?.settings.set( 'noiseThreshold', v );

	},

	handleAdaptiveMinSamplesChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { adaptiveMinSamples: v } );
		getApp()?.settings.set( 'adaptiveMinSamples', v );

	},

	handleConvergenceOverlayChange: val => {

		set( { convergenceOverlay: val } );
		getApp()?.settings.set( 'convergenceOverlay', val );

	},

	handleTileHelperToggle: handleChange(
		val => set( { tilesHelper: val } ),
		( val, app ) => {

			app.denoisingManager.setTileHelperEnabled( val );

		},
		false
	),

	// Turning the final denoise off takes the neural passes with it. Both need a denoised frame —
	// on raw Monte-Carlo noise the upscaler measured worse than a plain resize — so leaving their
	// switches on while the engine silently skipped them would be a lie on the panel.
	handleEnableOIDNChange: handleChange(
		val => set( val ? { enableOIDN: val } : { enableOIDN: val, enableUpscaler: false, neuralRendering: false } ),
		( val, app ) => {

			app.denoisingManager.setOIDNEnabled( val );
			if ( ! val ) {

				app.denoisingManager.setUpscalerEnabled( false );
				app.denoisingManager.setNeuralRendering( false );

			}

		},
		false
	),

	handleOidnQualityChange: handleChange(
		val => set( { oidnQuality: val } ),
		( val, app ) => app.denoisingManager.setOIDNQuality( val ),
		false
	),

	handleEnableUpscalerChange: handleChange(
		val => set( { enableUpscaler: val } ),
		( val, app ) => app.denoisingManager.setUpscalerEnabled( val ),
		false
	),

	handleUpscalerScaleChange: handleChange(
		val => set( { upscalerScale: Number( val ) } ),
		( val, app ) => app.denoisingManager.setUpscalerScaleFactor( Number( val ) ),
		false
	),

	handleNeuralRenderingChange: handleChange(
		val => set( { neuralRendering: val } ),
		( val, app ) => app.denoisingManager.setNeuralRendering( val, {
			intensity: get().nrIntensity,
			localTone: get().nrLocalTone,
			localStructure: get().nrLocalStructure,
			colorStrength: get().nrColorStrength,
		} ),
		false
	),

	handleNRSettingChange: ( key, storeKey ) => handleChange(
		val => set( { [ storeKey ]: val } ),
		( val, app ) => app.denoisingManager.setNeuralRendering( get().neuralRendering, { [ key ]: val } ),
		false
	),

	setRetouchVisible: visible => {

		set( { retouchVisible: visible } );
		if ( ! visible && get().neuralRendering ) get().handleNeuralRenderingChange( false );

	},

	handleUpscalerBackendChange: handleChange(
		val => set( { upscalerBackend: val } ),
		( val, app ) => app.denoisingManager.setUpscalerBackend( val ),
		false
	),

	handleUpscalerQualityChange: handleChange(
		val => set( { upscalerQuality: val } ),
		( val, app ) => app.denoisingManager.setUpscalerQuality( val ),
		false
	),

	handleDenoiserStrategyChange: handleChange(
		val => set( { denoiserStrategy: val } ),
		( val, app ) => {

			app.denoisingManager.setStrategy( val, get().nrdQualityPreset );
			// The engine may run another (NRD cannot in a panorama).
			set( { denoiserStrategy: app.denoisingManager.denoiserStrategy } );

		},
		false // engine method handles reset internally
	),

	handleDebugThresholdChange: val => {

		set( { debugThreshold: val } );
		getApp()?.settings.set( 'debugVisScale', val[ 0 ] );

	},

	handleDebugModeChange: val => {

		set( { debugMode: val } );
		const mode = {
			'1': 1, '2': 2, '3': 3, '4': 4, '5': 5,
			'6': 6, '7': 7, '8': 8, '9': 9, '10': 10, '11': 11,
			'12': 12, '13': 13, '14': 14, '15': 15,
		}[ val ] || 0;
		getApp()?.settings.set( 'visMode', mode );

	},

	handleExposureChange: val => {

		// Slider component emits [number]; unwrap so settings.set receives a scalar.
		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { exposure: v } );
		getApp()?.settings.set( 'exposure', v );

	},

	handleSaturationChange: handleChange(
		val => set( { saturation: val } ),
		( val, app ) => app.settings.set( 'saturation', val ),
		false
	),

	// Exposure handlers
	handleAutoExposureChange: handleChange(
		val => set( { autoExposure: val } ),
		( val, app ) => app.denoisingManager.setAutoExposure( val ),
		false
	),

	handleAutoExposureStrengthChange: handleChange(
		val => set( { autoExposureStrength: val } ),
		( val, app ) => app.denoisingManager.setAutoExposureParams( { strength: val } ),
		false
	),

	// The live denoiser and auto and local exposure keep no record in the engine's settings: the panel's values
	// are put on it at startup and after a session restores the panel. Only what the panel shows — the rest stay
	// the engine's. A session can name a denoiser that no longer exists; it gets the default.
	applyPanelToEngine: () => {

		const app = getApp();
		if ( ! app ) return;
		const s = get();
		const dm = app.denoisingManager;
		const strategy = DENOISER_STRATEGIES.includes( s.denoiserStrategy ) ? s.denoiserStrategy : DEFAULT_STATE.denoiserStrategy;
		if ( dm.denoiserStrategy !== strategy ) dm.setDenoiserStrategy( strategy, s.nrdQualityPreset );
		// The engine may run another (NRD cannot in a panorama).
		set( { denoiserStrategy: dm.denoiserStrategy } );
		dm.setNRDParams( {
			maxAccumulatedFrameNum: s.nrdMaxAccumulatedFrameNum, maxBlurRadius: s.nrdMaxBlurRadius,
			prepassBlurRadius: s.nrdPrepassBlurRadius, enableAntiFirefly: s.nrdAntiFirefly,
		} );
		dm.setNRDDebugMode( s.nrdDebugMode );
		dm.setAutoExposureParams( { strength: s.autoExposureStrength } );
		dm.setAutoExposure( s.autoExposure );
		app.setLocalExposureParams?.( { highlightContrast: s.localExposureHighlightContrast } );
		app.setLocalExposure?.( s.localExposure );
		s._applyFog();

	},

	handleLocalExposureChange: handleChange(
		val => set( { localExposure: val } ),
		( val, app ) => app.setLocalExposure?.( val ),
		false
	),

	// Amount is how far bright areas come down: 1 − the engine's highlight contrast.
	handleLocalExposureAmountChange: handleChange(
		val => set( { localExposureHighlightContrast: 1 - val } ),
		( val, app ) => app.setLocalExposureParams?.( { highlightContrast: 1 - val } ),
		false
	),

	handleEnableEnvironmentChange: val => {

		set( { enableEnvironment: val } );
		getApp()?.settings.set( 'enableEnvironment', val );

	},

	// Unified background mode. The backdrop (what camera rays see on a miss) is a single
	// mutually-exclusive choice — env image / solid color / transparent — driven by the two
	// engine uniforms showBackground + transparentBackground. Environment LIGHTING is a separate
	// axis (enableEnvironment), untouched here, so switching the backdrop never changes lighting.
	//   'environment' → showBackground=1, transparent=0   (HDRI/sky, opaque)
	//   'color'       → showBackground=0, transparent=0   (solid backgroundColor, opaque)
	//   'transparent' → showBackground=0, transparent=1   (alpha 0 for compositing)
	handleBackgroundTypeChange: mode => {

		const transparent = mode === 'transparent';
		const showBg = mode === 'environment';
		set( { transparentBackground: transparent, showBackground: showBg } );
		const app = getApp();
		if ( app ) {

			if ( app.scene ) app.scene.background = showBg ? app.scene.environment : null;
			app.settings.setMany( { showBackground: showBg, transparentBackground: transparent } );

		}

	},

	// Kept for API back-compat; the UI now drives the backdrop via handleBackgroundTypeChange.
	// No longer clobbers showBackground (the old one-way coupling that left a black backdrop).
	handleShowBackgroundChange: val => {

		set( { showBackground: val } );
		const app = getApp();
		if ( app ) {

			if ( app.scene ) app.scene.background = val ? app.scene.environment : null;
			app.settings.set( 'showBackground', val );

		}

	},

	handleTransparentBackgroundChange: val => {

		set( { transparentBackground: val } );
		const app = getApp();
		if ( app ) {

			if ( val && app.scene ) app.scene.background = null;
			app.settings.set( 'transparentBackground', val );

		}

	},

	handleBackgroundIntensityChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val; // Slider emits [value]
		set( { backgroundIntensity: v } );
		getApp()?.settings.set( 'backgroundIntensity', v );

	},

	// Solid backdrop color (engine converts the hex sRGB → linear). reset() re-accumulates.
	handleBackgroundColorChange: handleChange(
		val => set( { backgroundColor: val } ),
		( val, app ) => app.settings.set( 'backgroundColor', val ),
	),

	// Backdrop blur (env background only). 0 = sharp. Samples = cone-jitter taps/frame.
	handleBackgroundBlurrinessChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { backgroundBlurriness: v } );
		getApp()?.settings.set( 'backgroundBlurriness', v );

	},

	handleBackgroundBlurSamplesChange: val => {

		const v = Array.isArray( val ) ? val[ 0 ] : val;
		set( { backgroundBlurSamples: v } );
		getApp()?.settings.set( 'backgroundBlurSamples', v );

	},

	handleEnvironmentIntensityChange: val => {

		set( { environmentIntensity: val } );
		getApp()?.settings.set( 'environmentIntensity', val );

	},

	handleEnvironmentRotationChange: val => {

		set( { environmentRotation: val } );
		getApp()?.settings.set( 'environmentRotation', val[ 0 ] );

	},

	// Mirrors an environment the engine installed by itself — the HDRI authored into a model
	// file's metadata, or none for a pbrt scene without a sky (`enabled`), reported via the
	// SceneMetadataApplied event. The engine has already applied its own settings; this only
	// pulls the UI back in sync with them.
	syncSceneEnvironment: env => {

		if ( env?.enabled !== undefined ) {

			const settings = getApp()?.settings;
			if ( settings ) set( { enableEnvironment: settings.get( 'enableEnvironment' ), showBackground: settings.get( 'showBackground' ), transparentBackground: settings.get( 'transparentBackground' ) } );
			return;

		}

		if ( ! env?.sourceFile ) return;

		const patch = {
			environmentMode: 'hdri',
			enableEnvironment: true,
			showBackground: true,
			transparentBackground: false,
		};

		if ( env.intensity !== undefined ) {

			patch.environmentIntensity = env.intensity;
			patch.backgroundIntensity = env.intensity;

		}

		if ( env.rotation !== undefined ) patch.environmentRotation = env.rotation;

		set( patch );

		// Prefer the catalog entry when the authored URL is one we already know, so the
		// Environments tab highlights the matching thumbnail instead of nothing.
		const known = ( useEnvironmentStore.getState().environments || [] ).find( e => e.url === env.sourceFile );
		useAssetsStore.getState().setEnvironment( known || {
			id: env.sourceFile,
			name: decodeURIComponent( env.sourceFile.split( /[?#]/ )[ 0 ].split( '/' ).pop() || '' ) || 'Scene Environment',
			preview: null,
			url: env.sourceFile,
			source: 'scene',
		} );

	},

	handleGroundProjectionEnabledChange: val => {

		set( { groundProjectionEnabled: val } );
		getApp()?.settings.set( 'groundProjectionEnabled', val );

	},

	handleGroundProjectionRadiusChange: val => {

		set( { groundProjectionRadius: val[ 0 ] } );
		getApp()?.settings.set( 'groundProjectionRadius', val[ 0 ] );

	},

	handleGroundProjectionHeightChange: val => {

		set( { groundProjectionHeight: val[ 0 ] } );
		getApp()?.settings.set( 'groundProjectionHeight', val[ 0 ] );

	},

	// Analytic ground-plane shadow catcher (no geometry). On enable, seed the plane height
	// from the scene's floor (min-Y). The catcher adapts to the current background mode: it
	// composites the shadow over the visible environment, or emits a matte into alpha when the
	// background is transparent — so enabling it never removes the background.
	handleEnableGroundCatcherChange: val => {

		set( { enableGroundCatcher: val } );
		const app = getApp();
		app?.settings.set( 'enableGroundCatcher', val );

		if ( val && app ) {

			const minY = app.getSceneMinY?.() ?? 0;
			set( { groundCatcherHeight: minY } );
			app.settings.set( 'groundCatcherHeight', minY );

		}

	},

	handleGroundCatcherHeightChange: val => {

		set( { groundCatcherHeight: val } );
		getApp()?.settings.set( 'groundCatcherHeight', val );

	},

	handleFogChange: val => {

		set( { fog: val } );
		get()._applyFog();

	},

	handleFogThicknessChange: val => {

		set( { fogThickness: scalar( val ) } );
		get()._applyFog();

	},

	handleFogColorChange: val => {

		set( { fogColor: val } );
		getApp()?.settings.set( 'fogColor', val );

	},

	handleFogAnisotropyChange: val => {

		set( { fogAnisotropy: scalar( val ) } );
		getApp()?.settings.set( 'fogAnisotropy', scalar( val ) );

	},

	handleFogHeightChange: val => {

		set( { fogHeight: val } );
		get()._applyFog();

	},

	// Also after a model loads: the density follows the models' size.
	_applyFog: () => {

		const app = getApp();
		if ( ! app ) return;
		const s = get();
		const volume = s.fog ? fogVolume( s.fogThickness, s.fogHeight, app ) : { density: 0, bounds: null, falloff: 0 };
		app.settings.set( 'fogColor', s.fogColor );
		app.settings.set( 'fogAnisotropy', s.fogAnisotropy );
		app.settings.set( 'fogHeightFalloff', volume.falloff );
		app.settings.set( 'fogBounds', volume.bounds );
		app.settings.set( 'fogDensity', volume.density );

	},

	handleGIIntensityChange: val => {

		set( { GIIntensity: val } );
		getApp()?.settings.set( 'globalIlluminationIntensity', val );

	},

	// Environment Mode Handlers
	handleEnvironmentModeChange: ( val ) => {

		set( { environmentMode: val } );
		const app = getApp();
		if ( app ) app.environmentManager.setMode( val );

	},

	// Solid Color Sky Handler
	handleSolidSkyColorChange: handleChange(
		val => set( { solidSkyColor: val } ),
		( val, app ) => {

			if ( ! app || get().environmentMode !== 'color' ) return;

			const envParams = app.environmentManager.params;
			if ( ! envParams ) return;
			const color = new THREE.Color( val );
			envParams.solidSkyColor.copy( color );
			app.environmentManager.generateSolid();

		}
	),

	// Physical sky handlers
	handleSkyTimeChange: sunPathHandler( set, get, 'skyTime' ),
	handleSkyMonthChange: sunPathHandler( set, get, 'skyMonth' ),
	handleSkyLatitudeChange: sunPathHandler( set, get, 'skyLatitude' ),
	handleSkyNorthOffsetChange: sunPathHandler( set, get, 'skyNorthOffset' ),
	handleSkySunModeChange: val => {

		set( { skySunMode: val } );
		if ( val === 'time' ) applySunPath( set, get );

	},
	handleSkySunAzimuthChange: skyHandler( set, get, 'skySunAzimuth', ( p, val ) => p.skySunDirection.copy( sunDirection( val, get().skySunElevation ) ) ),
	handleSkySunElevationChange: skyHandler( set, get, 'skySunElevation', ( p, val ) => p.skySunDirection.copy( sunDirection( get().skySunAzimuth, val ) ) ),
	handleSkySunStrengthChange: skyHandler( set, get, 'skySunStrength', ( p, val ) => void ( p.skySunStrength = val ) ),
	handleSkySunSizeChange: skyHandler( set, get, 'skySunSize', ( p, val ) => void ( p.skySunSize = val ) ),
	handleSkyTurbidityChange: skyHandler( set, get, 'skyTurbidity', ( p, val ) => void ( p.skyTurbidity = val ) ),
	handleSkyOzoneChange: skyHandler( set, get, 'skyOzone', ( p, val ) => void ( p.skyOzone = val ) ),
	handleSkyAirDensityChange: skyHandler( set, get, 'skyAirDensity', ( p, val ) => void ( p.skyAirDensity = val ) ),
	handleSkyAltitudeChange: skyHandler( set, get, 'skyAltitude', ( p, val ) => void ( p.skyAltitude = val ) ),
	handleSkyGroundAlbedoChange: skyHandler( set, get, 'skyGroundAlbedo', ( p, val ) => p.skyGroundAlbedo.set( val ) ),

	handleSkyPresetChange: val => {

		const preset = SKY_PRESETS[ val ];
		if ( ! preset ) return;

		set( { skyPreset: val } );
		const store = get();
		if ( store.skySunMode === 'time' ) {

			// The preset's sun height, reached on the current date and latitude.
			store.handleSkyTimeChange( timeForSunElevation( {
				elevation: preset.sunElevation, dayOfYear: dayOfYearForMonth( store.skyMonth ),
				latitude: store.skyLatitude, afternoon: preset.sunAzimuth > 180,
			} ) );

		} else {

			store.handleSkySunAzimuthChange( preset.sunAzimuth );
			store.handleSkySunElevationChange( preset.sunElevation );

		}

		store.handleSkyTurbidityChange( preset.turbidity );
		store.handleSkyAltitudeChange( preset.altitude ?? DEFAULT_STATE.skyAltitude );
		store.handleExposureChange( Math.pow( 2, preset.exposure ?? 0 ) );

	},

	handleToneMappingChange: handleChange(
		val => set( { toneMapping: val } ),
		( val, app ) => {

			// Through colour management rather than straight onto the renderer: an OCIO view
			// returns colour already encoded for its display, and `outputColorSpace` has to follow
			// it or the output pass encodes it a second time.
			app.color.setActiveView( parseInt( val ) );
			app.reset();

		}
	),

	handleRenderLimitModeChange: val => {

		set( { renderLimitMode: val } );
		getApp()?.settings.set( 'renderLimitMode', val );

	},

	handleRenderTimeLimitChange: val => {

		set( { renderTimeLimit: val } );
		getApp()?.settings.set( 'renderTimeLimit', parseFloat( val ) );

	},

	handleInteractionModeEnabledChange: handleChange(
		val => set( { interactionModeEnabled: val } ),
		( val, app ) => app.settings.set( 'interactionModeEnabled', val ),
		false // Don't reset - exitInteractionMode handles the soft reset internally
	),

	// Canvas configuration handlers
	handleConfigureForPreview: () => {

		set( { ...PREVIEW_STATE, isRendering: true } );

		const app = getApp();
		if ( ! app ) return;

		const state = get();
		const { width, height } = computeOutputDimensions( state, state.resolution );
		set( { canvasWidth: width, canvasHeight: height } );

		app.configureForMode( 'interactive', { canvasWidth: width, canvasHeight: height } );

	},

	handleConfigureForFinalRender: () => {

		set( { ...FINAL_RENDER_STATE, isRendering: true } );

		const app = getApp();
		if ( ! app ) return;

		const state = get();
		const { width, height } = computeOutputDimensions( state, state.finalRenderResolution );
		set( { canvasWidth: width, canvasHeight: height } );

		app.configureForMode( 'production', { canvasWidth: width, canvasHeight: height } );

	},

	handleConfigureForResults: () => {

		const app = getApp();
		if ( ! app ) return;
		app.pauseRendering = true;
		app.cameraManager.controls.enabled = false;
		set( { isRendering: false } );

	},

	handleModeChange: mode => {

		getApp()?.timeline.stop();
		const actions = {
			preview: 'handleConfigureForPreview',
			'final-render': 'handleConfigureForFinalRender',
			results: 'handleConfigureForResults'
		};
		const action = actions[ mode ];
		action ? get()[ action ]() : console.warn( `Unknown mode: ${mode}` );

	},
} ) );

globalThis.rayzee = Object.assign( globalThis.rayzee ?? {}, {
	showRetouch: ( visible = true ) => usePathTracerStore.getState().setRetouchVisible( !! visible ),
} );
