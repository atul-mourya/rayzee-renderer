import { describe, it, expect } from 'vitest';
import { packCorners, NODE_WORD_LANES, NODE_NO_LANES } from '@/core/scene/TriangleClusters.js';
import { TRIANGLE_DATA_LAYOUT } from '@/core/scene/BufferLayout.js';

const LANES = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

// Triangle t's corner rows as the shader reads them (shaders/Common.js triangleGeoRows): through its pair, or from
// the corner base and word its leaf node holds.
function readNodeCorners( data, t, leaf = null ) {

	const cornerBase = leaf ? leaf.cornerBase : data[ t * 2 ];
	const word = leaf ? leaf.word : data[ t * 2 + 1 ];
	return [ 0, 1, 2 ].map( ( k ) => {

		const at = ( cornerBase + ( ( word >>> ( 8 * k ) ) & 255 ) ) * 4;
		return Array.from( data.subarray( at, at + 4 ) );

	} );

}

// Leaves of 1–8 triangles over `count`, skipping 5 triangles at 300.
function leaves( count ) {

	const first = [], sizes = [];
	for ( let t = 0, n = 1; t < count; ) {

		if ( t === 300 ) {

			t += 5;
			continue;

		}

		const size = Math.min( n, count - t );
		first.push( t );
		sizes.push( size );
		t += size;
		n = n % 8 + 1;

	}

	return { first, sizes };

}

// A grid strip: neighbouring triangles share corners, as a mesh's do.
function gridRecords( count ) {

	const records = new Uint32Array( count * LANES );
	const f = new Float32Array( 1 );
	const bits = ( v ) => {

		f[ 0 ] = v;
		return new Uint32Array( f.buffer )[ 0 ];

	};

	for ( let t = 0; t < count; t ++ ) {

		const q = t >> 1;
		const corners = t & 1 ? [[ q, 0 ], [ q + 1, 1 ], [ q, 1 ]] : [[ q, 0 ], [ q + 1, 0 ], [ q + 1, 1 ]];
		corners.forEach( ( [ x, y ], k ) => {

			records.set( [ bits( x ), bits( y ), bits( - 0 ), 0x7fff0000 ], t * LANES + k * 4 );

		} );
		records[ t * LANES + 18 ] = t;

	}

	return records;

}

// The whole pack, through a sink, `chunkRows` rows a call.
async function pack( records, count, first, sizes, chunkRows ) {

	const counted = await packCorners( records, count, first, sizes );
	const data = new Uint32Array( counted.rows * 4 );
	const built = await packCorners( records, count, first, sizes, ( row, piece ) => data.set( piece, row * 4 ), chunkRows );
	return { ...built, data, counted };

}

const expected = ( records, t ) => [ 0, 1, 2 ].map( ( k ) => Array.from( records.subarray( t * LANES + k * 4, t * LANES + k * 4 + 4 ) ) );

