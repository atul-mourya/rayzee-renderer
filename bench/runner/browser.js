/**
 * Headless Chrome driver for the bench harness.
 *
 * Uses puppeteer-core against the system Chrome install — no bundled browser download.
 * Verified on Apple Metal-3: headless yields a real GPU adapter with `timestamp-query`
 * and the full 10 storage buffers/stage the wavefront kernels require.
 */

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { CHROME, PATHS, TIMEOUTS } from './config.js';

/**
 * Builds the harness URL. The harness lives outside the Vite root, so it is served
 * through Vite's /@fs escape hatch (enabled by `server.fs.allow` in app/vite.config.js).
 *
 * @param {string} baseURL - dev server origin, e.g. http://localhost:5174
 * @param {string} [harnessPath] - absolute path to the harness HTML
 */
export function harnessURL( baseURL, harnessPath = PATHS.harness ) {

	return `${baseURL}/@fs${path.resolve( harnessPath )}`;

}

/**
 * Launches headless Chrome. Exported so an A/B run can host both harnesses in ONE browser:
 * per-session GPU state (clock/power state, readback scheduling) shifts measured cost by
 * several percent, which is larger than the regressions the perf gate is trying to resolve,
 * so the two sides have to share a process.
 *
 * @returns {Promise<Object>} puppeteer Browser
 */
export function launchBrowser() {

	return puppeteer.launch( {
		executablePath: CHROME.executablePath,
		headless: true,
		args: CHROME.args,
		// Ground-truth renders are thousands of samples; the 180 s CDP default would
		// abort them mid-flight.
		protocolTimeout: TIMEOUTS.render,
	} );

}

/**
 * Opens the harness and waits for the engine to finish booting.
 *
 * @param {string} baseURL
 * @param {Object} [options]
 * @param {boolean} [options.verbose] - forward page console output
 * @param {string} [options.harnessPath]
 * @param {Object} [options.browser] - existing browser to open a tab in. When given, close()
 *   closes only this page, leaving the browser to the caller.
 * @returns {Promise<{ page: Object, browser: Object, bench: Object, close: function }>}
 */
