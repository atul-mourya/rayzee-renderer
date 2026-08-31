import { EventDispatcher, Color, Vector2, MathUtils } from 'three';
import { ENGINE_DEFAULTS } from './EngineDefaults.js';
import { EngineEvents } from './EngineEvents.js';
import { ISSUE_CODES } from './EngineIssues.js';

/**
 * Routing table: maps each setting key to its target stage/handler.
 *
 * - `uniform`  → forwarded to PathTracer.setUniform(uniform, value)
 * - `handler`  → calls a named handler method for multi-stage settings
 * - `delegate` → routes to a named manager's updateParam(param, value)
 * - `reset`    → whether to reset accumulation after the change (default true)
 * - `after`    → optional method to call on PathTracer after the uniform is set
 */
const SETTING_ROUTES = {

	// ── Simple PathTracer uniforms ──────────────────────────

	maxBounces: { uniform: 'maxBounces', reset: true },
	transmissiveBounces: { uniform: 'transmissiveBounces', reset: true },
	maxSubsurfaceSteps: { uniform: 'maxSubsurfaceSteps', reset: true },
	maxTransparentBounces: { uniform: 'maxTransparentBounces', reset: true },
	environmentIntensity: { uniform: 'environmentIntensity', reset: true },
	backgroundIntensity: { uniform: 'backgroundIntensity', reset: true },
	backgroundBlurriness: { uniform: 'backgroundBlurriness', reset: true },
	backgroundBlurSamples: { uniform: 'backgroundBlurSamples', reset: true },
	showBackground: { uniform: 'showBackground', reset: true },
	enableEnvironment: { uniform: 'enableEnvironment', reset: true },
	groundProjectionEnabled: { uniform: 'groundProjectionEnabled', reset: true },
	groundProjectionRadius: { uniform: 'groundProjectionRadius', reset: true },
	groundProjectionHeight: { uniform: 'groundProjectionHeight', reset: true },
	groundProjectionLevel: { uniform: 'groundProjectionLevel', reset: true },
	enableGroundCatcher: { uniform: 'enableGroundCatcher', reset: true },
	groundCatcherHeight: { uniform: 'groundCatcherHeight', reset: true },
	globalIlluminationIntensity: { uniform: 'globalIlluminationIntensity', reset: true },
	panoramaLevelHorizon: { uniform: 'panoLevelHorizon', reset: true },
	enableDOF: { uniform: 'enableDOF', reset: true },
	focusDistance: { uniform: 'focusDistance', reset: false },
	focalLength: { uniform: 'focalLength', reset: true },
	aperture: { uniform: 'aperture', reset: true },
	apertureScale: { uniform: 'apertureScale', reset: true },
	anamorphicRatio: { uniform: 'anamorphicRatio', reset: true },
	samplingTechnique: { uniform: 'samplingTechnique', reset: true },
	fireflyThreshold: { uniform: 'fireflyThreshold', reset: true },
	enableAlphaShadows: { uniform: 'enableAlphaShadows', reset: true },
	// Adaptive sampling — whole-frame early-stop (useAdaptiveSampling) + per-pixel freeze (usePixelFreeze)
	useAdaptiveSampling: { uniform: 'useAdaptiveSampling', reset: true },
	noiseThreshold: { uniform: 'noiseThreshold', reset: true },
	adaptiveMinSamples: { uniform: 'adaptiveMinSamples', reset: true },
	adaptiveStopFraction: { uniform: 'adaptiveStopFraction', reset: true },
	usePixelFreeze: { uniform: 'usePixelFreeze', reset: true },
	pixelFreezeThreshold: { uniform: 'pixelFreezeThreshold', reset: true },
	pixelFreezeStability: { uniform: 'pixelFreezeStability', reset: true },
	convergenceOverlay: { handler: 'handleConvergenceOverlay', reset: false },
	enableEmissiveTriangleSampling: { uniform: 'enableEmissiveTriangleSampling', reset: true },
	emissiveBoost: { uniform: 'emissiveBoost', reset: true },
	visMode: { uniform: 'visMode', reset: true },
	debugVisScale: { uniform: 'debugVisScale', reset: true },

	// ── Multi-stage / special handling ────────────────────────────

	cameraProjection: { handler: 'handleCameraProjection', reset: true },
	panoramaLonRange: { handler: 'handlePanoramaLonRange', reset: true },
	panoramaLatRange: { handler: 'handlePanoramaLatRange', reset: true },
	interactionModeEnabled: { handler: 'handleInteractionModeEnabled', reset: false },
	maxSamples: { handler: 'handleMaxSamples', reset: false },
	transparentBackground: { handler: 'handleTransparentBackground' },
	backgroundColor: { handler: 'handleBackgroundColor', reset: true },
	exposure: { handler: 'handleExposure' },
	saturation: { handler: 'handleSaturation' },
	renderLimitMode: { handler: 'handleRenderLimitMode' },
	renderTimeLimit: { handler: 'handleRenderTimeLimit', reset: false },
	renderMode: { handler: 'handleRenderMode' },
	environmentRotation: { handler: 'handleEnvironmentRotation' },

};

