import { describe, it, expect, afterEach } from 'vitest';
import { configurePlatform, withHostGlobals, withHostWorker } from '@/core/Platform.js';

class HostWorker {}

describe( 'withHostWorker', () => {

	afterEach( () => {

		configurePlatform( { Worker: null } );
		delete globalThis.Worker;

	} );

	it( 'lends the host\'s Worker for the whole task, across awaits, and takes it back', async () => {

		configurePlatform( { Worker: HostWorker } );
		expect( globalThis.Worker ).toBeUndefined();

		const seen = await withHostWorker( async () => {

			await new Promise( ( resolve ) => setTimeout( resolve, 1 ) );
			return globalThis.Worker;

		} );

		expect( seen ).toBe( HostWorker );
		expect( globalThis.Worker ).toBeUndefined();

	} );

	it( 'keeps one loan for overlapping tasks until the last ends, and after a failure', async () => {

		configurePlatform( { Worker: HostWorker } );
		let releaseFirst;
		const first = withHostWorker( () => new Promise( ( resolve ) => {

			releaseFirst = resolve;

		} ) );
		await expect( withHostWorker( async () => {

			throw new Error( 'decode failed' );

		} ) ).rejects.toThrow( 'decode failed' );

		expect( globalThis.Worker ).toBe( HostWorker );
		releaseFirst();
		await first;
		expect( globalThis.Worker ).toBeUndefined();

	} );

	it( 'leaves a global Worker alone, and lends nothing without a host class', async () => {

		class BrowserWorker {}
		globalThis.Worker = BrowserWorker;
		configurePlatform( { Worker: HostWorker } );
		expect( await withHostWorker( async () => globalThis.Worker ) ).toBe( BrowserWorker );
		expect( globalThis.Worker ).toBe( BrowserWorker );

		delete globalThis.Worker;
		configurePlatform( { Worker: null } );
		expect( await withHostWorker( async () => globalThis.Worker ) ).toBeUndefined();

	} );

} );

describe( 'withHostGlobals', () => {

	class HostParser {}
	class HostNode {}

	it( 'lends each global the runtime lacks for the task, then takes it back', async () => {

		const seen = await withHostGlobals( { DOMParser: HostParser, Node: HostNode }, async () => {

			await new Promise( ( resolve ) => setTimeout( resolve, 1 ) );
			return [ globalThis.DOMParser, globalThis.Node ];

		} );

		expect( seen ).toEqual( [ HostParser, HostNode ] );
		expect( [ typeof globalThis.DOMParser, typeof globalThis.Node ] ).toEqual( [ 'undefined', 'undefined' ] );

	} );

	it( 'keeps a runtime\'s own, and lends nothing for a missing value', async () => {

		class OwnParser {}
		globalThis.DOMParser = OwnParser;
		try {

			expect( await withHostGlobals( { DOMParser: HostParser }, async () => globalThis.DOMParser ) ).toBe( OwnParser );

		} finally {

			delete globalThis.DOMParser;

		}

		expect( await withHostGlobals( { DOMParser: null, Node: null }, async () => [ typeof globalThis.DOMParser, typeof globalThis.Node ] ) ).toEqual( [ 'undefined', 'undefined' ] );

	} );

} );
