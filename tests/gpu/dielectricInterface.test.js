/**
 * A rough dielectric interface (sampleDielectric) must carry, on average, all the light that reaches it: reflection plus
 * refraction's share is the interface's own albedo, which it divides out. The old crossing sent rough "reflections" into
 * the glass without its stack entry and weighed neither facet masking nor the facet's Fresnel: a white furnace read
 * +2.9 % at roughness 0.1 for eta 1.5, +56 % for 2.4, and −32 % / −59 % at roughness 1.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec3, vec4, dot, normalize, select } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { sampleDielectric, DielectricSample } from '@/core/shaders/MaterialTransmission.js';
import { dielectricInterfaceAlbedo } from '@/core/shaders/MaterialProperties.js';

// Unpolarised Fresnel reflectance of a smooth dielectric, eta = n_t / n_i.
function exactFresnel( cosI, eta ) {

	const g2 = eta * eta - 1 + cosI * cosI;
	if ( g2 <= 0 ) return 1;
	const g = Math.sqrt( g2 );
	const A = ( g - cosI ) / ( g + cosI );
	const B = ( cosI * ( g + cosI ) - 1 ) / ( cosI * ( g - cosI ) + 1 );
	return 0.5 * A * A * ( 1 + B * B );

}

function mulberry32( seed ) {

	return () => {

		seed = ( seed + 0x6d2b79f5 ) | 0;
		let t = Math.imul( seed ^ ( seed >>> 15 ), 1 | seed );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

const SIDE = 128; // samples a case: SIDE² facets, each with its own pick

async function run( renderer, cases ) {

	const count = cases.length * SIDE * SIDE;
	const views = new Float32Array( count * 4 ), params = new Float32Array( count * 4 );
	const random = mulberry32( 7 );
	cases.forEach( ( { NoV }, c ) => {

		for ( let i = 0; i < SIDE * SIDE; i ++ ) {

			const k = ( c * SIDE * SIDE + i ) * 4;
			views.set( [ Math.sqrt( 1 - NoV * NoV ), 0, NoV, 0 ], k );
			// Stratified facet, independent pick.
			params.set( [ ( i % SIDE + random() ) / SIDE, ( Math.floor( i / SIDE ) + random() ) / SIDE, random(), 0 ], k );

		}

	} );

	const roughs = new Float32Array( count ), etas = new Float32Array( count );
	cases.forEach( ( { roughness, eta }, c ) => {

		roughs.fill( roughness, c * SIDE * SIDE, ( c + 1 ) * SIDE * SIDE );
		etas.fill( eta, c * SIDE * SIDE, ( c + 1 ) * SIDE * SIDE );

	} );

	const out = new Float32Array( await evaluate( renderer, count, {
		V: [ views, 'vec4' ], p: [ params, 'vec4' ], roughness: [ roughs, 'float' ], eta: [ etas, 'float' ],
	}, 'vec4', ( a ) => {

		const N = vec3( 0, 0, 1 );
		const s = DielectricSample.wrap( sampleDielectric( normalize( a.V.xyz ), N, a.eta, a.roughness, a.p.xy, a.p.z ) ).toVar();
		return vec4( dot( N, s.direction ), s.weight, select( s.didReflect, float( 1 ), float( 0 ) ), 0 );

	} ) );

	return cases.map( ( _, c ) => {

		let weight = 0, reflected = 0, wrongSide = 0;
		for ( let i = 0; i < SIDE * SIDE; i ++ ) {

			const k = ( c * SIDE * SIDE + i ) * 4;
			const [ NoL, w, didReflect ] = [ out[ k ], out[ k + 1 ], out[ k + 2 ] ];
			weight += w;
			reflected += didReflect;
			if ( w > 0 && ( NoL > 0 ) !== ( didReflect === 1 ) ) wrongSide ++;

		}

		const n = SIDE * SIDE;
		return { albedo: weight / n, reflected: reflected / n, wrongSide };

	} );

}

describeGPU( 'rough dielectric interface on the GPU', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	const cases = [];
	for ( const eta of [ 1.33, 1.5, 2.4, 1 / 1.33, 1 / 1.5, 1 / 2.4 ] )
		for ( const roughness of [ 0.1, 0.3, 0.6, 1 ] )
			for ( const NoV of [ 0.15, 0.5, 0.95 ] ) cases.push( { NoV, roughness, eta } );

	it( 'carries all the light it is given, reflected or refracted', async () => {

		const results = await run( renderer, cases );
		results.forEach( ( r, i ) => {

			const { NoV, roughness, eta } = cases[ i ];
			expect( r.albedo, `NoV ${NoV}, roughness ${roughness}, eta ${eta.toFixed( 3 )}` ).toBeCloseTo( 1, 1 );
			expect( Math.abs( r.albedo - 1 ), `NoV ${NoV}, roughness ${roughness}, eta ${eta.toFixed( 3 )}` ).toBeLessThan( 0.02 );

		} );

	} );

	it( 'reflects on the side it came from and refracts through, never the other way', async () => {

		const results = await run( renderer, cases );
		for ( const r of results ) expect( r.wrongSide ).toBe( 0 );

	} );

	it( 'is the delta pair about N at or below MIN_ROUGHNESS, split by the exact Fresnel', async () => {

		const smooth = [];
		for ( const eta of [ 1.5, 1 / 1.5, 2.4 ] ) for ( const NoV of [ 0.2, 0.6, 1 ] ) smooth.push( { NoV, roughness: 0.05, eta } );
		const results = await run( renderer, smooth );
		results.forEach( ( r, i ) => {

			const { NoV, eta } = smooth[ i ];
			expect( r.albedo ).toBe( 1 );
			expect( r.reflected, `NoV ${NoV}, eta ${eta.toFixed( 3 )}` ).toBeCloseTo( exactFresnel( NoV, eta ), 2 );

		} );

	} );

} );

// The rough dielectric BSDF written out (Walter et al. 2007), independent of the sampler: f · |N·L| for light (refraction
// counted as light, not radiance), uncompensated. eta = n2 / n1, V in the xz-plane above N = +z.
function walter( V, L, roughness, eta ) {

	const a2 = roughness ** 4;
	const D = ( NoH ) => a2 / ( Math.PI * ( NoH * NoH * ( a2 - 1 ) + 1 ) ** 2 );
	const lambda = ( c ) => ( Math.sqrt( a2 + ( 1 - a2 ) * c * c ) / c - 1 ) / 2;
	const NoV = V[ 2 ], NoL = L[ 2 ];
	const G2 = 1 / ( 1 + lambda( NoV ) + lambda( Math.abs( NoL ) ) );
	const dot = ( a, b ) => a[ 0 ] * b[ 0 ] + a[ 1 ] * b[ 1 ] + a[ 2 ] * b[ 2 ];
	const norm = ( a ) => a.map( v => v / Math.hypot( ...a ) );

	if ( NoL > 0 ) {

		const H = norm( [ V[ 0 ] + L[ 0 ], V[ 1 ] + L[ 1 ], V[ 2 ] + L[ 2 ] ] );
		return exactFresnel( dot( V, H ), eta ) * D( H[ 2 ] ) * G2 / ( 4 * NoV );

	}

	let H = norm( [ V[ 0 ] + eta * L[ 0 ], V[ 1 ] + eta * L[ 1 ], V[ 2 ] + eta * L[ 2 ] ] );
	if ( H[ 2 ] < 0 ) H = H.map( v => - v );
	const VoH = dot( V, H ), LoH = dot( L, H );
	if ( VoH <= 0 || LoH >= 0 ) return 0;
	return ( 1 - exactFresnel( VoH, eta ) ) * D( H[ 2 ] ) * G2 * eta * eta * VoH * Math.abs( LoH ) / ( NoV * ( VoH + eta * LoH ) ** 2 );

}

describeGPU( 'rough dielectric interface against the BSDF written out', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	// Bins in cos θ (−1…1) × φ, mirrored about the plane of V: the sampler's histogram of weight, against the BSDF's
	// integral over each bin.
	const BINS_Z = 24, BINS_PHI = 12;

	it.each( [
		[ 0.6, 0.3, 1.5 ], [ 0.6, 0.3, 1 / 1.5 ], [ 0.9, 0.6, 1.5 ], [ 0.3, 0.5, 1 / 1.33 ], [ 0.5, 1, 2.4 ],
	] )( 'spreads light as f · cos does: NoV %s, roughness %s, eta %s', async ( NoV, roughness, eta ) => {

		const side = 512, count = side * side;
		const V = [ Math.sqrt( 1 - NoV * NoV ), 0, NoV ];
		const random = mulberry32( 11 );
		const params = new Float32Array( count * 4 );
		for ( let i = 0; i < count; i ++ ) params.set( [ ( i % side + random() ) / side, ( Math.floor( i / side ) + random() ) / side, random(), 0 ], i * 4 );

		const out = new Float32Array( await evaluate( renderer, count, { p: [ params, 'vec4' ] }, 'vec4', ( a ) => {

			const s = DielectricSample.wrap( sampleDielectric( vec3( V[ 0 ], V[ 1 ], V[ 2 ] ), vec3( 0, 0, 1 ), float( eta ), float( roughness ), a.p.xy, a.p.z ) ).toVar();
			// Undo the compensation: the BSDF below is the single-scattering one.
			return vec4( s.direction, s.weight.mul( dielectricInterfaceAlbedo( float( NoV ), float( roughness ), float( eta ) ) ) );

		} ) );

		const bin = ( z, phi ) => Math.min( BINS_Z - 1, Math.floor( ( z + 1 ) / 2 * BINS_Z ) ) * BINS_PHI + Math.min( BINS_PHI - 1, Math.floor( phi / Math.PI * BINS_PHI ) );
		const sampled = new Float64Array( BINS_Z * BINS_PHI );
		for ( let i = 0; i < count; i ++ ) {

			const [ x, y, z, w ] = out.subarray( i * 4, i * 4 + 4 );
			if ( w > 0 ) sampled[ bin( z, Math.abs( Math.atan2( y, x ) ) ) ] += w / count;

		}

		// Each bin's integral of f · |cos| by the midpoint rule, 8 × 8 points a bin; the half space φ ∈ [0, π] counts twice.
		const expected = new Float64Array( BINS_Z * BINS_PHI );
		const SUB = 8;
		for ( let bz = 0; bz < BINS_Z; bz ++ ) for ( let bp = 0; bp < BINS_PHI; bp ++ ) {

			let sum = 0;
			for ( let i = 0; i < SUB; i ++ ) for ( let j = 0; j < SUB; j ++ ) {

				const z = - 1 + ( bz + ( i + 0.5 ) / SUB ) * 2 / BINS_Z;
				const phi = ( bp + ( j + 0.5 ) / SUB ) * Math.PI / BINS_PHI;
				const s = Math.sqrt( 1 - z * z );
				sum += walter( V, [ s * Math.cos( phi ), s * Math.sin( phi ), z ], roughness, eta );

			}

			expected[ bz * BINS_PHI + bp ] = 2 * sum * ( 2 / BINS_Z ) * ( Math.PI / BINS_PHI ) / ( SUB * SUB );

		}

		// Bins holding at least 0.5 % of the light, within 10 % of it or 0.1 % of all light; and the totals within 1 %.
		let total = 0, totalExpected = 0;
		for ( let k = 0; k < expected.length; k ++ ) {

			total += sampled[ k ];
			totalExpected += expected[ k ];
			if ( expected[ k ] > 0.005 ) expect( Math.abs( sampled[ k ] - expected[ k ] ), `bin ${k}` ).toBeLessThan( Math.max( 0.1 * expected[ k ], 0.001 ) );

		}

		expect( total / totalExpected ).toBeCloseTo( 1, 2 );

	} );

} );
