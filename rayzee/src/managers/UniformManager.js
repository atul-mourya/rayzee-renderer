/**
 * UniformManager.js
 * Manages all TSL uniform nodes for the path tracing pipeline.
 * Uniform nodes are created once and never replaced — only .value is mutated.
 * This preserves TSL shader graph references after compilation.
 */

import { uniform, uniformArray } from 'three/tsl';
import { Vector2, Matrix4, Vector3, Color, MathUtils } from 'three';
import { samplingTechniqueUniform } from '../TSL/Random.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE } from '../EngineDefaults.js';

/**
 * Map of uniform names to their WGSL shader names (where different).
 * Most uniforms use the same name for both key and shader name.
 */
const SHADER_NAMES = {
	cameraViewMatrix: 'ptCameraViewMatrix',
	cameraProjectionMatrix: 'ptCameraProjectionMatrix',
};

export class UniformManager {

	constructor( width = 1920, height = 1080 ) {

		/** @type {Map<string, import('three/tsl').UniformNode>} */
		this._uniforms = new Map();

		/** @type {Set<string>} Uniforms that store boolean values as int 0/1 */
		this._booleans = new Set();

		/** @type {Object} Light buffer uniformArray nodes */
		this._lightBuffers = {};

		this._initUniforms( width, height );
		this._nameAll();

	}

	/**
	 * Get a uniform node by name.
	 * @param {string} name
	 * @returns {import('three/tsl').UniformNode}
	 */
	get( name ) {

		return this._uniforms.get( name );

	}

	/**
	 * Set a uniform's value. Auto-handles booleans (→ int 0/1),
	 * vectors/matrices (→ .copy()), and plain scalars.
	 * @param {string} name
	 * @param {*} value
	 */
	set( name, value ) {

		const node = this._uniforms.get( name );
		if ( ! node ) {

			console.warn( `UniformManager: Unknown uniform "${name}"` );
			return;

		}

		if ( this._booleans.has( name ) ) {

			node.value = value ? 1 : 0;

		} else if ( value != null && typeof value === 'object' && typeof node.value?.copy === 'function' ) {

			node.value.copy( value );

		} else {

			node.value = value;

		}

	}

	/**
	 * Check if a uniform exists.
	 * @param {string} name
	 * @returns {boolean}
	 */
	has( name ) {

		return this._uniforms.has( name );

	}

	/**
	 * Returns an iterator over uniform names.
	 * @returns {IterableIterator<string>}
	 */
	keys() {

		return this._uniforms.keys();

	}

	/**
	 * Get the light buffer uniformArray nodes.
	 * @returns {{ directional: UniformArrayNode, area: UniformArrayNode, point: UniformArrayNode, spot: UniformArrayNode }}
	 */
	getLightBufferNodes() {

		return this._lightBuffers;

	}

	/**
	 * Batch-update multiple uniforms at once.
	 * @param {Object} updates - Map of uniform name → value
	 * @returns {boolean} True if any values changed
	 */
	updateMany( updates ) {

		let hasChanges = false;

		for ( const [ key, value ] of Object.entries( updates ) ) {

			const node = this._uniforms.get( key );
			if ( node && node.value !== value ) {

				node.value = value;
				hasChanges = true;

			}

		}

		return hasChanges;

	}

