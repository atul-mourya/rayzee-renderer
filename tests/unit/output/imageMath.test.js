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

describe( 'compareImages: FLIP', () => {

	const make = ( w, h, f, Type = Float32Array ) => {

		const data = new Type( w * h * 4 );
		for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) data.set( [ ...f( x, y ), Type === Float32Array ? 1 : 255 ], ( y * w + x ) * 4 );
		return { data, width: w, height: h };

	};

	const noise = ( x, y ) => ( Math.imul( ( x * 374761393 + y * 668265263 ) ^ ( y * 2246822519 ), 1274126177 ) >>> 16 ) / 0xffff;
	const grey = make( 48, 40, () => [ 0.18, 0.18, 0.18 ] );
	const noisy = make( 48, 40, ( x, y ) => Array( 3 ).fill( 0.18 * ( 0.5 + noise( x, y ) ) ) );

	it( 'scores identical images 0', () => {

		const bytes = make( 20, 12, ( x, y ) => [ x * 12, y * 20, 90 ], Uint8Array );
		expect( compareImages( bytes, bytes, { flip: true } ).flip ).toEqual( { mean: 0, weightedMedian: 0, max: 0 } );
		expect( compareImages( noisy, noisy, { flip: true } ).flip ).toEqual( { mean: 0, weightedMedian: 0, max: 0 } );

	} );

	// No edges, so the colour term alone: HyAB 100^0.7 against green-to-blue's, remapped by FLIP's pc and pt.
	it( 'scores black against white by FLIP\'s colour metric', () => {

		const black = make( 16, 16, () => [ 0, 0, 0 ], Uint8Array ), white = make( 16, 16, () => [ 255, 255, 255 ], Uint8Array );
		const { mean, max, errorImage } = compareImages( white, black, { flip: true, errorImage: true } ).flip;
		expect( mean ).toBeCloseTo( 0.96738, 5 );
		expect( max ).toBe( mean );
		expect( new Set( errorImage ).size ).toBe( 1 );

	} );

	it( 'reads 8- and 16-bit pictures alike, as sRGB', () => {

		const eight = ( f ) => make( 24, 16, f, Uint8Array ), sixteen = ( f ) => make( 24, 16, ( x, y ) => f( x, y ).map( ( v ) => v * 257 ), Uint16Array );
		const a = ( x, y ) => [ x * 10, y * 15, 128 ], b = ( x, y ) => [ x * 10, y * 15, x > 12 ? 160 : 128 ];
		expect( compareImages( sixteen( b ), sixteen( a ), { flip: true } ).flip.mean ).toBeCloseTo( compareImages( eight( b ), eight( a ), { flip: true } ).flip.mean, 6 );

	} );

	it( 'compares light at the reference\'s exposures, so scaling both changes nothing', () => {

		const times4 = ( { data, width, height } ) => ( { data: data.map( ( v, i ) => i % 4 === 3 ? v : v * 4 ), width, height } );
		const once = compareImages( noisy, grey, { flip: true } ).flip.mean;
		expect( once ).toBeGreaterThan( 0.01 );
		expect( compareImages( times4( noisy ), times4( grey ), { flip: true } ).flip.mean ).toBeCloseTo( once, 6 );

	} );

	it( 'sees fine noise less from farther away', () => {

		const at = ( ppd ) => compareImages( noisy, grey, { flip: { ppd } } ).flip.mean;
		expect( at( 20 ) ).toBeGreaterThan( at( 67 ) );
		expect( at( 67 ) ).toBeGreaterThan( at( 200 ) );

	} );

	it( 'puts the error where the images differ', () => {

		const patch = make( 48, 40, ( x, y ) => x < 8 && y < 8 ? [ 1, 1, 1 ] : [ 0.18, 0.18, 0.18 ] );
		const { errorImage, max } = compareImages( patch, grey, { flip: true, errorImage: true } ).flip;
		expect( errorImage[ 3 * 48 + 3 ] ).toBeGreaterThan( 0.2 );
		expect( errorImage[ 39 * 48 + 47 ] ).toBe( 0 );
		expect( max ).toBe( Math.max( ...errorImage ) );

	} );

	it( 'counts a value that is not finite as no error, and compares only the crop', () => {

		const broken = make( 48, 40, ( x, y ) => x === 5 && y === 5 ? [ NaN, Infinity, 0.18 ] : [ 0.18, 0.18, 0.18 ] );
		expect( compareImages( broken, grey, { flip: true } ).flip.mean ).toBe( 0 );

		const crop = { x: 10, y: 4, width: 20, height: 24 };
		const cut = ( { data, width } ) => make( crop.width, crop.height, ( x, y ) => Array.from( data.subarray( ( ( y + crop.y ) * width + x + crop.x ) * 4 ).slice( 0, 3 ) ) );
		expect( compareImages( noisy, grey, { flip: true, crop } ).flip ).toEqual( compareImages( cut( noisy ), cut( grey ), { flip: true } ).flip );

	} );

	// Pinned once the port matched NVIDIA's own test pairs (too large to keep here): a dark sRGB ramp and a moved edge;
	// a room with a light 40× brighter than its walls, rendered noisy.
	it( 'keeps the scores it gave when it matched NVIDIA\'s', () => {

		const scene = ( shift ) => ( x, y ) => [ x < 24 + shift ? x * 0.4 : 200, y * 2, x > 30 && y > 20 ? 220 : 6 ];
		const picture = compareImages( make( 48, 40, scene( 1 ), Uint8Array ), make( 48, 40, scene( 0 ), Uint8Array ), { flip: true } ).flip;
		expect( picture.mean ).toBeCloseTo( 0.0521397, 6 );
		expect( picture.weightedMedian ).toBeCloseTo( 0.355478, 5 );
		expect( picture.max ).toBeCloseTo( 0.569462, 5 );

		const room = ( x, y ) => {

			const light = ( x - 36 ) ** 2 + ( y - 8 ) ** 2 < 16 ? 40 : 0;
			return [ 0.02 + x * 0.004 + light, 0.02 + y * 0.005 + light, 0.05 + light ];

		};

		const rendered = make( 48, 40, ( x, y ) => room( x, y ).map( ( v ) => v * ( 0.6 + 0.8 * noise( x, y ) ) ) );
		const light = compareImages( rendered, make( 48, 40, room ), { flip: true } ).flip;
		expect( light.mean ).toBeCloseTo( 0.1261992, 6 );
		expect( light.weightedMedian ).toBeCloseTo( 0.138585, 5 );
		expect( light.max ).toBeCloseTo( 0.356225, 5 );

	} );

	it( 'refuses an option it cannot use', () => {

		expect( () => compareImages( grey, grey, { flip: 'yes' } ) ).toThrow( /true, false or \{ ppd \}/ );
		expect( () => compareImages( grey, grey, { flip: { ppd: 0 } } ) ).toThrow( /positive number/ );
		expect( compareImages( grey, grey ).flip ).toBeUndefined();

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
