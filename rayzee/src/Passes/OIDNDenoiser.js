import { EventDispatcher, ACESFilmicToneMapping } from 'three';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'oidn' );

let _initUNetFromURL = null;
let _tfEngine = null;
async function getInitUNetFromURL() {

	if ( ! _initUNetFromURL ) {

		const [ oidnMod, tfMod ] = await Promise.all( [
			import( 'oidn-web' ),
			import( '@tensorflow/tfjs-core' )
		] );
		_initUNetFromURL = oidnMod.initUNetFromURL;
		_tfEngine = tfMod.engine;

	}

	return _initUNetFromURL;

}

// oidn-web caches its WebGPUBackend in TFJS's global ENGINE under 'webgpu-oidn'.
// On dispose, drop it so the next instance binds to the new GPUDevice instead of
// reusing the destroyed one (which would produce black tiles).
function removeOidnTfjsBackend() {

	if ( ! _tfEngine ) return;
	try {

		const eng = _tfEngine();
		if ( eng?.registryFactory && 'webgpu-oidn' in eng.registryFactory ) {

			eng.removeBackend( 'webgpu-oidn' );

		}

	} catch ( e ) {

		log.warn( 'failed to clear cached TFJS backend', e );

	}

}

import { TONE_MAP_FNS, linearToSRGB, applySaturation } from '../Processor/ToneMapCPU.js';
import { getAssetConfig } from '../AssetConfig.js';

/** Reusable RGB output buffer (avoids per-pixel allocation). */
const _tmOut = new Float32Array( 3 );

const MODEL_CONFIG = {
	// clean-aux models — first-hit albedo/normal are deterministic per pixel
	QUALITY_MODELS: {
		fast: 'rt_hdr_alb_nrm_small',
		balance: 'rt_hdr_alb_nrm',
		high: 'rt_hdr_calb_cnrm_large'
	},
	DEFAULT_OPTIONS: {
		enableOIDN: true,
		oidnQuality: 'fast',
		debugGbufferMaps: true,
		tileSize: 256
	}
};

export class OIDNDenoiser extends EventDispatcher {

