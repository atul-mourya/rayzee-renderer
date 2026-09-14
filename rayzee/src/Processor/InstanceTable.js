/**
 * InstanceTable — Per-mesh BLAS metadata for the two-level BVH (TLAS/BLAS).
 *
 * Tracks each mesh's BLAS location within the combined BVH buffer, its triangle range in the
 * global triangle buffer, world-space AABB, and per-BLAS triangle reorder map for refit.
 *
 * Columns, not objects. One entry per placement used to be a JS object plus two subarray views
 * plus two AABB objects — five objects each. Measured at 6M placements that was 3,125 MB, of
 * which 2,393 MB was object headers wrapping 176 bytes of real numbers, and it left ~30M live
 * objects for the collector to trace: ~1 s GC pauses that dropped a 22 ms frame to 4 fps while
 * traversal itself was unchanged. The same data in typed columns is ~78 bytes per placement.
 *
 * Reads are by index. `world`/`inverse`/`objectAABB`/`worldAABB` are flat — stride 16 for the
 * matrices, 6 for the bounds — so callers index them directly rather than taking a view.
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

/** Writes an AABB carried through an affine transform into `dst` at `dstOff`. */
export function transformAABBInto( src, srcOff, m, mOff, dst, dstOff ) {

	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

	for ( let c = 0; c < 8; c ++ ) {

		const x = src[ srcOff + ( c & 1 ? 3 : 0 ) ];
		const y = src[ srcOff + ( c & 2 ? 4 : 1 ) ];
		const z = src[ srcOff + ( c & 4 ? 5 : 2 ) ];

		const wx = m[ mOff ] * x + m[ mOff + 4 ] * y + m[ mOff + 8 ] * z + m[ mOff + 12 ];
		const wy = m[ mOff + 1 ] * x + m[ mOff + 5 ] * y + m[ mOff + 9 ] * z + m[ mOff + 13 ];
		const wz = m[ mOff + 2 ] * x + m[ mOff + 6 ] * y + m[ mOff + 10 ] * z + m[ mOff + 14 ];

		if ( wx < minX ) minX = wx; if ( wx > maxX ) maxX = wx;
		if ( wy < minY ) minY = wy; if ( wy > maxY ) maxY = wy;
		if ( wz < minZ ) minZ = wz; if ( wz > maxZ ) maxZ = wz;

	}

	dst[ dstOff ] = minX; dst[ dstOff + 1 ] = minY; dst[ dstOff + 2 ] = minZ;
	dst[ dstOff + 3 ] = maxX; dst[ dstOff + 4 ] = maxY; dst[ dstOff + 5 ] = maxZ;

}

/** True when the 16 floats at `off` leave points untouched — lets refit skip the transform. */
export function isIdentityAt( m, off ) {

	for ( let i = 0; i < 16; i ++ ) if ( m[ off + i ] !== IDENTITY[ i ] ) return false;
	return true;

}

export class InstanceTable {

	constructor() {

		this.count = 0;
		this.totalBLASNodes = 0;
		this.tlasNodeCount = 0;
		this.allocate( 0 );

	}

	/**
	 * Pre-allocate the columns for a known placement count. Must be called before setEntry().
	 * @param {number} count
	 */
	allocate( count ) {

		this.count = count;
		this.isSet = new Uint8Array( count );
		this.blasOffset = new Int32Array( count ); // set during assembly
		this.blasNodeCount = new Int32Array( count );
		this.triOffset = new Int32Array( count );
		this.triCount = new Int32Array( count );
		this.expandedStart = new Int32Array( count );
		// Object3D this placement came from — visibility is authored per object, not per instance.
		this.sourceMesh = new Int32Array( count );
		this.sharedFrom = new Int32Array( count ).fill( - 1 ); // placements reusing another BLAS
		this.tlasLeafIndex = new Int32Array( count ).fill( - 1 ); // set by TLASBuilder
		this.visible = new Uint8Array( count ).fill( 1 ); // baked into TLAS leaf slot [2]
		// A mirroring transform reverses triangle winding, so front and back swap in object
		// space. Traversal needs telling, or single-sided faces cull inside out.
		this.flipWinding = new Uint8Array( count );

		this.objectAABB = new Float32Array( count * 6 ); // bounds in the instance's own space
		this.worldAABB = new Float32Array( count * 6 ); // what the TLAS sorts on
		// float32 is what the TLAS leaf stores anyway, so nothing is lost downstream.
		this.world = new Float32Array( count * 16 );
		this.inverse = new Float32Array( count * 16 );

		// Sparse: only BLAS owners carry these, and a scene with millions of placements still
		// has a few thousand unique geometries.
		this.originalToBvhMap = new Map();
		this.bvhToOriginal = new Map();
		this.blasData = new Map();

	}

	/** Writes a placement's matrices into the pool. @private */
	_poolMatrices( index, matrixWorld ) {

		const o = index * 16;
		if ( matrixWorld ) {

			this.world.set( matrixWorld, o );
			// Inverted in double precision, stored at the width everything downstream uses.
			this.inverse.set( invertAffine( matrixWorld ), o );

		} else {

			this.world.set( IDENTITY, o );
			this.inverse.set( IDENTITY, o );

		}

	}

