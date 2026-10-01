/**
 * Roughness 0 is an exact mirror: the specular lobe reflects about N and its throughput is the
 * lobe's reflectance over its selection chance. The old path clamped to MIN_ROUGHNESS and blurred.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec2, vec3, vec4, int, uint, normalize, dot, reflect, bool as tslBool } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { diffuseGroundMaterial, classifyMaterial } from '@/core/TSL/Common.js';
import { RayTracingMaterial, MaterialClassification, BRDFWeights, MaterialCache, DirectionSample } from '@/core/TSL/Struct.js';
import { calculateBRDFWeightsFromMaterial } from '@/core/TSL/MaterialProperties.js';
import { generateSampledDirection, DELTA_PDF } from '@/core/TSL/PathTracerCore.js';

const COS = [ 1, 0.8, 0.5, 0.2 ];

async function sample( renderer, metalness ) {

	const views = new Float32Array( COS.flatMap( ( c ) => [ Math.sqrt( 1 - c * c ), 0, c, 0 ] ) );
	const out = new Float32Array( await evaluate( renderer, COS.length, { V: [ views, 'vec4' ] }, 'vec4', ( a ) => {

		const V = normalize( a.V.xyz );
		const N = vec3( 0, 0, 1 );
		const material = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
		material.roughness.assign( 0.0 );
		material.metalness.assign( metalness );

		const mc = MaterialClassification.wrap( classifyMaterial(
			material.metalness, material.roughness, material.transmission,
			material.clearcoat, material.emissive, material.subsurface,
		) );
		const weights = BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( material ) ).toVar();
		const cache = MaterialCache( { invRoughness: float( 1 ), metalFactor: float( 0.5 ), iorFactor: float( 1 ), maxSheenColor: float( 0 ) } );

		// Land the lobe draw inside the specular band.
		const s = DirectionSample.wrap( generateSampledDirection(
			V, N, material, vec2( 0.3, 0.7 ), weights.diffuse.add( weights.specular.mul( 0.5 ) ), uint( 1 ).toVar(),
			vec2( 0.5 ), vec2( 1 ), uint( 0 ), int( 0 ),
			mc, tslBool( true ), weights, tslBool( false ), cache,
		) ).toVar();

		const NoL = dot( N, s.direction );
		return vec4( dot( s.direction, reflect( V.negate(), N ) ), s.value.x.mul( NoL ).div( s.pdf ), weights.specular, s.pdf );

	} ) );

	return COS.map( ( _, i ) => ( { mirror: out[ i * 4 ], throughput: out[ i * 4 + 1 ], weight: out[ i * 4 + 2 ], pdf: out[ i * 4 + 3 ] } ) );

}

describeGPU( 'exact mirror lobe', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'reflects a white metal exactly, with throughput 1', async () => {

		for ( const r of await sample( renderer, 1 ) ) {

			expect( r.mirror ).toBeCloseTo( 1, 5 );
			expect( r.pdf ).toBe( DELTA_PDF );
			expect( r.throughput ).toBeCloseTo( 1, 3 );

		}

	} );

	it( 'gives a dielectric its Fresnel reflectance over the selection chance', async () => {

		const [ head ] = await sample( renderer, 0 );
		expect( head.mirror ).toBeCloseTo( 1, 5 );
		// IOR 1.5 head-on: ( 0.5 / 2.5 )² = 0.04.
		expect( head.throughput * head.weight ).toBeCloseTo( 0.04, 3 );

	} );

} );
