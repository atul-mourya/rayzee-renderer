// Earth's clear-sky atmosphere after Bruneton's reference model: kilometres, and 16 bin-averaged
// spectral bins of 25 nm over 380–780 nm. No three.js import, so tests use it as is.

export const GROUND_RADIUS = 6360;
export const TOP_RADIUS = 6420;
export const RAYLEIGH_SCALE_HEIGHT = 8;
export const MIE_SCALE_HEIGHT = 1.2;
export const OZONE_PEAK_ALTITUDE = 25;
export const OZONE_HALF_WIDTH = 15;
const MIE_ALBEDO = 0.9;
export const MIE_PHASE_G = 0.76;
const ANGSTROM_ALPHA = 1.3;

export const LAMBDA_COUNT = 16;
const LAMBDA_MIN = 380;
const LAMBDA_STEP = 25;

/** Horizontal illuminance of a clear noon reads ~4 engine units, like the bundled HDRIs, instead of ~150. */
export const SKY_RADIANCE_SCALE = 1 / 32;

// ASTM G-173 extraterrestrial irradiance, 360–830 nm every 10 nm, W m⁻² nm⁻¹.
const SOLAR_IRRADIANCE = [
	1.11776, 1.14259, 1.01249, 1.14716, 1.72765, 1.73054, 1.6887, 1.61253,
	1.91198, 2.03474, 2.02042, 2.02212, 1.93377, 1.95809, 1.91686, 1.8298,
	1.8685, 1.8931, 1.85149, 1.8504, 1.8341, 1.8345, 1.8147, 1.78158, 1.7533,
	1.6965, 1.68194, 1.64654, 1.6048, 1.52143, 1.55622, 1.5113, 1.474, 1.4482,
	1.41018, 1.36775, 1.34188, 1.31429, 1.28303, 1.26758, 1.2367, 1.2082,
	1.18737, 1.14683, 1.12362, 1.1058, 1.07124, 1.04992,
];

// Ozone absorption cross section at 233 K (IUP Bremen), 360–830 nm every 10 nm, m².
const OZONE_CROSS_SECTION = [
	1.18e-27, 2.182e-28, 2.818e-28, 6.636e-28, 1.527e-27, 2.763e-27, 5.52e-27,
	8.451e-27, 1.582e-26, 2.316e-26, 3.669e-26, 4.924e-26, 7.752e-26, 9.016e-26,
	1.48e-25, 1.602e-25, 2.139e-25, 2.755e-25, 3.091e-25, 3.5e-25, 4.266e-25,
	4.672e-25, 4.398e-25, 4.701e-25, 5.019e-25, 4.305e-25, 3.74e-25, 3.215e-25,
	2.662e-25, 2.238e-25, 1.852e-25, 1.473e-25, 1.209e-25, 9.423e-26, 7.455e-26,
	6.566e-26, 5.105e-26, 4.15e-26, 4.228e-26, 3.237e-26, 2.451e-26, 2.801e-26,
	2.534e-26, 1.624e-26, 1.465e-26, 2.078e-26, 1.383e-26, 7.105e-27,
];

