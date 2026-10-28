import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createFakeOPFS, snapshot } from '../../../__mocks__/opfs.js';
import { STORAGE_KIND } from '@/core/addons/storage/StorageManager.js';
import { openStorage, acquireSharedStorage } from '@/core/addons/storage/OpenStorage.js';
import { entryIdFor } from '@/core/storage/FileIdentity.js';

const { workers } = vi.hoisted( () => ( { workers: [] } ) );

vi.mock( '@/core/addons/storage/StorageWorker.js?worker&inline', async () => {

	const { StorageOps } = await import( '@/core/addons/storage/StorageOps.js' );

	class StorageWorker {

		constructor() {

			this.messages = [];
			this.terminated = false;
			workers.push( this );

		}

		postMessage( data ) {

			this.messages.push( data );
			setTimeout( async () => {

				if ( this.terminated ) return;
				const { id, op, args } = data;
				try {

					if ( op === 'init' ) {

						this.ops = new StorageOps( args.root ?? navigator.storage.getDirectory().then( top => top.getDirectoryHandle( args.namespace, { create: true } ) ) );
						this.onmessage( { data: { id, result: {} } } );
						return;

					}

					this.onmessage( { data: { id, result: await this.ops[ op ]( args ) } } );

				} catch ( error ) {

					this.onmessage( { data: { id, error: { name: error.name, message: error.message } } } );

				}

			} );

		}

		terminate() {

			this.terminated = true;

		}

	}

	return { default: StorageWorker };

} );

const MiB = 1024 * 1024;

async function makeStorage( options = {} ) {

	const fake = createFakeOPFS( options );
	const uninstall = fake.install();
	const root = await fake.root.getDirectoryHandle( 'rayzee', { create: true } );
	const { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } );
	const issues = [];
	storage.addEventListener( 'issue', ( e ) => issues.push( e.code ) );
	return { storage, fake, root, uninstall, issues };

}

async function put( area, key, files, info = {} ) {

	const writer = await area.create( key, info );
	for ( const [ name, data ] of Object.entries( files ) ) await writer.write( name, data );
	return writer.commit();

}

