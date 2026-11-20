/**
 * pbrt's mesh refinement: Loop subdivision for the `loopsubdiv` shape, and a `plymesh`'s displacement (end of file).
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

// ── Displacement: pbrt-v4's TriQuadMesh::Displace (util/mesh.h), for a `plymesh` naming a `displacement` texture ──

/** pbrt's ComputeNormals: each vertex the normalised sum of its triangles' unit normals, zero where none has area. */
export function pbrtVertexNormals( P, indices, nv = P.length / 3 ) {

	const N = new Float32Array( nv * 3 );
	for ( let t = 0; t + 2 < indices.length; t += 3 ) {

		const a = indices[ t ] * 3, b = indices[ t + 1 ] * 3, c = indices[ t + 2 ] * 3;
		const ux = P[ b ] - P[ a ], uy = P[ b + 1 ] - P[ a + 1 ], uz = P[ b + 2 ] - P[ a + 2 ];
		const vx = P[ c ] - P[ b ], vy = P[ c + 1 ] - P[ b + 1 ], vz = P[ c + 2 ] - P[ b + 2 ];
		const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
		const length = Math.hypot( x, y, z );
		if ( length === 0 ) continue;
		for ( const v of [ a, b, c ] ) {

			N[ v ] += x / length; N[ v + 1 ] += y / length; N[ v + 2 ] += z / length;

		}

	}

	normalizeEach( N );
	return N;

}

function normalizeEach( N ) {

	for ( let i = 0; i < N.length; i += 3 ) {

		const length = Math.hypot( N[ i ], N[ i + 1 ], N[ i + 2 ] );
		if ( length > 0 ) {

			N[ i ] /= length; N[ i + 1 ] /= length; N[ i + 2 ] /= length;

		}

	}

}

// Midpoints rounded as pbrt's floats round them, so the count and the build split alike.
const half = ( a, b ) => Math.fround( a + b ) / 2;

/** An edge's length through the shape's transform (`e`: a column-major 4×4, its translation cancelling). */
function edgeLength( e, P, i, j ) {

	const x = P[ j ] - P[ i ], y = P[ j + 1 ] - P[ i + 1 ], z = P[ j + 2 ] - P[ i + 2 ];
	return Math.hypot( e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z, e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z, e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z );

}

/**
 * The first two vertices of pbrt's order: the longest edge first, its ties broken as pbrt's comparisons break them.
 * @returns {number} 0, 1 or 2: the rotation of (v0, v1, v2)
 */
function longestFirst( d01, d12, d20 ) {

	if ( d01 > d12 ) return d01 > d20 ? 0 : 2;
	return d12 > d20 ? 1 : 2;

}

/**
 * The triangles pbrt's Refine makes from every `stride`-th triangle, counted without building them. Past `limit` it
 * stops and returns its count extrapolated over the triangles it did not reach (more than `limit`).
 */
function countRefined( P, indices, e, maxDist, limit, stride = 1 ) {

	let stack = new Float64Array( 9 * 64 );
	const p = new Float64Array( 9 );
	let count = 0;

	for ( let t = 0; t + 2 < indices.length; t += 3 * stride ) {

		for ( let k = 0; k < 3; k ++ ) for ( let c = 0; c < 3; c ++ ) stack[ k * 3 + c ] = P[ indices[ t + k ] * 3 + c ];
		let top = 1;

		while ( top > 0 ) {

			top --;
			for ( let i = 0; i < 9; i ++ ) p[ i ] = stack[ top * 9 + i ];
			const d01 = edgeLength( e, p, 0, 3 ), d12 = edgeLength( e, p, 3, 6 ), d20 = edgeLength( e, p, 6, 0 );
			if ( d01 < maxDist && d12 < maxDist && d20 < maxDist ) {

				if ( ++ count > limit ) return count * Math.ceil( indices.length / 3 / stride ) / ( t / 3 / stride + 1 );
				continue;

			}

			const r = longestFirst( d01, d12, d20 );
			const v0 = r * 3, v1 = ( ( r + 1 ) % 3 ) * 3, v2 = ( ( r + 2 ) % 3 ) * 3;
			if ( ( top + 2 ) * 9 > stack.length ) {

				const grown = new Float64Array( stack.length * 2 );
				grown.set( stack );
				stack = grown;

			}

			const at = top * 9;
			for ( let c = 0; c < 3; c ++ ) {

				const mid = half( p[ v0 + c ], p[ v1 + c ] );
				// ( mid, v1, v2 ) under ( v0, mid, v2 ): popped first, as pbrt recurses.
				stack[ at + c ] = mid; stack[ at + 3 + c ] = p[ v1 + c ]; stack[ at + 6 + c ] = p[ v2 + c ];
				stack[ at + 9 + c ] = p[ v0 + c ]; stack[ at + 12 + c ] = mid; stack[ at + 15 + c ] = p[ v2 + c ];

			}

			top += 2;

		}

	}

	return count;

}