	/**
	 * Set a mesh entry at a specific index (meshIndex) after its BLAS has been built.
	 * Guarantees index → mesh regardless of build order.
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

		this._poolMatrices( meshIndex, matrixWorld );

		this.isSet[ meshIndex ] = 1;
		this.blasNodeCount[ meshIndex ] = blasNodeCount;
		this.triOffset[ meshIndex ] = triOffset;
		this.triCount[ meshIndex ] = triCount;
		this.expandedStart[ meshIndex ] = expandedStart ?? triOffset;
		this.sourceMesh[ meshIndex ] = sourceMesh ?? meshIndex;
		this.sharedFrom[ meshIndex ] = - 1;
		this.flipWinding[ meshIndex ] = matrixWorld && determinant3( matrixWorld ) < 0 ? 1 : 0;

		if ( originalToBvhMap ) this.originalToBvhMap.set( meshIndex, originalToBvhMap );
		if ( bvhData ) this.blasData.set( meshIndex, bvhData );

	}

	/**
	 * Register a placement that reuses `ownerIndex`'s triangles and BLAS. Only the transform
	 * differs, so it borrows the owner's node range and object-space bounds.
	 *
	 * @param {number} meshIndex
	 * @param {number} ownerIndex
	 * @param {number[]} [matrixWorld]
	 */
	setAlias( meshIndex, ownerIndex, matrixWorld = null, expandedStart = null, sourceMesh = null ) {

		if ( ! this.isSet[ ownerIndex ] ) throw new Error( `InstanceTable.setAlias: owner ${ownerIndex} not built` );

		this._poolMatrices( meshIndex, matrixWorld );

		this.isSet[ meshIndex ] = 1;
		this.blasNodeCount[ meshIndex ] = this.blasNodeCount[ ownerIndex ];
		this.triOffset[ meshIndex ] = this.triOffset[ ownerIndex ];
		this.triCount[ meshIndex ] = this.triCount[ ownerIndex ];
		this.expandedStart[ meshIndex ] = expandedStart ?? this.expandedStart[ ownerIndex ];
		this.sourceMesh[ meshIndex ] = sourceMesh ?? meshIndex;
		this.sharedFrom[ meshIndex ] = ownerIndex;
		this.flipWinding[ meshIndex ] = matrixWorld && determinant3( matrixWorld ) < 0 ? 1 : 0;

	}

	/** Placements actually built. */
	get setCount() {

		let n = 0;
		for ( let i = 0; i < this.count; i ++ ) n += this.isSet[ i ];
		return n;

	}

	/** A view of the 16 object-to-world floats for `index`. Cold paths only. */
	matrixWorldOf( index ) {

		return this.world.subarray( index * 16, index * 16 + 16 );

	}

	/** A view of the 16 world-to-object floats for `index`. Cold paths only. */
	matrixInverseOf( index ) {

		return this.inverse.subarray( index * 16, index * 16 + 16 );

	}

	/**
	 * A plain snapshot of one placement, shaped like the old entry object.
	 *
	 * This allocates, so it is for per-mesh work (refit of a handful of meshes) only — never a
	 * loop over every placement, which is the cost this class exists to avoid.
	 *
	 * @param {number} i
	 * @returns {object|null}
	 */
	entryAt( i ) {

		if ( ! this.isSet[ i ] ) return null;
		const owner = this.sharedFrom[ i ];
		const m = i * 16;

		return {
			meshIndex: i,
			blasOffset: this.blasOffset[ i ],
			blasNodeCount: this.blasNodeCount[ i ],
			triOffset: this.triOffset[ i ],
			triCount: this.triCount[ i ],
			expandedStart: this.expandedStart[ i ],
			sourceMesh: this.sourceMesh[ i ],
			sharedFrom: owner === - 1 ? null : owner,
			matrixWorld: this.world.subarray( m, m + 16 ),
			matrixInverse: this.inverse.subarray( m, m + 16 ),
			flipWinding: !! this.flipWinding[ i ],
			bvhToOriginal: this.bvhToOriginal.get( owner === - 1 ? i : owner ) || null,
			visible: !! this.visible[ i ],
			tlasLeafIndex: this.tlasLeafIndex[ i ],
		};

	}

	/**
	 * Set per-mesh visibility flag. Does NOT update the GPU buffer — caller must patch
	 * combinedBvhData[tlasLeafIndex*16 + 2] and mark the bvh attr dirty.
	 *
	 * @param {number} meshIndex
	 * @param {boolean} visible
	 */
	setVisibility( meshIndex, visible ) {

		if ( this.isSet[ meshIndex ] ) this.visible[ meshIndex ] = visible ? 1 : 0;

	}

