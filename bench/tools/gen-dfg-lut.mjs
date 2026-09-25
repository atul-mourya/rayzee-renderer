/**
 * Regenerates the directional-albedo LUT embedded in rayzee/src/TSL/MaterialProperties.js
 * (`_dfgLutData`). Block 0 (the first 16 columns):
 *
 *   R = specular E(NoV, roughness) at F0 = 1   — the divisor the multiscatter compensation needs
 *   G = sheen    E(NoV, sheenRoughness)         — inverted-GGX lobe, Ashikhmin/Neubelt visibility
 *   B = specular E(NoV, roughness) at F0 = 0   — the Schlick "bias" term, for metals
 *
 * Schlick's Fresnel is linear in F0, so E(F0) = F0·(R - B) + B is EXACT for any F0 given R and B.
 *
 * Dielectrics use the exact Fresnel curve, written as F = f0 + (f90 - f0)·s(VoH, eta) with
 * s = (F_exact - F0) / (1 - F0). That is linear in f0 and f90 too, so E = f0·(R - S) + f90·S with
 * S = E of s — but s depends on eta, so S is tabulated in DIELECTRIC_SLICES slices uniform in
 * r0 = (eta - 1)/(eta + 1) over [0, R0_MAX]. Blocks 1.. hold neighbouring pairs, R = S(k) and
 * G = S(k + 1), so one fetch interpolates between slices.
 *
 *   node bench/tools/gen-dfg-lut.mjs
 *
 * E(NoV, roughness) is the hemisphere integral of the renderer's own specular BRDF at F0 = 1 —
 * what the Kulla-Conty compensation must divide by. Estimated by VNDF importance sampling, whose
 * weight collapses to a closed form:
 *
 *   f·NoL/pdf  =  NoL · (NoV + SV) / (NoL·SV + NoV·SL),   S* = sqrt(α² + (1-α²)·N·*²)
 *
 * Following the lobe matters: a uniform hemisphere quadrature under-resolves the narrow lobe at
 * low roughness badly enough to report E ≈ 0.04 where the truth is ≈ 1.
 *
 * THE TABLE IS ONLY VALID FOR THE BRDF/SAMPLER PAIR IT WAS INTEGRATED FROM — height-correlated
 * Smith GGX (VisibilityGGXSmithCorrelated) sampled by sampleGGXVNDF, α = roughness². Change
 * either and this must be re-run, or the compensation silently drifts back out of calibration.
 * Verify with `node bench/runner/cli.js quality --only furnace-metal-mid,furnace-metal-rough`.
 */

const N = 16;       // grid, sampled at ENDPOINTS: index i is i/(N-1), so roughness 1.0 is covered
const SQRT_SAMPLES = 512;
const DIELECTRIC_SLICES = 17;
const R0_MAX = 0.5;     // eta = 3

const sliceEta = k => {

	const r0 = R0_MAX * k / ( DIELECTRIC_SLICES - 1 );
	return ( 1 + r0 ) / ( 1 - r0 );

};

// Unpolarised reflectance of a smooth dielectric interface; the shader's fresnelDielectric.
function fresnelDielectric( c, eta ) {

	const g2 = eta * eta - 1 + c * c;
	if ( g2 <= 0 ) return 1;
	const g = Math.sqrt( g2 );
	const A = ( g - c ) / Math.max( g + c, 1e-12 );
	const B = ( c * ( g + c ) - 1 ) / ( c * ( g - c ) + 1 );
	return 0.5 * A * A * ( 1 + B * B );

}

function dielectricWeight( c, eta ) {

	const r = ( eta - 1 ) / ( eta + 1 );
	const f0 = r * r;
	return Math.min( Math.max( ( fresnelDielectric( c, eta ) - f0 ) / Math.max( 1 - f0, 1e-6 ), 0 ), 1 );

}

function albedo( NoV, roughness, etas = [] ) {

	const a = roughness * roughness;
	const a2 = a * a;
	const Vx = Math.sqrt( Math.max( 1 - NoV * NoV, 0 ) );
	const Vz = NoV;

	// VNDF frame: V lies in the xz-plane, so the tangent basis is fixed.
	const vhLen = Math.hypot( a * Vx, Vz );
	const vhx = a * Vx / vhLen, vhz = Vz / vhLen;

	let full = 0, bias = 0;
	const dielectric = new Float64Array( etas.length );

	for ( let i = 0; i < SQRT_SAMPLES; i ++ ) {

		const u1 = ( i + 0.5 ) / SQRT_SAMPLES;
		const r = Math.sqrt( u1 );

		for ( let j = 0; j < SQRT_SAMPLES; j ++ ) {

			const phi = 2 * Math.PI * ( j + 0.5 ) / SQRT_SAMPLES;
			const t1 = r * Math.cos( phi );
			const t2raw = r * Math.sin( phi );
			const s = 0.5 * ( 1 + vhz );
			const t2 = ( 1 - s ) * Math.sqrt( Math.max( 1 - t1 * t1, 0 ) ) + s * t2raw;
			const t3 = Math.sqrt( Math.max( 1 - t1 * t1 - t2 * t2, 0 ) );

			// Matches the shader's frame: T1 = (0,1,0), T2 = cross(Vh, T1) = (-vhz, 0, vhx).
			// The sign matters — the t2 warp is asymmetric, so a flipped T2 is a different
			// distribution, not a relabelled one.
			const nhx = - t2 * vhz + t3 * vhx;
			const nhy = t1;
			const nhz = t2 * vhx + t3 * vhz;

			let hx = a * nhx, hy = a * nhy, hz = Math.max( nhz, 0 );
			const hl = Math.hypot( hx, hy, hz ) || 1e-12;
			hx /= hl; hy /= hl; hz /= hl;

			const VoH = hx * Vx + hz * Vz;
			const NoL = 2 * VoH * hz - Vz;
			if ( NoL <= 0 ) continue;

			const SV = Math.sqrt( a2 + ( 1 - a2 ) * NoV * NoV );
			const SL = Math.sqrt( a2 + ( 1 - a2 ) * NoL * NoL );
			const w = NoL * ( NoV + SV ) / Math.max( NoL * SV + NoV * SL, 1e-12 );
			const fres = Math.pow( 1 - VoH, 5 );
			full += w;                 // F = 1
			bias += w * fres;          // F = (1 - VoH)^5, i.e. F0 = 0
			for ( let k = 0; k < etas.length; k ++ ) dielectric[ k ] += w * dielectricWeight( VoH, etas[ k ] );

		}

	}

	const n = SQRT_SAMPLES * SQRT_SAMPLES;
	return [ full / n, bias / n, Array.from( dielectric, v => v / n ) ];

}

