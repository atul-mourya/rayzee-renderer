// database.js — the Results library. IndexedDB holds each render's details; its images are files
// in on-disk storage (`renders` area), or Blobs in the record when the browser offers no storage.
import { createLogger } from 'rayzee';
import { getStorage, APP_AREAS } from '@/lib/storage';

const log = createLogger( 'db' );

const DB_NAME = 'RenderResultsDB';
const DB_VERSION = 4;
const STORE_NAME = 'renders';
const THUMB_EDGE = 320;

export const RENDER_FILES = Object.freeze( { IMAGE: 'image.png', THUMB: 'thumb.webp', AI: 'ai.png', HDR: 'hdr.exr' } );

let dbPromise = null;
let migration = null;
const urlCache = new Map();

function openAt( version ) {

	return new Promise( ( resolve, reject ) => {

		const request = version ? indexedDB.open( DB_NAME, version ) : indexedDB.open( DB_NAME );
		request.onupgradeneeded = () => {

			const db = request.result;
			if ( ! db.objectStoreNames.contains( STORE_NAME ) ) {

				const store = db.createObjectStore( STORE_NAME, { keyPath: 'id', autoIncrement: true } );
				store.createIndex( 'timestamp', 'timestamp', { unique: false } );

			}

		};

		request.onsuccess = () => resolve( request.result );
		request.onerror = () => reject( request.error );

	} );

}

function getDatabase() {

	dbPromise ??= ( async () => {

		if ( typeof indexedDB === 'undefined' ) throw new Error( "This browser doesn't support IndexedDB" );
		try {

			return await openAt( DB_VERSION );

		} catch ( error ) {

			// A newer build already upgraded it: open whatever version is there.
			if ( error?.name === 'VersionError' ) return openAt( null );
			throw error;

		}

	} )();

	dbPromise.catch( () => {

		dbPromise = null;

	} );

	return dbPromise;

}

function request( req ) {

	return new Promise( ( resolve, reject ) => {

		req.onsuccess = () => resolve( req.result );
		req.onerror = () => reject( req.error );

	} );

}

async function store( mode ) {

	return ( await getDatabase() ).transaction( STORE_NAME, mode ).objectStore( STORE_NAME );

}

const getRecord = async ( id ) => request( ( await store( 'readonly' ) ).get( id ) );
const putRecord = async ( record ) => request( ( await store( 'readwrite' ) ).put( record ) );

export const initDatabase = () => getDatabase();

/**
 * Once storage is open: moves records that still carry their images (base64 from earlier builds,
 * or Blobs saved while storage was unavailable) onto files, and drops files whose record is gone.
 */
export function startRenderMaintenance() {

	migration ??= maintain().catch( ( error ) => log.warn( 'Saved-render maintenance failed:', error ) );
	return migration;

}

const renderKey = ( id ) => `render:${id}`;

const IMAGE_FIELDS = [ 'image', 'aiGeneratedImage', 'blobs', 'files' ];

function withoutImages( record, keep = [] ) {

	const out = { ...record };
	for ( const field of IMAGE_FIELDS ) if ( ! keep.includes( field ) ) delete out[ field ];
	return out;

}

function rendersArea() {

	return getStorage()?.area( APP_AREAS.RENDERS ) ?? null;

}

async function toBlob( image ) {

	if ( image instanceof Blob ) return image;
	if ( typeof image === 'string' ) return ( await fetch( image ) ).blob();
	if ( image instanceof Uint8Array || image instanceof ArrayBuffer ) return new Blob( [ image ] );
	return null;

}

function blobToDataURL( blob ) {

	return new Promise( ( resolve, reject ) => {

		const reader = new FileReader();
		reader.onload = () => resolve( reader.result );
		reader.onerror = () => reject( reader.error );
		reader.readAsDataURL( blob );

	} );

}

/** A small WebP for the list, and the image's size. */
export async function makeThumbnail( blob ) {

	const bitmap = await createImageBitmap( blob );
	const { width, height } = bitmap;
	const scale = Math.min( 1, THUMB_EDGE / Math.max( width, height ) );
	const canvas = new OffscreenCanvas( Math.max( 1, Math.round( width * scale ) ), Math.max( 1, Math.round( height * scale ) ) );
	canvas.getContext( '2d' ).drawImage( bitmap, 0, 0, canvas.width, canvas.height );
	bitmap.close();
	return { thumb: await canvas.convertToBlob( { type: 'image/webp', quality: 0.82 } ), width, height };

}

