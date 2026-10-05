/**
 * pbrt textures the engine has no node for, baked on the CPU into an image it samples: the `mix` texture,
 * an image texture's `scale` above 1 or `invert`, and a `mix` material whose amount is a texture.
 *
 * A layer is an image as pbrt evaluates it: linear values, top row first, `channels` 1 (a float texture reads
 * an image's alpha where it has one, else the mean of its colour) or 3, already scaled and inverted, and the uv
 * mapping pbrt applies before the lookup (st = scale · uv + delta, image row from the top = 1 − t).
 */

const MAX_BAKE_SIZE = 4096;

export const srgbToLinear = ( v ) => ( v <= 0.04045 ? v / 12.92 : ( ( v + 0.055 ) / 1.055 ) ** 2.4 );
export const linearToSRGB = ( v ) => ( v <= 0.0031308 ? v * 12.92 : 1.055 * v ** ( 1 / 2.4 ) - 0.055 );

/**
 * @param {{ data: ArrayLike<number>, width: number, height: number, channels?: number, topDown?: boolean }} pixels -
 *   8-bit (0–255) or float values, `channels` per texel (4 if unsaid)
 * @param {object} options
 * @param {number} options.channels - 1 for a float texture, 3 for a spectrum one
 * @param {(v: number) => number} [options.decode] - 8-bit value / 255 → linear; omitted for float data
 * @param {number} [options.scale=1]
 * @param {boolean} [options.invert=false]
 * @param {{ su: number, sv: number, du: number, dv: number }} [options.mapping]
 */
export function makeLayer( pixels, { channels, decode = null, scale = 1, invert = false, mapping = null } ) {

	const { width, height } = pixels;
	const stride = pixels.channels ?? 4;
	const data = new Float32Array( width * height * channels );
	const topDown = pixels.topDown !== false;
	// pbrt's encoding applies to every channel of an 8-bit image, alpha included.
	const read = ( i ) => ( decode ? decode( pixels.data[ i ] / 255 ) : pixels.data[ i ] );
	const fromAlpha = channels === 1 && stride === 4 && hasAlpha( pixels );
	const mean = channels === 1 && stride >= 3 && ! fromAlpha;

	for ( let y = 0; y < height; y ++ ) {

		const row = topDown ? y : height - 1 - y;
		for ( let x = 0; x < width; x ++ ) {

			const src = ( row * width + x ) * stride, dst = ( y * width + x ) * channels;
			for ( let c = 0; c < channels; c ++ ) {

				const raw = fromAlpha ? read( src + 3 )
					: mean ? ( read( src ) + read( src + 1 ) + read( src + 2 ) ) / 3
						: read( src + Math.min( c, stride - 1 ) );
				const v = scale * raw;
				data[ dst + c ] = invert ? Math.max( 0, 1 - v ) : v;

			}

		}

	}

	return { width, height, channels, data, su: 1, sv: 1, du: 0, dv: 0, ...mapping };

}

/** Whether an RGBA image's alpha is anything but opaque — pbrt reads it as an RGB image when it is not. */
export function hasAlpha( pixels ) {

	const { data } = pixels;
	const one = pixels.float ? 1 : 255;
	for ( let i = 3; i < data.length; i += 4 ) if ( data[ i ] !== one ) return true;
	return false;

}

/** The layer's mean value (a float layer's only channel; a spectrum layer's average of three). */
export function layerMean( layer ) {

	let sum = 0;
	for ( let i = 0; i < layer.data.length; i ++ ) sum += layer.data[ i ];
	return layer.data.length ? sum / layer.data.length : 0;

}

