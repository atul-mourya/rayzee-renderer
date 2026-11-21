/**
 * White balance as pbrt-v4's film does it (`PixelSensor`, `WhiteBalance`: src/pbrt/film.h, util/color.h): light of CIE
 * daylight at `kelvin` (a blackbody below 4000 K) shows as the working space's white, through a Bradford scale. One
 * 3×3 in linear working-space RGB, before exposure and the view.
 */

import { getWorkingMatrix } from './WorkingMatrix.js';

// pbrt's Spectra::D( T ) is S0 + M1·S1 + M2·S2 at the daylight locus of CCT T · 1.4388 / 1.4380: XYZ of S0, S1 and S2
// against the CIE 1931 1 nm functions, 360–830 nm, over ∫ȳ (util/spectrum.cpp).
const S_XYZ = [
	[ 95.88607529, 99.91579318, 115.7706592 ],
	[ 1.758566268, 1.806428144, 32.5910024 ],
	[ 1.995956706, 0.7151983065, - 2.203109088 ],
];

// Below a CCT of 4000 K pbrt takes a blackbody: its xy every 25 mired from 1025 down to 225, Catmull-Rom between.
const PLANCK_XY = [
	0.6562027, 0.34137987, 0.65275071, 0.34446165, 0.64913719, 0.34764266, 0.64535177, 0.35092234,
	0.64138303, 0.35429921, 0.63721841, 0.35777065, 0.63284402, 0.36133264, 0.62824453, 0.3649795,
	0.62340296, 0.36870348, 0.61830052, 0.37249439, 0.6129164, 0.37633907, 0.60722758, 0.38022084,
	0.60120861, 0.38411884, 0.59483148, 0.38800725, 0.58806544, 0.39185446, 0.58087694, 0.39562215,
	0.57322961, 0.39926418, 0.56508442, 0.40272561, 0.55640002, 0.40594152, 0.54713329, 0.40883599,
	0.53724028, 0.41132125, 0.5266775, 0.413297, 0.51540376, 0.41465032, 0.50338258, 0.41525619,
	0.49058526, 0.41497902, 0.47699455, 0.41367536, 0.46260908, 0.41119822, 0.44744813, 0.40740311,
	0.43155679, 0.40215611, 0.41501094, 0.39534392, 0.39792182, 0.38688574, 0.38043954, 0.37674683,
	0.36275523, 0.36495335,
];

// Linear Rec.709's white: D65 as pbrt-v4 integrates it (stdillum-D65), not the rounded (0.3127, 0.3290).
const WHITE = [ 0.31272693, 0.32902322 ];
const PRIMARIES = [[ 0.64, 0.33 ], [ 0.30, 0.60 ], [ 0.15, 0.06 ]];

const BRADFORD = [ 0.8951, 0.2664, - 0.1614, - 0.7502, 1.7135, 0.0367, 0.0389, - 0.0685, 1.0296 ];

const mul = ( a, b ) => {

	const c = new Array( 9 ).fill( 0 );
	for ( let r = 0; r < 3; r ++ ) for ( let k = 0; k < 3; k ++ ) for ( let j = 0; j < 3; j ++ ) c[ r * 3 + j ] += a[ r * 3 + k ] * b[ k * 3 + j ];
	return c;

};

const apply = ( m, v ) => [ 0, 3, 6 ].map( r => m[ r ] * v[ 0 ] + m[ r + 1 ] * v[ 1 ] + m[ r + 2 ] * v[ 2 ] );

const invert = m => {

	const [ a, b, c, d, e, f, g, h, i ] = m;
	const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [ A, c * h - b * i, b * f - c * e, B, a * i - c * g, c * d - a * f, C, b * g - a * h, a * e - b * d ].map( v => v / det );

};

const xyz = ( [ x, y ] ) => [ x / y, 1, ( 1 - x - y ) / y ];

// RGB → XYZ for the primaries, scaled so RGB 1 is the white.
function toXYZ( primaries, white ) {

	const p = primaries.map( xyz );
	const P = [ p[ 0 ][ 0 ], p[ 1 ][ 0 ], p[ 2 ][ 0 ], p[ 0 ][ 1 ], p[ 1 ][ 1 ], p[ 2 ][ 1 ], p[ 0 ][ 2 ], p[ 1 ][ 2 ], p[ 2 ][ 2 ] ];
	const s = apply( invert( P ), xyz( white ) );
	return P.map( ( v, i ) => v * s[ i % 3 ] );

}

const REC709_TO_XYZ = toXYZ( PRIMARIES, WHITE );
const XYZ_TO_REC709 = invert( REC709_TO_XYZ );
const BRADFORD_INV = invert( BRADFORD );

