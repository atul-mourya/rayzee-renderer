/**
 * How deep BVHTraversal's stack must be for a tree: a push past the end drops the nearer child, and its geometry.
 */

import { BVH_LEAF_MARKERS, BVH_MAX_INDEX, CLUSTER_COUNT_SHIFT, CLUSTER_ROOT_MASK } from '../scene/BufferLayout.js';

/** The smallest stack built: scenes within it keep the kernels they had. */
export const MIN_TRAVERSAL_STACK = 40;
/** The largest; a deeper tree overflows as before. */
export const MAX_TRAVERSAL_STACK = 128;
// A tree with chunks on disk cannot be walked when it is uploaded.
const SPILLED_TRAVERSAL_STACK = 64;

const { BLAS_POINTER_LEAF, CLUSTER_LEAF } = BVH_LEAF_MARKERS;
const FOLDED = 0x80000000;

/**
 * The deepest the stack gets in any ray's walk of the tree, counted as BVHTraversal pushes (inner: both children;
 * pointer leaf: the object's root; cluster of k: all k). Children follow their parents, so one sweep from the end.
 * @param {Float32Array|Uint32Array|import('../memory/ChunkedRecords.js').ChunkedRecords} nodes - 16 lanes a node
 * @param {{folded?: boolean}} [options] - folded leaves (`foldedLeaves` on the records)
 * @returns {number}
 */
export function traversalStackNeed( nodes, { folded = nodes.foldedLeaves === true } = {} ) {

	const chunks = nodes.chunks ?? [ nodes ];
	// A chunk a lazy fill never touched is zeros: nothing points into it.
	const views = chunks.map( c => ( ! c || c instanceof Uint32Array ? c : new Uint32Array( c.buffer, c.byteOffset, c.length ) ) );
	const count = nodes.recordCount ?? chunks[ 0 ].length / 16;
	const perChunk = nodes.recordsPerChunk ?? count;
	const need = new Uint8Array( count );
	const childNeed = c => ( folded && c >= FOLDED ? 0 : need[ c ] );

	for ( let k = views.length - 1; k >= 0; k -- ) {

		const u = views[ k ];
		if ( ! u ) continue;
		for ( let i = Math.min( perChunk, count - k * perChunk ) - 1; i >= 0; i -- ) {

			const o = i * 16, tag = u[ o + 3 ];
			let n;
			if ( folded ? tag >>> 30 === 1 : tag >= BVH_MAX_INDEX ) {

				if ( tag === BLAS_POINTER_LEAF ) n = Math.max( 1, need[ u[ o ] ] );
				else if ( tag === CLUSTER_LEAF ) {

					const copies = ( ( u[ o ] >>> CLUSTER_COUNT_SHIFT ) & 3 ) + 1;
					let deepest = 1;
					for ( let c = 0; c < copies; c ++ ) deepest = Math.max( deepest, need[ u[ o + 12 + c ] & CLUSTER_ROOT_MASK ] );
					n = Math.max( copies, copies - 1 + deepest );

				} else n = 0;

			} else n = Math.max( 2, 1 + childNeed( tag ), 1 + childNeed( u[ o + 7 ] ) );

			need[ k * perChunk + i ] = Math.min( n, 255 );

		}

	}

	return Math.max( 1, need[ 0 ] );

}

/**
 * The stack BVHTraversal is built with for a tree: its need rounded up to a multiple of 8 (fewer kernel variants),
 * within [{@link MIN_TRAVERSAL_STACK}, {@link MAX_TRAVERSAL_STACK}]; 64 for a tree with chunks on disk.
 * @param {Float32Array|import('../memory/ChunkedRecords.js').ChunkedRecords} nodes
 * @returns {number}
 */
export function traversalStackSize( nodes ) {

	if ( ! nodes ) return MIN_TRAVERSAL_STACK;
	if ( nodes.isResident && ! nodes.isResident() ) return SPILLED_TRAVERSAL_STACK;
	const need = traversalStackNeed( nodes );
	return Math.min( MAX_TRAVERSAL_STACK, Math.max( MIN_TRAVERSAL_STACK, Math.ceil( need / 8 ) * 8 ) );

}
