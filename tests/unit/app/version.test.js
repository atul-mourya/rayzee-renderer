import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const Logger = vi.hoisted( () => ( { getLevel: vi.fn( () => 'info' ) } ) );
vi.mock( 'rayzee', () => ( { Logger } ) );

describe( 'version', () => {

	let log;

	beforeEach( () => {

		vi.resetModules();
		vi.stubGlobal( '__APP_VERSION__', '11.15.1' );
		log = vi.spyOn( console, 'log' ).mockImplementation( () => {} );
		Logger.getLevel.mockReturnValue( 'info' );

	} );

	afterEach( () => {

		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		delete globalThis.rayzee;

	} );

	it( 'reads the version Vite defines at build time', async () => {

		const { appVersion } = await import( '@/lib/version.js' );
		expect( appVersion ).toBe( '11.15.1' );

	} );

	it( 'puts the log controls and version on the console handle, keeping what is already there', async () => {

		globalThis.rayzee = { app: 'kept' };
		const { logVersion } = await import( '@/lib/version.js' );

		logVersion();

		expect( globalThis.rayzee ).toEqual( { app: 'kept', log: Logger, version: '11.15.1' } );
		expect( log ).toHaveBeenCalledTimes( 1 );
		expect( log.mock.calls[ 0 ][ 0 ] ).toContain( ' 11.15.1' );

	} );

	it( 'says which log level is active when it is not the default', async () => {

		Logger.getLevel.mockReturnValue( 'debug' );
		const { logVersion } = await import( '@/lib/version.js' );

		logVersion();

		expect( log ).toHaveBeenCalledTimes( 2 );
		expect( log.mock.calls[ 1 ][ 0 ] ).toContain( 'level \'debug\' is active' );

	} );

} );
