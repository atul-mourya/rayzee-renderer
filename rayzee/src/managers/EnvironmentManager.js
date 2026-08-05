/**
 * EnvironmentManager.js
 * Manages HDRI loading, CDF importance sampling, procedural/gradient/solid sky
 * generation, and environment rotation for the path tracing pipeline.
 *
 * Storage buffer nodes are created once and never replaced — only .value
 * is mutated to preserve TSL shader graph references after compilation.
 */

import {
	RGBAFormat, RedFormat, FloatType, LinearFilter, Vector2, Vector3, Color, Matrix4, DataTexture,
} from 'three';
import { EquirectHDRInfo } from '../Processor/EquirectHDRInfo.js';
import { ProceduralSky } from '../Processor/ProceduralSky.js';
import { SimpleSky } from '../Processor/SimpleSky.js';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'env' );
import { ENGINE_DEFAULTS as DEFAULT_STATE } from '../EngineDefaults.js';

export class EnvironmentManager {

	/**
	 * @param {Object} scene - Three.js scene
	 * @param {import('./UniformManager').UniformManager} uniforms
	 */
	constructor( scene, uniforms ) {

		this.scene = scene;
		this.uniforms = uniforms;

		// CDF computation engine
		this.equirectHdrInfo = new EquirectHDRInfo();

		// Sky renderers (lazy init)
		this.proceduralSkyRenderer = null;
		this.simpleSkyRenderer = null;

		// Environment texture — 1×1 black placeholder for shader compilation. Filters must be
		// Linear: DataTexture defaults to Nearest, which is unfilterable, and WGSLNodeBuilder then
		// omits the `_sampler` binding that sampleEnvironment() takes as an explicit wgslFn arg.
		this._envPlaceholder = new DataTexture(
			new Float32Array( [ 0, 0, 0, 1 ] ), 1, 1, RGBAFormat, FloatType,
			undefined, undefined, undefined, LinearFilter, LinearFilter
		);
		this._envPlaceholder.needsUpdate = true;
		this.environmentTexture = this._envPlaceholder;
		this.envTexSize = new Vector2();

		// Importance-sampling CDF as an R32F texture (frees a Shade storage-buffer binding — the limit is 10).
		// Layout: (envResolution.x + 1) × envResolution.y; conditional in columns [0,W), marginal in column W.
		this.envCDFTexture = null;
		this._initCDFTexture();

		// Environment rotation
		this.environmentRotationMatrix = new Matrix4();

		// CDF timing
		this.cdfBuildTime = 0;

		// Environment parameters (CPU-side)
		this.envParams = {
			mode: 'hdri',

			// Gradient Sky
			gradientZenithColor: new Color( DEFAULT_STATE.gradientZenithColor ),
			gradientHorizonColor: new Color( DEFAULT_STATE.gradientHorizonColor ),
			gradientGroundColor: new Color( DEFAULT_STATE.gradientGroundColor ),

			// Solid Color Sky
			solidSkyColor: new Color( DEFAULT_STATE.solidSkyColor ),

			// Procedural Sky (Preetham Model)
			skySunDirection: this._calculateInitialSunDirection(),
			skySunIntensity: DEFAULT_STATE.skySunIntensity,
			skyRayleighDensity: DEFAULT_STATE.skyRayleighDensity,
			skyTurbidity: DEFAULT_STATE.skyTurbidity,
			skyMieAnisotropy: DEFAULT_STATE.skyMieAnisotropy,
		};

		/**
		 * Optional callbacks set by the owning stage.
		 * @type {{ onReset?: Function, onAutoExposureReset?: Function, getSceneTextureNodes?: Function }}
		 */
		this.callbacks = {};

		// Mode state machine (absorbed from EnvironmentAPI)
		this._previousHDRI = null;

	}

	// ===== MODE STATE MACHINE =====

