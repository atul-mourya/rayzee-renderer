/**
 * Renders a small scene in Node with the renderer core and saves it through `exportImage()` in every format Node
 * has, then reads each file back: 8- and 16-bit PNG against the readback, EXR's picture and layers (depth checked
 * against the floor's analytic distance, through a culled wall and an alpha cut-out), Radiance HDR; and the writers
 * alone (`rayzee/encoders`) against `exportImage()`.
 *
 *   npm run build:engine && node bench/tools/export-check.mjs [outDir] [WIDTHxHEIGHT]
 */

import { create, globals } from 'webgpu';
import { inflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Scene, Mesh, SphereGeometry, PlaneGeometry, MeshPhysicalMaterial, Vector3, FloatType, DoubleSide } from 'three';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { PNG } from 'pngjs';
import { RayzeeRenderer, configurePlatform } from 'rayzee/core';
import { nodePlatform } from 'rayzee/node';
import { encodePNG } from 'rayzee/encoders';

Object.assign( globalThis, globals );
const gpu = create( [] );
Object.defineProperty( globalThis.navigator, 'gpu', { value: gpu, configurable: true } );
configurePlatform( nodePlatform() );

const out = process.argv[ 2 ] ?? 'export-check';
await mkdir( out, { recursive: true } );
const [ width, height ] = ( process.argv[ 3 ] ?? '320x200' ).split( 'x' ).map( Number );
const failures = [];
const check = ( ok, message ) => {

	console.log( `${ok ? 'ok  ' : 'FAIL'} ${message}` );
	if ( ! ok ) failures.push( message );

};

const renderer = new RayzeeRenderer( null, { strict: false, storage: false } );
renderer.setReservedRenderResolution( Math.max( width, height ) );
await renderer.init();
renderer.setCanvasSize( width, height );
renderer.setDeterministicMode( true );
renderer.stages.pathTracer.setAuxGBufferEnabled( true );

const scene = new Scene();
const floor = new Mesh( new PlaneGeometry( 40, 40 ), new MeshPhysicalMaterial( { color: 0xb0b0b0, roughness: 0.8 } ) );
floor.rotation.x = - Math.PI / 2;
const ball = new Mesh( new SphereGeometry( 0.6, 64, 32 ), new MeshPhysicalMaterial( { color: 0xffc36b, metalness: 1, roughness: 0.25 } ) );
ball.position.set( - 0.8, 0.6, 0 );
// Faces away from the camera: culled for camera rays, so the depth must go through it.
const wall = new Mesh( new PlaneGeometry( 10, 10 ), new MeshPhysicalMaterial( { color: 0xff0000 } ) );
wall.position.set( 0, 0, 3.5 );
wall.rotation.y = Math.PI;
// Below its cut-off everywhere: an alpha cut-out the depth must skip.
const card = new Mesh( new PlaneGeometry( 10, 10 ), new MeshPhysicalMaterial( { color: 0x00ff00, opacity: 0.2, alphaTest: 0.5, transparent: true, side: DoubleSide } ) );
card.position.set( 0, 0.5, 2.5 );
scene.add( floor, ball, wall, card );

await renderer.loadObject3D( scene, 'export-check' );
renderer.environmentManager.params.solidSkyColor.set( 0xe8edf2 );
await renderer.environmentManager.setMode( 'color' );
renderer.camera.position.set( 0, 1.4, 4.2 );
renderer.camera.lookAt( 0, 0.5, 0 );
await renderer.renderFrames( 32 );

const time = async ( label, options ) => {

	const start = performance.now();
	const file = await renderer.exportImage( options );
	const bytes = new Uint8Array( await file.blob.arrayBuffer() );
	console.log( `     ${label}: ${( performance.now() - start ).toFixed( 0 )} ms, ${( bytes.length / 1024 ).toFixed( 1 )} KB, ${file.colorSpace}, layers [${file.passes}]` );
	await writeFile( path.join( out, `${label}.${file.extension}` ), bytes );
	return { file, bytes };

};

