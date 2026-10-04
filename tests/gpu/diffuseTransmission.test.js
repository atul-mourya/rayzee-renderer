/**
 * KHR_materials_diffuse_transmission: a share of the diffuse lobe goes through a thin surface. It moves energy from
 * reflection to transmission and creates none; the sampler draws through the surface exactly as often as the lobe's
 * weight; and the sampler, the NEE evaluation and the NEE density agree on every direction it draws.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec2, vec3, vec4, int, uint, normalize, dot, abs, select, bool as tslBool } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { diffuseGroundMaterial, classifyMaterial } from '@/core/TSL/Common.js';
import { RayTracingMaterial, MaterialClassification, BRDFWeights, MaterialCache, DirectionSample } from '@/core/TSL/Struct.js';
import { calculateBRDFWeightsFromMaterial } from '@/core/TSL/MaterialProperties.js';
import { generateSampledDirection } from '@/core/TSL/PathTracerCore.js';
import { evaluateMaterialResponse } from '@/core/TSL/MaterialEvaluation.js';
import { calculateMaterialPDF } from '@/core/TSL/LightsSampling.js';

const COUNT = 1 << 16;

// Stratified (xi.x, xi.y, lobe) per element: a 256 × 256 grid with a scrambled lobe variate.
const variates = ( () => {

	const data = new Float32Array( COUNT * 4 );
	let seed = 12345;
	const rand = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	for ( let i = 0; i < COUNT; i ++ ) {

		data[ i * 4 ] = ( ( i & 255 ) + rand() ) / 256;
		data[ i * 4 + 1 ] = ( ( i >> 8 ) + rand() ) / 256;
		data[ i * 4 + 2 ] = rand();

	}

	return data;

} )();

/**
 * One BSDF sample per element. x: its throughput as the bounce takes it (value·cos/pdf, the cosine below N for a
 * transmission draw and clamped at 0 otherwise), y: 1 if the transmission lobe drew it, z / w: its pdf and value
 * against what NEE evaluates for the same direction, relative, for transmission draws.
 */
async function sample( renderer, { roughness = 0.5, metalness = 0, dt = 0, dtColor = [ 1, 1, 1 ], clearcoat = 0, sheen = 0, channel = 'x' } ) {

	const out = new Float32Array( await evaluate( renderer, COUNT, { xi: [ variates, 'vec4' ] }, 'vec4', ( a ) => {

		const V = normalize( vec3( 0.42, 0.0, 0.9 ) );
		const N = vec3( 0, 0, 1 );
		const material = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
		material.roughness.assign( roughness );
		material.metalness.assign( metalness );
		material.clearcoat.assign( clearcoat );
		material.sheen.assign( sheen );
		material.sheenColor.assign( vec3( 1.0 ) );
		material.diffuseTransmission.assign( dt );
		material.diffuseTransmissionColor.assign( vec3( ...dtColor ) );

		const mc = MaterialClassification.wrap( classifyMaterial(
			material.metalness, material.roughness, material.transmission,
			material.clearcoat, material.emissive, material.subsurface,
		) );
		const weights = BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( material ) ).toVar();
		const cache = MaterialCache( { invRoughness: float( 1 ), metalFactor: float( 0.5 ), iorFactor: float( 1 ), maxSheenColor: float( 0 ) } );

		const s = DirectionSample.wrap( generateSampledDirection(
			V, N, material, a.xi.xy, a.xi.z, uint( 1 ).toVar(),
			vec2( 0.5 ), vec2( 1 ), uint( 0 ), int( 0 ),
			mc, tslBool( true ), weights, tslBool( false ), cache,
		) ).toVar();

		const cos = dot( N, s.direction );
		const below = s.isDiffuseTransmission;
		const throughput = s.value.mul( select( below, cos.negate(), cos.max( 0.0 ) ) ).div( s.pdf ).toVar();
		const neePdf = calculateMaterialPDF( V, s.direction, N, material );
		const neeValue = evaluateMaterialResponse( V, s.direction, N, material );
		// Above the sampler's MIN_PDF floor (0.001), which every lobe's density shares at grazing angles.
		const compared = below.and( s.pdf.greaterThan( 0.002 ) );
		const relPdf = select( compared, abs( s.pdf.sub( neePdf ) ).div( s.pdf ), float( 0 ) );
		const relValue = select( compared, abs( s.value.x.sub( neeValue.x ) ).div( s.value.x.max( 1e-12 ) ), float( 0 ) );
		return vec4( throughput[ channel ], select( below, float( 1 ), float( 0 ) ), relPdf, relValue );

	} ) );

	let throughput = 0, below = 0, maxRelPdf = 0, maxRelValue = 0;
	for ( let i = 0; i < COUNT; i ++ ) {

		throughput += out[ i * 4 ];
		below += out[ i * 4 + 1 ];
		maxRelPdf = Math.max( maxRelPdf, out[ i * 4 + 2 ] );
		maxRelValue = Math.max( maxRelValue, out[ i * 4 + 3 ] );

	}

	return { albedo: throughput / COUNT, below: below / COUNT, maxRelPdf, maxRelValue };

}