	/**
	 * Switches the environment mode (hdri, gradient, color, procedural).
	 * Preserves the HDRI texture when switching away, restores when switching back.
	 * @param {'hdri'|'gradient'|'color'|'procedural'} mode
	 */
	async setMode( mode ) {

		const prev = this.envParams.mode;
		this.envParams.mode = mode;

		// Cache HDRI texture when leaving HDRI mode
		if ( mode !== 'hdri' && prev === 'hdri' ) {

			this._previousHDRI = this.environmentTexture;

		}

		if ( mode === 'gradient' ) {

			await this.generateGradientTexture();

		} else if ( mode === 'color' ) {

			await this.generateSolidColorTexture();

		} else if ( mode === 'procedural' ) {

			await this.generateProceduralSkyTexture();

		} else if ( mode === 'hdri' && this._previousHDRI ) {

			await this.setEnvironmentMap( this._previousHDRI );
			this._previousHDRI = null;

		}

		this.markDirty();
		this.callbacks.onAutoExposureReset?.();
		this._notifyReset();

	}

	/**
	 * Marks the environment texture as needing GPU re-upload on the next frame.
	 */
	markDirty() {

		if ( this.environmentTexture ) this.environmentTexture.needsUpdate = true;

	}

	// ===== Aliases (match Sub-API surface for zero-churn migration) =====

	/** @see envParams */
	get params() {

		return this.envParams;

	}

	/** @see environmentTexture */
	get texture() {

		return this.environmentTexture;

	}

	/** @see generateGradientTexture */
	generateGradient() {

		return this.generateGradientTexture();

	}

	/** @see generateSolidColorTexture */
	generateSolid() {

		return this.generateSolidColorTexture();

	}

	/** @see generateProceduralSkyTexture */
	generateProcedural() {

		return this.generateProceduralSkyTexture();

	}

	// ===== CDF STORAGE BUFFER =====

	/**
	 * Initialize the packed CDF storage buffer with placeholder data.
	 * Must be called before shader compilation so the node exists in the graph.
	 *
	 * 1×1 R32F placeholder until a real env CDF is built (env IS is off meanwhile).
	 * @private
	 */
	_initCDFTexture() {

		this.envCDFTexture = new DataTexture( new Float32Array( [ 0 ] ), 1, 1, RedFormat, FloatType );
		this.envCDFTexture.needsUpdate = true;

	}

	/**
	 * Rebuild the CDF texture from equirectHdrInfo. Packs the 2D conditional + 1D marginal into one
	 * R32F texture of (W+1)×H: conditional[cy*W+cx] at texel (cx, cy); marginal[cy] at texel (W, cy).
	 * @private
	 */
	_updateCDFTexture() {

		const marginal = this.equirectHdrInfo.marginalData;
		const conditional = this.equirectHdrInfo.conditionalData;
		if ( ! marginal || ! conditional ) return;

		const W = this.equirectHdrInfo.width;
		const H = this.equirectHdrInfo.height;
		const texW = W + 1;
		const data = new Float32Array( texW * H );
		for ( let cy = 0; cy < H; cy ++ ) {

			const dstRow = cy * texW;
			data.set( conditional.subarray( cy * W, cy * W + W ), dstRow ); // conditional → columns [0,W)
			data[ dstRow + W ] = marginal[ cy ]; // marginal → column W

		}

		this.envCDFTexture?.dispose?.();
		this.envCDFTexture = new DataTexture( data, texW, H, RedFormat, FloatType );
		this.envCDFTexture.needsUpdate = true;

	}

	// ===== ENVIRONMENT TEXTURE =====

	/**
	 * Sets the environment map texture reference and size.
	 * @param {import('three').Texture} envTex
	 */
	setEnvironmentTexture( envTex ) {

		if ( ! envTex ) return;

		this.environmentTexture = envTex;
		this.envTexSize.set( envTex.image.width, envTex.image.height );

	}

	/**
	 * Get the current environment texture.
	 * @returns {import('three').Texture}
	 */
	getEnvironmentTexture() {

		return this.environmentTexture;

	}

	// ===== ENVIRONMENT ROTATION =====

	/**
	 * Set environment rotation from degrees.
	 * @param {number} rotationDegrees
	 */
	setEnvironmentRotation( rotationDegrees ) {

		const rotationRadians = rotationDegrees * ( Math.PI / 180 );
		this.environmentRotationMatrix.makeRotationY( rotationRadians );
		this.uniforms.get( 'environmentMatrix' ).value.copy( this.environmentRotationMatrix );

	}

