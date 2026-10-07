/**
 * glTF and Cycles define a partial metal as a linear blend of the dielectric and metal BSDFs, so its albedo is the
 * same blend of theirs. The diffuse budget once removed the metal's share twice.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec2, vec3, vec4, int, uint, normalize, dot, bool as tslBool } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { diffuseGroundMaterial, classifyMaterial } from '@/core/TSL/Common.js';
import { RayTracingMaterial, MaterialClassification, BRDFWeights, MaterialCache, DirectionSample } from '@/core/TSL/Struct.js';
import { calculateBRDFWeightsFromMaterial } from '@/core/TSL/MaterialProperties.js';
import { generateSampledDirection } from '@/core/TSL/PathTracerCore.js';

const COUNT = 1 << 16;

const variates = ( () => {

	const data = new Float32Array( COUNT * 4 );
	let seed = 777;
	const rand = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	for ( let i = 0; i < COUNT; i ++ ) {

		data[ i * 4 ] = ( ( i & 255 ) + rand() ) / 256;
		data[ i * 4 + 1 ] = ( ( i >> 8 ) + rand() ) / 256;
		data[ i * 4 + 2 ] = rand();

	}

	return data;

} )();

// Directional albedo per channel at one view, from BSDF samples: mean of value·cos/pdf.
async function albedo( renderer, { metalness, roughness, cosView } ) {

	const out = new Float32Array( await evaluate( renderer, COUNT, { xi: [ variates, 'vec4' ] }, 'vec4', ( a ) => {

		const V = normalize( vec3( Math.sqrt( 1 - cosView * cosView ), 0.0, cosView ) );
		const N = vec3( 0, 0, 1 );
		const material = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
		material.color.assign( vec4( 0.8, 0.6, 0.4, 1 ) );
		material.roughness.assign( roughness );
		material.metalness.assign( metalness );

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

		return vec4( s.value.mul( dot( N, s.direction ).max( 0.0 ) ).div( s.pdf ), 0 );

	} ) );

	const sum = [ 0, 0, 0 ];
	for ( let i = 0; i < COUNT; i ++ ) for ( let c = 0; c < 3; c ++ ) sum[ c ] += out[ i * 4 + c ];
	return sum.map( ( s ) => s / COUNT );

}

describeGPU( 'partial metal', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it.each( [[ 0.1, 0.9 ], [ 0.3, 0.6 ], [ 0.5, 0.9 ], [ 0.5, 0.3 ]] )( 'blends the two albedos linearly at roughness %s, cos %s', async ( roughness, cosView ) => {

		const [ dielectric, metal, partial ] = await Promise.all( [ 0, 1, 0.6 ].map(
			( metalness ) => albedo( renderer, { metalness, roughness, cosView } ),
		) );

		for ( let c = 0; c < 3; c ++ ) {

			// 0.97 at roughness 0.5: Kulla-Conty takes the blended F0, not one tint per lobe.
			const blend = 0.4 * dielectric[ c ] + 0.6 * metal[ c ];
			expect( partial[ c ] / blend, `channel ${c}` ).toBeGreaterThan( 0.96 );
			expect( partial[ c ] / blend, `channel ${c}` ).toBeLessThan( 1.01 );

		}

	} );

} );
