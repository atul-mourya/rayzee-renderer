/**
 * The supported way to render without a person watching. Defaults are the batch renderer's —
 * strict, deterministic — all reversible, none reversible by accident.
 *
 * @example
 * const shot = await renderHeadless( { model: url, width: 1920, height: 1080, samples: 256 } );
 */

import { PathTracerApp } from './PathTracerApp.js';
import { assertImage, compareImages } from '../output/ImageMath.js';
import { requestedRender } from '../loaders/SceneMetadata.js';
import { SETTING_SOURCE } from '../RenderSettings.js';
/**
 * One render, start to finish, disposing the app afterwards.
 *
 * @param {Object} options
 * @param {HTMLCanvasElement} [options.canvas] - leave it out and the app runs headless, on a canvas of
 *   its own (see PathTracerApp's `headless` option); pass one only to also present to it
 * @param {number} [options.hostMemoryGB] - see PathTracerApp; needed outside Chrome for renders above 2048
 * @param {string} [options.model] - URL to load before rendering
 * @param {number} [options.width=1920]
 * @param {number} [options.height=1080]
 * @param {number} [options.samples=64] - samples to accumulate; with `sceneRequest`, the file's when it asks and this
 *   is left out
 * @param {boolean} [options.sceneRequest=false] - render what the model's file asks for, as pbrt renders a file: its
 *   size (or its aspect, on the longer side of `width` × `height`), samples, bounces, light transport, exposure, white
 *   balance, sample clamp, pixel filter and panorama (`sceneMetadata.render`). `settings` still win.
 * @param {'linear'|'srgb'} [options.colorSpace='srgb']
 * @param {boolean} [options.strict=true]
 * @param {boolean} [options.deterministic=true]
 * @param {boolean} [options.allowEarlyRetire=false] - needs `deterministic: false` to be reachable
 * @param {boolean|{quality?: string, tileSize?: number}} [options.denoise=false] - one final OIDN pass, read back
 *   instead of the raw accumulation; an object also picks the model ('fast' | 'fast-clean' | 'balance' | 'high') and
 *   the tile cap (see OIDNDenoiser)
 * @param {Object} [options.settings] - applied before the model loads and again after it
 * @param {function(number): void} [options.onProgress] - running sample count
 * @param {number} [options.firstSample=0] - render samples `firstSample …` of the sequence, for {@link mergeRenders}
 * @param {number|number[]} [options.steps] - sample counts to stop at on the way: a list, or N for every N samples.
 *   With `onStep` or `reference` and no `steps`, pbrt's partial-image cadence: 1, 2, 4 … 64, then every 64
 * @param {function(Object, {samples: number}): (void|Promise<void>)} [options.onStep] - the raw accumulation at each
 *   step, read in `colorSpace` (pbrt's --write-partial-images); awaited before rendering on
 * @param {{data: Float32Array, width: number, height: number}} [options.reference] - linear RGBA to measure the
 *   accumulation against at each step and at the end (pbrt's --mse-reference-image): `errors`
 * @param {boolean} [options.stats=false] - return `stats` (pbrt's --stats): `scene` (getStatistics), `gpuMemory`,
 *   `hostMemory`, `convergence`, and `kernels`, the last frame's GPU ms per kernel (timing is on for this capture only)
 * @returns {Promise<{data: Float32Array|Uint8ClampedArray, width: number, height: number,
 *   colorSpace: string, source: string, samples: number, firstSample: ?number, retiredBy: string, issues: Object[],
 *   adapter: Object, provenance: Object, timings: Object, errors?: Object[]}>} `provenance` is
 *   {@link PathTracerApp#getProvenance} at the moment of capture; `timings` milliseconds spent rendering, at the
 *   steps, denoising and reading the frame; `errors` {@link compareImages} against `reference` with the sample count
 */
export async function renderHeadless( options ) {

	const app = await openHeadless( options );

	try {

		return await captureHeadless( app, options );

	} finally {

		app.dispose();

	}

}

