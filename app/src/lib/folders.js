import { localFolder } from 'rayzee';
import { getApp } from '@/lib/appProxy';
import { useStore } from '@/store';
import { toast } from '@/hooks/use-toast';

const DB_NAME = 'RayzeeFolders';
const STORE = 'handles';
const KEEP = 50;

const hidden = name => name.startsWith( '.' ) || name === '__MACOSX';

/** Whether this browser can keep a folder it was given (Chrome, Edge): a restored session then reopens it itself. */
const canRememberFolders = () => typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

function reading( name, count ) {

	useStore.getState().setLoading( { isLoading: true, title: 'Loading', status: `Reading ${name}… ${count} files`, progress: 1 } );

}

async function walkHandle( dir, prefix, out, report ) {

	const files = [];
	const dirs = [];
	for await ( const child of dir.values() ) {

		if ( hidden( child.name ) ) continue;
		( child.kind === 'directory' ? dirs : files ).push( child );

	}

	const read = await Promise.all( files.map( async handle => ( { path: prefix + handle.name, file: await handle.getFile() } ) ) );
	out.push( ...read );
	report( out.length );
	for ( const sub of dirs ) await walkHandle( sub, `${prefix}${sub.name}/`, out, report );

}

/** A directory handle's files, as `loadFile` takes a folder. */
export async function readHandle( handle ) {

	const files = [];
	reading( handle.name, 0 );
	if ( handle.kind === 'file' ) files.push( { path: handle.name, file: await handle.getFile() } );
	else await walkHandle( handle, `${handle.name}/`, files, count => reading( handle.name, count ) );
	return { name: handle.name, files };

}

const readEntries = reader => new Promise( ( resolve, reject ) => reader.readEntries( resolve, reject ) );
const entryFile = entry => new Promise( ( resolve, reject ) => entry.file( resolve, reject ) );

async function walkEntry( entry, out, report ) {

	if ( hidden( entry.name ) ) return;
	if ( entry.isFile ) {

		out.push( { path: entry.fullPath.replace( /^\/+/, '' ), file: await entryFile( entry ) } );
		return;

	}

	const reader = entry.createReader();
	const children = [];
	for ( let batch = await readEntries( reader ); batch.length; batch = await readEntries( reader ) ) children.push( ...batch );

	const files = children.filter( c => c.isFile && ! hidden( c.name ) );
	out.push( ...await Promise.all( files.map( async c => ( { path: c.fullPath.replace( /^\/+/, '' ), file: await entryFile( c ) } ) ) ) );
	report( out.length );
	for ( const sub of children ) if ( sub.isDirectory ) await walkEntry( sub, out, report );

}

/**
 * What a drop holds: `{ file }` for one file, or `{ read }` for a dropped folder or several items at once — `read()`
 * lists their files as `{ folder, handle }`. Call it inside the drop event: the browser empties the drop's items once
 * the handler returns.
 */
export function readDrop( dataTransfer ) {

	const items = [ ...( dataTransfer.items ?? [] ) ].filter( item => item.kind === 'file' );
	const entries = items.map( item => item.webkitGetAsEntry?.() ?? null );
	if ( items.length <= 1 && ! entries[ 0 ]?.isDirectory ) {

		const file = dataTransfer.files?.[ 0 ];
		return file ? { file } : null;

	}

	const handles = items.map( item => item.getAsFileSystemHandle?.()?.catch( () => null ) ?? null );
	const label = entries.length === 1 ? entries[ 0 ].name : 'the dropped files';

	const read = async () => {

		const resolved = await Promise.all( handles );
		if ( resolved.every( Boolean ) ) {

			if ( resolved.length === 1 ) return { folder: await readHandle( resolved[ 0 ] ), handle: resolved[ 0 ] };
			const files = [];
			for ( const handle of resolved ) files.push( ...( await readHandle( handle ) ).files );
			return { folder: { files }, handle: null };

		}

		const files = [];
		reading( label, 0 );
		for ( const entry of entries ) if ( entry ) await walkEntry( entry, files, count => reading( label, count ) );
		return { folder: { ...( entries.length === 1 ? { name: entries[ 0 ].name } : {} ), files }, handle: null };

	};

	return { read };

}

function chooseFiles( { directory = false } = {} ) {

	return new Promise( resolve => {

		const input = Object.assign( document.createElement( 'input' ), { type: 'file', multiple: true } );
		input.webkitdirectory = directory;
		input.style.display = 'none';
		const done = files => {

			input.remove();
			resolve( files?.length ? files : null );

		};

		input.addEventListener( 'change', () => done( [ ...input.files ] ), { once: true } );
		input.addEventListener( 'cancel', () => done( null ), { once: true } );
		document.body.append( input );
		input.click();

	} );

}

