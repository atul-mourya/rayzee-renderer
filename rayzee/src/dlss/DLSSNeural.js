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

import { PackedToneMapper } from '../Processor/ToneMapGPU.js';
import { createLogger } from '../utils/Logger.js';
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

/**
 * How much of the network's own colour to take, 0..1. Ours, not the runtime's.
 *
 * ⚠️ It must be kept OUT of the object handed to the runtime: that one is validated by key and
 * throws `Unknown DLSS-NR setting: colorStrength`. `splitSettings` does the separating.
 *
 * It is `color_strength` in the composition kernel, blending between the original chroma relit to
 * the network's luminance (`original * ratio`, at 0) and the network's full colour (at 1). At 0 the
 * chroma is the renderer's own, exactly, so the pass contributes structure and light without
 * regrading.
 *
 * **Defaults to 0**, which is a change: the pass used to desaturate and there was thought to be no
 * lever. Measured on 24155522.glb at 2048 output, mean saturation against an upscale-only render:
 * colour 1 gives -6.1 %, 0.5 gives -5.1 %, **0 gives -1.1 %** — while luminance (+0.9 %) and detail
 * are the same at all three, so nothing the pass is actually for is given up. The renderer's chroma
 * is ground truth here; the network's is a guess about a photograph.
 */
export const DLSS_NR_COLOR_STRENGTH = 0;

/** @returns {{runtime: object, colorStrength: number}} */
function splitSettings( settings = {} ) {

	const { colorStrength = DLSS_NR_COLOR_STRENGTH, ...rest } = settings;
	return { runtime: { ...DLSS_NR_DEFAULTS, ...rest }, colorStrength };

}

/**
 * Largest image the pass survives — 4.19 MP, i.e. 2048x2048.
 *
 * Measured on an M5 Pro, 24155522.glb, warm, end to end with super resolution:
 *
 * | image | pixels | wall | outcome |
 * |---|---|---|---|
 * | 1536² | 2.4 MP | 5.3 s | fine |
 * | 2048² | 4.2 MP | 6.2 s, repeatable | fine |
 * | 4096² | 16.8 MP | 65-108 s | **kills Chrome's GPU process** |
 *
 * Four times the pixels costs ten to seventeen times the wall clock and then dies: every device in
 * the page is lost at once with "A valid external Instance reference no longer exists", which takes
 * the renderer and the finished render with it.
 *
 * ⚠️ The pass runs **before** super resolution precisely so this stays out of reach. On the traced
 * image it sees a quarter of the pixels it would after a 2x upscale, and the engine's own render
 * reserve (`MAX_STORAGE_TEXTURE_SIZE`, 2048) already caps that at exactly 4.19 MP. The check below
 * is therefore unreachable today and exists as a floor under a raised reserve.
 */
const log = createLogger( 'dlss' );

export const DLSS_NR_MAX_PIXELS = 2048 * 2048;

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

