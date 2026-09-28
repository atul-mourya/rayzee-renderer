import { describe, it, expect, afterEach } from 'vitest';
import { gzipSync, zipSync, unzipSync } from 'three/addons/libs/fflate.module.js';
import { openTar, indexTarHeaders, readTar, createTarIndexer } from '@/core/Processor/ArchiveReader.js';
import { openZip, readZipDirectory } from '@/core/Processor/ZipReader.js';
import { unpackTarGz, loadTarIndex, saveTarIndex } from '@/core/Processor/ArchiveCache.js';
import { openStorage } from '@/core/Storage/openStorage.js';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { makeTar, text } from './tarFixture.js';

const LONG = `deep/${'x'.repeat( 120 )}/mesh.ply`;
const PAX = `pax/${'y'.repeat( 130 )}.pbrt`;

const FILES = [
	{ path: 'scene.pbrt', body: text( 'WorldBegin\n' ) },
	{ path: 'dir/', type: '5' },
	{ path: 'empty.txt' },
	{ path: 'after-empty.ply', body: text( 'PLY'.repeat( 300 ) ) },
	{ path: LONG, body: text( 'LONG'.repeat( 100 ) ) },
	{ path: PAX, body: text( 'PAX' ), longname: 'pax' },
	{ path: 'big.bin', body: new Uint8Array( 3 << 20 ).fill( 7 ) },
	{ path: 'tail.txt', body: text( 'end' ) },
];

const regular = FILES.filter( f => ( f.type ?? '0' ) === '0' );
const blob = bytes => new Blob( [ bytes ] );

describe( 'tar header index', () => {

	it( 'matches a full streaming walk, offsets included', async () => {

		const tar = makeTar( FILES );
		const byHeaders = await indexTarHeaders( blob( tar ) );
		const streamed = await openTar( blob( tar ), { retain: () => false } );

		expect( byHeaders.map( e => e.path ) ).toEqual( regular.map( f => f.path ) );
		expect( byHeaders ).toEqual( streamed.listing );

	} );

	it( 'indexes and materialises empty files, and keeps a filter from leaking to the next entry', async () => {

		const tar = makeTar( FILES );
		const all = await readTar( blob( tar ) );
		expect( all.entries[ 'empty.txt' ] ).toEqual( new Uint8Array( 0 ) );

		const filtered = await openTar( blob( tar ), { retain: () => false, filter: p => p === 'empty.txt' } );
		const withOffset = filtered.listing.filter( e => e.offset !== undefined ).map( e => e.path );
		expect( withOffset ).toEqual( [ 'empty.txt' ] );

	} );

	it( 'serves reads from a saved index without walking', async () => {

		const tar = makeTar( FILES );
		const first = await openTar( blob( tar ), { headersOnly: true } );
		const again = await openTar( blob( tar ), { index: JSON.parse( JSON.stringify( first.index ) ), filter: p => p.endsWith( '.ply' ) } );

		expect( new TextDecoder().decode( await again.read( 'after-empty.ply' ) ) ).toBe( 'PLY'.repeat( 300 ) );
		expect( await again.read( 'tail.txt' ) ).toBeNull();
		expect( again.listing.find( e => e.path === 'tail.txt' ).offset ).toBeUndefined();

	} );

	it( 'an indexer fed chunk by chunk agrees with the header index', async () => {

		const tar = makeTar( FILES );
		const indexer = createTarIndexer();
		for ( let i = 0; i < tar.length; i += 777 ) indexer.push( tar.subarray( i, i + 777 ) );
		expect( indexer.finish() ).toEqual( await indexTarHeaders( blob( tar ) ) );

	} );

} );

describe( 'ZipReader', () => {

	const files = {
		'scene.pbrt': text( 'WorldBegin\n' ),
		'geo/a.ply': new Uint8Array( 50_000 ).map( ( _, i ) => i % 251 ),
		'geo/stored.bin': [ new Uint8Array( 1000 ).fill( 9 ), { level: 0 } ],
		'empty.txt': new Uint8Array( 0 ),
		'ünï.txt': text( 'utf8 name' ),
		'folder/': new Uint8Array( 0 ),
	};

	it( 'lists and reads every entry exactly as unzipSync does', async () => {

		const bytes = zipSync( files );
		const expected = unzipSync( bytes );
		const zip = await openZip( blob( bytes ) );

		const paths = zip.listing.map( e => e.path );
		expect( paths.sort() ).toEqual( Object.keys( expected ).filter( p => ! p.endsWith( '/' ) ).sort() );
		for ( const path of paths ) expect( await zip.read( path ) ).toEqual( expected[ path ] );

	} );

	it( 'applies a filter like openTar', async () => {

		const zip = await openZip( blob( zipSync( files ) ), { filter: p => p.startsWith( 'geo/' ) } );
		expect( await zip.read( 'scene.pbrt' ) ).toBeNull();
		expect( zip.listing.find( e => e.path === 'scene.pbrt' ).offset ).toBeUndefined();
		expect( zip.indexed ).toBe( 2 );

	} );

	it( 'reads ZIP64 records', async () => {

		const body = text( 'zip64 body' );
		const zip = await openZip( blob( makeZip64( 'big/one.bin', body ) ) );
		expect( zip.listing ).toEqual( [ { path: 'big/one.bin', size: body.length, offset: 0 } ] );
		expect( await zip.read( 'big/one.bin' ) ).toEqual( body );

	} );

	it( 'refuses what it cannot read', async () => {

		await expect( readZipDirectory( blob( text( 'not a zip at all' ) ) ) ).rejects.toThrow( /end of central directory/ );

	} );

} );

