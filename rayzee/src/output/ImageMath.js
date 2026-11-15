/**
 * Images as data, for a batch host: compared by pbrt's error metrics and NVIDIA's FLIP, and parts of a render split by
 * sample range merged back into one. RGBA, as the engine reads back.
 */

import { FLIP_DEFAULT_PPD, flipErrorMap } from './Flip.js';

/**
 * How far `image` is from `reference` over red, green and blue, by the definitions pbrt's `imgtool diff` uses: MSE, MAE
 * and MRSE (squared error over (reference + 0.01)²) are means over every pixel, and a value not finite in either image
 * counts as no error (`nonFinite` says how many). Floats compare as they are — read both `'linear'` to compare light —
 * and 8- or 16-bit data as 0–1.
 * @param {{data: Float32Array|Uint8Array|Uint8ClampedArray|Uint16Array, width: number, height: number}} image - RGBA
 * @param {{data: Float32Array|Uint8Array|Uint8ClampedArray|Uint16Array, width: number, height: number}} reference - RGBA
 * @param {Object} [options]
 * @param {{x: number, y: number, width: number, height: number}} [options.crop] - compare this rectangle of both
 * @param {boolean} [options.errorImage=false] - also return each pixel's squared error, averaged over RGB
 * @param {boolean|{ppd?: number}} [options.flip=false] - also return NVIDIA's FLIP: how visible the difference is, 0–1.
 *   Light (floats) is compared as HDR-FLIP over the reference's exposures, a picture as sRGB. `ppd` is the viewer's
 *   pixels per degree (default 67: 0.7 m from a 0.7 m wide 4K screen). Seconds for a large image
 * @returns {{mse: number, rmse: number, mae: number, mrse: number, mean: number, referenceMean: number,
 *   relativeBias: number, nonFinite: number, pixels: number, errorImage?: Float32Array,
 *   flip?: {mean: number, weightedMedian: number, max: number, errorImage?: Float32Array}}} `relativeBias` is
 *   mean ÷ referenceMean − 1: energy gained or lost, which the error means do not show
 */
export function compareImages( image, reference, { crop = null, errorImage = false, flip = false } = {} ) {

	assertImage( image, 'compareImages: image' );
	assertImage( reference, 'compareImages: reference' );
	if ( image.width !== reference.width || image.height !== reference.height ) {

		throw new Error( `compareImages: the image is ${image.width}×${image.height}, the reference ${reference.width}×${reference.height}` );

	}

	const a = image.data, b = reference.data;
	if ( ( a instanceof Float32Array ) !== ( b instanceof Float32Array ) ) {

		throw new Error( 'compareImages: one image is light (floats), the other a picture (integers); read both alike' );

	}

	const { x = 0, y = 0, width = image.width - x, height = image.height - y } = crop ?? {};
	if ( ! [ x, y, width, height ].every( Number.isInteger ) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > image.width || y + height > image.height ) {

		throw new Error( `compareImages: crop ${JSON.stringify( crop )} is not inside the ${image.width}×${image.height} image` );

	}

	if ( typeof flip !== 'boolean' && ( typeof flip !== 'object' || flip === null ) ) throw new Error( 'compareImages: flip is true, false or { ppd }' );
	const { ppd = FLIP_DEFAULT_PPD } = flip === true ? {} : flip || {};
	if ( ! ( ppd > 0 && Number.isFinite( ppd ) ) ) throw new Error( `compareImages: flip.ppd must be a positive number, got ${ppd}` );

	const scaleA = dataScale( a ), scaleB = dataScale( b );
	const perPixel = errorImage ? new Float32Array( width * height ) : null;
	let se = 0, ae = 0, rse = 0, sumA = 0, sumB = 0, nonFinite = 0;

	for ( let row = 0; row < height; row ++ ) {

		for ( let col = 0; col < width; col ++ ) {

			const i = ( ( y + row ) * image.width + x + col ) * 4;
			let pixelSE = 0;
			for ( let c = 0; c < 3; c ++ ) {

				const va = a[ i + c ] * scaleA, vb = b[ i + c ] * scaleB;
				if ( ! Number.isFinite( va ) || ! Number.isFinite( vb ) ) {

					nonFinite ++;
					continue;

				}

				const d = va - vb;
				se += d * d;
				ae += Math.abs( d );
				rse += d * d / ( ( vb + 0.01 ) * ( vb + 0.01 ) );
				sumA += va;
				sumB += vb;
				pixelSE += d * d;

			}

			if ( perPixel ) perPixel[ row * width + col ] = pixelSE / 3;

		}

	}

	const values = width * height * 3;
	const mean = sumA / values, referenceMean = sumB / values;
	return {
		mse: se / values,
		rmse: Math.sqrt( se / values ),
		mae: ae / values,
		mrse: rse / values,
		mean,
		referenceMean,
		relativeBias: referenceMean !== 0 ? mean / referenceMean - 1 : ( mean === 0 ? 0 : Infinity ),
		nonFinite,
		pixels: width * height,
		...( perPixel ? { errorImage: perPixel } : {} ),
		...( flip ? { flip: flipStats( image, reference, { x, y, width, height }, ppd, errorImage ) } : {} ),
	};

}