	/**
	 * Initialize all uniforms.
	 * @private
	 */
	_initUniforms( width, height ) {

		const u = ( name, value, type ) => {

			const node = uniform( value, type );
			this._uniforms.set( name, node );
			return node;

		};

		// Boolean uniform helper (stores as int 0/1, auto-converts on set)
		const ub = ( name, value ) => {

			this._booleans.add( name );
			return u( name, value ? 1 : 0, 'int' );

		};

		// Frame and sampling
		u( 'frame', 0, 'uint' );
		// Sampler seed axis, separate from the accumulation index: `frame` is zeroed by every
		// reset, and a camera move resets each frame of a drag, so the RNG redrew the identical
		// sequence and temporal denoising had nothing to average.
		u( 'seedFrame', 0, 'uint' );
		u( 'maxBounces', DEFAULT_STATE.bounces, 'int' );
		u( 'maxSamples', DEFAULT_STATE.maxSamples, 'int' );
		u( 'transmissiveBounces', DEFAULT_STATE.transmissiveBounces, 'int' );
		u( 'maxSubsurfaceSteps', DEFAULT_STATE.maxSubsurfaceSteps, 'int' );
		u( 'maxTransparentBounces', DEFAULT_STATE.maxTransparentBounces, 'int' );
		u( 'visMode', DEFAULT_STATE.debugMode, 'int' );
		u( 'debugVisScale', DEFAULT_STATE.debugVisScale, 'float' );

		// Tier-1 convergence early-stop (FinalWrite reads these; live-toggled, no shader rebuild)
		ub( 'useAdaptiveSampling', DEFAULT_STATE.useAdaptiveSampling );
		u( 'noiseThreshold', DEFAULT_STATE.noiseThreshold, 'float' );
		u( 'adaptiveMinSamples', DEFAULT_STATE.adaptiveMinSamples, 'int' );
		// CPU-only (read in PathTracer._isConvergedComplete, not bound to any kernel); registered here for
		// the settings/configureForMode plumbing + the _defineUniformGetters accessor.
		u( 'adaptiveStopFraction', DEFAULT_STATE.adaptiveStopFraction, 'float' );

		// Tier-2 per-pixel freeze. usePixelFreeze gates both FinalWrite (stamp + pass-through) and render()'s
		// frozen-compaction dispatch path.
		ub( 'usePixelFreeze', DEFAULT_STATE.usePixelFreeze );
		u( 'pixelFreezeThreshold', DEFAULT_STATE.pixelFreezeThreshold, 'float' );
		u( 'pixelFreezeStability', DEFAULT_STATE.pixelFreezeStability, 'int' );

		// Convergence debug overlay: keeps FinalWrite's m2 estimate alive when adaptive sampling is off,
		// so the Compositor overlay reads a live error field instead of a stale buffer.
		ub( 'convergenceOverlay', DEFAULT_STATE.convergenceOverlay );

		// Accumulation
		ub( 'enableAccumulation', true );
		u( 'accumulationAlpha', 0.0, 'float' );
		ub( 'cameraIsMoving', false );
		ub( 'hasPreviousAccumulated', false );

		// Environment
		u( 'environmentIntensity', DEFAULT_STATE.environmentIntensity, 'float' );
		u( 'backgroundIntensity', DEFAULT_STATE.backgroundIntensity, 'float' );
		u( 'backgroundColor', new Color( 0, 0, 0 ), 'color' ); // linear; solid backdrop in 'color' mode
		u( 'backgroundBlurriness', DEFAULT_STATE.backgroundBlurriness, 'float' );
		u( 'backgroundBlurSamples', DEFAULT_STATE.backgroundBlurSamples, 'int' );
		ub( 'showBackground', DEFAULT_STATE.showBackground );
		ub( 'transparentBackground', DEFAULT_STATE.transparentBackground );
		ub( 'enableEnvironment', DEFAULT_STATE.enableEnvironment );
		u( 'environmentMatrix', new Matrix4(), 'mat4' );
		u( 'envTotalSum', 0.0, 'float' );
		u( 'envCompensationDelta', 0.0, 'float' );
		u( 'envResolution', new Vector2( 1, 1 ), 'vec2' );
		ub( 'groundProjectionEnabled', DEFAULT_STATE.groundProjectionEnabled );
		u( 'groundProjectionRadius', DEFAULT_STATE.groundProjectionRadius, 'float' );
		u( 'groundProjectionHeight', DEFAULT_STATE.groundProjectionHeight, 'float' );
		u( 'groundProjectionLevel', DEFAULT_STATE.groundProjectionLevel, 'float' );
		ub( 'enableGroundCatcher', DEFAULT_STATE.enableGroundCatcher );
		u( 'groundCatcherHeight', DEFAULT_STATE.groundCatcherHeight, 'float' );

		// Sun parameters
		u( 'sunDirection', new Vector3( 0, 1, 0 ), 'vec3' );
		u( 'sunAngularSize', 0.0087, 'float' );
		ub( 'hasSun', false );

		// Lighting
		u( 'globalIlluminationIntensity', DEFAULT_STATE.globalIlluminationIntensity, 'float' );
		u( 'exposure', DEFAULT_STATE.exposure, 'float' );

		// Light counts
		u( 'numDirectionalLights', 0, 'int' );
		u( 'numAreaLights', 0, 'int' );
		u( 'numPointLights', 0, 'int' );
		u( 'numSpotLights', 0, 'int' );

		// Light buffer nodes - pre-allocate for up to 16 lights per type (shader hard cap)
		this._lightBuffers = {
			directional: uniformArray( new Float32Array( 12 * 16 ), 'float' ),
			area: uniformArray( new Float32Array( 16 * 16 ), 'float' ),
			point: uniformArray( new Float32Array( 9 * 16 ), 'float' ),
			spot: uniformArray( new Float32Array( 20 * 16 ), 'float' ),
		};

		// Camera matrices
		u( 'cameraWorldMatrix', new Matrix4(), 'mat4' );
		u( 'cameraProjectionMatrixInverse', new Matrix4(), 'mat4' );
		u( 'cameraViewMatrix', new Matrix4(), 'mat4' );
		u( 'cameraProjectionMatrix', new Matrix4(), 'mat4' );

		// Projection: 0 = pinhole, 1 = equirectangular panorama. Ranges are radians (UI carries degrees).
		const radRange = ( [ min, max ] ) => new Vector2( min, max ).multiplyScalar( MathUtils.DEG2RAD );
		u( 'cameraProjection', DEFAULT_STATE.cameraProjection === 'equirectangular' ? 1 : 0, 'int' );
		u( 'panoLonRange', radRange( DEFAULT_STATE.panoramaLonRange ), 'vec2' );
		u( 'panoLatRange', radRange( DEFAULT_STATE.panoramaLatRange ), 'vec2' );
		ub( 'panoLevelHorizon', DEFAULT_STATE.panoramaLevelHorizon );

		// DOF
		ub( 'enableDOF', DEFAULT_STATE.enableDOF );
		u( 'focusDistance', DEFAULT_STATE.focusDistance, 'float' );
		u( 'focalLength', DEFAULT_STATE.focalLength, 'float' );
		u( 'aperture', DEFAULT_STATE.aperture, 'float' );
		u( 'apertureScale', 1.0, 'float' );
		u( 'anamorphicRatio', DEFAULT_STATE.anamorphicRatio ?? 1.0, 'float' );
		u( 'sceneScale', 1.0, 'float' );

		// Sampling — use the module-level uniform from Random.js so TSL sees the same node
		this._uniforms.set( 'samplingTechnique', samplingTechniqueUniform );
		samplingTechniqueUniform.value = DEFAULT_STATE.samplingTechnique;

		u( 'fireflyThreshold', DEFAULT_STATE.fireflyThreshold, 'float' );

		// Emissive
		ub( 'enableEmissiveTriangleSampling', DEFAULT_STATE.enableEmissiveTriangleSampling );
		u( 'emissiveBoost', DEFAULT_STATE.emissiveBoost, 'float' );
		u( 'emissiveTriangleCount', 0, 'int' );
		u( 'emissiveTotalPower', 0.0, 'float' );
		u( 'lightBVHNodeCount', 0, 'int' );
		// Offset (in vec4 elements) within the packed light buffer where emissive
		// triangle data starts. Equals lightBVHNodeCount * LBVH_STRIDE; computed on upload.
		u( 'emissiveVec4Offset', 0, 'int' );
		// Offset (in vec4 elements) within the packed light buffer where the per-triangle
		// bit-trail map starts (4 trails packed per vec4); computed on upload. Used by the
		// bounce-hit MIS path to re-walk the Light BVH descent pdf.
		u( 'reverseMapVec4Offset', 0, 'int' );

		// Render mode
		u( 'renderMode', DEFAULT_STATE.renderMode, 'int' );
		ub( 'enableAlphaShadows', DEFAULT_STATE.enableAlphaShadows );

		// Resolution (for RNG seeding)
		u( 'resolution', new Vector2( width, height ), 'vec2' );

	}

	/**
	 * Assign .name on each uniform node for WGSL debugging.
	 * Uses SHADER_NAMES overrides where the WGSL name differs from the key.
	 * @private
	 */
	_nameAll() {

		for ( const [ key, node ] of this._uniforms ) {

			node.name = SHADER_NAMES[ key ] || key;

		}

	}

	/**
	 * Releases uniform node references. Safe to call multiple times.
	 *
	 * Note: TSL uniform nodes are registered in the shader graph — once a
	 * compiled pipeline references them they are kept alive by the renderer
	 * until the pipeline is disposed. Clearing our maps here just drops the
	 * JS-side strong refs so UniformManager itself can be collected.
	 */
	dispose() {

		if ( this._disposed ) return;
		this._disposed = true;

		this._uniforms.clear();
		this._booleans.clear();
		this._lightBuffers = {};

	}

}
