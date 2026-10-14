/**
 * NRD at one sample on a flat, evenly lit wall: whatever the wall's texture, an emitter on it, or a sample that is not
 * reflected light, every pixel the blur reaches has the same lighting, so the output must keep the input.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataTexture, RGBAFormat, FloatType, PerspectiveCamera, Vector2, Vector3 } from 'three';
import { describeGPU, createRenderer } from './gpu.js';
import { NRD } from '@/core/Stages/NRD.js';
import { TextureReadback } from '@/core/Processor/TextureReadback.js';

const W = 64, H = 64;
const DISTANCE = 5;

const camera = new PerspectiveCamera( 50, W / H, 0.1, 100 );
camera.position.set( 0, 0, DISTANCE );
camera.lookAt( 0, 0, 0 );
camera.updateMatrixWorld();

// Distance along each pixel's primary ray to the wall at z = 0, as NormalDepth measures it.
function wallDepth( x, y ) {

	const ndc = new Vector3( ( x + 0.5 ) / W * 2 - 1, 1 - ( y + 0.5 ) / H * 2, 1 ).applyMatrix4( camera.projectionMatrixInverse );
	return DISTANCE / - ndc.normalize().z;

}

function texture( fn ) {

	const px = new Float32Array( W * H * 4 );
	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) px.set( fn( x, y ), ( y * W + x ) * 4 );
	const t = new DataTexture( px, W, H, RGBAFormat, FloatType );
	t.needsUpdate = true;
	return t;

}

const uniforms = {
	cameraWorldMatrix: camera.matrixWorld,
	cameraViewMatrix: camera.matrixWorldInverse,
	cameraProjectionMatrixInverse: camera.projectionMatrixInverse,
	cameraProjectionMatrix: camera.projectionMatrix,
	cameraProjection: 0, cameraClipStart: 0, panoLonRange: new Vector2(), panoLatRange: new Vector2(), panoLevelHorizon: 1,
	seedFrame: 0,
};
const pathTracer = { uniforms: { get: ( name ) => ( { value: uniforms[ name ] } ) }, requestOutput: () => () => {}, frameCount: 0 };

let renderer, readback, stage;

beforeAll( async () => {

	renderer = await createRenderer();
	readback = new TextureReadback( renderer );
	stage = new NRD( renderer, { pathTracer, width: W, height: H } );

} );

afterAll( () => {

	stage?.dispose();
	readback?.dispose();
	renderer?.dispose();

} );

/** One fresh NRD frame over the wall; `pixel( x, y )` gives { color, albedo, emitter }. */
async function denoise( pixel ) {

	const textures = {
		'pathtracer:color': texture( ( x, y ) => [ ...pixel( x, y ).color, 1 ] ),
		'pathtracer:albedo': texture( ( x, y ) => [ ...pixel( x, y ).albedo, 0.5 ] ),
		'pathtracer:normalDepth': texture( ( x, y ) => [ 0.5, 0.5, 1, wallDepth( x, y ) ] ),
		'pathtracer:shadingNormal': texture( ( x, y ) => [ 0.5, 0.5, 1, pixel( x, y ).emitter ? - 1 : 1 ] ),
		'motionVector:screenSpace': texture( () => [ 0, 0, 0, 0 ] ),
	};
	const out = {};
	stage.resetHistory();
	stage.render( {
		getTexture: ( name ) => textures[ name ] ?? null,
		setTexture: ( name, value ) => void ( out[ name ] = value ),
		getState: () => 0,
	} );
	const px = await readback.read( out[ 'nrd:output' ], W, H );
	for ( const t of Object.values( textures ) ) t.dispose();
	return ( x, y ) => px[ ( y * W + x ) * 4 + 1 ];

}

// Pixels at least `margin` from the patch, and inside it.
function regions( inPatch, margin ) {

	const outside = [], inside = [];
	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

		let near = false;
		for ( let j = - margin; j <= margin && ! near; j ++ ) for ( let i = - margin; i <= margin; i ++ ) if ( inPatch( x + i, y + j ) ) near = true;
		if ( inPatch( x, y ) ) inside.push( [ x, y ] );
		else if ( ! near ) outside.push( [ x, y ] );

	}

	return { outside, inside };

}