	constructor( output, renderer, scene, camera, options = {} ) {

		super();

		// Validate required parameters
		if ( ! output || ! renderer || ! scene || ! camera ) {

			throw new Error( 'OIDNDenoiser requires output canvas, renderer, scene, and camera' );

		}

		this.renderer = renderer;
		this.scene = scene;
		this.camera = camera;
		this.input = renderer.domElement;
		this.output = output;
		this.extractGBufferData = options.extractGBufferData || null;
		this.getMRTRenderTarget = options.getMRTRenderTarget || null;


		// WebGPU GPU-native path (no CPU readback for inputs)
		// backendParams: () => { device: GPUDevice, adapterInfo: GPUAdapterInfo|null }
		// getGPUTextures: () => { color: GPUTexture, albedo: GPUTexture, normal: GPUTexture }
		// getExposure: () => number  (effective exposure multiplier, pre-computed)
		// getToneMapping: () => number (Three.js ToneMapping constant)
		this.backendParamsGetter = options.backendParams || null;
		this.getGPUTextures = options.getGPUTextures || null;
		this.getExposure = options.getExposure || ( () => 1.0 );
		this.getToneMapping = options.getToneMapping || ( () => ACESFilmicToneMapping );
		this.getSaturation = options.getSaturation || ( () => 1.0 );
		this.getTransparentBackground = options.getTransparentBackground || ( () => false );
		this.isGPUMode = !! this.backendParamsGetter;
		this.gpuDevice = null;

		// Cached GPU storage buffers for texture→buffer copies (reused across denoise calls)
		this._gpuInputBuffers = { color: null, albedo: null, normal: null };
		this._gpuInputBufferSize = { width: 0, height: 0 };
		// Shared pad-strip buffer for non-256-aligned widths. Reused across
		// color/albedo/normal copies within the same encoder (WebGPU command
		// order guarantees the overwrites are serialized).
		this._gpuInputPadBuffer = null;
		this._gpuInputPaddedRowBytes = 0;
		// Pooled MAP_READ staging buffer for _cacheInputAlpha. Only allocated
		// when transparent-background readback is used, destroyed on resolution
		// change or dispose. Same spirit as r184's ReadbackBuffer — we can't use
		// renderer.getArrayBufferAsync because the source is a raw GPUBuffer,
		// not a Three.js BufferAttribute.
		this._alphaReadbackBuffer = null;
		this._alphaReadbackMapped = false;

		// Cached alpha channel from the input color buffer (OIDN discards alpha)
		this._cachedAlpha = null;
		this._cachedAlphaWidth = 0;

		// Merge options with defaults
		this.config = { ...MODEL_CONFIG.DEFAULT_OPTIONS, ...options };

		// Destructure for easier access
		this.enabled = this.config.enableOIDN;
		this.quality = this.config.oidnQuality;
		this.debugGbufferMaps = this.config.debugGbufferMaps;
		this.tileSize = this.config.tileSize;

		// State management
		this.state = {
			isDenoising: false,
			isLoading: false,
			abortController: null
		};

		// Track in-flight tile staging buffers so they can be destroyed on abort
		this._pendingStagingBuffers = new Set();
		// Per-run tile-blit promises; done() awaits these so capture waits for every tile to paint.
		this._pendingTileBlits = [];

		this.currentTZAUrl = null;
		this.unet = null;
		// A start() requested while the UNet is still loading is deferred here and fired
		// once loading finishes, instead of being silently dropped.
		this._pendingStart = false;

		// Initialize asynchronously
		this._initialize().catch( error => {

			log.error( 'init failed:', error );
			this.dispatchEvent( { type: 'error', error } );

		} );

	}

	async _initialize() {

		try {

			this._setupCanvas();
			await this._setupUNetDenoiser();

		} catch ( error ) {

			throw new Error( `Initialization failed: ${error.message}` );

		}

	}

	_setupCanvas() {

		if ( ! this.output.getContext ) {

			throw new Error( 'Output must be a valid Canvas element' );

		}

		// Configure canvas for optimal performance
		this.output.willReadFrequently = true;
		this.output.width = this.input.width;
		this.output.height = this.input.height;

		// Apply styling efficiently
		Object.assign( this.output.style, {
			position: 'absolute',
			top: '0',
			left: '0',
			width: '100%',
			height: '100%',
			borderRadius: '5px',
			background: "repeating-conic-gradient(#808080 0% 25%, transparent 0% 50%) 50% / 20px 20px"
		} );

		this.ctx = this.output.getContext( '2d', {
			willReadFrequently: true,
			alpha: true
		} );

	}

	async _setupUNetDenoiser() {

		if ( this.state.isLoading ) return;

		this.state.isLoading = true;
		const tzaUrl = this._generateTzaUrl();

		// Skip setup if URL hasn't changed
		if ( this.currentTZAUrl === tzaUrl && this.unet ) {

			this.state.isLoading = false;
			return;

		}

		try {

			this.dispatchEvent( { type: 'loading', message: 'Loading UNet denoiser...' } );

			// Dispose previous instance
			if ( this.unet ) {

				this.unet.dispose();
				this.unet = null;

			}

			// GPU-native path: share the existing GPUDevice so oidn-web uses the
			// same device as the renderer — no second device, no CPU roundtrip for inputs.
			let backendParams;
			if ( this.isGPUMode && this.backendParamsGetter ) {

				const params = this.backendParamsGetter();
				this.gpuDevice = params?.device ?? null;
				backendParams = params?.device ? params : undefined;

			}

			const initFn = await getInitUNetFromURL();
			this.unet = await initFn( tzaUrl, backendParams, {
				aux: true,
				hdr: true,
				maxTileSize: this.tileSize
			} );

			this.currentTZAUrl = tzaUrl;
			this.dispatchEvent( { type: 'loaded' } );
			log.debug( 'UNet weights loaded:', tzaUrl );

		} catch ( error ) {

			log.error( 'UNet weights failed to load:', error );
			this.dispatchEvent( { type: 'error', error: new Error( `Denoiser loading failed: ${error.message}` ) } );

		} finally {

			this.state.isLoading = false;

			// Fire a start() that arrived mid-load. Guard on unet+enabled so a failed load
			// or a disable during loading doesn't kick off a denoise.
			if ( this._pendingStart && this.unet && this.enabled ) {

				this._pendingStart = false;
				this.start();

			}

		}

	}

