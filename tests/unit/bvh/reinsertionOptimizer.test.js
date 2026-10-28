import { describe, it, expect, beforeEach } from 'vitest';
import { ReinsertionOptimizer } from '@/core/bvh/ReinsertionOptimizer.js';
import { BVHBuilder } from '@/core/bvh/BVHBuilder.js';
import { TRIANGLE_DATA_LAYOUT } from '@/core/scene/BufferLayout.js';
import { inspectBVH } from './bvhInvariants.js';

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

// Leaves along x, each paired with the one farthest from it: every inner box spans the whole row.
function scrambledTree( n ) {

	const leaves = Array.from( { length: n }, ( _, i ) => makeLeaf( i * 2, 0, 0, i * 2 + 1, 1, 1, i, 1 ) );
	let level = Array.from( { length: n / 2 }, ( _, i ) => makeInner( leaves[ i ], leaves[ n - 1 - i ] ) );
	while ( level.length > 1 ) level = Array.from( { length: level.length / 2 }, ( _, i ) => makeInner( level[ 2 * i ], level[ 2 * i + 1 ] ) );
	return level[ 0 ];

}

function orderedTree( n ) {

	let level = Array.from( { length: n }, ( _, i ) => makeLeaf( i * 2, 0, 0, i * 2 + 1, 1, 1, i, 1 ) );
	while ( level.length > 1 ) level = Array.from( { length: level.length / 2 }, ( _, i ) => makeInner( level[ 2 * i ], level[ 2 * i + 1 ] ) );
	return level[ 0 ];

}

const area = n => {

	const dx = n.maxX - n.minX, dy = n.maxY - n.minY, dz = n.maxZ - n.minZ;
	return dx * dy + dy * dz + dz * dx;

};

function sah( root ) {

	let cost = 0;
	const stack = [ root ];
	while ( stack.length ) {

		const n = stack.pop();
		if ( n.triangleCount > 0 ) cost += area( n ) * n.triangleCount * 2.5;
		else {

			cost += area( n );
			stack.push( n.leftChild, n.rightChild );

		}

	}

	return cost / area( root );

}

function treeProblems( root, triangleCount ) {

	const seen = new Set(), covered = new Uint8Array( triangleCount ), problems = [];
	const walk = node => {

		if ( seen.has( node ) ) return void problems.push( 'node reached twice' );
		seen.add( node );
		if ( node.triangleCount > 0 ) {

			for ( let t = node.triangleOffset; t < node.triangleOffset + node.triangleCount; t ++ ) covered[ t ] ++;
			return;

		}

		const { leftChild: l, rightChild: r } = node;
		if ( ! l || ! r ) return void problems.push( 'inner node without two children' );
		for ( const a of [ 'X', 'Y', 'Z' ] ) {

			if ( node[ `min${a}` ] !== Math.min( l[ `min${a}` ], r[ `min${a}` ] ) ) problems.push( `min${a} is not its children's` );
			if ( node[ `max${a}` ] !== Math.max( l[ `max${a}` ], r[ `max${a}` ] ) ) problems.push( `max${a} is not its children's` );

		}

		walk( l );
		walk( r );

	};

	walk( root );
	if ( covered.some( c => c !== 1 ) ) problems.push( 'a triangle is not under exactly one leaf' );
	return problems;

}

