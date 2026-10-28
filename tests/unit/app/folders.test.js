import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted( () => {

	globalThis.window ??= Object.assign( new EventTarget(), { devicePixelRatio: 1, location: { href: 'https://rayzee.test/' } } );
	globalThis.document ??= Object.assign( new EventTarget(), { visibilityState: 'visible', hidden: false } );
	const memory = new Map();
	globalThis.localStorage ??= {
		getItem: key => memory.get( key ) ?? null,
		setItem: ( key, value ) => memory.set( key, String( value ) ),
		removeItem: key => memory.delete( key ),
	};

} );
import { createFakeIndexedDB } from '../../__mocks__/indexedDB.js';
import {
	readDrop, readHandle, pickFolder, pickFiles, rememberFolder, recallFolder, folderAccess, rememberFramesFolder, framesFolderFor, loadFolder,
} from '@/lib/folders';
import { setApp } from '@/lib/appProxy';
import { useStore } from '@/store';
import { toast } from '@/hooks/use-toast';

vi.mock( '@/hooks/use-toast', () => ( { toast: vi.fn() } ) );

const file = name => new File( [ name ], name.split( '/' ).pop() );

// The old File and Directory Entries API, as a drop hands it over: a directory reads in batches until one is empty.
function entryOf( path, children = null ) {

	const name = path.split( '/' ).pop();
	if ( ! children ) return { isFile: true, isDirectory: false, name, fullPath: `/${path}`, file: ( ok ) => ok( file( path ) ) };
	const batches = [ children.slice( 0, 1 ), children.slice( 1 ), []];
	return {
		isFile: false, isDirectory: true, name, fullPath: `/${path}`,
		createReader: () => ( { readEntries: ( ok ) => ok( batches.shift() ) } ),
	};

}

// File System Access handles, as Chrome's drop and folder picker give them.
function handleOf( path, children = null ) {

	const name = path.split( '/' ).pop();
	if ( ! children ) return { kind: 'file', name, getFile: async () => file( path ) };
	return { kind: 'directory', name, async* values() {

		yield* children;

	} };

}

const item = ( entry, handle ) => ( {
	kind: 'file',
	webkitGetAsEntry: () => entry,
	...( handle === undefined ? {} : { getAsFileSystemHandle: async () => handle } ),
} );

const room = ( make ) => make( 'Room', [
	make( 'Room/scene.gltf' ),
	make( 'Room/.DS_Store' ),
	make( 'Room/tex', [ make( 'Room/tex/a.png' ), make( 'Room/tex/.hidden.png' ) ] ),
	make( 'Room/.git', [ make( 'Room/.git/HEAD' ) ] ),
] );

describe( 'reading a drop', () => {

	it( 'passes a single file straight through', () => {

		const one = file( 'chair.glb' );
		expect( readDrop( { items: [ item( entryOf( 'chair.glb' ) ) ], files: [ one ] } ) ).toEqual( { file: one } );
		expect( readDrop( { items: [], files: [] } ) ).toBeNull();

	} );

	it( 'walks a dropped folder, leaving hidden files and folders out', async () => {

		const read = await readDrop( { items: [ item( room( entryOf ) ) ], files: [] } ).read();
		expect( read.handle ).toBeNull();
		expect( read.folder.name ).toBe( 'Room' );
		expect( read.folder.files.map( e => e.path ).sort() ).toEqual( [ 'Room/scene.gltf', 'Room/tex/a.png' ] );
		expect( await read.folder.files.find( e => e.path === 'Room/tex/a.png' ).file.text() ).toBe( 'Room/tex/a.png' );

	} );

	it( 'reads nothing until the drop is taken', () => {

		const folder = room( entryOf );
		const createReader = vi.spyOn( folder, 'createReader' );
		const getFile = vi.fn();
		readDrop( { items: [ item( folder, { kind: 'directory', name: 'Room', getFile, values: getFile } ) ], files: [] } );
		expect( createReader ).not.toHaveBeenCalled();
		expect( getFile ).not.toHaveBeenCalled();

	} );

	it( 'keeps the handle of a folder dropped where the browser gives one', async () => {

		const handle = room( handleOf );
		const read = await readDrop( { items: [ item( room( entryOf ), handle ) ], files: [] } ).read();
		expect( read.handle ).toBe( handle );
		expect( read.folder.files.map( e => e.path ).sort() ).toEqual( [ 'Room/scene.gltf', 'Room/tex/a.png' ] );

	} );

	it( 'takes several dropped items together as one folder, with no handle to keep', async () => {

		const items = [ item( entryOf( 'scene.gltf' ), handleOf( 'scene.gltf' ) ), item( entryOf( 'scene.bin' ), handleOf( 'scene.bin' ) ) ];
		const read = await readDrop( { items, files: [] } ).read();
		expect( read.handle ).toBeNull();
		expect( read.folder.files.map( e => e.path ).sort() ).toEqual( [ 'scene.bin', 'scene.gltf' ] );

	} );

} );