/**
 * Default keys to extract from ENGINE_DEFAULTS for initializing the values map.
 * Maps ENGINE_DEFAULTS key → RenderSettings key when they differ.
 */
/**
 * Provenance tags for getEffective(). Add-only, like ISSUE_CODES — hosts branch on them.
 */
export const SETTING_SOURCE = Object.freeze( {
	/** ENGINE_DEFAULTS, never touched since. */
	DEFAULT: 'default',
	/** Set by the embedding application. */
	HOST: 'host',
	/** Read out of the model file's authored metadata (glTF `extras`). */
	SCENE_METADATA: 'scene-metadata',
	/** Applied by configureForMode() — the interactive/production quality tiers. */
	MODE_PRESET: 'mode-preset',
} );

const DEFAULTS_KEY_MAP = {
	bounces: 'maxBounces',
	debugMode: 'visMode',
};

/**
 * Single source of truth for all render parameters.
 *
 * Replaces the 48 property initializations and 22+ boilerplate setter
 * methods that were duplicated across PathTracerApp and UniformManager.
 *
 * Usage:
 *   settings.set('maxBounces', 8);
 *   settings.get('maxBounces');               // 8
 *   settings.setMany({ maxBounces: 8, exposure: 1.5 });
 */
export class RenderSettings extends EventDispatcher {

	/**
	 * @param {Object} [defaults]
	 * @param {Object} [options]
	 * @param {import('./EngineIssues.js').IssueLog} [options.issues] - records unroutable keys
	 */
	constructor( defaults = ENGINE_DEFAULTS, { issues = null } = {} ) {

		super();

		this._issues = issues;

		/** @type {Map<string, *>} */
		this._values = new Map();

		/**
		 * Where each value came from. A number that "looks wrong" is usually a value someone
		 * else set — the authored scene, a mode preset — and without this the only way to find
		 * out is to bisect the engine. See getEffective().
		 * @type {Map<string, string>}
		 */
		this._sources = new Map();

		/** @type {import('./Stages/PathTracer.js').PathTracer|null} */
		this._pathTracer = null;

		/** @type {Function|null} - Callback to reset accumulation */
		this._resetCallback = null;

		/** @type {Object<string, Function>} - Named handlers for multi-stage settings */
		this._handlers = {};

		/** @type {Object<string, Object>} - Named delegate managers */
		this._delegates = {};

		// Initialize values from ENGINE_DEFAULTS
		this._initDefaults( defaults );

	}

	/**
	 * Wires internal references. Called by PathTracerApp after init().
	 *
	 * @param {Object} params
	 * @param {Object} params.stages           - Pipeline stages { pathTracer, compositor, autoExposure, ... }
	 * @param {Function} params.resetCallback   - Called to reset accumulation
	 * @param {Function} [params.reconcileCompletion] - Called when completion limits change
	 * @param {Object} [params.denoisingManager] - Needed to force ASVGF off under panorama
	 * @param {Object} [params.cameraManager]    - Needed to force auto-focus manual under panorama
	 */
	bind( params ) {

		this._pathTracer = params.stages.pathTracer;
		this._resetCallback = params.resetCallback;
		this._delegates = {};
		this._handlers = this._buildHandlers( params );

	}

