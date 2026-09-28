// Inline copies of EngineDefaults' BVH_LEAF_MARKERS.TRIANGLE_LEAF, BVH_MAX_INDEX and
// BVH_FOLDED_LEAF_MAX: this runs in the BVH workers, which cannot import it. Keep in step.
const TRIANGLE_LEAF = 0x40000000;
const BVH_MAX_INDEX = 0x40000000;
const BVH_FOLDED_LEAF_MAX = 15;
const FLOATS_PER_NODE = 16;
const FOLDED = 0x80000000;

/** A folded leaf as its parent stores it (EngineDefaults: BVH_FOLDED_LEAF_MAX). */
export const foldedRef = ( first, count ) => ( ~ ( ( first << 4 ) | count ) ) >>> 0;
export const isFoldedRef = ref => ref >= FOLDED;
export const foldedFirst = ref => ( ( ~ ref ) >>> 0 ) >>> 4;
export const foldedCount = ref => ( ~ ref ) & 15;

/**
 * Folds every small triangle leaf into its parent ({@link foldedRef}), so the leaf node
 * goes: close to half of a binary BVH's nodes, and traversal no longer fetches a node only to read a
 * triangle range. Walked from the root in pre-order, which keeps each child after its parent, as a
 * refit needs, and drops nodes nothing reaches.
 * @param {Float32Array} data - a flattened BLAS, every leaf a node
 * @returns {Float32Array}
 */
export function foldLeaves( data ) {

	const src = new Uint32Array( data.buffer, data.byteOffset, data.length );
	const nodeCount = data.length / FLOATS_PER_NODE;
	const folds = n => {

		const o = n * FLOATS_PER_NODE;
		return src[ o + 3 ] === TRIANGLE_LEAF && src[ o + 1 ] > 0 && src[ o + 1 ] <= BVH_FOLDED_LEAF_MAX;

	};

	const renumbered = new Uint32Array( nodeCount );
	const kept = new Uint32Array( nodeCount );
	let count = 0;
	const stack = [ 0 ];
	while ( stack.length ) {

		const n = stack.pop();
		renumbered[ n ] = count;
		kept[ count ++ ] = n;
		const o = n * FLOATS_PER_NODE;
		if ( src[ o + 3 ] >= BVH_MAX_INDEX ) continue;
		if ( ! folds( src[ o + 7 ] ) ) stack.push( src[ o + 7 ] );
		if ( ! folds( src[ o + 3 ] ) ) stack.push( src[ o + 3 ] );

	}

	const out = new Float32Array( count * FLOATS_PER_NODE );
	const idx = new Uint32Array( out.buffer );
	for ( let k = 0; k < count; k ++ ) {

		const from = kept[ k ] * FLOATS_PER_NODE;
		const o = k * FLOATS_PER_NODE;
		out.set( data.subarray( from, from + FLOATS_PER_NODE ), o );
		if ( src[ from + 3 ] >= BVH_MAX_INDEX ) continue;

		idx[ o + 3 ] = childRef( src, src[ from + 3 ], folds, renumbered );
		idx[ o + 7 ] = childRef( src, src[ from + 7 ], folds, renumbered );

	}

	return out;

}

function childRef( src, child, folds, renumbered ) {

	const o = child * FLOATS_PER_NODE;
	return folds( child ) ? foldedRef( src[ o ], src[ o + 1 ] ) : renumbered[ child ];

}

const rebaseRef = ( ref, nodeOffset, triOffset ) => ( ref >= FOLDED
	? foldedRef( foldedFirst( ref ) + triOffset, foldedCount( ref ) )
	: ref + nodeOffset );

/**
 * Moves one BLAS's references: node indices by `nodeOffset`, triangle offsets (a leaf node's,
 * or a folded leaf's in its parent) by `triOffset`.
 * @param {Uint32Array} idx - u32 view of the nodes
 */
export function rebaseNodes( idx, nodeOffset, triOffset, from = 0, to = idx.length ) {

	for ( let o = from; o < to; o += FLOATS_PER_NODE ) {

		if ( idx[ o + 3 ] === TRIANGLE_LEAF ) {

			idx[ o ] += triOffset;
			continue;

		}

		idx[ o + 3 ] = rebaseRef( idx[ o + 3 ], nodeOffset, triOffset );
		idx[ o + 7 ] = rebaseRef( idx[ o + 7 ], nodeOffset, triOffset );

	}

}
