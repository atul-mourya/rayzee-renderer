/**
 * Image-comparison metrics for the path-tracer regression suite.
 *
 * Zero dependencies, no I/O: every entry point takes decoded `{ width, height, data }`
 * images ( RGBA bytes, sRGB-encoded ) and returns plain numbers or a plain image object.
 *
 * All photometric math runs in LINEAR light. Averaging sRGB bytes weights darks and
 * brights non-uniformly, so a mean over encoded values would report energy shifts that
 * are really tone-curve artefacts — useless as a bias probe.
 */

const MAX_BYTE = 255;
const DEFAULT_THRESHOLD = 0.02;

/** Rec.709 luma coefficients. */
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

/** SSIM stabilisers for a dynamic range of L = 1 ( linear luminance is already 0-1 ). */
const SSIM_C1 = 0.01 * 0.01;
const SSIM_C2 = 0.03 * 0.03;

const SSIM_WINDOW = 8;
const SSIM_STRIDE = 4;

/**
 * Convert one sRGB-encoded byte to linear light using the exact sRGB EOTF.
 *
 * The piecewise form is required, not a 2.2-gamma approximation: near black the two
 * disagree by more than the regression thresholds this suite trips on.
 *
 * @param {number} u8 - Encoded channel value, 0-255.
 * @returns {number} Linear value, 0-1.
 */
export function srgbToLinear( u8 ) {

	const c = u8 / MAX_BYTE;
	return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );

}

/** Byte -> linear lookup, so the per-pixel loops never call Math.pow. */
const SRGB_TO_LINEAR = new Float64Array( 256 );

for ( let i = 0; i < 256; i ++ ) {

	SRGB_TO_LINEAR[ i ] = srgbToLinear( i );

}

/**
 * Rec.709 relative luminance.
 *
 * @param {number} r - LINEAR red.
 * @param {number} g - LINEAR green.
 * @param {number} b - LINEAR blue.
 * @returns {number} Linear luminance.
 */
export function luminance( r, g, b ) {

	return LUMA_R * r + LUMA_G * g + LUMA_B * b;

}

/**
 * Compare two images.
 *
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} a - Reference.
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} b - Candidate.
 * @param {{ threshold?: number }} [options] - `threshold` is the per-pixel LINEAR luminance
 *   delta above which a pixel counts as differing ( default 0.02 ).
 * @returns {{ width: number, height: number, rmse: number, rmseSrgb: number, psnr: number,
 *   meanLuminanceA: number, meanLuminanceB: number, meanLuminanceDelta: number,
 *   meanLuminanceRatio: number, meanChannelDelta: { r: number, g: number, b: number },
 *   maxChannelDelta: number, pixelsOverThreshold: number, fractionOverThreshold: number,
 *   identical: boolean }}
 * @throws {Error} If the images differ in size or are not RGBA byte buffers.
 */
