import { StorageOps } from './StorageOps.js';

/** Writes on this thread through sync access handles: a worker's own storage, or tests with a fake root. */
export class InlineTransport {

	constructor( root ) {

		this._ops = new StorageOps( root );

	}

	async call( op, args ) {

		return this._ops[ op ]( args );

	}

	dispose() {

		this._ops.dispose();

	}

}