/** Writes files into the render's storage entry; resolves the names written, or null to keep them in IndexedDB. */
async function writeFiles( id, files, { edit = false } = {} ) {

	const area = rendersArea();
	if ( ! area ) return null;

	const present = Object.entries( files ).filter( ( [ , blob ] ) => blob );
	const bytes = present.reduce( ( n, [ , blob ] ) => n + blob.size, 0 );
	const writer = edit
		? await area.edit( renderKey( id ) )
		: await area.create( renderKey( id ), { label: `Render ${id}`, expectedBytes: bytes } );
	if ( ! writer ) return null;

	try {

		for ( const [ name, blob ] of present ) await writer.writeFile( name, blob );
		const meta = await writer.commit();
		return Object.keys( meta.files );

	} catch ( error ) {

		await writer.abort();
		log.warn( `Could not store render ${id} as files, keeping it in the database:`, error );
		return null;

	}

}

async function fileOf( record, name ) {

	if ( record.blobs?.[ name ] ) return record.blobs[ name ];
	if ( ! record.files?.includes( name ) ) return null;

	const entry = await rendersArea()?.open( renderKey( record.id ) );
	if ( ! entry ) return null;
	try {

		return await entry.file( name );

	} finally {

		entry.release();

	}

}

function forget( id ) {

	const urls = urlCache.get( id );
	if ( ! urls ) return;
	for ( const url of Object.values( urls ) ) if ( url ) URL.revokeObjectURL( url );
	urlCache.delete( id );

}

/** What the Results UI reads: the record, with `image`, `thumb` and `aiGeneratedImage` as URLs. */
async function toView( record ) {

	if ( typeof record.image === 'string' ) {

		return { ...record, thumb: record.image, hasHDR: false };

	}

	let urls = urlCache.get( record.id );
	if ( ! urls ) {

		const url = async ( name ) => {

			const file = await fileOf( record, name );
			return file ? URL.createObjectURL( file ) : null;

		};

		urls = { image: await url( RENDER_FILES.IMAGE ), thumb: await url( RENDER_FILES.THUMB ), ai: await url( RENDER_FILES.AI ) };
		urlCache.set( record.id, urls );

	}

	const has = ( name ) => !! ( record.blobs?.[ name ] || record.files?.includes( name ) );
	return {
		...withoutImages( record ),
		image: urls.image,
		thumb: urls.thumb ?? urls.image,
		aiGeneratedImage: urls.ai,
		hasHDR: has( RENDER_FILES.HDR ),
	};

}

/**
 * Save a render.
 * @param {{image: Blob|string, hdr?: Blob|Uint8Array, colorCorrection?: Object, renderTime?: number,
 *   isEdited?: boolean, aiPrompt?: string, aiGeneratedImage?: Blob|string, timestamp?: Date}} data
 * @returns {Promise<number>} the new render's id
 */
export const saveRender = async ( data ) => {

	const image = await toBlob( data.image );
	if ( ! image ) throw new Error( 'saveRender: no image' );

	const { thumb, width, height } = await makeThumbnail( image );
	const files = {
		[ RENDER_FILES.IMAGE ]: image,
		[ RENDER_FILES.THUMB ]: thumb,
		[ RENDER_FILES.AI ]: await toBlob( data.aiGeneratedImage ),
		[ RENDER_FILES.HDR ]: await toBlob( data.hdr ),
	};

	const record = {
		timestamp: data.timestamp ?? new Date(),
		renderTime: data.renderTime ?? null,
		isEdited: data.isEdited ?? false,
		colorCorrection: { ...data.colorCorrection },
		aiPrompt: data.aiPrompt ?? null,
		width,
		height,
	};

	const id = await request( ( await store( 'readwrite' ) ).add( record ) );
	const names = await writeFiles( id, files );
	if ( names ) record.files = names;
	else record.blobs = Object.fromEntries( Object.entries( files ).filter( ( [ , blob ] ) => blob ) );
	await putRecord( { ...record, id } );

	log.debug( 'Render saved with ID:', id );
	return id;

};

/** Every render, newest first, ready for display. */
export const getAllRenders = async () => {

	try {

		const records = await request( ( await store( 'readonly' ) ).getAll() );
		const shown = records
			.filter( ( r ) => r && r.timestamp && ( r.image || r.files || r.blobs ) )
			.sort( ( a, b ) => new Date( b.timestamp ) - new Date( a.timestamp ) );
		return Promise.all( shown.map( toView ) );

	} catch ( error ) {

		log.error( 'Error in getAllRenders:', error );
		return [];

	}

};

