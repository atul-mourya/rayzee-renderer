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

		configurePlatform( { Worker: null, decodeImage: null, threads: null } );
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

	it( 'counts the host\'s threads in place of the cores, and null as every core', () => {

		vi.stubGlobal( 'navigator', { hardwareConcurrency: 12 } );
		for ( const threads of [ 1, 3, 16 ] ) {

			configurePlatform( { threads } );
			expect( hardwareThreads() ).toBe( threads );

		}

		configurePlatform( { threads: null } );
		expect( hardwareThreads() ).toBe( 12 );

	} );

	it( 'refuses threads that are not a whole number from 1, changing nothing', () => {

		configurePlatform( { threads: 3 } );
		const decodeImage = async () => ( {} );
		for ( const threads of [ 0, - 2, 2.5, NaN, '4' ] ) {

			expect( () => configurePlatform( { threads, decodeImage } ), String( threads ) ).toThrow( /threads is a whole number from 1/ );

		}

		expect( [ hardwareThreads(), getPlatform().decodeImage ] ).toEqual( [ 3, null ] );

	} );

	it( 'takes threads through nodePlatform, and leaves them alone when not given', async () => {

		const { nodePlatform } = await import( '@/core/node/NodePlatform.js' );
		vi.stubGlobal( 'GPUQueue', class {

			writeBuffer() {}

			writeTexture() {}

		} );
		expect( nodePlatform( { threads: 2 } ).threads ).toBe( 2 );
		expect( 'threads' in nodePlatform() ).toBe( false );

	} );

} );
