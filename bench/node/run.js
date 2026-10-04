/**
 * The bench corpus rendered in plain Node on Dawn — the `webgpu` package, the WebGPU inside Chrome —
 * with no browser and no DOM shim, only what the engine's platform seams take: `navigator.gpu` and
 * `configurePlatform( nodePlatform() )`. Each render is compared with the Chrome golden, so a
 * new browser dependency, or a Node-only divergence, fails the day it lands.
 *
 *   npm run bench:node [-- --only a,b] [-- --core]
 *
 * It runs the BUILT engine (rayzee/dist), which is what a Node host imports; the npm script builds it.
 * `--core` also renders each scene with the renderer core (`rayzee/core`), alive beside the full engine,
 * and it must match the full engine byte for byte.
 */

import path from 'node:path';
import os from 'node:os';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

register( './resolve.js', import.meta.url );

const here = path.dirname( fileURLToPath( import.meta.url ) );
const goldenDir = path.resolve( here, '..', 'baselines', 'golden' );

const GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';

// Chrome and Node compile the same WGSL with different Dawn builds, and the readback tone-maps on the
// CPU (within one level of the canvas the goldens were captured from), so this cannot be bit-exact.
const GATES = { maxRmseSrgb: 0.004, maxFractionOverThreshold: 0.01, pixelThreshold: 0.02 };

const coreToo = process.argv.includes( '--core' );

const only = ( () => {

	const at = process.argv.indexOf( '--only' );
	return at > 0 ? process.argv[ at + 1 ].split( ',' ) : null;

} )();

const { create, globals } = await import( 'webgpu' );
Object.assign( globalThis, globals );
// Dawn crashes the process if this is collected while a device lives.
const gpu = create( [] );
Object.defineProperty( globalThis.navigator, 'gpu', { value: gpu, configurable: true } );

const { configurePlatform, configureAssets, openHeadless } = await import( 'rayzee' );
const { nodePlatform } = await import( 'rayzee/node' );
const { SCENES, RENDER_SIZE } = await import( '../harness/scenes.js' );
const { createSceneSession } = await import( '../harness/sceneSession.js' );
const { compare } = await import( '../lib/metrics.js' );
const { exists, readPNG } = await import( '../lib/png.js' );

configurePlatform( nodePlatform() );

const app = await openHeadless( {
	width: RENDER_SIZE.width,
	height: RENDER_SIZE.height,
	strict: false,
	profile: 'viewer',
	deterministic: true,
	hostMemoryGB: os.totalmem() / 2 ** 30,
} );
console.log( `${DIM}${app.adapterInfo.description || app.adapterInfo.vendor} · node ${process.version}${RESET}\n` );

// As openHeadless sets up the full engine.
async function openCore() {

	const { RayzeeRenderer } = await import( 'rayzee/core' );
	const { PhysicalSky } = await import( 'rayzee/addons/physical-sky' );
	const { BidirectionalIntegrator } = await import( 'rayzee/addons/bidirectional' );
	const core = new RayzeeRenderer( null, { autoResize: false, strict: false, profile: 'viewer', storage: false, hostMemoryGB: os.totalmem() / 2 ** 30 } );
	core.setReservedRenderResolution( Math.max( RENDER_SIZE.width, RENDER_SIZE.height ) );
	await core.init();
	core.environmentManager.setProceduralSky( PhysicalSky );
	core.stages.pathTracer.registerIntegrator( [ 'bidirectional', 'vcm' ], pt => new BidirectionalIntegrator( pt ) );
	// The full engine compiles the denoisers' G-buffer; with it here too both run the same programs, so a byte that
	// differs is state shared between renderers. Without it the core's Shade compiles differently (arealights-two: 56
	// bytes of 262,144, compiler scheduling) — the core-node example renders that way.
	core.stages.pathTracer.requestOutput( 'gBuffer' );
	core.setCanvasSize( RENDER_SIZE.width, RENDER_SIZE.height );
	core.setDeterministicMode( true );
	return core;

}

const core = coreToo ? await openCore() : null;
const coreSession = core && createSceneSession( core );

const session = createSceneSession( app );
let failed = 0;

for ( const scene of SCENES ) {

	if ( only && ! only.includes( scene.id ) ) continue;

	const goldenPath = path.join( goldenDir, `${scene.id}.png` );
	if ( ! await exists( goldenPath ) ) continue;

	try {

		const startedAt = performance.now();
		const { spec } = await session.loadScene( scene.id );
		await app.renderFrames( spec.spp );
		const frame = await app.renderToBuffer( { colorSpace: 'srgb' } );
		const ms = Math.round( performance.now() - startedAt );

		const m = compare( frame, await readPNG( goldenPath ), { threshold: GATES.pixelThreshold } );
		const pass = m.rmseSrgb <= GATES.maxRmseSrgb && m.fractionOverThreshold <= GATES.maxFractionOverThreshold;
		if ( ! pass ) failed ++;

		console.log(
			`  ${pass ? GREEN + 'pass' : RED + 'FAIL'}${RESET} ${scene.id}${DIM}  vs Chrome golden: rmse ${m.rmseSrgb.toFixed( 5 )}, ` +
			`${( m.fractionOverThreshold * 100 ).toFixed( 3 )} % over ${GATES.pixelThreshold}, max linear Δ ${m.maxChannelDelta.toFixed( 4 )} · ${ms} ms${RESET}`
		);

		if ( core ) {

			await coreSession.loadScene( scene.id );
			await core.renderFrames( spec.spp );
			const { data } = await core.renderToBuffer( { colorSpace: 'srgb' } );
			let differ = 0;
			for ( let i = 0; i < data.length; i ++ ) if ( data[ i ] !== frame.data[ i ] ) differ ++;
			const same = differ === 0 && data.length === frame.data.length;
			if ( ! same ) failed ++;
			console.log( `  ${same ? GREEN + 'pass' : RED + 'FAIL'}${RESET} ${scene.id}${DIM}  core vs full engine: ${differ} of ${frame.data.length} bytes differ${RESET}` );

		}

	} catch ( error ) {

		failed ++;
		console.log( `  ${RED}FAIL${RESET} ${scene.id}  ${error.message}` );

	}

}

