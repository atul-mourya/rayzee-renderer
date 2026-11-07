import { describe, it, expect, afterEach } from 'vitest';
import { gzipSync, zipSync, unzipSync, deflateSync } from 'three/addons/libs/fflate.module.js';
import { openTar, indexTarHeaders, readTar, createTarIndexer } from '@/core/addons/archives/ArchiveReader.js';
import { openZip, readZipDirectory } from '@/core/addons/archives/ZipReader.js';
import { unpackTarGz, loadTarIndex, saveTarIndex } from '@/core/addons/archives/ArchiveCache.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { createFakeOPFS } from '../../../__mocks__/opfs.js';
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

	// `zip -fz` (Info-ZIP 3.0, macOS): a.txt deflated and b.bin stored, each central entry with UT and ux extras before
	// a ZIP64 one holding only the saturated size, local headers with ZIP64 extras, and only the directory offset saturated.
	const INFO_ZIP64 = Uint8Array.from( atob(
		'UEsDBC0AAAAIAA8eZ13AtNv9//////////8FADAAYS50eHRVVAkAAzVS7mo1Uu5qdXgLAAEE9wEAAAQAAAAAAQAQAGwCAAAAAAAAJQAAAAAAAADL'
		+ 'SM3JyVeoyiwwM1Eozy/KSdFRyAALJaYnZuZxZYxKj0pTSxoAUEsDBC0AAAAAAA8eZ114d6YP//////////8FADAAYi5iaW5VVAkAAzVS7mo1Uu5q'
		+ 'dXgLAAEE9wEAAAQAAAAAAQAQAAwAAAAAAAAADAAAAAAAAABzdG9yZWQgYnl0ZXNQSwECHgMtAAAACAAPHmddwLTb/SUAAAD/////BQAkAAAAAAAB'
		+ 'AAAApIEAAAAAYS50eHRVVAUAAzVS7mp1eAsAAQT3AQAABAAAAAABAAgAbAIAAAAAAABQSwECHgMtAAAAAAAPHmddeHemDwwAAAD/////BQAkAAAA'
		+ 'AAAAAAAApIF4AAAAYi5iaW5VVAUAAzVS7mp1eAsAAQT3AQAABAAAAAABAAgADAAAAAAAAABQSwYGLAAAAAAAAAAeAy0AAAAAAAAAAAACAAAAAAAA'
		+ 'AAIAAAAAAAAArgAAAAAAAADXAAAAAAAAAFBLBgcAAAAAhQEAAAAAAAABAAAAUEsFBgAAAAACAAIArgAAAP////8AAA==',
	), c => c.charCodeAt( 0 ) );

	it( 'reads a ZIP64 archive Info-ZIP wrote', async () => {

		const a = text( 'hello zip64 world, hello again\n'.repeat( 20 ) );
		const zip = await openZip( blob( INFO_ZIP64 ) );
		expect( zip.listing ).toEqual( [ { path: 'a.txt', size: 620, offset: 0 }, { path: 'b.bin', size: 12, offset: 0x78 } ] );
		expect( await zip.read( 'a.txt' ) ).toEqual( a );
		expect( await zip.read( 'b.bin' ) ).toEqual( text( 'stored bytes' ) );
		expect( new Uint8Array( await ( await zip.slice( 'a.txt' ) ).arrayBuffer() ) ).toEqual( a );
		expect( await zip.readHead( 'b.bin', 6 ) ).toEqual( text( 'stored' ) );
		expect( await zip.readHead( 'a.txt', 5 ) ).toEqual( text( 'hello' ) );
		expect( [ await zip.slice( 'missing' ), await zip.readHead( 'missing', 4 ) ] ).toEqual( [ null, null ] );

	} );

	it( 'reads a deflated ZIP64 entry whose sizes differ', async () => {

		const body = text( 'deflate me '.repeat( 40 ) );
		const zip = await openZip( blob( makeZip64( 'big/one.bin', body, deflateSync( body ) ) ) );
		expect( zip.listing ).toEqual( [ { path: 'big/one.bin', size: body.length, offset: 0 } ] );
		expect( await zip.read( 'big/one.bin' ) ).toEqual( body );

	} );

	it( 'refuses what it cannot read', async () => {

		await expect( readZipDirectory( blob( text( 'not a zip at all' ) ) ) ).rejects.toThrow( /end of central directory/ );

		const bytes = zipSync( { 'a.txt': [ text( 'abc' ), { level: 0 } ] } );
		const at = signature => bytes.findIndex( ( _, i ) => new DataView( bytes.buffer ).getUint32( i, true ) === signature );
		const patched = ( offset, value, size = 2 ) => {

			const copy = bytes.slice();
			new DataView( copy.buffer )[ size === 2 ? 'setUint16' : 'setUint32' ]( offset, value, true );
			return blob( copy );

		};

		const central = at( 0x02014b50 ), local = at( 0x04034b50 );
		await expect( readZipDirectory( patched( central, 0, 4 ) ) ).rejects.toThrow( /corrupt central directory/ );
		await expect( ( await openZip( patched( local, 0, 4 ) ) ).read( 'a.txt' ) ).rejects.toThrow( /bad local header/ );
		await expect( ( await openZip( patched( central + 8, 1 ) ) ).read( 'a.txt' ) ).rejects.toThrow( /encrypted/ );
		await expect( ( await openZip( patched( central + 10, 12 ) ) ).read( 'a.txt' ) ).rejects.toThrow( /compression method 12/ );
		await expect( ( await openZip( patched( central + 10, 12 ) ) ).slice( 'a.txt' ) ).rejects.toThrow( /compression method 12/ );

		const z64 = makeZip64( 'x.bin', text( 'x' ) );
		const locator = z64.length - 42, record = locator - 56;
		const broken = offset => ( z64.slice().fill( 0, offset, offset + 4 ) );
		await expect( readZipDirectory( blob( broken( locator ) ) ) ).rejects.toThrow( /ZIP64 locator missing/ );
		await expect( readZipDirectory( blob( broken( record ) ) ) ).rejects.toThrow( /ZIP64 end record missing/ );

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

	it( 'unpacks only the chosen part, and a whole unpack serves any part', async () => {

		await makeStorage();
		const tar = makeTar( FILES );
		const gz = new File( [ gzipSync( tar ) ], 'scene.tar.gz', { lastModified: 2 } );
		const keep = ( path ) => path.endsWith( '.ply' ) || path === 'tail.txt';

		const part = await unpackTarGz( gz, { storage, filter: keep, part: 'ply' } );
		expect( part.cached ).toBe( false );
		// Only what it keeps is written, end to end, and listed.
		expect( part.file.size ).toBe( 'PLY'.repeat( 300 ).length + 'LONG'.repeat( 100 ).length + 3 );
		expect( part.index.listing.map( ( e ) => [ e.path, e.offset ] ) ).toEqual( [[ 'after-empty.ply', 0 ], [ LONG, 900 ], [ 'tail.txt', 1300 ]] );

		const source = await openTar( part.file, { index: part.index, filter: keep } );
		expect( await source.read( LONG ) ).toEqual( text( 'LONG'.repeat( 100 ) ) );
		expect( await source.read( 'tail.txt' ) ).toEqual( text( 'end' ) );
		expect( await source.read( 'big.bin' ) ).toBeNull();
		part.release();

		const again = await unpackTarGz( gz, { storage, filter: keep, part: 'ply' } );
		expect( again.cached ).toBe( true );
		again.release();

		( await unpackTarGz( gz, { storage } ) ).release();
		const fromWhole = await unpackTarGz( gz, { storage, filter: keep, part: 'other' } );
		expect( [ fromWhole.cached, fromWhole.file.size ] ).toEqual( [ true, tar.length ] );
		fromWhole.release();

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

function makeZip64( name, body, deflated = null ) {

	const nameBytes = text( name );
	const local = new Uint8Array( 30 + nameBytes.length );
	const lv = new DataView( local.buffer );
	lv.setUint32( 0, 0x04034b50, true );
	const data = deflated ?? body;
	lv.setUint16( 4, 45, true );
	lv.setUint16( 8, deflated ? 8 : 0, true );
	lv.setUint32( 18, data.length, true );
	lv.setUint32( 22, body.length, true );
	lv.setUint16( 26, nameBytes.length, true );
	local.set( nameBytes, 30 );

	// A 5-byte timestamp extra, as Info-ZIP writes one, ahead of the ZIP64 extra.
	const extra = new Uint8Array( 9 + 4 + 24 );
	const ev = new DataView( extra.buffer );
	ev.setUint16( 0, 0x5455, true );
	ev.setUint16( 2, 5, true );
	ev.setUint16( 9, 0x0001, true );
	ev.setUint16( 11, 24, true );
	ev.setUint32( 13, body.length, true );
	ev.setUint32( 21, data.length, true );
	ev.setUint32( 29, 0, true );

	const central = new Uint8Array( 46 + nameBytes.length + extra.length );
	const cv = new DataView( central.buffer );
	cv.setUint32( 0, 0x02014b50, true );
	cv.setUint16( 4, 45, true );
	cv.setUint16( 6, 45, true );
	cv.setUint16( 10, deflated ? 8 : 0, true );
	cv.setUint32( 20, 0xffffffff, true );
	cv.setUint32( 24, 0xffffffff, true );
	cv.setUint16( 28, nameBytes.length, true );
	cv.setUint16( 30, extra.length, true );
	cv.setUint32( 42, 0xffffffff, true );
	central.set( nameBytes, 46 );
	central.set( extra, 46 + nameBytes.length );

	const cdOffset = local.length + data.length;
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

	const parts = [ local, data, central, z64, locator, eocd ];
	const out = new Uint8Array( parts.reduce( ( n, p ) => n + p.length, 0 ) );
	let o = 0;
	for ( const p of parts ) {

		out.set( p, o );
		o += p.length;

	}

	return out;

}