// CIE 1931 2° colour matching functions, 360–830 nm every 5 nm: x̄, ȳ, z̄.
const CIE_1931 = [
	0.0001299, 0.000003917, 0.0006061, 0.0002321, 0.000006965, 0.001086, 0.0004149, 0.00001239, 0.001946,
	0.0007416, 0.00002202, 0.003486, 0.001368, 0.000039, 0.006450001, 0.002236, 0.000064, 0.01054999,
	0.004243, 0.00012, 0.02005001, 0.00765, 0.000217, 0.03621, 0.01431, 0.000396, 0.06785001,
	0.02319, 0.00064, 0.1102, 0.04351, 0.00121, 0.2074, 0.07763, 0.00218, 0.3713,
	0.13438, 0.004, 0.6456, 0.21477, 0.0073, 1.0390501, 0.2839, 0.0116, 1.3856,
	0.3285, 0.01684, 1.62296, 0.34828, 0.023, 1.74706, 0.34806, 0.0298, 1.7826,
	0.3362, 0.038, 1.77211, 0.3187, 0.048, 1.7441, 0.2908, 0.06, 1.6692,
	0.2511, 0.0739, 1.5281, 0.19536, 0.09098, 1.28764, 0.1421, 0.1126, 1.0419,
	0.09564, 0.13902, 0.8129501, 0.05795001, 0.1693, 0.6162, 0.03201, 0.20802, 0.46518,
	0.0147, 0.2586, 0.3533, 0.0049, 0.323, 0.272, 0.0024, 0.4073, 0.2123,
	0.0093, 0.503, 0.1582, 0.0291, 0.6082, 0.1117, 0.06327, 0.71, 0.07824999,
	0.1096, 0.7932, 0.05725001, 0.1655, 0.862, 0.04216, 0.2257499, 0.9148501, 0.02984,
	0.2904, 0.954, 0.0203, 0.3597, 0.9803, 0.0134, 0.4334499, 0.9949501, 0.008749999,
	0.5120501, 1.0, 0.005749999, 0.5945, 0.995, 0.0039, 0.6784, 0.9786, 0.002749999,
	0.7621, 0.952, 0.0021, 0.8425, 0.9154, 0.0018, 0.9163, 0.87, 0.001650001,
	0.9786, 0.8163, 0.0014, 1.0263, 0.757, 0.0011, 1.0567, 0.6949, 0.001,
	1.0622, 0.631, 0.0008, 1.0456, 0.5668, 0.0006, 1.0026, 0.503, 0.00034,
	0.9384, 0.4412, 0.00024, 0.8544499, 0.381, 0.00019, 0.7514, 0.321, 0.0001,
	0.6424, 0.265, 0.00004999999, 0.5419, 0.217, 0.00003, 0.4479, 0.175, 0.00002,
	0.3608, 0.1382, 0.00001, 0.2835, 0.107, 0, 0.2187, 0.0816, 0,
	0.1649, 0.061, 0, 0.1212, 0.04458, 0, 0.0874, 0.032, 0,
	0.0636, 0.0232, 0, 0.04677, 0.017, 0, 0.0329, 0.01192, 0,
	0.0227, 0.00821, 0, 0.01584, 0.005723, 0, 0.01135916, 0.004102, 0,
	0.008110916, 0.002929, 0, 0.005790346, 0.002091, 0, 0.004109457, 0.001484, 0,
	0.002899327, 0.001047, 0, 0.00204919, 0.00074, 0, 0.001439971, 0.00052, 0,
	0.0009999493, 0.0003611, 0, 0.0006900786, 0.0002492, 0, 0.0004760213, 0.0001719, 0,
	0.0003323011, 0.00012, 0, 0.0002348261, 0.0000848, 0, 0.0001661505, 0.00006, 0,
	0.000117413, 0.0000424, 0, 0.00008307527, 0.00003, 0, 0.00005870652, 0.0000212, 0,
	0.00004150994, 0.00001499, 0, 0.00002935326, 0.0000106, 0, 0.00002067383, 0.0000074657, 0,
	0.00001455977, 0.0000052578, 0, 0.00001025398, 0.0000037029, 0, 0.000007221456, 0.0000026078, 0,
	0.000005085868, 0.0000018366, 0, 0.000003581652, 0.0000012934, 0, 0.000002522525, 0.00000091093, 0,
	0.000001776509, 0.00000064153, 0, 0.000001251141, 0.00000045181, 0,
];

export const XYZ_TO_REC709 = [
	3.2406, - 1.5372, - 0.4986,
	- 0.9689, 1.8758, 0.0415,
	0.0557, - 0.204, 1.057,
];

const DOBSON_UNIT = 2.687e20; // molecules m⁻²

