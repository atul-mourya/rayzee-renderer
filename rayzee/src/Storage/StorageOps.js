/**
 * The write side of storage, run where sync access handles exist: inside StorageWorker, or
 * inline when the caller is itself a worker (or a test with a fake root).
 */
export class StorageOps {

	constructor( root ) {

		this._root = root;
		this._writers = new Map();
		this._nextId = 1;

	}

	async _dir( path, create ) {

		let dir = await this._root;
		for ( const part of path ) dir = await dir.getDirectoryHandle( part, { create } );
		return dir;

	}

	async openWriter( { path, name, truncate = true, length } ) {

		const dir = await this._dir( path, true );
		const handle = await ( await dir.getFileHandle( name, { create: true } ) ).createSyncAccessHandle();
		if ( truncate ) handle.truncate( 0 );
		else if ( length !== undefined && handle.getSize() > length ) handle.truncate( length );
		const id = this._nextId ++;
		this._writers.set( id, { handle, end: handle.getSize() } );
		return { id };

	}

	write( { id, buffer, byteOffset = 0, byteLength, at } ) {

		const writer = this._writers.get( id );
		if ( ! writer ) throw new Error( `storage: writer ${id} is not open` );

		const view = new Uint8Array( buffer, byteOffset, byteLength ?? buffer.byteLength - byteOffset );
		const position = at ?? writer.end;
		let written = 0;
		while ( written < view.length ) {

			const n = writer.handle.write( view.subarray( written ), { at: position + written } );
			if ( n <= 0 ) throw new Error( 'storage: write made no progress' );
			written += n;

		}

		writer.end = Math.max( writer.end, position + view.length );
		return { bytes: view.length };

	}

	closeWriter( { id, abort = false } ) {

		const writer = this._writers.get( id );
		if ( ! writer ) return { size: 0 };
		this._writers.delete( id );

		try {

			if ( ! abort ) writer.handle.flush();
			return { size: writer.handle.getSize() };

		} finally {

			writer.handle.close();

		}

	}

	async writeFile( { path, name, buffer, byteOffset = 0, byteLength } ) {

		const { id } = await this.openWriter( { path, name } );
		try {

			this.write( { id, buffer, byteOffset, byteLength } );
			return this.closeWriter( { id } );

		} catch ( error ) {

			this.closeWriter( { id, abort: true } );
			throw error;

		}

	}

	async readRange( { path, name, offset = 0, length } ) {

		const fileHandle = await ( await this._dir( path, false ) ).getFileHandle( name );

		let handle = null;
		try {

			handle = await fileHandle.createSyncAccessHandle();

		} catch ( error ) {

			if ( error.name !== 'NoModificationAllowedError' ) throw error;

		}

		if ( ! handle ) {

			const file = await fileHandle.getFile();
			const end = length === undefined ? file.size : offset + length;
			return { buffer: await file.slice( offset, end ).arrayBuffer() };

		}

		try {

			const size = handle.getSize();
			const n = Math.max( 0, Math.min( length ?? size - offset, size - offset ) );
			const buffer = new ArrayBuffer( n );
			handle.read( buffer, { at: offset } );
			return { buffer };

		} finally {

			handle.close();

		}

	}

	dispose() {

		for ( const id of [ ...this._writers.keys() ] ) this.closeWriter( { id, abort: true } );

	}

}
