import { ENGINE_AREAS } from './areas.js';

const WRITE_PIECE_BYTES = 32 * 1024 * 1024;
const FILE = 'chunks.bin';

/**
 * Where a spilled ChunkedRecords keeps its chunks: one scratch file, each chunk at a fixed offset.
 * It lives in the `spill` cache area and means nothing once its page is gone, so a new page clears
 * whatever no open page holds. Between writes the entry stays open, which is that hold.
 */
export class SpillStore {

	/**
	 * @param {import('./StorageManager.js').StorageManager} storage
	 * @param {string} key
	 * @param {number} chunkBytes - the byte stride of one full chunk
	 * @returns {Promise<?SpillStore>} null without storage, or with no room
	 */
	static async create( storage, key, chunkBytes, { label = '', expectedBytes = 0 } = {} ) {

		const area = storage?.area( ENGINE_AREAS.SPILL );
		const writer = await area?.create( key, { label, expectedBytes, growable: [ FILE ] } );
		return writer ? new SpillStore( area, key, chunkBytes, writer ) : null;

	}

	constructor( area, key, chunkBytes, writer ) {

		this._area = area;
		this._key = key;
		this._chunkBytes = chunkBytes;
		this._writer = writer;
		this._entry = null;
		this._file = null;

	}

	write( k, chunk ) {

		return this.writeAt( k * this._chunkBytes, chunk );

	}

	/** Writes `data` at a byte offset — for records of varying size, such as one BLAS each. */
	async writeAt( at, data ) {

		if ( ! this._writer ) {

			this._entry?.release();
			this._entry = this._file = null;
			this._writer = await this._area.edit( this._key );
			if ( ! this._writer ) throw new Error( 'spill: its storage entry is gone' );

		}

		// In pieces: an unshared buffer is copied to reach the storage worker, and one copy of a
		// big BLAS (600 MB for a 15M-triangle mesh) was the allocation that failed a 70M build.
		const bytes = new Uint8Array( data.buffer, data.byteOffset, data.byteLength );
		let off = 0;
		do {

			await this._writer.write( FILE, bytes.subarray( off, Math.min( bytes.length, off + WRITE_PIECE_BYTES ) ), { at: at + off } );
			off += WRITE_PIECE_BYTES;

		} while ( off < bytes.length );

	}

	/** Commits what was written and keeps the entry open, so no other page clears it. */
	async flush() {

		if ( this._writer ) {

			await this._writer.commit();
			this._writer = null;

		}

		if ( ! this._entry ) {

			this._entry = await this._area.open( this._key, { wait: true } );
			this._file = await this._entry?.file( FILE );
			if ( ! this._file ) throw new Error( 'spill: its storage entry is gone' );

		}

	}

	read( k, bytes ) {

		return this.readAt( k * this._chunkBytes, bytes );

	}

	async readAt( at, bytes ) {

		await this.flush();
		return await this._file.slice( at, at + bytes ).arrayBuffer();

	}

	/** Reads chunk `k` into `target` (bytes) and lets the read buffer go at once, not at the next major collection. */
	async readInto( k, target ) {

		const buffer = await this.read( k, target.byteLength );
		target.set( new Uint8Array( buffer ) );
		buffer.transfer?.( 0 );

	}

	async dispose() {

		if ( this._writer ) await this._writer.abort();
		this._writer = null;
		this._entry?.release();
		this._entry = this._file = null;
		await this._area.remove( this._key );

	}

}
