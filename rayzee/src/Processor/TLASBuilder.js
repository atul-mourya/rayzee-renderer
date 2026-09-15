/**
 * TLASBuilder — Builds a Top-Level Acceleration Structure (TLAS) from mesh AABBs.
 *
 * Produces a small SAH BVH where leaves are BLAS-pointer nodes (marker -2)
 * that reference per-mesh BLAS root indices in the combined BVH buffer.
 *
 * Single pass: entry indices are partitioned in place inside one Int32Array and nodes are
 * written straight into the final flat buffer. There is no intermediate node tree — the
 * previous build allocated one JS object per node plus two fresh index arrays per split and
 * then walked the result three times, which at 5M placements cost 20.8 s and 7.7 GB of
 * transient heap and was the scene's hard ceiling, well before triangles or VRAM.
 *
 * Every leaf holds exactly one entry, so a subtree over k entries occupies exactly 2k-1
 * consecutive pre-order nodes. That makes both the total node count and each child's index
 * known before its subtree is built, which is what lets the write be single-pass.
 */

import { BVH_LEAF_MARKERS, assertBVHIndexFits, bvhIndexView } from '../EngineDefaults.js';
import { invertAffineInto } from './InstanceTable.js';

const FLOATS_PER_NODE = 16;
const SAH_BINS = 16;
// Most nodes in a deep tree hold a handful of entries, and clearing 3x16 bins then sweeping
// them costs far more than binning four AABBs. Bin count follows the range instead.
const binsFor = count => ( count < SAH_BINS ? count : SAH_BINS );
// Below this, clearing bins and sweeping them costs more than the split is worth; a median on
// the widest centroid axis is a rounding error apart in tree quality at this size.
const SMALL_NODE = 8;
// Recursing into the smaller half and looping on the larger keeps depth at O(log n), so a
// pathological split chain cannot grow the stack to n frames.
const INITIAL_STACK_FRAMES = 64;
// One affine inverse is live at a time while leaves are filled.
const _inverseScratch = new Float64Array( 16 );

export class TLASBuilder {

	constructor() {

		// Cached flatten buffer — reused across rebuilds to avoid per-refit allocation.
		this._flatBuffer = null;
		this._flatBufferCapacity = 0;

		// Binning scratch, reused across every node.
		this._binCounts = new Int32Array( SAH_BINS * 3 ); // all three axes, binned in one pass
		this._binBounds = new Float64Array( SAH_BINS * 6 * 3 );
		this._binSuffix = new Float64Array( SAH_BINS );
		this._binSuffixCount = new Int32Array( SAH_BINS );

		this._order = null; // entry indices, partitioned in place
		this._stackI = null; // nodeIndex, start, end per frame
		this._stackB = null; // the frame's AABB, 6 doubles
		this._stackFrames = 0;
		this._sortScratch = [];
		this._suffix = null;
		this._bounds = new Float64Array( 12 ); // left half at 0, right half at 6
		this._extent = new Float64Array( 3 );
		this._cMin = new Float64Array( 3 );

	}

	/** Nodes a TLAS over `entryCount` entries will occupy. Exact: every leaf holds one entry. */
	static nodeCountFor( entryCount ) {

		return entryCount > 0 ? entryCount * 2 - 1 : 0;

	}

	/** Drop the cached flatten buffer. Worth it when the scene is large enough that holding a
	 *  spare copy of the TLAS costs more than rebuilding it does. */
	releaseFlattenBuffer() {

		this._flatBuffer = null;
		this._flatBufferCapacity = 0;

	}

