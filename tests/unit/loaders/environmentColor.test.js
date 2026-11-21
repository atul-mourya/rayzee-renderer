import { beforeAll, describe, expect, it } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { AssetLoader } from '@/core/loaders/AssetLoader.js';
import { exrFormat } from '@/core/addons/formats.js';
import { encodeEXR, encodeHDR } from '@/core/output/ImageEncoders.js';
import { rec709FromChromaticities } from '@/core/color/WhiteBalance.js';

// three's FileLoader makes one per streamed chunk; Node has none.
beforeAll( () => {

	globalThis.ProgressEvent ??= class extends Event {};

} );

const ACESCG = [ 0.713, 0.293, 0.165, 0.83, 0.128, 0.044, 0.32168, 0.33767 ];
const P3 = [ 0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329 ];
const REC709 = [ 0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329 ];
const width = 8, height = 2;
const PIXELS = Float32Array.from( { length: width * height * 4 }, ( _, i ) => ( i % 4 === 3 ? 1 : ( ( i * 37 ) % 11 ) / 4 ) );
PIXELS.set( [ 1, 1, 1, 1, 0, 1, 0, 1 ] ); // white, then a pure green

const apply = ( m, v ) => [ 0, 1, 2 ].map( ( r ) => m[ r * 3 ] * v[ 0 ] + m[ r * 3 + 1 ] * v[ 1 ] + m[ r * 3 + 2 ] * v[ 2 ] );

async function load( bytes, extension, options ) {

	const loader = new AssetLoader( new Scene(), new PerspectiveCamera(), { target: new Vector3(), saveState() {}, update() {} } ).registerFormat( exrFormat );
	const url = URL.createObjectURL( new Blob( [ bytes ] ) );
	loader._viaCache = async () => ( { url, cached: true, release() {} } );
	try {

		return await loader.loadEnvironmentByExtension( 'https://example.com/sky', extension, options );

	} finally {

		URL.revokeObjectURL( url );

	}

}

const exr = async ( chromaticities ) => {

	const channels = [ 'R', 'G', 'B', 'A' ].map( ( name, offset ) => ( { name, data: PIXELS, stride: 4, offset, type: 'float' } ) );
	return new Uint8Array( await ( await encodeEXR( { width, height, channels, chromaticities } ) ).arrayBuffer() );

};

const hdr = async ( chromaticities ) => new Uint8Array( await ( await encodeHDR( { data: PIXELS, width, height, chromaticities } ) ).arrayBuffer() );

describe( 'an environment in other primaries', () => {

	it( 'reads an EXR\'s chromaticities as linear Rec.709, its white carried to D65', async () => {

		const sky = await load( await exr( ACESCG ), 'exr' );
		const plain = await load( await exr( ACESCG ), 'exr', { convertColor: false } );
		const m = rec709FromChromaticities( ACESCG );
		expect( sky.userData.convertedFrom ).toBe( ACESCG.join( ' ' ) );
		expect( plain.userData.convertedFrom ).toBeUndefined();

		const got = sky.image.data, raw = plain.image.data;
		for ( let i = 0; i < got.length; i += 4 ) {

			const want = apply( m, [ raw[ i ], raw[ i + 1 ], raw[ i + 2 ] ] ).map( ( v ) => Math.max( 0, v ) );
			for ( let c = 0; c < 3; c ++ ) expect( got[ i + c ] ).toBeCloseTo( want[ c ], 5 );
			expect( got[ i + 3 ] ).toBe( raw[ i + 3 ] );

		}

		// White stays white.
		const white = raw.findIndex( ( v, i ) => i % 4 === 0 && v === 1 && raw[ i + 1 ] === 1 && raw[ i + 2 ] === 1 );
		expect( white ).toBeGreaterThanOrEqual( 0 );
		[ 0, 1, 2 ].forEach( ( c ) => expect( got[ white + c ] ).toBeCloseTo( 1, 4 ) );

	} );

	it( 'reads a Radiance file\'s PRIMARIES the same way', async () => {

		const sky = await load( await hdr( P3 ), 'hdr' );
		const plain = await load( await hdr( null ), 'hdr' );
		const m = rec709FromChromaticities( P3 );
		expect( sky.userData.chromaticities ).toEqual( P3 );
		expect( plain.userData.chromaticities ).toBeUndefined();
		for ( let i = 0; i < plain.image.data.length; i += 4 ) {

			const raw = plain.image.data;
			const want = apply( m, [ raw[ i ], raw[ i + 1 ], raw[ i + 2 ] ] ).map( ( v ) => Math.max( 0, v ) );
			for ( let c = 0; c < 3; c ++ ) expect( sky.image.data[ i + c ] ).toBeCloseTo( want[ c ], 5 );

		}

	} );

	it( 'leaves Rec.709 and untagged files as they are', async () => {

		for ( const chromaticities of [ REC709, null ] ) {

			const sky = await load( await exr( chromaticities ), 'exr' );
			const plain = await load( await exr( chromaticities ), 'exr', { convertColor: false } );
			expect( Array.from( sky.image.data ) ).toEqual( Array.from( plain.image.data ) );
			expect( sky.userData.convertedFrom ).toBeUndefined();

		}

		// PolyHaven's skies all say PRIMARIES=0 0 0 0 0 0 0 0: unknown.
		const bytes = await hdr( null ), header = new TextDecoder().decode( bytes.subarray( 0, 11 ) );
		expect( header ).toBe( '#?RADIANCE\n' );
		const zeros = new Uint8Array( [ ...bytes.subarray( 0, 11 ), ...new TextEncoder().encode( 'PRIMARIES=0 0 0 0 0 0 0 0\n' ), ...bytes.subarray( 11 ) ] );
		const sky = await load( zeros, 'hdr' ), plain = await load( bytes, 'hdr' );
		expect( sky.userData.chromaticities ).toEqual( [ 0, 0, 0, 0, 0, 0, 0, 0 ] );
		expect( sky.userData.convertedFrom ).toBeUndefined();
		expect( Array.from( sky.image.data ) ).toEqual( Array.from( plain.image.data ) );

	} );

} );
