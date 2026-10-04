import { describe, it, expect, vi, afterEach } from 'vitest';
import { configurePlatform, hasImageDecoder } from '@/core/Platform.js';
import { platformImagesPlugin, missingImageDecoderPlugin, loadPlatformImage } from '@/core/Processor/PlatformImageLoader.js';

// A PNG signature, one IHDR-shaped chunk and IEND, then the trailing bytes exporters leave.
function pngWithTrailer() {

	const chunk = ( type, length ) => [ 0, 0, 0, length, ...[ ...type ].map( ( c ) => c.charCodeAt( 0 ) ), ...new Array( length ).fill( 1 ), 9, 9, 9, 9 ];
	const png = [ 137, 80, 78, 71, 13, 10, 26, 10, ...chunk( 'IHDR', 13 ), ...chunk( 'IEND', 0 ) ];
	return { bytes: new Uint8Array( [ ...png, 0xde, 0xad, 0xbe, 0xef ] ), trimmedLength: png.length };

}

function fakeParser( images, buffers ) {

	return {
		json: { images },
		options: { path: 'https://cdn.test/model/', manager: { resolveURL: ( url ) => url } },
		sourceCache: {},
		getDependency: vi.fn( async ( _, index ) => buffers[ index ].buffer ),
	};

}

describe( 'platform image decoding', () => {

	afterEach( () => {

		configurePlatform( { decodeImage: null } );
		vi.unstubAllGlobals();

	} );

	it( 'hands the host an embedded PNG without the bytes past IEND', async () => {

		const { bytes, trimmedLength } = pngWithTrailer();
		const decodeImage = vi.fn( async () => ( { data: new Uint8Array( 4 ).fill( 200 ), width: 1, height: 1 } ) );
		configurePlatform( { decodeImage } );
		const parser = fakeParser( [ { bufferView: 0, mimeType: 'image/png', extras: { tag: 'x' } } ], [ bytes ] );
		platformImagesPlugin( parser );

		const texture = await parser.loadImageSource( 0 );

		const [ handed, mimeType ] = decodeImage.mock.calls[ 0 ];
		expect( handed.length ).toBe( trimmedLength );
		expect( mimeType ).toBe( 'image/png' );
		expect( texture.isDataTexture ).toBe( true );
		expect( texture.image ).toMatchObject( { width: 1, height: 1 } );
		expect( texture.userData ).toMatchObject( { tag: 'x', mimeType: 'image/png' } );

	} );

	it( 'decodes a source once, however many textures share it', async () => {

		const decodeImage = vi.fn( async () => ( { data: new Uint8Array( 4 ), width: 1, height: 1 } ) );
		configurePlatform( { decodeImage } );
		const parser = fakeParser( [ { bufferView: 0, mimeType: 'image/jpeg' } ], [ new Uint8Array( 8 ) ] );
		platformImagesPlugin( parser );

		const [ a, b ] = await Promise.all( [ parser.loadImageSource( 0 ), parser.loadImageSource( 0 ) ] );
		expect( decodeImage ).toHaveBeenCalledOnce();
		expect( a ).not.toBe( b );

	} );

	it( 'fetches an external image against the model\'s path', async () => {

		const fetch = vi.fn( async () => ( { ok: true, arrayBuffer: async () => new ArrayBuffer( 4 ) } ) );
		vi.stubGlobal( 'fetch', fetch );
		const decodeImage = vi.fn( async () => ( { data: new Uint8Array( 4 ), width: 1, height: 1 } ) );
		configurePlatform( { decodeImage } );
		const parser = fakeParser( [ { uri: 'textures/wood.jpg' } ], [] );
		platformImagesPlugin( parser );

		await parser.loadImageSource( 0 );
		expect( fetch ).toHaveBeenCalledWith( 'https://cdn.test/model/textures/wood.jpg' );
		expect( decodeImage.mock.calls[ 0 ][ 1 ] ).toBe( 'image/jpeg' );

	} );

	it( 'reports a failed decode, which GLTFLoader would otherwise drop silently', async () => {

		configurePlatform( { decodeImage: async () => {

			throw new Error( 'corrupt' );

		} } );
		const onFailure = vi.fn();
		const parser = fakeParser( [ { bufferView: 3, mimeType: 'image/png' } ], { 3: new Uint8Array( 8 ) } );
		platformImagesPlugin( parser, onFailure );

		await expect( parser.loadImageSource( 0 ) ).rejects.toThrow( 'corrupt' );
		expect( onFailure ).toHaveBeenCalledWith( 'bufferView 3', expect.any( Error ) );

	} );

	it( 'loads a sky image top row first with flipY on, as TextureLoader leaves one', async () => {

		vi.stubGlobal( 'fetch', async () => ( { ok: true, arrayBuffer: async () => new ArrayBuffer( 4 ) } ) );
		configurePlatform( { decodeImage: async () => ( { data: new Uint8Array( 8 ), width: 2, height: 1 } ) } );

		const texture = await loadPlatformImage( 'https://cdn.test/sky.png' );
		expect( texture.flipY ).toBe( true );
		expect( texture.image.width ).toBe( 2 );

	} );

	it( 'says what to configure where nothing can decode an image', async () => {

		configurePlatform( { decodeImage: null } );
		expect( hasImageDecoder() ).toBe( false );
		const failures = [];
		const parser = fakeParser( [ { uri: 'albedo.png', mimeType: 'image/png' } ], [] );
		missingImageDecoderPlugin( parser, ( where, error ) => failures.push( [ where, error.message ] ) );

		await expect( parser.loadImageSource( 0 ) ).rejects.toThrow( /decodeImage/ );
		expect( failures ).toEqual( [[ 'albedo.png', expect.stringMatching( /nodePlatform\( \{ decodeImage \} \)/ ) ]] );

		configurePlatform( { decodeImage: async () => ( { data: new Uint8Array( 4 ), width: 1, height: 1 } ) } );
		expect( hasImageDecoder() ).toBe( true );

	} );

	it( 'hands an image an extension decodes (KTX2) to that loader, not the host decoder', async () => {

		const decodeImage = vi.fn();
		configurePlatform( { decodeImage } );
		const bytes = new Uint8Array( [ 0xab, 0x4b, 0x54, 0x58 ] );
		const parser = fakeParser( [ { bufferView: 0, mimeType: 'image/ktx2' } ], [ bytes ] );
		parser.textureLoader = { load() {} };
		const ktx2 = { parse: vi.fn( ( buffer, onLoad ) => onLoad( { isCompressedTexture: true, clone() {

			return this;

		}, size: buffer.byteLength } ) ) };
		platformImagesPlugin( parser );

		const texture = await parser.loadImageSource( 0, ktx2 );
		expect( texture.size ).toBe( 4 );
		expect( decodeImage ).not.toHaveBeenCalled();

		missingImageDecoderPlugin( parser );
		parser.sourceCache = {};
		expect( ( await parser.loadImageSource( 0, ktx2 ) ).size ).toBe( 4 );

	} );

} );
