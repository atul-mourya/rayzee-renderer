import { describe, it, expect } from 'vitest';
import { whiteBalanceMatrix } from '@/core/color/WhiteBalance.js';

// pbrt-v4's own film matrices (local build, `Film "rgb" "float whitebalance" T "bool savefp16" false`): three emitters
// seen directly, rendered with and without the white balance, M = OUT_T · OUT_0⁻¹. Row-major, linear Rec.709.
const PBRT = {
	1500: [ 0.4887563, - 1.510582, - 0.9666568, 0.06010442, 1.777856, - 0.4876501, 0.5121983, 2.039091, 24.28664 ],
	2500: [ 0.7133823, - 0.587644, - 0.1570287, 0.02701921, 1.239043, - 0.06748669, 0.07752, 0.2934604, 4.388263 ],
	3000: [ 0.7786843, - 0.4182197, - 0.09155159, 0.01956483, 1.155022, - 0.03675536, 0.04394047, 0.1627491, 2.879047 ],
	5500: [ 0.9630479, - 0.05572093, - 0.01004874, 0.002642105, 1.013426, - 0.003698672, 0.004660463, 0.01678189, 1.188131 ],
	6500: [ 1.000025, 0.00003739169, 0.000006886501, - 0.000002025697, 0.9999909, 0.000001707002, - 0.000002633468, - 0.000009351238, 0.9998946 ],
	9000: [ 1.056383, 0.07651172, 0.01254302, - 0.003649507, 0.9870691, 0.004376153, - 0.005700286, - 0.02017395, 0.7793721 ],
	30000: [ 1.15199, 0.1866187, 0.0282279, - 0.008940279, 0.9826662, 0.009355024, - 0.01258944, - 0.04381082, 0.5366044 ],
};

// Linear Rec.709 → ACEScg (Bradford D65 → D60), row-major.
const ACESCG = [ 0.6130974, 0.3395231, 0.0473795, 0.0701937, 0.9163539, 0.0134524, 0.0206156, 0.1095698, 0.8698147 ];

const mul = ( a, b ) => {

	const c = new Array( 9 ).fill( 0 );
	for ( let r = 0; r < 3; r ++ ) for ( let k = 0; k < 3; k ++ ) for ( let j = 0; j < 3; j ++ ) c[ r * 3 + j ] += a[ r * 3 + k ] * b[ k * 3 + j ];
	return c;

};

const worst = ( a, b ) => Math.max( ...a.map( ( v, i ) => Math.abs( v - b[ i ] ) / Math.max( 1, Math.abs( b[ i ] ) ) ) );

describe( 'whiteBalanceMatrix', () => {

	it.each( Object.keys( PBRT ) )( 'is pbrt-v4\'s matrix at %s K', kelvin => {

		// 1500 K's blue gain is 24: the blackbody table's 4e-6 in xy is 5e-5 there.
		expect( worst( whiteBalanceMatrix( Number( kelvin ), null ), PBRT[ kelvin ] ) ).toBeLessThan( kelvin < 2000 ? 1e-4 : 1e-5 );

	} );

	it( 'is off at 0, below it and for anything not a number', () => {

		for ( const k of [ 0, - 6500, NaN, undefined, null, '6500' ] ) expect( whiteBalanceMatrix( k, null ) ).toBeNull();

	} );

	it( 'warms the picture above about 6500 K and cools it below', () => {

		const warm = whiteBalanceMatrix( 9000, null ), cool = whiteBalanceMatrix( 4000, null );
		expect( warm[ 0 ] ).toBeGreaterThan( 1 );
		expect( warm[ 8 ] ).toBeLessThan( 1 );
		expect( cool[ 0 ] ).toBeLessThan( 1 );
		expect( cool[ 8 ] ).toBeGreaterThan( 1 );

	} );

	it( 'reads anything below 1000 K as 1000 K', () => {

		expect( whiteBalanceMatrix( 400, null ) ).toEqual( whiteBalanceMatrix( 1000, null ) );

	} );

	it( 'follows the blackbody smoothly to the 4000 K daylight seam', () => {

		// Catmull-Rom over the table: no step between neighbouring kelvins anywhere below the seam.
		let last = whiteBalanceMatrix( 1000, null );
		for ( let k = 1010; k < 3990; k += 10 ) {

			const m = whiteBalanceMatrix( k, null );
			expect( worst( m, last ) ).toBeLessThan( 0.15 );
			last = m;

		}

	} );

	it( 'carries the Rec.709 balance into the working space', () => {

		const inRec709 = whiteBalanceMatrix( 3200, null );
		const inAces = whiteBalanceMatrix( 3200, ACESCG );
		// W · M · W⁻¹ applied to W·rgb is W·(M·rgb).
		expect( worst( mul( inAces, ACESCG ), mul( ACESCG, inRec709 ) ) ).toBeLessThan( 1e-9 );

	} );

} );
