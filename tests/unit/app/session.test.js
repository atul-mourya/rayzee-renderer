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
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { fileIdentity, folderIdentity, identityKey } from '@/core/storage/FileIdentity.js';
import { localFolder } from '@/core/loaders/ArchiveFormats.js';
import { ensureAppAreas } from '@/lib/storage';
import { SessionKeeper, listSessions, readSession, restoreSession, openSource, syncModelParam } from '@/lib/session';
import { snapshotPanels, restorePanels } from '@/lib/panelState';
import { readProject, PROJECT_FORMAT } from '@/lib/project';
import { zipInto } from '@/lib/zipSink';
import { usePathTracerStore, useCameraStore } from '@/store';
import { EngineEvents } from 'rayzee';
import { MODEL_FILES } from '@/Constants';

const encoder = new TextEncoder();

function fakeApp( storage, { source } = {} ) {

	const app = new EventTarget();
	app.dispatchEvent = EventTarget.prototype.dispatchEvent;
	const listen = app.addEventListener.bind( app );
	app.addEventListener = ( type, fn ) => listen( type, fn );
	Object.assign( app, {
		storage,
		sceneSource: source ?? { kind: 'url', url: 'https://example.com/a.glb', cacheKey: null },
		sceneModel: { name: 'A' },
		settings: new EventTarget(),
		edits: 0,
		exportSceneState() {

			return { v: 1, savedAt: Date.now(), edits: this.edits };

		},
		getCanvas: () => null,
		loadModel: vi.fn( async () => {} ),
		loadFile: vi.fn( async () => {} ),
		importSceneState: vi.fn( async () => ( { skipped: [] } ) ),
		lightManager: { getAll: () => [] },
		cameraManager: { getCameraNames: () => [ 'Default Camera' ] },
		currentCameraIndex: 0,
	} );
	return app;

}

