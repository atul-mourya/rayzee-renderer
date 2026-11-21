import { describe, it, expect } from 'vitest';
import { DataTexture, DataUtils, FloatType, HalfFloatType } from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { exrColorSpace, rec709From } from '@/core/addons/archives/pbrt/PBRTMaterials.js';
import { ArchiveImporter } from '@/core/addons/archives/ArchiveImporter.js';
import { encodeEXR } from '@/core/output/ImageEncoders.js';

const ACES = [ 0.7347, 0.2653, 0, 1, 0.0001, - 0.077, 0.32168, 0.33767 ];
const P3 = [ 0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329 ];
const REC2020 = [ 0.708, 0.292, 0.17, 0.797, 0.131, 0.046, 0.3127, 0.329 ];
const SRGB = [ 0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329 ];
const PIXELS = [ 0.5, 0.25, 0.125, 1, 0.1, 0.8, 0.3, 1, 2, 1.5, 1, 1, 0.02, 0.03, 0.9, 1 ]; // 2 × 2 RGBA

async function exr( chromaticities, text = { owner: 'night', comments: 'string attributes beside it' }, pixels = PIXELS ) {

	const channel = ( name, offset ) => ( { name, data: pixels, stride: 4, offset, type: 'half' } );
	const blob = await encodeEXR( { width: 2, height: 2, channels: [ channel( 'R', 0 ), channel( 'G', 1 ), channel( 'B', 2 ), channel( 'A', 3 ) ], chromaticities, text } );
	return new Uint8Array( await blob.arrayBuffer() );

}

const xyz = ( x, y ) => [ x / y, 1, ( 1 - x - y ) / y ];
const apply = ( m, v ) => [ 0, 1, 2 ].map( ( r ) => m[ r * 3 ] * v[ 0 ] + m[ r * 3 + 1 ] * v[ 1 ] + m[ r * 3 + 2 ] * v[ 2 ] );

