import { describe, it, expect, vi, afterEach } from 'vitest';
import { DataUtils, HalfFloatType, SRGBColorSpace } from 'three';

const cdf = vi.hoisted( () => ( { mode: 'answer', workers: [] } ) );

vi.mock( '@/core/environment/CDFWorker.js?worker&inline', async () => {

	const { buildExactEnvironmentTable } = await import( '@/core/environment/EnvironmentExactTable.js' );

	return { default: class {

		constructor() {

			this.terminate = vi.fn();
			cdf.workers.push( this );

		}

		postMessage( { floatData, width, height }, transfer ) {

			this.transfer = transfer;
			setTimeout( () => {

				if ( cdf.mode === 'answer' ) this.onmessage( { data: { width, height, ...buildExactEnvironmentTable( floatData, width, height ) } } );
				else if ( cdf.mode === 'fail' ) this.onmessage( { data: { error: 'table failed' } } );
				else if ( cdf.mode === 'crash' ) this.onerror( new Error( 'worker crashed' ) );

			} );

		}

	} };

} );

import { extractFloatData } from '@/core/environment/EquirectHDRInfo.js';
import { EquirectHDRInfo } from '@/core/environment/EquirectHDRInfo.js';
import { buildExactEnvironmentTable, packExactTable } from '@/core/environment/EnvironmentExactTable.js';

const srgbToLinear = c => ( c <= 0.04045 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4 );

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

	it( 'expands half floats', () => {

		const values = [ 0.5, 2, 65504, - 1 ];
		const result = extractFloatData( {
			type: HalfFloatType,
			image: { width: 1, height: 1, data: Uint16Array.from( values, v => DataUtils.toHalfFloat( v ) ) },
		} );
		expect( [ ...result.floatData ] ).toEqual( values );

	} );

	it( 'scales signed integers by their positive range', () => {

		const short = extractFloatData( { type: 0, image: { width: 1, height: 1, data: Int16Array.of( 32767, - 32767, 0, 16384 ) } } );
		expect( [ ...short.floatData ] ).toEqual( [ 1, - 1, 0, Math.fround( 16384 / 32767 ) ] );
		const byte = extractFloatData( { type: 0, image: { width: 1, height: 1, data: Int8Array.of( 127, 0, 0, 127 ) } } );
		expect( byte.floatData[ 0 ] ).toBe( 1 );

	} );

	it( 'decodes an sRGB texture to linear, alpha untouched', () => {

		const data = new Float32Array( [ 0.5, 0.04, 1, 0.5 ] );
		const result = extractFloatData( { type: 1015, colorSpace: SRGBColorSpace, image: { width: 1, height: 1, data } } );
		expect( result.floatData[ 0 ] ).toBeCloseTo( srgbToLinear( 0.5 ), 6 );
		expect( result.floatData[ 1 ] ).toBeCloseTo( 0.04 / 12.92, 6 );
		expect( result.floatData[ 2 ] ).toBeCloseTo( 1, 6 );
		expect( result.floatData[ 3 ] ).toBe( 0.5 );
		expect( data[ 0 ] ).toBe( 0.5 );

	} );

	it( 'draws an image without data to a canvas and decodes it as sRGB', () => {

		const drawn = [];
		vi.stubGlobal( 'OffscreenCanvas', class {

			constructor( width, height ) {

				this.size = [ width, height ];

			}

			getContext() {

				return {
					drawImage: ( image, x, y, w, h ) => drawn.push( [ image, w, h ] ),
					getImageData: () => ( { data: Uint8ClampedArray.of( 255, 128, 0, 255, 0, 0, 0, 0 ) } ),
				};

			}

		} );

		try {

			const bitmap = { width: 2, height: 1 };
			const result = extractFloatData( { type: 1009, image: bitmap } );
			expect( drawn ).toEqual( [[ bitmap, 2, 1 ]] );
			expect( result.floatData[ 0 ] ).toBeCloseTo( 1, 6 );
			expect( result.floatData[ 1 ] ).toBeCloseTo( srgbToLinear( 128 / 255 ), 6 );
			expect( result.floatData[ 3 ] ).toBe( 1 );
			expect( [ ...result.floatData.subarray( 4 ) ] ).toEqual( [ 0, 0, 0, 0 ] );

		} finally {

			vi.unstubAllGlobals();

		}

	} );

} );

