
/**
 * BVHRefitter — Fast O(N) bottom-up BVH AABB refit for animated geometry.
 *
 * When mesh topology stays the same but vertex positions change (skeletal animation,
 * morph targets), this avoids the full O(N log N) SAH rebuild by recomputing only
 * the bounding boxes in the existing tree structure.
 *
 * Designed to run in both main thread and Web Worker contexts.
 */

import { isFoldedRef, foldedFirst, foldedCount } from './BVHLeafFold.js';
import {
	TRIANGLE_DATA_LAYOUT, packNormalOct, BVH_LEAF_MARKERS, BVH_EMPTY_BOX,
	CLUSTER_FIRST_MASK, CLUSTER_COUNT_SHIFT, CLUSTER_ROOT_MASK, CLUSTER_SIZE, RECORD_VEC4, TLAS_LEAF_IDENTITY, encodeClusterBoxes,
} from './BufferLayout.js';

const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

// The record buffer is uint; positions are f32 in it. Views share the memory, no copy.
const floatView = ( data ) => data instanceof Float32Array
	? data : new Float32Array( data.buffer, data.byteOffset, data.length );
const uintView = ( data ) => data instanceof Uint32Array
	? data : new Uint32Array( data.buffer, data.byteOffset, data.length );

// Triangles arrive either as one flat record array or, past the ~2 GB array cap, as a
// ChunkedRecords. Both are handled by resolving the chunk once per triangle; the flat case
// keeps a constant chunk and plain `index * FPT` arithmetic.
// BVH nodes get the same treatment: one flat Float32Array, or a ChunkedRecords past the cap.
const nodeAccess = ( bvhData ) => {

	const chunked = bvhData && bvhData.chunks ? bvhData : null;
	return {
		chunked,
		f: chunked ? bvhData : bvhData,
		idx: chunked ? bvhData.viewAs( Uint32Array ) : uintView( bvhData ),
	};

};

// Resolve one node: returns nothing, callers use nodeF/nodeIdx/nodeBase below.
const nodeF = ( acc, n ) => ( acc.chunked ? acc.f.chunkFor( n ) : acc.f );
const nodeIdx = ( acc, n ) => ( acc.chunked ? acc.idx.chunkFor( n ) : acc.idx );
const nodeBase = ( acc, n ) => ( acc.chunked ? acc.chunked.baseOf( n ) : n * FLOATS_PER_NODE );

const triAccess = ( triangleData ) => {

	const chunked = triangleData && triangleData.chunks ? triangleData : null;
	return {
		chunked,
		f: chunked ? chunked.viewAs( Float32Array ) : floatView( triangleData ),
		u: chunked ? triangleData : uintView( triangleData ),
	};

};

const FLOATS_PER_NODE = 16; // 4 vec4s per BVH node
const LEAF_MARKER = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
const BLAS_POINTER_MARKER = BVH_LEAF_MARKERS.BLAS_POINTER_LEAF;
const CLUSTER_MARKER = BVH_LEAF_MARKERS.CLUSTER_LEAF;

// Relative to the matrix's own magnitude, never an absolute floor — see transformBoundsToWorld.
const SINGULAR_REL_EPS = 1e-12;

/**
 * Object-space bounds at `srcOff` through the instance transform stored on TLAS leaf `nodeOff`,
 * written to `dstOff`. Inlined rather than imported: this file also runs inside a worker.
 */
