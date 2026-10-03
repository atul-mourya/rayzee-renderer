import { describe, it, expect } from 'vitest';
import { parseIES, resampleIESToGrid } from '@/core/Processor/IESParser.js';

// An LM-63 file: type C, candela listed plane by plane (each horizontal angle's vertical run).
function ies( vertical, horizontal, candelaByPlane ) {

	return [
		'IESNA:LM-63-2002', 'TILT=NONE',
		`1 1000 1 ${vertical.length} ${horizontal.length} 1 2 0 0 0`,
		'1 1 100',
		vertical.join( ' ' ), horizontal.join( ' ' ),
		...candelaByPlane.map( ( plane ) => plane.join( ' ' ) ),
	].join( '\n' );

}

const W = 72, H = 36; // 5° a texel each way
const cell = ( grid, vDeg, hDeg ) => grid[ Math.floor( vDeg / 5 ) * W + Math.floor( hDeg / 5 ) ] / 255;

describe( 'resampleIESToGrid', () => {

	it( 'puts a downlight\'s 0–90° in the lower half of the sphere and nothing above it', () => {

		const grid = resampleIESToGrid( parseIES( ies( [ 0, 30, 60, 90 ], [ 0 ], [[ 100, 100, 50, 0 ]] ) ), W, H );
		expect( cell( grid, 2.5, 0 ) ).toBe( 1 );
		expect( cell( grid, 47.5, 200 ) ).toBeCloseTo( 1 - 0.5 * 17.5 / 30, 2 );
		expect( cell( grid, 62.5, 90 ) ).toBeCloseTo( 0.5 * ( 1 - 2.5 / 30 ), 2 );
		for ( let v = 92.5; v < 180; v += 5 ) expect( cell( grid, v, 0 ) ).toBe( 0 );

	} );

	it( 'mirrors a quadrant (0–90°) profile round the whole circle', () => {

		// Brightest at 0°, half at 90°.
		const grid = resampleIESToGrid( parseIES( ies( [ 0, 180 ], [ 0, 90 ], [[ 100, 100 ], [ 50, 50 ]] ) ), W, H );
		for ( const h of [ 2.5, 22.5, 47.5, 87.5 ] ) {

			const v = cell( grid, 2.5, h );
			expect( cell( grid, 2.5, 180 - h ) ).toBeCloseTo( v, 2 );
			expect( cell( grid, 2.5, 180 + h ) ).toBeCloseTo( v, 2 );
			expect( cell( grid, 2.5, 360 - h ) ).toBeCloseTo( v, 2 );

		}

		expect( cell( grid, 2.5, 2.5 ) ).toBeGreaterThan( cell( grid, 2.5, 87.5 ) );

	} );

	it( 'mirrors a half (0–180°) profile about its 0–180 plane', () => {

		const grid = resampleIESToGrid( parseIES( ies( [ 0, 180 ], [ 0, 90, 180 ], [[ 100, 100 ], [ 20, 20 ], [ 60, 60 ]] ) ), W, H );
		expect( cell( grid, 2.5, 87.5 ) ).toBeCloseTo( cell( grid, 2.5, 272.5 ), 2 );
		expect( cell( grid, 2.5, 177.5 ) ).toBeCloseTo( cell( grid, 2.5, 182.5 ), 2 );

	} );

	it( 'reads a full (0–360°) profile as it is', () => {

		const grid = resampleIESToGrid( parseIES( ies( [ 0, 180 ], [ 0, 180, 360 ], [[ 100, 100 ], [ 0, 0 ], [ 100, 100 ]] ) ), W, H );
		expect( cell( grid, 2.5, 2.5 ) ).toBeGreaterThan( 0.9 );
		expect( cell( grid, 2.5, 177.5 ) ).toBeLessThan( 0.05 );

	} );

} );
