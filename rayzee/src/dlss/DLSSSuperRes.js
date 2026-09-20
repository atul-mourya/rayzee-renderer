/**
 * DLSS Super Resolution — final-render output scaling.
 *
 * Traces at half resolution, denoises, then runs one neural upscale to reach the
 * requested output size. On a 1.89M-triangle interior at 32 spp this matched a
 * native full-resolution render for accuracy while resolving visibly more detail,
 * for a quarter of the traced pixels.
 *
 * Deliberately *not* wired into the live pipeline: the network costs ~132 ms of GPU
 * at 1920x1080, which is free against a final render and ruinous against a frame.
 *
 * ⚠️ **The pass is CPU-bound, not GPU-bound.** Measured end to end on an M5 Pro: 512² → 1024² costs
 * 319 ms of which ~70 ms is the network; 1024² → 2048² costs 682 ms of which ~272 ms is the network.
 * The rest is this file — four full-image passes in JS (half→float on read, float→half on upload,
 * half→float on the result, then the tone map) plus their allocations. The fix is to tone-map on the
 * GPU and read back RGBA8 instead of linear halves: a quarter of the bytes and none of the float
 * loops. Not done, because `toneMapToRGBA8` is the shared CPU curve and a second implementation
 * would drift from it — see the note on ToneMapWGSL.
 *
 * ⚠️ Each neural model brings **its own GPUDevice**, built by the runtime and not shareable. With
 * super resolution and the detail pass both on, the page holds three: the renderer's, and one each.
 */

import { EngineEvents } from '../EngineEvents.js';
import { toneMapToRGBA8 } from '../Processor/ToneMapCPU.js';
import { getAssetConfig } from '../AssetConfig.js';

/** The network is a fixed 2x per axis, and its input side is capped at 4096. */
export const SR_SCALE = 2;
export const SR_MAX_INPUT = 4096;

let _runtimePromise = null;

function loadRuntime() {

	if ( _runtimePromise ) return _runtimePromise;

	const { dlssRuntimeUrl, dlssAssetBaseUrl } = getAssetConfig();
	globalThis.__DLSS5_ASSET_BASE__ = dlssAssetBaseUrl;

	_runtimePromise = new Promise( ( resolve, reject ) => {

		if ( globalThis.DLSSRuntime?.getNativeSR ) return resolve( globalThis.DLSSRuntime.getNativeSR() );

		const el = document.createElement( 'script' );
		el.src = dlssRuntimeUrl;
		el.onload = () => {

			const factory = globalThis.DLSSRuntime?.getNativeSR;
			if ( ! factory ) return reject( new Error( 'DLSS runtime loaded but exposed no super-resolution entry' ) );
			resolve( factory() );

		};

		el.onerror = () => reject( new Error( `Failed to load the DLSS runtime from ${dlssRuntimeUrl}` ) );
		document.head.appendChild( el );

	} );

	return _runtimePromise;

}

const _f32 = new Float32Array( 1 );
const _u32 = new Uint32Array( _f32.buffer );

function toHalf( v ) {

	_f32[ 0 ] = v;
	const x = _u32[ 0 ];
	const s = ( x >>> 16 ) & 0x8000;
	const e = ( x >>> 23 ) & 0xff;
	const m = x & 0x7fffff;

	if ( e === 255 ) return s | ( m ? 0x7e00 : 0x7c00 );

	const ne = e - 112;
	if ( ne >= 31 ) return s | 0x7c00;
	if ( ne <= 0 ) {

		if ( ne < - 10 ) return s;
		return s | ( ( m | 0x800000 ) >>> ( 14 - ne ) );

	}

	return s | ( ne << 10 ) | ( m >>> 13 );

}

function fromHalf( u ) {

	const s = ( u & 0x8000 ) ? - 1 : 1;
	const e = ( u >> 10 ) & 0x1f;
	const m = u & 0x3ff;
	if ( e === 0 ) return s * m * 2 ** - 24;
	if ( e === 31 ) return m ? NaN : s * Infinity;
	return s * ( m + 1024 ) * 2 ** ( e - 25 );

}

/**
 * Reads the denoised picture as linear RGB.
 *
 * `renderToBuffer()` cannot be used here: it reads `pathtracer:color`, which is upstream of the
 * Compositor and so never contains OIDN's result. Feeding the network raw Monte-Carlo noise
 * measurably loses to plain bilinear, so the denoised image is the whole point.
 *
 * @param {import('../Passes/OIDNDenoiser.js').OIDNDenoiser} denoiser
 * @returns {Promise<{data: Float32Array, width: number, height: number}>}
 */
