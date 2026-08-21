import { EventDispatcher, ACESFilmicToneMapping } from 'three';
import { TONE_MAP_FNS, SRGB_GAMMA, applySaturation } from '../Processor/ToneMapCPU.js';
import { getAssetConfig } from '../AssetConfig.js';
import AIUpscalerWorker from '../Processor/Workers/AIUpscalerWorker.js?worker&inline';


// ─── Model Configuration ───────────────────────────────────────────────────────
// Quality presets reference relative paths against asset-config `upscalerModelBaseUrl`.

const QUALITY_PRESET_PATHS = {
	fast: {
		2: '2x-spanx2-ch48.onnx',
		4: '4xNomos8k_span_otf_strong_fp32_opset17.onnx'
	},
	balanced: {
		2: '2xNomosUni_compact_otf_medium.onnx',
		4: 'RealESRGAN_x4plus.onnx'
	},
	quality: {
		2: '2x-realesrgan-x2plus.onnx',
		4: '4xNomos2_hq_mosr_fp32.onnx'
	}
};

function _resolveQualityPresets() {

	const { upscalerModelBaseUrl } = getAssetConfig();
	const out = {};
	for ( const q in QUALITY_PRESET_PATHS ) {

		out[ q ] = {};
		for ( const s in QUALITY_PRESET_PATHS[ q ] ) {

			out[ q ][ s ] = upscalerModelBaseUrl + QUALITY_PRESET_PATHS[ q ][ s ];

		}

	}

	return out;

}

const MODEL_CONFIG = {

	get QUALITY_PRESETS() {

		return _resolveQualityPresets();

	},

	// Larger tiles = fewer GPU dispatches = faster. 512 works on most GPUs with 4GB+ VRAM.
	TILE_SIZE: 512,

	// Overlap in pixels between adjacent tiles (prevents seam artifacts)
	TILE_OVERLAP: 16,

	// ORT session options — WebGPU EP requires preferredLayout: 'NCHW' for SR models
	// (default NHWC layout causes internal buffer shape mismatches).
	SESSION_OPTIONS: {
		executionProviders: [
			{ name: 'webgpu', preferredLayout: 'NCHW' }
		],
		graphOptimizationLevel: 'all'
	}

};

// ─── AIUpscaler ─────────────────────────────────────────────────────────────────