describe( 'EquirectHDRInfo', () => {

	const sky = () => {

		const data = new Float32Array( 8 * 4 * 4 );
		for ( let i = 0; i < 8 * 4; i ++ ) data.set( [ 1 + ( i % 5 ), 1, 0.5 + ( i % 3 ), 1 ], i * 4 );
		return { type: 1015, flipY: true, image: { width: 8, height: 4, data } };

	};

	afterEach( () => {

		cdf.mode = 'answer';
		cdf.workers.length = 0;

	} );

	it( 'builds the table on this thread from the unflipped pixels', () => {

		const info = new EquirectHDRInfo();
		const hdr = sky();
		info.updateFrom( hdr );

		const { floatData } = extractFloatData( hdr );
		const expected = buildExactEnvironmentTable( floatData, 8, 4 );
		expect( [ info.width, info.height ] ).toEqual( [ 8, 4 ] );
		expect( info.totalSum ).toBe( expected.radianceIntegral );
		expect( info.totalSum ).toBeGreaterThan( 0 );
		expect( [ ...info.exactMarginal ] ).toEqual( [ ...expected.exactMarginal ] );
		expect( [ ...info.exactConditional ] ).toEqual( [ ...expected.exactConditional ] );

	} );

	it( 'builds the same table in a worker, handing it a copy, and ends the worker', async () => {

		const hdr = sky();
		const main = new EquirectHDRInfo();
		main.updateFrom( hdr );

		const info = new EquirectHDRInfo();
		await info.updateFromAsync( hdr );
		const [ worker ] = cdf.workers;
		expect( worker.transfer[ 0 ] ).not.toBe( hdr.image.data.buffer );
		expect( hdr.image.data.byteLength ).toBe( 8 * 4 * 16 );
		expect( worker.terminate ).toHaveBeenCalledOnce();
		expect( info._worker ).toBeNull();
		expect( [ info.width, info.height, info.totalSum ] ).toEqual( [ 8, 4, main.totalSum ] );
		expect( [ ...info.exactRowGuide ] ).toEqual( [ ...main.exactRowGuide ] );
		expect( [ ...info.exactMarginalGuide ] ).toEqual( [ ...main.exactMarginalGuide ] );

	} );

	it( 'rejects with the worker\'s error or crash, ending the worker either way', async () => {

		const info = new EquirectHDRInfo();
		cdf.mode = 'fail';
		await expect( info.updateFromAsync( sky() ) ).rejects.toThrow( 'table failed' );
		cdf.mode = 'crash';
		await expect( info.updateFromAsync( sky() ) ).rejects.toThrow( 'worker crashed' );
		expect( cdf.workers.map( w => w.terminate.mock.calls.length ) ).toEqual( [ 1, 1 ] );
		expect( info._worker ).toBeNull();
		expect( info.totalSum ).toBe( 0 );

	} );

	it( 'drops its table and ends a build in flight on dispose', async () => {

		const info = new EquirectHDRInfo();
		info.updateFrom( sky() );
		cdf.mode = 'silent';
		info.updateFromAsync( sky() );
		const [ worker ] = cdf.workers;

		info.dispose();
		expect( worker.terminate ).toHaveBeenCalledOnce();
		expect( info._worker ).toBeNull();
		expect( [ info.exactConditional, info.exactMarginal, info.exactRowGuide, info.exactMarginalGuide ] ).toEqual( [ null, null, null, null ] );

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

	// Each guide is the first entry above its step's start, or the last; two steps an entry.
	const checkGuides = ( cdf, offset, n, guide, guideOffset ) => {

		for ( let g = 0; g < 2 * n; g ++ ) {

			const i = guide[ guideOffset + g ];
			expect( i === n - 1 || cdf[ offset + i ] > g / ( 2 * n ) ).toBe( true );
			if ( i > 0 ) expect( cdf[ offset + i - 1 ] ).toBeLessThanOrEqual( g / ( 2 * n ) );

		}

	};

	it( 'spreads a uniform map evenly and guides each step to its entry', () => {

		const t = buildExactEnvironmentTable( image( 8, 4, () => 1 ), 8, 4 );
		expect( [ t.exactWidth, t.exactHeight ] ).toEqual( [ 8, 4 ] );
		for ( let x = 0; x < 8; x ++ ) expect( t.exactConditional[ x ] ).toBeCloseTo( ( x + 1 ) / 8, 6 );
		expect( t.exactMarginal[ 3 ] ).toBe( 1 );
		for ( let y = 0; y < 4; y ++ ) checkGuides( t.exactConditional, y * 8, 8, t.exactRowGuide, 2 * y * 8 );
		checkGuides( t.exactMarginal, 0, 4, t.exactMarginalGuide, 0 );
		expect( t.radianceIntegral ).toBeGreaterThan( 0 );

	} );

	it( 'guides a peaked map, past empty stretches', () => {

		const W = 64, H = 32;
		const t = buildExactEnvironmentTable( image( W, H, ( x, y ) => ( x === 40 && y === 20 ? 1000 : y < 8 ? 0 : 0.1 ) ), W, H );
		for ( let y = 0; y < H; y ++ ) checkGuides( t.exactConditional, y * W, W, t.exactRowGuide, 2 * y * W );
		checkGuides( t.exactMarginal, 0, H, t.exactMarginalGuide, 0 );
		// Most steps land on the sun's row and its neighbours (the filter gives them a share of it).
		const sunRows = [ ...t.exactMarginalGuide ].filter( y => Math.abs( y - 20 ) <= 1 ).length;
		expect( sunRows / ( 2 * H ) ).toBeGreaterThan( 0.9 );

	} );

	it( 'packs running sums and guides as the shader reads them', () => {

		const t = buildExactEnvironmentTable( image( 8, 4, ( x ) => x + 1 ), 8, 4 );
		const { data, width, height } = packExactTable( t );
		expect( [ width, height ] ).toEqual( [ 9, 4 ] );
		const texel = ( x, y ) => [ ...data.subarray( 4 * ( y * 9 + x ), 4 * ( y * 9 + x ) + 4 ) ];
		const i = 2 * 8 + 3;
		expect( texel( 3, 2 ) ).toEqual( [ t.exactConditional[ i ], t.exactConditional[ i - 1 ], t.exactRowGuide[ 2 * i ], t.exactRowGuide[ 2 * i + 1 ] ] );
		expect( texel( 0, 2 )[ 1 ] ).toBe( 0 );
		expect( texel( 8, 1 ) ).toEqual( [ t.exactMarginal[ 1 ], t.exactMarginal[ 0 ], t.exactMarginalGuide[ 2 ], t.exactMarginalGuide[ 3 ] ] );

	} );

	it( 'gives a black map nothing to sample', () => {

		const info = new EquirectHDRInfo();
		info._adopt( buildExactEnvironmentTable( new Float32Array( 2 * 2 * 4 ), 2, 2 ), 2, 2 );
		expect( info.totalSum ).toBe( 0 );
		expect( [ ...info.exactMarginal ] ).toEqual( [ 0, 0 ] );

	} );

} );
