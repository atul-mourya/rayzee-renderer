import { Box3, BufferGeometry, Vector3, RectAreaLight, Color, FloatType, LinearFilter, EquirectangularReflectionMapping,
	TextureLoader, SRGBColorSpace, Mesh, MeshPhysicalMaterial,
	CircleGeometry, LoadingManager, EventDispatcher, LoaderUtils
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { createMeshesFromMultiMaterialMesh } from 'three/addons/utils/SceneUtils.js';
import { clone as cloneWithSkeletons } from 'three/addons/utils/SkeletonUtils.js';
import { DownloadCache, nameFromUrl, cachedObjectURL } from '../Storage/DownloadCache.js';
import { setEnvironmentSource } from '../Storage/CDFCache.js';
import { fileIdentity, identityKey } from '../Storage/identity.js';
import { disposeEngineOwnedResources, disposeObjectFromMemory, updateLoading } from './utils';
import { BuildTimer } from './BuildTimer.js';
import { getPlatform, hasImageDecoder, withHostWorker } from '../Platform.js';
import { loadPlatformImage, platformImagesPlugin, missingImageDecoderPlugin } from './PlatformImageLoader.js';
import { diffuseTransmissionPlugin } from './GLTFDiffuseTransmission.js';
import { decodersOnDemand } from './GLTFDecoders.js';
import { extractSceneMetadata } from './SceneMetadata.js';
import { ISSUE_CODES } from '../EngineIssues.js';
import { ENGINE_DEFAULTS } from '../EngineDefaults.js';

// Define supported file formats
// What the core reads itself; every other format is registered (registerFormat) or comes with an add-on.
const CORE_FORMATS = {
	'glb': { type: 'model', name: 'GLB (GLTF Binary)' }, 'gltf': { type: 'model', name: 'GLTF' },
	'hdr': { type: 'environment', name: 'HDR (High Dynamic Range)' },
	'png': { type: 'image', name: 'PNG' }, 'jpg': { type: 'image', name: 'JPEG' },
	'jpeg': { type: 'image', name: 'JPEG' }, 'webp': { type: 'image', name: 'WebP' },
};

// Formats an add-on reads, for the error that names it.
const ARCHIVES = { addOn: 'rayzee/addons/archives', install: 'assetLoader.setArchiveImporter()' };
const FORMATS = { addOn: 'rayzee/addons/formats', install: 'assetLoader.registerFormat()' };
const ADDON_FORMATS = {
	zip: ARCHIVES, gz: ARCHIVES, tgz: ARCHIVES, tar: ARCHIVES,
	fbx: FORMATS, obj: FORMATS, stl: FORMATS, ply: FORMATS, dae: FORMATS, '3mf': FORMATS,
	usd: FORMATS, usda: FORMATS, usdc: FORMATS, usdz: FORMATS, exr: FORMATS,
};

// A throwaway stand-in for a geometry the engine must not mutate: the split's mergeGroups()
// reorders and disposes what it is given, but never writes the attributes.
function standInForSplit( source ) {

	const geometry = new BufferGeometry();
	for ( const name in source.attributes ) geometry.setAttribute( name, source.attributes[ name ] );
	if ( source.index ) geometry.setIndex( source.index );
	for ( const group of source.groups ) geometry.addGroup( group.start, group.count, group.materialIndex );
	return geometry;

}

// Luminous efficacy glTF, three.js and Blender's exporter all assume (PBR_WATTS_TO_LUMENS).
const LUMENS_PER_WATT = 683;

// three.js nits → the engine's radiant power, inverting areaLightRadiance.
function areaLightPowerFactor( node, width, height, userData ) {

	if ( ! ( userData.normalize ?? true ) ) return Math.PI;

	const shapeFactor = userData.shape === 'ellipse' || userData.shape === 'disk' ? Math.PI / 4 : 1;
	const scale = node.getWorldScale( new Vector3() );
	// abs: a mirrored ancestor decomposes negative; the serializer takes the area as |u × v|.
	const factor = Math.PI * shapeFactor * Math.abs( width * scale.x * height * scale.y );
	return Number.isFinite( factor ) ? factor : Math.PI;

}

/**
 * AssetLoader class - handles loading of 3D models, environment maps, and archives
 */
export class AssetLoader extends EventDispatcher {

	constructor( scene, camera, controls, { issues = null, areaLightIntensityScale = null } = {} ) {

		super();
		this.scene = scene;
		this.camera = camera;
		this.controls = controls;
		this.targetModel = null;
		this.floorPlane = null;
		this.sceneScale = 1.0;
		this.sceneSize = new Vector3( 1, 1, 1 );
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
		this._urlAbort = null;

		/** @type {?import('../Storage/StorageManager.js').StorageManager} set by the app once storage opens */
		this.storage = null;
		this._downloads = null;
		this._sourceKey = null;
		this._appended = false;
		/** @type {?import('./ArchiveImporter.js').ArchiveImporter} reads archives; see setArchiveImporter() */
		this.archives = null;
		/** @type {?{load: function(): Promise<Object>, formats: Object, pending: ?Promise}} see setArchiveImporterLoader() */
		this._archiveLoader = null;
		/** @type {Map<string, Object>} extension → a format registerFormat() added */
		this._formats = new Map();

		this._issues = issues;
		this._areaLightIntensityScale = areaLightIntensityScale ?? ( () => ENGINE_DEFAULTS.areaLightIntensityScale );

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
		this._urlAbort?.abort();

	}

	/**
	 * `url` swapped for an object URL of its stored copy, downloading it first if needed. A .gltf
	 * with its resources beside it, and non-network URLs, pass through untouched.
	 * @private
	 */
	async _viaCache( url, status, cancelable, { cacheKey = url, cachePolicy } = {} ) {

		if ( ! this.storage || ! AssetLoader._isNetworkUrl( url ) || /\.gltf$/i.test( url.split( /[?#]/ )[ 0 ] ) ) {

			return { url, release: () => {}, cached: false };

		}

		const controller = new AbortController();
		this._urlAbort = controller;
		try {

			return await cachedObjectURL( url, {
				downloads: this.downloads, key: cacheKey, policy: cachePolicy, name: nameFromUrl( url ),
				signal: controller.signal, onProgress: this._downloadProgress( status, cancelable ),
			} );

		} catch ( error ) {

			if ( this._isCancellation( error ) ) throw this._cancellationError();
			throw error;

		} finally {

			this._urlAbort = null;

		}

	}

	/**
	 * What the scene was loaded from, stable across reloads, or null — for the stored-BVH cache.
	 * Null once anything was appended: the scene is no longer one source's.
	 */
	get sceneSourceKey() {

		return this._appended ? null : this._sourceKey;

	}

	_keyed( kind, id ) {

		// The empty field held a profile name that was never set; kept so stored caches and sessions still match.
		return id ? `${kind}::${id}` : null;

	}

	/** Downloads go through storage when there is some, into memory otherwise. */
	get downloads() {

		if ( this._downloads?._storage !== this.storage ) this._downloads = new DownloadCache( this.storage );
		return this._downloads;

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
		this._sourceKey = null;
		this._appended = false;
		this.archives?.release();

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

	/**
	 * Installs the importer that reads scene archives and the pbrt scenes in them — `ArchiveImporter` from
	 * rayzee/addons/archives. Without one, archives are not a supported format.
	 * @param {?import('./ArchiveImporter.js').ArchiveImporter} importer
	 */
	setArchiveImporter( importer ) {

		this.archives = importer;

	}

	/**
	 * Installs the archive importer on first use: `load()` resolves to one, the first time an archive is read. `formats`
	 * are the extensions it reads (its class's `FORMATS`), known before its code is loaded.
	 * @param {function(): Promise<import('./ArchiveImporter.js').ArchiveImporter>} load
	 * @param {Object<string, {type: string, name: string}>} formats
	 */
	setArchiveImporterLoader( load, formats ) {

		this._archiveLoader = { load, formats, pending: null };

	}

	/** The archive importer, loading it first if it was installed with setArchiveImporterLoader(). @private */
	async _archiveImporter() {

		if ( ! this.archives && this._archiveLoader ) this.archives = await ( this._archiveLoader.pending ??= this._archiveLoader.load() );
		return this.archives;

	}

	/** @private */
	get _archiveFormats() {

		return this.archives?.constructor.FORMATS ?? this._archiveLoader?.formats ?? null;

	}

	/**
	 * Adds file formats beyond glTF and .hdr — those of rayzee/addons/formats, or a host's own. Each is
	 * `{ name, label, type: 'model' | 'environment', extensions, parse | createLoader }` (see Processor/FileFormats.js).
	 * @param {...Object} formats
	 * @returns {this}
	 */
	registerFormat( ...formats ) {

		for ( const format of formats ) for ( const extension of format.extensions ) this._formats.set( extension, format );
		return this;

	}

	// File utilities
	getFileFormat( filename ) {

		const extension = filename.split( '.' ).pop().toLowerCase();
		return CORE_FORMATS[ extension ] || this._formats.get( extension ) || this._archiveFormats?.[ extension ] || null;

	}

	/** The error for a file no installed reader takes, naming the add-on that would. */
	formatError( filename ) {

		const addOn = ADDON_FORMATS[ filename.split( '.' ).pop().toLowerCase() ];
		return new Error( addOn
			? `${filename}: this format is read by ${addOn.addOn} — install it with ${addOn.install}`
			: `Unsupported file format: ${filename}` );

	}

	/** @see ArchiveImporter#inspectArchive */
	async inspectArchive( file ) {

		const archives = await this._archiveImporter();
		if ( ! archives ) throw this.formatError( file.name ?? 'archive.zip' );
		return await archives.inspectArchive( file );

	}

	/** @see ArchiveImporter#flushPendingGraph */
	flushPendingGraph( buildMs ) {

		this.archives?.flushPendingGraph( buildMs );

	}

	// Blob's own readers, not FileReader: Node has no FileReader.
	readFileAsArrayBuffer( file ) {

		return file.arrayBuffer();

	}

	readFileAsText( file ) {

		return file.text();

	}

	// Asset loading methods
	async loadAssetFromFile( file, options = {} ) {

		const filename = file.name;
		const format = this.getFileFormat( filename );
		if ( ! format ) throw this.formatError( filename );

		updateLoading( { isLoading: true, status: `Loading ${format.name}...`, progress: 2 } );
		try {

			let result;
			switch ( format.type ) {

				case 'model': result = await this.loadModelFromFile( file, filename ); break;
				case 'environment':
				case 'image': result = await this.loadEnvironmentFromFile( file, filename ); break;
				case 'archive': result = await ( await this._archiveImporter() ).loadArchiveFromFile( file, filename, options ); break;
				default: throw new Error( `Unknown asset type: ${format.type}` );

			}

			return result;

		} catch ( error ) {

			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	/**
	 * Downloads a URL (through the download cache) and loads it as `loadAssetFromFile` would —
	 * archives included. An ARCHIVE_NEEDS_ELEMENT error carries the downloaded `file` to retry with.
	 * @param {string} url
	 * @param {object} [options] - as loadAssetFromFile, plus `filename` to name the download and
	 *   `cacheKey` for URLs that expire (signed links)
	 */
	async loadAssetFromUrl( url, options = {} ) {

		const { filename = nameFromUrl( url ), cacheKey = url, cachePolicy, ...loadOptions } = options;
		if ( ! this.getFileFormat( filename ) ) throw this.formatError( filename );

		this._loadCancelled = false;
		const cancelable = AssetLoader._isNetworkUrl( url );
		const status = `Downloading ${filename}...`;
		const controller = new AbortController();
		this._urlAbort = controller;

		updateLoading( { isLoading: true, status, progress: 2, canCancel: cancelable, loadedBytes: 0, totalBytes: 0 } );

		let download;
		try {

			download = await this.downloads.fetch( url, {
				key: cacheKey, name: filename, policy: cachePolicy, signal: controller.signal,
				onProgress: this._downloadProgress( status, cancelable ),
			} );

		} catch ( error ) {

			if ( this._isCancellation( error ) ) throw this._cancellationError();
			throw error;

		} finally {

			this._urlAbort = null;

		}

		this._downloadComplete();

		try {

			return await this.loadAssetFromFile( download.file, loadOptions );

		} catch ( error ) {

			if ( error?.code === 'ARCHIVE_NEEDS_ELEMENT' ) error.file = download.file;
			throw error;

		} finally {

			download.release();

		}

	}

	async loadModelFromFile( file, filename ) {

		const key = this.storage ? this._keyed( 'file', identityKey( await fileIdentity( file ) ) ) : null;
		const result = await this._loadModelFileByExtension( file, filename );
		this._sourceKey = key;
		return result;

	}

	async _loadModelFileByExtension( file, filename ) {

		const extension = filename.split( '.' ).pop().toLowerCase();
		if ( extension === 'glb' || extension === 'gltf' ) return await this.loadGLBFromArrayBuffer( await this.readFileAsArrayBuffer( file ), filename );

		const format = this._formats.get( extension );
		if ( format?.type !== 'model' ) throw this.formatError( filename );
		return await this._loadModelWithFormat( format, file, filename );

	}

	async _loadModelWithFormat( format, file, filename ) {

		try {

			updateLoading( { isLoading: true, status: `Processing ${format.label} Data...`, progress: 5 } );
			await new Promise( r => setTimeout( r, 0 ) );

			const { model, result = model } = await format.parse( file, { filename, cache: this.loaderCache } );
			this.releaseTargetModel();
			this.targetModel = model;

			updateLoading( { isLoading: true, status: "Processing Data...", progress: 10 } );
			await this.onModelLoad( this.targetModel );

			this.dispatchEvent( { type: 'load', model, filename } );
			return result;

		} catch ( error ) {

			console.error( `Error loading ${format.label}:`, error );
			this.dispatchEvent( { type: 'error', message: error.message, filename } );
			throw error;

		}

	}

	async loadEnvironmentFromFile( file, filename ) {

		const url = URL.createObjectURL( file );
		this.uploadedFileInfo = { name: filename, type: file.type, size: file.size };
		try {

			const texture = await this.loadEnvironment( url );
			setEnvironmentSource( texture, identityKey( await fileIdentity( file ) ) );
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
			if ( AssetLoader._isNetworkUrl( envUrl ) ) setEnvironmentSource( texture, envUrl );

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

	/**
	 * @param {string} url
	 * @param {string} extension
	 * @param {{loader?: Object}} [options] - a three.js loader to read the file with, for a format nothing registered
	 */
	async loadEnvironmentByExtension( url, extension, { loader = null } = {} ) {

		const format = this._formats.get( extension );
		if ( ! loader && format?.type === 'environment' ) loader = this.loaderCache[ extension ] ??= await format.createLoader( this._loadingManager );
		if ( ! loader && extension === 'hdr' ) loader = this.loaderCache.hdr ??= new HDRLoader( this._loadingManager ).setDataType( FloatType );
		if ( ! loader && ADDON_FORMATS[ extension ] ) throw this.formatError( `environment.${extension}` );

		const cancelable = AssetLoader._isNetworkUrl( url );
		const status = "Downloading Environment...";
		const source = await this._viaCache( url, status, cancelable );
		const onProgress = source.cached ? undefined : this._downloadProgress( status, cancelable );

		let texture;
		try {

			if ( loader ) {

				texture = await loader.loadAsync( source.url, onProgress );

			} else if ( getPlatform().decodeImage ) {

				texture = await loadPlatformImage( source.url, `image/${extension === 'jpg' ? 'jpeg' : extension}` );
				texture.colorSpace = SRGBColorSpace;

			} else {

				if ( ! this.loaderCache.texture ) this.loaderCache.texture = new TextureLoader( this._loadingManager );
				texture = await this.loaderCache.texture.loadAsync( source.url, onProgress );
				// LDR env maps (jpg/png/webp) are authored in sRGB; tag them so the backend
				// decodes to linear. HDR/EXR are already linear and keep the loader's setting.
				texture.colorSpace = SRGBColorSpace;

			}

		} finally {

			source.release();

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

	// Returns a fresh loader each call — the DRACOLoader/KTX2Loader a file needs hold persistent
	// worker pools. Callers must invoke _disposeGLTFLoader() to terminate them.
	async createGLTFLoader() {

		const loader = decodersOnDemand( new GLTFLoader( this._loadingManager ), this.renderer );
		const onImageFailure = ( where, error ) => this._reportImageFailure( where, error );
		if ( getPlatform().decodeImage ) loader.register( ( parser ) => platformImagesPlugin( parser, onImageFailure ) );
		else if ( ! hasImageDecoder() ) loader.register( ( parser ) => missingImageDecoderPlugin( parser, onImageFailure ) );
		loader.register( ( parser ) => diffuseTransmissionPlugin( parser ) );

		return loader;

	}

	// GLTFLoader swallows the failure and loads the model untextured, so a strict host's throw is kept
	// for the end of the load (_throwDeferred).
	_reportImageFailure( where, error ) {

		try {

			this._issues?.record(
				ISSUE_CODES.TEXTURE_BUILD_FAILED,
				`image ${where} could not be decoded (${error?.message ?? error}) — the surfaces using it render untextured`,
				{ image: where, cause: String( error?.message ?? error ) }
			);

		} catch ( strictError ) {

			this._deferredError ??= strictError;

		}

	}

	_throwDeferred() {

		const error = this._deferredError;
		this._deferredError = null;
		if ( error ) throw error;

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

	/**
	 * @param {string} modelUrl
	 * @param {{cacheKey?: string, cachePolicy?: string}} [options] - key a download cache entry by
	 *   something steadier than a signed, expiring URL
	 */
	async loadModel( modelUrl, options = {} ) {

		this._loadCancelled = false;
		const loader = await this.createGLTFLoader();
		const cancelable = AssetLoader._isNetworkUrl( modelUrl );
		let source = null;

		try {

			updateLoading( { isLoading: true, status: "Downloading Model...", progress: 2, canCancel: cancelable, loadedBytes: 0, totalBytes: 0 } );
			source = await this._viaCache( modelUrl, "Downloading Model...", cancelable, options );
			if ( source.cached ) loader.setResourcePath( LoaderUtils.extractUrlBase( modelUrl ) );
			const data = await withHostWorker( () => loader.loadAsync( source.url, source.cached ? undefined : this._downloadProgress( "Downloading Model...", cancelable ) ) );
			this._downloadComplete();
			this._throwDeferred();

			this.releaseTargetModel();
			this._sourceKey = cancelable ? this._keyed( 'url', options.cacheKey ?? modelUrl ) : null;

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

			source?.release();
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
	async appendModel( url, options = {} ) {

		this._loadCancelled = false;
		const loader = await this.createGLTFLoader();
		const cancelable = AssetLoader._isNetworkUrl( url );
		let source = null;

		try {

			updateLoading( { isLoading: true, status: "Downloading Model...", progress: 2, canCancel: cancelable, loadedBytes: 0, totalBytes: 0 } );
			source = await this._viaCache( url, "Downloading Model...", cancelable, options );
			if ( source.cached ) loader.setResourcePath( LoaderUtils.extractUrlBase( url ) );
			const data = await withHostWorker( () => loader.loadAsync( source.url, source.cached ? undefined : this._downloadProgress( "Downloading Model...", cancelable ) ) );
			this._downloadComplete();
			this._throwDeferred();
			this._appended = true;
			this._processAndParent( data.scene );
			return { root: data.scene, animations: data.animations || [] };

		} catch ( error ) {

			if ( this._isCancellation( error ) ) throw this._cancellationError();
			throw error;

		} finally {

			source?.release();
			this._disposeGLTFLoader( loader );

		}

	}

	// Append a copy of a caller-owned Object3D without releasing prior models or reframing.
	appendObject3D( object3d, name = 'object3d' ) {

		this._appended = true;

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

			const data = await withHostWorker( () => loader.parseAsync( arrayBuffer, '' ) );
			this._throwDeferred();

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

		this.controls?.target.copy( center );

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
		if ( this.controls ) {

			this.controls.maxDistance = cameraDistance * 10;
			this.controls.saveState();
			this.controls.update();

		}

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
		this.sceneSize.copy( size );

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
				// The clip animates the original; this lets the copy follow it.
				camera.userData.__rayzeeSourceUuid = object.uuid;

				// Apply world transforms — cameras may be children of
				// transformed nodes, so local position/quaternion != world.
				object.getWorldPosition( camera.position );
				object.getWorldQuaternion( camera.quaternion );

				// Keep only the sign of the world scale. A camera has no meaningful
				// size, but a negative axis is a mirror — a pbrt scene's `Scale -1 1 1`
				// lives here — and dropping it silently un-flips the view. decompose()
				// parks any mirror on x, so this lands as (±1, 1, 1).
				object.getWorldScale( camera.scale );
				camera.scale.set(
					Math.sign( camera.scale.x ) || 1,
					Math.sign( camera.scale.y ) || 1,
					Math.sign( camera.scale.z ) || 1
				);

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

		// Split after the walk: traverse() caches children.length, so splitting in place
		// shifts later siblings down a slot and skips one.
		const multiMaterialMeshes = [];
		const skippedPlaceholders = [];
		model.traverse( ( object ) => {

			const userData = object.userData;

			// An adopted light carries three.js units; convert as point/spot are below.
			if ( object.isRectAreaLight && ! userData.__radianceConverted ) {

				object.intensity *= areaLightPowerFactor( object, object.width, object.height, userData );
				userData.__radianceConverted = true;

			}

			// Punctual lights arrive photometric: glTF (and three.js) state point/spot in
			// candela and directional in lux. The engine is radiometric Blender Watts, which
			// LightSerializer turns into W/sr with ÷4π, so the luminous efficacy has to be
			// divided back out — Blender's own glTF importer does exactly this. Skipping it
			// rendered every Blender lamp 683x too bright.
			if ( ( object.isPointLight || object.isSpotLight ) && ! userData.__candelaConverted ) {

				object.intensity *= 4 * Math.PI / LUMENS_PER_WATT;
				userData.__candelaConverted = true;

			}

			if ( object.isDirectionalLight && ! userData.__luxConverted ) {

				object.intensity /= LUMENS_PER_WATT;
				userData.__luxConverted = true;

			}

			const placeholder = object.name.startsWith( 'RectAreaLightPlaceholder' );
			if ( placeholder && ! ( userData.name && userData.type === 'RectAreaLight' )
				&& ! object.parent?.name?.startsWith( 'RectAreaLightPlaceholder' ) ) skippedPlaceholders.push( object.name );

			// Process ceiling lights
			if ( placeholder && userData.name ) {

				if ( userData.type === 'RectAreaLight' ) {

					const normalize = userData.normalize ?? true;
					const shape = userData.shape ?? 'rectangle';
					const power = userData.intensity * areaLightPowerFactor( object, userData.width, userData.height, userData );
					const light = new RectAreaLight(
						new Color( ...userData.color ),
						power * this._areaLightIntensityScale(),
						userData.width,
						userData.height
					);
					light.userData.normalize = normalize;
					light.userData.spread = Number.isFinite( userData.spread ) ? userData.spread : Math.PI;
					light.userData.shape = shape;
					light.userData.__radianceConverted = true; // already power, and traverse() reaches it
					light.name = userData.name;
					object.add( light );

				}

			}

			// Handle multi-material meshes
			if ( object.isMesh && Array.isArray( object.material ) ) {

				multiMaterialMeshes.push( object );

			}

		} );

		if ( skippedPlaceholders.length ) {

			this._issues?.record(
				ISSUE_CODES.LIGHT_PLACEHOLDER_SKIPPED,
				`${skippedPlaceholders.length} area-light placeholder(s) lack userData.name or userData.type 'RectAreaLight' — no light was made for them`,
				{ count: skippedPlaceholders.length, names: skippedPlaceholders.slice( 0, 10 ) }
			);

		}

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

	/** The loaded model's bounding-box size along x, y and z, in scene units. */
	getSceneSize() {

		return this.sceneSize.clone();

	}

	getTargetModel() {

		return this.targetModel;

	}

	getSupportedFormats( type = null ) {

		const formats = { ...CORE_FORMATS, ...this._archiveFormats };
		for ( const [ extension, { type, name } ] of this._formats ) formats[ extension ] = { type, name };
		if ( type ) {

			const filtered = {};
			for ( const [ ext, info ] of Object.entries( formats ) ) {

				if ( info.type === type ) filtered[ ext ] = info;

			}

			return filtered;

		}

		return formats;

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
		this._urlAbort?.abort();
		this._urlAbort = null;
		this.storage = null;
		this._downloads = null;
		this.archives?.release();
		this.archives = null;
		this._archiveLoader = null;

		this.releaseTargetModel();

	}

	removeAllEventListeners() {

		this._listeners = undefined;

	}

}