	_generateTzaUrl() {

		const { oidnWeightsBaseUrl } = getAssetConfig();
		const { QUALITY_MODELS } = MODEL_CONFIG;
		const modelName = QUALITY_MODELS[ this.quality ] || QUALITY_MODELS.balance;
		return `${oidnWeightsBaseUrl}${modelName}.tza`;

	}

	// Public configuration methods with validation
	async updateConfiguration( newConfig ) {

		const hasChanged = Object.keys( newConfig ).some( key => this.config[ key ] !== newConfig[ key ] );

		if ( ! hasChanged ) return;

		// Update configuration
		Object.assign( this.config, newConfig );
		this.quality = this.config.oidnQuality;
		this.debugGbufferMaps = this.config.debugGbufferMaps;
		this.tileSize = this.config.tileSize;

		// Reload denoiser if necessary
		await this._setupUNetDenoiser();

	}

	async updateQuality( value ) {

		if ( ! Object.prototype.hasOwnProperty.call( MODEL_CONFIG.QUALITY_MODELS, value ) ) {

			throw new Error( `Invalid quality setting: ${value}. Must be one of: ${Object.keys( MODEL_CONFIG.QUALITY_MODELS ).join( ', ' )}` );

		}

		await this.updateConfiguration( { oidnQuality: value } );

	}

	async start() {

		if ( ! this.enabled || this.state.isDenoising ) {

			return false;

		}

		// UNet weights still loading — defer the start (fired from _setupUNetDenoiser's
		// finally) rather than silently dropping this frame's denoise request.
		if ( this.state.isLoading ) {

			this._pendingStart = true;
			return false;

		}

		this.dispatchEvent( { type: 'start' } );

		const startTime = performance.now();
		const success = await this.execute();

		if ( success ) {

			this.renderer?.resetState?.();
			this.input.style.opacity = '0';

			const duration = performance.now() - startTime;
			log.debug( `denoise complete in ${fmt.ms( duration )} · quality ${this.quality}` );

		}

		return success;

	}

	async execute() {

		if ( ! this.enabled || ! this.unet ) return false;

		// Create abort controller for this execution
		this.state.abortController = new AbortController();
		this.state.isDenoising = true;
		this.input.style.opacity = '0';
		this.output.style.display = 'block';

		try {

			await this._executeUNet();
			return true;

		} catch ( error ) {

			if ( error.name === 'AbortError' ) {

				log.debug( 'denoise aborted' );

			} else {

				log.error( 'denoise error:', error );

			}

			// Restore original rendering on error
			this.input.style.opacity = '1';
			return false;

		} finally {

			this.state.isDenoising = false;
			this.state.abortController = null;
			this.dispatchEvent( { type: 'end' } );

		}

	}

	async _executeUNet() {

		return this._executeUNetGPU();

	}

