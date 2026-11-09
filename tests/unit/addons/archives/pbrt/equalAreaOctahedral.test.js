import { describe, it, expect } from 'vitest';
import { equalAreaSphereToSquare, octahedralToEquirect } from '@/core/addons/archives/pbrt/EqualAreaOctahedral.js';
import { invert } from '@/core/addons/archives/pbrt/PBRTMath.js';

/**
 * pbrt-v4 `EqualAreaSquareToSphere` — the forward map, transcribed here purely so the
 * inverse the loader ships can be round-tripped against it.
 */
function equalAreaSquareToSphere( px, py ) {

	const u = 2 * px - 1, v = 2 * py - 1;
	const up = Math.abs( u ), vp = Math.abs( v );

	const signedDistance = 1 - ( up + vp );
	const d = Math.abs( signedDistance );
	const r = 1 - d;

	const phi = ( r === 0 ? 1 : ( vp - up ) / r + 1 ) * Math.PI / 4;
	const z = Math.sign( signedDistance || 1 ) * ( 1 - r * r );

	const cosPhi = Math.sign( u || 1 ) * Math.cos( phi );
	const sinPhi = Math.sign( v || 1 ) * Math.sin( phi );
	const s = r * Math.sqrt( Math.max( 0, 2 - r * r ) );

	return [ cosPhi * s, sinPhi * s, z ];

}