describe( 'ArchiveCache', () => {

	let uninstall = null;
	let storage = null;

	afterEach( () => {

		storage?.dispose();
		uninstall?.();
		storage = uninstall = null;

	} );

	async function makeStorage( options ) {

		const fake = createFakeOPFS( options );
		uninstall = fake.install();
		const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );
		return fake;

	}

	it( 'unpacks a .tar.gz once into a seekable, indexed .tar', async () => {

		await makeStorage();
		const tar = makeTar( FILES );
		const gz = new File( [ gzipSync( tar ) ], 'scene.tar.gz', { lastModified: 1 } );

		const first = await unpackTarGz( gz, { storage } );
		expect( first.cached ).toBe( false );
		expect( first.file.size ).toBe( tar.length );
		expect( first.index.listing ).toEqual( await indexTarHeaders( blob( tar ) ) );

		const source = await openTar( first.file, { index: first.index } );
		expect( await source.read( LONG ) ).toEqual( text( 'LONG'.repeat( 100 ) ) );
		first.release();

		const second = await unpackTarGz( gz, { storage } );
		expect( second.cached ).toBe( true );
		second.release();

	} );

	it( 'gives up without a trace when there is no room', async () => {

		const fake = await makeStorage();
		fake.state.faults.quotaAfterBytes = 1 << 20;
		const gz = new File( [ gzipSync( makeTar( FILES ) ) ], 'scene.tar.gz' );

		expect( await unpackTarGz( gz, { storage } ) ).toBeNull();
		expect( ( await storage.usage() ).areas.archives.entries ).toBe( 0 );

	} );

	it( 'saves and loads a plain tar index', async () => {

		await makeStorage();
		const file = new File( [ makeTar( FILES ) ], 'scene.tar', { lastModified: 5 } );
		const { index } = await openTar( file, { headersOnly: true } );

		expect( await loadTarIndex( file, storage ) ).toBeNull();
		expect( await saveTarIndex( file, storage, index ) ).toBe( true );
		expect( await loadTarIndex( file, storage ) ).toEqual( index );

	} );

} );

function makeZip64( name, body ) {

	const nameBytes = text( name );
	const local = new Uint8Array( 30 + nameBytes.length );
	const lv = new DataView( local.buffer );
	lv.setUint32( 0, 0x04034b50, true );
	lv.setUint16( 4, 45, true );
	lv.setUint32( 18, body.length, true );
	lv.setUint32( 22, body.length, true );
	lv.setUint16( 26, nameBytes.length, true );
	local.set( nameBytes, 30 );

	const extra = new Uint8Array( 4 + 24 );
	const ev = new DataView( extra.buffer );
	ev.setUint16( 0, 0x0001, true );
	ev.setUint16( 2, 24, true );
	ev.setUint32( 4, body.length, true );
	ev.setUint32( 12, body.length, true );
	ev.setUint32( 20, 0, true );

	const central = new Uint8Array( 46 + nameBytes.length + extra.length );
	const cv = new DataView( central.buffer );
	cv.setUint32( 0, 0x02014b50, true );
	cv.setUint16( 4, 45, true );
	cv.setUint16( 6, 45, true );
	cv.setUint32( 20, 0xffffffff, true );
	cv.setUint32( 24, 0xffffffff, true );
	cv.setUint16( 28, nameBytes.length, true );
	cv.setUint16( 30, extra.length, true );
	cv.setUint32( 42, 0xffffffff, true );
	central.set( nameBytes, 46 );
	central.set( extra, 46 + nameBytes.length );

	const cdOffset = local.length + body.length;
	const z64Offset = cdOffset + central.length;

	const z64 = new Uint8Array( 56 );
	const zv = new DataView( z64.buffer );
	zv.setUint32( 0, 0x06064b50, true );
	zv.setUint32( 4, 44, true );
	zv.setUint32( 24, 1, true );
	zv.setUint32( 32, 1, true );
	zv.setUint32( 40, central.length, true );
	zv.setUint32( 48, cdOffset, true );

	const locator = new Uint8Array( 20 );
	const locv = new DataView( locator.buffer );
	locv.setUint32( 0, 0x07064b50, true );
	locv.setUint32( 8, z64Offset, true );
	locv.setUint32( 16, 1, true );

	const eocd = new Uint8Array( 22 );
	const eov = new DataView( eocd.buffer );
	eov.setUint32( 0, 0x06054b50, true );
	eov.setUint16( 8, 0xffff, true );
	eov.setUint16( 10, 0xffff, true );
	eov.setUint32( 12, 0xffffffff, true );
	eov.setUint32( 16, 0xffffffff, true );

	const parts = [ local, body, central, z64, locator, eocd ];
	const out = new Uint8Array( parts.reduce( ( n, p ) => n + p.length, 0 ) );
	let o = 0;
	for ( const p of parts ) {

		out.set( p, o );
		o += p.length;

	}

	return out;

}