describe( 'StorageManager', () => {

	let ctx;

	beforeEach( async () => {

		ctx = await makeStorage();

	} );

	afterEach( () => {

		ctx.storage.dispose();
		ctx.uninstall();

	} );

	it( 'commits an entry and reads it back', async () => {

		const area = ctx.storage.area( 'downloads' );
		const meta = await put( area, 'https://x/a.bin', { data: new Uint8Array( [ 1, 2, 3, 4 ] ) }, { label: 'a.bin', extra: { etag: 'e1' } } );

		expect( meta.files ).toEqual( { data: 4 } );
		expect( meta.bytes ).toBe( 4 );
		expect( meta.kind ).toBe( STORAGE_KIND.CACHE );

		const entry = await area.open( 'https://x/a.bin' );
		expect( entry.extra.etag ).toBe( 'e1' );
		const file = await entry.file( 'data' );
		expect( [ ...new Uint8Array( await file.arrayBuffer() ) ] ).toEqual( [ 1, 2, 3, 4 ] );
		entry.release();

		expect( await area.list() ).toHaveLength( 1 );

	} );

	it( 'appends, writes at a position, and takes Blobs and strings', async () => {

		const area = ctx.storage.area( 'archives' );
		const writer = await area.create( 'k' );
		await writer.write( 'f', new Uint8Array( [ 1, 1, 1, 1 ] ) );
		await writer.write( 'f', new Uint8Array( [ 2, 2 ] ) );
		await writer.write( 'f', new Uint8Array( [ 9 ] ), { at: 1 } );
		await writer.write( 'b', new Blob( [ 'hi' ] ) );
		await writer.writeJSON( 'index.json', { n: 1 } );
		await writer.commit();

		const entry = await area.open( 'k' );
		expect( [ ...new Uint8Array( await ( await entry.file( 'f' ) ).arrayBuffer() ) ] ).toEqual( [ 1, 9, 1, 1, 2, 2 ] );
		expect( await ( await entry.file( 'b' ) ).text() ).toBe( 'hi' );
		expect( await entry.json( 'index.json' ) ).toEqual( { n: 1 } );
		entry.release();

	} );

	it( 'hands the worker a copy of a shared buffer, never the shared buffer itself', async () => {

		const area = ctx.storage.area( 'archives' );
		const writer = await area.create( 'k' );
		const transport = ctx.storage._transport;
		const sent = [];
		const call = transport.call.bind( transport );
		transport.call = ( op, args, list ) => {

			if ( op === 'write' ) sent.push( { buffer: args.buffer, list } );
			return call( op, args, list );

		};

		const shared = new Uint8Array( new SharedArrayBuffer( 8 ) );
		shared.set( [ 1, 2, 3, 4, 5, 6, 7, 8 ] );
		await writer.write( 'f', shared.subarray( 2, 6 ) );
		shared.fill( 0 );
		await writer.commit();
		transport.call = call;

		// Held by the worker, a shared buffer stays alive until that worker collects garbage.
		expect( sent[ 0 ].buffer ).toBeInstanceOf( ArrayBuffer );
		expect( sent[ 0 ].list ).toEqual( [ sent[ 0 ].buffer ] );
		const entry = await area.open( 'k' );
		expect( [ ...new Uint8Array( await ( await entry.file( 'f' ) ).arrayBuffer() ) ] ).toEqual( [ 3, 4, 5, 6 ] );
		entry.release();

	} );

	it( 'hides an entry that never committed, and the sweep removes it', async () => {

		const area = ctx.storage.area( 'scenes' );
		const writer = await area.create( 'half' );
		await writer.write( 'data', new Uint8Array( 16 ) );

		expect( await area.open( 'half' ) ).toBeNull();

		// Simulates the tab dying mid-write: its lock and its handle go away with it.
		writer._release();
		await writer._transport.call( 'closeWriter', { id: await writer._writer( 'data' ) } );

		expect( await ctx.storage.sweep() ).toBe( 1 );
		expect( snapshot( ctx.root ) ).toEqual( {} );

	} );

	it( 'rejects an entry whose files no longer match its metadata', async () => {

		const area = ctx.storage.area( 'cdf' );
		await put( area, 'k', { data: new Uint8Array( 8 ) } );

		const id = await entryIdFor( 'k' );
		const dir = await ( await ctx.root.getDirectoryHandle( 'cdf' ) ).getDirectoryHandle( id );
		( await dir.getFileHandle( 'data' ) ).data = new Uint8Array( 3 );

		expect( await area.open( 'k' ) ).toBeNull();

	} );

	it( 'replaces an entry under the same key', async () => {

		const area = ctx.storage.area( 'downloads' );
		await put( area, 'k', { old: new Uint8Array( 8 ) } );
		await put( area, 'k', { fresh: new Uint8Array( 2 ) } );

		const entry = await area.open( 'k' );
		expect( Object.keys( entry.meta.files ) ).toEqual( [ 'fresh' ] );
		expect( await entry.file( 'old' ) ).toBeNull();
		entry.release();

	} );

	it( 'aborts cleanly, leaving nothing behind', async () => {

		const area = ctx.storage.area( 'downloads' );
		const writer = await area.create( 'k' );
		await writer.write( 'data', new Uint8Array( 32 ) );
		await writer.abort();

		expect( snapshot( ctx.root ) ).toEqual( {} );
		expect( await area.open( 'k' ) ).toBeNull();

	} );

	it( 'surfaces a quota failure as the write error and an issue on commit failure', async () => {

		ctx.fake.state.faults.quotaAfterBytes = 100;
		const area = ctx.storage.area( 'downloads' );
		const writer = await area.create( 'big' );

		await expect( writer.write( 'data', new Uint8Array( 200 ) ) ).rejects.toMatchObject( { name: 'QuotaExceededError' } );
		await writer.abort();
		expect( snapshot( ctx.root ) ).toEqual( {} );

		ctx.fake.state.faults.quotaAfterBytes = null;
		ctx.fake.state.faults.failWriteOf = 'meta.json';
		const second = await area.create( 'meta-fails' );
		await second.write( 'data', new Uint8Array( 4 ) );
		await expect( second.commit() ).rejects.toThrow();
		expect( ctx.issues ).toContain( 'storage.write_failed' );
		expect( await area.open( 'meta-fails' ) ).toBeNull();

	} );

	it( 'keeps an entry that is open from being removed', async () => {

		const area = ctx.storage.area( 'archives' );
		await put( area, 'k', { data: new Uint8Array( 4 ) } );

		const entry = await area.open( 'k' );
		expect( await area.remove( 'k' ) ).toBe( false );
		entry.release();
		expect( await area.remove( 'k' ) ).toBe( true );

	} );

	it( 'serialises two writers of the same key', async () => {

		const area = ctx.storage.area( 'downloads' );
		const first = await area.create( 'k' );
		let secondStarted = false;
		const second = area.create( 'k' ).then( ( w ) => {

			secondStarted = true;
			return w;

		} );

		await first.write( 'data', new Uint8Array( 1 ) );
		await new Promise( ( r ) => setTimeout( r, 5 ) );
		expect( secondStarted ).toBe( false );
		await first.commit();

		const w2 = await second;
		await w2.write( 'data', new Uint8Array( 2 ) );
		await w2.commit();
		const entry = await area.open( 'k' );
		expect( entry.meta.files.data ).toBe( 2 );
		entry.release();

	} );

	it( 'streams a ReadableStream into a file in large batches', async () => {

		const area = ctx.storage.area( 'downloads' );
		const pieces = Array.from( { length: 50 }, ( _, i ) => new Uint8Array( 1000 ).fill( i ) );
		const stream = new ReadableStream( {
			start( controller ) {

				for ( const p of pieces ) controller.enqueue( p );
				controller.close();

			}
		} );

		const writer = await area.create( 'stream' );
		const writeSpy = vi.spyOn( writer, 'write' );
		const progress = [];
		const total = await writer.writeStream( 'data', stream, { batchBytes: 16 * 1024, onProgress: ( n ) => progress.push( n ) } );
		await writer.commit();

		expect( total ).toBe( 50_000 );
		expect( writeSpy.mock.calls.length ).toBe( 4 );
		expect( progress.at( - 1 ) ).toBe( 50_000 );

		const entry = await area.open( 'stream' );
		const bytes = new Uint8Array( await ( await entry.file( 'data' ) ).arrayBuffer() );
		expect( bytes[ 0 ] ).toBe( 0 );
		expect( bytes[ 49_999 ] ).toBe( 49 );
		entry.release();

	} );

	it( 'evicts least recently used, unpinned cache entries to make room', async () => {

		ctx.storage.setBudget( 10 * MiB );
		const area = ctx.storage.area( 'downloads' );
		const user = ctx.storage.defineArea( 'renders', { kind: STORAGE_KIND.USER } );

		vi.useFakeTimers( { now: 1_000_000 } );
		try {

			await put( area, 'oldest', { data: new Uint8Array( 4 * MiB ) } );
			vi.setSystemTime( 2_000_000 );
			await put( area, 'pinned', { data: new Uint8Array( 4 * MiB ) }, { pinned: true } );
			vi.setSystemTime( 3_000_000 );
			await put( area, 'newer', { data: new Uint8Array( 2 * MiB ) } );
			await put( user, 'mine', { data: new Uint8Array( 4 * MiB ) } );

		} finally {

			vi.useRealTimers();

		}

		expect( await ctx.storage.ensureSpace( 3 * MiB ) ).toBe( true );
		expect( ( await area.list() ).map( ( m ) => m.key ).sort() ).toEqual( [ 'newer', 'pinned' ] );
		expect( await user.list() ).toHaveLength( 1 );

	} );

	it( 'lists the caches once for many writes, counting each commit', async () => {

		ctx.storage.setBudget( 10 * MiB );
		const area = ctx.storage.area( 'downloads' );
		const listing = vi.spyOn( ctx.storage, '_cacheEntries' );

		vi.useFakeTimers( { now: 1_000_000, toFake: [ 'Date' ] } );
		try {

			for ( let i = 0; i < 4; i ++ ) {

				vi.setSystemTime( 1_000_000 + i * 1000 );
				const writer = await area.create( `file-${i}`, { expectedBytes: 2 * MiB } );
				await writer.write( 'data', new Uint8Array( 2 * MiB ) );
				await writer.commit();

			}

			expect( listing ).toHaveBeenCalledTimes( 1 );
			expect( await ctx.storage._cacheBytes() ).toBe( 8 * MiB );

			// Over the budget only once the four commits are counted.
			expect( await ctx.storage.ensureSpace( 3 * MiB ) ).toBe( true );
			expect( ( await area.list() ).map( ( m ) => m.key ).sort() ).toEqual( [ 'file-1', 'file-2', 'file-3' ] );

			vi.setSystemTime( 1_000_000 + 60_000 );
			listing.mockClear();
			await ctx.storage.ensureSpace( 1 );
			expect( listing ).toHaveBeenCalledTimes( 1 );

		} finally {

			vi.useRealTimers();

		}

	} );

	it( 'lets one write outgrow the budget, clearing other caches for it', async () => {

		ctx.storage.setBudget( 1 * MiB );
		const area = ctx.storage.area( 'scenes' );
		await put( area, 'small', { data: new Uint8Array( MiB / 2 ) } );

		const writer = await area.create( 'huge', { expectedBytes: 2 * MiB } );
		expect( writer ).not.toBeNull();
		await writer.abort();
		expect( await area.list() ).toHaveLength( 0 );

	} );

	it( 'refuses a write the disk cannot hold', async () => {

		ctx.storage.dispose();
		ctx.uninstall();
		ctx = await makeStorage( { quota: 8 * MiB } );

		const writer = await ctx.storage.area( 'scenes' ).create( 'huge', { expectedBytes: 16 * MiB } );
		expect( writer ).toBeNull();
		expect( ctx.issues ).toContain( 'storage.quota_exceeded' );

	} );

	it( 'reports usage per area', async () => {

		await put( ctx.storage.area( 'downloads' ), 'a', { data: new Uint8Array( 10 ) } );
		ctx.storage.defineArea( 'renders', { kind: STORAGE_KIND.USER } );
		await put( ctx.storage.area( 'renders' ), 'r', { image: new Uint8Array( 5 ) } );

		const usage = await ctx.storage.usage();
		expect( usage.areas.downloads ).toEqual( { kind: 'cache', bytes: 10, entries: 1 } );
		expect( usage.areas.renders ).toEqual( { kind: 'user', bytes: 5, entries: 1 } );
		expect( usage.cacheBytes ).toBe( 10 );
		expect( usage.quota ).toBe( 10 * 1024 ** 3 );

	} );

	it( 'refreshes lastUsed at most hourly', async () => {

		const area = ctx.storage.area( 'downloads' );
		vi.useFakeTimers( { now: 0 } );
		try {

			await put( area, 'k', { data: new Uint8Array( 1 ) } );
			vi.setSystemTime( 60_000 );
			( await area.open( 'k' ) ).release();
			expect( ( await area.list() )[ 0 ].lastUsed ).toBe( 0 );

			vi.setSystemTime( 3_600_001 );
			( await area.open( 'k' ) ).release();
			await vi.waitFor( async () => expect( ( await area.list() )[ 0 ].lastUsed ).toBe( 3_600_001 ) );

		} finally {

			vi.useRealTimers();

		}

	} );

	it( 'will not redefine an area with another kind', () => {

		expect( () => ctx.storage.defineArea( 'downloads', { kind: STORAGE_KIND.USER } ) ).toThrow( /already defined/ );

	} );

} );