export function compare( a, b, options = {} ) {

	assertComparable( a, b );

	const threshold = Number.isFinite( options.threshold ) ? options.threshold : DEFAULT_THRESHOLD;
	const width = a.width;
	const height = a.height;
	const da = a.data;
	const db = b.data;
	const pixels = width * height;

	let sumAR = 0;
	let sumAG = 0;
	let sumAB = 0;
	let sumBR = 0;
	let sumBG = 0;
	let sumBB = 0;
	let sumSqLinear = 0;
	let sumSqBytes = 0;
	let maxChannelDelta = 0;
	let pixelsOverThreshold = 0;
	let identical = true;

	for ( let i = 0, n = pixels * 4; i < n; i += 4 ) {

		const byteAR = da[ i ];
		const byteAG = da[ i + 1 ];
		const byteAB = da[ i + 2 ];
		const byteBR = db[ i ];
		const byteBG = db[ i + 1 ];
		const byteBB = db[ i + 2 ];

		const linAR = SRGB_TO_LINEAR[ byteAR ];
		const linAG = SRGB_TO_LINEAR[ byteAG ];
		const linAB = SRGB_TO_LINEAR[ byteAB ];
		const linBR = SRGB_TO_LINEAR[ byteBR ];
		const linBG = SRGB_TO_LINEAR[ byteBG ];
		const linBB = SRGB_TO_LINEAR[ byteBB ];

		sumAR += linAR;
		sumAG += linAG;
		sumAB += linAB;
		sumBR += linBR;
		sumBG += linBG;
		sumBB += linBB;

		const dR = linBR - linAR;
		const dG = linBG - linAG;
		const dB = linBB - linAB;

		sumSqLinear += dR * dR + dG * dG + dB * dB;
		maxChannelDelta = Math.max( maxChannelDelta, Math.abs( dR ), Math.abs( dG ), Math.abs( dB ) );

		// Accumulated in byte units and normalised once at the end.
		const eR = byteBR - byteAR;
		const eG = byteBG - byteAG;
		const eB = byteBB - byteAB;

		sumSqBytes += eR * eR + eG * eG + eB * eB;

		const lumDelta = luminance( dR, dG, dB );

		if ( Math.abs( lumDelta ) > threshold ) {

			pixelsOverThreshold ++;

		}

		if ( identical && ( eR !== 0 || eG !== 0 || eB !== 0 || da[ i + 3 ] !== db[ i + 3 ] ) ) {

			identical = false;

		}

	}

	const invPixels = pixels > 0 ? 1 / pixels : 0;
	const meanAR = sumAR * invPixels;
	const meanAG = sumAG * invPixels;
	const meanAB = sumAB * invPixels;
	const meanBR = sumBR * invPixels;
	const meanBG = sumBG * invPixels;
	const meanBB = sumBB * invPixels;

	const samples = pixels * 3;
	const rmse = samples > 0 ? Math.sqrt( sumSqLinear / samples ) : 0;
	const rmseSrgb = samples > 0 ? Math.sqrt( sumSqBytes / samples ) / MAX_BYTE : 0;

	const meanLuminanceA = luminance( meanAR, meanAG, meanAB );
	const meanLuminanceB = luminance( meanBR, meanBG, meanBB );

	return {
		width,
		height,
		rmse,
		rmseSrgb,
		psnr: rmse > 0 ? 20 * Math.log10( 1 / rmse ) : Infinity,
		meanLuminanceA,
		meanLuminanceB,
		meanLuminanceDelta: meanLuminanceB - meanLuminanceA,
		meanLuminanceRatio: meanLuminanceA > 0 ? meanLuminanceB / meanLuminanceA : 1,
		meanChannelDelta: {
			r: meanBR - meanAR,
			g: meanBG - meanAG,
			b: meanBB - meanAB,
		},
		maxChannelDelta,
		pixelsOverThreshold,
		fractionOverThreshold: pixels > 0 ? pixelsOverThreshold / pixels : 0,
		identical,
	};

}

/**
 * Global mean SSIM over the LINEAR luminance channel.
 *
 * Window choice: 8x8 uniform, stride 4. A uniform window keeps the implementation
 * dependency-free and exactly reproducible ( no Gaussian kernel constants to drift ), 8x8
 * is small enough to localise structural change at the resolutions this suite renders,
 * and stride 4 gives 50% overlap — dense enough that no feature falls between windows,
 * while costing 1/16 of a per-pixel sliding window. Right/bottom windows are anchored to
 * the image edge so partial strides are still covered, never dropped.
 *
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} a - Reference.
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} b - Candidate.
 * @param {{ windowSize?: number, stride?: number }} [options] - Window overrides.
 * @returns {number} Mean SSIM, clamped to 0-1.
 * @throws {Error} If the images differ in size or are not RGBA byte buffers.
 */