/**
 * The edge length to refine to, and its triangle count: the one asked for, or past `cap` triangles a longer one whose
 * count lands just under it. Counts are taken on a sample of the triangles first (the count goes about as 1 / length²),
 * then checked whole.
 */
function fitEdgeLength( P, indices, ctm, requested, cap ) {

	let estimate = countRefined( P, indices, ctm, requested, cap );
	if ( estimate <= cap ) return { length: requested, count: estimate };
	const stride = Math.max( 1, Math.ceil( indices.length / 3 / 65536 ) );
	let length = requested;
	for ( let i = 0; i < 16 && ( estimate > 0.95 * cap || estimate < 0.75 * cap ); i ++ ) {

		length = Math.max( requested, length * Math.sqrt( estimate / ( 0.85 * cap ) ) );
		estimate = countRefined( P, indices, ctm, length, Math.ceil( 2 * cap / stride ), stride ) * stride;

	}

	let count;
	while ( ( count = countRefined( P, indices, ctm, length, cap ) ) > cap ) length *= 1.05;
	return { length, count };

}

/** Edge → midpoint vertex, open addressing over typed arrays: a Map held ~70 B an edge. */
class EdgeMidpoints {

	constructor( edges ) {

		let size = 16;
		while ( size < edges * 2 ) size *= 2;
		this.mask = size - 1;
		this.lo = new Int32Array( size ).fill( - 1 );
		this.hi = new Int32Array( size );
		this.vertex = new Int32Array( size );

	}

	slot( lo, hi ) {

		let h = ( Math.imul( lo, 0x9e3779b1 ) ^ Math.imul( hi, 0x85ebca77 ) ) >>> 0;
		h = ( h ^ ( h >>> 15 ) ) & this.mask;
		while ( this.lo[ h ] !== - 1 && ( this.lo[ h ] !== lo || this.hi[ h ] !== hi ) ) h = ( h + 1 ) & this.mask;
		return h;

	}

}

/**
 * pbrt-v4's displacement of a triangle mesh: `refineMesh`, then `displaceRefined` (the split lets the refinement run
 * in a worker while the height, a function, stays on the page).
 */
export function displaceMesh( mesh, options ) {

	return displaceRefined( refineMesh( mesh, options ), options.height );

}

/**
 * pbrt-v4's Refine for displacement: every triangle's longest edge halved until each edge is shorter than
 * `edgeLength` (measured through `ctm`), a split edge's midpoint shared by both its triangles, its normal and uv
 * averaged. A mesh without normals takes pbrt's own first. Past `maxTriangles` the edge length grows until it fits.
 * @param {{ position: ArrayLike<number>, normal?: ArrayLike<number>|null, uv: ArrayLike<number>, index?: ArrayLike<number>|null, faces?: ArrayLike<number>|null }} mesh - `faces` one id a triangle (Ptex), carried to its pieces
 * @param {{ edgeLength: number, ctm: ArrayLike<number>, maxTriangles?: number }} options
 * @returns {{ position: Float32Array, normal: Float32Array, uv: Float32Array, index: Uint32Array, faces: Int32Array|null, edgeLength: number }} `edgeLength` the one used
 */
