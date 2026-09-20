/**
 * DLSS-NR — the neural-rendering (detail) pass.
 *
 * Runs over a finished, denoised image and adjusts its appearance: local tone and structure, and a
 * skin-specific term. It does not change resolution and it does not denoise. Measured on path-traced
 * input it is close to a no-op after OIDN, so it is off by default and exposed as an explicit choice.
 *
 * ⚠️ It is always LAST in the neural chain, and that is forced by the model rather than chosen: its
 * output texture is `rgba8unorm` with no `COPY_SRC`, so the result cannot be read back and nothing
 * can consume it. It ends at its own presentation, in its own display space.
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
	 * @param {HTMLCanvasElement} opts.canvas the network sizes and presents to this
	 */
	static async create( { width, height, canvas, settings = {}, onProgress = () => {} } ) {

		if ( ! Number.isInteger( width ) || ! Number.isInteger( height ) || width < 1 || height < 1 ) {

			throw new Error( 'DLSSNeural.create: width and height must be positive integers' );

		}

		if ( ! canvas ) throw new Error( 'DLSSNeural.create: a canvas is required — the network presents itself' );

		const SrNrChain = await loadRuntime();
		const chain = await SrNrChain.create(
			canvas, width, height, onProgress, { ...DLSS_NR_DEFAULTS, ...settings },
		);

		const instance = new DLSSNeural( chain, canvas );
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

	}

	dispose() {

		if ( this.disposed ) return;
		this.disposed = true;
		this.source?.destroy();
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
 * @param {HTMLCanvasElement} opts.canvas where the network presents
 * @param {number} [opts.exposure] applied on the way in; the network clamps to [0,1] internally
 * @param {DLSSNeural} [opts.instance] reuse a network already built for this size
 * @returns {Promise<{instance: DLSSNeural, width: number, height: number, ms: number}>}
 */
export async function enhanceLinearFrame( {
	source, canvas, settings = {}, instance = null, exposure = 1, onProgress = () => {},
} ) {

	let nr = instance;
	if ( nr && ( nr.width !== source.width || nr.height !== source.height ) ) {

		nr.dispose();
		nr = null;

	}

	if ( ! nr ) {

		nr = await DLSSNeural.create( {
			width: source.width, height: source.height, canvas, settings, onProgress,
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

	canvas.style.display = 'block';
	return { instance: nr, width, height, ms: performance.now() - started };

}