describe( 'openStorage / acquireSharedStorage', () => {

	it( 'reports why storage is missing', async () => {

		const { storage, reason } = await openStorage( { namespace: 'x' } );
		expect( storage ).toBeNull();
		expect( reason ).toMatch( /no origin private file system/ );

	} );

	it( 'reports why the file system refused', async () => {

		const restore = createFakeOPFS().install();
		navigator.storage.getDirectory = async () => {

			throw new DOMException( 'not allowed here', 'SecurityError' );

		};

		try {

			expect( await openStorage( { namespace: 'x' } ) ).toEqual( { storage: null, reason: 'SecurityError: not allowed here' } );
			const shared = await acquireSharedStorage( 'refused' );
			expect( shared ).toMatchObject( { storage: null, reason: 'SecurityError: not allowed here' } );
			shared.release();

		} finally {

			restore();

		}

		const fake = createFakeOPFS();
		const uninstall = fake.install();
		const again = await acquireSharedStorage( 'refused' );
		expect( again.storage ).not.toBeNull();
		again.release();
		uninstall();

	} );

	it( 'writes inline inside a worker, and through a worker on a page', async () => {

		const fake = createFakeOPFS();
		const uninstall = fake.install();
		vi.stubGlobal( 'Worker', class {} );
		try {

			vi.stubGlobal( 'WorkerGlobalScope', class {

				static [ Symbol.hasInstance ]() {

					return true;

				}

			} );
			const inWorker = ( await openStorage( { namespace: 'w' } ) ).storage;
			expect( inWorker._transport.inline ).toBe( true );
			expect( workers ).toHaveLength( 0 );
			inWorker.dispose();

			vi.stubGlobal( 'WorkerGlobalScope', undefined );
			const onPage = ( await openStorage( { namespace: 'w' } ) ).storage;
			expect( onPage._transport.inline ).toBeUndefined();
			expect( workers ).toHaveLength( 1 );
			await onPage._transport._ready;
			onPage.dispose();

		} finally {

			vi.unstubAllGlobals();
			uninstall();
			workers.length = 0;

		}

	} );

	it( 'shares one manager per namespace and disposes it with the last holder', async () => {

		const fake = createFakeOPFS();
		const uninstall = fake.install();
		try {

			const a = await acquireSharedStorage( 'ns' );
			const b = await acquireSharedStorage( 'ns' );
			expect( a.storage ).toBe( b.storage );

			const dispose = vi.spyOn( a.storage, 'dispose' );
			a.release();
			a.release();
			expect( dispose ).not.toHaveBeenCalled();
			b.release();
			expect( dispose ).toHaveBeenCalledOnce();

			const c = await acquireSharedStorage( 'ns' );
			expect( c.storage ).not.toBe( a.storage );
			c.release();

		} finally {

			uninstall();

		}

	} );

} );

