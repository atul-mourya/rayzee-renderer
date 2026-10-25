import { describe, it, expect } from 'vitest';
import { blackbodyToLinearRGB } from '../../../rayzee/src/lights/LightSerializer.js';

// Rec.709 / linear-sRGB relative luminance.
const luma = ( [ r, g, b ] ) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

describe( 'blackbodyToLinearRGB (Blender/Cycles port)', () => {

	it( 'is luminance-balanced (≈1.0) across the usable range', () => {

		for ( const t of [ 1500, 3200, 5000, 6500, 9000, 11000 ] ) {

			expect( luma( blackbodyToLinearRGB( t ) ) ).toBeCloseTo( 1.0, 1 );

		}

	} );

	it( 'is warm (red-dominant) at low temperature', () => {

		const [ r, g, b ] = blackbodyToLinearRGB( 3200 );
		expect( r ).toBeGreaterThan( g );
		expect( g ).toBeGreaterThan( b );

	} );

	it( 'is cool (blue-dominant) at high temperature', () => {

		const [ r, , b ] = blackbodyToLinearRGB( 9000 );
		expect( b ).toBeGreaterThan( r );

	} );

	it( 'is near-neutral at 6500K', () => {

		const [ r, g, b ] = blackbodyToLinearRGB( 6500 );
		expect( r ).toBeCloseTo( 1.0, 1 );
		expect( g ).toBeCloseTo( 1.0, 1 );
		expect( b ).toBeCloseTo( 1.0, 1 );

	} );

	it( 'clamps the high-temperature plateau (>=12000K)', () => {

		const a = blackbodyToLinearRGB( 12000 );
		const b = blackbodyToLinearRGB( 20000 );
		expect( a ).toEqual( b );
		expect( a[ 0 ] ).toBeCloseTo( 0.8262954810464208, 6 );

	} );

	it( 'never returns negative channels', () => {

		for ( const t of [ 700, 800, 1000, 6500, 12000, 30000 ] ) {

			for ( const c of blackbodyToLinearRGB( t ) ) expect( c ).toBeGreaterThanOrEqual( 0 );

		}

	} );

} );