export const getRenderById = async ( id ) => {

	const record = await getRecord( id );
	return record ? toView( record ) : null;

};

/** Updates a render's details in place — colour correction, edited flag — keeping its images. */
export const updateRender = async ( id, patch ) => {

	const record = await getRecord( id );
	if ( ! record ) throw new Error( `Render with ID ${id} not found` );
	await putRecord( { ...record, ...patch, id } );
	return true;

};

export const deleteRender = async ( id ) => {

	await request( ( await store( 'readwrite' ) ).delete( id ) );
	forget( id );
	await rendersArea()?.remove( renderKey( id ) );
	log.debug( `Render with ID ${id} deleted` );
	return true;

};

/** Attaches (or replaces) a render's AI-generated variant. */
export const updateRenderWithAI = async ( id, aiPrompt, aiGeneratedImage ) => {

	const record = await getRecord( id );
	if ( ! record ) throw new Error( `Render with ID ${id} not found` );

	if ( typeof record.image === 'string' ) {

		const dataUrl = typeof aiGeneratedImage === 'string' ? aiGeneratedImage : await blobToDataURL( await toBlob( aiGeneratedImage ) );
		await putRecord( { ...record, aiPrompt, aiGeneratedImage: dataUrl } );
		return true;

	}

	const blob = await toBlob( aiGeneratedImage );
	const next = { ...withoutImages( record, [ 'files', 'blobs' ] ), aiPrompt };

	const names = record.files ? await writeFiles( id, { [ RENDER_FILES.AI ]: blob }, { edit: true } ) : null;
	if ( names ) next.files = names;
	else next.blobs = { ...record.blobs, [ RENDER_FILES.AI ]: blob };

	await putRecord( next );
	forget( id );
	return true;

};

/** The render's HDR copy (EXR), when it kept one. */
export const getRenderHDR = async ( id ) => {

	const record = await getRecord( id );
	return record ? fileOf( record, RENDER_FILES.HDR ) : null;

};

/** Every file of a render, for export: name → Blob. */
export const getRenderFiles = async ( id ) => {

	const record = await getRecord( id );
	if ( ! record ) return {};
	if ( typeof record.image === 'string' ) {

		return Object.fromEntries( [
			[ RENDER_FILES.IMAGE, await toBlob( record.image ) ],
			[ RENDER_FILES.AI, await toBlob( record.aiGeneratedImage ) ],
		].filter( ( [ , blob ] ) => blob ) );

	}

	const out = {};
	for ( const name of Object.values( RENDER_FILES ) ) {

		const file = await fileOf( record, name );
		if ( file ) out[ name ] = file;

	}

	return out;

};

/** Raw details of every render, for export. */
export const getRenderRecords = async () => {

	const records = await request( ( await store( 'readonly' ) ).getAll() );
	return records.map( ( record ) => withoutImages( record ) );

};

async function maintain() {

	const area = rendersArea();
	if ( ! area ) return 0;

	const records = await request( ( await store( 'readonly' ) ).getAll() );
	let moved = 0;

	for ( const record of records ) {

		if ( record.files ) continue;

		const legacy = typeof record.image === 'string';
		const image = legacy ? await toBlob( record.image ) : record.blobs?.[ RENDER_FILES.IMAGE ];
		if ( ! image ) continue;

		const files = legacy
			? { [ RENDER_FILES.IMAGE ]: image, [ RENDER_FILES.AI ]: await toBlob( record.aiGeneratedImage ) }
			: { ...record.blobs };
		let size = { width: record.width, height: record.height };
		if ( ! files[ RENDER_FILES.THUMB ] ) {

			const made = await makeThumbnail( image );
			files[ RENDER_FILES.THUMB ] = made.thumb;
			size = { width: made.width, height: made.height };

		}

		const names = await writeFiles( record.id, files );
		if ( ! names ) break;

		await putRecord( { ...withoutImages( record ), ...size, files: names } );
		forget( record.id );
		moved ++;

	}

	const known = new Set( records.map( ( r ) => renderKey( r.id ) ) );
	for ( const entry of await area.list() ) if ( ! known.has( entry.key ) ) await area.removeById( entry.id );

	if ( moved > 0 ) {

		log.info( `Moved ${moved} saved render${moved > 1 ? 's' : ''} onto files` );
		window.dispatchEvent( new Event( 'render-saved' ) );

	}

	return moved;

}
