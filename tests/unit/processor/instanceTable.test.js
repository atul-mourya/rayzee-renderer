import { describe, it, expect } from 'vitest';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';

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

	return new Float32Array( [
		lMin[ 0 ], lMin[ 1 ], lMin[ 2 ], leftIdx,
		lMax[ 0 ], lMax[ 1 ], lMax[ 2 ], rightIdx,
		rMin[ 0 ], rMin[ 1 ], rMin[ 2 ], 0,
		rMax[ 0 ], rMax[ 1 ], rMax[ 2 ], 0,
	] );

}

// BVH leaf node: [triOffset, triCount, 0, -1, ...]
function makeLeaf( triOffset, triCount ) {

	return new Float32Array( [ triOffset, triCount, 0, - 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ] );

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
			expect( Array.from( table.triOffset ) ).toEqual( [ 0, 5, 20 ] );

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
			expect( Array.from( table.blasOffset ) ).toEqual( [ 7, 17, 37 ] ); // 7, +10, +20
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

			expect( Array.from( table.worldAABB.slice( 0, 6 ) ) ).toEqual( [ 0, 0, 0, 10, 10, 10 ] );

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

			expect( Array.from( table.worldAABB.slice( 0, 6 ) ) ).toEqual( [ - 1, - 2, - 3, 10, 11, 12 ] );

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

			expect( table.worldAABB[ 0 ] ).toBe( - 5 );
			expect( table.worldAABB[ 3 ] ).toBe( 15 );

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
