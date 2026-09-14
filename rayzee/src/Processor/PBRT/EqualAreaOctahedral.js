/**
 * Equal-area octahedral environment maps, as pbrt-v4 stores them.
 *
 * `LightSource "infinite" "string filename"` does NOT take a lat-long panorama.
 * pbrt-v4's ImageInfiniteLight reads a square image through EqualAreaSphereToSquare:
 * the upper hemisphere fills a centre diamond and the lower hemisphere the four
 * corner triangles (`imgtool makeequiarea` / `makesky` write this). Sampling one as
 * equirectangular smears the black corners over the whole sphere and puts the sun
 * in the wrong place — the scene goes dark.
 *
 * The engine's environment path (CDF build, importance sampling, background) is
 * equirectangular throughout, so convert once at load rather than teach every
 * consumer a second projection. The light's own transform folds into the same
 * resample, which is also how the engine gets a rotation it cannot otherwise
 * express (its environmentRotation is a single Y angle; pbrt lights carry a full
 * matrix).
 */

import * as M from './PBRTMath.js';

/**
 * pbrt-v4 `EqualAreaSphereToSquare`: unit direction → [0,1]² in the octahedral map.
 * Uses Math.atan where pbrt uses a polynomial approximation — this runs once on the
 * CPU, so take the exact value.
 */
export function equalAreaSphereToSquare( dx, dy, dz ) {

	const x = Math.abs( dx ), y = Math.abs( dy ), z = Math.abs( dz );
	const r = Math.sqrt( Math.max( 0, 1 - z ) );

	const a = Math.max( x, y );
	const b = a === 0 ? 0 : Math.min( x, y ) / a;

	let phi = Math.atan( b ) * ( 2 / Math.PI );
	if ( x < y ) phi = 1 - phi;

	let v = phi * r;
	let u = r - v;

	if ( dz < 0 ) {

		const prevU = u;
		u = 1 - v;
		v = 1 - prevU;

	}

	if ( dx < 0 ) u = - u;
	if ( dy < 0 ) v = - v;

	return [ 0.5 * ( u + 1 ), 0.5 * ( v + 1 ) ];

}

/** 8-bit sRGB → linear, tabulated so a per-tap decode costs a lookup rather than a pow(). */
const SRGB_TO_LINEAR = ( () => {

	const t = new Float32Array( 256 );
	for ( let i = 0; i < 256; i ++ ) {

		const c = i / 255;
		t[ i ] = c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );

	}

	return t;

} )();

/**
 * Bilinear fetch from a tightly packed image, clamped at the edges.
 * `table` maps stored values to linear before filtering; null reads them as-is.
 */
function sampleBilinear( data, width, height, channels, u, v, out, table ) {

	const fx = Math.min( Math.max( u * width - 0.5, 0 ), width - 1 );
	const fy = Math.min( Math.max( v * height - 0.5, 0 ), height - 1 );
	const x0 = Math.floor( fx ), y0 = Math.floor( fy );
	const x1 = Math.min( x0 + 1, width - 1 ), y1 = Math.min( y0 + 1, height - 1 );
	const tx = fx - x0, ty = fy - y0;

	const i00 = ( y0 * width + x0 ) * channels;
	const i10 = ( y0 * width + x1 ) * channels;
	const i01 = ( y1 * width + x0 ) * channels;
	const i11 = ( y1 * width + x1 ) * channels;

	for ( let c = 0; c < 3; c ++ ) {

		const a = table ? table[ data[ i00 + c ] ] : data[ i00 + c ];
		const b = table ? table[ data[ i10 + c ] ] : data[ i10 + c ];
		const d = table ? table[ data[ i01 + c ] ] : data[ i01 + c ];
		const e = table ? table[ data[ i11 + c ] ] : data[ i11 + c ];
		const top = a * ( 1 - tx ) + b * tx;
		const bottom = d * ( 1 - tx ) + e * tx;
		out[ c ] = top * ( 1 - ty ) + bottom * ty;

	}

}

/**
 * Resample a square equal-area octahedral map into an equirectangular RGBA float image.
 *
 * The output uses the engine's own mapping (Environment.js): u = atan2(z,x)/2pi + 0.5,
 * v = 1 - acos(y)/pi, with row 0 at v = 1 so "up" lands at the top like any other HDRI.
 *
 * @param {{data: ArrayLike<number>, width: number, height: number, channels: number,
 *   bottomUp?: boolean, srgb?: boolean}} src - `bottomUp` when row 0 holds the BOTTOM of the
 *   image, which is what three's EXR/HDR loaders produce; pbrt indexes the square top-down, and
 *   reading it the wrong way round turns out to rotate the sky 180° about the light's z axis.
 *   `srgb` when the samples are 8-bit sRGB, as a PNG read back through a canvas is.
 * @param {number[]} lightToWorld - the light's pbrt CTM (column-major 16), or null
 * @param {number} scale - the light's `scale` parameter, baked into the output
 * @param {number} [outWidth] - defaults to the source width, capped at 4096
 * @returns {{data: Float32Array, width: number, height: number}}
 */
export function octahedralToEquirect( src, lightToWorld, scale = 1, outWidth = 0 ) {

	const width = outWidth || Math.min( src.width, 4096 );
	const height = Math.max( 1, width >> 1 );
	const out = new Float32Array( width * height * 4 );

	// Directions go world → light, the opposite of the CTM, matching pbrt's
	// renderFromLight.ApplyInverse(ray.d) before the square lookup.
	const worldToLight = lightToWorld ? M.invert( lightToWorld ) : null;
	const table = src.srgb ? SRGB_TO_LINEAR : null;
	const rgb = [ 0, 0, 0 ];

	for ( let j = 0; j < height; j ++ ) {

		// Row index IS the v axis the engine samples on, so row 0 is v = 0 (straight down)
		// and the last row is v = 1 (up). Verified against a rendered frame — inverting
		// this turns the sky upside down with no other visible symptom.
		const v = ( j + 0.5 ) / height;
		const polar = ( 1 - v ) * Math.PI;
		const sinPolar = Math.sin( polar ), cosPolar = Math.cos( polar );

		for ( let i = 0; i < width; i ++ ) {

			const u = ( i + 0.5 ) / width;
			const azimuth = ( u - 0.5 ) * 2 * Math.PI;

			let dx = sinPolar * Math.cos( azimuth );
			let dy = cosPolar;
			let dz = sinPolar * Math.sin( azimuth );

			if ( worldToLight ) {

				const m = worldToLight;
				const tx = m[ 0 ] * dx + m[ 4 ] * dy + m[ 8 ] * dz;
				const ty = m[ 1 ] * dx + m[ 5 ] * dy + m[ 9 ] * dz;
				const tz = m[ 2 ] * dx + m[ 6 ] * dy + m[ 10 ] * dz;
				const len = Math.hypot( tx, ty, tz ) || 1;
				dx = tx / len; dy = ty / len; dz = tz / len;

			}

			const [ su, sv ] = equalAreaSphereToSquare( dx, dy, dz );
			sampleBilinear( src.data, src.width, src.height, src.channels, su, src.bottomUp ? 1 - sv : sv, rgb, table );

			const o = ( j * width + i ) * 4;
			out[ o ] = rgb[ 0 ] * scale;
			out[ o + 1 ] = rgb[ 1 ] * scale;
			out[ o + 2 ] = rgb[ 2 ] * scale;
			out[ o + 3 ] = 1;

		}

	}

	return { data: out, width, height };

}
