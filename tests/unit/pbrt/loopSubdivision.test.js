import { describe, it, expect } from 'vitest';
import { loopSubdivide } from '@/core/Processor/PBRT/LoopSubdivision.js';

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