	/**
	 * Build and flatten the TLAS in one pass.
	 *
	 * Inner nodes carry their children's AABBs and indices; leaves carry
	 * [blasRootNodeIndex, entryIndex, visibility, -2] followed by the instance's
	 * world-to-object matrix as three rows of four.
	 *
	 * Callers must assign BLAS offsets before calling — leaf payloads are written as the tree
	 * is built, so `entry.blasOffset` has to be final. Use {@link TLASBuilder.nodeCountFor} to
	 * get the node count the offsets depend on.
	 *
	 * Side effect: records each entry's flat leaf index on `entry.tlasLeafIndex` so visibility
	 * can later be patched in place (combinedBvhData[tlasLeafIndex*16 + 2]).
	 *
	 * @param {import('./InstanceTable.js').InstanceTable} table
	 * @returns {{ data: Float32Array, nodeCount: number }}
	 */
	build( table ) {

		const aabbs = new Float64Array( table.count * 6 );
		table.writeWorldAABBs( aabbs );
		const built = this.buildStructure( aabbs, table.count );
		TLASBuilder.fillLeaves( built.data, built.nodeCount, table );
		return built;

	}

	/**
	 * The expensive half: SAH tree over the AABBs alone, with no reference to the entry objects.
	 * Leaves are written as [0, entryIndex, 0, -2]; {@link TLASBuilder.fillLeaves} completes them.
	 * Split out so it can run in a worker — at 6M placements it is 25 s of frozen main thread.
	 *
	 * @param {ArrayLike<number>} aabb - 6 floats per entry (min xyz, max xyz)
	 * @param {number} n - entry count
	 * @returns {{ data: Float32Array, nodeCount: number }}
	 */
	buildStructure( aabb, n ) {

		const nodeCount = TLASBuilder.nodeCountFor( n );
		if ( n === 0 ) return { data: new Float32Array( 0 ), nodeCount: 0 };
		assertBVHIndexFits( nodeCount, 'TLAS node count' );

		const required = nodeCount * FLOATS_PER_NODE;
		if ( required > this._flatBufferCapacity ) {

			this._flatBuffer = new Float32Array( required );
			this._flatBufferCapacity = required;

		}

		const data = this._flatBuffer;
		const idx = bvhIndexView( data ); // index fields are u32 bit patterns, never float values

		if ( ! this._order || this._order.length < n ) this._order = new Int32Array( n );
		const order = this._order;
		for ( let i = 0; i < n; i ++ ) order[ i ] = i;

		this._ensureStack( INITIAL_STACK_FRAMES );

		let depth = 0;
		let nodeIndex = 0, start = 0, end = n;
		const bb = this._bounds;
		this._rangeBounds( aabb, order, start, end, bb, 0 );
		let minX = bb[ 0 ], minY = bb[ 1 ], minZ = bb[ 2 ];
		let maxX = bb[ 3 ], maxY = bb[ 4 ], maxZ = bb[ 5 ];

		for ( ;; ) {

			const count = end - start;

			if ( count === 1 ) {

				const o = nodeIndex * FLOATS_PER_NODE;
				idx[ o ] = 0;
				idx[ o + 1 ] = order[ start ];
				data[ o + 2 ] = 0;
				idx[ o + 3 ] = BVH_LEAF_MARKERS.BLAS_POINTER_LEAF;

			} else {

				const mid = this._partition( aabb, order, start, end, minX, minY, minZ, maxX, maxY, maxZ );
				const leftCount = mid - start;
				const leftIndex = nodeIndex + 1;
				const rightIndex = leftIndex + ( leftCount * 2 - 1 );

				const o = nodeIndex * FLOATS_PER_NODE;
				data[ o ] = bb[ 0 ]; data[ o + 1 ] = bb[ 1 ]; data[ o + 2 ] = bb[ 2 ]; idx[ o + 3 ] = leftIndex;
				data[ o + 4 ] = bb[ 3 ]; data[ o + 5 ] = bb[ 4 ]; data[ o + 6 ] = bb[ 5 ]; idx[ o + 7 ] = rightIndex;
				data[ o + 8 ] = bb[ 6 ]; data[ o + 9 ] = bb[ 7 ]; data[ o + 10 ] = bb[ 8 ]; data[ o + 11 ] = 0;
				data[ o + 12 ] = bb[ 9 ]; data[ o + 13 ] = bb[ 10 ]; data[ o + 14 ] = bb[ 11 ]; data[ o + 15 ] = 0;

				// Continue into the smaller half, stack the larger — bounds the stack at O(log n).
				const keepLeft = leftCount <= end - mid;
				const k = keepLeft ? 0 : 6, p = keepLeft ? 6 : 0;
				depth = this._push(
					depth, keepLeft ? rightIndex : leftIndex,
					keepLeft ? mid : start, keepLeft ? end : mid, bb, p
				);
				nodeIndex = keepLeft ? leftIndex : rightIndex;
				if ( keepLeft ) end = mid; else start = mid;
				minX = bb[ k ]; minY = bb[ k + 1 ]; minZ = bb[ k + 2 ];
				maxX = bb[ k + 3 ]; maxY = bb[ k + 4 ]; maxZ = bb[ k + 5 ];

				continue;

			}

			if ( depth === 0 ) break;

			depth --;
			const fi = depth * 3, fb = depth * 6;
			nodeIndex = this._stackI[ fi ]; start = this._stackI[ fi + 1 ]; end = this._stackI[ fi + 2 ];
			minX = this._stackB[ fb ]; minY = this._stackB[ fb + 1 ]; minZ = this._stackB[ fb + 2 ];
			maxX = this._stackB[ fb + 3 ]; maxY = this._stackB[ fb + 4 ]; maxZ = this._stackB[ fb + 5 ];

		}

		return { data: data.subarray( 0, required ), nodeCount };

	}

