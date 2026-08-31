/**
 * The supported way to render without a person watching.
 *
 * This exists because it was written twice already: once as `bench/harness/boot.js` to drive
 * the regression suite, and once inside a render farm that could not see it. Two drivers for
 * the same engine means a bug in either is invisible to the other, which is how a wrong image
 * reaches production past a green test suite.
 *
 * The defaults here are the batch renderer's, not the viewer's: strict is on, so a missing
 * texture or an unreachable environment throws instead of quietly rendering without it; the
 * physical profile is on, so viewer tuning does not move the result away from a reference
 * renderer; and sampling is deterministic, so the same scene renders bit-identically twice.
 * Every one of them can be turned off — none can be turned off by accident.
 *
 * @example
 * const shot = await renderHeadless( {
 *   canvas, model: 'https://cdn/scene.glb', width: 1920, height: 1080, samples: 256,
 * } );
 * await fs.writeFile( 'out.raw', Buffer.from( shot.data.buffer ) );
 */

import { PathTracerApp } from './PathTracerApp.js';
import { createLogger } from './utils/Logger.js';

const log = createLogger( 'headless' );

/**
 * One render, start to finish, with the app torn down afterwards.
 *
 * @param {Object} options
 * @param {HTMLCanvasElement} options.canvas - the engine still needs a canvas for its WebGPU
 *   surface even though the result never comes from it; an offscreen one is fine
 * @param {string} [options.model] - URL to load before rendering
 * @param {number} [options.width=1920]
 * @param {number} [options.height=1080]
 * @param {number} [options.samples=64] - samples to accumulate
 * @param {'linear'|'srgb'} [options.colorSpace='srgb']
 * @param {boolean} [options.strict=true] - fail on degradation rather than render around it
 * @param {string} [options.profile='physical'] - see RENDER_PROFILES
 * @param {boolean} [options.deterministic=true] - pin every clock- and readback-dependent input
 * @param {boolean} [options.allowEarlyRetire=false] - accept fewer samples when adaptive
 *   sampling converges early. Only reachable with `deterministic: false`, which turns adaptive
 *   sampling back on.
 * @param {Object} [options.settings] - applied before the render, after the model loads
 * @param {function(number): void} [options.onProgress] - running sample count
 * @returns {Promise<{data: Float32Array|Uint8ClampedArray, width: number, height: number,
 *   colorSpace: string, samples: number, retiredBy: string, issues: Object[], adapter: Object}>}
 */
export async function renderHeadless( options ) {

	const { app } = await openHeadless( options );

	try {

		return await captureHeadless( app, options );

	} finally {

		app.dispose();

	}

}

/**
 * Accumulate and read back, against an app that {@link openHeadless} already set up.
 *
 * @param {PathTracerApp} app
 * @param {Object} [options] - `samples`, `colorSpace`, `allowEarlyRetire`, `onProgress`
 * @returns {Promise<Object>} the frame plus what the engine survived to produce it
 */
export async function captureHeadless( app, {
	samples = 64,
	colorSpace = 'srgb',
	allowEarlyRetire = false,
	onProgress = undefined,
} = {} ) {

	const outcome = await app.renderFrames( samples, { onProgress, allowEarlyRetire } );

	// renderFrames returns a bare count unless early retirement was allowed.
	const accumulated = allowEarlyRetire ? outcome.samples : outcome;
	const retiredBy = allowEarlyRetire ? outcome.retiredBy : 'count';

	const frame = await app.renderToBuffer( { colorSpace } );

	return {
		...frame,
		samples: accumulated,
		retiredBy,
		// Empty under `strict`, which throws before reaching here. Populated otherwise, and the
		// thing a lenient caller checks before publishing the image.
		issues: app.issues,
		adapter: app.adapterInfo,
	};

}

/**
 * Same setup as {@link renderHeadless}, but hands back the live app instead of disposing it —
 * for callers rendering several frames, or several cameras, from one scene.
 *
 * The caller owns the app and MUST dispose it. Reusing one app across renders is what makes a
 * pooled worker cheaper than a pod per image, so this is the path that matters at scale.
 *
 * @param {Object} options - as {@link renderHeadless}, minus `samples`
 * @returns {Promise<{app: PathTracerApp}>}
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

		await app.init();

		// Before any render: the reserve is allocated once and a later raise re-inits storage.
		app.setReservedRenderResolution( Math.max( width, height ) );
		app.setCanvasSize( width, height );

		if ( model ) await app.loadModel( model );
		if ( settings ) app.settings.setMany( settings, { silent: true } );

		// After the model — loadModel applies authored scene metadata, and deterministic mode
		// has to win over anything that turns adaptive sampling back on.
		if ( deterministic ) app.setDeterministicMode( true );

		if ( app.adapterInfo?.isSoftware ) {

			log.warn( `rendering on a software adapter (${app.adapterInfo.description}) — expect ~100x hardware time` );

		}

		return { app };

	} catch ( error ) {

		// A half-built app still holds GPU memory; a farm that leaks one per failed job runs
		// its node out of memory long before it runs out of failures.
		app.dispose();
		throw error;

	}

}