// Compressed glTF: three's own Draco and KTX2 loaders start their workers themselves, which works in Node only because
// the engine lends them NodeWorker for the parse (withHostWorker). Each fixture (bench/tools/make-compressed-fixtures.mjs)
// renders against its uncompressed twin, so a decoder that runs but decodes wrongly fails too. The decoders are three's
// own files, served from node_modules: no network.
async function compressedGLTF() {

	const http = await import( 'node:http' );
	const fs = await import( 'node:fs/promises' );
	const libs = path.resolve( here, '../../node_modules/three/examples/jsm/libs' );
	const server = http.createServer( async ( req, res ) => {

		const file = path.join( libs, path.normalize( decodeURIComponent( new URL( req.url, 'http://local' ).pathname ) ) );
		try {

			if ( ! file.startsWith( libs ) ) throw new Error( 'outside libs' );
			res.end( await fs.readFile( file ) );

		} catch {

			res.statusCode = 404;
			res.end();

		}

	} );
	await new Promise( ( resolve ) => server.listen( 0, '127.0.0.1', resolve ) );
	const base = `http://127.0.0.1:${server.address().port}`;
	configureAssets( { dracoDecoderPath: `${base}/draco/`, ktx2TranscoderPath: `${base}/basis/` } );

	const sharp = ( await import( 'sharp' ) ).default;
	configurePlatform( { decodeImage: async ( bytes ) => {

		const { data, info } = await sharp( bytes ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
		return { data: new Uint8Array( data.buffer, data.byteOffset, data.length ), width: info.width, height: info.height };

	} } );

	// The corpus's last scene leaves its settings and sky behind (an integrator, a bounce count); start from boot's.
	app.settings.setMany( session.settingsFloor(), { silent: true } );
	session.restoreEnvParams();

	const render = async ( name, eye ) => {

		const before = app.issues.length;
		await app.loadFile( new File( [ await fs.readFile( path.join( here, 'fixtures', name ) ) ], name ) );
		await app.stages.pathTracer.environment.setMode( 'color' );
		app.camera.position.set( ...eye );
		app.camera.lookAt( 0, 0, 0 );
		app.camera.updateMatrixWorld( true );
		await app.renderFrames( 32, { reset: true } );
		return {
			frame: await app.renderToBuffer( { colorSpace: 'srgb' } ),
			triangles: app.stages.pathTracer.triangleCount,
			issues: app.issues.slice( before ).map( ( i ) => i.code ),
		};

	};

	// Draco quantizes positions to 14 bits (measured rmse 0.0007); ETC1S is lossy at the checker's edges (0.0026).
	const pairs = [
		{ plain: 'knot.glb', packed: 'knot-draco.glb', eye: [ 0, 0, 3 ], maxRmse: 0.003 },
		{ plain: 'checker.glb', packed: 'checker-ktx2.glb', eye: [ 0, 0, 2.6 ], maxRmse: 0.01 },
	];

	try {

		for ( const { plain, packed, eye, maxRmse } of pairs ) {

			const a = await render( plain, eye );
			const b = await render( packed, eye );
			const m = compare( b.frame, a.frame, { threshold: GATES.pixelThreshold } );
			const issues = [ ...a.issues, ...b.issues ];
			const pass = m.rmseSrgb <= maxRmse && a.triangles === b.triangles && ! issues.length && typeof globalThis.Worker === 'undefined';
			if ( ! pass ) failed ++;
			console.log(
				`  ${pass ? GREEN + 'pass' : RED + 'FAIL'}${RESET} ${packed}${DIM}  vs ${plain}: rmse ${m.rmseSrgb.toFixed( 5 )} (≤ ${maxRmse}), ` +
				`${b.triangles} / ${a.triangles} triangles${issues.length ? `, issues: ${issues.join( ', ' )}` : ''}${RESET}`
			);

		}

	} catch ( error ) {

		failed ++;
		console.log( `  ${RED}FAIL${RESET} compressed glTF  ${error.message}` );

	} finally {

		server.close();

	}

}

if ( ! only || only.includes( 'compressed-gltf' ) ) await compressedGLTF();

// The core-only example (rayzee/examples/core-node.mjs) in a process of its own, as a host would run it.
if ( ! only || only.includes( 'example' ) ) {

	const { spawnSync } = await import( 'node:child_process' );
	const out = path.join( os.tmpdir(), `rayzee-core-example-${process.pid}.png` );
	const run = spawnSync( process.execPath, [ path.resolve( here, '../../rayzee/examples/core-node.mjs' ), out ], { encoding: 'utf8' } );
	const line = run.stdout.trim().split( '\n' ).pop();
	if ( run.status !== 0 ) failed ++;
	console.log( `  ${run.status === 0 ? GREEN + 'pass' : RED + 'FAIL'}${RESET} rayzee/examples/core-node.mjs${DIM}  ${run.status === 0 ? line : run.stderr.trim().split( '\n' ).slice( - 3 ).join( ' ' )}${RESET}` );

}

app.dispose();
core?.dispose();

console.log( failed ? `\n${RED}${failed} scene(s) failed${RESET}` : `\n${GREEN}all scenes match Chrome${RESET}` );
process.exit( failed ? 1 : 0 );
