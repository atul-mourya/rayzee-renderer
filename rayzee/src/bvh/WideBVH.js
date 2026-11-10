/**
 * An object's tree 4-wide, from its binary BVH (PathTracerStage.buildWideBVH: the top level stays binary). A wide node:
 *   0           child count
 *   1, 2, 4–11  the children's boxes, quantised as a copy cluster's are (encodeClusterBoxes)
 *   3           WIDE_NODE
 *   12 + k      child k: a node index (a wide node or a kept leaf), or a triangle leaf folded as ~( first << 4 | count )
 * A triangle leaf that cannot fold (more than BVH_FOLDED_LEAF_MAX triangles) is copied whole. Built in steps, so a
 * caller can read the binary tree from disk and send the wide one to the GPU a page at a time.
 */

import { BVH_LEAF_MARKERS, BVH_FOLDED_LEAF_MAX, BVH_FOLDED_FIRST_LIMIT, BVH_EMPTY_BOX, WIDE_NODE, encodeClusterBoxes } from '../scene/BufferLayout.js';

const WIDTH = 4;
const PAGE_NODES = 1 << 18;
const FOLDED = 0, LEAF = 1, INNER = 2;

/**
 * Wide nodes from index `base` on, in pages of 16 MB (`pageNodes`). With a `sink`, flush() sends each full page as
 * sink( firstNode, floats ) and lets it go; a node finished after its page went (an ancestor still open then) goes
 * alone. Without one, every page stays, for at().
 */
export class WideWriter {

	constructor( base = 0, sink = null, pageNodes = PAGE_NODES ) {

		this.base = base;
		this.sink = sink;
		this.pageNodes = pageNodes;
		this.pages = [];
		this.count = 0;
		this.sent = 0;
		this.late = new Float32Array( 16 );
		this.late.u = new Uint32Array( this.late.buffer );

	}

	alloc() {

		if ( this.count === this.pages.length * this.pageNodes ) this.pages.push( new Float32Array( this.pageNodes * 16 ) );
		return this.base + this.count ++;

	}

	/** The f32 and u32 views and lane offset of node n. */
	at( n ) {

		const p = Math.floor( ( n - this.base ) / this.pageNodes );
		if ( p < this.sent ) return { f: this.late, u: this.late.u, o: 0 };
		const page = this.pages[ p ];
		page.u ??= new Uint32Array( page.buffer );
		return { f: page, u: page.u, o: ( ( n - this.base ) % this.pageNodes ) * 16 };

	}

	/** Node n is written. */
	done( n ) {

		if ( Math.floor( ( n - this.base ) / this.pageNodes ) < this.sent ) this.sink( n, this.late );

	}

	get flushDue() {

		return this.sink !== null && Math.floor( this.count / this.pageNodes ) > this.sent;

	}

	/** Sends every full page, or with `all` every page. */
	flush( all = false ) {

		const upTo = all ? this.pages.length : Math.floor( this.count / this.pageNodes );
		for ( ; this.sent < upTo; this.sent ++ ) {

			const nodes = Math.min( this.pageNodes, this.count - this.sent * this.pageNodes );
			this.sink( this.base + this.sent * this.pageNodes, this.pages[ this.sent ].subarray( 0, nodes * 16 ) );
			this.pages[ this.sent ] = null;

		}

	}

}

const area = ( b, k ) => {

	const dx = b[ k + 3 ] - b[ k ], dy = b[ k + 4 ] - b[ k + 1 ], dz = b[ k + 5 ] - b[ k + 2 ];
	return dx * dy + dy * dz + dz * dx;

};

/**
 * Collapses the binary subtree at `root` into `out`, in steps. `src.at( n )` gives binary node n's lane offset in
 * `src.f` / `src.u`, or −1 when it is not loaded: the step yields { need: n }, and the caller loads it before the next.
 * One expansion reads up to seven nodes, so the source keeps at least the last eight it loaded.
 * A step yields { flush: true } when `out` has full pages. Returns root's wide index — an object root never folds, so a
 * placement or copy can name it — and the stack the walk of it needs, counted as BVHTraversal pushes (a wide node: all
 * its hit children; bvh/TraversalStack.js counts the binary tree the same way).
 * @param {Object} options
 * @param {function(number, Object): void} [options.onLeafCopy] - a triangle leaf node copied whole, binary index and
 *   { f, u, o } of its copy
 */
