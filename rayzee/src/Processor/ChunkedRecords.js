/**
 * ChunkedRecords — a logically contiguous array of fixed-size records, stored as several
 * TypedArrays so it can exceed the ~2 GB cap V8 puts on a single ArrayBuffer.
 *
 * A GPU buffer may be 4 GB here while one JS array tops out near 2,040 MB, so the triangle and
 * BVH buffers hit a CPU-side wall long before the GPU one. Splitting the CPU side lifts that
 * without changing a single shader binding: the chunks are written into one GPU buffer in order.
 *
 * Chunk boundaries always fall on a record boundary, so a record never straddles two arrays.
 * Callers resolve the chunk once per record and then index its lanes directly, which keeps the
 * hot loops as fast as a flat array — one extra shift and mask per record, nothing per lane.
 *
 * One chunk is the overwhelmingly common case and is the fast path throughout: `single` returns
 * the whole array, and callers that only work on flat data can keep using it.
 */

/**
 * Below this a scene stays single-chunk. Far under the 2,040 MB V8 cap on purpose: a big
 * ArrayBuffer needs that much *contiguous* address space, so chunk size sets the usable total.
 * Placed before the allocator gave up, fresh renderer: 256 MB chunks 5,120 MB · 64 MB 7,040 MB ·
 * 32 MB 7,744 MB.
 */
export const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024;

/** Whether a worker can be handed these arrays without copying them first. */
export const SHARED_MEMORY_AVAILABLE = typeof SharedArrayBuffer !== 'undefined';

/**
 * Notified of every chunk allocated, so a build can attribute memory to the phase that spent it.
 * At most one watcher, and it must not throw — this sits on the allocation path.
 * @type {?function(number, boolean): void}
 */
let chunkObserver = null;

/** Watch chunk allocations. Pass null to stop. @param {?function(number, boolean): void} fn */
export function setChunkObserver( fn ) {

	chunkObserver = fn;

}

/** One chunk's storage, shared with workers when the page is cross-origin isolated. */
function allocChunk( LaneType, lanes, shared ) {

	const chunk = shared
		? new LaneType( new SharedArrayBuffer( lanes * LaneType.BYTES_PER_ELEMENT ) )
		: new LaneType( lanes );

	if ( chunkObserver && chunk.byteLength > 0 ) chunkObserver( chunk.byteLength, shared );
	return chunk;

}

export class ChunkedRecords {

	/**
	 * @param {number} recordCount - total records
	 * @param {number} lanesPerRecord - elements per record (20 for a triangle, 16 for a BVH node)
	 * @param {Function} LaneType - typed array constructor for one lane
	 * @param {number} [maxBytesPerChunk]
	 * @param {boolean} [shared] - back the chunks with SharedArrayBuffer so a worker can read and
	 *   write them in place. Without it a refit has to copy the whole store into shared memory,
	 *   which is a second copy of the largest thing in the scene.
	 */
	constructor( recordCount, lanesPerRecord, LaneType, maxBytesPerChunk = DEFAULT_CHUNK_BYTES, shared = false ) {

		const recordBytes = lanesPerRecord * LaneType.BYTES_PER_ELEMENT;
		const perChunk = Math.max( 1, Math.floor( maxBytesPerChunk / recordBytes ) );

		this.recordCount = recordCount;
		this.lanesPerRecord = lanesPerRecord;
		this.LaneType = LaneType;
		this.recordsPerChunk = recordCount <= perChunk ? Math.max( recordCount, 1 ) : perChunk;
		this.shared = shared;

		this.chunks = [];
		let remaining = recordCount;
		while ( remaining > 0 ) {

			const n = Math.min( remaining, this.recordsPerChunk );
			this.chunks.push( allocChunk( LaneType, n * lanesPerRecord, shared ) );
			remaining -= n;

		}

		if ( this.chunks.length === 0 ) this.chunks.push( allocChunk( LaneType, 0, shared ) );

	}

	/** Adopt already-built chunks (e.g. handed over by the extractor) without copying. */
	static adopt( chunks, recordCount, lanesPerRecord, recordsPerChunk ) {

		const c = Object.create( ChunkedRecords.prototype );
		c.recordCount = recordCount;
		c.lanesPerRecord = lanesPerRecord;
		c.LaneType = chunks[ 0 ]?.constructor ?? null;
		c.recordsPerChunk = recordsPerChunk;
		c.chunks = chunks;
		c.shared = typeof SharedArrayBuffer !== 'undefined' && chunks[ 0 ]?.buffer instanceof SharedArrayBuffer;
		return c;

	}

	/**
	 * Like the constructor, but a chunk is allocated the first time it is touched, so a fill that
	 * releases each source as it writes it never holds the whole source and destination at once.
	 */
	static lazy( recordCount, lanesPerRecord, LaneType, maxBytesPerChunk = DEFAULT_CHUNK_BYTES, shared = false ) {

		const perChunk = Math.max( 1, Math.floor( maxBytesPerChunk / ( lanesPerRecord * LaneType.BYTES_PER_ELEMENT ) ) );
		const c = Object.create( ChunkedRecords.prototype );
		c.recordCount = recordCount;
		c.lanesPerRecord = lanesPerRecord;
		c.LaneType = LaneType;
		c.recordsPerChunk = recordCount <= perChunk ? Math.max( recordCount, 1 ) : perChunk;
		c.shared = shared;
		c.chunks = new Array( Math.max( 1, Math.ceil( recordCount / c.recordsPerChunk ) ) );
		c._views = [];
		return c;

	}

