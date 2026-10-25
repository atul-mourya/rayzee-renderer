import { describe, it, expect, vi } from 'vitest';
import { PNG } from 'pngjs';
import { EXRLoader } from 'three/examples/jsm/loaders/EXRLoader.js';
import { HDRLoader } from 'three/examples/jsm/loaders/HDRLoader.js';
import { FloatType } from 'three';
import {
	encodePNG, encodeEXR, encodeHDR, crc32, displayP3Profile, primariesToXYZ, canEncodeWithCanvas, encodeWithCanvas, standardChromaticities,
	isoMetadata, jpegWithGainMap, heifFile, canEncodeStill, prepareStill,
} from '@/core/output/ImageEncoders.js';

const bytesOf = async blob => new Uint8Array( await blob.arrayBuffer() );

// Nearest half, ties to even, as OpenEXR rounds (three's DataUtils truncates).
function nearestHalf( v ) {

	const a = Math.abs( v );
	if ( a === 0 ) return v;
	const ulp = 2 ** ( Math.max( Math.floor( Math.log2( a ) ), - 14 ) - 10 );
	const q = a / ulp, f = Math.floor( q );
	const n = q - f > 0.5 || ( q - f === 0.5 && f % 2 === 1 ) ? f + 1 : f;
	return Math.sign( v ) * Math.min( n * ulp, 65504 );

}

function chunks( png ) {

	const view = new DataView( png.buffer, png.byteOffset );
	const out = [];
	for ( let at = 8; at < png.length; ) {

		const length = view.getUint32( at );
		const type = String.fromCharCode( ...png.subarray( at + 4, at + 8 ) );
		out.push( { type, body: png.subarray( at + 8, at + 8 + length ), crc: view.getUint32( at + 8 + length ) >>> 0, all: png.subarray( at + 4, at + 8 + length ) } );
		at += 12 + length;

	}

	return out;

}

// A ramp with every byte value in each channel, plus some noise so Paeth sees all its branches.
function picture( width, height, max ) {

	const data = new ( max > 255 ? Uint16Array : Uint8ClampedArray )( width * height * 4 );
	let seed = 7;
	for ( let i = 0; i < data.length; i ++ ) {

		seed = ( seed * 1103515245 + 12345 ) >>> 0;
		data[ i ] = ( i * 37 + ( seed >>> 24 ) ) % ( max + 1 );

	}

	return data;

}

describe( 'encodePNG', () => {

	it( 'writes 8-bit RGBA a strict decoder reads back exactly, with valid CRCs', async () => {

		const width = 37, height = 23;
		const data = picture( width, height, 255 );
		const png = await bytesOf( await encodePNG( { data, width, height } ) );
		const decoded = PNG.sync.read( Buffer.from( png ), { checkCRC: true } );

		expect( decoded.width ).toBe( width );
		expect( Array.from( decoded.data ) ).toEqual( Array.from( data ) );
		for ( const chunk of chunks( png ) ) expect( crc32( chunk.all ) ).toBe( chunk.crc );

	} );

	it( 'writes RGB without alpha', async () => {

		const width = 9, height = 4;
		const data = picture( width, height, 255 );
		const png = await bytesOf( await encodePNG( { data, width, height, alpha: false } ) );
		const decoded = PNG.sync.read( Buffer.from( png ) );

		expect( chunks( png )[ 0 ].body[ 9 ] ).toBe( 2 );
		for ( let i = 0; i < width * height; i ++ ) {

			expect( Array.from( decoded.data.subarray( i * 4, i * 4 + 4 ) ) ).toEqual( [ data[ i * 4 ], data[ i * 4 + 1 ], data[ i * 4 + 2 ], 255 ] );

		}

	} );

	it( 'writes 16 bits a channel, big-endian', async () => {

		const width = 13, height = 7;
		const data = picture( width, height, 65535 );
		const png = await bytesOf( await encodePNG( { data, width, height } ) );
		const decoded = PNG.sync.read( Buffer.from( png ), { skipRescale: true } );

		expect( chunks( png )[ 0 ].body[ 8 ] ).toBe( 16 );
		expect( Array.from( decoded.data ) ).toEqual( Array.from( data ) );

	} );

	it( 'tags sRGB, or Display P3 with cICP and an ICC profile, and keeps text', async () => {

		const width = 2, height = 2;
		const data = picture( width, height, 255 );
		const srgb = chunks( await bytesOf( await encodePNG( { data, width, height, text: { Software: 'Rayzee', Comment: 'é ü ✓' } } ) ) );
		expect( srgb.map( c => c.type ) ).toEqual( [ 'IHDR', 'sRGB', 'iTXt', 'iTXt', 'IDAT', 'IEND' ] );
		const comment = srgb.find( c => c.type === 'iTXt' && new TextDecoder().decode( c.body ).startsWith( 'Comment' ) );
		expect( new TextDecoder().decode( comment.body.subarray( 'Comment'.length + 5 ) ) ).toBe( 'é ü ✓' );

		const p3 = chunks( await bytesOf( await encodePNG( { data, width, height, colorSpace: 'display-p3' } ) ) );
		expect( p3.map( c => c.type ) ).toEqual( [ 'IHDR', 'cICP', 'iCCP', 'IDAT', 'IEND' ] );
		expect( Array.from( p3[ 1 ].body ) ).toEqual( [ 12, 13, 0, 1 ] );

	} );

} );

