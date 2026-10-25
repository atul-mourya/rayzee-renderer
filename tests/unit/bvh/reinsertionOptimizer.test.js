import { describe, it, expect, beforeEach } from 'vitest';
import { ReinsertionOptimizer } from '@/core/bvh/ReinsertionOptimizer.js';

function makeLeaf( minX, minY, minZ, maxX, maxY, maxZ, triOffset = 0, triCount = 1 ) {

	return {
		minX, minY, minZ, maxX, maxY, maxZ,
		leftChild: null, rightChild: null,
		triangleOffset: triOffset, triangleCount: triCount,
	};

}

function makeInner( left, right ) {

	return {
		minX: Math.min( left.minX, right.minX ),
		minY: Math.min( left.minY, right.minY ),
		minZ: Math.min( left.minZ, right.minZ ),
		maxX: Math.max( left.maxX, right.maxX ),
		maxY: Math.max( left.maxY, right.maxY ),
		maxZ: Math.max( left.maxZ, right.maxZ ),
		leftChild: left, rightChild: right,
		triangleOffset: 0, triangleCount: 0,
	};

}

describe( 'ReinsertionOptimizer', () => {

	let optimizer;

	beforeEach( () => {

		optimizer = new ReinsertionOptimizer( 1.0, 2.5 );

	} );

	// ── constructor ───────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'stores traversal and intersection costs', () => {

			expect( optimizer.traversalCost ).toBe( 1.0 );
			expect( optimizer.intersectionCost ).toBe( 2.5 );

		} );

		it( 'has sensible defaults', () => {

			expect( optimizer.batchSizeRatio ).toBe( 0.02 );
			expect( optimizer.maxIterations ).toBe( 2 );
			expect( optimizer.timeBudgetMs ).toBe( 15000 );

		} );

		it( 'initializes empty stats', () => {

			const stats = optimizer.getStatistics();
			expect( stats.reinsertionsApplied ).toBe( 0 );
			expect( stats.iterations ).toBe( 0 );
			expect( stats.timeMs ).toBe( 0 );

		} );

	} );

	// ── configuration ─────────────────────────────────────────

	describe( 'configuration', () => {

		it( 'setBatchSizeRatio clamps to [0.005, 0.1]', () => {

			optimizer.setBatchSizeRatio( 0.001 );
			expect( optimizer.batchSizeRatio ).toBe( 0.005 );

			optimizer.setBatchSizeRatio( 0.5 );
			expect( optimizer.batchSizeRatio ).toBe( 0.1 );

			optimizer.setBatchSizeRatio( 0.05 );
			expect( optimizer.batchSizeRatio ).toBe( 0.05 );

		} );

		it( 'setMaxIterations clamps to [1, 5]', () => {

			optimizer.setMaxIterations( 0 );
			expect( optimizer.maxIterations ).toBe( 1 );

			optimizer.setMaxIterations( 10 );
			expect( optimizer.maxIterations ).toBe( 5 );

			optimizer.setMaxIterations( 3 );
			expect( optimizer.maxIterations ).toBe( 3 );

		} );

	} );

	// ── surfaceArea ───────────────────────────────────────────

	describe( 'surfaceArea', () => {

		it( 'unit cube has half-SA = 3', () => {

			// dx*dy + dy*dz + dz*dx = 1+1+1 = 3
			const sa = optimizer.surfaceArea( { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 } );
			expect( sa ).toBeCloseTo( 3.0 );

		} );

		it( 'point has SA 0', () => {

			expect( optimizer.surfaceArea( { minX: 1, minY: 1, minZ: 1, maxX: 1, maxY: 1, maxZ: 1 } ) ).toBe( 0 );

		} );

		it( '2x3x4 box', () => {

			// dx=2, dy=3, dz=4 → 2*3 + 3*4 + 4*2 = 6+12+8 = 26
			const sa = optimizer.surfaceArea( { minX: 0, minY: 0, minZ: 0, maxX: 2, maxY: 3, maxZ: 4 } );
			expect( sa ).toBeCloseTo( 26.0 );

		} );

	} );

	// ── buildParentMap ────────────────────────────────────────

	describe( 'buildParentMap', () => {

		it( 'root has null parent', () => {

			const l = makeLeaf( 0, 0, 0, 1, 1, 1 );
			const r = makeLeaf( 2, 0, 0, 3, 1, 1 );
			const root = makeInner( l, r );

			const map = optimizer.buildParentMap( root );
			expect( map.get( root ).parent ).toBeNull();

		} );

		it( 'children point to parent', () => {

			const l = makeLeaf( 0, 0, 0, 1, 1, 1 );
			const r = makeLeaf( 2, 0, 0, 3, 1, 1 );
			const root = makeInner( l, r );

			const map = optimizer.buildParentMap( root );
			expect( map.get( l ).parent ).toBe( root );
			expect( map.get( l ).isLeft ).toBe( true );
			expect( map.get( r ).parent ).toBe( root );
			expect( map.get( r ).isLeft ).toBe( false );

		} );

		it( 'deep tree is mapped correctly', () => {

			const l1 = makeLeaf( 0, 0, 0, 1, 1, 1 );
			const l2 = makeLeaf( 2, 0, 0, 3, 1, 1 );
			const l3 = makeLeaf( 4, 0, 0, 5, 1, 1 );
			const inner = makeInner( l1, l2 );
			const root = makeInner( inner, l3 );

			const map = optimizer.buildParentMap( root );
			expect( map.get( l1 ).parent ).toBe( inner );
			expect( map.get( inner ).parent ).toBe( root );
			expect( map.size ).toBe( 5 );

		} );

	} );

	// ── findCandidates ────────────────────────────────────────

	describe( 'findCandidates', () => {

		it( 'returns empty for small tree (skips root direct children)', () => {

			const l = makeLeaf( 0, 0, 0, 1, 1, 1 );
			const r = makeLeaf( 2, 0, 0, 3, 1, 1 );
			const root = makeInner( l, r );

			const parentMap = optimizer.buildParentMap( root );
			const candidates = optimizer.findCandidates( root, 5, parentMap );
			// Direct children of root are skipped
			expect( candidates ).toHaveLength( 0 );

		} );

		it( 'finds candidates in deeper tree', () => {

			const l1 = makeLeaf( 0, 0, 0, 1, 1, 1 );
			const l2 = makeLeaf( 2, 0, 0, 3, 1, 1 );
			const l3 = makeLeaf( 10, 0, 0, 11, 1, 1 );
			const l4 = makeLeaf( 20, 0, 0, 21, 1, 1 );
			const inner1 = makeInner( l1, l2 );
			const inner2 = makeInner( l3, l4 );
			const root = makeInner( inner1, inner2 );

			const parentMap = optimizer.buildParentMap( root );
			const candidates = optimizer.findCandidates( root, 10, parentMap );
			// l1, l2 are grandchildren (parent=inner1, not root) → candidates
			// l3, l4 are grandchildren (parent=inner2, not root) → candidates
			expect( candidates.length ).toBeGreaterThan( 0 );

		} );

	} );

	// ── getStatistics ─────────────────────────────────────────

	describe( 'getStatistics', () => {

		it( 'returns a copy of stats', () => {

			const stats = optimizer.getStatistics();
			stats.reinsertionsApplied = 999;
			expect( optimizer.stats.reinsertionsApplied ).toBe( 0 );

		} );

	} );

} );
