/**
 * InstanceTable — per-placement transforms plus per-template BLAS metadata for the two-level BVH.
 *
 * Columns, not objects, and the per-template half is stored once rather than once per placement:
 * millions of placements still share a few thousand geometries, so triangle ranges, node counts
 * and object-space bounds live on the template. `sourceMesh` doubles as the template id.
 *
 * 75 bytes a placement, against 418 for the array-of-objects version and 211 for the flat but
 * denormalised one. World bounds and the inverse transform are derived on demand.
 */

import { BVH_LEAF_MARKERS, TRIANGLE_DATA_LAYOUT, assertBVHIndexFits, bvhIndexView } from '../EngineDefaults.js';

const IDENTITY = Float64Array.from( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );

/** Determinant of the upper-left 3x3 at `off`. Negative means the transform mirrors. */
export function determinant3At( m, off ) {

	return m[ off ] * ( m[ off + 5 ] * m[ off + 10 ] - m[ off + 6 ] * m[ off + 9 ] )
		- m[ off + 4 ] * ( m[ off + 1 ] * m[ off + 10 ] - m[ off + 2 ] * m[ off + 9 ] )
		+ m[ off + 8 ] * ( m[ off + 1 ] * m[ off + 6 ] - m[ off + 2 ] * m[ off + 5 ] );

}