function transformBoundsToWorld( bvhData, nodeOff, src, srcOff, dst, dstOff ) {

	if ( src[ srcOff ] > src[ srcOff + 3 ] ) {

		for ( let i = 0; i < 6; i ++ ) dst[ dstOff + i ] = src[ srcOff + i ];
		return;

	}

	const a0 = bvhData[ nodeOff + 4 ], a1 = bvhData[ nodeOff + 5 ], a2 = bvhData[ nodeOff + 6 ], tx = bvhData[ nodeOff + 7 ];
	const a3 = bvhData[ nodeOff + 8 ], a4 = bvhData[ nodeOff + 9 ], a5 = bvhData[ nodeOff + 10 ], ty = bvhData[ nodeOff + 11 ];
	const a6 = bvhData[ nodeOff + 12 ], a7 = bvhData[ nodeOff + 13 ], a8 = bvhData[ nodeOff + 14 ], tz = bvhData[ nodeOff + 15 ];

	// Inverse of the 3x3 whose rows are (a0..a2), (a3..a5), (a6..a8).
	const c0x = a4 * a8 - a5 * a7, c0y = a5 * a6 - a3 * a8, c0z = a3 * a7 - a4 * a6;
	const det = a0 * c0x + a1 * c0y + a2 * c0z;

	const identity = a0 === 1 && a4 === 1 && a8 === 1
		&& a1 === 0 && a2 === 0 && a3 === 0 && a5 === 0 && a6 === 0 && a7 === 0
		&& tx === 0 && ty === 0 && tz === 0;

	// Moana's ocean is a unit quad scaled to ±1,089,735, so its world-to-object determinant is
	// 7.7e-19 — an absolute floor called that singular and copied the unit quad's bounds straight
	// through as world bounds, collapsing the root AABB on every refit.
	const magnitude = ( Math.abs( a0 ) + Math.abs( a1 ) + Math.abs( a2 ) )
		* ( Math.abs( a3 ) + Math.abs( a4 ) + Math.abs( a5 ) )
		* ( Math.abs( a6 ) + Math.abs( a7 ) + Math.abs( a8 ) );

	if ( identity || ! Number.isFinite( det ) || Math.abs( det ) <= SINGULAR_REL_EPS * magnitude ) {

		for ( let i = 0; i < 6; i ++ ) dst[ dstOff + i ] = src[ srcOff + i ];
		return;

	}

	const inv = 1 / det;
	// Columns of the inverse: cross(r1,r2), cross(r2,r0), cross(r0,r1).
	const k0x = c0x * inv, k0y = c0y * inv, k0z = c0z * inv;
	const k1x = ( a2 * a7 - a1 * a8 ) * inv, k1y = ( a0 * a8 - a2 * a6 ) * inv, k1z = ( a1 * a6 - a0 * a7 ) * inv;
	const k2x = ( a1 * a5 - a2 * a4 ) * inv, k2y = ( a2 * a3 - a0 * a5 ) * inv, k2z = ( a0 * a4 - a1 * a3 ) * inv;

	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

	for ( let c = 0; c < 8; c ++ ) {

		const px = ( c & 1 ? src[ srcOff + 3 ] : src[ srcOff ] ) - tx;
		const py = ( c & 2 ? src[ srcOff + 4 ] : src[ srcOff + 1 ] ) - ty;
		const pz = ( c & 4 ? src[ srcOff + 5 ] : src[ srcOff + 2 ] ) - tz;

		const wx = k0x * px + k1x * py + k2x * pz;
		const wy = k0y * px + k1y * py + k2y * pz;
		const wz = k0z * px + k1z * py + k2z * pz;

		if ( wx < minX ) minX = wx; if ( wx > maxX ) maxX = wx;
		if ( wy < minY ) minY = wy; if ( wy > maxY ) maxY = wy;
		if ( wz < minZ ) minZ = wz; if ( wz > maxZ ) maxZ = wz;

	}

	dst[ dstOff ] = minX; dst[ dstOff + 1 ] = minY; dst[ dstOff + 2 ] = minZ;
	dst[ dstOff + 3 ] = maxX; dst[ dstOff + 4 ] = maxY; dst[ dstOff + 5 ] = maxZ;

}


/** Bounds of triangles [first, first + count) into out[ off .. off + 6 ). */
function triangleBounds( acc, first, count, out, off ) {

	const A = TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET;
	const B = TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET;
	const C = TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET;
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

	for ( let t = 0; t < count; t ++ ) {

		const gi = first + t;
		const f = acc.chunked ? acc.f.chunkFor( gi ) : acc.f;
		const o = acc.chunked ? acc.chunked.baseOf( gi ) : gi * FPT;
		minX = Math.min( minX, f[ o + A ], f[ o + B ], f[ o + C ] );
		minY = Math.min( minY, f[ o + A + 1 ], f[ o + B + 1 ], f[ o + C + 1 ] );
		minZ = Math.min( minZ, f[ o + A + 2 ], f[ o + B + 2 ], f[ o + C + 2 ] );
		maxX = Math.max( maxX, f[ o + A ], f[ o + B ], f[ o + C ] );
		maxY = Math.max( maxY, f[ o + A + 1 ], f[ o + B + 1 ], f[ o + C + 1 ] );
		maxZ = Math.max( maxZ, f[ o + A + 2 ], f[ o + B + 2 ], f[ o + C + 2 ] );

	}

	out[ off ] = minX; out[ off + 1 ] = minY; out[ off + 2 ] = minZ;
	out[ off + 3 ] = maxX; out[ off + 4 ] = maxY; out[ off + 5 ] = maxZ;

}

const folded = new Float32Array( 12 );