	// ===== CDF BUILDING =====

	/**
	 * Build environment CDF for importance sampling.
	 * @param {Object} [options]
	 * @param {boolean} [options.useWorker=true]
	 */
	async buildEnvironmentCDF( { useWorker = true } = {} ) {

		if ( ! this.scene.environment ) {

			this._updateCDFTexture();
			this.uniforms.set( 'envTotalSum', 0.0 );
			this.uniforms.set( 'envCompensationDelta', 0.0 );
			return;

		}

		try {

			const startTime = performance.now();
			const textureForCDF = this.scene.environment;

			if ( ! textureForCDF.image ) {

				this._updateCDFTexture();
				this.uniforms.set( 'envTotalSum', 0.0 );
				this.uniforms.set( 'envCompensationDelta', 0.0 );
				return;

			}

			if ( useWorker ) {

				await this.equirectHdrInfo.updateFromAsync( textureForCDF );

			} else {

				this.equirectHdrInfo.updateFrom( textureForCDF );

			}

			this.cdfBuildTime = performance.now() - startTime;

			this._updateCDFTexture();
			this.uniforms.set( 'envTotalSum', this.equirectHdrInfo.totalSum );
			this.uniforms.set( 'envCompensationDelta', this.equirectHdrInfo.compensationDelta );

			const { width, height } = this.equirectHdrInfo;
			if ( width && height ) {

				this.uniforms.get( 'envResolution' ).value.set( width, height );

			}

			log.info( fmt.list( [
				fmt.px( this.envTexSize.x, this.envTexSize.y ),
				`CDF ${fmt.ms( this.cdfBuildTime )}${useWorker ? '' : ' (main thread)'}`,
			] ) );

		} catch ( error ) {

			log.error( 'CDF build failed:', error );
			this.uniforms.set( 'envTotalSum', 0.0 );
			this.uniforms.set( 'envCompensationDelta', 0.0 );

		}

	}

	/**
	 * Apply CDF results and update TSL env texture nodes after a parallel CDF build.
	 */
	applyCDFResults() {

		const envMap = this.scene.environment;

		const nodes = this.callbacks.getSceneTextureNodes?.();
		if ( nodes && envMap && nodes.envTex ) {

			nodes.envTex.value = envMap;

		}

		if ( envMap && ! envMap._isGeneratedProcedural ) {

			this.uniforms.set( 'hasSun', 0 );

		}

	}

	// ===== ENVIRONMENT MAP LOADING =====

	/**
	 * Set environment map, build CDF, and update shader texture nodes.
	 * @param {import('three').Texture|null} envMap
	 */
	async setEnvironmentMap( envMap ) {

		// Free the outgoing env texture's GPU memory before it is orphaned. Skip: the
		// reusable placeholder, an idempotent re-set of the same texture, and the HDRI
		// stashed by setMode() for a later sky→hdri restore. Only when actually
		// installing a new non-null texture (the null-env branch keeps the old ref).
		const oldTex = this.environmentTexture;
		if ( envMap && oldTex && oldTex !== envMap && oldTex !== this._envPlaceholder && oldTex !== this._previousHDRI ) {

			oldTex.dispose?.();

		}

		this.scene.environment = envMap;
		this.setEnvironmentTexture( envMap );

		if ( envMap ) {

			await this.buildEnvironmentCDF();

		} else {

			this._updateCDFTexture();
			this.uniforms.set( 'envTotalSum', 0.0 );
			this.uniforms.set( 'envCompensationDelta', 0.0 );

		}

		// Update TSL texture nodes so the shader sees the new environment
		const nodes = this.callbacks.getSceneTextureNodes?.();
		if ( nodes ) {

			if ( envMap && nodes.envTex ) {

				nodes.envTex.value = envMap;

			}

		}

		if ( envMap && ! envMap._isGeneratedProcedural ) {

			this.uniforms.set( 'hasSun', 0 );

		}

		this._notifyReset();

	}

