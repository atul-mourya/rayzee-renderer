import { describe, it, expect } from 'vitest';
import { parseIES, resampleIESToGrid, deriveIESBeamAngle, deriveIESPenumbra } from '@/core/viewer/lights/IESParser.js';

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

describe( 'parseIES', () => {

	it( 'transposes the planes into rows by vertical angle, scaled by the multiplier and ballast factor', () => {

		const text = [
			'IESNA:LM-63-2002', '[TEST] two lamps', 'TILT=NONE',
			'2 500 2 3 2 1 2 0 0 0',
			'0.5 1 100',
			'0 45 90', '0 90',
			'1 2 3', '4 5 6',
		].join( '\n' );
		const profile = parseIES( text, 'lamp' );

		expect( profile.verticalAngles ).toEqual( [ 0, 45, 90 ] );
		expect( profile.horizontalAngles ).toEqual( [ 0, 90 ] );
		expect( profile.candela.map( row => [ ...row ] ) ).toEqual( [[ 1, 4 ], [ 2, 5 ], [ 3, 6 ]] );
		expect( profile.maxCandela ).toBe( 6 );
		expect( profile.lumens ).toBe( 1000 );
		expect( profile.photometricType ).toBe( 1 );
		expect( profile.name ).toBe( 'lamp' );

	} );

	it( 'skips an inline tilt block', () => {

		const plain = ies( [ 0, 90 ], [ 0 ], [[ 100, 40 ]] );
		const tilted = plain.replace( 'TILT=NONE', 'TILT=INCLUDE\n1\n3\n0 45 90\n1 0.9 0.8' );

		expect( parseIES( tilted ) ).toEqual( parseIES( plain ) );

	} );

	it( 'refuses a file without a TILT line, a cut-off TILT line, or no angles', () => {

		expect( () => parseIES( 'IESNA:LM-63\n1 1000 1', 'a' ) ).toThrow( 'IES (a): missing TILT line' );
		expect( () => parseIES( 'IESNA:LM-63\nTILT=NONE', 'b' ) ).toThrow( 'truncated TILT line' );
		expect( () => parseIES( ies( [], [ 0 ], [[]] ) ) ).toThrow( 'invalid vertical angle count 0' );
		expect( () => parseIES( ies( [ 0 ], [], [] ) ) ).toThrow( 'invalid horizontal angle count 0' );
		expect( () => parseIES( 'TILT=INCLUDE\n1 5 0 10' ) ).toThrow( 'invalid vertical angle count NaN' );

	} );

} );

describe( 'resampleIESToGrid, other layouts', () => {

	it( 'is dark for a profile with no light', () => {

		const grid = resampleIESToGrid( parseIES( ies( [ 0, 90 ], [ 0 ], [[ 0, 0 ]] ) ), W, H );
		expect( grid.every( v => v === 0 ) ).toBe( true );

	} );

	it( 'mirrors a 90–270° profile about its 90–270 plane', () => {

		const grid = resampleIESToGrid( parseIES( ies( [ 0, 180 ], [ 90, 180, 270 ], [[ 100, 100 ], [ 20, 20 ], [ 60, 60 ]] ) ), W, H );
		expect( cell( grid, 2.5, 2.5 ) ).toBeCloseTo( cell( grid, 2.5, 177.5 ), 2 );
		expect( cell( grid, 2.5, 357.5 ) ).toBeCloseTo( cell( grid, 2.5, 182.5 ), 2 );
		expect( cell( grid, 2.5, 87.5 ) ).toBeCloseTo( cell( grid, 2.5, 92.5 ), 2 );
		expect( cell( grid, 2.5, 92.5 ) ).toBeGreaterThan( cell( grid, 2.5, 177.5 ) );

	} );

	it( 'leaves horizontal angles outside an unsymmetric range dark', () => {

		const grid = resampleIESToGrid( parseIES( ies( [ 0, 180 ], [ 0, 120, 240 ], [[ 100, 100 ], [ 100, 100 ], [ 100, 100 ]] ) ), W, H );
		expect( cell( grid, 2.5, 237.5 ) ).toBe( 1 );
		expect( cell( grid, 2.5, 242.5 ) ).toBe( 0 );
		expect( cell( grid, 2.5, 357.5 ) ).toBe( 0 );

	} );

	it( 'stretches a type B profile over the whole grid', () => {

		const text = ies( [ - 90, 0, 90 ], [ - 90, 90 ], [[ 0, 100, 0 ], [ 0, 100, 0 ]] ).replace( '1 2 0 0 0', '2 2 0 0 0' );
		const profile = parseIES( text );
		const grid = resampleIESToGrid( profile, 4, 4 );

		expect( profile.photometricType ).toBe( 2 );
		expect( grid[ 0 ] ).toBe( Math.round( 0.25 * 255 ) );
		expect( grid[ 4 ] ).toBe( Math.round( 0.75 * 255 ) );
		expect( grid[ 8 ] ).toBe( grid[ 4 ] );
		expect( grid[ 12 ] ).toBe( grid[ 0 ] );

	} );

} );

