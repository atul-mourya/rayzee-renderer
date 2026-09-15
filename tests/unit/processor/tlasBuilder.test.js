import { describe, it, expect, beforeEach } from 'vitest';
import { TLASBuilder } from '@/core/Processor/TLASBuilder.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';

/** A table of `n` placements with the given world AABBs (6 floats each). */
function makeTable( bounds ) {

	const n = bounds.length;
	const table = new InstanceTable();
	table.allocate( n );
	for ( let i = 0; i < n; i ++ ) {

		table.setEntry( {
			meshIndex: i, blasNodeCount: 3, triOffset: i * 10, triCount: 10,
			originalToBvhMap: null, bvhData: null
		} );
		table.tplBlasOffset[ i ] = i * 100;
		// Transforms are identity here, so object bounds are the world bounds the build reads.
		table.tplObjectAABB.set( bounds[ i ], i * 6 );

	}

	return table;

}

/** Spread `n` unit boxes along +x so every centroid is distinct. */
function spread( n ) {

	return makeTable( Array.from( { length: n }, ( _, i ) => [ i * 4, 0, 0, i * 4 + 1, 1, 1 ] ) );

}

const isLeaf = ( data, node ) => data[ node * 16 + 3 ] === - 2;

/**
 * Walk the flat tree from the root, checking structure: every node reachable exactly once,
 * child indices in range, and each inner node's stored child AABBs containing that subtree.
 */
function walk( data, nodeCount ) {

	const seen = new Uint8Array( nodeCount );
	const leaves = [];
	const stack = [ 0 ];
	let inner = 0;

	while ( stack.length ) {

		const node = stack.pop();
		expect( node ).toBeGreaterThanOrEqual( 0 );
		expect( node ).toBeLessThan( nodeCount );
		expect( seen[ node ] ).toBe( 0 ); // reached exactly once
		seen[ node ] = 1;

		if ( isLeaf( data, node ) ) {

			leaves.push( node );
			continue;

		}

		inner ++;
		stack.push( data[ node * 16 + 3 ], data[ node * 16 + 7 ] );

	}

	expect( seen.every( v => v === 1 ) ).toBe( true ); // no orphans
	return { leaves, inner };

}