	/**
	 * Builds handler functions for multi-stage settings that can't
	 * be routed with a simple uniform forward.
	 */
	_buildHandlers( { stages, renderer, resetCallback, reconcileCompletion, denoisingManager, cameraManager } ) {

		// UniformManager copies into the existing node, so one scratch vector serves every write.
		const panoScratch = new Vector2();
		const setPanoRange = ( uniform, value ) => {

			panoScratch.set( value?.[ 0 ] ?? 0, value?.[ 1 ] ?? 0 ).multiplyScalar( MathUtils.DEG2RAD );
			stages.pathTracer?.setUniform( uniform, panoScratch );

		};

		return {

			handleCameraProjection: ( value ) => {

				const isPanorama = value === 'equirectangular';
				stages.pathTracer?.setUniform( 'cameraProjection', isPanorama ? 1 : 0 );

				if ( ! isPanorama ) return;

				// ASVGF is driven entirely by MotionVector, which unprojects through
				// projectionMatrixInverse — meaningless once every pixel is its own direction.
				// Fall back to the spatial-only denoiser rather than leaving no strategy.
				if ( denoisingManager?.denoiserStrategy === 'asvgf' ) denoisingManager.setDenoiserStrategy( 'edgeaware' );
				// Auto-focus raycasts via Raycaster.setFromCamera, which only knows the frustum.
				cameraManager?.setAutoFocusMode( 'manual' );

			},

			handlePanoramaLonRange: ( value ) => setPanoRange( 'panoLonRange', value ),

			handlePanoramaLatRange: ( value ) => setPanoRange( 'panoLatRange', value ),

			handleTransparentBackground: ( value ) => {

				stages.pathTracer?.setUniform( 'transparentBackground', value );
				stages.compositor?.setTransparentBackground( value );

			},

			handleBackgroundColor: ( value ) => {

				// Accept a hex string ('#rrggbb') or a Color; THREE.Color converts sRGB → linear working
				// space, which is what the shader adds to radiance.
				const c = value?.isColor ? value : new Color( value );
				stages.pathTracer?.setUniform( 'backgroundColor', c );

			},

			handleExposure: ( value ) => {

				// Three.js applies toneMappingExposure inside the tone-mapping branch,
				// so this has no effect when renderer.toneMapping === NoToneMapping.
				if ( ! stages.autoExposure?.enabled && renderer ) {

					renderer.toneMappingExposure = value;

				}

			},

			handleSaturation: ( value ) => {

				stages.compositor?.setSaturation( value );

			},

			handleConvergenceOverlay: ( value ) => {

				stages.pathTracer?.setUniform( 'convergenceOverlay', value );
				stages.compositor?.setConvergenceOverlay( value );

				// With adaptive sampling off nothing kept m2 current, so the estimate has no history to
				// read — restart accumulation so it self-inits at frame 0 instead of painting stale error.
				if ( value && ! this.get( 'useAdaptiveSampling' ) ) resetCallback?.();

			},

			handleRenderLimitMode: ( value ) => {

				stages.pathTracer?.setRenderLimitMode?.( value );
				reconcileCompletion?.();

			},

			handleMaxSamples: ( value ) => {

				stages.pathTracer?.setUniform( 'maxSamples', value );
				stages.pathTracer?.updateCompletionThreshold();
				reconcileCompletion?.();

			},

			handleRenderTimeLimit: () => {

				reconcileCompletion?.();

			},

			handleRenderMode: ( value ) => {

				stages.pathTracer?.setUniform( 'renderMode', parseInt( value ) );

			},

			handleEnvironmentRotation: ( value ) => {

				stages.pathTracer?.environment.setEnvironmentRotation( value );

			},

			handleInteractionModeEnabled: ( value ) => {

				stages.pathTracer?.setInteractionModeEnabled( value );

			},

		};

	}

	/**
	 * Sets a single render parameter.
	 * @param {string} key
	 * @param {*}      value
	 * @param {Object}  [options]
	 * @param {boolean} [options.reset]  - Override the route's default reset behavior
	 * @param {boolean} [options.silent] - Suppress the settingChanged event
	 */
	set( key, value, { reset, silent, source = SETTING_SOURCE.HOST } = {} ) {

		const prev = this._values.get( key );
		if ( prev === value ) return;

		this._values.set( key, value );
		this._sources.set( key, source );

		const route = SETTING_ROUTES[ key ];
		if ( ! route ) {

			this._reportUnknownKey( key );
			return;

		}

		this._applyRoute( route, value, prev );

		const shouldReset = reset !== undefined ? reset : ( route.reset ?? true );
		if ( shouldReset ) this._resetCallback?.();

		if ( ! silent ) {

			this.dispatchEvent( { type: EngineEvents.SETTING_CHANGED, key, value, prev } );

		}

	}