describe( 'packCorners', () => {

	it( 'reads every triangle back through its pair and its leaf node, gaps included', async () => {

		const count = 700;
		const records = gridRecords( count );
		const { first, sizes } = leaves( count );
		const built = await pack( records, count, Uint32Array.from( first ), Uint32Array.from( sizes ) );

		expect( built.clusters ).toBeGreaterThan( 1 );
		expect( built.counted.rows ).toBe( built.rows );
		// A strip shares its corners: far fewer than three a triangle.
		expect( built.corners ).toBeLessThan( count * 3 / 2 );
		for ( let t = 0; t < count; t ++ ) expect( readNodeCorners( built.data, t ) ).toEqual( expected( records, t ) );
		first.forEach( ( f, l ) => {

			for ( let i = 0; i < sizes[ l ]; i ++ ) {

				const leaf = { cornerBase: built.leafBase[ l ], word: built.leafWords[ l * NODE_WORD_LANES + i ] };
				expect( readNodeCorners( built.data, f + i, leaf ) ).toEqual( expected( records, f + i ) );

			}

		} );

	} );

	it( 'keeps corners that differ only in the normal or in -0 apart', async () => {

		const records = gridRecords( 2 );
		records[ 3 ] = 0x12345678;
		records[ LANES + 2 ] = 0;
		const { data } = await pack( records, 2, Uint32Array.of( 0 ), Uint32Array.of( 2 ) );
		expect( readNodeCorners( data, 0 )[ 0 ][ 3 ] ).toBe( 0x12345678 );
		expect( readNodeCorners( data, 1 )[ 0 ][ 3 ] ).toBe( 0x7fff0000 );
		expect( readNodeCorners( data, 1 )[ 0 ][ 2 ] ).toBe( 0 );
		expect( readNodeCorners( data, 0 )[ 1 ][ 2 ] ).toBe( 0x80000000 );

	} );

	it( 'streams what it writes a few rows at a time, each waited on, the same rows', async () => {

		const count = 701;
		const records = gridRecords( count );
		const { first, sizes } = leaves( count );
		const whole = await pack( records, count, Uint32Array.from( first ), Uint32Array.from( sizes ) );

		const out = new Uint32Array( whole.rows * 4 );
		const calls = [];
		let drains = 0;
		const streamed = await packCorners( records, count, Uint32Array.from( first ), Uint32Array.from( sizes ), ( row, data ) => {

			calls.push( data.length / 4 );
			out.set( data, row * 4 );
			return Promise.resolve().then( () => drains ++ );

		}, 7 );
		expect( drains ).toBe( calls.length );
		expect( Math.max( ...calls ) ).toBeLessThanOrEqual( 7 );
		expect( out ).toEqual( whole.data );
		expect( streamed.leafBase ).toEqual( whole.leafBase );
		expect( streamed.leafWords ).toEqual( whole.leafWords );

	} );

	it( 'reads a leaf past the lanes through its pairs, marked for traversal', async () => {

		const count = 120;
		const records = gridRecords( count );
		const built = await pack( records, count, Uint32Array.of( 0, 50, 110 ), Uint32Array.of( 50, 60, 10 ) );

		expect( built.tooBig ).toBe( 2 );
		expect( built.leafBase[ 0 ] ).toBe( NODE_NO_LANES );
		expect( built.leafBase[ 1 ] ).toBe( NODE_NO_LANES );
		for ( let t = 0; t < count; t ++ ) expect( readNodeCorners( built.data, t ) ).toEqual( expected( records, t ) );
		for ( let i = 0; i < 10; i ++ ) {

			const leaf = { cornerBase: built.leafBase[ 2 ], word: built.leafWords[ 2 * NODE_WORD_LANES + i ] };
			expect( readNodeCorners( built.data, 110 + i, leaf ) ).toEqual( expected( records, 110 + i ) );

		}

	} );

	it( 'packs through a small window loaded on demand: the same rows', async () => {

		const count = 700;
		const records = gridRecords( count );
		const { first, sizes } = leaves( count );
		const whole = await pack( records, count, Uint32Array.from( first ), Uint32Array.from( sizes ) );
		const size = 37;
		const buffer = new Uint32Array( size * LANES );
		let loads = 0;
		const window = {
			windowed: true, start: 0, end: 0,
			at: () => buffer,
			base: ( t ) => ( t - window.start ) * LANES,
			has: ( f, n ) => f >= window.start && f + n <= window.end,
			load: async ( f ) => {

				loads ++;
				window.start = f;
				window.end = Math.min( count, f + size );
				buffer.set( records.subarray( f * LANES, window.end * LANES ) );

			},
		};

		const windowed = await pack( window, count, Uint32Array.from( first ), Uint32Array.from( sizes ) );
		expect( loads ).toBeGreaterThan( 2 * count / size - 2 );
		expect( windowed.data ).toEqual( whole.data );

	} );

} );