	/** @private */
	_push( depth, nodeIndex, start, end, b, off ) {

		if ( depth >= this._stackFrames ) this._ensureStack( this._stackFrames * 2 );
		const fi = depth * 3, fb = depth * 6;
		this._stackI[ fi ] = nodeIndex; this._stackI[ fi + 1 ] = start; this._stackI[ fi + 2 ] = end;
		for ( let i = 0; i < 6; i ++ ) this._stackB[ fb + i ] = b[ off + i ];
		return depth + 1;

	}

	/** @private */
	_ensureStack( frames ) {

		if ( this._stackFrames >= frames ) return;
		const grownI = new Int32Array( frames * 3 );
		const grownB = new Float64Array( frames * 6 );
		if ( this._stackI ) {

			grownI.set( this._stackI );
			grownB.set( this._stackB );

		}

		this._stackI = grownI; this._stackB = grownB; this._stackFrames = frames;

	}

	/**
	 * Fill in each leaf's BLAS pointer, visibility and world-to-object matrix, and record where
	 * the leaf landed. One O(n) pass, so it stays on the main thread while the SAH tree does not.
	 *
	 * A node is 16 floats and the BLAS pointer needs 4, so the affine inverse fits in the
	 * remaining 12: the ray moves into object space with no second binding, which matters
	 * because Shade is already at the 10 storage buffers Metal allows. The inverse is derived
	 * here rather than stored: a column of it costs 64 bytes a placement.
	 */
	static fillLeaves( data, nodeCount, table ) {

		const world = table.world, src = table.sourceMesh;
		const blasOffset = table.tplBlasOffset, visible = table.visible, leafOf = table.tlasLeafIndex;
		const idx = bvhIndexView( data );

		for ( let node = 0; node < nodeCount; node ++ ) {

			const o = node * FLOATS_PER_NODE;
			if ( idx[ o + 3 ] !== BVH_LEAF_MARKERS.BLAS_POINTER_LEAF ) continue;

			const i = idx[ o + 1 ];
			idx[ o ] = blasOffset[ src[ i ] ];
			data[ o + 2 ] = visible[ i ] ? 1.0 : 0.0;

			TLASBuilder.writeLeafMatrix( data, o, world, i );

			leafOf[ i ] = node;

		}

	}

