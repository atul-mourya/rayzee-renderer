import { createTarIndexer } from './ArchiveReader.js';
import { ENGINE_AREAS } from '../Storage/areas.js';
import { fileIdentity, identityKey } from '../Storage/identity.js';
import { ISSUE_CODES } from '../EngineIssues.js';

const INDEX_VERSION = 1;
// Scene text compresses 3-5×; reserving too little only means the write fails and falls back.
const GUESSED_EXPANSION = 3;

export async function archiveKey( kind, file ) {

	return `${kind}:${identityKey( await fileIdentity( file ) )}`;

}

/**
 * Decompresses a .tar.gz into storage once, indexing it on the way, and hands back the unpacked
 * .tar as a seekable File. A second call for the same file skips the work.
 *
 * With `filter` (and `part`, naming what it keeps) only the entries it keeps are written, end to end, and only they
 * get offsets in the listing: a 31 GB scene archive need not fit to load the part of it chosen. An unpack of the whole
 * archive serves any part.
 * @returns {Promise<?{file: File, index: {v:number, listing:Array}, release: function(): void, cached: boolean}>}
 *   null when storage cannot take it — the caller reads the archive the old way.
 */
export async function unpackTarGz( file, { storage, label = file.name, onProgress = null, filter = null, part = null } ) {

	if ( ! storage || typeof DecompressionStream === 'undefined' ) return null;

	const area = storage.area( ENGINE_AREAS.ARCHIVES );
	const whole = await archiveKey( 'gunzip', file );
	let key = whole;

	let entry = await area.open( whole );
	if ( ! entry && filter ) entry = await area.open( key = `${whole}|${part}` );
	const cached = !! entry;

	if ( ! entry ) {

		// A part's size is known only once its headers are read: a write past the quota falls back below.
		const writer = await area.create( key, filter ? { label: `${label} (${part})` } : { label, expectedBytes: file.size * GUESSED_EXPANSION } );
		if ( ! writer ) return null;

		let out = null;
		const indexer = createTarIndexer( filter ? { filter, sink: ( bytes ) => out.enqueue( bytes ) } : {} );
		const tap = new TransformStream( {
			start( controller ) {

				out = controller;

			},
			transform( chunk, controller ) {

				indexer.push( chunk );
				if ( ! filter ) controller.enqueue( chunk );

			},
		} );

		try {

			const unpacked = file.stream().pipeThrough( new DecompressionStream( 'gzip' ) ).pipeThrough( tap );
			const tarBytes = await writer.writeStream( 'data.tar', unpacked, { onProgress } );
			await writer.writeJSON( 'index.json', { v: INDEX_VERSION, listing: indexer.finish() } );
			await writer.commit( { compressedBytes: file.size, tarBytes } );

		} catch ( error ) {

			await writer.abort();
			if ( error?.name !== 'QuotaExceededError' ) throw error;
			storage._issue( ISSUE_CODES.STORAGE_QUOTA_EXCEEDED, `ran out of room unpacking ${label}; reading it in memory instead`, { area: ENGINE_AREAS.ARCHIVES } );
			return null;

		}

		entry = await area.open( key, { wait: true } );
		if ( ! entry ) return null;

	}

	const tar = await entry.file( 'data.tar' );
	const index = await entry.json( 'index.json' );
	if ( ! tar || index?.v !== INDEX_VERSION ) {

		entry.release();
		return null;

	}

	return { file: tar, index, release: () => entry.release(), cached };

}

/** A plain .tar's saved header index, so reopening it skips even the header walk. */
export async function loadTarIndex( file, storage ) {

	if ( ! storage ) return null;
	const entry = await storage.area( ENGINE_AREAS.ARCHIVES ).open( await archiveKey( 'tarindex', file ) );
	if ( ! entry ) return null;

	try {

		const index = await entry.json( 'index.json' );
		return index?.v === INDEX_VERSION ? index : null;

	} finally {

		entry.release();

	}

}

export async function saveTarIndex( file, storage, index ) {

	if ( ! storage || ! index ) return false;
	const writer = await storage.area( ENGINE_AREAS.ARCHIVES ).create( await archiveKey( 'tarindex', file ), { label: `${file.name} (index)` } );
	if ( ! writer ) return false;

	try {

		await writer.writeJSON( 'index.json', index );
		await writer.commit();
		return true;

	} catch {

		await writer.abort();
		return false;

	}

}
