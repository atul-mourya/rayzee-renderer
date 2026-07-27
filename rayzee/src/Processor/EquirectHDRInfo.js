import { DataUtils, HalfFloatType, FloatType, SRGBColorSpace } from 'three';
import CDFWorker from './Workers/CDFWorker.js?worker&inline';

/**
 * Binary search to find the closest index
 */
function binarySearchFindClosestIndexOf( array, targetValue, offset = 0, count = array.length ) {

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

/**
 * Calculate luminance from RGB values
 */
function colorToLuminance( r, g, b ) {

	// https://en.wikipedia.org/wiki/Relative_luminance
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;

}

/**
 * sRGB to linear conversion (IEC 61966-2-1 transfer function)
 */
function sRGBToLinear( c ) {

	return c <= 0.04045 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4;

}

/**
 * Extract Float32 RGBA pixel data from an environment map.
 * Handles HalfFloat/integer type conversion, canvas extraction for
 * non-DataTexture images (JPG/PNG), sRGB-to-linear conversion, and Y-flip.
 * @returns {{ floatData: Float32Array, width: number, height: number }}
 */
export function extractFloatData( envMap ) {

	const { width, height } = envMap.image;
	let data = envMap.image.data;
	let needsSRGBToLinear = false;

	// No CPU-accessible data — extract from HTMLImageElement / ImageBitmap via canvas
	if ( ! data ) {

		const canvas = new OffscreenCanvas( width, height );
		const ctx = canvas.getContext( '2d' );
		ctx.drawImage( envMap.image, 0, 0, width, height );
		data = ctx.getImageData( 0, 0, width, height ).data;
		needsSRGBToLinear = true;

	}

	// Convert to Float32 regardless of source type
	let floatData;

	if ( envMap.type === FloatType && data instanceof Float32Array ) {

		// Copy so the original texture buffer is not detached by worker transfer
		floatData = new Float32Array( data );

	} else if ( envMap.type === HalfFloatType ) {

		floatData = new Float32Array( data.length );
		for ( let i = 0, l = data.length; i < l; i ++ ) {

			floatData[ i ] = DataUtils.fromHalfFloat( data[ i ] );

		}

	} else {

		// Integer types (Uint8, Uint8Clamped, Int16, etc.)
		let maxIntValue;
		if ( data instanceof Int8Array || data instanceof Int16Array || data instanceof Int32Array ) {

			maxIntValue = 2 ** ( 8 * data.BYTES_PER_ELEMENT - 1 ) - 1;

		} else {

			maxIntValue = 2 ** ( 8 * data.BYTES_PER_ELEMENT ) - 1;

		}

		floatData = new Float32Array( data.length );
		for ( let i = 0, l = data.length; i < l; i ++ ) {

			floatData[ i ] = data[ i ] / maxIntValue;

		}

	}

	// Also flag sRGB conversion for DataTextures explicitly marked as sRGB
	if ( ! needsSRGBToLinear && envMap.colorSpace === SRGBColorSpace ) {

		needsSRGBToLinear = true;

	}

	// Convert sRGB to linear so CDF luminance matches GPU-sampled linear values
	if ( needsSRGBToLinear ) {

		for ( let i = 0, l = floatData.length; i < l; i += 4 ) {

			floatData[ i ] = sRGBToLinear( floatData[ i ] );
			floatData[ i + 1 ] = sRGBToLinear( floatData[ i + 1 ] );
			floatData[ i + 2 ] = sRGBToLinear( floatData[ i + 2 ] );

		}

	}

	// Remove Y-flip for CDF computation
	if ( envMap.flipY ) {

		const flipped = new Float32Array( floatData.length );
		for ( let y = 0; y < height; y ++ ) {

			const newY = height - y - 1;
			const srcOffset = y * width * 4;
			const dstOffset = newY * width * 4;
			flipped.set( floatData.subarray( srcOffset, srcOffset + width * 4 ), dstOffset );

		}

		floatData = flipped;

	}

	return { floatData, width, height };

}

/**
 * EquirectHDRInfo - Importance sampling data for equirectangular HDR maps
 *
 * Builds inverted marginal and conditional CDFs from an HDR environment map.
 * Outputs Float32Arrays consumed directly by StorageInstancedBufferAttribute
 * on the GPU — no intermediate DataTexture or HalfFloat conversion needed.
 *
 * Supports two modes:
 * - `updateFrom(hdr)`: synchronous, runs on main thread
 * - `updateFromAsync(hdr)`: offloads CDF math to a Web Worker
 */
export class EquirectHDRInfo {

	constructor() {

		// Placeholder data matching the default storage buffer sizes in PathTracer
		this.marginalData = new Float32Array( [ 0, 1 ] );
		this.conditionalData = new Float32Array( [ 0, 0, 1, 1 ] );
		this.totalSum = 0;
		this.compensationDelta = 0;
		this.width = 0;
		this.height = 0;

		this._worker = null;

	}

	dispose() {

		this.marginalData = null;
		this.conditionalData = null;

		if ( this._worker ) {

			this._worker.terminate();
			this._worker = null;

		}

	}

	/**
	 * Synchronous CDF build on main thread (fallback path).
	 */
	updateFrom( hdr ) {

		const { floatData, width, height } = extractFloatData( hdr );

		const result = EquirectHDRInfo.computeCDF( floatData, width, height );

		this.marginalData = result.marginalData;
		this.conditionalData = result.conditionalData;
		this.totalSum = result.totalSum;
		this.compensationDelta = result.compensationDelta;
		this.width = width;
		this.height = height;

	}

	/**
	 * Async CDF build offloaded to a Web Worker.
	 * Float extraction (HalfFloat → Float32) runs on main thread (needs Three.js DataUtils),
	 * then the pure-math CDF computation runs off-thread.
	 * @returns {Promise<void>}
	 */
	async updateFromAsync( hdr ) {

		const { floatData, width, height } = extractFloatData( hdr );

		// Fresh worker per call — terminated in finally to avoid ~30 MB residency.
		this._worker = new CDFWorker();

		try {

			const result = await new Promise( ( resolve, reject ) => {

				this._worker.onmessage = ( e ) => {

					if ( e.data.error ) {

						reject( new Error( e.data.error ) );

					} else {

						resolve( e.data );

					}

				};

				this._worker.onerror = reject;

				// Transfer floatData to worker (zero-copy)
				this._worker.postMessage(
					{ floatData, width, height },
					[ floatData.buffer ]
				);

			} );

			this.marginalData = result.marginalData;
			this.conditionalData = result.conditionalData;
			this.totalSum = result.totalSum;
			this.compensationDelta = result.compensationDelta;
			this.width = result.width;
			this.height = result.height;

		} finally {

			if ( this._worker ) {

				this._worker.terminate();
				this._worker = null;

			}

		}

	}

	/**
	 * Pure-math CDF computation. Used by both the sync path and CDFWorker.
	 * Static so it can be called without an instance.
	 */
	static computeCDF( floatData, width, height ) {

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
				const w = colorToLuminance(
					floatData[ 4 * i ],
					floatData[ 4 * i + 1 ],
					floatData[ 4 * i + 2 ],
				) * sinTheta;
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

			for ( let y = 0; y < height; y ++ ) {

				const sinTheta = Math.sin( Math.PI * ( y + 0.5 ) / height );

				for ( let x = 0; x < width; x ++ ) {

					const i = y * width + x;
					pixelWeights[ i ] = colorToLuminance(
						floatData[ 4 * i ],
						floatData[ 4 * i + 1 ],
						floatData[ 4 * i + 2 ],
					) * sinTheta;

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

		// Create inverted CDF arrays (Float32 directly for storage buffers)
		const marginalData = new Float32Array( height );
		const conditionalData = new Float32Array( numPixels );

		// Invert marginal CDF
		for ( let i = 0; i < height; i ++ ) {

			const dist = ( i + 1 ) / height;
			const row = binarySearchFindClosestIndexOf( cdfMarginal, dist );

			marginalData[ i ] = ( row + 0.5 ) / height;

		}

		// Invert conditional CDFs
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

}
