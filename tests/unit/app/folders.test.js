import { describe, it, expect, vi } from 'vitest';

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
import { readDrop } from '@/lib/folders';

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
