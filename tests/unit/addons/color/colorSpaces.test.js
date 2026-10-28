import { describe, it, expect, beforeEach, vi } from 'vitest';

const ocio = vi.hoisted( () => ( { runtime: null, info: null } ) );

vi.mock( '@/core/addons/color/OcioRuntime.js', () => ( {
	getRuntime: () => ocio.runtime,
	getConfigInfo: () => ocio.info,
} ) );

import {
	convertColor, convertPixelsF32, convertEncodedRGBA8, srgbToLinear, linearToSrgb, applyMatrixRGBA8, extractMatrix,
	isDataSpace, hasColorSpace, clearColorCaches, resetConfigHandle,
} from '@/core/addons/color/ColorSpaces.js';

const WIDEN = [ 0.6, 0.3, 0.1, 0.07, 0.9, 0.03, 0.02, 0.1, 0.88 ];
const TRANSFORMS = {
	'lin_rec709>ACEScg': rgb => [ 0, 3, 6 ].map( r => WIDEN[ r ] * rgb[ 0 ] + WIDEN[ r + 1 ] * rgb[ 1 ] + WIDEN[ r + 2 ] * rgb[ 2 ] ),
	'lin_rec709>log': rgb => rgb.map( v => Math.log2( v + 1 ) ),
	'lin_rec709>double': rgb => rgb.map( v => v * 2 ),
	'lin_rec709>halve': rgb => rgb.map( v => v / 2 ),
};

const processorFor = ( from, to ) => {

	const transform = TRANSFORMS[ `${from}>${to}` ];
	if ( from === 'lin_rec709' && to === 'lin_rec709 alias' ) return { isNoOp: true, dispose: vi.fn() };
	if ( ! transform ) throw new Error( `unknown colour space "${to}"` );
	return {
		isNoOp: false,
		chunks: [],
		dispose: vi.fn(),
		applyRGBAF32( buf ) {

			this.chunks.push( buf.length );
			for ( let i = 0; i < buf.length; i += 4 ) buf.set( transform( [ buf[ i ], buf[ i + 1 ], buf[ i + 2 ] ] ), i );

		},
	};

};

const makeConfig = () => ( { createColorSpaceProcessor: vi.fn( ( from, to ) => processorFor( from, to ) ), dispose: vi.fn() } );

const makeRuntime = ( config = makeConfig() ) => ( {
	config,
	transformRgb: vi.fn( ( from, to, rgb ) => TRANSFORMS[ `${from}>${to}` ]( rgb ) ),
} );

const INFO = {
	id: 'ocio://test-config',
	colorSpaces: [
		{ name: 'lin_rec709', aliases: [ 'Linear Rec.709 (sRGB)' ], isData: false },
		{ name: 'ACEScg', aliases: [], isData: false },
		{ name: 'Raw', aliases: [ 'Utility - Raw' ], isData: true },
	],
};

describe( 'ColorSpaces without a config', () => {

	beforeEach( () => {

		ocio.runtime = null;
		ocio.info = null;
		resetConfigHandle();

	} );

	it( 'leaves every colour and pixel as it is', () => {

		const rgb = [ 0.1, 0.2, 0.3 ];
		const out = convertColor( rgb, 'lin_rec709', 'ACEScg' );
		expect( out ).toEqual( rgb );
		expect( out ).not.toBe( rgb );

		const pixels = Float32Array.of( 0.5, 0.5, 0.5, 1 );
		expect( convertPixelsF32( pixels, 'lin_rec709', 'ACEScg' ) ).toBe( pixels );
		expect( [ ...pixels ] ).toEqual( [ 0.5, 0.5, 0.5, 1 ] );
		const bytes = Uint8Array.of( 10, 20, 30, 40 );
		expect( [ ...convertEncodedRGBA8( bytes, 'lin_rec709', 'ACEScg' ) ] ).toEqual( [ 10, 20, 30, 40 ] );

		expect( extractMatrix( 'lin_rec709', 'ACEScg' ) ).toBeNull();
		expect( isDataSpace( 'Raw' ) ).toBe( false );
		expect( hasColorSpace( 'ACEScg' ) ).toBe( false );

	} );

} );

