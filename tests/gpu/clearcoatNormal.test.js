/**
 * A clear coat with a normal of its own (glTF's clearcoatNormalTexture; three.js's clearcoatNormal): its highlight
 * follows that normal on either side of the surface, both samplers report the density every MIS site evaluates, the
 * BSDF sampler's estimate is the integral NEE sees, a white coated surface creates no light, and a coat without a
 * normal of its own is the base's, as before.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec2, vec3, vec4, int, uint, normalize, dot, reflect, instanceIndex, bool as tslBool } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { diffuseGroundMaterial, classifyMaterial } from '@/core/TSL/Common.js';
import { RayTracingMaterial, MaterialClassification, BRDFWeights, MaterialCache, DirectionSample, Ray, HitInfo } from '@/core/TSL/Struct.js';
import { calculateBRDFWeightsFromMaterial } from '@/core/TSL/MaterialProperties.js';
import { generateSampledDirection } from '@/core/TSL/PathTracerCore.js';
import { sampleClearcoat, ClearcoatResult } from '@/core/TSL/Clearcoat.js';
import { evaluateMaterialResponse } from '@/core/TSL/MaterialEvaluation.js';
import { calculateMaterialPDF } from '@/core/TSL/LightsSampling.js';

const COUNT = 1 << 18;
const TILT = 20 * Math.PI / 180;
const COAT_N = [ Math.sin( TILT ), 0, Math.cos( TILT ) ];

const rng = ( seed ) => () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );

// Stratified (xi.x, xi.y) on a 512 × 512 grid, a lobe variate, and a second stratified pair for the reference.
const variates = ( () => {

	const data = new Float32Array( COUNT * 4 );
	const rand = rng( 2024 );
	for ( let i = 0; i < COUNT; i ++ ) {

		data[ i * 4 ] = ( ( i & 511 ) + rand() ) / 512;
		data[ i * 4 + 1 ] = ( ( i >> 9 ) + rand() ) / 512;
		data[ i * 4 + 2 ] = rand();
		data[ i * 4 + 3 ] = rand();

	}

	return data;

} )();

// tilt: the coat's normal, null for none of its own.
const coated = ( { color = 0, coatRoughness = 0.1, tilt = COAT_N } ) => {

	const m = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
	m.color.assign( vec4( vec3( color ), 1.0 ) );
	m.clearcoat.assign( 1.0 );
	m.clearcoatRoughness.assign( coatRoughness );
	if ( tilt ) m.clearcoatNormal.assign( vec3( ...tilt ) );
	return m;

};

const classified = ( m ) => MaterialClassification.wrap( classifyMaterial( m.metalness, m.roughness, m.transmission, m.clearcoat, m.emissive, m.subsurface ) );

const sampleLobes = ( V, N, m, xi ) => {

	const weights = BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( m ) ).toVar();
	const cache = MaterialCache( { invRoughness: float( 1 ), metalFactor: float( 0.5 ), iorFactor: float( 1 ), maxSheenColor: float( 0 ) } );
	return DirectionSample.wrap( generateSampledDirection(
		V, N, m, xi.xy, xi.z, uint( 1 ).toVar(),
		vec2( 0.5 ), vec2( 1 ), uint( 0 ), int( 0 ),
		classified( m ), tslBool( true ), weights, tslBool( false ), cache,
	) ).toVar();

};

const at = ( theta ) => [ Math.sin( theta ), 0, Math.cos( theta ) ];

describeGPU( 'clear coat normal', () => {

	let renderer;
	beforeAll( async () => {

		renderer = await createRenderer();

	} );
	afterAll( () => renderer?.dispose() );

	it( 'puts the coat\'s highlight about its own normal, on either side of the surface', async () => {

		const V = at( 0.5 );
		const out = new Float32Array( await evaluate( renderer, 1, {}, 'vec4', () => {

			const response = ( N, V, tilt, mirrorAbout ) => {

				const m = coated( { tilt } );
				const L = reflect( V.negate(), mirrorAbout );
				return evaluateMaterialResponse( V, L, N, m ).x.mul( dot( N, L ).max( 0.0 ) );

			};

			const N = vec3( 0, 0, 1 );
			const v = normalize( vec3( ...V ) );
			const c = vec3( ...COAT_N );
			const back = vec3( V[ 0 ], V[ 1 ], - V[ 2 ] );
			return vec4(
				response( N, v, COAT_N, c ).div( response( N, v, COAT_N, N ) ),
				response( N, v, null, N ).div( response( N, v, null, c ) ),
				// Seen from behind, the coat's normal turns with the base's.
				response( N.negate(), back, COAT_N, c.negate() ).div( response( N.negate(), back, COAT_N, N.negate() ) ),
				0,
			);

		} ) );

		expect( out[ 0 ] ).toBeGreaterThan( 20 );
		expect( out[ 1 ] ).toBeGreaterThan( 20 );
		expect( out[ 2 ] ).toBeGreaterThan( 20 );

	} );

	it( 'samples the coat where its density says, in both samplers', async () => {

		const out = new Float32Array( await evaluate( renderer, COUNT, { xi: [ variates, 'vec4' ] }, 'vec4', ( a ) => {

			const V = normalize( vec3( a.xi.w.sub( 0.5 ), 0.2, 1.0 ) );
			const N = vec3( 0, 0, 1 );
			const m = coated( { color: 0.5 } );
			const s = sampleLobes( V, N, m, a.xi );

			const pixel = vec2( float( instanceIndex.mod( 512 ) ), float( instanceIndex.div( 512 ) ) );
			const cc = ClearcoatResult.wrap( sampleClearcoat(
				Ray( { origin: vec3( 0 ), direction: V.negate() } ),
				HitInfo( {
					didHit: true, dst: float( 1 ), hitPoint: vec3( 0 ), normal: N, uv: vec2( 0 ),
					materialIndex: int( 0 ), meshIndex: int( 0 ), triangleIndex: int( 0 ), boxTests: int( 0 ), triTests: int( 0 ),
				} ),
				m, a.xi.xy, uint( instanceIndex ).add( 7 ).toVar(), pixel, vec2( 512 ), uint( 0 ), int( 0 ),
			) ).toVar();

			const stray = ( dir, value, pdf ) => {

				const above = dot( N, dir ).greaterThan( 0.01 );
				const nee = calculateMaterialPDF( V, dir, N, m ).max( 0.001 );
				const f = evaluateMaterialResponse( V, dir, N, m ).x;
				return above.select( pdf.sub( nee ).abs().div( nee ).max( value.x.sub( f ).abs().div( f.max( 1e-12 ) ) ), float( 0 ) );

			};

			// The coat's own draws: half vectors nearer its normal than the base's.
			const H = normalize( V.add( cc.L ) );
			return vec4( stray( s.direction, s.value, s.pdf ), stray( cc.L, cc.brdf, cc.pdf ), cc.pdf, dot( H, vec3( ...COAT_N ) ).sub( dot( H, N ) ) );

		} ) );

		let worst = 0, worstShade = 0, drawn = 0, coatward = 0;
		for ( let i = 0; i < COUNT; i ++ ) {

			worst = Math.max( worst, out[ i * 4 ] );
			worstShade = Math.max( worstShade, out[ i * 4 + 1 ] );
			if ( out[ i * 4 + 2 ] > 0 ) drawn ++;
			if ( out[ i * 4 + 3 ] > 0.1 ) coatward ++;

		}

		expect( drawn ).toBe( COUNT );
		expect( coatward / COUNT ).toBeGreaterThan( 0.05 );
		expect( worst ).toBeLessThan( 1e-4 );
		expect( worstShade ).toBeLessThan( 1e-4 );

	} );

	it( 'estimates, by sampling the BSDF, the integral NEE sees', async () => {

		// Rough enough that uniform directions find the lobe; a black base leaves only the coat.
		const look = { color: 0, coatRoughness: 0.5 };
		for ( const theta of [ 0.3, 1.0 ] ) {

			const V = at( theta );
			const out = new Float32Array( await evaluate( renderer, COUNT, { xi: [ variates, 'vec4' ] }, 'vec4', ( a ) => {

				const v = vec3( ...V );
				const N = vec3( 0, 0, 1 );
				const m = coated( look );
				const s = sampleLobes( v, N, m, a.xi );
				const sampled = s.value.x.mul( dot( N, s.direction ).max( 0.0 ) ).div( s.pdf );

				// Uniform over the upper hemisphere: f·cos / ( 1 / 2π ).
				const z = a.xi.x;
				const r = float( 1 ).sub( z.mul( z ) ).max( 0 ).sqrt();
				const phi = a.xi.y.mul( 2 * Math.PI );
				const L = vec3( r.mul( phi.cos() ), r.mul( phi.sin() ), z );
				const reference = evaluateMaterialResponse( v, L, N, m ).x.mul( z ).mul( 2 * Math.PI );
				return vec4( sampled, reference, 0, 0 );

			} ) );

			let a = 0, b = 0;
			for ( let i = 0; i < COUNT; i ++ ) {

				a += out[ i * 4 ];
				b += out[ i * 4 + 1 ];

			}

			expect( a / b, `θ ${theta}` ).toBeCloseTo( 1, 1 );
			expect( Math.abs( a / b - 1 ), `θ ${theta}` ).toBeLessThan( 0.02 );

		}

	} );

	it( 'returns no more light than a white coated surface receives', async () => {

		for ( const theta of [ 0.2, 0.8, 1.3 ] ) {

			const V = at( theta );
			const out = new Float32Array( await evaluate( renderer, COUNT, { xi: [ variates, 'vec4' ] }, 'vec4', ( a ) => {

				const v = vec3( ...V );
				const N = vec3( 0, 0, 1 );
				const s = sampleLobes( v, N, coated( { color: 1, coatRoughness: 0.2 } ), a.xi );
				return vec4( s.value.x.mul( dot( N, s.direction ).max( 0.0 ) ).div( s.pdf ), 0, 0, 0 );

			} ) );

			let sum = 0;
			for ( let i = 0; i < COUNT; i ++ ) sum += out[ i * 4 ];
			const albedo = sum / COUNT;
			expect( albedo, `θ ${theta}` ).toBeLessThan( 1.003 );
			expect( albedo, `θ ${theta}` ).toBeGreaterThan( 0.95 );

		}

	} );

	it( 'leaves a coat without a normal of its own as it was, and compiles the normal out', async () => {

		const run = ( tilt, resources ) => evaluate( renderer, 4096, { xi: [ variates.subarray( 0, 4096 * 4 ), 'vec4' ] }, 'vec4', ( a ) => {

			const V = normalize( vec3( a.xi.x.sub( 0.5 ), a.xi.y.sub( 0.5 ), 1.0 ) );
			const L = normalize( vec3( a.xi.z.sub( 0.5 ), a.xi.w.sub( 0.5 ), 0.7 ) );
			const N = vec3( 0, 0, 1 );
			const m = coated( { color: 0.6, coatRoughness: 0.15, tilt } );
			const f = evaluateMaterialResponse( V, L, N, m );
			return vec4( f, calculateMaterialPDF( V, L, N, m ) );

		}, resources );

		const none = new Float32Array( await run( null, null ) );
		const compiledOut = new Float32Array( await run( COAT_N, { clearcoatNormals: false } ) );
		const own = new Float32Array( await run( COAT_N, null ) );
		expect( none.every( ( v, i ) => i % 4 === 3 ? v > 0 : v >= 0 ) ).toBe( true );
		expect( own.some( ( v, i ) => Math.abs( v - none[ i ] ) > 1e-3 * Math.abs( none[ i ] ) ) ).toBe( true );
		let worst = 0;
		for ( let i = 0; i < none.length; i ++ ) worst = Math.max( worst, Math.abs( none[ i ] - compiledOut[ i ] ) / Math.max( Math.abs( none[ i ] ), 1e-12 ) );
		expect( worst ).toBeLessThan( 1e-6 );

	} );

} );
