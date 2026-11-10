/**
 * Triangle corners packed in clusters: the corner rows of the triangle records (rows 0–2, a position and its packed
 * normal each, TRIANGLE_DATA_LAYOUT) with each distinct corner of a cluster kept once, a triangle naming its three by
 * 8-bit numbers. A cluster is whole BVH leaves of at most 256 distinct corners. One uvec4 buffer: each triangle's
 * [ corner base, word ], two a row, then the clusters' corners. A leaf node of at most NODE_WORD_LANES triangles also
 * keeps its cluster's corner base in slot [2] and its words in lanes 4–15, so traversal reads no pair first.
 * `triangleGeoRows` (shaders/Common.js) reads them back bit for bit.
 */

import { TRIANGLE_DATA_LAYOUT } from './BufferLayout.js';

const LEAF_SLOT_BITS = 5;
export const NODE_WORD_LANES = 12;

const MAX_CORNERS = 256;
const TABLE_SIZE = 1024;
const LANES = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

// The distinct corners of one cluster, found by their four lanes.
class CornerSet {

	constructor() {

		this.table = new Int32Array( TABLE_SIZE );
		this.corners = new Uint32Array( MAX_CORNERS * 4 );
		this.clear();

	}

	clear() {

		this.table.fill( - 1 );
		this.count = 0;

	}

	// The corner's number, or −1 when it is new and `add` is false (−2 when new and the set is full).
	find( src, s, add ) {

		const x = src[ s ], y = src[ s + 1 ], z = src[ s + 2 ], w = src[ s + 3 ];
		let h = ( Math.imul( x, 0x9E3779B1 ) ^ Math.imul( y, 0x85EBCA77 ) ^ Math.imul( z, 0xC2B2AE3D ) ^ Math.imul( w, 0x27D4EB2F ) ) >>> 22;
		const corners = this.corners;

		while ( this.table[ h ] !== - 1 ) {

			const j = this.table[ h ] * 4;
			if ( corners[ j ] === x && corners[ j + 1 ] === y && corners[ j + 2 ] === z && corners[ j + 3 ] === w ) return this.table[ h ];
			h = ( h + 1 ) & ( TABLE_SIZE - 1 );

		}

		if ( ! add ) return - 1;
		if ( this.count === MAX_CORNERS ) return - 2;
		const index = this.count ++;
		this.table[ h ] = index;
		corners.set( [ x, y, z, w ], index * 4 );
		return index;

	}

}

// Triangle records as one array or ChunkedRecords, read as u32 lanes (a curve's NaN marker compares by its bits): the
// array holding triangle t and its first lane there.
function source( records ) {

	const views = new Map();
	const u32 = ( a ) => {

		if ( a instanceof Uint32Array ) return a;
		let v = views.get( a );
		if ( ! v ) views.set( a, v = new Uint32Array( a.buffer, a.byteOffset, a.length ) );
		return v;

	};

	return records.chunkFor
		? { at: ( t ) => u32( records.chunkFor( t ) ), base: ( t ) => records.baseOf( t ) }
		: { at: () => u32( records ), base: ( t ) => t * LANES };

}

// Every triangle in exactly one range, in order: the leaves, and the gaps between them in pieces of 8 (−1 for no leaf).
function leafRanges( count, leafFirst, leafCount, maxLeaf ) {

	const firsts = [];
	const counts = [];
	const leafOf = [];
	const tooBig = [];
	let next = 0;
	const gap = ( to ) => {

		for ( ; next < to; next += 8 ) {

			firsts.push( next );
			counts.push( Math.min( 8, to - next ) );
			leafOf.push( - 1 );

		}

	};

	for ( let l = 0; l < leafFirst.length; l ++ ) {

		if ( leafFirst[ l ] < next ) throw new Error( 'clustered corners: leaves out of order' );
		gap( leafFirst[ l ] );
		if ( leafCount[ l ] > maxLeaf ) {

			// A leaf past what its node's lanes hold reads its triangles through the per-triangle table.
			tooBig.push( l );
			for ( let s = 0; s < leafCount[ l ]; s += 1 << LEAF_SLOT_BITS ) {

				firsts.push( leafFirst[ l ] + s );
				counts.push( Math.min( 1 << LEAF_SLOT_BITS, leafCount[ l ] - s ) );
				leafOf.push( - 1 );

			}

		} else {

			firsts.push( leafFirst[ l ] );
			counts.push( leafCount[ l ] );
			leafOf.push( l );

		}

		next = leafFirst[ l ] + leafCount[ l ];

	}

	gap( count );
	return { firsts, counts, leafOf, tooBig };

}

