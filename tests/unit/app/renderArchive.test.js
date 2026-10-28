import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { createFakeIndexedDB } from '../../__mocks__/indexedDB.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { STORAGE_KIND } from '@/core/addons/storage/StorageManager.js';
import { openZip } from '@/core/addons/archives/ZipReader.js';
import { zipInto } from '@/lib/zipSink';

// Only what these modules take from the engine, without loading all of it on every reset.
vi.mock( 'rayzee', async () => ( {
	...await import( '@/core/Logger.js' ), ...await import( '@/core/storage/StorageAreas.js' ), ...await import( '@/core/addons/archives/ZipReader.js' ),
} ) );

const encoder = new TextEncoder();
const png = ( width, height ) => new Blob( [ `${width}x${height}` ], { type: 'image/png' } );

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

async function decode( blob ) {

	const [ width, height ] = ( await blob.text() ).split( 'x' ).map( Number );
	return { width, height, close: () => {} };

}

async function zipOf( entries ) {

	const chunks = [];
	const zip = zipInto( { push: ( c ) => chunks.push( c ), drain: async () => {} } );
	for ( const [ path, value ] of Object.entries( entries ) ) zip.addBytes( path, encoder.encode( typeof value === 'string' ? value : JSON.stringify( value ) ) );
	await zip.finish();
	return new File( chunks, 'renders.zip' );

}

describe( 'render archives', () => {

	let db, archive, storage, uninstall;

	beforeEach( async () => {

		vi.resetModules();
		vi.stubGlobal( 'indexedDB', createFakeIndexedDB().indexedDB );
		vi.stubGlobal( 'window', new EventTarget() );
		vi.stubGlobal( 'createImageBitmap', decode );
		vi.stubGlobal( 'OffscreenCanvas', FakeCanvas );
		const opfs = createFakeOPFS();
		uninstall = opfs.install();
		const root = await opfs.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );
		storage.defineArea( 'renders', { kind: STORAGE_KIND.USER } );
		( await import( '@/lib/appProxy' ) ).setApp( { isInitialized: true, storage } );
		db = await import( '@/lib/database' );
		archive = await import( '@/lib/renderArchive' );

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();
		vi.unstubAllGlobals();

	} );

	function pickSaveFile() {

		const chunks = [];
		const writable = { write: async ( chunk ) => chunks.push( chunk ), close: vi.fn( async () => {} ), abort: vi.fn() };
		window.showSaveFilePicker = vi.fn( async () => ( { createWritable: async () => writable } ) );
		return { file: () => new File( chunks, 'renders.zip' ), writable };

	}

	it( 'exports every render with its files and details, and brings them back into an emptied library', async () => {

		const first = await db.saveRender( {
			image: png( 4, 2 ), hdr: new Uint8Array( [ 9, 8 ] ), aiGeneratedImage: png( 1, 1 ), aiPrompt: 'dusk',
			renderTime: 10, colorCorrection: { contrast: 2 }, isEdited: true, timestamp: new Date( 1000 ),
		} );
		const second = await db.saveRender( { image: png( 2, 2 ), renderTime: 20, timestamp: new Date( 2000 ) } );
		const sink = pickSaveFile();

		expect( await archive.exportRenders() ).toBe( 2 );
		expect( window.showSaveFilePicker.mock.calls[ 0 ][ 0 ].suggestedName ).toMatch( /^rayzee-renders-\d{4}-\d{2}-\d{2}\.zip$/ );
		expect( sink.writable.close ).toHaveBeenCalledTimes( 1 );

		const zip = await openZip( sink.file() );
		const manifest = JSON.parse( new TextDecoder().decode( await zip.read( 'manifest.json' ) ) );
		expect( manifest ).toMatchObject( { format: 'rayzee-renders', v: 1, count: 2 } );
		const paths = zip.listing.map( ( e ) => e.path );
		for ( const name of [ 'details.json', 'image.png', 'thumb.webp', 'ai.png', 'hdr.exr' ] ) expect( paths ).toContain( `renders/${first}/${name}` );
		expect( paths.filter( ( p ) => p.startsWith( `renders/${second}/` ) ).sort() ).toEqual( [ 'details.json', 'image.png', 'thumb.webp' ].map( ( n ) => `renders/${second}/${n}` ) );

		const before = ( await db.getRenderRecords() ).map( ( { id, ...rest } ) => rest );
		await db.deleteRender( first );
		await db.deleteRender( second );
		const saved = vi.fn();
		window.addEventListener( 'render-saved', saved );

		expect( await archive.importRenders( sink.file() ) ).toEqual( { added: 2, skipped: 0 } );
		expect( saved ).toHaveBeenCalledTimes( 1 );
		const records = await db.getRenderRecords();
		expect( records.map( ( { id, ...rest } ) => rest ) ).toEqual( before );
		const restored = records.find( ( r ) => r.renderTime === 10 ).id;
		expect( [ ...new Uint8Array( await ( await db.getRenderHDR( restored ) ).arrayBuffer() ) ] ).toEqual( [ 9, 8 ] );
		expect( await ( await db.getRenderFiles( restored ) )[ 'ai.png' ].text() ).toBe( '1x1' );

		expect( await archive.importRenders( sink.file() ) ).toEqual( { added: 0, skipped: 2 } );
		expect( saved ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'imports only renders the library lacks', async () => {

		await db.saveRender( { image: png( 2, 2 ), renderTime: 5, timestamp: new Date( 500 ) } );
		const file = await zipOf( {
			'manifest.json': { format: 'rayzee-renders', v: 1 },
			'renders/1/details.json': { timestamp: new Date( 500 ).toISOString(), renderTime: 5 },
			'renders/1/image.png': '2x2',
			'renders/2/details.json': { timestamp: new Date( 500 ).toISOString(), renderTime: 6 },
			'renders/2/image.png': '3x3',
			'renders/3/details.json': { timestamp: new Date( 700 ).toISOString(), renderTime: 7 },
		} );

		expect( await archive.importRenders( file ) ).toEqual( { added: 1, skipped: 2 } );
		expect( ( await db.getRenderRecords() ).map( ( r ) => [ r.renderTime, r.width ] ) ).toEqual( [[ 5, 2 ], [ 6, 3 ]] );

	} );

	it( 'refuses a zip that is not a renders export', async () => {

		await expect( archive.importRenders( await zipOf( { 'manifest.json': { format: 'rayzee-project' } } ) ) ).rejects.toThrow( 'renders.zip is not a Rayzee renders export' );
		await expect( archive.importRenders( await zipOf( { 'renders/1/details.json': {} } ) ) ).rejects.toThrow( 'is not a Rayzee renders export' );

	} );

} );
