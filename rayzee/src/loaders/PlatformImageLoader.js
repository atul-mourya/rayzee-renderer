import { DataTexture, LoaderUtils, RGBAFormat, Texture, UnsignedByteType } from 'three';
import { getPlatform } from '../Platform.js';
import { setImageReader } from '../materials/TextureCreator.js';

// Enough of a file for the size of nearly any PNG or JPEG; JPEG metadata before the frame header can run long.
export const IMAGE_HEADER_BYTES = 256 * 1024;

const MIME_BY_EXTENSION = [[ /\.jpe?g(\?|#|$)/i, 'image/jpeg' ], [ /\.webp(\?|#|$)/i, 'image/webp' ], [ /\.avif(\?|#|$)/i, 'image/avif' ]];

function mimeTypeOf( def ) {

	if ( def.mimeType ) return def.mimeType;
	if ( def.uri?.startsWith( 'data:' ) ) return def.uri.slice( 5, def.uri.indexOf( ';' ) );
	return MIME_BY_EXTENSION.find( ( [ pattern ] ) => pattern.test( def.uri ?? '' ) )?.[ 1 ] ?? 'image/png';

}

// Browsers ignore bytes after IEND and exporters leave them there; strict decoders reject the file.
function trimPNG( bytes ) {

	for ( let i = 8; i + 12 <= bytes.length; ) {

		const length = ( ( bytes[ i ] << 24 ) | ( bytes[ i + 1 ] << 16 ) | ( bytes[ i + 2 ] << 8 ) | bytes[ i + 3 ] ) >>> 0;
		const end = i + 12 + length;
		if ( bytes[ i + 4 ] === 0x49 && bytes[ i + 5 ] === 0x45 && bytes[ i + 6 ] === 0x4E && bytes[ i + 7 ] === 0x44 ) return bytes.subarray( 0, end );
		i = end;

	}

	return bytes;

}

/**
 * A PNG's or JPEG's size from its header, or null: other formats, a header past `bytes`, and an image whose metadata may
 * turn it (a JPEG's Exif, a PNG's eXIf) are decoded to learn it.
 */
export function imageHeaderSize( bytes ) {

	const u32 = ( i ) => ( ( bytes[ i ] << 24 ) | ( bytes[ i + 1 ] << 16 ) | ( bytes[ i + 2 ] << 8 ) | bytes[ i + 3 ] ) >>> 0;
	const u16 = ( i ) => ( bytes[ i ] << 8 ) | bytes[ i + 1 ];
	const tag = ( i, name ) => String.fromCharCode( bytes[ i ], bytes[ i + 1 ], bytes[ i + 2 ], bytes[ i + 3 ] ) === name;

	if ( bytes.length >= 24 && u32( 0 ) === 0x89504E47 && tag( 12, 'IHDR' ) ) {

		for ( let i = 8; i + 8 <= bytes.length; i += 12 + u32( i ) ) {

			if ( tag( i + 4, 'eXIf' ) ) return null;
			if ( tag( i + 4, 'IDAT' ) ) return { width: u32( 16 ), height: u32( 20 ) };

		}

		return null;

	}

	if ( bytes.length < 4 || u16( 0 ) !== 0xFFD8 ) return null;
	for ( let i = 2; i + 4 <= bytes.length; ) {

		if ( bytes[ i ] !== 0xFF ) return null;
		const marker = bytes[ i + 1 ];
		if ( marker === 0xFF ) {

			i ++;
			continue;

		}

		if ( marker === 0x01 || ( marker >= 0xD0 && marker <= 0xD7 ) ) {

			i += 2;
			continue;

		}

		if ( marker === 0xE1 && i + 10 <= bytes.length && tag( i + 4, 'Exif' ) ) return null;
		if ( marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC ) {

			return i + 9 <= bytes.length ? { width: u16( i + 7 ), height: u16( i + 5 ) } : null;

		}

		if ( marker === 0xDA || marker === 0xD9 ) return null;
		i += 2 + u16( i + 2 );

	}

	return null;

}

// A model's images go to the texture pack worker, which reads a SharedArrayBuffer where they lie.
function pixelImage( { data, width, height }, { shared = false } = {} ) {

	const view = new Uint8Array( data.buffer, data.byteOffset, width * height * 4 );
	let pixels = view;
	if ( shared && typeof SharedArrayBuffer !== 'undefined' && ! ( view.buffer instanceof SharedArrayBuffer ) ) {

		pixels = new Uint8Array( new SharedArrayBuffer( view.byteLength ) );
		pixels.set( view );

	}

	return { data: pixels, width, height };

}

// `image` null: a texture whose pixels are read later, `image.data` null until then.
function pixelTexture( image, { width = image.width, height = image.height } = {} ) {

	const texture = new DataTexture( image?.data ?? null, width, height, RGBAFormat, UnsignedByteType );
	texture.needsUpdate = true;
	return texture;

}

function decodeBytes( bytes, mimeType ) {

	return getPlatform().decodeImage( mimeType === 'image/png' ? trimPNG( bytes ) : bytes, mimeType );

}

async function fetchBytes( url ) {

	const response = await fetch( url );
	if ( ! response.ok ) throw new Error( `HTTP ${response.status}` );
	return new Uint8Array( await response.arrayBuffer() );

}

function imageURL( parser, def ) {

	return parser.options.manager.resolveURL( LoaderUtils.resolveURL( def.uri, parser.options.path ) );

}

function imageBytes( parser, def ) {

	return def.bufferView !== undefined
		? parser.getDependency( 'bufferView', def.bufferView ).then( ( buffer ) => new Uint8Array( buffer ) )
		: fetchBytes( imageURL( parser, def ) );

}

// A glTF image's file as three's ImageBitmapLoader fetches it, telling the loading manager as it does.
function imageBlob( parser, def, loader ) {

	if ( def.bufferView !== undefined ) return parser.getDependency( 'bufferView', def.bufferView ).then( ( buffer ) => new Blob( [ buffer ], { type: def.mimeType } ) );

	const { manager } = parser.options;
	const url = imageURL( parser, def );
	manager.itemStart( url );
	return fetch( url, {
		credentials: loader.crossOrigin === 'anonymous' ? 'same-origin' : 'include',
		headers: loader.requestHeader,
		signal: manager.abortController?.signal,
	} ).then( ( response ) => {

		if ( ! response.ok ) throw new Error( `HTTP ${response.status}` );
		return response.blob();

	} ).catch( ( error ) => {

		manager.itemError( url );
		throw error;

	} ).finally( () => manager.itemEnd( url ) );

}

// GLTFLoader hands an image its extension decodes (KHR_texture_basisu → KTX2Loader) a loader of its own; three's way to
// it is an object URL through `self.URL`, so here the loader parses the bytes.
const ownsLoader = ( parser, loader ) => !! loader && loader !== parser.textureLoader && typeof loader.parse === 'function';

function loadWithOwnLoader( parser, sourceIndex, loader ) {

	if ( parser.sourceCache[ sourceIndex ] !== undefined ) return parser.sourceCache[ sourceIndex ].then( ( texture ) => texture.clone() );

	const promise = imageBytes( parser, parser.json.images[ sourceIndex ] ).then( ( bytes ) => new Promise( ( resolve, reject ) => {

		loader.parse( bytes.buffer.slice( bytes.byteOffset, bytes.byteOffset + bytes.byteLength ), resolve, reject );

	} ) );
	parser.sourceCache[ sourceIndex ] = promise;
	return promise;

}

/**
 * An image file as a texture, decoded by the platform: the counterpart of TextureLoader for hosts
 * with no DOM. Rows stay top first with `flipY` on, exactly as TextureLoader leaves an image.
 */
export async function loadPlatformImage( url, mimeType = mimeTypeOf( { uri: url } ) ) {

	const texture = pixelTexture( pixelImage( await decodeBytes( await fetchBytes( url ), mimeType ) ) );
	texture.flipY = true;
	return texture;

}

/** An image file's bytes as a texture, decoded by the platform: {@link loadPlatformImage} without the fetch. */
export async function platformImageFromBytes( bytes, filename ) {

	const texture = pixelTexture( pixelImage( await decodeBytes( bytes, mimeTypeOf( { uri: filename } ) ), { shared: true } ) );
	texture.flipY = true;
	return texture;

}

/** {@link platformImageFromBytes}'s texture before its pixels: `image` is `{ data: null, width, height }`. */
export function platformImagePlaceholder( width, height ) {

	const texture = pixelTexture( null, { width, height } );
	texture.flipY = true;
	return texture;

}

// A glTF image's texture as three.js gives it, its pixels decoded by `read` only when the arrays are packed.
async function rereadableImage( bytes, read, def, onFailure ) {

	const size = imageHeaderSize( bytes.subarray( 0, IMAGE_HEADER_BYTES ) );
	let texture;
	try {

		texture = await read( size );

	} catch ( error ) {

		onFailure?.( def.uri ?? `bufferView ${def.bufferView}`, error );
		throw error;

	}

	setImageReader( texture, () => read( null ).then( ( t ) => t.image ), { resident: ! size } );
	if ( def.extras && typeof def.extras === 'object' ) Object.assign( texture.userData, def.extras );
	texture.userData.mimeType = mimeTypeOf( def );
	return texture;

}

/**
 * A GLTFLoader plugin for the browser: an image three's ImageBitmapLoader would read, embedded or a file of its own, is
 * fetched and decoded as that loader does it, but decoded only when the texture arrays are packed (a PNG or JPEG), and
 * let go once they are. A file that cannot be fetched fails as it does there, through the loading manager.
 */
export function browserImagesPlugin( parser, onFailure = null ) {

	const loadImageSource = parser.loadImageSource;
	parser.loadImageSource = function ( sourceIndex, loader ) {

		const def = this.json.images[ sourceIndex ];
		if ( this.sourceCache[ sourceIndex ] !== undefined || ( def.bufferView === undefined && def.uri === undefined ) || ! loader?.isImageBitmapLoader ) return loadImageSource.call( this, sourceIndex, loader );

		const promise = imageBlob( this, def, loader ).then( async ( blob ) => {

			const read = async ( size ) => {

				const texture = new Texture( size ? { ...size, data: null } : await createImageBitmap( blob, { ...loader.options, colorSpaceConversion: 'none' } ) );
				texture.needsUpdate = true;
				return texture;

			};

			return rereadableImage( new Uint8Array( await blob.slice( 0, IMAGE_HEADER_BYTES ).arrayBuffer() ), read, def, onFailure );

		} );

		this.sourceCache[ sourceIndex ] = promise;
		return promise;

	};

	return { name: 'RAYZEE_browser_images' };

}

/**
 * A GLTFLoader plugin for a runtime with no way to decode an image (Node without `decodeImage`): each image fails with
 * what to configure, where three.js's own path threw `self is not defined` and took the whole load down.
 */
export function missingImageDecoderPlugin( parser, onFailure = null ) {

	parser.loadImageSource = function ( sourceIndex, loader ) {

		if ( ownsLoader( this, loader ) ) return loadWithOwnLoader( this, sourceIndex, loader );

		const def = this.json.images[ sourceIndex ];
		const error = new Error( 'no image decoder in this runtime: configurePlatform( nodePlatform( { decodeImage } ) ) — see "Running in Node"' );
		onFailure?.( def.uri ?? `bufferView ${def.bufferView}`, error );
		return Promise.reject( error );

	};

	return { name: 'RAYZEE_missing_image_decoder' };

}

/**
 * A GLTFLoader plugin for hosts with the platform's `decodeImage`: every image of the model, embedded
 * or not, is decoded by the host and becomes a DataTexture of its pixels, which the texture packer
 * copies without a canvas. three.js would otherwise need the DOM or createImageBitmap, and `self.URL`
 * for the blob URL it makes of an embedded image.
 *
 * GLTFLoader turns a texture that fails into no texture at all, silently; `onFailure( where, error )`
 * is how that is heard.
 */
export function platformImagesPlugin( parser, onFailure = null ) {

	parser.loadImageSource = function ( sourceIndex, loader ) {

		if ( ownsLoader( this, loader ) ) return loadWithOwnLoader( this, sourceIndex, loader );
		if ( this.sourceCache[ sourceIndex ] !== undefined ) return this.sourceCache[ sourceIndex ].then( ( texture ) => texture.clone() );

		const def = this.json.images[ sourceIndex ];
		const mimeType = mimeTypeOf( def );
		const where = def.uri ?? `bufferView ${def.bufferView}`;

		const promise = imageBytes( this, def ).then( ( bytes ) => {

			const blob = new Blob( [ bytes ] );
			const read = async ( size ) => pixelTexture( size ? null : pixelImage( await decodeBytes( new Uint8Array( await blob.arrayBuffer() ), mimeType ), { shared: true } ), size ?? {} );
			return rereadableImage( bytes, read, def, onFailure );

		}, ( error ) => {

			onFailure?.( where, error );
			throw error;

		} );

		this.sourceCache[ sourceIndex ] = promise;
		return promise;

	};

	return { name: 'RAYZEE_platform_images' };

}