describe( 'storage through a worker', () => {

	let fake, uninstall, storage, worker;

	beforeEach( async () => {

		fake = createFakeOPFS();
		uninstall = fake.install();
		( { storage } = await openStorage( { namespace: 'rayzee', transport: 'worker' } ) );
		worker = workers.at( - 1 );
		await storage._transport._ready;

	} );

	afterEach( () => {

		storage.dispose();
		uninstall();
		workers.length = 0;

	} );

	it( 'opens the namespace in the worker first, then commits and reads entries through it', async () => {

		expect( worker.messages[ 0 ] ).toMatchObject( { id: 0, op: 'init', args: { namespace: 'rayzee', root: null } } );

		const area = storage.area( 'downloads' );
		const writer = await area.create( 'k' );
		await writer.write( 'data', new Uint8Array( [ 4, 5, 6 ] ) );
		const meta = await writer.commit();
		expect( meta.files ).toEqual( { data: 3 } );
		expect( worker.messages.map( m => m.op ) ).toEqual( expect.arrayContaining( [ 'openWriter', 'write', 'closeWriter', 'writeFile' ] ) );
		expect( new Set( worker.messages.map( m => m.id ) ).size ).toBe( worker.messages.length );

		const entry = await area.open( 'k' );
		expect( [ ...new Uint8Array( await ( await entry.file( 'data' ) ).arrayBuffer() ) ] ).toEqual( [ 4, 5, 6 ] );
		entry.release();
		expect( snapshot( fake.root )[ `rayzee/downloads/${await entryIdFor( 'k' )}/data` ] ).toBe( 3 );

	} );

	it( 'rejects with the worker\'s error, its name kept, and ignores an answer it never asked for', async () => {

		await expect( storage._transport.call( 'readRange', { path: [ 'nowhere' ], name: 'f' } ) ).rejects.toMatchObject( { name: 'NotFoundError', message: 'nowhere not found' } );
		await expect( storage._transport.call( 'write', { id: 42, buffer: new ArrayBuffer( 1 ) } ) ).rejects.toThrow( 'storage: writer 42 is not open' );
		expect( () => worker.onmessage( { data: { id: 999, result: {} } } ) ).not.toThrow();

	} );

	it( 'leaves nothing unhandled when closed before the worker has opened', async () => {

		const unhandled = vi.fn();
		process.on( 'unhandledRejection', unhandled );
		try {

			const { storage: early } = await openStorage( { namespace: 'early', transport: 'worker' } );
			early.dispose();
			await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
			expect( unhandled ).not.toHaveBeenCalled();

		} finally {

			process.off( 'unhandledRejection', unhandled );

		}

	} );

	it( 'fails what is in flight and anything after once disposed', async () => {

		const pending = storage._transport.call( 'readRange', { path: [ 'a' ], name: 'f' } );
		const transport = storage._transport;
		storage.dispose();
		await expect( pending ).rejects.toThrow( 'storage: transport disposed' );
		await expect( transport.call( 'readRange', {} ) ).rejects.toThrow( 'storage: transport disposed' );
		expect( worker.terminated ).toBe( true );
		transport.dispose();

	} );

} );

