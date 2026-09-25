/**
 * The readback half of the view transform: linear float pixels to display bytes, in the output
 * pass's order. Shared by OIDN, the AI upscaler and `renderToBuffer`.
 *
 * The curves themselves live in `../Color/ViewTransforms.js`, declared beside their WGSL and TSL
 * counterparts, because a saved image that differs from the viewport is the failure this file
 * exists to prevent. What stays here is everything around the curve — exposure, the saturation
 * grade, the transfer function and the byte rounding.
 *
 * ⚠️ Rounding is deliberately bug-compatible. This writes `srgb * 255 + 0.5` into a
 * `Uint8ClampedArray`, which rounds again, so the result has always been half a level bright.
 * `ToneMapGPU.js` reproduces it exactly. Dropping the extra half would shift every image.
 */

import { NoToneMapping } from 'three';
import { VIEW_TRANSFORMS, getViewTransform, onRegistryChange } from '../Color/ViewTransforms.js';

/**
 * Three.js clamps the fragment output with `.max( 0 )` *before* tone mapping (NodeMaterial.js,
 * "force unsigned floats"), so the GPU curves never see a negative channel. The Compositor's
 * saturation grade (default 1.2) drives complementary channels below zero on a third of a typical
 * frame, and AgX/Neutral mix those negatives across channels instead of clipping them — measured
 * 7-10 levels of shadow error against the viewport until the readback clamps the same way.
 */
const clampNegative = fn => ( r, g, b, exposure, out ) =>
	fn( r > 0 ? r : 0, g > 0 ? g : 0, b > 0 ? b : 0, exposure, out );

/**
 * Three.js ToneMapping constant → CPU function.
 *
 * Rebuilt in place rather than replaced: callers hold this Map, and loading a config adds entries
 * to it long after they captured it.
 */
export const TONE_MAP_FNS = new Map();

function rebuild() {

	TONE_MAP_FNS.clear();
	for ( const t of VIEW_TRANSFORMS.values() ) TONE_MAP_FNS.set( t.id, clampNegative( t.cpu ) );

}

rebuild();
onRegistryChange( rebuild );

/**
 * Whether this transform already returned display-encoded colour.
 *
 * Three.js's seven curves return linear and the output pass encodes them. An OCIO view returns
 * colour encoded for its own display — sRGB, Rec.1886 or PQ — and encoding that again is the
 * single most visible way to get colour management wrong.
 */
export function isOutputEncoded( toneMapping ) {

	return getViewTransform( toneMapping )?.outputEncoded === true;

}

/** sRGB gamma (1/2.2) — fast pow approximation. Prefer `linearToSRGB` when matching three.js. */
export const SRGB_GAMMA = 1 / 2.2;

/**
 * Proper sRGB OETF, matching three.js `sRGBTransferOETF` (`1.055 * c^(1/2.4) - 0.055` with a
 * `12.92 * c` linear segment below 0.0031308).
 */
export function linearToSRGB( c ) {

	return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow( c, 1 / 2.4 ) - 0.055;

}

/**
 * The transfer step, skipped for a transform that encoded its own output.
 * @param {number} c - a single channel, post-curve
 */
export function encodeForDisplay( c, toneMapping ) {

	return isOutputEncoded( toneMapping ) ? Math.min( Math.max( c, 0 ), 1 ) : linearToSRGB( c );

}

/**
 * Exposure as the WebGPU output pass applies it.
 *
 * Three.js applies `toneMappingExposure` *inside* ToneMappingNode's branch, and that branch
 * returns the colour untouched for NoToneMapping (`if ( toneMapping === NoToneMapping ) return
 * colorNode`). So exposure is a no-op on screen there, and a CPU readback that applied it anyway
 * paints brighter than the viewport it replaces — measured +33.6 % at exposure 2.
 *
 * @param {number} exposure - renderer.toneMappingExposure
 * @param {number} toneMapping - a registered view transform id
 */
export function effectiveExposure( exposure, toneMapping ) {

	const t = getViewTransform( toneMapping );
	if ( ! t ) return toneMapping === NoToneMapping ? 1.0 : exposure;
	return t.appliesExposure ? exposure : 1.0;

}

/** Rec.709 luminance coefficients (same as Display / Common.js). */
const LUM_R = 0.2126, LUM_G = 0.7152, LUM_B = 0.0722;

/**
 * Pre-tonemapping saturation adjustment matching Display's GPU shader:
 *   mix( vec3(luma), exposed, saturation )
 * Operates in-place on the `out` array (expects exposed linear RGB).
 * @param {Float32Array|number[]} out - [r, g, b] to adjust
 * @param {number} saturation - 1.0 = neutral
 */
export function applySaturation( out, saturation ) {

	if ( saturation === 1.0 ) return;
	const luma = out[ 0 ] * LUM_R + out[ 1 ] * LUM_G + out[ 2 ] * LUM_B;
	out[ 0 ] = luma + ( out[ 0 ] - luma ) * saturation;
	out[ 1 ] = luma + ( out[ 1 ] - luma ) * saturation;
	out[ 2 ] = luma + ( out[ 2 ] - luma ) * saturation;

}

/**
 * Linear float RGBA → display bytes, in the output pass's order: exposure, saturation, curve,
 * transfer function. Not interchangeable — moving any step shifts every mid-tone.
 *
 * @param {Float32Array} linear - RGBA, 4 floats per pixel
 * @param {Object} options
 * @param {number} options.exposure - renderer.toneMappingExposure, raw
 * @param {number} options.toneMapping - a registered view transform id
 * @param {number} [options.saturation=1]
 * @param {boolean} [options.preserveAlpha=false]
 * @returns {Uint8ClampedArray} RGBA bytes
 */
export function toneMapToRGBA8( linear, { exposure, toneMapping, saturation = 1, preserveAlpha = false } ) {

	const curve = TONE_MAP_FNS.get( toneMapping ) ?? TONE_MAP_FNS.get( NoToneMapping );
	const gain = effectiveExposure( exposure, toneMapping );
	const encoded = isOutputEncoded( toneMapping );
	const out = new Uint8ClampedArray( linear.length );
	const scratch = [ 0, 0, 0 ];

	for ( let i = 0; i < linear.length; i += 4 ) {

		scratch[ 0 ] = linear[ i ] * gain;
		scratch[ 1 ] = linear[ i + 1 ] * gain;
		scratch[ 2 ] = linear[ i + 2 ] * gain;

		applySaturation( scratch, saturation );
		curve( scratch[ 0 ], scratch[ 1 ], scratch[ 2 ], 1.0, scratch );

		if ( encoded ) {

			out[ i ] = scratch[ 0 ] * 255 + 0.5;
			out[ i + 1 ] = scratch[ 1 ] * 255 + 0.5;
			out[ i + 2 ] = scratch[ 2 ] * 255 + 0.5;

		} else {

			out[ i ] = linearToSRGB( scratch[ 0 ] ) * 255 + 0.5;
			out[ i + 1 ] = linearToSRGB( scratch[ 1 ] ) * 255 + 0.5;
			out[ i + 2 ] = linearToSRGB( scratch[ 2 ] ) * 255 + 0.5;

		}

		out[ i + 3 ] = preserveAlpha ? linear[ i + 3 ] * 255 + 0.5 : 255;

	}

	return out;

}
