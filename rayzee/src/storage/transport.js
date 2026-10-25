import StorageWorker from './StorageWorker.js?worker&inline';

function toError( { name, message } ) {

	const error = new Error( message );
	error.name = name;
	return error;

}

export class WorkerTransport {

	constructor( { namespace, root = null } ) {

		this._worker = new StorageWorker();
		this._pending = new Map();
		this._nextId = 0;

		this._worker.onmessage = ( { data } ) => {

			const request = this._pending.get( data.id );
			if ( ! request ) return;
			this._pending.delete( data.id );
			if ( data.error ) request.reject( toError( data.error ) );
			else request.resolve( data.result );

		};

		this._ready = this.call( 'init', { namespace, root } );

	}

	call( op, args, transfer = [] ) {

		if ( ! this._worker ) return Promise.reject( new Error( 'storage: transport disposed' ) );

		return new Promise( ( resolve, reject ) => {

			const id = this._nextId ++;
			this._pending.set( id, { resolve, reject } );
			this._worker.postMessage( { id, op, args }, transfer );

		} );

	}

	dispose() {

		this._worker?.terminate();
		this._worker = null;
		for ( const { reject } of this._pending.values() ) reject( new Error( 'storage: transport disposed' ) );
		this._pending.clear();

	}

}

export function inWorkerContext() {

	return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope; // eslint-disable-line no-undef

}
