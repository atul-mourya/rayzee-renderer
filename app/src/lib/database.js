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
const versionKey = ( id, n ) => `render:${id}:v${n}`;

const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
const versionFile = ( n, type ) => `ai-${n}.${EXTENSIONS[ type ] ?? 'png'}`;

/** A render's AI versions, oldest first; an earlier build's single AI image reads as version 1. */
function versionsOf( record ) {

	if ( record.aiVersions ) return record.aiVersions;
	const legacy = record.aiGeneratedImage || record.blobs?.[ RENDER_FILES.AI ] || record.files?.includes( RENDER_FILES.AI );
	return legacy ? [ { n: 1, file: RENDER_FILES.AI, prompt: record.aiPrompt ?? '', legacy: true } ] : [];

}

const nextVersion = ( record, versions ) => record.aiNext ?? versions.reduce( ( m, v ) => Math.max( m, v.n ), 0 ) + 1;

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
async function writeFiles( id, files ) {

	const area = rendersArea();
	if ( ! area ) return null;

	const present = Object.entries( files ).filter( ( [ , blob ] ) => blob );
	const bytes = present.reduce( ( n, [ , blob ] ) => n + blob.size, 0 );
	const writer = await area.create( renderKey( id ), { label: `Render ${id}`, expectedBytes: bytes } );
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
	for ( const url of [ urls.image, urls.thumb, ...Object.values( urls.versions ) ] ) if ( url ) URL.revokeObjectURL( url );
	urlCache.delete( id );

}

async function versionBlob( record, version ) {

	if ( version.legacy ) return typeof record.aiGeneratedImage === 'string' ? toBlob( record.aiGeneratedImage ) : fileOf( record, RENDER_FILES.AI );
	if ( record.blobs?.[ version.file ] ) return record.blobs[ version.file ];

	const entry = await rendersArea()?.open( versionKey( record.id, version.n ) );
	if ( ! entry ) return null;
	try {

		return await entry.file( version.file );

	} finally {

		entry.release();

	}

}

/** Writes a version into an entry of its own, so deleting it frees its space. */
async function writeVersion( id, version, blob ) {

	const writer = await rendersArea()?.create( versionKey( id, version.n ), { label: `Render ${id} v${version.n}`, expectedBytes: blob.size } );
	if ( ! writer ) return false;

	try {

		await writer.writeFile( version.file, blob );
		await writer.commit();
		return true;

	} catch ( error ) {

		await writer.abort();
		log.warn( `Could not store version ${version.n} of render ${id} as a file, keeping it in the database:`, error );
		return false;

	}

}

/** What the Results UI reads: the record, with `image`, `thumb` and each AI version's `url` as URLs. */
async function toView( record ) {

	const versions = versionsOf( record );

	if ( typeof record.image === 'string' ) {

		const { aiGeneratedImage, ...rest } = record;
		return { ...rest, thumb: record.image, hasHDR: false, aiVersions: versions.map( v => ( { ...v, url: aiGeneratedImage } ) ) };

	}

	let urls = urlCache.get( record.id );
	const url = async ( blob ) => blob ? URL.createObjectURL( blob ) : null;
	if ( ! urls ) {

		urls = { image: await url( await fileOf( record, RENDER_FILES.IMAGE ) ), thumb: await url( await fileOf( record, RENDER_FILES.THUMB ) ), versions: {} };
		urlCache.set( record.id, urls );

	}

	for ( const version of versions ) urls.versions[ version.n ] ??= await url( await versionBlob( record, version ) );

	const has = ( name ) => !! ( record.blobs?.[ name ] || record.files?.includes( name ) );
	return {
		...withoutImages( record ),
		image: urls.image,
		thumb: urls.thumb ?? urls.image,
		aiVersions: versions.map( v => ( { ...v, url: urls.versions[ v.n ] } ) ).filter( v => v.url ),
		hasHDR: has( RENDER_FILES.HDR ),
	};

}

