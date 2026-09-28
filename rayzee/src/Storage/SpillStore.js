import { ENGINE_AREAS } from './StorageManager.js';

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

		await this._writer.write( FILE, data, { at } );

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

	async dispose() {

		if ( this._writer ) await this._writer.abort();
		this._writer = null;
		this._entry?.release();
		this._entry = this._file = null;
		await this._area.remove( this._key );

	}

}
