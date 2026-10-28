import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const memoryStorage = ( initial = {} ) => {

	const items = new Map( Object.entries( initial ) );
	return {
		items,
		getItem: key => ( items.has( key ) ? items.get( key ) : null ),
		setItem: ( key, value ) => items.set( key, String( value ) ),
		removeItem: key => items.delete( key ),
	};

};

// The module caches its level, filter and warned keys: each test starts from a fresh copy.
const freshLogger = async () => {

	vi.resetModules();
	return import( '@/core/Logger.js' );

};

describe( 'Logger', () => {

	let log, warn, error, group, groupCollapsed, groupEnd;

	beforeEach( () => {

		log = vi.spyOn( console, 'log' ).mockImplementation( () => {} );
		warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		error = vi.spyOn( console, 'error' ).mockImplementation( () => {} );
		group = vi.spyOn( console, 'group' ).mockImplementation( () => {} );
		groupCollapsed = vi.spyOn( console, 'groupCollapsed' ).mockImplementation( () => {} );
		groupEnd = vi.spyOn( console, 'groupEnd' ).mockImplementation( () => {} );

	} );

	afterEach( () => {

		delete globalThis.__RAYZEE_LOG_LEVEL__;
		delete globalThis.__RAYZEE_LOG_NS__;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	it( 'prints info and above by default, each level to its console method, the prefix styled', async () => {

		const { createLogger, Logger } = await freshLogger();
		const bvh = createLogger( 'bvh' );

		bvh.debug( 'hidden' );
		bvh.info( 'built', 3 );
		bvh.warn( 'slow' );
		bvh.error( new Error( 'broken' ) );

		expect( Logger.getLevel() ).toBe( 'info' );
		expect( log ).toHaveBeenCalledOnce();
		expect( log ).toHaveBeenCalledWith( '%c[bvh]%c built', 'color:#7c8494', 'color:inherit', 3 );
		expect( warn ).toHaveBeenCalledWith( '%c[bvh]%c slow', 'color:#7c8494', 'color:inherit' );
		expect( error.mock.calls[ 0 ].slice( 0, 2 ) ).toEqual( [ '%c[bvh]', 'color:#7c8494' ] );
		expect( error.mock.calls[ 0 ][ 2 ] ).toBeInstanceOf( Error );
		expect( bvh.namespace ).toBe( 'bvh' );

	} );

	it( 'takes its level from the global first, then storage, then info', async () => {

		vi.stubGlobal( 'localStorage', memoryStorage( { rayzeeLogLevel: 'warn' } ) );
		expect( ( await freshLogger() ).Logger.getLevel() ).toBe( 'warn' );

		globalThis.__RAYZEE_LOG_LEVEL__ = 'debug';
		expect( ( await freshLogger() ).Logger.getLevel() ).toBe( 'debug' );

		globalThis.__RAYZEE_LOG_LEVEL__ = 'loud';
		expect( ( await freshLogger() ).Logger.getLevel() ).toBe( 'warn' );

		vi.stubGlobal( 'localStorage', memoryStorage( { rayzeeLogLevel: 'chatty' } ) );
		expect( ( await freshLogger() ).Logger.getLevel() ).toBe( 'info' );

	} );

	it( 'falls back to info when storage cannot be read, and still applies a level it cannot store', async () => {

		vi.stubGlobal( 'localStorage', {
			getItem() {

				throw new Error( 'denied' );

			},
			setItem() {

				throw new Error( 'denied' );

			},
		} );

		const { Logger, createLogger } = await freshLogger();
		expect( Logger.getLevel() ).toBe( 'info' );
		expect( Logger.setLevel( 'debug' ) ).toBe( 'debug' );
		createLogger( 'gpu' ).debug( 'shown' );
		expect( log ).toHaveBeenCalledOnce();

	} );

	it( 'sets a level for this page and the next, forgetting the default', async () => {

		const storage = memoryStorage();
		vi.stubGlobal( 'localStorage', storage );
		const { Logger, createLogger } = await freshLogger();
		const scene = createLogger( 'scene' );

		expect( Logger.setLevel( 'warn' ) ).toBe( 'warn' );
		expect( globalThis.__RAYZEE_LOG_LEVEL__ ).toBe( 'warn' );
		expect( storage.items.get( 'rayzeeLogLevel' ) ).toBe( 'warn' );
		scene.info( 'hidden' );
		expect( log ).not.toHaveBeenCalled();
		expect( Logger.isEnabled( 'warn' ) ).toBe( true );
		expect( Logger.isEnabled( 'info' ) ).toBe( false );
		expect( Logger.isEnabled( 'nonsense' ) ).toBe( false );
		expect( scene.isEnabled( 'error' ) ).toBe( true );

		expect( Logger.setLevel( 'shout' ) ).toBe( 'warn' );
		expect( warn ).toHaveBeenCalledWith( expect.stringContaining( 'unknown level \'shout\'' ) );

		Logger.setLevel( 'info' );
		expect( storage.items.has( 'rayzeeLogLevel' ) ).toBe( false );

		Logger.setLevel( 'silent' );
		scene.error( 'hidden too' );
		expect( error ).not.toHaveBeenCalled();

	} );

	it( 'narrows debug to the namespaces asked for, their sub-namespaces included, never warnings', async () => {

		const storage = memoryStorage();
		vi.stubGlobal( 'localStorage', storage );
		const { Logger, createLogger } = await freshLogger();

		expect( Logger.only( 'bvh', [ 'gpu' ], '' ) ).toEqual( [ 'bvh', 'gpu' ] );
		expect( Logger.getLevel() ).toBe( 'debug' );
		expect( storage.items.get( 'rayzeeLogNamespaces' ) ).toBe( 'bvh,gpu' );

		createLogger( 'bvh' ).debug( 'a' );
		createLogger( 'bvh:refit' ).debug( 'b' );
		createLogger( 'bvhx' ).debug( 'c' );
		createLogger( 'scene' ).debug( 'd' );
		createLogger( 'scene' ).info( 'e' );
		createLogger( 'scene' ).warn( 'f' );
		expect( log.mock.calls.map( c => c[ 0 ] ) ).toEqual( [ '%c[bvh]%c a', '%c[bvh:refit]%c b', '%c[scene]%c e' ] );
		expect( warn ).toHaveBeenCalledOnce();

		expect( Logger.only() ).toEqual( [] );
		expect( storage.items.has( 'rayzeeLogNamespaces' ) ).toBe( false );
		createLogger( 'scene' ).debug( 'g' );
		expect( log ).toHaveBeenCalledTimes( 4 );

	} );

	it( 'reads a namespace filter from the global or storage, and again after a refresh', async () => {

		globalThis.__RAYZEE_LOG_LEVEL__ = 'debug';
		globalThis.__RAYZEE_LOG_NS__ = ' gpu , ';
		const { Logger, createLogger } = await freshLogger();
		createLogger( 'gpu' ).debug( 'a' );
		createLogger( 'bvh' ).debug( 'b' );
		expect( log ).toHaveBeenCalledOnce();

		delete globalThis.__RAYZEE_LOG_NS__;
		vi.stubGlobal( 'localStorage', memoryStorage( { rayzeeLogNamespaces: 'bvh' } ) );
		globalThis.__RAYZEE_LOG_LEVEL__ = 'warn';
		createLogger( 'bvh' ).debug( 'cached' );
		expect( log ).toHaveBeenCalledOnce();

		expect( Logger.refresh() ).toBe( 'warn' );
		globalThis.__RAYZEE_LOG_LEVEL__ = 'debug';
		Logger.refresh();
		createLogger( 'bvh' ).debug( 'c' );
		createLogger( 'gpu' ).debug( 'd' );
		expect( log.mock.calls.map( c => c[ 0 ] ) ).toEqual( [ '%c[gpu]%c a', '%c[bvh]%c c' ] );

	} );

	it( 'folds a summary\'s details under one line, open at debug', async () => {

		const { Logger, createLogger } = await freshLogger();
		const scene = createLogger( 'scene' );

		scene.summary( 'loaded', [ 'meshes 3', null, 'lights 1' ] );
		expect( groupCollapsed ).toHaveBeenCalledWith( '%c[scene]%c loaded', 'color:#7c8494', 'color:inherit' );
		expect( log.mock.calls ).toEqual( [[ 'meshes 3' ], [ 'lights 1' ]] );
		expect( groupEnd ).toHaveBeenCalledOnce();

		Logger.setLevel( 'debug' );
		scene.summary( 'loaded', [ 'meshes 3' ] );
		expect( group ).toHaveBeenCalledOnce();

		Logger.setLevel( 'warn' );
		scene.summary( 'loaded', [ 'meshes 3' ] );
		expect( groupCollapsed ).toHaveBeenCalledOnce();
		expect( groupEnd ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'prints a summary as plain lines without details or console groups', async () => {

		const { Logger, createLogger } = await freshLogger();
		const scene = createLogger( 'scene' );

		scene.summary( 'loaded' );
		expect( log ).toHaveBeenCalledWith( '%c[scene]%c loaded', 'color:#7c8494', 'color:inherit' );
		expect( groupCollapsed ).not.toHaveBeenCalled();

		Logger.setLevel( 'debug' );
		vi.stubGlobal( 'console', { ...console, groupCollapsed: undefined, log } );
		scene.summary( 'again', [ 'detail' ] );
		expect( log.mock.calls.slice( 1 ).map( c => c[ 0 ] ) ).toEqual( [ '%c[scene]%c again', '%c[scene]%c detail' ] );

	} );

	it( 'warns once per key', async () => {

		const { createLogger, warnOnce } = await freshLogger();
		const materials = createLogger( 'materials' );
		warnOnce( materials, 'mat:7', 'unsupported map on', 7 );
		warnOnce( materials, 'mat:7', 'unsupported map on', 7 );
		warnOnce( materials, 'mat:8', 'unsupported map on', 8 );
		expect( warn.mock.calls.map( c => c[ 3 ] ) ).toEqual( [ 7, 8 ] );

	} );

	it( 'hands a worker the level and applies only a known one there', async () => {

		const { workerLogLevel, applyWorkerLogLevel, Logger } = await freshLogger();
		expect( workerLogLevel() ).toBe( 'info' );
		applyWorkerLogLevel( 'debug' );
		expect( Logger.getLevel() ).toBe( 'debug' );
		expect( globalThis.__RAYZEE_LOG_LEVEL__ ).toBe( 'debug' );
		applyWorkerLogLevel( 'verbose' );
		applyWorkerLogLevel( null );
		expect( workerLogLevel() ).toBe( 'debug' );

	} );

} );

describe( 'fmt', () => {

	it( 'formats counts, times, sizes and summary lines', async () => {

		const { fmt } = await import( '@/core/Logger.js' );
		expect( fmt.n( 18016 ) ).toBe( '18,016' );
		expect( fmt.ms( 481.27 ) ).toBe( '481 ms' );
		expect( fmt.ms( 4.26 ) ).toBe( '4.3 ms' );
		expect( fmt.mb( 592 * 1048576 ) ).toBe( '592 MB' );
		expect( fmt.mb( 1.5 * 1048576 ) ).toBe( '1.5 MB' );
		expect( fmt.px( 512, 256 ) ).toBe( '512×256' );
		expect( fmt.count( 1, 'map' ) ).toBe( '1 map' );
		expect( fmt.count( 2000, 'map' ) ).toBe( '2,000 maps' );
		expect( fmt.count( 2, 'mesh', 'meshes' ) ).toBe( '2 meshes' );
		expect( fmt.list( [ 'a', false, null, 'b' ] ) ).toBe( 'a · b' );

	} );

} );