// Rayleigh optical depth of the US standard atmosphere at sea level (Bodhaine et al. 1999, eq. 30).
function rayleighOpticalDepth( lambda ) {

	const l2 = ( lambda / 1000 ) ** 2;
	return 0.0021520 * ( 1.0455996 - 341.29061 / l2 - 0.90230850 * l2 ) / ( 1 + 0.0027059889 / l2 - 85.968563 * l2 );

}

function sampleTable( table, first, step, lambda, stride = 1, column = 0 ) {

	const rows = table.length / stride;
	const u = ( lambda - first ) / step;
	if ( u <= 0 ) return table[ column ];
	if ( u >= rows - 1 ) return table[ ( rows - 1 ) * stride + column ];
	const i = Math.floor( u );
	const f = u - i;
	return table[ i * stride + column ] * ( 1 - f ) + table[ ( i + 1 ) * stride + column ] * f;

}

function binAverage( k, f ) {

	let sum = 0;
	const lo = LAMBDA_MIN + k * LAMBDA_STEP;
	for ( let i = 0; i < LAMBDA_STEP; i ++ ) sum += f( lo + i + 0.5 );
	return sum / LAMBDA_STEP;

}

function bins( f ) {

	const out = new Float64Array( LAMBDA_COUNT );
	for ( let k = 0; k < LAMBDA_COUNT; k ++ ) out[ k ] = binAverage( k, f );
	return out;

}

export const WAVELENGTHS = Float64Array.from( { length: LAMBDA_COUNT }, ( _, k ) => LAMBDA_MIN + ( k + 0.5 ) * LAMBDA_STEP );
export const SOLAR_SPECTRUM = bins( l => sampleTable( SOLAR_IRRADIANCE, 360, 10, l ) );
const RAYLEIGH_SPECTRUM = bins( l => rayleighOpticalDepth( l ) / RAYLEIGH_SCALE_HEIGHT );
const OZONE_SPECTRUM = bins( l => sampleTable( OZONE_CROSS_SECTION, 360, 10, l ) );
const MIE_SPECTRUM = bins( l => Math.pow( l / 1000, - ANGSTROM_ALPHA ) );

// ∫ over each bin of x̄, ȳ, z̄ — so XYZ = Σ L(bin) · CMF(bin) for bin-averaged radiance L.
const CMF_BINS = ( () => {

	const out = new Float64Array( LAMBDA_COUNT * 3 );
	for ( let k = 0; k < LAMBDA_COUNT; k ++ ) {

		for ( let c = 0; c < 3; c ++ ) {

			out[ k * 3 + c ] = binAverage( k, l => sampleTable( CIE_1931, 360, 5, l, 3, c ) ) * LAMBDA_STEP;

		}

	}

	return out;

} )();

/**
 * The 3×16 matrix taking bin-averaged spectral radiance to linear Rec.709, rows R, G, B.
 * @param {number} [scale]
 */
export function spectrumToRec709( scale = 1 ) {

	const out = new Float32Array( 3 * LAMBDA_COUNT );
	for ( let k = 0; k < LAMBDA_COUNT; k ++ ) {

		const X = CMF_BINS[ k * 3 ], Y = CMF_BINS[ k * 3 + 1 ], Z = CMF_BINS[ k * 3 + 2 ];
		for ( let c = 0; c < 3; c ++ ) {

			const m = XYZ_TO_REC709;
			out[ c * LAMBDA_COUNT + k ] = ( m[ c * 3 ] * X + m[ c * 3 + 1 ] * Y + m[ c * 3 + 2 ] * Z ) * scale;

		}

	}

	return out;

}

export function spectrumToXYZ( spectrum ) {

	let X = 0, Y = 0, Z = 0;
	for ( let k = 0; k < LAMBDA_COUNT; k ++ ) {

		X += spectrum[ k ] * CMF_BINS[ k * 3 ];
		Y += spectrum[ k ] * CMF_BINS[ k * 3 + 1 ];
		Z += spectrum[ k ] * CMF_BINS[ k * 3 + 2 ];

	}

	return [ X, Y, Z ];

}

