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
import { PhysicalSky } from '../Processor/PhysicalSky.js';
import { SimpleSky } from '../Processor/SimpleSky.js';
import { convertLinearTriple } from '../Color/WorkingMatrix.js';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'env' );
import { ENGINE_DEFAULTS as DEFAULT_STATE } from '../EngineDefaults.js';
import { getActiveColorManagement } from '../Color/ColorManagement.js';
import { loadCDF, saveCDF } from '../Storage/CDFCache.js';

const SKY_WIDTH = 1024;
const SKY_HEIGHT = 512;
const DEG2RAD = Math.PI / 180;
const _rotation = new Matrix4();

// Bakes queued on the GPU at once. More only queue behind frames already waiting there.
const SKY_BAKES_IN_FLIGHT = 4;

export class EnvironmentManager {

	/**
	 * @param {Object} scene - Three.js scene
	 * @param {import('./UniformManager').UniformManager} uniforms
	 * @param {import('three/webgpu').WebGPURenderer} [renderer] - bakes the physical sky
	 */
	constructor( scene, uniforms, renderer = null ) {

		this.scene = scene;
		this.uniforms = uniforms;
		this.renderer = renderer;

		// CDF computation engine
		this.equirectHdrInfo = new EquirectHDRInfo();

		// Sky renderers (lazy init)
		this.physicalSky = null;
		this.simpleSkyRenderer = null;
		this._sun = null;
		this._skyRequested = false;
		this._skyScheduled = false;
		this._skyInFlight = 0;
		this._skyCaughtUp = null;
		this._resolveSky = null;
		this._skyBakes = 0;
		this._skyStatsBake = 0;

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

			// Physical sky. The sun direction is in the sky's own frame; environment rotation turns both.
			skySunDirection: this._calculateInitialSunDirection(),
			skySunStrength: DEFAULT_STATE.skySunStrength,
			skySunSize: DEFAULT_STATE.skySunSize,
			skyTurbidity: DEFAULT_STATE.skyTurbidity,
			skyOzone: DEFAULT_STATE.skyOzone,
			skyAirDensity: DEFAULT_STATE.skyAirDensity,
			skyGroundAlbedo: new Color( DEFAULT_STATE.skyGroundAlbedo ),
			skyAltitude: DEFAULT_STATE.skyAltitude,
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
	 * Switches the environment mode (hdri, gradient, color, procedural — the physical sky).
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

		if ( mode !== 'procedural' && prev === 'procedural' ) this._releaseSky();

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

	// ===== SAVED SESSIONS =====

	/** Where the HDRI came from (see Storage/CDFCache.js), shown or held while a sky is. */
	get hdriSource() {

		const hdri = this.envParams.mode === 'hdri' ? this.environmentTexture : this._previousHDRI;
		return hdri?.userData?.__rayzeeSource ?? null;

	}

	/** The mode, the sky parameters and the HDRI's source, as plain data. */
	serialize() {

		const p = this.envParams;
		return {
			mode: p.mode,
			hdri: this.hdriSource,
			gradientZenithColor: p.gradientZenithColor.toArray(),
			gradientHorizonColor: p.gradientHorizonColor.toArray(),
			gradientGroundColor: p.gradientGroundColor.toArray(),
			solidSkyColor: p.solidSkyColor.toArray(),
			skyModel: 'atmosphere',
			skySunDirection: p.skySunDirection.toArray(),
			skySunStrength: p.skySunStrength,
			skySunSize: p.skySunSize,
			skyTurbidity: p.skyTurbidity,
			skyOzone: p.skyOzone,
			skyAirDensity: p.skyAirDensity,
			skyGroundAlbedo: p.skyGroundAlbedo.toArray(),
			skyAltitude: p.skyAltitude,
		};

	}

	/**
	 * Puts back {@link serialize}'s parameters and mode. The HDRI itself is the caller's to load
	 * first: only it can resolve the source.
	 */
	async restore( state ) {

		if ( ! state ) return;
		const p = this.envParams;
		// Sessions saved before the physical sky gave the same names other meanings.
		const atmosphere = state.skyModel === 'atmosphere';
		const colors = [ 'gradientZenithColor', 'gradientHorizonColor', 'gradientGroundColor', 'solidSkyColor', 'skySunDirection' ];
		for ( const key of atmosphere ? [ ...colors, 'skyGroundAlbedo' ] : colors ) {

			if ( Array.isArray( state[ key ] ) ) p[ key ].fromArray( state[ key ] );

		}

		if ( atmosphere ) {

			for ( const key of [ 'skySunStrength', 'skySunSize', 'skyTurbidity', 'skyOzone', 'skyAirDensity', 'skyAltitude' ] ) {

				if ( typeof state[ key ] === 'number' ) p[ key ] = state[ key ];

			}

		}

		if ( state.mode && ( state.mode !== 'hdri' || p.mode !== 'hdri' ) ) await this.setMode( state.mode );

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

		if ( ! this.envCDFTexture?._isPhysicalSky ) this.envCDFTexture?.dispose?.();
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

		// Before the CDF is built, so importance sampling sees the same pixels the shader will.
		// Inert unless a working space has been adopted; the texture's own space is honoured when
		// the host tagged it, otherwise it is taken as linear Rec.709, which is what every HDRI
		// loader produces.
		const cm = getActiveColorManagement();
		if ( cm?.hasConfig ) {

			try {

				cm.convertTexturePixels( envTex, { space: envTex.userData?.ocioColorSpace ?? null } );

			} catch ( error ) {

				log.warn( `environment colour conversion failed, left in its original space: ${error.message}` );

			}

		}

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
		this.refreshSun();

	}

	// ===== CDF BUILDING =====

	/**
	 * Build environment CDF for importance sampling.
	 * @param {Object} [options]
	 * @param {boolean} [options.useWorker=true]
	 */
	async buildEnvironmentCDF( { useWorker = true } = {} ) {

		if ( ! this.scene.environment ) {

			this._cdfSignature = null;
			this._updateCDFTexture();
			this.uniforms.set( 'envTotalSum', 0.0 );
			this.uniforms.set( 'envCompensationDelta', 0.0 );
			return;

		}

		// Its table is built with it, on the GPU.
		if ( this.scene.environment._isPhysicalSky ) return;

		try {

			const startTime = performance.now();
			const textureForCDF = this.scene.environment;

			if ( ! textureForCDF.image ) {

				this._cdfSignature = null;
				this._updateCDFTexture();
				this.uniforms.set( 'envTotalSum', 0.0 );
				this.uniforms.set( 'envCompensationDelta', 0.0 );
				return;

			}

			// The same pixels as last time: the tables and uniforms already describe them.
			const signature = `${textureForCDF.uuid}:${textureForCDF.version}`;
			if ( signature === this._cdfSignature ) return;

			const cached = await loadCDF( textureForCDF ).catch( () => null );
			if ( cached ) {

				Object.assign( this.equirectHdrInfo, cached );

			} else if ( useWorker ) {

				await this.equirectHdrInfo.updateFromAsync( textureForCDF );

			} else {

				this.equirectHdrInfo.updateFrom( textureForCDF );

			}

			if ( ! cached ) saveCDF( textureForCDF, this.equirectHdrInfo ).catch( () => {} );
			this._cdfSignature = signature;
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
				`CDF ${fmt.ms( this.cdfBuildTime )}${cached ? ' (stored)' : useWorker ? '' : ' (main thread)'}`,
			] ) );

		} catch ( error ) {

			this._cdfSignature = null;
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
	 * @param {Object}  [options]
	 * @param {boolean} [options.buildCDF=true] - Skip when the caller builds the CDF itself
	 *   (PathTracerApp.loadSceneData builds it in parallel with the BVH, then calls applyCDFResults).
	 */
	async setEnvironmentMap( envMap, { buildCDF = true } = {} ) {

		// Free the outgoing env texture's GPU memory before it is orphaned. Skip: the
		// reusable placeholder, an idempotent re-set of the same texture, and the HDRI
		// stashed by setMode() for a later sky→hdri restore. Only when actually
		// installing a new non-null texture (the null-env branch keeps the old ref).
		const oldTex = this.environmentTexture;
		if ( envMap && oldTex && oldTex !== envMap && oldTex !== this._envPlaceholder && oldTex !== this._previousHDRI && ! oldTex._isPhysicalSky ) {

			oldTex.dispose?.();

		}

		this.scene.environment = envMap;
		this.setEnvironmentTexture( envMap );

		if ( envMap ) {

			if ( buildCDF ) await this.buildEnvironmentCDF();

		} else {

			this._cdfSignature = null;
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

		if ( envMap && oldTex?._isPhysicalSky && this.envParams.mode !== 'procedural' ) this._releaseSky();

		this._notifyReset();

	}

	/**
	 * Enter 'hdri' mode ahead of an async HDRI install, and drop the texture stashed by a
	 * previous setMode( 'gradient' | 'color' | 'procedural' ): a new HDRI makes it
	 * unreachable, so leaving it in place both leaks it and lets a setMode( 'hdri' )
	 * arriving mid-download restore it over the map we are about to install.
	 * @param {import('three').Texture} [incoming] - Never disposed, even if it is the stash.
	 */
	beginHDRI( incoming = null ) {

		if ( this._previousHDRI && this._previousHDRI !== incoming ) this._previousHDRI.dispose?.();

		this._previousHDRI = null;
		this.envParams.mode = 'hdri';

	}

	/**
	 * Install an HDRI as the active environment, switching the mode state machine to 'hdri'.
	 * @param {import('three').Texture} envMap
	 * @param {Object}  [options]
	 * @param {boolean} [options.buildCDF=true]
	 */
	async applyHDRI( envMap, { buildCDF = true } = {} ) {

		this.beginHDRI( envMap );
		await this.setEnvironmentMap( envMap, { buildCDF } );

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
	 * Bake the physical sky and set it as the environment. Requests made in one task become one
	 * bake, queued straight away while the GPU keeps up and otherwise as soon as it finishes an
	 * earlier one. Resolves once the environment has caught up with the latest request.
	 */
	generateProceduralSkyTexture() {

		this._skyRequested = true;
		this._skyCaughtUp ??= new Promise( resolve => void ( this._resolveSky = resolve ) );
		this._pumpSky();
		return this._skyCaughtUp;

	}

	/** @private */
	_pumpSky() {

		if ( this._skyScheduled || ! this._skyRequested || this._skyInFlight >= SKY_BAKES_IN_FLIGHT ) return;
		this._skyScheduled = true;
		queueMicrotask( () => {

			this._skyScheduled = false;
			if ( this._skyRequested && this._skyInFlight < SKY_BAKES_IN_FLIGHT ) this._bakePhysicalSky();

		} );

	}

	/** @private */
	_settleSky() {

		const resolve = this._resolveSky;
		this._skyCaughtUp = this._resolveSky = null;
		resolve?.();

	}

	/** @private */
	async _bakePhysicalSky() {

		this._skyRequested = false;
		const p = this.envParams;
		if ( ! this.renderer || p.mode !== 'procedural' ) {

			if ( ! this.renderer ) log.warn( 'physical sky needs a renderer' );
			if ( this._skyInFlight === 0 ) this._settleSky();
			return;

		}

		const sky = this.physicalSky ??= new PhysicalSky( SKY_WIDTH, SKY_HEIGHT );
		const albedo = p.skyGroundAlbedo;
		const bake = ++ this._skyBakes;
		const latest = () => bake === this._skyBakes && ! this._skyRequested;
		this._skyInFlight ++;

		try {

			const { texture, cdfTexture, sun, stats } = sky.bake( this.renderer, {
				sunDirection: p.skySunDirection.toArray(),
				turbidity: p.skyTurbidity,
				ozone: p.skyOzone,
				airDensity: p.skyAirDensity,
				groundAlbedo: [ albedo.r, albedo.g, albedo.b ],
				altitude: p.skyAltitude,
				sunAngularDiameter: p.skySunSize * DEG2RAD,
				sunStrength: p.skySunStrength,
			} );
			this._sun = sun;
			this._installSky( texture, cdfTexture );

			// Frames until they land normalise by an older bake's.
			const { totalSum, compensationDelta } = await stats;
			if ( p.mode === 'procedural' && sky === this.physicalSky && bake > this._skyStatsBake ) {

				this._skyStatsBake = bake;
				this.uniforms.set( 'envTotalSum', totalSum );
				this.uniforms.set( 'envCompensationDelta', compensationDelta );
				if ( latest() ) this._notifyReset();

			}

			if ( latest() ) log.debug( `physical sky ${fmt.ms( sky.getLastRenderTime() )} · sun ${sun.radiance.map( v => v.toPrecision( 3 ) ).join( ',' )}` );

		} catch ( error ) {

			log.error( 'physical sky generation failed:', error );

		} finally {

			this._skyInFlight --;
			if ( latest() ) this._settleSky();
			else this._pumpSky();

		}

	}

	/** @private */
	_installSky( texture, cdfTexture ) {

		const oldTex = this.environmentTexture;
		if ( oldTex && oldTex !== texture && oldTex !== this._envPlaceholder && oldTex !== this._previousHDRI ) oldTex.dispose?.();
		if ( this.envCDFTexture !== cdfTexture ) {

			this.envCDFTexture?.dispose?.();
			this.envCDFTexture = cdfTexture;

		}

		// So an HDRI coming back rebuilds its own table.
		this._cdfSignature = null;
		texture._isGeneratedProcedural = true;
		this.scene.environment = texture;
		this.environmentTexture = texture;
		this.envTexSize.set( texture.image.width, texture.image.height );
		this.uniforms.get( 'envResolution' ).value.set( texture.image.width, texture.image.height );
		const nodes = this.callbacks.getSceneTextureNodes?.();
		if ( nodes?.envTex ) nodes.envTex.value = texture;
		this.refreshSun();
		this._notifyReset();

	}

	/** @private */
	_releaseSky() {

		if ( ! this.physicalSky ) return;
		this.physicalSky.dispose( this.renderer );
		this.physicalSky = null;
		this._sun = null;
		this.refreshSun();

	}

	/**
	 * Push the sun to the shader: into world space through the environment rotation, and into
	 * the working colour space. Call after either changes.
	 */
	refreshSun() {

		const sun = this.envParams.mode === 'procedural' ? this._sun : null;
		const on = !! sun && sun.radiance.some( v => v > 0 );
		this.uniforms.set( 'hasSun', on ? 1 : 0 );
		if ( ! on ) return;

		const direction = this.uniforms.get( 'sunDirection' ).value;
		direction.fromArray( sun.direction ).transformDirection( _rotation.copy( this.environmentRotationMatrix ).transpose() );
		const rgb = [ ...sun.radiance ];
		convertLinearTriple( rgb );
		this.uniforms.get( 'sunRadiance' ).value.fromArray( rgb );
		this.uniforms.get( 'sunParams' ).value.set( sun.cosHalfAngle, sun.solidAngle, 1 / ( sun.sinHalfAngle * sun.sinHalfAngle ), sun.horizonSin );

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

		this.callbacks = {};
		this._settleSky();
		this.physicalSky?.dispose( this.renderer );
		this.physicalSky = null;
		this.simpleSkyRenderer = null;
		this._sun = null;

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
