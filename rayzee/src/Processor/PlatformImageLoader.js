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

function pixelTexture( { data, width, height } ) {

	const texture = new DataTexture( new Uint8Array( data.buffer, data.byteOffset, width * height * 4 ), width, height, RGBAFormat, UnsignedByteType );
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
 * A GLTFLoader plugin for hosts with the platform's `decodeImage`: every image of the model, embedded
 * or not, is decoded by the host and becomes a DataTexture of its pixels, which the texture packer
 * copies without a canvas. three.js would otherwise need the DOM or createImageBitmap, and `self.URL`
 * for the blob URL it makes of an embedded image.
 *
 * GLTFLoader turns a texture that fails into no texture at all, silently; `onFailure( where, error )`
 * is how that is heard.
 */
export function platformImagesPlugin( parser, onFailure = null ) {

	parser.loadImageSource = function ( sourceIndex ) {

		if ( this.sourceCache[ sourceIndex ] !== undefined ) return this.sourceCache[ sourceIndex ].then( ( texture ) => texture.clone() );

		const def = this.json.images[ sourceIndex ];
		const mimeType = mimeTypeOf( def );
		const where = def.uri ?? `bufferView ${def.bufferView}`;

		const bytes = def.bufferView !== undefined
			? this.getDependency( 'bufferView', def.bufferView ).then( ( buffer ) => new Uint8Array( buffer ) )
			: fetchBytes( this.options.manager.resolveURL( LoaderUtils.resolveURL( def.uri, this.options.path ) ) );

		const promise = bytes.then( ( data ) => decodeBytes( data, mimeType ) ).then( ( pixels ) => {

			const texture = pixelTexture( pixels );
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