	/**
	 * GPU-native execution path. Copies render target textures into GPU storage buffers
	 * via copyTextureToBuffer (GPU-only, no CPU roundtrip), then passes those buffers to
	 * oidn-web's well-tested GPUBuffer path.
	 *
	 * Note: oidn-web's GPUTexture input path produces NaN outputs — using GPUBuffer instead.
	 */
	async _executeUNetGPU() {

		const { width, height } = this.output;

		if ( ! this.getGPUTextures ) {

			log.warn( 'GPU mode enabled but getGPUTextures not provided' );
			return false;

		}

		const textures = this.getGPUTextures();
		if ( ! textures?.color ) {

			log.warn( 'GPU textures not ready yet' );
			return false;

		}

		const device = this.gpuDevice;
		if ( ! device ) {

			log.warn( 'gpuDevice not available' );
			return false;

		}

		// Ensure storage buffers are sized correctly (recreate on resolution change)
		this._ensureGPUInputBuffers( width, height );

		// Copy render target textures → tightly packed GPU storage buffers for oidn-web.
		// copyTextureToBuffer requires bytesPerRow to be a multiple of 256. When the tight
		// row size (width * 16) isn't aligned, copy via a shared pre-allocated padded buffer
		// (see _ensureGPUInputBuffers) then strip padding row-by-row. The pad buffer is
		// reused across color/albedo/normal — safe because WebGPU serializes commands
		// within a single encoder.
		const encoder = device.createCommandEncoder( { label: 'oidn-tex-to-buf' } );
		const tightRowBytes = width * 16; // rgba32float
		const paddedRowBytes = this._gpuInputPaddedRowBytes;
		const needsPadStrip = paddedRowBytes > tightRowBytes;
		const padBuf = this._gpuInputPadBuffer;

		const copyTex = ( tex, tightBuf ) => {

			if ( ! needsPadStrip ) {

				encoder.copyTextureToBuffer(
					{ texture: tex, mipLevel: 0 },
					{ buffer: tightBuf, offset: 0, bytesPerRow: tightRowBytes, rowsPerImage: height },
					{ width, height, depthOrArrayLayers: 1 }
				);

			} else {

				encoder.copyTextureToBuffer(
					{ texture: tex, mipLevel: 0 },
					{ buffer: padBuf, offset: 0, bytesPerRow: paddedRowBytes, rowsPerImage: height },
					{ width, height, depthOrArrayLayers: 1 }
				);

				for ( let row = 0; row < height; row ++ ) {

					encoder.copyBufferToBuffer( padBuf, row * paddedRowBytes, tightBuf, row * tightRowBytes, tightRowBytes );

				}

			}

		};

		copyTex( textures.color, this._gpuInputBuffers.color );
		copyTex( textures.albedo, this._gpuInputBuffers.albedo );
		copyTex( textures.normal, this._gpuInputBuffers.normal );

		device.queue.submit( [ encoder.finish() ] );

		// Cache alpha channel from input color buffer when transparent background is enabled.
		// OIDN only processes RGB — the alpha channel is lost, so we read it before denoising.
		if ( this.getTransparentBackground() ) {

			await this._cacheInputAlpha( device, width, height );

		} else {

			this._cachedAlpha = null;

		}

		// Draw the current noisy frame as the base — denoised tiles paint on top progressively
		this.ctx.drawImage( this.input, 0, 0, width, height );
		// Pass GPU storage buffers to oidn-web (GPUBuffer path, well-tested)
		const config = {
			color: { data: this._gpuInputBuffers.color, width, height },
			albedo: { data: this._gpuInputBuffers.albedo, width, height },
			normal: { data: this._gpuInputBuffers.normal, width, height }
		};

		return this._executeWithAbortGPU( config );

	}