describe( 'deriveIESBeamAngle', () => {

	const beam = candela => parseIES( ies( [ 0, 10, 20, 30, 40, 90 ], [ 0 ], [ candela ] ) );
	const deg = d => d * Math.PI / 180;

	it( 'is the first angle out from the axis whose light falls under the threshold', () => {

		expect( deriveIESBeamAngle( beam( [ 100, 100, 80, 5, 0, 0 ] ) ) ).toBeCloseTo( deg( 30 ), 9 );
		expect( deriveIESBeamAngle( beam( [ 100, 100, 80, 5, 0, 0 ] ), 0.9 ) ).toBeCloseTo( deg( 20 ), 9 );

	} );

	it( 'starts counting only once the beam has been bright', () => {

		expect( deriveIESBeamAngle( beam( [ 0, 0, 100, 0, 0, 0 ] ) ) ).toBeCloseTo( deg( 30 ), 9 );

	} );

	it( 'keeps between 5° and 89°, and falls back to 45° for a dark profile', () => {

		expect( deriveIESBeamAngle( parseIES( ies( [ 0, 2, 90 ], [ 0 ], [[ 100, 0, 0 ]] ) ) ) ).toBeCloseTo( deg( 5 ), 9 );
		expect( deriveIESBeamAngle( beam( [ 100, 100, 100, 100, 100, 100 ] ) ) ).toBeCloseTo( deg( 89 ), 9 );
		expect( deriveIESBeamAngle( beam( [ 0, 0, 0, 0, 0, 0 ] ) ) ).toBe( Math.PI / 4 );

	} );

	it( 'averages the horizontal planes', () => {

		const profile = parseIES( ies( [ 0, 10, 20 ], [ 0, 90 ], [[ 100, 100, 0 ], [ 100, 0, 0 ]] ) );
		expect( deriveIESBeamAngle( profile, 0.6 ) ).toBeCloseTo( deg( 10 ), 9 );
		expect( deriveIESBeamAngle( profile, 0.4 ) ).toBeCloseTo( deg( 20 ), 9 );

	} );

} );

describe( 'deriveIESPenumbra', () => {

	const beam = candela => parseIES( ies( [ 0, 10, 20, 30 ], [ 0 ], [ candela ] ) );
	const deg = d => d * Math.PI / 180;

	it( 'is the share of the cone outside the still-hot core', () => {

		expect( deriveIESPenumbra( beam( [ 100, 80, 50, 0 ] ), deg( 30 ) ) ).toBeCloseTo( 1 - 10 / 30, 9 );
		expect( deriveIESPenumbra( beam( [ 100, 80, 50, 0 ] ), deg( 30 ), 0.4 ) ).toBeCloseTo( 1 - 20 / 30, 9 );

	} );

	it( 'is a hard edge when the core reaches the cone, and for no light or no cone', () => {

		expect( deriveIESPenumbra( beam( [ 100, 100, 100, 100 ] ), deg( 20 ) ) ).toBe( 0 );
		expect( deriveIESPenumbra( beam( [ 0, 0, 0, 0 ] ), deg( 30 ) ) ).toBe( 0 );
		expect( deriveIESPenumbra( beam( [ 100, 80, 50, 0 ] ), 0 ) ).toBe( 0 );

	} );

	it( 'is the whole cone when only the axis is hot, whatever lies further out', () => {

		expect( deriveIESPenumbra( beam( [ 100, 10, 0, 0 ] ), deg( 30 ) ) ).toBe( 1 );
		expect( deriveIESPenumbra( beam( [ 100, 50, 90, 0 ] ), deg( 30 ) ) ).toBe( 1 );

	} );

} );