// Empty bounds (a hidden group member, an empty leaf) are min > max while computed — neutral in a union — and stored
// as the far point box no ray enters, read back as empty.
const isEmptyStored = ( f, o ) => f[ o ] >= BVH_EMPTY_BOX * 0.5;

/** A child's computed box into its slot at `o`: as it is, or the far point box when empty. */
function writeChildSlot( f, o, src, s ) {

	const empty = src[ s ] > src[ s + 3 ];
	f[ o ] = empty ? BVH_EMPTY_BOX : src[ s ]; f[ o + 1 ] = empty ? BVH_EMPTY_BOX : src[ s + 1 ]; f[ o + 2 ] = empty ? BVH_EMPTY_BOX : src[ s + 2 ];
	f[ o + 4 ] = empty ? BVH_EMPTY_BOX : src[ s + 3 ]; f[ o + 5 ] = empty ? BVH_EMPTY_BOX : src[ s + 4 ]; f[ o + 6 ] = empty ? BVH_EMPTY_BOX : src[ s + 5 ];

}

/** A node's own box from what it stores — its two child boxes, or a leaf's triangles — into out[ 0 .. 6 ). */
function storedBounds( nodes, n, acc, out ) {

	const f = nodeF( nodes, n );
	const idx = nodeIdx( nodes, n );
	const o = nodeBase( nodes, n );

	if ( idx[ o + 3 ] === LEAF_MARKER ) {

		triangleBounds( acc, idx[ o ], idx[ o + 1 ], out, 0 );
		return;

	}

	const left = ! isEmptyStored( f, o ), right = ! isEmptyStored( f, o + 8 );
	for ( let a = 0; a < 3; a ++ ) {

		out[ a ] = Math.min( left ? f[ o + a ] : Infinity, right ? f[ o + 8 + a ] : Infinity );
		out[ 3 + a ] = Math.max( left ? f[ o + 4 + a ] : - Infinity, right ? f[ o + 12 + a ] : - Infinity );

	}

}

const recordRows = new Float32Array( 16 );
const rootBox = new Float32Array( 6 );
const copyBoxes = new Float32Array( CLUSTER_SIZE * 6 );

/**
 * A cluster leaf's boxes from its copies now: each copy's root's stored box carried to world through its record
 * (behind the BLASes from node `recordNodeStart`), encoded into the leaf; the union into `out` at `outOff`.
 */
function refitClusterLeaf( nodes, i, acc, recordNodeStart, out, outOff ) {

	const f = nodeF( nodes, i ), idx = nodeIdx( nodes, i ), o = nodeBase( nodes, i );
	const first = idx[ o ] & CLUSTER_FIRST_MASK;
	const count = ( ( idx[ o ] >>> CLUSTER_COUNT_SHIFT ) & 3 ) + 1;

	for ( let k = 0; k < count; k ++ ) {

		const word = idx[ o + 12 + k ];
		storedBounds( nodes, word & CLUSTER_ROOT_MASK, acc, rootBox );
		if ( word & TLAS_LEAF_IDENTITY ) {

			for ( let a = 0; a < 6; a ++ ) copyBoxes[ k * 6 + a ] = rootBox[ a ];
			continue;

		}

		// A record's 12 floats may straddle a node, and so a chunk.
		const lane = recordNodeStart * 16 + ( first + k ) * RECORD_VEC4 * 4;
		for ( let l = 0; l < 12; l ++ ) {

			const n = ( lane + l ) >> 4;
			recordRows[ 4 + l ] = nodeF( nodes, n )[ nodeBase( nodes, n ) + ( ( lane + l ) & 15 ) ];

		}

		transformBoundsToWorld( recordRows, 0, rootBox, 0, copyBoxes, k * 6 );

	}

	encodeClusterBoxes( f, idx, o, copyBoxes, count, out, outOff );

}

/**
 * One node of a bottom-up refit: its own bounds into `bounds[ ( i - base ) * 6 ]`, and an inner
 * node's two child boxes rewritten from theirs. A leaf folded into its parent takes its box from
 * its triangles.
 */