	/**
	 * Write one leaf's world-to-object rows, the twelve floats after its payload. Called again on
	 * its own whenever a placement moves, so a rigid transform costs a matrix rather than a
	 * rewrite of the geometry the placement may be sharing.
	 *
	 * @param {Float32Array} data - the node buffer, or one chunk of it
	 * @param {number} off - float offset of the leaf within `data`
	 * @param {Float32Array} world - the instance table's object-to-world column
	 * @param {number} placement
	 */
	static writeLeafMatrix( data, off, world, placement ) {

		const inv = _inverseScratch;
		invertAffineInto( world, placement * 16, inv );

		data[ off + 4 ] = inv[ 0 ]; data[ off + 5 ] = inv[ 4 ]; data[ off + 6 ] = inv[ 8 ]; data[ off + 7 ] = inv[ 12 ];
		data[ off + 8 ] = inv[ 1 ]; data[ off + 9 ] = inv[ 5 ]; data[ off + 10 ] = inv[ 9 ]; data[ off + 11 ] = inv[ 13 ];
		data[ off + 12 ] = inv[ 2 ]; data[ off + 13 ] = inv[ 6 ]; data[ off + 14 ] = inv[ 10 ]; data[ off + 15 ] = inv[ 14 ];

	}

	/**
	 * Choose a split for order[start..end) and partition it in place.
	 * Always returns a mid strictly inside the range, so every leaf ends up holding one entry.
	 * @private
	 */
	_partition( aabb, order, start, end, minX, minY, minZ, maxX, maxY, maxZ ) {

		const count = end - start;
		let mid = 0;

		if ( count === 2 ) mid = start + 1;
		else if ( count <= SMALL_NODE ) {

			mid = start + ( count >> 1 );
			this._insertionSortRange( aabb, order, start, end, this._widestCentroidAxis( aabb, order, start, end ) );

		} else {

			// Binned SAH at every size, not just large ranges. Almost every node in a deep tree
			// holds a handful of entries, so gating the sort-based exact sweep on "small range"
			// ran it ~9.8M times at 5M placements — three sorts each, and the bulk of the build.
			mid = this._binnedSplit( aabb, order, start, end, minX, minY, minZ, maxX, maxY, maxZ );
			// The binned partition already accumulated both halves' bounds.
			if ( mid > start && mid < end ) return mid;

			mid = this._sweepSplit( aabb, order, start, end, minX, minY, minZ, maxX, maxY, maxZ );

			if ( ! ( mid > start && mid < end ) ) {

				// Median on the widest axis — degenerate AABBs, overflowed surface area, or
				// coincident centroids all land here.
				const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
				const axis = dy > dx && dy > dz ? 1 : dz > dx ? 2 : 0;
				this._sortRange( aabb, order, start, end, axis );
				mid = start + ( count >> 1 );

			}

		}

		const bb = this._bounds;
		this._rangeBounds( aabb, order, start, mid, bb, 0 );
		this._rangeBounds( aabb, order, mid, end, bb, 6 );
		return mid;

	}

