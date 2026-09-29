/**
 * OPFS throughput suite: raw sync-handle / writable / File-slice speeds, random reads, and a
 * .tar.gz decompress-to-disk pipeline, each with and without cross-origin isolation (production
 * on GitHub Pages is not isolated). Served by a tiny static server, not Vite, so the headers are
 * the only difference between the two runs.
 */

import http from 'node:http';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import puppeteer from 'puppeteer-core';

import { launchBrowser, nativeLaunchOptions } from './browser.js';
import { PATHS } from './config.js';

const ROOT = path.join( PATHS.benchRoot, 'harness', 'storage' );
const TYPES = { '.html': 'text/html', '.js': 'text/javascript' };

function startServer( { isolated, fixture } ) {

	const server = http.createServer( ( request, response ) => {

		const headers = isolated
			? { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' }
			: {};

		const url = new URL( request.url, 'http://localhost' );

		if ( url.pathname === '/fixture.tar.gz' && fixture ) {

			const stat = fs.statSync( fixture );
			response.writeHead( 200, { ...headers, 'Content-Type': 'application/gzip', 'Content-Length': stat.size } );
			fs.createReadStream( fixture ).pipe( response );
			return;

		}

		const file = path.join( ROOT, url.pathname === '/' ? 'index.html' : url.pathname );
		if ( ! file.startsWith( ROOT ) || ! fs.existsSync( file ) ) {

			response.writeHead( 404, headers );
			response.end();
			return;

		}

		response.writeHead( 200, { ...headers, 'Content-Type': TYPES[ path.extname( file ) ] ?? 'application/octet-stream' } );
		fs.createReadStream( file ).pipe( response );

	} );

	return new Promise( ( resolve ) => server.listen( 0, '127.0.0.1', () => resolve( server ) ) );

}

const FIREFOX = process.env.FIREFOX_PATH || '/Applications/Firefox.app/Contents/MacOS/firefox';

export async function runStorage( { sizeMiB = 2048, fixture = null, firefox = false, log } ) {

	const browser = firefox
		? await puppeteer.launch( { browser: 'firefox', ...nativeLaunchOptions( FIREFOX ), headless: true } )
		: await launchBrowser();
	const reports = [];

	try {

		for ( const isolated of [ true, false ] ) {

			const server = await startServer( { isolated, fixture } );
			const { port } = server.address();
			const page = await browser.newPage();
			try {

				await page.goto( `http://localhost:${port}/`, { waitUntil: 'load' } );
				await page.waitForFunction( 'globalThis.__storageBenchReady === true' );
				log( `  ${isolated ? 'isolated' : 'not isolated'}…` );
				const result = await page.evaluate(
					( opts ) => globalThis.__storageBench.run( opts ),
					{ sizeMiB, gzURL: fixture ? '/fixture.tar.gz' : null }
				);
				reports.push( result );

			} finally {

				await page.close();
				server.close();

			}

		}

	} finally {

		await browser.close();

	}

	return reports;

}

export function formatStorage( reports ) {

	const f = ( v ) => ( v === undefined ? '—' : v.toFixed( v < 10 ? 2 : 0 ) );
	const rows = [
		[ 'sequential write, sync handle (MiB/s)', 'writeSync' ],
		[ 'sequential write, createWritable (MiB/s)', 'writeWritable' ],
		[ 'sequential read, sync handle (MiB/s)', 'readSync' ],
		[ 'sequential read, sync handle + transfer (MiB/s)', 'readSyncTransfer' ],
		[ 'sequential read, sync handle into SAB (MiB/s)', 'readSyncShared' ],
		[ 'sequential read, File.slice (MiB/s)', 'readFileSlices' ],
		[ 'random 64 KiB read, sync handle (ms/read)', 'randomSyncPerReadMs' ],
		[ 'random 64 KiB read, File.slice (ms/read)', 'randomFilePerReadMs' ],
	];

	const lines = [ `  ${'measure'.padEnd( 50 )} ${'isolated'.padStart( 10 )} ${'not'.padStart( 10 )}` ];
	for ( const [ label, key ] of rows ) {

		lines.push( `  ${label.padEnd( 50 )} ${f( reports[ 0 ]?.[ key ] ).padStart( 10 )} ${f( reports[ 1 ]?.[ key ] ).padStart( 10 )}` );

	}

	for ( const r of reports ) {

		const tag = r.crossOriginIsolated ? 'isolated' : 'not isolated';
		lines.push( `  ${tag}: quota ${r.quotaGiB.toFixed( 0 )} GiB, persisted ${r.persisted}` );
		if ( r.gunzipMemory ) {

			const gb = ( b ) => ( b / 1073741824 ).toFixed( 2 );
			lines.push( `    gunzip → memory: ${f( r.gunzipMemory.mbps )} MiB/s, ${( r.gunzipMemory.ms / 1000 ).toFixed( 1 )} s, retained ${gb( r.gunzipMemory.retainedBytes )} GiB` );
			lines.push( `    gunzip → OPFS:   ${f( r.gunzipOPFS.mbps )} MiB/s, ${( r.gunzipOPFS.ms / 1000 ).toFixed( 1 )} s, retained ${gb( r.gunzipOPFS.retainedBytes )} GiB, written ${gb( r.gunzipOPFS.written )} GiB` );

		}

	}

	return lines.join( '\n' );

}

function processTreeRSS( rootPid ) {

	const out = execFileSync( 'ps', [ '-A', '-o', 'pid=,ppid=,rss=' ], { encoding: 'utf8' } );
	const rows = out.trim().split( '\n' ).map( ( line ) => line.trim().split( /\s+/ ).map( Number ) );
	const children = new Map();
	for ( const [ pid, ppid ] of rows ) {

		if ( ! children.has( ppid ) ) children.set( ppid, [] );
		children.get( ppid ).push( pid );

	}

	const rss = new Map( rows.map( ( [ pid, , kb ] ) => [ pid, kb * 1024 ] ) );
	let total = 0;
	const stack = [ rootPid ];
	while ( stack.length ) {

		const pid = stack.pop();
		total += rss.get( pid ) ?? 0;
		stack.push( ...( children.get( pid ) ?? [] ) );

	}

	return total;

}

/**
 * Loads each archive through the engine in the storage harness and reports time, triangles and
 * the peak resident memory of the whole Chrome process tree, sampled from outside.
 */
export async function runArchiveScenarios( harness, scenarios, { log } ) {

	const pid = harness.browser.process()?.pid;
	const input = await harness.page.$( '#archive' );
	const results = [];

	await harness.page.evaluate( () => globalThis.__bench.storage.clearAll() );

	for ( const { label, file, storage = 'auto' } of scenarios ) {

		await input.uploadFile( file );
		const baseline = processTreeRSS( pid );
		let peak = baseline;
		const timer = setInterval( () => {

			peak = Math.max( peak, processTreeRSS( pid ) );

		}, 200 );

		try {

			const result = await harness.page.evaluate( ( opts ) => globalThis.__bench.storage.archiveLoad( opts ), { storage } );
			results.push( { label, ...result, baselineGB: baseline / 1e9, peakGB: peak / 1e9 } );
			log( `  ${label}: ${( result.ms / 1000 ).toFixed( 1 )} s, ${result.triangles?.toLocaleString() ?? '?'} triangles, peak ${( peak / 1e9 ).toFixed( 2 )} GB (from ${( baseline / 1e9 ).toFixed( 2 )})` );
			for ( const issue of result.issues ) log( `    ${issue}` );

		} finally {

			clearInterval( timer );

		}

	}

	return results;

}
