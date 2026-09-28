import { StorageOps } from './StorageOps.js';

let ops = null;

async function rootFor( namespace, root ) {

	if ( root ) return root;
	const top = await navigator.storage.getDirectory();
	return top.getDirectoryHandle( namespace, { create: true } );

}

self.onmessage = async ( { data } ) => {

	const { id, op, args } = data;

	try {

		if ( op === 'init' ) {

			ops = new StorageOps( rootFor( args.namespace, args.root ) );
			postMessage( { id, result: {} } );
			return;

		}

		const result = await ops[ op ]( args );
		const transfer = result?.buffer instanceof ArrayBuffer ? [ result.buffer ] : [];
		postMessage( { id, result }, transfer );

	} catch ( error ) {

		postMessage( { id, error: { name: error.name, message: error.message } } );

	}

};
