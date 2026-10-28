import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { BVH_LEAF_MARKERS, bvhIndexView } from '@/core/scene/BufferLayout.js';
import { inspectBVH } from './bvhInvariants.js';

const reinsert = vi.hoisted( () => ( { fail: false, applied: 0 } ) );

vi.mock( '@/core/bvh/ReinsertionOptimizer.js', () => ( {
	ReinsertionOptimizer: class {

		constructor() {

			this.stats = { reinsertionsApplied: 0, iterations: 0, timeMs: 0 };

		}

		setBatchSizeRatio() {}
		setMaxIterations() {}
		optimizeBVH( root, progress ) {

			progress?.( 'Reinsertion iter 1/2' );
			if ( reinsert.fail ) throw new Error( 'reinsertion broke' );
			this.stats = { reinsertionsApplied: reinsert.applied, iterations: 2, timeMs: 1 };

		}

		getStatistics() {

			return this.stats;

		}

	}
} ) );

import { BVHBuilder, setBVHWorkerFactory } from '@/core/bvh/BVHBuilder.js';

/**
 * Helper: create a Float32Array of triangle data (32 floats per triangle).
 * Each triangle is [ax, ay, az, bx, by, bz, cx, cy, cz].
 */
const FPT = 20; // lanes per triangle record

function makeTriData( triangles ) {

	const data = new Uint32Array( triangles.length * FPT );
	const f = new Float32Array( data.buffer );
	for ( let i = 0; i < triangles.length; i ++ ) {

		const t = triangles[ i ];
		const b = i * FPT;
		f[ b ] = t[ 0 ]; f[ b + 1 ] = t[ 1 ]; f[ b + 2 ] = t[ 2 ];
		f[ b + 4 ] = t[ 3 ]; f[ b + 5 ] = t[ 4 ]; f[ b + 6 ] = t[ 5 ];
		f[ b + 8 ] = t[ 6 ]; f[ b + 9 ] = t[ 7 ]; f[ b + 10 ] = t[ 8 ];

	}

	return data;

}