describe( 'TLASBuilder', () => {

	let builder;

	beforeEach( () => {

		builder = new TLASBuilder();

	} );

	describe( 'nodeCountFor', () => {

		it( 'is 2n-1 because every leaf holds exactly one entry', () => {

			expect( TLASBuilder.nodeCountFor( 0 ) ).toBe( 0 );
			expect( TLASBuilder.nodeCountFor( 1 ) ).toBe( 1 );
			expect( TLASBuilder.nodeCountFor( 2 ) ).toBe( 3 );
			expect( TLASBuilder.nodeCountFor( 1000 ) ).toBe( 1999 );

		} );

		it( 'matches what build actually emits', () => {

			// The caller assigns BLAS offsets from this BEFORE building, so a mismatch would
			// shift every BLAS pointer in the combined buffer.
			for ( const n of [ 1, 2, 3, 7, 65, 200 ] ) {

				const { nodeCount } = builder.build( spread( n ) );
				expect( nodeCount ).toBe( TLASBuilder.nodeCountFor( n ) );

			}

		} );

	} );

	describe( 'build', () => {

		it( 'returns an empty buffer for no entries', () => {

			const { data, nodeCount } = builder.build( makeTable( [] ) );
			expect( nodeCount ).toBe( 0 );
			expect( data ).toHaveLength( 0 );

		} );

		it( 'writes a single entry as a lone BLAS-pointer leaf', () => {

			const table = makeTable( [[ 0, 0, 0, 1, 1, 1 ]] );
			table.tplBlasOffset[ 0 ] = 10;
			const { data, nodeCount } = builder.build( table );

			expect( nodeCount ).toBe( 1 );
			expect( data ).toHaveLength( 16 );
			expect( data[ 0 ] ).toBe( 10 ); // blasOffset
			expect( data[ 1 ] ).toBe( 0 ); // entryIndex
			expect( data[ 2 ] ).toBe( 1 ); // visible
			expect( data[ 3 ] ).toBe( - 2 ); // BLAS-pointer marker
			expect( table.tlasLeafIndex[ 0 ] ).toBe( 0 );

		} );

		it( 'produces a well-formed tree at every size', () => {

			for ( const n of [ 2, 3, 8, 65, 300 ] ) {

				const table = spread( n );
				const { data, nodeCount } = builder.build( table );
				const { leaves, inner } = walk( data, nodeCount );

				expect( leaves ).toHaveLength( n );
				expect( inner ).toBe( n - 1 );

				// Every entry appears exactly once, and knows where its leaf landed.
				const ids = leaves.map( node => data[ node * 16 + 1 ] ).sort( ( a, b ) => a - b );
				expect( ids ).toEqual( Array.from( { length: n }, ( _, i ) => i ) );
				for ( let i = 0; i < n; i ++ ) {

					expect( data[ table.tlasLeafIndex[ i ] * 16 + 1 ] ).toBe( i );

				}

			}

		} );

		it( 'stores child AABBs that contain their subtrees', () => {

			const table = spread( 40 );
			const { data, nodeCount } = builder.build( table );
			const bounds = new Float64Array( table.count * 6 );
			table.writeWorldAABBs( bounds );

			const subtreeBounds = node => {

				if ( isLeaf( data, node ) ) {

					const a = data[ node * 16 + 1 ] * 6;
					return Array.from( bounds.slice( a, a + 6 ) );

				}

				const l = subtreeBounds( data[ node * 16 + 3 ] );
				const r = subtreeBounds( data[ node * 16 + 7 ] );
				return [
					Math.min( l[ 0 ], r[ 0 ] ), Math.min( l[ 1 ], r[ 1 ] ), Math.min( l[ 2 ], r[ 2 ] ),
					Math.max( l[ 3 ], r[ 3 ] ), Math.max( l[ 4 ], r[ 4 ] ), Math.max( l[ 5 ], r[ 5 ] )
				];

			};

			for ( let node = 0; node < nodeCount; node ++ ) {

				if ( isLeaf( data, node ) ) continue;
				const o = node * 16;
				const l = subtreeBounds( data[ o + 3 ] );
				const r = subtreeBounds( data[ o + 7 ] );
				expect( [ data[ o ], data[ o + 1 ], data[ o + 2 ], data[ o + 4 ], data[ o + 5 ], data[ o + 6 ] ] )
					.toEqual( l );
				expect( [ data[ o + 8 ], data[ o + 9 ], data[ o + 10 ], data[ o + 12 ], data[ o + 13 ], data[ o + 14 ] ] )
					.toEqual( r );

			}

		} );

		it( 'survives entries that share one centroid', () => {

			// Coincident centroids defeat both SAH paths; the median fallback still has to
			// split, or a leaf would hold two entries and the 2n-1 node count would be wrong.
			const table = makeTable( Array.from( { length: 200 }, () => [ 0, 0, 0, 1, 1, 1 ] ) );
			const { data, nodeCount } = builder.build( table );

			expect( nodeCount ).toBe( 399 );
			const { leaves } = walk( data, nodeCount );
			expect( leaves ).toHaveLength( 200 );

		} );

		it( 'carries visibility and the world-to-object matrix into the leaf', () => {

			// Exactly representable in f32 both ways, since the leaf carries the derived inverse.
			const world = [ 0.5, 0, 0, 0, 0, 0.25, 0, 0, 0, 0, 0.125, 0, - 2.5, - 1.5, - 0.875, 1 ];
			const table = spread( 2 );
			table.visible[ 0 ] = 0;
			table.world.set( world, 16 );

			const { data } = builder.build( table );
			const leafOf = i => table.tlasLeafIndex[ i ] * 16;

			expect( data[ leafOf( 0 ) + 2 ] ).toBe( 0 ); // hidden
			expect( data[ leafOf( 1 ) + 2 ] ).toBe( 1 );

			// Three rows of four, read out of the column-major inverse.
			const o = leafOf( 1 );
			expect( Array.from( data.slice( o + 4, o + 16 ) ) )
				.toEqual( [ 2, 0, 0, 5, 0, 4, 0, 6, 0, 0, 8, 7 ] );

		} );

		it( 'reuses its buffers across rebuilds', () => {

			const table = spread( 50 );
			builder.build( table );
			const buffer = builder._flatBuffer;
			const order = builder._order;

			builder.build( table );
			expect( builder._flatBuffer ).toBe( buffer );
			expect( builder._order ).toBe( order );

		} );

		it( 'keeps stack depth logarithmic, not linear', () => {

			// Entries placed so each split peels off one side; recursing into the smaller half
			// is what stops a 100k-entry scene needing 100k stack frames.
			const table = makeTable( Array.from( { length: 4000 }, ( _, i ) =>
				[ 2 ** ( i % 20 ), 0, 0, 2 ** ( i % 20 ) + 1, 1, 1 ] ) );

			const { data, nodeCount } = builder.build( table );
			expect( nodeCount ).toBe( 7999 );
			expect( walk( data, nodeCount ).leaves ).toHaveLength( 4000 );
			expect( builder._stackFrames ).toBeLessThan( 512 );

		} );

	} );

} );
