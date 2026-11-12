/**
 * The pbrt texture baker's fast paths give what the plain arithmetic gives, byte for byte: the sRGB byte from a table,
 * an image's own texels read directly when a bake runs at its size, the layer loops for bytes through a table, and a
 * one-channel map's bytes worked out once a value.
 */
import { describe, it, expect } from 'vitest';
import { makeLayer, mixOf, productOf, srgbByte, linearToSRGB, srgbToLinear, planBake, bakeRows, bakeResult, combineOf } from '@/core/addons/archives/pbrt/PBRTTextureBake.js';

// A whole bake on this thread, as the scene builder runs one.
function bake( terms, combine, options = {} ) {

	const plan = planBake( terms );
	if ( ! plan ) return null;
	const data = new Uint8Array( plan.width * plan.height * 4 );
	bakeRows( plan, combine, options, 0, plan.height, data );
	return bakeResult( plan, data );

}

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

	it( 'works a one-channel map out once a value, byte for byte as texel by texel', () => {

		const w = 64, h = 48, ramp = Float32Array.from( { length: 256 }, ( _, b ) => srgbToLinear( b / 255 ) * 1.2 );
		const data = Float32Array.from( { length: w * h }, () => ramp[ Math.floor( rand() * 256 ) ] );
		[ NaN, - 0, 0, Infinity, - Infinity, 3.5, - 0.25 ].forEach( ( v, k ) => {

			data[ 17 * k + 5 ] = v;

		} );
		const layer = { width: w, height: h, channels: 1, data, su: 1, sv: 1, du: 0, dv: 0, uv: null };
		const other = { ...layer, data: data.map( () => rand() ) };
		let calls = 0;
		const combine = ( [ a, b, c ] ) => {

			calls ++;
			return [ 0, 1, 2 ].map( ( k ) => Math.sqrt( Math.max( 0, a[ k ] ) ) * 0.7 + b[ k ] * c[ k ] );

		};

		const alphaOf = ( [ a ] ) => 1 - a[ 0 ];
		const terms = ( second ) => [ { layer }, { layer: second, tint: [ 0.5, 2, 1 ], clamp: true }, { rgb: [ 0.25, 0.5, 1 ] } ];
		const expected = ( second, linear ) => {

			const out = new Uint8Array( w * h * 4 );
			for ( let j = 0; j < h; j ++ ) for ( let i = 0; i < w; i ++ ) {

				const at = ( h - 1 - j ) * w + i, a = data[ at ], b = second.data[ at ];
				const tinted = [ 0.5, 2, 1 ].map( ( t ) => Math.min( 1, Math.max( 0, b * t ) ) );
				const rgb = combine( [[ a, a, a ], tinted, [ 0.25, 0.5, 1 ]] );
				for ( let c = 0; c < 3; c ++ ) {

					const v = Math.min( 1, Math.max( 0, rgb[ c ] ) );
					out[ ( j * w + i ) * 4 + c ] = linear ? Math.round( 255 * v ) : srgbByte( v );

				}

				out[ ( j * w + i ) * 4 + 3 ] = Math.round( 255 * Math.min( 1, Math.max( 0, 1 - a ) ) );

			}

			return out;

		};

		for ( const linear of [ true, false ] ) {

			const want = expected( layer, linear );
			calls = 0;
			expect( bake( terms( layer ), combine, { alphaOf, linear } ).data ).toEqual( want );
			expect( calls ).toBeLessThanOrEqual( 256 + 7 );

		}

		// Another image in the same uv set: each texel is worked out.
		const want = expected( other, true );
		calls = 0;
		expect( bake( terms( other ), combine, { alphaOf, linear: true } ).data ).toEqual( want );
		expect( calls ).toBe( w * h );

	} );

	it( 'works out a float map with more values than it keeps, and one resampled past the bake size, texel by texel', () => {

		const w = 600, h = 500, data = Float32Array.from( { length: w * h }, () => rand() );
		const layer = { width: w, height: h, channels: 1, data, su: 1, sv: 1, du: 0, dv: 0, uv: null };
		const baked = bake( [ { layer } ], ( [ v ] ) => v, { linear: true } ).data;
		for ( let j = 0; j < h; j ++ ) for ( let i = 0; i < w; i ++ ) {

			const want = Math.round( 255 * data[ ( h - 1 - j ) * w + i ] );
			if ( baked[ ( j * w + i ) * 4 ] !== want ) expect( baked[ ( j * w + i ) * 4 ], `${i}, ${j}` ).toBe( want );

		}

		// 4,097 texels wide bakes at 4,096: each texel is a blend of two, never a copy of one.
		const wide = { width: 4097, height: 1, channels: 1, data: Float32Array.from( { length: 4097 }, ( _, i ) => ( i % 7 ) / 6 ), su: 1, sv: 1, du: 0, dv: 0, uv: null };
		const resampled = bake( [ { layer: wide } ], ( [ v ] ) => v, { linear: true } );
		expect( resampled.width ).toBe( 4096 );
		for ( let i = 0; i < 4096; i ++ ) {

			const x = ( i + 0.5 ) / 4096 * 4097 - 0.5, x0 = Math.floor( x ), fx = x - x0;
			const d = wide.data, a = d[ ( x0 + 4097 ) % 4097 ], b = d[ ( x0 + 1 ) % 4097 ];
			const v = ( a * ( 1 - fx ) + b * fx ) * 1 + ( a * ( 1 - fx ) + b * fx ) * 0;
			expect( resampled.data[ i * 4 ], `${i}` ).toBe( Math.round( 255 * Math.min( 1, Math.max( 0, v ) ) ) );

		}

	} );

	it( 'works a colour image out once a value a channel when the combine goes channel by channel', () => {

		const w = 64, h = 48;
		const layer = makeLayer( { data: bytes( w * h * 4 ), width: w, height: h }, { channels: 3, decode: srgbToLinear, scale: 1.3 } );
		[ NaN, - 0, Infinity, - 0.5 ].forEach( ( v, k ) => {

			layer.data[ 29 * k + 4 ] = v;

		} );
		let calls = 0;
		const counted = ( values ) => {

			calls ++;
			return mixOf( values );

		};

		const terms = [ { layer, tint: [ 0.9, 1.1, 1 ], clamp: true }, { rgb: [ 0.2, 0.4, 0.8 ] }, { rgb: [ 0.3, 0.3, 0.3 ] } ];
		for ( const linear of [ false, true ] ) {

			const plain = bake( terms, mixOf, { linear } ).data;
			calls = 0;
			expect( bake( terms, counted, { linear, perChannel: true } ).data ).toEqual( plain );
			expect( calls ).toBeLessThan( w * h / 2 );

		}

		// Not without the promise, nor with an alpha channel.
		calls = 0;
		bake( terms, counted, {} );
		expect( calls ).toBe( w * h );
		calls = 0;
		const withAlpha = bake( terms, counted, { perChannel: true, alphaOf: ( [ a ] ) => a[ 0 ] } );
		expect( calls ).toBe( w * h );
		expect( withAlpha.data ).toEqual( bake( terms, mixOf, { alphaOf: ( [ a ] ) => a[ 0 ] } ).data );

	} );

} );