describe( 'ColorSpaces', () => {

	let runtime;

	beforeEach( () => {

		runtime = makeRuntime();
		ocio.runtime = runtime;
		ocio.info = INFO;
		resetConfigHandle();

	} );

	it( 'converts a colour once per colour, context and pair, handing back copies', () => {

		const first = convertColor( [ 1, 1, 1 ], 'lin_rec709', 'double' );
		expect( first ).toEqual( [ 2, 2, 2 ] );
		first[ 0 ] = 99;
		expect( convertColor( [ 1, 1, 1 ], 'lin_rec709', 'double' ) ).toEqual( [ 2, 2, 2 ] );
		expect( runtime.transformRgb ).toHaveBeenCalledOnce();

		convertColor( Float32Array.of( 1, 1, 1 ), 'lin_rec709', 'double', { context: { SHOT: 'a' } } );
		expect( runtime.transformRgb ).toHaveBeenLastCalledWith( 'lin_rec709', 'double', [ 1, 1, 1 ], { context: { SHOT: 'a' } } );
		convertColor( [ 1, 1, 1 ], 'lin_rec709', 'halve' );
		expect( runtime.transformRgb ).toHaveBeenCalledTimes( 3 );

		expect( convertColor( [ 0.3, 0.2, 0.1 ], 'ACEScg', 'ACEScg' ) ).toEqual( [ 0.3, 0.2, 0.1 ] );
		expect( runtime.transformRgb ).toHaveBeenCalledTimes( 3 );

	} );

	it( 'forgets cached colours past its limit, and when cleared', () => {

		convertColor( [ 0, 0, 0 ], 'lin_rec709', 'double' );
		for ( let i = 1; i <= 4096; i ++ ) convertColor( [ i, 0, 0 ], 'lin_rec709', 'double' );
		const calls = runtime.transformRgb.mock.calls.length;
		convertColor( [ 4096, 0, 0 ], 'lin_rec709', 'double' );
		expect( runtime.transformRgb ).toHaveBeenCalledTimes( calls );
		convertColor( [ 0, 0, 0 ], 'lin_rec709', 'double' );
		expect( runtime.transformRgb ).toHaveBeenCalledTimes( calls + 1 );

		clearColorCaches();
		convertColor( [ 4096, 0, 0 ], 'lin_rec709', 'double' );
		expect( runtime.transformRgb ).toHaveBeenCalledTimes( calls + 2 );

	} );

	it( 'converts float pixels in place, alpha untouched, building each processor once', () => {

		const pixels = Float32Array.of( 1, 2, 3, 0.25, 4, 5, 6, 0.75 );
		expect( convertPixelsF32( pixels, 'lin_rec709', 'double' ) ).toBe( pixels );
		expect( [ ...pixels ] ).toEqual( [ 2, 4, 6, 0.25, 8, 10, 12, 0.75 ] );
		convertPixelsF32( pixels, 'lin_rec709', 'double' );
		expect( runtime.config.createColorSpaceProcessor ).toHaveBeenCalledOnce();

		expect( () => convertPixelsF32( new Float32Array( 6 ), 'lin_rec709', 'double' ) ).toThrow( '4 floats per pixel' );
		expect( convertPixelsF32( pixels, 'ACEScg', 'ACEScg' ) ).toBe( pixels );
		expect( pixels[ 0 ] ).toBe( 4 );

	} );

	it( 'converts a large buffer a million pixels at a time, every pixel included', () => {

		const pixels = new Float32Array( ( ( 1 << 20 ) + 2 ) * 4 ).fill( 1 );
		convertPixelsF32( pixels, 'lin_rec709', 'double' );
		const [ processor ] = runtime.config.createColorSpaceProcessor.mock.results.map( r => r.value );
		expect( processor.chunks ).toEqual( [ ( 1 << 20 ) * 4, 8 ] );
		expect( [ pixels[ 0 ], pixels[ 3 ], pixels.at( - 4 ), pixels.at( - 1 ) ] ).toEqual( [ 2, 1, 2, 1 ] );

	} );

	it( 'drops a processor that does nothing, remembers that, and clears it', () => {

		const pixels = Float32Array.of( 0.5, 0.5, 0.5, 1 );
		convertPixelsF32( pixels, 'lin_rec709', 'lin_rec709 alias' );
		convertPixelsF32( pixels, 'lin_rec709', 'lin_rec709 alias' );
		expect( [ ...pixels ] ).toEqual( [ 0.5, 0.5, 0.5, 1 ] );
		const [ noOp ] = runtime.config.createColorSpaceProcessor.mock.results.map( r => r.value );
		expect( noOp.dispose ).toHaveBeenCalledOnce();
		expect( runtime.config.createColorSpaceProcessor ).toHaveBeenCalledOnce();
		expect( extractMatrix( 'lin_rec709', 'lin_rec709 alias' ) ).toEqual( [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ] );

		expect( () => clearColorCaches() ).not.toThrow();
		convertPixelsF32( pixels, 'lin_rec709', 'lin_rec709 alias' );
		expect( runtime.config.createColorSpaceProcessor ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'says which transform it could not build', () => {

		expect( () => convertPixelsF32( new Float32Array( 4 ), 'lin_rec709', 'nowhere' ) ).toThrow( 'no OCIO transform from "lin_rec709" to "nowhere": unknown colour space "nowhere"' );

	} );

	it( 'disposes cached processors when cleared, and builds them again', () => {

		convertPixelsF32( new Float32Array( 4 ), 'lin_rec709', 'double' );
		const [ processor ] = runtime.config.createColorSpaceProcessor.mock.results.map( r => r.value );
		clearColorCaches();
		expect( processor.dispose ).toHaveBeenCalledOnce();
		convertPixelsF32( new Float32Array( 4 ), 'lin_rec709', 'double' );
		expect( runtime.config.createColorSpaceProcessor ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'converts 8-bit pixels through float, decoding and encoding as told', () => {

		const raw = convertEncodedRGBA8( Uint8Array.of( 51, 102, 0, 7 ), 'lin_rec709', 'halve' );
		expect( [ raw[ 0 ], raw[ 1 ], raw[ 2 ], raw[ 3 ] ] ).toEqual( [
			Math.round( linearToSrgb( 0.1 ) * 255 ), Math.round( linearToSrgb( 0.2 ) * 255 ), 0, 7,
		] );

		const linear = convertEncodedRGBA8( Uint8Array.of( 200, 255, 0, 9 ), 'lin_rec709', 'halve', { inputEncoding: 'linear', outputEncoding: 'linear' } );
		expect( [ ...linear ] ).toEqual( [ 100, 128, 0, 9 ] );

		const decoded = convertEncodedRGBA8( Uint8Array.of( 128, 255, 10, 1 ), 'lin_rec709', 'double', { inputEncoding: 'srgb', outputEncoding: 'linear' } );
		expect( [ ...decoded ] ).toEqual( [ Math.round( 2 * srgbToLinear( 128 / 255 ) * 255 ), 255, Math.round( 2 * srgbToLinear( 10 / 255 ) * 255 ), 1 ] );

		expect( () => convertEncodedRGBA8( new Uint8Array( 3 ), 'lin_rec709', 'halve' ) ).toThrow( '4 bytes per pixel' );
		const same = Uint8Array.of( 1, 2, 3, 4 );
		expect( convertEncodedRGBA8( same, 'ACEScg', 'ACEScg' ) ).toBe( same );

	} );

	it( 'converts a large 8-bit texture in chunks, the last one short', () => {

		const bytes = new Uint8Array( ( ( 1 << 20 ) + 1 ) * 4 ).fill( 200 );
		convertEncodedRGBA8( bytes, 'lin_rec709', 'halve', { inputEncoding: 'linear', outputEncoding: 'linear' } );
		const [ processor ] = runtime.config.createColorSpaceProcessor.mock.results.map( r => r.value );
		expect( processor.chunks ).toEqual( [ ( 1 << 20 ) * 4, 4 ] );
		expect( [ bytes[ 0 ], bytes[ 3 ], bytes.at( - 4 ), bytes.at( - 1 ) ] ).toEqual( [ 100, 200, 100, 200 ] );

	} );

	it( 'finds the matrix of a primaries change, and none for a curve', () => {

		const m = extractMatrix( 'lin_rec709', 'ACEScg' );
		m.forEach( ( v, i ) => expect( v ).toBeCloseTo( WIDEN[ i ], 6 ) );
		expect( extractMatrix( 'lin_rec709', 'log' ) ).toBeNull();
		expect( extractMatrix( 'ACEScg', 'ACEScg' ) ).toEqual( [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ] );

		const processors = runtime.config.createColorSpaceProcessor.mock.results.map( r => r.value );
		const applied = processors.map( p => p.chunks.length );
		expect( extractMatrix( 'lin_rec709', 'ACEScg' ) ).toBe( m );
		expect( extractMatrix( 'lin_rec709', 'log' ) ).toBeNull();
		expect( processors.map( p => p.chunks.length ) ).toEqual( applied );

	} );

	it( 'tells data spaces and known names apart, aliases included', () => {

		expect( isDataSpace( 'Raw' ) ).toBe( true );
		expect( isDataSpace( 'Utility - Raw' ) ).toBe( true );
		expect( isDataSpace( 'ACEScg' ) ).toBe( false );
		expect( isDataSpace( 'Unknown' ) ).toBe( false );
		expect( hasColorSpace( 'Linear Rec.709 (sRGB)' ) ).toBe( true );
		expect( hasColorSpace( 'Unknown' ) ).toBe( false );
		expect( hasColorSpace( '' ) ).toBe( false );

	} );

} );

describe( 'ColorSpaces on a runtime without a Config handle', () => {

	let builtins;

	beforeEach( () => {

		builtins = [];
		ocio.runtime = {
			ocio: { createBuiltinConfig: vi.fn( id => {

				const config = { ...makeConfig(), id };
				builtins.push( config );
				return config;

			} ) },
		};
		ocio.info = { ...INFO, id: 'ocio://test-config' };
		resetConfigHandle();

	} );

	it( 'builds the built-in config once, and releases it when the config changes or is reset', () => {

		convertPixelsF32( new Float32Array( 4 ), 'lin_rec709', 'double' );
		convertPixelsF32( new Float32Array( 4 ), 'lin_rec709', 'halve' );
		expect( builtins.map( c => c.id ) ).toEqual( [ 'ocio://test-config' ] );

		ocio.info = { ...INFO, id: 'ocio://other-config' };
		convertPixelsF32( new Float32Array( 4 ), 'lin_rec709', 'ACEScg' );
		expect( builtins.map( c => c.id ) ).toEqual( [ 'ocio://test-config', 'ocio://other-config' ] );
		expect( builtins[ 0 ].dispose ).toHaveBeenCalledOnce();

		resetConfigHandle();
		expect( builtins[ 1 ].dispose ).toHaveBeenCalledOnce();

	} );

	it( 'cannot convert a config it has no handle for', () => {

		ocio.info = { ...INFO, id: 'file:///studio/config.ocio' };
		expect( () => convertPixelsF32( new Float32Array( 4 ), 'lin_rec709', 'double' ) ).toThrow( 'OCIO runtime exposes no Config handle for this config' );

	} );

	it( 'never disposes the runtime\'s own handle', () => {

		const config = makeConfig();
		ocio.runtime = makeRuntime( config );
		convertPixelsF32( new Float32Array( 4 ), 'lin_rec709', 'double' );
		resetConfigHandle();
		expect( config.dispose ).not.toHaveBeenCalled();

	} );

} );

describe( 'sRGB transfer', () => {

	it( 'decodes and encodes the IEC curve, both segments', () => {

		expect( srgbToLinear( 0 ) ).toBe( 0 );
		expect( srgbToLinear( 1 ) ).toBeCloseTo( 1, 12 );
		expect( srgbToLinear( 0.04 ) ).toBeCloseTo( 0.04 / 12.92, 12 );
		expect( srgbToLinear( 0.5 ) ).toBeCloseTo( 0.214041, 6 );
		expect( linearToSrgb( - 1 ) ).toBe( 0 );
		expect( linearToSrgb( 0.001 ) ).toBeCloseTo( 0.01292, 12 );
		for ( const v of [ 0.002, 0.18, 0.5, 0.9 ] ) expect( srgbToLinear( linearToSrgb( v ) ) ).toBeCloseTo( v, 10 );

	} );

	it( 'applies a matrix to 8-bit pixels in either encoding, clamped', () => {

		const SWAP_RG = [ 0, 1, 0, 1, 0, 0, 0, 0, 1 ];
		const linear = applyMatrixRGBA8( Uint8Array.of( 10, 200, 30, 77 ), SWAP_RG, 'linear' );
		expect( [ ...linear ] ).toEqual( [ 200, 10, 30, 77 ] );

		const clamped = applyMatrixRGBA8( Uint8Array.of( 200, 100, 50, 1 ), [ 2, 0, 0, 0, - 1, 0, 0, 0, 1 ], 'linear' );
		expect( [ ...clamped ] ).toEqual( [ 255, 0, 50, 1 ] );

		const srgb = applyMatrixRGBA8( Uint8Array.from( { length: 256 * 4 }, ( _, i ) => ( i % 4 === 3 ? 255 : i >> 2 ) ), SWAP_RG );
		for ( let b = 0; b < 256; b ++ ) for ( let c = 0; c < 3; c ++ ) expect( Math.abs( srgb[ b * 4 + c ] - b ) ).toBeLessThanOrEqual( 1 );
		expect( srgb[ 255 * 4 ] ).toBe( 255 );
		expect( srgb[ 0 ] ).toBe( 0 );

		const untouched = Uint8Array.of( 1, 2, 3, 4 );
		expect( applyMatrixRGBA8( untouched, null ) ).toBe( untouched );
		expect( [ ...untouched ] ).toEqual( [ 1, 2, 3, 4 ] );

	} );

} );
