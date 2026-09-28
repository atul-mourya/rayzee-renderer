import { openZip, VERSION } from 'rayzee';
import { openSink, zipInto } from '@/lib/zipSink';
import { captureSession, SESSION_FORMAT } from '@/lib/session';
import { APP_AREAS } from '@/lib/storage';
import { getApp } from '@/lib/appProxy';
import { useStore } from '@/store';

export const PROJECT_FORMAT = 'rayzee-project';
const PROJECT_VERSION = 1;
const MANIFEST = 'project.json';
const THUMB = 'thumb.webp';
const RECENT_LIMIT = 10;

// A model opened from disk travels inside the project, stored. Streaming writes no ZIP64, so
// 4 GB is the ceiling; a download assembled in memory stops far earlier.
const EMBED_LIMIT_STREAMED = 3.5 * 1024 ** 3;
const EMBED_LIMIT_IN_MEMORY = 512 * 1024 ** 2;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const fileName = title => `${( title || 'project' ).replace( /\.[a-z0-9]+$/i, '' ).replace( /[\\/:*?"<>|]+/g, '_' ).trim() || 'project'}.rayzee`;

/**
 * Writes the scene as a `.rayzee` project — the session record, a thumbnail, and the model when it
 * came from a local file — to a file the user picks (or a download).
 * @returns {Promise<{title: string, embedded: boolean}>}
 */
export async function saveProject( app, { onProgress } = {} ) {

	const { record, thumb } = await captureSession( app );
	const sink = await openSink( fileName( record.title ), { description: 'Rayzee project', extension: '.rayzee' } );
	const file = app.sceneSourceFile;
	const embed = !! file && file.size <= ( sink.streamed ? EMBED_LIMIT_STREAMED : EMBED_LIMIT_IN_MEMORY );

	const manifest = {
		format: PROJECT_FORMAT,
		v: PROJECT_VERSION,
		savedAt: record.savedAt,
		app: VERSION,
		title: record.title,
		embedded: embed ? `sources/${file.name}` : null,
		session: record,
	};

	const zip = zipInto( sink );
	try {

		zip.addBytes( MANIFEST, encoder.encode( JSON.stringify( manifest ) ) );
		if ( thumb ) zip.addBytes( THUMB, new Uint8Array( await thumb.arrayBuffer() ) );
		if ( embed ) await zip.addBlob( manifest.embedded, file, { onProgress } );
		await zip.finish();
		await sink.close();

	} catch ( error ) {

		await sink.abort().catch( () => {} );
		throw error;

	}

	await rememberProject( app.storage, manifest, thumb );
	return { title: record.title, embedded: embed, tooLarge: !! file && ! embed };

}

/**
 * Reads a `.rayzee` project without loading anything.
 * @returns {Promise<{manifest: Object, record: Object, thumb: ?Blob, embeddedFile: ?File}>}
 */
export async function readProject( file ) {

	const zip = await openZip( file );
	const bytes = await zip.read( MANIFEST );
	let manifest = null;
	try {

		manifest = bytes && JSON.parse( decoder.decode( bytes ) );

	} catch {

		manifest = null;

	}

	if ( manifest?.format !== PROJECT_FORMAT ) throw new Error( `${file.name} is not a Rayzee project` );
	if ( manifest.v > PROJECT_VERSION || manifest.session?.v > SESSION_FORMAT ) throw new Error( `${file.name} was saved by a newer Rayzee` );

	const thumbBytes = await zip.read( THUMB );
	const source = manifest.session.source;
	const blob = manifest.embedded ? await zip.slice( manifest.embedded ) : null;
	const embeddedFile = blob && source?.kind === 'local-file'
		? new File( [ blob ], source.file.name, { lastModified: source.file.lastModified } )
		: null;

	return {
		manifest,
		record: manifest.session,
		thumb: thumbBytes ? new Blob( [ thumbBytes ], { type: 'image/webp' } ) : null,
		embeddedFile,
	};

}

/** Keeps a saved or opened project under File → Recent (its record and thumbnail, not the model). */
export async function rememberProject( storage, manifest, thumb ) {

	const area = storage?.area( APP_AREAS.PROJECTS );
	if ( ! area ) return;

	const key = `project:${manifest.title}:${manifest.session?.source?.key ?? manifest.session?.source?.url ?? ''}`;
	const writer = await area.create( key, {
		label: `Project · ${manifest.title}`,
		extra: { kind: 'project', title: manifest.title, savedAt: Date.now(), embedded: !! manifest.embedded },
	} );
	if ( ! writer ) return;

	try {

		await writer.writeJSON( MANIFEST, { ...manifest, embedded: null, embeddedName: manifest.embedded } );
		if ( thumb ) await writer.writeFile( THUMB, thumb );
		await writer.commit();

	} catch {

		await writer.abort();
		return;

	}

	const recent = ( await area.list() ).filter( m => m.extra?.kind === 'project' ).sort( ( a, b ) => b.extra.savedAt - a.extra.savedAt );
	for ( const meta of recent.slice( RECENT_LIMIT ) ) await area.remove( meta.key );

}

/** Recent projects, newest first: `{ key, title, savedAt, embedded }`. */
export async function listRecentProjects( storage ) {

	const area = storage?.area( APP_AREAS.PROJECTS );
	if ( ! area ) return [];
	return ( await area.list() )
		.filter( m => m.extra?.kind === 'project' )
		.map( m => ( { key: m.key, title: m.extra.title, savedAt: m.extra.savedAt, embedded: m.extra.embedded } ) )
		.sort( ( a, b ) => b.savedAt - a.savedAt );

}

/** @returns {Promise<?{record: Object, thumb: ?Blob, manifest: Object}>} */
export async function readRecentProject( storage, key ) {

	const entry = await storage?.area( APP_AREAS.PROJECTS ).open( key, { wait: true } );
	if ( ! entry ) return null;

	try {

		const manifest = await entry.json( MANIFEST );
		const thumb = entry.meta.files[ THUMB ] ? await entry.file( THUMB ) : null;
		return {
			manifest,
			record: manifest.session,
			thumb: thumb ? new Blob( [ await thumb.arrayBuffer() ], { type: 'image/webp' } ) : null,
		};

	} finally {

		entry.release();

	}

}

/** Reads a `.rayzee` file and asks to open it (the session dialog does the rest). */
export async function requestProjectOpen( file ) {

	const project = await readProject( file );
	useStore.getState().setSessionRequest( { origin: 'project', record: project.record, thumb: project.thumb, embeddedFile: project.embeddedFile } );
	rememberProject( getApp()?.storage, project.manifest, project.thumb );

}
