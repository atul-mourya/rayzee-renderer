/**
 * An environment's sampling table: piecewise constant over cells of at most EXACT_TABLE_MAX_WIDTH × half that,
 * so a direction's density is its cell's share, read back from the same cumulative sums it is drawn from.
 * MIS-compensated (Karlík et al. 2019): each texel weighs what it has above the mean, and BSDF-sampled rays
 * cover the rest. A guide per running sum (Chen & Hsu's cutpoint method) starts each search within a cell or
 * two of its answer. Pure math: CDFWorker runs it too.
 */

export const EXACT_TABLE_MAX_WIDTH = 1024;

// Every cell keeps this share of the mean, so light tracing or NEE alone covers the whole sphere.
const FLOOR = 1e-4;

/** Cells the table has for a width × height environment; TSL/Environment.js derives the same. */
export function exactTableSize( width, height ) {

	const k = Math.max( 1, Math.ceil( width / EXACT_TABLE_MAX_WIDTH ) );
	return { k, width: Math.ceil( width / k ), height: Math.ceil( height / k ) };

}

// For each of n equal steps of a running sum, the first entry above the step's start; n − 1 past the end.
function cutpoints( cdf, offset, n, out, outOffset ) {

	let x = 0;
	for ( let g = 0; g < n; g ++ ) {

		while ( x < n - 1 && cdf[ offset + x ] <= g / n ) x ++;
		out[ outOffset + g ] = x;

	}

}

/**
 * @param {Float32Array} floatData - RGBA, row 0 the nadir
 * @param {{ filtered?: boolean }} [options] - filtered false: each texel weighs as itself (the physical sky's GPU twin)
 * @returns {{ exactWidth: number, exactHeight: number, exactConditional: Float32Array, exactMarginal: Float32Array,
 *   exactRowGuide: Float32Array, exactMarginalGuide: Float32Array, radianceIntegral: number }}
 *   each row's running sum over its cells and the rows' over all, both ending at 1, and their guides; ∫ luminance dω.
 */
export function buildExactEnvironmentTable( floatData, width, height, { filtered = true } = {} ) {

	const { k, width: w, height: h } = exactTableSize( width, height );
	const lum = new Float32Array( width * height );
	let raw = 0;
	for ( let y = 0; y < height; y ++ ) {

		const sinTheta = Math.sin( Math.PI * ( y + 0.5 ) / height );
		for ( let x = 0; x < width; x ++ ) {

			const i = 4 * ( y * width + x );
			const l = 0.2126 * floatData[ i ] + 0.7152 * floatData[ i + 1 ] + 0.0722 * floatData[ i + 2 ];
			lum[ y * width + x ] = Number.isFinite( l ) && l > 0 ? l : 0;
			raw += lum[ y * width + x ] * sinTheta;

		}

	}

	// Each texel weighs as the bilinear filter's mean over it — 1/8, 6/8, 1/8 of its neighbours along each axis — so
	// a cell has weight wherever the filtered map has light, and a sharp texel's neighbours only their share of it.
	const TAP = [ 1 / 8, 6 / 8, 1 / 8 ];
	const eachTexel = ( visit ) => {

		for ( let y = 0; y < height; y ++ ) {

			const sinTheta = Math.sin( Math.PI * ( y + 0.5 ) / height );
			const row = Math.floor( y / k ) * w;
			const ys = [ Math.max( y - 1, 0 ), y, Math.min( y + 1, height - 1 ) ];
			for ( let x = 0; x < width; x ++ ) {

				let value = lum[ y * width + x ];
				if ( filtered ) {

					const xs = [ ( x + width - 1 ) % width, x, ( x + 1 ) % width ];
					value = 0;
					for ( let j = 0; j < 3; j ++ ) for ( let i = 0; i < 3; i ++ ) value += TAP[ j ] * TAP[ i ] * lum[ ys[ j ] * width + xs[ i ] ];

				}

				visit( row + Math.floor( x / k ), value * sinTheta );

			}

		}

	};

	let filteredTotal = 0;
	eachTexel( ( cell, weight ) => void ( filteredTotal += weight ) );
	const mean = filteredTotal / ( width * height );
	const cells = new Float64Array( w * h );
	let compensated = 0;
	eachTexel( ( cell, weight ) => {

		cells[ cell ] += Math.max( weight - mean, 0 );
		compensated += Math.max( weight - mean, 0 );

	} );
	// A flat map has nothing above its mean: then the raw weights.
	if ( ! ( compensated > 0 ) ) {

		cells.fill( 0 );
		eachTexel( ( cell, weight ) => void ( cells[ cell ] += weight ) );

	}

	const floor = filteredTotal > 0 ? FLOOR * filteredTotal / ( w * h ) : 0;
	const exactConditional = new Float32Array( w * h );
	const exactMarginal = new Float32Array( h );
	const rowSums = new Float64Array( h );
	let total = 0;
	for ( let y = 0; y < h; y ++ ) {

		let sum = 0;
		for ( let x = 0; x < w; x ++ ) sum += cells[ y * w + x ] + floor;
		let cumulative = 0;
		for ( let x = 0; x < w; x ++ ) {

			cumulative += cells[ y * w + x ] + floor;
			exactConditional[ y * w + x ] = sum > 0 ? ( x === w - 1 ? 1 : cumulative / sum ) : 0;

		}

		rowSums[ y ] = sum;
		total += sum;

	}

	let cumulative = 0;
	for ( let y = 0; y < h; y ++ ) {

		cumulative += rowSums[ y ];
		exactMarginal[ y ] = total > 0 ? ( y === h - 1 ? 1 : cumulative / total ) : 0;

	}

	const exactRowGuide = new Float32Array( w * h );
	const exactMarginalGuide = new Float32Array( h );
	for ( let y = 0; y < h; y ++ ) cutpoints( exactConditional, y * w, w, exactRowGuide, y * w );
	cutpoints( exactMarginal, 0, h, exactMarginalGuide, 0 );

	return {
		exactWidth: w, exactHeight: h, exactConditional, exactMarginal, exactRowGuide, exactMarginalGuide,
		radianceIntegral: 2 * Math.PI * Math.PI * raw / ( width * height ),
	};

}

/**
 * The table as the CDF texture holds it, ( w + 1 ) × 2h floats: the guides in rows [0, h), the running sums in
 * rows [h, 2h), and in column w of each the rows' own. TSL/Environment.js reads this layout.
 */
export function packExactTable( { exactWidth: w, exactHeight: h, exactConditional, exactMarginal, exactRowGuide, exactMarginalGuide } ) {

	const stride = w + 1;
	const data = new Float32Array( stride * 2 * h );
	for ( let y = 0; y < h; y ++ ) {

		data.set( exactRowGuide.subarray( y * w, y * w + w ), y * stride );
		data[ y * stride + w ] = exactMarginalGuide[ y ];
		data.set( exactConditional.subarray( y * w, y * w + w ), ( h + y ) * stride );
		data[ ( h + y ) * stride + w ] = exactMarginal[ y ];

	}

	return { data, width: stride, height: 2 * h };

}
