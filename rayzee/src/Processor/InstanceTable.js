/**
 * InstanceTable — Per-mesh BLAS metadata for the two-level BVH (TLAS/BLAS).
 *
 * Tracks each mesh's BLAS location within the combined BVH buffer,
 * its triangle range in the global triangle buffer, world-space AABB,
 * and per-BLAS triangle reorder map for refit.
 */

import { TRIANGLE_DATA_LAYOUT } from '../EngineDefaults.js';

const IDENTITY = Float64Array.from( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );

/** Determinant of the upper-left 3x3. Negative means the transform mirrors. */
function determinant3( m ) {

	return m[ 0 ] * ( m[ 5 ] * m[ 10 ] - m[ 6 ] * m[ 9 ] )
		- m[ 4 ] * ( m[ 1 ] * m[ 10 ] - m[ 2 ] * m[ 9 ] )
		+ m[ 8 ] * ( m[ 1 ] * m[ 6 ] - m[ 2 ] * m[ 5 ] );

}

/** Inverse of an affine column-major 4x4 (no projective row). */
function invertAffine( m ) {

	const det = determinant3( m );
	const out = IDENTITY.slice();
	if ( ! Number.isFinite( det ) || Math.abs( det ) < 1e-20 ) return out;
	const s = 1 / det;

	out[ 0 ] = ( m[ 5 ] * m[ 10 ] - m[ 6 ] * m[ 9 ] ) * s;
	out[ 1 ] = ( m[ 2 ] * m[ 9 ] - m[ 1 ] * m[ 10 ] ) * s;
	out[ 2 ] = ( m[ 1 ] * m[ 6 ] - m[ 2 ] * m[ 5 ] ) * s;
	out[ 4 ] = ( m[ 6 ] * m[ 8 ] - m[ 4 ] * m[ 10 ] ) * s;
	out[ 5 ] = ( m[ 0 ] * m[ 10 ] - m[ 2 ] * m[ 8 ] ) * s;
	out[ 6 ] = ( m[ 2 ] * m[ 4 ] - m[ 0 ] * m[ 6 ] ) * s;
	out[ 8 ] = ( m[ 4 ] * m[ 9 ] - m[ 5 ] * m[ 8 ] ) * s;
	out[ 9 ] = ( m[ 1 ] * m[ 8 ] - m[ 0 ] * m[ 9 ] ) * s;
	out[ 10 ] = ( m[ 0 ] * m[ 5 ] - m[ 1 ] * m[ 4 ] ) * s;

	out[ 12 ] = - ( out[ 0 ] * m[ 12 ] + out[ 4 ] * m[ 13 ] + out[ 8 ] * m[ 14 ] );
	out[ 13 ] = - ( out[ 1 ] * m[ 12 ] + out[ 5 ] * m[ 13 ] + out[ 9 ] * m[ 14 ] );
	out[ 14 ] = - ( out[ 2 ] * m[ 12 ] + out[ 6 ] * m[ 13 ] + out[ 10 ] * m[ 14 ] );
	return out;

}

/** True when the matrix leaves points untouched — lets refit skip the transform entirely. */
export function isIdentity( m ) {

	for ( let i = 0; i < 16; i ++ ) if ( m[ i ] !== IDENTITY[ i ] ) return false;
	return true;

}

/** Axis-aligned bounds of an AABB carried through an affine transform (all 8 corners). */
export function transformAABB( aabb, m ) {

	if ( ! aabb ) return aabb;

	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

	for ( let c = 0; c < 8; c ++ ) {

		const x = c & 1 ? aabb.maxX : aabb.minX;
		const y = c & 2 ? aabb.maxY : aabb.minY;
		const z = c & 4 ? aabb.maxZ : aabb.minZ;

		const wx = m[ 0 ] * x + m[ 4 ] * y + m[ 8 ] * z + m[ 12 ];
		const wy = m[ 1 ] * x + m[ 5 ] * y + m[ 9 ] * z + m[ 13 ];
		const wz = m[ 2 ] * x + m[ 6 ] * y + m[ 10 ] * z + m[ 14 ];

		if ( wx < minX ) minX = wx; if ( wx > maxX ) maxX = wx;
		if ( wy < minY ) minY = wy; if ( wy > maxY ) maxY = wy;
		if ( wz < minZ ) minZ = wz; if ( wz > maxZ ) maxZ = wz;

	}

	return { minX, minY, minZ, maxX, maxY, maxZ };

}

export class InstanceTable {

	constructor() {

		/** @type {InstanceEntry[]} */
		this.entries = [];

		/** Total BVH node count across all BLASes (excludes TLAS nodes) */
		this.totalBLASNodes = 0;

		/** Number of TLAS nodes */
		this.tlasNodeCount = 0;

	}

	/**
	 * Pre-allocate entries array for a known mesh count.
	 * Must be called before setEntry().
	 * @param {number} count
	 */
	allocate( count ) {

		this.entries = new Array( count ).fill( null );
		// Matrices live in two pooled buffers rather than a pair of typed arrays per entry:
		// at a couple of million placements the per-array headers cost more than the numbers.
		// float32 is what the TLAS leaf stores anyway, so nothing is lost downstream.
		this._world = new Float32Array( count * 16 );
		this._inverse = new Float32Array( count * 16 );

	}

