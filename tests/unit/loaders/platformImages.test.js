import { describe, it, expect, vi, afterEach } from 'vitest';
import { configurePlatform, hasImageDecoder } from '@/core/Platform.js';
import { platformImagesPlugin, missingImageDecoderPlugin, loadPlatformImage, imageHeaderSize, embeddedImagesPlugin } from '@/core/loaders/PlatformImageLoader.js';
import { holdImages, releaseImages } from '@/core/materials/TextureCreator.js';

// A PNG signature, one IHDR-shaped chunk and IEND, then the trailing bytes exporters leave.
function pngWithTrailer() {

	const chunk = ( type, length ) => [ 0, 0, 0, length, ...[ ...type ].map( ( c ) => c.charCodeAt( 0 ) ), ...new Array( length ).fill( 1 ), 9, 9, 9, 9 ];
	const png = [ 137, 80, 78, 71, 13, 10, 26, 10, ...chunk( 'IHDR', 13 ), ...chunk( 'IEND', 0 ) ];
	return { bytes: new Uint8Array( [ ...png, 0xde, 0xad, 0xbe, 0xef ] ), trimmedLength: png.length };

}

const u32 = ( v ) => [ v >>> 24, ( v >>> 16 ) & 255, ( v >>> 8 ) & 255, v & 255 ];
const ascii = ( text ) => [ ...text ].map( ( c ) => c.charCodeAt( 0 ) );

// A PNG of `width` × `height` with the chunks named before its pixels.
function png( width, height, before = [] ) {

	const chunk = ( type, body ) => [ ...u32( body.length ), ...ascii( type ), ...body, 0, 0, 0, 0 ];
	return new Uint8Array( [ 137, 80, 78, 71, 13, 10, 26, 10, ...chunk( 'IHDR', [ ...u32( width ), ...u32( height ), 8, 6, 0, 0, 0 ] ),
		...before.flatMap( ( type ) => chunk( type, [ 1, 2, 3 ] ) ), ...chunk( 'IDAT', [ 9, 9 ] ), ...chunk( 'IEND', [] ) ] );

}