export async function readDenoisedLinear( denoiser ) {

	const texture = denoiser?._outGPUTexture;
	if ( ! texture ) throw new Error( 'DLSSSuperRes: no denoised frame — enable OIDN and finish a render first' );

	const device = denoiser.gpuDevice;
	const { width, height } = denoiser._outTexSize;
	const bytesPerRow = Math.ceil( width * 8 / 256 ) * 256;

	const readback = device.createBuffer( {
		label: 'rayzee:dlss-sr-denoised-read',
		size: bytesPerRow * height,
		usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
	} );

	const encoder = device.createCommandEncoder( { label: 'rayzee:dlss-sr-denoised-read' } );
	encoder.copyTextureToBuffer(
		{ texture },
		{ buffer: readback, bytesPerRow, rowsPerImage: height },
		[ width, height, 1 ],
	);
	device.queue.submit( [ encoder.finish() ] );

	await readback.mapAsync( GPUMapMode.READ );
	const half = new Uint16Array( readback.getMappedRange().slice( 0 ) );
	readback.unmap();
	readback.destroy();

	const strideHalfs = bytesPerRow / 2;
	const data = new Float32Array( width * height * 3 );
	for ( let y = 0; y < height; y ++ ) {

		let si = y * strideHalfs;
		let di = y * width * 3;
		for ( let x = 0; x < width; x ++ ) {

			data[ di ] = fromHalf( half[ si ] );
			data[ di + 1 ] = fromHalf( half[ si + 1 ] );
			data[ di + 2 ] = fromHalf( half[ si + 2 ] );
			si += 4;
			di += 3;

		}

	}

	return { data, width, height };

}

export class DLSSSuperRes {

	constructor( sr, canvas ) {

		this.sr = sr;
		this.canvas = canvas;
		this.slot = 0;
		this._color = null;
		this._depth = null;
		this._motion = null;
		this.disposed = false;

	}

	get geometry() {

		return this.sr.geometry;

	}

	get inputWidth() {

		return this.sr.geometry.width;

	}

	get inputHeight() {

		return this.sr.geometry.height;

	}

	get outputWidth() {

		return this.sr.geometry.outputWidth;

	}

	get outputHeight() {

		return this.sr.geometry.outputHeight;

	}

	/**
	 * @param {object} opts
	 * @param {number} opts.width  input (traced) width — output is twice this
	 * @param {number} opts.height input (traced) height
	 */
	static async create( { width, height, onProgress = () => {} } = {} ) {

		if ( ! Number.isInteger( width ) || ! Number.isInteger( height ) || width < 1 || height < 1 ) {

			throw new Error( 'DLSSSuperRes.create: width and height must be positive integers' );

		}

		if ( width > SR_MAX_INPUT || height > SR_MAX_INPUT ) {

			throw new Error( `DLSSSuperRes.create: input capped at ${SR_MAX_INPUT}px, got ${width}x${height}` );

		}

		const NativeSR = await loadRuntime();

		const canvas = document.createElement( 'canvas' );
		canvas.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';
		document.body.appendChild( canvas );

		let sr;
		try {

			sr = await NativeSR.create( canvas, { width, height, onProgress, timestamps: true, nrSettings: null } );

		} catch ( e ) {

			canvas.remove();
			throw e;

		}

		const instance = new DLSSSuperRes( sr, canvas );
		instance._allocate();
		return instance;

	}

	_allocate() {

		const w = this.inputWidth;
		const h = this.inputHeight;
		this._color = new Uint16Array( w * h * 4 );
		this._depth = new Float32Array( w * h );
		this._motion = new Uint16Array( w * h * 2 );

	}

	/**
	 * Upscales one linear-RGB image. The caller supplies the picture rather than the stage name so
	 * this stays usable for a frame that was captured earlier.
	 *
	 * @param {{data: Float32Array, width: number, height: number}} source linear RGB, 3 floats/px
	 * @returns {Promise<{data: Float32Array, width: number, height: number, ms: number}>} linear RGB
	 */
	async upscale( source ) {

		if ( this.disposed ) throw new Error( 'DLSSSuperRes: disposed' );

		const w = this.inputWidth;
		const h = this.inputHeight;
		if ( source.width !== w || source.height !== h ) {

			throw new Error( `DLSSSuperRes: expected a ${w}x${h} source, got ${source.width}x${source.height}` );

		}

		const color = this._color;
		for ( let i = 0, n = w * h; i < n; i ++ ) {

			color[ i * 4 ] = toHalf( source.data[ i * 3 ] );
			color[ i * 4 + 1 ] = toHalf( source.data[ i * 3 + 1 ] );
			color[ i * 4 + 2 ] = toHalf( source.data[ i * 3 + 2 ] );
			color[ i * 4 + 3 ] = 0x3c00;

		}

		// A still frame has no motion and no disocclusion, so depth only has to be uniform and finite.
		this._depth.fill( 0.5 );
		this._motion.fill( 0 );

		const started = performance.now();
		const result = await this.sr.render( this.slot, {
			color,
			depth: this._depth,
			motion: this._motion,
			reset: true,
			jitter: [ 0, 0 ],
		} );
		await this.sr.device.queue.onSubmittedWorkDone();
		const ms = performance.now() - started;

		return { ...( await this._readHDR( result ) ), ms };

	}

