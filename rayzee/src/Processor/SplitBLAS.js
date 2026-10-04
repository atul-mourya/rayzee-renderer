import { TRIANGLE_DATA_LAYOUT } from './BufferLayout.js';
import { rebaseNodes } from './BVHLeafFold.js';

const FLOATS_PER_NODE = 16;
const A = TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET;
const B = TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET;
const C = TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET;

/**
 * Sorts records [start, start + count) in place into spatial pieces of at most `pieceTriangles`,
 * halving at the centroid median along the longest axis — so a mesh too large to build at once
 * becomes pieces that build one per worker and join under a few nodes ({@link joinPieces}).
 * @param {import('./ChunkedRecords.js').ChunkedRecords} records
 * @param {{pause?: function(): Promise}} [options] - awaited every million records moved or so
 * @returns {Promise<{order: Uint32Array, pieces: Array<{start: number, count: number}>, tree: Object}>}
 *   `order[ j ]` is the index, within the range, that record j held before; piece starts are
 *   relative to `start`, and `tree` is the halving as `{ left, right }` down to `{ piece }`.
 */
export async function partitionRange( records, start, count, pieceTriangles, { pause = null } = {} ) {

	const lanes = records.lanesPerRecord;
	// One array per axis, swapped in step with `order`, so every pass reads memory in sequence.
	const axes = [ new Float32Array( count ), new Float32Array( count ), new Float32Array( count ) ];
	const [ cx, cy, cz ] = axes;
	for ( let j = 0; j < count; ) {

		const chunk = records.chunkFor( start + j );
		const f = new Float32Array( chunk.buffer, chunk.byteOffset, chunk.length );
		const end = Math.min( count, ( ( ( ( start + j ) / records.recordsPerChunk ) | 0 ) + 1 ) * records.recordsPerChunk - start );
		for ( let d = records.baseOf( start + j ); j < end; j ++, d += lanes ) {

			cx[ j ] = f[ d + A ] + f[ d + B ] + f[ d + C ];
			cy[ j ] = f[ d + A + 1 ] + f[ d + B + 1 ] + f[ d + C + 1 ];
			cz[ j ] = f[ d + A + 2 ] + f[ d + B + 2 ] + f[ d + C + 2 ];

		}

	}

	const order = new Uint32Array( count );
	for ( let j = 0; j < count; j ++ ) order[ j ] = j;

	const pieces = [];
	const split = ( lo, hi ) => {

		if ( hi - lo <= pieceTriangles ) {

			pieces.push( { start: lo, count: hi - lo } );
			return { piece: pieces.length - 1 };

		}

		const mid = lo + ( ( hi - lo ) >> 1 );
		selectNth( order, axes, longestAxis( axes, lo, hi ), lo, hi, mid );
		return { left: split( lo, mid ), right: split( mid, hi ) };

	};

	const tree = split( 0, count );
	await pause?.();
	await permuteInPlace( records, start, count, order, pause );
	return { order, pieces, tree };

}

function longestAxis( axes, lo, hi ) {

	let best = 0, widest = - 1;
	for ( let a = 0; a < 3; a ++ ) {

		const c = axes[ a ];
		let min = Infinity, max = - Infinity;
		for ( let i = lo; i < hi; i ++ ) {

			const v = c[ i ];
			if ( v < min ) min = v;
			if ( v > max ) max = v;

		}

		if ( max - min > widest ) {

			widest = max - min;
			best = a;

		}

	}

	return best;

}

// Quickselect with a three-way partition, so runs of equal keys cannot make it quadratic, and
// pivots sampled with a fixed seed: the first, middle and last of a terrain grid's repeating rows
// took a thousand passes. Fixed, so the same mesh always builds the same BVH.
function selectNth( order, axes, axis, lo, hi, k ) {

	const key = axes[ axis ];
	const [ c0, c1, c2 ] = axes;
	const swap = ( i, j ) => {

		let t = order[ i ]; order[ i ] = order[ j ]; order[ j ] = t;
		t = c0[ i ]; c0[ i ] = c0[ j ]; c0[ j ] = t;
		t = c1[ i ]; c1[ i ] = c1[ j ]; c1[ j ] = t;
		t = c2[ i ]; c2[ i ] = c2[ j ]; c2[ j ] = t;

	};

	let seed = 0x9e3779b9;
	const sample = () => {

		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		return key[ lo + ( seed >>> 0 ) % ( hi - lo ) ];

	};

	while ( hi - lo > 1 ) {

		const a = sample(), b = sample(), c = sample();
		const pivot = a < b ? ( b < c ? b : a < c ? c : a ) : ( a < c ? a : b < c ? c : b );

		let lt = lo, i = lo, gt = hi;
		while ( i < gt ) {

			const v = key[ i ];
			if ( v < pivot ) swap( lt ++, i ++ );
			else if ( v > pivot ) swap( i, -- gt );
			else i ++;

		}

		if ( k < lt ) hi = lt;
		else if ( k >= gt ) lo = gt;
		else return;

	}

}

