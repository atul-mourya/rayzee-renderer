import { describe, it, expect, vi } from 'vitest';
import { subsurfaceFromDiffuse } from '@/core/materials/Scattering.js';
import { buildMaterial } from '@/core/addons/archives/pbrt/PBRTMaterials.js';
import { MaterialService } from '@/services/MaterialService';
import { MEASURED_MATERIALS } from '@/services/MeasuredMaterials';

vi.mock( '@/lib/appProxy', () => ( { getApp: () => null } ) );

// Entries as https://api.physicallybased.info/materials serves them (2026-11-07).
const CATALOG = {
	Diamond: { name: 'Diamond', color: [ 1, 1, 1 ], metalness: 0, roughness: 0, ior: 2.4168, transmission: 1, transmissionDispersion: 55.3, density: 3500 },
	Coffee: { name: 'Coffee', color: [ 0.447, 0.133, 0.034 ], metalness: 0, roughness: 0, ior: 1.34, transmission: 1, transmissionDepth: 0.1, transmissionDispersion: 55.78, density: 1000 },
	Honey: { name: 'Honey (Liquid)', color: [ 0.831, 0.571, 0.037 ], metalness: 0, roughness: 0, ior: 1.504, transmission: 1, density: 1400 },
	Gold: { name: 'Gold', color: [ 1.059, 0.773, 0.307 ], metalness: 1, roughness: 0, ior: 1.5, density: 19320 },
	Milk: { name: 'Milk', color: [ 0.815, 0.813, 0.682 ], metalness: 0, roughness: 0, ior: 1.348, subsurfaceRadius: [ 1.842, 1.044, 0.35 ], density: 1030 },
};
const read = ( entry, unitsPerMetre = 1 ) => MaterialService.createCompleteMaterialFromAPI( entry, unitsPerMetre );
const closeTo = ( got, want, digits = 4 ) => want.forEach( ( v, c ) => expect( got[ c ] ).toBeCloseTo( v, digits ) );
const ctx = { warn() {}, resolveNamedTexture: async () => null };

describe( 'a Physically Based catalogue entry', () => {

	it( 'splits colours by its Abbe number and keeps a mirror a mirror', () => {

		const diamond = read( CATALOG.Diamond );
		expect( [ diamond.transmission, diamond.ior, diamond.roughness ] ).toEqual( [ 1, 2.4168, 0 ] );
		expect( diamond.dispersion ).toBeCloseTo( 20 / 55.3, 9 );

	} );

	it( 'tints clear matter once: in the volume at its depth, else at the surface; never by its mass density', () => {

		// 0.1 cm in a scene of 1 unit a metre.
		const coffee = read( CATALOG.Coffee );
		expect( coffee.color ).toEqual( [ 1, 1, 1 ] );
		expect( coffee.attenuationColor ).toEqual( CATALOG.Coffee.color );
		expect( coffee.attenuationDistance ).toBeCloseTo( 0.001, 9 );

		const honey = read( CATALOG.Honey );
		expect( honey.color ).toEqual( CATALOG.Honey.color );
		expect( honey.attenuationDistance ).toBe( Infinity );
		expect( read( CATALOG.Gold ).attenuationDistance ).toBe( Infinity );
		expect( honey.transparent ).toBe( 0 );

	} );

	it( 'scatters under the surface by its diffuse mean free path, in the scene\'s units', () => {

		const milk = read( CATALOG.Milk, 100 );
		const { subsurfaceColor, subsurfaceRadius } = subsurfaceFromDiffuse( CATALOG.Milk.color, CATALOG.Milk.subsurfaceRadius, 1.348 );
		expect( milk.subsurface ).toBe( 1 );
		closeTo( milk.subsurfaceColor, subsurfaceColor, 9 );
		// Centimetres in a scene of 100 units a metre.
		closeTo( milk.subsurfaceRadius, subsurfaceRadius, 9 );
		expect( milk.color ).toEqual( CATALOG.Milk.color );

	} );

} );

describe( 'the catalogue\'s additions from pbrt', () => {

	it( 'read back as the pbrt importer reads the same media and glasses', async () => {

		for ( const entry of MEASURED_MATERIALS ) {

			// pbrt's coefficients are per millimetre: a scene of 1000 units a metre keeps its radii.
			const mine = read( entry, 1000 );
			if ( entry.transmission ) {

				const theirs = await buildMaterial( { type: 'dielectric', params: { eta: { type: 'spectrum', value: [ entry.pbrt ] } } }, ctx );
				expect( mine.ior ).toBeCloseTo( theirs.ior, 4 );
				expect( mine.dispersion / theirs.dispersion ).toBeCloseTo( 1, 3 );

			} else {

				const theirs = await buildMaterial( { type: 'subsurface', params: { name: { type: 'string', value: [ entry.pbrt ] } } }, ctx );
				closeTo( mine.color, theirs.color.toArray() );
				closeTo( mine.subsurfaceColor, theirs.subsurfaceColor.toArray() );
				mine.subsurfaceRadius.forEach( ( r, c ) => expect( r / theirs.subsurfaceRadius[ c ] ).toBeCloseTo( 1, 3 ) );

			}

			expect( entry.preview.startsWith( 'data:image/svg+xml' ) ).toBe( true );

		}

		expect( new Set( MEASURED_MATERIALS.map( ( m ) => m.name ) ).size ).toBe( MEASURED_MATERIALS.length );

	} );

} );
