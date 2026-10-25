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