	/**
	 * Binned SAH — one pass to bin, one over the bin boundaries, then an in-place partition.
	 * A node costs O(n) instead of sorting three times over.
	 * Returns `start` when the centroids are degenerate on every axis.
	 * @private
	 */
	_binnedSplit( aabb, order, start, end, minX, minY, minZ, maxX, maxY, maxZ ) {

		const parentSA = this._surfaceArea( minX, minY, minZ, maxX, maxY, maxZ );
		if ( ! ( parentSA > 0 ) || ! isFinite( parentSA ) ) return start;

		// Centroid bounds decide the bin mapping; object bounds decide the cost.
		let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
		let cMaxX = - Infinity, cMaxY = - Infinity, cMaxZ = - Infinity;
		for ( let i = start; i < end; i ++ ) {

			const a = order[ i ] * 6;
			const cx = ( aabb[ a ] + aabb[ a + 3 ] ) * 0.5;
			const cy = ( aabb[ a + 1 ] + aabb[ a + 4 ] ) * 0.5;
			const cz = ( aabb[ a + 2 ] + aabb[ a + 5 ] ) * 0.5;
			if ( cx < cMinX ) cMinX = cx; if ( cx > cMaxX ) cMaxX = cx;
			if ( cy < cMinY ) cMinY = cy; if ( cy > cMaxY ) cMaxY = cy;
			if ( cz < cMinZ ) cMinZ = cz; if ( cz > cMaxZ ) cMaxZ = cz;

		}

		// Reused, not fresh literals: at ~10M calls two small arrays per call is most of the
		// collector's work.
		const extent = this._extent, cMin = this._cMin;
		extent[ 0 ] = cMaxX - cMinX; extent[ 1 ] = cMaxY - cMinY; extent[ 2 ] = cMaxZ - cMinZ;
		cMin[ 0 ] = cMinX; cMin[ 1 ] = cMinY; cMin[ 2 ] = cMinZ;

		let bestCost = Infinity, bestAxis = - 1, bestBin = - 1;
		const counts = this._binCounts;
		const bounds = this._binBounds;

		const liveX = extent[ 0 ] > 1e-12, liveY = extent[ 1 ] > 1e-12, liveZ = extent[ 2 ] > 1e-12;
		if ( ! liveX && ! liveY && ! liveZ ) return start;

		const nBins = binsFor( end - start );
		const scaleX = liveX ? nBins / extent[ 0 ] : 0;
		const scaleY = liveY ? nBins / extent[ 1 ] : 0;
		const scaleZ = liveZ ? nBins / extent[ 2 ] : 0;

		counts.fill( 0, 0, nBins * 3 );
		for ( let b = 0; b < nBins * 3; b ++ ) {

			const o = b * 6;
			bounds[ o ] = bounds[ o + 1 ] = bounds[ o + 2 ] = Infinity;
			bounds[ o + 3 ] = bounds[ o + 4 ] = bounds[ o + 5 ] = - Infinity;

		}

		// All three axes binned in ONE sweep. Three separate passes re-read the same range
		// (and the same cache lines) three times for no extra information.
		for ( let i = start; i < end; i ++ ) {

			const a = order[ i ] * 6;
			const aMinX = aabb[ a ], aMinY = aabb[ a + 1 ], aMinZ = aabb[ a + 2 ];
			const aMaxX = aabb[ a + 3 ], aMaxY = aabb[ a + 4 ], aMaxZ = aabb[ a + 5 ];

			for ( let axis = 0; axis < 3; axis ++ ) {

				const scale = axis === 0 ? scaleX : axis === 1 ? scaleY : scaleZ;
				if ( scale === 0 ) continue;
				const c = axis === 0 ? ( aMinX + aMaxX ) * 0.5
					: axis === 1 ? ( aMinY + aMaxY ) * 0.5 : ( aMinZ + aMaxZ ) * 0.5;
				let b = ( ( c - cMin[ axis ] ) * scale ) | 0;
				if ( b < 0 ) b = 0; else if ( b >= nBins ) b = nBins - 1;

				b += axis * nBins;
				counts[ b ] ++;
				const o = b * 6;
				if ( aMinX < bounds[ o ] ) bounds[ o ] = aMinX;
				if ( aMinY < bounds[ o + 1 ] ) bounds[ o + 1 ] = aMinY;
				if ( aMinZ < bounds[ o + 2 ] ) bounds[ o + 2 ] = aMinZ;
				if ( aMaxX > bounds[ o + 3 ] ) bounds[ o + 3 ] = aMaxX;
				if ( aMaxY > bounds[ o + 4 ] ) bounds[ o + 4 ] = aMaxY;
				if ( aMaxZ > bounds[ o + 5 ] ) bounds[ o + 5 ] = aMaxZ;

			}

		}

		for ( let axis = 0; axis < 3; axis ++ ) {

			if ( ! ( extent[ axis ] > 1e-12 ) ) continue;
			const binBase = axis * nBins;

			// Suffix pass over bin boundaries, then a prefix sweep — same shape as the exact
			// version, but over 16 bins instead of n entries.
			const rightSA = this._binSuffix;
			const rightN = this._binSuffixCount;
			let sMinX = Infinity, sMinY = Infinity, sMinZ = Infinity;
			let sMaxX = - Infinity, sMaxY = - Infinity, sMaxZ = - Infinity, sCount = 0;

			for ( let b = nBins - 1; b >= 1; b -- ) {

				const o = ( binBase + b ) * 6;
				if ( bounds[ o ] < sMinX ) sMinX = bounds[ o ];
				if ( bounds[ o + 1 ] < sMinY ) sMinY = bounds[ o + 1 ];
				if ( bounds[ o + 2 ] < sMinZ ) sMinZ = bounds[ o + 2 ];
				if ( bounds[ o + 3 ] > sMaxX ) sMaxX = bounds[ o + 3 ];
				if ( bounds[ o + 4 ] > sMaxY ) sMaxY = bounds[ o + 4 ];
				if ( bounds[ o + 5 ] > sMaxZ ) sMaxZ = bounds[ o + 5 ];
				sCount += counts[ binBase + b ];
				rightSA[ b ] = sCount ? this._surfaceArea( sMinX, sMinY, sMinZ, sMaxX, sMaxY, sMaxZ ) : 0;
				rightN[ b ] = sCount;

			}

			let lMinX = Infinity, lMinY = Infinity, lMinZ = Infinity;
			let lMaxX = - Infinity, lMaxY = - Infinity, lMaxZ = - Infinity, lCount = 0;

			for ( let b = 1; b < nBins; b ++ ) {

				const o = ( binBase + b - 1 ) * 6;
				if ( bounds[ o ] < lMinX ) lMinX = bounds[ o ];
				if ( bounds[ o + 1 ] < lMinY ) lMinY = bounds[ o + 1 ];
				if ( bounds[ o + 2 ] < lMinZ ) lMinZ = bounds[ o + 2 ];
				if ( bounds[ o + 3 ] > lMaxX ) lMaxX = bounds[ o + 3 ];
				if ( bounds[ o + 4 ] > lMaxY ) lMaxY = bounds[ o + 4 ];
				if ( bounds[ o + 5 ] > lMaxZ ) lMaxZ = bounds[ o + 5 ];
				lCount += counts[ binBase + b - 1 ];

				if ( lCount === 0 || rightN[ b ] === 0 ) continue;

				const leftSA = this._surfaceArea( lMinX, lMinY, lMinZ, lMaxX, lMaxY, lMaxZ );
				const cost = 1.0 + ( leftSA * lCount + rightSA[ b ] * rightN[ b ] ) / parentSA;
				if ( cost < bestCost ) {

					bestCost = cost; bestAxis = axis; bestBin = b;

				}

			}

		}

		if ( bestAxis < 0 ) return start;

		// Two-pointer partition in place: everything below the chosen bin moves left. Both
		// halves' bounds fall out of the same sweep, so the caller needs no extra passes.
		const scale = nBins / extent[ bestAxis ];
		const base = cMin[ bestAxis ];
		const bb = this._bounds;
		bb[ 0 ] = bb[ 1 ] = bb[ 2 ] = bb[ 6 ] = bb[ 7 ] = bb[ 8 ] = Infinity;
		bb[ 3 ] = bb[ 4 ] = bb[ 5 ] = bb[ 9 ] = bb[ 10 ] = bb[ 11 ] = - Infinity;

		let i = start, j = end - 1;
		while ( i <= j ) {

			const a = order[ i ] * 6;
			const c = ( aabb[ a + bestAxis ] + aabb[ a + 3 + bestAxis ] ) * 0.5;
			let b = ( ( c - base ) * scale ) | 0;
			if ( b < 0 ) b = 0; else if ( b >= nBins ) b = nBins - 1;

			const h = b < bestBin ? 0 : 6;
			if ( aabb[ a ] < bb[ h ] ) bb[ h ] = aabb[ a ];
			if ( aabb[ a + 1 ] < bb[ h + 1 ] ) bb[ h + 1 ] = aabb[ a + 1 ];
			if ( aabb[ a + 2 ] < bb[ h + 2 ] ) bb[ h + 2 ] = aabb[ a + 2 ];
			if ( aabb[ a + 3 ] > bb[ h + 3 ] ) bb[ h + 3 ] = aabb[ a + 3 ];
			if ( aabb[ a + 4 ] > bb[ h + 4 ] ) bb[ h + 4 ] = aabb[ a + 4 ];
			if ( aabb[ a + 5 ] > bb[ h + 5 ] ) bb[ h + 5 ] = aabb[ a + 5 ];

			if ( h === 0 ) i ++;
			else {

				const t = order[ i ]; order[ i ] = order[ j ]; order[ j ] = t;
				j --;

			}

		}

		return i;

	}