/** Same pack, but keeping the light: tight rgba16float, which is what the upscaler consumes. */
const HDR_READBACK_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> dst: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
	let size = textureDimensions(src);
	if ( gid.x >= size.x || gid.y >= size.y ) { return; }
	let c = textureLoad(src, vec2<i32>(gid.xy), 0);
	let a = (gid.y * size.x + gid.x) * 2u;
	dst[a] = pack2x16float(c.rg);
	dst[a + 1u] = pack2x16float(vec2<f32>(c.b, 1.0));
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
		this._hdrPipeline = null;
		this._hdrStorage = null;
		this._hdrMap = null;
		this._toneMapper = null;
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

		if ( width * height > DLSS_NR_MAX_PIXELS ) {

			throw new Error(
				`DLSSNeural.create: ${width}x${height} is ${( width * height / 1e6 ).toFixed( 1 )} MP, above the ` +
				`${( DLSS_NR_MAX_PIXELS / 1e6 ).toFixed( 1 )} MP this pass survives. Past it the run takes minutes ` +
				'and then loses every GPU device in the page.'
			);

		}

		// The runtime insists on a canvas (it sizes it and takes a WebGPU context), but nothing reads
		// it — so one is made here and kept off screen unless the caller supplies its own.
		const surface = canvas ?? document.createElement( 'canvas' );
		if ( ! canvas ) surface.style.cssText = 'position:fixed;left:-10000px;top:0;pointer-events:none';

		const SrNrChain = await loadRuntime();
		const chain = await SrNrChain.create(
			surface, width, height, onProgress, splitSettings( settings ).runtime,
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

		const hdrBytes = validWidth * validHeight * 8;
		this._hdrStorage = this.device.createBuffer( {
			label: 'rayzee:dlss-nr-hdr',
			size: hdrBytes,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
		} );
		this._hdrMap = this.device.createBuffer( {
			label: 'rayzee:dlss-nr-hdr-map',
			size: hdrBytes,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
		} );
		this._hdrPipeline = this.device.createComputePipeline( {
			label: 'rayzee:dlss-nr-hdr',
			layout: 'auto',
			compute: { module: this.device.createShaderModule( { code: HDR_READBACK_WGSL } ), entryPoint: 'main' },
		} );

	}

	/** Runs the scene-referred texture into `_hdrStorage`, optionally copying it out for mapping. */
	async _packHDR( w, h, forRead = false ) {

		const texture = this.chain.pipeline.slots[ this.slot ]?.hdrOutput;
		if ( ! texture ) {

			throw new Error(
				'DLSSNeural: the runtime has no scene-referred output. Either no frame has been produced yet, '
				+ 'or dlss-runtime.js was re-vendored without the patch described in its PATCHES.md.'
			);

		}

		const group = this.device.createBindGroup( {
			layout: this._hdrPipeline.getBindGroupLayout( 0 ),
			entries: [
				{ binding: 0, resource: texture.createView() },
				{ binding: 1, resource: { buffer: this._hdrStorage } },
			],
		} );

		const encoder = this.device.createCommandEncoder( { label: 'rayzee:dlss-nr-hdr' } );
		const pass = encoder.beginComputePass();
		pass.setPipeline( this._hdrPipeline );
		pass.setBindGroup( 0, group );
		pass.dispatchWorkgroups( Math.ceil( w / 8 ), Math.ceil( h / 8 ) );
		pass.end();
		if ( forRead ) encoder.copyBufferToBuffer( this._hdrStorage, 0, this._hdrMap, 0, w * h * 8 );
		this.device.queue.submit( [ encoder.finish() ] );

	}

	/**
	 * The pass's result as scene-referred light, packed the way the upscaler wants it.
	 *
	 * Reads `hdrOutput`, the `rgba16float` texture the vendored runtime gained in
	 * `app/public/dlss/PATCHES.md` — the value one statement before its own 8-bit store, so nothing
	 * has been clamped, quantised or pushed through the model's hardcoded ACES curve yet.
	 *
	 * This is what lets the pass run FIRST, at render size, where it is ~10x cheaper than on an
	 * upscaled image and inside the size it survives.
	 *
	 * @returns {Promise<{half: Uint16Array, width: number, height: number}>}
	 */
	async readOutputHDR() {

		const { validWidth: w, validHeight: h } = this.chain.pipeline.geometry;
		await this._packHDR( w, h, true );

		await this._hdrMap.mapAsync( GPUMapMode.READ );
		const half = new Uint16Array( this._hdrMap.getMappedRange().slice( 0 ) );
		this._hdrMap.unmap();
		return { half, width: w, height: h };

	}

	/**
	 * The pass's result as display bytes through the ENGINE's tone curve, for when nothing follows it.
	 *
	 * Deliberately not the runtime's own `rgba8unorm` output: that one is forced through a hardcoded
	 * ACES fit (`webgi_display` in the composition kernel), which is where the pass's ~10 %
	 * desaturation came from and why it never answered the engine's tone-mapping setting.
	 *
	 * @param {{exposure: number, toneMapping: number, saturation: number}} tone
	 * @returns {Promise<{rgba8: Uint8ClampedArray, width: number, height: number}>}
	 */
	async readOutputToned( tone ) {

		const { validWidth: w, validHeight: h } = this.chain.pipeline.geometry;
		await this._packHDR( w, h );

		this._toneMapper ??= new PackedToneMapper( this.device, 'rayzee:dlss-nr-tonemap' );
		this._toneMapper.ensureSize( w, h );

		const rgba8 = await this._toneMapper.toRGBA8( this._hdrStorage, {
			exposure: tone.exposure ?? 1,
			toneMapping: tone.toneMapping ?? 0,
			saturation: tone.saturation ?? 1,
		} );

		return { rgba8, width: w, height: h };

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
		this._hdrStorage?.destroy();
		this._hdrMap?.destroy();
		this._toneMapper?.dispose();
		try {

			this.chain.destroy();

		} catch ( e ) {

			log.warn( 'retouch teardown:', e );

		}

	}

}