	/**
	 * Creates or recreates the GPU storage buffers used as oidn-web inputs.
	 * Reuses existing buffers if the resolution hasn't changed.
	 * Usage: COPY_DST (for copyTextureToBuffer) | STORAGE (for oidn-web WGSL read) | COPY_SRC
	 */
	_ensureGPUInputBuffers( width, height ) {

		const { width: cw, height: ch } = this._gpuInputBufferSize;
		if ( cw === width && ch === height && this._gpuInputBuffers.color ) return;

		// Destroy stale buffers
		this._destroyGPUInputBuffers();

		const device = this.gpuDevice;
		const byteSize = width * height * 16; // rgba32float, tightly packed for oidn-web
		const usage = GPUBufferUsage.COPY_DST | GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;

		this._gpuInputBuffers.color = device.createBuffer( { label: 'oidn-in-color', size: byteSize, usage } );
		this._gpuInputBuffers.albedo = device.createBuffer( { label: 'oidn-in-albedo', size: byteSize, usage } );
		this._gpuInputBuffers.normal = device.createBuffer( { label: 'oidn-in-normal', size: byteSize, usage } );
		this._gpuInputBufferSize = { width, height };

		// Pre-allocate the row-pad staging buffer when width * 16 isn't 256-aligned.
		// Shared across the three texture copies; recreated only on resolution change.
		const tightRowBytes = width * 16;
		const paddedRowBytes = Math.ceil( tightRowBytes / 256 ) * 256;
		if ( paddedRowBytes !== tightRowBytes ) {

			this._gpuInputPadBuffer = device.createBuffer( {
				label: 'oidn-in-pad',
				size: paddedRowBytes * height,
				usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC
			} );
			this._gpuInputPaddedRowBytes = paddedRowBytes;

		} else {

			this._gpuInputPaddedRowBytes = tightRowBytes;

		}

	}

	_destroyGPUInputBuffers() {

		this._gpuInputBuffers.color?.destroy();
		this._gpuInputBuffers.albedo?.destroy();
		this._gpuInputBuffers.normal?.destroy();
		this._gpuInputPadBuffer?.destroy();

		// Unmap before destroying if a mapAsync resolved but unmap hasn't been called yet.
		// If mapAsync is still pending, destroy() will reject it — _cacheInputAlpha's
		// catch handler covers that case.
		if ( this._alphaReadbackMapped && this._alphaReadbackBuffer ) {

			try {

				this._alphaReadbackBuffer.unmap();

			} catch { /* already unmapped or destroyed */ }

		}

		this._alphaReadbackBuffer?.destroy();
		this._alphaReadbackMapped = false;
		this._gpuInputBuffers = { color: null, albedo: null, normal: null };
		this._gpuInputPadBuffer = null;
		this._gpuInputPaddedRowBytes = 0;
		this._alphaReadbackBuffer = null;
		this._gpuInputBufferSize = { width: 0, height: 0 };

	}

	/**
	 * Reads the alpha channel from the input color GPU buffer and caches it as a Uint8Array.
	 * Called before OIDN denoising when transparent background is enabled.
	 */
	async _cacheInputAlpha( device, width, height ) {

		const byteSize = width * height * 16; // rgba32float, tightly packed

		// Lazy-allocate the pooled staging buffer on first call at this resolution.
		// _destroyGPUInputBuffers clears it on resolution change or dispose, so if
		// it is non-null here, it already matches the current resolution.
		if ( this._alphaReadbackBuffer === null ) {

			this._alphaReadbackBuffer = device.createBuffer( {
				label: 'oidn-alpha-readback',
				size: byteSize,
				usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
			} );

		}

		const staging = this._alphaReadbackBuffer;

		const enc = device.createCommandEncoder();
		enc.copyBufferToBuffer( this._gpuInputBuffers.color, 0, staging, 0, byteSize );
		device.queue.submit( [ enc.finish() ] );

		this._alphaReadbackMapped = true;
		try {

			await staging.mapAsync( GPUMapMode.READ );

		} catch {

			// Buffer was destroyed while mapAsync was pending (resize or dispose)
			this._alphaReadbackMapped = false;
			return;

		}

		const f32 = new Float32Array( staging.getMappedRange() );

		// Extract alpha channel as uint8 (pre-multiplied is not needed — alpha is 0 or 1)
		const pixelCount = width * height;
		const alpha = new Uint8Array( pixelCount );
		for ( let i = 0; i < pixelCount; i ++ ) {

			alpha[ i ] = Math.min( Math.max( f32[ i * 4 + 3 ] * 255, 0 ), 255 ) | 0;

		}

		staging.unmap();
		this._alphaReadbackMapped = false;

		this._cachedAlpha = alpha;
		this._cachedAlphaWidth = width;

	}