	/**
	 * Exact SAH sweep over all three axes. Sorts the range once per axis into scratch, then
	 * leaves it sorted along the winning axis so the partition is already done.
	 * Returns `start` when no axis yields a valid split.
	 * @private
	 */
	_sweepSplit( aabb, order, start, end, minX, minY, minZ, maxX, maxY, maxZ ) {

		const n = end - start;
		const parentSA = this._surfaceArea( minX, minY, minZ, maxX, maxY, maxZ );
		if ( ! ( parentSA > 0 ) || ! isFinite( parentSA ) ) return start;
		const suffix = this._suffixBuffer( n );
		let bestCost = Infinity, bestAxis = - 1, bestSplit = - 1;

		for ( let axis = 0; axis < 3; axis ++ ) {

			this._sortRange( aabb, order, start, end, axis );

			// suffix[i] = bounds of order[start+i .. end-1]
			let sMinX = Infinity, sMinY = Infinity, sMinZ = Infinity;
			let sMaxX = - Infinity, sMaxY = - Infinity, sMaxZ = - Infinity;
			for ( let i = n - 1; i >= 1; i -- ) {

				const a = order[ start + i ] * 6;
				if ( aabb[ a ] < sMinX ) sMinX = aabb[ a ];
				if ( aabb[ a + 1 ] < sMinY ) sMinY = aabb[ a + 1 ];
				if ( aabb[ a + 2 ] < sMinZ ) sMinZ = aabb[ a + 2 ];
				if ( aabb[ a + 3 ] > sMaxX ) sMaxX = aabb[ a + 3 ];
				if ( aabb[ a + 4 ] > sMaxY ) sMaxY = aabb[ a + 4 ];
				if ( aabb[ a + 5 ] > sMaxZ ) sMaxZ = aabb[ a + 5 ];

				const o = i * 6;
				suffix[ o ] = sMinX; suffix[ o + 1 ] = sMinY; suffix[ o + 2 ] = sMinZ;
				suffix[ o + 3 ] = sMaxX; suffix[ o + 4 ] = sMaxY; suffix[ o + 5 ] = sMaxZ;

			}

			let lMinX = Infinity, lMinY = Infinity, lMinZ = Infinity;
			let lMaxX = - Infinity, lMaxY = - Infinity, lMaxZ = - Infinity;

			for ( let i = 1; i < n; i ++ ) {

				const a = order[ start + i - 1 ] * 6;
				if ( aabb[ a ] < lMinX ) lMinX = aabb[ a ];
				if ( aabb[ a + 1 ] < lMinY ) lMinY = aabb[ a + 1 ];
				if ( aabb[ a + 2 ] < lMinZ ) lMinZ = aabb[ a + 2 ];
				if ( aabb[ a + 3 ] > lMaxX ) lMaxX = aabb[ a + 3 ];
				if ( aabb[ a + 4 ] > lMaxY ) lMaxY = aabb[ a + 4 ];
				if ( aabb[ a + 5 ] > lMaxZ ) lMaxZ = aabb[ a + 5 ];

				const o = i * 6;
				const leftSA = this._surfaceArea( lMinX, lMinY, lMinZ, lMaxX, lMaxY, lMaxZ );
				const rightSA = this._surfaceArea(
					suffix[ o ], suffix[ o + 1 ], suffix[ o + 2 ],
					suffix[ o + 3 ], suffix[ o + 4 ], suffix[ o + 5 ]
				);

				const cost = 1.0 + ( leftSA * i + rightSA * ( n - i ) ) / parentSA;
				if ( cost < bestCost ) {

					bestCost = cost; bestAxis = axis; bestSplit = i;

				}

			}

		}

		if ( bestAxis < 0 || bestSplit <= 0 ) return start;

		// The last axis swept is 2; re-sort only if the winner was a different one.
		if ( bestAxis !== 2 ) this._sortRange( aabb, order, start, end, bestAxis );
		return start + bestSplit;

	}

