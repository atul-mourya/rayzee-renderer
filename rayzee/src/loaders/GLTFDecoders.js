import { getAssetConfig } from '../AssetConfig.js';
import { nextTask } from '../Platform.js';

const DRACO = 'KHR_draco_mesh_compression';
const BASISU = 'KHR_texture_basisu';
const MESHOPT = [ 'EXT_meshopt_compression', 'KHR_meshopt_compression' ];

const decoder = new TextDecoder();

const GLB_MAGIC = 0x46546C67;
const CHUNK_JSON = 0x4E4F534A;
const CHUNK_BIN = 0x004E4942;
const GLB_SOURCE = Symbol( 'glb' );

// A version 2 .glb's JSON text and where its binary chunk sits; null for anything else, which three reads itself.
function splitGLB( data ) {

	if ( ! ( data instanceof ArrayBuffer ) || data.byteLength < 20 ) return null;
	const view = new DataView( data );
	if ( view.getUint32( 0, true ) !== GLB_MAGIC || view.getUint32( 4, true ) !== 2 ) return null;

	const end = Math.min( view.getUint32( 8, true ), data.byteLength );
	let text = null, bin = null;
	for ( let at = 12; at + 8 <= end; ) {

		const length = view.getUint32( at, true ), type = view.getUint32( at + 4, true ), start = at + 8;
		if ( start + length > end ) return null;
		if ( type === CHUNK_JSON ) text = decoder.decode( new Uint8Array( data, start, length ) );
		else if ( type === CHUNK_BIN ) bin = { start, length };
		at = start + length;

	}

	return text === null ? null : { text, data, bin };

}

// Each view of the binary chunk is sliced from the file's own bytes; what asks for the chunk itself gets one copy of it.
function glbViewsPlugin( parser ) {

	const name = 'RAYZEE_glb_views';
	const glb = parser.json[ GLB_SOURCE ];
	if ( ! glb ) return { name };
	delete parser.json[ GLB_SOURCE ];

	const { data, bin } = glb;
	// Clamped to the chunk, as a slice of three's copy is.
	const slice = ( offset, length ) => data.slice( bin.start + Math.min( offset, bin.length ), bin.start + Math.min( offset + length, bin.length ) );
	let body;
	return {
		name,
		beforeRoot() {

			parser.extensions.KHR_binary_glTF = { get body() {

				return body ??= bin ? slice( 0, bin.length ) : null;

			} };

		},
		loadBufferView( index ) {

			const def = parser.json.bufferViews[ index ];
			if ( ! bin || def.buffer !== 0 || parser.json.buffers?.[ 0 ]?.uri !== undefined || def.extensions ) return null;
			return Promise.resolve( slice( def.byteOffset ?? 0, def.byteLength ?? 0 ) );

		},
	};

}

/**
 * Parses a .glb without copying its binary chunk: three copies the whole chunk, then each buffer view out of that copy.
 * The JSON is decoded once, here, and handed to three parsed. Decoding, parsing and three's start each get a task.
 * @param {Object} loader - a GLTFLoader
 */
export function glbInPlace( loader ) {

	loader.register( glbViewsPlugin );
	const parse = loader.parse.bind( loader );
	loader.parse = ( data, path, onLoad, onError ) => {

		const glb = splitGLB( data );
		if ( ! glb ) return parse( data, path, onLoad, onError );

		nextTask().then( () => {

			let json = null;
			try {

				json = JSON.parse( glb.text );

			} catch {

				// three's own path, so the error reads as it always has.

			}

			if ( typeof json !== 'object' || json === null ) return parse( data, path, onLoad, onError );
			json[ GLB_SOURCE ] = glb;
			return nextTask().then( () => parse( json, path, onLoad, onError ) );

		} ).catch( ( error ) => onError?.( error ) );

	};

	return loader;

}

// The glTF's JSON as text: a .glb's first chunk, a .gltf whole. Only searched, never parsed.
function jsonText( data ) {

	if ( typeof data === 'string' ) return data;
	if ( ! ( data instanceof ArrayBuffer ) ) return JSON.stringify( data?.extensionsUsed ?? [] );

	const view = new DataView( data );
	const isBinary = data.byteLength >= 20 && view.getUint32( 0, true ) === 0x46546C67;
	if ( ! isBinary ) return decoder.decode( data );
	const length = Math.min( view.getUint32( 12, true ), data.byteLength - 20 );
	return decoder.decode( new Uint8Array( data, 20, length ) );

}

async function attachDecoders( loader, text, renderer ) {

	const { dracoDecoderPath, ktx2TranscoderPath } = getAssetConfig();
	const [ draco, ktx2, meshopt ] = await Promise.all( [
		text.includes( DRACO ) && ! loader.dracoLoader ? import( 'three/addons/loaders/DRACOLoader.js' ) : null,
		text.includes( BASISU ) && ! loader.ktx2Loader ? import( 'three/addons/loaders/KTX2Loader.js' ) : null,
		MESHOPT.some( name => text.includes( name ) ) && ! loader.meshoptDecoder ? import( 'three/addons/libs/meshopt_decoder.module.js' ) : null,
	] );

	if ( draco ) {

		const dracoLoader = new draco.DRACOLoader();
		dracoLoader.setDecoderPath( dracoDecoderPath );
		loader.setDRACOLoader( dracoLoader );

	}

	if ( ktx2 ) {

		const ktx2Loader = new ktx2.KTX2Loader();
		ktx2Loader.setTranscoderPath( ktx2TranscoderPath );
		if ( renderer ) {

			ktx2Loader.detectSupport( renderer );
			// RGBA only: GPU-compressed texture arrays are blocked by a three.js TSL limitation (the node compiler's
			// state survives dispose(), so swapping DataArrayTexture for CompressedArrayTexture breaks WGSL compilation).
			ktx2Loader.workerConfig = {
				astcSupported: false, etc1Supported: false, etc2Supported: false,
				dxtSupported: false, bptcSupported: false, pvrtcSupported: false,
			};

		}

		loader.setKTX2Loader( ktx2Loader );

	}

	if ( meshopt ) loader.setMeshoptDecoder( meshopt.MeshoptDecoder );

}

// A file JSON.parse refused, said plainly. A web page in a model's place is mostly a wrong address, or a missing file a
// server answered with its page.
function notGLTF( data, error ) {

	const page = /^\s*</.test( jsonText( data ).slice( 0, 256 ) );
	return new Error( page
		? 'The address gave a web page, not a 3D model. The link may be wrong, or the file missing.'
		: 'This is not a glTF model: the file could not be read as one.', { cause: error } );

}

/**
 * Gives a GLTFLoader the Draco, KTX2 and meshopt decoders only when the file it parses uses them, importing each then:
 * most glTFs use none, and the three are ~35 KB compressed a host would otherwise always ship.
 * @param {Object} loader - a GLTFLoader
 * @param {?Object} renderer - for KTX2's format detection
 */
export function decodersOnDemand( loader, renderer ) {

	const parse = loader.parse.bind( loader );
	loader.parse = ( data, path, onLoad, onError ) => {

		// three's parse throws on what is not JSON, which GLTFLoader.load catches; a step later nothing would, and the load
		// never ended (every later one refused as already in progress).
		attachDecoders( loader, jsonText( data ), renderer )
			.then( () => parse( data, path, onLoad, onError ) )
			.catch( ( error ) => onError?.( error instanceof SyntaxError ? notGLTF( data, error ) : error ) );

	};

	return loader;

}