describe( 'BVHBuilder', () => {

	let builder;

	beforeEach( () => {

		builder = new BVHBuilder();
		// Disable optimizations that are too complex for unit tests
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

		it( 'leaf nodes carry the triangle-leaf tag in the .w position', () => {

			const data = makeTriData( [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
				[ 5, 0, 0, 6, 0, 0, 5, 1, 0 ],
			] );

			const root = builder.buildSync( data );
			const flat = builder.flattenBVH( root );
			const idx = bvhIndexView( flat );

			// Walk nodes and check leaf markers
			let foundLeaf = false;
			for ( let i = 0; i < builder.totalNodes; i ++ ) {

				const o = i * 16;
				if ( idx[ o + 3 ] === BVH_LEAF_MARKERS.TRIANGLE_LEAF ) {

					foundLeaf = true;
					expect( idx[ o ] ).toBeGreaterThanOrEqual( 0 );
					expect( idx[ o + 1 ] ).toBeGreaterThan( 0 );

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

		it( 'flattenBVH of single leaf carries the triangle-leaf tag', () => {

			const data = makeTriData( [
				[ 0, 0, 0, 1, 0, 0, 0, 1, 0 ],
			] );

			const root = builder.buildSync( data );
			const flat = builder.flattenBVH( root );

			expect( flat.length ).toBe( 16 );
			expect( bvhIndexView( flat )[ 3 ] ).toBe( BVH_LEAF_MARKERS.TRIANGLE_LEAF );

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
			const idx = bvhIndexView( flat );
			for ( let i = 0; i < builder.totalNodes; i ++ ) {

				const o = i * 16;
				if ( idx[ o + 3 ] === BVH_LEAF_MARKERS.TRIANGLE_LEAF ) {

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
			const idx = bvhIndexView( flat );
			for ( let i = 0; i < builder.totalNodes; i ++ ) {

				const o = i * 16;
				if ( idx[ o + 3 ] === BVH_LEAF_MARKERS.TRIANGLE_LEAF ) {

					totalLeafTris += idx[ o + 1 ];

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
			expect( builder.reorderedTriangleData ).toBeInstanceOf( Uint32Array );
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

				posAx.add( new Float32Array( reordered.buffer )[ i * FPT ] );

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

				const origBase = i * FPT;
				const bvhBase = map[ i ] * FPT;
				expect( reordered[ bvhBase ] ).toBe( data[ origBase ] );
				expect( reordered[ bvhBase + 1 ] ).toBe( data[ origBase + 1 ] );
				expect( reordered[ bvhBase + 2 ] ).toBe( data[ origBase + 2 ] );

			}

		} );

	} );

} );

let seed = 7;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

function scatter( count, spread = 50 ) {

	const tris = [];
	for ( let i = 0; i < count; i ++ ) {

		const x = rand() * spread, y = rand() * spread, z = rand() * spread;
		tris.push( [ x, y, z, x + rand(), y, z, x, y + rand(), z + rand() ] );

	}

	return makeTriData( tris );

}

const atX = ( x, lo = 0, hi = 0 ) => [ x + lo, 0, 0, x + hi, 1, 0, x - lo - hi, 0, 1 ];

function prepared( data, setup = () => {} ) {

	const b = new BVHBuilder();
	b.enableReinsertionOptimization = false;
	b.useMortonCodes = false;
	setup( b );
	const n = data.length / FPT;
	b.triangles = data;
	b.totalTriangles = n;
	b.centroids = new Float32Array( n * 3 );
	b.bMin = new Float32Array( n * 3 );
	b.bMax = new Float32Array( n * 3 );
	b.indices = new Uint32Array( n );
	b.initializeTriangleArrays();
	return b;

}

function reorder( data, indices ) {

	const out = new Uint32Array( data.length );
	indices.forEach( ( t, i ) => out.set( data.subarray( t * FPT, ( t + 1 ) * FPT ), i * FPT ) );
	return out;

}

function leafSizes( root ) {

	const sizes = [];
	const stack = [ root ];
	while ( stack.length ) {

		const n = stack.pop();
		if ( n.leftChild ) stack.push( n.leftChild, n.rightChild );
		else sizes.push( n.triangleCount );

	}

	return sizes;

}

describe( 'BVHBuilder.build', () => {

	afterEach( () => {

		setBVHWorkerFactory( null );
		vi.unstubAllGlobals();

	} );

	it( 'builds on this thread without a worker, folding leaves when asked', async () => {

		const data = scatter( 300 );
		const builder = new BVHBuilder();
		builder.useWorker = false;
		builder.useMortonCodes = false;
		const progress = [];
		const plain = await builder.build( data.slice(), 30, p => progress.push( p ) );
		expect( plain.bvhRoot ).toBe( true );
		expect( inspectBVH( plain.bvhData, plain.reorderedTriangles ).problems ).toEqual( [] );
		expect( progress.at( - 1 ) ).toBe( 100 );
		expect( [ ...plain.originalToBvh ].sort( ( a, b ) => a - b ) ).toEqual( Array.from( { length: 300 }, ( _, i ) => i ) );

		builder.foldLeaves = true;
		const folded = await builder.build( data.slice() );
		expect( folded.bvhData.length ).toBeLessThan( plain.bvhData.length );
		const check = inspectBVH( folded.bvhData, folded.reorderedTriangles, { folded: true } );
		expect( check.problems ).toEqual( [] );
		expect( check.stats.foldedLeaves ).toBeGreaterThan( 0 );

	} );

	const fakeWorker = () => ( { postMessage: vi.fn(), terminate: vi.fn() } );

	it( 'hands a worker the triangles and settings, and takes the reordered triangles from shared memory', async () => {

		vi.stubGlobal( 'Worker', class {} );
		const worker = fakeWorker();
		setBVHWorkerFactory( () => worker );
		const builder = new BVHBuilder();
		builder.setReinsertionConfig( { batchSizeRatio: 0.05, maxIterations: 3 } );
		const data = scatter( 4 );
		const progress = [];

		const building = builder.build( data, 12, p => progress.push( p ) );
		const [ message, transfer ] = worker.postMessage.mock.calls[ 0 ];
		expect( transfer ).toEqual( [ data.buffer ] );
		expect( message ).toMatchObject( {
			triangleData: data.buffer, triangleByteOffset: 0, triangleByteLength: 4 * FPT * 4, triangleCount: 4, depth: 12,
			reportProgress: true, reinsertionOptimization: { enabled: true, batchSizeRatio: 0.05, maxIterations: 3 },
		} );
		expect( message.sharedReorderBuffer.byteLength ).toBe( 4 * FPT * 4 );

		worker.onmessage( { data: { progress: 40 } } );
		expect( progress ).toEqual( [ 40 ] );
		expect( worker.terminate ).not.toHaveBeenCalled();

		const bvhData = new Float32Array( 16 ), stats = { sahSplits: 3 };
		worker.onmessage( { data: { bvhData, originalToBvh: Uint32Array.of( 1, 0, 2, 3 ), splitStats: stats } } );
		const result = await building;
		expect( result.bvhData ).toBe( bvhData );
		expect( result.reorderedTriangles.buffer ).toBe( message.sharedReorderBuffer );
		expect( [ ...result.originalToBvh ] ).toEqual( [ 1, 0, 2, 3 ] );
		expect( builder.splitStats ).toBe( stats );
		expect( worker.terminate ).toHaveBeenCalledOnce();

	} );

	it( 'takes the triangles back by transfer where memory cannot be shared', async () => {

		vi.stubGlobal( 'Worker', class {} );
		vi.stubGlobal( 'SharedArrayBuffer', undefined );
		const worker = fakeWorker();
		setBVHWorkerFactory( () => worker );
		const building = new BVHBuilder().build( scatter( 2 ) );
		expect( worker.postMessage.mock.calls[ 0 ][ 0 ].sharedReorderBuffer ).toBeNull();

		const triangles = new Float32Array( 2 * FPT );
		worker.onmessage( { data: { bvhData: new Float32Array( 16 ), triangles } } );
		const result = await building;
		expect( result.reorderedTriangles ).toBe( triangles );
		expect( result.originalToBvh ).toBeNull();

	} );

	it( 'rejects on the worker\'s error or crash, ending it', async () => {

		vi.stubGlobal( 'Worker', class {} );
		const failing = fakeWorker();
		setBVHWorkerFactory( () => failing );
		const failed = new BVHBuilder().build( scatter( 2 ) );
		failing.onmessage( { data: { error: 'out of memory' } } );
		await expect( failed ).rejects.toThrow( 'out of memory' );
		expect( failing.terminate ).toHaveBeenCalledOnce();

		const crashing = fakeWorker();
		setBVHWorkerFactory( () => crashing );
		const crashed = new BVHBuilder().build( scatter( 2 ) );
		const crash = new Error( 'worker died' );
		crashing.onerror( crash );
		await expect( crashed ).rejects.toBe( crash );
		expect( crashing.terminate ).toHaveBeenCalledOnce();

	} );

	it( 'builds on this thread when no worker can be started', async () => {

		vi.stubGlobal( 'Worker', class {} );
		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		setBVHWorkerFactory( () => {

			throw new Error( 'blocked by CSP' );

		} );
		const builder = new BVHBuilder();
		builder.enableReinsertionOptimization = false;
		const result = await builder.build( scatter( 50 ) );
		expect( inspectBVH( result.bvhData, result.reorderedTriangles ).problems ).toEqual( [] );
		expect( console.warn ).toHaveBeenCalled();
		vi.restoreAllMocks();

	} );

} );

describe( 'BVHBuilder splits', () => {

	afterEach( () => {

		reinsert.fail = false;
		reinsert.applied = 0;
		vi.restoreAllMocks();

	} );

	it( 'reads a triangle\'s Morton code from its place in the scene\'s bounds', () => {

		const b = new BVHBuilder();
		b.centroids = Float32Array.of( 0, 0, 0, 1, 1, 1, 0.5, 0.25, 2 );
		expect( b.computeMortonCodeForIndex( 0, 0, 0, 0, 1, 1, 1 ) ).toBe( 0 );
		expect( b.computeMortonCodeForIndex( 1, 0, 0, 0, 1, 1, 1 ) ).toBe( 2 ** 30 - 1 );
		expect( b.computeMortonCodeForIndex( 2, 0, 0, 0, 1, 1, 1 ) ).toBe( b.morton3D( 511, 255, 1023 ) );
		expect( b.computeMortonCodeForIndex( 2, 0, 0, 0, 1, 0, 0 ) ).toBe( b.morton3D( 511, 0, 0 ) );

	} );

	it( 'orders triangles along a Morton curve before splitting, keeping every one', () => {

		const b = prepared( scatter( 200 ), x => {

			x.useMortonCodes = true;
			x.setMortonConfig( { threshold: 16 } );

		} );
		b.mortonCodes = new Uint32Array( 200 );
		b.sortTrianglesByMortonCode();
		const codes = [ ...b.indices ].map( t => b.mortonCodes[ t ] );
		expect( codes.every( ( c, i ) => i === 0 || c >= codes[ i - 1 ] ) ).toBe( true );
		expect( new Set( codes ).size ).toBeGreaterThan( 100 );
		expect( [ ...b.indices ].sort( ( x, y ) => x - y ) ).toEqual( Array.from( { length: 200 }, ( _, i ) => i ) );

		const builder = new BVHBuilder();
		builder.enableReinsertionOptimization = false;
		builder.setMortonConfig( { threshold: 16 } );
		const root = builder.buildSync( scatter( 200 ) );
		expect( inspectBVH( builder.flattenBVH( root ), builder.reorderedTriangleData ).problems ).toEqual( [] );

	} );

	it( 'falls back to object median splits when SAH sees no gain, and still covers every triangle', () => {

		const builder = new BVHBuilder();
		builder.enableReinsertionOptimization = false;
		builder.useMortonCodes = false;
		builder.maxLeafSize = 2;
		builder.traversalCost = 1e9;
		const data = scatter( 40 );
		const root = builder.buildSync( data );
		expect( builder.splitStats.sahSplits ).toBe( 0 );
		expect( builder.splitStats.objectMedianSplits ).toBeGreaterThan( 0 );
		expect( Math.max( ...leafSizes( root ) ) ).toBeLessThanOrEqual( 2 );
		expect( inspectBVH( builder.flattenBVH( root ), builder.reorderedTriangleData ).problems ).toEqual( [] );

		builder.setFallbackConfig( { objectMedian: false } );
		builder.buildSync( data );
		expect( builder.splitStats.objectMedianSplits ).toBe( 0 );
		expect( builder.splitStats.spatialMedianSplits ).toBeGreaterThan( 0 );

		builder.setFallbackConfig( { spatialMedian: false } );
		const leaf = builder.buildSync( data );
		expect( leaf.triangleCount ).toBe( 40 );
		expect( builder.splitStats.failedSplits ).toBe( 1 );

	} );

	it( 'keeps triangles stacked on one point in one leaf rather than splitting forever', () => {

		const builder = new BVHBuilder();
		builder.enableReinsertionOptimization = false;
		builder.maxLeafSize = 2;
		const data = makeTriData( Array.from( { length: 12 }, () => atX( 5, - 1, 1 ) ) );
		const root = builder.buildSync( data );
		expect( root.triangleCount ).toBe( 12 );
		expect( builder.splitStats.failedSplits ).toBe( 1 );
		expect( inspectBVH( builder.flattenBVH( root ), builder.reorderedTriangleData ).problems ).toEqual( [] );

	} );

	it( 'nudges an object median off a run of equal centroids', () => {

		const b = prepared( makeTriData( [ atX( 1 ), atX( 0 ), atX( 1 ), atX( 0 ) ] ) );
		expect( b.findObjectMedianSplit( 0, 4 ) ).toEqual( { success: true, axis: 0, pos: 0.5, method: 'object_median' } );

		const run = prepared( makeTriData( [ atX( 1 ), atX( 0 ), atX( 1 ), atX( 1 ) ] ), x => x.setFallbackConfig( { spatialMedian: false } ) );
		expect( run.findObjectMedianSplit( 0, 4 ) ).toEqual( { success: false, method: 'object_median_degenerate' } );
		const flat = prepared( makeTriData( [ atX( 2 ), atX( 2 ) ] ), x => x.setFallbackConfig( { spatialMedian: false } ) );
		expect( flat.findObjectMedianSplit( 0, 2 ) ).toEqual( { success: false, method: 'object_median_failed' } );

		const spatial = prepared( makeTriData( [ atX( 1 ), atX( 0 ), atX( 1 ), atX( 1 ) ] ) );
		expect( spatial.findObjectMedianSplit( 0, 4 ) ).toMatchObject( { success: true, method: 'spatial_median' } );

	} );

	it( 'splits at the middle of the bounds, or at the median when the middle splits nothing', () => {

		const middle = prepared( makeTriData( [ atX( 0 ), atX( 10 ), atX( 3 ), atX( 9 ) ] ) );
		expect( middle.findSpatialMedianSplit( 0, 4 ) ).toEqual( { success: true, axis: 0, pos: 5, method: 'spatial_median' } );

		// One wide triangle drags the bounds' middle below every centroid.
		const below = prepared( makeTriData( [ atX( 5, - 50, 25 ), atX( 7 ), atX( 5 ), atX( 6 ) ] ) );
		expect( below.findSpatialMedianSplit( 0, 4 ) ).toMatchObject( { success: true, axis: 0, pos: 5.5 } );

		const repeated = prepared( makeTriData( [ atX( 5, - 50, 25 ), atX( 7 ), atX( 5 ), atX( 5 ) ] ) );
		expect( repeated.findSpatialMedianSplit( 0, 4 ) ).toMatchObject( { success: true, axis: 0, pos: 6 } );

		const same = prepared( makeTriData( [ atX( 5, - 50, 25 ), atX( 5 ), atX( 5 ) ] ) );
		expect( same.findSpatialMedianSplit( 0, 3 ) ).toEqual( { success: false, method: 'spatial_median_degenerate' } );

		const point = prepared( makeTriData( [[ 1, 1, 1, 1, 1, 1, 1, 1, 1 ], [ 1, 1, 1, 1, 1, 1, 1, 1, 1 ]] ) );
		expect( point.findSpatialMedianSplit( 0, 2 ) ).toEqual( { success: false, method: 'spatial_median_failed' } );

	} );

	it( 'says when SAH finds nothing and every fallback is off', () => {

		const b = prepared( scatter( 20 ), x => {

			x.traversalCost = 1e9;
			x.setFallbackConfig( { objectMedian: false, spatialMedian: false } );

		} );
		const node = {};
		b.updateNodeBounds( node, 0, 20 );
		expect( b.findBestSplitPositionSAH( 0, 20, node ) ).toEqual( { success: false, method: 'fallbacks_disabled' } );

	} );

	it( 'makes a leaf of a split that would leave one side empty', () => {

		const builder = new BVHBuilder();
		builder.enableReinsertionOptimization = false;
		builder.maxLeafSize = 2;
		vi.spyOn( builder, 'findBestSplitPositionSAH' ).mockReturnValue( { success: true, axis: 0, pos: 1e9, method: 'SAH' } );
		const root = builder.buildSync( scatter( 10 ) );
		expect( root.triangleCount ).toBe( 10 );
		expect( root.leftChild ).toBeNull();

	} );

	it( 'reports progress as leaves are made, never 100 before the end', () => {

		const builder = new BVHBuilder();
		builder.enableReinsertionOptimization = false;
		builder.maxLeafSize = 2;
		builder.progressUpdateInterval = - 1;
		const progress = [];
		builder.buildSync( scatter( 64 ), 30, p => progress.push( p ) );
		expect( progress.length ).toBeGreaterThan( 2 );
		expect( progress.at( - 1 ) ).toBe( 100 );
		expect( progress.slice( 0, - 1 ).every( ( p, i, all ) => p <= 99 && ( i === 0 || p >= all[ i - 1 ] ) ) ).toBe( true );

	} );

	it( 'runs the reinsertion pass on a large mesh, passing its progress on, and survives it failing', () => {

		const builder = new BVHBuilder();
		builder.useMortonCodes = false;
		const data = scatter( 1001 );
		const progress = [];
		reinsert.applied = 7;
		builder.buildSync( data, 30, p => progress.push( p ) );
		expect( progress ).toContain( 'Reinsertion iter 1/2' );
		expect( builder.splitStats ).toMatchObject( { reinsertionsApplied: 7, reinsertionIterations: 2, reinsertionOptimizationTime: 1 } );

		reinsert.fail = true;
		const error = vi.spyOn( console, 'error' ).mockImplementation( () => {} );
		const root = builder.buildSync( data );
		expect( error ).toHaveBeenCalled();
		expect( inspectBVH( builder.flattenBVH( root ), builder.reorderedTriangleData ).problems ).toEqual( [] );

	} );

} );

describe( 'BVHBuilder parallel build', () => {

	function parallelBuild( data, frontierDepth, setup = () => {} ) {

		const top = prepared( data, setup );
		top.frontierTasks = [];
		const root = top.buildNodeRecursiveToDepth( 0, top.totalTriangles, 30, frontierDepth );
		top.applySAOrdering( root );
		const flat = top.flattenBVHWithFrontier( root );

		const subtrees = top.frontierTasks.map( task => {

			const sub = prepared( data, setup );
			Object.assign( sub, { centroids: top.centroids, bMin: top.bMin, bMax: top.bMax, indices: top.indices } );
			const r = sub.buildNodeRecursive( task.start, task.end, task.depth, null, task.preMinX, task.preMinY, task.preMinZ, task.preMaxX, task.preMaxY, task.preMaxZ );
			const nodes = sub.flattenBVH( r );
			return { taskId: task.taskId, flatData: nodes, nodeCount: nodes.length / 16 };

		} );

		const nodes = top.assembleParallelBVH( flat.flatData, flat.nodeCount, flat.frontierMap, subtrees.reverse() );
		return { top, flat, nodes, triangles: reorder( data, top.indices ) };

	}

	it( 'assembles subtrees built apart into one valid BVH', () => {

		const { top, flat, nodes, triangles } = parallelBuild( scatter( 400 ), 2, b => ( b.maxLeafSize = 2 ) );
		expect( top.frontierTasks ).toHaveLength( 4 );
		expect( flat.frontierMap.map( f => f.taskId ).sort() ).toEqual( [ 0, 1, 2, 3 ] );
		const idx = bvhIndexView( flat.flatData );
		for ( const { flatIndex } of flat.frontierMap ) expect( idx[ flatIndex * 16 + 3 ] ).toBe( BVH_LEAF_MARKERS.FRONTIER );

		const { problems, stats } = inspectBVH( nodes, triangles );
		expect( problems ).toEqual( [] );
		expect( stats.unreached ).toBe( 4 );

	} );

	it( 'stops short of the frontier where a range is small, stacked, or will not split', () => {

		const small = parallelBuild( scatter( 20 ), 1, b => ( b.maxLeafSize = 2 ) );
		expect( small.top.frontierTasks ).toHaveLength( 0 );
		expect( inspectBVH( small.nodes, small.triangles ).problems ).toEqual( [] );

		const stacked = parallelBuild( makeTriData( Array.from( { length: 40 }, () => atX( 3, - 1, 1 ) ) ), 2, b => ( b.maxLeafSize = 2 ) );
		expect( stacked.top.splitStats.failedSplits ).toBe( 1 );
		expect( inspectBVH( stacked.nodes, stacked.triangles ).problems ).toEqual( [] );

		const medians = parallelBuild( scatter( 64 ), 3, b => {

			b.maxLeafSize = 2;
			b.traversalCost = 1e9;

		} );
		expect( medians.top.splitStats.objectMedianSplits ).toBeGreaterThan( 0 );
		expect( inspectBVH( medians.nodes, medians.triangles ).problems ).toEqual( [] );

		const spatial = prepared( scatter( 64 ), b => {

			b.maxLeafSize = 2;
			b.traversalCost = 1e9;
			b.setFallbackConfig( { objectMedian: false } );

		} );
		spatial.frontierTasks = [];
		spatial.buildNodeRecursiveToDepth( 0, 64, 30, 3 );
		expect( spatial.splitStats.spatialMedianSplits ).toBeGreaterThan( 0 );

		const lopsided = prepared( scatter( 64 ), b => ( b.maxLeafSize = 2 ) );
		lopsided.frontierTasks = [];
		vi.spyOn( lopsided, 'findBestSplitPositionSAH' ).mockReturnValue( { success: true, axis: 0, pos: - 1e9, method: 'SAH' } );
		expect( lopsided.buildNodeRecursiveToDepth( 0, 64, 30, 3 ).triangleCount ).toBe( 64 );

	} );

} );