	/** Widest centroid extent of order[start..end). @private */
	_widestCentroidAxis( aabb, order, start, end ) {

		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;
		for ( let i = start; i < end; i ++ ) {

			const a = order[ i ] * 6;
			const cx = ( aabb[ a ] + aabb[ a + 3 ] ) * 0.5;
			const cy = ( aabb[ a + 1 ] + aabb[ a + 4 ] ) * 0.5;
			const cz = ( aabb[ a + 2 ] + aabb[ a + 5 ] ) * 0.5;
			if ( cx < minX ) minX = cx; if ( cx > maxX ) maxX = cx;
			if ( cy < minY ) minY = cy; if ( cy > maxY ) maxY = cy;
			if ( cz < minZ ) minZ = cz; if ( cz > maxZ ) maxZ = cz;

		}

		const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
		return dy > dx && dy > dz ? 1 : dz > dx ? 2 : 0;

	}

	/** Insertion sort by centroid along `axis`; allocation-free, for a handful of entries. @private */
	_insertionSortRange( aabb, order, start, end, axis ) {

		const lo = axis, hi = 3 + axis;
		for ( let i = start + 1; i < end; i ++ ) {

			const v = order[ i ];
			const key = aabb[ v * 6 + lo ] + aabb[ v * 6 + hi ];
			let j = i - 1;
			while ( j >= start && ( aabb[ order[ j ] * 6 + lo ] + aabb[ order[ j ] * 6 + hi ] ) > key ) {

				order[ j + 1 ] = order[ j ];
				j --;

			}

			order[ j + 1 ] = v;

		}

	}