export function ssim( a, b, options = {} ) {

	assertComparable( a, b );

	const width = a.width;
	const height = a.height;

	if ( width === 0 || height === 0 ) {

		return 1;

	}

	const windowSize = Number.isFinite( options.windowSize ) && options.windowSize > 0
		? Math.floor( options.windowSize )
		: SSIM_WINDOW;
	const stride = Number.isFinite( options.stride ) && options.stride > 0
		? Math.floor( options.stride )
		: SSIM_STRIDE;

	const planeA = luminancePlane( a );
	const planeB = luminancePlane( b );

	// Too small to tile: one window over the whole image.
	if ( width < windowSize || height < windowSize ) {

		return clamp01( ssimWindow( planeA, planeB, width, 0, 0, width, height ) );

	}

	const maxX = width - windowSize;
	const maxY = height - windowSize;
	const stepsX = Math.floor( maxX / stride ) + ( maxX % stride === 0 ? 1 : 2 );
	const stepsY = Math.floor( maxY / stride ) + ( maxY % stride === 0 ? 1 : 2 );

	let total = 0;
	let count = 0;

	for ( let iy = 0; iy < stepsY; iy ++ ) {

		const oy = Math.min( iy * stride, maxY );

		for ( let ix = 0; ix < stepsX; ix ++ ) {

			const ox = Math.min( ix * stride, maxX );
			total += ssimWindow( planeA, planeB, width, ox, oy, windowSize, windowSize );
			count ++;

		}

	}

	return clamp01( count > 0 ? total / count : 1 );

}

/**
 * Render the absolute LINEAR luminance delta as an RGBA heatmap for the human-facing report.
 *
 * Ramp: black -> blue -> cyan -> yellow -> red.
 *
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} a - Reference.
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} b - Candidate.
 * @param {{ scale?: number }} [options] - `scale` is the delta mapped to the top of the ramp.
 *   Defaults to the largest delta present, so the map always uses its full range; pass an
 *   explicit scale to make several heatmaps comparable to each other.
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }} RGBA image, alpha 255.
 * @throws {Error} If the images differ in size or are not RGBA byte buffers.
 */
export function diffHeatmap( a, b, options = {} ) {

	assertComparable( a, b );

	const width = a.width;
	const height = a.height;
	const da = a.data;
	const db = b.data;
	const n = width * height * 4;
	const out = new Uint8ClampedArray( n );

	let scale = Number.isFinite( options.scale ) ? options.scale : - 1;

	if ( scale < 0 ) {

		let peak = 0;

		for ( let i = 0; i < n; i += 4 ) {

			const delta = Math.abs( pixelLuminanceDelta( da, db, i ) );

			if ( delta > peak ) {

				peak = delta;

			}

		}

		scale = peak;

	}

	// A flat-zero diff ( or scale 0 ) collapses to an all-black map rather than dividing by 0.
	const invScale = scale > 0 ? 1 / scale : 0;

	for ( let i = 0; i < n; i += 4 ) {

		const t = Math.min( 1, Math.abs( pixelLuminanceDelta( da, db, i ) ) * invScale );
		writeRamp( out, i, t );

	}

	return { width, height, data: out };

}

/**
 * @param {*} a
 * @param {*} b
 * @throws {Error} On anything the metric functions cannot consume.
 */
function assertComparable( a, b ) {

	if ( ! a || ! b || ! a.data || ! b.data ) {

		throw new Error( 'metrics: both arguments must be { width, height, data } images.' );

	}

	if ( ! isByteBuffer( a.data ) || ! isByteBuffer( b.data ) ) {

		throw new Error( 'metrics: image data must be a Uint8ClampedArray or Uint8Array of RGBA bytes.' );

	}

	if ( a.width !== b.width || a.height !== b.height ) {

		throw new Error(
			`metrics: image dimensions differ - a is ${ a.width }x${ a.height }, b is ${ b.width }x${ b.height }.`
		);

	}

	const expected = a.width * a.height * 4;

	if ( a.data.length < expected || b.data.length < expected ) {

		throw new Error(
			`metrics: RGBA data too short - ${ a.width }x${ a.height } needs ${ expected } bytes, ` +
			`got ${ a.data.length } and ${ b.data.length }.`
		);

	}

}

/**
 * @param {*} data
 * @returns {boolean}
 */
function isByteBuffer( data ) {

	return data instanceof Uint8ClampedArray || data instanceof Uint8Array;

}

/**
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array }} img
 * @returns {Float32Array} Linear luminance, one entry per pixel.
 */
function luminancePlane( img ) {

	const data = img.data;
	const count = img.width * img.height;
	const out = new Float32Array( count );

	for ( let p = 0, i = 0; p < count; p ++, i += 4 ) {

		out[ p ] = luminance(
			SRGB_TO_LINEAR[ data[ i ] ],
			SRGB_TO_LINEAR[ data[ i + 1 ] ],
			SRGB_TO_LINEAR[ data[ i + 2 ] ]
		);

	}

	return out;

}

