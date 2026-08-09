import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock( '@/core/Processor/TreeletOptimizer.js', () => ( {
	TreeletOptimizer: class {

		constructor() {

			this.stats = { treeletsProcessed: 0, treeletsImproved: 0, totalSAHImprovement: 0, averageSAHImprovement: 0, optimizationTime: 0 };

		}

		setTreeletSize() {}
		setMinImprovement() {}
		setMaxTreelets() {}
		optimizeBVH() {}
		getStatistics() {

			return this.stats;

		}

	}
} ) );

vi.mock( '@/core/Processor/ReinsertionOptimizer.js', () => ( {
	ReinsertionOptimizer: class {

		constructor() {

			this.stats = { reinsertionsApplied: 0, iterations: 0, timeMs: 0 };

		}

		setBatchSizeRatio() {}
		setMaxIterations() {}
		optimizeBVH() {}
		getStatistics() {

			return this.stats;

		}

	}
} ) );

import { BVHBuilder } from '@/core/Processor/BVHBuilder.js';

/**
 * Helper: create a Float32Array of triangle data (32 floats per triangle).
 * Each triangle is [ax, ay, az, bx, by, bz, cx, cy, cz].
 */
function makeTriData( triangles ) {

	const data = new Float32Array( triangles.length * 32 );
	for ( let i = 0; i < triangles.length; i ++ ) {

		const t = triangles[ i ];
		const b = i * 32;
		// posA at offset 0
		data[ b ] = t[ 0 ]; data[ b + 1 ] = t[ 1 ]; data[ b + 2 ] = t[ 2 ];
		// posB at offset 4
		data[ b + 4 ] = t[ 3 ]; data[ b + 5 ] = t[ 4 ]; data[ b + 6 ] = t[ 5 ];
		// posC at offset 8
		data[ b + 8 ] = t[ 6 ]; data[ b + 9 ] = t[ 7 ]; data[ b + 10 ] = t[ 8 ];

	}

	return data;

}

