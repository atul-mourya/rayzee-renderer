/**
 * Neural super resolution — final-render output scaling.
 *
 * Traces at half resolution, denoises, then runs one neural upscale to reach the
 * requested output size. On a 1.89M-triangle interior at 32 spp this matched a
 * native full-resolution render for accuracy while resolving visibly more detail,
 * for a quarter of the traced pixels.
 *
 * Deliberately *not* wired into the live pipeline: the network costs ~132 ms of GPU
 * at 1920x1080, which is free against a final render and ruinous against a frame.
 *
 * The pass is GPU-bound by design. Every crossing of the CPU boundary is a compute pass: the
 * denoised frame is packed to rgba16float on the renderer's device (`readDenoisedHalf`), and the
 * result leaves the model's device either as display bytes (`upscaleToRGBA8`) or as packed halves
 * for the detail pass (`upscaleToHalf`). Nothing crosses in floats and no per-pixel JavaScript runs,
 * so the wall clock is the network plus two readbacks.
 *
 * Measured on a 1.89M-triangle interior, warm: 1024² → 2048² fell from 540 ms to 260 ms, and
 * 2048² → 4096² from 2.41 s to 947 ms — of which 922 ms is the network, 9 ms the input read and
 * 13 ms the tone map and its readback. Plumbing is 2 % of the pass, so the only remaining lever on
 * output size is the network itself.
 *
 * ⚠️ The FIRST pass after a resolution change rebuilds the graph: 266 ms vs 136 ms warm at 1024²
 * output, 762 ms vs 531 ms at 2048².
 *
 * ⚠️ Each neural model brings **its own GPUDevice**, built by the runtime and not shareable. With
 * super resolution and the detail pass both on, the page holds three: the renderer's, and one each.
 */

import { EngineEvents } from '../EngineEvents.js';
import { createLogger } from '../utils/Logger.js';
import { PackedToneMapper } from '../Processor/ToneMapGPU.js';
import { getAssetConfig } from '../AssetConfig.js';

/** The network is a fixed 2x per axis. */
export const SR_SCALE = 2;

const log = createLogger( 'neural' );

/**
 * Largest input side the runtime actually survives — 2048, i.e. 4096 output.
 *
 * The runtime advertises 4096 and validates against it, but two walls sit lower and both were hit
 * by measurement rather than reading:
 *
 *  - It allocates a "retained history" plane at **4x the input dimension** and requests no raised
 *    limit, so 2049+ input exceeds the default `maxTextureDimension2D` of 8192. The failure surfaces
 *    much later and unhelpfully, as an invalid bind group in an unrelated pass. The adapter here
 *    supports 16384, so patching the runtime's `requestDevice` would lift this one.
 *  - Its "arbitrary exposure" pass dispatches `ceil(w * h / 256)` workgroups in X, so an input area
 *    of 16,777,216 px — exactly 4096² — asks for 65,536 against WebGPU's 65,535 limit. One over.
 *    That wall does not move without changing the dispatch, so square 8192 output is unreachable
 *    even with the texture limit raised.
 *
 * 2048 also happens to be `MAX_STORAGE_TEXTURE_SIZE`, the engine's own default render reserve, so
 * nothing is lost in practice today.
 */
export const SR_MAX_INPUT = 2048;

let _runtimePromise = null;

function loadRuntime() {

	if ( _runtimePromise ) return _runtimePromise;

	const { neuralRuntimeUrl, neuralAssetBaseUrl } = getAssetConfig();
	if ( ! neuralAssetBaseUrl ) return Promise.reject( new Error( 'No neural model location: set neuralAssetBaseUrl with configureAssets()' ) );
	globalThis.__NEURAL_ASSET_BASE__ = neuralAssetBaseUrl;

	_runtimePromise = new Promise( ( resolve, reject ) => {

		if ( globalThis.NeuralRuntime?.getNativeSR ) return resolve( globalThis.NeuralRuntime.getNativeSR() );

		const el = document.createElement( 'script' );
		el.src = neuralRuntimeUrl;
		el.onload = () => {

			const factory = globalThis.NeuralRuntime?.getNativeSR;
			if ( ! factory ) return reject( new Error( 'Neural runtime loaded but exposed no super-resolution entry' ) );
			resolve( factory() );

		};

		el.onerror = () => reject( new Error( `Failed to load the neural runtime from ${neuralRuntimeUrl}` ) );
		document.head.appendChild( el );

	} );

	return _runtimePromise;

}

const DENOISED_PACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;

