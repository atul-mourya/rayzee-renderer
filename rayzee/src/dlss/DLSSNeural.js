/**
 * DLSS-NR — the neural-rendering (detail) pass.
 *
 * Runs over a finished, denoised image and adjusts its appearance: local tone and structure, and a
 * skin-specific term. It does not change resolution and it does not denoise. Measured on path-traced
 * input it is close to a no-op after OIDN, so it is off by default and exposed as an explicit choice.
 *
 * ⚠️ It is always LAST in the neural chain: its output is `rgba8unorm`, i.e. display-referred 8-bit,
 * so nothing downstream can work with it in linear light.
 *
 * Its result IS recoverable, though not the obvious way. The texture has no `COPY_SRC`, and its own
 * canvas is a WebGPU surface that reads back empty at every timing tried (immediately, after one
 * rAF, after two) — so neither `copyTextureToBuffer` nor `drawImage` works. It does carry
 * `TEXTURE_BINDING`, so a small compute pass of our own samples it into a storage buffer instead.
 * That is what makes the pass saveable, and lets it share the engine's one 2D overlay rather than
 * needing a second canvas whose context type conflicts.
 *
 * ⚠️ **It desaturates, and there is no lever for it.** Driven at `intensity: 0`, where the network
 * returns its input untouched, the result still differs from the engine's own render: luminance is
 * nearly exact (94.4 vs 94.0) but chroma is ~10 % low (saturation 0.313 vs 0.348). So the pass
 * reproduces brightness faithfully and loses colour, inside its own preprocessing — its presentation
 * shader is a plain `textureSample` blit with no display controls, and the `override ACES /
 * SATURATION` block in the bundle belongs to the SUPER-RESOLUTION presenter, not this one.
 *
 * Pre-tone-mapping the input to compensate was tried and measured WORSE — passthrough error doubled
 * (RMSE 5.1 -> 10.8) and the image came out over-saturated, because the network then applies its own
 * handling on top. Feeding it scene-referred linear, as here, is both the model's intended domain and
 * the more faithful of the two. A real fix would have to reach inside the vendored runtime.
 */

import { getAssetConfig } from '../AssetConfig.js';

/**
 * The model's own settings contract. Every field is numeric and validated hard by the runtime —
 * passing a string throws `"<name> must be finite"`.
 */
export const DLSS_NR_DEFAULTS = Object.freeze( {
	enabled: true,
	intensity: 1,
	localTone: 1,
	localStructure: 1,
	skinStructure: - 1,
	autoMask: true,
	style: 0,
	preset: 0,
	uiCorrection: false,
} );

/** Ranges the runtime clamps to. `skinStructure: -1` means "follow localStructure". */
export const DLSS_NR_RANGES = Object.freeze( {
	intensity: [ 0, 1 ],
	localTone: [ 0, 2 ],
	localStructure: [ 0, 2 ],
	skinStructure: [ - 1, 2 ],
	style: [ 0, 2 ],
	preset: [ 0, 3 ],
} );

let _runtimePromise = null;

/**
 * The runtime is a plain script that installs `globalThis.DLSSRuntime`, not a module, so it has to
 * be injected rather than imported. Cached: a second tag would re-run a 1 MB bundle.
 */