/**
 * Accumulate and read back, against an app {@link openHeadless} already set up.
 * @param {PathTracerApp} app
 * @returns {Promise<Object>} the frame plus what the engine survived to produce it
 */
export async function captureHeadless( app, {
	samples = undefined,
	sceneRequest = false,
	settings = null,
	colorSpace = 'srgb',
	allowEarlyRetire = false,
	denoise = false,
	onProgress = undefined,
	firstSample = 0,
	steps = undefined,
	onStep = undefined,
	reference = undefined,
	stats = false,
} = {} ) {

	if ( reference ) {

		assertImage( reference, 'captureHeadless: reference' );
		const stage = app.stages?.pathTracer;
		if ( ! ( reference.data instanceof Float32Array ) || ( stage && ( stage.width !== reference.width || stage.height !== reference.height ) ) ) {

			throw new Error( `captureHeadless: the reference must be linear floats at the render's size${stage ? ` (${stage.width}×${stage.height})` : ''}` );

		}

	}

	// What the loaded model's file asks for, under the host's own settings, which win. Here, not at the load, so a model
	// the host loaded itself (loadFile, loadObject3D) is rendered as asked too.
	const asked = sceneRequest ? requestedRender( app.sceneMetadata?.render, app.stages.pathTracer ) : null;
	if ( asked ) {

		app.settings.setMany( asked.settings, { silent: true, source: SETTING_SOURCE.SCENE_METADATA } );
		if ( settings ) app.settings.setMany( settings, { silent: true } );
		const stage = app.stages.pathTracer;
		if ( asked.width !== stage.width || asked.height !== stage.height ) {

			app.setReservedRenderResolution( Math.max( asked.width, asked.height ) );
			app.setCanvasSize( asked.width, asked.height );

		}

	}

	samples ??= asked?.samples ?? 64;
	const stops = stepCounts( steps, samples, !! ( onStep || reference ) );

	// Before accumulating: OIDN reads the albedo and normal buffers, which are only written while it is
	// on. Not setOIDNEnabled(), whose refresh would wake the loop; renderFrames resets anyway.
	const dm = app.denoisingManager;
	if ( denoise && dm ) {

		const { quality, tileSize } = denoise === true ? {} : denoise;
		if ( quality ) {

			await dm.denoiser?.updateQuality( quality );
			dm.applyOIDNQuality( quality );

		}

		if ( tileSize ) await dm.denoiser?.updateConfiguration( { tileSize } );
		if ( ! dm.finalDenoise ) dm.applyOIDNEnabled( true );
		// The model decides whether the guides accumulate.
		dm._syncGBufferStages();

	}

	// GPU timing only for a capture that asks: its queries cost time. Put back as it was.
	const timedBefore = !! app.renderer?.backend?.trackTimestamp;
	const timed = stats && ! timedBefore ? app.enableGPUTiming( true ) : timedBefore;
	const timings = { render: 0, steps: 0, denoise: 0, readback: 0 };
	const errors = reference ? [] : undefined;
	// Read once, reused for a linear onStep or frame.
	const measure = async ( reached ) => {

		const linear = await app.renderToBuffer( { colorSpace: 'linear', source: 'accumulation' } );
		errors.push( { samples: reached, ...compareImages( linear, reference ) } );
		return linear;

	};

	let accumulated = 0;
	for ( const stop of [ ...stops, samples ] ) {

		const started = performance.now();
		const first = accumulated === 0;
		accumulated = await app.renderFrames( stop - accumulated, { onProgress, allowEarlyRetire, reset: first, firstSample: first ? firstSample : 0 } );
		timings.render += performance.now() - started;
		if ( accumulated < stop || stop === samples ) break;

		const stepStarted = performance.now();
		const linear = reference ? await measure( accumulated ) : null;
		if ( onStep ) {

			const shown = colorSpace === 'linear' && linear ? linear : await app.renderToBuffer( { colorSpace, source: 'accumulation' } );
			await onStep( shown, { samples: accumulated } );

		}

		timings.steps += performance.now() - stepStarted;

	}

	let last = null;
	if ( reference ) {

		const started = performance.now();
		last = await measure( accumulated );
		timings.steps += performance.now() - started;

	}

	if ( denoise ) {

		const started = performance.now();
		await app.runFinalDenoise();
		timings.denoise = performance.now() - started;

	}

	const started = performance.now();
	const frame = ! denoise && colorSpace === 'linear' && last ? last : await app.renderToBuffer( { colorSpace, source: denoise ? 'display' : 'accumulation' } );
	timings.readback = performance.now() - started;
	const provenance = app.getProvenance();
	// pbrt's --stats in one place: the scene and its trees, GPU and CPU memory, convergence, the last frame's kernels.
	const statistics = stats ? {
		scene: app.getStatistics(),
		gpuMemory: app.getMemoryInfo(),
		hostMemory: app.getHostMemoryInfo(),
		convergence: app.getConvergenceStats(),
		kernels: timed ? await app.getKernelGPUTimings() : null,
	} : null;
	if ( stats && ! timedBefore ) app.enableGPUTiming( false );

	return {
		...frame,
		samples: accumulated,
		// The image's own, from the engine: null when the sequence ran free, which mergeRenders cannot check.
		firstSample: provenance?.render?.firstSample ?? null,
		retiredBy: accumulated < samples ? 'converged' : 'count',
		issues: app.issues,
		adapter: app.adapterInfo,
		provenance,
		timings,
		...( errors ? { errors } : {} ),
		...( statistics ? { stats: statistics } : {} ),
	};

}

