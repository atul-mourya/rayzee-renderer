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

const { configurePlatform, openHeadless } = await import( 'rayzee' );
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

app.dispose();
core?.dispose();

console.log( failed ? `\n${RED}${failed} scene(s) failed${RESET}` : `\n${GREEN}all scenes match Chrome${RESET}` );
process.exit( failed ? 1 : 0 );