export function xyzToRec709( [ X, Y, Z ] ) {

	const m = XYZ_TO_REC709;
	return [
		m[ 0 ] * X + m[ 1 ] * Y + m[ 2 ] * Z,
		m[ 3 ] * X + m[ 4 ] * Y + m[ 5 ] * Z,
		m[ 6 ] * X + m[ 7 ] * Y + m[ 8 ] * Z,
	];

}

/** Ångström turbidity coefficient from Linke-style turbidity (Preetham et al. 1999, appendix). */
export function angstromBeta( turbidity ) {

	return Math.max( 0, 0.04608365822050 * turbidity - 0.04586025928522 );

}

// Partition of unity over the visible range, so a grey albedo stays exactly grey.
function albedoSpectrum( [ r, g, b ] ) {

	const smooth = ( a, c, x ) => {

		const t = Math.min( Math.max( ( x - a ) / ( c - a ), 0 ), 1 );
		return t * t * ( 3 - 2 * t );

	};

	return Float64Array.from( WAVELENGTHS, l => {

		const wb = 1 - smooth( 470, 520, l );
		const wr = smooth( 560, 610, l );
		return b * wb + r * wr + g * ( 1 - wb - wr );

	} );

}

/**
 * Per-bin coefficients at unit density, km⁻¹.
 * @param {Object} p
 * @param {number} [p.airDensity=1] - Rayleigh multiplier
 * @param {number} [p.turbidity=2] - 1 is aerosol-free
 * @param {number} [p.ozone=300] - column, Dobson units
 * @param {number[]} [p.groundAlbedo=[0.3,0.3,0.3]] - linear Rec.709
 */
export function atmosphereCoefficients( { airDensity = 1, turbidity = 2, ozone = 300, groundAlbedo = [ 0.3, 0.3, 0.3 ] } = {} ) {

	const aerosol = angstromBeta( turbidity ) / MIE_SCALE_HEIGHT;
	const ozonePeak = ozone * DOBSON_UNIT / ( OZONE_HALF_WIDTH * 1000 ) * 1000; // molecules m⁻³ → per km of path

	const rayleigh = new Float64Array( LAMBDA_COUNT );
	const mieExtinction = new Float64Array( LAMBDA_COUNT );
	const mieScattering = new Float64Array( LAMBDA_COUNT );
	const ozoneAbsorption = new Float64Array( LAMBDA_COUNT );

	for ( let k = 0; k < LAMBDA_COUNT; k ++ ) {

		rayleigh[ k ] = RAYLEIGH_SPECTRUM[ k ] * airDensity;
		mieExtinction[ k ] = MIE_SPECTRUM[ k ] * aerosol;
		mieScattering[ k ] = mieExtinction[ k ] * MIE_ALBEDO;
		ozoneAbsorption[ k ] = OZONE_SPECTRUM[ k ] * ozonePeak;

	}

	return { rayleigh, mieScattering, mieExtinction, ozone: ozoneAbsorption, albedo: albedoSpectrum( groundAlbedo ) };

}

export const rayleighDensity = h => Math.exp( - h / RAYLEIGH_SCALE_HEIGHT );
export const mieDensity = h => Math.exp( - h / MIE_SCALE_HEIGHT );
export const ozoneDensity = h => Math.max( 0, 1 - Math.abs( h - OZONE_PEAK_ALTITUDE ) / OZONE_HALF_WIDTH );

/** sin of how far the horizon sits below level, seen from `altitude` km: directions with y below −this hit the ground. */
export function horizonDipSin( altitude ) {

	const h = Math.max( altitude, 0 );
	return Math.sqrt( h * ( 2 * GROUND_RADIUS + h ) ) / ( GROUND_RADIUS + h );

}

