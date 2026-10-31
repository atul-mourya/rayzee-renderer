/**
 * The fog's pieces on the GPU: the box span a ray spends inside it, the Henyey–Greenstein phase function the scatter
 * direction is drawn from — the draw and the density Shade weighs it with must be one distribution, or MIS is biased —
 * and the closed-form optical depth and free flight of fog thinning with height, held to a numerical integral.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec2, vec3, vec4, normalize, dot } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { fogSpan, henyeyGreenstein, fogOpticalDepth, fogFreeFlight } from '@/core/shaders/Fog.js';
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

	// Rays at heights oy + t · dy through fog of `density` below `floor` and density · e^(−falloff · h) at h above it.
	const heightRays = ( count ) => {

		let seed = 7;
		const rand = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
		const ray = new Float32Array( count * 4 ), medium = new Float32Array( count * 4 );
		const falloffs = [ 0, 0.1, 1, 4, 20 ];
		for ( let i = 0; i < count; i ++ ) {

			const dy = [ 0, 1e-7, - 1e-7, 1, - 1 ][ i % 5 ] || ( rand() * 2 - 1 );
			const a = rand();
			ray.set( [ rand() * 5 - 2, dy, a, a + rand() * 6 ], i * 4 );
			// The variate's tail reaches past most spans, so both outcomes of the free flight are drawn.
			medium.set( [ 0.05 + rand() * 3, falloffs[ Math.floor( i / 5 ) % falloffs.length ], rand() * 2 - 1, - Math.log( 1 - rand() ) * 2 ], i * 4 );

		}

		return { ray, medium };

	};

	const cpuDepth = ( [ oy, dy, a, b ], [ density, falloff, floor ] ) => {

		const steps = 20000, h = ( b - a ) / steps;
		const rho = ( t ) => density * Math.exp( - falloff * Math.max( oy + dy * t - floor, 0 ) );
		let sum = rho( a ) + rho( b );
		for ( let k = 1; k < steps; k ++ ) sum += rho( a + k * h ) * ( k % 2 ? 4 : 2 );
		return sum * h / 3;

	};

	it( 'integrates fog thinning with height in closed form, and inverts it for the free flight', async () => {

		const N = 2000;
		const { ray, medium } = heightRays( N );
		const out = new Float32Array( await evaluate( renderer, N, { r: [ ray, 'vec4' ], m: [ medium, 'vec4' ] }, 'vec2', ( { r, m } ) => {

			const fog = { density: m.x, falloff: m.y, floor: m.z };
			const origin = vec3( 0, r.x, 0 ), dir = vec3( 0, r.y, 0 );
			return vec2( fogOpticalDepth( fog, origin, dir, r.z, r.w ), fogFreeFlight( fog, origin, dir, r.z, r.w, m.w ) );

		} ) );

		let scattered = 0;
		for ( let i = 0; i < N; i ++ ) {

			const r = Array.from( ray.subarray( i * 4, i * 4 + 4 ) ), m = Array.from( medium.subarray( i * 4, i * 4 + 4 ) );
			const depth = cpuDepth( r, m );
			expect( Math.abs( out[ i * 2 ] - depth ) ).toBeLessThanOrEqual( 2e-4 * depth + 1e-7 );

			// The flight lands where the depth from the start reaches the variate, or past the span when it holds less.
			const [ , , a, b ] = r, t = out[ i * 2 + 1 ], xi = m[ 3 ];
			if ( xi < depth * ( 1 - 1e-3 ) ) {

				scattered ++;
				expect( t ).toBeGreaterThanOrEqual( a - 1e-5 );
				expect( t ).toBeLessThan( b );
				expect( Math.abs( cpuDepth( [ r[ 0 ], r[ 1 ], a, t ], m ) - xi ) ).toBeLessThanOrEqual( 1e-3 * xi + 1e-5 );

			} else if ( xi > depth * ( 1 + 1e-3 ) ) expect( t ).toBeGreaterThanOrEqual( b );

		}

		expect( scattered ).toBeGreaterThan( N / 4 );
		expect( scattered ).toBeLessThan( N * 3 / 4 );

	} );

	it( 'keeps even fog exactly as a homogeneous medium computes it', async () => {

		const N = 256;
		const { ray, medium } = heightRays( N );
		for ( let i = 0; i < N; i ++ ) medium[ i * 4 + 1 ] = 0;
		const out = new Float32Array( await evaluate( renderer, N, { r: [ ray, 'vec4' ], m: [ medium, 'vec4' ] }, 'vec4', ( { r, m } ) => {

			const fog = { density: m.x, falloff: m.y, floor: m.z };
			const origin = vec3( 0, r.x, 0 ), dir = vec3( 0, r.y, 0 );
			return vec4( fogOpticalDepth( fog, origin, dir, r.z, r.w ), fogFreeFlight( fog, origin, dir, r.z, r.w, m.w ),
				m.x.mul( r.w.sub( r.z ) ), r.z.add( m.w.div( m.x ) ) );

		} ) );

		for ( let i = 0; i < N; i ++ ) {

			expect( out[ i * 4 ] ).toBe( out[ i * 4 + 2 ] );
			expect( out[ i * 4 + 1 ] ).toBe( out[ i * 4 + 3 ] );

		}

	} );

} );
