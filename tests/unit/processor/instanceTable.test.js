import { describe, it, expect } from 'vitest';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { BVH_LEAF_MARKERS, bvhIndexView } from '@/core/EngineDefaults.js';

// Triangle record: 20 uint lanes; positions f32 at 0,1,2 (A), 4,5,6 (B), 8,9,10 (C)
const FPT = 20;

function makeTriangle( ax, ay, az, bx, by, bz, cx, cy, cz ) {

	const data = new Uint32Array( FPT );
	const f = new Float32Array( data.buffer );
	f[ 0 ] = ax; f[ 1 ] = ay; f[ 2 ] = az;
	f[ 4 ] = bx; f[ 5 ] = by; f[ 6 ] = bz;
	f[ 8 ] = cx; f[ 9 ] = cy; f[ 10 ] = cz;
	return data;

}

// BVH inner node: [leftMin.xyz, leftChild, leftMax.xyz, rightChild, rightMin.xyz, 0, rightMax.xyz, 0]
function makeInner( lMin, lMax, leftIdx, rMin, rMax, rightIdx ) {

	const n = new Float32Array( [
		lMin[ 0 ], lMin[ 1 ], lMin[ 2 ], 0,
		lMax[ 0 ], lMax[ 1 ], lMax[ 2 ], 0,
		rMin[ 0 ], rMin[ 1 ], rMin[ 2 ], 0,
		rMax[ 0 ], rMax[ 1 ], rMax[ 2 ], 0,
	] );
	const idx = bvhIndexView( n );
	idx[ 3 ] = leftIdx; idx[ 7 ] = rightIdx;
	return n;

}

/** Every placement's world-space bounds, which the table derives rather than stores. */
function worldBounds( table ) {

	const out = new Float64Array( table.count * 6 );
	table.writeWorldAABBs( out );
	return out;

}