export class AIUpscaler extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} output - Canvas for upscaled output (shared with denoiser)
	 * @param {WebGPURenderer} renderer - Three.js WebGPU renderer
	 * @param {Object} options
	 * @param {number} [options.scaleFactor=2] - Upscale factor (2 or 4)
	 * @param {Function} [options.getSourceCanvas] - Returns the canvas to read source image from
	 * @param {Function} [options.getGPUTextures] - Returns { color: GPUTexture } for HDR path
	 * @param {Function} [options.getExposure] - Returns current exposure multiplier
	 * @param {Function} [options.getToneMapping] - Returns Three.js ToneMapping constant
	 * @param {number} [options.tileSize] - Override default tile size
	 */
	constructor( output, renderer, options = {} ) {

		super();

		if ( ! output || ! renderer ) {

			throw new Error( 'AIUpscaler requires output canvas and renderer' );

		}

		this.renderer = renderer;
		this.input = renderer.domElement;
		this.output = output;
		this.getSourceCanvas = options.getSourceCanvas || null;

		// HDR pipeline callbacks (same pattern as OIDNDenoiser)
		this.getGPUTextures = options.getGPUTextures || null;
		this.getExposure = options.getExposure || ( () => 1.0 );
		this.getToneMapping = options.getToneMapping || ( () => ACESFilmicToneMapping );
		this.getSaturation = options.getSaturation || ( () => 1.0 );

		// Configuration
		this.enabled = false;
		this.hdr = false;
		this.scaleFactor = options.scaleFactor || 2;
		this.quality = options.quality || 'fast';
		// refreshInput: () => void — re-renders the compositor so the WebGPU canvas is readable
		this.refreshInput = options.refreshInput || null;
		this.tileSize = options.tileSize || MODEL_CONFIG.TILE_SIZE;
		this._tileSizeOverride = !! options.tileSize;

		// State
		this.state = {
			isUpscaling: false,
			isLoading: false,
			abortController: null
		};

		// Worker for off-main-thread inference
		this._worker = null;
		this._currentModelUrl = null;
		this._tileId = 0;
		this._pendingWorkerHandlers = new Set();

		// Alpha channel cache (bilinear-upscaled from source, applied per tile)
		this._upscaledAlpha = null;
		this._upscaledAlphaWidth = 0;

		// Canvas state backup for abort recovery
		this._backupCanvas = null;
		this._baseWidth = output.width;
		this._baseHeight = output.height;

		// Pooled HDR readback staging buffer — reused across _captureSourceHDR calls.
		// Rebuilt only when the source texture dimensions change (same spirit as
		// r184's ReadbackBuffer; we can't use renderer.getArrayBufferAsync directly
		// because our source is a raw GPUTexture, not a Three.js BufferAttribute).
		this._hdrStagingBuffer = null;
		this._hdrStagingWidth = 0;
		this._hdrStagingHeight = 0;

	}

	// ─── Model Management ─────────────────────────────────────────────────────

	/**
	 * Ensures the worker is created and the model is loaded for the current scale factor.
	 */
	async _ensureSession() {

		const preset = MODEL_CONFIG.QUALITY_PRESETS[ this.quality ];
		if ( ! preset ) throw new Error( `Unknown quality preset: ${this.quality}` );
		const url = preset[ this.scaleFactor ];
		if ( ! url ) throw new Error( `No model for ${this.quality}/${this.scaleFactor}x` );

		// Reuse if model hasn't changed
		if ( this._worker && this._currentModelUrl === url ) return;

		this.state.isLoading = true;
		this.dispatchEvent( { type: 'loading', message: `Loading ${this.scaleFactor}x upscale model...` } );

		try {

			// Create worker on first use
			if ( ! this._worker ) {

				this._worker = new AIUpscalerWorker();

			}

			// Send model load request and wait for response
			await new Promise( ( resolve, reject ) => {

				const handler = ( e ) => {

					if ( e.data.type === 'loaded' ) {

						this._worker.removeEventListener( 'message', handler );

						// Apply GPU-recommended tile size (auto-detected in worker)
						if ( e.data.tileSize && ! this._tileSizeOverride ) {

							this.tileSize = e.data.tileSize;

						}

						console.log( `AI Upscaler: ${this.scaleFactor}x model loaded, backend: ${e.data.backend}, tileSize: ${this.tileSize}` );
						resolve();

					} else if ( e.data.type === 'error' ) {

						this._worker.removeEventListener( 'message', handler );
						reject( new Error( e.data.message ) );

					}

				};

				const { ortRuntimeUrl, ortWasmPaths, cacheNamespace } = getAssetConfig();
				this._worker.addEventListener( 'message', handler );
				this._worker.postMessage( {
					type: 'load',
					url,
					sessionOptions: MODEL_CONFIG.SESSION_OPTIONS,
					ortRuntimeUrl,
					ortWasmPaths,
					cacheNamespace,
				} );

			} );

			this._currentModelUrl = url;
			this.dispatchEvent( { type: 'loaded' } );

		} catch ( error ) {

			console.error( 'AI Upscaler: Failed to load model:', error );
			this.dispatchEvent( { type: 'error', error } );
			throw error;

		} finally {

			this.state.isLoading = false;

		}

	}

	// ─── Public Lifecycle ─────────────────────────────────────────────────────

	async start() {

		if ( ! this.enabled || this.state.isUpscaling || this.state.isLoading ) {

			return false;

		}

		this.dispatchEvent( { type: 'start' } );

		const startTime = performance.now();
		const success = await this.execute();

		if ( success ) {

			this.renderer?.resetState?.();
			const duration = performance.now() - startTime;
			console.log( `AI Upscaler: ${this.scaleFactor}x upscale completed in ${duration.toFixed( 1 )}ms` );

		}

		return success;

	}

	// See OIDNDenoiser._revealOutput. Here the resize below also clears the bitmap.
	_revealOutput() {

		this.output.style.display = 'block';
		this.input.style.opacity = '0';

	}

	async execute() {

		if ( ! this.enabled ) return false;

		this.state.abortController = new AbortController();
		this.state.isUpscaling = true;

		// Capture source image SYNCHRONOUSLY before any async work.
		// WebGPU canvas textures expire after each compositor frame,
		// so we must grab the pixels before awaiting model load.
		if ( this.hdr && this.getGPUTextures ) {

			// HDR path: read float32 from GPU texture, tonemap happens after upscale
			this._capturedSource = await this._captureSourceHDR();

		} else {

			// LDR path: read tonemapped uint8 from canvas
			this._capturedSource = this._captureSource();

		}

		this._createBackup( this._capturedSource );

		// Immediately draw source image (bilinear-upscaled) as base so the user
		// sees the noisy/source image right away — not a blank canvas during model load.
		const outW = this._capturedSource.width * this.scaleFactor;
		const outH = this._capturedSource.height * this.scaleFactor;
		this.output.width = outW;
		this.output.height = outH;
		const ctx = this.output.getContext( '2d', { willReadFrequently: true, alpha: true } );
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';
		ctx.drawImage( this._backupCanvas, 0, 0, outW, outH );
		this._revealOutput();

		try {

			await this._ensureSession();
			await this._runUpscale();

			// Update dimension display to reflect upscaled resolution
			this.dispatchEvent( { type: 'resolution_changed', width: this.output.width, height: this.output.height } );

			return true;

		} catch ( error ) {

			if ( error.name === 'AbortError' ) {

				console.log( 'AI Upscaler: Upscaling was aborted' );

			} else {

				console.error( 'AI Upscaler: Upscaling error:', error );
				this.dispatchEvent( { type: 'error', error } );

				// Restore canvas and input visibility on non-abort failure
				this._restoreBackup();
				this.input.style.opacity = '1';

				this.dispatchEvent( { type: 'resolution_changed', width: this._baseWidth, height: this._baseHeight } );

			}

			return false;

		} finally {

			this._capturedSource = null;
			this._upscaledAlpha = null;
			this._backupCanvas = null;

			// Only clean up if abort() hasn't already done it
			if ( this.state.isUpscaling ) {

				this.state.isUpscaling = false;
				this.state.abortController = null;
				this.dispatchEvent( { type: 'end' } );

			}

		}

	}

	abort() {

		if ( ! this.state.isUpscaling ) return;

		this.state.abortController?.abort();
		this._cleanupPendingWorkerHandlers();

		// Restore input visibility and canvas state
		this.input.style.opacity = '1';
		this._restoreBackup();

		// Restore original dimension display
		this.dispatchEvent( { type: 'resolution_changed', width: this._baseWidth, height: this._baseHeight } );

		this.state.isUpscaling = false;
		this.dispatchEvent( { type: 'end' } );

		console.log( 'AI Upscaler: Aborted' );

	}

	// ─── Core Upscaling Pipeline ──────────────────────────────────────────────

	/**
	 * Main upscaling pipeline:
	 * 1. Capture source image from the appropriate canvas
	 * 2. Process in overlapping tiles through the ONNX model
	 * 3. Write upscaled result to output canvas
	 */
	async _runUpscale() {

		const signal = this.state.abortController.signal;

		// Source image and backup already set up in execute() before model load
		const sourceImageData = this._capturedSource;
		this._capturedSource = null;
		const { width: srcW, height: srcH } = sourceImageData;
		const scale = this.scaleFactor;

		// Canvas already sized and base image drawn in execute()
		const ctx = this.output.getContext( '2d', { willReadFrequently: true, alpha: true } );

		// Cache bilinear-upscaled alpha channel from source for restoration per tile.
		// The SR model outputs RGB only — alpha would be lost without this.
		this._cacheUpscaledAlpha( sourceImageData, srcW * scale, srcH * scale );

		// Cache HDR tonemapping state for tile extraction (avoids per-pixel lookups)
		if ( sourceImageData.isHDR ) {

			this._hdrToneMapFn = TONE_MAP_FNS.get( this.getToneMapping() ) || TONE_MAP_FNS.get( ACESFilmicToneMapping );
			this._hdrExposure = this.getExposure();
			this._hdrSaturation = this.getSaturation();
			this._tmOut = new Float32Array( 3 );

		}

		// Tile-based inference
		const overlap = MODEL_CONFIG.TILE_OVERLAP;
		const tileSize = this.tileSize;
		const step = tileSize - overlap * 2;

		const tilesX = Math.ceil( srcW / step );
		const tilesY = Math.ceil( srcH / step );
		const totalTiles = tilesX * tilesY;
		let completedTiles = 0;

		for ( let ty = 0; ty < tilesY; ty ++ ) {

			for ( let tx = 0; tx < tilesX; tx ++ ) {

				if ( signal.aborted ) throw new DOMException( 'Aborted', 'AbortError' );

				// Calculate tile bounds in source image (clamped to edges)
				const srcX = Math.min( tx * step, Math.max( 0, srcW - tileSize ) );
				const srcY = Math.min( ty * step, Math.max( 0, srcH - tileSize ) );
				const tw = Math.min( tileSize, srcW - srcX );
				const th = Math.min( tileSize, srcH - srcY );

				// Extract tile from source
				const tileInput = this._extractTile( sourceImageData, srcX, srcY, tw, th );

				// Run inference on this tile
				const tileOutput = await this._inferTile( tileInput, tw, th );

				// Write upscaled tile to canvas with restored alpha
				const writeX = srcX * scale;
				const writeY = srcY * scale;
				const upscaledW = tw * scale;
				const upscaledH = th * scale;
				const tileImageData = this._tensorToImageData( tileOutput, upscaledW, upscaledH, writeX, writeY );
				ctx.putImageData( tileImageData, writeX, writeY );

				completedTiles ++;
				this.dispatchEvent( {
					type: 'progress',
					progress: completedTiles / totalTiles,
					tile: { x: tx, y: ty, total: totalTiles, completed: completedTiles }
				} );

				// Emit pixel-space tile bounds for OverlayManager's TileHelper
				this.dispatchEvent( {
					type: 'tileProgress',
					tile: { x: writeX, y: writeY, width: upscaledW, height: upscaledH },
					imageWidth: srcW * scale,
					imageHeight: srcH * scale
				} );

			}

		}

	}

	/**
	 * Captures the source image from the appropriate canvas.
	 * If a denoiser ran, reads from the denoiser canvas (this.output).
	 * Otherwise, reads from the WebGPU renderer canvas.
	 */
	_captureSource() {

		const sourceCanvas = this.getSourceCanvas ? this.getSourceCanvas() : null;

		if ( sourceCanvas && sourceCanvas !== this.output ) {

			// Source is the WebGPU canvas — must copy to a 2D canvas first, and it only reads
			// back non-empty straight after a compositor pass. Enforced here rather than left to
			// the caller: any awaited GPU work in between silently yields a fully transparent
			// capture, and the upscaler would then upscale nothing at all.
			this.refreshInput?.();
			const offscreen = document.createElement( 'canvas' );
			offscreen.width = sourceCanvas.width;
			offscreen.height = sourceCanvas.height;
			const offCtx = offscreen.getContext( '2d' );
			offCtx.drawImage( sourceCanvas, 0, 0 );
			return offCtx.getImageData( 0, 0, offscreen.width, offscreen.height );

		}

		// Default: read from the output canvas (denoiser already wrote to it)
		const ctx = this.output.getContext( '2d', { willReadFrequently: true } );
		return ctx.getImageData( 0, 0, this.output.width, this.output.height );

	}

	/**
	 * HDR capture: reads float32 color data directly from the path tracer's GPU texture.
	 * Returns an ImageData-like object with float32 RGBA data and dimensions.
	 */
	async _captureSourceHDR() {

		const gpuTextures = this.getGPUTextures();
		if ( ! gpuTextures?.color ) throw new Error( 'No GPU color texture available for HDR capture' );

		const device = this.renderer.backend.device;
		const colorTexture = gpuTextures.color;
		const width = colorTexture.width;
		const height = colorTexture.height;

		// GPU texture → pooled staging buffer → CPU readback.
		// The staging buffer is kept alive between calls (unmap, don't destroy)
		// and only re-created when texture dimensions change.
		const bytesPerRow = Math.ceil( width * 16 / 256 ) * 256; // rgba32float=16 bytes, aligned to 256
		const bufferSize = bytesPerRow * height;

		if ( this._hdrStagingWidth !== width || this._hdrStagingHeight !== height ) {

			this._hdrStagingBuffer?.destroy();
			this._hdrStagingBuffer = device.createBuffer( {
				label: 'aiupscaler-hdr-readback',
				size: bufferSize,
				usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
			} );
			this._hdrStagingWidth = width;
			this._hdrStagingHeight = height;

		}

		const stagingBuffer = this._hdrStagingBuffer;

		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer(
			{ texture: colorTexture },
			{ buffer: stagingBuffer, bytesPerRow, rowsPerImage: height },
			{ width, height, depthOrArrayLayers: 1 }
		);
		device.queue.submit( [ encoder.finish() ] );

		await stagingBuffer.mapAsync( GPUMapMode.READ );
		const mappedData = new Float32Array( stagingBuffer.getMappedRange() );

		// Copy to ImageData-like structure (handle row alignment padding)
		const pixelFloats = width * 4;
		const rowFloats = bytesPerRow / 4;
		const data = new Float32Array( width * height * 4 );

		for ( let y = 0; y < height; y ++ ) {

			const srcOffset = y * rowFloats;
			const dstOffset = y * pixelFloats;
			data.set( mappedData.subarray( srcOffset, srcOffset + pixelFloats ), dstOffset );

		}

		stagingBuffer.unmap();

		// Mark as HDR so _extractTile and _tensorToImageData handle it correctly
		return { data, width, height, isHDR: true };

	}

	/**
	 * Extracts a tile region from the source image.
	 * Returns a Float32Array in NCHW format [1, 3, H, W] with values in [0, 1].
	 * Handles both LDR (uint8 ImageData) and HDR (float32) sources.
	 */
	_extractTile( sourceImageData, x, y, w, h ) {

		const { data, width } = sourceImageData;
		const isHDR = sourceImageData.isHDR;
		const pixelCount = w * h;
		const floats = new Float32Array( 3 * pixelCount );

		for ( let row = 0; row < h; row ++ ) {

			for ( let col = 0; col < w; col ++ ) {

				const srcIdx = ( ( y + row ) * width + ( x + col ) ) * 4;
				const dstIdx = row * w + col;

				if ( isHDR ) {

					// HDR: exposure + saturation + tonemap + gamma to sRGB [0,1] at float32 precision.
					// The SR model expects sRGB-range input — we tonemap before the model
					// but keep float32 precision (no uint8 quantization bottleneck).
					const tmFn = this._hdrToneMapFn;
					const exposure = this._hdrExposure;
					const saturation = this._hdrSaturation;
					let er = data[ srcIdx ] * exposure, eg = data[ srcIdx + 1 ] * exposure, eb = data[ srcIdx + 2 ] * exposure;
					if ( saturation !== 1.0 ) {

						this._tmOut[ 0 ] = er; this._tmOut[ 1 ] = eg; this._tmOut[ 2 ] = eb;
						applySaturation( this._tmOut, saturation );
						er = this._tmOut[ 0 ]; eg = this._tmOut[ 1 ]; eb = this._tmOut[ 2 ];

					}

					tmFn( er, eg, eb, 1.0, this._tmOut );
					floats[ dstIdx ] = Math.pow( this._tmOut[ 0 ], SRGB_GAMMA );
					floats[ pixelCount + dstIdx ] = Math.pow( this._tmOut[ 1 ], SRGB_GAMMA );
					floats[ 2 * pixelCount + dstIdx ] = Math.pow( this._tmOut[ 2 ], SRGB_GAMMA );

				} else {

					// LDR: normalize uint8 [0,255] to [0,1]
					floats[ dstIdx ] = data[ srcIdx ] / 255;
					floats[ pixelCount + dstIdx ] = data[ srcIdx + 1 ] / 255;
					floats[ 2 * pixelCount + dstIdx ] = data[ srcIdx + 2 ] / 255;

				}

			}

		}

		return floats;

	}

	/**
	 * Runs the ONNX model on a single tile via the worker.
	 * Input: NCHW Float32Array [1, 3, H, W], values in [0, 1]
	 * Output: NCHW Float32Array [1, 3, H*scale, W*scale]
	 */
	async _inferTile( tileData, width, height ) {

		const id = ++ this._tileId;

		return new Promise( ( resolve, reject ) => {

			const handler = ( e ) => {

				if ( e.data.id !== id ) return;
				this._worker.removeEventListener( 'message', handler );
				this._pendingWorkerHandlers.delete( handler );

				if ( e.data.type === 'inferred' ) {

					resolve( e.data.outputData );

				} else if ( e.data.type === 'error' ) {

					reject( new Error( e.data.message ) );

				}

			};

			this._pendingWorkerHandlers.add( handler );
			this._worker.addEventListener( 'message', handler );
			this._worker.postMessage(
				{ type: 'infer', tileData, width, height, id },
				[ tileData.buffer ] // Transfer ownership (zero-copy)
			);

		} );

	}

	/**
	 * Converts NCHW Float32 tensor output [3, H, W] to RGBA ImageData.
	 * Restores alpha from the cached upscaled alpha channel.
	 * @param {Float32Array} tensorData - Model output in NCHW [1, 3, H, W]
	 * @param {number} width - Tile width in upscaled pixels
	 * @param {number} height - Tile height in upscaled pixels
	 * @param {number} tileX - Tile X offset in the upscaled canvas
	 * @param {number} tileY - Tile Y offset in the upscaled canvas
	 */
	_tensorToImageData( tensorData, width, height, tileX, tileY ) {

		const imageData = new ImageData( width, height );
		const pixels = imageData.data;
		const planeSize = width * height;
		const alpha = this._upscaledAlpha;
		const alphaW = this._upscaledAlphaWidth;

		for ( let i = 0; i < planeSize; i ++ ) {

			pixels[ i * 4 ] = Math.min( 255, Math.max( 0, tensorData[ i ] * 255 + 0.5 ) ) | 0;
			pixels[ i * 4 + 1 ] = Math.min( 255, Math.max( 0, tensorData[ planeSize + i ] * 255 + 0.5 ) ) | 0;
			pixels[ i * 4 + 2 ] = Math.min( 255, Math.max( 0, tensorData[ 2 * planeSize + i ] * 255 + 0.5 ) ) | 0;

			// Restore alpha from cached upscaled source
			if ( alpha ) {

				const row = ( i / width ) | 0;
				const col = i % width;
				pixels[ i * 4 + 3 ] = alpha[ ( tileY + row ) * alphaW + ( tileX + col ) ];

			} else {

				pixels[ i * 4 + 3 ] = 255;

			}

		}

		return imageData;

	}

	/**
	 * Extracts and bilinear-upscales the alpha channel from the source image.
	 * Uses canvas drawImage for high-quality interpolation.
	 */
	_cacheUpscaledAlpha( sourceImageData, outW, outH ) {

		const { data, width, height } = sourceImageData;

		const isHDR = sourceImageData.isHDR;
		const opaqueVal = isHDR ? 1.0 : 255;

		// Check if source has any non-opaque pixels
		let hasAlpha = false;
		for ( let i = 3; i < data.length; i += 4 ) {

			if ( data[ i ] < opaqueVal ) {

				hasAlpha = true;
				break;

			}

		}

		if ( ! hasAlpha ) {

			this._upscaledAlpha = null;
			this._upscaledAlphaWidth = 0;
			return;

		}

		// Create a canvas with just the alpha channel as grayscale
		const srcCanvas = document.createElement( 'canvas' );
		srcCanvas.width = width;
		srcCanvas.height = height;
		const srcCtx = srcCanvas.getContext( '2d' );
		const alphaImage = srcCtx.createImageData( width, height );

		for ( let i = 0, len = width * height; i < len; i ++ ) {

			const a = isHDR
				? Math.min( Math.max( data[ i * 4 + 3 ] * 255, 0 ), 255 ) | 0
				: data[ i * 4 + 3 ];
			alphaImage.data[ i * 4 ] = a;
			alphaImage.data[ i * 4 + 1 ] = a;
			alphaImage.data[ i * 4 + 2 ] = a;
			alphaImage.data[ i * 4 + 3 ] = 255;

		}

		srcCtx.putImageData( alphaImage, 0, 0 );

		// Bilinear-upscale via canvas drawImage
		const dstCanvas = document.createElement( 'canvas' );
		dstCanvas.width = outW;
		dstCanvas.height = outH;
		const dstCtx = dstCanvas.getContext( '2d' );
		dstCtx.imageSmoothingEnabled = true;
		dstCtx.imageSmoothingQuality = 'high';
		dstCtx.drawImage( srcCanvas, 0, 0, outW, outH );

		// Extract the upscaled alpha as a flat Uint8Array (R channel = alpha)
		const upscaledData = dstCtx.getImageData( 0, 0, outW, outH ).data;
		const alphaArray = new Uint8Array( outW * outH );

		for ( let i = 0, len = outW * outH; i < len; i ++ ) {

			alphaArray[ i ] = upscaledData[ i * 4 ];

		}

		this._upscaledAlpha = alphaArray;
		this._upscaledAlphaWidth = outW;

	}

	// ─── Canvas Backup / Restore ──────────────────────────────────────────────

	_createBackup( sourceImageData ) {

		this._backupCanvas = document.createElement( 'canvas' );
		this._backupCanvas.width = sourceImageData.width;
		this._backupCanvas.height = sourceImageData.height;
		const ctx = this._backupCanvas.getContext( '2d' );

		if ( sourceImageData.isHDR ) {

			// HDR source: tonemap to LDR for the backup canvas display
			const { data, width, height } = sourceImageData;
			const imageData = ctx.createImageData( width, height );
			const pixels = imageData.data;
			const tmFn = TONE_MAP_FNS.get( this.getToneMapping() ) || TONE_MAP_FNS.get( ACESFilmicToneMapping );
			const exposure = this.getExposure();
			const saturation = this.getSaturation();
			const out = new Float32Array( 3 );

			for ( let i = 0, len = width * height; i < len; i ++ ) {

				const si = i * 4;
				let er = data[ si ] * exposure, eg = data[ si + 1 ] * exposure, eb = data[ si + 2 ] * exposure;
				if ( saturation !== 1.0 ) {

					out[ 0 ] = er; out[ 1 ] = eg; out[ 2 ] = eb;
					applySaturation( out, saturation );
					er = out[ 0 ]; eg = out[ 1 ]; eb = out[ 2 ];

				}

				tmFn( er, eg, eb, 1.0, out );
				pixels[ si ] = ( Math.pow( out[ 0 ], SRGB_GAMMA ) * 255 + 0.5 ) | 0;
				pixels[ si + 1 ] = ( Math.pow( out[ 1 ], SRGB_GAMMA ) * 255 + 0.5 ) | 0;
				pixels[ si + 2 ] = ( Math.pow( out[ 2 ], SRGB_GAMMA ) * 255 + 0.5 ) | 0;
				pixels[ si + 3 ] = 255;

			}

			ctx.putImageData( imageData, 0, 0 );

		} else {

			ctx.putImageData( sourceImageData, 0, 0 );

		}

	}

	_restoreBackup() {

		if ( ! this._backupCanvas ) return;

		this.output.width = this._backupCanvas.width;
		this.output.height = this._backupCanvas.height;
		const ctx = this.output.getContext( '2d' );
		ctx.drawImage( this._backupCanvas, 0, 0 );
		this._backupCanvas = null;

	}

	// ─── Configuration ────────────────────────────────────────────────────────

	toggleHDR( value ) {

		this.hdr = !! value;

	}

	setQuality( value ) {

		if ( ! MODEL_CONFIG.QUALITY_PRESETS[ value ] ) {

			console.warn( `AIUpscaler: Invalid quality "${value}", must be fast/balanced/quality` );
			return;

		}

		this.quality = value;

	}

	setScaleFactor( scale ) {

		scale = Number( scale );
		if ( scale !== 2 && scale !== 4 ) {

			console.warn( `AIUpscaler: Invalid scale factor ${scale}, must be 2 or 4` );
			return;

		}

		this.scaleFactor = scale;

	}

	setBaseSize( width, height ) {

		this._baseWidth = width;
		this._baseHeight = height;

	}

	// ─── Disposal ─────────────────────────────────────────────────────────────

	_cleanupPendingWorkerHandlers() {

		if ( this._worker ) {

			for ( const handler of this._pendingWorkerHandlers ) {

				this._worker.removeEventListener( 'message', handler );

			}

		}

		this._pendingWorkerHandlers.clear();

	}

	async dispose() {

		this.abort();
		this._cleanupPendingWorkerHandlers();

		if ( this._worker ) {

			this._worker.postMessage( { type: 'dispose' } );
			this._worker.terminate();
			this._worker = null;

		}

		this._currentModelUrl = null;
		this._backupCanvas = null;
		this._upscaledAlpha = null;
		this.state.abortController = null;

		this._hdrStagingBuffer?.destroy();
		this._hdrStagingBuffer = null;
		this._hdrStagingWidth = 0;
		this._hdrStagingHeight = 0;

		console.log( 'AIUpscaler disposed' );

	}

}
