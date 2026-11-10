import { describe, it, expect } from 'vitest';
import { packCornerBlock, NODE_WORD_LANES, NODE_NO_LANES } from '@/core/scene/TriangleClusters.js';
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

// The GPU buffer the stage assembles from jobs (pathtracer/CompactLayout.js): each job's pairs at its first triangle,
// its corners at the row the counts before it give, after the pairs. `cuts` split the triangles into jobs.
function pack( records, count, first, sizes, cuts = [] ) {

	const edges = [ 0, ...cuts, count ];
	const jobs = edges.slice( 0, - 1 ).map( ( from, k ) => {

		const to = edges[ k + 1 ];
		const leaves = first.map( ( f, l ) => l ).filter( ( l ) => first[ l ] >= from && first[ l ] < to );
		return {
			from, to, leaves,
			records: records.subarray( from * LANES, to * LANES ),
			leafFirst: Uint32Array.from( leaves, ( l ) => first[ l ] - from ), leafCount: Uint32Array.from( leaves, ( l ) => sizes[ l ] ),
		};

	} );
	let at = Math.ceil( count / 2 );
	const counted = jobs.map( ( j ) => packCornerBlock( j.records, j.to - j.from, j.leafFirst, j.leafCount ) );
	const bases = counted.map( ( c ) => ( at += c.corners ) - c.corners );
	const data = new Uint32Array( at * 4 );
	const leafBase = new Uint32Array( first.length ), leafWords = new Uint32Array( first.length * NODE_WORD_LANES );
	let clusters = 0, tooBig = 0;
	jobs.forEach( ( j, k ) => {

		const r = packCornerBlock( j.records, j.to - j.from, j.leafFirst, j.leafCount, bases[ k ] );
		expect( r.corners ).toBe( counted[ k ].corners );
		data.set( r.pairs, j.from * 2 );
		data.set( r.rows, bases[ k ] * 4 );
		j.leaves.forEach( ( l, i ) => {

			leafBase[ l ] = r.leafBase[ i ];
			leafWords.set( r.leafWords.subarray( i * NODE_WORD_LANES, ( i + 1 ) * NODE_WORD_LANES ), l * NODE_WORD_LANES );

		} );
		clusters += r.clusters;
		tooBig += r.tooBig;

	} );
	return { data, leafBase, leafWords, clusters, tooBig, corners: at - Math.ceil( count / 2 ) };

}

const expected = ( records, t ) => [ 0, 1, 2 ].map( ( k ) => Array.from( records.subarray( t * LANES + k * 4, t * LANES + k * 4 + 4 ) ) );

const readsBack = ( built, records, count, first, sizes ) => {

	for ( let t = 0; t < count; t ++ ) expect( readNodeCorners( built.data, t ) ).toEqual( expected( records, t ) );
	first.forEach( ( f, l ) => {

		if ( built.leafBase[ l ] === NODE_NO_LANES ) return;
		for ( let i = 0; i < sizes[ l ]; i ++ ) {

			const leaf = { cornerBase: built.leafBase[ l ], word: built.leafWords[ l * NODE_WORD_LANES + i ] };
			expect( readNodeCorners( built.data, f + i, leaf ) ).toEqual( expected( records, f + i ) );

		}

	} );

};

describe( 'packCornerBlock', () => {

	it( 'reads every triangle back through its pair and its leaf node, gaps included', () => {

		const count = 700;
		const records = gridRecords( count );
		const { first, sizes } = leaves( count );
		const built = pack( records, count, first, sizes );

		expect( built.clusters ).toBeGreaterThan( 1 );
		// A strip shares its corners: far fewer than three a triangle.
		expect( built.corners ).toBeLessThan( count * 3 / 2 );
		readsBack( built, records, count, first, sizes );

	} );

	it( 'packs in jobs cut at leaf boundaries, an odd one included, each at the offset the counts before it give', () => {

		const count = 701;
		const records = gridRecords( count );
		const { first, sizes } = leaves( count );
		// Cuts at leaf starts, as the build makes them: never inside a leaf.
		const cuts = [ first[ 9 ], first[ 40 ], first[ 61 ], first[ 90 ] ];
		expect( cuts.some( ( c ) => c % 2 ) ).toBe( true );
		readsBack( pack( records, count, first, sizes, cuts ), records, count, first, sizes );

	} );

	it( 'keeps corners that differ only in the normal or in -0 apart', () => {

		const records = gridRecords( 2 );
		records[ 3 ] = 0x12345678;
		records[ LANES + 2 ] = 0;
		const { data } = pack( records, 2, [ 0 ], [ 2 ] );
		expect( readNodeCorners( data, 0 )[ 0 ][ 3 ] ).toBe( 0x12345678 );
		expect( readNodeCorners( data, 1 )[ 0 ][ 3 ] ).toBe( 0x7fff0000 );
		expect( readNodeCorners( data, 1 )[ 0 ][ 2 ] ).toBe( 0 );
		expect( readNodeCorners( data, 0 )[ 1 ][ 2 ] ).toBe( 0x80000000 );

	} );

	it( 'reads a leaf past the lanes through its pairs, marked for traversal', () => {

		const count = 120;
		const records = gridRecords( count );
		const first = [ 0, 50, 110 ], sizes = [ 50, 60, 10 ];
		const built = pack( records, count, first, sizes );

		expect( built.tooBig ).toBe( 2 );
		expect( built.leafBase[ 0 ] ).toBe( NODE_NO_LANES );
		expect( built.leafBase[ 1 ] ).toBe( NODE_NO_LANES );
		readsBack( built, records, count, first, sizes );

	} );

} );
