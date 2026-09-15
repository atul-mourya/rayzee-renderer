import { describe, it, expect, beforeEach } from 'vitest';
import { BVHRefitter } from '@/core/Processor/BVHRefitter.js';
import { BVH_LEAF_MARKERS } from '@/core/EngineDefaults.js';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';
import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';

// Index fields are u32 bit patterns inside the float buffer.
const _u = new Uint32Array( 1 ), _f = new Float32Array( _u.buffer );
function bits( u ) {

	_u[ 0 ] = u;
	return _f[ 0 ];

}

// BVH flat layout: 16 floats per node. Bounds are floats; index fields are u32 bit patterns.
// Inner: [leftMin.xyz, leftChildIdx, leftMax.xyz, rightChildIdx, rightMin.xyz, 0, rightMax.xyz, 0]
// Leaf:  [triOffset, triCount, 0, TRIANGLE_LEAF, 0,0,0,0, 0,0,0,0, 0,0,0,0]

function makeLeaf( triOffset, triCount ) {

	return [ bits( triOffset ), bits( triCount ), 0, bits( BVH_LEAF_MARKERS.TRIANGLE_LEAF ), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 ];

}

function makeInner( lMin, lMax, leftIdx, rMin, rMax, rightIdx ) {

	return [
		lMin[ 0 ], lMin[ 1 ], lMin[ 2 ], bits( leftIdx ),
		lMax[ 0 ], lMax[ 1 ], lMax[ 2 ], bits( rightIdx ),
		rMin[ 0 ], rMin[ 1 ], rMin[ 2 ], 0,
		rMax[ 0 ], rMax[ 1 ], rMax[ 2 ], 0,
	];

}

// Triangle record: 20 uint lanes, positions f32 at 0,1,2 (A), 4,5,6 (B), 8,9,10 (C)
const FPT = 20;

function makeRecords( count ) {

	const data = new Uint32Array( count * FPT );
	return { data, f: new Float32Array( data.buffer ) };

}

function makeTriangle( ax, ay, az, bx, by, bz, cx, cy, cz ) {

	const { data, f } = makeRecords( 1 );
	f[ 0 ] = ax; f[ 1 ] = ay; f[ 2 ] = az; // posA
	f[ 4 ] = bx; f[ 5 ] = by; f[ 6 ] = bz; // posB
	f[ 8 ] = cx; f[ 9 ] = cy; f[ 10 ] = cz; // posC
	return data;

}

// Octahedral decode, mirroring unpackNormalOct in EngineDefaults.
function unpackOct( packed ) {

	const u = ( ( packed << 16 ) >> 16 ) / 32767;
	const v = ( packed >> 16 ) / 32767;
	let x = u, y = v;
	const z = 1 - Math.abs( u ) - Math.abs( v );
	if ( z < 0 ) {

		const ax = x, ay = y;
		x = ( 1 - Math.abs( ay ) ) * ( ax >= 0 ? 1 : - 1 );
		y = ( 1 - Math.abs( ax ) ) * ( ay >= 0 ? 1 : - 1 );

	}

	const len = Math.hypot( x, y, z ) || 1;
	return [ x / len, y / len, z / len ];

}

