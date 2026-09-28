
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

// Inline copy of layout constants (source of truth: EngineDefaults.js).
// Cannot import because this runs inside Web Workers where window is not defined.
const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 20,
	POSITION_A_OFFSET: 0,
	POSITION_B_OFFSET: 4,
	POSITION_C_OFFSET: 8,
	NORMAL_A_PACKED_OFFSET: 3,
	NORMAL_B_PACKED_OFFSET: 7,
	NORMAL_C_PACKED_OFFSET: 11,
};

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

// Octahedral snorm16 pair, matching packNormalOct in EngineDefaults (not importable here).
function packNormalOct( x, y, z ) {

	const len = Math.sqrt( x * x + y * y + z * z );
	if ( len > 0 ) {

		x /= len; y /= len; z /= len;

	} else {

		x = 0; y = 0; z = 1;

	}

	const sum = Math.abs( x ) + Math.abs( y ) + Math.abs( z );
	let u = x / sum, v = y / sum;
	if ( z < 0 ) {

		const au = u, av = v;
		u = ( 1 - Math.abs( av ) ) * ( au >= 0 ? 1 : - 1 );
		v = ( 1 - Math.abs( au ) ) * ( av >= 0 ? 1 : - 1 );

	}

	const qu = Math.round( Math.min( 1, Math.max( - 1, u ) ) * 32767 ) & 0xffff;
	const qv = Math.round( Math.min( 1, Math.max( - 1, v ) ) * 32767 ) & 0xffff;
	return ( ( qv << 16 ) | qu ) >>> 0;

}

const FLOATS_PER_NODE = 16; // 4 vec4s per BVH node
// Inline copies of EngineDefaults.BVH_LEAF_MARKERS — this module also runs inside a worker.
// Index fields are u32 BIT PATTERNS (exact past 2^24), read through `indexView`.
const LEAF_MARKER = 0x40000000;
const BLAS_POINTER_MARKER = 0x40000001;

// Relative to the matrix's own magnitude, never an absolute floor — see transformBoundsToWorld.
const SINGULAR_REL_EPS = 1e-12;

/**
 * Object-space bounds at `srcOff` through the instance transform stored on TLAS leaf `nodeOff`,
 * written to `dstOff`. Inlined rather than imported: this file also runs inside a worker.
 */
function transformBoundsToWorld( bvhData, nodeOff, src, srcOff, dst, dstOff ) {

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

/**
 * One node of a bottom-up refit: its own bounds into `bounds[ ( i - base ) * 6 ]`, and an inner
 * node's two child boxes rewritten from theirs. A leaf folded into its parent takes its box from
 * its triangles.
 */
function refitNode( nodes, i, acc, bounds, base ) {

	const bvhF = nodeF( nodes, i );
	const idx = nodeIdx( nodes, i );
	const o = nodeBase( nodes, i );
	const b = ( i - base ) * 6;
	const marker = idx[ o + 3 ];

	if ( marker === LEAF_MARKER ) {

		triangleBounds( acc, idx[ o ], idx[ o + 1 ], bounds, b );
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

	bvhF[ o ] = ls[ lb ]; bvhF[ o + 1 ] = ls[ lb + 1 ]; bvhF[ o + 2 ] = ls[ lb + 2 ];
	bvhF[ o + 4 ] = ls[ lb + 3 ]; bvhF[ o + 5 ] = ls[ lb + 4 ]; bvhF[ o + 6 ] = ls[ lb + 5 ];
	bvhF[ o + 8 ] = rs[ rb ]; bvhF[ o + 9 ] = rs[ rb + 1 ]; bvhF[ o + 10 ] = rs[ rb + 2 ];
	bvhF[ o + 12 ] = rs[ rb + 3 ]; bvhF[ o + 13 ] = rs[ rb + 4 ]; bvhF[ o + 14 ] = rs[ rb + 5 ];

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
	 * Bottom-up refit of all BVH node AABBs.
	 * Reverse pre-order iteration gives valid bottom-up order (children have higher
	 * indices than parents in pre-order, so reversing processes children first).
	 *
	 * @param {Float32Array} bvhData - Flat BVH array (mutated in place)
	 * @param {Uint32Array} triangleData - Updated triangle records
	 * @param {number} nodeCount - Total number of BVH nodes
	 */
	refit( bvhData, triangleData, nodeCount ) {

		const acc = triAccess( triangleData );

		// Reuse bounds buffer across frames (reallocate only on scene change)
		if ( nodeCount !== this._boundsNodeCount ) {

			this._bounds = new Float32Array( nodeCount * 6 );
			this._boundsNodeCount = nodeCount;

		}

		const nodes = nodeAccess( bvhData );
		for ( let i = nodeCount - 1; i >= 0; i -- ) refitNode( nodes, i, acc, this._bounds, 0 );

	}

}
