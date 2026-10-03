import { describe, it, expect, vi } from 'vitest';

// Mock Three.js imports
vi.mock( 'three', () => ( {
	DataUtils: { fromHalfFloat: ( v ) => v },
	HalfFloatType: 1016,
	FloatType: 1015,
	SRGBColorSpace: 'srgb',
} ) );

import { extractFloatData } from '@/core/Processor/EquirectHDRInfo.js';
import { EquirectHDRInfo } from '@/core/Processor/EquirectHDRInfo.js';
import { buildExactEnvironmentTable, packExactTable } from '@/core/Processor/EnvironmentExactTable.js';

describe( 'extractFloatData', () => {

	it( 'copies Float32Array data', () => {

		const data = new Float32Array( [ 1, 0, 0, 1, 0, 1, 0, 1 ] ); // 2 pixels RGBA
		const envMap = {
			type: 1015, // FloatType
			image: { width: 2, height: 1, data },
			flipY: false,
		};

		const result = extractFloatData( envMap );
		expect( result.width ).toBe( 2 );
		expect( result.height ).toBe( 1 );
		expect( result.floatData ).toBeInstanceOf( Float32Array );
		expect( result.floatData ).not.toBe( data ); // should be a copy
		expect( [ ...result.floatData ] ).toEqual( [ ...data ] );

	} );

	it( 'throws when image data is missing and canvas extraction unavailable', () => {

		const envMap = {
			type: 1015,
			image: { width: 2, height: 1, data: null },
		};

		expect( () => extractFloatData( envMap ) ).toThrow();

	} );

	it( 'handles integer type conversion', () => {

		// Uint8Array: values 0-255 mapped to 0-1
		const data = new Uint8Array( [ 255, 0, 0, 255, 0, 255, 0, 255 ] );
		const envMap = {
			type: 0, // not Float or HalfFloat
			image: { width: 2, height: 1, data },
			flipY: false,
		};

		const result = extractFloatData( envMap );
		expect( result.floatData[ 0 ] ).toBeCloseTo( 1.0 ); // 255/255
		expect( result.floatData[ 1 ] ).toBeCloseTo( 0.0 ); // 0/255

	} );

	it( 'handles flipY by inverting rows', () => {

		// 2x2 image, RGBA
		const data = new Float32Array( [
			// row 0 (top)
			1, 0, 0, 1, 0, 1, 0, 1,
			// row 1 (bottom)
			0, 0, 1, 1, 1, 1, 1, 1,
		] );
		const envMap = {
			type: 1015,
			image: { width: 2, height: 2, data },
			flipY: true,
		};

		const result = extractFloatData( envMap );
		// After Y-flip, row 0 becomes row 1 and vice versa
		// New row 0 = old row 1 (blue pixel, white pixel)
		expect( result.floatData[ 0 ] ).toBeCloseTo( 0 ); // blue.r
		expect( result.floatData[ 2 ] ).toBeCloseTo( 1 ); // blue.b

	} );

} );

describe( 'buildExactEnvironmentTable', () => {

	const image = ( width, height, at ) => {

		const data = new Float32Array( width * height * 4 );
		for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

			const v = at( x, y );
			data.set( [ v, v, v, 1 ], ( y * width + x ) * 4 );

		}

		return data;

	};

	// Each guide is the first entry above its step's start, or the last.
	const checkGuides = ( cdf, offset, n, guide, guideOffset ) => {

		for ( let g = 0; g < n; g ++ ) {

			const i = guide[ guideOffset + g ];
			expect( i === n - 1 || cdf[ offset + i ] > g / n ).toBe( true );
			if ( i > 0 ) expect( cdf[ offset + i - 1 ] ).toBeLessThanOrEqual( g / n );

		}

	};

	it( 'spreads a uniform map evenly and guides each step to its entry', () => {

		const t = buildExactEnvironmentTable( image( 8, 4, () => 1 ), 8, 4 );
		expect( [ t.exactWidth, t.exactHeight ] ).toEqual( [ 8, 4 ] );
		for ( let x = 0; x < 8; x ++ ) expect( t.exactConditional[ x ] ).toBeCloseTo( ( x + 1 ) / 8, 6 );
		expect( t.exactMarginal[ 3 ] ).toBe( 1 );
		for ( let y = 0; y < 4; y ++ ) checkGuides( t.exactConditional, y * 8, 8, t.exactRowGuide, y * 8 );
		checkGuides( t.exactMarginal, 0, 4, t.exactMarginalGuide, 0 );
		expect( t.radianceIntegral ).toBeGreaterThan( 0 );

	} );

	it( 'guides a peaked map, past empty stretches', () => {

		const W = 64, H = 32;
		const t = buildExactEnvironmentTable( image( W, H, ( x, y ) => ( x === 40 && y === 20 ? 1000 : y < 8 ? 0 : 0.1 ) ), W, H );
		for ( let y = 0; y < H; y ++ ) checkGuides( t.exactConditional, y * W, W, t.exactRowGuide, y * W );
		checkGuides( t.exactMarginal, 0, H, t.exactMarginalGuide, 0 );
		// Most steps land on the sun's row and its neighbours (the filter gives them a share of it).
		const sunRows = [ ...t.exactMarginalGuide ].filter( y => Math.abs( y - 20 ) <= 1 ).length;
		expect( sunRows / H ).toBeGreaterThan( 0.9 );

	} );

	it( 'packs guides and running sums as the shader reads them', () => {

		const t = buildExactEnvironmentTable( image( 8, 4, ( x ) => x + 1 ), 8, 4 );
		const { data, width, height } = packExactTable( t );
		expect( [ width, height ] ).toEqual( [ 9, 8 ] );
		expect( data[ 2 * 9 + 3 ] ).toBe( t.exactRowGuide[ 2 * 8 + 3 ] );
		expect( data[ 1 * 9 + 8 ] ).toBe( t.exactMarginalGuide[ 1 ] );
		expect( data[ ( 4 + 2 ) * 9 + 3 ] ).toBe( t.exactConditional[ 2 * 8 + 3 ] );
		expect( data[ ( 4 + 1 ) * 9 + 8 ] ).toBe( t.exactMarginal[ 1 ] );

	} );

	it( 'gives a black map nothing to sample', () => {

		const info = new EquirectHDRInfo();
		info._adopt( buildExactEnvironmentTable( new Float32Array( 2 * 2 * 4 ), 2, 2 ), 2, 2 );
		expect( info.totalSum ).toBe( 0 );
		expect( [ ...info.exactMarginal ] ).toEqual( [ 0, 0 ] );

	} );

} );