/**
 * Asks for a folder — through the browser's folder picker where it can be remembered, else a folder input. Resolves
 * null when cancelled, or `{ name, handle, read }`: `read()` lists its files, which for a large folder takes a while.
 */
export async function pickFolder() {

	if ( canRememberFolders() ) {

		let handle;
		try {

			handle = await window.showDirectoryPicker( { id: 'rayzee-models', mode: 'read' } );

		} catch ( error ) {

			if ( error?.name === 'AbortError' ) return null;
			throw error;

		}

		return { name: handle.name, handle, read: () => readHandle( handle ) };

	}

	const files = await chooseFiles( { directory: true } );
	if ( ! files ) return null;
	const folder = localFolder( { files } );
	return { name: folder.name, handle: null, read: async () => folder };

}

/** Asks for several files at once, as `pickFolder` does for a folder. */
export async function pickFiles() {

	const files = await chooseFiles();
	return files ? { name: null, handle: null, read: async () => ( { files } ) } : null;

}

function openDatabase() {

	return new Promise( ( resolve, reject ) => {

		const request = indexedDB.open( DB_NAME, 1 );
		request.onupgradeneeded = () => request.result.createObjectStore( STORE );
		request.onsuccess = () => resolve( request.result );
		request.onerror = () => reject( request.error );

	} );

}

const done = request => new Promise( ( resolve, reject ) => {

	request.onsuccess = () => resolve( request.result );
	request.onerror = () => reject( request.error );

} );

async function withStore( mode, fn ) {

	const db = await openDatabase();
	try {

		return await fn( db.transaction( STORE, mode ).objectStore( STORE ) );

	} finally {

		db.close();

	}

}

/** Keeps a folder's handle under a scene source's key, so a session of that scene can reopen it. */
export async function rememberFolder( key, handle ) {

	if ( ! key || ! handle || typeof indexedDB === 'undefined' ) return;

	try {

		await withStore( 'readwrite', async store => {

			await done( store.put( { handle, savedAt: Date.now() }, key ) );
			const [ keys, values ] = await Promise.all( [ done( store.getAllKeys() ), done( store.getAll() ) ] );
			const old = keys.map( ( k, i ) => ( { k, savedAt: values[ i ]?.savedAt ?? 0 } ) ).sort( ( a, b ) => b.savedAt - a.savedAt ).slice( KEEP );
			await Promise.all( old.map( ( { k } ) => done( store.delete( k ) ) ) );

		} );

	} catch ( error ) {

		console.warn( 'Could not remember the folder:', error );

	}

}

/** The folder handle kept for a scene source's key, or null. */
export async function recallFolder( key ) {

	if ( ! key || ! canRememberFolders() || typeof indexedDB === 'undefined' ) return null;

	try {

		return ( await withStore( 'readonly', store => done( store.get( key ) ) ) )?.handle ?? null;

	} catch {

		return null;

	}

}

/** Whether a kept folder can be read: already allowed, or allowed now when `ask` (needs a click just before). */
export async function folderAccess( handle, { ask = false } = {} ) {

	try {

		let state = await handle.queryPermission( { mode: 'read' } );
		if ( state === 'prompt' && ask ) state = await handle.requestPermission( { mode: 'read' } );
		return state === 'granted';

	} catch {

		return false;

	}

}

/**
 * Loads a folder of files as the scene, asking which parts to load when it is a large pbrt scene, and keeps its handle
 * so a restored session can open it again.
 */
export async function loadFolder( folder, { handle = null } = {} ) {

	const app = getApp();
	if ( ! app ) return;

	// The viewport already shows a toast for the loader's own error event.
	let reported = false;
	const onError = () => {

		reported = true;

	};

	app.assetLoader?.addEventListener( 'error', onError );
	try {

		app.pauseRendering = true;
		await app.loadFile( folder );
		rememberFolder( app.sceneSource?.key, handle );

	} catch ( error ) {

		if ( error?.code === 'ARCHIVE_NEEDS_ELEMENT' ) {

			useStore.getState().setArchivePrompt( { file: error.file ?? folder, handle, elements: error.elements, totalBytes: error.totalBytes } );

		} else if ( error?.code === 'LOAD_IN_PROGRESS' ) {

			toast( { title: 'Still Loading', description: 'Wait for the current load to finish, then open the folder again.' } );

		} else if ( ! reported ) {

			toast( { title: 'Could not load the folder', description: error?.message || String( error ), variant: 'destructive' } );

		}

	} finally {

		app.assetLoader?.removeEventListener( 'error', onError );
		app.pauseRendering = false;
		useStore.getState().resetLoading();

	}

}
