import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/Storage/openStorage.js';
import { SpillStore } from '@/core/Storage/SpillStore.js';
import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';

// 10 records of 4 lanes, 3 records a chunk → chunks of 3, 3, 3, 1.
function records() {

	const r = new ChunkedRecords( 10, 4, Uint32Array, 3 * 4 * 4 );
	for ( let i = 0; i < 10; i ++ ) r.setRecords( i, Uint32Array.of( i, i * 10, i * 100, 0xdeadbeef ) );
	return r;

}

describe( 'spilling ChunkedRecords', () => {

	let storage, uninstall;

	beforeEach( async () => {

		const fake = createFakeOPFS();
		uninstall = fake.install();
		const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();

	} );

	it( 'moves chunks to disk and reads them back exactly', async () => {

		const r = records();
		const before = r.copyOf( 0, 10 );
		const store = await SpillStore.create( storage, 'spill:a', r.recordsPerChunk * 4 * 4 );

		const bytes = await r.spill( store, { keep: k => k === 0 } );
		await store.flush();
		expect( bytes ).toBe( ( 3 + 3 + 1 ) * 16 );
		expect( r.spilledChunks ).toBe( 3 );
		expect( r.isResident( 0, 3 ) ).toBe( true );
		expect( r.isResident( 0, 4 ) ).toBe( false );
		expect( r.copyOf( 0, 3 ) ).toEqual( before.subarray( 0, 12 ) );

		await r.ensureResident( 4, 2 );
		expect( r.spilledChunks ).toBe( 2 );
		await r.ensureResident();
		expect( r.spilledChunks ).toBe( 0 );
		expect( r.copyOf( 0, 10 ) ).toEqual( before );

		await store.dispose();
		expect( await storage.area( 'spill' ).list() ).toHaveLength( 0 );

	} );

	it( 'throws on a spilled chunk rather than reading zeros, views included', async () => {

		const r = records();
		const floats = r.viewAs( Float32Array );
		const store = await SpillStore.create( storage, 'spill:b', r.recordsPerChunk * 4 * 4 );
		await r.spill( store );
		await store.flush();

		expect( () => r.copyOf( 5, 1 ) ).toThrow( /on disk/ );
		expect( () => floats.chunkFor( 5 ) ).toThrow( /on disk/ );
		expect( floats.chunks.every( c => c === null ) ).toBe( true );

		await r.ensureResident();
		expect( new Uint32Array( floats.chunkFor( 9 ).buffer )[ 3 ] ).toBe( 0xdeadbeef );
		expect( floats.chunkFor( 9 ).buffer ).toBe( r.chunkFor( 9 ).buffer );

	} );

	it( 'writes a changed chunk again on the next spill', async () => {

		const r = records();
		const store = await SpillStore.create( storage, 'spill:c', r.recordsPerChunk * 4 * 4 );
		await r.spill( store );
		await r.ensureResident();
		r.setRecords( 4, Uint32Array.of( 7, 7, 7, 7 ) );
		await r.spill( store );
		await r.ensureResident();
		expect( [ ...r.copyOf( 4, 1 ) ] ).toEqual( [ 7, 7, 7, 7 ] );
		expect( [ ...r.copyOf( 5, 1 ) ] ).toEqual( [ 5, 50, 500, 0xdeadbeef ] );

	} );

} );