/**
 * Save a render.
 * @param {{image: Blob|string, hdr?: Blob|Uint8Array, colorCorrection?: Object, renderTime?: number,
 *   isEdited?: boolean, aiVersions?: Array<Object>, aiPrompt?: string, aiGeneratedImage?: Blob|string, timestamp?: Date}} data
 *   `aiVersions` are the details `addAIVersion` keeps, each with its `blob`; an earlier export's single AI image comes as
 *   `aiGeneratedImage` and `aiPrompt`.
 * @returns {Promise<number>} the new render's id
 */
export const saveRender = async ( data ) => {

	const image = await toBlob( data.image );
	if ( ! image ) throw new Error( 'saveRender: no image' );

	const { thumb, width, height } = await makeThumbnail( image );
	const files = {
		[ RENDER_FILES.IMAGE ]: image,
		[ RENDER_FILES.THUMB ]: thumb,
		[ RENDER_FILES.HDR ]: await toBlob( data.hdr ),
	};

	const given = data.aiVersions ?? ( data.aiGeneratedImage ? [ { n: 1, prompt: data.aiPrompt ?? '', blob: data.aiGeneratedImage } ] : [] );
	const versions = [];
	for ( const { blob: source, legacy, file, url, ...meta } of given ) {

		const blob = await toBlob( source );
		if ( blob ) versions.push( { meta: { ...meta, file: versionFile( meta.n, blob.type ) }, blob } );

	}

	const record = {
		timestamp: data.timestamp ?? new Date(),
		renderTime: data.renderTime ?? null,
		isEdited: data.isEdited ?? false,
		colorCorrection: { ...data.colorCorrection },
		width,
		height,
	};
	if ( versions.length ) {

		record.aiVersions = versions.map( v => v.meta );
		record.aiNext = versions.reduce( ( m, v ) => Math.max( m, v.meta.n ), 0 ) + 1;

	}

	const id = await request( ( await store( 'readwrite' ) ).add( record ) );
	const names = await writeFiles( id, files );
	if ( names ) record.files = names;
	else record.blobs = Object.fromEntries( Object.entries( files ).filter( ( [ , blob ] ) => blob ) );
	for ( const { meta, blob } of versions ) {

		if ( ! names || ! await writeVersion( id, meta, blob ) ) record.blobs = { ...record.blobs, [ meta.file ]: blob };

	}

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
		// One unreadable render leaves the rest listed.
		const views = await Promise.all( shown.map( ( record ) => toView( record ).catch( ( error ) => {

			log.error( `Could not read render ${record.id}:`, error );
			return null;

		} ) ) );
		return views.filter( Boolean );

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

	const record = await getRecord( id );
	await request( ( await store( 'readwrite' ) ).delete( id ) );
	forget( id );
	const area = rendersArea();
	await area?.remove( renderKey( id ) );
	for ( const version of record ? versionsOf( record ) : [] ) if ( ! version.legacy ) await area?.remove( versionKey( id, version.n ) );
	log.debug( `Render with ID ${id} deleted` );
	return true;

};

/** An earlier build's record, its images in data URLs, turned into one keeping Blobs. */
async function withBlobs( record ) {

	if ( typeof record.image !== 'string' ) return record;
	const image = await toBlob( record.image );
	const { thumb, width, height } = await makeThumbnail( image );
	const blobs = { [ RENDER_FILES.IMAGE ]: image, [ RENDER_FILES.THUMB ]: thumb };
	if ( record.aiGeneratedImage ) blobs[ RENDER_FILES.AI ] = await toBlob( record.aiGeneratedImage );
	forget( record.id );
	return { ...withoutImages( record ), width, height, blobs };

}

/**
 * Adds an AI version to a render.
 * @param {number} id
 * @param {{blob: Blob, prompt: string} & Object} version its picture and the details shown with it
 * @returns {Promise<number>} the version's number
 */