describe( 'sessions', () => {

	let storage, uninstall;

	beforeEach( async () => {

		const fake = createFakeOPFS();
		uninstall = fake.install();
		const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );
		ensureAppAreas( storage );

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();

	} );

	it( 'saves only what changed since it was enabled, into one entry per tab', async () => {

		const app = fakeApp( storage );
		const keeper = new SessionKeeper( app, { delay: 5 } );
		await keeper.start();
		keeper.setEnabled( true );

		keeper.touch();
		await keeper.flush();
		expect( await listSessions( storage ) ).toHaveLength( 0 );

		app.edits = 1;
		keeper.touch();
		await keeper.flush();
		app.edits = 2;
		keeper.touch();
		await keeper.flush();

		const sessions = await listSessions( storage );
		expect( sessions ).toHaveLength( 1 );
		expect( sessions[ 0 ] ).toMatchObject( { id: keeper.id, title: 'a.glb', locked: true } );
		const entries = ( await storage.area( 'sessions' ).list() ).filter( m => m.extra?.id === keeper.id );
		expect( entries ).toHaveLength( 1 );
		expect( ( await readSession( storage, sessions[ 0 ].key ) ).record.scene.edits ).toBe( 2 );

		keeper.dispose();

	} );

	it( 'marks a session an open tab owns, and hands it over once that tab closes', async () => {

		const first = fakeApp( storage );
		const keeper = new SessionKeeper( first, { delay: 5 } );
		await keeper.start();
		keeper.setEnabled( true );
		first.edits = 1;
		keeper.touch();
		await keeper.flush();

		expect( ( await listSessions( storage ) )[ 0 ].locked ).toBe( true );
		keeper.dispose();

		const [ saved ] = await listSessions( storage );
		expect( saved ).toMatchObject( { title: 'a.glb', locked: false } );

		const second = new SessionKeeper( fakeApp( storage ), { delay: 5 } );
		await second.start();
		expect( await second.adopt( saved ) ).toBe( true );
		expect( second.id ).toBe( saved.id );
		expect( ( await listSessions( storage ) )[ 0 ].locked ).toBe( true );
		second.dispose();

	} );

	it( 'knows whether the scene is still as it loaded', async () => {

		const app = fakeApp( storage );
		const keeper = new SessionKeeper( app, { delay: 5 } );
		await keeper.start();
		expect( keeper.isAsLoaded() ).toBe( true );

		app.edits = 1;
		expect( keeper.isAsLoaded() ).toBe( false );

		app.sceneSource = { kind: 'url', url: 'https://example.com/b.glb', cacheKey: null };
		app.dispatchEvent( new Event( EngineEvents.MODEL_LOADED ) );
		expect( keeper.isAsLoaded() ).toBe( true );

		keeper.dispose();

	} );

	it( 'never saves a scene it could not reopen', async () => {

		const app = fakeApp( storage, { source: { kind: 'object3d', name: 'host' } } );
		const keeper = new SessionKeeper( app, { delay: 5 } );
		await keeper.start();
		keeper.setEnabled( true );
		app.edits = 1;
		keeper.touch();
		await keeper.flush();
		expect( await listSessions( storage ) ).toHaveLength( 0 );
		keeper.dispose();

	} );

	it( 'reopens a local file only once the user gives the same one back', async () => {

		const file = new File( [ encoder.encode( 'model bytes' ) ], 'chair.glb', { lastModified: 5 } );
		const identity = await fileIdentity( file );
		const app = fakeApp( storage );
		const source = { kind: 'local-file', file: identity, key: identityKey( identity ), element: 'parts/a' };

		const pickFile = vi.fn( async () => new File( [ encoder.encode( 'other bytes' ) ], 'chair.glb', { lastModified: 5 } ) );
		await expect( openSource( app, source, { pickFile } ) ).rejects.toMatchObject( { code: 'SESSION_FILE_MISMATCH' } );
		expect( pickFile ).toHaveBeenCalledWith( identity, 'model' );

		expect( await openSource( app, source, { pickFile: async () => null } ) ).toBe( false );

		await restoreSession( app, { source, scene: { v: 1 }, panels: {} }, { pickFile: async () => file } );
		expect( app.loadFile ).toHaveBeenCalledWith( file, { element: 'parts/a' } );
		expect( app.importSceneState ).toHaveBeenCalledWith( { v: 1 }, expect.objectContaining( { resolve: expect.any( Function ) } ) );

	} );

	it( 'reopens a folder by its name, whether or not its contents changed since', async () => {

		const files = [ { path: 'Room/scene.gltf', file: new File( [ '{}' ], 'scene.gltf', { lastModified: 5 } ) } ];
		const identity = await folderIdentity( localFolder( { files } ) );
		const app = fakeApp( storage );
		const source = { kind: 'local-folder', folder: identity, key: identityKey( identity ), element: 'Room/a' };

		const pickFile = vi.fn( async () => ( { folder: { name: 'Hall', files }, handle: null } ) );
		await expect( openSource( app, source, { pickFile } ) ).rejects.toMatchObject( { code: 'SESSION_FILE_MISMATCH' } );
		expect( pickFile ).toHaveBeenCalledWith( { ...identity, key: source.key, flat: false }, 'folder' );
		expect( await openSource( app, source, { pickFile: async () => null } ) ).toBe( false );

		const changed = { files: [ ...files, { path: 'Room/new.png', file: new File( [ 'x' ], 'new.png' ) } ] };
		expect( await openSource( app, source, { pickFile: async () => ( { folder: changed, handle: null } ) } ) ).toBe( true );
		expect( app.loadFile ).toHaveBeenLastCalledWith( changed, { element: 'Room/a' } );

		const loose = { files: [ { path: 'scene.gltf', file: files[ 0 ].file } ] };
		expect( await openSource( app, { ...source, flat: true }, { pickFile: async () => ( { folder: loose, handle: null } ) } ) ).toBe( true );
		expect( app.loadFile ).toHaveBeenLastCalledWith( loose, { element: 'Room/a' } );

	} );

	it( 'saves a folder\'s scene under the folder\'s name', async () => {

		const identity = { name: 'Room', size: 2, lastModified: 5, sample: 'ab', files: 1 };
		const app = fakeApp( storage, { source: { kind: 'local-folder', folder: identity, key: identityKey( identity ) } } );
		const keeper = new SessionKeeper( app, { delay: 5 } );
		await keeper.start();
		keeper.setEnabled( true );
		app.edits = 1;
		keeper.touch();
		await keeper.flush();
		expect( ( await listSessions( storage ) )[ 0 ] ).toMatchObject( { title: 'Room' } );
		keeper.dispose();

	} );

	it( 'reopens a catalog model from where the catalog has it now', async () => {

		const app = fakeApp( storage );
		await openSource( app, { kind: 'url', url: 'https://old.cdn/x.glb', catalog: 'Classroom 2' }, { pickFile: vi.fn() } );
		expect( app.loadModel.mock.calls[ 0 ][ 0 ] ).toMatch( /classroom2-lit\.glb$/ );

		await openSource( app, { kind: 'url', url: 'https://old.cdn/cornell-box.zip', filename: 'cornell-box.zip', catalog: 'Cornell Box' }, { pickFile: vi.fn() } );
		expect( app.loadFile ).toHaveBeenCalledWith( expect.stringMatching( /\/pbrt-scenes\/cornell-box\.zip$/ ), { filename: 'cornell-box.zip' } );

		await openSource( app, { kind: 'url', url: 'https://s.test/x.zip', filename: 'x.zip', cacheKey: 'sketchfab:1:gltf' }, { pickFile: vi.fn() } );
		expect( app.loadFile ).toHaveBeenCalledWith( 'https://s.test/x.zip', { filename: 'x.zip', cacheKey: 'sketchfab:1:gltf' } );

	} );

	it( 'keeps the model on screen only when it is the session\'s, loaded the same way', async () => {

		const url = MODEL_FILES.find( m => m.name === 'Classroom 2' ).url;
		const saved = { kind: 'url', url: 'https://old.cdn/x.glb', catalog: 'Classroom 2', element: [ 'a', 'b' ], pbrtEntry: 'scene.pbrt' };
		const record = { source: saved, scene: { v: 1 }, panels: {} };
		const loaded = { kind: 'url', url, cacheKey: null, element: [ 'a', 'b' ], pbrtEntry: 'scene.pbrt' };
		const opens = async ( sceneSource, reuseLoaded = true ) => {

			const app = fakeApp( storage, { source: sceneSource } );
			await restoreSession( app, record, { pickFile: vi.fn(), reuseLoaded } );
			return app.loadModel.mock.calls.length + app.loadFile.mock.calls.length;

		};

		expect( await opens( loaded ) ).toBe( 0 );
		expect( await opens( loaded, false ) ).toBe( 1 );
		expect( await opens( { ...loaded, url: saved.url } ) ).toBe( 1 );
		expect( await opens( { ...loaded, cacheKey: 'sketchfab:1:gltf' } ) ).toBe( 1 );
		expect( await opens( { ...loaded, element: [ 'a' ] } ) ).toBe( 1 );
		expect( await opens( { ...loaded, pbrtEntry: undefined } ) ).toBe( 1 );
		expect( await opens( { ...loaded, kind: 'local-file' } ) ).toBe( 1 );

	} );

	it( 'asks for a session\'s sky file by the identity it saved, and refuses another', async () => {

		const hdr = new File( [ encoder.encode( 'sky bytes' ) ], 'sky|night.hdr', { lastModified: 7 } );
		const identity = await fileIdentity( hdr );
		const app = fakeApp( storage );
		let resolve;
		app.importSceneState = vi.fn( async ( scene, options ) => ( resolve = options.resolve, { skipped: [] } ) );
		const pickFile = vi.fn( async () => hdr );
		await restoreSession( app, { source: app.sceneSource, scene: { v: 1 }, panels: {} }, { pickFile, reuseLoaded: true } );

		expect( await resolve( { kind: 'environment', source: identityKey( identity ) } ) ).toBe( hdr );
		expect( pickFile ).toHaveBeenCalledWith( identity, 'environment' );

		pickFile.mockResolvedValueOnce( new File( [ encoder.encode( 'other sky' ) ], 'sky|night.hdr', { lastModified: 7 } ) );
		await expect( resolve( { kind: 'environment', source: identityKey( identity ) } ) ).rejects.toMatchObject( { code: 'SESSION_FILE_MISMATCH' } );
		pickFile.mockResolvedValueOnce( null );
		expect( await resolve( { kind: 'environment', source: identityKey( identity ) } ) ).toBeNull();

		pickFile.mockClear();
		for ( const source of [ 'folder:sky|9|7|ab', 'file:sky.hdr|9|7', 'file:sky.hdr|9|7|AB', undefined ] ) {

			expect( await resolve( { kind: 'environment', source } ) ).toBeNull();

		}

		expect( await resolve( { kind: 'texture', source: identityKey( identity ) } ) ).toBeNull();
		expect( pickFile ).not.toHaveBeenCalled();

	} );

	it( 'points ?model= at a plain link and clears it otherwise', () => {

		const replaceState = vi.spyOn( window.history, 'replaceState' );
		syncModelParam( { kind: 'url', url: 'https://example.com/a.glb' } );
		expect( String( replaceState.mock.calls.at( - 1 )[ 2 ] ) ).toContain( 'model=https%3A%2F%2Fexample.com%2Fa.glb' );
		window.location.href = 'https://rayzee.test/?model=x';
		syncModelParam( { kind: 'url', url: 'https://s.test/x.zip', cacheKey: 'k' } );
		expect( String( replaceState.mock.calls.at( - 1 )[ 2 ] ) ).toBe( 'https://rayzee.test/' );
		window.location.href = 'https://rayzee.test/';

	} );

} );