describe( 'pbrt EXR colour spaces', () => {

	it( 'names the colour space an EXR\'s chromaticities record, as pbrt matches them', async () => {

		expect( exrColorSpace( await exr( ACES ) ) ).toBe( 'ACES2065-1' );
		expect( exrColorSpace( await exr( P3 ) ) ).toBe( 'DCI-P3' );
		expect( exrColorSpace( await exr( REC2020 ) ) ).toBe( 'Rec2020' );
		expect( exrColorSpace( await exr( SRGB ) ) ).toBe( 'sRGB' );
		// Within 0.1 % of each value, as pbrt's Lookup.
		expect( exrColorSpace( await exr( ACES.map( ( v ) => v * 1.0005 ) ) ) ).toBe( 'ACES2065-1' );
		expect( exrColorSpace( await exr( ACES.map( ( v, i ) => ( i === 6 ? v * 1.01 : v ) ) ) ) ).toBe( null );
		expect( exrColorSpace( await exr( null ) ) ).toBe( 'sRGB' );
		expect( exrColorSpace( new Uint8Array( [ 0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0 ] ) ) ).toBe( 'sRGB' );
		// A malformed size (negative, back to its own name) ends the read rather than reading it again forever.
		const bad = new Uint8Array( [ 0x76, 0x2f, 0x31, 0x01, 2, 0, 0, 0, 0x61, 0, 0x69, 0x6e, 0x74, 0, 0xf6, 0xff, 0xff, 0xff ] );
		expect( exrColorSpace( bad ) ).toBe( 'sRGB' );

	} );

	it( 'converts to linear Rec.709 through XYZ without adapting the white', () => {

		// BT.2087's Rec.2020 → Rec.709 (both D65).
		const m = rec709From( 'Rec2020' );
		[ 1.6605, - 0.5876, - 0.0728, - 0.1246, 1.1329, - 0.0083, - 0.0182, - 0.1006, 1.1187 ].forEach( ( v, i ) => expect( m[ i ] ).toBeCloseTo( v, 3 ) );
		rec709From( 'sRGB' ).forEach( ( v, i ) => expect( v ).toBeCloseTo( i % 4 === 0 ? 1 : 0, 3 ) );
		// ACES's white stays its own D60, warmer than Rec.709's: pbrt's film with no white balance.
		const white = apply( rec709From( 'ACES2065-1' ), [ 1, 1, 1 ] );
		const d60 = apply( [ 3.2404542, - 1.5371385, - 0.4985314, - 0.9692660, 1.8760108, 0.0415560, 0.0556434, - 0.2040259, 1.0572252 ], xyz( 0.32168, 0.33767 ) );
		white.forEach( ( v, c ) => expect( v ).toBeCloseTo( d60[ c ], 4 ) );
		expect( white[ 0 ] ).toBeGreaterThan( white[ 2 ] );

	} );

	it( 'reads a pbrt sky in its EXR\'s colour space as pbrt does, and leaves any other sky to the loader', async () => {

		const bytes = await exr( ACES );
		const parsed = new EXRLoader().setDataType( HalfFloatType ).parse( bytes.buffer.slice( 0 ) );
		const converts = [];
		const importer = new ArchiveImporter( {
			loadEnvironmentByExtension: async ( url, extension, { convertColor } ) => {

				converts.push( convertColor );

				const decoded = new EXRLoader().setDataType( HalfFloatType ).parse( bytes.buffer.slice( 0 ) );
				return new DataTexture( decoded.data, decoded.width, decoded.height, decoded.format, decoded.type );

			},
		} );
		importer._exrLoader = async () => null;

		const sky = await importer._archiveEnvironment( bytes, 'sky.exr', { pbrt: true } );
		const other = await importer._archiveEnvironment( bytes, 'sky.exr' );
		const m = rec709From( 'ACES2065-1' );
		const half = ( data, i ) => DataUtils.fromHalfFloat( data[ i ] );
		for ( let p = 0; p < 4; p ++ ) {

			const rgb = [ 0, 1, 2 ].map( ( c ) => half( parsed.data, p * 4 + c ) );
			const want = apply( m, rgb ).map( ( v ) => Math.max( 0, v ) );
			for ( let c = 0; c < 3; c ++ ) {

				expect( half( sky.image.data, p * 4 + c ) ).toBeCloseTo( want[ c ], 2 );
				expect( half( other.image.data, p * 4 + c ) ).toBe( rgb[ c ] );

			}

			expect( half( sky.image.data, p * 4 + 3 ) ).toBe( 1 );

		}

		// A converted sky is not the same environment as the file read plainly: its sampling table is its own.
		expect( JSON.stringify( sky.userData ) ).not.toBe( JSON.stringify( other.userData ) );
		expect( converts ).toEqual( [ false, true ] );

	} );

	const importerFor = ( bytes, type ) => {

		const importer = new ArchiveImporter( {
			loadEnvironmentByExtension: async () => {

				const decoded = new EXRLoader().setDataType( type ).parse( bytes.buffer.slice( 0 ) );
				return new DataTexture( decoded.data, decoded.width, decoded.height, decoded.format, decoded.type );

			},
		} );
		importer._exrLoader = async () => null;
		return importer;

	};

	it( 'converts float skies (the loaders\' type), the file\'s negatives clamped first as pbrt clamps them', async () => {

		const pixels = [ 0.5, 0.5, - 0.2, 1, 0.1, 0.8, 0.3, 1, 2, 1.5, 1, 1, 0.02, 0.03, 0.9, 1 ];
		const bytes = await exr( ACES, undefined, pixels );
		const sky = await importerFor( bytes, FloatType )._archiveEnvironment( bytes, 'sky.exr', { pbrt: true } );
		const m = rec709From( 'ACES2065-1' );
		const decoded = new EXRLoader().setDataType( FloatType ).parse( bytes.buffer.slice( 0 ) ).data;
		for ( let p = 0; p < 4; p ++ ) {

			const rgb = [ 0, 1, 2 ].map( ( c ) => Math.max( 0, decoded[ p * 4 + c ] ) );
			apply( m, rgb ).forEach( ( v, c ) => expect( sky.image.data[ p * 4 + c ] ).toBeCloseTo( Math.max( 0, v ), 5 ) );

		}

	} );

	it( 'leaves a sky in a colour space pbrt does not know as it is, read as sRGB', async () => {

		const odd = [ 0.7, 0.3, 0.25, 0.7, 0.15, 0.05, 0.314, 0.351 ];
		const bytes = await exr( odd );
		const importer = importerFor( bytes, FloatType );
		const sky = await importer._archiveEnvironment( bytes, 'sky.exr', { pbrt: true } );
		const plain = await importer._archiveEnvironment( bytes, 'sky.exr' );
		expect( Array.from( sky.image.data ) ).toEqual( Array.from( plain.image.data ) );
		expect( JSON.stringify( sky.userData ) ).toBe( JSON.stringify( plain.userData ) );

	} );

} );