// Groups whole ranges into clusters of at most MAX_CORNERS distinct corners, `flush( pending, set )` writing each. It
// yields after each flush, so a caller can let an upload drain, and yields { need } when `records` is a window
// (`windowed`) that does not hold the next range, for the caller to load it.
function* clusterSteps( records, { firsts, counts, leafOf }, flush ) {

	const src = records.windowed ? records : source( records );
	const set = new CornerSet();
	const words = new Uint32Array( 1 << LEAF_SLOT_BITS );
	let pending = [];
	let clusters = 0;
	let total = 0;

	const close = () => {

		if ( ! pending.length ) return;
		flush( pending, set );
		total += set.count;
		clusters ++;
		set.clear();
		pending = [];

	};

	for ( let r = 0; r < firsts.length; r ++ ) {

		const first = firsts[ r ], n = counts[ r ];
		if ( src.windowed && ! src.has( first, n ) ) yield { need: first };

		// A range's corners all go in one cluster: count the new ones first, a corner repeated in it once.
		let fresh = 0;
		for ( let t = first; t < first + n; t ++ ) {

			const array = src.at( t ), s = src.base( t );
			for ( let k = 0; k < 3; k ++ ) {

				const c = s + k * 4;
				if ( set.find( array, c, false ) !== - 1 ) continue;
				let repeated = false;
				for ( let u = first; u <= t && ! repeated; u ++ ) {

					const other = src.at( u ), o = src.base( u );
					for ( let j = 0; j < ( u === t ? k : 3 ); j ++ ) {

						const d = o + j * 4;
						if ( other[ d ] === array[ c ] && other[ d + 1 ] === array[ c + 1 ] && other[ d + 2 ] === array[ c + 2 ] && other[ d + 3 ] === array[ c + 3 ] ) {

							repeated = true;
							break;

						}

					}

				}

				if ( ! repeated ) fresh ++;

			}

		}

		if ( set.count + fresh > MAX_CORNERS ) {

			close();
			yield;

		}

		for ( let t = first, i = 0; t < first + n; t ++, i ++ ) {

			const array = src.at( t ), s = src.base( t );
			let word = 0;
			for ( let k = 0; k < 3; k ++ ) word |= set.find( array, s + k * 4, true ) << ( 8 * k );
			words[ i ] = word >>> 0;

		}

		pending.push( { first, count: n, leaf: leafOf[ r ], words: words.slice( 0, n ) } );

	}

	close();
	return { clusters, corners: total };

}

/** Leaf slot [2] of a leaf whose triangles read through the per-triangle table. */
export const NODE_NO_LANES = 0xFFFFFFFF;

/**
 * The packed corners without holding them whole: `sink( row, data )` takes it in order, a region at a time (the
 * per-triangle table, then the corners), `chunkRows` rows a call; a promise it returns is waited on before the next
 * cluster. Without a sink it only counts the rows. `records` may be a window over records kept elsewhere: `{ windowed:
 * true, at( t ), base( t ), has( first, n ), load( first ) }`, loaded on demand. A leaf past
 * NODE_WORD_LANES triangles gets NODE_NO_LANES as its base: its node has no room for its words.
 * @returns {{ rows: number, clusters: number, corners: number, leafBase: ?Uint32Array, leafWords: ?Uint32Array, tooBig: number }}
 */
export async function packCorners( records, count, leafFirst, leafCount, sink = null, chunkRows = 1 << 20 ) {

	const ranges = leafRanges( count, leafFirst, leafCount, NODE_WORD_LANES );
	const pairRows = Math.ceil( count / 2 );
	// Runs the steps, loading the window a range needs and waiting on what the sink returned.
	let waiting = null;
	const run = async ( steps ) => {

		let step;
		while ( ! ( step = steps.next() ).done ) {

			if ( step.value?.need !== undefined ) await records.load( step.value.need );
			if ( waiting ) await waiting;
			waiting = null;

		}

		return step.value;

	};

	if ( ! sink ) {

		const { clusters, corners } = await run( clusterSteps( records, ranges, () => {} ) );
		return { rows: pairRows + corners, clusters, corners, leafBase: null, leafWords: null, tooBig: ranges.tooBig.length };

	}

	const leafBase = new Uint32Array( leafFirst.length );
	const leafWords = new Uint32Array( leafFirst.length * NODE_WORD_LANES );
	for ( const l of ranges.tooBig ) leafBase[ l ] = NODE_NO_LANES;

	// Two append-only regions, each staged `chunkRows` rows at a time.
	const region = ( start ) => {

		const stage = new Uint32Array( chunkRows * 4 );
		let base = start, filled = 0;
		const flush = () => {

			if ( filled ) sink( base, stage.subarray( 0, filled * 4 ) );
			base += filled;
			filled = 0;

		};

		return {
			flush,
			// Lane `lane` of row `row`, rows only ever moving forward.
			put( row, lane, value ) {

				while ( row - base >= chunkRows ) {

					filled = chunkRows;
					flush();
					stage.fill( 0 );

				}

				stage[ ( row - base ) * 4 + lane ] = value;
				filled = Math.max( filled, row - base + 1 );

			},
			append( data ) {

				for ( let at = 0; at < data.length; ) {

					const n = Math.min( data.length - at, ( chunkRows - filled ) * 4 );
					stage.set( data.subarray( at, at + n ), filled * 4 );
					filled += n / 4;
					at += n;
					if ( filled === chunkRows ) flush();

				}

			},
		};

	};

	const pairs = region( 0 );
	const corners = region( pairRows );
	let cornerAt = pairRows;

	// A sink may return a promise (an upload draining): the next cluster waits for it.
	const put = sink;
	sink = ( row, data ) => {

		waiting = put( row, data ) ?? waiting;

	};

	const steps = clusterSteps( records, ranges, ( pending, set ) => {

		for ( const p of pending ) {

			for ( let i = 0; i < p.count; i ++ ) {

				const t = p.first + i;
				pairs.put( t >> 1, ( t & 1 ) * 2, cornerAt );
				pairs.put( t >> 1, ( t & 1 ) * 2 + 1, p.words[ i ] );

			}

			if ( p.leaf >= 0 ) {

				leafBase[ p.leaf ] = cornerAt;
				leafWords.set( p.words, p.leaf * NODE_WORD_LANES );

			}

		}

		corners.append( set.corners.subarray( 0, set.count * 4 ) );
		cornerAt += set.count;

	} );

	const { clusters, corners: total } = await run( steps );
	pairs.flush();
	corners.flush();
	if ( waiting ) await waiting;
	return { rows: pairRows + total, clusters, corners: total, leafBase, leafWords, tooBig: ranges.tooBig.length };

}