describe( 'reading a drop without handles', () => {

	it( 'walks the entries when the browser hands no handle over, naming several items together', async () => {

		const failing = { kind: 'file', webkitGetAsEntry: () => entryOf( 'a.gltf' ), getAsFileSystemHandle: () => Promise.reject( new Error( 'no' ) ) };
		const read = await readDrop( { items: [ failing, item( room( entryOf ) ) ], files: [] } ).read();
		expect( read.handle ).toBeNull();
		expect( read.folder.name ).toBeUndefined();
		expect( read.folder.files.map( e => e.path ).sort() ).toEqual( [ 'Room/scene.gltf', 'Room/tex/a.png', 'a.gltf' ] );
		expect( useStore.getState().loading.status ).toBe( 'Reading the dropped files… 3 files' );

	} );

	it( 'reads one file handle as a folder of one, and counts a folder\'s files as it goes', async () => {

		const one = await readHandle( handleOf( 'chair.glb' ) );
		expect( one.name ).toBe( 'chair.glb' );
		expect( one.files.map( e => e.path ) ).toEqual( [ 'chair.glb' ] );
		expect( useStore.getState().loading.status ).toBe( 'Reading chair.glb… 0 files' );

		await readHandle( room( handleOf ) );
		expect( useStore.getState().loading ).toMatchObject( { isLoading: true, status: 'Reading Room… 2 files' } );

	} );

} );

function fakeInput( picked ) {

	const input = Object.assign( new EventTarget(), { style: {}, files: [], remove: vi.fn() } );
	input.click = () => {

		if ( picked === null ) return input.dispatchEvent( new Event( 'cancel' ) );
		input.files = picked;
		input.dispatchEvent( new Event( 'change' ) );

	};

	document.createElement = vi.fn( () => input );
	document.body = { append: vi.fn() };
	return input;

}

const inFolder = path => Object.defineProperty( file( path ), 'webkitRelativePath', { value: path } );

describe( 'picking folders and files', () => {

	afterEach( () => {

		delete window.showDirectoryPicker;
		delete document.createElement;
		delete document.body;

	} );

	it( 'asks through the folder picker where the browser can keep the folder', async () => {

		const handle = room( handleOf );
		window.showDirectoryPicker = vi.fn( async () => handle );

		const picked = await pickFolder();
		expect( window.showDirectoryPicker ).toHaveBeenCalledWith( { id: 'rayzee-models', mode: 'read' } );
		expect( picked.name ).toBe( 'Room' );
		expect( picked.handle ).toBe( handle );
		expect( ( await picked.read() ).files.map( e => e.path ).sort() ).toEqual( [ 'Room/scene.gltf', 'Room/tex/a.png' ] );

		window.showDirectoryPicker = async () => {

			throw new DOMException( 'cancelled', 'AbortError' );

		};

		expect( await pickFolder() ).toBeNull();

		window.showDirectoryPicker = async () => {

			throw new DOMException( 'blocked', 'SecurityError' );

		};

		await expect( pickFolder() ).rejects.toThrow( 'blocked' );

	} );

	it( 'falls back to a folder input elsewhere', async () => {

		const input = fakeInput( [ inFolder( 'Room/scene.gltf' ), inFolder( 'Room/.DS_Store' ), inFolder( 'Room/tex/a.png' ) ] );

		const picked = await pickFolder();
		expect( input ).toMatchObject( { type: 'file', multiple: true, webkitdirectory: true } );
		expect( input.style.display ).toBe( 'none' );
		expect( document.body.append ).toHaveBeenCalledWith( input );
		expect( input.remove ).toHaveBeenCalled();
		expect( picked.name ).toBe( 'Room' );
		expect( picked.handle ).toBeNull();
		expect( ( await picked.read() ).files.map( e => e.path ) ).toEqual( [ 'Room/scene.gltf', 'Room/tex/a.png' ] );

		fakeInput( null );
		expect( await pickFolder() ).toBeNull();
		fakeInput( [] );
		expect( await pickFolder() ).toBeNull();

	} );

	it( 'asks for several files at once', async () => {

		const files = [ file( 'a.gltf' ), file( 'a.bin' ) ];
		const input = fakeInput( files );

		const picked = await pickFiles();
		expect( input.webkitdirectory ).toBe( false );
		expect( picked ).toMatchObject( { name: null, handle: null } );
		expect( ( await picked.read() ).files ).toEqual( files );

		fakeInput( null );
		expect( await pickFiles() ).toBeNull();

	} );

} );

