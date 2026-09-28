import { StorageManager, openInlineStorage } from './StorageManager.js';
import { WorkerTransport, inWorkerContext } from './transport.js';
import { sharedByNamespace } from './shared.js';

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

