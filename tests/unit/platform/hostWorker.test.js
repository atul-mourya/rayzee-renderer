import { describe, it, expect, afterEach } from 'vitest';
import { configurePlatform, withHostWorker } from '@/core/Platform.js';

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