	/** Allocate chunk `k`, plus the matching chunk of every view taken over this storage. @private */
	_materialize( k ) {

		if ( this._owner ) {

			this._owner._materialize( k );
			return this.chunks[ k ];

		}

		const from = k * this.recordsPerChunk;
		const lanes = Math.min( this.recordsPerChunk, this.recordCount - from ) * this.lanesPerRecord;
		const chunk = this.chunks[ k ] = allocChunk( this.LaneType, lanes, this.shared );

		for ( const v of this._views ) {

			v.chunks[ k ] = new v.LaneType( chunk.buffer, chunk.byteOffset, chunk.byteLength / v.LaneType.BYTES_PER_ELEMENT );

		}

		return chunk;

	}

	/** Allocate whatever a lazy fill never touched, so the result behaves like an eager one. */
	materializeAll() {

		for ( let k = 0; k < this.chunks.length; k ++ ) if ( ! this.chunks[ k ] ) this._materialize( k );
		return this;

	}

	get chunkCount() {

		return this.chunks.length;

	}

	/** The whole thing as one array when it fits in one, else null. */
	get single() {

		return this.chunks.length === 1 ? this.chunks[ 0 ] : null;

	}

	get byteLength() {

		let n = 0;
		for ( const c of this.chunks ) if ( c ) n += c.byteLength;
		return n;

	}

	/** The array holding `record`. */
	chunkFor( record ) {

		const k = ( record / this.recordsPerChunk ) | 0;
		return this.chunks[ k ] ?? this._materialize( k );

	}

	/** Lane offset of `record` within its own chunk. */
	baseOf( record ) {

		return ( record % this.recordsPerChunk ) * this.lanesPerRecord;

	}

	/** True when records [start, start+count) sit inside one chunk. */
	isContiguous( start, count ) {

		if ( count <= 0 ) return true;
		return ( ( start / this.recordsPerChunk ) | 0 ) === ( ( ( start + count - 1 ) / this.recordsPerChunk ) | 0 );

	}

	/**
	 * A view over records [start, start+count) when they share a chunk, otherwise a copy.
	 * Callers that only read may use it freely; callers that write must use {@link setRecords}.
	 */
	slice( start, count ) {

		const base = this.baseOf( start );
		const lanes = count * this.lanesPerRecord;

		if ( this.isContiguous( start, count ) ) return this.chunkFor( start ).subarray( base, base + lanes );

		const out = new this.LaneType( lanes );
		this.readRecords( start, count, out );
		return out;

	}

	/** Copy records [start, start+count) into `out`. */
	readRecords( start, count, out ) {

		let done = 0;
		while ( done < count ) {

			const rec = start + done;
			const chunk = this.chunkFor( rec );
			const base = this.baseOf( rec );
			const room = this.recordsPerChunk - ( rec % this.recordsPerChunk );
			const n = Math.min( room, count - done );
			out.set( chunk.subarray( base, base + n * this.lanesPerRecord ), done * this.lanesPerRecord );
			done += n;

		}

		return out;

	}

	/** Write `src` (whole records) starting at record `start`, spanning chunks as needed. */
	setRecords( start, src ) {

		const count = src.length / this.lanesPerRecord;
		let done = 0;
		while ( done < count ) {

			const rec = start + done;
			const chunk = this.chunkFor( rec );
			const base = this.baseOf( rec );
			const room = this.recordsPerChunk - ( rec % this.recordsPerChunk );
			const n = Math.min( room, count - done );
			chunk.set(
				src.subarray( done * this.lanesPerRecord, ( done + n ) * this.lanesPerRecord ),
				base
			);
			done += n;

		}

	}

	/** A fresh copy of records [start, start+count). Always a copy, so it is safe to transfer. */
	copyOf( start, count ) {

		return this.readRecords( start, count, new this.LaneType( count * this.lanesPerRecord ) );

	}

	/**
	 * The same storage narrowed to the first `recordCount` records: whole unused chunks are
	 * dropped and the last one is trimmed, so the upload writes exactly what was filled.
	 */
	trimTo( recordCount ) {

		const needed = Math.max( 1, Math.ceil( recordCount / this.recordsPerChunk ) );
		const chunks = this.chunks.slice( 0, needed );
		const lanes = ( recordCount - ( needed - 1 ) * this.recordsPerChunk ) * this.lanesPerRecord;
		const last = chunks[ needed - 1 ];
		if ( last.length > lanes ) chunks[ needed - 1 ] = last.subarray( 0, Math.max( 0, lanes ) );

		return ChunkedRecords.adopt( chunks, recordCount, this.lanesPerRecord, this.recordsPerChunk );

	}

	/** A parallel set of views of another lane type over the same memory (u32 records read as f32). */
	viewAs( LaneType ) {

		const wrap = c => new LaneType( c.buffer, c.byteOffset, c.byteLength / LaneType.BYTES_PER_ELEMENT );
		const v = ChunkedRecords.adopt(
			this.chunks.map( c => ( c ? wrap( c ) : undefined ) ),
			this.recordCount, this.lanesPerRecord, this.recordsPerChunk
		);
		v.LaneType = LaneType;

		if ( this._views ) {

			v._owner = this;
			this._views.push( v );

		}

		return v;

	}

}