/**
 * Density-weighted path length (km) from `altitude` along zenith cosine `mu` to the top of the
 * atmosphere: [ Rayleigh, Mie, ozone ]. Null when the ray meets the ground.
 */
export function opticalDepth( altitude, mu, steps = 1024 ) {

	const h0 = Math.max( altitude, 0 );
	const r = GROUND_RADIUS + h0;
	const b = r * mu;
	const cGround = h0 * ( 2 * GROUND_RADIUS + h0 );
	if ( mu < 0 && b * b >= cGround ) return null;

	const tTop = - b + Math.sqrt( b * b + ( TOP_RADIUS - r ) * ( TOP_RADIUS + r ) );
	let tr = 0, tm = 0, to = 0;
	for ( let i = 0; i < steps; i ++ ) {

		// Squared spacing: the density is near the start of every ray that leaves the ground.
		const t0 = tTop * ( i / steps ) ** 2;
		const t1 = tTop * ( ( i + 1 ) / steps ) ** 2;
		const t = 0.5 * ( t0 + t1 );
		const r2mRg2 = cGround + t * ( t + 2 * b );
		const h = r2mRg2 / ( Math.sqrt( r * r + t * ( t + 2 * b ) ) + GROUND_RADIUS );
		const dt = t1 - t0;
		tr += rayleighDensity( h ) * dt;
		tm += mieDensity( h ) * dt;
		to += ozoneDensity( h ) * dt;

	}

	return [ tr, tm, to ];

}

function transmittanceSpectrum( coefficients, depth ) {

	const out = new Float64Array( LAMBDA_COUNT );
	if ( ! depth ) return out;
	const [ tr, tm, to ] = depth;
	for ( let k = 0; k < LAMBDA_COUNT; k ++ ) {

		out[ k ] = Math.exp( - ( coefficients.rayleigh[ k ] * tr + coefficients.mieExtinction[ k ] * tm + coefficients.ozone[ k ] * to ) );

	}

	return out;

}

// Hestroffer & Magnan 1998: I(µ)/I(1) = µ^α, α = −0.023 + 0.292 / λ[µm], at each primary's centroid.
export const LIMB_DARKENING_EXPONENT = [ 610, 550, 465 ].map( l => - 0.023 + 0.292 / ( l / 1000 ) );

/** Solid angle of a cone of the given half-angle, without the cancellation `2π(1 − cos)` suffers. */
export function coneSolidAngle( halfAngle ) {

	const s = Math.sin( halfAngle / 2 );
	return 4 * Math.PI * s * s;

}

/**
 * The sun as a light: its disc-average radiance (engine units, linear Rec.709) over the part of
 * the disc above the horizon. Near the horizon the transmittance changes across the disc by
 * several times, so it is averaged over the disc rather than read at its centre.
 * @param {Object} p
 * @param {number[]} p.direction - unit, y up
 * @param {number} p.altitude - km
 * @param {number} p.angularDiameter - radians
 * @param {number} [p.strength=1]
 * @param {Object} p.coefficients - from atmosphereCoefficients
 */