	/**
	 * Pulls the network's own linear output rather than the presented canvas, which would have had a
	 * clamp and an sRGB encode baked in. ⚠️ The network emits its picture vertically flipped.
	 */
	async _readHDR( result ) {

		const device = this.sr.device;
		const { hdrBytes, outputWidth, outputHeight } = this.geometry;

		const readback = device.createBuffer( {
			label: 'rayzee:dlss-sr-out',
			size: hdrBytes,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		} );

		const encoder = device.createCommandEncoder( { label: 'rayzee:dlss-sr-out' } );
		encoder.copyBufferToBuffer( result.hdr.buffer ?? result.hdr, 0, readback, 0, hdrBytes );
		device.queue.submit( [ encoder.finish() ] );

		await readback.mapAsync( GPUMapMode.READ );
		const half = new Uint16Array( readback.getMappedRange().slice( 0 ) );
		readback.unmap();
		readback.destroy();

		const data = new Float32Array( outputWidth * outputHeight * 3 );
		for ( let y = 0; y < outputHeight; y ++ ) {

			const flipped = outputHeight - 1 - y;
			let si = flipped * outputWidth * 4;
			let di = y * outputWidth * 3;
			for ( let x = 0; x < outputWidth; x ++ ) {

				data[ di ] = fromHalf( half[ si ] );
				data[ di + 1 ] = fromHalf( half[ si + 1 ] );
				data[ di + 2 ] = fromHalf( half[ si + 2 ] );
				si += 4;
				di += 3;

			}

		}

		return { data, width: outputWidth, height: outputHeight };

	}

	dispose() {

		if ( this.disposed ) return;
		this.disposed = true;
		this.canvas.remove();
		try {

			this.sr.destroy();

		} catch ( e ) {

			console.warn( 'DLSSSuperRes: teardown', e );

		}

	}

}

function waitForDenoise( app, samples, timeoutMs ) {

	return new Promise( ( resolve, reject ) => {

		let settled = false;
		const finish = ( ok, err ) => {

			if ( settled ) return;
			settled = true;
			app.removeEventListener( EngineEvents.DENOISING_END, onEnd );
			clearInterval( poll );
			clearTimeout( timer );
			ok ? resolve() : reject( err );

		};

		// Only a denoise that lands once the sample target is met counts. A denoise left in flight by
		// the previous render can arrive after this listener attaches and would otherwise end the
		// wait on the wrong frame.
		let denoised = false;
		const onEnd = () => {

			if ( ( app.stages?.pathTracer?.frameCount ?? 0 ) >= samples ) denoised = true;

		};

		app.addEventListener( EngineEvents.DENOISING_END, onEnd );

		const poll = setInterval( () => {

			if ( denoised ) finish( true );

		}, 200 );

		const timer = setTimeout(
			() => finish( false, new Error( 'DLSSSuperRes: timed out waiting for the render to finish' ) ),
			timeoutMs,
		);

	} );

}

/**
 * Renders the scene at half the requested size, denoises it, and upscales to full size.
 *
 * Restores render size, sample ceiling and denoiser state before returning, including on failure.
 *
 * @param {object}  opts
 * @param {number}  opts.outputWidth   final width; must be even
 * @param {number}  opts.outputHeight  final height; must be even
 * @param {number}  [opts.samples]     samples to accumulate at half resolution
 * @param {DLSSSuperRes} [opts.upscaler] reuse an upscaler already built for this size
 * @param {boolean} [opts.present]  draw the result over the viewport
 * @returns {Promise<{linear: object, rgba8: Uint8ClampedArray, width: number, height: number, timings: object}>}
 */
