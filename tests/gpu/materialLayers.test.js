/**
 * A material layer no material uses is compiled out of every function that reads it (SceneResources.materialLayers).
 * For a material without those layers that changes nothing, bit for bit: the sampler's direction, value and density,
 * and the BSDF and its density for NEE. A material that does have a layer loses it when compiled out, which is how
 * the gate is known to act at all.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec2, vec3, vec4, int, uint, normalize, bool as tslBool } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { diffuseGroundMaterial, classifyMaterial } from '@/core/TSL/Common.js';
import { RayTracingMaterial, MaterialClassification, BRDFWeights, MaterialCache, DirectionSample } from '@/core/TSL/Struct.js';
import { calculateBRDFWeightsFromMaterial } from '@/core/TSL/MaterialProperties.js';
import { generateSampledDirection } from '@/core/TSL/PathTracerCore.js';
import { evaluateMaterialResponse } from '@/core/TSL/MaterialEvaluation.js';
import { calculateMaterialPDF } from '@/core/TSL/LightsSampling.js';
import { MATERIAL_LAYERS, ALL_MATERIAL_LAYERS } from '@/core/TSL/SceneResources.js';

const COUNT = 1 << 14;
const NONE = Object.fromEntries( MATERIAL_LAYERS.map( ( layer ) => [ layer, false ] ) );

const variates = ( () => {

	const data = new Float32Array( COUNT * 4 );
	let seed = 777;
	const rand = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	for ( let i = 0; i < COUNT * 4; i ++ ) data[ i ] = rand();
	return data;

} )();

// Per element: the sampled direction's value·cos/pdf (xyz) and pdf (w), then the BSDF and NEE density for a fixed light.
async function shade( renderer, look, materialLayers ) {

	return new Float32Array( await evaluate( renderer, COUNT, { xi: [ variates, 'vec4' ] }, 'vec4', ( a ) => {

		const V = normalize( vec3( a.xi.w.sub( 0.5 ), 0.3, 1.0 ) );
		const N = vec3( 0, 0, 1 );
		const L = normalize( vec3( 0.3, a.xi.z.sub( 0.5 ), 0.8 ) );
		const material = RayTracingMaterial.wrap( diffuseGroundMaterial() ).toVar();
		material.roughness.assign( look.roughness ?? 0.4 );
		material.metalness.assign( look.metalness ?? 0.3 );
		material.clearcoat.assign( look.clearcoat ?? 0 );
		material.sheen.assign( look.sheen ?? 0 );
		material.sheenColor.assign( vec3( 1.0 ) );

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

		const bsdf = evaluateMaterialResponse( V, L, N, material );
		const pdf = calculateMaterialPDF( V, L, N, material );
		return vec4( s.value.x.mul( s.direction.z ).div( s.pdf ), s.pdf, bsdf.x, pdf );

	}, { materialLayers } ) );

}

describeGPU( 'material layers compiled only when used', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'leaves a material without those layers bit-identical', async () => {

		for ( const look of [ { roughness: 0.4, metalness: 0.3 }, { roughness: 1, metalness: 0 }, { roughness: 0.08, metalness: 1 } ] ) {

			const all = await shade( renderer, look, ALL_MATERIAL_LAYERS );
			const none = await shade( renderer, look, NONE );
			let differing = 0;
			for ( let i = 0; i < all.length; i ++ ) if ( ! Object.is( all[ i ], none[ i ] ) ) differing ++;
			expect( differing, JSON.stringify( look ) ).toBe( 0 );

		}

	} );

	it( 'drops a layer a material has once it is compiled out', async () => {

		const look = { roughness: 0.6, metalness: 0, clearcoat: 1, sheen: 1 };
		const all = await shade( renderer, look, ALL_MATERIAL_LAYERS );
		const none = await shade( renderer, look, NONE );
		let differing = 0;
		for ( let i = 0; i < all.length; i += 4 ) if ( all[ i + 2 ] !== none[ i + 2 ] ) differing ++;
		expect( differing ).toBeGreaterThan( COUNT / 2 );

	} );

} );