/**
 * Smallest `paper_white` the runtime accepts, so the largest exposure it can carry: 1 / 0.05.
 */
const MAX_EXPOSURE = 20;

/**
 * Runs the pass over a finished frame and hands the result back as light.
 *
 * `source.half` is packed rgba16float — what `readDenoisedHalf` produces — carrying **scene-referred**
 * linear light, not exposed and not tone-mapped.
 *
 * Exposure goes through the runtime's own `paper_white`, which is the divisor it uses to bring scene
 * light into the network's working range (`value = scene / paper_white`) and multiplies back out at
 * the end. Setting it to `1 / exposure` therefore shows the network an exposed image while returning
 * the result in scene-referred units — so the engine's own tone curve still applies afterwards, and
 * the model's hardcoded ACES never runs.
 *
 * Pass `tone` when this is the last step and the result should be display bytes; leave it out to get
 * packed halves for the upscaler.
 *
 * @param {object} opts
 * @param {{half: Uint16Array, width: number, height: number}} opts.source
 * @param {number} [opts.exposure=1] clamped to `MAX_EXPOSURE`
 * @param {{exposure: number, toneMapping: number, saturation: number}} [opts.tone] engine display state
 * @param {DLSSNeural} [opts.instance] reuse a network already built for this size
 * @returns {Promise<object>} `{ instance, width, height, ms }` plus `rgba8` or `half`
 */
export async function enhanceFrame( {
	source, settings = {}, instance = null, exposure = 1, tone = null, onProgress = () => {},
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

	const { runtime: merged, colorStrength } = splitSettings( settings );
	const dst = nr.staging;

	if ( ! source.half || source.half.length !== dst.length ) {

		throw new Error( `DLSSNeural: expected ${dst.length} packed halfs, got ${source.half?.length}` );

	}

	dst.set( source.half );
	nr.device.queue.writeBuffer( nr.source, 0, dst );

	// ⚠️ On `chain.pipeline`, not `chain`. Both objects carry these two fields, but only the
	// pipeline's copies are read when the composition kernel's params are written each encode —
	// setting them on the chain is silently inert.
	nr.chain.pipeline.paperWhite = 1 / Math.min( Math.max( exposure, 1 / MAX_EXPOSURE ), MAX_EXPOSURE );
	nr.chain.pipeline.colorStrength = colorStrength;

	const started = performance.now();
	const encoder = nr.device.createCommandEncoder( { label: 'rayzee:dlss-nr' } );
	await nr.chain.encode( encoder, nr.slot, { buffer: nr.source }, merged, () => {}, { reset: true } );
	nr.device.queue.submit( [ encoder.finish() ] );
	await nr.device.queue.onSubmittedWorkDone();

	const result = tone ? await nr.readOutputToned( tone ) : await nr.readOutputHDR();
	return { instance: nr, ...result, ms: performance.now() - started };

}
