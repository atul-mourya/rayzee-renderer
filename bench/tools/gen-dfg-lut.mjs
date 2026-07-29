/**
 * Regenerates the two-channel directional-albedo LUT embedded in
 * rayzee/src/TSL/MaterialProperties.js (`_dfgLutData`).
 *
 *   R = specular E(NoV, roughness) at F0 = 1   — the divisor the multiscatter compensation needs
 *   G = sheen    E(NoV, sheenRoughness)         — inverted-GGX lobe, Ashikhmin/Neubelt visibility
 *   B = specular E(NoV, roughness) at F0 = 0   — the Schlick "bias" term
 *
 * Schlick's Fresnel is linear in F0, so E(F0) = F0·(R - B) + B is EXACT for any F0 given R and B.
 * That removes the last borrowed fit: the F0 split used to come from Karis's polynomial shape with
 * only its overall level corrected, which left the F0 = 0.04 dielectrics about 1 pp off.
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

function albedo( NoV, roughness ) {

	const a = roughness * roughness;
	const a2 = a * a;
	const Vx = Math.sqrt( Math.max( 1 - NoV * NoV, 0 ) );
	const Vz = NoV;

	// VNDF frame: V lies in the xz-plane, so the tangent basis is fixed.
	const vhLen = Math.hypot( a * Vx, Vz );
	const vhx = a * Vx / vhLen, vhz = Vz / vhLen;

	let full = 0, bias = 0;

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

		}

	}

	const n = SQRT_SAMPLES * SQRT_SAMPLES;
	return [ full / n, bias / n ];

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

const rows = [];

for ( let i = 0; i < N; i ++ ) {

	const NoV = Math.max( i / ( N - 1 ), 0.02 );        // NoV = 0 is degenerate
	const cells = [];

	for ( let j = 0; j < N; j ++ ) {

		const roughness = Math.max( j / ( N - 1 ), 0.001 );
		const [ full, bias ] = albedo( NoV, roughness );
		cells.push( full.toFixed( 4 ) );
		cells.push( sheenAlbedo( NoV, j / ( N - 1 ) ).toFixed( 4 ) );
		cells.push( bias.toFixed( 4 ) );
		cells.push( '1.0000' );        // unused; RGBA because RGB float textures are not portable

	}

	rows.push( `\t${cells.join( ', ' )},` );

}

process.stdout.write( `const _dfgLutData = new Float32Array( [\n${rows.join( '\n' )}\n] );\n` );