describe( 'displayP3Profile', () => {

	const profile = displayP3Profile();
	const view = new DataView( profile.buffer );
	const tag = sig => {

		for ( let i = 0; i < view.getUint32( 128 ); i ++ ) {

			const at = 132 + i * 12;
			if ( String.fromCharCode( ...profile.subarray( at, at + 4 ) ) === sig ) return view.getUint32( at + 4 );

		}

		return - 1;

	};

	const xyz = sig => [ 0, 1, 2 ].map( i => view.getInt32( tag( sig ) + 8 + i * 4 ) / 65536 );

	it( 'is a well-formed v4 display profile', () => {

		expect( view.getUint32( 0 ) ).toBe( profile.length );
		expect( String.fromCharCode( ...profile.subarray( 36, 40 ) ) ).toBe( 'acsp' );
		expect( String.fromCharCode( ...profile.subarray( 12, 24 ) ) ).toBe( 'mntrRGB XYZ ' );
		for ( const sig of [ 'desc', 'cprt', 'wtpt', 'rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC', 'chad' ] ) expect( tag( sig ) % 4, sig ).toBe( 0 );

	} );

	it( 'holds the D50-adapted P3 colorants Apple\'s Display P3 profile has', () => {

		[[ 'rXYZ', [ 0.5151, 0.2412, - 0.0011 ]], [ 'gXYZ', [ 0.2920, 0.6922, 0.0419 ]], [ 'bXYZ', [ 0.1571, 0.0666, 0.7841 ]]]
			.forEach( ( [ sig, expected ] ) => xyz( sig ).forEach( ( v, i ) => expect( v ).toBeCloseTo( expected[ i ], 3 ) ) );

	} );

	it( 'derives Rec.709 primaries\' matrix', () => {

		const m = primariesToXYZ( [ 0.64, 0.33, 0.30, 0.60, 0.15, 0.06 ], [ 0.3127, 0.3290 ] );
		[ 0.4124, 0.3576, 0.1805, 0.2126, 0.7152, 0.0722, 0.0193, 0.1192, 0.9505 ].forEach( ( v, i ) => expect( m[ i ] ).toBeCloseTo( v, 3 ) );

	} );

} );

describe( 'standardChromaticities', () => {

	it( 'gives ACES its own primaries and white back from D65-adapted measurements, as Blender\'s config reports them', () => {

		expect( standardChromaticities( [ 0.7349, 0.2642, - 0.0062, 1.0113, 0.016, - 0.0642, 0.3127, 0.329 ] ) )
			.toEqual( [ 0.7347, 0.2653, 0.0, 1.0, 0.0001, - 0.077, 0.32168, 0.33767 ] );

	} );

	it( 'keeps a gamut it does not know as measured', () => {

		const odd = [ 0.5, 0.3, 0.3, 0.5, 0.2, 0.1, 0.3127, 0.329 ];
		expect( standardChromaticities( odd ) ).toBe( odd );

	} );

} );

