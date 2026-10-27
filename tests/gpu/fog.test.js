/**
 * The fog's pieces on the GPU: the box span a ray spends inside it, and the Henyey–Greenstein phase function the scatter
 * direction is drawn from — the draw and the density Shade weighs it with must be one distribution, or MIS is biased.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec2, vec3, normalize, dot } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { fogSpan, henyeyGreenstein } from '@/core/shaders/Fog.js';
import { sampleHenyeyGreenstein } from '@/core/shaders/Subsurface.js';

const N = 1 << 16;

// Stratified pairs on a 256 × 256 grid, jittered by a fixed hash so the run is reproducible.
const strata = () => {

	const xi = new Float32Array( N * 2 );
	let s = 12345;
	const rand = () => ( ( s = ( s * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	for ( let i = 0; i < N; i ++ ) {

		xi[ i * 2 ] = ( ( i & 255 ) + rand() ) / 256;
		xi[ i * 2 + 1 ] = ( ( i >> 8 ) + rand() ) / 256;

	}

	return xi;

};

async function drawHG( renderer, g, wi ) {

	const out = new Float32Array( await evaluate( renderer, N, { xi: [ strata(), 'vec2' ] }, 'vec2', ( a ) => {

		const w = normalize( vec3( ...wi ) );
		const L = sampleHenyeyGreenstein( w, float( g ), a.xi ).toVar();
		return vec2( dot( w, L ), henyeyGreenstein( dot( w, L ), float( g ) ) );

	} ) );
	return out;

}

describeGPU( 'fog', () => {

	let renderer;
	beforeAll( async () => {

		renderer = await createRenderer();

	} );
	afterAll( () => renderer?.dispose() );

	it( 'draws scatter directions from the density it weighs them with', async () => {

		for ( const g of [ 0, 0.3, 0.7, - 0.5, 0.9 ] ) {

			const out = await drawHG( renderer, g, [ 0.3, - 0.8, 0.52 ] );
			let meanCos = 0, inversePdf = 0;
			for ( let i = 0; i < N; i ++ ) {

				meanCos += out[ i * 2 ];
				inversePdf += 1 / out[ i * 2 + 1 ];

			}

			// Henyey–Greenstein's mean cosine is g; E[1 / p] over its own draws is the sphere's 4π only when p is the draw's density.
			expect( meanCos / N ).toBeCloseTo( g, 2 );
			expect( inversePdf / N / ( 4 * Math.PI ) ).toBeCloseTo( 1, 2 );

		}

	} );

	it( 'measures the part of a ray inside the box', async () => {

		const rays = [
			// origin, direction, tMax → enter, leave
			[[ 0, 0, 0 ], [ 1, 0, 0 ], 1e20, 0, 1 ], // from inside
			[[ - 3, 0, 0 ], [ 1, 0, 0 ], 1e20, 2, 4 ], // through
			[[ - 3, 0, 0 ], [ 1, 0, 0 ], 2.5, 2, 2.5 ], // stops inside
			[[ - 3, 2, 0 ], [ 1, 0, 0 ], 1e20, null, null ], // misses
			[[ 3, 0, 0 ], [ 1, 0, 0 ], 1e20, null, null ], // leaves it behind
			[[ 0, 0, 0 ], [ 0, 0.6, 0.8 ], 1e20, 0, 1.25 ], // diagonal, axis-parallel components of 0
		];
		const origins = new Float32Array( rays.flatMap( ( [ o, , t ] ) => [ ...o, t ] ) );
		const directions = new Float32Array( rays.flatMap( ( [ , d ] ) => [ ...d, 0 ] ) );
		const out = new Float32Array( await evaluate( renderer, rays.length, { o: [ origins, 'vec4' ], d: [ directions, 'vec4' ] }, 'vec2',
			( a ) => fogSpan( a.o.xyz, a.d.xyz, a.o.w, vec3( - 1 ), vec3( 1 ) ) ) );

		rays.forEach( ( [ , , , enter, leave ], i ) => {

			const [ near, far ] = [ out[ i * 2 ], out[ i * 2 + 1 ] ];
			if ( enter === null ) expect( far ).toBeLessThanOrEqual( near );
			else {

				expect( near ).toBeCloseTo( enter, 5 );
				expect( far ).toBeCloseTo( leave, 5 );

			}

		} );

	} );

} );
