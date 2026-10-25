/**
 * LightBVHBuilder
 *
 * CPU-side BVH builder over emissive triangles for spatially-aware light sampling.
 * Each node occupies 4 vec4s (16 floats, BVH_STRIDE=4):
 *
 *   vec4[0]: [aabb.minX, aabb.minY, aabb.minZ, totalPower]   // power = Rec.709 luma-weighted
 *   vec4[1]: [aabb.maxX, aabb.maxY, aabb.maxZ, isLeaf]       // isLeaf: 0.0=inner, 1.0=leaf
 *   vec4[2]: inner → [leftChildIdx, rightChildIdx, 0, 0]
 *            leaf  → [emissiveStart, emissiveCount, 0, 0]
 *   vec4[3]: [coneAxisX, coneAxisY, coneAxisZ, cosThetaO]    // emission orientation cone (Conty-Kulla)
 *
 * The orientation cone bounds the emission directions of the cluster (θ_o = spread of emitter
 * normals; θ_e = π/2 assumed for diffuse emitters, applied at sample time). cosThetaO = -1 means
 * "whole sphere" (mixed/two-sided cluster → never culled by orientation).
 *
 * Build algorithm: median split on longest centroid AABB axis, maxLeafSize=8.
 * Output: pre-order flattened array with left child immediately after parent.
 * Also emits a per-(sorted)-triangle bit-trail: the sequence of left(0)/right(1) child choices
 * from the root to that triangle's leaf, so the GPU can re-walk the exact descent for MIS.
 */
export class LightBVHBuilder {

	constructor() {

		this.maxLeafSize = 8;

	}