/**
 * Setup only, keeping the app alive for several frames. The caller MUST dispose it.
 * @param {Object} options - as {@link renderHeadless}, minus `samples`
 * @returns {Promise<PathTracerApp>}
 */
export async function openHeadless( {
	canvas,
	model = null,
	width = 1920,
	height = 1080,
	strict = true,
	deterministic = true,
	settings = null,
	storage = false,
	hostMemoryGB = undefined,
} = {} ) {

	// Off unless asked for: cached state from an earlier run must not change what a batch renders.
	const app = new PathTracerApp( canvas ?? null, { autoResize: false, strict, storage, hostMemoryGB } );

	try {

		// Before init(): replayed once the device exists but before the stages allocate, so a
		// >2048 render builds the storage pool once instead of building then re-building it.
		app.setReservedRenderResolution( Math.max( width, height ) );

		await app.init();
		app.setCanvasSize( width, height );

		// Before the load as well: some are read while a model loads (areaLightIntensityScale).
		if ( settings ) app.settings.setMany( settings, { silent: true } );
		if ( model ) await app.loadModel( model );
		// Again after it, over anything the model's metadata set.
		if ( settings ) app.settings.setMany( settings, { silent: true } );

		// After the model: scene metadata can turn adaptive sampling back on.
		if ( deterministic ) app.setDeterministicMode( true );

		return app;

	} catch ( error ) {

		app.dispose(); // a half-built app still holds GPU memory
		throw error;

	}

}

// pbrt's partial-image cadence (cpu/integrators.cpp): waves of 1, 1, 2, 4 … 64 samples, then 64 at a time.
function stepCounts( steps, samples, wanted ) {

	let counts = [];
	if ( steps === undefined ) {

		if ( wanted ) for ( let n = 1, size = 1; n < samples; n += size, size = Math.min( size * 2, 64 ) ) counts.push( n );

	} else if ( Number.isInteger( steps ) && steps > 0 ) {

		for ( let n = steps; n < samples; n += steps ) counts.push( n );

	} else if ( Array.isArray( steps ) && steps.every( ( n ) => Number.isInteger( n ) && n > 0 ) ) {

		counts = steps;

	} else {

		throw new Error( `captureHeadless: steps must be a positive whole number or a list of them, got ${JSON.stringify( steps )}` );

	}

	return [ ...new Set( counts ) ].filter( ( n ) => n < samples ).sort( ( a, b ) => a - b );

}
