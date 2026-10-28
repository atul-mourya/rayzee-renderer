import { StorageManager, openInlineStorage } from './StorageManager.js';
import { sharedByNamespace } from '../../storage/StorageAreas.js';
import StorageWorker from './StorageWorker.js?worker&inline';

function toError( { name, message } ) {

	const error = new Error( message );
	error.name = name;
	return error;

}

class WorkerTransport {

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
		// Nothing waits on it: a failed init, or a dispose before it answers, fails every later call instead.
		this._ready.catch( () => {} );

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

function inWorkerContext() {

	return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope; // eslint-disable-line no-undef

}

async function namespaceRoot( namespace ) {

	const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
	if ( ! storage?.getDirectory ) return { root: null, reason: 'this browser has no origin private file system' };

	try {

		const top = await storage.getDirectory();
		return { root: await top.getDirectoryHandle( namespace, { create: true } ) };

	} catch ( error ) {

		return { root: null, reason: `${error.name}: ${error.message}` };

	}

}

/**
 * Opens storage for a namespace (`cacheNamespace`). Resolves `{ storage: null, reason }` where the
 * browser offers none — private windows, old browsers, Node without a fake.
 * @param {Object} [options]
 * @param {string} options.namespace
 * @param {FileSystemDirectoryHandle} [options.root] - use this directory instead of the OPFS one
 * @param {'auto'|'inline'|'worker'} [options.transport] - 'inline' writes on this thread (needs sync handles here)
 * @returns {Promise<{storage: ?StorageManager, reason?: string}>}
 */
export async function openStorage( { namespace, root = null, transport = 'auto' } = {} ) {

	const resolved = root ? { root } : await namespaceRoot( namespace );
	if ( ! resolved.root ) return { storage: null, reason: resolved.reason };

	const inline = transport === 'inline' || ( transport === 'auto' && ( inWorkerContext() || typeof Worker === 'undefined' ) );
	if ( inline ) return { storage: openInlineStorage( { namespace, root: resolved.root } ) };

	const channel = new WorkerTransport( { namespace, root } );
	const storage = new StorageManager( { root: resolved.root, transport: channel, namespace } );
	storage.sweep().catch( () => {} );
	return { storage };

}

/**
 * One manager per namespace per page, shared by every app on it; the last `release()` disposes it.
 * @returns {Promise<{storage: ?StorageManager, reason?: string, release: function(): void}>}
 */
export async function acquireSharedStorage( namespace ) {

	let slot = sharedByNamespace.get( namespace );
	if ( ! slot ) {

		slot = { refs: 0, opened: openStorage( { namespace } ) };
		sharedByNamespace.set( namespace, slot );

	}

	slot.refs ++;
	const { storage, reason } = await slot.opened;
	slot.storage = storage;

	let released = false;
	const release = () => {

		if ( released ) return;
		released = true;
		slot.refs --;
		if ( slot.refs > 0 ) return;
		if ( sharedByNamespace.get( namespace ) === slot ) sharedByNamespace.delete( namespace );
		storage?.dispose();

	};

	if ( ! storage ) {

		release();
		return { storage: null, reason, release: () => {} };

	}

	return { storage, release };

}

