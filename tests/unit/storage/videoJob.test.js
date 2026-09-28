import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/Storage/openStorage.js';
import { STORAGE_KIND } from '@/core/Storage/StorageManager.js';
import { VideoJob } from '@/lib/videoJob';

const fakeChunk = ( type, timestamp, bytes ) => ( {
	type,
	timestamp,
	byteLength: bytes.length,
	copyTo: ( target ) => target.set( bytes ),
} );

describe( 'VideoJob', () => {

	let storage, uninstall;

	beforeEach( async () => {

		const fake = createFakeOPFS();
		uninstall = fake.install();
		const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );
		storage.defineArea( 'jobs', { kind: STORAGE_KIND.USER } );

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();

	} );

	const spec = { width: 64, height: 32, fps: 30, codec: 'vp8', totalFrames: 3 };

	it( 'journals frames, survives being abandoned, and muxes a WebM', async () => {

		const job = await VideoJob.start( storage, spec );
		await job.appendFrame( 0, [ fakeChunk( 'key', 0, new Uint8Array( [ 1, 2, 3 ] ) ) ], { codec: 'vp8', description: new Uint8Array( [ 7 ] ) } );
		await job.appendFrame( 1, [ fakeChunk( 'delta', 33_333, new Uint8Array( [ 4, 5 ] ) ) ] );

		const [ found ] = await VideoJob.unfinished( storage );
		expect( found.key ).toBe( job.key );
		expect( found.framesDone ).toBe( 2 );
		expect( found.job.decoderConfig ).toEqual( { codec: 'vp8', description: 'Bw==' } );

		await found.appendFrame( 2, [ fakeChunk( 'delta', 66_666, new Uint8Array( [ 6 ] ) ) ] );
		expect( await VideoJob.unfinished( storage ) ).toHaveLength( 0 );

		const file = await found.finalize();
		const bytes = new Uint8Array( await file.arrayBuffer() );
		expect( file.type ).toBe( 'video/webm' );
		expect( [ ...bytes.subarray( 0, 4 ) ] ).toEqual( [ 0x1a, 0x45, 0xdf, 0xa3 ] );
		for ( const payload of [[ 1, 2, 3 ], [ 4, 5 ], [ 6 ]] ) {

			const at = bytes.findIndex( ( _, i ) => payload.every( ( b, j ) => bytes[ i + j ] === b ) );
			expect( at ).toBeGreaterThan( 0 );

		}

		expect( await found.discard() ).toBe( true );
		expect( await storage.area( 'jobs' ).list() ).toHaveLength( 0 );

	} );

	it( 'returns null without storage', async () => {

		expect( await VideoJob.start( null, spec ) ).toBeNull();

	} );

} );
