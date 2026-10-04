/**
 * One shadow ray a hit (LightsSampling lightPick): each light is kept as often as its share of the unshadowed
 * luminance, and the kept light divided by that chance sums, on average, to every light's own estimate.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, select, vec3, vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { lightPick } from '@/core/TSL/LightsSampling.js';

const N = 1 << 16;
const LIGHTS = [[ 1, 0.5, 0.2 ], [ 0, 0, 0 ], [ 0.1, 0.1, 3 ], [ 4, 4, 4 ]];
const VISIBLE = [ 1, 1, 0.25, 0.5 ];
const luminance = ( [ r, g, b ] ) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

const stratified = () => Float32Array.from( { length: N }, ( _, i ) => ( i + 0.5 ) / N );

const run = ( renderer, lights ) => evaluate( renderer, N, { u: [ stratified(), 'float' ] }, 'vec4', ( { u } ) => {

	const pick = lightPick( u );
	lights.forEach( ( c, i ) => pick.offer( vec3( ...c ), vec3( i, 0, 0 ), vec3( 0, 1, 0 ), float( 1 ) ) );
	const index = pick.origin.x;
	const visibility = select( index.lessThan( 1.5 ), float( VISIBLE[ 0 ] ), select( index.lessThan( 2.5 ), float( VISIBLE[ 2 ] ), float( VISIBLE[ 3 ] ) ) );
	return vec4( pick.resolve( visibility ), select( pick.total.greaterThan( 0.0 ), index, float( - 1 ) ) );

} ).then( ( buffer ) => new Float32Array( buffer ) );

describeGPU( 'one shadow ray a hit', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'keeps each light as often as its share of the luminance, and never a dark one', async () => {

		const out = await run( renderer, LIGHTS );
		const counts = LIGHTS.map( () => 0 );
		for ( let i = 0; i < N; i ++ ) counts[ out[ i * 4 + 3 ] ] ++;

		const total = LIGHTS.reduce( ( sum, c ) => sum + luminance( c ), 0 );
		LIGHTS.forEach( ( c, i ) => expect( counts[ i ] / N ).toBeCloseTo( luminance( c ) / total, 3 ) );
		expect( counts[ 1 ] ).toBe( 0 );

	} );

	it( 'sums, on average, to every light traced on its own', async () => {

		const out = await run( renderer, LIGHTS );
		const mean = [ 0, 0, 0 ];
		for ( let i = 0; i < N; i ++ ) for ( let c = 0; c < 3; c ++ ) mean[ c ] += out[ i * 4 + c ] / N;

		const expected = [ 0, 1, 2 ].map( ( c ) => LIGHTS.reduce( ( sum, light, i ) => sum + light[ c ] * VISIBLE[ i ], 0 ) );
		mean.forEach( ( m, c ) => expect( m / expected[ c ] ).toBeCloseTo( 1, 3 ) );

	} );

	it( 'keeps nothing when every light is dark', async () => {

		const out = await run( renderer, [[ 0, 0, 0 ], [ 0, 0, 0 ]] );
		for ( let i = 0; i < N; i += 997 ) {

			expect( out[ i * 4 + 3 ] ).toBe( - 1 );
			expect( out[ i * 4 ] ).toBe( 0 );

		}

	} );

} );
