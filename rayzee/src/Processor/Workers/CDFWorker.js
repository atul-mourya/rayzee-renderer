/**
 * Web Worker for computing environment map CDF (Cumulative Distribution Function)
 * for importance sampling. Pure math — no Three.js dependencies.
 *
 * Input:  { floatData: Float32Array, width, height }
 * Output: { marginalData, conditionalData, totalSum, compensationDelta, width, height } and the exact table
 * (EnvironmentExactTable.js)
 */

import { buildExactEnvironmentTable } from '../EnvironmentExactTable.js';

function binarySearchFindClosestIndexOf( array, targetValue, offset, count ) {

	let lower = offset;
	let upper = offset + count - 1;

	while ( lower < upper ) {

		const mid = ( lower + upper ) >> 1;

		if ( array[ mid ] < targetValue ) {

			lower = mid + 1;

		} else {

			upper = mid;

		}

	}

	return lower - offset;

}

function buildCDF( floatData, width, height ) {

	const numPixels = width * height;

	// Pass 1: compute per-pixel luminance weighted by sin(theta) and raw total sum.
	// sin(theta) compensates for the equirectangular projection: pixels near the poles
	// cover less solid angle, so weighting by sin(theta) makes the CDF proportional to
	// luminance per solid angle rather than luminance per pixel.
	const pixelWeights = new Float32Array( numPixels );
	let rawTotalSum = 0.0;

	for ( let y = 0; y < height; y ++ ) {

		const sinTheta = Math.sin( Math.PI * ( y + 0.5 ) / height );

		for ( let x = 0; x < width; x ++ ) {

			const i = y * width + x;
			const r = floatData[ 4 * i ];
			const g = floatData[ 4 * i + 1 ];
			const b = floatData[ 4 * i + 2 ];

			// Luminance (Rec. 709) weighted by solid angle factor
			const w = ( 0.2126 * r + 0.7152 * g + 0.0722 * b ) * sinTheta;
			pixelWeights[ i ] = w;
			rawTotalSum += w;

		}

	}

	// MIS Compensation (Karlík et al. 2019, Eq. 14)
	// With equal sample allocation (c_I = 0.5): delta = 2*(1 - 0.5)*meanWeight = meanWeight
	// Subtracting mean sharpens the env map PDF, reducing oversampling
	// of dim regions already well-covered by BSDF sampling.
	const meanWeight = rawTotalSum / numPixels;
	let compensatedTotalSum = 0.0;

	for ( let i = 0; i < numPixels; i ++ ) {

		pixelWeights[ i ] = Math.max( 0, pixelWeights[ i ] - meanWeight );
		compensatedTotalSum += pixelWeights[ i ];

	}

	// Fall back to raw weights if compensation zeroed everything (uniform env map)
	const useCompensation = compensatedTotalSum > 0;
	const totalSumValue = useCompensation ? compensatedTotalSum : rawTotalSum;
	const compensationDelta = useCompensation ? meanWeight : 0;

	if ( ! useCompensation ) {

		// Restore raw sin-weighted luminance
		for ( let y = 0; y < height; y ++ ) {

			const sinTheta = Math.sin( Math.PI * ( y + 0.5 ) / height );

			for ( let x = 0; x < width; x ++ ) {

				const i = y * width + x;
				const r = floatData[ 4 * i ];
				const g = floatData[ 4 * i + 1 ];
				const b = floatData[ 4 * i + 2 ];
				pixelWeights[ i ] = ( 0.2126 * r + 0.7152 * g + 0.0722 * b ) * sinTheta;

			}

		}

	}

	// Pass 2: build conditional and marginal CDFs from (compensated) weights
	const cdfConditional = new Float32Array( numPixels );
	const cdfMarginal = new Float32Array( height );

	let cumulativeWeightMarginal = 0.0;

	for ( let y = 0; y < height; y ++ ) {

		let cumulativeRowWeight = 0.0;
		for ( let x = 0; x < width; x ++ ) {

			const i = y * width + x;
			cumulativeRowWeight += pixelWeights[ i ];
			cdfConditional[ i ] = cumulativeRowWeight;

		}

		// Normalize row CDF to [0, 1]
		if ( cumulativeRowWeight !== 0 ) {

			for ( let i = y * width, l = y * width + width; i < l; i ++ ) {

				cdfConditional[ i ] /= cumulativeRowWeight;

			}

		}

		cumulativeWeightMarginal += cumulativeRowWeight;
		cdfMarginal[ y ] = cumulativeWeightMarginal;

	}

	// Normalize marginal CDF to [0, 1]
	if ( cumulativeWeightMarginal !== 0 ) {

		for ( let i = 0, l = cdfMarginal.length; i < l; i ++ ) {

			cdfMarginal[ i ] /= cumulativeWeightMarginal;

		}

	}

	// Invert marginal CDF
	const marginalData = new Float32Array( height );
	for ( let i = 0; i < height; i ++ ) {

		const dist = ( i + 1 ) / height;
		const row = binarySearchFindClosestIndexOf( cdfMarginal, dist, 0, height );
		marginalData[ i ] = ( row + 0.5 ) / height;

	}

	// Invert conditional CDFs
	const conditionalData = new Float32Array( width * height );
	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const i = y * width + x;
			const dist = ( x + 1 ) / width;
			const col = binarySearchFindClosestIndexOf( cdfConditional, dist, y * width, width );
			conditionalData[ i ] = ( col + 0.5 ) / width;

		}

	}

	return { marginalData, conditionalData, totalSum: totalSumValue, compensationDelta };

}

self.onmessage = function ( e ) {

	const { floatData, width, height } = e.data;

	try {

		const result = buildCDF( floatData, width, height );
		const exact = buildExactEnvironmentTable( floatData, width, height );

		// Transfer arrays back zero-copy
		self.postMessage(
			{
				marginalData: result.marginalData,
				conditionalData: result.conditionalData,
				totalSum: result.totalSum,
				compensationDelta: result.compensationDelta,
				width,
				height,
				...exact,
			},
			[ result.marginalData.buffer, result.conditionalData.buffer, exact.exactConditional.buffer, exact.exactMarginal.buffer ]
		);

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