	/** Writes a placement's matrices into the pool and returns views onto them. @private */
	_poolMatrices( index, matrixWorld ) {

		const o = index * 16;
		const world = this._world.subarray( o, o + 16 );
		const inverse = this._inverse.subarray( o, o + 16 );

		if ( matrixWorld ) {

			world.set( matrixWorld );
			// Inverted in double precision, stored at the width everything downstream uses.
			inverse.set( invertAffine( matrixWorld ) );

		} else {

			world.set( IDENTITY );
			inverse.set( IDENTITY );

		}

		return { world, inverse };

	}

	/**
	 * Set a mesh entry at a specific index (meshIndex) after its BLAS has been built.
	 * Guarantees entries[meshIndex] maps to the correct mesh regardless of build order.
	 *
	 * @param {Object} params
	 * @param {number} params.meshIndex - Index into the meshes array (also the slot index)
	 * @param {number} params.blasNodeCount - Number of BVH nodes in this BLAS
	 * @param {number} params.triOffset - Triangle index offset in global triangleData
	 * @param {number} params.triCount - Number of triangles for this mesh
	 * @param {Uint32Array} params.originalToBvhMap - Per-BLAS triangle reorder map
	 * @param {Float32Array} params.bvhData - Raw BLAS BVH data (local indices, before assembly)
	 * @param {number[]} [params.matrixWorld] - object-to-world, column-major 16
	 */
	setEntry( { meshIndex, blasNodeCount, triOffset, triCount, originalToBvhMap, bvhData, matrixWorld = null, expandedStart = null, sourceMesh = null } ) {

		const pooled = this._poolMatrices( meshIndex, matrixWorld );

		this.entries[ meshIndex ] = {
			meshIndex,
			blasOffset: 0, // Set during assembly
			blasNodeCount,
			triOffset,
			triCount,
			expandedStart: expandedStart ?? triOffset,
			// Object3D this placement came from — visibility is authored per object, not per instance.
			sourceMesh: sourceMesh ?? meshIndex,
			sharedFrom: null, // set on placements that reuse another entry's BLAS
			matrixWorld: pooled.world,
			matrixInverse: pooled.inverse,
			// A mirroring transform reverses triangle winding, so front and back swap in
			// object space. Traversal needs telling, or single-sided faces cull inside out.
			flipWinding: matrixWorld ? determinant3( matrixWorld ) < 0 : false,
			objectAABB: null, // Bounds in the instance's own space, straight off the BLAS root
			worldAABB: null, // objectAABB through matrixWorld — what the TLAS sorts on
			originalToBvhMap,
			bvhData,
			visible: true, // Per-mesh visibility (baked into TLAS leaf slot [2])
			tlasLeafIndex: - 1, // Set by TLASBuilder.flatten() — enables in-place visibility patching
		};

	}

	/**
	 * Register a placement that reuses `ownerIndex`'s triangles and BLAS. Only the transform
	 * differs, so the entry borrows the owner's node range and object-space bounds.
	 *
	 * @param {number} meshIndex
	 * @param {number} ownerIndex
	 * @param {number[]} [matrixWorld]
	 */
	setAlias( meshIndex, ownerIndex, matrixWorld = null, expandedStart = null, sourceMesh = null ) {

		const owner = this.entries[ ownerIndex ];
		if ( ! owner ) throw new Error( `InstanceTable.setAlias: owner ${ownerIndex} not built` );

		const pooled = this._poolMatrices( meshIndex, matrixWorld );

		this.entries[ meshIndex ] = {
			meshIndex,
			blasOffset: 0,
			blasNodeCount: owner.blasNodeCount,
			triOffset: owner.triOffset,
			triCount: owner.triCount,
			expandedStart: expandedStart ?? owner.expandedStart,
			sourceMesh: sourceMesh ?? meshIndex,
			originalToBvhMap: null,
			bvhData: null,
			sharedFrom: ownerIndex,
			matrixWorld: pooled.world,
			matrixInverse: pooled.inverse,
			objectAABB: null,
			worldAABB: null,
			visible: true,
			tlasLeafIndex: - 1,
		};

	}

	/**
	 * Set per-mesh visibility flag. Does NOT update the GPU buffer —
	 * caller must patch combinedBvhData[tlasLeafIndex*16 + 2] and mark bvh attr dirty.
	 *
	 * @param {number} meshIndex
	 * @param {boolean} visible
	 */
	setVisibility( meshIndex, visible ) {

		const entry = this.entries[ meshIndex ];
		if ( entry ) entry.visible = visible;

	}