/**
 * SSIM of one rectangular window. Variance/covariance use the unbiased ( N - 1 ) estimator,
 * matching scikit-image's default so scores are comparable with external tooling.
 *
 * @param {Float32Array} pa
 * @param {Float32Array} pb
 * @param {number} rowStride
 * @param {number} ox
 * @param {number} oy
 * @param {number} w
 * @param {number} h
 * @returns {number}
 */
function ssimWindow( pa, pb, rowStride, ox, oy, w, h ) {

	const n = w * h;

	if ( n === 0 ) {

		return 1;

	}

	let sumA = 0;
	let sumB = 0;
	let sumAA = 0;
	let sumBB = 0;
	let sumAB = 0;

	for ( let y = 0; y < h; y ++ ) {

		let p = ( oy + y ) * rowStride + ox;

		for ( let x = 0; x < w; x ++, p ++ ) {

			const pxA = pa[ p ];
			const pxB = pb[ p ];

			sumA += pxA;
			sumB += pxB;
			sumAA += pxA * pxA;
			sumBB += pxB * pxB;
			sumAB += pxA * pxB;

		}

	}

	const meanA = sumA / n;
	const meanB = sumB / n;
	const norm = n > 1 ? 1 / ( n - 1 ) : 1;

	// Rounding can push a flat window's variance just below zero.
	const varA = Math.max( 0, ( sumAA - n * meanA * meanA ) * norm );
	const varB = Math.max( 0, ( sumBB - n * meanB * meanB ) * norm );
	const covAB = ( sumAB - n * meanA * meanB ) * norm;

	const numerator = ( 2 * meanA * meanB + SSIM_C1 ) * ( 2 * covAB + SSIM_C2 );
	const denominator = ( meanA * meanA + meanB * meanB + SSIM_C1 ) * ( varA + varB + SSIM_C2 );

	// denominator >= C1 * C2 > 0, so this cannot divide by zero.
	return numerator / denominator;

}

/**
 * @param {Uint8ClampedArray|Uint8Array} da
 * @param {Uint8ClampedArray|Uint8Array} db
 * @param {number} i - Byte offset of the pixel.
 * @returns {number} Signed linear luminance delta, b - a.
 */
function pixelLuminanceDelta( da, db, i ) {

	return luminance(
		SRGB_TO_LINEAR[ db[ i ] ] - SRGB_TO_LINEAR[ da[ i ] ],
		SRGB_TO_LINEAR[ db[ i + 1 ] ] - SRGB_TO_LINEAR[ da[ i + 1 ] ],
		SRGB_TO_LINEAR[ db[ i + 2 ] ] - SRGB_TO_LINEAR[ da[ i + 2 ] ]
	);

}

/**
 * Write one ramp sample. Uint8ClampedArray handles the rounding and clamping.
 *
 * @param {Uint8ClampedArray} out
 * @param {number} o - Byte offset.
 * @param {number} t - Normalised delta, 0-1.
 */
function writeRamp( out, o, t ) {

	const u = t * 4;

	if ( u < 1 ) {

		out[ o ] = 0;
		out[ o + 1 ] = 0;
		out[ o + 2 ] = MAX_BYTE * u;

	} else if ( u < 2 ) {

		out[ o ] = 0;
		out[ o + 1 ] = MAX_BYTE * ( u - 1 );
		out[ o + 2 ] = MAX_BYTE;

	} else if ( u < 3 ) {

		out[ o ] = MAX_BYTE * ( u - 2 );
		out[ o + 1 ] = MAX_BYTE;
		out[ o + 2 ] = MAX_BYTE * ( 3 - u );

	} else {

		out[ o ] = MAX_BYTE;
		out[ o + 1 ] = MAX_BYTE * ( 4 - u );
		out[ o + 2 ] = 0;

	}

	out[ o + 3 ] = MAX_BYTE;

}

/**
 * @param {number} v
 * @returns {number}
 */
function clamp01( v ) {

	return Number.isFinite( v ) ? Math.min( 1, Math.max( 0, v ) ) : 0;

}
