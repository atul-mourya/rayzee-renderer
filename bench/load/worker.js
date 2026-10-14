/**
 * One side of `bench:load` in Node: a headless engine on Dawn, from the checkout the parent names, loading models on
 * request over IPC. The parent runs one per side and interleaves them.
 *
 *   parent → { type: 'load', id, model }      worker → { type: 'result', id, result }
 *   parent → { type: 'exit' }                 worker → { type: 'ready', adapter } once, at start
 */

import { openAsBlob } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire, register } from 'node:module';
import { measureLoad } from './measure.js';

const { tree, dist, width, height } = JSON.parse( process.env.BENCH_LOAD_SIDE );
register( './resolve.js', import.meta.url, { data: { tree, dist } } );

const { create, globals } = await import( 'webgpu' );
Object.assign( globalThis, globals );
// Dawn crashes the process if this is collected while a device lives.
const gpu = create( [] );
Object.defineProperty( globalThis.navigator, 'gpu', { value: gpu, configurable: true } );

const { configureAssets, configurePlatform, openHeadless } = await import( 'rayzee' );
const { nodePlatform } = await import( 'rayzee/node' );
const sharp = ( await import( 'sharp' ) ).default;

const decode = { active: 0, since: 0, busy: 0, calls: 0 };

configurePlatform( nodePlatform( {
	decodeImage: async ( bytes ) => {

		if ( decode.active ++ === 0 ) decode.since = performance.now();
		decode.calls ++;
		try {

			const { data, info } = await sharp( bytes ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
			return { data: new Uint8Array( data.buffer, data.byteOffset, data.length ), width: info.width, height: info.height };

		} finally {

			if ( -- decode.active === 0 ) decode.busy += performance.now() - decode.since;

		}

	},
} ) );

// No network: three's decoders come from this checkout's three, and anything else is refused and reported. Every app
// fetches OIDN's weights at startup, denoising or not; they get a 404 here.
const libs = path.join( path.dirname( createRequire( path.join( tree, 'rayzee', 'package.json' ) ).resolve( 'three' ) ), '..', 'examples', 'jsm', 'libs' );
const server = http.createServer( async ( req, res ) => {

	const file = path.join( libs, path.normalize( decodeURIComponent( new URL( req.url, 'http://local' ).pathname ) ) );
	try {

		if ( ! file.startsWith( libs + path.sep ) ) throw new Error( 'outside libs' );
		res.end( await fs.readFile( file ) );

	} catch {

		res.statusCode = 404;
		res.end();

	}

} );
await new Promise( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
const local = `http://127.0.0.1:${server.address().port}/`;
configureAssets( { dracoDecoderPath: `${local}draco/`, ktx2TranscoderPath: `${local}basis/`, oidnWeightsBaseUrl: `${local}oidn/` } );

const network = [];
const realFetch = globalThis.fetch;
globalThis.fetch = ( input, init ) => {

	const url = String( input?.url ?? input );
	if ( url.startsWith( local ) || /^(data|blob|file):/.test( url ) ) return realFetch( input, init );
	network.push( url );
	return Promise.reject( new TypeError( `bench:load allows no network: ${url}` ) );

};

const app = await openHeadless( { width, height, strict: false, deterministic: true, hostMemoryGB: os.totalmem() / 2 ** 30 } );

async function blobOf( file ) {

	return new File( [ await openAsBlob( file ) ], path.basename( file ) );

}

async function folderOf( dir ) {

	const name = path.basename( dir );
	const files = [];
	for ( const entry of await fs.readdir( dir, { recursive: true, withFileTypes: true } ) ) {

		if ( ! entry.isFile() ) continue;
		const abs = path.join( entry.parentPath, entry.name );
		files.push( { path: `${name}/${path.relative( dir, abs ).split( path.sep ).join( '/' )}`, file: await blobOf( abs ) } );

	}

	return { name, files };

}

const openInput = async ( model ) => ( ( await fs.stat( model.file ) ).isDirectory() ? folderOf( model.file ) : blobOf( model.file ) );

const rss = { peak: 0, timer: null };

const runtime = {
	openInput,
	decodeBusy: () => ( { ms: decode.busy, calls: decode.calls } ),
	resetDecode: () => Object.assign( decode, { busy: 0, calls: 0 } ),
	startSampling() {

		rss.peak = process.memoryUsage.rss();
		rss.timer = setInterval( () => {

			rss.peak = Math.max( rss.peak, process.memoryUsage.rss() );

		}, 10 );

	},
	stopSampling() {

		clearInterval( rss.timer );
		return { rssPeakBytes: Math.max( rss.peak, process.memoryUsage.rss() ) };

	},
	collect: () => globalThis.gc?.(),
};

process.on( 'message', async ( message ) => {

	if ( message.type === 'exit' ) {

		app.dispose();
		server.close();
		process.exit( 0 );

	}

	if ( message.type !== 'load' ) return;

	let result;
	try {

		result = await measureLoad( app, message.model, runtime );

	} catch ( error ) {

		result = { error: String( error?.stack ?? error ) };

	}

	result.network = network.splice( 0 );
	process.send( { type: 'result', id: message.id, result } );

} );

await app.denoisingManager?.denoiser?.whenLoaded?.();

process.send( { type: 'ready', network: network.slice(), startupIssues: app.issues.map( ( { code, severity } ) => ( { code, severity } ) ), adapter: app.adapterInfo?.description || app.adapterInfo?.vendor || 'unknown', node: process.version } );
