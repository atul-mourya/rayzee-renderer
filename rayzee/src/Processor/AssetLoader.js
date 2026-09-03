import { Box3, BufferGeometry, Vector3, RectAreaLight, Color, FloatType, LinearFilter, EquirectangularReflectionMapping,
	TextureLoader, Texture, SRGBColorSpace, RepeatWrapping, Mesh, MeshStandardMaterial, MeshPhysicalMaterial,
	CircleGeometry, Points, PointsMaterial, LoadingManager, EventDispatcher
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { createMeshesFromMultiMaterialMesh } from 'three/addons/utils/SceneUtils.js';
import { clone as cloneWithSkeletons } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { unzipSync, zipSync, strFromU8 } from 'three/addons/libs/fflate.module.js';
import { disposeEngineOwnedResources, disposeObjectFromMemory, updateLoading } from './utils';
import { BuildTimer } from './BuildTimer.js';
import { getAssetConfig } from '../AssetConfig.js';
import { loadPBRTScene, pickEntryPath } from './PBRT/index.js';
import { extractSceneMetadata } from './SceneMetadata.js';
import { ISSUE_CODES } from '../EngineIssues.js';
import { getRenderProfile } from '../EngineDefaults.js';

// Define supported file formats
const SUPPORTED_FORMATS = {
	'glb': { type: 'model', name: 'GLB (GLTF Binary)' }, 'gltf': { type: 'model', name: 'GLTF' },
	'fbx': { type: 'model', name: 'FBX' }, 'obj': { type: 'model', name: 'OBJ' },
	'stl': { type: 'model', name: 'STL' }, 'ply': { type: 'model', name: 'PLY (Polygon File Format)' },
	'dae': { type: 'model', name: 'Collada' }, '3mf': { type: 'model', name: '3D Manufacturing Format' },
	'usd': { type: 'model', name: 'USD (Universal Scene Description)' },
	'usda': { type: 'model', name: 'USDA (USD ASCII)' },
	'usdc': { type: 'model', name: 'USDC (USD Crate)' },
	'usdz': { type: 'model', name: 'USDZ (USD Archive)' },
	'hdr': { type: 'environment', name: 'HDR (High Dynamic Range)' }, 'exr': { type: 'environment', name: 'EXR (OpenEXR)' },
	'png': { type: 'image', name: 'PNG' }, 'jpg': { type: 'image', name: 'JPEG' },
	'jpeg': { type: 'image', name: 'JPEG' }, 'webp': { type: 'image', name: 'WebP' },
	'zip': { type: 'archive', name: 'ZIP Archive' }
};

// Loose USD layers inside a ZIP compose into one scene; these pick out the
// layers and the image assets they reference.
const USD_LAYER_RE = /\.(usd|usda|usdc)$/i;
const USD_IMAGE_RE = /\.(png|jpg|jpeg|avif)$/i;
// A throwaway stand-in for a geometry the engine must not mutate: the split's mergeGroups()
// reorders and disposes what it is given, but never writes the attributes.
function standInForSplit( source ) {

	const geometry = new BufferGeometry();
	for ( const name in source.attributes ) geometry.setAttribute( name, source.attributes[ name ] );
	if ( source.index ) geometry.setIndex( source.index );
	for ( const group of source.groups ) geometry.addGroup( group.start, group.count, group.materialIndex );
	return geometry;

}

/**
 * AssetLoader class - handles loading of 3D models, environment maps, and archives
 */
export class AssetLoader extends EventDispatcher {

	constructor( scene, camera, controls, { issues = null, profile = null } = {} ) {

		super();
		this.scene = scene;
		this.camera = camera;
		this.controls = controls;
		this.targetModel = null;
		this.floorPlane = null;
		this.sceneScale = 1.0;
		this.loaderCache = {};
		this.uploadedFileInfo = null;
		this.animations = [];
		this.renderer = null;

		// Scene-level authoring metadata from the current model (glTF `extras`), or null.
		// See SceneMetadata.js. Cleared by releaseTargetModel() on every replace-load.
		this.sceneMetadata = null;

		// Shared across every loader so cancelActiveLoad() can abort whichever
		// fetch is in flight (three r185 FileLoader wires the manager's abort
		// signal into its fetch). One load runs at a time (guarded upstream).
		this._loadingManager = new LoadingManager();
		this._loadCancelled = false;

		this._issues = issues;
		this._profile = profile ?? getRenderProfile();

		// A glTF whose external texture 404s still loads. Only place the engine sees the URL.
		// ZIP paths build their own managers and are not covered.
		this._loadingManager.onError = ( url ) => {

			if ( this._loadCancelled ) return;
			this._issues?.record(
				ISSUE_CODES.ASSET_UNREACHABLE,
				`asset "${url}" could not be fetched — anything depending on it renders without it`,
				{ url }
			);

		};

	}

	/**
	 * Abort the network download for the in-flight load, if any. The aborted
	 * loadAsync() rejects with an AbortError, which each load path re-throws as a
	 * typed LOAD_CANCELLED error. Only the download phase is cancelable — once the
	 * bytes are in and BVH/texture processing has begun, this is a no-op.
	 */
	cancelActiveLoad() {

		this._loadCancelled = true;
		this._loadingManager.abort();

	}

	_isCancellation( error ) {

		return this._loadCancelled || error?.name === 'AbortError' || error?.code === 'LOAD_CANCELLED';

	}

	_cancellationError() {

		const err = new Error( 'Load cancelled' );
		err.code = 'LOAD_CANCELLED';
		return err;

	}

	// Build an onProgress handler that reports download byte counts to the UI.
	// `cancelable` gates the Cancel affordance (true only for network URLs — blob
	// and data URLs resolve locally and have nothing to abort). Download maps onto
	// 2→60% of the bar, leaving headroom for the processing phases that follow.
	_downloadProgress( status, cancelable ) {

		return ( event ) => {

			const loaded = event?.loaded || 0;
			const total = event?.lengthComputable ? ( event.total || 0 ) : 0;
			updateLoading( {
				isLoading: true,
				status,
				loadedBytes: loaded,
				totalBytes: total,
				canCancel: !! cancelable,
				progress: total ? Math.min( 60, 2 + Math.round( ( loaded / total ) * 58 ) ) : 2,
			} );

		};

	}

	// Called once bytes are in, before the (non-cancelable) processing phases.
	_downloadComplete( status = 'Processing Data...', progress = 62 ) {

		updateLoading( { status, progress, canCancel: false, loadedBytes: null, totalBytes: null } );

	}

	static _isNetworkUrl( url ) {

		return typeof url === 'string' && /^https?:/i.test( url );

	}

	/**
	 * Deep-clones a caller-owned Object3D so the engine never mutates the host's tree.
	 * Geometry/material/texture ride along by reference, so release frees only what the engine
	 * allocated — see removeModelRoot().
	 *
	 * @param {import('three').Object3D} object3d - the caller's object; left untouched.
	 * @returns {import('three').Object3D} the engine-owned copy.
	 */
	_adoptExternalObject( object3d ) {

		// Not Object3D.clone(): that leaves SkinnedMeshes bound to the source's bones.
		let model;
		try {

			model = cloneWithSkeletons( object3d );

		} catch ( error ) {

			// Object3D.copy() round-trips userData through JSON, so a back-reference throws.
			throw new Error(
				`Cannot render "${object3d.name || object3d.type}": its userData must be JSON-serializable.`,
				{ cause: error }
			);

		}

		model.userData.__rayzeeExternal = true;

		// Carried through as the scene-object id, unless a second copy already took it.
		if ( ! this.scene?.children.some( c => c.uuid === object3d.uuid ) ) model.uuid = object3d.uuid;

		// The copy sits under the engine's identity root, which keeps only a local transform.
		if ( object3d.parent ) {

			object3d.parent.updateWorldMatrix( true, false );
			model.applyMatrix4( object3d.parent.matrixWorld );

		}

		return model;

	}

	/** Releases the current targetModel. See removeModelRoot() for what gets freed. */
	releaseTargetModel() {

		this.sceneMetadata = null;

		if ( ! this.targetModel ) return;

		this.removeModelRoot( this.targetModel );

		this.targetModel = null;
		// Drop the released model's animation clips so a later rebuild doesn't rebind
		// a mixer to disposed nodes. Every load path re-populates this.animations after.
		this.animations = [];

	}

	setRenderer( renderer ) {

		this.renderer = renderer;

	}

	// File utilities
	getFileFormat( filename ) {

		const extension = filename.split( '.' ).pop().toLowerCase();
		return SUPPORTED_FORMATS[ extension ] || null;

	}

	readFileAsArrayBuffer( file ) {

		return new Promise( ( resolve, reject ) => {

			const reader = new FileReader();
			reader.onload = ( event ) => resolve( event.target.result );
			reader.onerror = ( error ) => reject( error );
			reader.readAsArrayBuffer( file );

		} );

	}

	readFileAsText( file ) {

		return new Promise( ( resolve, reject ) => {

			const reader = new FileReader();
			reader.onload = ( event ) => resolve( event.target.result );
			reader.onerror = ( error ) => reject( error );
			reader.readAsText( file );

		} );

	}

	// Asset loading methods
	async loadAssetFromFile( file ) {

		const filename = file.name;
		const format = this.getFileFormat( filename );
		if ( ! format ) throw new Error( `Unsupported file format: ${filename}` );

		updateLoading( { isLoading: true, status: `Loading ${format.name}...`, progress: 2 } );
		try {

			let result;
			switch ( format.type ) {

				case 'model': result = await this.loadModelFromFile( file, filename ); break;
				case 'environment':
				case 'image': result = await this.loadEnvironmentFromFile( file, filename ); break;
				case 'archive': result = await this.loadArchiveFromFile( file, filename ); break;
				default: throw new Error( `Unknown asset type: ${format.type}` );

			}

			return result;

		} catch ( error ) {

			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	async loadModelFromFile( file, filename ) {

		const extension = filename.split( '.' ).pop().toLowerCase();
		const arrayBuffer = await this.readFileAsArrayBuffer( file );

		switch ( extension ) {

			case 'glb':
			case 'gltf': return await this.loadGLBFromArrayBuffer( arrayBuffer, filename );
			case 'fbx': return await this.loadFBXFromArrayBuffer( arrayBuffer, filename );
			case 'obj': return await this.loadOBJFromFile( file, filename );
			case 'stl': return await this.loadSTLFromArrayBuffer( arrayBuffer, filename );
			case 'ply': return await this.loadPLYFromArrayBuffer( arrayBuffer, filename );
			case 'dae': return await this.loadColladaFromFile( file, filename );
			case '3mf': return await this.load3MFFromArrayBuffer( arrayBuffer, filename );
			case 'usd':
			case 'usda':
			case 'usdc':
			case 'usdz': return await this.loadUSDFromArrayBuffer( arrayBuffer, filename );
			default: throw new Error( `Support for ${extension} files is not yet implemented` );

		}

	}

	async loadEnvironmentFromFile( file, filename ) {

		const url = URL.createObjectURL( file );
		this.uploadedFileInfo = { name: filename, type: file.type, size: file.size };
		try {

			const texture = await this.loadEnvironment( url );
			this.dispatchEvent( { type: 'load', texture, filename } );
			return texture;

		} finally {

			URL.revokeObjectURL( url );

		}

	}

	async loadEnvironment( envUrl ) {

		this._loadCancelled = false;

		try {

			// Dispatch event before loading environment to allow UI to prepare
			// (e.g., switching to HDRI mode if needed)
			this.dispatchEvent( { type: 'beforeEnvironmentLoad', url: envUrl } );

			let texture;
			if ( envUrl.startsWith( 'blob:' ) ) {

				texture = await this.loadEnvironmentFromBlob( envUrl );

			} else {

				// Strip query string + fragment before extracting extension, otherwise
				// URLs like ".../foo.hdr?v=2" get mis-detected and fall through to the
				// regular TextureLoader, which can't parse HDR/EXR binary data.
				const cleanPath = envUrl.split( /[?#]/ )[ 0 ];
				const extension = cleanPath.split( '.' ).pop().toLowerCase();
				texture = await this.loadEnvironmentByExtension( envUrl, extension );

			}

			texture.generateMipmaps = true;

			this.applyEnvironmentToScene( texture );
			this.dispatchEvent( { type: 'load', texture, url: envUrl, filename: envUrl.split( /[?#]/ )[ 0 ].split( '/' ).pop() } );
			return texture;

		} catch ( error ) {

			if ( this._isCancellation( error ) ) throw this._cancellationError();
			console.error( "Error loading environment:", error );
			this.dispatchEvent( { type: 'error', message: error.message, filename: envUrl } );
			throw error;

		}

	}

	async loadEnvironmentFromBlob( blobUrl ) {

		const response = await fetch( blobUrl );
		const blob = await response.blob();
		const extension = this.determineEnvironmentExtension( blob, blobUrl );
		const newBlobUrl = URL.createObjectURL( blob );
		try {

			return await this.loadEnvironmentByExtension( newBlobUrl, extension );

		} finally {

			URL.revokeObjectURL( newBlobUrl );

		}

	}

	determineEnvironmentExtension( blob, url ) {

		let extension;
		if ( blob.type === 'image/x-exr' || blob.type.includes( 'exr' ) ) {

			extension = 'exr';

		} else if ( blob.type === 'image/vnd.radiance' || blob.type.includes( 'hdr' ) ) {

			extension = 'hdr';

		} else {

			const fileNameMatch = url.split( '/' ).pop();
			if ( fileNameMatch ) {

				const extMatch = fileNameMatch.match( /\.([^.]+)$/ );
				if ( extMatch ) extension = extMatch[ 1 ].toLowerCase();

			}

		}

		if ( ! extension && this.uploadedFileInfo ) {

			extension = this.uploadedFileInfo.name.split( '.' ).pop().toLowerCase();

		}

		return extension;

	}

	async loadEnvironmentByExtension( url, extension ) {

		const cancelable = AssetLoader._isNetworkUrl( url );
		const onProgress = this._downloadProgress( "Downloading Environment...", cancelable );

		let texture;
		if ( extension === 'hdr' || extension === 'exr' ) {

			const loader = extension === 'hdr'
				? ( this.loaderCache.hdr || ( this.loaderCache.hdr = new HDRLoader( this._loadingManager ).setDataType( FloatType ) ) )
				: ( this.loaderCache.exr || ( this.loaderCache.exr = new EXRLoader( this._loadingManager ).setDataType( FloatType ) ) );
			texture = await loader.loadAsync( url, onProgress );

		} else {

			if ( ! this.loaderCache.texture ) this.loaderCache.texture = new TextureLoader( this._loadingManager );
			texture = await this.loaderCache.texture.loadAsync( url, onProgress );
			// LDR env maps (jpg/png/webp) are authored in sRGB; tag them so the backend
			// decodes to linear. HDR/EXR are already linear and keep the loader's setting.
			texture.colorSpace = SRGBColorSpace;

		}

		this._downloadComplete( "Processing Environment...", 62 );

		texture.mapping = EquirectangularReflectionMapping;
		texture.minFilter = LinearFilter;
		texture.magFilter = LinearFilter;
		return texture;

	}

	applyEnvironmentToScene( texture ) {

		this.scene.background = texture;
		this.scene.environment = texture;

	}

	// Archive handling
	async loadArchiveFromFile( file, filename ) {

		try {

			const arrayBuffer = await this.readFileAsArrayBuffer( file );
			const zip = unzipSync( new Uint8Array( arrayBuffer ) );

			// A pbrt scene archive takes priority — it owns its own geometry/texture refs.
			if ( pickEntryPath( zip ) ) return await this.loadPBRTFromZip( zip, filename );

			const result = await this.processObjMtlPairsInZip( zip, filename );
			if ( result ) return result;
			return await this.findAndLoadModelFromZip( zip, filename );

		} catch ( error ) {

			console.error( 'Error loading ZIP archive:', error );
			throw error;

		}

	}

	/**
	 * Loads a pbrt-v4 scene from an unzipped archive. Parses the entry .pbrt
	 * (following Include/Import), builds a THREE.Group, sets the infinite light
	 * as the scene environment, and runs the standard onModelLoad pipeline.
	 * @param {Object<string, Uint8Array>} zip - unzipped entries (path → bytes)
	 * @param {string} filename - original archive name (for display/events)
	 */
	async loadPBRTFromZip( zip, filename ) {

		updateLoading( { isLoading: true, status: 'Parsing PBRT scene...', progress: 5 } );

		// Geometry decoder — reuse the cached PLYLoader (pbrt leans on .ply meshes).
		if ( ! this.loaderCache.ply ) {

			const { PLYLoader } = await import( 'three/examples/jsm/loaders/PLYLoader.js' );
			this.loaderCache.ply = new PLYLoader();

		}

		const plyParser = ( buf ) => this.loaderCache.ply.parse( buf );

		// Texture maps — decode by extension (pbrt uses .png/.jpg but also .exr/.hdr/.tga).
		const imageFromBytes = ( bytes, fname ) => this._pbrtTextureFromBytes( bytes, fname );

		// Infinite-light maps → HDR/EXR/LDR via the shared environment decoder.
		const envFromBytes = async ( bytes, fname ) => {

			const ext = fname.split( '.' ).pop().toLowerCase();
			const url = URL.createObjectURL( new Blob( [ bytes ] ) );
			try {

				return await this.loadEnvironmentByExtension( url, ext );

			} finally {

				URL.revokeObjectURL( url );

			}

		};

		const { group, environment, report, warnings, entryPath } = await loadPBRTScene( {
			vfs: zip, plyParser, imageFromBytes, envFromBytes
		} );

		// Diagnostics — surface what each mesh resolved to (helps debug black/wrong materials).
		if ( report && report.length && typeof console.table === 'function' ) {

			console.groupCollapsed( `PBRT loader: ${report.length} mesh(es) from "${entryPath}"` );
			console.table( report );
			console.groupEnd();

		}

		if ( warnings && warnings.length ) {

			console.warn( `PBRT loader: ${warnings.length} warning(s) parsing "${entryPath}"` );
			warnings.forEach( w => console.warn( '  •', w ) );

		}

		// Infinite light → scene environment (CDF is built later in loadSceneData).
		if ( environment?.texture ) {

			environment.texture.generateMipmaps = true;
			this.applyEnvironmentToScene( environment.texture );

		}

		group.name = entryPath || filename;
		this.releaseTargetModel();
		this.targetModel = group;

		updateLoading( { isLoading: true, status: 'Processing PBRT geometry...', progress: 10 } );
		await this.onModelLoad( this.targetModel );

		this.dispatchEvent( { type: 'load', model: group, filename: `${entryPath} (from ZIP)` } );
		return group;

	}

	/**
	 * Decodes a pbrt texture map from raw bytes, picking a decoder by extension.
	 * ImageBitmap can't handle EXR/HDR/TGA, which pbrt scenes use freely.
	 * @param {Uint8Array} bytes
	 * @param {string} fname
	 * @returns {Promise<import('three').Texture>}
	 */
	async _pbrtTextureFromBytes( bytes, fname ) {

		const ext = fname.split( '.' ).pop().toLowerCase();
		let tex;

		if ( ext === 'exr' || ext === 'hdr' ) {

			const loader = ext === 'hdr'
				? ( this.loaderCache.hdr || ( this.loaderCache.hdr = new HDRLoader().setDataType( FloatType ) ) )
				: ( this.loaderCache.exr || ( this.loaderCache.exr = new EXRLoader().setDataType( FloatType ) ) );
			tex = await this._loadViaObjectURL( loader, bytes );
			// HDR/EXR maps are linear — leave colorSpace as the loader set it.

		} else if ( ext === 'tga' ) {

			if ( ! this.loaderCache.tga ) {

				const { TGALoader } = await import( 'three/examples/jsm/loaders/TGALoader.js' );
				this.loaderCache.tga = new TGALoader();

			}

			tex = await this._loadViaObjectURL( this.loaderCache.tga, bytes );
			tex.colorSpace = SRGBColorSpace;

		} else {

			// png / jpg / webp / gif / bmp
			const bitmap = await createImageBitmap( new Blob( [ bytes ] ) );
			tex = new Texture( bitmap );
			tex.colorSpace = SRGBColorSpace;

		}

		tex.wrapS = tex.wrapT = RepeatWrapping;
		tex.needsUpdate = true;
		return tex;

	}

	/** Decode bytes through a three loader's loadAsync via a transient object URL. */
	async _loadViaObjectURL( loader, bytes ) {

		const url = URL.createObjectURL( new Blob( [ bytes ] ) );
		try {

			return await loader.loadAsync( url );

		} finally {

			URL.revokeObjectURL( url );

		}

	}

	async processObjMtlPairsInZip( zip, filename ) {

		const objFiles = [];
		const mtlFiles = [];

		for ( const path in zip ) {

			const lowerPath = path.toLowerCase();
			if ( lowerPath.endsWith( '.obj' ) ) objFiles.push( { path, content: zip[ path ] } );
			else if ( lowerPath.endsWith( '.mtl' ) ) mtlFiles.push( { path, content: zip[ path ] } );

		}

		if ( objFiles.length > 0 && mtlFiles.length > 0 ) {

			console.log( `Found ${objFiles.length} OBJ files and ${mtlFiles.length} MTL files in ZIP` );
			const matches = this.findMatchingObjMtlPairs( objFiles, mtlFiles );

			if ( matches.length > 0 ) {

				console.log( `Found ${matches.length} matching OBJ+MTL pairs` );
				return await this.loadOBJMTLPairFromZip( matches[ 0 ].obj, matches[ 0 ].mtl, zip, filename );

			}

			if ( matches.length === 0 ) {

				console.log( 'No matching pairs by name, using first OBJ and MTL files' );
				return await this.loadOBJMTLPairFromZip( objFiles[ 0 ], mtlFiles[ 0 ], zip, filename );

			}

		}

		return null;

	}

	findMatchingObjMtlPairs( objFiles, mtlFiles ) {

		const matches = [];
		for ( const objFile of objFiles ) {

			const objBaseName = objFile.path.split( '/' ).pop().replace( /\.obj$/i, '' ).toLowerCase();

			for ( const mtlFile of mtlFiles ) {

				const mtlBaseName = mtlFile.path.split( '/' ).pop().replace( /\.mtl$/i, '' ).toLowerCase();
				if ( objBaseName === mtlBaseName || objBaseName.includes( mtlBaseName ) || mtlBaseName.includes( objBaseName ) ) {

					matches.push( { obj: objFile, mtl: mtlFile } );
					break;

				}

			}

		}

		return matches;

	}

	async findAndLoadModelFromZip( zip ) {

		const mainModelFiles = [
			'scene.gltf', 'scene.glb', 'model.gltf', 'model.glb',
			'main.gltf', 'main.glb', 'asset.gltf', 'asset.glb'
		];

		for ( const mainFile of mainModelFiles ) {

			if ( zip[ mainFile ] ) {

				console.log( `Found main model file: ${mainFile}` );
				const extension = mainFile.split( '.' ).pop().toLowerCase();
				return await this.loadModelFromZipEntry( zip[ mainFile ], mainFile, extension, zip );

			}

		}

		for ( const path in zip ) {

			const extension = path.split( '.' ).pop().toLowerCase();
			if ( SUPPORTED_FORMATS[ extension ] && SUPPORTED_FORMATS[ extension ].type === 'model' ) {

				// A loose layer is only one slice of a USD scene — hand the whole
				// archive over so its references and payloads can resolve.
				if ( USD_LAYER_RE.test( path ) ) return await this.loadUSDHierarchyFromZip( zip );

				console.log( `Loading model file from ZIP: ${path}` );
				return await this.loadModelFromZipEntry( zip[ path ], path, extension, zip );

			}

		}

		throw new Error( 'No supported model files found in the ZIP archive' );

	}

	// USDLoader only builds a cross-layer asset map on its USDZ branch, so repack
	// the archive as USDZ — root layer first, per AOUSD core spec 16.4.1.2 — and
	// let the loader resolve the references/payloads itself.
	async loadUSDHierarchyFromZip( zip ) {

		const layers = Object.keys( zip ).filter( name => USD_LAYER_RE.test( name ) );
		if ( layers.length === 0 ) throw new Error( 'No USD layers found in the ZIP archive' );

		const root = AssetLoader._pickUSDRootLayer( layers );
		console.log( `Loading USD scene from ZIP: ${root} (${layers.length} layers)` );

		const packed = { [ root ]: [ zip[ root ], { level: 0 } ] };
		for ( const name of Object.keys( zip ) ) {

			if ( name === root ) continue;
			if ( USD_LAYER_RE.test( name ) || USD_IMAGE_RE.test( name ) ) packed[ name ] = [ zip[ name ], { level: 0 } ];

		}

		return await this.loadUSDFromArrayBuffer( zipSync( packed ), root );

	}

	// Shallowest layer wins; among ties prefer the <dir>/<dir>.usd convention so a
	// set's entry point beats its sibling variants.
	static _pickUSDRootLayer( layers ) {

		const depth = name => name.split( '/' ).length;
		const minDepth = Math.min( ...layers.map( depth ) );
		const candidates = layers.filter( name => depth( name ) === minDepth );

		const conventional = candidates.find( name => {

			const parts = name.split( '/' );
			return parts.length > 1 && parts[ parts.length - 1 ].replace( USD_LAYER_RE, '' ) === parts[ parts.length - 2 ];

		} );

		return conventional || candidates[ 0 ];

	}

	async loadModelFromZipEntry( fileContent, filePath, extension, zipContents ) {

		try {

			updateLoading( { isLoading: true, status: `Processing ${extension.toUpperCase()} from ZIP...`, progress: 5 } );
			const blob = new Blob( [ fileContent.buffer ], { type: 'application/octet-stream' } );
			const blobUrl = URL.createObjectURL( blob );
			let result;

			switch ( extension ) {

				case 'glb':
				case 'gltf':
					result = await this.handleGltfFromZip( extension, fileContent, filePath, zipContents );
					break;
				case 'fbx':
					result = await this.loadFBXFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'obj':
					result = await this.handleObjFromZip( fileContent, filePath, zipContents );
					break;
				case 'stl':
					result = await this.loadSTLFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'ply':
					result = await this.loadPLYFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'dae':
					{

						const daeContent = strFromU8( fileContent );
						const daeFile = new File( [ new Blob( [ daeContent ] ) ], filePath );
						result = await this.loadColladaFromFile( daeFile, filePath );

					}

					break;
				case '3mf':
					result = await this.load3MFFromArrayBuffer( fileContent.buffer, filePath );
					break;
				case 'usd':
				case 'usda':
				case 'usdc':
				case 'usdz':
					result = await this.loadUSDFromArrayBuffer( fileContent, filePath );
					break;
				default:
					throw new Error( `Support for ${extension} files is not yet implemented` );

			}

			URL.revokeObjectURL( blobUrl );
			this.dispatchEvent( {
				type: 'load',
				model: this.targetModel,
				filename: `${filePath} (from ZIP)`
			} );
			return result;

		} catch ( error ) {

			console.error( `Error loading ${extension} from ZIP:`, error );
			this.dispatchEvent( { type: 'error', message: error.message, filename: filePath } );
			throw error;

		}

	}

	async handleGltfFromZip( extension, fileContent, filePath, zipContents ) {

		if ( extension === 'gltf' ) {

			const gltfContent = strFromU8( fileContent );
			const manager = new LoadingManager();
			const gltfDir = filePath.split( '/' ).slice( 0, - 1 ).join( '/' );

			manager.setURLModifier( url => this.resolveZipResource( url, gltfDir, zipContents ) );
			const loader = await this.createGLTFLoader();
			loader.manager = manager;

			try {

				return await new Promise( ( resolve, reject ) => {

					loader.parse( gltfContent, '',
						gltf => {

							this.releaseTargetModel();
							this.targetModel = gltf.scene;
							this.sceneMetadata = extractSceneMetadata( gltf );
							this.onModelLoad( this.targetModel ).then( () => resolve( gltf ) );

						},
						error => reject( error )
					);

				} );

			} finally {

				this._disposeGLTFLoader( loader );

			}

		} else {

			return await this.loadGLBFromArrayBuffer( fileContent.buffer, filePath );

		}

	}

	async handleObjFromZip( fileContent, filePath, zipContents ) {

		const objContent = strFromU8( fileContent );
		const mtlMatch = objContent.match( /mtllib\s+([^\s]+)/ );
		let materials = null;

		if ( mtlMatch && mtlMatch[ 1 ] ) {

			materials = await this.loadMtlFromZip( mtlMatch[ 1 ], filePath, zipContents );

		}

		const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
		const objLoader = new OBJLoader();
		if ( materials ) objLoader.setMaterials( materials );

		const object = objLoader.parse( objContent );
		object.name = filePath;

		this.releaseTargetModel();
		this.targetModel = object;
		await this.onModelLoad( this.targetModel );
		return object;

	}

	async loadMtlFromZip( mtlFilename, objPath, zipContents ) {

		const objDir = objPath.split( '/' ).slice( 0, - 1 ).join( '/' );
		const possibleMtlPaths = [
			mtlFilename,
			`${objDir}/${mtlFilename}`,
			mtlFilename.split( '/' ).pop()
		];

		for ( const path of possibleMtlPaths ) {

			if ( zipContents[ path ] ) {

				const { MTLLoader } = await import( 'three/examples/jsm/loaders/MTLLoader.js' );
				const mtlContent = strFromU8( zipContents[ path ] );
				const manager = new LoadingManager();
				manager.setURLModifier( url => this.resolveZipResource( url, objDir, zipContents ) );
				const mtlLoader = new MTLLoader( manager );
				const materials = mtlLoader.parse( mtlContent, objDir );
				materials.preload();
				return materials;

			}

		}

		return null;

	}

	resolveZipResource( url, baseDir, zipContents ) {

		const normalizedUrl = url.replace( /^\.\/|^\//, '' );
		const possiblePaths = [
			normalizedUrl,
			`${baseDir}/${normalizedUrl}`,
			normalizedUrl.split( '/' ).pop()
		];

		for ( const path of possiblePaths ) {

			if ( zipContents[ path ] ) {

				const fileBlob = new Blob( [ zipContents[ path ].buffer ], { type: 'application/octet-stream' } );
				return URL.createObjectURL( fileBlob );

			}

		}

		console.warn( `Resource not found in ZIP: ${url}` );
		return url;

	}

	async loadOBJMTLPairFromZip( objFile, mtlFile, zip, filename ) {

		const { MTLLoader } = await import( 'three/examples/jsm/loaders/MTLLoader.js' );
		const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
		const createdUrls = [];
		const manager = new LoadingManager();
		const objDir = objFile.path.split( '/' ).slice( 0, - 1 ).join( '/' );
		const mtlDir = mtlFile.path.split( '/' ).slice( 0, - 1 ).join( '/' );

		manager.setURLModifier( url => this.resolveTextureInZip( url, objDir, mtlDir, mtlFile, zip, createdUrls ) );
		const mtlContent = this.prepareFixedMtlContent( mtlFile );
		const materials = new MTLLoader( manager ).parse( mtlContent, mtlDir );
		materials.preload();

		const objLoader = new OBJLoader( manager );
		objLoader.setMaterials( materials );
		const objContent = strFromU8( objFile.content );
		const object = objLoader.parse( objContent );

		this.releaseTargetModel();
		this.targetModel = object;
		await this.onModelLoad( this.targetModel );

		createdUrls.forEach( url => URL.revokeObjectURL( url ) );
		this.dispatchEvent( {
			type: 'load',
			model: object,
			filename: `${objFile.path} (from ${filename})`
		} );

		return object;

	}

	prepareFixedMtlContent( mtlFile ) {

		const mtlContent = strFromU8( mtlFile.content );
		return mtlContent
			.replace( new RegExp( `${mtlFile.path.split( '/' ).pop()}\\s+`, 'g' ), ' ' )
			.replace( /([a-zA-Z_]+)([\\/])/g, '$1 $2' );

	}

	resolveTextureInZip( url, objDir, mtlDir, mtlFile, zip, createdUrls ) {

		const cleanUrl = url.split( '?' )[ 0 ].split( '#' )[ 0 ];
		let normalizedUrl = cleanUrl.replace( /^\.\/|^\//, '' );

		const mtlFilename = mtlFile.path.split( '/' ).pop();
		if ( normalizedUrl.startsWith( mtlFilename ) ) {

			normalizedUrl = normalizedUrl.substring( mtlFilename.length ).replace( /^\.\/|^\/|^\./, '' );

		}

		const possibleLocations = [
			normalizedUrl,
			`${objDir}/${normalizedUrl}`,
			`${mtlDir}/${normalizedUrl}`,
			`textures/${normalizedUrl}`,
			`texture/${normalizedUrl}`,
			`materials/${normalizedUrl}`,
			normalizedUrl.split( '/' ).pop()
		];

		for ( const location of possibleLocations ) {

			if ( zip[ location ] ) {

				const blob = new Blob( [ zip[ location ].buffer ], { type: 'application/octet-stream' } );
				const blobUrl = URL.createObjectURL( blob );
				createdUrls.push( blobUrl );
				return blobUrl;

			}

		}

		return this.findTextureWithFuzzyMatch( normalizedUrl, zip, createdUrls ) || url;

	}

	findTextureWithFuzzyMatch( normalizedUrl, zip, createdUrls ) {

		const textureFilename = normalizedUrl.split( '/' ).pop();

		for ( const zipPath in zip ) {

			if ( zipPath.endsWith( textureFilename ) ) {

				const blob = new Blob( [ zip[ zipPath ].buffer ], { type: 'application/octet-stream' } );
				const blobUrl = URL.createObjectURL( blob );
				createdUrls.push( blobUrl );
				return blobUrl;

			}

		}

		if ( textureFilename && textureFilename.length > 5 ) {

			for ( const zipPath in zip ) {

				const zipFilename = zipPath.split( '/' ).pop();
				if ( zipFilename.includes( textureFilename ) || textureFilename.includes( zipFilename ) ) {

					const blob = new Blob( [ zip[ zipPath ].buffer ], { type: 'application/octet-stream' } );
					const blobUrl = URL.createObjectURL( blob );
					createdUrls.push( blobUrl );
					return blobUrl;

				}

			}

		}

		return null;

	}

	// Returns a fresh loader each call — DRACOLoader/KTX2Loader hold persistent
	// worker pools. Callers must invoke _disposeGLTFLoader() to terminate them.
	async createGLTFLoader() {

		const { dracoDecoderPath, ktx2TranscoderPath } = getAssetConfig();

		const dracoLoader = new DRACOLoader();
		dracoLoader.setDecoderConfig( { type: 'js' } );
		dracoLoader.setDecoderPath( dracoDecoderPath );

		const ktx2Loader = new KTX2Loader();
		ktx2Loader.setTranscoderPath( ktx2TranscoderPath );

		if ( this.renderer ) {

			ktx2Loader.detectSupport( this.renderer );

			// Force RGBA output for Basis Universal textures. GPU-compressed
			// texture arrays (CompressedArrayTexture) are blocked by a Three.js
			// TSL limitation: the node compiler maintains global state that
			// survives dispose(), so swapping texture array formats between
			// DataArrayTexture and CompressedArrayTexture at runtime causes
			// WGSL compilation failures (unresolved uniform bindings).
			ktx2Loader.workerConfig = {
				astcSupported: false, etc1Supported: false, etc2Supported: false,
				dxtSupported: false, bptcSupported: false, pvrtcSupported: false,
			};

		}

		const loader = new GLTFLoader( this._loadingManager );
		loader.setDRACOLoader( dracoLoader );
		loader.setKTX2Loader( ktx2Loader );
		loader.setMeshoptDecoder( MeshoptDecoder );

		return loader;

	}

	_disposeGLTFLoader( loader ) {

		if ( ! loader ) return;
		loader.dracoLoader?.dispose();
		loader.ktx2Loader?.dispose();

	}

	async loadExampleModels( index, modelFiles ) {

		if ( ! modelFiles || ! modelFiles[ index ] ) {

			throw new Error( `No model file at index ${index}` );

		}

		const modelUrl = `${modelFiles[ index ].url}`;
		return await this.loadModel( modelUrl );

	}

	async loadModel( modelUrl ) {

		this._loadCancelled = false;
		const loader = await this.createGLTFLoader();
		const cancelable = AssetLoader._isNetworkUrl( modelUrl );

		try {

			updateLoading( { isLoading: true, status: "Downloading Model...", progress: 2, canCancel: cancelable, loadedBytes: 0, totalBytes: 0 } );
			const data = await loader.loadAsync( modelUrl, this._downloadProgress( "Downloading Model...", cancelable ) );
			this._downloadComplete();

			this.releaseTargetModel();

			this.targetModel = data.scene;
			this.animations = data.animations || [];
			this.sceneMetadata = extractSceneMetadata( data );
			await this.onModelLoad( this.targetModel );
			this.dispatchEvent( { type: 'load', model: data.scene, filename: modelUrl.split( '/' ).pop() } );
			return data;

		} catch ( error ) {

			if ( this._isCancellation( error ) ) throw this._cancellationError();
			console.error( "Error loading model:", error );
			this.dispatchEvent( { type: 'error', message: error.message, filename: modelUrl } );
			throw error;

		} finally {

			this._disposeGLTFLoader( loader );

		}

	}

	// ─────────────────────────────────────────────────────────────
	// Append / remove primitives (dynamic object add/remove).
	// These deliberately do NOT touch targetModel/animations and do NOT
	// reframe the camera or dispatch load/modelProcessed — the caller
	// (PathTracerApp) drives a reframe-free scene rebuild.
	// ─────────────────────────────────────────────────────────────

	// Multi-material split + area-light placeholders, then parent into meshScene.
	_processAndParent( model ) {

		this.processModelObjects( model );
		this.scene.add( model );
		// Refresh world matrices for the whole subtree — the reframe-free rebuild
		// extracts geometry immediately (rAF is gated off), so nothing else would
		// update matrices first and any ancestor-node transform would be dropped.
		model.updateMatrixWorld( true );

	}

	// Append a model from URL without releasing prior models or reframing.
	// Reuses createGLTFLoader() so appended KTX2 textures stay RGBA DataArrayTexture.
	async appendModel( url ) {

		this._loadCancelled = false;
		const loader = await this.createGLTFLoader();
		const cancelable = AssetLoader._isNetworkUrl( url );

		try {

			updateLoading( { isLoading: true, status: "Downloading Model...", progress: 2, canCancel: cancelable, loadedBytes: 0, totalBytes: 0 } );
			const data = await loader.loadAsync( url, this._downloadProgress( "Downloading Model...", cancelable ) );
			this._downloadComplete();
			this._processAndParent( data.scene );
			return { root: data.scene, animations: data.animations || [] };

		} catch ( error ) {

			if ( this._isCancellation( error ) ) throw this._cancellationError();
			throw error;

		} finally {

			this._disposeGLTFLoader( loader );

		}

	}

	// Append a copy of a caller-owned Object3D without releasing prior models or reframing.
	appendObject3D( object3d, name = 'object3d' ) {

		const root = this._adoptExternalObject( object3d );
		root.name = object3d.name || name;
		this._processAndParent( root );
		return { root };

	}

	// Detach + dispose a model root. An adopted root's geometry/materials belong to the
	// caller, so only the engine's own allocations go.
	removeModelRoot( root ) {

		if ( ! root ) return;

		if ( root.userData.__rayzeeExternal ) {

			disposeEngineOwnedResources( root );
			root.parent?.remove( root );

		} else {

			disposeObjectFromMemory( root );

		}

	}

	async loadGLBFromArrayBuffer( arrayBuffer, filename = 'model.glb' ) {

		const loader = await this.createGLTFLoader();

		try {

			updateLoading( { isLoading: true, status: "Processing GLB Data...", progress: 5 } );
			await new Promise( r => setTimeout( r, 0 ) );

			const data = await loader.parseAsync( arrayBuffer, '' );

			this.releaseTargetModel();

			this.targetModel = data.scene;
			this.animations = data.animations || [];
			this.sceneMetadata = extractSceneMetadata( data );
			updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: data.scene, filename } );
			return data;

		} catch ( error ) {

			console.error( 'Error loading GLB:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		} finally {

			this._disposeGLTFLoader( loader );

		}

	}

	async loadFBXFromArrayBuffer( arrayBuffer, filename = 'model.fbx' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing FBX Data...", progress: 5 } );
			await new Promise( r => setTimeout( r, 0 ) );

			if ( ! this.loaderCache.fbx ) {

				const { FBXLoader } = await import( 'three/examples/jsm/loaders/FBXLoader.js' );
				this.loaderCache.fbx = new FBXLoader();

			}

			const object = this.loaderCache.fbx.parse( arrayBuffer );
			this.releaseTargetModel();
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading FBX:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	async loadOBJFromFile( file, filename = 'model.obj' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing OBJ Data...", progress: 5 } );
			await new Promise( r => setTimeout( r, 0 ) );

			if ( ! this.loaderCache.obj ) {

				const { OBJLoader } = await import( 'three/examples/jsm/loaders/OBJLoader.js' );
				this.loaderCache.obj = new OBJLoader();

			}

			const contents = await this.readFileAsText( file );
			const object = this.loaderCache.obj.parse( contents );
			object.name = filename;

			this.releaseTargetModel();
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading OBJ:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	async loadSTLFromArrayBuffer( arrayBuffer, filename = 'model.stl' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing STL Data...", progress: 5 } );
			await new Promise( r => setTimeout( r, 0 ) );

			if ( ! this.loaderCache.stl ) {

				const { STLLoader } = await import( 'three/examples/jsm/loaders/STLLoader.js' );
				this.loaderCache.stl = new STLLoader();

			}

			const geometry = this.loaderCache.stl.parse( arrayBuffer );
			const material = new MeshStandardMaterial();
			const mesh = new Mesh( geometry, material );
			mesh.name = filename;

			this.releaseTargetModel();
			this.targetModel = mesh;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: mesh, filename } );
			return mesh;

		} catch ( error ) {

			console.error( 'Error loading STL:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	async loadPLYFromArrayBuffer( arrayBuffer, filename = 'model.ply' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing PLY Data...", progress: 5 } );
			await new Promise( r => setTimeout( r, 0 ) );

			if ( ! this.loaderCache.ply ) {

				const { PLYLoader } = await import( 'three/examples/jsm/loaders/PLYLoader.js' );
				this.loaderCache.ply = new PLYLoader();

			}

			const geometry = this.loaderCache.ply.parse( arrayBuffer );
			let object;

			if ( geometry.index !== null ) {

				const material = new MeshStandardMaterial();
				object = new Mesh( geometry, material );

			} else {

				const material = new PointsMaterial( { size: 0.01 } );
				material.vertexColors = geometry.hasAttribute( 'color' );
				object = new Points( geometry, material );

			}

			object.name = filename;
			this.releaseTargetModel();
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading PLY:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	async loadColladaFromFile( file, filename = 'model.dae' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing Collada Data...", progress: 5 } );
			await new Promise( r => setTimeout( r, 0 ) );

			if ( ! this.loaderCache.collada ) {

				const { ColladaLoader } = await import( 'three/examples/jsm/loaders/ColladaLoader.js' );
				this.loaderCache.collada = new ColladaLoader();

			}

			const contents = await this.readFileAsText( file );
			const collada = this.loaderCache.collada.parse( contents );
			collada.scene.name = filename;

			this.releaseTargetModel();
			this.targetModel = collada.scene;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: collada.scene, filename } );
			return collada;

		} catch ( error ) {

			console.error( 'Error loading Collada:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	async load3MFFromArrayBuffer( arrayBuffer, filename = 'model.3mf' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing 3MF Data...", progress: 5 } );
			await new Promise( r => setTimeout( r, 0 ) );

			if ( ! this.loaderCache.threemf ) {

				const { ThreeMFLoader } = await import( 'three/examples/jsm/loaders/3MFLoader.js' );
				this.loaderCache.threemf = new ThreeMFLoader();

			}

			const object = this.loaderCache.threemf.parse( arrayBuffer );

			this.releaseTargetModel();
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading 3MF:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	async loadUSDFromArrayBuffer( data, filename = 'model.usd' ) {

		try {

			updateLoading( { isLoading: true, status: "Processing USD Data...", progress: 5 } );
			await new Promise( r => setTimeout( r, 0 ) );

			if ( ! this.loaderCache.usd ) {

				const { USDLoader } = await import( 'three/examples/jsm/loaders/USDLoader.js' );
				this.loaderCache.usd = new USDLoader();

			}

			// parse() returns the group synchronously but resolves textures async;
			// setupPathTracing snapshots materials, so maps must land before it runs.
			const object = await new Promise( ( resolve, reject ) => {

				this.loaderCache.usd.parse( data, '', resolve, reject );

			} );

			object.name = filename;

			this.releaseTargetModel();
			this.targetModel = object;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model: object, filename } );
			return object;

		} catch ( error ) {

			console.error( 'Error loading USD:', error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	async loadObject3D( object3d, name = 'object3d' ) {

		this.releaseTargetModel();

		const model = this._adoptExternalObject( object3d );
		model.name = object3d.name || name;

		this.targetModel = model;

		updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
		await this.onModelLoad( this.targetModel );

		this.dispatchEvent( { type: 'load', model, filename: name } );
		return model;

	}

	// Model processing methods
	async onModelLoad( model ) {

		const buildTimer = new BuildTimer( 'onModelLoad' );

		// Extract cameras from the loaded model
		buildTimer.start( 'Camera extraction' );
		const extractedCameras = this.extractCamerasFromModel( model );
		buildTimer.end( 'Camera extraction' );

		// Center model and adjust camera
		buildTimer.start( 'Camera setup' );
		const box = new Box3().setFromObject( model );
		const center = box.getCenter( new Vector3() );
		const size = box.getSize( new Vector3() );

		this.controls.target.copy( center );

		const maxDim = Math.max( size.x, size.y, size.z );
		const fov = this.camera.fov * ( Math.PI / 180 );
		const cameraDistance = Math.abs( maxDim / Math.sin( fov / 2 ) / 2 );

		// Set up isometric-like view
		const angle = Math.PI / 6; // 30 degrees
		const pos = new Vector3(
			Math.cos( angle ) * cameraDistance,
			cameraDistance / Math.sqrt( 2 ), // Elevation
			Math.sin( angle ) * cameraDistance
		);

		this.camera.position.copy( pos.add( center ) );
		this.camera.lookAt( center );

		this.camera.near = maxDim / 100;
		this.camera.far = maxDim * 100;
		this.camera.updateProjectionMatrix();
		this.controls.maxDistance = cameraDistance * 10;
		this.controls.saveState();
		this.controls.update();
		buildTimer.end( 'Camera setup' );

		// Adjust floor plane
		if ( this.floorPlane ) {

			const floorY = box.min.y;
			this.floorPlane.position.y = floorY;
			this.floorPlane.rotation.x = - Math.PI / 2;
			this.floorPlane.scale.setScalar( maxDim * 5 );

		}

		// Process model objects
		buildTimer.start( 'Process model objects' );
		this.processModelObjects( model );
		buildTimer.end( 'Process model objects' );

		buildTimer.start( 'Scene add' );
		this.scene.add( model );
		buildTimer.end( 'Scene add' );

		// Calculate scene scale factor based on model size
		const sceneScale = maxDim;

		// Rebuild path tracing
		buildTimer.start( 'setupPathTracing' );
		await this.setupPathTracing( model, sceneScale );
		buildTimer.end( 'setupPathTracing' );

		buildTimer.print();

		// Dispatch event with cameras if found
		this.dispatchEvent( {
			type: 'modelProcessed',
			model: model,
			cameras: extractedCameras,
			sceneData: { center, size, maxDim, sceneScale }
		} );

		// Notify model loaded and processed
		this.dispatchEvent( { type: 'SceneRebuild' } );
		return { center, size, maxDim, sceneScale };

	}

	// New method to extract cameras from loaded models
	extractCamerasFromModel( model ) {

		const cameras = [];

		// Ensure world matrices are up-to-date before extraction
		model.updateWorldMatrix( true, true );

		model.traverse( ( object ) => {

			if ( object.isCamera ) {

				// Clone the camera to avoid modifying the original
				const camera = object.clone();

				// Apply world transforms — cameras may be children of
				// transformed nodes, so local position/quaternion != world.
				object.getWorldPosition( camera.position );
				object.getWorldQuaternion( camera.quaternion );

				// Set a meaningful name
				if ( ! camera.name || camera.name === '' ) {

					camera.name = `Model Camera ${cameras.length + 1}`;

				}

				// Ensure the camera has proper aspect ratio
				if ( camera.isPerspectiveCamera ) {

					camera.aspect = this.camera.aspect;
					camera.updateProjectionMatrix();

				}

				cameras.push( camera );

			}

		} );

		return cameras;

	}

	processModelObjects( model ) {

		let visitedAreaLights = [];
		// Split after the walk: traverse() caches children.length, so splitting in place
		// shifts later siblings down a slot and skips one.
		const multiMaterialMeshes = [];
		model.traverse( ( object ) => {

			const userData = object.userData;

			if ( object.isRectAreaLight && ! visitedAreaLights.includes( object.uuid ) ) {

				visitedAreaLights.push( object.uuid );

			}

			// glTF punctual point/spot intensity is candela (W/sr); the engine's light
			// model is Blender-style Power (W) that LightSerializer divides by 4π. Convert
			// glTF candela → Power once at import (×4π) so it nets to the correct I/d².
			// Directional (lux ≈ irradiance) is used directly and needs no conversion.
			if ( ( object.isPointLight || object.isSpotLight ) && ! userData.__candelaConverted ) {

				object.intensity *= 4 * Math.PI;
				userData.__candelaConverted = true;

			}

			// Process ceiling lights
			if ( object.name.startsWith( 'RectAreaLightPlaceholder' ) &&
				userData.name
				// && userData.name.includes( "ceilingLight" )
			) {

				if ( userData.type === 'RectAreaLight' ) {

					// Authored intensity is three.js radiance (these files also carry power = intensity·w·h·π);
					// convert to the engine's radiant power through the world area so Normalize reproduces it.
					const worldScale = object.getWorldScale( new Vector3() );
					const normalize = userData.normalize ?? true;
					const shape = userData.shape ?? 'rectangle';
					const shapeFactor = shape === 'ellipse' || shape === 'disk' ? Math.PI / 4 : 1;
					const worldArea = shapeFactor * userData.width * worldScale.x * userData.height * worldScale.y;
					const power = userData.intensity * Math.PI * ( normalize ? worldArea : 1 );
					const light = new RectAreaLight(
						new Color( ...userData.color ),
						power * this._profile.areaLightIntensityScale,
						userData.width,
						userData.height
					);
					light.userData.normalize = normalize;
					light.userData.spread = Number.isFinite( userData.spread ) ? userData.spread : Math.PI;
					light.userData.shape = shape;
					light.name = userData.name;
					object.add( light );
					visitedAreaLights.push( light.uuid );

				}

			}

			// Handle multi-material meshes
			if ( object.isMesh && Array.isArray( object.material ) ) {

				multiMaterialMeshes.push( object );

			}

		} );

		const shared = model.userData.__rayzeeExternal === true;

		for ( const object of multiMaterialMeshes ) {

			if ( ! object.parent ) continue;

			console.log( 'Found multi-material mesh:', object.name );
			if ( shared ) object.geometry = standInForSplit( object.geometry );

			const group = createMeshesFromMultiMaterialMesh( object );
			// Fresh geometry per group; tag it so an adopted model's release can free it.
			for ( const child of group.children ) child.geometry.userData.__rayzeeOwned = true;

			object.parent.add( group );
			object.parent.remove( object );

		}

	}

	async setupPathTracing( model, sceneScale ) {

		this.sceneScale = sceneScale;

	}

	// Utility methods

	/**
	 * Creates and adds a floor plane to the scene.
	 * The floor plane is used for focus raycasting and ground contact.
	 */
	createFloorPlane() {

		this.floorPlane = new Mesh(
			new CircleGeometry(),
			new MeshPhysicalMaterial( {
				transparent: false,
				color: 0x303030,
				roughness: 1,
				metalness: 0,
				opacity: 0,
				transmission: 0,
			} )
		);
		this.floorPlane.name = "Ground";
		this.floorPlane.visible = false;
		this.scene.add( this.floorPlane );

	}

	setFloorPlane( floorPlane ) {

		this.floorPlane = floorPlane;

	}

	getSceneScale() {

		return this.sceneScale;

	}

	getTargetModel() {

		return this.targetModel;

	}

	getSupportedFormats( type = null ) {

		if ( type ) {

			const filtered = {};
			for ( const [ ext, info ] of Object.entries( SUPPORTED_FORMATS ) ) {

				if ( info.type === type ) filtered[ ext ] = info;

			}

			return filtered;

		}

		return SUPPORTED_FORMATS;

	}

	// Cleanup
	dispose() {

		for ( const key in this.loaderCache ) {

			const loader = this.loaderCache[ key ];
			if ( loader && typeof loader.dispose === 'function' ) {

				loader.dispose();

			}

		}

		this.loaderCache = {};

		// Three.js EventDispatcher exposes no dispose()/removeAllEventListeners().
		// Clear the internal listener map directly so handlers don't retain references.
		this._listeners = undefined;

		// onError captures `this`, and a manager outlives the loader via an in-flight fetch.
		this._loadingManager.onError = undefined;
		this._issues = null;

		this.releaseTargetModel();

	}

	removeAllEventListeners() {

		this._listeners = undefined;

	}

}