export function sunLight( { direction, altitude, angularDiameter, strength = 1, coefficients } ) {

	const halfAngle = angularDiameter / 2;
	const solidAngle = coneSolidAngle( halfAngle );
	const dip = horizonDipSin( altitude );
	const [ dx, dy, dz ] = direction;
	const sinHalf = Math.sin( halfAngle );

	const transmittance = new Float64Array( LAMBDA_COUNT );
	let visible = 0;

	const accumulate = mu => {

		if ( mu < - dip ) return;
		const t = transmittanceSpectrum( coefficients, opticalDepth( altitude, mu, 512 ) );
		for ( let k = 0; k < LAMBDA_COUNT; k ++ ) transmittance[ k ] += t[ k ];
		visible ++;

	};

	if ( dy - sinHalf > 0.1 ) {

		accumulate( dy );

	} else {

		// Only the disc's height changes the transmittance: rows at equal-area steps down it.
		const rows = 48;
		const cosEl = Math.sqrt( Math.max( 0, 1 - dy * dy ) );
		for ( let i = 0; i < rows; i ++ ) {

			const q = ( i + 0.5 ) / rows;
			let lo = - 1, hi = 1;
			for ( let it = 0; it < 30; it ++ ) {

				const m = 0.5 * ( lo + hi );
				const area = ( Math.asin( m ) + m * Math.sqrt( 1 - m * m ) + Math.PI / 2 ) / Math.PI;
				if ( area < q ) lo = m; else hi = m;

			}

			accumulate( dy + 0.5 * ( lo + hi ) * sinHalf * cosEl );

		}

	}

	const radiance = new Float64Array( LAMBDA_COUNT );
	const count = dy - sinHalf > 0.1 ? 1 : 48;
	if ( visible > 0 ) {

		for ( let k = 0; k < LAMBDA_COUNT; k ++ ) {

			radiance[ k ] = SOLAR_SPECTRUM[ k ] * strength / solidAngle * transmittance[ k ] / visible;

		}

	}

	const rgb = xyzToRec709( spectrumToXYZ( radiance ) ).map( v => Math.max( 0, v * SKY_RADIANCE_SCALE ) );

	return {
		radiance: rgb,
		visibleFraction: visible / count,
		solidAngle,
		direction: [ dx, dy, dz ],
	};

}

export const rayleighPhase = nu => 3 / ( 16 * Math.PI ) * ( 1 + nu * nu );

export function miePhase( nu, g = MIE_PHASE_G ) {

	const g2 = g * g;
	return 3 / ( 8 * Math.PI ) * ( 1 - g2 ) / ( 2 + g2 ) * ( 1 + nu * nu ) / Math.pow( 1 + g2 - 2 * g * nu, 1.5 );

}

/**
 * How much of each phase function falls in each incoming cell: rows are viewing directions
 * (zenith cosine uniform over [−1, 1] × azimuth from the sun uniform over [0, π]), columns are
 * incoming cells (zenith cosine bands × azimuth sectors over [0, π], each with its mirror image).
 * Rayleigh rows first, then Mie; every row sums to 1.
 */
export function phaseCellWeights( viewsMu, viewsPhi, bandsMu, sectorsPhi, sub = 8 ) {

	const cells = bandsMu * sectorsPhi;
	const rows = viewsMu * viewsPhi;
	const out = new Float32Array( 2 * rows * cells );
	[ rayleighPhase, nu => miePhase( nu ) ].forEach( ( phase, lobe ) => {

		for ( let v = 0; v < rows; v ++ ) {

			const muV = - 1 + 2 * Math.floor( v / viewsPhi ) / ( viewsMu - 1 );
			const phiV = Math.PI * ( v % viewsPhi ) / ( viewsPhi - 1 );
			const sV = Math.sqrt( Math.max( 0, 1 - muV * muV ) );
			const row = ( lobe * rows + v ) * cells;
			let total = 0;
			for ( let c = 0; c < cells; c ++ ) {

				const band = Math.floor( c / sectorsPhi ), sector = c % sectorsPhi;
				let w = 0;
				for ( let i = 0; i < sub; i ++ ) {

					const mu = - 1 + 2 * ( band + ( i + 0.5 ) / sub ) / bandsMu;
					const s = Math.sqrt( Math.max( 0, 1 - mu * mu ) );
					for ( let j = 0; j < sub; j ++ ) {

						const phi = Math.PI * ( sector + ( j + 0.5 ) / sub ) / sectorsPhi;
						w += phase( muV * mu + sV * s * Math.cos( phiV - phi ) ) + phase( muV * mu + sV * s * Math.cos( phiV + phi ) );

					}

				}

				out[ row + c ] = w;
				total += w;

			}

			for ( let c = 0; c < cells; c ++ ) out[ row + c ] /= total;

		}

	} );

	return out;

}
