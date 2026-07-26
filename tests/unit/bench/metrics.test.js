import { describe, it, expect } from 'vitest';
import { compare, srgbToLinear, luminance, ssim, diffHeatmap } from '../../../bench/lib/metrics.js';
import {
	percentile,
	median,
	mean,
	stdev,
	summarise,
	discardWarmup,
	compareRuns,
} from '../../../bench/lib/stats.js';

/**
 * Build a decoded RGBA image.
 *
 * @param {number} width
 * @param {number} height
 * @param {number[]|function( number, number ): number[]} fill - `[ r, g, b ]` for a solid
 *   image, or `( x, y ) => [ r, g, b ]` for a per-pixel pattern.
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
function makeImage( width, height, fill ) {

	const data = new Uint8ClampedArray( width * height * 4 );
	const sample = typeof fill === 'function' ? fill : () => fill;

	for ( let y = 0; y < height; y ++ ) {

		for ( let x = 0; x < width; x ++ ) {

			const rgb = sample( x, y );
			const i = ( y * width + x ) * 4;

			data[ i ] = rgb[ 0 ];
			data[ i + 1 ] = rgb[ 1 ];
			data[ i + 2 ] = rgb[ 2 ];
			data[ i + 3 ] = 255;

		}

	}

	return { width, height, data };

}

/**
 * Copy an image and overwrite a single pixel.
 *
 * @param {{ width: number, height: number, data: Uint8ClampedArray }} img
 * @param {number} x
 * @param {number} y
 * @param {number[]} rgb
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
function withPixel( img, x, y, rgb ) {

	const data = new Uint8ClampedArray( img.data );
	const i = ( y * img.width + x ) * 4;

	data[ i ] = rgb[ 0 ];
	data[ i + 1 ] = rgb[ 1 ];
	data[ i + 2 ] = rgb[ 2 ];
	data[ i + 3 ] = 255;

	return { width: img.width, height: img.height, data };

}

const checker = ( x, y ) => ( ( x + y ) % 2 === 0 ? [ 0, 0, 0 ] : [ 255, 255, 255 ] );
const invertedChecker = ( x, y ) => ( ( x + y ) % 2 === 0 ? [ 255, 255, 255 ] : [ 0, 0, 0 ] );

describe( 'bench/lib/metrics', () => {

	describe( 'srgbToLinear', () => {

		it( 'maps the endpoints exactly', () => {

			expect( srgbToLinear( 0 ) ).toBe( 0 );
			expect( srgbToLinear( 255 ) ).toBe( 1 );

		} );

		it( 'maps mid-grey 128 to ~0.2159, not 0.5', () => {

			// The whole reason the metrics run in linear light: encoded 50% is 21.6% of the energy.
			expect( srgbToLinear( 128 ) ).toBeCloseTo( 0.2159, 3 );
			expect( Math.abs( srgbToLinear( 128 ) - 0.5 ) ).toBeGreaterThan( 0.2 );

		} );

		it( 'uses the linear toe below the piecewise knee', () => {

			expect( srgbToLinear( 8 ) ).toBeCloseTo( ( 8 / 255 ) / 12.92, 6 );

		} );

	} );

	describe( 'luminance', () => {

		it( 'applies Rec.709 weights and sums to 1 for white', () => {

			expect( luminance( 1, 1, 1 ) ).toBeCloseTo( 1, 12 );
			expect( luminance( 1, 0, 0 ) ).toBeCloseTo( 0.2126, 12 );
			expect( luminance( 0, 1, 0 ) ).toBeCloseTo( 0.7152, 12 );
			expect( luminance( 0, 0, 1 ) ).toBeCloseTo( 0.0722, 12 );

		} );

	} );

	describe( 'compare', () => {

		it( 'reports a perfect match for identical images', () => {

			const a = makeImage( 8, 8, checker );
			const b = makeImage( 8, 8, checker );
			const result = compare( a, b );

			expect( result.rmse ).toBe( 0 );
			expect( result.rmseSrgb ).toBe( 0 );
			expect( result.identical ).toBe( true );
			expect( result.psnr ).toBe( Infinity );
			expect( result.pixelsOverThreshold ).toBe( 0 );
			expect( result.fractionOverThreshold ).toBe( 0 );
			expect( result.meanLuminanceDelta ).toBe( 0 );
			expect( result.meanLuminanceRatio ).toBe( 1 );
			expect( result.maxChannelDelta ).toBe( 0 );
			expect( result.width ).toBe( 8 );
			expect( result.height ).toBe( 8 );

		} );

		it( 'throws on a dimension mismatch', () => {

			const a = makeImage( 4, 4, [ 0, 0, 0 ] );
			const b = makeImage( 4, 5, [ 0, 0, 0 ] );

			expect( () => compare( a, b ) ).toThrow( /dimensions differ/ );

		} );

		it( 'throws on non-image arguments', () => {

			const a = makeImage( 4, 4, [ 0, 0, 0 ] );

			expect( () => compare( a, null ) ).toThrow( /images/ );
			expect( () => compare( a, { width: 4, height: 4, data: new Float32Array( 64 ) } ) )
				.toThrow( /Uint8ClampedArray/ );

		} );

		it( 'reports a positive luminance delta and ratio > 1 for a brighter candidate', () => {

			// Bias detection: a uniformly brighter render must read as brighter, signed.
			const a = makeImage( 8, 8, [ 64, 64, 64 ] );
			const b = makeImage( 8, 8, [ 128, 128, 128 ] );
			const result = compare( a, b );

			expect( result.meanLuminanceA ).toBeCloseTo( srgbToLinear( 64 ), 6 );
			expect( result.meanLuminanceB ).toBeCloseTo( srgbToLinear( 128 ), 6 );
			expect( result.meanLuminanceDelta ).toBeGreaterThan( 0 );
			expect( result.meanLuminanceRatio ).toBeGreaterThan( 1 );
			expect( result.meanChannelDelta.r ).toBeGreaterThan( 0 );
			expect( result.meanChannelDelta.g ).toBeGreaterThan( 0 );
			expect( result.meanChannelDelta.b ).toBeGreaterThan( 0 );
			expect( result.identical ).toBe( false );

		} );

		it( 'reports a negative luminance delta and ratio < 1 for a darker candidate', () => {

			const a = makeImage( 8, 8, [ 128, 128, 128 ] );
			const b = makeImage( 8, 8, [ 64, 64, 64 ] );
			const result = compare( a, b );

			expect( result.meanLuminanceDelta ).toBeLessThan( 0 );
			expect( result.meanLuminanceRatio ).toBeLessThan( 1 );

		} );

		it( 'produces no NaN for black vs black', () => {

			const black = makeImage( 4, 4, [ 0, 0, 0 ] );
			const result = compare( black, black );

			expect( result.psnr ).toBe( Infinity );
			expect( result.meanLuminanceRatio ).toBe( 1 );

			for ( const [ key, value ] of Object.entries( result ) ) {

				if ( key === 'psnr' || typeof value !== 'number' ) continue;

				expect( Number.isFinite( value ), `${ key } is not finite` ).toBe( true );

			}

			for ( const [ key, value ] of Object.entries( result.meanChannelDelta ) ) {

				expect( Number.isFinite( value ), `meanChannelDelta.${ key } is not finite` ).toBe( true );

			}

		} );

		it( 'produces no NaN when only the reference is black', () => {

			const a = makeImage( 4, 4, [ 0, 0, 0 ] );
			const b = makeImage( 4, 4, [ 255, 255, 255 ] );
			const result = compare( a, b );

			expect( Number.isFinite( result.rmse ) ).toBe( true );
			expect( Number.isFinite( result.psnr ) ).toBe( true );

			// Divide-by-zero guard: the ratio falls back to 1, so the signed delta is the
			// only usable bias signal against a black reference.
			expect( result.meanLuminanceRatio ).toBe( 1 );
			expect( result.meanLuminanceDelta ).toBeCloseTo( 1, 12 );

		} );

		it( 'counts a single pixel that exceeds the threshold', () => {

			const a = makeImage( 4, 4, [ 0, 0, 0 ] );
			const b = withPixel( a, 1, 2, [ 255, 255, 255 ] );
			const result = compare( a, b );

			expect( result.identical ).toBe( false );
			expect( result.pixelsOverThreshold ).toBe( 1 );
			expect( result.fractionOverThreshold ).toBeCloseTo( 1 / 16, 12 );
			expect( result.maxChannelDelta ).toBeCloseTo( 1, 12 );

		} );

		it( 'does not count a pixel whose delta sits under the threshold', () => {

			// Blue 8/255 is ~0.00018 linear luminance — well below the 0.02 default.
			const a = makeImage( 4, 4, [ 0, 0, 0 ] );
			const b = withPixel( a, 0, 0, [ 0, 0, 8 ] );
			const result = compare( a, b );

			expect( result.identical ).toBe( false );
			expect( result.pixelsOverThreshold ).toBe( 0 );
			expect( result.fractionOverThreshold ).toBe( 0 );

		} );

		it( 'honours an explicit threshold', () => {

			const a = makeImage( 4, 4, [ 0, 0, 0 ] );
			const b = withPixel( a, 3, 3, [ 255, 255, 255 ] );

			expect( compare( a, b, { threshold: 0.5 } ).pixelsOverThreshold ).toBe( 1 );
			expect( compare( a, b, { threshold: 2 } ).pixelsOverThreshold ).toBe( 0 );

		} );

	} );

	describe( 'ssim', () => {

		it( 'returns ~1 for identical images', () => {

			const a = makeImage( 16, 16, checker );
			const b = makeImage( 16, 16, checker );

			expect( ssim( a, b ) ).toBeCloseTo( 1, 6 );

		} );

		it( 'returns ~1 for identical flat images', () => {

			const a = makeImage( 16, 16, [ 90, 120, 200 ] );
			const b = makeImage( 16, 16, [ 90, 120, 200 ] );

			expect( ssim( a, b ) ).toBeCloseTo( 1, 6 );

		} );

		it( 'drops well below 1 for a structurally different image', () => {

			const a = makeImage( 16, 16, checker );
			const b = makeImage( 16, 16, invertedChecker );
			const score = ssim( a, b );

			expect( score ).toBeLessThan( 0.5 );
			expect( score ).toBeGreaterThanOrEqual( 0 );

		} );

		it( 'handles images smaller than the window', () => {

			const a = makeImage( 4, 4, checker );

			expect( ssim( a, makeImage( 4, 4, checker ) ) ).toBeCloseTo( 1, 6 );
			expect( ssim( a, makeImage( 4, 4, invertedChecker ) ) ).toBeLessThan( 0.5 );

		} );

	} );

	describe( 'diffHeatmap', () => {

		it( 'renders an all-black opaque map for a zero diff', () => {

			const a = makeImage( 4, 4, [ 30, 60, 90 ] );
			const map = diffHeatmap( a, makeImage( 4, 4, [ 30, 60, 90 ] ) );

			expect( map.width ).toBe( 4 );
			expect( map.height ).toBe( 4 );

			for ( let i = 0; i < map.data.length; i += 4 ) {

				expect( map.data[ i ] ).toBe( 0 );
				expect( map.data[ i + 1 ] ).toBe( 0 );
				expect( map.data[ i + 2 ] ).toBe( 0 );
				expect( map.data[ i + 3 ] ).toBe( 255 );

			}

		} );

		it( 'puts the peak delta at the top of the ramp', () => {

			const a = makeImage( 2, 2, [ 0, 0, 0 ] );
			const b = withPixel( a, 1, 1, [ 255, 255, 255 ] );
			const map = diffHeatmap( a, b );

			// Auto-scale normalises the peak to 1 -> pure red.
			expect( map.data[ 12 ] ).toBe( 255 );
			expect( map.data[ 13 ] ).toBe( 0 );
			expect( map.data[ 14 ] ).toBe( 0 );
			expect( map.data[ 0 ] ).toBe( 0 );

		} );

	} );

} );

describe( 'bench/lib/stats', () => {

	describe( 'percentile', () => {

		it( 'interpolates between adjacent ranks', () => {

			const values = [ 3, 1, 4, 2 ];

			expect( percentile( values, 0 ) ).toBe( 1 );
			expect( percentile( values, 0.25 ) ).toBeCloseTo( 1.75, 12 );
			expect( percentile( values, 0.5 ) ).toBeCloseTo( 2.5, 12 );
			expect( percentile( values, 0.75 ) ).toBeCloseTo( 3.25, 12 );
			expect( percentile( values, 1 ) ).toBe( 4 );

		} );

		it( 'clamps p to 0-1', () => {

			const values = [ 3, 1, 4, 2 ];

			expect( percentile( values, - 1 ) ).toBe( 1 );
			expect( percentile( values, 2 ) ).toBe( 4 );

		} );

		it( 'returns NaN for an empty sample', () => {

			expect( percentile( [], 0.5 ) ).toBeNaN();

		} );

		it( 'does not mutate its input', () => {

			const values = [ 3, 1, 4, 2 ];

			percentile( values, 0.9 );
			expect( values ).toEqual( [ 3, 1, 4, 2 ] );

		} );

	} );

	describe( 'median', () => {

		it( 'takes the middle value of an odd sample', () => {

			expect( median( [ 5, 1, 3 ] ) ).toBe( 3 );

		} );

		it( 'averages the two middle values of an even sample', () => {

			expect( median( [ 4, 1, 3, 2 ] ) ).toBeCloseTo( 2.5, 12 );

		} );

		it( 'returns NaN for an empty sample', () => {

			expect( median( [] ) ).toBeNaN();

		} );

		it( 'does not mutate its input', () => {

			const values = [ 9, 2, 7, 1 ];

			median( values );
			expect( values ).toEqual( [ 9, 2, 7, 1 ] );

		} );

	} );

	describe( 'mean / stdev', () => {

		it( 'computes the arithmetic mean', () => {

			expect( mean( [ 2, 4, 6 ] ) ).toBe( 4 );
			expect( mean( [] ) ).toBeNaN();

		} );

		it( 'uses the n - 1 denominator', () => {

			// deviations from 5: -3,-1,-1,-1,0,0,2,4 -> sumSq 32, /7
			expect( stdev( [ 2, 4, 4, 4, 5, 5, 7, 9 ] ) ).toBeCloseTo( Math.sqrt( 32 / 7 ), 12 );

		} );

		it( 'returns 0 for samples shorter than 2', () => {

			expect( stdev( [ 42 ] ) ).toBe( 0 );
			expect( stdev( [] ) ).toBe( 0 );

		} );

	} );

	describe( 'discardWarmup', () => {

		it( 'drops the requested number of leading samples', () => {

			expect( discardWarmup( [ 1, 2, 3 ] ) ).toEqual( [ 2, 3 ] );
			expect( discardWarmup( [ 1, 2, 3 ], 2 ) ).toEqual( [ 3 ] );

		} );

		it( 'returns the sample untouched when trimming would empty it', () => {

			const values = [ 1, 2, 3 ];

			expect( discardWarmup( values, 5 ) ).toBe( values );

		} );

	} );

	describe( 'summarise', () => {

		it( 'reports hand-computed statistics', () => {

			const values = [ 5, 2, 9, 4, 7, 4, 5, 4 ];
			const s = summarise( values );

			expect( s.n ).toBe( 8 );
			expect( s.min ).toBe( 2 );
			expect( s.max ).toBe( 9 );
			expect( s.mean ).toBe( 5 );
			expect( s.median ).toBeCloseTo( 4.5, 12 );
			// rank 0.95 * 7 = 6.65 -> 7 + ( 9 - 7 ) * 0.65
			expect( s.p95 ).toBeCloseTo( 8.3, 12 );
			expect( s.stdev ).toBeCloseTo( Math.sqrt( 32 / 7 ), 12 );
			expect( s.cv ).toBeCloseTo( Math.sqrt( 32 / 7 ) / 5, 12 );

		} );

		it( 'does not mutate its input', () => {

			const values = [ 5, 2, 9, 4 ];

			summarise( values );
			expect( values ).toEqual( [ 5, 2, 9, 4 ] );

		} );

		it( 'degrades gracefully on empty and single-value samples', () => {

			const empty = summarise( [] );

			expect( empty.n ).toBe( 0 );
			expect( empty.min ).toBeNaN();
			expect( empty.max ).toBeNaN();
			expect( empty.mean ).toBeNaN();
			expect( empty.median ).toBeNaN();
			expect( empty.p95 ).toBeNaN();
			expect( empty.stdev ).toBe( 0 );
			expect( empty.cv ).toBe( 0 );

			const single = summarise( [ 12 ] );

			expect( single.n ).toBe( 1 );
			expect( single.mean ).toBe( 12 );
			expect( single.median ).toBe( 12 );
			expect( single.p95 ).toBe( 12 );
			expect( single.stdev ).toBe( 0 );
			expect( single.cv ).toBe( 0 );

		} );

		it( 'keeps cv non-negative for negative-mean samples', () => {

			expect( summarise( [ - 10, - 12, - 11 ] ).cv ).toBeGreaterThan( 0 );

		} );

	} );

	describe( 'compareRuns', () => {

		it( 'refuses a verdict when the baseline is noisy', () => {

			const base = [ 50, 150, 60, 140, 100 ];
			const head = [ 110, 110, 110, 110, 110 ];
			const result = compareRuns( base, head );

			expect( result.base.cv ).toBeGreaterThan( 0.15 );
			expect( result.verdict ).toBe( 'inconclusive' );

		} );

		it( 'calls a clean 20% regression slower', () => {

			const base = [ 100, 101, 99, 100, 100 ];
			const head = [ 120, 121, 119, 120, 120 ];
			const result = compareRuns( base, head );

			expect( result.base.median ).toBe( 100 );
			expect( result.head.median ).toBe( 120 );
			expect( result.deltaPct ).toBeCloseTo( 20, 12 );
			expect( result.verdict ).toBe( 'slower' );

		} );

		it( 'calls a clean 20% improvement faster', () => {

			const base = [ 100, 101, 99, 100, 100 ];
			const head = [ 80, 81, 79, 80, 80 ];
			const result = compareRuns( base, head );

			expect( result.deltaPct ).toBeCloseTo( - 20, 12 );
			expect( result.verdict ).toBe( 'faster' );

		} );

		it( 'calls a sub-2% change unchanged', () => {

			const base = [ 100, 100, 100, 100, 100 ];
			const head = [ 101, 101, 101, 101, 101 ];
			const result = compareRuns( base, head );

			expect( result.deltaPct ).toBeCloseTo( 1, 12 );
			expect( result.verdict ).toBe( 'unchanged' );

		} );

		it( 'refuses a verdict when the delta sits inside the noise floor', () => {

			const base = [ 100, 108, 92, 104, 96 ];
			const head = [ 103, 111, 95, 107, 99 ];

			expect( compareRuns( base, head ).verdict ).toBe( 'inconclusive' );

		} );

		it( 'refuses a verdict for empty samples', () => {

			expect( compareRuns( [], [] ).verdict ).toBe( 'inconclusive' );

		} );

	} );

} );
