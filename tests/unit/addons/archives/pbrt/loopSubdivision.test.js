import { describe, it, expect } from 'vitest';
import { loopSubdivide, displaceMesh, pbrtVertexNormals } from '@/core/addons/archives/pbrt/LoopSubdivision.js';

// Closed tetrahedron — no boundary, every vertex valence 3.
const TETRA_P = [ 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1 ];
const TETRA_I = [ 0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3 ];

// Flat 2×2 grid of quads in the z=0 plane, split into 8 triangles (has a boundary).
function flatGrid() {

	const P = [];
	for ( let y = 0; y <= 2; y ++ ) for ( let x = 0; x <= 2; x ++ ) P.push( x, y, 0 );

	const I = [];
	for ( let y = 0; y < 2; y ++ ) for ( let x = 0; x < 2; x ++ ) {

		const a = y * 3 + x, b = a + 1, c = a + 3, d = a + 4;
		I.push( a, b, d, a, d, c );

	}

	return { P, I };

}

/** Count how many faces each undirected edge touches. */
function edgeFaceCounts( indices ) {

	const counts = new Map();
	for ( let f = 0; f < indices.length / 3; f ++ ) {

		for ( let e = 0; e < 3; e ++ ) {

			const a = indices[ f * 3 + e ], b = indices[ f * 3 + ( e + 1 ) % 3 ];
			const key = `${Math.min( a, b )}_${Math.max( a, b )}`;
			counts.set( key, ( counts.get( key ) || 0 ) + 1 );

		}

	}

	return [ ...counts.values() ];

}

describe( 'Loop subdivision', () => {

	it( 'quadruples faces and adds one vertex per edge per level', () => {

		const one = loopSubdivide( TETRA_P, TETRA_I, 1 );
		expect( one.levels ).toBe( 1 );
		expect( one.indices.length / 3 ).toBe( 16 );
		expect( one.positions.length / 3 ).toBe( 4 + 6 ); // 4 corners + 6 edge midpoints

		const two = loopSubdivide( TETRA_P, TETRA_I, 2 );
		expect( two.indices.length / 3 ).toBe( 64 );

	} );

	it( 'keeps a closed mesh closed', () => {

		const { indices } = loopSubdivide( TETRA_P, TETRA_I, 2 );
		expect( new Set( edgeFaceCounts( indices ) ) ).toEqual( new Set( [ 2 ] ) );

	} );

	it( 'stays inside the control cage', () => {

		const { positions } = loopSubdivide( TETRA_P, TETRA_I, 3 );
		for ( let i = 0; i < positions.length; i ++ ) {

			expect( positions[ i ] ).toBeGreaterThanOrEqual( - 1e-5 );
			expect( positions[ i ] ).toBeLessThanOrEqual( 1 + 1e-5 );

		}

	} );

	it( 'leaves a flat surface flat, boundary included', () => {

		const { P, I } = flatGrid();
		const { positions } = loopSubdivide( P, I, 2 );

		let minX = Infinity, maxX = - Infinity;
		for ( let v = 0; v < positions.length / 3; v ++ ) {

			expect( Math.abs( positions[ v * 3 + 2 ] ) ).toBeLessThan( 1e-6 );
			minX = Math.min( minX, positions[ v * 3 ] );
			maxX = Math.max( maxX, positions[ v * 3 ] );

		}

		// The limit surface pulls the open border inward; it must not escape the cage.
		expect( minX ).toBeGreaterThanOrEqual( - 1e-6 );
		expect( maxX ).toBeLessThanOrEqual( 2 + 1e-6 );

	} );

	it( 'stops refining rather than blow the triangle budget', () => {

		const { levels, indices } = loopSubdivide( TETRA_P, TETRA_I, 6, 100 );
		expect( levels ).toBeLessThan( 6 );
		expect( indices.length / 3 ).toBeLessThanOrEqual( 100 );

	} );

	it( 'produces no NaN on a mesh with an open border', () => {

		const { P, I } = flatGrid();
		const { positions } = loopSubdivide( P, I, 3 );
		expect( positions.every( Number.isFinite ) ).toBe( true );

	} );

} );

