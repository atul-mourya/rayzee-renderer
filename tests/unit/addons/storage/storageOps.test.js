import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createFakeOPFS } from '../../../__mocks__/opfs.js';
import { StorageOps } from '@/core/addons/storage/StorageOps.js';

const bytes = ( buffer ) => [ ...new Uint8Array( buffer ) ];

const rootWith = ( handle ) => {

	const file = { createSyncAccessHandle: vi.fn( async () => handle ), getFile: async () => new File( [], 'f' ) };
	return { getDirectoryHandle: async () => rootWith( handle ), getFileHandle: async () => file };

};

describe( 'StorageOps', () => {

	let fake, ops;

	beforeEach( () => {

		fake = createFakeOPFS();
		ops = new StorageOps( fake.root );

	} );

	const fileData = async ( ...path ) => {

		let dir = fake.root;
		for ( const part of path.slice( 0, - 1 ) ) dir = await dir.getDirectoryHandle( part );
		return bytes( ( await dir.getFileHandle( path.at( - 1 ) ) ).data );

	};

	it( 'appends, writes at a position and from part of a buffer, then flushes on close', async () => {

		const { id } = await ops.openWriter( { path: [ 'area', 'entry' ], name: 'f' } );
		expect( ops.write( { id, buffer: Uint8Array.of( 1, 2, 3 ).buffer } ) ).toEqual( { bytes: 3 } );
		ops.write( { id, buffer: Uint8Array.of( 9, 4, 5, 9 ).buffer, byteOffset: 1, byteLength: 2 } );
		ops.write( { id, buffer: Uint8Array.of( 7 ).buffer, at: 0 } );
		ops.write( { id, buffer: Uint8Array.of( 6 ).buffer } );
		expect( ops.closeWriter( { id } ) ).toEqual( { size: 6 } );
		expect( await fileData( 'area', 'entry', 'f' ) ).toEqual( [ 7, 2, 3, 4, 5, 6 ] );

	} );

	it( 'keeps, cuts or empties an existing file as the writer asks', async () => {

		await ops.writeFile( { path: [ 'a' ], name: 'f', buffer: Uint8Array.of( 1, 2, 3, 4, 5 ).buffer } );

		const kept = await ops.openWriter( { path: [ 'a' ], name: 'f', truncate: false } );
		ops.write( { id: kept.id, buffer: Uint8Array.of( 6 ).buffer } );
		ops.closeWriter( kept );
		expect( await fileData( 'a', 'f' ) ).toEqual( [ 1, 2, 3, 4, 5, 6 ] );

		const cut = await ops.openWriter( { path: [ 'a' ], name: 'f', truncate: false, length: 2 } );
		ops.write( { id: cut.id, buffer: Uint8Array.of( 9 ).buffer } );
		ops.closeWriter( cut );
		expect( await fileData( 'a', 'f' ) ).toEqual( [ 1, 2, 9 ] );

		const longer = await ops.openWriter( { path: [ 'a' ], name: 'f', truncate: false, length: 10 } );
		ops.closeWriter( longer );
		expect( await fileData( 'a', 'f' ) ).toEqual( [ 1, 2, 9 ] );

		const emptied = await ops.openWriter( { path: [ 'a' ], name: 'f' } );
		expect( ops.closeWriter( emptied ) ).toEqual( { size: 0 } );

	} );

	it( 'reads any range of a file, clamped to its end', async () => {

		await ops.writeFile( { path: [ 'a', 'b' ], name: 'f', buffer: Uint8Array.of( 0, 1, 2, 3, 4, 5, 6, 7 ).buffer } );
		const read = async ( args ) => bytes( ( await ops.readRange( { path: [ 'a', 'b' ], name: 'f', ...args } ) ).buffer );

		expect( await read( {} ) ).toEqual( [ 0, 1, 2, 3, 4, 5, 6, 7 ] );
		expect( await read( { offset: 2, length: 3 } ) ).toEqual( [ 2, 3, 4 ] );
		expect( await read( { offset: 6, length: 10 } ) ).toEqual( [ 6, 7 ] );
		expect( await read( { offset: 5 } ) ).toEqual( [ 5, 6, 7 ] );
		expect( await read( { offset: 12, length: 4 } ) ).toEqual( [] );
		expect( ( await ( await fake.root.getDirectoryHandle( 'a' ) ).getDirectoryHandle( 'b' ) ).children.get( 'f' ).locked ).toBe( false );

	} );

	it( 'reads a file a writer holds open through a snapshot, and the writer carries on', async () => {

		const { id } = await ops.openWriter( { path: [ 'a' ], name: 'f' } );
		ops.write( { id, buffer: Uint8Array.of( 1, 2, 3, 4 ).buffer } );

		expect( bytes( ( await ops.readRange( { path: [ 'a' ], name: 'f', offset: 1, length: 2 } ) ).buffer ) ).toEqual( [ 2, 3 ] );
		expect( bytes( ( await ops.readRange( { path: [ 'a' ], name: 'f', offset: 2 } ) ).buffer ) ).toEqual( [ 3, 4 ] );

		ops.write( { id, buffer: Uint8Array.of( 5 ).buffer } );
		expect( ops.closeWriter( { id } ) ).toEqual( { size: 5 } );

	} );

	it( 'passes on a read failure that is not a lock, and a missing file', async () => {

		const broken = { createSyncAccessHandle: async () => {

			throw new DOMException( 'gone', 'InvalidStateError' );

		} };
		const failing = new StorageOps( { getDirectoryHandle: async () => ( { getFileHandle: async () => broken } ) } );
		await expect( failing.readRange( { path: [ 'a' ], name: 'f' } ) ).rejects.toThrow( 'gone' );

		await ops.writeFile( { path: [ 'a' ], name: 'f', buffer: new ArrayBuffer( 1 ) } );
		await expect( ops.readRange( { path: [ 'a' ], name: 'missing' } ) ).rejects.toMatchObject( { name: 'NotFoundError' } );
		await expect( ops.readRange( { path: [ 'nowhere' ], name: 'f' } ) ).rejects.toMatchObject( { name: 'NotFoundError' } );

	} );

	it( 'writes in as many calls as the handle takes', async () => {

		const written = [];
		const handle = {
			size: 0,
			write: vi.fn( ( view, { at } ) => {

				const n = Math.min( 2, view.length );
				written.push( [ at, ...view.subarray( 0, n ) ] );
				handle.size = Math.max( handle.size, at + n );
				return n;

			} ),
			getSize: () => handle.size, truncate() {}, flush() {}, close() {},
		};
		const chunked = new StorageOps( rootWith( handle ) );
		const { id } = await chunked.openWriter( { path: [], name: 'f' } );
		expect( chunked.write( { id, buffer: Uint8Array.of( 1, 2, 3, 4, 5 ).buffer } ) ).toEqual( { bytes: 5 } );
		expect( written ).toEqual( [[ 0, 1, 2 ], [ 2, 3, 4 ], [ 4, 5 ]] );

	} );

	it( 'gives up on a handle that takes nothing, closing it without a flush', async () => {

		const handle = { write: () => 0, getSize: () => 0, truncate() {}, flush: vi.fn(), close: vi.fn() };
		const stuck = new StorageOps( rootWith( handle ) );
		await expect( stuck.writeFile( { path: [], name: 'f', buffer: new ArrayBuffer( 4 ) } ) ).rejects.toThrow( 'made no progress' );
		expect( handle.close ).toHaveBeenCalledOnce();
		expect( handle.flush ).not.toHaveBeenCalled();
		expect( stuck._writers.size ).toBe( 0 );

	} );

	it( 'refuses a writer it does not hold, and closes every writer on dispose', async () => {

		expect( () => ops.write( { id: 99, buffer: new ArrayBuffer( 1 ) } ) ).toThrow( 'writer 99 is not open' );
		expect( ops.closeWriter( { id: 99 } ) ).toEqual( { size: 0 } );

		const a = await ops.openWriter( { path: [ 'a' ], name: 'one' } );
		await ops.openWriter( { path: [ 'a' ], name: 'two' } );
		ops.closeWriter( a );
		expect( () => ops.write( { id: a.id, buffer: new ArrayBuffer( 1 ) } ) ).toThrow( /is not open/ );

		ops.dispose();
		expect( ops._writers.size ).toBe( 0 );
		const dir = await fake.root.getDirectoryHandle( 'a' );
		expect( [ ...dir.children.values() ].map( f => f.locked ) ).toEqual( [ false, false ] );

	} );

} );