// A JPEG with the segments given before its frame header (`marker` SOFn).
function jpeg( width, height, { marker = 0xC0, before = [] } = {} ) {

	const segment = ( m, body ) => [ 0xFF, m, ( body.length + 2 ) >> 8, ( body.length + 2 ) & 255, ...body ];
	return new Uint8Array( [ 0xFF, 0xD8, ...before.flatMap( ( [ m, body ] ) => segment( m, body ) ),
		...segment( marker, [ 8, height >> 8, height & 255, width >> 8, width & 255, 3 ] ), 0xFF, 0xDA, 0, 2, 0xFF, 0xD9 ] );

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

describe( 'an image\'s size from its header', () => {

	it( 'reads a PNG\'s and a JPEG\'s, baseline or progressive, past other segments', () => {

		expect( imageHeaderSize( png( 2048, 1024, [ 'iCCP', 'tEXt' ] ) ) ).toEqual( { width: 2048, height: 1024 } );
		expect( imageHeaderSize( jpeg( 640, 480 ) ) ).toEqual( { width: 640, height: 480 } );
		expect( imageHeaderSize( jpeg( 4000, 3000, { marker: 0xC2, before: [[ 0xE0, ascii( 'JFIF\0' ) ], [ 0xDB, new Array( 64 ).fill( 1 ) ], [ 0xC4, [ 0, 1 ]]] } ) ) ).toEqual( { width: 4000, height: 3000 } );

	} );

	it( 'leaves an image that may be turned, a header past the bytes and any other format to the decoder', () => {

		expect( imageHeaderSize( png( 8, 8, [ 'eXIf' ] ) ) ).toBeNull();
		expect( imageHeaderSize( jpeg( 8, 8, { before: [[ 0xE1, [ ...ascii( 'Exif' ), 0, 0 ]]] } ) ) ).toBeNull();
		expect( imageHeaderSize( png( 8, 8 ).subarray( 0, 30 ) ) ).toBeNull();
		expect( imageHeaderSize( jpeg( 8, 8 ).subarray( 0, 8 ) ) ).toBeNull();
		expect( imageHeaderSize( new Uint8Array( [ ...ascii( 'RIFF' ), 0, 0, 0, 0, ...ascii( 'WEBPVP8 ' ) ] ) ) ).toBeNull();
		expect( imageHeaderSize( new Uint8Array( 0 ) ) ).toBeNull();

	} );

} );

describe( 'glTF images decoded when packed', () => {

	afterEach( () => {

		configurePlatform( { decodeImage: null } );
		vi.unstubAllGlobals();

	} );

	it( 'gives a PNG its size and no pixels until held, then the pixels the host decodes (Node)', async () => {

		const pixels = new Uint8Array( 4 * 3 * 4 ).map( ( _, i ) => i );
		const decodeImage = vi.fn( async () => ( { data: pixels.slice(), width: 4, height: 3 } ) );
		configurePlatform( { decodeImage } );
		const parser = fakeParser( [ { bufferView: 0, mimeType: 'image/png', extras: { tag: 'x' } } ], [ png( 4, 3 ) ] );
		platformImagesPlugin( parser );

		const texture = await parser.loadImageSource( 0 );
		expect( decodeImage ).not.toHaveBeenCalled();
		expect( texture.isDataTexture ).toBe( true );
		expect( texture.image ).toMatchObject( { width: 4, height: 3, data: null } );
		expect( texture.userData ).toMatchObject( { tag: 'x', mimeType: 'image/png' } );

		await holdImages( [ texture ] );
		expect( decodeImage ).toHaveBeenCalledOnce();
		expect( Array.from( texture.image.data ) ).toEqual( Array.from( pixels ) );
		releaseImages( [ texture ] );
		expect( texture.image.data ).toBeNull();

	} );

	it( 'decodes in the browser with three\'s ImageBitmapLoader options, a JPEG only when held, a WebP at once', async () => {

		const createImageBitmap = vi.fn( async () => ( { width: 8, height: 8, close() {} } ) );
		vi.stubGlobal( 'createImageBitmap', createImageBitmap );
		const webp = new Uint8Array( [ ...ascii( 'RIFF' ), 0, 0, 0, 0, ...ascii( 'WEBPVP8 ' ) ] );
		const parser = fakeParser( [ { bufferView: 0, mimeType: 'image/jpeg' }, { bufferView: 1, mimeType: 'image/webp' } ], [ jpeg( 8, 8 ), webp ] );
		const loader = { isImageBitmapLoader: true, options: { premultiplyAlpha: 'none' } };
		embeddedImagesPlugin( parser );

		const lazy = await parser.loadImageSource( 0, loader );
		expect( createImageBitmap ).not.toHaveBeenCalled();
		expect( lazy.image ).toMatchObject( { width: 8, height: 8, data: null } );
		expect( lazy.userData.mimeType ).toBe( 'image/jpeg' );

		await holdImages( [ lazy ] );
		const [ blob, options ] = createImageBitmap.mock.calls[ 0 ];
		expect( blob.type ).toBe( 'image/jpeg' );
		expect( new Uint8Array( await blob.arrayBuffer() ) ).toEqual( jpeg( 8, 8 ) );
		expect( options ).toEqual( { premultiplyAlpha: 'none', colorSpaceConversion: 'none' } );
		expect( lazy.image.close ).toBeTypeOf( 'function' );

		const eager = await parser.loadImageSource( 1, loader );
		expect( createImageBitmap ).toHaveBeenCalledTimes( 2 );
		expect( eager.image.close ).toBeTypeOf( 'function' );

	} );

	it( 'leaves an external image, or one another loader decodes, to three', async () => {

		const original = vi.fn( async () => 'three' );
		const parser = { ...fakeParser( [ { uri: 'wood.png' }, { bufferView: 0, mimeType: 'image/png' } ], [ png( 2, 2 ) ] ), loadImageSource: original };
		embeddedImagesPlugin( parser );

		expect( await parser.loadImageSource( 0, { isImageBitmapLoader: true } ) ).toBe( 'three' );
		expect( await parser.loadImageSource( 1, { parse() {} } ) ).toBe( 'three' );

	} );

} );