export async function renderUpscaled( app, {
	outputWidth,
	outputHeight,
	samples = 64,
	upscaler = null,
	timeoutMs = 600000,
	present = true,
	onProgress = () => {},
} = {} ) {

	if ( outputWidth % SR_SCALE || outputHeight % SR_SCALE ) {

		throw new Error( `renderUpscaled: output must be divisible by ${SR_SCALE}, got ${outputWidth}x${outputHeight}` );

	}

	const inW = outputWidth / SR_SCALE;
	const inH = outputHeight / SR_SCALE;

	const pathTracer = app.stages?.pathTracer;
	const restore = {
		width: pathTracer?.width,
		height: pathTracer?.height,
		maxSamples: app.settings?.get?.( 'maxSamples' ),
		finalDenoise: app.denoisingManager?.finalDenoise,
		paused: app.pauseRendering,
	};

	const owned = ! upscaler;
	let sr = upscaler;
	const timings = {};

	try {

		if ( ! sr ) {

			const t = performance.now();
			onProgress( 'Loading the super-resolution model' );
			sr = await DLSSSuperRes.create( { width: inW, height: inH, onProgress } );
			timings.load = performance.now() - t;

		} else if ( sr.inputWidth !== inW || sr.inputHeight !== inH ) {

			throw new Error( `renderUpscaled: upscaler is ${sr.inputWidth}x${sr.inputHeight}, need ${inW}x${inH}` );

		}

		const tRender = performance.now();
		onProgress( `Tracing ${inW}x${inH} at ${samples} spp` );
		app.pauseRendering = false;
		app.setCanvasSize( inW, inH );
		await new Promise( r => setTimeout( r, 300 ) );

		app.denoisingManager.applyOIDNEnabled( true );
		app.settings.set( 'maxSamples', samples );
		const done = waitForDenoise( app, samples, timeoutMs );
		app.reset();
		await done;
		app.pauseRendering = true;
		timings.render = performance.now() - tRender;

		onProgress( 'Reading the denoised frame' );
		const tRead = performance.now();
		const source = await readDenoisedLinear( app.denoisingManager?.denoiser );
		timings.read = performance.now() - tRead;

		onProgress( `Upscaling to ${outputWidth}x${outputHeight}` );
		const linear = await sr.upscale( source );
		timings.upscale = linear.ms;

		const rgba8 = toneMapToRGBA8( expandToRGBA( linear ), {
			exposure: app.renderer.toneMappingExposure,
			toneMapping: app.renderer.toneMapping,
			saturation: app.settings.get( 'saturation' ) ?? 1,
		} );

		if ( present ) presentToUpscalerCanvas( app.denoisingManager?.upscalerCanvas, rgba8, linear.width, linear.height );

		return { linear, rgba8, width: linear.width, height: linear.height, timings, upscaler: sr };

	} catch ( e ) {

		// An upscaler built inside this call has no other owner, so it would otherwise leak its
		// device and 3 MB of weights on the failure path.
		if ( owned ) sr?.dispose();
		throw e;

	} finally {

		if ( restore.width && restore.height ) app.setCanvasSize( restore.width, restore.height );
		if ( restore.maxSamples !== undefined ) app.settings?.set?.( 'maxSamples', restore.maxSamples );
		if ( restore.finalDenoise !== undefined ) app.denoisingManager?.applyOIDNEnabled( restore.finalDenoise );
		app.pauseRendering = restore.paused;

	}

}

/** `toneMapToRGBA8` consumes 4-channel linear data. */
function expandToRGBA( { data, width, height } ) {

	const out = new Float32Array( width * height * 4 );
	for ( let i = 0, n = width * height; i < n; i ++ ) {

		out[ i * 4 ] = data[ i * 3 ];
		out[ i * 4 + 1 ] = data[ i * 3 + 1 ];
		out[ i * 4 + 2 ] = data[ i * 3 + 2 ];
		out[ i * 4 + 3 ] = 1;

	}

	return out;

}

/**
 * Shows the result on the engine's 2D overlay — the same canvas the AI upscaler uses, because this
 * picture is also larger than the render and also in ordinary pixels.
 */
function presentToUpscalerCanvas( canvas, rgba8, width, height ) {

	if ( ! canvas ) return false;

	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext( '2d' );
	ctx.putImageData( new ImageData( new Uint8ClampedArray( rgba8.buffer ?? rgba8 ), width, height ), 0, 0 );
	canvas.style.display = 'block';
	return true;

}

/**
 * Tone-maps a linear image with the engine's own curve and draws it on the overlay.
 *
 * Used when the detail pass is off: that pass presents in its own display space, so this is the
 * only path where the enlarged picture still matches the viewport's look.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{data: Float32Array, width: number, height: number}} image linear RGB
 * @param {{exposure: number, toneMapping: number, saturation: number}} tone
 */
export function presentLinear( canvas, image, tone = {} ) {

	const rgba8 = toneMapToRGBA8( expandToRGBA( image ), {
		exposure: tone.exposure ?? 1,
		toneMapping: tone.toneMapping,
		saturation: tone.saturation ?? 1,
	} );

	return presentToUpscalerCanvas( canvas, rgba8, image.width, image.height );

}
