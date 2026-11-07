import { describe, it, expect } from 'vitest';
import { Texture } from 'three';
import { buildMaterial } from '@/core/addons/archives/pbrt/PBRTMaterials.js';
import { albedoForReflectance, dipoleReflectance } from '@/core/materials/Scattering.js';

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

	it( 'makes a conductor without a roughness a mirror, as pbrt does', async () => {

		expect( ( await buildMaterial( { type: 'conductor', params: {} }, ctx ) ).roughness ).toBe( 0 );
		// pbrt-v4's upgrade renames v3's `metal` and adds no roughness.
		expect( ( await buildMaterial( { type: 'metal', params: {} }, ctx ) ).roughness ).toBe( 0 );

	} );

	it( 'makes a coated conductor a metal under a clear coat, pbrt\'s roughnesses defaulting to 0', async () => {

		const gold = await buildMaterial( { type: 'coatedconductor', params: {
			'conductor.eta': param( 'spectrum', 'metal-Au-eta' ), 'conductor.k': param( 'spectrum', 'metal-Au-k' ),
			'conductor.roughness': param( 'float', 0.01 ), 'interface.roughness': param( 'float', 0.1 )
		} }, ctx );
		expect( gold.metalness ).toBe( 1 );
		expect( gold.clearcoat ).toBe( 1 );
		expect( gold.color.toArray() ).toEqual( [ 1, 0.7657, 0.3360 ] );
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

	it( 'transmits a textured transmittance through its map, taking its brightest texel as 1 where it cannot be read', async () => {

		const leaf = new Texture();
		const withTexture = { ...ctx, resolveNamedTexture: async () => ( { texture: leaf } ) };
		const mat = await buildMaterial( { type: 'diffusetransmission', params: {
			reflectance: param( 'rgb', 0.25, 0.25, 0.25 ), transmittance: param( 'texture', 'leaf' ), scale: param( 'float', 0.5 )
		} }, withTexture );

		expect( mat.diffuseTransmissionColorMap ).toBe( leaf );
		expect( mat.diffuseTransmission ).toBe( 0.5 );
		expect( mat.diffuseTransmissionColor.toArray() ).toEqual( [ 1, 1, 1 ] );
		expect( mat.color.toArray().map( ( c ) => c * ( 1 - mat.diffuseTransmission ) ) ).toEqual( [ 0.125, 0.125, 0.125 ].map( ( v ) => expect.closeTo( v, 6 ) ) );

	} );

	// Named textures and their maps' brightest texels, as the builder resolves them.
	const withMaps = ( maps, extra = {} ) => ( {
		...ctx, ...extra,
		resolveNamedTexture: async ( name ) => ( maps[ name ] ? { texture: maps[ name ].texture } : null ),
		textureMaxRGB: async ( name ) => maps[ name ]?.most ?? null,
	} );
	const transmitter = ( params ) => ( { type: 'diffusetransmission', params } );

	it( 'keeps R and T exact at every texel of a dim map, a scale past 1 included', async () => {

		const m = new Texture();
		const dim = withMaps( { m: { texture: m, most: [ 0.4, 0.4, 0.4 ] } } );
		// One image for both, brightest 0.4: dt 0.4, and each colour × the map's 0.4 gives back R and T there.
		const one = await buildMaterial( transmitter( { reflectance: param( 'texture', 'm' ), transmittance: param( 'texture', 'm' ) } ), dim );
		expect( one.diffuseTransmission ).toBeCloseTo( 0.4, 6 );
		expect( one.color.r * ( 1 - one.diffuseTransmission ) * 0.4 ).toBeCloseTo( 0.4, 6 );
		expect( one.diffuseTransmissionColor.r * one.diffuseTransmission * 0.4 ).toBeCloseTo( 0.4, 6 );
		expect( [ one.map, one.diffuseTransmissionColorMap ] ).toEqual( [ m, m ] );

		// × 2: T is 2 · map, 0.8 at its brightest; pbrt clamps nowhere.
		const twice = await buildMaterial( transmitter( {
			reflectance: param( 'rgb', 0.1, 0.1, 0.1 ), transmittance: param( 'texture', 'm' ), scale: param( 'float', 2 ),
		} ), dim );
		expect( twice.diffuseTransmission ).toBeCloseTo( 0.8, 6 );
		expect( twice.diffuseTransmissionColor.r * twice.diffuseTransmission ).toBeCloseTo( 2, 6 );
		expect( twice.color.r * ( 1 - twice.diffuseTransmission ) ).toBeCloseTo( 0.2, 6 );

	} );

	it( 'reads a transmittance mapped unlike its reflectance as flat at its brightest, reported', async () => {

		const tiled = new Texture();
		tiled.repeat.set( 8, 8 );
		const warnings = [];
		const mat = await buildMaterial( transmitter( { reflectance: param( 'rgb', 0.2, 0.2, 0.2 ), transmittance: param( 'texture', 't' ) } ),
			withMaps( { t: { texture: tiled, most: [ 0.5, 0.5, 0.5 ] } }, { warn: ( w ) => warnings.push( w ) } ) );

		expect( mat.diffuseTransmissionColorMap ).toBeUndefined();
		expect( mat.diffuseTransmission * mat.diffuseTransmissionColor.r ).toBeCloseTo( 0.5, 6 );
		expect( warnings ).toEqual( [ expect.stringMatching( /mapped unlike its reflectance/ ) ] );

	} );

	it( 'mixes a mapped transmitter at its colours\' peaks, never past 1', async () => {

		const m = new Texture();
		const maps = withMaps( { m: { texture: m, most: [ 0.2, 0.2, 0.2 ] } }, {
			namedMaterials: new Map( [
				[ 'leaf', transmitter( { reflectance: param( 'rgb', 0.3, 0.3, 0.3 ), transmittance: param( 'texture', 'm' ) } ) ],
				[ 'paper', transmitter( { reflectance: param( 'rgb', 0.3, 0.3, 0.3 ), transmittance: param( 'rgb', 0.5, 0.5, 0.5 ) } ) ],
			] ),
		} );
		const leaf = await buildMaterial( maps.namedMaterials.get( 'leaf' ), maps );
		// The mapped colour passes 1 (0.2 at its brightest, made up to T): mixed as it stands, it would light past 1.
		expect( leaf.diffuseTransmissionColor.r ).toBeGreaterThan( 1 );

		for ( const amount of [ 0.25, 0.75 ] ) {

			const mix = await buildMaterial( { type: 'mix', params: { materials: param( 'string', 'leaf', 'paper' ), amount: param( 'float', amount ) } }, maps );
			expect( mix.diffuseTransmissionColor.r, `amount ${amount}` ).toBeLessThanOrEqual( 1 );
			expect( mix.color.r, `amount ${amount}` ).toBeLessThanOrEqual( 1 );
			expect( mix.diffuseTransmission * mix.diffuseTransmissionColor.r + ( 1 - mix.diffuseTransmission ) * mix.color.r ).toBeLessThanOrEqual( 1 );

		}

	} );

	it( 'colours a conductor from a measured eta with copper\'s k where it gives none, and survives a textured eta', async () => {

		const fr = ( n, k ) => ( ( n - 1 ) ** 2 + k ** 2 ) / ( ( n + 1 ) ** 2 + k ** 2 );
		const copper = [ fr( 0.2, 3.9 ), fr( 0.92, 2.45 ), fr( 1.1, 2.14 ) ].map( ( v ) => expect.closeTo( v, 6 ) );
		// Was the eta itself as the colour, blue 1.1.
		const measured = await buildMaterial( { type: 'conductor', params: { eta: param( 'rgb', 0.2, 0.92, 1.1 ) } }, ctx );
		expect( measured.color.toArray() ).toEqual( copper );

		// Threw: a texture with no constant resolves to no rgb.
		const textured = { ...ctx, resolveNamedTexture: async () => ( { texture: new Texture() } ) };
		const map = await buildMaterial( { type: 'conductor', params: { eta: param( 'texture', 'e' ), k: param( 'texture', 'k' ) } }, textured );
		expect( map.color.toArray() ).toEqual( copper );
		expect( map.metalness ).toBe( 1 );

		// A named k alone is that metal.
		const silver = await buildMaterial( { type: 'conductor', params: { k: param( 'spectrum', 'metal-Ag-k' ) } }, ctx );
		const gold = await buildMaterial( { type: 'conductor', params: { eta: param( 'spectrum', 'metal-Au-eta' ) } }, ctx );
		expect( silver.color.toArray() ).not.toEqual( gold.color.toArray() );

	} );

	it( 'colours pbrt\'s named metals by their measured eta and k, as Real-Time Rendering\'s table has them', async () => {

		// Hoffman's linear-sRGB F0 table (Real-Time Rendering, 4th ed.), from other measurements than pbrt's.
		const RTR = { Ag: [ 0.972, 0.960, 0.915 ], Al: [ 0.913, 0.922, 0.924 ], Au: [ 1.000, 0.766, 0.336 ], Cu: [ 0.955, 0.638, 0.538 ], CuZn: [ 0.910, 0.778, 0.423 ] };
		const metal = async ( name ) => ( await buildMaterial( { type: 'conductor', params: {
			eta: param( 'spectrum', `metal-${name}-eta` ), k: param( 'spectrum', `metal-${name}-k` )
		} }, ctx ) ).color.toArray();
		for ( const [ name, f0 ] of Object.entries( RTR ) ) ( await metal( name ) ).forEach( ( v, c ) => expect( v ).toBeCloseTo( f0[ c ], 2 ) );

		// TiO2 and MgO are clear in the visible (k ≈ 0): a dielectric's ( (η−1) / (η+1) )², η ≈ 2.9 and 1.74 — never grey metal.
		for ( const [ name, eta ] of [[ 'TiO2', 2.9 ], [ 'MgO', 1.74 ]] ) {

			const f0 = ( ( eta - 1 ) / ( eta + 1 ) ) ** 2;
			( await metal( name ) ).forEach( ( v ) => expect( Math.abs( v / f0 - 1 ) ).toBeLessThan( 0.15 ) );

		}

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

	it( 'reads a spectral IOR as glTF gives glass one: its value at the d line and its spread as dispersion', async () => {

		// crown's gems: "spectrum eta" [ 200 3.5 900 3.3 ] had an IOR of 200.
		const glass = async ( type, ...samples ) => {

			const mat = await buildMaterial( { type, params: { eta: param( 'spectrum', ...samples ) } }, ctx );
			return [ mat.ior, mat.dispersion ];

		};

		const [ gem, gemDispersion ] = await glass( 'dielectric', 200, 3.5, 900, 3.3 );
		expect( gem ).toBeCloseTo( 3.5 - 0.2 * 387.562 / 700, 6 );
		// 20 / Abbe: n_F − n_C over n_d − 1.
		expect( gemDispersion ).toBeCloseTo( 20 * ( 0.2 * ( 656.281 - 486.134 ) / 700 ) / ( gem - 1 ), 6 );
		expect( ( await glass( 'dielectric', 400, 1.53, 500, 1.52, 600, 1.515, 700, 1.512 ) )[ 0 ] ).toBeCloseTo( 1.52 - 0.005 * 0.87562, 6 );
		// Held at its ends: a spectrum flat over the visible lines splits nothing.
		expect( await glass( 'dielectric', 300, 1.7, 400, 1.68 ) ).toEqual( [ 1.68, 0 ] );
		expect( await glass( 'dielectric', 'glass-SF11' ) ).toEqual( [ 1.5, 0 ] );
		// A thin dielectric bends no light, so splits no colours.
		expect( ( await glass( 'thindielectric', 200, 3.5, 900, 3.3 ) )[ 1 ] ).toBe( 0 );
		expect( ( await buildMaterial( { type: 'dielectric', params: { eta: param( 'float', 1.33 ) } }, ctx ) ).dispersion ).toBe( 0 );
		const skin = await buildMaterial( { type: 'subsurface', params: { eta: param( 'spectrum', 500, 1.4, 600, 1.3 ) } }, ctx );
		expect( skin.ior ).toBeCloseTo( 1.4 - 0.1 * 0.87562, 6 );

	} );

	it( 'reads pbrt\'s named glasses as Schott\'s catalogue gives them', async () => {

		// n_d and the Abbe number V_d from Schott's catalogue: pbrt's tables, sampled every ~22 nm, land within 0.5 %.
		const SCHOTT = {
			'glass-BK7': [ 1.5168, 64.17 ], 'glass-BAF10': [ 1.67003, 47.11 ], 'glass-FK51A': [ 1.48656, 84.47 ],
			'glass-LASF9': [ 1.85025, 32.17 ], 'glass-F5': [ 1.6727, 32.21 ], 'glass-F10': [ 1.72825, 28.41 ], 'glass-F11': [ 1.78472, 25.68 ]
		};
		for ( const [ name, [ nd, abbe ]] of Object.entries( SCHOTT ) ) {

			const mat = await buildMaterial( { type: 'dielectric', params: { eta: param( 'spectrum', name ) } }, ctx );
			expect( mat.ior ).toBeCloseTo( nd, 4 );
			expect( Math.abs( 20 / mat.dispersion / abbe - 1 ) ).toBeLessThan( 0.006 );

		}

	} );

} );
