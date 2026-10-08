import { SpillStore } from './SpillStore.js';

const PACK_BYTES = 32 * 1024 * 1024;
const OWN_WRITE_BYTES = PACK_BYTES / 4;
const READ_WINDOW = 64 * 1024 * 1024;
const EMPTY = new Map();

function empty( Type ) {

	let array = EMPTY.get( Type );
	if ( ! array ) EMPTY.set( Type, array = new Type( 0 ) );
	return array;

}

/**
 * Holds three.js geometry on disk while a build has no use for it, and puts it back afterwards.
 * Small arrays are packed into shared writes; each comes back in a buffer of its own. An array
 * whose write fails stays in memory and is restored from there.
 */
export class GeometrySpill {

	/** @returns {Promise<?GeometrySpill>} null without storage, or with no room */
	static async create( storage, key, expectedBytes = 0 ) {

		const store = await SpillStore.create( storage, key, 0, { label: 'Scene geometry (while building)', expectedBytes } );
		return store ? new GeometrySpill( store ) : null;

	}

	/** Whether every attribute is a plain BufferAttribute, the only kind whose array can be swapped. */
	static canTake( geometry ) {

		if ( Object.keys( geometry.morphAttributes ?? {} ).length ) return false;
		for ( const name in geometry.attributes ) if ( ! geometry.attributes[ name ].isBufferAttribute ) return false;
		return ! geometry.index || geometry.index.isBufferAttribute === true;

	}

	constructor( store ) {

		this._store = store;
		this._records = [];
		this._geometries = [];
		this._end = 0;
		this._pack = null;
		this._packAt = 0;
		this._packUsed = 0;
		this._packRecords = [];
		this._chain = Promise.resolve();
		this._queued = 0;
		this.bytes = 0;
		this.error = null;

	}

	/** Bytes handed over and not yet on disk. */
	get queuedBytes() {

		return this._queued;

	}

	/** Moves a geometry's arrays to disk, leaving empty arrays of the same type in their place; its bounds stay. */
	add( geometry ) {

		if ( ! geometry.boundingBox ) geometry.computeBoundingBox();
		if ( ! geometry.boundingSphere ) geometry.computeBoundingSphere();

		const byArray = new Map();
		const attributes = Object.values( geometry.attributes );
		if ( geometry.index ) attributes.push( geometry.index );

		for ( const attribute of attributes ) {

			const array = attribute.array;
			if ( ! array?.byteLength ) continue;
			let record = byArray.get( array );
			if ( ! record ) byArray.set( array, record = this._write( array ) );
			record.attributes.push( attribute );
			attribute.array = empty( array.constructor );

		}

		// What the bounds were with the arrays in place: anything computed from the empty ones must not outlive the restore.
		this._geometries.push( { geometry, box: geometry.boundingBox.clone(), sphere: geometry.boundingSphere.clone() } );

	}

	/** @private */
	_write( array ) {

		const bytes = new Uint8Array( array.buffer, array.byteOffset, array.byteLength );
		const record = { at: 0, byteLength: bytes.byteLength, Type: array.constructor, attributes: [], array: null, pack: null, offset: 0 };
		this._records.push( record );
		this.bytes += bytes.byteLength;

		if ( bytes.byteLength >= OWN_WRITE_BYTES ) {

			record.at = this._end;
			record.array = array;
			this._end += bytes.byteLength;
			this._queue( record.at, bytes, [ record ] );
			return record;

		}

		if ( this._pack && this._packUsed + bytes.byteLength > PACK_BYTES ) this._flushPack();
		if ( ! this._pack ) {

			this._pack = new Uint8Array( PACK_BYTES );
			this._packAt = this._end;
			this._packUsed = 0;
			this._end += PACK_BYTES;

		}

		this._pack.set( bytes, this._packUsed );
		record.at = this._packAt + this._packUsed;
		record.pack = this._pack;
		record.offset = this._packUsed;
		this._packUsed += bytes.byteLength;
		this._packRecords.push( record );
		return record;

	}

	/** @private */
	_flushPack() {

		if ( ! this._pack ) return;
		this._queue( this._packAt, this._pack.subarray( 0, this._packUsed ), this._packRecords );
		this._pack = null;
		this._packRecords = [];

	}

	/** @private */
	_queue( at, bytes, records ) {

		this._queued += bytes.byteLength;
		this._chain = this._chain
			.then( async () => {

				if ( this.error ) return;
				await this._store.writeAt( at, bytes );
				for ( const record of records ) record.array = record.pack = null;

			} )
			.catch( error => void ( this.error ??= error ) )
			.finally( () => void ( this._queued -= bytes.byteLength ) );

	}

	/** Resolves once everything handed over so far is written (or has failed to be). */
	written() {

		this._flushPack();
		return this._chain;

	}

	/** Puts every array back where it was taken from, reading the file in large windows. */
	async restore() {

		await this.written();
		const records = this._records.sort( ( a, b ) => a.at - b.at );
		if ( records.some( r => ! r.array && ! r.pack ) ) await this._store.flush();

		let window = null;
		let windowAt = 0;
		for ( const record of records ) {

			let array;
			if ( record.array ) array = record.array;
			else if ( record.pack ) array = new record.Type( record.pack.slice( record.offset, record.offset + record.byteLength ).buffer );
			else if ( record.byteLength > READ_WINDOW ) array = new record.Type( await this._store.readAt( record.at, record.byteLength ) );
			else {

				if ( ! window || record.at + record.byteLength > windowAt + window.byteLength ) {

					windowAt = record.at;
					window = await this._store.readAt( record.at, READ_WINDOW );

				}

				array = new record.Type( window.slice( record.at - windowAt, record.at - windowAt + record.byteLength ) );

			}

			if ( array.byteLength !== record.byteLength ) throw new Error( 'geometry spill: an array came back short' );
			for ( const attribute of record.attributes ) attribute.array = array;

		}

		for ( const { geometry, box, sphere } of this._geometries ) {

			geometry.boundingBox = box;
			geometry.boundingSphere = sphere;

		}

		this._records = [];
		this._geometries = [];
		this.bytes = 0;

	}

	async dispose() {

		await this._chain;
		this._records = [];
		this._geometries = [];
		this._pack = null;
		this._packRecords = [];
		await this._store.dispose();

	}

}