describe( 'displaceMesh (pbrt-v4 TriQuadMesh::Displace)', () => {

	// bench/pbrt/scenes/displacement-bumps: a 2×2 plane of quads (3×3 vertices, uv, no normals), as pbrt reads its .ply
	// — each quad ( a, b, c, d ) as ( a, b, c ), ( a, c, d ).
	function plane() {

		const position = [], uv = [], index = [];
		for ( let j = 0; j < 3; j ++ ) for ( let i = 0; i < 3; i ++ ) {

			position.push( i - 1, 0, j - 1 );
			uv.push( i / 2, j / 2 );

		}

		for ( let j = 0; j < 2; j ++ ) for ( let i = 0; i < 2; i ++ ) {

			const a = j * 3 + i;
			index.push( a, a + 3, a + 4, a, a + 4, a + 1 );

		}

		return { position: Float32Array.from( position ), uv: Float32Array.from( uv ), index: Uint32Array.from( index ) };

	}

	// The scene's `Rotate 20 0 1 0  Scale 1.2 1 0.8`, column-major.
	const t = 20 * Math.PI / 180;
	const CTM = [ Math.cos( t ) * 1.2, 0, - Math.sin( t ) * 1.2, 0, 0, 1, 0, 0, Math.sin( t ) * 0.8, 0, Math.cos( t ) * 0.8, 0, 0, 0, 0, 1 ];
	const IDENTITY = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];
	const flat = () => 0;

	const worldLength = ( e, P, a, b ) => {

		const x = P[ 3 * b ] - P[ 3 * a ], y = P[ 3 * b + 1 ] - P[ 3 * a + 1 ], z = P[ 3 * b + 2 ] - P[ 3 * a + 2 ];
		return Math.hypot( e[ 0 ] * x + e[ 4 ] * y + e[ 8 ] * z, e[ 1 ] * x + e[ 5 ] * y + e[ 9 ] * z, e[ 2 ] * x + e[ 6 ] * y + e[ 10 ] * z );

	};

	it( 'refines to pbrt\'s own triangle count (pbrt-v4 --stats on the bench scene: 16384)', () => {

		const out = displaceMesh( plane(), { edgeLength: 0.045, ctm: CTM, height: flat } );
		expect( out.index.length / 3 ).toBe( 16384 );
		expect( out.position.length / 3 ).toBe( 8321 );
		expect( out.edgeLength ).toBe( 0.045 );

	} );

	it( 'leaves every edge shorter than the edge length through the transform, and no edge longer than needed split', () => {

		const out = displaceMesh( plane(), { edgeLength: 0.1, ctm: CTM, height: flat } );
		let longest = 0;
		for ( let f = 0; f < out.index.length; f += 3 ) for ( let e = 0; e < 3; e ++ ) {

			longest = Math.max( longest, worldLength( CTM, out.position, out.index[ f + e ], out.index[ f + ( e + 1 ) % 3 ] ) );

		}

		expect( longest ).toBeLessThan( 0.1 );
		// A halving too many would leave every edge under half the length.
		expect( longest ).toBeGreaterThan( 0.05 );

	} );

	it( 'shares each split edge\'s midpoint between its two triangles: no cracks, every inner edge on two triangles', () => {

		const out = displaceMesh( plane(), { edgeLength: 0.07, ctm: CTM, height: ( u, v ) => Math.sin( 9 * u ) * Math.cos( 7 * v ) } );
		const counts = new Map();
		for ( let f = 0; f < out.index.length; f += 3 ) for ( let e = 0; e < 3; e ++ ) {

			const a = out.index[ f + e ], b = out.index[ f + ( e + 1 ) % 3 ];
			const key = `${Math.min( a, b )}_${Math.max( a, b )}`;
			counts.set( key, ( counts.get( key ) ?? 0 ) + 1 );

		}

		const onBorder = ( a, b ) => {

			const p = out.uv;
			return ( p[ 2 * a ] === p[ 2 * b ] && ( p[ 2 * a ] === 0 || p[ 2 * a ] === 1 ) ) || ( p[ 2 * a + 1 ] === p[ 2 * b + 1 ] && ( p[ 2 * a + 1 ] === 0 || p[ 2 * a + 1 ] === 1 ) );

		};

		for ( const [ key, n ] of counts ) {

			const [ a, b ] = key.split( '_' ).map( Number );
			expect( n ).toBe( onBorder( a, b ) ? 1 : 2 );

		}

	} );

	it( 'moves each vertex along its normal by the height at its uv, then rebuilds the normals from the moved surface', () => {

		const out = displaceMesh( plane(), { edgeLength: 0.3, ctm: IDENTITY, height: ( u, v ) => u + 2 * v } );
		for ( let i = 0; i < out.position.length / 3; i ++ ) {

			const u = out.uv[ 2 * i ], v = out.uv[ 2 * i + 1 ];
			expect( out.position[ 3 * i ] ).toBeCloseTo( 2 * u - 1, 6 );
			expect( out.position[ 3 * i + 1 ] ).toBeCloseTo( u + 2 * v, 6 );
			expect( out.position[ 3 * i + 2 ] ).toBeCloseTo( 2 * v - 1, 6 );

		}

		// A plane y = ( x + 1 ) / 2 + ( z + 1 ): its normal is ( −½, 1, −1 ), normalised, everywhere.
		const n = [ - 0.5, 1, - 1 ].map( ( c ) => c / 1.5 );
		for ( let i = 0; i < out.normal.length; i += 3 ) for ( let c = 0; c < 3; c ++ ) expect( out.normal[ i + c ] ).toBeCloseTo( n[ c ], 5 );

	} );

	it( 'displaces along the mesh\'s own normals where it has them, averaged at a midpoint', () => {

		const mesh = plane();
		mesh.normal = new Float32Array( 27 );
		for ( let i = 0; i < 9; i ++ ) mesh.normal[ 3 * i + ( i % 2 ? 0 : 2 ) ] = 1; // +z and +x by turns
		const out = displaceMesh( mesh, { edgeLength: 0.8, ctm: IDENTITY, height: () => 0.25 } );
		// The first edge split: corner 0 (+z) with corner 3 (+x), at ( −1, 0, −½ ) before the move.
		const mid = out.uv.findIndex( ( _, i ) => i % 2 === 0 && out.uv[ i ] === 0 && out.uv[ i + 1 ] === 0.25 ) / 2;
		expect( mid ).toBeGreaterThan( 8 );
		expect( Array.from( out.position.slice( 3 * mid, 3 * mid + 3 ) ) ).toEqual( [ - 1 + 0.25 * Math.fround( Math.SQRT1_2 ), 0, - 0.5 + 0.25 * Math.fround( Math.SQRT1_2 ) ].map( Math.fround ) );

	} );

	it( 'takes pbrt\'s normals where the mesh has none: each triangle\'s unit normal counted once, whatever its area', () => {

		// A big triangle in z = 0 and a sliver tilted up to +y meeting at vertex 0: area weighting would all but ignore
		// the sliver.
		const N = pbrtVertexNormals( [ 0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 0.01, - 0.01, 0, 0 ], [ 0, 1, 2, 0, 4, 3 ] );
		expect( N[ 0 ] ).toBeCloseTo( 0, 6 );
		expect( N[ 1 ] ).toBeCloseTo( Math.SQRT1_2, 6 );
		expect( N[ 2 ] ).toBeCloseTo( Math.SQRT1_2, 6 );

	} );

	it( 'grows the edge length to keep under a cap, landing near it, and says so', () => {

		const out = displaceMesh( plane(), { edgeLength: 0.01, ctm: IDENTITY, height: flat, maxTriangles: 5000 } );
		const count = out.index.length / 3;
		expect( count ).toBeLessThanOrEqual( 5000 );
		expect( count ).toBeGreaterThanOrEqual( 0.75 * 5000 );
		expect( out.edgeLength ).toBeGreaterThan( 0.01 );
		expect( displaceMesh( plane(), { edgeLength: out.edgeLength, ctm: IDENTITY, height: flat } ).index.length / 3 ).toBe( count );

	} );

	it( 'breaks a tie for the longest edge as pbrt\'s comparisons fall', () => {

		// A 3-4-5 triangle's two sides of 5: v0–v1 and v1–v2. pbrt splits v1–v2 ( d01 > d12 is false ).
		const out = displaceMesh( { position: [ 0, 0, 0, 5, 0, 0, 2, 4, 0 ], uv: [ 0, 0, 1, 0, 0, 1 ], index: [ 0, 1, 2 ] }, { edgeLength: 4.9, ctm: IDENTITY, height: flat } );
		expect( Array.from( out.position.slice( 9, 12 ) ) ).toEqual( [ 3.5, 2, 0 ] );
		// A 5-12-13 pair: v1–v2 and v2–v0 of 13. pbrt splits v2–v0 ( d12 > d20 is false ).
		const apex = displaceMesh( { position: [ - 5, 0, 0, 5, 0, 0, 0, 12, 0 ], uv: [ 0, 0, 1, 0, 0, 1 ], index: [ 0, 1, 2 ] }, { edgeLength: 12.9, ctm: IDENTITY, height: flat } );
		expect( Array.from( apex.position.slice( 9, 12 ) ) ).toEqual( [ - 2.5, 6, 0 ] );

	} );

	it( 'moves a mesh already at the cap as it is, rather than search for an edge length forever', () => {

		const out = displaceMesh( plane(), { edgeLength: 0.01, ctm: IDENTITY, height: () => 0.5, maxTriangles: 7 } );
		expect( out.index.length / 3 ).toBe( 8 );
		expect( out.edgeLength ).toBe( Infinity );
		expect( new Set( Array.from( out.position ).filter( ( _, i ) => i % 3 === 1 ) ) ).toEqual( new Set( [ 0.5 ] ) );

	} );

	it( 'splits a double-precision mesh as its float positions, in the count and the build alike', () => {

		const mesh = ( Type ) => ( { position: Type.from( [ 0, 0, 0, 0.1 - 1e-12, 0, 0, 0, 0.05, 0 ] ), uv: [ 0, 0, 1, 0, 0, 1 ], index: [ 0, 1, 2 ] } );
		const doubles = displaceMesh( mesh( Float64Array ), { edgeLength: 0.1, ctm: IDENTITY, height: flat } );
		const floats = displaceMesh( mesh( Float32Array ), { edgeLength: 0.1, ctm: IDENTITY, height: flat } );
		expect( Array.from( doubles.index ) ).toEqual( Array.from( floats.index ) );
		expect( Array.from( doubles.position ) ).toEqual( Array.from( floats.position ) );

	} );

	it( 'keeps a triangle already short enough, and carries each triangle\'s face id to its pieces', () => {

		const mesh = { ...plane(), faces: [ 10, 11, 12, 13, 14, 15, 16, 17 ] };
		const same = displaceMesh( mesh, { edgeLength: 5, ctm: IDENTITY, height: flat } );
		expect( Array.from( same.index ) ).toEqual( Array.from( mesh.index ) );
		expect( Array.from( same.faces ) ).toEqual( mesh.faces );

		const split = displaceMesh( mesh, { edgeLength: 0.3, ctm: IDENTITY, height: flat } );
		for ( let f = 0; f < split.faces.length; f ++ ) {

			// Every piece lies inside its parent quad, whose ids are 10 + 2 · quad (+1).
			const quad = ( split.faces[ f ] - 10 ) >> 1;
			const qi = quad % 2, qj = quad >> 1;
			for ( let e = 0; e < 3; e ++ ) {

				const v = split.index[ 3 * f + e ];
				expect( split.uv[ 2 * v ] * 2 ).toBeGreaterThanOrEqual( qi - 1e-6 );
				expect( split.uv[ 2 * v ] * 2 ).toBeLessThanOrEqual( qi + 1 + 1e-6 );
				expect( split.uv[ 2 * v + 1 ] * 2 ).toBeGreaterThanOrEqual( qj - 1e-6 );
				expect( split.uv[ 2 * v + 1 ] * 2 ).toBeLessThanOrEqual( qj + 1 + 1e-6 );

			}

		}

	} );

} );