describe( 'equal-area octahedral mapping', () => {

	it( 'inverts pbrt\'s square-to-sphere map', () => {

		let worst = 0;
		for ( let i = 0; i < 2000; i ++ ) {

			// Deterministic spread over the square, avoiding exact edges.
			const px = ( ( i * 0.6180339887 ) % 1 ) * 0.98 + 0.01;
			const py = ( ( i * 0.3819660113 ) % 1 ) * 0.98 + 0.01;

			const [ dx, dy, dz ] = equalAreaSquareToSphere( px, py );
			const [ su, sv ] = equalAreaSphereToSquare( dx, dy, dz );
			worst = Math.max( worst, Math.abs( su - px ), Math.abs( sv - py ) );

		}

		expect( worst ).toBeLessThan( 1e-6 );

	} );

	it( 'maps the square centre to +z and the corners to -z', () => {

		// pbrt fills the centre diamond with the +z hemisphere; the corners are -z.
		expect( equalAreaSphereToSquare( 0, 0, 1 ) ).toEqual( [ 0.5, 0.5 ] );

		const corner = equalAreaSphereToSquare( 0, 0, - 1 );
		expect( Math.abs( corner[ 0 ] - 0.5 ) ).toBeCloseTo( 0.5, 6 );
		expect( Math.abs( corner[ 1 ] - 0.5 ) ).toBeCloseTo( 0.5, 6 );

	} );

	it( 'resamples a hemisphere-tagged map into the right half of an equirect', () => {

		// Source: +z hemisphere (centre diamond) bright, -z hemisphere (corners) black.
		const n = 64;
		const data = new Float32Array( n * n * 3 );
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const [ , , dz ] = equalAreaSquareToSphere( ( i + 0.5 ) / n, ( j + 0.5 ) / n );
			const value = dz > 0 ? 1 : 0;
			const o = ( j * n + i ) * 3;
			data[ o ] = data[ o + 1 ] = data[ o + 2 ] = value;

		}

		// Identity light transform: the engine's equirect +z is the horizon at u = 0.75.
		const { data: out, width, height } = octahedralToEquirect(
			{ data, width: n, height: n, channels: 3 }, null, 1, 64
		);
		expect( [ width, height ] ).toEqual( [ 64, 32 ] );

		// Row index is the engine's v axis directly (Environment.js samples texture(uv)).
		const at = ( u, v ) => {

			const i = Math.min( width - 1, Math.floor( u * width ) );
			const j = Math.min( height - 1, Math.floor( v * height ) );
			return out[ ( j * width + i ) * 4 ];

		};

		// u = 0.75 looks toward +z (bright hemisphere), u = 0.25 toward -z (dark).
		expect( at( 0.75, 0.5 ) ).toBeGreaterThan( 0.9 );
		expect( at( 0.25, 0.5 ) ).toBeLessThan( 0.1 );

	} );

	it( 'puts "up" at v = 1, the row the engine samples for +y', () => {

		// Source bright over the +y half of the sphere; identity transform, so light +y
		// is world +y. An inverted row order flips the sky and nothing else complains.
		const n = 64;
		const data = new Float32Array( n * n * 3 );
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const [ , dy ] = equalAreaSquareToSphere( ( i + 0.5 ) / n, ( j + 0.5 ) / n );
			const o = ( j * n + i ) * 3;
			data[ o ] = data[ o + 1 ] = data[ o + 2 ] = dy > 0 ? 1 : 0;

		}

		const { data: out, width, height } = octahedralToEquirect(
			{ data, width: n, height: n, channels: 3 }, null, 1, 64
		);

		const rowAvg = j => {

			let sum = 0;
			for ( let i = 0; i < width; i ++ ) sum += out[ ( j * width + i ) * 4 ];
			return sum / width;

		};

		expect( rowAvg( height - 1 ) ).toBeGreaterThan( 0.9 ); // v = 1 → up → bright
		expect( rowAvg( 0 ) ).toBeLessThan( 0.1 ); // v = 0 → down → dark

	} );

	it( 'reads a bottom-up source the other way up', () => {

		// Same hemisphere tag as above, but the caller says row 0 is the image bottom.
		// Reading it top-down instead rotates the result 180 degrees about the light z axis.
		const n = 64;
		const topDown = new Float32Array( n * n * 3 );
		const bottomUp = new Float32Array( n * n * 3 );
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const [ , dy ] = equalAreaSquareToSphere( ( i + 0.5 ) / n, ( j + 0.5 ) / n );
			const value = dy > 0 ? 1 : 0;
			topDown[ ( j * n + i ) * 3 ] = value;
			bottomUp[ ( ( n - 1 - j ) * n + i ) * 3 ] = value;

		}

		const a = octahedralToEquirect( { data: topDown, width: n, height: n, channels: 3 }, null, 1, 64 );
		const b = octahedralToEquirect(
			{ data: bottomUp, width: n, height: n, channels: 3, bottomUp: true }, null, 1, 64
		);

		let worst = 0;
		for ( let i = 0; i < a.data.length; i += 4 ) worst = Math.max( worst, Math.abs( a.data[ i ] - b.data[ i ] ) );
		expect( worst ).toBeLessThan( 1e-6 );

	} );

	it( 'bakes the light scale into the output', () => {

		const n = 8;
		const data = new Float32Array( n * n * 3 ).fill( 0.5 );
		const { data: out } = octahedralToEquirect( { data, width: n, height: n, channels: 3 }, null, 6, 8 );

		expect( out[ 0 ] ).toBeCloseTo( 3, 5 );
		expect( out[ 3 ] ).toBe( 1 ); // alpha untouched

	} );


	it( 'decodes an 8-bit sRGB source to linear', () => {

		// A canvas readback of a PNG sky arrives as 8-bit sRGB RGBA, top-down.
		const n = 8;
		const value = 188; // mid-tone, well inside the curve's non-linear part
		const data = new Uint8ClampedArray( n * n * 4 ).fill( value );
		for ( let i = 3; i < data.length; i += 4 ) data[ i ] = 255;

		const { data: out } = octahedralToEquirect(
			{ data, width: n, height: n, channels: 4, srgb: true }, null, 1, 8
		);

		const c = value / 255;
		const expected = Math.pow( ( c + 0.055 ) / 1.055, 2.4 );
		expect( out[ 0 ] ).toBeCloseTo( expected, 5 );
		expect( out[ 0 ] ).toBeLessThan( c ); // decoded, not passed through

	} );

	it( 'reads an 8-bit source top-down, matching an equivalent float one', () => {

		// Same hemisphere tag both ways: a canvas gives top-down rows, so the two must agree
		// only when the float source is also read top-down.
		const n = 32;
		const bytes = new Uint8ClampedArray( n * n * 4 );
		const floats = new Float32Array( n * n * 3 );
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const [ , dy ] = equalAreaSquareToSphere( ( i + 0.5 ) / n, ( j + 0.5 ) / n );
			const on = dy > 0;
			const o4 = ( j * n + i ) * 4;
			bytes[ o4 ] = bytes[ o4 + 1 ] = bytes[ o4 + 2 ] = on ? 255 : 0;
			bytes[ o4 + 3 ] = 255;
			const o3 = ( j * n + i ) * 3;
			floats[ o3 ] = floats[ o3 + 1 ] = floats[ o3 + 2 ] = on ? 1 : 0;

		}

		const a = octahedralToEquirect( { data: bytes, width: n, height: n, channels: 4, srgb: true }, null, 1, 32 );
		const b = octahedralToEquirect( { data: floats, width: n, height: n, channels: 3 }, null, 1, 32 );

		let worst = 0;
		for ( let i = 0; i < a.data.length; i += 4 ) worst = Math.max( worst, Math.abs( a.data[ i ] - b.data[ i ] ) );
		expect( worst ).toBeLessThan( 1e-5 );

	} );

	it( 'keeps the light of a sun a few source pixels wide', () => {

		const n = 128;
		let worst = 0;
		for ( let k = 0; k < 24; k ++ ) {

			const data = new Float32Array( n * n * 3 );
			const x = 20 + ( k * 37 ) % 88, y = 20 + ( k * 53 ) % 88;
			for ( const [ dx, dy ] of [[ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ]] ) data[ ( ( y + dy ) * n + x + dx ) * 3 ] = 1000;
			const source = 4 * 1000 * 4 * Math.PI / ( n * n );

			const { data: out, width, height } = octahedralToEquirect( { data, width: n, height: n, channels: 3 }, null, 1 );
			let light = 0;
			for ( let j = 0; j < height; j ++ ) {

				const dOmega = ( 2 * Math.PI / width ) * ( Math.PI / height ) * Math.sin( ( 1 - ( j + 0.5 ) / height ) * Math.PI );
				for ( let i = 0; i < width; i ++ ) light += out[ ( j * width + i ) * 4 ] * dOmega;

			}

			worst = Math.max( worst, Math.abs( light / source - 1 ) );

		}

		expect( worst ).toBeLessThan( 0.02 );

	} );

	it( 'gives every float the per-read evaluation gives, rotated or not, float or 8-bit, at either read count', () => {

		// Each read worked out from scratch: its angles, its square position and a bilinear fetch, clamped at the edges.
		const reference = ( src, worldToLight, scale, width ) => {

			const height = width >> 1, out = new Float32Array( width * height * 4 ), reads = width > 1024 ? 2 : 4;
			const decode = ( v ) => ( src.srgb ? Math.fround( v / 255 <= 0.04045 ? v / 255 / 12.92 : Math.pow( ( v / 255 + 0.055 ) / 1.055, 2.4 ) ) : v );
			const fetch = ( u, v, c ) => {

				const fx = Math.min( Math.max( u * src.width - 0.5, 0 ), src.width - 1 ), fy = Math.min( Math.max( v * src.height - 0.5, 0 ), src.height - 1 );
				const x0 = Math.floor( fx ), y0 = Math.floor( fy ), x1 = Math.min( x0 + 1, src.width - 1 ), y1 = Math.min( y0 + 1, src.height - 1 );
				const tx = fx - x0, ty = fy - y0, at = ( x, y ) => decode( src.data[ ( y * src.width + x ) * src.channels + c ] );
				return ( at( x0, y0 ) * ( 1 - tx ) + at( x1, y0 ) * tx ) * ( 1 - ty ) + ( at( x0, y1 ) * ( 1 - tx ) + at( x1, y1 ) * tx ) * ty;

			};

			for ( let j = 0; j < height; j ++ ) for ( let i = 0; i < width; i ++ ) {

				const sum = [ 0, 0, 0 ];
				let weight = 0;
				for ( let sj = 0; sj < reads; sj ++ ) for ( let si = 0; si < reads; si ++ ) {

					const polar = ( 1 - ( j + ( sj + 0.5 ) / reads ) / height ) * Math.PI;
					const azimuth = ( ( i + ( si + 0.5 ) / reads ) / width - 0.5 ) * 2 * Math.PI;
					let d = [ Math.sin( polar ) * Math.cos( azimuth ), Math.cos( polar ), Math.sin( polar ) * Math.sin( azimuth ) ];
					if ( worldToLight ) {

						const m = worldToLight, t = [ 0, 1, 2 ].map( ( r ) => m[ r ] * d[ 0 ] + m[ r + 4 ] * d[ 1 ] + m[ r + 8 ] * d[ 2 ] );
						const len = Math.hypot( ...t ) || 1;
						d = t.map( ( v ) => v / len );

					}

					const [ su, sv ] = equalAreaSphereToSquare( ...d );
					for ( let c = 0; c < 3; c ++ ) sum[ c ] += fetch( su, src.bottomUp ? 1 - sv : sv, c ) * Math.sin( polar );
					weight += Math.sin( polar );

				}

				const k = weight > 0 ? scale / weight : 0;
				for ( let c = 0; c < 3; c ++ ) out[ ( j * width + i ) * 4 + c ] = sum[ c ] * k;
				out[ ( j * width + i ) * 4 + 3 ] = 1;

			}

			return out;

		};

		let seed = 5;
		const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
		// pbrt's CTM for a light turned about a tilted axis and moved.
		const turn = [ 0.36, 0.48, - 0.8, 0, - 0.8, 0.6, 0, 0, 0.48, 0.64, 0.6, 0, 1, 2, 3, 1 ];
		const bits = ( a ) => Array.from( new Uint32Array( a.buffer, a.byteOffset, a.length ) );
		for ( const [ n, channels, kind, ctm, scale, width ] of [[ 40, 3, 'float', null, 1, 64 ], [ 33, 4, 'srgb', turn, 2.5, 96 ], [ 37, 3, 'bottomUp', turn, 1, 1025 ]] ) {

			const src = {
				data: kind === 'srgb' ? Uint8Array.from( { length: n * n * channels }, () => Math.floor( rand() * 256 ) ) : Float32Array.from( { length: n * n * channels }, () => rand() * 3 ),
				width: n, height: n, channels, srgb: kind === 'srgb', bottomUp: kind === 'bottomUp'
			};
			const fast = octahedralToEquirect( src, ctm, scale, width ).data;
			const want = reference( src, ctm && invert( ctm ), scale, width );
			// The first differing float, not a diff of a million (which never finishes printing).
			const a = bits( fast ), b = bits( want );
			const first = a.findIndex( ( v, k ) => v !== b[ k ] );
			expect( [ a.length, first ] ).toEqual( [ b.length, - 1 ] );

		}

	} );

} );