	/**
	 * Compute world-space AABBs for all entries from their BLAS root node data.
	 * O(1) per mesh for inner roots; falls back to a triangle scan for leaf roots (rare).
	 *
	 * @param {Float32Array} triangleData - Global triangle data (needed for leaf-root fallback)
	 */
	computeAABBs( triangleData ) {

		for ( let i = 0; i < this.count; i ++ ) {

			if ( ! this.isSet[ i ] || this.sharedFrom[ i ] !== - 1 ) continue;
			this._readRootAABB( this.blasData.get( i ), i, triangleData, this.objectAABB, i * 6 );
			transformAABBInto( this.objectAABB, i * 6, this.world, i * 16, this.worldAABB, i * 6 );

		}

		// Aliases share the owner's object bounds; only the transform differs.
		for ( let i = 0; i < this.count; i ++ ) {

			const owner = this.sharedFrom[ i ];
			if ( ! this.isSet[ i ] || owner === - 1 ) continue;
			this.objectAABB.copyWithin( i * 6, owner * 6, owner * 6 + 6 );
			transformAABBInto( this.objectAABB, i * 6, this.world, i * 16, this.worldAABB, i * 6 );

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

		const root = this.blasOffset[ entryIndex ] * 16;
		this._readRootAABB(
			combinedBvhData.subarray( root, root + 16 ), entryIndex, triangleData,
			this.objectAABB, entryIndex * 6
		);
		transformAABBInto(
			this.objectAABB, entryIndex * 6, this.world, entryIndex * 16,
			this.worldAABB, entryIndex * 6
		);

	}

	/**
	 * Read the root node's AABB from a flat BVH data array into `out` at `off`.
	 * Inner root: union of left+right child AABBs (O(1)).
	 * Leaf root: scan triangles (rare — only meshes with <= maxLeafSize tris).
	 * @private
	 */
	_readRootAABB( bvhData, index, triangleData, out, off ) {

		if ( ! bvhData || bvhData[ 3 ] === - 1 ) {

			// Root is a leaf — very small mesh. Scan its triangles.
			this._computeAABBFromTriangles( index, triangleData, out, off );
			return;

		}

		// Inner node: [leftMin.xyz, leftChild] [leftMax.xyz, rightChild] [rightMin.xyz, 0] [rightMax.xyz, 0]
		out[ off ] = Math.min( bvhData[ 0 ], bvhData[ 8 ] );
		out[ off + 1 ] = Math.min( bvhData[ 1 ], bvhData[ 9 ] );
		out[ off + 2 ] = Math.min( bvhData[ 2 ], bvhData[ 10 ] );
		out[ off + 3 ] = Math.max( bvhData[ 4 ], bvhData[ 12 ] );
		out[ off + 4 ] = Math.max( bvhData[ 5 ], bvhData[ 13 ] );
		out[ off + 5 ] = Math.max( bvhData[ 6 ], bvhData[ 14 ] );

	}

	/**
	 * Compute AABB by scanning triangle positions (fallback for leaf-root BLASes).
	 * @private
	 */
	_computeAABBFromTriangles( index, triangleData, out, off ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		const tri = triangleData instanceof Float32Array
			? triangleData
			: new Float32Array( triangleData.buffer, triangleData.byteOffset, triangleData.length );
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		const triOffset = this.triOffset[ index ], triCount = this.triCount[ index ];
		for ( let t = 0; t < triCount; t ++ ) {

			const base = ( triOffset + t ) * FPT;

			// Positions A (offset 0), B (offset 4), C (offset 8)
			for ( let o = 0; o <= 8; o += 4 ) {

				const x = tri[ base + o ], y = tri[ base + o + 1 ], z = tri[ base + o + 2 ];
				if ( x < minX ) minX = x;
				if ( y < minY ) minY = y;
				if ( z < minZ ) minZ = z;
				if ( x > maxX ) maxX = x;
				if ( y > maxY ) maxY = y;
				if ( z > maxZ ) maxZ = z;

			}

		}

		out[ off ] = minX; out[ off + 1 ] = minY; out[ off + 2 ] = minZ;
		out[ off + 3 ] = maxX; out[ off + 4 ] = maxY; out[ off + 5 ] = maxZ;

	}

	/**
	 * Assign BLAS offsets in the combined BVH buffer. Called once the TLAS node count is known.
	 * @param {number} tlasNodeCount - Number of nodes in the TLAS
	 */
	assignOffsets( tlasNodeCount ) {

		this.tlasNodeCount = tlasNodeCount;
		let offset = tlasNodeCount;

		for ( let i = 0; i < this.count; i ++ ) {

			if ( ! this.isSet[ i ] || this.sharedFrom[ i ] !== - 1 ) continue;
			this.blasOffset[ i ] = offset;
			offset += this.blasNodeCount[ i ];

		}

		for ( let i = 0; i < this.count; i ++ ) {

			const owner = this.sharedFrom[ i ];
			if ( ! this.isSet[ i ] || owner === - 1 ) continue;
			this.blasOffset[ i ] = this.blasOffset[ owner ];

		}

		this.totalBLASNodes = offset - tlasNodeCount;

	}

	/** Total node count (TLAS + all BLASes). */
	get totalNodeCount() {

		return this.tlasNodeCount + this.totalBLASNodes;

	}

	/** Reset all columns. */
	clear() {

		this.allocate( 0 );
		this.totalBLASNodes = 0;
		this.tlasNodeCount = 0;

	}

}