// BVH leaf node: [triOffset, triCount, 0, -1, ...]
function makeLeaf( triOffset, triCount ) {

	const n = new Float32Array( 16 );
	const idx = bvhIndexView( n );
	idx[ 0 ] = triOffset; idx[ 1 ] = triCount; idx[ 3 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
	return n;

}

describe( 'InstanceTable', () => {

	describe( 'allocate and setEntry', () => {

		it( 'pre-allocates entries array with null slots', () => {

			const table = new InstanceTable();
			table.allocate( 3 );
			expect( table.count ).toBe( 3 );
			expect( table.setCount ).toBe( 0 );
			expect( Array.from( table.isSet ) ).toEqual( [ 0, 0, 0 ] );

		} );

		it( 'sets entries at correct meshIndex positions regardless of insertion order', () => {

			const table = new InstanceTable();
			table.allocate( 3 );

			// Insert out of order (simulating async-first build)
			table.setEntry( { meshIndex: 2, blasNodeCount: 5, triOffset: 20, triCount: 10, originalToBvhMap: null, bvhData: new Float32Array( 80 ) } );
			table.setEntry( { meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 5, originalToBvhMap: null, bvhData: new Float32Array( 48 ) } );
			table.setEntry( { meshIndex: 1, blasNodeCount: 7, triOffset: 5, triCount: 15, originalToBvhMap: null, bvhData: new Float32Array( 112 ) } );

			expect( table.setCount ).toBe( 3 );
			expect( [ 0, 1, 2 ].map( i => table.triOffsetOf( i ) ) ).toEqual( [ 0, 5, 20 ] );

		} );

	} );

	describe( 'assignOffsets', () => {

		it( 'assigns sequential BLAS offsets after TLAS nodes', () => {

			const table = new InstanceTable();
			table.allocate( 3 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 10, triOffset: 0, triCount: 5, originalToBvhMap: null, bvhData: new Float32Array( 160 ) } );
			table.setEntry( { meshIndex: 1, blasNodeCount: 20, triOffset: 5, triCount: 8, originalToBvhMap: null, bvhData: new Float32Array( 320 ) } );
			table.setEntry( { meshIndex: 2, blasNodeCount: 5, triOffset: 13, triCount: 3, originalToBvhMap: null, bvhData: new Float32Array( 80 ) } );

			table.assignOffsets( 7 ); // 7 TLAS nodes

			expect( table.tlasNodeCount ).toBe( 7 );
			expect( [ 0, 1, 2 ].map( i => table.blasOffsetOf( i ) ) ).toEqual( [ 7, 17, 37 ] ); // 7, +10, +20
			expect( table.totalBLASNodes ).toBe( 35 ); // 10 + 20 + 5
			expect( table.totalNodeCount ).toBe( 42 ); // 7 + 35

		} );

	} );

	describe( 'computeAABBs', () => {

		it( 'reads AABB from inner root node (O(1) path)', () => {

			const table = new InstanceTable();
			table.allocate( 1 );

			// Inner root with left child AABB (1,2,3)→(4,5,6) and right child AABB (0,0,0)→(10,10,10)
			const bvhData = makeInner( [ 1, 2, 3 ], [ 4, 5, 6 ], 1, [ 0, 0, 0 ], [ 10, 10, 10 ], 2 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 2, originalToBvhMap: null, bvhData } );

			table.computeAABBs( new Float32Array( 64 ) );

			expect( Array.from( worldBounds( table ) ) ).toEqual( [ 0, 0, 0, 10, 10, 10 ] );

		} );

		it( 'falls back to triangle scan for leaf root (very small mesh)', () => {

			const table = new InstanceTable();
			table.allocate( 1 );

			// Leaf root — mesh has ≤ maxLeafSize triangles
			const bvhData = makeLeaf( 0, 2 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 1, triOffset: 0, triCount: 2, originalToBvhMap: null, bvhData } );

			const triangleData = new Uint32Array( 2 * FPT );
			triangleData.set( makeTriangle( 1, 2, 3, 4, 5, 6, 7, 8, 9 ), 0 );
			triangleData.set( makeTriangle( - 1, - 2, - 3, 10, 11, 12, 0, 0, 0 ), FPT );

			table.computeAABBs( triangleData );

			expect( Array.from( worldBounds( table ) ) ).toEqual( [ - 1, - 2, - 3, 10, 11, 12 ] );

		} );

	} );

	describe( 'recomputeAABB', () => {

		it( 'reads updated AABB from combined buffer at BLAS offset', () => {

			const table = new InstanceTable();
			table.allocate( 1 );

			const bvhData = makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 2 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 2, originalToBvhMap: null, bvhData } );
			table.assignOffsets( 5 ); // BLAS starts at node 5

			// Build a combined buffer with BLAS root at offset 5
			const combinedBvh = new Float32Array( 128 ); // 8 nodes worth
			const updatedRoot = makeInner( [ - 5, - 5, - 5 ], [ 15, 15, 15 ], 6, [ 2, 2, 2 ], [ 8, 8, 8 ], 7 );
			combinedBvh.set( updatedRoot, 5 * 16 );

			table.recomputeAABB( 0, combinedBvh, new Float32Array( 64 ) );

			const bounds = worldBounds( table );
			expect( bounds[ 0 ] ).toBe( - 5 );
			expect( bounds[ 3 ] ).toBe( 15 );

		} );

	} );

	describe( 'normalisation', () => {

		it( 'stores triangle ranges once per template, not once per placement', () => {

			// One template, a million placements: the per-template columns must not scale with n.
			const table = new InstanceTable();
			table.allocate( 1000, 1 );
			table.setEntry( {
				meshIndex: 0, blasNodeCount: 3, triOffset: 40, triCount: 7,
				originalToBvhMap: null, bvhData: null, sourceMesh: 0, expandedStart: 11
			} );
			for ( let i = 1; i < 1000; i ++ ) table.setAlias( i, 0, null, null, 0 );

			expect( table.tplTriOffset ).toHaveLength( 1 );
			expect( table.tplTriCount ).toHaveLength( 1 );
			expect( table.tplObjectAABB ).toHaveLength( 6 );
			// ...while every placement still reads its own values back.
			expect( table.triOffsetOf( 999 ) ).toBe( 40 );
			expect( table.triCountOf( 999 ) ).toBe( 7 );
			expect( table.expandedStartOf( 999 ) ).toBe( 11 );
			expect( table.isOwner( 0 ) ).toBe( true );
			expect( table.isOwner( 999 ) ).toBe( false );

		} );

		it( 'adopts a caller-supplied matrix pool instead of copying it', () => {

			const pool = new Float32Array( 2 * 16 );
			pool.set( [ 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1 ], 16 );

			const table = new InstanceTable();
			table.allocate( 2, 2, pool );
			expect( table.world ).toBe( pool );

			// Passing the pool back as the matrix must not rewrite what is already there.
			table.setEntry( {
				meshIndex: 1, blasNodeCount: 1, triOffset: 0, triCount: 1,
				originalToBvhMap: null, bvhData: null, matrixWorld: pool, matrixOffset: 16
			} );
			expect( Array.from( table.matrixWorldOf( 1 ) ) ).toEqual( [ 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 1 ] );
			expect( table.flipWinding[ 1 ] ).toBe( 0 );

		} );

		it( 'flags a mirroring transform read out of a pool', () => {

			const pool = new Float32Array( 16 );
			pool.set( [ - 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ] );

			const table = new InstanceTable();
			table.allocate( 1, 1, pool );
			table.setEntry( {
				meshIndex: 0, blasNodeCount: 1, triOffset: 0, triCount: 1,
				originalToBvhMap: null, bvhData: null, matrixWorld: pool, matrixOffset: 0
			} );
			expect( table.flipWinding[ 0 ] ).toBe( 1 );

		} );

		it( 'derives world bounds from the template box and the placement transform', () => {

			const table = new InstanceTable();
			table.allocate( 2, 1 );
			table.setEntry( {
				meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 2, sourceMesh: 0,
				originalToBvhMap: null, bvhData: makeInner( [ 0, 0, 0 ], [ 2, 2, 2 ], 1, [ 0, 0, 0 ], [ 2, 2, 2 ], 2 )
			} );
			table.setAlias( 1, 0, [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 0, 0, 1 ], null, 0 );
			table.computeAABBs( new Float32Array( 64 ) );

			const bounds = worldBounds( table );
			expect( Array.from( bounds.slice( 0, 6 ) ) ).toEqual( [ 0, 0, 0, 2, 2, 2 ] );
			expect( Array.from( bounds.slice( 6, 12 ) ) ).toEqual( [ 10, 0, 0, 12, 2, 2 ] );

		} );

		it( 'writes zero bounds for a placement that was never built', () => {

			const table = new InstanceTable();
			table.allocate( 2, 2 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 1, triOffset: 0, triCount: 1, originalToBvhMap: null, bvhData: null } );
			expect( Array.from( worldBounds( table ).slice( 6, 12 ) ) ).toEqual( [ 0, 0, 0, 0, 0, 0 ] );

		} );

	} );

	describe( 'clear', () => {

		it( 'resets all state', () => {

			const table = new InstanceTable();
			table.allocate( 2 );
			table.setEntry( { meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 5, originalToBvhMap: null, bvhData: new Float32Array( 48 ) } );
			table.setEntry( { meshIndex: 1, blasNodeCount: 5, triOffset: 5, triCount: 8, originalToBvhMap: null, bvhData: new Float32Array( 80 ) } );
			table.assignOffsets( 5 );

			table.clear();

			expect( table.count ).toBe( 0 );
			expect( table.totalBLASNodes ).toBe( 0 );
			expect( table.tlasNodeCount ).toBe( 0 );

		} );

	} );

} );
