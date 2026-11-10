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

	/** at( n ) into one object, overwritten by the next call. */
	cursor( n ) {

		const c = this._cursor ??= { f: null, u: null, o: 0 };
		const p = Math.floor( ( n - this.base ) / this.pageNodes );
		if ( p < this.sent ) {

			c.f = this.late;
			c.u = this.late.u;
			c.o = 0;
			return c;

		}

		const page = this.pages[ p ];
		page.u ??= new Uint32Array( page.buffer );
		c.f = page;
		c.u = page.u;
		c.o = ( ( n - this.base ) % this.pageNodes ) * 16;
		return c;

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

	// One expansion's children, up to WIDTH and one more while the largest inner one opens; and one frame a depth, reused.
	// Allocated a node, their collection was most of the time in workers.
	const sRefs = new Uint32Array( WIDTH + 2 ), sKinds = new Uint8Array( WIDTH + 2 ), sBox = new Float64Array( ( WIDTH + 2 ) * 6 );
	let sCount = 0;
	const frames = [];
	const frameAt = ( d ) => frames[ d ] ??= { at: 0, count: 0, next: 0, need: 0, refs: new Uint32Array( WIDTH ), kinds: new Uint8Array( WIDTH ), box: new Float64Array( WIDTH * 6 ), wide: new Uint32Array( WIDTH ) };

	const open = ( m ) => {

		const o = src.at( m );
		if ( o < 0 ) {

			missing = m;
			return false;

		}

		const f = src.f, u = src.u;
		const l = u[ o + 3 ], r = u[ o + 7 ];
		const b = sCount * 6;
		sBox[ b ] = f[ o ]; sBox[ b + 1 ] = f[ o + 1 ]; sBox[ b + 2 ] = f[ o + 2 ];
		sBox[ b + 3 ] = f[ o + 4 ]; sBox[ b + 4 ] = f[ o + 5 ]; sBox[ b + 5 ] = f[ o + 6 ];
		sBox[ b + 6 ] = f[ o + 8 ]; sBox[ b + 7 ] = f[ o + 9 ]; sBox[ b + 8 ] = f[ o + 10 ];
		sBox[ b + 9 ] = f[ o + 12 ]; sBox[ b + 10 ] = f[ o + 13 ]; sBox[ b + 11 ] = f[ o + 14 ];
		const kl = kindOf( l ), kr = kindOf( r );
		if ( kl < 0 || kr < 0 ) return false;
		sRefs[ sCount ] = l;
		sKinds[ sCount ] = kl;
		sRefs[ sCount + 1 ] = r;
		sKinds[ sCount + 1 ] = kr;
		sCount += 2;
		return true;

	};

	// Inner node n opened to up to four children, the largest inner child first, into the frame for `depth`; null when a
	// node it needs is not loaded.
	const expand = ( n, depth ) => {

		sCount = 0;
		if ( ! open( n ) ) return null;
		for ( ;; ) {

			let best = - 1, bestArea = - 1;
			if ( sCount < WIDTH ) for ( let k = 0; k < sCount; k ++ ) {

				if ( sKinds[ k ] !== INNER ) continue;
				const a = area( sBox, k * 6 );
				if ( a > bestArea ) {

					best = k;
					bestArea = a;

				}

			}

			if ( best < 0 ) break;
			const m = sRefs[ best ];
			for ( let k = best; k < sCount - 1; k ++ ) {

				sRefs[ k ] = sRefs[ k + 1 ];
				sKinds[ k ] = sKinds[ k + 1 ];
				for ( let a = 0; a < 6; a ++ ) sBox[ k * 6 + a ] = sBox[ k * 6 + 6 + a ];

			}

			sCount --;
			if ( ! open( m ) ) return null;

		}

		// A child no ray reaches (a hidden member's far box) would stretch the quantisation range to it.
		const frame = frameAt( depth );
		frame.at = out.alloc();
		frame.count = frame.next = frame.need = 0;
		for ( let k = 0; k < sCount; k ++ ) {

			if ( ! ( sBox[ k * 6 ] < BVH_EMPTY_BOX * 0.5 ) ) continue;
			const c = frame.count ++;
			for ( let a = 0; a < 6; a ++ ) frame.box[ c * 6 + a ] = sBox[ k * 6 + a ];
			frame.refs[ c ] = sRefs[ k ];
			frame.kinds[ c ] = sKinds[ k ];

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
		const w = out.cursor( at );
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
	while ( ! ( first = expand( root, 0 ) ) ) yield { need: missing };
	const stack = [ first ];
	for ( ;; ) {

		const top = stack[ stack.length - 1 ];
		if ( top.next < top.count ) {

			const k = top.next;
			const ref = top.refs[ k ], kind = top.kinds[ k ];
			if ( kind === FOLDED ) top.wide[ k ] = ref;
			else if ( kind === LEAF ) {

				let w;
				while ( ( w = leafRef( ref, true ) ) < 0 ) yield { need: missing };
				top.wide[ k ] = w;

			} else {

				let frame;
				while ( ! ( frame = expand( ref, stack.length ) ) ) yield { need: missing };
				stack.push( frame );
				continue;

			}

			top.next ++;
			continue;

		}

		const w = out.cursor( top.at );
		const count = top.count;
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

/**
 * The 4-wide trees of `roots` (binary roots, ascending; every node they reach in `src`), one job of a build spread over
 * workers. Without `wideBase` each one's node count and stack need; with it their nodes, written from `wideBase` on in
 * order, as one array, and each one's wide root.
 * @returns {{ counts?: Uint32Array, stacks?: Uint32Array, nodes?: Float32Array, roots?: Uint32Array }}
 */
export function collapseObjects( src, roots, { wideBase = null, onLeafCopy = null } = {} ) {

	const counting = wideBase === null;
	// Counting sends each full page nowhere; writing keeps them for the one array.
	const out = new WideWriter( wideBase ?? 0, counting ? () => {} : null );
	const counts = new Uint32Array( roots.length ), stacks = new Uint32Array( roots.length ), wide = new Uint32Array( roots.length );
	for ( let i = 0; i < roots.length; i ++ ) {

		const before = out.count;
		const steps = collapseSteps( src, roots[ i ], out, { onLeafCopy } );
		let step;
		while ( ! ( step = steps.next() ).done ) {

			if ( step.value.need !== undefined ) throw new Error( `WideBVH: node ${step.value.need} is not in the job` );
			if ( counting ) out.flush();

		}

		wide[ i ] = step.value.root;
		stacks[ i ] = step.value.stack;
		counts[ i ] = out.count - before;

	}

	if ( counting ) return { counts, stacks };
	const nodes = new Float32Array( out.count * 16 );
	out.pages.forEach( ( page, k ) => nodes.set( page.subarray( 0, Math.min( out.pageNodes, out.count - k * out.pageNodes ) * 16 ), k * out.pageNodes * 16 ) );
	return { nodes, roots: wide };

}

/** {@link collapseSteps} over a source whose every node is loaded, into a writer with no sink. */
export function collapse( src, root, out, options ) {

	const steps = collapseSteps( src, root, out, options );
	let step;
	while ( ! ( step = steps.next() ).done ) if ( step.value.need !== undefined ) throw new Error( `WideBVH: node ${step.value.need} is not loaded` );
	return step.value;

}
