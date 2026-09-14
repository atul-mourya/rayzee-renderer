import { describe, it, expect } from 'vitest';
import { InstanceTable, transformAABB, isIdentity } from '@/core/Processor/InstanceTable.js';

const box = ( n = 1 ) => ( { minX: - n, minY: - n, minZ: - n, maxX: n, maxY: n, maxZ: n } );

/** A BLAS root that reports the given bounds, in the flat 16-float node layout. */
function rootNode( aabb ) {

	const d = new Float32Array( 16 );
	d[ 0 ] = aabb.minX; d[ 1 ] = aabb.minY; d[ 2 ] = aabb.minZ; d[ 3 ] = 1;
	d[ 4 ] = aabb.maxX; d[ 5 ] = aabb.maxY; d[ 6 ] = aabb.maxZ; d[ 7 ] = 2;
	d[ 8 ] = aabb.minX; d[ 9 ] = aabb.minY; d[ 10 ] = aabb.minZ;
	d[ 12 ] = aabb.maxX; d[ 13 ] = aabb.maxY; d[ 14 ] = aabb.maxZ;
	return d;

}

describe( 'instance transforms', () => {

	it( 'carries an AABB through a scale and translation', () => {

		const m = [ 3, 0, 0, 0, 0, 3, 0, 0, 0, 0, 3, 0, 0, 5, 0, 1 ];
		expect( transformAABB( box( 1 ), m ) ).toEqual( {
			minX: - 3, minY: 2, minZ: - 3, maxX: 3, maxY: 8, maxZ: 3
		} );

	} );

	it( 'grows the box around a rotation rather than shrinking it', () => {

		// 45 degrees about Y: a unit box's footprint widens to sqrt(2).
		const c = Math.SQRT1_2;
		const m = [ c, 0, - c, 0, 0, 1, 0, 0, c, 0, c, 0, 0, 0, 0, 1 ];
		const out = transformAABB( box( 1 ), m );
		expect( out.maxX ).toBeCloseTo( Math.SQRT2, 5 );
		expect( out.maxZ ).toBeCloseTo( Math.SQRT2, 5 );
		expect( out.maxY ).toBeCloseTo( 1, 5 );

	} );

	it( 'inverts the stored matrix so a point round-trips', () => {

		const table = new InstanceTable();
		table.allocate( 1 );
		const m = [ 2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 4, 0, 7, - 3, 1, 1 ];
		table.setEntry( { meshIndex: 0, blasNodeCount: 1, triOffset: 0, triCount: 1, originalToBvhMap: null, bvhData: null, matrixWorld: m } );

		const inv = table.entries[ 0 ].matrixInverse;
		const world = [ 5, 2, - 1 ];
		const obj = [
			inv[ 0 ] * world[ 0 ] + inv[ 4 ] * world[ 1 ] + inv[ 8 ] * world[ 2 ] + inv[ 12 ],
			inv[ 1 ] * world[ 0 ] + inv[ 5 ] * world[ 1 ] + inv[ 9 ] * world[ 2 ] + inv[ 13 ],
			inv[ 2 ] * world[ 0 ] + inv[ 6 ] * world[ 1 ] + inv[ 10 ] * world[ 2 ] + inv[ 14 ]
		];
		const back = [
			m[ 0 ] * obj[ 0 ] + m[ 4 ] * obj[ 1 ] + m[ 8 ] * obj[ 2 ] + m[ 12 ],
			m[ 1 ] * obj[ 0 ] + m[ 5 ] * obj[ 1 ] + m[ 9 ] * obj[ 2 ] + m[ 13 ],
			m[ 2 ] * obj[ 0 ] + m[ 6 ] * obj[ 1 ] + m[ 10 ] * obj[ 2 ] + m[ 14 ]
		];

		expect( back[ 0 ] ).toBeCloseTo( world[ 0 ], 6 );
		expect( back[ 1 ] ).toBeCloseTo( world[ 1 ], 6 );
		expect( back[ 2 ] ).toBeCloseTo( world[ 2 ], 6 );

	} );

	it( 'falls back to identity for a degenerate transform', () => {

		const table = new InstanceTable();
		table.allocate( 1 );
		// Flattened to a plane — not invertible.
		const m = [ 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];
		table.setEntry( { meshIndex: 0, blasNodeCount: 1, triOffset: 0, triCount: 1, originalToBvhMap: null, bvhData: null, matrixWorld: m } );
		expect( isIdentity( table.entries[ 0 ].matrixInverse ) ).toBe( true );

	} );

} );

describe( 'shared BLAS placements', () => {

	it( 'gives an alias the owner\'s nodes and triangles, but its own transform', () => {

		const table = new InstanceTable();
		table.allocate( 2 );
		table.setEntry( {
			meshIndex: 0, blasNodeCount: 7, triOffset: 0, triCount: 12,
			originalToBvhMap: null, bvhData: rootNode( box( 1 ) ),
			matrixWorld: null, expandedStart: 0
		} );
		table.setAlias( 1, 0, [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1 ], 12 );

		const [ owner, alias ] = table.entries;
		expect( alias.sharedFrom ).toBe( 0 );
		expect( alias.triOffset ).toBe( owner.triOffset );
		expect( alias.triCount ).toBe( owner.triCount );
		// Its own slot in a per-mesh walk, which is what refit callers build.
		expect( alias.expandedStart ).toBe( 12 );

		table.computeAABBs( new Float32Array( 0 ) );
		expect( alias.objectAABB ).toBe( owner.objectAABB );
		expect( alias.worldAABB.minX ).toBeCloseTo( 9, 5 );
		expect( owner.worldAABB.minX ).toBeCloseTo( - 1, 5 );

	} );

	it( 'counts a shared BLAS once when assigning node offsets', () => {

		const table = new InstanceTable();
		table.allocate( 3 );
		table.setEntry( { meshIndex: 0, blasNodeCount: 5, triOffset: 0, triCount: 4, originalToBvhMap: null, bvhData: null } );
		table.setAlias( 1, 0 );
		table.setEntry( { meshIndex: 2, blasNodeCount: 9, triOffset: 4, triCount: 8, originalToBvhMap: null, bvhData: null } );

		table.assignOffsets( 3 ); // 3 TLAS nodes

		expect( table.entries[ 0 ].blasOffset ).toBe( 3 );
		expect( table.entries[ 1 ].blasOffset ).toBe( 3 ); // shares the owner's nodes
		expect( table.entries[ 2 ].blasOffset ).toBe( 8 );
		// Only the two distinct BLASes are counted.
		expect( table.totalBLASNodes ).toBe( 14 );
		expect( table.totalNodeCount ).toBe( 17 );

	} );

} );