describe( 'StorageArea.edit', () => {

	let ctx;

	beforeEach( async () => {

		ctx = await makeStorage();

	} );

	afterEach( () => {

		ctx.storage.dispose();
		ctx.uninstall();

	} );

	it( 'adds and replaces files, appends to one, and keeps the rest', async () => {

		const area = ctx.storage.area( 'downloads' );
		const first = await put( area, 'k', { keep: new Uint8Array( [ 1 ] ), log: new Uint8Array( [ 1, 2 ] ) }, { label: 'job', extra: { a: 1 } } );

		const writer = await area.edit( 'k' );
		await writer.writeFile( 'added', 'new' );
		await writer.write( 'log', new Uint8Array( [ 3 ] ) );
		const meta = await writer.commit( { b: 2 } );

		expect( meta.files ).toEqual( { keep: 1, log: 3, added: 3 } );
		expect( meta.label ).toBe( 'job' );
		expect( meta.extra ).toEqual( { a: 1, b: 2 } );
		expect( meta.createdAt ).toBe( first.createdAt );

		const entry = await area.open( 'k' );
		expect( [ ...new Uint8Array( await ( await entry.file( 'log' ) ).arrayBuffer() ) ] ).toEqual( [ 1, 2, 3 ] );
		expect( await ( await entry.file( 'added' ) ).text() ).toBe( 'new' );
		entry.release();

	} );

	it( 'keeps the committed entry when an edit is aborted, and returns null for no entry', async () => {

		const area = ctx.storage.area( 'downloads' );
		await put( area, 'k', { keep: new Uint8Array( [ 1 ] ) } );
		const writer = await area.edit( 'k' );
		await writer.writeFile( 'other', 'x' );
		await writer.abort();
		expect( ( await area.open( 'k' ) ) ).not.toBeNull();
		expect( await area.edit( 'missing' ) ).toBeNull();

	} );

} );

