import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeOPFS } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { STORAGE_KIND } from '@/core/addons/storage/StorageManager.js';
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
		expect( found.container ).toBe( 'webm' );
		expect( [ ...bytes.subarray( 0, 4 ) ] ).toEqual( [ 0x1a, 0x45, 0xdf, 0xa3 ] );
		for ( const payload of [[ 1, 2, 3 ], [ 4, 5 ], [ 6 ]] ) {

			const at = bytes.findIndex( ( _, i ) => payload.every( ( b, j ) => bytes[ i + j ] === b ) );
			expect( at ).toBeGreaterThan( 0 );

		}

		expect( await found.discard() ).toBe( true );
		expect( await storage.area( 'jobs' ).list() ).toHaveLength( 0 );

	} );

	it( 'muxes an MP4 with its index first', async () => {

		const job = await VideoJob.start( storage, { ...spec, codec: 'vp09.00.51.08', container: 'mp4' } );
		for ( let frame = 0; frame < 3; frame ++ ) {

			await job.appendFrame( frame, [ fakeChunk( frame ? 'delta' : 'key', frame * 33_333, new Uint8Array( [ 9, frame ] ) ) ] );

		}

		const file = await job.finalize();
		const bytes = new Uint8Array( await file.arrayBuffer() );
		const boxes = [];
		for ( let at = 0; at + 8 <= bytes.length; ) {

			const size = new DataView( bytes.buffer, at ).getUint32( 0 );
			boxes.push( String.fromCharCode( ...bytes.subarray( at + 4, at + 8 ) ) );
			if ( ! size ) break;
			at += size;

		}

		expect( file.type ).toBe( 'video/mp4' );
		expect( file.name ).toMatch( /\.mp4$/ );
		expect( boxes.indexOf( 'moov' ) ).toBeGreaterThan( - 1 );
		expect( boxes.indexOf( 'moov' ) ).toBeLessThan( boxes.indexOf( 'mdat' ) );

	} );

	it( 'returns null without storage', async () => {

		expect( await VideoJob.start( null, spec ) ).toBeNull();
		expect( await VideoJob.unfinished( null ) ).toEqual( [] );

	} );

	// Resolves, or rejects after a second: a writer left open would hold the entry's lock for good.
	const soon = promise => Promise.race( [ promise, new Promise( ( _, reject ) => setTimeout( () => reject( new Error( 'still locked' ) ), 1000 ) ) ] );

	// The jobs area's next writer fails at `method` once.
	function failNext( method, area = storage.area( 'jobs' ) ) {

		const open = area[ method ].bind( area );
		area[ method ] = async ( ...args ) => {

			area[ method ] = open;
			const writer = await open( ...args );
			writer.write = async () => {

				throw new Error( 'disk full' );

			};

			writer.writeJSON = writer.write;
			return writer;

		};

	}

	it( 'lets a frame whose write fails go, and takes it again', async () => {

		const job = await VideoJob.start( storage, spec );
		failNext( 'edit' );
		await expect( job.appendFrame( 0, [ fakeChunk( 'key', 0, new Uint8Array( [ 1 ] ) ) ] ) ).rejects.toThrow( 'disk full' );
		expect( job.framesDone ).toBe( 0 );

		await soon( job.appendFrame( 0, [ fakeChunk( 'key', 0, new Uint8Array( [ 1 ] ) ) ] ) );
		expect( job.framesDone ).toBe( 1 );
		expect( ( await VideoJob.unfinished( storage ) )[ 0 ].framesDone ).toBe( 1 );

	} );

	it( 'leaves no job behind when its first write fails', async () => {

		failNext( 'create' );
		await expect( VideoJob.start( storage, spec ) ).rejects.toThrow( 'disk full' );
		expect( await storage.area( 'jobs' ).list() ).toHaveLength( 0 );

	} );

	it( 'keeps the journal when muxing fails, so it can be muxed again', async () => {

		const job = await VideoJob.start( storage, { ...spec, totalFrames: 1 } );
		await job.appendFrame( 0, [ fakeChunk( 'key', 0, new Uint8Array( [ 5, 6 ] ) ) ] );
		failNext( 'edit' );
		await expect( job.finalize() ).rejects.toThrow( 'disk full' );

		const file = await soon( job.finalize() );
		expect( file.type ).toBe( 'video/webm' );

	} );

	it( 'lists only unfinished video jobs, newest first', async () => {

		const now = vi.spyOn( Date, 'now' );
		now.mockReturnValue( 1000 );
		const old = await VideoJob.start( storage, spec );
		now.mockReturnValue( 2000 );
		const recent = await VideoJob.start( storage, spec );
		now.mockReturnValue( 3000 );
		const done = await VideoJob.start( storage, { ...spec, totalFrames: 1 } );
		now.mockRestore();
		await done.appendFrame( 0, [ fakeChunk( 'key', 0, new Uint8Array( [ 1 ] ) ) ] );
		const other = await storage.area( 'jobs' ).create( 'still:1', { extra: { kind: 'still' } } );
		await other.writeJSON( 'job.json', { framesDone: 0, totalFrames: 5 } );
		await other.commit();

		expect( ( await VideoJob.unfinished( storage ) ).map( j => j.key ) ).toEqual( [ recent.key, old.key ] );

	} );

	it( 'says when its entry is gone', async () => {

		const job = await VideoJob.start( storage, spec );
		await job.discard();
		await expect( job.appendFrame( 0, [] ) ).rejects.toThrow( /storage entry is gone/ );
		await expect( job.finalize() ).rejects.toThrow( /storage entry is gone/ );

	} );

} );