describe( 'encodeEXR', () => {

	const width = 21, height = 35; // three ZIP blocks, the last one short
	const rgba = Float32Array.from( { length: width * height * 4 }, ( _, i ) => ( ( i * 7919 ) % 1000 ) / 37 - 3 );
	const loader = new EXRLoader().setDataType( FloatType );

	function header( exr ) {

		const view = new DataView( exr.buffer, exr.byteOffset );
		const attributes = {};
		let at = 8;
		const str = () => {

			let end = at;
			while ( exr[ end ] ) end ++;
			const s = new TextDecoder().decode( exr.subarray( at, end ) );
			at = end + 1;
			return s;

		};

		for ( ;; ) {

			const name = str();
			if ( ! name ) break;
			const type = str();
			const size = view.getUint32( at, true );
			attributes[ name ] = { type, value: exr.subarray( at + 4, at + 4 + size ) };
			at += 4 + size;

		}

		return attributes;

	}

	function channelNames( chlist ) {

		const names = [];
		for ( let at = 0; chlist[ at ]; ) {

			let end = at;
			while ( chlist[ end ] ) end ++;
			names.push( [ new TextDecoder().decode( chlist.subarray( at, end ) ), new DataView( chlist.buffer, chlist.byteOffset + end + 1 ).getInt32( 0, true ) ] );
			at = end + 17;

		}

		return names;

	}

	for ( const [ type, compression ] of [[ 'half', 'zip' ], [ 'float', 'zip' ], [ 'half', 'none' ], [ 'float', 'none' ]] ) {

		it( `round-trips ${type} RGBA, ${compression} compression, top line first`, async () => {

			const channels = [ 'R', 'G', 'B', 'A' ].map( ( name, offset ) => ( { name, data: rgba, stride: 4, offset, type } ) );
			const exr = await bytesOf( await encodeEXR( { width, height, channels, compression } ) );
			const out = loader.parse( exr.buffer );

			expect( [ out.width, out.height ] ).toEqual( [ width, height ] );
			for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width * 4; x ++ ) {

				const want = rgba[ y * width * 4 + x ];
				const got = out.data[ ( height - 1 - y ) * width * 4 + x ];
				expect( got ).toBeCloseTo( type === 'half' ? nearestHalf( want ) : want, 6 );

			}

		} );

	}

	it( 'keeps layers, per-channel precision, chromaticities and text', async () => {

		const depth = Float32Array.from( { length: width * height }, ( _, i ) => 1e10 - i * 1e-3 );
		const channels = [
			...[ 'R', 'G', 'B', 'A' ].map( ( name, offset ) => ( { name, data: rgba, stride: 4, offset } ) ),
			...[ 'R', 'G', 'B' ].map( ( c, offset ) => ( { name: `albedo.${c}`, data: rgba, stride: 4, offset } ) ),
			{ name: 'depth.Z', data: depth, type: 'float' },
		];
		const chromaticities = [ 0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329 ];
		const exr = await bytesOf( await encodeEXR( { width, height, channels, chromaticities, text: { software: 'Rayzee' } } ) );
		const attributes = header( exr );

		expect( channelNames( attributes.channels.value ) ).toEqual( [
			[ 'A', 1 ], [ 'B', 1 ], [ 'G', 1 ], [ 'R', 1 ], [ 'albedo.B', 1 ], [ 'albedo.G', 1 ], [ 'albedo.R', 1 ], [ 'depth.Z', 2 ],
		] );
		expect( new TextDecoder().decode( attributes.software.value ) ).toBe( 'Rayzee' );
		const c = new DataView( attributes.chromaticities.value.buffer, attributes.chromaticities.value.byteOffset );
		chromaticities.forEach( ( v, i ) => expect( c.getFloat32( i * 4, true ) ).toBeCloseTo( v, 6 ) );

		// A reader that knows only R, G, B and A still gets the picture.
		const out = loader.parse( exr.buffer );
		expect( out.data[ ( height - 1 ) * width * 4 ] ).toBeCloseTo( nearestHalf( rgba[ 0 ] ), 6 );

	} );

	it( 'clamps half channels to the largest half and zeroes NaN', async () => {

		const data = new Float32Array( [ 1e6, - 1e6, NaN, 1 ] );
		const channels = [ 'R', 'G', 'B', 'A' ].map( ( name, offset ) => ( { name, data, stride: 4, offset } ) );
		const out = loader.parse( ( await bytesOf( await encodeEXR( { width: 1, height: 1, channels } ) ) ).buffer );
		expect( Array.from( out.data ) ).toEqual( [ 65504, - 65504, 0, 1 ] );

	} );

} );