async function weightOf( renderer, material ) {

	const out = new Float32Array( await evaluate( renderer, 1, { xi: [ new Float32Array( 4 ), 'vec4' ] }, 'vec4', () => {

		const m = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
		m.roughness.assign( material.roughness ?? 0.5 );
		m.diffuseTransmission.assign( material.dt );
		const w = BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( m ) );
		return vec4( w.diffuseTransmission, w.diffuse, 0, 0 );

	} ) );
	return out[ 0 ];

}

describeGPU( 'diffuse transmission lobe', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'moves the diffuse energy through the surface without creating or losing any', async () => {

		for ( const look of [ { roughness: 1 }, { roughness: 0.5 }, { roughness: 0.3, clearcoat: 1 }, { roughness: 0.6, sheen: 0.5 } ] ) {

			const opaque = await sample( renderer, { ...look, dt: 0 } );
			const translucent = await sample( renderer, { ...look, dt: 0.4 } );
			expect( translucent.albedo, JSON.stringify( look ) ).toBeCloseTo( opaque.albedo, 2 );

		}

	} );

	it( 'draws through the surface as often as the lobe weighs', async () => {

		const weight = await weightOf( renderer, { dt: 0.4 } );
		expect( weight ).toBeGreaterThan( 0.2 );
		const { below } = await sample( renderer, { dt: 0.4 } );
		expect( below ).toBeCloseTo( weight, 2 );

		expect( ( await sample( renderer, { dt: 0 } ) ).below ).toBe( 0 );

	} );

	it( 'reports the density and value NEE evaluates for the same direction', async () => {

		const { maxRelPdf, maxRelValue } = await sample( renderer, { dt: 0.4 } );
		expect( maxRelPdf ).toBeLessThan( 1e-4 );
		expect( maxRelValue ).toBeLessThan( 1e-4 );

	} );

	it( 'tints only the transmitted light with its colour', async () => {

		// A white Lambertian: every draw through the surface carries the transmission colour, every other one white.
		const red = await sample( renderer, { roughness: 1, dt: 1, dtColor: [ 1, 0.5, 0.25 ], channel: 'x' } );
		const green = await sample( renderer, { roughness: 1, dt: 1, dtColor: [ 1, 0.5, 0.25 ], channel: 'y' } );
		const blue = await sample( renderer, { roughness: 1, dt: 1, dtColor: [ 1, 0.5, 0.25 ], channel: 'z' } );
		expect( red.below ).toBeCloseTo( 1, 5 );
		expect( green.albedo / red.albedo ).toBeCloseTo( 0.5, 4 );
		expect( blue.albedo / red.albedo ).toBeCloseTo( 0.25, 4 );

	} );

} );
