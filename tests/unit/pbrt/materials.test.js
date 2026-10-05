import { describe, it, expect } from 'vitest';
import { buildMaterial } from '@/core/Processor/PBRT/PBRTMaterials.js';
import { albedoForReflectance, dipoleReflectance } from '@/core/Processor/PBRT/PBRTScattering.js';

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

	it( 'makes diffusetransmission the engine\'s diffuse transmission lobe: reflecting R, transmitting T', async () => {

		// kroken's rug, with a tinted T; exact while max( R ) + max( T ) ≤ 1.
		const rug = await buildMaterial( { type: 'diffusetransmission', params: { reflectance: param( 'rgb', 0.85, 0.8, 0.85 ), transmittance: param( 'rgb', 0.1, 0.15, 0.1 ) } }, ctx );
		expect( rug.transmission ).toBe( 0 );
		expect( rug.specularIntensity ).toBe( 0 );
		expect( rug.diffuseTransmission ).toBeCloseTo( 0.15, 6 );
		// Reflected (1 − dt) · base = R, transmitted dt · colour = T.
		expect( rug.color.toArray().map( ( c ) => c * ( 1 - rug.diffuseTransmission ) ) ).toEqual( [ 0.85, 0.8, 0.85 ].map( ( v ) => expect.closeTo( v, 6 ) ) );
		expect( rug.diffuseTransmissionColor.toArray().map( ( c ) => c * rug.diffuseTransmission ) ).toEqual( [ 0.1, 0.15, 0.1 ].map( ( v ) => expect.closeTo( v, 6 ) ) );

	} );

	it( 'makes diffuse Lambertian', async () => {

		const mat = await buildMaterial( { type: 'diffuse', params: { reflectance: param( 'rgb', 0.2, 0.4, 0.6 ) } }, ctx );
		expect( mat.specularIntensity ).toBe( 0 );
		expect( mat.color.toArray() ).toEqual( [ 0.2, 0.4, 0.6 ] );

	} );

	it( 'makes subsurface the engine\'s random walk: albedo σs / σt, mean free path 1 / σt, scaled as pbrt scales them', async () => {

		const coefficients = await buildMaterial( { type: 'subsurface', params: {
			sigma_a: param( 'rgb', 1, 2, 3 ), sigma_s: param( 'rgb', 3, 2, 1 ), scale: param( 'float', 0.5 ), g: param( 'float', 0.3 ), eta: param( 'float', 1.4 )
		} }, ctx );
		expect( coefficients.subsurface ).toBe( 1 );
		expect( coefficients.subsurfaceColor.toArray() ).toEqual( [ 0.75, 0.5, 0.25 ] );
		expect( coefficients.subsurfaceRadius ).toEqual( [ 0.5, 0.5, 0.5 ] );
		expect( [ coefficients.subsurfaceAnisotropy, coefficients.ior ] ).toEqual( [ 0.3, 1.4 ] );

		// A named medium is σ′s with g 0, whatever g says.
		const skin = await buildMaterial( { type: 'subsurface', params: { name: param( 'string', 'Skin1' ), g: param( 'float', 0.8 ) } }, ctx );
		expect( skin.subsurfaceAnisotropy ).toBe( 0 );
		expect( skin.subsurfaceRadius[ 0 ] ).toBeCloseTo( 1 / ( 0.74 + 0.032 ), 9 );

		// Nothing given: pbrt's default, whole milk.
		const milk = await buildMaterial( { type: 'subsurface', params: {} }, ctx );
		expect( milk.subsurfaceRadius[ 2 ] ).toBeCloseTo( 1 / ( 3.77 + 0.014 ), 9 );

	} );

	it( 'inverts a subsurface reflectance through the dipole, at the mean free path asked for', async () => {

		const mat = await buildMaterial( { type: 'subsurface', params: {
			reflectance: param( 'rgb', 0.8, 0.5, 0.2 ), mfp: param( 'rgb', 2, 1, 0.5 ), scale: param( 'float', 2 )
		} }, ctx );
		expect( mat.subsurfaceRadius ).toEqual( [ 4, 2, 1 ] );
		const albedo = mat.subsurfaceColor.toArray();
		[ 0.8, 0.5, 0.2 ].forEach( ( r, c ) => expect( dipoleReflectance( albedo[ c ], 1.33 ) ).toBeCloseTo( r, 6 ) );
		expect( mat.color.r ).toBeCloseTo( 0.8, 6 );
		expect( albedoForReflectance( 0, 1.33 ) ).toBeCloseTo( 0, 9 );

	} );

} );
