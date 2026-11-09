import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolveObjectURL } from 'node:buffer';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { createFakeIndexedDB } from '../../__mocks__/indexedDB.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { STORAGE_KIND } from '@/core/addons/storage/StorageManager.js';

// Only what database.js and storage.js take from the engine, without loading all of it on every reset.
vi.mock( 'rayzee', async () => ( { ...await import( '@/core/Logger.js' ), ...await import( '@/core/storage/StorageAreas.js' ) } ) );

// An image here is its own size as text, so the fake decoder knows it.
const png = ( width, height ) => new Blob( [ `${width}x${height}` ], { type: 'image/png' } );
const dataURL = ( text ) => `data:image/png;base64,${Buffer.from( text ).toString( 'base64' )}`;
const textAt = ( url ) => resolveObjectURL( url ).text();

const bitmaps = [];

async function decode( blob ) {

	const [ width, height ] = ( await blob.text() ).split( 'x' ).map( Number );
	const bitmap = { width, height, close: vi.fn() };
	bitmaps.push( bitmap );
	return bitmap;

}

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

class FakeFileReader {

	readAsDataURL( blob ) {

		blob.arrayBuffer().then( ( buffer ) => {

			this.result = `data:${blob.type || 'application/octet-stream'};base64,${Buffer.from( buffer ).toString( 'base64' )}`;
			this.onload();

		} );

	}

}

