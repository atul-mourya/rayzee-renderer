import { describe, it, expect, vi } from 'vitest';

// The app's constants read the device pixel ratio as they load.
vi.hoisted( () => {

	globalThis.window ??= { devicePixelRatio: 1 };

} );
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, MeshPhysicalMaterial, Color } from 'three';
import { subsurfaceFromDiffuse } from '@/core/materials/Scattering.js';
import { buildMaterial } from '@/core/addons/archives/pbrt/PBRTMaterials.js';
import { MaterialService } from '@/services/MaterialService';
import { MEASURED_MATERIALS, PRESET_MATERIALS } from '@/services/MeasuredMaterials';
import { SSS_PRESETS } from '@/Constants';

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
		// Past the gamut, scaled to 1 with its hue kept, as the pbrt importer has gold.
		const gold = read( CATALOG.Gold ).color;
		expect( Math.max( ...gold ) ).toBe( 1 );
		expect( gold[ 1 ] / gold[ 0 ] ).toBeCloseTo( 0.773 / 1.059, 9 );
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

describe( 'the catalogue\'s translucent looks', () => {

	it( 'scatter as far in as a share of the object they land on, as the Material tab\'s preset did', () => {

		const object = new Mesh( new BoxGeometry( 2, 1, 2 ) );
		expect( MaterialService.diagonalOf( object ) ).toBeCloseTo( 3, 9 );

		for ( const entry of PRESET_MATERIALS ) {

			const preset = SSS_PRESETS.find( ( p ) => p.name === entry.subsurfacePreset );
			const mine = read( entry, 1000 );
			const sized = MaterialService.createCompleteMaterialFromAPI( entry, 1000, 3 );
			closeTo( sized.subsurfaceRadius, preset.radius.map( ( c ) => c * preset.depth * 3 ), 9 );
			expect( sized.subsurfaceRadius[ 0 ] / mine.subsurfaceRadius[ 0 ] ).toBeCloseTo( 3, 9 );
			closeTo( sized.color, new Color( preset.base ).toArray(), 9 );
			closeTo( sized.subsurfaceColor, new Color( preset.scatter ).toArray(), 9 );
			expect( [ sized.subsurface, sized.subsurfaceAnisotropy, sized.roughness, sized.ior ] ).toEqual( [ preset.weight, preset.g, preset.roughness, preset.ior ] );

		}

		expect( PRESET_MATERIALS.map( ( m ) => m.name ) ).toEqual( SSS_PRESETS.map( ( p ) => p.label ) );
		const measured = new Set( [ ...MEASURED_MATERIALS, ...Object.values( CATALOG ) ].map( ( m ) => m.name.toLowerCase() ) );
		expect( PRESET_MATERIALS.some( ( m ) => measured.has( m.name.toLowerCase() ) ) ).toBe( false );

	} );

} );

describe( 'replacing a shared material', () => {

	it( 'puts the new one on every part that shared the old, multi-material parts included, and nowhere else', () => {

		const shared = new MeshStandardMaterial(), other = new MeshStandardMaterial(), fresh = new MeshPhysicalMaterial();
		const geometry = new BoxGeometry();
		const root = new Group();
		const a = new Mesh( geometry, shared ), b = new Mesh( geometry, shared ), c = new Mesh( geometry, other ), d = new Mesh( geometry, [ other, shared ] );
		root.add( a, c );
		a.add( b, d );

		expect( MaterialService.replaceMaterial( root, shared, fresh ) ).toBe( 3 );
		expect( [ a.material, b.material, c.material ] ).toEqual( [ fresh, fresh, other ] );
		expect( d.material ).toEqual( [ other, fresh ] );
		// In first-use order the new material sits where the old one did, so no later index moves.
		const order = [];
		root.traverse( ( o ) => [ o.material ].flat().forEach( ( m ) => m && ! order.includes( m ) && order.push( m ) ) );
		expect( order ).toEqual( [ fresh, other ] );

	} );

} );