function flipStats( image, reference, { x, y, width, height }, ppd, keepMap ) {

	const light = image.data instanceof Float32Array;
	const a = image.data, b = reference.data;
	const tableA = light ? null : srgbTable( a ), tableB = light ? null : srgbTable( b );
	const test = new Float32Array( width * height * 3 ), ref = new Float32Array( width * height * 3 );
	for ( let row = 0; row < height; row ++ ) {

		for ( let col = 0; col < width; col ++ ) {

			const i = ( ( y + row ) * image.width + x + col ) * 4, o = ( row * width + col ) * 3;
			for ( let c = 0; c < 3; c ++ ) {

				if ( ! light ) {

					test[ o + c ] = tableA[ a[ i + c ] ];
					ref[ o + c ] = tableB[ b[ i + c ] ];
					continue;

				}

				let va = a[ i + c ], vb = b[ i + c ];
				const fa = Number.isFinite( va ), fb = Number.isFinite( vb );
				// As above, a value not finite in either image counts as no error.
				if ( ! fa || ! fb ) {

					va = fa ? va : fb ? vb : 0;
					vb = fb ? vb : va;

				}

				test[ o + c ] = Math.max( va, 0 );
				ref[ o + c ] = Math.max( vb, 0 );

			}

		}

	}

	const map = flipErrorMap( ref, test, width, height, { hdr: light, ppd } );
	const sorted = map.slice().sort();
	let sum = 0;
	for ( const v of sorted ) sum += v;
	// FLIP's weighted median: the error below which half the summed error lies.
	let weightedMedian = 0;
	for ( let i = 0, running = 0; i < sorted.length; i ++ ) {

		running += sorted[ i ];
		if ( running > 0.5 * sum ) {

			weightedMedian = sorted[ i ];
			break;

		}

	}

	return { mean: sum / map.length, weightedMedian, max: sorted[ sorted.length - 1 ], ...( keepMap ? { errorImage: map } : {} ) };

}

// Every 8- or 16-bit sRGB code value as linear light.
function srgbTable( data ) {

	const scale = dataScale( data ), table = new Float32Array( Math.round( 1 / scale ) + 1 );
	for ( let i = 0; i < table.length; i ++ ) {

		const v = i * scale;
		table[ i ] = v <= 0.04045 ? v / 12.92 : ( ( v + 0.055 ) / 1.055 ) ** 2.4;

	}

	return table;

}

/**
 * Renders of disjoint sample ranges of one view — {@link captureHeadless} with `firstSample` on several machines or GPUs,
 * read `'linear'` — as the one render of all their samples: each part weighted by its sample count. Parts that say
 * where they start (`firstSample`; null when the sequence ran free) must not overlap: two renders of the same samples
 * merge into the noise of one.
 * @param {Array<{data: Float32Array, width: number, height: number, samples: number, firstSample?: ?number,
 *   colorSpace?: string}>} parts
 * @returns {{data: Float32Array, width: number, height: number, colorSpace: string, samples: number,
 *   firstSample: ?number}} `firstSample` where the parts make one unbroken range, else null
 */
export function mergeRenders( parts ) {

	if ( ! Array.isArray( parts ) || parts.length === 0 ) throw new Error( 'mergeRenders: expected a list of renders' );

	const { width, height } = parts[ 0 ];
	const colorSpace = parts[ 0 ].colorSpace ?? 'linear';
	for ( const [ i, part ] of parts.entries() ) {

		assertImage( part, `mergeRenders: part ${i}` );
		if ( ! ( part.data instanceof Float32Array ) ) throw new Error( `mergeRenders: part ${i} is not light: capture the parts with colorSpace 'linear'` );
		if ( part.width !== width || part.height !== height ) throw new Error( `mergeRenders: part ${i} is ${part.width}×${part.height}, part 0 ${width}×${height}` );
		if ( ( part.colorSpace ?? 'linear' ) !== colorSpace ) throw new Error( `mergeRenders: part ${i} is in ${part.colorSpace}, part 0 in ${colorSpace}` );
		if ( ! ( Number.isInteger( part.samples ) && part.samples > 0 ) ) throw new Error( `mergeRenders: part ${i} has no sample count` );
		// A denoised or displayed picture is not an average of its samples.
		if ( part.source !== undefined && part.source !== 'accumulation' ) throw new Error( `mergeRenders: part ${i} is the ${part.source} picture; merge raw accumulations (no denoise)` );

	}

	// Every part that says its range must keep to it, whether or not the others say theirs.
	const ranged = parts.filter( ( part ) => Number.isInteger( part.firstSample ) ).sort( ( p, q ) => p.firstSample - q.firstSample );
	let unbroken = ranged.length === parts.length;
	for ( let i = 1; i < ranged.length; i ++ ) {

		const end = ranged[ i - 1 ].firstSample + ranged[ i - 1 ].samples;
		if ( end > ranged[ i ].firstSample ) {

			throw new Error( `mergeRenders: two parts hold samples ${ranged[ i ].firstSample}…${end - 1}; give each part its own firstSample` );

		}

		if ( end !== ranged[ i ].firstSample ) unbroken = false;

	}

	const samples = parts.reduce( ( sum, part ) => sum + part.samples, 0 );
	const data = new Float32Array( width * height * 4 );
	for ( const part of parts ) {

		const weight = part.samples / samples;
		const from = part.data;
		for ( let i = 0; i < data.length; i ++ ) data[ i ] += from[ i ] * weight;

	}

	return { data, width, height, colorSpace, samples, firstSample: unbroken ? ranged[ 0 ].firstSample : null };

}

export function assertImage( image, name ) {

	const { data, width, height } = image ?? {};
	if ( ! data?.length || ! ( width > 0 ) || ! ( height > 0 ) || data.length < width * height * 4 ) {

		throw new Error( `${name}: expected RGBA { data, width, height }` );

	}

}

function dataScale( data ) {

	if ( data instanceof Uint8Array || data instanceof Uint8ClampedArray ) return 1 / 255;
	if ( data instanceof Uint16Array ) return 1 / 65535;
	return 1;

}