// PNG, 8 and 16 bits, against the readback.
const srgb = ( await renderer.renderToBuffer( { colorSpace: 'srgb', source: 'display' } ) ).data;
const png8 = await time( 'png8', { format: 'png' } );
const decoded8 = PNG.sync.read( Buffer.from( png8.bytes ) );
let same = true;
for ( let i = 0; i < width * height; i ++ ) for ( let c = 0; c < 3; c ++ ) same &&= decoded8.data[ i * 4 + c ] === srgb[ i * 4 + c ];
check( same && decoded8.width === width, 'png8 holds the readback, byte for byte' );

// The writers alone, as a host holding its own pixels reaches them.
const direct = new Uint8Array( await ( await encodePNG( { data: srgb, width, height, alpha: false } ) ).arrayBuffer() );
const plain = new Uint8Array( await ( await renderer.exportImage( { format: 'png', metadata: false } ) ).blob.arrayBuffer() );
check( direct.length === plain.length && direct.every( ( v, i ) => v === plain[ i ] ), 'rayzee/encoders writes the PNG exportImage does, byte for byte' );

const png16 = await time( 'png16', { format: 'png', bitDepth: 16 } );
const decoded16 = PNG.sync.read( Buffer.from( png16.bytes ), { skipRescale: true } );
let coarse = 0, levels = new Set();
for ( let i = 0; i < width * height; i ++ ) for ( let c = 0; c < 3; c ++ ) {

	const v = decoded16.data[ i * 4 + c ];
	coarse = Math.max( coarse, Math.abs( v / 257 - srgb[ i * 4 + c ] ) );
	levels.add( v );

}

check( coarse <= 1, `png16 is the same picture within one 8-bit level (worst ${coarse.toFixed( 2 )})` );
check( levels.size > new Set( srgb ).size, `png16 holds finer steps (${levels.size} distinct values against ${new Set( srgb ).size})` );

// EXR with every layer.
const exr = await time( 'exr', { format: 'exr', passes: [ 'albedo', 'normal', 'depth' ] } );
check( exr.file.passes.join() === 'albedo,normal,depth', 'exr wrote all three layers' );
const linear = ( await renderer.renderToBuffer( { colorSpace: 'linear', source: 'display' } ) ).data;
const picture = new EXRLoader().setDataType( FloatType ).parse( exr.bytes.buffer );
let worst = 0;
for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width * 4; x ++ ) {

	const want = linear[ y * width * 4 + x ];
	worst = Math.max( worst, Math.abs( picture.data[ ( height - 1 - y ) * width * 4 + x ] - want ) / Math.max( 1e-3, Math.abs( want ) ) );

}

check( worst < 1e-3, `exr picture matches the linear readback (worst relative ${worst.toExponential( 2 )})` );

const layers = readEXRChannels( exr.bytes );
check( Object.keys( layers ).join() === 'A,B,G,R,albedo.B,albedo.G,albedo.R,depth.Z,normal.X,normal.Y,normal.Z', `exr channels ${Object.keys( layers )}` );

// Depth on the floor: the bottom row's centre, against the ray's analytic hit.
const camera = renderer.camera;
camera.updateMatrixWorld();
const forward = new Vector3();
camera.getWorldDirection( forward );
let depthWorst = 0, checked = 0;
for ( const [ x, y ] of [ [ width / 2, height - 1 ], [ 40, height - 5 ], [ width - 30, height - 20 ] ] ) {

	const ndc = new Vector3( ( ( x + 0.5 ) / width ) * 2 - 1, 1 - ( ( y + 0.5 ) / height ) * 2, 0.5 ).unproject( camera );
	const dir = ndc.sub( camera.position ).normalize();
	const t = - camera.position.y / dir.y;
	const hit = camera.position.clone().addScaledVector( dir, t );
	const want = hit.sub( camera.position ).dot( forward );
	const got = layers[ 'depth.Z' ][ y * width + x ];
	depthWorst = Math.max( depthWorst, Math.abs( got - want ) / want );
	checked ++;

}

