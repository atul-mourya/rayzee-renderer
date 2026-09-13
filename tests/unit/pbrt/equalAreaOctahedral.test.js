import { describe, it, expect } from 'vitest';
import { equalAreaSphereToSquare, octahedralToEquirect } from '@/core/Processor/PBRT/EqualAreaOctahedral.js';

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

} );