	/**
	 * Promise wrapper around tileExecute for the GPU path.
	 * Outputs a GPUBuffer — copied to a staging buffer then converted to ImageData for the 2D canvas.
	 */
	_executeWithAbortGPU( config ) {

		return new Promise( ( resolve, reject ) => {

			if ( this.state.abortController?.signal.aborted ) {

				reject( new DOMException( 'Aborted', 'AbortError' ) );
				return;

			}

			let abortDenoise = null;

			// Fresh per-run list of tile-blit promises (the progress callback appends to it).
			this._pendingTileBlits = [];

			const abortHandler = () => {

				if ( abortDenoise ) {

					abortDenoise();
					abortDenoise = null;

				}

				reject( new DOMException( 'Aborted', 'AbortError' ) );

			};

			this.state.abortController.signal.addEventListener( 'abort', abortHandler, { once: true } );

			abortDenoise = this.unet.tileExecute( {
				...config,
				done: async ( output ) => {

					this.state.abortController.signal.removeEventListener( 'abort', abortHandler );
					abortDenoise = null;

					try {

						if ( this._pendingTileBlits.length > 0 ) {

							// Normal path: the progress callback already painted every tile progressively, with
							// the same exposure/saturation/tonemap/sRGB math the full-frame readback uses (verified:
							// tiles tile the image exactly, no overlap). Just wait for those blits — no redundant
							// full-frame re-read + re-tonemap.
							await Promise.allSettled( this._pendingTileBlits );

						} else {

							// Degenerate fallback (no per-tile progress was emitted): one authoritative full paint.
							await this._displayGPUOutput( output );

						}

						// DENOISING_END (which gates screenshot/video capture) fires only after this resolves,
						// so the captured canvas is always complete.
						resolve();

					} catch ( err ) {

						reject( err );

					}

				},
				progress: ( outputData, _tileData, tile ) => {

					// oidn-web GPU path: tileData is null, but outputData holds the assembled
					// full-image buffer updated after each tile. Extract the tile region via
					// row-by-row copyBufferToBuffer (no stride support in WebGPU buffer copies).
					if ( ! outputData?.data || ! tile ) return;

					const device = this.gpuDevice;
					const fullWidth = outputData.width;
					const fullHeight = outputData.height;
					const bytesPerPixel = 16; // rgba32float = 4 × float32

					// Clamp tile to image bounds (edge tiles may extend past the image)
					const clampedW = Math.min( tile.width, fullWidth - tile.x );
					const clampedH = Math.min( tile.height, fullHeight - tile.y );
					if ( clampedW <= 0 || clampedH <= 0 ) return;

					const tileRowBytes = clampedW * bytesPerPixel;
					const tileByteSize = clampedW * clampedH * bytesPerPixel;

					const staging = device.createBuffer( {
						size: tileByteSize,
						usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
					} );

					this._pendingStagingBuffers.add( staging );

					// Copy each tile row from its position in the full output buffer
					const enc = device.createCommandEncoder();

					for ( let row = 0; row < clampedH; row ++ ) {

						const srcOffset = ( ( tile.y + row ) * fullWidth + tile.x ) * bytesPerPixel;
						const dstOffset = row * tileRowBytes;
						enc.copyBufferToBuffer( outputData.data, srcOffset, staging, dstOffset, tileRowBytes );

					}

					device.queue.submit( [ enc.finish() ] );

					// Map and blit asynchronously — GPU copy is already queued. Track the whole chain so
					// done() can await every tile paint before resolving (replaces the full-frame readback).
					const tileBlit = staging.mapAsync( GPUMapMode.READ ).then( () => {

						const f32 = new Float32Array( staging.getMappedRange() );
						const tileImageData = new ImageData( clampedW, clampedH );
						const exposure = this.getExposure();
						const saturation = this.getSaturation();
						const tmFn = TONE_MAP_FNS.get( this.getToneMapping() ) || TONE_MAP_FNS.get( ACESFilmicToneMapping );
						const alpha = this._cachedAlpha;
						const alphaW = this._cachedAlphaWidth;

						for ( let i = 0, len = f32.length; i < len; i += 4 ) {

							// Exposure + saturation (pre-tonemap, matching Display)
							let er = f32[ i ] * exposure, eg = f32[ i + 1 ] * exposure, eb = f32[ i + 2 ] * exposure;
							if ( saturation !== 1.0 ) {

								_tmOut[ 0 ] = er; _tmOut[ 1 ] = eg; _tmOut[ 2 ] = eb;
								applySaturation( _tmOut, saturation );
								er = _tmOut[ 0 ]; eg = _tmOut[ 1 ]; eb = _tmOut[ 2 ];

							}

							tmFn( er, eg, eb, 1.0, _tmOut );
							tileImageData.data[ i ] = linearToSRGB( _tmOut[ 0 ] ) * 255 + 0.5 | 0;
							tileImageData.data[ i + 1 ] = linearToSRGB( _tmOut[ 1 ] ) * 255 + 0.5 | 0;
							tileImageData.data[ i + 2 ] = linearToSRGB( _tmOut[ 2 ] ) * 255 + 0.5 | 0;

							if ( alpha ) {

								const px = ( i >> 2 ) % clampedW;
								const py = ( i >> 2 ) / clampedW | 0;
								tileImageData.data[ i + 3 ] = alpha[ ( tile.y + py ) * alphaW + tile.x + px ];

							} else {

								tileImageData.data[ i + 3 ] = 255;

							}

						}

						staging.unmap();
						staging.destroy();
						this._pendingStagingBuffers.delete( staging );
						this.ctx.putImageData( tileImageData, tile.x, tile.y );

						// Emit tile progress for OverlayManager's TileHelper
						this.dispatchEvent( {
							type: 'tileProgress',
							tile: { x: tile.x, y: tile.y, width: clampedW, height: clampedH },
							imageWidth: fullWidth,
							imageHeight: fullHeight
						} );

					} ).catch( () => {

						// mapAsync rejected (abort or GPU lost) — destroy the buffer
						staging.destroy();
						this._pendingStagingBuffers.delete( staging );

					} );

					this._pendingTileBlits.push( tileBlit );

				}
			} );

		} );

	}

