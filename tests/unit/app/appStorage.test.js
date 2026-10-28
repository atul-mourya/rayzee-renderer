import { describe, it, expect, afterEach, vi } from 'vitest';
import { describeUsage, formatBytes, memorySpillPreference, setMemorySpillPreference, spillNote, getStorage, ensureAppAreas, APP_AREAS } from '@/lib/storage';
import { setApp } from '@/lib/appProxy';

function memoryStorage() {

	const memory = new Map();
	return {
		memory,
		getItem: ( key ) => memory.get( key ) ?? null,
		setItem: ( key, value ) => memory.set( key, String( value ) ),
		removeItem: ( key ) => memory.delete( key ),
	};

}

describe( 'app storage summary', () => {

	it( 'lists user data before caches and names every area', () => {

		const summary = describeUsage( {
			quota: 1e12,
			usage: 3072,
			persisted: false,
			budget: 3e11,
			cacheBytes: 2048,
			areas: {
				scenes: { kind: 'cache', bytes: 2048, entries: 1 },
				downloads: { kind: 'cache', bytes: 0, entries: 0 },
				renders: { kind: 'user', bytes: 1024, entries: 2 },
				custom: { kind: 'user', bytes: 0, entries: 0 },
			},
		} );

		expect( summary.rows.map( ( r ) => r.name ) ).toEqual( [ 'renders', 'downloads', 'scenes', 'custom' ] );
		expect( summary.rows[ 0 ].label ).toBe( 'Saved renders' );
		expect( summary.rows[ 3 ].label ).toBe( 'custom' );
		expect( summary.userBytes ).toBe( 1024 );
		expect( summary.siteBytes ).toBe( 3072 );

	} );

	it( 'formats sizes', () => {

		expect( formatBytes( 512 ) ).toBe( '512 B' );
		expect( formatBytes( 1536 ) ).toBe( '1.5 KB' );
		expect( formatBytes( 7.3 * 1024 ** 3 ) ).toBe( '7.3 GB' );
		expect( formatBytes( 250 * 1024 ** 2 ) ).toBe( '250 MB' );
		expect( formatBytes( Infinity ) ).toBe( '—' );
		expect( formatBytes( 1023 ) ).toBe( '1023 B' );
		expect( formatBytes( 3 * 1024 ** 5 ) ).toBe( '3072 TB' );

	} );

	it( 'leaves areas it does not know unexplained', () => {

		const { rows } = describeUsage( { areas: { zeta: { kind: 'cache', bytes: 1, entries: 1 }, alpha: { kind: 'cache', bytes: 2, entries: 1 } } } );
		expect( rows.map( ( r ) => [ r.name, r.label, r.hint ] ) ).toEqual( [[ 'alpha', 'alpha', '' ], [ 'zeta', 'zeta', '' ]] );

	} );

} );

describe( 'app storage settings', () => {

	afterEach( () => {

		setApp( null );
		vi.unstubAllGlobals();

	} );

	it( 'remembers how large scenes use the disk and tells the engine', () => {

		const store = memoryStorage();
		vi.stubGlobal( 'localStorage', store );
		const app = { isInitialized: true, setMemorySpill: vi.fn() };
		setApp( app );

		expect( memorySpillPreference() ).toBe( 'auto' );
		setMemorySpillPreference( true );
		expect( store.memory.get( 'rayzee-memory-spill' ) ).toBe( '1' );
		expect( memorySpillPreference() ).toBe( true );
		setMemorySpillPreference( false );
		expect( memorySpillPreference() ).toBe( false );
		setMemorySpillPreference( 'auto' );
		expect( store.memory.has( 'rayzee-memory-spill' ) ).toBe( false );
		expect( memorySpillPreference() ).toBe( 'auto' );
		expect( app.setMemorySpill.mock.calls ).toEqual( [[ true ], [ false ], [ 'auto' ]] );

		store.setItem( 'rayzee-memory-spill', 'sometimes' );
		expect( memorySpillPreference() ).toBe( 'auto' );

	} );

	it( 'reads auto and still tells the engine where nothing can be remembered', () => {

		vi.stubGlobal( 'localStorage', { getItem: () => {

			throw new Error( 'denied' );

		}, setItem: () => {

			throw new Error( 'denied' );

		} } );
		const app = { isInitialized: true, setMemorySpill: vi.fn() };
		setApp( app );

		expect( memorySpillPreference() ).toBe( 'auto' );
		expect( () => setMemorySpillPreference( false ) ).not.toThrow();
		expect( app.setMemorySpill ).toHaveBeenCalledWith( false );

		setApp( null );
		expect( () => setMemorySpillPreference( true ) ).not.toThrow();

	} );

	it( 'notes a scene built through disk', () => {

		expect( spillNote( null ) ).toBe( '' );
		expect( spillNote( { sceneSpilled: false, geometryOnDisk: true } ) ).toBe( '' );
		expect( spillNote( { sceneSpilled: true } ) ).toBe( ' Built through disk to save memory.' );
		expect( spillNote( { sceneSpilled: true, geometryOnDisk: true } ) ).toBe( ' Built through disk to save memory; clicking to select objects is off for this scene.' );

	} );

	it( 'reaches the app\'s storage once the app is up, and defines the app\'s areas there', () => {

		expect( getStorage() ).toBeNull();
		setApp( { isInitialized: false, storage: {} } );
		expect( getStorage() ).toBeNull();
		setApp( { isInitialized: true } );
		expect( getStorage() ).toBeNull();
		const storage = { defineArea: vi.fn() };
		setApp( { isInitialized: true, storage } );
		expect( getStorage() ).toBe( storage );

		ensureAppAreas( null );
		ensureAppAreas( storage );
		expect( storage.defineArea.mock.calls ).toEqual( Object.values( APP_AREAS ).map( ( name ) => [ name, { kind: 'user' } ] ) );
		expect( Object.values( APP_AREAS ).sort() ).toEqual( [ 'jobs', 'projects', 'renders', 'sessions' ] );

	} );

} );
