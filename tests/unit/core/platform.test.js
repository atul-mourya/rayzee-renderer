import { describe, it, expect, vi, afterEach } from 'vitest';
import { configurePlatform, createWorker, getPlatform, hasWorkers, hardwareThreads } from '@/core/Platform.js';

// Stands in for a bundled worker constructor, which calls the global `Worker` itself.
class BundledWorker {

	constructor( options ) {

		this.inner = new globalThis.Worker( 'data:text/javascript,', options );

	}

}

describe( 'Platform', () => {

	afterEach( () => {

		configurePlatform( { Worker: null, decodeImage: null } );
		vi.unstubAllGlobals();

	} );

	it( 'starts a bundled worker on the host\'s class, and leaves the global as it was', () => {

		const Host = vi.fn( function ( url, options ) {

			this.options = options;

		} );
		configurePlatform( { Worker: Host } );
		const hadWorker = Object.prototype.hasOwnProperty.call( globalThis, 'Worker' );

		const worker = createWorker( BundledWorker, { name: 'bvh' } );

		expect( worker.inner ).toBeInstanceOf( Host );
		expect( worker.inner.options ).toEqual( { name: 'bvh' } );
		expect( Object.prototype.hasOwnProperty.call( globalThis, 'Worker' ) ).toBe( hadWorker );

	} );

	it( 'restores the global even when the constructor throws', () => {

		configurePlatform( { Worker: class {

			constructor() {

				throw new Error( 'no thread' );

			}

		} } );
		const before = globalThis.Worker;

		expect( () => createWorker( BundledWorker ) ).toThrow( 'no thread' );
		expect( globalThis.Worker ).toBe( before );

	} );

	it( 'counts a host class as workers being available', () => {

		vi.stubGlobal( 'Worker', undefined );
		expect( hasWorkers() ).toBe( false );
		configurePlatform( { Worker: class {} } );
		expect( hasWorkers() ).toBe( true );

	} );

	it( 'replaces only the keys given', () => {

		const decodeImage = async () => ( {} );
		configurePlatform( { decodeImage } );
		configurePlatform( { Worker: class {} } );
		expect( getPlatform().decodeImage ).toBe( decodeImage );

	} );

	it( 'falls back to 4 cores where nothing reports them', () => {

		vi.stubGlobal( 'navigator', undefined );
		expect( hardwareThreads() ).toBe( 4 );

	} );

} );