	/** Sort order[start..end) by centroid along `axis`, in place. @private */
	_sortRange( aabb, order, start, end, axis ) {

		const n = end - start;
		const scratch = this._sortScratch;
		scratch.length = n;
		for ( let i = 0; i < n; i ++ ) scratch[ i ] = order[ start + i ];

		const lo = axis, hi = 3 + axis;
		scratch.sort( ( a, b ) =>
			( aabb[ a * 6 + lo ] + aabb[ a * 6 + hi ] ) - ( aabb[ b * 6 + lo ] + aabb[ b * 6 + hi ] ) );
		for ( let i = 0; i < n; i ++ ) order[ start + i ] = scratch[ i ];

	}

	/** Grow-only scratch for the split sweep; one buffer serves every node. @private */
	_suffixBuffer( n ) {

		const need = n * 6;
		if ( ! this._suffix || this._suffix.length < need ) this._suffix = new Float64Array( need );
		return this._suffix;

	}

	/** Writes 6 doubles (min xyz, max xyz) into `out` at `off`. @private */
	_rangeBounds( aabb, order, start, end, out, off ) {

		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		for ( let i = start; i < end; i ++ ) {

			const a = order[ i ] * 6;
			if ( aabb[ a ] < minX ) minX = aabb[ a ];
			if ( aabb[ a + 1 ] < minY ) minY = aabb[ a + 1 ];
			if ( aabb[ a + 2 ] < minZ ) minZ = aabb[ a + 2 ];
			if ( aabb[ a + 3 ] > maxX ) maxX = aabb[ a + 3 ];
			if ( aabb[ a + 4 ] > maxY ) maxY = aabb[ a + 4 ];
			if ( aabb[ a + 5 ] > maxZ ) maxZ = aabb[ a + 5 ];

		}

		out[ off ] = minX; out[ off + 1 ] = minY; out[ off + 2 ] = minZ;
		out[ off + 3 ] = maxX; out[ off + 4 ] = maxY; out[ off + 5 ] = maxZ;

	}

	// ── Helpers ──

	_surfaceArea( minX, minY, minZ, maxX, maxY, maxZ ) {

		const dx = maxX - minX;
		const dy = maxY - minY;
		const dz = maxZ - minZ;
		return 2.0 * ( dx * dy + dy * dz + dz * dx );

	}

}
