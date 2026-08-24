/**
 * CPU tone mapping functions matching Three.js ToneMappingFunctions.js (WebGPU).
 * Shared between OIDNDenoiser and AIUpscaler for consistent HDR → sRGB conversion.
 *
 * All functions write tonemapped linear RGB [0,1] into the `out` array.
 */
import {
	NoToneMapping, LinearToneMapping, ReinhardToneMapping,
	CineonToneMapping, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping
} from 'three';

const clamp01 = x => Math.min( Math.max( x, 0 ), 1 );

function noToneMap( r, g, b, _exposure, out ) {

	out[ 0 ] = clamp01( r );
	out[ 1 ] = clamp01( g );
	out[ 2 ] = clamp01( b );

}

function linearToneMap( r, g, b, exposure, out ) {

	out[ 0 ] = clamp01( r * exposure );
	out[ 1 ] = clamp01( g * exposure );
	out[ 2 ] = clamp01( b * exposure );

}

function reinhardToneMap( r, g, b, exposure, out ) {

	r *= exposure; g *= exposure; b *= exposure;
	out[ 0 ] = clamp01( r / ( r + 1 ) );
	out[ 1 ] = clamp01( g / ( g + 1 ) );
	out[ 2 ] = clamp01( b / ( b + 1 ) );

}

function cineonToneMap( r, g, b, exposure, out ) {

	r = Math.max( r * exposure - 0.004, 0 );
	g = Math.max( g * exposure - 0.004, 0 );
	b = Math.max( b * exposure - 0.004, 0 );
	const f = c => Math.pow( ( c * ( 6.2 * c + 0.5 ) ) / ( c * ( 6.2 * c + 1.7 ) + 0.06 ), 2.2 );
	out[ 0 ] = f( r );
	out[ 1 ] = f( g );
	out[ 2 ] = f( b );

}

function acesFilmicToneMap( r, g, b, exposure, out ) {

	r = r * exposure / 0.6;
	g = g * exposure / 0.6;
	b = b * exposure / 0.6;

	let ir = 0.59719 * r + 0.35458 * g + 0.04823 * b;
	let ig = 0.07600 * r + 0.90834 * g + 0.01566 * b;
	let ib = 0.02840 * r + 0.13383 * g + 0.83777 * b;

	const fit = c => ( c * ( c + 0.0245786 ) - 0.000090537 ) / ( c * ( 0.983729 * c + 0.4329510 ) + 0.238081 );
	ir = fit( ir ); ig = fit( ig ); ib = fit( ib );

	out[ 0 ] = clamp01( 1.60475 * ir - 0.53108 * ig - 0.07367 * ib );
	out[ 1 ] = clamp01( - 0.10208 * ir + 1.10813 * ig - 0.00605 * ib );
	out[ 2 ] = clamp01( - 0.00327 * ir - 0.07276 * ig + 1.07602 * ib );

}

function agxToneMap( r, g, b, exposure, out ) {

	r *= exposure; g *= exposure; b *= exposure;

	let cr = 0.6274 * r + 0.3293 * g + 0.0433 * b;
	let cg = 0.0691 * r + 0.9195 * g + 0.0113 * b;
	let cb = 0.0164 * r + 0.0880 * g + 0.8956 * b;

	let ar = 0.856627153315983 * cr + 0.0951212405381588 * cg + 0.0482516061458583 * cb;
	let ag = 0.137318972929847 * cr + 0.761241990602591 * cg + 0.101439036467562 * cb;
	let ab = 0.11189821299995 * cr + 0.0767994186031903 * cg + 0.811302368396859 * cb;

	const AgxMinEv = - 12.47393, AgxMaxEv = 4.026069, range = AgxMaxEv - AgxMinEv;
	ar = clamp01( ( Math.log2( Math.max( ar, 1e-10 ) ) - AgxMinEv ) / range );
	ag = clamp01( ( Math.log2( Math.max( ag, 1e-10 ) ) - AgxMinEv ) / range );
	ab = clamp01( ( Math.log2( Math.max( ab, 1e-10 ) ) - AgxMinEv ) / range );

	const approx = x => {

		const x2 = x * x, x4 = x2 * x2;
		return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;

	};

	ar = approx( ar ); ag = approx( ag ); ab = approx( ab );

	let or = 1.1271005818144368 * ar - 0.11060664309660323 * ag - 0.016493938717834573 * ab;
	let og = - 0.1413297634984383 * ar + 1.157823702216272 * ag - 0.016493938717834257 * ab;
	let ob = - 0.14132976349843826 * ar - 0.11060664309660294 * ag + 1.2519364065950405 * ab;

	or = Math.pow( Math.max( 0, or ), 2.2 );
	og = Math.pow( Math.max( 0, og ), 2.2 );
	ob = Math.pow( Math.max( 0, ob ), 2.2 );

	out[ 0 ] = clamp01( 1.6605 * or - 0.5876 * og - 0.0728 * ob );
	out[ 1 ] = clamp01( - 0.1246 * or + 1.1329 * og - 0.0083 * ob );
	out[ 2 ] = clamp01( - 0.0182 * or - 0.1006 * og + 1.1187 * ob );

}