describe( 'BVHRefitter', () => {

	let refitter;

	beforeEach( () => {

		refitter = new BVHRefitter();

	} );

	describe( 'updateTrianglePositions', () => {

		it( 'patches positions using bvhToOriginal map', () => {

			// 2 triangles, BVH order: bvh[0]=orig[1], bvh[1]=orig[0]
			const { data: triangleData, f } = makeRecords( 2 );
			const newPositions = new Float32Array( [
				1, 2, 3, 4, 5, 6, 7, 8, 9, // original tri 0
				10, 20, 30, 40, 50, 60, 70, 80, 90 // original tri 1
			] );
			// bvhToOriginal: bvh[0]→orig[1], bvh[1]→orig[0]
			const bvhToOriginal = new Uint32Array( [ 1, 0 ] );

			refitter.updateTrianglePositions( triangleData, newPositions, bvhToOriginal );

			// bvh index 0 should have original tri 1 positions
			expect( f[ 0 ] ).toBe( 10 ); // posA.x
			expect( f[ 1 ] ).toBe( 20 ); // posA.y
			expect( f[ 2 ] ).toBe( 30 ); // posA.z
			expect( f[ 4 ] ).toBe( 40 ); // posB.x
			expect( f[ 8 ] ).toBe( 70 ); // posC.x

			// bvh index 1 should have original tri 0 positions
			expect( f[ FPT ] ).toBe( 1 ); // posA.x
			expect( f[ FPT + 4 ] ).toBe( 4 ); // posB.x
			expect( f[ FPT + 8 ] ).toBe( 7 ); // posC.x

		} );

		it( 'computes face normals', () => {

			const { data: triangleData } = makeRecords( 1 );
			// Triangle in XY plane: A=(0,0,0), B=(1,0,0), C=(0,1,0) → normal (0,0,1)
			const newPositions = new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
			const bvhToOriginal = new Uint32Array( [ 0 ] );

			refitter.updateTrianglePositions( triangleData, newPositions, bvhToOriginal );

			// Packed normals ride in each position's spare lane (3, 7, 11).
			for ( const lane of [ 3, 7, 11 ] ) {

				const n = unpackOct( triangleData[ lane ] );
				expect( n[ 0 ] ).toBeCloseTo( 0, 4 );
				expect( n[ 1 ] ).toBeCloseTo( 0, 4 );
				expect( n[ 2 ] ).toBeCloseTo( 1, 4 );

			}

		} );

	} );

	describe( 'refit', () => {

		it( 'updates inner node AABBs from leaf triangle data', () => {

			// Simple 3-node tree: root (inner) → left leaf (tri 0) + right leaf (tri 1)
			// Pre-order: [root=0, leftLeaf=1, rightLeaf=2]
			const bvhData = new Float32Array( [
				// Node 0 (inner): children at 1 and 2 — AABBs will be overwritten
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 2 ),
				// Node 1 (leaf): triOffset=0, triCount=1
				...makeLeaf( 0, 1 ),
				// Node 2 (leaf): triOffset=1, triCount=1
				...makeLeaf( 1, 1 ),
			] );

			// Two triangles
			const tri0 = makeTriangle( 0, 0, 0, 1, 0, 0, 0, 1, 0 );
			const tri1 = makeTriangle( 5, 5, 5, 6, 5, 5, 5, 6, 5 );
			const triangleData = new Uint32Array( 2 * FPT );
			triangleData.set( tri0, 0 );
			triangleData.set( tri1, FPT );

			refitter.refit( bvhData, triangleData, 3 );

			// After refit, root's left child AABB = tri0 bounds = (0,0,0)→(1,1,0)
			expect( bvhData[ 0 ] ).toBe( 0 ); // leftMin.x
			expect( bvhData[ 1 ] ).toBe( 0 ); // leftMin.y
			expect( bvhData[ 2 ] ).toBe( 0 ); // leftMin.z
			expect( bvhData[ 4 ] ).toBe( 1 ); // leftMax.x
			expect( bvhData[ 5 ] ).toBe( 1 ); // leftMax.y
			expect( bvhData[ 6 ] ).toBe( 0 ); // leftMax.z

			// Root's right child AABB = tri1 bounds = (5,5,5)→(6,6,5)
			expect( bvhData[ 8 ] ).toBe( 5 ); // rightMin.x
			expect( bvhData[ 12 ] ).toBe( 6 ); // rightMax.x
			expect( bvhData[ 13 ] ).toBe( 6 ); // rightMax.y
			expect( bvhData[ 14 ] ).toBe( 5 ); // rightMax.z

		} );

		it( 'reuses bounds buffer across calls', () => {

			const bvhData = new Float32Array( [
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 2, 2, 2 ], [ 3, 3, 3 ], 2 ),
				...makeLeaf( 0, 1 ),
				...makeLeaf( 1, 1 ),
			] );

			const triangleData = new Uint32Array( 2 * FPT );
			triangleData.set( makeTriangle( 0, 0, 0, 1, 0, 0, 0, 1, 0 ), 0 );
			triangleData.set( makeTriangle( 2, 2, 2, 3, 2, 2, 2, 3, 2 ), FPT );

			refitter.refit( bvhData, triangleData, 3 );
			const firstBounds = refitter._bounds;

			refitter.refit( bvhData, triangleData, 3 );
			expect( refitter._bounds ).toBe( firstBounds ); // same buffer reused

		} );

		it( 'handles deeper trees correctly', () => {

			// 5-node tree:
			// root(0) → left(1), right(2)
			// left(1) → leaf(3, tri 0), leaf(4, tri 1)
			// right(2) = leaf(tri 2)
			const bvhData = new Float32Array( [
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 2 ), // 0: root
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 3, [ 0, 0, 0 ], [ 1, 1, 1 ], 4 ), // 1: inner
				...makeLeaf( 2, 1 ), // 2: right leaf (tri 2)
				...makeLeaf( 0, 1 ), // 3: left-left leaf (tri 0)
				...makeLeaf( 1, 1 ), // 4: left-right leaf (tri 1)
			] );

			const triangleData = new Uint32Array( 3 * FPT );
			triangleData.set( makeTriangle( - 1, - 1, - 1, 0, - 1, - 1, - 1, 0, - 1 ), 0 );
			triangleData.set( makeTriangle( 1, 1, 1, 2, 1, 1, 1, 2, 1 ), FPT );
			triangleData.set( makeTriangle( 10, 10, 10, 11, 10, 10, 10, 11, 10 ), 2 * FPT );

			refitter.refit( bvhData, triangleData, 5 );

			// Node 1's left child (node 3) = tri 0 bounds = (-1,-1,-1)→(0,0,-1)
			expect( bvhData[ 16 + 0 ] ).toBe( - 1 ); // leftMin.x
			expect( bvhData[ 16 + 4 ] ).toBe( 0 ); // leftMax.x

			// Root's right child (node 2) = tri 2 bounds = (10,10,10)→(11,11,10)
			expect( bvhData[ 8 ] ).toBe( 10 ); // rightMin.x
			expect( bvhData[ 12 ] ).toBe( 11 ); // rightMax.x

		} );

	} );

	describe( 'refitRange (per-BLAS sub-range)', () => {

		it( 'refits only the specified node range', () => {

			// Combined buffer: 2 "TLAS" placeholder nodes + 3 BLAS nodes
			// BLAS is a 3-node tree at indices [2,3,4]: inner(2) → leaf(3, tri 0), leaf(4, tri 1)
			const bvhData = new Float32Array( [
				// Node 0, 1: TLAS placeholders (not touched by refitRange)
				...new Array( 32 ).fill( 999 ),
				// Node 2 (inner): children at 3 and 4
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 3, [ 0, 0, 0 ], [ 1, 1, 1 ], 4 ),
				// Node 3 (leaf): triOffset=0, triCount=1
				...makeLeaf( 0, 1 ),
				// Node 4 (leaf): triOffset=1, triCount=1
				...makeLeaf( 1, 1 ),
			] );

			const tri0 = makeTriangle( 0, 0, 0, 2, 0, 0, 0, 2, 0 );
			const tri1 = makeTriangle( 10, 10, 10, 12, 10, 10, 10, 12, 10 );
			const triangleData = new Uint32Array( 2 * FPT );
			triangleData.set( tri0, 0 );
			triangleData.set( tri1, FPT );

			refitter.refitRange( bvhData, triangleData, 2, 3 ); // startNode=2, nodeCount=3

			// TLAS nodes should be untouched
			expect( bvhData[ 0 ] ).toBe( 999 );

			// BLAS root (node 2) should have updated AABBs
			// Left child (node 3) = tri0 bounds: (0,0,0)→(2,2,0)
			expect( bvhData[ 32 + 0 ] ).toBe( 0 ); // leftMin.x
			expect( bvhData[ 32 + 4 ] ).toBe( 2 ); // leftMax.x
			expect( bvhData[ 32 + 5 ] ).toBe( 2 ); // leftMax.y
			// Right child (node 4) = tri1 bounds: (10,10,10)→(12,12,10)
			expect( bvhData[ 32 + 8 ] ).toBe( 10 ); // rightMin.x
			expect( bvhData[ 32 + 12 ] ).toBe( 12 ); // rightMax.x

		} );

		it( 'grow-only bounds buffer avoids reallocation on smaller subsequent calls', () => {

			const bvhData = new Float32Array( [
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 2 ),
				...makeLeaf( 0, 1 ),
				...makeLeaf( 1, 1 ),
			] );
			const triangleData = new Uint32Array( 2 * FPT );
			triangleData.set( makeTriangle( 0, 0, 0, 1, 0, 0, 0, 1, 0 ), 0 );
			triangleData.set( makeTriangle( 2, 2, 2, 3, 2, 2, 2, 3, 2 ), FPT );

			// First call with 3 nodes
			refitter.refitRange( bvhData, triangleData, 0, 3 );
			const firstBounds = refitter._bounds;
			expect( refitter._boundsNodeCount ).toBe( 3 );

			// Second call with 1 node (smaller) — should NOT reallocate
			const smallBvh = new Float32Array( [ ...makeLeaf( 0, 1 ) ] );
			refitter.refitRange( smallBvh, triangleData, 0, 1 );
			expect( refitter._bounds ).toBe( firstBounds );
			expect( refitter._boundsNodeCount ).toBe( 3 ); // Still 3 (grow-only)

		} );

	} );

	describe( 'refit with BLAS-pointer nodes', () => {

		it( 'reads BLAS root bounds for TLAS BLAS-pointer leaves', () => {

			// Combined buffer simulating TLAS/BLAS layout:
			// Node 0: TLAS inner → children 1, 2
			// Node 1: TLAS BLAS-pointer leaf → blasRoot = 3
			// Node 2: TLAS BLAS-pointer leaf → blasRoot = 5
			// Node 3: BLAS0 inner → children 4 (unused, just for bounds)
			// Node 4: BLAS0 leaf (tri 0)
			// Node 5: BLAS1 inner → children 6 (unused)
			// Node 6: BLAS1 leaf (tri 1)

			// Simplified: BLAS roots are inner nodes whose bounds we already know
			const bvhData = new Float32Array( [
				// Node 0: TLAS root inner (AABBs will be overwritten by refit)
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 2 ),
				// Node 1: TLAS BLAS-pointer leaf → blasRoot=3
				bits( 3 ), 0, 0, bits( BVH_LEAF_MARKERS.BLAS_POINTER_LEAF ), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
				// Node 2: TLAS BLAS-pointer leaf → blasRoot=5
				bits( 5 ), 0, 0, bits( BVH_LEAF_MARKERS.BLAS_POINTER_LEAF ), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
				// Node 3: BLAS0 root (inner) → leaf at 4
				...makeInner( [ 0, 0, 0 ], [ 3, 3, 3 ], 4, [ 0, 0, 0 ], [ 3, 3, 3 ], 4 ),
				// Node 4: BLAS0 leaf (tri 0)
				...makeLeaf( 0, 1 ),
				// Node 5: BLAS1 root (inner) → leaf at 6
				...makeInner( [ 10, 10, 10 ], [ 13, 13, 13 ], 6, [ 10, 10, 10 ], [ 13, 13, 13 ], 6 ),
				// Node 6: BLAS1 leaf (tri 1)
				...makeLeaf( 1, 1 ),
			] );

			const tri0 = makeTriangle( 0, 0, 0, 3, 0, 0, 0, 3, 3 );
			const tri1 = makeTriangle( 10, 10, 10, 13, 10, 10, 10, 13, 13 );
			const triangleData = new Uint32Array( 2 * FPT );
			triangleData.set( tri0, 0 );
			triangleData.set( tri1, FPT );

			refitter.refit( bvhData, triangleData, 7 );

			// TLAS root (node 0) should have:
			// Left child AABB = BLAS0 root bounds = (0,0,0)→(3,3,3)
			expect( bvhData[ 0 ] ).toBe( 0 ); // leftMin.x
			expect( bvhData[ 1 ] ).toBe( 0 ); // leftMin.y
			expect( bvhData[ 4 ] ).toBe( 3 ); // leftMax.x
			expect( bvhData[ 5 ] ).toBe( 3 ); // leftMax.y
			expect( bvhData[ 6 ] ).toBe( 3 ); // leftMax.z

			// Right child AABB = BLAS1 root bounds = (10,10,10)→(13,13,13)
			expect( bvhData[ 8 ] ).toBe( 10 ); // rightMin.x
			expect( bvhData[ 12 ] ).toBe( 13 ); // rightMax.x
			expect( bvhData[ 13 ] ).toBe( 13 ); // rightMax.y

		} );

		// Moana's ocean: a unit quad scaled to ±1,089,735, so the world-to-object matrix on the
		// leaf has a determinant of 7.7e-19. An absolute singular-matrix floor called that
		// degenerate and copied the unit quad's bounds through as world bounds, so the TLAS root
		// collapsed from ±1,089,735 to ±1 on every refit — with the render still looking fine.
		it.each( [ 1, 1e3, 1e6, 1e-3 ] )( 'carries BLAS bounds out through a %f× instance scale', scale => {

			const inv = 1 / scale;
			// Leaf slots 4..15 are the rows of world-to-object: a uniform 1/scale with no offset.
			const leaf = [
				bits( 2 ), 0, 0, bits( BVH_LEAF_MARKERS.BLAS_POINTER_LEAF ),
				inv, 0, 0, 0,
				0, inv, 0, 0,
				0, 0, inv, 0,
			];

			const bvhData = new Float32Array( [
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 1 ),
				...leaf,
				...makeInner( [ - 1, - 1, - 1 ], [ 1, 1, 1 ], 3, [ - 1, - 1, - 1 ], [ 1, 1, 1 ], 3 ),
				...makeLeaf( 0, 1 ),
			] );

			const triangleData = new Uint32Array( FPT );
			triangleData.set( makeTriangle( - 1, - 1, - 1, 1, - 1, - 1, - 1, 1, 1 ), 0 );

			new BVHRefitter().refit( bvhData, triangleData, 4 );

			// The unit-ish BLAS box must come back out at instance scale, not object scale.
			expect( bvhData[ 0 ] ).toBeCloseTo( - scale, Math.max( 0, 6 - Math.log10( scale ) ) );
			expect( bvhData[ 4 ] ).toBeCloseTo( scale, Math.max( 0, 6 - Math.log10( scale ) ) );

		} );

		it( 'still treats a genuinely singular instance matrix as untransformed', () => {

			const leaf = [
				bits( 2 ), 0, 0, bits( BVH_LEAF_MARKERS.BLAS_POINTER_LEAF ),
				1, 0, 0, 0,
				2, 0, 0, 0, // second row is a multiple of the first — rank 2, not invertible
				0, 0, 1, 0,
			];

			const bvhData = new Float32Array( [
				...makeInner( [ 0, 0, 0 ], [ 1, 1, 1 ], 1, [ 0, 0, 0 ], [ 1, 1, 1 ], 1 ),
				...leaf,
				...makeInner( [ - 1, - 1, - 1 ], [ 1, 1, 1 ], 3, [ - 1, - 1, - 1 ], [ 1, 1, 1 ], 3 ),
				...makeLeaf( 0, 1 ),
			] );

			const triangleData = new Uint32Array( FPT );
			triangleData.set( makeTriangle( - 1, - 1, - 1, 1, - 1, - 1, - 1, 1, 1 ), 0 );

			new BVHRefitter().refit( bvhData, triangleData, 4 );

			expect( bvhData[ 0 ] ).toBe( - 1 );
			expect( bvhData[ 4 ] ).toBe( 1 );

		} );

	} );

} );

describe( 'SceneProcessor.sceneBounds', () => {

	it( 'unions both child boxes, because node 0 holds two subtrees and not the scene', () => {

		// The trap: the first six floats are child A alone. A reader that takes them as the
		// scene box gets a number that moves whenever the tree rebalances, while the real
		// bounds never changed.
		const sp = Object.create( SceneProcessor.prototype );
		sp.bvh = ChunkedRecords.adopt( [ Float32Array.from( [
			- 5, 0, 0, 0, /* A max */ 1, 1, 1, 0,
			0, - 7, 0, 0, /* B max */ 2, 2, 9, 0,
		] ) ], 1, 16, 1 );

		expect( sp.sceneBounds() ).toEqual( { min: [ - 5, - 7, 0 ], max: [ 2, 2, 9 ] } );

	} );

	it( 'returns null before a BVH exists rather than decoding an empty buffer', () => {

		const sp = Object.create( SceneProcessor.prototype );
		sp.bvh = null;
		expect( sp.sceneBounds() ).toBeNull();

	} );

} );
