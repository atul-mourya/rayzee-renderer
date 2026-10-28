import { describe, it, expect, afterEach, vi } from 'vitest';
import { acquireLock, heldLockNames } from '@/core/addons/storage/Locks.js';
import { sampleHash, fileIdentity, identityKey, sameIdentity, entryIdFor } from '@/core/storage/FileIdentity.js';

const tick = () => new Promise( ( r ) => setTimeout( r, 1 ) );

describe( 'acquireLock (in-process fallback)', () => {

	it( 'lets readers share and makes a writer wait for them', async () => {

		const a = await acquireLock( 'L1', { mode: 'shared' } );
		const b = await acquireLock( 'L1', { mode: 'shared' } );
		let writer = null;
		const pending = acquireLock( 'L1' ).then( ( release ) => ( writer = release ) );

		await tick();
		expect( writer ).toBeNull();
		a();
		await tick();
		expect( writer ).toBeNull();
		b();
		await pending;
		expect( typeof writer ).toBe( 'function' );
		expect( ( await heldLockNames() ).has( 'L1' ) ).toBe( true );
		writer();
		expect( ( await heldLockNames() ).has( 'L1' ) ).toBe( false );

	} );

	it( 'queues readers behind a waiting writer, first come first served', async () => {

		const order = [];
		const first = await acquireLock( 'L2', { mode: 'shared' } );
		const w = acquireLock( 'L2' ).then( ( r ) => {

			order.push( 'writer' );
			return r;

		} );
		const s = acquireLock( 'L2', { mode: 'shared' } ).then( ( r ) => {

			order.push( 'reader' );
			return r;

		} );

		first();
		( await w )();
		( await s )();
		expect( order ).toEqual( [ 'writer', 'reader' ] );

	} );

	it( 'returns null when ifAvailable and taken; release is idempotent', async () => {

		const held = await acquireLock( 'L3' );
		expect( await acquireLock( 'L3', { ifAvailable: true } ) ).toBeNull();
		held();
		held();
		const again = await acquireLock( 'L3', { ifAvailable: true } );
		expect( again ).not.toBeNull();
		again();

	} );

} );

describe( 'acquireLock (Web Locks)', () => {

	const webLocks = () => {

		const held = new Map();
		return {
			held,
			request: vi.fn( async ( name, { mode, ifAvailable }, callback ) => {

				if ( name === 'refused' ) throw new DOMException( 'aborted', 'AbortError' );
				if ( held.has( name ) && ifAvailable ) return callback( null );
				held.set( name, mode );
				try {

					return await callback( { name, mode } );

				} finally {

					held.delete( name );

				}

			} ),
			query: vi.fn( async () => ( { held: [ ...held ].map( ( [ name, mode ] ) => ( { name, mode } ) ) } ) ),
		};

	};

	afterEach( () => {

		vi.unstubAllGlobals();

	} );

	it( 'holds the browser\'s lock until released, once', async () => {

		const locks = webLocks();
		vi.stubGlobal( 'navigator', { locks } );

		const release = await acquireLock( 'W1', { mode: 'shared' } );
		expect( locks.request ).toHaveBeenCalledWith( 'W1', { mode: 'shared', ifAvailable: false }, expect.any( Function ) );
		expect( await heldLockNames() ).toEqual( new Set( [ 'W1' ] ) );

		release();
		release();
		await tick();
		expect( await heldLockNames() ).toEqual( new Set() );

	} );

	it( 'resolves null when taken and asked only if available, and rejects when the browser refuses', async () => {

		const locks = webLocks();
		vi.stubGlobal( 'navigator', { locks } );

		const held = await acquireLock( 'W2' );
		expect( await acquireLock( 'W2', { ifAvailable: true } ) ).toBeNull();
		held();
		await expect( acquireLock( 'refused' ) ).rejects.toThrow( 'aborted' );

		locks.query.mockResolvedValueOnce( {} );
		expect( await heldLockNames() ).toEqual( new Set() );

	} );

} );

describe( 'identity', () => {

	it( 'hashes a small file whole', async () => {

		const a = new Blob( [ new Uint8Array( 1000 ).fill( 1 ) ] );
		const b = new Blob( [ new Uint8Array( 1000 ).fill( 1 ) ] );
		const c = new Blob( [ new Uint8Array( 1000 ).fill( 2 ) ] );
		expect( await sampleHash( a ) ).toBe( await sampleHash( b ) );
		expect( await sampleHash( a ) ).not.toBe( await sampleHash( c ) );

	} );

	it( 'samples a large file: head, tail and probes count, gaps do not', async () => {

		const size = 8 * 1024 * 1024;
		const base = new Uint8Array( size );
		const hash = ( bytes ) => sampleHash( new Blob( [ bytes ] ) );

		const original = await hash( base );

		const head = base.slice();
		head[ 10 ] = 1;
		expect( await hash( head ) ).not.toBe( original );

		const tail = base.slice();
		tail[ size - 5 ] = 1;
		expect( await hash( tail ) ).not.toBe( original );

		// The first probe covers [HEAD + span*0.5/14, +64 KiB); the byte just after the head is in no probe.
		const gap = base.slice();
		gap[ 1024 * 1024 + 1 ] = 1;
		expect( await hash( gap ) ).toBe( original );

	} );

	it( 'builds a stable key from a File identity', async () => {

		const file = new File( [ 'abc' ], 'scene.glb', { lastModified: 42 } );
		const id = await fileIdentity( file );
		expect( id ).toMatchObject( { name: 'scene.glb', size: 3, lastModified: 42 } );
		expect( identityKey( id ) ).toBe( `file:scene.glb|3|42|${id.sample}` );
		expect( sameIdentity( id, { ...id, lastModified: 7 } ) ).toBe( true );
		expect( sameIdentity( id, { ...id, size: 4 } ) ).toBe( false );
		expect( await entryIdFor( 'x' ) ).toMatch( /^[0-9a-f]{32}$/ );

	} );

} );
