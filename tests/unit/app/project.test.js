import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted( () => {

	globalThis.window ??= Object.assign( new EventTarget(), {
		devicePixelRatio: 1,
		location: { href: 'https://rayzee.test/' },
		history: { state: null, replaceState() {} },
	} );
	globalThis.document ??= Object.assign( new EventTarget(), { visibilityState: 'visible', hidden: false } );
	globalThis.CustomEvent ??= class extends Event {};
	const memory = new Map();
	globalThis.localStorage ??= {
		getItem: key => memory.get( key ) ?? null,
		setItem: ( key, value ) => memory.set( key, String( value ) ),
		removeItem: key => memory.delete( key ),
	};

} );
import { resolveObjectURL } from 'node:buffer';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { fileIdentity } from '@/core/storage/FileIdentity.js';
import { VERSION } from '@/core/Version.js';
import { ensureAppAreas } from '@/lib/storage';
import { setApp } from '@/lib/appProxy';
import { zipInto } from '@/lib/zipSink';
import { saveProject, readProject, rememberProject, listRecentProjects, readRecentProject, requestProjectOpen, PROJECT_FORMAT } from '@/lib/project';
import { useStore } from '@/store';

const encoder = new TextEncoder();

class FakeCanvas {

	constructor( width, height ) {

		this.width = width;
		this.height = height;

	}

	getContext() {

		return { drawImage: () => {} };

	}

	async convertToBlob( { type } ) {

		return new Blob( [ `thumb ${this.width}x${this.height}` ], { type } );

	}

}

function fakeApp( storage, { source = null, file = null, folder = null, model = 'Scene' } = {} ) {

	return {
		isInitialized: true,
		storage,
		sceneSource: source,
		sceneSourceFile: file,
		sceneSourceFolder: folder,
		sceneModel: { name: model },
		exportSceneState: () => ( { v: 1, edits: 3 } ),
		getCanvas: () => ( { width: 640, height: 480 } ),
	};

}

function pickSaveFile( { fail = null } = {} ) {

	const chunks = [];
	const writable = {
		write: vi.fn( async ( chunk ) => {

			if ( fail ) throw fail;
			chunks.push( chunk );

		} ),
		close: vi.fn( async () => {} ),
		abort: vi.fn( async () => {} ),
	};
	window.showSaveFilePicker = vi.fn( async () => ( { createWritable: async () => writable } ) );
	return { writable, file: () => new File( chunks, 'saved.rayzee' ) };

}

async function projectZip( manifest ) {

	const chunks = [];
	const zip = zipInto( { push: c => chunks.push( c ), drain: async () => {} } );
	zip.addBytes( 'project.json', typeof manifest === 'string' ? encoder.encode( manifest ) : encoder.encode( JSON.stringify( manifest ) ) );
	await zip.addBlob( 'sources/a.glb', new Blob( [ 'model' ] ) );
	await zip.finish();
	return new File( chunks, 'x.rayzee' );

}

