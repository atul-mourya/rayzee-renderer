import { describe, it, expect } from 'vitest';
import { buildMaterial } from '@/core/Processor/PBRT/PBRTMaterials.js';

const ctx = { resolveNamedTexture: async () => null, warn: () => {} };
const param = ( type, ...value ) => ( { type, value } );

describe( 'pbrt materials', () => {

	it( 'gives the engine the GGX α pbrt-v4 means', async () => {

		// remaproughness (the default): α = √roughness; the engine's α is roughness².
		const remapped = await buildMaterial( { type: 'conductor', params: { roughness: param( 'float', 0.1 ) } }, ctx );
		expect( remapped.roughness ** 2 ).toBeCloseTo( Math.sqrt( 0.1 ), 6 );

		const raw = await buildMaterial( { type: 'conductor', params: { uroughness: param( 'float', 0.1 ), vroughness: param( 'float', 0.3 ), remaproughness: param( 'bool', false ) } }, ctx );
		expect( raw.roughness ** 2 ).toBeCloseTo( 0.2, 6 );

		const coat = await buildMaterial( { type: 'coateddiffuse', params: { roughness: param( 'float', 0.04 ), remaproughness: param( 'bool', 'false' ) } }, ctx );
		expect( coat.clearcoatRoughness ** 2 ).toBeCloseTo( 0.04, 6 );

	} );

	it( 'keeps the engine default when pbrt gives no roughness', async () => {

		expect( ( await buildMaterial( { type: 'conductor', params: {} }, ctx ) ).roughness ).toBe( 0.1 );

	} );

	it( 'makes a coated conductor a metal under a clear coat, pbrt\'s roughnesses defaulting to 0', async () => {

		const gold = await buildMaterial( { type: 'coatedconductor', params: {
			'conductor.eta': param( 'spectrum', 'metal-Au-eta' ), 'conductor.k': param( 'spectrum', 'metal-Au-k' ),
			'conductor.roughness': param( 'float', 0.01 ), 'interface.roughness': param( 'float', 0.1 )
		} }, ctx );
		expect( gold.metalness ).toBe( 1 );
		expect( gold.clearcoat ).toBe( 1 );
		expect( gold.color.toArray() ).toEqual( [ 1.0, 0.78, 0.34 ] );
		expect( gold.roughness ** 4 ).toBeCloseTo( 0.01, 6 );
		expect( gold.clearcoatRoughness ** 4 ).toBeCloseTo( 0.1, 6 );

		const black = await buildMaterial( { type: 'coatedconductor', params: { reflectance: param( 'rgb', 0.04, 0.04, 0.04 ) } }, ctx );
		expect( black.color.toArray() ).toEqual( [ 0.04, 0.04, 0.04 ] );
		expect( [ black.roughness, black.clearcoatRoughness ] ).toEqual( [ 0, 0 ] );

	} );

	it( 'takes a textured roughness as the texture\'s mean', async () => {

		const withMean = { ...ctx, floatTextureMean: async ( name ) => ( name === 'gloss' ? 0.25 : null ) };
		const mat = await buildMaterial( { type: 'coateddiffuse', params: { roughness: param( 'texture', 'gloss' ) } }, withMean );
		expect( mat.clearcoatRoughness ** 4 ).toBeCloseTo( 0.25, 6 );

	} );

	it( 'keeps a diffuse-transmission surface reflecting R while T passes through', async () => {

		const rug = await buildMaterial( { type: 'diffusetransmission', params: { reflectance: param( 'rgb', 0.85, 0.85, 0.85 ), transmittance: param( 'rgb', 0.15, 0.15, 0.15 ) } }, ctx );
		expect( rug.transmission ).toBeCloseTo( 0.15, 6 );
		expect( rug.color.r * ( 1 - rug.transmission ) ).toBeCloseTo( 0.85, 6 );

	} );

	it( 'makes diffuse Lambertian', async () => {

		const mat = await buildMaterial( { type: 'diffuse', params: { reflectance: param( 'rgb', 0.2, 0.4, 0.6 ) } }, ctx );
		expect( mat.specularIntensity ).toBe( 0 );
		expect( mat.color.toArray() ).toEqual( [ 0.2, 0.4, 0.6 ] );

	} );

} );
