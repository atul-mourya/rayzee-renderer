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

/** Below this a scene stays single-chunk. Leaves headroom under the measured 2,040 MB V8 cap. */
export const DEFAULT_CHUNK_BYTES = 1_536 * 1024 * 1024;

export class ChunkedRecords {

	/**
	 * @param {number} recordCount - total records
	 * @param {number} lanesPerRecord - elements per record (20 for a triangle, 16 for a BVH node)
	 * @param {Function} LaneType - typed array constructor for one lane
	 * @param {number} [maxBytesPerChunk]
	 */
	constructor( recordCount, lanesPerRecord, LaneType, maxBytesPerChunk = DEFAULT_CHUNK_BYTES ) {

		const recordBytes = lanesPerRecord * LaneType.BYTES_PER_ELEMENT;
		const perChunk = Math.max( 1, Math.floor( maxBytesPerChunk / recordBytes ) );

		this.recordCount = recordCount;
		this.lanesPerRecord = lanesPerRecord;
		this.LaneType = LaneType;
		this.recordsPerChunk = recordCount <= perChunk ? Math.max( recordCount, 1 ) : perChunk;

		this.chunks = [];
		let remaining = recordCount;
		while ( remaining > 0 ) {

			const n = Math.min( remaining, this.recordsPerChunk );
			this.chunks.push( new LaneType( n * lanesPerRecord ) );
			remaining -= n;

		}

		if ( this.chunks.length === 0 ) this.chunks.push( new LaneType( 0 ) );

	}

	/** Adopt already-built chunks (e.g. handed over by the extractor) without copying. */
	static adopt( chunks, recordCount, lanesPerRecord, recordsPerChunk ) {

		const c = Object.create( ChunkedRecords.prototype );
		c.recordCount = recordCount;
		c.lanesPerRecord = lanesPerRecord;
		c.LaneType = chunks[ 0 ].constructor;
		c.recordsPerChunk = recordsPerChunk;
		c.chunks = chunks;
		return c;

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
		for ( const c of this.chunks ) n += c.byteLength;
		return n;

	}

	/** The array holding `record`. */
	chunkFor( record ) {

		return this.chunks[ ( record / this.recordsPerChunk ) | 0 ];

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

		return ChunkedRecords.adopt(
			this.chunks.map( c => new LaneType( c.buffer, c.byteOffset, c.byteLength / LaneType.BYTES_PER_ELEMENT ) ),
			this.recordCount, this.lanesPerRecord, this.recordsPerChunk
		);

	}

}