describe( 'projects', () => {

	let storage, uninstall;

	beforeEach( async () => {

		const fake = createFakeOPFS();
		uninstall = fake.install();
		const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );
		ensureAppAreas( storage );
		vi.stubGlobal( 'createImageBitmap', async ( canvas ) => ( { width: canvas.width, height: canvas.height, close: () => {} } ) );
		vi.stubGlobal( 'OffscreenCanvas', FakeCanvas );

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
		delete window.showSaveFilePicker;
		delete document.createElement;
		setApp( null );

	} );

	it( 'saves a project with the model it was opened from, and keeps it under Recent', async () => {

		const model = new File( [ new Uint8Array( 300_000 ).map( ( _, i ) => i * 7 ) ], 'room.glb', { lastModified: 9 } );
		const identity = await fileIdentity( model );
		const app = fakeApp( storage, { source: { kind: 'local-file', file: identity, key: 'k1' }, file: model } );
		const sink = pickSaveFile();
		const progress = [];

		const result = await saveProject( app, { onProgress: f => progress.push( f ) } );
		expect( result ).toEqual( { title: 'room.glb', embedded: true, tooLarge: false, folder: false } );
		expect( window.showSaveFilePicker ).toHaveBeenCalledWith( {
			suggestedName: 'room.rayzee', types: [ { description: 'Rayzee project', accept: { 'application/zip': [ '.rayzee' ] } } ],
		} );
		expect( progress.at( - 1 ) ).toBe( 1 );
		expect( sink.writable.close ).toHaveBeenCalledTimes( 1 );

		const project = await readProject( sink.file() );
		expect( project.manifest ).toMatchObject( { format: PROJECT_FORMAT, v: 1, app: VERSION, title: 'room.glb', embedded: 'sources/room.glb' } );
		expect( project.manifest.embeddedFolder ).toBeUndefined();
		expect( project.record.scene ).toEqual( { v: 1, edits: 3 } );
		expect( await fileIdentity( project.embeddedFile ) ).toEqual( identity );
		expect( project.embeddedFolder ).toBeNull();
		expect( project.thumb.type ).toBe( 'image/webp' );
		expect( await project.thumb.text() ).toBe( 'thumb 320x240' );

		const [ recent ] = await listRecentProjects( storage );
		expect( recent ).toMatchObject( { key: 'project:room.glb:k1', title: 'room.glb', embedded: true } );
		const kept = await readRecentProject( storage, recent.key );
		expect( kept.manifest ).toMatchObject( { embedded: null, embeddedFolder: null, embeddedName: 'sources/room.glb' } );
		expect( kept.record.title ).toBe( 'room.glb' );
		expect( await kept.thumb.text() ).toBe( 'thumb 320x240' );

	} );

	it( 'saves the folder a scene came from, reporting progress over all its files', async () => {

		const folder = {
			name: 'Room',
			files: [
				{ path: 'Room/scene.gltf', file: new File( [ '{"a":1}' ], 'scene.gltf' ) },
				{ path: 'Room/tex/a.png', file: new File( [ new Uint8Array( 993 ) ], 'a.png' ) },
			],
		};
		const app = fakeApp( storage, { source: { kind: 'local-folder', folder: { name: 'Room' } }, folder } );
		const sink = pickSaveFile();
		const progress = [];

		expect( await saveProject( app, { onProgress: f => progress.push( f ) } ) ).toEqual( { title: 'Room', embedded: true, tooLarge: false, folder: true } );
		expect( progress ).toEqual( [ 0.007, 1 ] );

		const { manifest, embeddedFolder, embeddedFile } = await readProject( sink.file() );
		expect( manifest.embeddedFolder ).toBe( 'sources/folder/' );
		expect( manifest.embedded ).toBeNull();
		expect( embeddedFile ).toBeNull();
		expect( embeddedFolder.files.map( e => e.path ) ).toEqual( [ 'Room/scene.gltf', 'Room/tex/a.png' ] );
		expect( await embeddedFolder.files[ 0 ].file.text() ).toBe( '{"a":1}' );
		expect( ( await listRecentProjects( storage ) )[ 0 ].embedded ).toBe( true );

	} );

	it( 'downloads a project without its model when the model is too large to carry', async () => {

		vi.useFakeTimers( { toFake: [ 'setTimeout' ] } );
		const link = { click: vi.fn() };
		document.createElement = vi.fn( () => link );
		const app = fakeApp( storage, { source: { kind: 'local-file', file: { name: 'huge.glb' } }, file: { name: 'huge.glb', size: 600 * 1024 ** 2 } } );

		expect( await saveProject( app ) ).toEqual( { title: 'huge.glb', embedded: false, tooLarge: true, folder: false } );
		expect( link.download ).toBe( 'huge.rayzee' );
		const project = await readProject( new File( [ resolveObjectURL( link.href ) ], 'huge.rayzee' ) );
		expect( project.manifest.embedded ).toBeNull();
		expect( project.embeddedFile ).toBeNull();

		const many = { name: 'Big', files: Array.from( { length: 65_001 }, ( _, i ) => ( { path: `Big/${i}`, file: { size: 1 } } ) ) };
		const folderApp = fakeApp( storage, { source: { kind: 'local-folder', folder: { name: 'Big' } }, folder: many } );
		expect( await saveProject( folderApp ) ).toEqual( { title: 'Big', embedded: false, tooLarge: true, folder: true } );

		const heavy = { name: 'Heavy', files: [ { path: 'Heavy/a.bin', file: { size: 513 * 1024 ** 2 } } ] };
		const heavyApp = fakeApp( storage, { source: { kind: 'local-folder', folder: { name: 'Heavy' } }, folder: heavy } );
		expect( ( await saveProject( heavyApp ) ).embedded ).toBe( false );

		expect( await saveProject( fakeApp( storage ) ) ).toEqual( { title: 'Scene', embedded: false, tooLarge: false, folder: false } );

	} );

	it( 'names the file after the scene, safely', async () => {

		pickSaveFile();
		await saveProject( fakeApp( storage, { model: 'a/b:c?*.glb' } ) );
		await saveProject( fakeApp( storage, { model: '.glb' } ) );
		expect( window.showSaveFilePicker.mock.calls.map( ( [ options ] ) => options.suggestedName ) ).toEqual( [ 'a_b_c_.rayzee', 'project.rayzee' ] );

	} );

	it( 'saves without a thumbnail when there is no picture', async () => {

		const sink = pickSaveFile();
		const app = { ...fakeApp( storage, { model: 'Dark' } ), getCanvas: () => null };
		await saveProject( app );

		expect( ( await readProject( sink.file() ) ).thumb ).toBeNull();
		const [ recent ] = await listRecentProjects( storage );
		expect( ( await readRecentProject( storage, recent.key ) ).thumb ).toBeNull();

	} );

	it( 'aborts the file and remembers nothing when writing fails', async () => {

		const sink = pickSaveFile( { fail: new Error( 'disk full' ) } );
		const model = new File( [ 'model' ], 'room.glb' );
		const app = fakeApp( storage, { source: { kind: 'local-file', file: { name: 'room.glb' } }, file: model } );

		await expect( saveProject( app ) ).rejects.toThrow( 'disk full' );
		expect( sink.writable.abort ).toHaveBeenCalledTimes( 1 );
		expect( sink.writable.close ).not.toHaveBeenCalled();
		expect( await listRecentProjects( storage ) ).toEqual( [] );

	} );

	it( 'keeps the ten most recent projects, one per scene', async () => {

		let now = 1_000;
		vi.spyOn( Date, 'now' ).mockImplementation( () => now );
		const manifest = ( title, url ) => ( { title, session: { source: { kind: 'url', url } } } );
		for ( let i = 0; i < 12; i ++ ) {

			now += 10;
			await rememberProject( storage, manifest( `p${i}`, `https://x/${i}.glb` ), null );

		}

		now += 10;
		await rememberProject( storage, manifest( 'p5', 'https://x/5.glb' ), null );
		const other = await storage.area( 'projects' ).create( 'not-a-project', { extra: { kind: 'other' } } );
		await other.commit();

		const recent = await listRecentProjects( storage );
		expect( recent.map( r => r.title ) ).toEqual( [ 'p5', 'p11', 'p10', 'p9', 'p8', 'p7', 'p6', 'p4', 'p3', 'p2' ] );
		expect( recent[ 0 ] ).toEqual( { key: 'project:p5:https://x/5.glb', title: 'p5', savedAt: now, embedded: false } );
		expect( await storage.area( 'projects' ).has( 'not-a-project' ) ).toBe( true );

	} );

	it( 'remembers nothing when the record cannot be written, or there is no storage', async () => {

		class UnreadableBlob extends Blob {

			arrayBuffer() {

				return Promise.reject( new Error( 'gone' ) );

			}

		}

		await rememberProject( storage, { title: 'a', session: {} }, new UnreadableBlob( [ 'x' ] ) );
		expect( await listRecentProjects( storage ) ).toEqual( [] );
		expect( await storage.area( 'projects' ).list() ).toEqual( [] );

		await expect( rememberProject( null, { title: 'a' } ) ).resolves.toBeUndefined();
		expect( await listRecentProjects( null ) ).toEqual( [] );
		expect( await readRecentProject( null, 'project:a:' ) ).toBeNull();
		expect( await readRecentProject( storage, 'project:missing:' ) ).toBeNull();

	} );

	it( 'refuses what it cannot open', async () => {

		const session = { v: 1, title: 'a', source: { kind: 'url', url: 'https://x/a.glb' } };
		await expect( readProject( await projectZip( '{ not json' ) ) ).rejects.toThrow( 'x.rayzee is not a Rayzee project' );
		await expect( readProject( await projectZip( { format: 'other', session } ) ) ).rejects.toThrow( 'is not a Rayzee project' );
		await expect( readProject( await projectZip( { format: PROJECT_FORMAT, v: 2, session } ) ) ).rejects.toThrow( 'x.rayzee was saved by a newer Rayzee' );
		await expect( readProject( await projectZip( { format: PROJECT_FORMAT, v: 1, session: { ...session, v: 2 } } ) ) ).rejects.toThrow( 'newer Rayzee' );

		const linked = await readProject( await projectZip( { format: PROJECT_FORMAT, v: 1, embedded: 'sources/a.glb', session } ) );
		expect( linked.embeddedFile ).toBeNull();
		expect( linked.thumb ).toBeNull();

	} );

	it( 'asks to open a project file and keeps it under Recent', async () => {

		setApp( { isInitialized: true, storage } );
		const session = { v: 1, title: 'a.glb', source: { kind: 'url', url: 'https://x/a.glb' } };
		const file = await projectZip( { format: PROJECT_FORMAT, v: 1, title: 'a.glb', embedded: null, session } );

		await requestProjectOpen( file );
		expect( useStore.getState().sessionRequest ).toEqual( { origin: 'project', record: session, thumb: null, embeddedFile: null, embeddedFolder: null } );
		await vi.waitFor( async () => expect( ( await listRecentProjects( storage ) ).map( r => r.title ) ).toEqual( [ 'a.glb' ] ) );

	} );

} );