	/**
	 * Compute world-space AABBs for all entries from their BLAS root node data.
	 * O(1) per mesh for inner roots; falls back to triangle scan for leaf roots (rare).
	 *
	 * @param {Float32Array} triangleData - Global triangle data (needed for leaf-root fallback)
	 */
	computeAABBs( triangleData ) {

		for ( const entry of this.entries ) {

			if ( ! entry || entry.sharedFrom !== null ) continue;
			entry.objectAABB = this._readRootAABB( entry.bvhData, entry, triangleData );
			entry.worldAABB = transformAABB( entry.objectAABB, entry.matrixWorld );

		}

		// Aliases share the owner's object bounds; only the transform differs.
		for ( const entry of this.entries ) {

			if ( ! entry || entry.sharedFrom === null ) continue;
			entry.objectAABB = this.entries[ entry.sharedFrom ].objectAABB;
			entry.worldAABB = transformAABB( entry.objectAABB, entry.matrixWorld );

		}

	}

	/**
	 * Recompute AABB for a single entry after BLAS refit.
	 * Reads from the combined bvhData buffer at the BLAS root offset.
	 *
	 * @param {number} entryIndex
	 * @param {Float32Array} combinedBvhData - The assembled BVH buffer (TLAS + BLASes)
	 * @param {Float32Array} triangleData - Global triangle data (for leaf-root fallback)
	 */
	recomputeAABB( entryIndex, combinedBvhData, triangleData ) {

		const entry = this.entries[ entryIndex ];
		const rootData = combinedBvhData.subarray( entry.blasOffset * 16, entry.blasOffset * 16 + 16 );
		entry.objectAABB = this._readRootAABB( rootData, entry, triangleData );
		entry.worldAABB = transformAABB( entry.objectAABB, entry.matrixWorld );

	}

	/**
	 * Read the root node's AABB from a flat BVH data array.
	 * Inner root: union of left+right child AABBs (O(1)).
	 * Leaf root: scan triangles (rare — only meshes with ≤maxLeafSize tris).
	 * @private
	 */
	_readRootAABB( bvhData, entry, triangleData ) {

		const marker = bvhData[ 3 ];

		if ( marker === - 1 ) {

			// Root is a leaf — very small mesh. Scan its triangles.
			return this._computeAABBFromTriangles( entry, triangleData );

		}

		// Inner node: [leftMin.xyz, leftChild] [leftMax.xyz, rightChild] [rightMin.xyz, 0] [rightMax.xyz, 0]
		const lMinX = bvhData[ 0 ], lMinY = bvhData[ 1 ], lMinZ = bvhData[ 2 ];
		const lMaxX = bvhData[ 4 ], lMaxY = bvhData[ 5 ], lMaxZ = bvhData[ 6 ];
		const rMinX = bvhData[ 8 ], rMinY = bvhData[ 9 ], rMinZ = bvhData[ 10 ];
		const rMaxX = bvhData[ 12 ], rMaxY = bvhData[ 13 ], rMaxZ = bvhData[ 14 ];

		return {
			minX: Math.min( lMinX, rMinX ),
			minY: Math.min( lMinY, rMinY ),
			minZ: Math.min( lMinZ, rMinZ ),
			maxX: Math.max( lMaxX, rMaxX ),
			maxY: Math.max( lMaxY, rMaxY ),
			maxZ: Math.max( lMaxZ, rMaxZ ),
		};

	}

	/**
	 * Compute AABB by scanning triangle positions (fallback for leaf-root BLASes).
	 * @private
	 */
	_computeAABBFromTriangles( entry, triangleData ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		for ( let t = 0; t < entry.triCount; t ++ ) {

			const base = ( entry.triOffset + t ) * FPT;

			// Check positions A (offset 0), B (offset 4), C (offset 8)
			for ( let off = 0; off <= 8; off += 4 ) {

				const x = triangleData[ base + off ];
				const y = triangleData[ base + off + 1 ];
				const z = triangleData[ base + off + 2 ];
				if ( x < minX ) minX = x;
				if ( y < minY ) minY = y;
				if ( z < minZ ) minZ = z;
				if ( x > maxX ) maxX = x;
				if ( y > maxY ) maxY = y;
				if ( z > maxZ ) maxZ = z;

			}

		}

		return { minX, minY, minZ, maxX, maxY, maxZ };

	}

	/**
	 * Assign BLAS offsets in the combined BVH buffer.
	 * Called after TLAS node count is known.
	 *
	 * @param {number} tlasNodeCount - Number of nodes in the TLAS
	 */
	assignOffsets( tlasNodeCount ) {

		this.tlasNodeCount = tlasNodeCount;
		let offset = tlasNodeCount;

		for ( const entry of this.entries ) {

			if ( ! entry || entry.sharedFrom !== null ) continue;
			entry.blasOffset = offset;
			offset += entry.blasNodeCount;

		}

		for ( const entry of this.entries ) {

			if ( ! entry || entry.sharedFrom === null ) continue;
			entry.blasOffset = this.entries[ entry.sharedFrom ].blasOffset;

		}

		this.totalBLASNodes = offset - tlasNodeCount;

	}

	/**
	 * Total node count (TLAS + all BLASes).
	 */
	get totalNodeCount() {

		return this.tlasNodeCount + this.totalBLASNodes;

	}

	/**
	 * Number of mesh instances.
	 */
	get count() {

		return this.entries.length;

	}

	/**
	 * Reset all entries.
	 */
	clear() {

		this.entries = [];
		this.totalBLASNodes = 0;
		this.tlasNodeCount = 0;

	}

}