	/**
	 * Build the Light BVH over emissive triangles.
	 *
	 * @param {Array} emissiveTriangles - Array of objects:
	 *   { triangleIndex, power, area, emissive, emissiveIntensity, cx, cy, cz,
	 *     bMinX, bMinY, bMinZ, bMaxX, bMaxY, bMaxZ, nx, ny, nz, twoSided }
	 * @returns {{ nodeData: Float32Array, nodeCount: number, sortedPerm: Int32Array, bitTrails: Float32Array }}
	 *   sortedPerm[i] = original index in emissiveTriangles for position i in sorted leaf order
	 *   bitTrails[i]  = root→leaf bit-trail for the triangle now at sorted position i (as a float-encoded int)
	 */
	build( emissiveTriangles ) {

		const n = emissiveTriangles.length;
		if ( n === 0 ) {

			// Dummy leaf node — whole-sphere cone so importance never culls it
			const nodeData = new Float32Array( 16 );
			nodeData[ 7 ] = 1.0; // isLeaf
			nodeData[ 14 ] = 1.0; // cone axis z
			nodeData[ 15 ] = - 1.0; // cosThetaO = whole sphere
			return { nodeData, nodeCount: 1, sortedPerm: new Int32Array( 0 ), bitTrails: new Float32Array( 0 ) };

		}

		// Working indices into emissiveTriangles (will be reordered in-place)
		const indices = new Int32Array( n );
		for ( let i = 0; i < n; i ++ ) indices[ i ] = i;

		// Pre-allocate node storage: upper bound is 2*n nodes
		const maxNodes = 2 * n + 4;
		// Each node is 16 floats
		const nodeData = new Float32Array( maxNodes * 16 );
		let nodeCount = 0;

		// bit-trail per sorted position (filled at leaves). 24-bit safe → tree depth < 24 (≈16M leaf clusters).
		const bitTrails = new Float32Array( n );

		// Recursively build; returns { nodeIndex, cone }. `trail`/`depth` accumulate the root→leaf path.
		const buildRecursive = ( start, end, trail, depth ) => {

			const nodeIndex = nodeCount ++;
			const nodeOffset = nodeIndex * 16;

			// Compute AABB and total power for this range
			let minX = Infinity, minY = Infinity, minZ = Infinity;
			let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;
			let totalPower = 0;
			// Also track centroid AABB for split axis
			let cMinX = Infinity, cMinY = Infinity, cMinZ = Infinity;
			let cMaxX = - Infinity, cMaxY = - Infinity, cMaxZ = - Infinity;

			for ( let i = start; i < end; i ++ ) {

				const tri = emissiveTriangles[ indices[ i ] ];
				minX = Math.min( minX, tri.bMinX );
				minY = Math.min( minY, tri.bMinY );
				minZ = Math.min( minZ, tri.bMinZ );
				maxX = Math.max( maxX, tri.bMaxX );
				maxY = Math.max( maxY, tri.bMaxY );
				maxZ = Math.max( maxZ, tri.bMaxZ );
				totalPower += tri.power;
				cMinX = Math.min( cMinX, tri.cx );
				cMinY = Math.min( cMinY, tri.cy );
				cMinZ = Math.min( cMinZ, tri.cz );
				cMaxX = Math.max( cMaxX, tri.cx );
				cMaxY = Math.max( cMaxY, tri.cy );
				cMaxZ = Math.max( cMaxZ, tri.cz );

			}

			// vec4[0]: [minX, minY, minZ, totalPower]
			nodeData[ nodeOffset + 0 ] = minX;
			nodeData[ nodeOffset + 1 ] = minY;
			nodeData[ nodeOffset + 2 ] = minZ;
			nodeData[ nodeOffset + 3 ] = totalPower;

			// vec4[1]: [maxX, maxY, maxZ, isLeaf] — fill isLeaf below
			nodeData[ nodeOffset + 4 ] = maxX;
			nodeData[ nodeOffset + 5 ] = maxY;
			nodeData[ nodeOffset + 6 ] = maxZ;

			const count = end - start;

			let cone;

			if ( count <= this.maxLeafSize ) {

				// LEAF NODE
				nodeData[ nodeOffset + 7 ] = 1.0; // isLeaf
				nodeData[ nodeOffset + 8 ] = start; // emissiveStart
				nodeData[ nodeOffset + 9 ] = count; // emissiveCount
				nodeData[ nodeOffset + 10 ] = 0;
				nodeData[ nodeOffset + 11 ] = 0;

				// Cone = union of this leaf's triangle emission cones; write this leaf's bit-trail
				cone = null;
				for ( let i = start; i < end; i ++ ) {

					const tri = emissiveTriangles[ indices[ i ] ];
					cone = coneUnion( cone, triangleCone( tri ) );
					bitTrails[ i ] = trail;

				}

				if ( ! cone ) cone = { ax: 0, ay: 0, az: 1, cosO: - 1 };

			} else {

				// INNER NODE — find longest centroid axis and split at median
				const extX = cMaxX - cMinX;
				const extY = cMaxY - cMinY;
				const extZ = cMaxZ - cMinZ;

				let axis;
				if ( extX >= extY && extX >= extZ ) axis = 0;
				else if ( extY >= extZ ) axis = 1;
				else axis = 2;

				const axisKeys = [ 'cx', 'cy', 'cz' ];
				const axisKey = axisKeys[ axis ];

				// Partial sort: partition around median
				const mid = ( start + end ) >> 1;
				this._nthElement( indices, emissiveTriangles, start, end, mid, axisKey );

				nodeData[ nodeOffset + 7 ] = 0.0; // isLeaf = false (inner)

				// Build left child immediately after this node (pre-order), then right.
				// Trail bit at `depth`: 0 for left, 1 for right.
				const left = buildRecursive( start, mid, trail, depth + 1 );
				const right = buildRecursive( mid, end, trail + Math.pow( 2, depth ), depth + 1 );

				nodeData[ nodeOffset + 8 ] = left.nodeIndex;
				nodeData[ nodeOffset + 9 ] = right.nodeIndex;
				nodeData[ nodeOffset + 10 ] = 0;
				nodeData[ nodeOffset + 11 ] = 0;

				cone = coneUnion( left.cone, right.cone );

			}

			// vec4[3]: [coneAxisX, coneAxisY, coneAxisZ, cosThetaO]
			nodeData[ nodeOffset + 12 ] = cone.ax;
			nodeData[ nodeOffset + 13 ] = cone.ay;
			nodeData[ nodeOffset + 14 ] = cone.az;
			nodeData[ nodeOffset + 15 ] = cone.cosO;

			return { nodeIndex, cone };

		};

		buildRecursive( 0, n, 0, 0 );

		// sortedPerm: the rearranged indices array (leaf order)
		const sortedPerm = new Int32Array( n );
		for ( let i = 0; i < n; i ++ ) sortedPerm[ i ] = indices[ i ];

		// Trim nodeData to actual used size
		const trimmedData = new Float32Array( nodeCount * 16 );
		trimmedData.set( nodeData.subarray( 0, nodeCount * 16 ) );

		console.log( `[LightBVHBuilder] Built BVH: ${nodeCount} nodes for ${n} emissive triangles` );

		return { nodeData: trimmedData, nodeCount, sortedPerm, bitTrails };

	}