	/**
	 * Batch-update multiple settings. Only calls reset() once at the end.
	 * @param {Object} updates - Key/value pairs
	 * @param {Object} [options]
	 * @param {boolean} [options.silent] - Suppress settingChanged events
	 * @param {boolean} [options.reset]  - Override the routes' default reset behavior
	 */
	setMany( updates, { silent, reset, source = SETTING_SOURCE.HOST } = {} ) {

		let needsReset = false;

		for ( const [ key, value ] of Object.entries( updates ) ) {

			const prev = this._values.get( key );
			if ( prev === value ) continue;

			this._values.set( key, value );
			this._sources.set( key, source );

			const route = SETTING_ROUTES[ key ];
			if ( ! route ) {

				this._reportUnknownKey( key );
				continue;

			}

			this._applyRoute( route, value, prev );

			if ( route.reset ?? true ) needsReset = true;

			if ( ! silent ) {

				this.dispatchEvent( { type: EngineEvents.SETTING_CHANGED, key, value, prev } );

			}

		}

		const shouldReset = reset !== undefined ? reset : needsReset;
		if ( shouldReset ) this._resetCallback?.();

	}

	/**
	 * A key with no route is stored and never applied — the caller believes it took effect and
	 * the render silently ignores it, which is how a typo becomes a wrong image.
	 * @private
	 */
	_reportUnknownKey( key ) {

		this._issues?.record(
			ISSUE_CODES.SETTING_UNKNOWN_KEY,
			`unknown setting "${key}" — stored but never applied to any stage`,
			{ key }
		);

	}

	get( key ) {

		return this._values.get( key );

	}

	/**
	 * Every live setting with the value in force and who put it there.
	 *
	 * The engine ships defaults a caller cannot guess — environmentRotation is 270, not 0 —
	 * and then a model's authored metadata or a mode preset overwrites some of them silently.
	 * Comparing a render against another renderer without this means bisecting to find which
	 * layer moved a number.
	 *
	 * @returns {Object<string, {value: *, source: string, routed: boolean}>}
	 */
	getEffective() {

		const out = {};

		for ( const [ key, value ] of this._values ) {

			out[ key ] = {
				value,
				source: this._sources.get( key ) ?? SETTING_SOURCE.DEFAULT,
				// False means the value is stored but reaches no stage — see _reportUnknownKey.
				routed: SETTING_ROUTES[ key ] !== undefined,
			};

		}

		return out;

	}

	/** Where one setting's current value came from. */
	sourceOf( key ) {

		return this._sources.get( key ) ?? null;

	}

	getAll() {

		return Object.fromEntries( this._values );

	}

	/**
	 * Pushes all stored values to their target stages.
	 * Called after loadSceneData() to ensure GPU uniforms match stored values.
	 */
	applyAll() {

		for ( const [ key, value ] of this._values ) {

			const route = SETTING_ROUTES[ key ];
			if ( ! route ) continue;

			// prev is undefined on initial apply — handlers should not rely on it
			this._applyRoute( route, value, undefined );

		}

	}

	// ── Private ───────────────────────────────────────────────────

	_applyRoute( route, value, prev ) {

		if ( route.uniform ) {

			this._pathTracer?.setUniform( route.uniform, value );
			if ( route.after ) this._pathTracer?.[ route.after ]?.();

		} else if ( route.handler ) {

			this._handlers[ route.handler ]?.( value, prev );

		} else if ( route.delegate ) {

			this._delegates[ route.delegate ]?.updateParam?.( route.param, value );

		}

	}

	/**
	 * Populates the values map from ENGINE_DEFAULTS.
	 * Handles key renames via DEFAULTS_KEY_MAP.
	 */
	_initDefaults( defaults ) {

		// Keys that exist in both SETTING_ROUTES and ENGINE_DEFAULTS (direct match)
		for ( const key of Object.keys( SETTING_ROUTES ) ) {

			if ( key in defaults ) {

				this._values.set( key, defaults[ key ] );
				this._sources.set( key, SETTING_SOURCE.DEFAULT );

			}

		}

		// Keys where ENGINE_DEFAULTS uses a different name
		for ( const [ defaultsKey, settingsKey ] of Object.entries( DEFAULTS_KEY_MAP ) ) {

			if ( defaultsKey in defaults ) {

				this._values.set( settingsKey, defaults[ defaultsKey ] );
				this._sources.set( settingsKey, SETTING_SOURCE.DEFAULT );

			}

		}

	}

}