check( checked === 3 && depthWorst < 1e-4, `depth on the floor, through a culled wall and a cut-out, matches the analytic distance (worst relative ${depthWorst.toExponential( 2 )})` );
check( layers[ 'depth.Z' ][ 0 ] === 1e10, 'depth of the sky is 1e10' );
const n = [ 'X', 'Y', 'Z' ].map( c => layers[ `normal.${c}` ][ ( height - 1 ) * width + width / 2 ] );
check( Math.abs( n[ 1 ] - 1 ) < 0.01 && Math.abs( n[ 0 ] ) < 0.01, `the floor's normal is up (${n.map( v => v.toFixed( 3 ) )})` );
const a = [ 'R', 'G', 'B' ].map( c => layers[ `albedo.${c}` ][ ( height - 1 ) * width + width / 2 ] );
check( Math.abs( a[ 0 ] - a[ 2 ] ) < 0.02 && a[ 0 ] > 0.3 && a[ 0 ] < 0.6, `the floor's albedo is its grey, linear (${a.map( v => v.toFixed( 3 ) )})` );

// Float precision and Radiance HDR.
const exrFloat = await time( 'exr-float', { format: 'exr', precision: 'float' } );
check( readEXRChannels( exrFloat.bytes ).R[ 0 ] === linear[ 0 ], 'float exr keeps the value exactly' );
const hdr = await time( 'hdr', { format: 'hdr' } );
const rgbe = new HDRLoader().setDataType( FloatType ).parse( hdr.bytes.buffer );
let hdrWorst = 0;
for ( let i = 0; i < width * height; i ++ ) {

	const max = Math.max( linear[ i * 4 ], linear[ i * 4 + 1 ], linear[ i * 4 + 2 ] );
	for ( let c = 0; c < 3; c ++ ) hdrWorst = Math.max( hdrWorst, Math.abs( rgbe.data[ i * 4 + c ] - linear[ i * 4 + c ] ) / Math.max( max, 1e-6 ) );

}

check( hdrWorst <= 1 / 128, `hdr within RGBE precision (worst ${hdrWorst.toExponential( 2 )} of the brightest channel)` );

// As on screen: the picture's light, which a viewer's sRGB curve turns back into the picture. RGBE shares one exponent
// a pixel, so its dark channels beside a bright one keep less; EXR keeps each.
const encode = v => 255 * ( v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow( Math.min( v, 1 ), 1 / 2.4 ) - 0.055 );
const versusPicture = light => {

	let worst = 0, sum = 0;
	for ( let i = 0; i < width * height; i ++ ) for ( let c = 0; c < 3; c ++ ) {

		const d = Math.abs( encode( light( i, c ) ) - srgb[ i * 4 + c ] );
		worst = Math.max( worst, d );
		sum += d;

	}

	return { worst, mean: sum / ( width * height * 3 ) };

};

const shownEXR = await time( 'exr-as-shown', { format: 'exr', asShown: true } );
const exrLight = new EXRLoader().setDataType( FloatType ).parse( shownEXR.bytes.buffer ).data;
const exrFit = versusPicture( ( i, c ) => exrLight[ ( ( height - 1 - Math.floor( i / width ) ) * width + i % width ) * 4 + c ] );
check( shownEXR.file.colorSpace === 'srgb-linear' && exrFit.worst <= 1.5, `as-shown exr is the screen's picture once a viewer encodes it (worst ${exrFit.worst.toFixed( 2 )} of 255)` );
const shownHDR = await time( 'hdr-as-shown', { format: 'hdr', asShown: true } );
const hdrLight = new HDRLoader().setDataType( FloatType ).parse( shownHDR.bytes.buffer ).data;
const hdrFit = versusPicture( ( i, c ) => hdrLight[ i * 4 + c ] );
check( hdrFit.mean <= 0.5 && hdrFit.worst <= 6, `as-shown hdr matches within RGBE precision (mean ${hdrFit.mean.toFixed( 2 )}, worst ${hdrFit.worst.toFixed( 2 )} of 255)` );

