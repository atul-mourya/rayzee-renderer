/**
 * Web Worker for AI Upscaler inference.
 * Handles ONNX model loading and tile-based inference off the main thread.
 *
 * Messages:
 *   Main → Worker:
 *     { type: 'load', url, sessionOptions }  — load/switch model
 *     { type: 'infer', tileData, width, height, id }  — run inference on a tile
 *     { type: 'dispose' }  — release session
 *
 *   Worker → Main:
 *     { type: 'loaded', backend }
 *     { type: 'inferred', outputData, id }
 *     { type: 'error', message, id? }
 */

import { openInlineStorage } from '../../Storage/StorageManager.js';
import { DownloadCache } from '../../Storage/DownloadCache.js';

// Asset config supplied via 'load' message from the main thread.
// Defaults match the upstream Rayzee deployment; override via configureAssets().
let _assetConfig = {
	ortRuntimeUrl: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort.webgpu.bundle.min.mjs',
	ortWasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/',
	cacheNamespace: 'rayzee',
	storage: 'auto',
};

let ort = null;

async function getOrt() {

	if ( ort ) return ort;

	ort = await import( /* @vite-ignore */ _assetConfig.ortRuntimeUrl );

	// WASM paths for CDN delivery — WebGPU EP still uses WASM for lightweight shape ops
	ort.env.wasm.wasmPaths = _assetConfig.ortWasmPaths;
	ort.env.logLevel = 'error';

	return ort;

}

let session = null;
let currentModelUrl = null;
let downloads = null;

// ─── Model cache (the engine's download storage, written from this worker) ─────

function getDownloads() {

	downloads ??= ( async () => {

		if ( _assetConfig.storage === false || ! navigator.storage?.getDirectory ) return new DownloadCache( null );

		try {

			const top = await navigator.storage.getDirectory();
			const root = await top.getDirectoryHandle( _assetConfig.cacheNamespace, { create: true } );
			const storage = openInlineStorage( { namespace: _assetConfig.cacheNamespace, root } );
			await migrateIndexedDB( storage ).catch( () => {} );
			return new DownloadCache( storage );

		} catch {

			return new DownloadCache( null );

		}

	} )();

	return downloads;

}

// Earlier builds kept models in IndexedDB: move them across once, then drop the database.
async function migrateIndexedDB( storage ) {

	const name = `${_assetConfig.cacheNamespace}:ai-upscaler-models`;
	if ( typeof indexedDB === 'undefined' || ! indexedDB.databases ) return;
	if ( ! ( await indexedDB.databases() ).some( ( d ) => d.name === name ) ) return;

	const entries = await new Promise( ( resolve, reject ) => {

		const open = indexedDB.open( name );
		open.onerror = () => reject( open.error );
		open.onsuccess = () => {

			const db = open.result;
			if ( ! db.objectStoreNames.contains( 'models' ) ) {

				db.close();
				resolve( [] );
				return;

			}

			const out = [];
			const cursor = db.transaction( 'models', 'readonly' ).objectStore( 'models' ).openCursor();
			cursor.onerror = () => reject( cursor.error );
			cursor.onsuccess = () => {

				const c = cursor.result;
				if ( ! c ) {

					db.close();
					resolve( out );
					return;

				}

				out.push( [ c.key, c.value ] );
				c.continue();

			};

		};

	} );

	const area = storage.area( 'downloads' );
	for ( const [ url, buffer ] of entries ) {

		if ( typeof url !== 'string' || ! ( buffer instanceof ArrayBuffer ) || await area.has( url ) ) continue;
		const writer = await area.create( url, { label: url.split( '/' ).pop(), expectedBytes: buffer.byteLength } );
		if ( ! writer ) continue;
		await writer.write( 'data', buffer, { transfer: true } );
		await writer.commit( { url, contentType: 'application/octet-stream', checkedAt: Date.now() } );

	}

	await new Promise( ( resolve ) => {

		const request = indexedDB.deleteDatabase( name );
		request.onsuccess = request.onerror = request.onblocked = () => resolve();

	} );

}

