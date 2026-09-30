import { Worker as ThreadWorker } from 'node:worker_threads';
import { Buffer, resolveObjectURL } from 'node:buffer';

// Evaluated inside the thread: a dedicated worker's `self` over parentPort, then the module. Messages
// that arrive before the module has installed its handler are held, not dropped.
const BOOTSTRAP = `
const { parentPort } = require( 'node:worker_threads' );
const listeners = { message: new Set(), error: new Set(), messageerror: new Set() };
const held = [];
let ready = false;

const transferable = ( list ) => ( list ?? [] ).filter( ( item ) => item instanceof ArrayBuffer || item?.constructor?.name === 'MessagePort' );
const deliver = ( data ) => {

	const event = { type: 'message', data };
	globalThis.onmessage?.( event );
	for ( const fn of listeners.message ) fn( event );

};

globalThis.self = globalThis;
globalThis.onmessage = null;
globalThis.postMessage = ( data, transfer ) => parentPort.postMessage( data, transferable( Array.isArray( transfer ) ? transfer : transfer?.transfer ) );
globalThis.addEventListener = ( type, fn ) => listeners[ type ]?.add( fn );
globalThis.removeEventListener = ( type, fn ) => listeners[ type ]?.delete( fn );
globalThis.close = () => process.exit( 0 );

parentPort.on( 'message', ( message ) => {

	if ( message?.__rayzeeModule !== undefined ) {

		const release = () => {

			ready = true;
			for ( const data of held.splice( 0 ) ) deliver( data );

		};

		// A classic worker is a script in the global scope (three's Draco decoder is one).
		if ( message.classic ) {

			require( 'node:vm' ).runInThisContext( message.__rayzeeModule );
			release();

		} else {

			import( 'data:text/javascript;charset=utf-8,' + encodeURIComponent( message.__rayzeeModule ) ).then( release, ( error ) => { throw error; } );

		}

		return;

	}

	if ( ready ) deliver( message );
	else held.push( message );

} );
`;

const DATA_URL = /^data:([^,]*?)(;base64)?,(.*)$/s;

function readModuleSource( url ) {

	const href = String( url );

	if ( href.startsWith( 'blob:' ) ) {

		const blob = resolveObjectURL( href );
		if ( ! blob ) throw new Error( `NodeWorker: no blob behind ${href}` );
		return blob.text();

	}

	const match = DATA_URL.exec( href );
	if ( ! match ) throw new Error( `NodeWorker: only data: and blob: worker URLs are supported, got ${href.slice( 0, 64 )}` );
	const [ , , base64, body ] = match;
	return base64 ? Buffer.from( body, 'base64' ).toString( 'utf8' ) : decodeURIComponent( body );

}

/**
 * The Web Worker API over `worker_threads`, for hosts with no browser (see nodePlatform). It runs
 * `data:` and `blob:` workers, module or classic: the engine's own, which the published build inlines,
 * and three.js's. Those call the global `Worker`, so a model using Draco or KTX2 also needs
 * `globalThis.Worker = NodeWorker`. ArrayBuffers transfer and
 * SharedArrayBuffers share as in a browser; an ImageBitmap cannot exist here to transfer.
 */
export class NodeWorker {

	constructor( url, options = {} ) {

		this.onmessage = null;
		this.onerror = null;
		this.onmessageerror = null;
		this._listeners = { message: new Set(), error: new Set(), messageerror: new Set() };

		this._thread = new ThreadWorker( BOOTSTRAP, { eval: true, name: options.name } );
		this._thread.on( 'message', ( data ) => this._emit( 'message', { type: 'message', data } ) );
		this._thread.on( 'messageerror', ( error ) => this._emit( 'messageerror', { type: 'messageerror', error } ) );
		this._thread.on( 'error', ( error ) => this._emit( 'error', { type: 'error', error, message: error?.message ?? String( error ) } ) );

		// Anything the caller posts before the module lands is held in the thread, in order.
		const source = readModuleSource( url );
		const load = ( code ) => this._thread.postMessage( { __rayzeeModule: code, classic: options.type !== 'module' } );
		if ( typeof source === 'string' ) load( source );
		else source.then( load, ( error ) => this._emit( 'error', { type: 'error', error, message: error.message } ) );

	}

	postMessage( data, transfer ) {

		const list = Array.isArray( transfer ) ? transfer : transfer?.transfer;
		this._thread.postMessage( data, ( list ?? [] ).filter( ( item ) => item instanceof ArrayBuffer ) );

	}

	addEventListener( type, fn ) {

		this._listeners[ type ]?.add( fn );

	}

	removeEventListener( type, fn ) {

		this._listeners[ type ]?.delete( fn );

	}

	terminate() {

		this._thread.terminate();

	}

	_emit( type, event ) {

		this[ `on${type}` ]?.( event );
		for ( const fn of this._listeners[ type ] ) fn( event );

	}

}