@compute @workgroup_size(8, 8)
fn main( @builtin(global_invocation_id) gid: vec3<u32> ) {
	let size = textureDimensions( src );
	if ( gid.x >= size.x || gid.y >= size.y ) { return; }
	let c = textureLoad( src, vec2<i32>( gid.xy ), 0 ).rgb;
	let a = ( gid.y * size.x + gid.x ) * 2u;
	dst[ a ] = pack2x16float( c.rg );
	dst[ a + 1u ] = pack2x16float( vec2<f32>( c.b, 1.0 ) );
}
`;

/**
 * Cached on the module rather than on the denoiser, which is engine-owned and should not grow a
 * field for this. `releaseDenoisedReader()` is called from `DenoisingManager`'s teardown.
 */
let _reader = null;

function ensureReader( device, width, height ) {

	if ( _reader && ( _reader.device !== device || _reader.width !== width || _reader.height !== height ) ) {

		releaseDenoisedReader();

	}

	if ( _reader ) return _reader;

	const bytes = width * height * 8;
	_reader = {
		device,
		width,
		height,
		storage: device.createBuffer( {
			label: 'rayzee:neural-sr-pack',
			size: bytes,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
		} ),
		map: device.createBuffer( {
			label: 'rayzee:neural-sr-pack-map',
			size: bytes,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		} ),
		pipeline: device.createComputePipeline( {
			label: 'rayzee:neural-sr-pack',
			layout: 'auto',
			compute: {
				module: device.createShaderModule( { label: 'rayzee:neural-sr-pack', code: DENOISED_PACK_WGSL } ),
				entryPoint: 'main',
			},
		} ),
	};

	return _reader;

}

/** Frees the packing buffers — ~26 MB at a 2048² render. */
export function releaseDenoisedReader() {

	_reader?.storage.destroy();
	_reader?.map.destroy();
	_reader = null;

}

/**
 * Reads the denoised picture already packed the way the network wants it: tightly packed
 * rgba16float, alpha 1, no row padding. Feed it straight to `upscale()` / `upscaleToRGBA8()`.
 *
 * The half floats never become JavaScript numbers, which is the whole point — reaching the same
 * bytes through a float array cost two full-image loops and a 50 MB allocation at a 2048² render.
 *
 * @param {import('../Passes/OIDNDenoiser.js').OIDNDenoiser} denoiser
 * @returns {Promise<{half: Uint16Array, width: number, height: number}>}
 */
export async function readDenoisedHalf( denoiser ) {

	const texture = denoiser?._outGPUTexture;
	if ( ! texture ) throw new Error( 'NeuralSuperRes: no denoised frame — enable OIDN and finish a render first' );

	const device = denoiser.gpuDevice;
	const { width, height } = denoiser._outTexSize;
	const reader = ensureReader( device, width, height );
	const group = device.createBindGroup( {
		layout: reader.pipeline.getBindGroupLayout( 0 ),
		entries: [
			{ binding: 0, resource: texture.createView() },
			{ binding: 1, resource: { buffer: reader.storage } },
		],
	} );

	const encoder = device.createCommandEncoder( { label: 'rayzee:neural-sr-pack' } );
	const pass = encoder.beginComputePass();
	pass.setPipeline( reader.pipeline );
	pass.setBindGroup( 0, group );
	pass.dispatchWorkgroups( Math.ceil( width / 8 ), Math.ceil( height / 8 ) );
	pass.end();
	encoder.copyBufferToBuffer( reader.storage, 0, reader.map, 0, width * height * 8 );
	device.queue.submit( [ encoder.finish() ] );

	await reader.map.mapAsync( GPUMapMode.READ );
	const half = new Uint16Array( reader.map.getMappedRange().slice( 0 ) );
	reader.map.unmap();

	return { half, width, height };

}

export class NeuralSuperRes {

	constructor( sr, canvas ) {

		this.sr = sr;
		this.canvas = canvas;
		this.slot = 0;
		this._color = null;
		this._depth = null;
		this._motion = null;
		this._toneMapper = null;
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

			throw new Error( 'NeuralSuperRes.create: width and height must be positive integers' );

		}

		if ( width > SR_MAX_INPUT || height > SR_MAX_INPUT ) {

			throw new Error(
				`NeuralSuperRes.create: input capped at ${SR_MAX_INPUT}px per side (${SR_MAX_INPUT * SR_SCALE}px output), ` +
				`got ${width}x${height}. Above that the runtime's history plane exceeds maxTextureDimension2D ` +
				'and it fails later with an unrelated bind-group error.'
			);

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

		const instance = new NeuralSuperRes( sr, canvas );
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

	/** Runs the network once over a frame already in its own layout, as `readDenoisedHalf` returns. */
	async _run( source ) {

		if ( this.disposed ) throw new Error( 'NeuralSuperRes: disposed' );

		const w = this.inputWidth;
		const h = this.inputHeight;
		if ( source.width !== w || source.height !== h ) {

			throw new Error( `NeuralSuperRes: expected a ${w}x${h} source, got ${source.width}x${source.height}` );

		}

		const color = this._color;
		if ( ! source.half || source.half.length !== color.length ) {

			throw new Error(
				`NeuralSuperRes: expected ${color.length} packed halfs from readDenoisedHalf, got ${source.half?.length}`
			);

		}

		color.set( source.half );

		// Depth and motion are both provably inert on this path, so the constants below cost nothing:
		// with `reset: true` the output is bit-identical for depth 0.0 / 0.5 / 1.0 and for motion zero
		// vs 5 % of the frame. That matches the shaders — `raw_motion` is reachable only from a debug
		// branch, and `raw_depth` only from a history-gated address path. Feeding the engine's real
		// depth and motion vectors here would change nothing.
		//
		// Jitter is the one input that DOES move the result, and [0,0] is right for this use: a
		// converged accumulation is the average over the pixel, i.e. its centre.
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

		return { result, ms: performance.now() - started };

	}

	/**
	 * Upscales one image and tone-maps it to display bytes without leaving the card.
	 *
	 * @param {{half: Uint16Array, width: number, height: number}} source
	 * @param {{exposure: number, toneMapping: number, saturation: number}} tone engine display state
	 * @returns {Promise<{rgba8: Uint8ClampedArray, width: number, height: number, ms: number, toneMs: number}>}
	 */
	async upscaleToRGBA8( source, tone = {} ) {

		const { result, ms } = await this._run( source );
		const { outputWidth, outputHeight } = this.geometry;

		this._toneMapper ??= new PackedToneMapper( this.sr.device, 'rayzee:neural-sr-tonemap' );
		this._toneMapper.ensureSize( outputWidth, outputHeight );

		const started = performance.now();
		const rgba8 = await this._toneMapper.toRGBA8( result.hdr.buffer ?? result.hdr, {
			exposure: tone.exposure ?? 1,
			toneMapping: tone.toneMapping ?? 0,
			saturation: tone.saturation ?? 1,
			// The network emits its picture vertically flipped.
			flipY: true,
		} );

		return { rgba8, width: outputWidth, height: outputHeight, ms, toneMs: performance.now() - started };

	}

	dispose() {

		if ( this.disposed ) return;
		this.disposed = true;
		this._toneMapper?.dispose();
		this._toneMapper = null;
		this.canvas.remove();
		try {

			this.sr.destroy();

		} catch ( e ) {

			log.warn( 'super resolution teardown:', e );

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
			() => finish( false, new Error( 'NeuralSuperRes: timed out waiting for the render to finish' ) ),
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
 * @param {NeuralSuperRes} [opts.upscaler] reuse an upscaler already built for this size
 * @param {boolean} [opts.present]  draw the result over the viewport
 * @returns {Promise<{rgba8: Uint8ClampedArray, width: number, height: number, timings: object}>}
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
			sr = await NeuralSuperRes.create( { width: inW, height: inH, onProgress } );
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
		const source = await readDenoisedHalf( app.denoisingManager?.denoiser );
		timings.read = performance.now() - tRead;

		onProgress( `Upscaling to ${outputWidth}x${outputHeight}` );
		const tone = {
			exposure: app.renderer.toneMappingExposure,
			toneMapping: app.renderer.toneMapping,
			saturation: app.settings.get( 'saturation' ) ?? 1,
		};

		const { rgba8, width, height, ms, toneMs } = await sr.upscaleToRGBA8( source, tone );
		timings.upscale = ms;
		timings.tonemap = toneMs;

		if ( present ) presentToUpscalerCanvas( app.denoisingManager?.upscalerCanvas, rgba8, width, height );

		return { rgba8, width, height, timings, upscaler: sr };

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
 * Draws ready RGBA bytes onto the overlay. For the detail pass, whose result comes back as bytes
 * rather than linear floats — it is display-referred by the time we can read it.
 */
export function presentRGBA8( canvas, rgba8, width, height ) {

	return presentToUpscalerCanvas( canvas, rgba8, width, height );

}