	/**
	 * Partial selection: rearranges indices[start..end) so that indices[k] is
	 * the element that would be at position k in a sorted array, with elements
	 * < median to the left and >= median to the right.
	 * Uses introselect (simple quickselect here).
	 * @private
	 */
	_nthElement( indices, tris, start, end, k, axisKey ) {

		while ( start < end - 1 ) {

			// Pick pivot as median of first/middle/last
			const mid = ( start + end ) >> 1;
			const pivotVal = tris[ indices[ mid ] ][ axisKey ];

			// Move pivot to end
			let tmp = indices[ mid ];
			indices[ mid ] = indices[ end - 1 ];
			indices[ end - 1 ] = tmp;

			// Partition
			let store = start;
			for ( let i = start; i < end - 1; i ++ ) {

				if ( tris[ indices[ i ] ][ axisKey ] < pivotVal ) {

					tmp = indices[ i ];
					indices[ i ] = indices[ store ];
					indices[ store ] = tmp;
					store ++;

				}

			}

			// Restore pivot
			tmp = indices[ store ];
			indices[ store ] = indices[ end - 1 ];
			indices[ end - 1 ] = tmp;

			if ( store === k ) return;
			else if ( store < k ) start = store + 1;
			else end = store;

		}

	}

}

// ================================================================================
// ORIENTATION CONE HELPERS (Conty-Estevez & Kulla 2018 / PBRT-v4 DirectionCone)
// ================================================================================

// Per-triangle emission cone: axis = geometric normal, θ_o = 0 (single direction).
// Two-sided emitters emit into both hemispheres → whole sphere (cosO = -1).
function triangleCone( tri ) {

	if ( tri.twoSided ) return { ax: tri.nx, ay: tri.ny, az: tri.nz, cosO: - 1 };
	return { ax: tri.nx, ay: tri.ny, az: tri.nz, cosO: 1 };

}

// Union of two direction cones (PBRT-v4 DirectionCone::Union). cosO === -1 ⇒ whole sphere.
function coneUnion( a, b ) {

	if ( ! a ) return b;
	if ( ! b ) return a;
	if ( a.cosO <= - 1 ) return a; // a is already whole sphere
	if ( b.cosO <= - 1 ) return b;

	const cosA = Math.min( Math.max( a.cosO, - 1 ), 1 );
	const cosB = Math.min( Math.max( b.cosO, - 1 ), 1 );
	const thetaA = Math.acos( cosA );
	const thetaB = Math.acos( cosB );
	const dotAB = Math.min( Math.max( a.ax * b.ax + a.ay * b.ay + a.az * b.az, - 1 ), 1 );
	const thetaD = Math.acos( dotAB );

	// One cone already contains the other
	if ( Math.min( thetaD + thetaB, Math.PI ) <= thetaA ) return a;
	if ( Math.min( thetaD + thetaA, Math.PI ) <= thetaB ) return b;

	const thetaO = ( thetaA + thetaB + thetaD ) * 0.5;
	if ( thetaO >= Math.PI ) return { ax: a.ax, ay: a.ay, az: a.az, cosO: - 1 };

	const thetaR = thetaO - thetaA;

	// Rotation axis = normalize(cross(a, b))
	let wx = a.ay * b.az - a.az * b.ay;
	let wy = a.az * b.ax - a.ax * b.az;
	let wz = a.ax * b.ay - a.ay * b.ax;
	const wl = Math.sqrt( wx * wx + wy * wy + wz * wz );
	if ( wl < 1e-8 ) return { ax: a.ax, ay: a.ay, az: a.az, cosO: - 1 }; // (anti)parallel → whole sphere
	wx /= wl; wy /= wl; wz /= wl;

	// Rodrigues: rotate a.axis around (wx,wy,wz) by thetaR
	const c = Math.cos( thetaR ), s = Math.sin( thetaR );
	const kdotv = wx * a.ax + wy * a.ay + wz * a.az;
	const cx = wy * a.az - wz * a.ay;
	const cy = wz * a.ax - wx * a.az;
	const cz = wx * a.ay - wy * a.ax;
	const ax = a.ax * c + cx * s + wx * kdotv * ( 1 - c );
	const ay = a.ay * c + cy * s + wy * kdotv * ( 1 - c );
	const az = a.az * c + cz * s + wz * kdotv * ( 1 - c );
	const al = Math.sqrt( ax * ax + ay * ay + az * az ) || 1;

	return { ax: ax / al, ay: ay / al, az: az / al, cosO: Math.cos( thetaO ) };

}