describe( 'growable files', () => {

	let ctx;

	beforeEach( async () => {

		ctx = await makeStorage();

	} );

	afterEach( () => {

		ctx.storage.dispose();
		ctx.uninstall();

	} );

	it( 'survive a crash mid-append, and the next append starts from the committed length', async () => {

		const area = ctx.storage.area( 'downloads' );
		const writer = await area.create( 'job', { growable: [ 'log' ] } );
		await writer.write( 'log', new Uint8Array( [ 1, 2 ] ) );
		await writer.commit();

		// A crash between an append and its commit leaves extra bytes on disk.
		const crashed = await area.edit( 'job' );
		await crashed.write( 'log', new Uint8Array( [ 9, 9, 9 ] ) );
		await crashed._closeAll( false );
		crashed._release();

		const entry = await area.open( 'job' );
		expect( entry ).not.toBeNull();
		expect( entry.meta.files.log ).toBe( 2 );
		entry.release();

		const next = await area.edit( 'job' );
		await next.write( 'log', new Uint8Array( [ 3 ] ) );
		await next.commit();

		const done = await area.open( 'job' );
		expect( [ ...new Uint8Array( await ( await done.file( 'log' ) ).arrayBuffer() ) ] ).toEqual( [ 1, 2, 3 ] );
		done.release();

	} );

} );