	/**
	 * Reads a GPUBuffer (oidn-web output, rgba32float linear) back to CPU via a staging buffer,
	 * applies exposure * pow(4) + ACES filmic tonemap + sRGB gamma 2.2, then draws to the 2D canvas.
	 * @param {{ data: GPUBuffer, width: number, height: number }} output
	 */
	async _displayGPUOutput( { data: gpuBuffer, width, height } ) {

		const device = this.gpuDevice;
		if ( ! device ) {

			log.error( 'gpuDevice not available for output readback' );
			return;

		}

		const byteSize = width * height * 4 * 4; // rgba32float = 16 bytes/pixel

		// Staging buffer with MAP_READ so we can copy the output into it and read from CPU
		const stagingBuffer = device.createBuffer( {
			label: 'oidn-output-staging',
			size: byteSize,
			usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
		} );

		try {

			// Queue a copy from the oidn output buffer (STORAGE|COPY_SRC) to staging
			const encoder = device.createCommandEncoder( { label: 'oidn-readback' } );
			encoder.copyBufferToBuffer( gpuBuffer, 0, stagingBuffer, 0, byteSize );
			device.queue.submit( [ encoder.finish() ] );

			await stagingBuffer.mapAsync( GPUMapMode.READ );
			const float32 = new Float32Array( stagingBuffer.getMappedRange() );

			const imageData = new ImageData( width, height );
			const exposure = this.getExposure();
			const saturation = this.getSaturation();
			const tmFn = TONE_MAP_FNS.get( this.getToneMapping() ) || TONE_MAP_FNS.get( ACESFilmicToneMapping );
			const alpha = this._cachedAlpha;

			for ( let i = 0, len = float32.length; i < len; i += 4 ) {

				// Exposure + saturation (pre-tonemap, matching Display)
				let er = float32[ i ] * exposure, eg = float32[ i + 1 ] * exposure, eb = float32[ i + 2 ] * exposure;
				if ( saturation !== 1.0 ) {

					_tmOut[ 0 ] = er; _tmOut[ 1 ] = eg; _tmOut[ 2 ] = eb;
					applySaturation( _tmOut, saturation );
					er = _tmOut[ 0 ]; eg = _tmOut[ 1 ]; eb = _tmOut[ 2 ];

				}

				tmFn( er, eg, eb, 1.0, _tmOut );
				imageData.data[ i ] = linearToSRGB( _tmOut[ 0 ] ) * 255 + 0.5 | 0;
				imageData.data[ i + 1 ] = linearToSRGB( _tmOut[ 1 ] ) * 255 + 0.5 | 0;
				imageData.data[ i + 2 ] = linearToSRGB( _tmOut[ 2 ] ) * 255 + 0.5 | 0;
				imageData.data[ i + 3 ] = alpha ? alpha[ i >> 2 ] : 255;

			}

			stagingBuffer.unmap();
			this.ctx.putImageData( imageData, 0, 0 );

		} finally {

			stagingBuffer.destroy();

		}

	}

