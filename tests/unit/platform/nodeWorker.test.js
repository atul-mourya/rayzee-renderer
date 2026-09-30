import { describe, it, expect, afterEach } from 'vitest';
import { NodeWorker } from '@/core/node/NodeWorker.js';

const moduleURL = ( code ) => 'data:text/javascript;charset=utf-8,' + encodeURIComponent( code );
const nextMessage = ( worker ) => new Promise( ( resolve ) => {

	worker.onmessage = ( event ) => resolve( event.data );

} );

describe( 'NodeWorker', () => {

	const started = [];
	afterEach( () => started.splice( 0 ).forEach( ( w ) => w.terminate() ) );
	const start = ( url, options ) => {

		const worker = new NodeWorker( url, options );
		started.push( worker );
		return worker;

	};

	it( 'runs a module worker the way the published build inlines one', async () => {

		const worker = start( moduleURL( 'self.onmessage = ( e ) => self.postMessage( e.data * 2 );' ), { type: 'module' } );
		const reply = nextMessage( worker );
		worker.postMessage( 21 );
		expect( await reply ).toBe( 42 );

	} );

	it( 'holds messages posted before the module has loaded, in order', async () => {

		const worker = start( moduleURL( 'const seen = []; self.addEventListener( "message", ( e ) => { seen.push( e.data ); if ( seen.length === 3 ) self.postMessage( seen ); } );' ), { type: 'module' } );
		const reply = nextMessage( worker );
		worker.postMessage( 'a' );
		worker.postMessage( 'b' );
		worker.postMessage( 'c' );
		expect( await reply ).toEqual( [ 'a', 'b', 'c' ] );

	} );

	it( 'runs a classic worker in the global scope, as three.js\'s decoders are', async () => {

		const worker = start( moduleURL( 'var scale = 3; onmessage = function ( e ) { postMessage( e.data * scale ); };' ) );
		const reply = nextMessage( worker );
		worker.postMessage( 5 );
		expect( await reply ).toBe( 15 );

	} );

	it( 'transfers ArrayBuffers and shares SharedArrayBuffers', async () => {

		const worker = start( moduleURL( 'self.onmessage = ( e ) => { new Int32Array( e.data.shared )[ 0 ] = 7; self.postMessage( e.data.owned.byteLength ); };' ), { type: 'module' } );
		const shared = new SharedArrayBuffer( 4 );
		const owned = new ArrayBuffer( 16 );
		const reply = nextMessage( worker );
		worker.postMessage( { shared, owned }, [ owned ] );

		expect( await reply ).toBe( 16 );
		expect( owned.byteLength ).toBe( 0 );
		expect( new Int32Array( shared )[ 0 ] ).toBe( 7 );

	} );

	it( 'reads a blob: worker too', async () => {

		const url = URL.createObjectURL( new Blob( [ 'self.onmessage = () => self.postMessage( "from a blob" );' ] ) );
		const worker = start( url, { type: 'module' } );
		const reply = nextMessage( worker );
		worker.postMessage( null );
		expect( await reply ).toBe( 'from a blob' );

	} );

	it( 'reports an error thrown in the worker', async () => {

		const worker = start( moduleURL( 'self.onmessage = () => { throw new Error( "boom" ); };' ), { type: 'module' } );
		const failed = new Promise( ( resolve ) => worker.addEventListener( 'error', resolve ) );
		worker.postMessage( null );
		expect( ( await failed ).message ).toMatch( /boom/ );

	} );

	it( 'refuses a URL it cannot read', () => {

		expect( () => new NodeWorker( 'https://example.com/worker.js' ) ).toThrow( /only data: and blob:/ );

	} );

} );