/** Writes the inverse of the affine column-major 4x4 at `off` into `out`. */
export function invertAffineInto( m, off, out ) {

	const det = determinant3At( m, off );
	if ( ! Number.isFinite( det ) || Math.abs( det ) < 1e-20 ) {

		out.set( IDENTITY );
		return out;

	}

	const s = 1 / det;

	out[ 0 ] = ( m[ off + 5 ] * m[ off + 10 ] - m[ off + 6 ] * m[ off + 9 ] ) * s;
	out[ 1 ] = ( m[ off + 2 ] * m[ off + 9 ] - m[ off + 1 ] * m[ off + 10 ] ) * s;
	out[ 2 ] = ( m[ off + 1 ] * m[ off + 6 ] - m[ off + 2 ] * m[ off + 5 ] ) * s;
	out[ 3 ] = 0;
	out[ 4 ] = ( m[ off + 6 ] * m[ off + 8 ] - m[ off + 4 ] * m[ off + 10 ] ) * s;
	out[ 5 ] = ( m[ off ] * m[ off + 10 ] - m[ off + 2 ] * m[ off + 8 ] ) * s;
	out[ 6 ] = ( m[ off + 2 ] * m[ off + 4 ] - m[ off ] * m[ off + 6 ] ) * s;
	out[ 7 ] = 0;
	out[ 8 ] = ( m[ off + 4 ] * m[ off + 9 ] - m[ off + 5 ] * m[ off + 8 ] ) * s;
	out[ 9 ] = ( m[ off + 1 ] * m[ off + 8 ] - m[ off ] * m[ off + 9 ] ) * s;
	out[ 10 ] = ( m[ off ] * m[ off + 5 ] - m[ off + 1 ] * m[ off + 4 ] ) * s;
	out[ 11 ] = 0;

	out[ 12 ] = - ( out[ 0 ] * m[ off + 12 ] + out[ 4 ] * m[ off + 13 ] + out[ 8 ] * m[ off + 14 ] );
	out[ 13 ] = - ( out[ 1 ] * m[ off + 12 ] + out[ 5 ] * m[ off + 13 ] + out[ 9 ] * m[ off + 14 ] );
	out[ 14 ] = - ( out[ 2 ] * m[ off + 12 ] + out[ 6 ] * m[ off + 13 ] + out[ 10 ] * m[ off + 14 ] );
	out[ 15 ] = 1;
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
		this.templateCount = 0;
		this.totalBLASNodes = 0;
		this.tlasNodeCount = 0;
		this.allocate( 0 );

	}

	/**
	 * Pre-allocate the columns. Must be called before setEntry().
	 *
	 * @param {number} count - placements
	 * @param {number} [templateCount] - distinct source meshes; defaults to one per placement
	 * @param {Float32Array} [worldPool] - adopted as the transform column instead of allocating,
	 *   so a caller that already built the matrices contiguously hands them over without a copy
	 * @param {Int32Array} [sourcePool] - likewise for the source-mesh column
	 */
	allocate( count, templateCount = count, worldPool = null, sourcePool = null ) {

		this.count = count;
		this.templateCount = templateCount;

		this.isSet = new Uint8Array( count );
		// Object3D this placement came from, and the template index for everything below.
		this.sourceMesh = sourcePool && sourcePool.length >= count ? sourcePool : new Int32Array( count );
		this.tlasLeafIndex = new Int32Array( count ).fill( - 1 ); // set by TLASBuilder
		this.visible = new Uint8Array( count ).fill( 1 ); // baked into TLAS leaf slot [2]
		// A mirroring transform reverses triangle winding, so front and back swap in object
		// space. Traversal needs telling, or single-sided faces cull inside out.
		this.flipWinding = new Uint8Array( count );

		if ( worldPool && worldPool.length >= count * 16 ) {

			this.world = worldPool;
			this.worldPooled = true;

		} else {

			this.world = new Float32Array( count * 16 );
			this.worldPooled = false;

		}

		this.tplTriOffset = new Int32Array( templateCount );
		this.tplTriCount = new Int32Array( templateCount );
		this.tplExpandedStart = new Int32Array( templateCount );
		this.tplNodeCount = new Int32Array( templateCount );
		this.tplBlasOffset = new Int32Array( templateCount );
		this.tplOwner = new Int32Array( templateCount ).fill( - 1 ); // placement that built the BLAS
		this.tplObjectAABB = new Float32Array( templateCount * 6 );

		// Keyed by template, and only templates that own a BLAS carry them.
		this.originalToBvhMap = new Map();
		this.bvhToOriginal = new Map();
		this.blasData = new Map();

	}

	/** Writes the placement half of an entry. @private */
	_place( index, template, matrixWorld, matrixOffset ) {

		this.isSet[ index ] = 1;
		this.sourceMesh[ index ] = template;

		const o = index * 16;

		if ( ! matrixWorld ) {

			this.world.set( IDENTITY, o );
			this.flipWinding[ index ] = 0;
			return;

		}

		// Already in the pool — adopting it is the whole point of passing it in.
		if ( matrixWorld !== this.world ) {

			for ( let k = 0; k < 16; k ++ ) this.world[ o + k ] = matrixWorld[ matrixOffset + k ];

		}

		this.flipWinding[ index ] = determinant3At( this.world, o ) < 0 ? 1 : 0;

	}

	/**
	 * Set a placement whose BLAS has just been built. Template metadata (triangle range, node
	 * count, reorder map) is recorded once against `sourceMesh`, not once per placement.
	 *
	 * @param {Object} params
	 * @param {number} params.meshIndex - Placement slot
	 * @param {number} params.blasNodeCount - Number of BVH nodes in this BLAS
	 * @param {number} params.triOffset - Triangle index offset in global triangleData
	 * @param {number} params.triCount - Number of triangles for this mesh
	 * @param {Uint32Array} params.originalToBvhMap - Per-BLAS triangle reorder map
	 * @param {Float32Array} params.bvhData - Raw BLAS BVH data (local indices, before assembly)
	 * @param {ArrayLike<number>} [params.matrixWorld] - object-to-world, column-major 16
	 * @param {number} [params.matrixOffset] - element offset into `matrixWorld`
	 */
	setEntry( { meshIndex, blasNodeCount, triOffset, triCount, originalToBvhMap, bvhData, matrixWorld = null, matrixOffset = 0, expandedStart = null, sourceMesh = null } ) {

		const t = sourceMesh ?? meshIndex;

		this._place( meshIndex, t, matrixWorld, matrixOffset );

		this.tplTriOffset[ t ] = triOffset;
		this.tplTriCount[ t ] = triCount;
		this.tplExpandedStart[ t ] = expandedStart ?? triOffset;
		this.tplNodeCount[ t ] = blasNodeCount;
		this.tplOwner[ t ] = meshIndex;

		if ( originalToBvhMap ) this.originalToBvhMap.set( t, originalToBvhMap );
		if ( bvhData ) this.blasData.set( t, bvhData );

	}

	/**
	 * Register a placement that reuses `ownerIndex`'s triangles and BLAS. Only the transform
	 * differs, so its template borrows the owner's node range and object-space bounds.
	 *
	 * @param {number} meshIndex
	 * @param {number} ownerIndex
	 * @param {ArrayLike<number>} [matrixWorld]
	 */
	setAlias( meshIndex, ownerIndex, matrixWorld = null, expandedStart = null, sourceMesh = null, matrixOffset = 0 ) {

		if ( ! this.isSet[ ownerIndex ] ) throw new Error( `InstanceTable.setAlias: owner ${ownerIndex} not built` );

		const t = sourceMesh ?? meshIndex;
		const ot = this.sourceMesh[ ownerIndex ];

		this._place( meshIndex, t, matrixWorld, matrixOffset );

		if ( t === ot ) return; // same template as the owner: nothing to mirror

		this.tplTriOffset[ t ] = this.tplTriOffset[ ot ];
		this.tplTriCount[ t ] = this.tplTriCount[ ot ];
		this.tplNodeCount[ t ] = this.tplNodeCount[ ot ];
		this.tplExpandedStart[ t ] = expandedStart ?? this.tplExpandedStart[ ot ];
		this.tplOwner[ t ] = this.tplOwner[ ot ];

	}

	/** Placements actually built. */
	get setCount() {

		let n = 0;
		for ( let i = 0; i < this.count; i ++ ) n += this.isSet[ i ];
		return n;

	}

	/** True when this placement is the one whose BLAS the others alias. */
	isOwner( index ) {

		return this.tplOwner[ this.sourceMesh[ index ] ] === index;

	}

	triOffsetOf( index ) {

		return this.tplTriOffset[ this.sourceMesh[ index ] ];

	}

	triCountOf( index ) {

		return this.tplTriCount[ this.sourceMesh[ index ] ];

	}

	expandedStartOf( index ) {

		return this.tplExpandedStart[ this.sourceMesh[ index ] ];

	}

	blasOffsetOf( index ) {

		return this.tplBlasOffset[ this.sourceMesh[ index ] ];

	}

	blasNodeCountOf( index ) {

		return this.tplNodeCount[ this.sourceMesh[ index ] ];

	}

	/** The per-BLAS triangle reorder map this placement traverses through. */
	bvhToOriginalOf( index ) {

		return this.bvhToOriginal.get( this.sourceMesh[ index ] ) || null;

	}

	/** A view of the 16 object-to-world floats for `index`. Cold paths only. */
	matrixWorldOf( index ) {

		return this.world.subarray( index * 16, index * 16 + 16 );

	}

	/**
	 * The 16 world-to-object floats for `index`, inverted on demand. Allocates — per-mesh work
	 * only; the TLAS build inverts into its own scratch.
	 */
	matrixInverseOf( index ) {

		return invertAffineInto( this.world, index * 16, new Float64Array( 16 ) );

	}

	/** Writes this placement's world-space bounds into `out` at `off`. */
	writeWorldAABB( index, out, off ) {

		if ( ! this.isSet[ index ] ) {

			for ( let k = 0; k < 6; k ++ ) out[ off + k ] = 0;
			return;

		}

		transformAABBInto( this.tplObjectAABB, this.sourceMesh[ index ] * 6, this.world, index * 16, out, off );

	}

	/**
	 * Every placement's world-space bounds, 6 floats each — what the TLAS sorts on.
	 * @param {Float64Array|Float32Array} out
	 */
	writeWorldAABBs( out ) {

		const aabb = this.tplObjectAABB, world = this.world, src = this.sourceMesh, set = this.isSet;

		for ( let i = 0; i < this.count; i ++ ) {

			const o = i * 6;

			if ( ! set[ i ] ) {

				out[ o ] = 0; out[ o + 1 ] = 0; out[ o + 2 ] = 0;
				out[ o + 3 ] = 0; out[ o + 4 ] = 0; out[ o + 5 ] = 0;
				continue;

			}

			transformAABBInto( aabb, src[ i ] * 6, world, i * 16, out, o );

		}

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

		const t = this.sourceMesh[ i ];
		const owner = this.tplOwner[ t ];

		return {
			meshIndex: i,
			blasOffset: this.tplBlasOffset[ t ],
			blasNodeCount: this.tplNodeCount[ t ],
			triOffset: this.tplTriOffset[ t ],
			triCount: this.tplTriCount[ t ],
			expandedStart: this.tplExpandedStart[ t ],
			sourceMesh: t,
			sharedFrom: owner === i ? null : owner,
			matrixWorld: this.matrixWorldOf( i ),
			matrixInverse: this.matrixInverseOf( i ),
			flipWinding: !! this.flipWinding[ i ],
			bvhToOriginal: this.bvhToOriginal.get( t ) || null,
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
	 * Compute object-space AABBs for every template from its BLAS root node.
	 * O(1) per template for inner roots; falls back to a triangle scan for leaf roots (rare).
	 *
	 * @param {Float32Array} triangleData - Global triangle data (needed for leaf-root fallback)
	 */
	computeAABBs( triangleData ) {

		for ( let t = 0; t < this.templateCount; t ++ ) {

			if ( this.tplOwner[ t ] < 0 ) continue;
			const blas = this.blasData.get( t );
			if ( blas ) this._readRootAABB( blas, t, triangleData, this.tplObjectAABB, t * 6 );

		}

		// Templates aliasing another's BLAS share its object bounds; only the transform differs.
		for ( let t = 0; t < this.templateCount; t ++ ) {

			const owner = this.tplOwner[ t ];
			if ( owner < 0 || this.blasData.has( t ) ) continue;
			const ot = this.sourceMesh[ owner ];
			if ( ot !== t ) this.tplObjectAABB.copyWithin( t * 6, ot * 6, ot * 6 + 6 );

		}

	}

	/**
	 * Recompute a placement's template bounds after its BLAS was refit.
	 * Reads from the combined bvhData buffer at the BLAS root offset.
	 *
	 * @param {number} entryIndex
	 * @param {Float32Array} combinedBvhData - The assembled BVH buffer (TLAS + BLASes)
	 * @param {Float32Array} triangleData - Global triangle data (for leaf-root fallback)
	 */
	recomputeAABB( entryIndex, combinedBvhData, triangleData ) {

		const t = this.sourceMesh[ entryIndex ];
		const root = this.tplBlasOffset[ t ] * 16;
		this._readRootAABB(
			combinedBvhData.subarray( root, root + 16 ), t, triangleData,
			this.tplObjectAABB, t * 6
		);

	}

	/**
	 * Read the root node's AABB from a flat BVH data array into `out` at `off`.
	 * Inner root: union of left+right child AABBs (O(1)).
	 * Leaf root: scan triangles (rare — only meshes with <= maxLeafSize tris).
	 * @private
	 */
	_readRootAABB( bvhData, template, triangleData, out, off ) {

		if ( ! bvhData || bvhIndexView( bvhData )[ 3 ] === BVH_LEAF_MARKERS.TRIANGLE_LEAF ) {

			// Root is a leaf — very small mesh. Scan its triangles.
			this._computeAABBFromTriangles( template, triangleData, out, off );
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
	_computeAABBFromTriangles( template, triangleData, out, off ) {

		const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
		// Flat array or ChunkedRecords: resolve the chunk once per triangle either way.
		const chunked = triangleData && triangleData.chunks ? triangleData.viewAs( Float32Array ) : null;
		const flat = chunked ? null : ( triangleData instanceof Float32Array
			? triangleData
			: new Float32Array( triangleData.buffer, triangleData.byteOffset, triangleData.length ) );
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		const triOffset = this.tplTriOffset[ template ], triCount = this.tplTriCount[ template ];
		for ( let t = 0; t < triCount; t ++ ) {

			const gi = triOffset + t;
			const tri = chunked ? chunked.chunkFor( gi ) : flat;
			const base = chunked ? chunked.baseOf( gi ) : gi * FPT;

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

		for ( let t = 0; t < this.templateCount; t ++ ) {

			const owner = this.tplOwner[ t ];
			if ( owner < 0 || this.sourceMesh[ owner ] !== t ) continue;
			this.tplBlasOffset[ t ] = offset;
			offset += this.tplNodeCount[ t ];

		}

		for ( let t = 0; t < this.templateCount; t ++ ) {

			const owner = this.tplOwner[ t ];
			if ( owner < 0 ) continue;
			const ot = this.sourceMesh[ owner ];
			if ( ot !== t ) this.tplBlasOffset[ t ] = this.tplBlasOffset[ ot ];

		}

		this.totalBLASNodes = offset - tlasNodeCount;
		assertBVHIndexFits( offset, 'combined TLAS + BLAS node count' );

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
