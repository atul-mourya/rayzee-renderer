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

// Groups whole ranges of `records` (u32 lanes, triangle 0 first) into clusters of at most MAX_CORNERS distinct
// corners, `flush( pending, set )` writing each.
function clusterRanges( records, { firsts, counts, leafOf }, flush ) {

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

		// A range's corners all go in one cluster: count the new ones first, a corner repeated in it once.
		let fresh = 0;
		for ( let t = first; t < first + n; t ++ ) {

			const s = t * LANES;
			for ( let k = 0; k < 3; k ++ ) {

				const c = s + k * 4;
				if ( set.find( records, c, false ) !== - 1 ) continue;
				let repeated = false;
				for ( let u = first; u <= t && ! repeated; u ++ ) {

					const o = u * LANES;
					for ( let j = 0; j < ( u === t ? k : 3 ); j ++ ) {

						const d = o + j * 4;
						if ( records[ d ] === records[ c ] && records[ d + 1 ] === records[ c + 1 ] && records[ d + 2 ] === records[ c + 2 ] && records[ d + 3 ] === records[ c + 3 ] ) {

							repeated = true;
							break;

						}

					}

				}

				if ( ! repeated ) fresh ++;

			}

		}

		if ( set.count + fresh > MAX_CORNERS ) close();

		for ( let t = first, i = 0; t < first + n; t ++, i ++ ) {

			const s = t * LANES;
			let word = 0;
			for ( let k = 0; k < 3; k ++ ) word |= set.find( records, s + k * 4, true ) << ( 8 * k );
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
 * The packed corners of `count` triangles (`records`, u32 lanes from the first; leaves relative to it), one job of a
 * build spread over workers. Without `cornerBase` only how many corners and clusters; with it each triangle's
 * [ corner base, word ] (`pairs`, two lanes a triangle) and the corners as rows from `cornerBase` on (`rows`), with
 * each leaf's base and words for its node. A leaf past NODE_WORD_LANES triangles gets NODE_NO_LANES as its base: its
 * node has no room for its words.
 * @returns {{ corners: number, clusters: number, tooBig: number, pairs?: Uint32Array, rows?: Uint32Array, leafBase?: Uint32Array, leafWords?: Uint32Array }}
 */
export function packCornerBlock( records, count, leafFirst, leafCount, cornerBase = null ) {

	const ranges = leafRanges( count, leafFirst, leafCount, NODE_WORD_LANES );
	const write = cornerBase !== null;
	const pairs = write ? new Uint32Array( count * 2 ) : null;
	const leafBase = write ? new Uint32Array( leafFirst.length ) : null;
	const leafWords = write ? new Uint32Array( leafFirst.length * NODE_WORD_LANES ) : null;
	if ( write ) for ( const l of ranges.tooBig ) leafBase[ l ] = NODE_NO_LANES;
	const blocks = [];
	let at = cornerBase ?? 0;

	const { clusters, corners } = clusterRanges( records, ranges, ( pending, set ) => {

		if ( write ) {

			for ( const p of pending ) {

				for ( let i = 0; i < p.count; i ++ ) {

					pairs[ ( p.first + i ) * 2 ] = at;
					pairs[ ( p.first + i ) * 2 + 1 ] = p.words[ i ];

				}

				if ( p.leaf >= 0 ) {

					leafBase[ p.leaf ] = at;
					leafWords.set( p.words, p.leaf * NODE_WORD_LANES );

				}

			}

			blocks.push( set.corners.slice( 0, set.count * 4 ) );

		}

		at += set.count;

	} );

	const tooBig = ranges.tooBig.length;
	if ( ! write ) return { corners, clusters, tooBig };
	const rows = new Uint32Array( corners * 4 );
	for ( let k = 0, o = 0; k < blocks.length; o += blocks[ k ].length, k ++ ) rows.set( blocks[ k ], o );
	return { corners, clusters, tooBig, pairs, rows, leafBase, leafWords };

}