export const addAIVersion = async ( id, { blob, ...meta } ) => {

	const found = await getRecord( id );
	if ( ! found ) throw new Error( `Render with ID ${id} not found` );

	const record = await withBlobs( found );
	const versions = versionsOf( record );
	const n = nextVersion( record, versions );
	const version = { ...meta, n, file: versionFile( n, blob.type ), createdAt: meta.createdAt ?? Date.now() };
	const next = { ...record, aiVersions: [ ...versions, version ], aiNext: n + 1 };
	if ( ! await writeVersion( id, version, blob ) ) next.blobs = { ...next.blobs, [ version.file ]: blob };

	await putRecord( next );
	return n;

};

export const deleteAIVersion = async ( id, n ) => {

	const record = await getRecord( id );
	if ( ! record ) throw new Error( `Render with ID ${id} not found` );
	const versions = versionsOf( record );
	const version = versions.find( v => v.n === n );
	if ( ! version ) return false;

	const rest = versions.filter( v => v !== version );
	// Numbers are not reused while versions remain; with none left the next is v1 again.
	const next = { ...record, aiVersions: rest, aiNext: rest.length ? nextVersion( record, versions ) : undefined };
	if ( next.blobs?.[ version.file ] ) {

		next.blobs = { ...next.blobs };
		delete next.blobs[ version.file ];

	}

	// An earlier build's file sits in the render's own entry, which cannot drop one file: it stays until the render goes.
	if ( version.legacy ) delete next.aiGeneratedImage;
	else await rendersArea()?.remove( versionKey( id, n ) );

	await putRecord( next );
	const urls = urlCache.get( id );
	if ( urls?.versions[ n ] ) {

		URL.revokeObjectURL( urls.versions[ n ] );
		delete urls.versions[ n ];

	}

	return true;

};

export const getAIVersionFile = async ( id, n ) => {

	const record = await getRecord( id );
	const version = record && versionsOf( record ).find( v => v.n === n );
	return version ? versionBlob( record, version ) : null;

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

	const out = {};
	if ( typeof record.image === 'string' ) out[ RENDER_FILES.IMAGE ] = await toBlob( record.image );
	else {

		for ( const name of [ RENDER_FILES.IMAGE, RENDER_FILES.THUMB, RENDER_FILES.HDR ] ) {

			const file = await fileOf( record, name );
			if ( file ) out[ name ] = file;

		}

	}

	for ( const version of versionsOf( record ) ) {

		const blob = await versionBlob( record, version );
		if ( blob ) out[ version.file ] = blob;

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
		const kept = {};
		for ( const version of versionsOf( record ) ) {

			if ( version.legacy || ! files[ version.file ] ) continue;
			if ( ! await writeVersion( record.id, version, files[ version.file ] ) ) kept[ version.file ] = files[ version.file ];
			delete files[ version.file ];

		}

		let size = { width: record.width, height: record.height };
		if ( ! files[ RENDER_FILES.THUMB ] ) {

			const made = await makeThumbnail( image );
			files[ RENDER_FILES.THUMB ] = made.thumb;
			size = { width: made.width, height: made.height };

		}

		const names = await writeFiles( record.id, files );
		if ( ! names ) break;

		const next = { ...withoutImages( record ), ...size, files: names };
		if ( Object.keys( kept ).length ) next.blobs = kept;
		await putRecord( next );
		forget( record.id );
		moved ++;

	}

	const known = new Set( records.flatMap( ( r ) => [ renderKey( r.id ), ...versionsOf( r ).filter( v => ! v.legacy ).map( v => versionKey( r.id, v.n ) ) ] ) );
	for ( const entry of await area.list() ) if ( ! known.has( entry.key ) ) await area.removeById( entry.id );

	if ( moved > 0 ) {

		log.info( `Moved ${moved} saved render${moved > 1 ? 's' : ''} onto files` );
		window.dispatchEvent( new Event( 'render-saved' ) );

	}

	return moved;

}
