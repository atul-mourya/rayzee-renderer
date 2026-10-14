/**
 * pbrt textures the engine has no node for, baked on the CPU into an image it samples: the `mix` texture,
 * an image texture's `scale` above 1 or `invert`, and a `mix` material whose amount is a texture.
 *
 * A layer is an image as pbrt evaluates it: linear values, top row first, `channels` 1 (a float texture reads
 * an image's alpha where it has one, else the mean of its colour) or 3, already scaled and inverted, and the uv
 * mapping pbrt applies before the lookup (st = scale · uv + delta, image row from the top = 1 − t).
 *
 * pbrt's position mappings (`planar`, `spherical`, `cylindrical`) read no uv: their (s, t) becomes a uv set generated per
 * shape (`generateUV`), and a layer in one carries it as `uv` (`{ type, key, … }`; null for the mesh's own uv).
 */

const MAX_BAKE_SIZE = 4096;

export const uvKey = ( uv ) => uv?.key ?? '';

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
 * @param {{ su: number, sv: number, du: number, dv: number, uv?: object }} [options.mapping]
 */
export function makeLayer( pixels, { channels, decode = null, scale = 1, invert = false, mapping = null } ) {

	const { width, height } = pixels;
	const stride = pixels.channels ?? 4;
	const data = new Float32Array( width * height * channels );
	const topDown = pixels.topDown !== false;
	// pbrt's encoding applies to every channel of an 8-bit image, alpha included.
	const bytes = decode && ( pixels.data instanceof Uint8Array || pixels.data instanceof Uint8ClampedArray );
	const lut = bytes ? Float64Array.from( { length: 256 }, ( _, v ) => decode( v / 255 ) ) : null;
	const read = lut ? ( i ) => lut[ pixels.data[ i ] ] : ( i ) => ( decode ? decode( pixels.data[ i ] / 255 ) : pixels.data[ i ] );
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

	return { width, height, channels, data, su: 1, sv: 1, du: 0, dv: 0, uv: null, ...mapping };

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

function layerMeanRGB( { data, channels } ) {

	const sum = [ 0, 0, 0 ];
	for ( let i = 0; i < data.length; i ++ ) sum[ i % channels ] += data[ i ];
	const texels = data.length / channels || 1;
	return [ 0, 1, 2 ].map( ( c ) => sum[ Math.min( c, channels - 1 ) ] / texels );

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
 * `combine( values )` over the texel grid of the largest image among the terms in the first image's uv set, in that
 * image's uv mapping; a term with another mapping is sampled through it, and one in another uv set counts as its mean
 * (`averaged` says how many). The result is sRGB bytes laid out for a DataTexture
 * (bottom row first), clamped to [0, 1] as pbrt clamps an albedo. Null when every term is a constant.
 * @param {Array<{ rgb?: number[], layer?: object, tint?: number[] }>} terms
 * @param {(values: number[][]) => number[]} combine - linear RGB from each term's linear RGB
 * @param {object} [options]
 * @param {(values: number[][]) => number} [options.alphaOf] - the alpha channel, linear; opaque without it
 * @param {boolean} [options.linear=false] - linear bytes, for a data map
 * @returns {{ data: Uint8Array, width: number, height: number, mapping: { su: number, sv: number, du: number, dv: number, uv: object|null }, averaged: number } | null}
 */
export function bake( terms, combine, { alphaOf = null, linear = false } = {} ) {

	const set = uvKey( terms.find( ( term ) => term.layer )?.layer.uv );
	let driver = null, averaged = 0;
	terms = terms.map( ( term ) => {

		if ( ! term.layer ) return term;
		if ( uvKey( term.layer.uv ) !== set ) {

			averaged ++;
			const mean = layerMeanRGB( term.layer );
			return { rgb: mean.map( ( v, c ) => v * ( term.tint?.[ c ] ?? 1 ) ), clamp: term.clamp };

		}

		if ( ! driver || term.layer.width * term.layer.height > driver.width * driver.height ) driver = term.layer;
		return term;

	} );
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

	return { data: out, width, height, mapping: { su: driver.su, sv: driver.sv, du: driver.du, dv: driver.dv, uv: driver.uv ?? null }, averaged };

}

/** pbrt's mix: ( 1 − amount ) · a + amount · b, amount read from its first channel. */
export const mixOf = ( [ a, b, amount ] ) => {

	const t = amount[ 0 ];
	return [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t, a[ 2 ] + ( b[ 2 ] - a[ 2 ] ) * t ];

};

// The coordinate that goes once around the axis: spherical φ is t, cylindrical φ is s.
const WRAPPED = { spherical: 1, cylindrical: 0 };

/** pbrt-v4's (s, t) of a point in texture space (textures.h: PlanarMapping, SphericalMapping, CylindricalMapping). */
export function mapPoint( mapping, x, y, z, out ) {

	if ( mapping.type === 'planar' ) {

		const { vs, vt } = mapping;
		out[ 0 ] = mapping.ds + x * vs[ 0 ] + y * vs[ 1 ] + z * vs[ 2 ];
		out[ 1 ] = mapping.dt + x * vt[ 0 ] + y * vt[ 1 ] + z * vt[ 2 ];

	} else if ( mapping.type === 'spherical' ) {

		const length = Math.hypot( x, y, z ) || 1;
		const phi = Math.atan2( y, x );
		out[ 0 ] = Math.acos( Math.min( 1, Math.max( - 1, z / length ) ) ) / Math.PI;
		out[ 1 ] = ( phi < 0 ? phi + 2 * Math.PI : phi ) / ( 2 * Math.PI );

	} else {

		out[ 0 ] = ( Math.PI + Math.atan2( y, x ) ) / ( 2 * Math.PI );
		out[ 1 ] = z;

	}

	return out;

}

/**
 * pbrt's (s, t) at each vertex as a uv set, `toTexture` (column-major) taking `positions` to texture space. A triangle
 * across the seam gets copies of its vertices a turn on (`extra` names their sources, `index` the rewritten triangles,
 * null when none); a vertex on the axis takes its triangle's mean angle.
 * @param {Float32Array} positions
 * @param {ArrayLike<number>|null} index
 * @param {number[]} toTexture
 * @param {{ type: string }} mapping
 * @returns {{ uv: Float32Array, index: Uint32Array|null, extra: Uint32Array }}
 */
export function generateUV( positions, index, toTexture, mapping ) {

	const count = positions.length / 3;
	const m = toTexture;
	const k = WRAPPED[ mapping.type ];
	const st = new Float64Array( count * 2 );
	const radius = k === undefined ? null : new Float64Array( count );
	const out = [ 0, 0 ];
	let maxRadius = 0;

	for ( let i = 0; i < count; i ++ ) {

		const px = positions[ i * 3 ], py = positions[ i * 3 + 1 ], pz = positions[ i * 3 + 2 ];
		const x = m[ 0 ] * px + m[ 4 ] * py + m[ 8 ] * pz + m[ 12 ];
		const y = m[ 1 ] * px + m[ 5 ] * py + m[ 9 ] * pz + m[ 13 ];
		const z = m[ 2 ] * px + m[ 6 ] * py + m[ 10 ] * pz + m[ 14 ];
		mapPoint( mapping, x, y, z, out );
		st[ i * 2 ] = out[ 0 ];
		st[ i * 2 + 1 ] = out[ 1 ];
		if ( ! radius ) continue;
		radius[ i ] = Math.hypot( x, y );
		if ( radius[ i ] > maxRadius ) maxRadius = radius[ i ];

	}

	const extra = [];
	let triangles = index;

	if ( radius ) {

		const onAxis = maxRadius * 1e-6;
		const copies = new Map();
		const corner = [ 0, 0, 0 ], value = [ 0, 0, 0 ];
		const triangleCount = ( index ? index.length : count ) / 3;

		for ( let t = 0; t < triangleCount; t ++ ) {

			let lo = Infinity, hi = - Infinity, sum = 0, around = 0;
			for ( let c = 0; c < 3; c ++ ) {

				const v = corner[ c ] = index ? index[ t * 3 + c ] : t * 3 + c;
				if ( radius[ v ] <= onAxis ) continue;
				lo = Math.min( lo, st[ v * 2 + k ] );
				hi = Math.max( hi, st[ v * 2 + k ] );

			}

			const across = hi - lo > 0.5;
			for ( let c = 0; c < 3; c ++ ) {

				const w = st[ corner[ c ] * 2 + k ];
				if ( radius[ corner[ c ] ] <= onAxis ) value[ c ] = NaN;
				else {

					value[ c ] = across && w < 0.5 ? w + 1 : w;
					sum += value[ c ];
					around ++;

				}

			}

			for ( let c = 0; c < 3; c ++ ) {

				const v = corner[ c ];
				const w = Number.isNaN( value[ c ] ) ? ( around > 0 ? sum / around : st[ v * 2 + k ] ) : value[ c ];
				if ( w === st[ v * 2 + k ] ) continue;

				if ( ! index ) {

					st[ v * 2 + k ] = w;
					continue;

				}

				const key = `${v}|${w}`;
				let copy = copies.get( key );
				if ( copy === undefined ) {

					copies.set( key, copy = count + extra.length / 2 );
					extra.push( v, w );

				}

				if ( triangles === index ) triangles = Uint32Array.from( index );
				triangles[ t * 3 + c ] = copy;

			}

		}

	}

	const added = extra.length / 2;
	const uv = new Float32Array( ( count + added ) * 2 );
	for ( let i = 0; i < count * 2; i ++ ) uv[ i ] = st[ i ];
	const sources = new Uint32Array( added );
	for ( let i = 0; i < added; i ++ ) {

		const v = sources[ i ] = extra[ i * 2 ];
		uv[ ( count + i ) * 2 ] = st[ v * 2 ];
		uv[ ( count + i ) * 2 + 1 ] = st[ v * 2 + 1 ];
		uv[ ( count + i ) * 2 + k ] = extra[ i * 2 + 1 ];

	}

	return { uv, index: triangles === index ? null : triangles, extra: sources };

}
