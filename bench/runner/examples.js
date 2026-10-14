/**
 * Runs every example in rayzee/examples as a user would, against this tree's engine: the Node ones as processes of
 * their own, the browser ones through their npm script in headless Chrome. An example passes when it finishes and
 * reports nothing — no thrown error, no console error or warning (the browser examples print the engine's issues).
 *
 * Needs the network: the viewer example loads its model, sky and denoiser weights from CDNs.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchBrowser } from './browser.js';
import { startDevServer } from './devserver.js';
import { PATHS } from './config.js';

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const DIR = path.join( PATHS.repoRoot, 'rayzee', 'examples' );
const TIMEOUT = 300_000;

// Run in a scratch directory, where render.mjs writes render.png.
const NODE = [
	{ name: 'core-node', file: 'core-node.mjs', args: [ 'core-node.png' ] },
	{ name: 'render', file: 'render.mjs', args: [ '--samples', '16', '--resolution', '320' ] },
];

// Each page shows its progress in #status; `done` matches it once the example has finished.
const BROWSER = [
	{ name: 'core-browser', script: 'example:browser', done: '^512 samples' },
	{ name: 'viewer-browser', script: 'example:viewer', done: 'denoised$' },
];

function runNode( example, cwd ) {

	const run = spawnSync( process.execPath, [ path.join( DIR, example.file ), ...example.args ], { cwd, encoding: 'utf8', timeout: TIMEOUT } );
	if ( run.status === 0 ) return { ok: true, detail: run.stdout.trim().split( '\n' ).pop() };

	const reason = run.error?.message ?? run.stderr.trim().split( '\n' ).slice( - 3 ).join( ' ' );
	return { ok: false, detail: reason };

}

async function runBrowser( browser, example, verbose ) {

	const server = await startDevServer( { args: [ 'run', example.script ], verbose } );
	const page = await browser.newPage();
	const problems = [];

	// A thrown error ends the wait at once rather than at the timeout.
	let fail;
	const failed = new Promise( ( _, reject ) => {

		fail = reject;

	} );
	failed.catch( () => {} );

	page.on( 'console', ( message ) => {

		const type = message.type();
		if ( type === 'error' || type === 'warn' ) problems.push( `${type}: ${message.text()}` );
		if ( verbose ) process.stdout.write( `  [page:${type}] ${message.text()}\n` );

	} );
	page.on( 'pageerror', ( error ) => {

		problems.push( `uncaught: ${error.message}` );
		fail( error );

	} );

	let status = '';

	try {

		await page.goto( server.url, { waitUntil: 'load', timeout: TIMEOUT } );
		const finished = page.waitForFunction(
			( done ) => new RegExp( done ).test( document.querySelector( '#status' )?.textContent ?? '' ),
			{ timeout: TIMEOUT, polling: 250 }, example.done
		);
		finished.catch( () => {} );
		await Promise.race( [ finished, failed ] );

	} catch ( error ) {

		if ( ! problems.some( ( problem ) => problem.endsWith( error.message ) ) ) problems.push( error.message );

	} finally {

		status = await page.$eval( '#status', ( element ) => element.textContent ).catch( () => '' );
		await page.close();
		await server.stop();

	}

	return { ok: problems.length === 0, detail: problems.length ? `${problems.join( ' | ' )} (status: "${status}")` : status };

}

/**
 * @param {Object} options
 * @param {string[]} [options.only] - example names
 * @param {boolean} [options.verbose] - forward page console output and the dev servers' logs
 * @param {function(string): void} options.log
 * @returns {Promise<number>} exit code
 */
export async function runExamples( { only, verbose = false, log } ) {

	const names = [ ...NODE, ...BROWSER ].map( ( example ) => example.name );
	const unknown = ( only ?? [] ).filter( ( name ) => ! names.includes( name ) );
	if ( unknown.length ) throw new Error( `no example named ${unknown.join( ', ' )}. Examples: ${names.join( ', ' )}` );

	const picked = ( list ) => list.filter( ( example ) => ! only || only.includes( example.name ) );
	const results = [];

	log( 'examples (rayzee/examples, against this tree)' );

	const scratch = await fs.mkdtemp( path.join( os.tmpdir(), 'rayzee-examples-' ) );
	try {

		for ( const example of picked( NODE ) ) results.push( { example, ...runNode( example, scratch ) } );

	} finally {

		await fs.rm( scratch, { recursive: true, force: true } );

	}

	const browserExamples = picked( BROWSER );
	if ( browserExamples.length ) {

		const browser = await launchBrowser();
		try {

			for ( const example of browserExamples ) results.push( { example, ...await runBrowser( browser, example, verbose ) } );

		} finally {

			await browser.close();

		}

	}

	for ( const { example, ok, detail } of results ) {

		log( `  ${ok ? GREEN + 'pass' : RED + 'FAIL'}${RESET} ${example.name.padEnd( 15 )}${DIM}${detail}${RESET}` );

	}

	const failures = results.filter( ( result ) => ! result.ok ).length;
	log( failures ? `\n${RED}${failures} example(s) failed${RESET}` : `\n${GREEN}all examples ran${RESET}` );
	return failures ? 1 : 0;

}
