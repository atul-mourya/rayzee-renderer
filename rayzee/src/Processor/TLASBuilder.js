/**
 * TLASBuilder — Builds a Top-Level Acceleration Structure (TLAS) from mesh AABBs.
 *
 * Produces a small SAH BVH where leaves are BLAS-pointer nodes (marker -2)
 * that reference per-mesh BLAS root indices in the combined BVH buffer.
 */

import { BVH_LEAF_MARKERS } from '../EngineDefaults.js';

const FLOATS_PER_NODE = 16;
const IDENTITY_16 = Object.freeze( [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );
const SAH_BINS = 16;
// Below this the exact sweep is both cheap and better than 16 bins.
const EXACT_SWEEP_MAX = 64;

class TLASNode {

	constructor() {

		this.minX = 0; this.minY = 0; this.minZ = 0;
		this.maxX = 0; this.maxY = 0; this.maxZ = 0;
		this.leftChild = null;
		this.rightChild = null;
		this.entryIndex = - 1; // Index into InstanceTable.entries (leaf only)

	}

}

export class TLASBuilder {

	constructor() {

		// Cached flatten buffer — reused across rebuilds to avoid per-refit allocation.
		this._flatBuffer = null;
		this._flatBufferCapacity = 0;

		// Binning scratch, reused across every node.
		this._binCounts = new Int32Array( SAH_BINS );
		this._binBounds = new Float64Array( SAH_BINS * 6 );
		this._binSuffix = new Float64Array( SAH_BINS );
		this._binSuffixCount = new Int32Array( SAH_BINS );

	}

	/**
	 * Build TLAS from instance table entries.
	 *
	 * @param {Array<{worldAABB: {minX,minY,minZ,maxX,maxY,maxZ}, blasOffset: number}>} entries
	 * @returns {{ root: TLASNode, nodeCount: number }}
	 */
	build( entries ) {

		if ( entries.length === 0 ) {

			return { root: null, nodeCount: 0 };

		}

		// Build array of indices for partitioning
		const indices = [];
		for ( let i = 0; i < entries.length; i ++ ) {

			indices.push( i );

		}

		const root = this._buildRecursive( entries, indices );
		const nodeCount = this._countNodes( root );

		return { root, nodeCount };

	}


	/**
	 * Binned SAH split — one pass to bin, one over the bin boundaries, then a partition.
	 * No sort and no per-node allocation beyond the two output arrays, so a node costs O(n)
	 * instead of O(n log n) three times over.
	 *
	 * Returns null when the centroids are degenerate on every axis, leaving the caller to
	 * fall back to the exact sweep and then the median split.
	 * @private
	 */
	_binnedSplit( entries, indices, minX, minY, minZ, maxX, maxY, maxZ ) {

		const n = indices.length;
		const parentSA = this._surfaceArea( minX, minY, minZ, maxX, maxY, maxZ );
		if ( ! ( parentSA > 0 ) || ! isFinite( parentSA ) ) return null;

		// Centroid bounds decide the bin mapping; object bounds decide the cost.
		let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
		let cMaxX = - Infinity, cMaxY = - Infinity, cMaxZ = - Infinity;
		for ( let i = 0; i < n; i ++ ) {

			const a = entries[ indices[ i ] ].worldAABB;
			const cx = ( a.minX + a.maxX ) * 0.5, cy = ( a.minY + a.maxY ) * 0.5, cz = ( a.minZ + a.maxZ ) * 0.5;
			if ( cx < cMinX ) cMinX = cx; if ( cx > cMaxX ) cMaxX = cx;
			if ( cy < cMinY ) cMinY = cy; if ( cy > cMaxY ) cMaxY = cy;
			if ( cz < cMinZ ) cMinZ = cz; if ( cz > cMaxZ ) cMaxZ = cz;

		}

		const extent = [ cMaxX - cMinX, cMaxY - cMinY, cMaxZ - cMinZ ];
		const cMin = [ cMinX, cMinY, cMinZ ];

		let bestCost = Infinity, bestAxis = - 1, bestBin = - 1;
		const counts = this._binCounts;
		const bounds = this._binBounds;

		for ( let axis = 0; axis < 3; axis ++ ) {

			if ( ! ( extent[ axis ] > 1e-12 ) ) continue;
			const scale = SAH_BINS / extent[ axis ];

			counts.fill( 0 );
			for ( let b = 0; b < SAH_BINS; b ++ ) {

				const o = b * 6;
				bounds[ o ] = bounds[ o + 1 ] = bounds[ o + 2 ] = Infinity;
				bounds[ o + 3 ] = bounds[ o + 4 ] = bounds[ o + 5 ] = - Infinity;

			}

			for ( let i = 0; i < n; i ++ ) {

				const a = entries[ indices[ i ] ].worldAABB;
				const c = this._centroid( a, axis );
				let b = ( ( c - cMin[ axis ] ) * scale ) | 0;
				if ( b < 0 ) b = 0; else if ( b >= SAH_BINS ) b = SAH_BINS - 1;

				counts[ b ] ++;
				const o = b * 6;
				if ( a.minX < bounds[ o ] ) bounds[ o ] = a.minX;
				if ( a.minY < bounds[ o + 1 ] ) bounds[ o + 1 ] = a.minY;
				if ( a.minZ < bounds[ o + 2 ] ) bounds[ o + 2 ] = a.minZ;
				if ( a.maxX > bounds[ o + 3 ] ) bounds[ o + 3 ] = a.maxX;
				if ( a.maxY > bounds[ o + 4 ] ) bounds[ o + 4 ] = a.maxY;
				if ( a.maxZ > bounds[ o + 5 ] ) bounds[ o + 5 ] = a.maxZ;

			}

			// Suffix pass over bin boundaries, then a prefix sweep — same shape as the exact
			// version, but over 16 bins instead of n entries.
			const rightSA = this._binSuffix;
			const rightN = this._binSuffixCount;
			let sMinX = Infinity, sMinY = Infinity, sMinZ = Infinity;
			let sMaxX = - Infinity, sMaxY = - Infinity, sMaxZ = - Infinity, sCount = 0;

			for ( let b = SAH_BINS - 1; b >= 1; b -- ) {

				const o = b * 6;
				if ( bounds[ o ] < sMinX ) sMinX = bounds[ o ];
				if ( bounds[ o + 1 ] < sMinY ) sMinY = bounds[ o + 1 ];
				if ( bounds[ o + 2 ] < sMinZ ) sMinZ = bounds[ o + 2 ];
				if ( bounds[ o + 3 ] > sMaxX ) sMaxX = bounds[ o + 3 ];
				if ( bounds[ o + 4 ] > sMaxY ) sMaxY = bounds[ o + 4 ];
				if ( bounds[ o + 5 ] > sMaxZ ) sMaxZ = bounds[ o + 5 ];
				sCount += counts[ b ];
				rightSA[ b ] = sCount ? this._surfaceArea( sMinX, sMinY, sMinZ, sMaxX, sMaxY, sMaxZ ) : 0;
				rightN[ b ] = sCount;

			}

			let lMinX = Infinity, lMinY = Infinity, lMinZ = Infinity;
			let lMaxX = - Infinity, lMaxY = - Infinity, lMaxZ = - Infinity, lCount = 0;

			for ( let b = 1; b < SAH_BINS; b ++ ) {

				const o = ( b - 1 ) * 6;
				if ( bounds[ o ] < lMinX ) lMinX = bounds[ o ];
				if ( bounds[ o + 1 ] < lMinY ) lMinY = bounds[ o + 1 ];
				if ( bounds[ o + 2 ] < lMinZ ) lMinZ = bounds[ o + 2 ];
				if ( bounds[ o + 3 ] > lMaxX ) lMaxX = bounds[ o + 3 ];
				if ( bounds[ o + 4 ] > lMaxY ) lMaxY = bounds[ o + 4 ];
				if ( bounds[ o + 5 ] > lMaxZ ) lMaxZ = bounds[ o + 5 ];
				lCount += counts[ b - 1 ];

				if ( lCount === 0 || rightN[ b ] === 0 ) continue;

				const leftSA = this._surfaceArea( lMinX, lMinY, lMinZ, lMaxX, lMaxY, lMaxZ );
				const cost = 1.0 + ( leftSA * lCount + rightSA[ b ] * rightN[ b ] ) / parentSA;
				if ( cost < bestCost ) {

					bestCost = cost; bestAxis = axis; bestBin = b;

				}

			}

		}

		if ( bestAxis < 0 ) return null;

		const scale = SAH_BINS / extent[ bestAxis ];
		const left = [], right = [];
		for ( let i = 0; i < n; i ++ ) {

			const idx = indices[ i ];
			const c = this._centroid( entries[ idx ].worldAABB, bestAxis );
			let b = ( ( c - cMin[ bestAxis ] ) * scale ) | 0;
			if ( b < 0 ) b = 0; else if ( b >= SAH_BINS ) b = SAH_BINS - 1;
			( b < bestBin ? left : right ).push( idx );

		}

		if ( left.length === 0 || right.length === 0 ) return null;
		return { left, right };

	}

	/** Grow-only scratch for the split sweep; one buffer serves every node. @private */
	_suffixBuffer( n ) {

		const need = n * 6;
		if ( ! this._suffix || this._suffix.length < need ) this._suffix = new Float64Array( need );
		return this._suffix;

	}

	/**
	 * Recursive SAH-based TLAS build.
	 * @private
	 */
	_buildRecursive( entries, indices ) {

		const node = new TLASNode();

		if ( indices.length === 1 ) {

			// Leaf — single mesh
			const entry = entries[ indices[ 0 ] ];
			const aabb = entry.worldAABB;
			node.minX = aabb.minX; node.minY = aabb.minY; node.minZ = aabb.minZ;
			node.maxX = aabb.maxX; node.maxY = aabb.maxY; node.maxZ = aabb.maxZ;
			node.entryIndex = indices[ 0 ];
			return node;

		}

		// Compute overall AABB
		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		for ( const idx of indices ) {

			const aabb = entries[ idx ].worldAABB;
			if ( aabb.minX < minX ) minX = aabb.minX;
			if ( aabb.minY < minY ) minY = aabb.minY;
			if ( aabb.minZ < minZ ) minZ = aabb.minZ;
			if ( aabb.maxX > maxX ) maxX = aabb.maxX;
			if ( aabb.maxY > maxY ) maxY = aabb.maxY;
			if ( aabb.maxZ > maxZ ) maxZ = aabb.maxZ;

		}

		node.minX = minX; node.minY = minY; node.minZ = minZ;
		node.maxX = maxX; node.maxY = maxY; node.maxZ = maxZ;

		// If only 2 entries, split trivially
		if ( indices.length === 2 ) {

			node.leftChild = this._buildRecursive( entries, [ indices[ 0 ] ] );
			node.rightChild = this._buildRecursive( entries, [ indices[ 1 ] ] );
			return node;

		}

		// Above this, binning beats sorting: the exact sweep sorts the subarray three times
		// at every node, which is what kept the build super-linear out at a million instances.
		if ( indices.length > EXACT_SWEEP_MAX ) {

			const split = this._binnedSplit( entries, indices, minX, minY, minZ, maxX, maxY, maxZ );
			if ( split ) {

				node.leftChild = this._buildRecursive( entries, split.left );
				node.rightChild = this._buildRecursive( entries, split.right );
				return node;

			}

		}

		// SAH split: try all 3 axes, pick best
		const parentSA = this._surfaceArea( minX, minY, minZ, maxX, maxY, maxZ );
		let bestCost = Infinity;
		let bestAxis = 0;
		let bestSplit = 0;

		// Only attempt SAH when surface area is finite and positive —
		// degenerate/overflow AABBs (meshes far from origin) produce NaN costs.
		if ( parentSA > 0 && isFinite( parentSA ) ) {

			const n = indices.length;
			// Suffix bounds, reused across axes. Rebuilding the right-hand box at every split
			// position is what made this quadratic: 38k instances took ~56 s, which dwarfed
			// every BLAS in the scene put together.
			const suffix = this._suffixBuffer( n );

			for ( let axis = 0; axis < 3; axis ++ ) {

				// Sort indices by centroid along axis
				const sorted = indices.slice().sort( ( a, b ) => {

					const aabbA = entries[ a ].worldAABB;
					const aabbB = entries[ b ].worldAABB;
					const cA = this._centroid( aabbA, axis );
					const cB = this._centroid( aabbB, axis );
					return cA - cB;

				} );

				// suffix[i] = bounds of sorted[i .. n-1]
				let sMinX = Infinity, sMinY = Infinity, sMinZ = Infinity;
				let sMaxX = - Infinity, sMaxY = - Infinity, sMaxZ = - Infinity;
				for ( let i = n - 1; i >= 1; i -- ) {

					const a = entries[ sorted[ i ] ].worldAABB;
					if ( a.minX < sMinX ) sMinX = a.minX;
					if ( a.minY < sMinY ) sMinY = a.minY;
					if ( a.minZ < sMinZ ) sMinZ = a.minZ;
					if ( a.maxX > sMaxX ) sMaxX = a.maxX;
					if ( a.maxY > sMaxY ) sMaxY = a.maxY;
					if ( a.maxZ > sMaxZ ) sMaxZ = a.maxZ;

					const o = i * 6;
					suffix[ o ] = sMinX; suffix[ o + 1 ] = sMinY; suffix[ o + 2 ] = sMinZ;
					suffix[ o + 3 ] = sMaxX; suffix[ o + 4 ] = sMaxY; suffix[ o + 5 ] = sMaxZ;

				}

				// Sweep left, growing the prefix box one entry at a time.
				let lMinX = Infinity, lMinY = Infinity, lMinZ = Infinity;
				let lMaxX = - Infinity, lMaxY = - Infinity, lMaxZ = - Infinity;

				for ( let i = 1; i < n; i ++ ) {

					const a = entries[ sorted[ i - 1 ] ].worldAABB;
					if ( a.minX < lMinX ) lMinX = a.minX;
					if ( a.minY < lMinY ) lMinY = a.minY;
					if ( a.minZ < lMinZ ) lMinZ = a.minZ;
					if ( a.maxX > lMaxX ) lMaxX = a.maxX;
					if ( a.maxY > lMaxY ) lMaxY = a.maxY;
					if ( a.maxZ > lMaxZ ) lMaxZ = a.maxZ;

					const o = i * 6;
					const leftSA = this._surfaceArea( lMinX, lMinY, lMinZ, lMaxX, lMaxY, lMaxZ );
					const rightSA = this._surfaceArea(
						suffix[ o ], suffix[ o + 1 ], suffix[ o + 2 ],
						suffix[ o + 3 ], suffix[ o + 4 ], suffix[ o + 5 ]
					);

					// SAH cost: traversal + (leftSA/parentSA * leftCount + rightSA/parentSA * rightCount)
					const cost = 1.0 + ( leftSA * i + rightSA * ( n - i ) ) / parentSA;

					if ( cost < bestCost ) {

						bestCost = cost;
						bestAxis = axis;
						bestSplit = i;

					}

				}

			}

		}

		// Fallback to median split when SAH fails to find a valid partition
		// (degenerate AABB, overflow surface area, or coincident centroids).
		if ( bestSplit <= 0 || bestSplit >= indices.length ) {

			bestAxis = 0;
			const dx = maxX - minX, dy = maxY - minY, dz = maxZ - minZ;
			if ( dy > dx && dy > dz ) bestAxis = 1;
			else if ( dz > dx ) bestAxis = 2;

			bestSplit = indices.length >> 1;

		}

		// Sort along best axis and split
		const sorted = indices.slice().sort( ( a, b ) => {

			return this._centroid( entries[ a ].worldAABB, bestAxis ) -
				this._centroid( entries[ b ].worldAABB, bestAxis );

		} );

		const leftIndices = sorted.slice( 0, bestSplit );
		const rightIndices = sorted.slice( bestSplit );

		node.leftChild = this._buildRecursive( entries, leftIndices );
		node.rightChild = this._buildRecursive( entries, rightIndices );

		return node;

	}

	/**
	 * Flatten TLAS tree into Float32Array.
	 * Inner nodes: same format as BVH.
	 * Leaf nodes: [blasRootNodeIndex, meshIndex, visibility, -2] then the instance's
	 * world-to-object matrix as three rows of four.
	 *
	 * Side effect: records each entry's flat leaf index on `entry.tlasLeafIndex` so that
	 * visibility can later be patched in place (combinedBvhData[tlasLeafIndex*16 + 2]).
	 *
	 * @param {TLASNode} root
	 * @param {Array<{blasOffset: number, visible: boolean, tlasLeafIndex: number}>} entries
	 * @returns {Float32Array}
	 */
	flatten( root, entries ) {

		if ( ! root ) return new Float32Array( 0 );

		// Pre-order traversal to assign flat indices
		const nodes = [];
		const stack = [ root ];
		while ( stack.length > 0 ) {

			const n = stack.pop();
			n._flatIndex = nodes.length;
			nodes.push( n );
			if ( n.rightChild ) stack.push( n.rightChild );
			if ( n.leftChild ) stack.push( n.leftChild );

		}

		// Reuse cached buffer (grow-only to avoid per-refit allocation)
		const requiredSize = nodes.length * FLOATS_PER_NODE;
		if ( requiredSize > this._flatBufferCapacity ) {

			this._flatBuffer = new Float32Array( requiredSize );
			this._flatBufferCapacity = requiredSize;

		}

		const data = this._flatBuffer;
		data.fill( 0, 0, requiredSize ); // Clear stale data

		for ( let i = 0; i < nodes.length; i ++ ) {

			const n = nodes[ i ];
			const o = i * FLOATS_PER_NODE;

			if ( n.leftChild ) {

				// Inner node — same format as BVH inner nodes
				const left = n.leftChild;
				const right = n.rightChild;

				data[ o ] = left.minX;
				data[ o + 1 ] = left.minY;
				data[ o + 2 ] = left.minZ;
				data[ o + 3 ] = left._flatIndex;

				data[ o + 4 ] = left.maxX;
				data[ o + 5 ] = left.maxY;
				data[ o + 6 ] = left.maxZ;
				data[ o + 7 ] = right._flatIndex;

				data[ o + 8 ] = right.minX;
				data[ o + 9 ] = right.minY;
				data[ o + 10 ] = right.minZ;

				data[ o + 12 ] = right.maxX;
				data[ o + 13 ] = right.maxY;
				data[ o + 14 ] = right.maxZ;

			} else {

				// Leaf node — BLAS pointer, plus the instance's world-to-object transform.
				// A node is 16 floats and the pointer needs 4, so the affine inverse fits in
				// the remaining 12: the ray moves into object space with no second binding,
				// which matters because Shade is close to the 10 storage buffers Metal allows.
				const entry = entries[ n.entryIndex ];
				data[ o ] = entry.blasOffset; // Absolute node index of BLAS root in combined buffer
				data[ o + 1 ] = n.entryIndex; // meshIndex (kept for debug/ID — traversal uses slot [2])
				data[ o + 2 ] = entry.visible === false ? 0.0 : 1.0;
				data[ o + 3 ] = BVH_LEAF_MARKERS.BLAS_POINTER_LEAF; // -2 marker

				const inv = entry.matrixInverse || IDENTITY_16;
				data[ o + 4 ] = inv[ 0 ]; data[ o + 5 ] = inv[ 4 ]; data[ o + 6 ] = inv[ 8 ]; data[ o + 7 ] = inv[ 12 ];
				data[ o + 8 ] = inv[ 1 ]; data[ o + 9 ] = inv[ 5 ]; data[ o + 10 ] = inv[ 9 ]; data[ o + 11 ] = inv[ 13 ];
				data[ o + 12 ] = inv[ 2 ]; data[ o + 13 ] = inv[ 6 ]; data[ o + 14 ] = inv[ 10 ]; data[ o + 15 ] = inv[ 14 ];

				entry.tlasLeafIndex = i;

			}

		}

		return data.subarray( 0, requiredSize );

	}

	// ── Helpers ──

	_centroid( aabb, axis ) {

		if ( axis === 0 ) return ( aabb.minX + aabb.maxX ) * 0.5;
		if ( axis === 1 ) return ( aabb.minY + aabb.maxY ) * 0.5;
		return ( aabb.minZ + aabb.maxZ ) * 0.5;

	}

	_surfaceArea( minX, minY, minZ, maxX, maxY, maxZ ) {

		const dx = maxX - minX;
		const dy = maxY - minY;
		const dz = maxZ - minZ;
		return 2.0 * ( dx * dy + dy * dz + dz * dx );

	}

	_computeGroupAABB( entries, sorted, from, to ) {

		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		for ( let i = from; i < to; i ++ ) {

			const aabb = entries[ sorted[ i ] ].worldAABB;
			if ( aabb.minX < minX ) minX = aabb.minX;
			if ( aabb.minY < minY ) minY = aabb.minY;
			if ( aabb.minZ < minZ ) minZ = aabb.minZ;
			if ( aabb.maxX > maxX ) maxX = aabb.maxX;
			if ( aabb.maxY > maxY ) maxY = aabb.maxY;
			if ( aabb.maxZ > maxZ ) maxZ = aabb.maxZ;

		}

		return { minX, minY, minZ, maxX, maxY, maxZ };

	}

	_countNodes( root ) {

		if ( ! root ) return 0;

		let count = 0;
		const stack = [ root ];
		while ( stack.length > 0 ) {

			const node = stack.pop();
			count ++;
			if ( node.leftChild ) stack.push( node.leftChild );
			if ( node.rightChild ) stack.push( node.rightChild );

		}

		return count;

	}

}