const worst = ( read, list, expected ) => Math.max( ...list.map( ( [ x, y ] ) => Math.abs( read( x, y ) / expected( x, y ) - 1 ) ) );

describeGPU( 'NRD demodulation', () => {

	const panel = ( x, y ) => x >= 26 && x < 38 && y >= 26 && y < 38;

	it( 'blurs a noisy wall', async () => {

		const noise = ( x, y ) => ( ( x * 37 + y * 101 ) % 17 ) / 16 - 0.5;
		const read = await denoise( ( x, y ) => {

			const c = 0.6 * ( 1 + noise( x, y ) );
			return { color: [ c, c, c ], albedo: [ 0.6, 0.6, 0.6 ], emitter: false };

		} );
		const spread = ( f ) => {

			let sum = 0, sum2 = 0;
			for ( let y = 8; y < H - 8; y ++ ) for ( let x = 8; x < W - 8; x ++ ) {

				sum += f( x, y ); sum2 += f( x, y ) ** 2;

			}

			const n = ( W - 16 ) * ( H - 16 );
			return Math.sqrt( sum2 / n - ( sum / n ) ** 2 );

		};

		expect( spread( read ) ).toBeLessThan( 0.25 * spread( ( x, y ) => 0.6 * noise( x, y ) ) );

	}, 60000 );

	it( 'keeps an emitter with a black base colour out of the wall around it', async () => {

		const read = await denoise( ( x, y ) => panel( x, y )
			? { color: [ 20, 20, 20 ], albedo: [ 0, 0, 0 ], emitter: true }
			: { color: [ 0.6, 0.6, 0.6 ], albedo: [ 0.6, 0.6, 0.6 ], emitter: false } );
		const { outside, inside } = regions( panel, 1 );
		expect( worst( read, outside, () => 0.6 ) ).toBeLessThan( 0.01 );
		expect( worst( read, inside, () => 20 ) ).toBeLessThan( 0.01 );

	}, 30000 );

	it( 'keeps an emitter with a white base colour out of the wall around it', async () => {

		const read = await denoise( ( x, y ) => panel( x, y )
			? { color: [ 20.6, 20.6, 20.6 ], albedo: [ 1, 1, 1 ], emitter: true }
			: { color: [ 0.6, 0.6, 0.6 ], albedo: [ 0.6, 0.6, 0.6 ], emitter: false } );
		const { outside } = regions( panel, 1 );
		expect( worst( read, outside, () => 0.6 ) ).toBeLessThan( 0.01 );

	}, 30000 );

	it( 'keeps samples that saw no surface out of the wall', async () => {

		// A one-sample silhouette: the jittered ray missed the wall and saw a bright sky, with no albedo.
		const missed = ( x, y ) => ( x * 7 + y * 13 ) % 23 === 0;
		const read = await denoise( ( x, y ) => missed( x, y )
			? { color: [ 8, 8, 8 ], albedo: [ 0, 0, 0 ], emitter: false }
			: { color: [ 0.6, 0.6, 0.6 ], albedo: [ 0.6, 0.6, 0.6 ], emitter: false } );
		const { outside } = regions( missed, 0 );
		expect( worst( read, outside, () => 0.6 ) ).toBeLessThan( 0.01 );

	}, 30000 );

	it( 'demodulates the specular a dark texel reflects without spreading it onto the light ones', async () => {

		// Diffuse a·1 plus a dielectric's specular, 0.04 whatever the texel.
		const dark = ( x, y ) => ( ( x >> 3 ) + ( y >> 3 ) ) % 2 === 1;
		const albedo = ( x, y ) => ( dark( x, y ) ? 0.01 : 0.8 );
		const read = await denoise( ( x, y ) => {

			const a = albedo( x, y );
			return { color: [ a + 0.04, a + 0.04, a + 0.04 ], albedo: [ a, a, a ], emitter: false };

		} );
		const all = [];
		for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) all.push( [ x, y ] );
		expect( worst( read, all, ( x, y ) => albedo( x, y ) + 0.04 ) ).toBeLessThan( 0.05 );

	}, 30000 );

} );