await renderer.exportImage( { format: 'jpeg' } ).then( () => check( false, 'jpeg should need a canvas in Node' ), error => check( /OffscreenCanvas/.test( error.message ), 'jpeg explains it needs a canvas' ) );

renderer.dispose();
console.log( failures.length ? `\n${failures.length} failed` : '\nall passed' );
process.exit( failures.length ? 1 : 0 );

/** A single-part scanline EXR's channels as Float32Arrays, top row first (ZIP or none). */
function readEXRChannels( bytes ) {

	const view = new DataView( bytes.buffer, bytes.byteOffset );
	let at = 8;
	const str = () => {

		let end = at;
		while ( bytes[ end ] ) end ++;
		const s = Buffer.from( bytes.subarray( at, end ) ).toString();
		at = end + 1;
		return s;

	};

	const attributes = {};
	for ( ;; ) {

		const name = str();
		if ( ! name ) break;
		const type = str();
		const size = view.getUint32( at, true );
		attributes[ name ] = { type, at: at + 4, size };
		at += 4 + size;

	}

	const channels = [];
	for ( let c = attributes.channels.at; bytes[ c ]; ) {

		let end = c;
		while ( bytes[ end ] ) end ++;
		channels.push( { name: Buffer.from( bytes.subarray( c, end ) ).toString(), type: view.getInt32( end + 1, true ) } );
		c = end + 17;

	}

	const w = view.getInt32( attributes.dataWindow.at + 8, true ) + 1;
	const h = view.getInt32( attributes.dataWindow.at + 12, true ) + 1;
	const zip = bytes[ attributes.compression.at ] === 3;
	const lines = zip ? 16 : 1;
	const blocks = Math.ceil( h / lines );
	const result = Object.fromEntries( channels.map( c => [ c.name, new Float32Array( w * h ) ] ) );
	const lineBytes = channels.reduce( ( s, c ) => s + ( c.type === 2 ? 4 : 2 ) * w, 0 );

	for ( let b = 0; b < blocks; b ++ ) {

		const offset = Number( view.getBigUint64( at + b * 8, true ) );
		const y0 = view.getInt32( offset, true );
		const size = view.getInt32( offset + 4, true );
		const count = Math.min( lines, h - y0 );
		let raw = bytes.subarray( offset + 8, offset + 8 + size );
		if ( size < count * lineBytes ) {

			const tmp = new Uint8Array( inflateSync( raw ) );
			for ( let t = 1; t < tmp.length; t ++ ) tmp[ t ] = ( tmp[ t - 1 ] + tmp[ t ] - 128 ) & 0xFF;
			raw = new Uint8Array( tmp.length );
			for ( let s = 0, t1 = 0, t2 = ( tmp.length + 1 ) >> 1; s < tmp.length; ) {

				raw[ s ++ ] = tmp[ t1 ++ ];
				if ( s < tmp.length ) raw[ s ++ ] = tmp[ t2 ++ ];

			}

		}

		const rv = new DataView( raw.buffer, raw.byteOffset, raw.byteLength );
		let o = 0;
		for ( let y = y0; y < y0 + count; y ++ ) for ( const c of channels ) for ( let x = 0; x < w; x ++ ) {

			result[ c.name ][ y * w + x ] = c.type === 2 ? rv.getFloat32( o, true ) : halfToFloat( rv.getUint16( o, true ) );
			o += c.type === 2 ? 4 : 2;

		}

	}

	return result;

}

function halfToFloat( h ) {

	const s = h & 0x8000 ? - 1 : 1, e = ( h >> 10 ) & 0x1F, m = h & 0x3FF;
	if ( e === 0 ) return s * m * 2 ** - 24;
	if ( e === 31 ) return m ? NaN : s * Infinity;
	return s * ( 1 + m / 1024 ) * 2 ** ( e - 15 );

}