	abort() {

		// Cancel any start deferred during loading so a reset supersedes it.
		this._pendingStart = false;

		if ( ! this.enabled || ! this.state.isDenoising ) return;

		// Signal abort to current operation
		this.state.abortController?.abort();

		// Destroy any in-flight tile staging buffers that mapAsync won't resolve
		this._destroyPendingStagingBuffers();

		// Restore input visibility
		this.input.style.opacity = '1';

		// Reset denoising state and dispatch end event
		this.state.isDenoising = false;
		this.dispatchEvent( { type: 'end' } );

		log.debug( 'denoise aborted' );

	}

	setSize( width, height ) {

		if ( width <= 0 || height <= 0 ) {

			throw new Error( `Invalid dimensions: ${width}x${height}` );

		}

		this.output.width = width;
		this.output.height = height;

		// Reinitialize denoiser if tile size changes relative to image size
		this._setupUNetDenoiser().catch( error => {

			log.error( 'reinitialize after size change failed:', error );

		} );

	}

	_destroyPendingStagingBuffers() {

		for ( const buf of this._pendingStagingBuffers ) {

			buf.destroy();

		}

		this._pendingStagingBuffers.clear();

	}

	dispose() {

		// Abort any ongoing operations
		this.abort();

		// Destroy any remaining staging buffers
		this._destroyPendingStagingBuffers();

		// Dispose resources
		this.unet?.dispose();
		// Must precede renderer.dispose() so the GPUDevice is still alive when
		// TFJS tears down the cached backend's buffers/textures.
		removeOidnTfjsBackend();
		this._destroyGPUInputBuffers();

		// Clean up DOM
		if ( this.output?.parentNode ) {

			this.output.remove();

		}

		// Clear references
		this.unet = null;
		this.ctx = null;
		this.state.abortController = null;

		// Remove all event listeners
		this.removeAllListeners?.();

		log.debug( 'disposed' );

	}

}
