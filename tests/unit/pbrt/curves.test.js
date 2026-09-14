import { describe, it, expect } from 'vitest';
import { tessellateCurve, curveTriangleCount } from '@/core/Processor/PBRT/PBRTCurves.js';

/** A straight run along +x, as four evenly spaced control points. */
const STRAIGHT = [ 0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0 ];

const bounds = positions => {

	const lo = [ Infinity, Infinity, Infinity ], hi = [ - Infinity, - Infinity, - Infinity ];
	for ( let i = 0; i < positions.length; i += 3 ) {

		for ( let c = 0; c < 3; c ++ ) {

			lo[ c ] = Math.min( lo[ c ], positions[ i + c ] );
			hi[ c ] = Math.max( hi[ c ], positions[ i + c ] );

		}

	}

	return { lo, hi };

};

describe( 'curve tessellation', () => {

	it( 'builds a ribbon of the requested width around a straight bezier', () => {

		const { positions, indices } = tessellateCurve( {
			P: STRAIGHT, basis: 'bezier', width0: 2, width1: 2, steps: 4, sides: 1
		} );

		const { lo, hi } = bounds( positions );
		expect( hi[ 0 ] - lo[ 0 ] ).toBeCloseTo( 3, 4 ); // full length of the curve
		// Width 2 means radius 1 either side of the centreline, on one axis only.
		const spread = [ hi[ 1 ] - lo[ 1 ], hi[ 2 ] - lo[ 2 ] ].sort( ( a, b ) => b - a );
		expect( spread[ 0 ] ).toBeCloseTo( 2, 4 );
		expect( spread[ 1 ] ).toBeCloseTo( 0, 4 );

		expect( indices.length % 3 ).toBe( 0 );
		expect( indices.length / 3 ).toBe( curveTriangleCount( STRAIGHT.length, 'bezier', 4, 1 ) );

	} );

	it( 'tapers from width0 to width1', () => {

		const { positions } = tessellateCurve( {
			P: STRAIGHT, basis: 'bezier', width0: 4, width1: 0, steps: 8, sides: 1
		} );

		// First ring spans the full width; the last collapses to the centreline.
		const first = Math.hypot(
			positions[ 0 ] - positions[ 3 ], positions[ 1 ] - positions[ 4 ], positions[ 2 ] - positions[ 5 ]
		);
		const n = positions.length;
		const last = Math.hypot(
			positions[ n - 6 ] - positions[ n - 3 ], positions[ n - 5 ] - positions[ n - 2 ], positions[ n - 4 ] - positions[ n - 1 ]
		);
		expect( first ).toBeCloseTo( 4, 4 );
		expect( last ).toBeCloseTo( 0, 4 );

	} );

	it( 'crosses two ribbons for a cylinder, filling both axes', () => {

		const single = tessellateCurve( { P: STRAIGHT, width0: 2, width1: 2, steps: 4, sides: 1 } );
		const crossed = tessellateCurve( { P: STRAIGHT, width0: 2, width1: 2, steps: 4, sides: 2 } );

		const s = bounds( single.positions ), c = bounds( crossed.positions );
		const sSpread = [ s.hi[ 1 ] - s.lo[ 1 ], s.hi[ 2 ] - s.lo[ 2 ] ].sort( ( a, b ) => b - a );
		const cSpread = [ c.hi[ 1 ] - c.lo[ 1 ], c.hi[ 2 ] - c.lo[ 2 ] ].sort( ( a, b ) => b - a );

		expect( sSpread[ 1 ] ).toBeCloseTo( 0, 4 ); // a single ribbon is flat
		expect( cSpread[ 1 ] ).toBeCloseTo( 2, 4 ); // the crossed pair is not
		expect( crossed.indices.length ).toBe( single.indices.length * 2 );

	} );

	it( 'closes a tube when asked for three or more sides', () => {

		const { positions, indices } = tessellateCurve( {
			P: STRAIGHT, width0: 2, width1: 2, steps: 2, sides: 6
		} );

		// A hexagon inscribed in radius 1 spans 2 vertex-to-vertex and 2*cos(30) flat-to-flat,
		// so check the section is closed and near-circular rather than exactly square.
		const { lo, hi } = bounds( positions );
		const spans = [ hi[ 1 ] - lo[ 1 ], hi[ 2 ] - lo[ 2 ] ];
		expect( Math.max( ...spans ) ).toBeCloseTo( 2, 3 );
		expect( Math.min( ...spans ) ).toBeGreaterThanOrEqual( 2 * Math.cos( Math.PI / 6 ) - 1e-3 );
		expect( indices.length / 3 ).toBe( curveTriangleCount( STRAIGHT.length, 'bezier', 2, 6 ) );

	} );

	it( 'reads a 7-point cubic b-spline as four spans, the way Moana writes them', () => {

		// isMountainB's ground cover: degree 3, bspline basis, 7 control points.
		const P = [];
		for ( let i = 0; i < 7; i ++ ) P.push( i, 0, 0 );

		const { indices } = tessellateCurve( { P, basis: 'bspline', width0: 1, width1: 1, steps: 2, sides: 1 } );
		// 4 spans x 2 steps = 8 segments, 2 triangles each.
		expect( indices.length / 3 ).toBe( 16 );
		expect( curveTriangleCount( P.length, 'bspline', 2, 1 ) ).toBe( 16 );

	} );

	it( 'keeps a b-spline inside the hull of its control points', () => {

		const P = [ 0, 0, 0, 0, 10, 0, 10, 10, 0, 10, 0, 0, 20, 0, 0, 20, 10, 0, 30, 10, 0 ];
		const { positions } = tessellateCurve( { P, basis: 'bspline', width0: 0.001, width1: 0.001, steps: 6, sides: 1 } );
		const { lo, hi } = bounds( positions );

		expect( lo[ 0 ] ).toBeGreaterThanOrEqual( - 0.01 );
		expect( hi[ 0 ] ).toBeLessThanOrEqual( 30.01 );
		expect( lo[ 1 ] ).toBeGreaterThanOrEqual( - 0.01 );
		expect( hi[ 1 ] ).toBeLessThanOrEqual( 10.01 );

	} );

	it( 'produces no NaN on a curve that doubles back on itself', () => {

		// A reversing tangent is where a naive frame degenerates.
		const P = [ 0, 0, 0, 5, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0, 5, 0, 0, 0, 0, 0 ];
		const { positions } = tessellateCurve( { P, basis: 'bspline', width0: 1, width1: 1, steps: 8, sides: 2 } );
		expect( positions.every( Number.isFinite ) ).toBe( true );

	} );

	it( 'refuses fewer than four control points', () => {

		expect( tessellateCurve( { P: [ 0, 0, 0, 1, 0, 0 ] } ) ).toBe( null );

	} );

} );