// Bradford from one white's XYZ to another's.
function adaptation( from, to ) {

	const s = apply( BRADFORD, from ), d = apply( BRADFORD, to );
	return mul( BRADFORD_INV, mul( [ d[ 0 ] / s[ 0 ], 0, 0, 0, d[ 1 ] / s[ 1 ], 0, 0, 0, d[ 2 ] / s[ 2 ] ], BRADFORD ) );

}

/**
 * Linear RGB of a file's chromaticities (red, green, blue and white xy, as an EXR or a Radiance header records them) as
 * linear Rec.709, row-major: its white carried to D65 (Bradford, as colour configs do) unless `adapt` is false. Null for
 * Rec.709 itself (within 0.2 %) or numbers that make no colour space.
 * @param {number[]} chromaticities
 * @param {{ adapt?: boolean }} [options]
 * @returns {?number[]}
 */
export function rec709FromChromaticities( chromaticities, { adapt = true } = {} ) {

	const c = chromaticities;
	if ( c?.length !== 8 || ! c.every( Number.isFinite ) || ! ( c[ 7 ] > 0 ) || [ 1, 3, 5 ].some( ( i ) => c[ i ] === 0 ) ) return null;
	const white = [ c[ 6 ], c[ 7 ] ];
	let m = toXYZ( [[ c[ 0 ], c[ 1 ] ], [ c[ 2 ], c[ 3 ] ], [ c[ 4 ], c[ 5 ] ]], white );
	if ( ! m.every( Number.isFinite ) ) return null;
	if ( adapt ) m = mul( adaptation( xyz( white ), xyz( WHITE ) ), m );
	const out = mul( XYZ_TO_REC709, m );
	if ( ! out.every( Number.isFinite ) ) return null;
	return out.every( ( v, i ) => Math.abs( v - ( i % 4 === 0 ? 1 : 0 ) ) < 2e-3 ) ? null : out;

}

/** The chromaticity pbrt white-balances from at `kelvin`: CIE daylight, a blackbody below a CCT of 4000 K. */
function sourceWhite( kelvin ) {

	const cct = kelvin * 1.4388 / 1.4380;
	if ( cct < 4000 ) {

		const f = ( 1025 - 1e6 / cct ) / 25, i = Math.min( Math.max( Math.floor( f ), 1 ), PLANCK_XY.length / 2 - 3 ), t = f - i;
		const p = k => [ PLANCK_XY[ ( i + k ) * 2 ], PLANCK_XY[ ( i + k ) * 2 + 1 ] ];
		const [ p0, p1, p2, p3 ] = [ p( - 1 ), p( 0 ), p( 1 ), p( 2 ) ];
		return [ 0, 1 ].map( c => 0.5 * ( 2 * p1[ c ] + ( p2[ c ] - p0[ c ] ) * t
			+ ( 2 * p0[ c ] - 5 * p1[ c ] + 4 * p2[ c ] - p3[ c ] ) * t * t + ( 3 * p1[ c ] - p0[ c ] - 3 * p2[ c ] + p3[ c ] ) * t * t * t ) );

	}

	const x = cct <= 7000
		? - 4.607e9 / cct ** 3 + 2.9678e6 / cct ** 2 + 0.09911e3 / cct + 0.244063
		: - 2.0064e9 / cct ** 3 + 1.9018e6 / cct ** 2 + 0.24748e3 / cct + 0.23704;
	const y = - 3 * x * x + 2.870 * x - 0.275;
	const m = 0.0241 + 0.2562 * x - 0.7341 * y;
	const m1 = ( - 1.3515 - 1.7703 * x + 5.9114 * y ) / m, m2 = ( 0.0300 - 31.4424 * x + 30.0717 * y ) / m;
	const v = [ 0, 1, 2 ].map( c => S_XYZ[ 0 ][ c ] + m1 * S_XYZ[ 1 ][ c ] + m2 * S_XYZ[ 2 ][ c ] );
	const sum = v[ 0 ] + v[ 1 ] + v[ 2 ];
	return [ v[ 0 ] / sum, v[ 1 ] / sum ];

}

/**
 * The white balance for `kelvin` as a row-major 3×3 on linear working-space RGB, or null when off (0, negative or not a
 * number). Below 1000 K reads as 1000 K. Computed on Rec.709's axes and carried into the working space by `working`
 * (Rec.709 → working, row-major; null is Rec.709 itself).
 * @param {number} kelvin
 * @param {?number[]} [working]
 * @returns {?number[]}
 */
