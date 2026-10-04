import { DataTexture, LoaderUtils, RGBAFormat, UnsignedByteType } from 'three';
import { getPlatform } from '../Platform.js';

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

// A model's images go to the texture pack worker, which reads a SharedArrayBuffer where they lie.
function pixelTexture( { data, width, height }, { shared = false } = {} ) {

	const view = new Uint8Array( data.buffer, data.byteOffset, width * height * 4 );
	let pixels = view;
	if ( shared && typeof SharedArrayBuffer !== 'undefined' && ! ( view.buffer instanceof SharedArrayBuffer ) ) {

		pixels = new Uint8Array( new SharedArrayBuffer( view.byteLength ) );
		pixels.set( view );

	}

	const texture = new DataTexture( pixels, width, height, RGBAFormat, UnsignedByteType );
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

function imageBytes( parser, def ) {

	return def.bufferView !== undefined
		? parser.getDependency( 'bufferView', def.bufferView ).then( ( buffer ) => new Uint8Array( buffer ) )
		: fetchBytes( parser.options.manager.resolveURL( LoaderUtils.resolveURL( def.uri, parser.options.path ) ) );

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

	const texture = pixelTexture( await decodeBytes( await fetchBytes( url ), mimeType ) );
	texture.flipY = true;
	return texture;

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

		const promise = imageBytes( this, def ).then( ( data ) => decodeBytes( data, mimeType ) ).then( ( pixels ) => {

			const texture = pixelTexture( pixels, { shared: true } );
			if ( def.extras && typeof def.extras === 'object' ) Object.assign( texture.userData, def.extras );
			texture.userData.mimeType = mimeType;
			return texture;

		} ).catch( ( error ) => {

			onFailure?.( where, error );
			throw error;

		} );

		this.sourceCache[ sourceIndex ] = promise;
		return promise;

	};

	return { name: 'RAYZEE_platform_images' };

}