export function* collapseSteps( src, root, out, { onLeafCopy = null } = {} ) {

	let missing = - 1;
	const kindOf = ( ref ) => {

		if ( ref >= 0x80000000 ) return FOLDED;
		const o = src.at( ref );
		if ( o < 0 ) {

			missing = ref;
			return - 1;

		}

		return ( src.u[ o + 3 ] >>> 30 ) === 1 ? LEAF : INNER;

	};

	// Inner node n opened to up to four children, the largest inner child first; null when a node it needs is not loaded.
	const expand = ( n ) => {

		const refs = [], kinds = [], box = [];
		const open = ( m ) => {

			const o = src.at( m );
			if ( o < 0 ) {

				missing = m;
				return false;

			}

			const f = src.f, u = src.u;
			const l = u[ o + 3 ], r = u[ o + 7 ];
			box.push( f[ o ], f[ o + 1 ], f[ o + 2 ], f[ o + 4 ], f[ o + 5 ], f[ o + 6 ], f[ o + 8 ], f[ o + 9 ], f[ o + 10 ], f[ o + 12 ], f[ o + 13 ], f[ o + 14 ] );
			const kl = kindOf( l ), kr = kindOf( r );
			if ( kl < 0 || kr < 0 ) return false;
			refs.push( l, r );
			kinds.push( kl, kr );
			return true;

		};

		if ( ! open( n ) ) return null;
		for ( ;; ) {

			let best = - 1, bestArea = - 1;
			if ( refs.length < WIDTH ) for ( let k = 0; k < refs.length; k ++ ) {

				if ( kinds[ k ] !== INNER ) continue;
				const a = area( box, k * 6 );
				if ( a > bestArea ) {

					best = k;
					bestArea = a;

				}

			}

			if ( best < 0 ) break;
			const m = refs[ best ];
			refs.splice( best, 1 );
			kinds.splice( best, 1 );
			box.splice( best * 6, 6 );
			if ( ! open( m ) ) return null;

		}

		// A child no ray reaches (a hidden member's far box) would stretch the quantisation range to it.
		const frame = { at: out.alloc(), refs: [], kinds: [], box: new Float64Array( WIDTH * 6 ), next: 0, wide: [], need: 0 };
		for ( let k = 0; k < refs.length; k ++ ) {

			if ( ! ( box[ k * 6 ] < BVH_EMPTY_BOX * 0.5 ) ) continue;
			frame.box.set( box.slice( k * 6, k * 6 + 6 ), frame.refs.length * 6 );
			frame.refs.push( refs[ k ] );
			frame.kinds.push( kinds[ k ] );

		}

		return frame;

	};

	// Triangle leaf n as a reference: folded when it fits (never an object root), else copied whole; −1 when not loaded.
	const leafRef = ( n, fold ) => {

		const o = src.at( n );
		if ( o < 0 ) {

			missing = n;
			return - 1;

		}

		const f = src.f, u = src.u;
		const tag = u[ o + 3 ];
		if ( fold && tag === BVH_LEAF_MARKERS.TRIANGLE_LEAF && u[ o + 1 ] <= BVH_FOLDED_LEAF_MAX && u[ o ] + u[ o + 1 ] <= BVH_FOLDED_FIRST_LIMIT ) {

			return ( ~ ( ( u[ o ] << 4 ) | u[ o + 1 ] ) ) >>> 0;

		}

		if ( tag !== BVH_LEAF_MARKERS.TRIANGLE_LEAF ) throw new Error( `WideBVH: leaf tag ${tag.toString( 16 )} in an object's tree` );
		const at = out.alloc();
		const w = out.at( at );
		w.f.set( f.subarray( o, o + 16 ), w.o );
		onLeafCopy?.( n, w );

		out.done( at );
		return at;

	};

	const rootKind = kindOf( root );
	if ( rootKind < 0 ) {

		yield { need: missing };
		return yield* collapseSteps( src, root, out, { onLeafCopy } );

	}

	if ( rootKind === LEAF ) {

		let ref;
		while ( ( ref = leafRef( root, false ) ) < 0 ) yield { need: missing };
		return { root: ref, stack: 0 };

	}

	let first;
	while ( ! ( first = expand( root ) ) ) yield { need: missing };
	const stack = [ first ];
	for ( ;; ) {

		const top = stack[ stack.length - 1 ];
		if ( top.next < top.refs.length ) {

			const k = top.next;
			const ref = top.refs[ k ], kind = top.kinds[ k ];
			if ( kind === FOLDED ) top.wide[ k ] = ref;
			else if ( kind === LEAF ) {

				let w;
				while ( ( w = leafRef( ref, true ) ) < 0 ) yield { need: missing };
				top.wide[ k ] = w;

			} else {

				let frame;
				while ( ! ( frame = expand( ref ) ) ) yield { need: missing };
				stack.push( frame );
				continue;

			}

			top.next ++;
			continue;

		}

		const w = out.at( top.at );
		const count = top.refs.length;
		encodeClusterBoxes( w.f, w.u, w.o, top.box, count, null, 0 );
		w.u[ w.o ] = count;
		w.u[ w.o + 3 ] = WIDE_NODE;
		for ( let k = 0; k < WIDTH; k ++ ) w.u[ w.o + 12 + k ] = k < count ? top.wide[ k ] : 0;
		out.done( top.at );
		stack.pop();
		if ( out.flushDue ) yield { flush: true };
		// All its children pushed, then the nearest's walk on top of the rest.
		const need = Math.max( count, count - 1 + top.need );
		if ( ! stack.length ) return { root: top.at, stack: need };
		const parent = stack[ stack.length - 1 ];
		parent.need = Math.max( parent.need, need );
		parent.wide[ parent.next ++ ] = top.at;

	}

}

/** {@link collapseSteps} over a source whose every node is loaded, into a writer with no sink. */
export function collapse( src, root, out, options ) {

	const steps = collapseSteps( src, root, out, options );
	let step;
	while ( ! ( step = steps.next() ).done ) if ( step.value.need !== undefined ) throw new Error( `WideBVH: node ${step.value.need} is not loaded` );
	return step.value;

}