function refitNode( nodes, i, acc, bounds, base, recordNodeStart = - 1 ) {

	const bvhF = nodeF( nodes, i );
	const idx = nodeIdx( nodes, i );
	const o = nodeBase( nodes, i );
	const b = ( i - base ) * 6;
	const marker = idx[ o + 3 ];

	if ( marker === LEAF_MARKER ) {

		triangleBounds( acc, idx[ o ], idx[ o + 1 ], bounds, b );
		return;

	}

	if ( marker === CLUSTER_MARKER ) {

		refitClusterLeaf( nodes, i, acc, recordNodeStart, bounds, b );
		return;

	}

	if ( marker === BLAS_POINTER_MARKER ) {

		// BLAS-pointer leaf (TLAS): the BLAS root's bounds are in the instance's own
		// space, and the TLAS sorts on world bounds — so carry the box out through the
		// leaf's transform. Slots 4..15 are the rows of world-to-object; the eight
		// corners go back the other way through its inverse.
		transformBoundsToWorld( bvhF, o, bounds, ( idx[ o ] - base ) * 6, bounds, b );
		return;

	}

	const right = idx[ o + 7 ];
	let ls = bounds, lb = ( marker - base ) * 6;
	if ( isFoldedRef( marker ) ) {

		triangleBounds( acc, foldedFirst( marker ), foldedCount( marker ), folded, 0 );
		ls = folded; lb = 0;

	}

	let rs = bounds, rb = ( right - base ) * 6;
	if ( isFoldedRef( right ) ) {

		triangleBounds( acc, foldedFirst( right ), foldedCount( right ), folded, 6 );
		rs = folded; rb = 6;

	}

	writeChildSlot( bvhF, o, ls, lb );
	writeChildSlot( bvhF, o + 8, rs, rb );

	for ( let a = 0; a < 3; a ++ ) {

		bounds[ b + a ] = Math.min( ls[ lb + a ], rs[ rb + a ] );
		bounds[ b + 3 + a ] = Math.max( ls[ lb + 3 + a ], rs[ rb + 3 + a ] );

	}

}

export class BVHRefitter {

	constructor() {

		// Reusable bounds buffer — cached across refit calls to avoid allocation per frame.
		// Resized only when nodeCount changes (i.e., new scene loaded).
		this._bounds = null;
		this._boundsNodeCount = 0;
		this._tlasBounds = null;
		this._rootBox = null;

	}

	/**
	 * Update triangle positions in the BVH-reordered triangle array.
	 * Iterates in BVH order (sequential writes, random reads) for cache efficiency.
	 *
	 * @param {Uint32Array} triangleData - BVH-reordered triangle records (mutated in place)
	 * @param {Float32Array} newPositions - 9 floats per triangle in ORIGINAL mesh order
	 * @param {Uint32Array} bvhToOriginal - Map from BVH-order index to original tri index
	 */
	updateTrianglePositions( triangleData, newPositions, bvhToOriginal ) {

		const triCount = bvhToOriginal.length;
		const acc = triAccess( triangleData );

		for ( let bvhIdx = 0; bvhIdx < triCount; bvhIdx ++ ) {

			const orig = bvhToOriginal[ bvhIdx ];
			// sequential writes
			const f = acc.chunked ? acc.f.chunkFor( bvhIdx ) : acc.f;
			const u = acc.chunked ? acc.u.chunkFor( bvhIdx ) : acc.u;
			const dstOff = acc.chunked ? acc.chunked.baseOf( bvhIdx ) : bvhIdx * FPT;
			const srcOff = orig * 9;

			const ax = newPositions[ srcOff ];
			const ay = newPositions[ srcOff + 1 ];
			const az = newPositions[ srcOff + 2 ];
			const bx = newPositions[ srcOff + 3 ];
			const by = newPositions[ srcOff + 4 ];
			const bz = newPositions[ srcOff + 5 ];
			const cx = newPositions[ srcOff + 6 ];
			const cy = newPositions[ srcOff + 7 ];
			const cz = newPositions[ srcOff + 8 ];

			f[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET ] = ax;
			f[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ] = ay;
			f[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ] = az;

			f[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET ] = bx;
			f[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ] = by;
			f[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ] = bz;

			f[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET ] = cx;
			f[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ] = cy;
			f[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ] = cz;

			// Face normal from the cross product; packNormalOct normalizes it.
			const abx = bx - ax, aby = by - ay, abz = bz - az;
			const acx = cx - ax, acy = cy - ay, acz = cz - az;
			const packed = packNormalOct(
				aby * acz - abz * acy,
				abz * acx - abx * acz,
				abx * acy - aby * acx
			);

			u[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_A_PACKED_OFFSET ] = packed;
			u[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_B_PACKED_OFFSET ] = packed;
			u[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_C_PACKED_OFFSET ] = packed;

		}

	}