function neutralToneMap( r, g, b, exposure, out ) {

	const StartCompression = 0.8 - 0.04;
	const Desaturation = 0.15;

	r *= exposure; g *= exposure; b *= exposure;

	const x = Math.min( r, Math.min( g, b ) );
	const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;

	r -= offset; g -= offset; b -= offset;

	const peak = Math.max( r, Math.max( g, b ) );

	if ( peak < StartCompression ) {

		out[ 0 ] = r; out[ 1 ] = g; out[ 2 ] = b;
		return;

	}

	const d = 1 - StartCompression;
	const newPeak = 1 - d * d / ( peak + d - StartCompression );
	const scale = newPeak / peak;
	r *= scale; g *= scale; b *= scale;
	const gFactor = 1 - 1 / ( Desaturation * ( peak - newPeak ) + 1 );

	out[ 0 ] = r + ( newPeak - r ) * gFactor;
	out[ 1 ] = g + ( newPeak - g ) * gFactor;
	out[ 2 ] = b + ( newPeak - b ) * gFactor;

}

/**
 * Three.js clamps the fragment output with `.max( 0 )` *before* tone mapping
 * (NodeMaterial.js, "force unsigned floats"), so the GPU curves never see a negative
 * channel. Compositor's saturation grade (default 1.2) drives complementary channels
 * below zero on a third of a typical frame, and AgX/Neutral mix those negatives across
 * channels instead of clipping them — measured 7-10 levels of shadow error against the
 * viewport until the readback clamps the same way.
 */
const clampNegative = fn => ( r, g, b, exposure, out ) =>
	fn( r > 0 ? r : 0, g > 0 ? g : 0, b > 0 ? b : 0, exposure, out );

/** Look-up table mapping Three.js ToneMapping constants to CPU functions. */
export const TONE_MAP_FNS = new Map( [
	[ NoToneMapping, clampNegative( noToneMap ) ],
	[ LinearToneMapping, clampNegative( linearToneMap ) ],
	[ ReinhardToneMapping, clampNegative( reinhardToneMap ) ],
	[ CineonToneMapping, clampNegative( cineonToneMap ) ],
	[ ACESFilmicToneMapping, clampNegative( acesFilmicToneMap ) ],
	[ AgXToneMapping, clampNegative( agxToneMap ) ],
	[ NeutralToneMapping, clampNegative( neutralToneMap ) ]
] );

/** sRGB gamma (1/2.2) — fast pow approximation. Prefer `linearToSRGB` when matching Three.js's output. */
export const SRGB_GAMMA = 1 / 2.2;

/**
 * Proper sRGB OETF, matching Three.js `sRGBTransferOETF` (`1.055 * c^(1/2.4) - 0.055`
 * with a `12.92 * c` linear segment below 0.0031308). Use this when the CPU readback
 * needs to match the WebGPU output pass's sRGB encoding.
 */
export function linearToSRGB( c ) {

	return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055;

}

/**
 * Exposure as the WebGPU output pass applies it.
 *
 * Three.js applies `toneMappingExposure` *inside* ToneMappingNode's tone-mapping branch, and
 * that branch returns the colour untouched for NoToneMapping (ToneMappingNode.js: `if
 * ( toneMapping === NoToneMapping ) return colorNode`). So exposure is a no-op on screen there,
 * and a CPU readback that applies it anyway paints brighter than the viewport it replaces
 * (measured +33.6 % at exposure 2).
 *
 * @param {number} exposure - renderer.toneMappingExposure
 * @param {number} toneMapping - Three.js ToneMapping constant
 * @returns {number}
 */
export function effectiveExposure( exposure, toneMapping ) {

	return toneMapping === NoToneMapping ? 1.0 : exposure;

}

/** Rec.709 luminance coefficients (same as Display / Common.js). */
const LUM_R = 0.2126, LUM_G = 0.7152, LUM_B = 0.0722;

/**
 * Pre-tonemapping saturation adjustment matching Display's GPU shader:
 *   mix( vec3(luma), exposed, saturation )
 * Operates in-place on the `out` array (expects exposed linear RGB).
 * @param {Float32Array} out - [r, g, b] to adjust
 * @param {number} saturation - 1.0 = neutral
 */
export function applySaturation( out, saturation ) {

	if ( saturation === 1.0 ) return;
	const luma = out[ 0 ] * LUM_R + out[ 1 ] * LUM_G + out[ 2 ] * LUM_B;
	out[ 0 ] = luma + ( out[ 0 ] - luma ) * saturation;
	out[ 1 ] = luma + ( out[ 1 ] - luma ) * saturation;
	out[ 2 ] = luma + ( out[ 2 ] - luma ) * saturation;

}
