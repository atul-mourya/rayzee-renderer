import { describe, it, expect } from 'vitest';
import { compareImages, mergeRenders } from '@/core/output/ImageMath.js';

describe( 'compareImages', () => {

	const image = ( values, Type = Float32Array ) => {

		const data = new Type( values.length * 4 );
		values.forEach( ( [ r, g, b ], i ) => data.set( [ r, g, b, Type === Float32Array ? 1 : 255 ], i * 4 ) );
		return { data, width: values.length, height: 1 };

	};

	// imgtool diff's numbers, by hand: errors 0.5 and 0 per pixel, reference 1 and 0.
	it( 'gives pbrt\'s MSE, MAE and MRSE', () => {

		const out = compareImages( image( [[ 1.5, 1.5, 1.5 ], [ 0, 0, 0 ]] ), image( [[ 1, 1, 1 ], [ 0, 0, 0 ]] ) );

		expect( out.mse ).toBeCloseTo( 0.125 );
		expect( out.rmse ).toBeCloseTo( Math.sqrt( 0.125 ) );
		expect( out.mae ).toBeCloseTo( 0.25 );
		expect( out.mrse ).toBeCloseTo( 0.25 / 1.01 ** 2 / 2 );
		expect( out ).toMatchObject( { mean: 0.75, referenceMean: 0.5, relativeBias: expect.closeTo( 0.5 ), nonFinite: 0, pixels: 2 } );

	} );

	it( 'counts an error below the reference as one above it', () => {

		expect( compareImages( image( [[ 0.5, 0.5, 0.5 ]] ), image( [[ 1, 1, 1 ]] ) ) ).toMatchObject( { mae: 0.5, mse: 0.25, relativeBias: - 0.5 } );

	} );

	it( 'ignores alpha', () => {

		const a = image( [[ 1, 1, 1 ]] ), b = image( [[ 1, 1, 1 ]] );
		b.data[ 3 ] = 0;
		expect( compareImages( a, b ).mse ).toBe( 0 );

	} );

	it( 'counts a value that is not finite as no error, as pbrt does', () => {

		const out = compareImages( image( [[ Infinity, NaN, 1 ], [ 1, 1, 1 ]] ), image( [[ 1, 1, 1 ], [ 1, 1, 1 ]] ) );
		expect( out ).toMatchObject( { mse: 0, nonFinite: 2 } );

	} );

	it( 'reads 8- and 16-bit data as 0–1', () => {

		const bytes = compareImages( image( [[ 255, 255, 255 ]], Uint8ClampedArray ), image( [[ 0, 0, 0 ]], Uint8Array ) );
		const halves = compareImages( image( [[ 65535, 0, 0 ]], Uint16Array ), image( [[ 0, 0, 0 ]], Uint16Array ) );
		expect( bytes.mse ).toBeCloseTo( 1 );
		expect( halves.mae ).toBeCloseTo( 1 / 3 );

	} );

	it( 'compares only the crop', () => {

		const a = image( [[ 9, 9, 9 ], [ 1, 1, 1 ]] ), b = image( [[ 0, 0, 0 ], [ 1, 1, 1 ]] );
		expect( compareImages( a, b, { crop: { x: 1, y: 0, width: 1, height: 1 } } ) ).toMatchObject( { mse: 0, pixels: 1 } );

	} );

	it( 'returns each pixel\'s error on request', () => {

		const out = compareImages( image( [[ 2, 2, 2 ], [ 1, 1, 1 ]] ), image( [[ 1, 1, 1 ], [ 1, 1, 1 ]] ), { errorImage: true } );
		expect( Array.from( out.errorImage ) ).toEqual( [ 1, 0 ] );

	} );

	it( 'refuses images it cannot line up', () => {

		const two = image( [[ 1, 1, 1 ], [ 1, 1, 1 ]] );
		expect( () => compareImages( two, image( [[ 1, 1, 1 ]] ) ) ).toThrow( /2×1.*1×1/ );
		expect( () => compareImages( two, image( [[ 1, 1, 1 ], [ 1, 1, 1 ]], Uint8Array ) ) ).toThrow( /read both alike/ );
		expect( () => compareImages( two, two, { crop: { x: 1, y: 0, width: 2, height: 1 } } ) ).toThrow( /not inside/ );
		expect( () => compareImages( { data: new Float32Array( 3 ), width: 1, height: 1 }, two ) ).toThrow( /expected RGBA/ );

	} );

} );

describe( 'mergeRenders', () => {

	const part = ( value, samples, firstSample = null, size = 2 ) => ( {
		data: new Float32Array( size * 4 ).fill( value ), width: size, height: 1, colorSpace: 'linear', samples, firstSample,
	} );

	it( 'refuses a denoised or displayed picture as a part', () => {

		expect( () => mergeRenders( [ { ...part( 1, 4, 0 ), source: 'oidn' }, part( 1, 4, 4 ) ] ) ).toThrow( /oidn picture/ );
		expect( mergeRenders( [ { ...part( 1, 4, 0 ), source: 'accumulation' }, part( 1, 4, 4 ) ] ).samples ).toBe( 8 );

	} );

	it( 'checks the ranges it is told even when one part gives none', () => {

		expect( () => mergeRenders( [ part( 1, 8, 0 ), part( 1, 8, 4 ), part( 1, 8 ) ] ) ).toThrow( /give each part its own firstSample/ );
		expect( mergeRenders( [ part( 1, 8, 0 ), part( 1, 8, 8 ), part( 1, 8 ) ] ).firstSample ).toBeNull();

	} );

	it( 'weights each part by its samples, as one render of all of them', () => {

		const merged = mergeRenders( [ part( 1, 32, 0 ), part( 4, 96, 32 ) ] );
		expect( merged.data[ 0 ] ).toBeCloseTo( ( 32 * 1 + 96 * 4 ) / 128 );
		expect( merged ).toMatchObject( { samples: 128, firstSample: 0, width: 2, height: 1, colorSpace: 'linear' } );

	} );

	it( 'names no first sample where the ranges leave a gap, or are not known', () => {

		expect( mergeRenders( [ part( 1, 32, 0 ), part( 1, 32, 64 ) ] ).firstSample ).toBeNull();
		expect( mergeRenders( [ part( 1, 32, 0 ), part( 1, 32 ) ] ).firstSample ).toBeNull();

	} );

	it( 'refuses two parts of the same samples', () => {

		expect( () => mergeRenders( [ part( 1, 64, 0 ), part( 1, 64, 32 ) ] ) ).toThrow( /32…63/ );
		expect( () => mergeRenders( [ part( 1, 64, 0 ), part( 1, 64, 0 ) ] ) ).toThrow( /own firstSample/ );

	} );

	it( 'refuses what is not light, or not the same picture', () => {

		const bytes = { ...part( 1, 8, 0 ), data: new Uint8ClampedArray( 8 ), colorSpace: 'srgb' };
		expect( () => mergeRenders( [ part( 1, 8, 0 ), bytes ] ) ).toThrow( /colorSpace 'linear'/ );
		expect( () => mergeRenders( [ part( 1, 8, 0 ), part( 1, 8, 8, 3 ) ] ) ).toThrow( /3×1, part 0 2×1/ );
		expect( () => mergeRenders( [ part( 1, 8, 0 ), { ...part( 1, 8, 8 ), colorSpace: 'ACEScg' } ] ) ).toThrow( /ACEScg/ );
		expect( () => mergeRenders( [ part( 1, 0, 0 ) ] ) ).toThrow( /no sample count/ );
		expect( () => mergeRenders( [] ) ).toThrow( /a list of renders/ );

	} );

} );