	// ===== SKY GENERATORS =====

	/**
	 * Generate gradient sky texture and set as environment.
	 */
	async generateGradientTexture() {

		if ( ! this.simpleSkyRenderer ) {

			this.simpleSkyRenderer = new SimpleSky( 512, 256 );

		}

		const params = {
			zenithColor: this.envParams.gradientZenithColor,
			horizonColor: this.envParams.gradientHorizonColor,
			groundColor: this.envParams.gradientGroundColor,
		};

		try {

			const texture = this.simpleSkyRenderer.renderGradient( params );
			texture._isGeneratedProcedural = true;
			await this.setEnvironmentMap( texture );
			this.uniforms.set( 'hasSun', 0 );

		} catch ( error ) {

			log.error( 'gradient sky generation failed:', error );

		}

	}

	/**
	 * Generate solid color sky texture and set as environment.
	 */
	async generateSolidColorTexture() {

		if ( ! this.simpleSkyRenderer ) {

			this.simpleSkyRenderer = new SimpleSky( 512, 256 );

		}

		const params = {
			color: this.envParams.solidSkyColor,
		};

		try {

			const texture = this.simpleSkyRenderer.renderSolid( params );
			texture._isGeneratedProcedural = true;
			await this.setEnvironmentMap( texture );
			this.uniforms.set( 'hasSun', 0 );

		} catch ( error ) {

			log.error( 'solid color sky generation failed:', error );

		}

	}

	/**
	 * Generate procedural (Preetham) sky texture and set as environment.
	 */
	async generateProceduralSkyTexture() {

		if ( ! this.proceduralSkyRenderer ) {

			this.proceduralSkyRenderer = new ProceduralSky( 512, 256 );

		}

		const params = {
			sunDirection: this.envParams.skySunDirection.clone(),
			sunIntensity: this.envParams.skySunIntensity * 0.05,
			rayleighDensity: this.envParams.skyRayleighDensity * 2.0,
			mieDensity: this.envParams.skyTurbidity * 0.005,
			mieAnisotropy: this.envParams.skyMieAnisotropy,
			turbidity: this.envParams.skyTurbidity * 2.0,
		};

		try {

			const texture = this.proceduralSkyRenderer.render( params );
			texture._isGeneratedProcedural = true;
			await this.setEnvironmentMap( texture );

			this.uniforms.get( 'sunDirection' ).value.copy( this.envParams.skySunDirection );
			this.uniforms.set( 'sunAngularSize', 0.0087 );
			this.uniforms.set( 'hasSun', 1 );

			log.debug( `sun synced · dir ${this.envParams.skySunDirection.toArray().map( v => v.toFixed( 2 ) ).join( ',' )}` );

		} catch ( error ) {

			log.error( 'procedural sky generation failed:', error );

		}

	}

	// ===== HELPERS =====

	/** @private */
	_calculateInitialSunDirection() {

		const azimuth = DEFAULT_STATE.skySunAzimuth * ( Math.PI / 180 );
		const elevation = DEFAULT_STATE.skySunElevation * ( Math.PI / 180 );
		return new Vector3(
			Math.cos( elevation ) * Math.sin( azimuth ),
			Math.sin( elevation ),
			Math.cos( elevation ) * Math.cos( azimuth )
		).normalize();

	}

	/** @private */
	_notifyReset() {

		if ( this.callbacks.onReset ) {

			this.callbacks.onReset();

		}

	}

	// ===== DISPOSAL =====

	dispose() {

		this.proceduralSkyRenderer = null;
		this.simpleSkyRenderer = null;

		this.envCDFTexture?.dispose?.();
		this.envCDFTexture = null;

		// Dispose the HDRI environment texture unless it's the shared placeholder
		// (the placeholder is handled separately just below).
		if ( this.environmentTexture && this.environmentTexture !== this._envPlaceholder ) {

			this.environmentTexture.dispose?.();

		}

		this._envPlaceholder?.dispose();
		this._envPlaceholder = null;
		this.environmentTexture = null;
		this._previousHDRI = null;

	}

}