// Bilinear, repeating, at pbrt's (s, t).
function sample( layer, s, t, out ) {

	const { width: w, height: h, channels: n, data } = layer;
	const x = s * w - 0.5, y = ( 1 - t ) * h - 0.5;
	const x0 = Math.floor( x ), y0 = Math.floor( y );
	const fx = x - x0, fy = y - y0;
	const wrap = ( i, size ) => ( ( i % size ) + size ) % size;
	const xa = wrap( x0, w ), xb = wrap( x0 + 1, w ), ya = wrap( y0, h ), yb = wrap( y0 + 1, h );

	for ( let c = 0; c < 3; c ++ ) {

		const k = Math.min( c, n - 1 );
		const top = data[ ( ya * w + xa ) * n + k ] * ( 1 - fx ) + data[ ( ya * w + xb ) * n + k ] * fx;
		const bottom = data[ ( yb * w + xa ) * n + k ] * ( 1 - fx ) + data[ ( yb * w + xb ) * n + k ] * fx;
		out[ c ] = top * ( 1 - fy ) + bottom * fy;

	}

	return out;

}

/**
 * Each term is `{ rgb }` (a constant) or `{ layer, tint? }` (an image, times `tint`); `clamp` clamps it to [0, 1]
 * first, as pbrt clamps a colour texture read as an albedo, before anything mixes it. Evaluates
 * `combine( values )` over the texel grid of the largest image among the terms, in that image's uv mapping;
 * a term with another mapping is sampled through it. The result is sRGB bytes laid out for a DataTexture
 * (bottom row first), clamped to [0, 1] as pbrt clamps an albedo. Null when every term is a constant.
 * @param {Array<{ rgb?: number[], layer?: object, tint?: number[] }>} terms
 * @param {(values: number[][]) => number[]} combine - linear RGB from each term's linear RGB
 * @param {object} [options]
 * @param {(values: number[][]) => number} [options.alphaOf] - the alpha channel, linear; opaque without it
 * @param {boolean} [options.linear=false] - linear bytes, for a data map
 * @returns {{ data: Uint8Array, width: number, height: number, mapping: { su: number, sv: number, du: number, dv: number } } | null}
 */
export function bake( terms, combine, { alphaOf = null, linear = false } = {} ) {

	let driver = null;
	for ( const term of terms ) if ( term.layer && ( ! driver || term.layer.width * term.layer.height > driver.width * driver.height ) ) driver = term.layer;
	if ( ! driver ) return null;

	const width = Math.min( driver.width, MAX_BAKE_SIZE ), height = Math.min( driver.height, MAX_BAKE_SIZE );
	const out = new Uint8Array( width * height * 4 );
	const values = terms.map( () => [ 0, 0, 0 ] );

	for ( let j = 0; j < height; j ++ ) {

		const t = ( j + 0.5 ) / height;
		const v = ( t - driver.dv ) / driver.sv;

		for ( let i = 0; i < width; i ++ ) {

			const s = ( i + 0.5 ) / width;
			const u = ( s - driver.du ) / driver.su;

			for ( let k = 0; k < terms.length; k ++ ) {

				const term = terms[ k ], value = values[ k ];
				if ( term.layer ) {

					const L = term.layer;
					sample( L, L === driver ? s : L.su * u + L.du, L === driver ? t : L.sv * v + L.dv, value );
					if ( term.tint ) for ( let c = 0; c < 3; c ++ ) value[ c ] *= term.tint[ c ];

				} else {

					value[ 0 ] = term.rgb[ 0 ]; value[ 1 ] = term.rgb[ 1 ]; value[ 2 ] = term.rgb[ 2 ];

				}

				if ( term.clamp ) for ( let c = 0; c < 3; c ++ ) value[ c ] = Math.min( 1, Math.max( 0, value[ c ] ) );

			}

			const rgb = combine( values );
			const o = ( j * width + i ) * 4;
			for ( let c = 0; c < 3; c ++ ) {

				const v = Math.min( 1, Math.max( 0, rgb[ c ] ) );
				out[ o + c ] = Math.round( 255 * ( linear ? v : linearToSRGB( v ) ) );

			}

			out[ o + 3 ] = alphaOf ? Math.round( 255 * Math.min( 1, Math.max( 0, alphaOf( values ) ) ) ) : 255;

		}

	}

	return { data: out, width, height, mapping: { su: driver.su, sv: driver.sv, du: driver.du, dv: driver.dv } };

}

/** pbrt's mix: ( 1 − amount ) · a + amount · b, amount read from its first channel. */
export const mixOf = ( [ a, b, amount ] ) => {

	const t = amount[ 0 ];
	return [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t ];

};