export async function openHarness( baseURL, { verbose = false, harnessPath, browser: shared } = {} ) {

	const browser = shared ?? await launchBrowser();
	const page = await browser.newPage();

	// A shared browser belongs to the caller: tearing it down here would kill the other
	// harness in an interleaved A/B.
	const teardown = () => ( shared ? page.close() : browser.close() );

	const consoleErrors = [];

	page.on( 'console', ( message ) => {

		// Chrome logs a bare "Failed to load resource: 404" with no URL, which makes an
		// unreachable favicon indistinguishable from a missing STBN atlas. Attach the URL
		// the message came from so a real missing asset is diagnosable from the log alone.
		if ( message.type() === 'error' ) {

			const url = message.location?.()?.url;
			consoleErrors.push( url ? `${message.text()} [${url}]` : message.text() );

		}

		if ( verbose ) process.stdout.write( `  [page:${message.type()}] ${message.text()}\n` );

	} );

	page.on( 'pageerror', ( error ) => consoleErrors.push( `pageerror: ${error.message}` ) );

	// WebGPU is unavailable on about:blank — it is not a secure context and
	// requestAdapter() returns null there. Navigate to the real origin first.
	const url = harnessURL( baseURL, harnessPath );
	const response = await page.goto( url, { waitUntil: 'load', timeout: TIMEOUTS.boot } );

	// A Vite 403 (harness outside `server.fs.allow`) still loads — as an HTML error page.
	// The harness module never runs, so it sets neither __bench nor __benchBootError, and
	// without this the only symptom is a bare 180 s TimeoutError with no cause. Check the
	// status before committing to that wait.
	if ( response && ! response.ok() ) {

		await teardown();
		throw new Error(
			`bench harness returned HTTP ${response.status()} for ${url}\n` +
			'403 means the path is outside Vite\'s server.fs.allow — check that the harness ' +
			'and the dev server come from the same tree, with symlinks resolved.'
		);

	}

	try {

		await page.waitForFunction(
			'window.__bench !== undefined || window.__benchBootError !== undefined',
			{ timeout: TIMEOUTS.boot }
		);

	} catch ( error ) {

		// Neither global set means the module never finished evaluating — a failed import,
		// most often. The page's own errors are the only evidence, so surface them rather
		// than letting the timeout stand alone.
		await teardown();
		throw new Error(
			`bench harness never initialised within ${TIMEOUTS.boot} ms (${error.message}).\n` +
			( consoleErrors.length
				? `page errors:\n  ${consoleErrors.slice( 0, 10 ).join( '\n  ' )}`
				: 'the page logged no errors — window.__bench was never assigned, so the ' +
					'harness module probably failed to load.' )
		);

	}

	const bootError = await page.evaluate( () => globalThis.__benchBootError ?? null );
	if ( bootError ) {

		await teardown();
		throw new Error( `bench harness failed to boot:\n${bootError}` );

	}

	await page.evaluate( () => globalThis.__bench.ready );

	/** Thin typed wrapper so suites never write raw page.evaluate strings. */
	const bench = {
		fingerprint: () => page.evaluate( () => globalThis.__bench.fingerprint() ),
		scenes: () => page.evaluate( () => globalThis.__bench.scenes() ),
		loadScene: ( id ) => page.evaluate(
			( sceneId ) => globalThis.__bench.loadScene( sceneId ), id
		),
		render: ( spp, options = {} ) => page.evaluate(
			( n, opts ) => globalThis.__bench.render( n, opts ), spp, options
		),
		measureKernelGPU: ( count ) => page.evaluate(
			( n ) => globalThis.__bench.measureKernelGPU( n ), count
		),
		setRenderSize: ( width, height ) => page.evaluate(
			( w, h ) => globalThis.__bench.setRenderSize( w, h ), width, height
		),
		setShippingHeuristics: ( enabled ) => page.evaluate(
			( on ) => globalThis.__bench.setShippingHeuristics( on ), enabled
		),
		loadModelScene: ( url, cameraIndex, env ) => page.evaluate(
			( u, c, e ) => globalThis.__bench.loadModelScene( u, c, e ),
			url, cameraIndex ?? 1, env ?? 'procedural'
		),
		setSettings: ( values ) => page.evaluate(
			( v ) => globalThis.__bench.setSettings( v ), values
		),
		setSortMaterials: ( enabled ) => page.evaluate(
			( on ) => globalThis.__bench.setSortMaterials( on ), enabled
		),
		setSceneConfig: ( config ) => page.evaluate(
			( c ) => globalThis.__bench.setSceneConfig( c ), config
		),
		rebuildKernels: () => page.evaluate( () => globalThis.__bench.rebuildKernels() ),
		meshStats: () => page.evaluate( () => globalThis.__bench.meshStats() ),
		measureGPUPerSample: ( count ) => page.evaluate(
			( n ) => globalThis.__bench.measureGPUPerSample( n ), count
		),
		setPerfMode: ( enabled ) => page.evaluate(
			( on ) => globalThis.__bench.setPerfMode( on ), enabled
		),
		setDenoiser: ( strategy, preset ) => page.evaluate(
			( s, p ) => globalThis.__bench.setDenoiser( s, p ), strategy, preset ?? null
		),
		awaitDenoise: ( timeoutMs ) => page.evaluate(
			( t ) => globalThis.__bench.awaitDenoise( t ?? undefined ), timeoutMs ?? null
		),
		captureDenoisedPNG: () => page.evaluate( () => globalThis.__bench.captureDenoisedPNG() ),
		denoisedNonFinite: () => page.evaluate( () => globalThis.__bench.denoisedNonFinite() ),
		shaderDiagnostics: () => page.evaluate( () => globalThis.__bench.shaderDiagnostics() ),
		bindingFindings: () => page.evaluate( () => globalThis.__bench.bindingFindings() ),
		clearBindingFindings: () => page.evaluate( () => globalThis.__bench.clearBindingFindings() ),
		isDeterministic: () => page.evaluate( () => globalThis.__bench.isDeterministic() ),
		capturePNG: () => page.evaluate( () => globalThis.__bench.capturePNG() ),
		probes: () => page.evaluate( () => globalThis.__bench.probes() ),
		snapshotReference: () => page.evaluate( () => globalThis.__bench.snapshotReference() ),
		rmseVsReference: () => page.evaluate( () => globalThis.__bench.rmseVsReference() ),
		memory: () => page.evaluate( () => globalThis.__bench.memory() ),
		resetPeakMemory: () => page.evaluate( () => globalThis.__bench.resetPeakMemory() ),
		gpuTimings: () => page.evaluate( () => globalThis.__bench.gpuTimings() ),
		frameCount: () => page.evaluate( () => globalThis.__bench.frameCount() ),
		unload: () => page.evaluate( () => globalThis.__bench.unload() ),
		consoleErrors: () => consoleErrors.slice(),
	};

	return {
		page,
		browser,
		bench,
		close: teardown,
	};

}