describe( 'encodeHDR', () => {

	it( 'round-trips through three\'s Radiance reader within RGBE precision, top line first', async () => {

		const width = 40, height = 6;
		const data = new Float32Array( width * height * 4 );
		for ( let i = 0; i < width * height; i ++ ) {

			// Runs and literals both, and a range of exponents.
			const v = i % 9 < 4 ? 0.5 : ( i % 13 ) * 3.7 + 0.01;
			data.set( [ v, v * 0.5, v * 0.25, 1 ], i * 4 );

		}

		data.set( [ 0, 0, 0, 1 ], 0 );
		data.set( [ - 1, 1e4, 2, 1 ], 4 );

		const hdr = await bytesOf( await encodeHDR( { data, width, height, text: { Software: 'Rayzee' } } ) );
		expect( new TextDecoder().decode( hdr.subarray( 0, 40 ) ) ).toContain( '#?RADIANCE\n# Software: Rayzee' );
		const out = new HDRLoader().setDataType( FloatType ).parse( hdr.buffer );

		expect( [ out.width, out.height ] ).toEqual( [ width, height ] );
		for ( let i = 0; i < width * height; i ++ ) for ( let c = 0; c < 3; c ++ ) {

			const want = Math.max( 0, data[ i * 4 + c ] );
			const max = Math.max( ...[ 0, 1, 2 ].map( k => Math.max( 0, data[ i * 4 + k ] ) ) );
			expect( Math.abs( out.data[ i * 4 + c ] - want ) ).toBeLessThanOrEqual( max / 128 + 1e-6 );

		}

	} );

} );

describe( 'encodeWithCanvas', () => {

	it( 'explains itself where there is no OffscreenCanvas', async () => {

		expect( canEncodeWithCanvas() ).toBe( false );
		await expect( encodeWithCanvas( { data: new Uint8ClampedArray( 4 ), width: 1, height: 1, format: 'jpeg' } ) ).rejects.toThrow( /png, exr or hdr/ );

	} );

} );