function loadRuntime() {

	if ( _runtimePromise ) return _runtimePromise;

	const { dlssRuntimeUrl, dlssAssetBaseUrl } = getAssetConfig();
	globalThis.__DLSS5_ASSET_BASE__ = dlssAssetBaseUrl;

	_runtimePromise = new Promise( ( resolve, reject ) => {

		if ( globalThis.DLSSRuntime?.getSrNrChain ) return resolve( globalThis.DLSSRuntime.getSrNrChain() );

		const el = document.createElement( 'script' );
		el.src = dlssRuntimeUrl;
		el.onload = () => {

			const factory = globalThis.DLSSRuntime?.getSrNrChain;
			if ( ! factory ) return reject( new Error( 'DLSS runtime loaded but exposed no neural-rendering entry' ) );
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

const READBACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let size = textureDimensions(src);
	if ( gid.x >= size.x || gid.y >= size.y ) { return; }
	let c = textureLoad(src, vec2<i32>(gid.xy), 0);
	let r = u32(clamp(c.r, 0.0, 1.0) * 255.0 + 0.5);
	let g = u32(clamp(c.g, 0.0, 1.0) * 255.0 + 0.5);
	let b = u32(clamp(c.b, 0.0, 1.0) * 255.0 + 0.5);
	dst[gid.y * size.x + gid.x] = r | (g << 8u) | (b << 16u) | (255u << 24u);
}
`;

/**
 * One loaded network, bound to one image size and one canvas.
 *
 * Holds a GPUDevice of its own (the runtime builds it) plus ~140 MB of weights, so it must be
 * disposed rather than dropped.
 */
export class DLSSNeural {

	constructor( chain, canvas ) {

		this.chain = chain;
		this.canvas = canvas;
		this.slot = 0;
		this.source = null;
		this.staging = null;
		this._readbackPipeline = null;
		this._readbackStorage = null;
		this._readbackMap = null;
		this.disposed = false;

	}

	get device() {

		return this.chain.device;

	}

	get width() {

		return this.chain.pipeline.geometry.validWidth;

	}

	get height() {

		return this.chain.pipeline.geometry.validHeight;

	}

	/**
	 * @param {object} opts
	 * @param {number} opts.width
	 * @param {number} opts.height
	 * @param {HTMLCanvasElement} [opts.canvas] surface the runtime presents to. Offscreen by
	 *   default: the result is taken with `readOutput()`, not from this canvas, which cannot be read.
	 */
	static async create( { width, height, canvas = null, settings = {}, onProgress = () => {} } ) {

		if ( ! Number.isInteger( width ) || ! Number.isInteger( height ) || width < 1 || height < 1 ) {

			throw new Error( 'DLSSNeural.create: width and height must be positive integers' );

		}

		// The runtime insists on a canvas (it sizes it and takes a WebGPU context), but nothing reads
		// it — so one is made here and kept off screen unless the caller supplies its own.
		const surface = canvas ?? document.createElement( 'canvas' );
		if ( ! canvas ) surface.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';

		const SrNrChain = await loadRuntime();
		const chain = await SrNrChain.create(
			surface, width, height, onProgress, { ...DLSS_NR_DEFAULTS, ...settings },
		);

		const instance = new DLSSNeural( chain, surface );
		instance._allocate();
		return instance;

	}

	_allocate() {

		const { validWidth, validHeight } = this.chain.pipeline.geometry;

		this.source = this.device.createBuffer( {
			label: 'rayzee:dlss-nr-source',
			size: validWidth * validHeight * 8,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		} );

		this.staging = new Uint16Array( validWidth * validHeight * 4 );

		const bytes = validWidth * validHeight * 4;
		this._readbackStorage = this.device.createBuffer( {
			label: 'rayzee:dlss-nr-readback',
			size: bytes,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
		} );
		this._readbackMap = this.device.createBuffer( {
			label: 'rayzee:dlss-nr-readback-map',
			size: bytes,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		} );
		this._readbackPipeline = this.device.createComputePipeline( {
			label: 'rayzee:dlss-nr-readback',
			layout: 'auto',
			compute: { module: this.device.createShaderModule( { code: READBACK_WGSL } ), entryPoint: 'main' },
		} );

	}

	/**
	 * Samples the pass's own output texture into ordinary RGBA bytes.
	 *
	 * @returns {Promise<Uint8ClampedArray>} RGBA, width*height*4
	 */
	async readOutput() {

		const { validWidth: w, validHeight: h } = this.chain.pipeline.geometry;
		const texture = this.chain.pipeline.slots[ this.slot ]?.output;
		if ( ! texture ) throw new Error( 'DLSSNeural.readOutput: the pass has not produced a frame yet' );

		const group = this.device.createBindGroup( {
			layout: this._readbackPipeline.getBindGroupLayout( 0 ),
			entries: [
				{ binding: 0, resource: texture.createView() },
				{ binding: 1, resource: { buffer: this._readbackStorage } },
			],
		} );

		const encoder = this.device.createCommandEncoder( { label: 'rayzee:dlss-nr-readback' } );
		const pass = encoder.beginComputePass();
		pass.setPipeline( this._readbackPipeline );
		pass.setBindGroup( 0, group );
		pass.dispatchWorkgroups( Math.ceil( w / 8 ), Math.ceil( h / 8 ) );
		pass.end();
		encoder.copyBufferToBuffer( this._readbackStorage, 0, this._readbackMap, 0, w * h * 4 );
		this.device.queue.submit( [ encoder.finish() ] );

		await this._readbackMap.mapAsync( GPUMapMode.READ );
		const bytes = new Uint8ClampedArray( this._readbackMap.getMappedRange().slice( 0 ) );
		this._readbackMap.unmap();
		return bytes;

	}

	dispose() {

		if ( this.disposed ) return;
		this.disposed = true;
		this.source?.destroy();
		this._readbackStorage?.destroy();
		this._readbackMap?.destroy();
		try {

			this.chain.destroy();

		} catch ( e ) {

			console.warn( 'DLSSNeural: teardown', e );

		}

	}

}

/**
 * Runs the pass over a finished linear image and lets the network present it.
 *
 * Nothing useful is returned but the instance: see the file header — the result is not readable.
 *
 * @param {object} opts
 * @param {{data: Float32Array, width: number, height: number}} opts.source linear RGB, 3 floats/px
 * @param {number} [opts.exposure] applied on the way in; the network clamps to [0,1] internally
 * @param {DLSSNeural} [opts.instance] reuse a network already built for this size
 * @returns {Promise<{instance: DLSSNeural, rgba8: Uint8ClampedArray, width: number, height: number, ms: number}>}
 */
export async function enhanceLinearFrame( {
	source, settings = {}, instance = null, exposure = 1, onProgress = () => {},
} ) {

	let nr = instance;
	if ( nr && ( nr.width !== source.width || nr.height !== source.height ) ) {

		nr.dispose();
		nr = null;

	}

	if ( ! nr ) {

		nr = await DLSSNeural.create( {
			width: source.width, height: source.height, settings, onProgress,
		} );

	}

	const merged = { ...DLSS_NR_DEFAULTS, ...settings };
	const { width, height } = nr;
	const dst = nr.staging;

	for ( let i = 0, n = width * height; i < n; i ++ ) {

		// Exposure has to be applied here rather than after: the network works in display space and
		// clamps to [0,1], and there is no readable output left to scale.
		dst[ i * 4 ] = toHalf( source.data[ i * 3 ] * exposure );
		dst[ i * 4 + 1 ] = toHalf( source.data[ i * 3 + 1 ] * exposure );
		dst[ i * 4 + 2 ] = toHalf( source.data[ i * 3 + 2 ] * exposure );
		dst[ i * 4 + 3 ] = 0x3c00;

	}

	nr.device.queue.writeBuffer( nr.source, 0, dst );

	const started = performance.now();
	const encoder = nr.device.createCommandEncoder( { label: 'rayzee:dlss-nr' } );
	await nr.chain.encode( encoder, nr.slot, { buffer: nr.source }, merged, () => {}, { reset: true } );
	nr.device.queue.submit( [ encoder.finish() ] );
	await nr.device.queue.onSubmittedWorkDone();

	const rgba8 = await nr.readOutput();
	return { instance: nr, rgba8, width, height, ms: performance.now() - started };

}
