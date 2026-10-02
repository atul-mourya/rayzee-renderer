/**
 * An environment's exact sampling table, for the bidirectional integrator: piecewise constant over cells of
 * at most EXACT_TABLE_MAX_WIDTH × half that, so a direction's density is its cell's share, read back from the
 * same cumulative sums it is drawn from. Pure math: CDFWorker runs it too.
 */

export const EXACT_TABLE_MAX_WIDTH = 1024;

// Every cell keeps this share of the mean, so light tracing or NEE alone covers the whole sphere.
const FLOOR = 1e-4;

/** Cells the table has for a width × height environment; TSL/Environment.js derives the same. */
export function exactTableSize( width, height ) {

	const k = Math.max( 1, Math.ceil( width / EXACT_TABLE_MAX_WIDTH ) );
	return { k, width: Math.ceil( width / k ), height: Math.ceil( height / k ) };

}

/**
 * @param {Float32Array} floatData - RGBA, row 0 the nadir
 * @returns {{ exactWidth: number, exactHeight: number, exactConditional: Float32Array, exactMarginal: Float32Array, radianceIntegral: number }}
 *   each row's running sum over its cells and the rows' over all, both ending at 1; ∫ luminance dω.
 */
export function buildExactEnvironmentTable( floatData, width, height ) {

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

	// Each texel weighs as its brightest neighbour: filtering spreads a bright texel's light into the next ones.
	const cells = new Float64Array( w * h );
	for ( let y = 0; y < height; y ++ ) {

		const sinTheta = Math.sin( Math.PI * ( y + 0.5 ) / height );
		const row = Math.floor( y / k ) * w;
		const ys = [ Math.max( y - 1, 0 ), y, Math.min( y + 1, height - 1 ) ];
		for ( let x = 0; x < width; x ++ ) {

			const xs = [ ( x + width - 1 ) % width, x, ( x + 1 ) % width ];
			let peak = 0;
			for ( const yy of ys ) for ( const xx of xs ) peak = Math.max( peak, lum[ yy * width + xx ] );
			cells[ row + Math.floor( x / k ) ] += peak * sinTheta;

		}

	}

	const floor = raw > 0 ? FLOOR * raw / ( w * h ) : 0;
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

	return { exactWidth: w, exactHeight: h, exactConditional, exactMarginal, radianceIntegral: 2 * Math.PI * Math.PI * raw / ( width * height ) };

}