describe( 'BVHBuilder', () => {

	let builder;

	beforeEach( () => {

		builder = new BVHBuilder();
		// Disable optimizations that are too complex for unit tests
		builder.enableTreeletOptimization = false;
		builder.enableReinsertionOptimization = false;
		builder.useMortonCodes = false;

	} );

	// ── constructor ──────────────────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'sets default maxLeafSize to 8', () => {

			const b = new BVHBuilder();
			expect( b.maxLeafSize ).toBe( 8 );

		} );

		it( 'sets default numBins to 32', () => {

			const b = new BVHBuilder();
			expect( b.numBins ).toBe( 32 );

		} );

		it( 'sets default traversalCost to 1.0', () => {

			const b = new BVHBuilder();
			expect( b.traversalCost ).toBe( 1.0 );

		} );

		it( 'sets default intersectionCost to 2.5', () => {

			const b = new BVHBuilder();
			expect( b.intersectionCost ).toBe( 2.5 );

		} );

		it( 'pre-allocates bin arrays via initializeBinArrays', () => {

			const b = new BVHBuilder();
			expect( b.binBoundsMin ).toBeInstanceOf( Float32Array );
			expect( b.binCounts ).toBeInstanceOf( Uint32Array );
			expect( b.binBoundsMin.length ).toBe( b.maxBins * 3 );
			expect( b.binCounts.length ).toBe( b.maxBins );

		} );

	} );

	// ── getOptimalBinCount ───────────────────────────────────────────────

	describe( 'getOptimalBinCount', () => {

		it( 'returns minBins (8) for counts <= 16', () => {

			expect( builder.getOptimalBinCount( 1 ) ).toBe( 8 );
			expect( builder.getOptimalBinCount( 16 ) ).toBe( 8 );

		} );

		it( 'returns 16 for counts <= 64', () => {

			expect( builder.getOptimalBinCount( 17 ) ).toBe( 16 );
			expect( builder.getOptimalBinCount( 64 ) ).toBe( 16 );

		} );

		it( 'returns 32 for counts <= 256', () => {

			expect( builder.getOptimalBinCount( 65 ) ).toBe( 32 );
			expect( builder.getOptimalBinCount( 256 ) ).toBe( 32 );

		} );

		it( 'returns 48 for counts <= 1024', () => {

			expect( builder.getOptimalBinCount( 257 ) ).toBe( 48 );
			expect( builder.getOptimalBinCount( 1024 ) ).toBe( 48 );

		} );

		it( 'returns maxBins (64) for counts > 1024', () => {

			expect( builder.getOptimalBinCount( 1025 ) ).toBe( 64 );
			expect( builder.getOptimalBinCount( 100000 ) ).toBe( 64 );

		} );

	} );

	// ── expandBits ───────────────────────────────────────────────────────

	describe( 'expandBits', () => {

		it( 'expands 0 to 0', () => {

			expect( builder.expandBits( 0 ) ).toBe( 0 );

		} );

		it( 'expands 1 to 1', () => {

			expect( builder.expandBits( 1 ) ).toBe( 1 );

		} );

		it( 'expands 2 to 8 (bit 1 shifts to bit 3)', () => {

			// 2 = 0b10 → expanded = 0b1000 = 8
			expect( builder.expandBits( 2 ) ).toBe( 8 );

		} );

		it( 'expands 3 to 9 (bits 0,1 spread to positions 0,3)', () => {

			// 3 = 0b11 → expanded = 0b1001 = 9
			expect( builder.expandBits( 3 ) ).toBe( 9 );

		} );

		it( 'expands 4 to 64 (bit 2 shifts to bit 6)', () => {

			// 4 = 0b100 → expanded = 0b1000000 = 64
			expect( builder.expandBits( 4 ) ).toBe( 64 );

		} );

	} );

	// ── morton3D ─────────────────────────────────────────────────────────

	describe( 'morton3D', () => {

		it( 'returns 0 for (0,0,0)', () => {

			expect( builder.morton3D( 0, 0, 0 ) ).toBe( 0 );

		} );

		it( 'returns 1 for (1,0,0) — x occupies bit 0', () => {

			expect( builder.morton3D( 1, 0, 0 ) ).toBe( 1 );

		} );

		it( 'returns 2 for (0,1,0) — y occupies bit 1', () => {

			expect( builder.morton3D( 0, 1, 0 ) ).toBe( 2 );

		} );

		it( 'returns 4 for (0,0,1) — z occupies bit 2', () => {

			expect( builder.morton3D( 0, 0, 1 ) ).toBe( 4 );

		} );

		it( 'returns 7 for (1,1,1) — all low bits set', () => {

			expect( builder.morton3D( 1, 1, 1 ) ).toBe( 7 );

		} );

	} );

	// ── configuration methods ────────────────────────────────────────────

	describe( 'configuration methods', () => {

		describe( 'setAdaptiveBinConfig', () => {

			it( 'clamps minBins to at least 4', () => {

				builder.setAdaptiveBinConfig( { minBins: 1 } );
				expect( builder.minBins ).toBe( 4 );

			} );

			it( 'clamps maxBins to at most 128', () => {

				builder.setAdaptiveBinConfig( { maxBins: 256 } );
				expect( builder.maxBins ).toBe( 128 );

			} );

			it( 'sets baseBins on numBins', () => {

				builder.setAdaptiveBinConfig( { baseBins: 24 } );
				expect( builder.numBins ).toBe( 24 );

			} );

			it( 're-initializes bin arrays when maxBins changes', () => {

				builder.setAdaptiveBinConfig( { maxBins: 100 } );
				expect( builder.binBoundsMin.length ).toBe( 100 * 3 );
				expect( builder.binCounts.length ).toBe( 100 );

			} );

		} );

		describe( 'setMortonConfig', () => {

			it( 'clamps bits to [6, 10]', () => {

				builder.setMortonConfig( { bits: 2 } );
				expect( builder.mortonBits ).toBe( 6 );

				builder.setMortonConfig( { bits: 20 } );
				expect( builder.mortonBits ).toBe( 10 );

			} );

			it( 'clamps threshold to at least 16', () => {

				builder.setMortonConfig( { threshold: 5 } );
				expect( builder.mortonClusterThreshold ).toBe( 16 );

			} );

			it( 'sets enabled flag', () => {

				builder.setMortonConfig( { enabled: false } );
				expect( builder.useMortonCodes ).toBe( false );

			} );

		} );

		describe( 'setFallbackConfig', () => {

			it( 'sets objectMedian flag', () => {

				builder.setFallbackConfig( { objectMedian: false } );
				expect( builder.enableObjectMedianFallback ).toBe( false );

			} );

			it( 'sets spatialMedian flag', () => {

				builder.setFallbackConfig( { spatialMedian: false } );
				expect( builder.enableSpatialMedianFallback ).toBe( false );

			} );

		} );

		describe( 'setTreeletConfig', () => {

			it( 'clamps size to [3, 12]', () => {

				builder.setTreeletConfig( { size: 1 } );
				expect( builder.treeletSize ).toBe( 3 );

				builder.setTreeletConfig( { size: 50 } );
				expect( builder.treeletSize ).toBe( 12 );

			} );

			it( 'clamps passes to [1, 3]', () => {

				builder.setTreeletConfig( { passes: 0 } );
				expect( builder.treeletOptimizationPasses ).toBe( 1 );

				builder.setTreeletConfig( { passes: 10 } );
				expect( builder.treeletOptimizationPasses ).toBe( 3 );

			} );

			it( 'clamps minImprovement to at least 0.001', () => {

				builder.setTreeletConfig( { minImprovement: 0.0001 } );
				expect( builder.treeletMinImprovement ).toBe( 0.001 );

			} );

		} );

		describe( 'setReinsertionConfig', () => {

			it( 'clamps batchSizeRatio to [0.005, 0.1]', () => {

				builder.setReinsertionConfig( { batchSizeRatio: 0.001 } );
				expect( builder.reinsertionBatchSizeRatio ).toBe( 0.005 );

				builder.setReinsertionConfig( { batchSizeRatio: 0.5 } );
				expect( builder.reinsertionBatchSizeRatio ).toBe( 0.1 );

			} );

			it( 'clamps maxIterations to [1, 5]', () => {

				builder.setReinsertionConfig( { maxIterations: 0 } );
				expect( builder.reinsertionMaxIterations ).toBe( 1 );

				builder.setReinsertionConfig( { maxIterations: 20 } );
				expect( builder.reinsertionMaxIterations ).toBe( 5 );

			} );

		} );

		describe( 'disableTreeletOptimization', () => {

			it( 'sets enableTreeletOptimization to false', () => {

				const b = new BVHBuilder();
				b.enableTreeletOptimization = true; // default is false
				b.disableTreeletOptimization();
				expect( b.enableTreeletOptimization ).toBe( false );

			} );

		} );

	} );

	// ── buildSync + flattenBVH ───────────────────────────────────────────

	describe( 'buildSync + flattenBVH', () => {

		it( 'builds from 2 triangles and returns a node', () => {

			const data = makeTriData( [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
				[ 2, 0, 0, 3, 0, 0, 2, 1, 0 ],
			] );

			const root = builder.buildSync( data );
			expect( root ).not.toBeNull();
			expect( builder.totalNodes ).toBeGreaterThan( 0 );

		} );

		it( 'flattenBVH produces correct length (16 * totalNodes)', () => {

			const data = makeTriData( [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
				[ 2, 0, 0, 3, 0, 0, 2, 1, 0 ],
			] );

			const root = builder.buildSync( data );
			const flat = builder.flattenBVH( root );
			expect( flat ).toBeInstanceOf( Float32Array );
			expect( flat.length ).toBe( 16 * builder.totalNodes );

		} );

		it( 'leaf nodes have marker -1 in the .w position', () => {

			const data = makeTriData( [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
				[ 5, 0, 0, 6, 0, 0, 5, 1, 0 ],
			] );

			const root = builder.buildSync( data );
			const flat = builder.flattenBVH( root );

			// Walk nodes and check leaf markers
			let foundLeaf = false;
			for ( let i = 0; i < builder.totalNodes; i ++ ) {

				const o = i * 16;
				if ( flat[ o + 3 ] === - 1 ) {

					foundLeaf = true;
					// triOffset should be non-negative
					expect( flat[ o ] ).toBeGreaterThanOrEqual( 0 );
					// triCount should be positive
					expect( flat[ o + 1 ] ).toBeGreaterThan( 0 );

				}

			}

			expect( foundLeaf ).toBe( true );

		} );

		it( 'root AABB encompasses all triangle positions', () => {

			const tris = [
				[ - 5, - 3, - 1, 1, 0, 0, 0, 1, 0 ],
				[ 10, 20, 30, 11, 20, 30, 10, 21, 30 ],
				[ 0, 0, 0, 1, 1, 1, - 1, - 1, - 1 ],
			];
			const data = makeTriData( tris );
			const root = builder.buildSync( data );

			// Root must contain all positions
			expect( root.minX ).toBeLessThanOrEqual( - 5 );
			expect( root.minY ).toBeLessThanOrEqual( - 3 );
			expect( root.minZ ).toBeLessThanOrEqual( - 1 );
			expect( root.maxX ).toBeGreaterThanOrEqual( 11 );
			expect( root.maxY ).toBeGreaterThanOrEqual( 21 );
			expect( root.maxZ ).toBeGreaterThanOrEqual( 30 );

		} );

		it( 'builds correctly with 4 spatially separated triangles (small leaf size)', () => {

			builder.maxLeafSize = 2;

			const data = makeTriData( [
				[ - 10, 0, 0, - 9, 0, 0, - 10, 1, 0 ],
				[ 10, 0, 0, 11, 0, 0, 10, 1, 0 ],
				[ 0, - 10, 0, 1, - 10, 0, 0, - 9, 0 ],
				[ 0, 10, 0, 1, 10, 0, 0, 11, 0 ],
			] );

			const root = builder.buildSync( data );
			const flat = builder.flattenBVH( root );

			expect( root ).not.toBeNull();
			expect( builder.totalNodes ).toBeGreaterThan( 1 );
			expect( flat.length ).toBe( 16 * builder.totalNodes );

		} );

	} );

	// ── buildSync with single triangle ───────────────────────────────────

	describe( 'buildSync with single triangle', () => {

		it( 'creates a single leaf node', () => {

			const data = makeTriData( [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
			] );

			const root = builder.buildSync( data );
			expect( root ).not.toBeNull();
			expect( builder.totalNodes ).toBe( 1 );

			// Root is a leaf (no children)
			expect( root.leftChild ).toBeNull();
			expect( root.rightChild ).toBeNull();
			expect( root.triangleCount ).toBe( 1 );

		} );

		it( 'flattenBVH of single leaf has marker -1', () => {

			const data = makeTriData( [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
			] );

			const root = builder.buildSync( data );
			const flat = builder.flattenBVH( root );

			expect( flat.length ).toBe( 16 );
			expect( flat[ 3 ] ).toBe( - 1 );

		} );

	} );

	// ── buildSync with many triangles ────────────────────────────────────

	describe( 'buildSync with many triangles', () => {

		it( 'builds a tree with 20+ spatially distributed triangles', () => {

			const tris = [];
			for ( let i = 0; i < 25; i ++ ) {

				const x = ( i % 5 ) * 10;
				const y = Math.floor( i / 5 ) * 10;
				tris.push( [
					x, y, 0,
					x + 1, y, 0,
					x, y + 1, 0,
				] );

			}

			const data = makeTriData( tris );
			const root = builder.buildSync( data );
			const flat = builder.flattenBVH( root );

			expect( root ).not.toBeNull();
			// A proper tree should have more than 1 node for 25 triangles
			expect( builder.totalNodes ).toBeGreaterThan( 1 );
			// Must have both inner and leaf nodes
			let innerCount = 0;
			let leafCount = 0;
			for ( let i = 0; i < builder.totalNodes; i ++ ) {

				const o = i * 16;
				if ( flat[ o + 3 ] === - 1 ) {

					leafCount ++;

				} else {

					innerCount ++;

				}

			}

			expect( innerCount ).toBeGreaterThan( 0 );
			expect( leafCount ).toBeGreaterThan( 0 );

		} );

		it( 'total leaf triangle count equals input triangle count', () => {

			const tris = [];
			for ( let i = 0; i < 30; i ++ ) {

				const x = i * 5;
				tris.push( [ x, 0, 0, x + 1, 0, 0, x, 1, 0 ] );

			}

			const data = makeTriData( tris );
			const root = builder.buildSync( data );
			const flat = builder.flattenBVH( root );

			let totalLeafTris = 0;
			for ( let i = 0; i < builder.totalNodes; i ++ ) {

				const o = i * 16;
				if ( flat[ o + 3 ] === - 1 ) {

					totalLeafTris += flat[ o + 1 ];

				}

			}

			expect( totalLeafTris ).toBe( 30 );

		} );

	} );

	// ── reorderedTriangleData ────────────────────────────────────────────

	describe( 'reorderedTriangleData', () => {

		it( 'has the same length as input data after buildSync', () => {

			const data = makeTriData( [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
				[ 5, 0, 0, 6, 0, 0, 5, 1, 0 ],
				[ 10, 0, 0, 11, 0, 0, 10, 1, 0 ],
			] );

			builder.buildSync( data );
			expect( builder.reorderedTriangleData ).toBeInstanceOf( Float32Array );
			expect( builder.reorderedTriangleData.length ).toBe( data.length );

		} );

		it( 'contains the same triangle data (possibly reordered)', () => {

			const tris = [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
				[ 5, 5, 5, 6, 5, 5, 5, 6, 5 ],
			];
			const data = makeTriData( tris );
			builder.buildSync( data );

			const reordered = builder.reorderedTriangleData;

			// Extract posA.x from each reordered triangle to verify data is present
			const posAx = new Set();
			for ( let i = 0; i < 2; i ++ ) {

				posAx.add( reordered[ i * 32 ] );

			}

			expect( posAx.has( 0 ) ).toBe( true );
			expect( posAx.has( 5 ) ).toBe( true );

		} );

	} );

	// ── originalToBvhMap ─────────────────────────────────────────────────

	describe( 'originalToBvhMap', () => {

		it( 'is a Uint32Array of length equal to triangle count', () => {

			const data = makeTriData( [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
				[ 5, 0, 0, 6, 0, 0, 5, 1, 0 ],
				[ 10, 0, 0, 11, 0, 0, 10, 1, 0 ],
			] );

			builder.buildSync( data );
			expect( builder.originalToBvhMap ).toBeInstanceOf( Uint32Array );
			expect( builder.originalToBvhMap.length ).toBe( 3 );

		} );

		it( 'is a valid permutation (contains each index exactly once)', () => {

			const tris = [];
			for ( let i = 0; i < 10; i ++ ) {

				const x = i * 5;
				tris.push( [ x, 0, 0, x + 1, 0, 0, x, 1, 0 ] );

			}

			const data = makeTriData( tris );
			builder.buildSync( data );

			const map = builder.originalToBvhMap;
			const seen = new Set();
			for ( let i = 0; i < map.length; i ++ ) {

				expect( map[ i ] ).toBeGreaterThanOrEqual( 0 );
				expect( map[ i ] ).toBeLessThan( 10 );
				seen.add( map[ i ] );

			}

			expect( seen.size ).toBe( 10 );

		} );

		it( 'maps original triangles to their BVH-reordered positions', () => {

			const tris = [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
				[ 100, 0, 0, 101, 0, 0, 100, 1, 0 ],
			];
			const data = makeTriData( tris );
			builder.buildSync( data );

			const map = builder.originalToBvhMap;
			const reordered = builder.reorderedTriangleData;

			// For each original triangle i, reordered[ map[i] ] should match original
			for ( let i = 0; i < 2; i ++ ) {

				const origBase = i * 32;
				const bvhBase = map[ i ] * 32;
				expect( reordered[ bvhBase ] ).toBe( data[ origBase ] );
				expect( reordered[ bvhBase + 1 ] ).toBe( data[ origBase + 1 ] );
				expect( reordered[ bvhBase + 2 ] ).toBe( data[ origBase + 2 ] );

			}

		} );

	} );

} );
