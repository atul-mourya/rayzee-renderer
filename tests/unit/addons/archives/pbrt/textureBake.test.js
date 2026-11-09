/**
 * The pbrt texture baker's fast paths give what the plain arithmetic gives, byte for byte: the sRGB byte from a table,
 * an image's own texels read directly when a bake runs at its size, and the layer loops for bytes through a table.
 */
import { describe, it, expect } from 'vitest';
import { bake, makeLayer, srgbByte, linearToSRGB, srgbToLinear } from '@/core/addons/archives/pbrt/PBRTTextureBake.js';

let seed = 11;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
const bytes = ( n ) => Uint8Array.from( { length: n }, () => Math.floor( rand() * 256 ) );

describe( 'the pbrt texture baker', () => {

	it( 'encodes sRGB bytes as Math.round( 255 · linearToSRGB( v ) ) does', () => {

		const f = ( v ) => Math.round( 255 * linearToSRGB( v ) );
		const one = new Float32Array( 1 ), bits = new Uint32Array( one.buffer );
		let checked = 0;
		for ( let b = 0; ; b += 257 ) {

			bits[ 0 ] = b;
			if ( one[ 0 ] > 1 ) break;
			expect( srgbByte( one[ 0 ] ) ).toBe( f( one[ 0 ] ) );
			checked ++;

		}

		for ( let i = 0; i < 100000; i ++ ) {

			const v = rand();
			if ( srgbByte( v ) !== f( v ) ) expect( srgbByte( v ), `${v}` ).toBe( f( v ) );

		}

		expect( [ srgbByte( 0 ), srgbByte( 1 ), srgbByte( - 0.5 ), srgbByte( 2 ), srgbByte( NaN ), checked > 4e6 ] ).toEqual( [ 0, 255, 0, 255, 0, true ] );

	} );

	it( 'reads bytes through the table as the arithmetic does: channel for channel, grey from three, alpha, bottom up', () => {

		const w = 7, h = 5;
		const rgba = { data: bytes( w * h * 4 ), width: w, height: h };
		const opaque = { data: rgba.data.map( ( v, i ) => ( i % 4 === 3 ? 255 : v ) ), width: w, height: h, topDown: false };
		const at = ( p, x, y ) => ( ( p.topDown === false ? h - 1 - y : y ) * w + x ) * 4;
		const expectLayer = ( layer, value ) => {

			for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) for ( let c = 0; c < layer.channels; c ++ ) {

				expect( layer.data[ ( y * w + x ) * layer.channels + c ] ).toBe( Math.fround( value( x, y, c ) ) );

			}

		};

		expectLayer( makeLayer( rgba, { channels: 3, decode: srgbToLinear, scale: 2 } ), ( x, y, c ) => 2 * srgbToLinear( rgba.data[ at( rgba, x, y ) + c ] / 255 ) );
		expectLayer( makeLayer( opaque, { channels: 1, decode: srgbToLinear } ), ( x, y ) => {

			const i = at( opaque, x, y ), d = ( k ) => srgbToLinear( opaque.data[ i + k ] / 255 );
			return ( d( 0 ) + d( 1 ) + d( 2 ) ) / 3;

		} );

		expectLayer( makeLayer( rgba, { channels: 1, decode: ( v ) => v } ), ( x, y ) => rgba.data[ at( rgba, x, y ) + 3 ] / 255 );

	} );

	it( 'bakes an image at its own size from its own texels, tinted and clamped, in sRGB or linear bytes', () => {

		const w = 9, h = 6;
		const layer = makeLayer( { data: bytes( w * h * 4 ), width: w, height: h }, { channels: 3, decode: srgbToLinear } );
		const tint = [ 1.5, 0.5, 1 ];
		for ( const linear of [ false, true ] ) {

			const baked = bake( [ { layer, tint, clamp: true } ], ( [ v ] ) => v, { linear } );
			for ( let j = 0; j < h; j ++ ) for ( let i = 0; i < w; i ++ ) for ( let c = 0; c < 3; c ++ ) {

				// Bake rows run bottom up; the layer's top down.
				const v = Math.min( 1, Math.max( 0, layer.data[ ( ( h - 1 - j ) * w + i ) * 3 + c ] * tint[ c ] ) );
				expect( baked.data[ ( j * w + i ) * 4 + c ] ).toBe( Math.round( 255 * ( linear ? v : linearToSRGB( v ) ) ) );

			}

		}

	} );

	it( 'bakes a float map at its own size from its texels: a tie rounds as the texel says, an infinite texel stays alone', () => {

		// One channel, as a float texture's layer: 0.5 is a tie in linear bytes (127.5 → 128).
		const layer = { width: 11, height: 1, channels: 1, data: Float32Array.from( { length: 11 }, ( _, i ) => ( i === 7 ? 0.5 : i === 3 ? Infinity : 0.3 ) ), su: 1, sv: 1, du: 0, dv: 0, uv: null };
		const linear = bake( [ { layer } ], ( [ v ] ) => v, { linear: true } ).data;
		expect( [ linear[ 7 * 4 ], linear[ 3 * 4 ], linear[ 2 * 4 ], linear[ 4 * 4 ] ] ).toEqual( [ 128, 255, 77, 77 ] );

	} );

} );
