/**
 * Loop subdivision for pbrt's `loopsubdiv` shape.
 *
 * Mirrors pbrt-v4's loopsubdiv.cpp: Warren's simplified beta for the even-vertex
 * one-ring rule, 1/8 for the boundary rule, 3/8–1/8 for interior edge points, and a
 * final push onto the limit surface. Scenes use this shape for exactly the objects
 * that read wrong as a coarse cage — a tub, a cushion, a curtain — so approximating
 * it by its control mesh is visibly not the same model.
 *
 * Topology is rebuilt per level from the index buffer alone; no half-edge structure,
 * since the meshes involved are control cages (thousands of faces, not millions).
 */

/** pbrt: Beta(valence) — the one-ring weight for an interior even vertex. */
function beta( valence ) {

	return valence === 3 ? 3 / 16 : 3 / ( 8 * valence );

}

/** pbrt: LoopGamma(valence) — the one-ring weight for the limit-surface push. */
function loopGamma( valence ) {

	return 1 / ( valence + 3 / ( 8 * beta( valence ) ) );

}

/**
 * Edge records plus per-vertex neighbour rings.
 *
 * A vertex is on the boundary when it touches an edge with a single adjacent face;
 * `boundaryRing` keeps only those neighbours, because the boundary rule weights the
 * two vertices along the boundary curve, not the whole ring.
 */
function buildTopology( nv, indices ) {

	const edgeIndex = new Map();
	const edgeV0 = [], edgeV1 = [], edgeOpp0 = [], edgeOpp1 = [], edgeFaces = [];
	const faceCount = indices.length / 3;

	for ( let f = 0; f < faceCount; f ++ ) {

		for ( let e = 0; e < 3; e ++ ) {

			const a = indices[ f * 3 + e ];
			const b = indices[ f * 3 + ( e + 1 ) % 3 ];
			const opposite = indices[ f * 3 + ( e + 2 ) % 3 ];
			const lo = a < b ? a : b;
			const hi = a < b ? b : a;
			const key = lo * nv + hi;

			const existing = edgeIndex.get( key );
			if ( existing === undefined ) {

				edgeIndex.set( key, edgeV0.length );
				edgeV0.push( lo );
				edgeV1.push( hi );
				edgeOpp0.push( opposite );
				edgeOpp1.push( - 1 );
				edgeFaces.push( 1 );

			} else {

				if ( edgeOpp1[ existing ] < 0 ) edgeOpp1[ existing ] = opposite;
				edgeFaces[ existing ] ++;

			}

		}

	}

	const ring = Array.from( { length: nv }, () => [] );
	const boundaryRing = Array.from( { length: nv }, () => [] );

	for ( let i = 0; i < edgeV0.length; i ++ ) {

		const v0 = edgeV0[ i ], v1 = edgeV1[ i ];
		ring[ v0 ].push( v1 );
		ring[ v1 ].push( v0 );

		if ( edgeFaces[ i ] === 1 ) {

			boundaryRing[ v0 ].push( v1 );
			boundaryRing[ v1 ].push( v0 );

		}

	}

	return { edgeIndex, edgeV0, edgeV1, edgeOpp0, edgeOpp1, edgeFaces, ring, boundaryRing };

}

/**
 * Reposition every vertex by a one-ring weighting: (1 - n·w)·v + w·Σring for an
 * interior vertex, (1 - 2w)·v + w·(both boundary neighbours) on a boundary. Used for
 * both the even-vertex step and the limit push, which differ only in the weights.
 */
function weightVertices( P, topology, nv, interiorWeight, boundaryWeight ) {

	const out = new Float64Array( P.length );

	for ( let v = 0; v < nv; v ++ ) {

		const base = v * 3;
		const boundary = topology.boundaryRing[ v ];

		// Anything other than a clean two-neighbour boundary (a wire edge, a
		// non-manifold fan) has no defined rule — leave the vertex where it is.
		if ( boundary.length === 2 ) {

			const a = boundary[ 0 ] * 3, b = boundary[ 1 ] * 3;
			const centre = 1 - 2 * boundaryWeight;
			for ( let k = 0; k < 3; k ++ ) {

				out[ base + k ] = centre * P[ base + k ] + boundaryWeight * ( P[ a + k ] + P[ b + k ] );

			}

			continue;

		}

		const ring = topology.ring[ v ];
		const n = ring.length;
		if ( n === 0 || boundary.length > 0 ) {

			for ( let k = 0; k < 3; k ++ ) out[ base + k ] = P[ base + k ];
			continue;

		}

		const w = interiorWeight( n );
		let sx = 0, sy = 0, sz = 0;
		for ( let i = 0; i < n; i ++ ) {

			const r = ring[ i ] * 3;
			sx += P[ r ];
			sy += P[ r + 1 ];
			sz += P[ r + 2 ];

		}

		const centre = 1 - n * w;
		out[ base ] = centre * P[ base ] + w * sx;
		out[ base + 1 ] = centre * P[ base + 1 ] + w * sy;
		out[ base + 2 ] = centre * P[ base + 2 ] + w * sz;

	}

	return out;

}

