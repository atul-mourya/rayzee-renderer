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

	it( 'makes diffuse Lambertian', async () => {

		const mat = await buildMaterial( { type: 'diffuse', params: { reflectance: param( 'rgb', 0.2, 0.4, 0.6 ) } }, ctx );
		expect( mat.specularIntensity ).toBe( 0 );
		expect( mat.color.toArray() ).toEqual( [ 0.2, 0.4, 0.6 ] );

	} );

} );
