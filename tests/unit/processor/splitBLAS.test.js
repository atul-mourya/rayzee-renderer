import { describe, it, expect, vi } from 'vitest';
import { BVH_LEAF_MARKERS } from '@/core/EngineDefaults.js';

vi.mock( '@/core/Processor/TreeletOptimizer.js', () => ( {
	TreeletOptimizer: class {

		setTreeletSize() {}
		setMinImprovement() {}
		setMaxTreelets() {}
		optimizeBVH() {}
		getStatistics() {

			return {};

		}

	}
} ) );

vi.mock( '@/core/Processor/ReinsertionOptimizer.js', () => ( {
	ReinsertionOptimizer: class {

		setBatchSizeRatio() {}
		setMaxIterations() {}
		optimizeBVH() {}
		getStatistics() {

			return {};

		}

	}
} ) );

import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';
import { BVHBuilder } from '@/core/Processor/BVHBuilder.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { partitionRange, joinPieces } from '@/core/Processor/SplitBLAS.js';

const LANES = 20;
const ID = 18;
const TOTAL = 3000;
const START = 100;
const COUNT = 2500;
const PIECE = 400;

// Small triangles scattered over a box, lane 18 carrying each one's original index.
function records() {

	const r = new ChunkedRecords( TOTAL, LANES, Uint32Array, 256 * LANES * 4 );
	const rec = new Uint32Array( LANES );
	const f = new Float32Array( rec.buffer );
	let seed = 7;
	const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
	for ( let i = 0; i < TOTAL; i ++ ) {

		const x = rand() * 40, y = rand() * 5, z = rand() * 20;
		f.fill( 0 );
		f.set( [ x, y, z ], 0 );
		f.set( [ x + 0.3, y, z ], 4 );
		f.set( [ x, y + 0.3, z + 0.2 ], 8 );
		rec[ ID ] = i;
		r.setRecords( i, rec );

	}

	return r;

}

const idOf = ( r, i ) => r.chunkFor( i )[ r.baseOf( i ) + ID ];

function centroid( r, i ) {

	const c = r.chunkFor( i ), b = r.baseOf( i );
	const f = new Float32Array( c.buffer, c.byteOffset, c.length );
	return [ 0, 1, 2 ].map( a => f[ b + a ] + f[ b + 4 + a ] + f[ b + 8 + a ] );

}

function piecesUnder( node ) {

	return node.piece !== undefined ? [ node.piece ] : [ ...piecesUnder( node.left ), ...piecesUnder( node.right ) ];

}

describe( 'partitionRange', () => {

	it( 'reorders only the range, into contiguous pieces split at the median of the longest axis', async () => {

		const r = records();
		const { order, pieces, tree } = await partitionRange( r, START, COUNT, PIECE );

		for ( let i = 0; i < START; i ++ ) expect( idOf( r, i ) ).toBe( i );
		for ( let i = START + COUNT; i < TOTAL; i ++ ) expect( idOf( r, i ) ).toBe( i );
		for ( let j = 0; j < COUNT; j ++ ) expect( idOf( r, START + j ) ).toBe( START + order[ j ] );
		expect( new Set( order ).size ).toBe( COUNT );

		let at = 0;
		for ( const p of pieces ) {

			expect( p.start ).toBe( at );
			expect( p.count ).toBeLessThanOrEqual( PIECE );
			expect( p.count ).toBeGreaterThanOrEqual( PIECE / 2 );
			at += p.count;

		}

		expect( at ).toBe( COUNT );

		// The box is widest in x, so the first halving is in x.
		const xs = which => piecesUnder( which ).flatMap( k => Array.from( { length: pieces[ k ].count }, ( _, i ) => centroid( r, START + pieces[ k ].start + i )[ 0 ] ) );
		expect( Math.max( ...xs( tree.left ) ) ).toBeLessThanOrEqual( Math.min( ...xs( tree.right ) ) );

	} );

} );