/** One subdivision step: 4 faces per face, one new vertex per edge. */
function subdivideOnce( P, indices ) {

	const nv = P.length / 3;
	const topology = buildTopology( nv, indices );
	const edgeCount = topology.edgeV0.length;

	const even = weightVertices( P, topology, nv, beta, 1 / 8 );
	const out = new Float64Array( ( nv + edgeCount ) * 3 );
	out.set( even );

	for ( let i = 0; i < edgeCount; i ++ ) {

		const v0 = topology.edgeV0[ i ] * 3;
		const v1 = topology.edgeV1[ i ] * 3;
		const dst = ( nv + i ) * 3;
		const opp1 = topology.edgeOpp1[ i ];

		if ( opp1 < 0 ) {

			for ( let k = 0; k < 3; k ++ ) out[ dst + k ] = 0.5 * ( P[ v0 + k ] + P[ v1 + k ] );

		} else {

			const o0 = topology.edgeOpp0[ i ] * 3, o1 = opp1 * 3;
			for ( let k = 0; k < 3; k ++ ) {

				out[ dst + k ] = 0.375 * ( P[ v0 + k ] + P[ v1 + k ] ) + 0.125 * ( P[ o0 + k ] + P[ o1 + k ] );

			}

		}

	}

	const faceCount = indices.length / 3;
	const outIndices = new Int32Array( faceCount * 12 );
	const midpoint = ( a, b ) => nv + topology.edgeIndex.get( ( a < b ? a : b ) * nv + ( a < b ? b : a ) );

	for ( let f = 0; f < faceCount; f ++ ) {

		const a = indices[ f * 3 ], b = indices[ f * 3 + 1 ], c = indices[ f * 3 + 2 ];
		const ab = midpoint( a, b ), bc = midpoint( b, c ), ca = midpoint( c, a );
		const o = f * 12;

		outIndices[ o ] = a; outIndices[ o + 1 ] = ab; outIndices[ o + 2 ] = ca;
		outIndices[ o + 3 ] = ab; outIndices[ o + 4 ] = b; outIndices[ o + 5 ] = bc;
		outIndices[ o + 6 ] = ca; outIndices[ o + 7 ] = bc; outIndices[ o + 8 ] = c;
		outIndices[ o + 9 ] = ab; outIndices[ o + 10 ] = bc; outIndices[ o + 11 ] = ca;

	}

	return { positions: out, indices: outIndices };

}

/**
 * @param {ArrayLike<number>} P - control-cage positions, 3 per vertex
 * @param {ArrayLike<number>} indices - control-cage triangles, 3 per face
 * @param {number} levels - refinement steps; each multiplies face count by 4
 * @param {number} [maxTriangles=2000000] - stop refining early rather than exhaust memory
 * @returns {{positions: Float32Array, indices: Uint32Array, levels: number}} levels actually applied
 */
export function loopSubdivide( P, indices, levels, maxTriangles = 2000000 ) {

	let positions = Float64Array.from( P );
	let faces = Int32Array.from( indices );
	let applied = 0;

	for ( let i = 0; i < levels; i ++ ) {

		if ( faces.length / 3 * 4 > maxTriangles ) break;
		const step = subdivideOnce( positions, faces );
		positions = step.positions;
		faces = step.indices;
		applied ++;

	}

	const nv = positions.length / 3;
	const limit = weightVertices( positions, buildTopology( nv, faces ), nv, loopGamma, 1 / 5 );

	return { positions: Float32Array.from( limit ), indices: Uint32Array.from( faces ), levels: applied };

}