// ─── Model Loading ───────────────────────────────────────────────────────────

async function fetchModel( url ) {

	const { file, release, fromCache } = await ( await getDownloads() ).fetch( url );

	try {

		const buffer = await file.arrayBuffer();
		if ( fromCache ) console.log( `AI Upscaler Worker: model loaded from cache (${( buffer.byteLength / 1024 / 1024 ).toFixed( 1 )}MB)` );
		return buffer;

	} finally {

		release();

	}

}

async function loadModel( url, sessionOptions ) {

	if ( session && currentModelUrl === url ) {

		const backend = 'webgpu';
		self.postMessage( { type: 'loaded', backend } );
		return;

	}

	// Dispose previous session
	if ( session ) {

		await session.release();
		session = null;

	}

	const [ modelBuffer, ortLib ] = await Promise.all( [ fetchModel( url ), getOrt() ] );

	session = await ortLib.InferenceSession.create( modelBuffer, sessionOptions );
	currentModelUrl = url;

	// Detect GPU and recommend tile size based on device type
	let tileSize = 512; // default
	try {

		const adapter = await navigator.gpu?.requestAdapter();
		const info = await adapter?.requestAdapterInfo?.() || adapter?.info;
		const isMobile = /apple|swiftshader|llvmpipe/i.test( info?.vendor || '' )
			|| /apple|swiftshader/i.test( info?.architecture || '' );
		const isIntegrated = info?.device?.toLowerCase?.()?.includes( 'integrated' )
			|| /intel.*iris|intel.*uhd|intel.*hd|amd.*vega|radeon.*graphics/i.test( info?.description || '' );

		if ( isMobile ) {

			tileSize = 128;

		} else if ( isIntegrated ) {

			tileSize = 256;

		} else {

			tileSize = 512;

		}

		console.log( `AI Upscaler Worker: GPU="${info?.description || info?.device || 'unknown'}", tileSize=${tileSize}` );

	} catch { /* fallback to default */ }

	const sizeMB = ( modelBuffer.byteLength / 1024 / 1024 ).toFixed( 1 );
	console.log( `AI Upscaler Worker: model loaded (${sizeMB}MB), backend: webgpu` );

	self.postMessage( { type: 'loaded', backend: 'webgpu', tileSize } );

}

async function inferTile( tileData, width, height, id ) {

	const ortLib = await getOrt();
	const inputName = session.inputNames[ 0 ];
	const outputName = session.outputNames[ 0 ];
	const inputTensor = new ortLib.Tensor( 'float32', tileData, [ 1, 3, height, width ] );

	const results = await session.run( { [ inputName ]: inputTensor } );
	const outputData = results[ outputName ].data;

	// Transfer the output buffer (zero-copy)
	self.postMessage( { type: 'inferred', outputData, id }, [ outputData.buffer ] );

}

self.onmessage = async ( e ) => {

	const { type } = e.data;

	try {

		if ( type === 'load' ) {

			// Apply asset overrides from main thread before any network or cache access
			if ( e.data.ortRuntimeUrl ) _assetConfig.ortRuntimeUrl = e.data.ortRuntimeUrl;
			if ( e.data.ortWasmPaths ) _assetConfig.ortWasmPaths = e.data.ortWasmPaths;
			if ( e.data.cacheNamespace ) _assetConfig.cacheNamespace = e.data.cacheNamespace;
			if ( e.data.storage !== undefined ) _assetConfig.storage = e.data.storage;
			await loadModel( e.data.url, e.data.sessionOptions );

		} else if ( type === 'infer' ) {

			await inferTile( e.data.tileData, e.data.width, e.data.height, e.data.id );

		} else if ( type === 'dispose' ) {

			if ( session ) {

				await session.release();
				session = null;
				currentModelUrl = null;

			}

		}

	} catch ( error ) {

		self.postMessage( { type: 'error', message: error.message, id: e.data?.id } );

	}

};