describe( 'partitionRange, again', () => {

	it( 'builds the same pieces every time, and the same when it pauses', async () => {

		const a = records(), b = records();
		let pauses = 0;
		const first = await partitionRange( a, START, COUNT, PIECE );
		const second = await partitionRange( b, START, COUNT, PIECE, { pause: async () => void pauses ++ } );

		expect( Array.from( second.order ) ).toEqual( Array.from( first.order ) );
		expect( second.pieces ).toEqual( first.pieces );
		expect( pauses ).toBeGreaterThan( 0 );

	} );

} );

describe( 'joinPieces', () => {

	it( 'joins the pieces\' BLASes into one that reaches every triangle once, in boxes that hold them', async () => {

		const r = records();
		const { order, pieces, tree } = await partitionRange( r, START, COUNT, PIECE );

		const built = pieces.map( p => {

			const builder = new BVHBuilder();
			const root = builder.buildSync( r.copyOf( START + p.start, p.count ) );
			const bvhData = builder.flattenBVH( root );
			r.setRecords( START + p.start, builder.reorderedTriangleData );
			const aabb = new Float32Array( 6 );
			InstanceTable.rootAABB( bvhData, r, START + p.start, p.count, aabb, 0 );
			return { bvhData, originalToBvh: builder.originalToBvhMap, aabb };

		} );

		const pieceArrays = built.map( b => b.bvhData );
		const { bvhData: parts, nodeCount, originalToBvh } = joinPieces( tree, pieces, built, order );

		// Handed back as parts, the pieces' own arrays among them: nothing the size of the mesh.
		expect( parts.slice( 1 ) ).toEqual( pieceArrays );
		expect( parts[ 1 ] ).toBe( pieceArrays[ 0 ] );
		const bvhData = new Float32Array( nodeCount * 16 );
		let at = 0;
		for ( const part of parts ) {

			bvhData.set( part, at );
			at += part.length;

		}

		expect( at ).toBe( nodeCount * 16 );
		const idx = new Uint32Array( bvhData.buffer );

		const seen = new Uint8Array( COUNT );
		const contains = ( box, tri ) => {

			const c = r.chunkFor( START + tri ), b = r.baseOf( START + tri );
			const f = new Float32Array( c.buffer, c.byteOffset, c.length );
			for ( const v of [ 0, 4, 8 ] ) for ( let a = 0; a < 3; a ++ ) {

				if ( f[ b + v + a ] < box[ a ] - 1e-4 || f[ b + v + a ] > box[ 3 + a ] + 1e-4 ) return false;

			}

			return true;

		};

		// Every triangle under a node, checked against each box on the way down.
		const walk = ( n, boxes ) => {

			const o = n * 16;
			if ( idx[ o + 3 ] === BVH_LEAF_MARKERS.TRIANGLE_LEAF ) {

				for ( let t = idx[ o ]; t < idx[ o ] + idx[ o + 1 ]; t ++ ) {

					seen[ t ] ++;
					for ( const box of boxes ) expect( contains( box, t ) ).toBe( true );

				}

				return;

			}

			walk( idx[ o + 3 ], [[ bvhData[ o ], bvhData[ o + 1 ], bvhData[ o + 2 ], bvhData[ o + 4 ], bvhData[ o + 5 ], bvhData[ o + 6 ] ], ...boxes ] );
			walk( idx[ o + 7 ], [[ bvhData[ o + 8 ], bvhData[ o + 9 ], bvhData[ o + 10 ], bvhData[ o + 12 ], bvhData[ o + 13 ], bvhData[ o + 14 ] ], ...boxes ] );
			expect( idx[ o + 3 ] ).toBeGreaterThan( n );
			expect( idx[ o + 7 ] ).toBeGreaterThan( n );

		};

		walk( 0, [] );
		expect( seen.every( v => v === 1 ) ).toBe( true );

		expect( new Set( originalToBvh ).size ).toBe( COUNT );
		for ( let i = 0; i < COUNT; i ++ ) expect( idOf( r, START + originalToBvh[ i ] ) ).toBe( START + i );

	} );

} );
