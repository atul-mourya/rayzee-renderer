import { getAssetConfig } from '../AssetConfig.js';

const DRACO = 'KHR_draco_mesh_compression';
const BASISU = 'KHR_texture_basisu';
const MESHOPT = [ 'EXT_meshopt_compression', 'KHR_meshopt_compression' ];

const decoder = new TextDecoder();

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
		dracoLoader.setDecoderConfig( { type: 'js' } );
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

/**
 * Gives a GLTFLoader the Draco, KTX2 and meshopt decoders only when the file it parses uses them, importing each then:
 * most glTFs use none, and the three are ~35 KB compressed a host would otherwise always ship.
 * @param {Object} loader - a GLTFLoader
 * @param {?Object} renderer - for KTX2's format detection
 */
export function decodersOnDemand( loader, renderer ) {

	const parse = loader.parse.bind( loader );
	loader.parse = ( data, path, onLoad, onError ) => {

		attachDecoders( loader, jsonText( data ), renderer ).then(
			() => parse( data, path, onLoad, onError ),
			( error ) => onError?.( error ),
		);

	};

	return loader;

}
