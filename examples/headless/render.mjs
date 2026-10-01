// Path-traces a model in plain Node (no browser) and saves it as render.png.
//
//   npm run build:engine
//   node examples/headless/render.mjs [options]
//
//   --model <file|url>        .glb, .gltf, .fbx, .obj, … (default: a gold ball on a floor)
//   --environment <file|url>  .hdr, .exr, .png or .jpg, or "sky" for the physical sky (default)
//   --resolution <n|WxH>      the longer side in pixels, or an exact size like 1920x1080 (default: 800)
//   --aspect <W:H>            shape for a single-number resolution, like 16:9 or 1.5 (default: 4:3)
//   --camera <name|n>         a camera in the scene, by name or number; 0 is the engine's own view of the model
//                             (default), and a name the scene lacks lists the ones it has
//   --samples <n>             samples per pixel (default: 128)
//   --no-denoise              save the raw render instead of running the OIDN denoiser on it

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { create, globals } from 'webgpu';
import sharp from 'sharp';
import { BoxGeometry, Group, Mesh, MeshPhysicalMaterial, SphereGeometry } from 'three';
import { captureHeadless, configurePlatform, openHeadless } from 'rayzee';
import { NodeWorker, nodePlatform } from 'rayzee/node';

const { values: args } = parseArgs( {
	options: {
		model: { type: 'string' },
		environment: { type: 'string', default: 'sky' },
		resolution: { type: 'string', default: '800' },
		aspect: { type: 'string' },
		camera: { type: 'string' },
		samples: { type: 'string', default: '128' },
		denoise: { type: 'boolean', default: true },
	},
	allowNegative: true,
} );

function renderSize( resolution, aspect ) {

	const exact = resolution.match( /^(\d+)x(\d+)$/i );
	if ( exact ) {

		if ( aspect ) throw new Error( '--aspect only applies to a single-number --resolution' );
		return { width: Number( exact[ 1 ] ), height: Number( exact[ 2 ] ) };

	}

	const side = Number( resolution );
	const [ w, h = 1 ] = ( aspect ?? '4:3' ).split( /[:/]/ ).map( Number );
	const ratio = w / h;
	if ( ! Number.isInteger( side ) || side <= 0 ) throw new Error( `--resolution: expected a size like 800 or 1920x1080, got "${resolution}"` );
	if ( ! ( ratio > 0 ) ) throw new Error( `--aspect: expected a shape like 16:9 or 1.5, got "${aspect}"` );

	return ratio >= 1
		? { width: side, height: Math.round( side / ratio ) }
		: { width: Math.round( side * ratio ), height: side };

}

// A URL loads as is; a local path is read into a File, since Node's fetch cannot open file:// URLs.
async function source( location ) {

	if ( /^https?:\/\//.test( location ) ) return location;
	return new File( [ await readFile( location ) ], path.basename( location ) );

}

function pickCamera( cameras, choice ) {

	const names = cameras.getNames();
	const index = /^\d+$/.test( choice ) ? Number( choice ) : names.findIndex( ( name ) => name.toLowerCase() === choice.toLowerCase() );
	if ( ! ( index >= 0 && index < names.length ) ) {

		throw new Error( `--camera: no camera "${choice}" in this scene; it has ${names.map( ( name, i ) => `${i} "${name}"` ).join( ', ' )}` );

	}

	if ( index !== cameras.currentCameraIndex ) cameras.switchCamera( index );

}

function demoScene() {

	const scene = new Group();
	const floor = new Mesh( new BoxGeometry( 10, 0.2, 10 ), new MeshPhysicalMaterial( { color: 0xcccccc, roughness: 0.8 } ) );
	floor.position.y = - 0.1;
	const ball = new Mesh( new SphereGeometry( 1, 64, 32 ), new MeshPhysicalMaterial( { color: 0xd4a017, metalness: 1, roughness: 0.2 } ) );
	ball.position.y = 1;
	scene.add( floor, ball );
	return scene;

}

async function decodeImage( bytes ) {

	const { data, info } = await sharp( bytes ).ensureAlpha().raw().toBuffer( { resolveWithObject: true } );
	return { data, width: info.width, height: info.height };

}

const { width, height } = renderSize( args.resolution, args.aspect );
const samples = Number( args.samples );
if ( ! Number.isInteger( samples ) || samples <= 0 ) throw new Error( `--samples: expected a positive whole number, got "${args.samples}"` );

Object.assign( globalThis, globals );
const gpu = create( [] ); // Dawn crashes if this is garbage-collected while the app lives
Object.defineProperty( navigator, 'gpu', { value: gpu } );
configurePlatform( nodePlatform( { decodeImage } ) );
globalThis.Worker = NodeWorker; // three.js's Draco and KTX2 decoders start their own workers

const app = await openHeadless( { width, height, hostMemoryGB: os.totalmem() / 2 ** 30 } );

try {

	if ( args.model ) {

		await app.loadFile( await source( args.model ) );

	} else {

		await app.loadObject3D( demoScene() );
		const camera = app.cameraManager.active;
		camera.position.set( 3, 2.5, 5 );
		camera.lookAt( 0, 0.8, 0 );
		camera.updateMatrixWorld(); // the engine reads the cached matrix, and lookAt() leaves it stale
		app.cameraManager.controls?.target.set( 0, 0.8, 0 );

	}

	if ( args.camera ) pickCamera( app.cameraManager, args.camera );

	if ( args.environment === 'sky' ) await app.environmentManager.setMode( 'procedural' );
	else await app.loadFile( await source( args.environment ) );

	app.setDeterministicMode( true ); // a model's own settings can turn adaptive sampling back on

	const frame = await captureHeadless( app, { samples, denoise: args.denoise } );

	// The render is opaque, so its alpha channel is dropped; adaptive filtering keeps the file small.
	await sharp( frame.data, { raw: { width: frame.width, height: frame.height, channels: 4 } } )
		.removeAlpha().png( { adaptiveFiltering: true } ).toFile( 'render.png' );
	const camera = app.cameraManager.getNames()[ app.cameraManager.currentCameraIndex ];
	console.log( `saved render.png (${frame.width}×${frame.height}, camera "${camera}", ${samples} samples, ${frame.source === 'accumulation' ? 'not denoised' : `denoised by ${frame.source}`})` );

} finally {

	app.dispose();

}

// Node's performance.now() counts from process start, so this includes startup and imports.
console.log( `completed in ${( performance.now() / 1000 ).toFixed( 1 )} s` );