describe( 'saved renders', () => {

	let db, idb, opfs, storage, uninstall, setApp;

	const withStorage = () => setApp( { isInitialized: true, storage } );
	const stored = ( id ) => idb.records( 'RenderResultsDB', 'renders' ).get( id );
	const seed = ( records, version = 4 ) => idb.seed( 'RenderResultsDB', version, { renders: { keyPath: 'id', autoIncrement: true, records } } );

	beforeEach( async () => {

		vi.resetModules();
		bitmaps.length = 0;
		idb = createFakeIndexedDB();
		vi.stubGlobal( 'indexedDB', idb.indexedDB );
		vi.stubGlobal( 'window', new EventTarget() );
		vi.stubGlobal( 'createImageBitmap', decode );
		vi.stubGlobal( 'OffscreenCanvas', FakeCanvas );
		vi.stubGlobal( 'FileReader', FakeFileReader );
		opfs = createFakeOPFS();
		uninstall = opfs.install();
		const root = await opfs.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );
		storage.defineArea( 'renders', { kind: STORAGE_KIND.USER } );
		( { setApp } = await import( '@/lib/appProxy' ) );
		db = await import( '@/lib/database' );

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	it( 'makes a thumbnail no larger than 320 a side and keeps the size', async () => {

		const wide = await db.makeThumbnail( png( 1000, 500 ) );
		expect( [ wide.width, wide.height ] ).toEqual( [ 1000, 500 ] );
		expect( await wide.thumb.text() ).toBe( 'thumb 320x160' );
		expect( wide.thumb.type ).toBe( 'image/webp' );
		expect( await ( await db.makeThumbnail( png( 200, 1000 ) ) ).thumb.text() ).toBe( 'thumb 64x320' );
		expect( await ( await db.makeThumbnail( png( 40, 30 ) ) ).thumb.text() ).toBe( 'thumb 40x30' );
		expect( bitmaps.every( ( b ) => b.close.mock.calls.length === 1 ) ).toBe( true );

	} );

	it( 'saves a render as files and shows it through URLs', async () => {

		withStorage();
		const id = await db.saveRender( {
			image: png( 1000, 500 ), hdr: new Uint8Array( [ 1, 2, 3 ] ), renderTime: 12, colorCorrection: { exposure: 2 }, timestamp: new Date( 1000 ),
		} );

		const record = stored( id );
		expect( [ ...record.files ].sort() ).toEqual( [ 'hdr.exr', 'image.png', 'thumb.webp' ] );
		expect( record.blobs ).toBeUndefined();
		expect( record ).toMatchObject( { id, width: 1000, height: 500, renderTime: 12, isEdited: false, colorCorrection: { exposure: 2 } } );
		expect( record.aiVersions ).toBeUndefined();
		expect( record.timestamp.getTime() ).toBe( 1000 );
		expect( await storage.area( 'renders' ).has( `render:${id}` ) ).toBe( true );

		const view = await db.getRenderById( id );
		expect( await textAt( view.image ) ).toBe( '1000x500' );
		expect( await textAt( view.thumb ) ).toBe( 'thumb 320x160' );
		expect( view.aiVersions ).toEqual( [] );
		expect( view.hasHDR ).toBe( true );
		expect( view.files ).toBeUndefined();
		expect( ( await db.getRenderById( id ) ).image ).toBe( view.image );

		expect( [ ...new Uint8Array( await ( await db.getRenderHDR( id ) ).arrayBuffer() ) ] ).toEqual( [ 1, 2, 3 ] );
		expect( Object.keys( await db.getRenderFiles( id ) ).sort() ).toEqual( [ 'hdr.exr', 'image.png', 'thumb.webp' ] );

	} );

	it( 'keeps the images in the database without storage', async () => {

		const id = await db.saveRender( { image: dataURL( '40x30' ), aiGeneratedImage: png( 8, 8 ) } );

		const record = stored( id );
		expect( record.files ).toBeUndefined();
		expect( Object.keys( record.blobs ).sort() ).toEqual( [ 'ai-1.png', 'image.png', 'thumb.webp' ] );

		const [ view ] = await db.getAllRenders();
		expect( await textAt( view.image ) ).toBe( '40x30' );
		expect( await textAt( view.thumb ) ).toBe( 'thumb 40x30' );
		expect( await textAt( view.aiVersions[ 0 ].url ) ).toBe( '8x8' );
		expect( view.hasHDR ).toBe( false );
		expect( await db.getRenderHDR( id ) ).toBeNull();
		expect( await ( await db.getRenderFiles( id ) )[ 'ai-1.png' ].text() ).toBe( '8x8' );

	} );

	it( 'falls back to the database when a file fails to write, leaving no entry behind', async () => {

		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		withStorage();
		opfs.state.faults.failWriteOf = 'thumb.webp';
		const id = await db.saveRender( { image: png( 10, 10 ) } );

		expect( stored( id ).files ).toBeUndefined();
		expect( Object.keys( stored( id ).blobs ).sort() ).toEqual( [ 'image.png', 'thumb.webp' ] );
		expect( await storage.area( 'renders' ).has( `render:${id}` ) ).toBe( false );
		expect( console.warn ).toHaveBeenCalled();

	} );

	it( 'falls back to the database when storage has no room', async () => {

		withStorage();
		opfs.state.quota = 1024;
		const id = await db.saveRender( { image: png( 10, 10 ) } );
		expect( stored( id ).blobs[ 'image.png' ] ).toBeInstanceOf( Blob );
		expect( stored( id ).files ).toBeUndefined();

	} );

	it( 'refuses a save without an image', async () => {

		await expect( db.saveRender( { image: 42 } ) ).rejects.toThrow( 'no image' );
		expect( idb.records( 'RenderResultsDB', 'renders' ).size ).toBe( 0 );

	} );

	it( 'lists renders newest first, leaving out records with nothing to show', async () => {

		seed( [
			{ id: 1, timestamp: new Date( 1000 ), image: dataURL( '1x1' ) },
			{ id: 2, timestamp: new Date( 3000 ), image: dataURL( '1x1' ) },
			{ id: 3, image: dataURL( '1x1' ) },
			{ id: 4, timestamp: new Date( 4000 ) },
			{ id: 5, timestamp: new Date( 2000 ), image: dataURL( '1x1' ) },
		] );

		expect( ( await db.getAllRenders() ).map( ( r ) => r.id ) ).toEqual( [ 2, 5, 1 ] );

	} );

	it( 'lists the other renders when one cannot be read', async () => {

		vi.spyOn( console, 'error' ).mockImplementation( () => {} );
		withStorage();
		const broken = await db.saveRender( { image: png( 2, 2 ), timestamp: new Date( 1000 ) } );
		const fine = await db.saveRender( { image: png( 3, 3 ), timestamp: new Date( 2000 ) } );
		const area = storage.area( 'renders' );
		const open = area.open.bind( area );
		vi.spyOn( area, 'open' ).mockImplementation( ( key ) => ( key === `render:${broken}` ? Promise.reject( new Error( 'unreadable' ) ) : open( key ) ) );

		const views = await db.getAllRenders();

		expect( views.map( ( r ) => r.id ) ).toEqual( [ fine ] );
		expect( await textAt( views[ 0 ].image ) ).toBe( '3x3' );
		expect( console.error ).toHaveBeenCalled();

	} );

	it( 'shows and exports a render saved by an earlier build as data URLs', async () => {

		seed( [ { id: 7, timestamp: new Date( 1 ), image: dataURL( '4x4' ), aiGeneratedImage: dataURL( 'ai' ) } ] );

		const [ view ] = await db.getAllRenders();
		expect( view.image ).toBe( dataURL( '4x4' ) );
		expect( view.thumb ).toBe( view.image );
		expect( view.hasHDR ).toBe( false );
		expect( view.aiVersions ).toEqual( [ { n: 1, file: 'ai.png', prompt: '', legacy: true, url: dataURL( 'ai' ) } ] );

		const files = await db.getRenderFiles( 7 );
		expect( Object.keys( files ).sort() ).toEqual( [ 'ai.png', 'image.png' ] );
		expect( await files[ 'ai.png' ].text() ).toBe( 'ai' );
		expect( await db.getRenderFiles( 99 ) ).toEqual( {} );
		expect( await db.getRenderHDR( 99 ) ).toBeNull();
		expect( await db.getRenderById( 99 ) ).toBeNull();

	} );

	it( 'updates details in place, keeping the images', async () => {

		withStorage();
		const id = await db.saveRender( { image: png( 2, 2 ), isEdited: false } );
		const files = stored( id ).files;

		expect( await db.updateRender( id, { isEdited: true, colorCorrection: { contrast: 3 }, id: 99 } ) ).toBe( true );
		expect( stored( id ) ).toMatchObject( { id, isEdited: true, colorCorrection: { contrast: 3 }, files } );
		expect( stored( 99 ) ).toBeUndefined();
		await expect( db.updateRender( 42, {} ) ).rejects.toThrow( 'Render with ID 42 not found' );

	} );

	it( 'deletes a render with its files and revokes its URLs', async () => {

		withStorage();
		const id = await db.saveRender( { image: png( 2, 2 ) } );
		const view = await db.getRenderById( id );
		const revoke = vi.spyOn( URL, 'revokeObjectURL' );

		expect( await db.deleteRender( id ) ).toBe( true );
		expect( stored( id ) ).toBeUndefined();
		expect( await storage.area( 'renders' ).has( `render:${id}` ) ).toBe( false );
		expect( revoke.mock.calls.map( ( [ url ] ) => url ).sort() ).toEqual( [ view.image, view.thumb ].sort() );
		expect( await db.getRenderById( id ) ).toBeNull();

	} );

	it( 'keeps each AI version in an entry of its own, numbered and never reused', async () => {

		withStorage();
		const id = await db.saveRender( { image: png( 2, 2 ) } );
		const area = storage.area( 'renders' );

		expect( await db.addAIVersion( id, { blob: png( 8, 8 ), prompt: 'a sunset', scope: 'only', width: 8, height: 8 } ) ).toBe( 1 );
		expect( await db.addAIVersion( id, { blob: new Blob( [ '6x6' ], { type: 'image/jpeg' } ), prompt: 'snow' } ) ).toBe( 2 );
		expect( [ ...stored( id ).files ].sort() ).toEqual( [ 'image.png', 'thumb.webp' ] );
		expect( stored( id ).aiVersions.map( ( v ) => [ v.n, v.file, v.prompt ] ) ).toEqual( [[ 1, 'ai-1.png', 'a sunset' ], [ 2, 'ai-2.jpg', 'snow' ]] );
		expect( await area.has( `render:${id}:v1` ) ).toBe( true );

		let view = await db.getRenderById( id );
		expect( view.aiVersions.map( ( v ) => v.n ) ).toEqual( [ 1, 2 ] );
		expect( await textAt( view.aiVersions[ 0 ].url ) ).toBe( '8x8' );
		expect( await textAt( view.image ) ).toBe( '2x2' );
		expect( await ( await db.getAIVersionFile( id, 2 ) ).text() ).toBe( '6x6' );
		expect( Object.keys( await db.getRenderFiles( id ) ).sort() ).toEqual( [ 'ai-1.png', 'ai-2.jpg', 'image.png', 'thumb.webp' ] );

		expect( await db.deleteAIVersion( id, 2 ) ).toBe( true );
		expect( await area.has( `render:${id}:v2` ) ).toBe( false );
		expect( await db.deleteAIVersion( id, 2 ) ).toBe( false );
		expect( await db.addAIVersion( id, { blob: png( 3, 3 ), prompt: 'again' } ) ).toBe( 3 );
		view = await db.getRenderById( id );
		expect( view.aiVersions.map( ( v ) => v.n ) ).toEqual( [ 1, 3 ] );

		await db.deleteRender( id );
		expect( await area.has( `render:${id}:v1` ) ).toBe( false );
		expect( await area.has( `render:${id}:v3` ) ).toBe( false );
		await expect( db.addAIVersion( 42, { blob: png( 1, 1 ) } ) ).rejects.toThrow( 'not found' );

	} );

	it( 'keeps AI versions in the database without storage', async () => {

		const id = await db.saveRender( { image: png( 2, 2 ) } );
		await db.addAIVersion( id, { blob: png( 5, 5 ), prompt: 'p' } );
		expect( Object.keys( stored( id ).blobs ).sort() ).toEqual( [ 'ai-1.png', 'image.png', 'thumb.webp' ] );
		expect( await textAt( ( await db.getRenderById( id ) ).aiVersions[ 0 ].url ) ).toBe( '5x5' );

		await db.deleteAIVersion( id, 1 );
		expect( Object.keys( stored( id ).blobs ).sort() ).toEqual( [ 'image.png', 'thumb.webp' ] );
		expect( ( await db.getRenderById( id ) ).aiVersions ).toEqual( [] );

	} );

	it( 'reads an earlier build\'s AI image as version 1 and numbers on from it', async () => {

		seed( [ { id: 1, timestamp: new Date( 1 ), image: dataURL( '1x1' ), aiGeneratedImage: dataURL( 'old' ), aiPrompt: 'given' } ] );

		expect( await db.addAIVersion( 1, { blob: png( 3, 3 ), prompt: 'new' } ) ).toBe( 2 );
		const record = stored( 1 );
		expect( record.image ).toBeUndefined();
		expect( record.aiGeneratedImage ).toBeUndefined();
		expect( Object.keys( record.blobs ).sort() ).toEqual( [ 'ai-2.png', 'ai.png', 'image.png', 'thumb.webp' ] );
		expect( record.aiVersions.map( ( v ) => [ v.n, v.prompt, !! v.legacy ] ) ).toEqual( [[ 1, 'given', true ], [ 2, 'new', false ]] );

		const view = await db.getRenderById( 1 );
		expect( await textAt( view.aiVersions[ 0 ].url ) ).toBe( 'old' );
		expect( await textAt( view.image ) ).toBe( '1x1' );

		await db.deleteAIVersion( 1, 1 );
		expect( Object.keys( stored( 1 ).blobs ).sort() ).toEqual( [ 'ai-2.png', 'image.png', 'thumb.webp' ] );
		expect( ( await db.getRenderById( 1 ) ).aiVersions.map( ( v ) => v.n ) ).toEqual( [ 2 ] );

	} );

	it( 'hides an earlier build\'s AI file once its version is deleted', async () => {

		withStorage();
		const id = await db.saveRender( { image: png( 2, 2 ) } );
		const writer = await storage.area( 'renders' ).edit( `render:${id}` );
		await writer.writeFile( 'ai.png', png( 4, 4 ) );
		const meta = await writer.commit();
		await db.updateRender( id, { files: Object.keys( meta.files ), aiPrompt: 'old one' } );

		const view = await db.getRenderById( id );
		expect( view.aiVersions.map( ( v ) => [ v.n, v.prompt ] ) ).toEqual( [[ 1, 'old one' ]] );
		expect( await textAt( view.aiVersions[ 0 ].url ) ).toBe( '4x4' );

		await db.deleteAIVersion( id, 1 );
		expect( ( await db.getRenderById( id ) ).aiVersions ).toEqual( [] );
		expect( await db.addAIVersion( id, { blob: png( 1, 1 ) } ) ).toBe( 1 );

	} );

	it( 'moves AI versions kept in a record into entries of their own, and keeps those entries', async () => {

		seed( [ { id: 1, timestamp: new Date( 1 ), width: 2, height: 2, blobs: { 'image.png': png( 2, 2 ), 'thumb.webp': new Blob( [ 't' ] ), 'ai-1.png': png( 7, 7 ) },
			aiVersions: [ { n: 1, file: 'ai-1.png', prompt: 'kept' } ], aiNext: 2 } ] );
		withStorage();
		vi.spyOn( console, 'log' ).mockImplementation( () => {} );

		expect( await db.startRenderMaintenance() ).toBe( 1 );
		expect( stored( 1 ).blobs ).toBeUndefined();
		expect( [ ...stored( 1 ).files ].sort() ).toEqual( [ 'image.png', 'thumb.webp' ] );
		expect( await storage.area( 'renders' ).has( 'render:1:v1' ) ).toBe( true );
		expect( await ( await db.getAIVersionFile( 1, 1 ) ).text() ).toBe( '7x7' );

	} );

	it( 'exports every record\'s details without its images', async () => {

		seed( [
			{ id: 1, timestamp: new Date( 1 ), image: dataURL( '1x1' ), aiGeneratedImage: dataURL( 'a' ), renderTime: 5 },
			{ id: 2, timestamp: new Date( 2 ), files: [ 'image.png' ], blobs: {}, isEdited: true },
		] );

		const records = await db.getRenderRecords();
		expect( records ).toEqual( [ { id: 1, timestamp: new Date( 1 ), renderTime: 5 }, { id: 2, timestamp: new Date( 2 ), isEdited: true } ] );

	} );

	it( 'moves images kept in records onto files and drops files of deleted renders', async () => {

		const blob = { 'image.png': png( 6, 3 ), 'thumb.webp': new Blob( [ 'kept thumb' ] ) };
		seed( [
			{ id: 1, timestamp: new Date( 1 ), image: dataURL( '1000x500' ), aiGeneratedImage: dataURL( 'ai' ) },
			{ id: 2, timestamp: new Date( 2 ), blobs: blob, width: 6, height: 3 },
			{ id: 3, timestamp: new Date( 3 ), files: [ 'image.png' ] },
			{ id: 4, timestamp: new Date( 4 ) },
		] );
		const orphan = await storage.area( 'renders' ).create( 'render:99' );
		await orphan.writeFile( 'image.png', png( 1, 1 ) );
		await orphan.commit();
		withStorage();
		const saved = vi.fn();
		window.addEventListener( 'render-saved', saved );
		vi.spyOn( console, 'log' ).mockImplementation( () => {} );

		const run = db.startRenderMaintenance();
		expect( db.startRenderMaintenance() ).toBe( run );
		expect( await run ).toBe( 2 );

		expect( stored( 1 ).image ).toBeUndefined();
		expect( stored( 1 ).aiGeneratedImage ).toBeUndefined();
		expect( stored( 1 ) ).toMatchObject( { width: 1000, height: 500 } );
		expect( [ ...stored( 1 ).files ].sort() ).toEqual( [ 'ai.png', 'image.png', 'thumb.webp' ] );
		expect( stored( 2 ).blobs ).toBeUndefined();
		expect( [ ...stored( 2 ).files ].sort() ).toEqual( [ 'image.png', 'thumb.webp' ] );
		expect( stored( 3 ).files ).toEqual( [ 'image.png' ] );
		expect( await storage.area( 'renders' ).has( 'render:99' ) ).toBe( false );
		expect( saved ).toHaveBeenCalledTimes( 1 );

		const files = await db.getRenderFiles( 2 );
		expect( await files[ 'thumb.webp' ].text() ).toBe( 'kept thumb' );
		expect( await ( await db.getRenderFiles( 1 ) )[ 'thumb.webp' ].text() ).toBe( 'thumb 320x160' );

	} );

	it( 'leaves records as they are when storage is missing or full', async () => {

		seed( [ { id: 1, timestamp: new Date( 1 ), image: dataURL( '2x2' ) } ] );
		expect( await db.startRenderMaintenance() ).toBe( 0 );

		vi.resetModules();
		( { setApp } = await import( '@/lib/appProxy' ) );
		db = await import( '@/lib/database' );
		withStorage();
		opfs.state.quota = 1024;
		expect( await db.startRenderMaintenance() ).toBe( 0 );
		expect( stored( 1 ).image ).toBe( dataURL( '2x2' ) );

	} );

	it( 'shows nothing when a file a record names is gone', async () => {

		withStorage();
		const id = await db.saveRender( { image: png( 2, 2 ), hdr: new Uint8Array( 1 ) } );
		await storage.area( 'renders' ).remove( `render:${id}` );
		expect( await db.getRenderHDR( id ) ).toBeNull();
		expect( ( await db.getRenderById( id ) ).image ).toBeNull();

	} );

	it( 'says when the browser has no IndexedDB, and opens it once there is one', async () => {

		vi.spyOn( console, 'error' ).mockImplementation( () => {} );
		vi.stubGlobal( 'indexedDB', undefined );
		await expect( db.saveRender( { image: png( 1, 1 ) } ) ).rejects.toThrow( "doesn't support IndexedDB" );
		expect( await db.getAllRenders() ).toEqual( [] );

		vi.stubGlobal( 'indexedDB', idb.indexedDB );
		const connection = await db.initDatabase();
		expect( connection.version ).toBe( 4 );
		expect( connection.objectStoreNames.contains( 'renders' ) ).toBe( true );
		expect( idb.databases.get( 'RenderResultsDB' ).stores.get( 'renders' ).indexes.has( 'timestamp' ) ).toBe( true );

	} );

	it( 'opens a library a newer build has upgraded', async () => {

		seed( [ { id: 3, timestamp: new Date( 1 ), image: dataURL( '1x1' ) } ], 5 );
		expect( ( await db.getAllRenders() ).map( ( r ) => r.id ) ).toEqual( [ 3 ] );
		expect( ( await db.initDatabase() ).version ).toBe( 5 );

	} );

	it( 'upgrades a library from an earlier build, keeping its renders', async () => {

		seed( [ { id: 3, timestamp: new Date( 1 ), image: dataURL( '1x1' ) } ], 3 );
		expect( ( await db.initDatabase() ).version ).toBe( 4 );
		expect( ( await db.getAllRenders() ).map( ( r ) => r.id ) ).toEqual( [ 3 ] );

	} );

	it( 'tries the database again after it failed to open', async () => {

		idb.faults.open = 'UnknownError';
		await expect( db.initDatabase() ).rejects.toThrow( 'UnknownError' );
		idb.faults.open = null;
		expect( ( await db.initDatabase() ).version ).toBe( 4 );

	} );

	it( 'shows an empty library when reading it fails', async () => {

		vi.spyOn( console, 'error' ).mockImplementation( () => {} );
		seed( [ { id: 1, timestamp: new Date( 1 ), image: dataURL( '1x1' ) } ] );
		idb.faults.ops = [ 'getAll' ];
		expect( await db.getAllRenders() ).toEqual( [] );
		expect( console.error ).toHaveBeenCalled();

	} );

} );