// Record j takes record order[ j ], following each cycle with one record held aside.
async function permuteInPlace( records, start, count, order, pause ) {

	const lanes = records.lanesPerRecord;
	const held = new Uint32Array( lanes );
	const done = new Uint8Array( count );
	let moved = 0;

	for ( let j = 0; j < count; j ++ ) {

		if ( done[ j ] ) continue;
		done[ j ] = 1;
		if ( order[ j ] === j ) continue;

		let chunk = records.chunkFor( start + j ), base = records.baseOf( start + j );
		for ( let l = 0; l < lanes; l ++ ) held[ l ] = chunk[ base + l ];

		for ( let k = j; ; ) {

			const s = order[ k ];
			const to = chunk, at = base;
			if ( s === j ) {

				for ( let l = 0; l < lanes; l ++ ) to[ at + l ] = held[ l ];
				break;

			}

			chunk = records.chunkFor( start + s );
			base = records.baseOf( start + s );
			for ( let l = 0; l < lanes; l ++ ) to[ at + l ] = chunk[ base + l ];
			done[ s ] = 1;
			k = s;
			if ( pause && ( ++ moved & 0xfffff ) === 0 ) await pause();

		}

	}

}

/**
 * One BLAS from the pieces of {@link partitionRange}: the halving becomes inner nodes ahead of
 * the pieces' own nodes, which are rebased in place to follow them, so children always sit after
 * their parent as a refit requires. Handed back as parts, never one array the size of the mesh:
 * a 600 MB request is what failed an 80M-triangle build with memory to spare.
 * @param {Object} tree
 * @param {Array<{start: number, count: number}>} pieces
 * @param {Array<{bvhData: Float32Array, originalToBvh: ?Uint32Array, aabb: ArrayLike<number>}>} built - per piece
 * @param {Uint32Array} order - from partitionRange
 * @returns {{bvhData: Float32Array[], nodeCount: number, originalToBvh: Uint32Array}} the join's nodes
 *   first, then each piece's; `originalToBvh` as one build of the whole range returns it
 */
export function joinPieces( tree, pieces, built, order ) {

	const inner = pieces.length - 1;
	const bases = [];
	let total = inner;
	for ( const { bvhData } of built ) {

		bases.push( total );
		total += bvhData.length / FLOATS_PER_NODE;

	}

	const data = new Float32Array( inner * FLOATS_PER_NODE );
	const idx = new Uint32Array( data.buffer );
	const parts = [ data ];
	const originalToBvh = new Uint32Array( order.length );

	for ( let k = 0; k < pieces.length; k ++ ) {

		const { bvhData, originalToBvh: pieceOrder } = built[ k ];
		built[ k ].bvhData = built[ k ].originalToBvh = null;
		const base = bases[ k ];
		const { start, count } = pieces[ k ];
		rebaseNodes( new Uint32Array( bvhData.buffer, bvhData.byteOffset, bvhData.length ), base, start );

		parts.push( bvhData );
		for ( let i = 0; i < count; i ++ ) originalToBvh[ order[ start + i ] ] = start + ( pieceOrder ? pieceOrder[ i ] : i );

	}

	let next = 0;
	const place = node => {

		if ( node.piece !== undefined ) return { index: bases[ node.piece ], box: built[ node.piece ].aabb };

		const index = next ++;
		const l = place( node.left );
		const r = place( node.right );
		const o = index * FLOATS_PER_NODE;
		data[ o ] = l.box[ 0 ]; data[ o + 1 ] = l.box[ 1 ]; data[ o + 2 ] = l.box[ 2 ]; idx[ o + 3 ] = l.index;
		data[ o + 4 ] = l.box[ 3 ]; data[ o + 5 ] = l.box[ 4 ]; data[ o + 6 ] = l.box[ 5 ]; idx[ o + 7 ] = r.index;
		data[ o + 8 ] = r.box[ 0 ]; data[ o + 9 ] = r.box[ 1 ]; data[ o + 10 ] = r.box[ 2 ];
		data[ o + 12 ] = r.box[ 3 ]; data[ o + 13 ] = r.box[ 4 ]; data[ o + 14 ] = r.box[ 5 ];

		const box = [ 0, 1, 2 ].map( a => Math.min( l.box[ a ], r.box[ a ] ) )
			.concat( [ 3, 4, 5 ].map( a => Math.max( l.box[ a ], r.box[ a ] ) ) );
		return { index, box };

	};

	place( tree );
	return { bvhData: parts, nodeCount: total, originalToBvh };

}
