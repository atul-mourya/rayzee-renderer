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
 * Launches Chrome, opens the harness and waits for the engine to finish booting.
 *
 * @param {string} baseURL
 * @param {Object} [options]
 * @param {boolean} [options.verbose] - forward page console output
 * @param {string} [options.harnessPath]
 * @returns {Promise<{ page: Object, browser: Object, bench: Object, close: function }>}
 */
export async function openHarness( baseURL, { verbose = false, harnessPath } = {} ) {

	const browser = await puppeteer.launch( {
		executablePath: CHROME.executablePath,
		headless: true,
		args: CHROME.args,
		// Ground-truth renders are thousands of samples; the 180 s CDP default would
		// abort them mid-flight.
		protocolTimeout: TIMEOUTS.render,
	} );

	const page = await browser.newPage();
	const consoleErrors = [];

	page.on( 'console', ( message ) => {

		if ( message.type() === 'error' ) consoleErrors.push( message.text() );
		if ( verbose ) process.stdout.write( `  [page:${message.type()}] ${message.text()}\n` );

	} );

	page.on( 'pageerror', ( error ) => consoleErrors.push( `pageerror: ${error.message}` ) );

	// WebGPU is unavailable on about:blank — it is not a secure context and
	// requestAdapter() returns null there. Navigate to the real origin first.
	await page.goto( harnessURL( baseURL, harnessPath ), { waitUntil: 'load', timeout: TIMEOUTS.boot } );

	await page.waitForFunction(
		'window.__bench !== undefined || window.__benchBootError !== undefined',
		{ timeout: TIMEOUTS.boot }
	);

	const bootError = await page.evaluate( () => globalThis.__benchBootError ?? null );
	if ( bootError ) {

		await browser.close();
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
		measureGPUPerSample: ( count ) => page.evaluate(
			( n ) => globalThis.__bench.measureGPUPerSample( n ), count
		),
		capturePNG: () => page.evaluate( () => globalThis.__bench.capturePNG() ),
		probes: () => page.evaluate( () => globalThis.__bench.probes() ),
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
		close: () => browser.close(),
	};

}