describe( 'gain maps', () => {

	const gain = { min: - 0.25, max: 3.5, headroom: 3.5 };

	it( 'writes ISO 21496-1 metadata as libultrahdr and libavif do: one channel, base colour space', () => {

		const view = new DataView( isoMetadata( gain ).buffer );
		expect( view.byteLength ).toBe( 61 );
		expect( [ view.getUint16( 0 ), view.getUint16( 2 ), view.getUint8( 4 ) ] ).toEqual( [ 0, 0, 0x40 ] );
		const r = at => view.getInt32( at ) / view.getUint32( at + 4 );
		expect( [ r( 5 ), r( 13 ) ] ).toEqual( [ 0, 3.5 ] );
		expect( [ r( 21 ), r( 29 ), r( 37 ), r( 45 ), r( 53 ) ] ).toEqual( [ - 0.25, 3.5, 1, 1 / 64, 1 / 64 ] );

	} );

	// The smallest shape the assembly reads: SOI, APP0, DQT, SOS and its scan.
	const fakeJPEG = scan => new Uint8Array( [ 0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 1, 2, 0xFF, 0xDB, 0, 3, 9, 0xFF, 0xDA, 0, 2, ...scan, 0xFF, 0xD9 ] );

	it( 'lays out an Ultra HDR JPEG whose index finds its gain map', async () => {

		const file = new Uint8Array( await jpegWithGainMap( fakeJPEG( [ 1, 2, 3 ] ), fakeJPEG( [ 7, 8 ] ), gain ).arrayBuffer() );
		const text = new TextDecoder( 'latin1' ).decode( file );
		const second = text.lastIndexOf( '\xFF\xD8' );

		// The primary's XMP names the gain map's length, which runs to the end of the file.
		expect( Number( /Item:Length="(\d+)"/.exec( text )[ 1 ] ) ).toBe( file.length - second );
		expect( text.indexOf( 'hdrgm:GainMapMax="3.5"' ) ).toBeGreaterThan( second );

		// The MPF index (big-endian, offsets from its TIFF header) points at the second picture.
		const mpf = text.indexOf( 'MPF\0' );
		const view = new DataView( file.buffer, mpf + 4 );
		expect( view.getUint32( 54 ) ).toBe( second );
		expect( view.getUint32( 70 ) ).toBe( file.length - second );
		expect( mpf + 4 + view.getUint32( 74 ) ).toBe( second );
		expect( text.indexOf( 'MPF' ) ).toBeLessThan( text.indexOf( '\xFF\xDA' ) );

	} );

	function boxes( bytes, at = 0, end = bytes.length ) {

		const view = new DataView( bytes.buffer, bytes.byteOffset );
		const out = {};
		while ( at + 8 <= end ) {

			const size = view.getUint32( at );
			out[ String.fromCharCode( ...bytes.subarray( at + 4, at + 8 ) ) ] = { at, size, body: bytes.subarray( at + 8, at + size ) };
			at += size;

		}

		return out;

	}

	it( 'lays out a HEIF tone-map item over the picture and its gain map', async () => {

		const base = { width: 4, height: 2, data: new Uint8Array( [ 1, 1, 1 ] ), record: new Uint8Array( [ 9 ] ), matrix: 1, fullRange: false };
		const map = { ...base, data: new Uint8Array( [ 2, 2 ] ) };
		const toneMap = new Uint8Array( [ 0, ...isoMetadata( gain ) ] );
		const file = new Uint8Array( await heifFile( 'avif', { base, primaries: 12, gainMap: map, toneMap } ).arrayBuffer() );
		const top = boxes( file );
		const brands = String.fromCharCode( ...top.ftyp.body );
		expect( brands.startsWith( 'avif' ) && brands.includes( 'tmap' ) ).toBe( true );

		const meta = boxes( top.meta.body, 4 );
		const iloc = new DataView( meta.iloc.body.buffer, meta.iloc.body.byteOffset + 4 );
		expect( iloc.getUint16( 2 ) ).toBe( 3 );
		const located = [ 0, 1, 2 ].map( i => {

			const at = 4 + i * 14;
			const offset = iloc.getUint32( at + 6 ), length = iloc.getUint32( at + 10 );
			return [ iloc.getUint16( at ), Array.from( file.subarray( offset, offset + length ) ) ];

		} );
		expect( located ).toEqual( [[ 1, [ 1, 1, 1 ]], [ 2, Array.from( toneMap ) ], [ 3, [ 2, 2 ]]] );

		const types = String.fromCharCode( ...meta.iinf.body );
		expect( [ 'av01', 'tmap' ].every( t => types.includes( t ) ) ).toBe( true );
		expect( Array.from( meta.iref.body.subarray( 4 + 8 ) ) ).toEqual( [ 0, 2, 0, 2, 0, 1, 0, 3 ] );
		expect( Array.from( meta.grpl.body.subarray( 8 + 4 + 4 ) ) ).toEqual( [ 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 1 ] );
		expect( new DataView( meta.pitm.body.buffer, meta.pitm.body.byteOffset ).getUint16( 4 ) ).toBe( 1 );

	} );

	it( 'says HEIC and AVIF need a video encoder where there is none', async () => {

		expect( await canEncodeStill( 'heic' ) ).toBe( false );
		expect( await canEncodeStill( 'avif' ) ).toBe( false );

	} );

	it( 'starts the encoder once a page, small, and closes it', async () => {

		const made = [];
		class StubEncoder {

			static isConfigSupported = async () => ( { supported: true } );
			constructor() {

				this.state = 'unconfigured';
				made.push( this );

			}

			configure( config ) {

				this.config = config;
				this.state = 'configured';

			}

			flush = vi.fn( async () => {} );
			close() {

				this.state = 'closed';

			}

		}

		vi.stubGlobal( 'VideoEncoder', StubEncoder );
		try {

			expect( prepareStill( 'heic' ) ).toBe( prepareStill( 'heic' ) );
			expect( await prepareStill( 'heic' ) ).toBe( true );
			expect( made.length ).toBe( 1 );
			expect( made[ 0 ].config ).toMatchObject( { codec: 'hvc1.1.6.L123.B0', width: 64, height: 64 } );
			expect( made[ 0 ].flush ).toHaveBeenCalledOnce();
			expect( made[ 0 ].state ).toBe( 'closed' );

		} finally {

			vi.unstubAllGlobals();

		}

	} );

	it( 'starts nothing where there is no video encoder', async () => {

		expect( await prepareStill( 'avif' ) ).toBe( false );

	} );

} );