function permissionHandle( state, granted = state ) {

	return { kind: 'directory', name: 'Out', queryPermission: vi.fn( async () => state ), requestPermission: vi.fn( async () => granted ) };

}

describe( 'kept folders', () => {

	let idb;
	const kept = () => idb.records( 'RayzeeFolders', 'handles' );

	beforeEach( () => {

		idb = createFakeIndexedDB();
		vi.stubGlobal( 'indexedDB', idb.indexedDB );
		window.showDirectoryPicker = vi.fn();

	} );

	afterEach( () => {

		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		delete window.showDirectoryPicker;
		setApp( null );

	} );

	it( 'keeps a folder under its scene\'s key and hands it back', async () => {

		const handle = room( handleOf );
		await rememberFolder( 'folder:Room', handle );
		expect( await recallFolder( 'folder:Room' ) ).toBe( handle );
		expect( await recallFolder( 'folder:Other' ) ).toBeNull();
		expect( await recallFolder( null ) ).toBeNull();

		delete window.showDirectoryPicker;
		expect( await recallFolder( 'folder:Room' ) ).toBeNull();

	} );

	it( 'keeps nothing without a key, a handle or a database', async () => {

		await rememberFolder( null, room( handleOf ) );
		await rememberFolder( 'folder:Room', null );
		expect( kept().size ).toBe( 0 );

		vi.stubGlobal( 'indexedDB', undefined );
		await rememberFolder( 'folder:Room', room( handleOf ) );
		expect( await recallFolder( 'folder:Room' ) ).toBeNull();

	} );

	it( 'keeps the fifty most recently used folders', async () => {

		let now = 0;
		vi.spyOn( Date, 'now' ).mockImplementation( () => ( now += 10 ) );
		for ( let i = 0; i < 52; i ++ ) await rememberFolder( `folder:${i}`, { kind: 'directory', name: `${i}` } );
		await rememberFolder( 'folder:0', { kind: 'directory', name: 'again' } );

		expect( kept().size ).toBe( 50 );
		expect( kept().has( 'folder:0' ) ).toBe( true );
		expect( kept().has( 'folder:1' ) ).toBe( false );
		expect( kept().has( 'folder:2' ) ).toBe( false );
		expect( kept().has( 'folder:3' ) ).toBe( true );
		expect( ( await recallFolder( 'folder:0' ) ).name ).toBe( 'again' );

	} );

	it( 'carries on when the database cannot be opened', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		idb.faults.open = 'UnknownError';
		await rememberFolder( 'folder:Room', room( handleOf ) );
		expect( warn ).toHaveBeenCalledWith( 'Could not remember the folder:', expect.any( DOMException ) );
		expect( await recallFolder( 'folder:Room' ) ).toBeNull();

	} );

	it( 'says whether a kept folder may be used, asking only when told to', async () => {

		const prompt = permissionHandle( 'prompt', 'granted' );
		expect( await folderAccess( prompt ) ).toBe( false );
		expect( prompt.requestPermission ).not.toHaveBeenCalled();
		expect( await folderAccess( prompt, { ask: true, mode: 'readwrite' } ) ).toBe( true );
		expect( prompt.queryPermission ).toHaveBeenLastCalledWith( { mode: 'readwrite' } );
		expect( prompt.requestPermission ).toHaveBeenCalledWith( { mode: 'readwrite' } );

		expect( await folderAccess( permissionHandle( 'granted' ) ) ).toBe( true );
		expect( await folderAccess( permissionHandle( 'denied' ), { ask: true } ) ).toBe( false );
		expect( await folderAccess( permissionHandle( 'prompt', 'denied' ), { ask: true } ) ).toBe( false );
		expect( await folderAccess( { queryPermission: () => Promise.reject( new Error( 'gone' ) ) } ) ).toBe( false );

	} );

	it( 'finds the folder a frame export writes into, or asks for one', async () => {

		const out = permissionHandle( 'prompt', 'granted' );
		await rememberFramesFolder( 'job-1', out );
		expect( kept().has( 'frames:job-1' ) ).toBe( true );
		expect( await framesFolderFor( 'job-1' ) ).toBe( out );
		expect( window.showDirectoryPicker ).not.toHaveBeenCalled();

		const picked = permissionHandle( 'granted' );
		window.showDirectoryPicker.mockResolvedValue( picked );
		await rememberFramesFolder( 'job-2', permissionHandle( 'denied' ) );
		expect( await framesFolderFor( 'job-2' ) ).toBe( picked );
		expect( window.showDirectoryPicker ).toHaveBeenCalledWith( { id: 'rayzee-frames', mode: 'readwrite' } );
		expect( await framesFolderFor( 'job-3' ) ).toBe( picked );

		window.showDirectoryPicker.mockRejectedValue( new DOMException( 'cancelled', 'AbortError' ) );
		expect( await framesFolderFor( 'job-3' ) ).toBeNull();

	} );

	it( 'loads a folder as the scene and keeps its handle', async () => {

		const handle = room( handleOf );
		const folder = { name: 'Room', files: [] };
		const app = {
			isInitialized: true,
			pauseRendering: false,
			assetLoader: new EventTarget(),
			loadFile: vi.fn( async () => {

				expect( app.pauseRendering ).toBe( true );
				app.sceneSource = { kind: 'local-folder', key: 'folder:Room' };

			} ),
		};
		setApp( app );
		useStore.getState().setLoading( { isLoading: true, status: 'Reading' } );

		await loadFolder( folder, { handle } );
		expect( app.loadFile ).toHaveBeenCalledWith( folder );
		expect( app.pauseRendering ).toBe( false );
		expect( useStore.getState().loading.isLoading ).toBe( false );
		await vi.waitFor( () => expect( kept().get( 'folder:Room' )?.handle ).toBe( handle ) );

	} );

	it( 'asks which parts to load, or says why a folder did not load', async () => {

		const folder = { name: 'Island', files: [] };
		const handle = room( handleOf );
		const fail = error => Object.assign( { isInitialized: true, pauseRendering: false, assetLoader: new EventTarget() }, {
			loadFile: vi.fn( async () => {

				throw error;

			} ),
		} );

		const needs = Object.assign( new Error( 'pick' ), { code: 'ARCHIVE_NEEDS_ELEMENT', elements: [ 'a', 'b' ], totalBytes: 9 } );
		setApp( fail( needs ) );
		await loadFolder( folder, { handle } );
		expect( useStore.getState().archivePrompt ).toEqual( { file: folder, handle, elements: [ 'a', 'b' ], totalBytes: 9 } );
		expect( toast ).not.toHaveBeenCalled();

		setApp( fail( Object.assign( new Error( 'busy' ), { code: 'LOAD_IN_PROGRESS' } ) ) );
		await loadFolder( folder );
		expect( toast ).toHaveBeenLastCalledWith( expect.objectContaining( { title: 'Still Loading' } ) );

		const app = fail( new Error( 'bad gltf' ) );
		setApp( app );
		await loadFolder( folder );
		expect( toast ).toHaveBeenLastCalledWith( { title: 'Could not load the folder', description: 'bad gltf', variant: 'destructive' } );
		expect( app.pauseRendering ).toBe( false );
		expect( toast ).toHaveBeenCalledTimes( 2 );

		app.loadFile.mockImplementation( async () => {

			app.assetLoader.dispatchEvent( new Event( 'error' ) );
			throw new Error( 'shown already' );

		} );
		await loadFolder( folder );
		expect( toast ).toHaveBeenCalledTimes( 2 );
		expect( kept().size ).toBe( 0 );

		setApp( null );
		await loadFolder( folder );
		expect( app.loadFile ).toHaveBeenCalledTimes( 2 );

	} );

} );
