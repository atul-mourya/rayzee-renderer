import { DataTexture, FileLoader, HalfFloatType, RGBAFormat } from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import EXRWorker from './EXRWorker.js?worker&inline';
import { createWorker, hardwareThreads, hasWorkers } from '../Platform.js';

const MAX_WORKERS = 4;
const idle = [];
const queue = [];
let running = 0;

function parseHere( buffer, { type, outputFormat, part } ) {

	return new EXRLoader().setDataType( type ).setOutputFormat( outputFormat ).setPart( part ).parse( buffer );

}

function next() {

	if ( queue.length === 0 ) {

		// A burst's workers end with it: an idle worker would keep Node's process alive.
		for ( const worker of idle.splice( 0 ) ) worker.terminate();
		return;

	}

	if ( running >= Math.min( MAX_WORKERS, Math.max( 1, hardwareThreads() - 1 ) ) ) return;

	const task = queue.shift();
	let worker;
	try {

		worker = idle.pop() ?? createWorker( EXRWorker );

	} catch {

		// Nothing transferred yet: decode here instead.
		try {

			task.resolve( parseHere( task.buffer, task.options ) );

		} catch ( error ) {

			task.reject( error );

		}

		next();
		return;

	}

	running ++;
	const done = ( settle ) => {

		running --;
		settle();
		next();

	};

	worker.onmessage = ( { data } ) => {

		idle.push( worker );
		done( () => data.error ? task.reject( new Error( data.error ) ) : task.resolve( data.result ) );

	};

	worker.onerror = ( event ) => {

		event?.preventDefault?.();
		worker.terminate();
		done( () => task.reject( new Error( `EXR worker failed: ${event?.message ?? 'unknown error'}` ) ) );

	};

	const { buffer, options } = task;
	worker.postMessage( { buffer, ...options }, buffer instanceof ArrayBuffer ? [ buffer ] : [] );

}

/**
 * three's EXRLoader.parse, off the main thread where workers exist. `buffer` is transferred (detached) when it is an
 * ArrayBuffer. Resolves to what parse returns.
 * @param {ArrayBuffer} buffer
 * @param {{ type?: number, outputFormat?: number, part?: number }} [options]
 */
export function decodeEXR( buffer, { type = HalfFloatType, outputFormat = RGBAFormat, part = 0 } = {} ) {

	const options = { type, outputFormat, part };
	if ( ! hasWorkers() ) return new Promise( ( resolve ) => resolve( parseHere( buffer, options ) ) );

	return new Promise( ( resolve, reject ) => {

		queue.push( { buffer, options, resolve, reject } );
		next();

	} );

}

/** three's EXRLoader, decoding through decodeEXR. */
export class WorkerEXRLoader extends EXRLoader {

	load( url, onLoad, onProgress, onError ) {

		const texture = new DataTexture();
		const fail = ( error ) => {

			this.manager.itemError( url );
			this.manager.itemEnd( url );
			if ( onError ) onError( error );
			else console.error( error );

		};

		const loader = new FileLoader( this.manager );
		loader.setPriority( this.priority );
		loader.setCache( this.cache );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( this.requestHeader );
		loader.setPath( this.path );
		loader.setWithCredentials( this.withCredentials );
		loader.load( url, ( buffer ) => {

			this.manager.itemStart( url );
			decodeEXR( buffer, this ).then( ( texData ) => {

				this._applyTexData( texture, texData );
				if ( onLoad ) onLoad( texture, texData );
				this.manager.itemEnd( url );

			}, fail );

		}, onProgress, onError );

		return texture;

	}

}