describe( 'a bake split into bands of rows (its workers)', () => {

	let seed = 3;
	const rnd = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
	const image = ( width, height ) => ( { width, height, data: Uint8Array.from( { length: width * height * 4 }, ( _, i ) => ( i & 3 ) === 3 ? ( rnd() < 0.3 ? rnd() * 256 : 255 ) : rnd() * 256 ) } );
	const layer = ( w, h, channels, mapping = null ) => makeLayer( image( w, h ), { channels, decode: srgbToLinear, mapping } );

	const cases = [
		[ 'two images mixed', () => [ { layer: layer( 37, 29, 3 ), clamp: true }, { rgb: [ 0.2, 0.7, 0.1 ], clamp: true }, { layer: layer( 53, 41, 1 ) } ], { op: 'mix' }, {} ],
		[ 'a product, mapped', () => [ { layer: layer( 40, 31, 3, { su: 2, sv: 1.5, du: 0.1, dv: 0.3 } ) }, { layer: layer( 19, 23, 1 ) } ], { op: 'product' }, {} ],
		[ 'alpha from a second image', () => [ { layer: layer( 33, 27, 3 ) }, { layer: layer( 21, 17, 1 ) } ], { op: 'first' }, { alphaOf: { op: 'channel', term: 1 } } ],
		[ 'one colour image, channel by channel (memo)', () => [ { layer: layer( 45, 38, 3 ), clamp: true } ], { op: 'first' }, { perChannel: true } ],
		[ 'one float image stretched (memo)', () => [ { layer: layer( 39, 33, 1 ) } ], { op: 'stretch', low: 0.05, high: 0.9 }, { linear: true } ],
		[ 'roughness from two images', () => [ { layer: layer( 30, 26, 1 ) }, { layer: layer( 17, 13, 1 ) } ], { op: 'scalars', fn: 'roughness', count: 2 }, { linear: true } ],
		[ 'remapped roughness', () => [ { layer: layer( 28, 22, 1 ) } ], { op: 'scalars', fn: 'remapped roughness', count: 1 }, { linear: true } ],
	];

	for ( const [ name, terms, spec, options ] of cases ) {

		it( `writes the bytes of one pass: ${name}`, () => {

			const plan = planBake( terms() );
			const opts = { ...options, alphaOf: options.alphaOf ? combineOf( options.alphaOf ) : null };
			const whole = new Uint8Array( plan.width * plan.height * 4 );
			bakeRows( plan, combineOf( spec ), opts, 0, plan.height, whole );

			// Each band in a buffer of its own, as a worker bakes it.
			const banded = new Uint8Array( whole.length );
			const rows = Math.ceil( plan.height / 5 );
			for ( let j0 = 0; j0 < plan.height; j0 += rows ) {

				const j1 = Math.min( plan.height, j0 + rows );
				const band = new Uint8Array( ( j1 - j0 ) * plan.width * 4 );
				bakeRows( plan, combineOf( spec ), opts, j0, j1, band, j0 );
				banded.set( band, j0 * plan.width * 4 );

			}

			expect( Buffer.compare( Buffer.from( banded ), Buffer.from( whole ) ) ).toBe( 0 );

		} );

	}

	it( 'names each combine with the arithmetic of the function it stands for', () => {

		const v = () => [ rnd() * 2 - 0.5, rnd(), rnd() * 3 ];
		for ( let k = 0; k < 200; k ++ ) {

			const values = [ v(), v(), v() ];
			expect( combineOf( { op: 'mix' } )( values ) ).toEqual( mixOf( values ) );
			expect( combineOf( { op: 'product' } )( values ) ).toEqual( productOf( values ) );
			expect( combineOf( { op: 'first' } )( values ) ).toBe( values[ 0 ] );
			expect( combineOf( { op: 'channel', term: 1 } )( values ) ).toBe( values[ 1 ][ 0 ] );
			expect( combineOf( { op: 'stretch', low: 0.2, high: 0.7 } )( values ) ).toEqual( values[ 0 ].map( ( x ) => ( x - 0.2 ) / ( 0.7 - 0.2 ) ) );
			const alpha = ( remap ) => ( r ) => ( remap ? Math.sqrt( Math.max( r, 0 ) ) : Math.max( r, 0 ) );
			for ( const remap of [ false, true ] ) {

				const scalars = values.map( ( x ) => x[ 0 ] );
				const expected = Math.sqrt( scalars.reduce( ( sum, r ) => sum + alpha( remap )( r ), 0 ) / scalars.length );
				expect( combineOf( { op: 'scalars', fn: remap ? 'remapped roughness' : 'roughness', count: 3 } )( values ) ).toEqual( [ expected, expected, expected ] );

			}

		}

		expect( combineOf( { op: 'scalars', fn: 'unknown', count: 1 } ) ).toBeNull();
		expect( combineOf( { op: 'nothing' } ) ).toBeNull();

	} );

} );