export function whiteBalanceMatrix( kelvin, working = getWorkingMatrix() ) {

	if ( typeof kelvin !== 'number' || ! ( kelvin > 0 ) ) return null;

	const m = mul( XYZ_TO_REC709, mul( adaptation( xyz( sourceWhite( Math.max( kelvin, 1000 ) ) ), xyz( WHITE ) ), REC709_TO_XYZ ) );
	return working ? mul( working, mul( m, invert( working ) ) ) : m;

}

// Blackbody temperature → linear Rec.709 (= linear sRGB) RGB.
//
// Ported verbatim from Blender/Cycles `svm_math_blackbody_color_rec709`
// (Lukas Stockner's 7-segment rational/cubic fit; coefficients from
// intern/cycles/kernel/tables.h). The fit is luminance-balanced — the Rec.709
// luminance of the returned colour is ≈1.0 across the whole range — so it can be
// multiplied straight into a light's colour without altering its power: the
// temperature shifts hue only, brightness stays governed by intensity. This is
// exactly how Cycles applies it (raw multiply into the light colour, no
// renormalisation).

const BB_R = [
	[ 1.61919106e3, - 2.05010916e-3, 5.02995757e0 ],
	[ 2.48845471e3, - 1.11330907e-3, 3.22621544e0 ],
	[ 3.34143193e3, - 4.86551192e-4, 1.76486769e0 ],
	[ 4.09461742e3, - 1.27446582e-4, 7.25731635e-1 ],
	[ 4.67028036e3, 2.91258199e-5, 1.26703442e-1 ],
	[ 4.59509185e3, 2.87495649e-5, 1.50345020e-1 ],
	[ 3.78717450e3, 9.35907826e-6, 3.99075871e-1 ],
];

const BB_G = [
	[ - 4.88999748e2, 6.04330754e-4, - 7.55807526e-2 ],
	[ - 7.55994277e2, 3.16730098e-4, 4.78306139e-1 ],
	[ - 1.02363977e3, 1.20223470e-4, 9.36662319e-1 ],
	[ - 1.26571316e3, 4.87340896e-6, 1.27054498e0 ],
	[ - 1.42529332e3, - 4.01150431e-5, 1.43972784e0 ],
	[ - 1.17554822e3, - 2.16378048e-5, 1.30408023e0 ],
	[ - 5.00799571e2, - 4.59832026e-6, 1.09098763e0 ],
];

const BB_B = [
	[ 5.96945309e-11, - 4.85742887e-8, - 9.70622247e-5, - 4.07936148e-3 ],
	[ 2.40430366e-11, 5.55021075e-8, - 1.98503712e-4, 2.89312858e-2 ],
	[ - 1.40949732e-11, 1.89878968e-7, - 3.56632824e-4, 9.10767778e-2 ],
	[ - 3.61460868e-11, 2.84822009e-7, - 4.93211319e-4, 1.56723440e-1 ],
	[ - 1.97075738e-11, 1.75359352e-7, - 2.50542825e-4, - 2.22783266e-2 ],
	[ - 1.61997957e-13, - 1.64216008e-8, 3.86216271e-4, - 7.38077418e-1 ],
	[ 6.72650283e-13, - 2.73078809e-8, 4.24098264e-4, - 7.52335691e-1 ],
];

/**
 * Convert a colour temperature in Kelvin to linear Rec.709 / linear-sRGB RGB.
 * Negative out-of-gamut channels (very low temperatures) are clamped to 0.
 * @param {number} kelvin
 * @returns {[number, number, number]}
 */
export function blackbodyToLinearRGB( kelvin ) {

	let r, g, b;

	if ( kelvin >= 12000 ) {

		r = 0.8262954810464208; g = 0.9945080501520986; b = 1.566307710274283;

	} else if ( kelvin < 800 ) {

		r = 5.413294490189271; g = - 0.20319390035873933; b = - 0.0822535242887164;

	} else {

		const i = kelvin >= 6365 ? 6 : kelvin >= 3315 ? 5 : kelvin >= 1902 ? 4
			: kelvin >= 1449 ? 3 : kelvin >= 1167 ? 2 : kelvin >= 965 ? 1 : 0;
		const cr = BB_R[ i ], cg = BB_G[ i ], cb = BB_B[ i ];
		const tInv = 1 / kelvin;
		r = cr[ 0 ] * tInv + cr[ 1 ] * kelvin + cr[ 2 ];
		g = cg[ 0 ] * tInv + cg[ 1 ] * kelvin + cg[ 2 ];
		b = ( ( cb[ 0 ] * kelvin + cb[ 1 ] ) * kelvin + cb[ 2 ] ) * kelvin + cb[ 3 ];

	}

	return [ Math.max( 0, r ), Math.max( 0, g ), Math.max( 0, b ) ];

}