	/**
	 * Refit a BLAS sub-range within the combined BVH buffer.
	 * Same algorithm as refit() but scoped to nodes [startNode, startNode + count).
	 *
	 * @param {Float32Array} bvhData - Combined BVH array (TLAS + all BLASes)
	 * @param {Uint32Array} triangleData - Global triangle records
	 * @param {number} startNode - First node index of this BLAS in bvhData
	 * @param {number} nodeCount - Number of nodes in this BLAS
	 */
	refitRange( bvhData, triangleData, startNode, nodeCount ) {

		const acc = triAccess( triangleData );

		// Grow-only bounds buffer to avoid reallocation on mixed-size BLASes
		if ( nodeCount > this._boundsNodeCount ) {

			this._bounds = new Float32Array( nodeCount * 6 );
			this._boundsNodeCount = nodeCount;

		}

		const nodes = nodeAccess( bvhData );
		// Bounds indexed relative to the BLAS start; child indices are absolute.
		for ( let i = startNode + nodeCount - 1; i >= startNode; i -- ) refitNode( nodes, i, acc, this._bounds, startNode );

	}

	/**
	 * Refit the given BLAS node ranges, then the TLAS from every BLAS root's stored box. The same
	 * nodes as refit() when every other BLAS is as the last refit left it.
	 *
	 * @param {Float32Array} bvhData - Combined BVH array (TLAS + all BLASes)
	 * @param {Uint32Array} triangleData - Global triangle records
	 * @param {ArrayLike<number>} blasRanges - flat [ startNode, nodeCount, ... ]
	 * @param {number} tlasNodeCount - the TLAS occupies nodes [0, tlasNodeCount)
	 */
	refitPartial( bvhData, triangleData, blasRanges, tlasNodeCount, groupRange = null, recordNodeStart = - 1 ) {

		for ( let r = 0; r < blasRanges.length; r += 2 ) this.refitRange( bvhData, triangleData, blasRanges[ r ], blasRanges[ r + 1 ] );

		const acc = triAccess( triangleData );
		const nodes = nodeAccess( bvhData );
		if ( groupRange ) this.refitGroups( nodes, acc, groupRange[ 0 ], groupRange[ 1 ] );
		if ( ! this._tlasBounds || this._tlasBounds.length < tlasNodeCount * 6 ) this._tlasBounds = new Float32Array( tlasNodeCount * 6 );
		const bounds = this._tlasBounds;

		for ( let i = tlasNodeCount - 1; i >= 0; i -- ) {

			const idx = nodeIdx( nodes, i );
			const o = nodeBase( nodes, i );

			if ( idx[ o + 3 ] === BLAS_POINTER_MARKER ) {

				storedBounds( nodes, idx[ o ], acc, rootBox );
				transformBoundsToWorld( nodeF( nodes, i ), o, rootBox, 0, bounds, i * 6 );

			} else {

				refitNode( nodes, i, acc, bounds, 0, recordNodeStart );

			}

		}

	}

	/**
	 * Group trees between the TLAS and the BLASes: each inner node's child boxes from what its children store, last
	 * node first, so a child group node is current before its parent reads it. The empty leaf is left alone.
	 * @private
	 */
	refitGroups( nodes, acc, start, count ) {

		const box = this._groupBox ||= new Float32Array( 6 );
		for ( let i = start + count - 1; i >= start; i -- ) {

			const f = nodeF( nodes, i );
			const idx = nodeIdx( nodes, i );
			const o = nodeBase( nodes, i );
			if ( idx[ o + 3 ] === LEAF_MARKER ) continue;

			storedBounds( nodes, idx[ o + 3 ], acc, box );
			writeChildSlot( f, o, box, 0 );
			storedBounds( nodes, idx[ o + 7 ], acc, box );
			writeChildSlot( f, o + 8, box, 0 );

		}

	}

	/**
	 * Bottom-up refit of all BVH node AABBs.
	 * Reverse pre-order iteration gives valid bottom-up order (children have higher
	 * indices than parents in pre-order, so reversing processes children first).
	 *
	 * @param {Float32Array} bvhData - Flat BVH array (mutated in place)
	 * @param {Uint32Array} triangleData - Updated triangle records
	 * @param {number} nodeCount - Total number of BVH nodes
	 */
	refit( bvhData, triangleData, nodeCount, recordNodeStart = - 1 ) {

		const acc = triAccess( triangleData );

		// Reuse bounds buffer across frames (reallocate only on scene change)
		if ( nodeCount !== this._boundsNodeCount ) {

			this._bounds = new Float32Array( nodeCount * 6 );
			this._boundsNodeCount = nodeCount;

		}

		const nodes = nodeAccess( bvhData );
		for ( let i = nodeCount - 1; i >= 0; i -- ) refitNode( nodes, i, acc, this._bounds, 0, recordNodeStart );

	}

}
