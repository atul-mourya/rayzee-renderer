/**
 * BVHRefitter — Fast O(N) bottom-up BVH AABB refit for animated geometry.
 *
 * When mesh topology stays the same but vertex positions change (skeletal animation,
 * morph targets), this avoids the full O(N log N) SAH rebuild by recomputing only
 * the bounding boxes in the existing tree structure.
 *
 * Designed to run in both main thread and Web Worker contexts.
 */

// Inline copy of layout constants (source of truth: EngineDefaults.js).
// Cannot import because this runs inside Web Workers where window is not defined.
const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 32,
	POSITION_A_OFFSET: 0,
	POSITION_B_OFFSET: 4,
	POSITION_C_OFFSET: 8,
	NORMAL_A_OFFSET: 12,
	NORMAL_B_OFFSET: 16,
	NORMAL_C_OFFSET: 20,
};

const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
const FLOATS_PER_NODE = 16; // 4 vec4s per BVH node
const LEAF_MARKER = - 1;
const BLAS_POINTER_MARKER = - 2;

const IDENTITY_EPS = 1e-12;

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

	if ( identity || ! Number.isFinite( det ) || Math.abs( det ) < IDENTITY_EPS ) {

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
	 * @param {Float32Array} triangleData - BVH-reordered triangle array (mutated in place)
	 * @param {Float32Array} newPositions - 9 floats per triangle in ORIGINAL mesh order
	 * @param {Uint32Array} bvhToOriginal - Map from BVH-order index to original tri index
	 */
	updateTrianglePositions( triangleData, newPositions, bvhToOriginal ) {

		const triCount = bvhToOriginal.length;

		for ( let bvhIdx = 0; bvhIdx < triCount; bvhIdx ++ ) {

			const orig = bvhToOriginal[ bvhIdx ];
			const dstOff = bvhIdx * FPT; // sequential writes
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

			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET ] = ax;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ] = ay;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ] = az;

			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET ] = bx;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ] = by;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ] = bz;

			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET ] = cx;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ] = cy;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ] = cz;

			// Compute unnormalized face normal from cross product.
			// Skip sqrt normalization — the path tracer shader normalizes during shading.
			const abx = bx - ax, aby = by - ay, abz = bz - az;
			const acx = cx - ax, acy = cy - ay, acz = cz - az;
			const nx = aby * acz - abz * acy;
			const ny = abz * acx - abx * acz;
			const nz = abx * acy - aby * acx;

			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET ] = nx;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 1 ] = ny;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET + 2 ] = nz;

			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET ] = nx;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 1 ] = ny;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET + 2 ] = nz;

			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET ] = nx;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 1 ] = ny;
			triangleData[ dstOff + TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET + 2 ] = nz;

		}

	}

	/**
	 * Refit a BLAS sub-range within the combined BVH buffer.
	 * Same algorithm as refit() but scoped to nodes [startNode, startNode + count).
	 *
	 * @param {Float32Array} bvhData - Combined BVH array (TLAS + all BLASes)
	 * @param {Float32Array} triangleData - Global triangle data
	 * @param {number} startNode - First node index of this BLAS in bvhData
	 * @param {number} nodeCount - Number of nodes in this BLAS
	 */
	refitRange( bvhData, triangleData, startNode, nodeCount ) {

		// Grow-only bounds buffer to avoid reallocation on mixed-size BLASes
		if ( nodeCount > this._boundsNodeCount ) {

			this._bounds = new Float32Array( nodeCount * 6 );
			this._boundsNodeCount = nodeCount;

		}

		const bounds = this._bounds;
		const endNode = startNode + nodeCount;

		for ( let i = endNode - 1; i >= startNode; i -- ) {

			const o = i * FLOATS_PER_NODE;
			const b = ( i - startNode ) * 6; // bounds indexed relative to BLAS start

			if ( bvhData[ o + 3 ] === LEAF_MARKER ) {

				const triOffset = bvhData[ o ];
				const triCount = bvhData[ o + 1 ];

				let minX = Infinity, minY = Infinity, minZ = Infinity;
				let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

				for ( let t = 0; t < triCount; t ++ ) {

					const tOff = ( triOffset + t ) * FPT;
					const ax = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET ];
					const ay = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ];
					const az = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ];
					const bx = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET ];
					const by = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ];
					const bz = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ];
					const cx = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET ];
					const cy = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ];
					const cz = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ];

					minX = Math.min( minX, ax, bx, cx );
					minY = Math.min( minY, ay, by, cy );
					minZ = Math.min( minZ, az, bz, cz );
					maxX = Math.max( maxX, ax, bx, cx );
					maxY = Math.max( maxY, ay, by, cy );
					maxZ = Math.max( maxZ, az, bz, cz );

				}

				bounds[ b ] = minX;
				bounds[ b + 1 ] = minY;
				bounds[ b + 2 ] = minZ;
				bounds[ b + 3 ] = maxX;
				bounds[ b + 4 ] = maxY;
				bounds[ b + 5 ] = maxZ;

			} else {

				// Inner node — child indices are absolute, but bounds index relative to startNode
				const leftIdx = bvhData[ o + 3 ];
				const rightIdx = bvhData[ o + 7 ];
				const lb = ( leftIdx - startNode ) * 6;
				const rb = ( rightIdx - startNode ) * 6;

				const lMinX = bounds[ lb ];
				const lMinY = bounds[ lb + 1 ];
				const lMinZ = bounds[ lb + 2 ];
				const lMaxX = bounds[ lb + 3 ];
				const lMaxY = bounds[ lb + 4 ];
				const lMaxZ = bounds[ lb + 5 ];

				const rMinX = bounds[ rb ];
				const rMinY = bounds[ rb + 1 ];
				const rMinZ = bounds[ rb + 2 ];
				const rMaxX = bounds[ rb + 3 ];
				const rMaxY = bounds[ rb + 4 ];
				const rMaxZ = bounds[ rb + 5 ];

				bvhData[ o ] = lMinX;
				bvhData[ o + 1 ] = lMinY;
				bvhData[ o + 2 ] = lMinZ;
				bvhData[ o + 4 ] = lMaxX;
				bvhData[ o + 5 ] = lMaxY;
				bvhData[ o + 6 ] = lMaxZ;

				bvhData[ o + 8 ] = rMinX;
				bvhData[ o + 9 ] = rMinY;
				bvhData[ o + 10 ] = rMinZ;
				bvhData[ o + 12 ] = rMaxX;
				bvhData[ o + 13 ] = rMaxY;
				bvhData[ o + 14 ] = rMaxZ;

				bounds[ b ] = Math.min( lMinX, rMinX );
				bounds[ b + 1 ] = Math.min( lMinY, rMinY );
				bounds[ b + 2 ] = Math.min( lMinZ, rMinZ );
				bounds[ b + 3 ] = Math.max( lMaxX, rMaxX );
				bounds[ b + 4 ] = Math.max( lMaxY, rMaxY );
				bounds[ b + 5 ] = Math.max( lMaxZ, rMaxZ );

			}

		}

	}

	/**
	 * Bottom-up refit of all BVH node AABBs.
	 * Reverse pre-order iteration gives valid bottom-up order (children have higher
	 * indices than parents in pre-order, so reversing processes children first).
	 *
	 * @param {Float32Array} bvhData - Flat BVH array (mutated in place)
	 * @param {Float32Array} triangleData - Updated triangle data
	 * @param {number} nodeCount - Total number of BVH nodes
	 */
	refit( bvhData, triangleData, nodeCount ) {

		// Reuse bounds buffer across frames (reallocate only on scene change)
		if ( nodeCount !== this._boundsNodeCount ) {

			this._bounds = new Float32Array( nodeCount * 6 );
			this._boundsNodeCount = nodeCount;

		}

		const bounds = this._bounds;

		// Reverse iteration: bottom-up in pre-order layout
		for ( let i = nodeCount - 1; i >= 0; i -- ) {

			const o = i * FLOATS_PER_NODE;
			const b = i * 6;

			const marker = bvhData[ o + 3 ];

			if ( marker === LEAF_MARKER ) {

				// Triangle leaf: compute AABB from triangles
				const triOffset = bvhData[ o ];
				const triCount = bvhData[ o + 1 ];

				let minX = Infinity, minY = Infinity, minZ = Infinity;
				let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

				for ( let t = 0; t < triCount; t ++ ) {

					const tOff = ( triOffset + t ) * FPT;

					// Position A
					const ax = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET ];
					const ay = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 1 ];
					const az = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET + 2 ];
					// Position B
					const bx = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET ];
					const by = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 1 ];
					const bz = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET + 2 ];
					// Position C
					const cx = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET ];
					const cy = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 1 ];
					const cz = triangleData[ tOff + TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET + 2 ];

					minX = Math.min( minX, ax, bx, cx );
					minY = Math.min( minY, ay, by, cy );
					minZ = Math.min( minZ, az, bz, cz );
					maxX = Math.max( maxX, ax, bx, cx );
					maxY = Math.max( maxY, ay, by, cy );
					maxZ = Math.max( maxZ, az, bz, cz );

				}

				bounds[ b ] = minX;
				bounds[ b + 1 ] = minY;
				bounds[ b + 2 ] = minZ;
				bounds[ b + 3 ] = maxX;
				bounds[ b + 4 ] = maxY;
				bounds[ b + 5 ] = maxZ;

			} else if ( marker === BLAS_POINTER_MARKER ) {

				// BLAS-pointer leaf (TLAS): the BLAS root's bounds are in the instance's own
				// space, and the TLAS sorts on world bounds — so carry the box out through the
				// leaf's transform. Slots 4..15 are the rows of world-to-object; the eight
				// corners go back the other way through its inverse.
				const blasRoot = bvhData[ o ];
				const br = blasRoot * 6;
				transformBoundsToWorld( bvhData, o, bounds, br, bounds, b );

			} else {

				// Inner node: union children bounds (already computed since we iterate in reverse)
				const leftIdx = bvhData[ o + 3 ];
				const rightIdx = bvhData[ o + 7 ];
				const lb = leftIdx * 6;
				const rb = rightIdx * 6;

				const lMinX = bounds[ lb ];
				const lMinY = bounds[ lb + 1 ];
				const lMinZ = bounds[ lb + 2 ];
				const lMaxX = bounds[ lb + 3 ];
				const lMaxY = bounds[ lb + 4 ];
				const lMaxZ = bounds[ lb + 5 ];

				const rMinX = bounds[ rb ];
				const rMinY = bounds[ rb + 1 ];
				const rMinZ = bounds[ rb + 2 ];
				const rMaxX = bounds[ rb + 3 ];
				const rMaxY = bounds[ rb + 4 ];
				const rMaxZ = bounds[ rb + 5 ];

				// Write left child AABB into bvhData
				bvhData[ o ] = lMinX;
				bvhData[ o + 1 ] = lMinY;
				bvhData[ o + 2 ] = lMinZ;
				// o+3 = leftChildIdx (preserved)
				bvhData[ o + 4 ] = lMaxX;
				bvhData[ o + 5 ] = lMaxY;
				bvhData[ o + 6 ] = lMaxZ;
				// o+7 = rightChildIdx (preserved)

				// Write right child AABB into bvhData
				bvhData[ o + 8 ] = rMinX;
				bvhData[ o + 9 ] = rMinY;
				bvhData[ o + 10 ] = rMinZ;
				// o+11 = 0 padding
				bvhData[ o + 12 ] = rMaxX;
				bvhData[ o + 13 ] = rMaxY;
				bvhData[ o + 14 ] = rMaxZ;
				// o+15 = 0 padding

				// Store this node's bounds as union of children
				bounds[ b ] = Math.min( lMinX, rMinX );
				bounds[ b + 1 ] = Math.min( lMinY, rMinY );
				bounds[ b + 2 ] = Math.min( lMinZ, rMinZ );
				bounds[ b + 3 ] = Math.max( lMaxX, rMaxX );
				bounds[ b + 4 ] = Math.max( lMaxY, rMaxY );
				bounds[ b + 5 ] = Math.max( lMaxZ, rMaxZ );

			}

		}

	}

}