export function refineMesh( mesh, { edgeLength: requested, ctm, maxTriangles = 2000000 } ) {

	const nv0 = mesh.position.length / 3;
	const indices = mesh.index ?? Uint32Array.from( { length: nv0 }, ( _, i ) => i );
	const triangles = Math.floor( indices.length / 3 );
	// Counted on the positions as the build reads them, pbrt's floats: a double-precision .ply splits alike in both.
	const position = mesh.position instanceof Float32Array ? mesh.position : Float32Array.from( mesh.position );

	// A mesh at the cap already is moved as it is: no edge length brings it under.
	const { length: maxDist, count } = triangles >= maxTriangles
		? { length: Infinity, count: triangles }
		: fitEdgeLength( position, indices, ctm, requested > 0 ? requested : 1, maxTriangles );

	const cap = nv0 + count - triangles;
	const P = new Float32Array( cap * 3 ), N = new Float32Array( cap * 3 ), UV = new Float32Array( cap * 2 );
	P.set( position );
	N.set( mesh.normal ?? pbrtVertexNormals( position, indices, nv0 ) );
	UV.set( mesh.uv );
	const out = new Uint32Array( count * 3 );
	const faces = mesh.faces ? new Int32Array( count ) : null;
	const edges = new EdgeMidpoints( count - triangles );

	let nv = nv0, o = 0;
	let stack = new Int32Array( 3 * 64 );
	const v = [ 0, 0, 0 ];

	for ( let t = 0; t < triangles; t ++ ) {

		stack[ 0 ] = indices[ 3 * t ]; stack[ 1 ] = indices[ 3 * t + 1 ]; stack[ 2 ] = indices[ 3 * t + 2 ];
		let top = 1;

		while ( top > 0 ) {

			top --;
			const a = stack[ top * 3 ], b = stack[ top * 3 + 1 ], c = stack[ top * 3 + 2 ];
			const d01 = edgeLength( ctm, P, a * 3, b * 3 ), d12 = edgeLength( ctm, P, b * 3, c * 3 ), d20 = edgeLength( ctm, P, c * 3, a * 3 );
			if ( d01 < maxDist && d12 < maxDist && d20 < maxDist ) {

				if ( o === out.length ) throw new Error( `refineMesh: built past the ${count} triangles counted` );
				if ( faces ) faces[ o / 3 ] = mesh.faces[ t ];
				out[ o ++ ] = a; out[ o ++ ] = b; out[ o ++ ] = c;
				continue;

			}

			const r = longestFirst( d01, d12, d20 );
			v[ 0 ] = r === 0 ? a : r === 1 ? b : c;
			v[ 1 ] = r === 0 ? b : r === 1 ? c : a;
			v[ 2 ] = r === 0 ? c : r === 1 ? a : b;

			const lo = Math.min( v[ 0 ], v[ 1 ] ), hi = Math.max( v[ 0 ], v[ 1 ] );
			const slot = edges.slot( lo, hi );
			let mid = edges.vertex[ slot ];
			if ( edges.lo[ slot ] === - 1 ) {

				if ( nv === cap ) throw new Error( `refineMesh: split past the ${count} triangles counted` );
				mid = nv ++;
				edges.lo[ slot ] = lo; edges.hi[ slot ] = hi; edges.vertex[ slot ] = mid;
				const p = v[ 0 ] * 3, q = v[ 1 ] * 3, m = mid * 3;
				for ( let k = 0; k < 3; k ++ ) {

					P[ m + k ] = half( P[ p + k ], P[ q + k ] );
					N[ m + k ] = N[ p + k ] + N[ q + k ];

				}

				const length = Math.hypot( N[ m ], N[ m + 1 ], N[ m + 2 ] );
				if ( length > 0 ) {

					N[ m ] /= length; N[ m + 1 ] /= length; N[ m + 2 ] /= length;

				}

				UV[ mid * 2 ] = half( UV[ v[ 0 ] * 2 ], UV[ v[ 1 ] * 2 ] );
				UV[ mid * 2 + 1 ] = half( UV[ v[ 0 ] * 2 + 1 ], UV[ v[ 1 ] * 2 + 1 ] );

			}

			if ( ( top + 2 ) * 3 > stack.length ) {

				const grown = new Int32Array( stack.length * 2 );
				grown.set( stack );
				stack = grown;

			}

			const at = top * 3;
			stack[ at ] = mid; stack[ at + 1 ] = v[ 1 ]; stack[ at + 2 ] = v[ 2 ];
			stack[ at + 3 ] = v[ 0 ]; stack[ at + 4 ] = mid; stack[ at + 5 ] = v[ 2 ];
			top += 2;

		}

	}

	if ( o !== out.length ) throw new Error( `refineMesh: counted ${count} triangles, built ${o / 3}` );
	const trim = ( a, n ) => ( n < a.length ? a.slice( 0, n ) : a );
	return { position: trim( P, nv * 3 ), normal: trim( N, nv * 3 ), uv: trim( UV, nv * 2 ), index: out, faces, edgeLength: maxDist };

}

/**
 * pbrt's Displace on a refined mesh, in place: each vertex moved along its normal by `height( u, v )`, then the normals
 * rebuilt from the moved surface.
 */
export function displaceRefined( refined, height ) {

	const { position, normal: N, uv } = refined;
	for ( let i = 0; i < position.length / 3; i ++ ) {

		const d = height( uv[ 2 * i ], uv[ 2 * i + 1 ] );
		if ( d === 0 || ! Number.isFinite( d ) ) continue;
		position[ 3 * i ] += d * N[ 3 * i ]; position[ 3 * i + 1 ] += d * N[ 3 * i + 1 ]; position[ 3 * i + 2 ] += d * N[ 3 * i + 2 ];

	}

	refined.normal = pbrtVertexNormals( position, refined.index, position.length / 3 );
	return refined;

}