/**
 * Sheen directional albedo. The lobe is D_sheen · V_sheen, and H is drawn from D_sheen — which is
 * GGX with A² = 1/roughness⁴, so the GGX sampler takes the RECIPROCAL roughness. With pdf(L) =
 * D·NoH/(4·VoH) the D cancels and the estimator is 4·VoH·NoL·V/NoH.
 *
 * This is what the base layer must be attenuated by. The old `(1-r)*0.5 + 0.25` guess claimed
 * 0.55 at sheenRoughness 0.4 where the truth is ~0.27, so the base was darkened for energy the
 * sheen lobe never returned — the white furnace read -27 %.
 */
function sheenAlbedo( NoV, sheenRoughness ) {

	const r = Math.max( sheenRoughness, 0.05 );          // matches MIN_ROUGHNESS in the shader
	const A = 1 / ( r * r );                             // inverted-GGX: A² = 1/r⁴
	const Vx = Math.sqrt( Math.max( 1 - NoV * NoV, 0 ) );
	const Vz = NoV;
	let sum = 0;

	for ( let i = 0; i < SQRT_SAMPLES; i ++ ) {

		const u2 = ( i + 0.5 ) / SQRT_SAMPLES;
		const cosT = Math.sqrt( ( 1 - u2 ) / ( 1 + ( A * A - 1 ) * u2 ) );
		const sinT = Math.sqrt( Math.max( 1 - cosT * cosT, 0 ) );

		for ( let j = 0; j < SQRT_SAMPLES; j ++ ) {

			const phi = 2 * Math.PI * ( j + 0.5 ) / SQRT_SAMPLES;
			const hx = sinT * Math.cos( phi ), hy = sinT * Math.sin( phi ), hz = cosT;
			const VoH = hx * Vx + hz * Vz;
			if ( VoH <= 0 ) continue;
			const NoL = 2 * VoH * hz - Vz;
			if ( NoL <= 0 ) continue;
			const vis = Math.min( 1 / Math.max( 4 * ( NoL + NoV - NoL * NoV ), 1e-9 ), 1 );
			sum += 4 * VoH * NoL * vis / Math.max( hz, 1e-6 );

		}

	}

	return sum / ( SQRT_SAMPLES * SQRT_SAMPLES );

}

const etas = Array.from( { length: DIELECTRIC_SLICES }, ( _, k ) => sliceEta( k ) );
const rows = [];

for ( let i = 0; i < N; i ++ ) {

	const NoV = Math.max( i / ( N - 1 ), 0.02 );        // NoV = 0 is degenerate
	const base = [];
	const slices = [];

	for ( let j = 0; j < N; j ++ ) {

		const roughness = Math.max( j / ( N - 1 ), 0.001 );
		const [ full, bias, dielectric ] = albedo( NoV, roughness, etas );
		base.push( full.toFixed( 4 ), sheenAlbedo( NoV, j / ( N - 1 ) ).toFixed( 4 ), bias.toFixed( 4 ), '1.0000' );
		slices.push( dielectric );

	}

	const cells = [ ...base ];
	for ( let k = 0; k < DIELECTRIC_SLICES - 1; k ++ ) {

		for ( let j = 0; j < N; j ++ ) cells.push( slices[ j ][ k ].toFixed( 4 ), slices[ j ][ k + 1 ].toFixed( 4 ), '1.0000', '1.0000' );

	}

	rows.push( `\t${cells.join( ', ' )},` );

}

// Slice interpolation error against a direct integral, at IORs between slices.
{

	const check = [ 1.33, 1.45, 1.5, 1.6, 1.8, 2.0, 2.42 ];
	let worst = 0;
	for ( const eta of check ) {

		const t = Math.min( ( eta - 1 ) / ( eta + 1 ) / R0_MAX, 1 ) * ( DIELECTRIC_SLICES - 1 );
		const k = Math.min( Math.floor( t ), DIELECTRIC_SLICES - 2 );
		const f = t - k;
		for ( const [ NoV, roughness ] of [ [ 0.2, 0.1 ], [ 0.5, 0.4 ], [ 0.8, 0.8 ], [ 1.0, 0.3 ] ] ) {

			const [ , , pair ] = albedo( NoV, roughness, [ etas[ k ], etas[ k + 1 ], eta ] );
			const interp = pair[ 0 ] + ( pair[ 1 ] - pair[ 0 ] ) * f;
			worst = Math.max( worst, Math.abs( interp - pair[ 2 ] ) );

		}

	}

	process.stderr.write( `slice interpolation: worst |error| ${worst.toFixed( 5 )} (absolute, in albedo)\n` );

}

process.stdout.write( `const _dfgLutData = new Float32Array( [\n${rows.join( '\n' )}\n] );\n` );