function shape( node ) {

	return node.triangleCount > 0 ? node.triangleOffset : [ shape( node.leftChild ), shape( node.rightChild ) ];

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

	describe( 'optimizeBVH', () => {

		it( 'moves nodes of a badly built tree into a valid tree of lower cost', () => {

			const root = scrambledTree( 32 );
			const before = sah( root );
			const progress = [];
			optimizer.setBatchSizeRatio( 0.1 );
			optimizer.setMaxIterations( 5 );

			const stats = optimizer.optimizeBVH( root, message => progress.push( message ) );
			expect( treeProblems( root, 32 ) ).toEqual( [] );
			expect( sah( root ) ).toBeLessThan( before );
			expect( stats.reinsertionsApplied ).toBeGreaterThan( 0 );
			expect( stats.iterations ).toBeGreaterThan( 1 );
			expect( optimizer.getStatistics() ).toEqual( stats );
			expect( progress[ 0 ] ).toBe( 'Reinsertion iter 1/5: selecting 6 candidates' );
			expect( progress[ 1 ] ).toMatch( /^Reinsertion iter 1: applied [1-9]\d* reinsertions$/ );

		} );

		it( 'carries a node over to the branch it belongs in, growing every box on its new path', () => {

			const stray = makeLeaf( 116, 0, 0, 140, 1, 1, 16, 1 );
			const offset = ( tree, dx, first ) => {

				const stack = [ tree ];
				while ( stack.length ) {

					const n = stack.pop();
					n.minX += dx;
					n.maxX += dx;
					if ( n.triangleCount ) n.triangleOffset += first;
					else stack.push( n.leftChild, n.rightChild );

				}

				return tree;

			};

			const near = orderedTree( 8 ), far = offset( orderedTree( 8 ), 100, 8 );
			const root = makeInner( makeInner( makeInner( near, stray ), far ), makeLeaf( - 200, 0, 0, - 199, 1, 1, 17, 1 ) );
			const before = sah( root );

			optimizer.setBatchSizeRatio( 0.1 );
			optimizer.optimizeBVH( root );
			expect( treeProblems( root, 18 ) ).toEqual( [] );
			const parent = optimizer.buildParentMap( root ).get( stray ).parent;
			const sibling = parent.leftChild === stray ? parent.rightChild : parent.leftChild;
			expect( sibling.minX ).toBeGreaterThanOrEqual( 100 );
			expect( sah( root ) ).toBeLessThan( before );

		} );

		it( 'reinserts deep in another branch, growing the boxes above its new place', () => {

			const leaf = ( x0, x1, i ) => makeLeaf( x0, 0, 0, x1, 1, 1, i, 1 );
			const stray = leaf( 132, 135, 2 ), target = leaf( 120, 130, 4 );
			const near = makeInner( leaf( 100, 110, 3 ), target );
			const root = makeInner(
				makeInner( makeInner( makeInner( leaf( 400, 401, 0 ), leaf( 402, 403, 1 ) ), stray ), makeInner( near, makeInner( leaf( 280, 290, 5 ), leaf( 292, 300, 6 ) ) ) ),
				leaf( - 200, - 199, 7 ),
			);
			const map = optimizer.buildParentMap( root );

			const move = optimizer.findReinsertion( stray, root, map );
			expect( move.to ).toBe( target );
			const before = sah( root );
			optimizer.reinsertNode( stray, target, map );
			expect( treeProblems( root, 8 ) ).toEqual( [] );
			expect( near.maxX ).toBe( 135 );
			expect( map.get( stray ).parent ).toBe( map.get( target ).parent );
			expect( sah( root ) ).toBeLessThan( before );

		} );

		it( 'never makes a tree worse, however many passes it runs', () => {

			const root = scrambledTree( 64 );
			let cost = sah( root );
			for ( let pass = 0; pass < 4; pass ++ ) {

				optimizer.optimizeBVH( root );
				expect( treeProblems( root, 64 ) ).toEqual( [] );
				expect( sah( root ) ).toBeLessThanOrEqual( cost + 1e-9 );
				cost = sah( root );

			}

		} );

		it( 'leaves a well-built tree as it is, stopping after one pass', () => {

			const root = orderedTree( 16 );
			const before = shape( root );
			const stats = optimizer.optimizeBVH( root );
			expect( stats.reinsertionsApplied ).toBe( 0 );
			expect( stats.iterations ).toBe( 1 );
			expect( shape( root ) ).toEqual( before );

		} );

		it( 'does nothing once out of time', () => {

			const root = scrambledTree( 16 );
			const before = shape( root );
			optimizer.timeBudgetMs = - 1;
			const stats = optimizer.optimizeBVH( root );
			expect( stats.iterations ).toBe( 0 );
			expect( shape( root ) ).toEqual( before );
			expect( stats.timeMs ).toBeGreaterThanOrEqual( 0 );

		} );

		it( 'finds no move for the root, nor one that puts a node back where it was', () => {

			const root = orderedTree( 8 );
			const map = optimizer.buildParentMap( root );
			expect( optimizer.findReinsertion( root, root, map ) ).toBeNull();
			const leaf = root.leftChild.leftChild.leftChild;
			const move = optimizer.findReinsertion( leaf, root, map );
			expect( move === null || ( move.to !== leaf && move.to !== root.leftChild.leftChild.rightChild ) ).toBe( true );

		} );

		it( 'names the nodes a move touches', () => {

			const root = orderedTree( 8 );
			const map = optimizer.buildParentMap( root );
			const from = root.leftChild.leftChild.leftChild, to = root.rightChild.rightChild;
			expect( optimizer.getConflicts( from, to, map ) ).toEqual( [ to, from, root.leftChild.leftChild.rightChild, root.rightChild, root.leftChild.leftChild ] );

		} );

		it( 'improves a BLAS the builder made, which still flattens to a valid BVH', () => {

			const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
			let seed = 3;
			const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;
			const data = new Uint32Array( 1200 * FPT );
			const f = new Float32Array( data.buffer );
			for ( let i = 0; i < 1200; i ++ ) {

				const x = rand() * 40, y = rand() * 40, z = rand() * 4;
				f.set( [ x, y, z ], i * FPT );
				f.set( [ x + rand(), y, z ], i * FPT + 4 );
				f.set( [ x, y + rand(), z + rand() ], i * FPT + 8 );

			}

			const build = reinsert => {

				const builder = new BVHBuilder();
				builder.enableReinsertionOptimization = reinsert;
				builder.setReinsertionConfig( { batchSizeRatio: 0.1, maxIterations: 5 } );
				const root = builder.buildSync( data.slice() );
				return { builder, root };

			};

			const plain = build( false );
			const { builder, root } = build( true );
			expect( builder.splitStats.reinsertionIterations ).toBeGreaterThan( 0 );
			expect( treeProblems( root, 1200 ) ).toEqual( [] );
			expect( sah( root ) ).toBeLessThanOrEqual( sah( plain.root ) );
			expect( inspectBVH( builder.flattenBVH( root ), builder.reorderedTriangleData ).problems ).toEqual( [] );

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