describe( 'panel state', () => {

	it( 'puts the panels back, refusing values of another kind', () => {

		usePathTracerStore.setState( { bounces: 7, exposure: 1.5 } );
		useCameraStore.setState( { fov: 42, afScreenPoint: { x: 0.1, y: 0.9 } } );
		const snapshot = JSON.parse( JSON.stringify( snapshotPanels() ) );
		expect( snapshot.pathTracer.showInspector ).toBeUndefined();

		usePathTracerStore.setState( { bounces: 2, exposure: 1 } );
		useCameraStore.setState( { fov: 60 } );
		restorePanels( { ...snapshot, pathTracer: { ...snapshot.pathTracer, exposure: 'loud', noSuchKey: 1 } } );

		expect( usePathTracerStore.getState().bounces ).toBe( 7 );
		expect( usePathTracerStore.getState().exposure ).toBe( 1 );
		expect( 'noSuchKey' in usePathTracerStore.getState() ).toBe( false );
		expect( useCameraStore.getState().fov ).toBe( 42 );
		expect( useCameraStore.getState().afScreenPoint ).toEqual( { x: 0.1, y: 0.9 } );

	} );

} );

describe( 'project files', () => {

	it( 'reads a project and hands back its model without copying it', async () => {

		const model = new File( [ new Uint8Array( 300_000 ).map( ( _, i ) => i * 7 ) ], 'room.glb', { lastModified: 9 } );
		const identity = await fileIdentity( model );
		const manifest = {
			format: PROJECT_FORMAT, v: 1, title: 'room.glb', embedded: 'sources/room.glb',
			session: { v: 1, title: 'room.glb', source: { kind: 'local-file', file: identity }, scene: { v: 1 }, panels: {} },
		};

		const chunks = [];
		const zip = zipInto( { push: c => chunks.push( c ), drain: async () => {} } );
		zip.addBytes( 'project.json', encoder.encode( JSON.stringify( manifest ) ) );
		await zip.addBlob( 'sources/room.glb', model );
		await zip.finish();

		const project = await readProject( new File( chunks, 'room.rayzee' ) );
		expect( project.record.title ).toBe( 'room.glb' );
		expect( project.embeddedFile.name ).toBe( 'room.glb' );
		expect( await fileIdentity( project.embeddedFile ) ).toEqual( identity );

		await expect( readProject( new File( [ encoder.encode( 'nope' ) ], 'x.rayzee' ) ) ).rejects.toThrow();

	} );

	it( 'hands back the folder a project carries, each file a slice of it', async () => {

		const identity = { name: 'Room', size: 7, lastModified: 5, sample: 'ab', files: 2 };
		const manifest = {
			format: PROJECT_FORMAT, v: 1, title: 'Room', embedded: null, embeddedFolder: 'sources/folder/', savedAt: 42,
			session: { v: 1, title: 'Room', source: { kind: 'local-folder', folder: identity }, scene: { v: 1 }, panels: {} },
		};

		const chunks = [];
		const zip = zipInto( { push: c => chunks.push( c ), drain: async () => {} } );
		zip.addBytes( 'project.json', encoder.encode( JSON.stringify( manifest ) ) );
		await zip.addBlob( 'sources/folder/Room/scene.gltf', new Blob( [ '{"a":1}' ] ) );
		await zip.addBlob( 'sources/folder/Room/tex/a b.png', new Blob( [] ) );
		await zip.finish();

		const { embeddedFolder, embeddedFile } = await readProject( new File( chunks, 'room.rayzee' ) );
		expect( embeddedFile ).toBeNull();
		expect( embeddedFolder.name ).toBe( 'Room' );
		expect( embeddedFolder.files.map( e => e.path ) ).toEqual( [ 'Room/scene.gltf', 'Room/tex/a b.png' ] );
		expect( await embeddedFolder.files[ 0 ].file.text() ).toBe( '{"a":1}' );
		expect( embeddedFolder.files[ 1 ].file.size ).toBe( 0 );
		expect( embeddedFolder.files[ 0 ].file.lastModified ).toBe( 42 );

	} );

} );
