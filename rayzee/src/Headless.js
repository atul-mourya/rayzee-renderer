/**
 * The supported way to render without a person watching. Defaults are the batch renderer's —
 * strict, physical profile, deterministic — all reversible, none reversible by accident.
 *
 * @example
 * const shot = await renderHeadless( { canvas, model: url, width: 1920, height: 1080, samples: 256 } );
 */

import { PathTracerApp } from './PathTracerApp.js';
/**
 * One render, start to finish, disposing the app afterwards.
 *
 * @param {Object} options
 * @param {HTMLCanvasElement} options.canvas - needed for the WebGPU surface, not for output
 * @param {string} [options.model] - URL to load before rendering
 * @param {number} [options.width=1920]
 * @param {number} [options.height=1080]
 * @param {number} [options.samples=64] - samples to accumulate
 * @param {'linear'|'srgb'} [options.colorSpace='srgb']
 * @param {boolean} [options.strict=true]
 * @param {string} [options.profile='physical'] - see RENDER_PROFILES
 * @param {boolean} [options.deterministic=true]
 * @param {boolean} [options.allowEarlyRetire=false] - needs `deterministic: false` to be reachable
 * @param {Object} [options.settings] - applied after the model loads
 * @param {function(number): void} [options.onProgress] - running sample count
 * @returns {Promise<{data: Float32Array|Uint8ClampedArray, width: number, height: number,
 *   colorSpace: string, samples: number, retiredBy: string, issues: Object[], adapter: Object}>}
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
	samples = 64,
	colorSpace = 'srgb',
	allowEarlyRetire = false,
	onProgress = undefined,
} = {} ) {

	const accumulated = await app.renderFrames( samples, { onProgress, allowEarlyRetire } );
	const frame = await app.renderToBuffer( { colorSpace } );

	return {
		...frame,
		samples: accumulated,
		retiredBy: accumulated < samples ? 'converged' : 'count',
		issues: app.issues,
		adapter: app.adapterInfo,
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
	profile = 'physical',
	deterministic = true,
	settings = null,
} = {} ) {

	if ( ! canvas ) throw new Error( 'openHeadless: a canvas is required' );

	const app = new PathTracerApp( canvas, { autoResize: false, strict, profile } );

	try {

		// Before init(): replayed once the device exists but before the stages allocate, so a
		// >2048 render builds the storage pool once instead of building then re-building it.
		app.setReservedRenderResolution( Math.max( width, height ) );

		await app.init();
		app.setCanvasSize( width, height );

		if ( model ) await app.loadModel( model );
		if ( settings ) app.settings.setMany( settings, { silent: true } );

		// After the model: scene metadata can turn adaptive sampling back on.
		if ( deterministic ) app.setDeterministicMode( true );

		return app;

	} catch ( error ) {

		app.dispose(); // a half-built app still holds GPU memory
		throw error;

	}

}
