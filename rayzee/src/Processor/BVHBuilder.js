import { TreeletOptimizer } from './TreeletOptimizer.js';
import { ReinsertionOptimizer } from './ReinsertionOptimizer.js';
import BVHWorker from './Workers/BVHWorker.js?worker&inline';
// Logger is worker-safe (globalThis only, storage access guarded), unlike Constants.js below.
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'bvh' );

// Inline copy of TRIANGLE_DATA_LAYOUT (mirrors Constants.js).
// Cannot import Constants.js because BVHBuilder runs inside BVHWorker
// where `window` (used elsewhere in Constants.js) is not defined.
const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 32,
	POSITION_A_OFFSET: 0,
	POSITION_B_OFFSET: 4,
	POSITION_C_OFFSET: 8,
	NORMAL_A_OFFSET: 12,
	NORMAL_B_OFFSET: 16,
	NORMAL_C_OFFSET: 20,
	UV_AB_OFFSET: 24,
	UV_C_MAT_OFFSET: 28 // vec4: uvC.x, uvC.y, materialIndex, meshIndex
};

const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;

class BVHNode {

	constructor() {

		// Inline floats instead of Vector3 to avoid 2M+ object allocations
		this.minX = 0; this.minY = 0; this.minZ = 0;
		this.maxX = 0; this.maxY = 0; this.maxZ = 0;
		this.leftChild = null;
		this.rightChild = null;
		this.triangleOffset = 0;
		this.triangleCount = 0;

	}

}

export class BVHBuilder {

	constructor() {

		this.useWorker = true;
		this.maxLeafSize = 8;
		this.numBins = 32;
		this.minBins = 8;
		this.maxBins = 64;
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.totalTriangles = 0;
		this.lastProgressUpdate = 0;
		this.progressUpdateInterval = 100;

		// SAH constants — GPU intersection is ~2.5x more expensive than traversal
		// (8 storage buffer fetches + Möller-Trumbore vs 4 vec4 reads + slab test)
		this.traversalCost = 1.0;
		this.intersectionCost = 2.5;

		// Morton code clustering settings
		this.useMortonCodes = true;
		this.mortonBits = 10;
		this.mortonClusterThreshold = 128;

		// Fallback method configuration
		this.enableObjectMedianFallback = true;
		this.enableSpatialMedianFallback = true;

		// Split statistics
		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			spatialMedianSplits: 0,
			failedSplits: 0,
			avgBinsUsed: 0,
			totalSplitAttempts: 0,
			mortonSortTime: 0,
			totalBuildTime: 0,
			treeletOptimizationTime: 0,
			treeletsProcessed: 0,
			treeletsImproved: 0,
			averageSAHImprovement: 0,
			reinsertionOptimizationTime: 0,
			reinsertionsApplied: 0,
			reinsertionIterations: 0
		};

		// Treelet optimization configuration
		this.enableTreeletOptimization = true;
		this.treeletSize = 5;
		this.treeletOptimizationPasses = 1;
		this.treeletMinImprovement = 0.02;
		this.maxTreeletDepth = 3;
		this.maxTreeletsPerScene = 20;
		this.treeletComplexityThreshold = 50000;

		// Reinsertion optimization configuration
		this.enableReinsertionOptimization = true;
		this.reinsertionBatchSizeRatio = 0.02;
		this.reinsertionMaxIterations = 2;

		// Pre-allocate bin arrays
		this.initializeBinArrays();

		// Reusable partition result (avoids per-node object allocation)
		this._partResult = {
			mid: 0,
			lMinX: 0, lMinY: 0, lMinZ: 0, lMaxX: 0, lMaxY: 0, lMaxZ: 0,
			rMinX: 0, rMinY: 0, rMinZ: 0, rMaxX: 0, rMaxY: 0, rMaxZ: 0
		};

		// Flat per-triangle arrays (allocated in buildSync)
		this.centroids = null;
		this.bMin = null;
		this.bMax = null;
		this.indices = null;
		this.mortonCodes = null;
		this.triangles = null;

		// Reordered output (produced by buildSync)
		this.reorderedTriangleData = null;

	}

	initializeBinArrays() {

		const mb = this.maxBins;
		// Flat bin bounds: 3 floats per bin (x, y, z)
		this.binBoundsMin = new Float32Array( mb * 3 );
		this.binBoundsMax = new Float32Array( mb * 3 );
		this.binCounts = new Uint32Array( mb );

		// Prefix-sum arrays for SAH evaluation
		this.leftPrefixMin = new Float32Array( mb * 3 );
		this.leftPrefixMax = new Float32Array( mb * 3 );
		this.leftPrefixCount = new Uint32Array( mb );
		this.rightPrefixMin = new Float32Array( mb * 3 );
		this.rightPrefixMax = new Float32Array( mb * 3 );
		this.rightPrefixCount = new Uint32Array( mb );

	}

	getOptimalBinCount( triangleCount ) {

		if ( triangleCount <= 16 ) return this.minBins;
		if ( triangleCount <= 64 ) return 16;
		if ( triangleCount <= 256 ) return 32;
		if ( triangleCount <= 1024 ) return 48;
		return this.maxBins;

	}

	setAdaptiveBinConfig( config ) {

		if ( config.minBins !== undefined ) this.minBins = Math.max( 4, config.minBins );
		if ( config.maxBins !== undefined ) this.maxBins = Math.min( 128, config.maxBins );
		if ( config.baseBins !== undefined ) this.numBins = config.baseBins;
		if ( config.maxBins !== undefined ) this.initializeBinArrays();

	}

	setMortonConfig( config ) {

		if ( config.enabled !== undefined ) this.useMortonCodes = config.enabled;
		if ( config.bits !== undefined ) this.mortonBits = Math.max( 6, Math.min( 10, config.bits ) );
		if ( config.threshold !== undefined ) this.mortonClusterThreshold = Math.max( 16, config.threshold );

	}

	setFallbackConfig( config ) {

		if ( config.objectMedian !== undefined ) this.enableObjectMedianFallback = config.objectMedian;
		if ( config.spatialMedian !== undefined ) this.enableSpatialMedianFallback = config.spatialMedian;

	}

	setTreeletConfig( config ) {

		if ( config.enabled !== undefined ) this.enableTreeletOptimization = config.enabled;
		if ( config.size !== undefined ) this.treeletSize = Math.max( 3, Math.min( 12, config.size ) );
		if ( config.passes !== undefined ) this.treeletOptimizationPasses = Math.max( 1, Math.min( 3, config.passes ) );
		if ( config.minImprovement !== undefined ) this.treeletMinImprovement = Math.max( 0.001, config.minImprovement );

	}

	disableTreeletOptimization() {

		this.enableTreeletOptimization = false;

	}

	setReinsertionConfig( config ) {

		if ( config.enabled !== undefined ) this.enableReinsertionOptimization = config.enabled;
		if ( config.batchSizeRatio !== undefined ) this.reinsertionBatchSizeRatio = Math.max( 0.005, Math.min( 0.1, config.batchSizeRatio ) );
		if ( config.maxIterations !== undefined ) this.reinsertionMaxIterations = Math.max( 1, Math.min( 5, config.maxIterations ) );

	}

	/**
	 * Fill per-triangle arrays (centroids, bMin, bMax, indices) from triangle data.
	 * Arrays must already be allocated on `this` before calling.
	 */
	initializeTriangleArrays() {

		const n = this.totalTriangles;
		const src = this.triangles;
		const PA = TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET;
		const PB = TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET;
		const PC = TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET;

		for ( let i = 0; i < n; i ++ ) {

			const base = i * FPT;
			const ax = src[ base + PA ], ay = src[ base + PA + 1 ], az = src[ base + PA + 2 ];
			const bx = src[ base + PB ], by = src[ base + PB + 1 ], bz = src[ base + PB + 2 ];
			const cx = src[ base + PC ], cy = src[ base + PC + 1 ], cz = src[ base + PC + 2 ];

			const o3 = i * 3;
			this.centroids[ o3 ] = ( ax + bx + cx ) / 3;
			this.centroids[ o3 + 1 ] = ( ay + by + cy ) / 3;
			this.centroids[ o3 + 2 ] = ( az + bz + cz ) / 3;

			this.bMin[ o3 ] = ax < bx ? ( ax < cx ? ax : cx ) : ( bx < cx ? bx : cx );
			this.bMin[ o3 + 1 ] = ay < by ? ( ay < cy ? ay : cy ) : ( by < cy ? by : cy );
			this.bMin[ o3 + 2 ] = az < bz ? ( az < cz ? az : cz ) : ( bz < cz ? bz : cz );

			this.bMax[ o3 ] = ax > bx ? ( ax > cx ? ax : cx ) : ( bx > cx ? bx : cx );
			this.bMax[ o3 + 1 ] = ay > by ? ( ay > cy ? ay : cy ) : ( by > cy ? by : cy );
			this.bMax[ o3 + 2 ] = az > bz ? ( az > cz ? az : cz ) : ( bz > cz ? bz : cz );

			this.indices[ i ] = i;

		}

	}

	// --- Morton code helpers ---

	expandBits( value ) {

		value = ( value * 0x00010001 ) & 0xFF0000FF;
		value = ( value * 0x00000101 ) & 0x0F00F00F;
		value = ( value * 0x00000011 ) & 0xC30C30C3;
		value = ( value * 0x00000005 ) & 0x49249249;
		return value;

	}

	morton3D( x, y, z ) {

		return ( this.expandBits( z ) << 2 ) + ( this.expandBits( y ) << 1 ) + this.expandBits( x );

	}

	computeMortonCodeForIndex( idx, sceneMinX, sceneMinY, sceneMinZ, rangeX, rangeY, rangeZ ) {

		const c = this.centroids;
		const o = idx * 3;
		const mortonScale = ( 1 << this.mortonBits ) - 1;

		let nx = rangeX > 0 ? ( c[ o ] - sceneMinX ) / rangeX : 0;
		let ny = rangeY > 0 ? ( c[ o + 1 ] - sceneMinY ) / rangeY : 0;
		let nz = rangeZ > 0 ? ( c[ o + 2 ] - sceneMinZ ) / rangeZ : 0;

		const x = Math.max( 0, Math.min( mortonScale, Math.floor( nx * mortonScale ) ) );
		const y = Math.max( 0, Math.min( mortonScale, Math.floor( ny * mortonScale ) ) );
		const z = Math.max( 0, Math.min( mortonScale, Math.floor( nz * mortonScale ) ) );

		return this.morton3D( x, y, z );

	}

	sortTrianglesByMortonCode() {

		const n = this.totalTriangles;
		if ( ! this.useMortonCodes || n < this.mortonClusterThreshold ) return;

		const startTime = performance.now();
		const c = this.centroids;
		const indices = this.indices;

		// Compute scene bounds from centroids
		let sMinX = Infinity, sMinY = Infinity, sMinZ = Infinity;
		let sMaxX = - Infinity, sMaxY = - Infinity, sMaxZ = - Infinity;
		for ( let i = 0; i < n; i ++ ) {

			const idx = indices[ i ];
			const o = idx * 3;
			const cx = c[ o ], cy = c[ o + 1 ], cz = c[ o + 2 ];
			if ( cx < sMinX ) sMinX = cx;
			if ( cy < sMinY ) sMinY = cy;
			if ( cz < sMinZ ) sMinZ = cz;
			if ( cx > sMaxX ) sMaxX = cx;
			if ( cy > sMaxY ) sMaxY = cy;
			if ( cz > sMaxZ ) sMaxZ = cz;

		}

		const rX = sMaxX - sMinX, rY = sMaxY - sMinY, rZ = sMaxZ - sMinZ;

		// Compute morton codes (inlined to avoid per-triangle method dispatch)
		const mc = this.mortonCodes;
		const mortonScale = ( 1 << this.mortonBits ) - 1;
		const invRX = rX > 0 ? mortonScale / rX : 0;
		const invRY = rY > 0 ? mortonScale / rY : 0;
		const invRZ = rZ > 0 ? mortonScale / rZ : 0;

		for ( let i = 0; i < n; i ++ ) {

			const triIdx = indices[ i ];
			const o = triIdx * 3;

			let mx = ( c[ o ] - sMinX ) * invRX;
			let my = ( c[ o + 1 ] - sMinY ) * invRY;
			let mz = ( c[ o + 2 ] - sMinZ ) * invRZ;

			// Clamp and truncate to integer
			mx = mx < 0 ? 0 : ( mx > mortonScale ? mortonScale : mx ) | 0;
			my = my < 0 ? 0 : ( my > mortonScale ? mortonScale : my ) | 0;
			mz = mz < 0 ? 0 : ( mz > mortonScale ? mortonScale : mz ) | 0;

			// Inline expandBits + morton3D
			mx = ( mx * 0x00010001 ) & 0xFF0000FF;
			mx = ( mx * 0x00000101 ) & 0x0F00F00F;
			mx = ( mx * 0x00000011 ) & 0xC30C30C3;
			mx = ( mx * 0x00000005 ) & 0x49249249;

			my = ( my * 0x00010001 ) & 0xFF0000FF;
			my = ( my * 0x00000101 ) & 0x0F00F00F;
			my = ( my * 0x00000011 ) & 0xC30C30C3;
			my = ( my * 0x00000005 ) & 0x49249249;

			mz = ( mz * 0x00010001 ) & 0xFF0000FF;
			mz = ( mz * 0x00000101 ) & 0x0F00F00F;
			mz = ( mz * 0x00000011 ) & 0xC30C30C3;
			mz = ( mz * 0x00000005 ) & 0x49249249;

			mc[ triIdx ] = ( mz << 2 ) + ( my << 1 ) + mx;

		}

		// Radix sort indices by morton code (O(N), 4 passes of 8-bit digits)
		const temp = new Uint32Array( n );
		const counts = new Uint32Array( 256 );

		for ( let shift = 0; shift < 32; shift += 8 ) {

			counts.fill( 0 );

			// Count digit occurrences
			for ( let i = 0; i < n; i ++ ) {

				counts[ ( mc[ indices[ i ] ] >>> shift ) & 0xFF ] ++;

			}

			// Prefix sum
			let total = 0;
			for ( let i = 0; i < 256; i ++ ) {

				const c = counts[ i ];
				counts[ i ] = total;
				total += c;

			}

			// Scatter to temp
			for ( let i = 0; i < n; i ++ ) {

				const digit = ( mc[ indices[ i ] ] >>> shift ) & 0xFF;
				temp[ counts[ digit ] ++ ] = indices[ i ];

			}

			indices.set( temp );

		}

		this.splitStats.mortonSortTime += performance.now() - startTime;

	}

	// --- Build entry points ---

	/**
	 * Build BVH from triangle data.
	 * Returns { bvhData: Float32Array, bvhRoot: true, reorderedTriangles: Float32Array }
	 * where bvhData is the GPU-ready flat array (12 floats/node) and reorderedTriangles
	 * is the BVH-ordered triangle data. Caller must use reorderedTriangles instead of
	 * the original input (which is neutered after transfer to the worker).
	 */
	build( triangles, depth = 30, progressCallback = null ) {

		this.totalTriangles = triangles.byteLength / ( FPT * 4 );
		this.processedTriangles = 0;
		this.lastProgressUpdate = performance.now();

		if ( this.useWorker && typeof Worker !== 'undefined' ) {

			return new Promise( ( resolve, reject ) => {

				const setupWorker = ( worker ) => {

					const triangleCount = this.totalTriangles;
					const useShared = typeof SharedArrayBuffer !== 'undefined';
					log.debug( `SharedArrayBuffer ${useShared ? 'enabled' : 'unavailable (using transfer fallback)'}` );

					// Pre-allocate SharedArrayBuffer for reordered output so worker
					// writes directly to shared memory (no transfer needed on return).
					const sharedReorderBuffer = useShared
						? new SharedArrayBuffer( triangleCount * FPT * 4 )
						: null;

					worker.onmessage = ( e ) => {

						const { bvhData, triangles: transferredTriangles, originalToBvh, error, progress, treeletStats } = e.data;

						if ( error ) {

							worker.terminate();
							reject( new Error( error ) );
							return;

						}

						if ( progress !== undefined && progressCallback ) {

							progressCallback( progress );
							return;

						}

						if ( treeletStats ) {

							this.splitStats = treeletStats;

						}

						worker.terminate();

						// Reordered triangles: from shared memory or fallback transfer
						const reorderedTriangles = sharedReorderBuffer
							? new Float32Array( sharedReorderBuffer )
							: transferredTriangles;

						resolve( { bvhData, bvhRoot: true, reorderedTriangles, originalToBvh: originalToBvh || null } );

					};

					worker.onerror = ( error ) => {

						worker.terminate();
						reject( error );

					};

					// Transfer the original buffer directly — avoids 362MB copy.
					const transferBuffer = triangles.buffer;
					const workerData = {
						triangleData: transferBuffer,
						triangleByteOffset: triangles.byteOffset,
						triangleByteLength: triangles.byteLength,
						triangleCount,
						depth,
						reportProgress: !! progressCallback,
						sharedReorderBuffer,
						treeletOptimization: {
							enabled: this.enableTreeletOptimization,
							size: this.treeletSize,
							passes: this.treeletOptimizationPasses,
							minImprovement: this.treeletMinImprovement
						},
						reinsertionOptimization: {
							enabled: this.enableReinsertionOptimization,
							batchSizeRatio: this.reinsertionBatchSizeRatio,
							maxIterations: this.reinsertionMaxIterations
						}
					};

					worker.postMessage( workerData, [ transferBuffer ] );

				};

				try {

					setupWorker( new BVHWorker() );

				} catch ( error ) {

					log.warn( 'worker creation failed, falling back to synchronous build:', error );
					resolve( this._buildSyncAndFlatten( triangles, depth, progressCallback ) );

				}

			} );

		} else {

			return new Promise( ( resolve ) => {

				resolve( this._buildSyncAndFlatten( triangles, depth, progressCallback ) );

			} );

		}

	}

	/**
	 * Synchronous build + flatten helper for non-worker path.
	 * @private
	 */
	_buildSyncAndFlatten( triangles, depth, progressCallback ) {

		const root = this.buildSync( triangles, depth, progressCallback );
		const bvhData = this.flattenBVH( root );
		// Return reordered triangles if available (avoids 362MB copy)
		const reorderedTriangles = this.reorderedTriangleData || null;
		const originalToBvh = this.originalToBvhMap || null;
		return { bvhData, bvhRoot: true, reorderedTriangles, originalToBvh };

	}

	buildSync( triangles, depth = 30, progressCallback = null, reorderTarget = null ) {

		const buildStartTime = performance.now();

		// Reset state
		this.totalNodes = 0;
		this.processedTriangles = 0;
		this.triangles = triangles;
		this.totalTriangles = triangles.byteLength / ( FPT * 4 );
		this.lastProgressUpdate = performance.now();

		this.splitStats = {
			sahSplits: 0,
			objectMedianSplits: 0,
			spatialMedianSplits: 0,
			failedSplits: 0,
			avgBinsUsed: 0,
			totalSplitAttempts: 0,
			mortonSortTime: 0,
			totalBuildTime: 0,
			treeletOptimizationTime: 0,
			treeletsProcessed: 0,
			treeletsImproved: 0,
			averageSAHImprovement: 0,
			reinsertionOptimizationTime: 0,
			reinsertionsApplied: 0,
			reinsertionIterations: 0,
			saOrderTime: 0,
			// Granular phase timings
			initTime: 0,
			sahBuildTime: 0,
			reorderTime: 0
		};

		const n = this.totalTriangles;

		// Phase 1: Allocate and initialize per-triangle arrays
		const initStart = performance.now();

		this.centroids = new Float32Array( n * 3 );
		this.bMin = new Float32Array( n * 3 );
		this.bMax = new Float32Array( n * 3 );
		this.indices = new Uint32Array( n );
		this.mortonCodes = new Uint32Array( n );

		this.initializeTriangleArrays();

		this.splitStats.initTime = performance.now() - initStart;

		// Phase 2: Morton code spatial clustering
		this.sortTrianglesByMortonCode();

		// Phase 3: Recursive SAH build
		const sahStart = performance.now();
		const root = this.buildNodeRecursive( 0, n, depth, progressCallback );
		this.splitStats.sahBuildTime = performance.now() - sahStart;

		// Phase 4: Treelet optimization
		if ( this.enableTreeletOptimization && this.totalTriangles > 1000 ) {

			const isLargeScene = this.totalTriangles > this.treeletComplexityThreshold;
			const adaptiveTreeletSize = isLargeScene ? 3 : this.treeletSize;
			const adaptiveMaxTreelets = isLargeScene ? 10 : this.maxTreeletsPerScene;

			const optimizer = new TreeletOptimizer( this.traversalCost, this.intersectionCost );
			optimizer.setTreeletSize( adaptiveTreeletSize );
			optimizer.setMinImprovement( this.treeletMinImprovement );
			optimizer.setMaxTreelets( adaptiveMaxTreelets );

			const optimizationStartTime = performance.now();

			for ( let pass = 0; pass < this.treeletOptimizationPasses; pass ++ ) {

				const passCallback = progressCallback ? ( status ) => {

					progressCallback( `Treelet optimization pass ${pass + 1}/${this.treeletOptimizationPasses}: ${status}` );

				} : null;

				try {

					optimizer.optimizeBVH( root, passCallback );

				} catch ( error ) {

					log.error( `treelet optimizer failed in pass ${pass + 1}:`, error );
					break;

				}

				// optimizeBVH resets stats internally, so afterStats reflects this pass only
				const afterStats = optimizer.getStatistics();
				const passTime = performance.now() - optimizationStartTime;
				if ( ( afterStats.treeletsImproved === 0 && pass > 0 ) || passTime > 15000 ) {

					break;

				}

			}

			const treeletTime = performance.now() - optimizationStartTime;
			this.splitStats.treeletOptimizationTime = treeletTime;
			const treeletStats = optimizer.getStatistics();
			this.splitStats.treeletsProcessed = treeletStats.treeletsProcessed;
			this.splitStats.treeletsImproved = treeletStats.treeletsImproved;
			this.splitStats.averageSAHImprovement = treeletStats.averageSAHImprovement;

		}

		// Phase 4b: Reinsertion optimization (Meister & Bittner)
		if ( this.enableReinsertionOptimization && this.totalTriangles > 1000 ) {

			const reinsertionOptimizer = new ReinsertionOptimizer( this.traversalCost, this.intersectionCost );
			reinsertionOptimizer.setBatchSizeRatio( this.reinsertionBatchSizeRatio );
			reinsertionOptimizer.setMaxIterations( this.reinsertionMaxIterations );

			const reinsertCallback = progressCallback ? ( status ) => {

				progressCallback( status );

			} : null;

			try {

				reinsertionOptimizer.optimizeBVH( root, reinsertCallback );

			} catch ( error ) {

				log.error( 'reinsertion optimizer failed:', error );

			}

			const reinsertStats = reinsertionOptimizer.getStatistics();
			this.splitStats.reinsertionOptimizationTime = reinsertStats.timeMs;
			this.splitStats.reinsertionsApplied = reinsertStats.reinsertionsApplied;
			this.splitStats.reinsertionIterations = reinsertStats.iterations;

		}

		// Phase 5: Surface-area child ordering (DFS cache locality)
		const saOrderStart = performance.now();
		this.applySAOrdering( root );
		this.splitStats.saOrderTime = performance.now() - saOrderStart;

		// Phase 6: Create reordered triangle data from final index order
		const reorderStart = performance.now();
		const triSrc = this.triangles;
		const reordered = reorderTarget || new Float32Array( n * FPT );
		for ( let i = 0; i < n; i ++ ) {

			const srcOff = this.indices[ i ] * FPT;
			const dstOff = i * FPT;
			reordered.set( triSrc.subarray( srcOff, srcOff + FPT ), dstOff );

		}

		this.reorderedTriangleData = reordered;

		// Phase 6b: Build inverse index map for BVH refit
		// originalToBvh[originalTriIdx] = bvhOrderIdx
		const originalToBvh = new Uint32Array( n );
		for ( let i = 0; i < n; i ++ ) {

			originalToBvh[ this.indices[ i ] ] = i;

		}

		this.originalToBvhMap = originalToBvh;

		this.splitStats.reorderTime = performance.now() - reorderStart;

		this.splitStats.totalBuildTime = performance.now() - buildStartTime;

		const total = this.splitStats.totalBuildTime;
		const s = this.splitStats;
		log.debug(
			`${fmt.n( n )} tris → ${fmt.n( this.totalNodes )} nodes in ${fmt.ms( total )}` +
			` | SAH ${s.sahSplits} objMed ${s.objectMedianSplits} spatMed ${s.spatialMedianSplits} failed ${s.failedSplits}` +
			( s.treeletsProcessed ? ` | treelets ${s.treeletsImproved}/${s.treeletsProcessed} improved` : '' ) +
			( s.reinsertionsApplied ? ` | reinsertions ${s.reinsertionsApplied}` : '' )
		);

		progressCallback && progressCallback( 100 );

		// Free flat arrays (no longer needed)
		this.centroids = null;
		this.bMin = null;
		this.bMax = null;
		this.mortonCodes = null;

		return root;

	}

	updateProgress( trianglesProcessed, progressCallback ) {

		if ( ! progressCallback ) return;

		this.processedTriangles += trianglesProcessed;
		const now = performance.now();
		if ( now - this.lastProgressUpdate < this.progressUpdateInterval ) return;

		this.lastProgressUpdate = now;
		const progress = Math.min( Math.floor( ( this.processedTriangles / this.totalTriangles ) * 100 ), 99 );
		progressCallback( progress );

	}

	// --- Top-level BVH build for parallel construction ---

	/**
	 * Build top levels of BVH, creating frontier leaves for parallel subtree construction.
	 * Frontier leaves are marked with `isFrontier = true` and recorded in `this.frontierTasks`.
	 * @param {number} start - Start index in indices array
	 * @param {number} end - End index in indices array
	 * @param {number} depth - Remaining depth budget for full tree
	 * @param {number} frontierDepthRemaining - Levels still to build before creating frontier leaves
	 * @param {Function} progressCallback - Optional progress callback
	 * @param {number} preMinX - Precomputed bounds (optional)
	 */
	buildNodeRecursiveToDepth( start, end, depth, frontierDepthRemaining, progressCallback, preMinX, preMinY, preMinZ, preMaxX, preMaxY, preMaxZ ) {

		const node = new BVHNode();
		this.totalNodes ++;

		const count = end - start;

		// Use precomputed bounds from parent's partition, or compute for root
		if ( preMinX !== undefined ) {

			node.minX = preMinX; node.minY = preMinY; node.minZ = preMinZ;
			node.maxX = preMaxX; node.maxY = preMaxY; node.maxZ = preMaxZ;

		} else {

			this.updateNodeBounds( node, start, end );

		}

		// Normal leaf condition (small enough to not need a subtree)
		if ( count <= this.maxLeafSize || depth <= 0 ) {

			node.triangleOffset = start;
			node.triangleCount = count;
			this.updateProgress( count, progressCallback );
			return node;

		}

		// Frontier condition: stop recursion and record as parallel task
		if ( frontierDepthRemaining <= 0 && count > this.maxLeafSize * 16 ) {

			const taskId = this.frontierTasks.length;
			node.triangleOffset = start;
			node.triangleCount = count;
			node.isFrontier = true;
			node.frontierTaskId = taskId;
			this.frontierTasks.push( {
				taskId,
				start,
				end,
				depth,
				preMinX: node.minX, preMinY: node.minY, preMinZ: node.minZ,
				preMaxX: node.maxX, preMaxY: node.maxY, preMaxZ: node.maxZ
			} );
			return node;

		}

		// Find best split using SAH
		const splitInfo = this.findBestSplitPositionSAH( start, end, node );

		if ( ! splitInfo.success ) {

			this.splitStats.failedSplits ++;

			// If we haven't reached frontier depth yet, make it a frontier task anyway
			if ( frontierDepthRemaining > 0 || count <= this.maxLeafSize * 16 ) {

				node.triangleOffset = start;
				node.triangleCount = count;
				this.updateProgress( count, progressCallback );
				return node;

			}

			const taskId = this.frontierTasks.length;
			node.triangleOffset = start;
			node.triangleCount = count;
			node.isFrontier = true;
			node.frontierTaskId = taskId;
			this.frontierTasks.push( {
				taskId,
				start,
				end,
				depth,
				preMinX: node.minX, preMinY: node.minY, preMinZ: node.minZ,
				preMaxX: node.maxX, preMaxY: node.maxY, preMaxZ: node.maxZ
			} );
			return node;

		}

		// Track split method
		if ( splitInfo.method === 'SAH' ) this.splitStats.sahSplits ++;
		else if ( splitInfo.method === 'object_median' ) this.splitStats.objectMedianSplits ++;
		else if ( splitInfo.method === 'spatial_median' ) this.splitStats.spatialMedianSplits ++;

		// Partition and compute child bounds in one pass
		this.partitionWithBounds( start, end, splitInfo.axis, splitInfo.pos );

		const p = this._partResult;
		const mid = p.mid;
		const lMnX = p.lMinX, lMnY = p.lMinY, lMnZ = p.lMinZ;
		const lMxX = p.lMaxX, lMxY = p.lMaxY, lMxZ = p.lMaxZ;
		const rMnX = p.rMinX, rMnY = p.rMinY, rMnZ = p.rMinZ;
		const rMxX = p.rMaxX, rMxY = p.rMaxY, rMxZ = p.rMaxZ;

		// Degenerate partition fallback
		if ( mid === start || mid === end ) {

			node.triangleOffset = start;
			node.triangleCount = count;
			this.updateProgress( count, progressCallback );
			return node;

		}

		node.leftChild = this.buildNodeRecursiveToDepth(
			start, mid, depth - 1, frontierDepthRemaining - 1, progressCallback,
			lMnX, lMnY, lMnZ, lMxX, lMxY, lMxZ
		);
		node.rightChild = this.buildNodeRecursiveToDepth(
			mid, end, depth - 1, frontierDepthRemaining - 1, progressCallback,
			rMnX, rMnY, rMnZ, rMxX, rMxY, rMxZ
		);

		return node;

	}

	// --- Recursive BVH build (operates on index range) ---

	buildNodeRecursive( start, end, depth, progressCallback, preMinX, preMinY, preMinZ, preMaxX, preMaxY, preMaxZ ) {

		const node = new BVHNode();
		this.totalNodes ++;

		const count = end - start;

		// Use precomputed bounds from parent's partition, or compute for root
		if ( preMinX !== undefined ) {

			node.minX = preMinX; node.minY = preMinY; node.minZ = preMinZ;
			node.maxX = preMaxX; node.maxY = preMaxY; node.maxZ = preMaxZ;

		} else {

			this.updateNodeBounds( node, start, end );

		}

		// Leaf condition
		if ( count <= this.maxLeafSize || depth <= 0 ) {

			node.triangleOffset = start;
			node.triangleCount = count;
			this.updateProgress( count, progressCallback );
			return node;

		}

		// Find best split using SAH
		const splitInfo = this.findBestSplitPositionSAH( start, end, node );

		if ( ! splitInfo.success ) {

			this.splitStats.failedSplits ++;
			node.triangleOffset = start;
			node.triangleCount = count;
			this.updateProgress( count, progressCallback );
			return node;

		}

		// Track split method
		if ( splitInfo.method === 'SAH' ) this.splitStats.sahSplits ++;
		else if ( splitInfo.method === 'object_median' ) this.splitStats.objectMedianSplits ++;
		else if ( splitInfo.method === 'spatial_median' ) this.splitStats.spatialMedianSplits ++;

		// Partition and compute child bounds in one pass
		this.partitionWithBounds( start, end, splitInfo.axis, splitInfo.pos );

		// Snapshot into locals — _partResult is reused and will be overwritten by child recursion
		const p = this._partResult;
		const mid = p.mid;
		const lMnX = p.lMinX, lMnY = p.lMinY, lMnZ = p.lMinZ;
		const lMxX = p.lMaxX, lMxY = p.lMaxY, lMxZ = p.lMaxZ;
		const rMnX = p.rMinX, rMnY = p.rMinY, rMnZ = p.rMinZ;
		const rMxX = p.rMaxX, rMxY = p.rMaxY, rMxZ = p.rMaxZ;

		// Degenerate partition fallback
		if ( mid === start || mid === end ) {

			node.triangleOffset = start;
			node.triangleCount = count;
			this.updateProgress( count, progressCallback );
			return node;

		}

		node.leftChild = this.buildNodeRecursive(
			start, mid, depth - 1, progressCallback,
			lMnX, lMnY, lMnZ, lMxX, lMxY, lMxZ
		);
		node.rightChild = this.buildNodeRecursive(
			mid, end, depth - 1, progressCallback,
			rMnX, rMnY, rMnZ, rMxX, rMxY, rMxZ
		);

		return node;

	}

	// Partition indices and accumulate child bounds in a single pass
	partitionWithBounds( start, end, axis, splitPos ) {

		const idx = this.indices;
		const c = this.centroids;
		const bMn = this.bMin;
		const bMx = this.bMax;

		let lo = start;
		let hi = end - 1;

		let lMinX = Infinity, lMinY = Infinity, lMinZ = Infinity;
		let lMaxX = - Infinity, lMaxY = - Infinity, lMaxZ = - Infinity;
		let rMinX = Infinity, rMinY = Infinity, rMinZ = Infinity;
		let rMaxX = - Infinity, rMaxY = - Infinity, rMaxZ = - Infinity;

		while ( lo <= hi ) {

			const triIdx = idx[ lo ];
			const o = triIdx * 3;

			if ( c[ o + axis ] <= splitPos ) {

				// Left partition — accumulate bounds
				if ( bMn[ o ] < lMinX ) lMinX = bMn[ o ];
				if ( bMn[ o + 1 ] < lMinY ) lMinY = bMn[ o + 1 ];
				if ( bMn[ o + 2 ] < lMinZ ) lMinZ = bMn[ o + 2 ];
				if ( bMx[ o ] > lMaxX ) lMaxX = bMx[ o ];
				if ( bMx[ o + 1 ] > lMaxY ) lMaxY = bMx[ o + 1 ];
				if ( bMx[ o + 2 ] > lMaxZ ) lMaxZ = bMx[ o + 2 ];
				lo ++;

			} else {

				// Right partition — accumulate bounds
				if ( bMn[ o ] < rMinX ) rMinX = bMn[ o ];
				if ( bMn[ o + 1 ] < rMinY ) rMinY = bMn[ o + 1 ];
				if ( bMn[ o + 2 ] < rMinZ ) rMinZ = bMn[ o + 2 ];
				if ( bMx[ o ] > rMaxX ) rMaxX = bMx[ o ];
				if ( bMx[ o + 1 ] > rMaxY ) rMaxY = bMx[ o + 1 ];
				if ( bMx[ o + 2 ] > rMaxZ ) rMaxZ = bMx[ o + 2 ];

				// Swap indices[lo] and indices[hi]
				idx[ lo ] = idx[ hi ];
				idx[ hi ] = triIdx;
				hi --;

			}

		}

		const r = this._partResult;
		r.mid = lo;
		r.lMinX = lMinX; r.lMinY = lMinY; r.lMinZ = lMinZ;
		r.lMaxX = lMaxX; r.lMaxY = lMaxY; r.lMaxZ = lMaxZ;
		r.rMinX = rMinX; r.rMinY = rMinY; r.rMinZ = rMinZ;
		r.rMaxX = rMaxX; r.rMaxY = rMaxY; r.rMaxZ = rMaxZ;
		return r;

	}

	updateNodeBounds( node, start, end ) {

		let minX = Infinity, minY = Infinity, minZ = Infinity;
		let maxX = - Infinity, maxY = - Infinity, maxZ = - Infinity;

		const idx = this.indices;
		const bMin = this.bMin;
		const bMax = this.bMax;

		for ( let i = start; i < end; i ++ ) {

			const o = idx[ i ] * 3;
			if ( bMin[ o ] < minX ) minX = bMin[ o ];
			if ( bMin[ o + 1 ] < minY ) minY = bMin[ o + 1 ];
			if ( bMin[ o + 2 ] < minZ ) minZ = bMin[ o + 2 ];
			if ( bMax[ o ] > maxX ) maxX = bMax[ o ];
			if ( bMax[ o + 1 ] > maxY ) maxY = bMax[ o + 1 ];
			if ( bMax[ o + 2 ] > maxZ ) maxZ = bMax[ o + 2 ];

		}

		node.minX = minX; node.minY = minY; node.minZ = minZ;
		node.maxX = maxX; node.maxY = maxY; node.maxZ = maxZ;

	}

	// --- SAH with prefix-sum (O(bins) per axis instead of O(bins²)) ---

	findBestSplitPositionSAH( start, end, parentNode ) {

		let bestCost = Infinity;
		let bestAxis = - 1;
		let bestPos = 0;

		const parentSA = this.computeSurfaceAreaFlat( parentNode.minX, parentNode.minY, parentNode.minZ, parentNode.maxX, parentNode.maxY, parentNode.maxZ );
		const count = end - start;
		const leafCost = this.intersectionCost * count;
		const currentBinCount = this.getOptimalBinCount( count );

		this.splitStats.totalSplitAttempts ++;
		this.splitStats.avgBinsUsed = ( ( this.splitStats.avgBinsUsed * ( this.splitStats.totalSplitAttempts - 1 ) ) + currentBinCount ) / this.splitStats.totalSplitAttempts;

		const idx = this.indices;
		const c = this.centroids;
		const bMn = this.bMin;
		const bMx = this.bMax;
		const bbMin = this.binBoundsMin;
		const bbMax = this.binBoundsMax;
		const bc = this.binCounts;
		const lpMin = this.leftPrefixMin;
		const lpMax = this.leftPrefixMax;
		const lpc = this.leftPrefixCount;
		const rpMin = this.rightPrefixMin;
		const rpMax = this.rightPrefixMax;
		const rpc = this.rightPrefixCount;

		// Single pass: find centroid bounds for all 3 axes
		let cMin0 = Infinity, cMax0 = - Infinity;
		let cMin1 = Infinity, cMax1 = - Infinity;
		let cMin2 = Infinity, cMax2 = - Infinity;

		for ( let i = start; i < end; i ++ ) {

			const o = idx[ i ] * 3;
			const c0 = c[ o ], c1 = c[ o + 1 ], c2 = c[ o + 2 ];
			if ( c0 < cMin0 ) cMin0 = c0; if ( c0 > cMax0 ) cMax0 = c0;
			if ( c1 < cMin1 ) cMin1 = c1; if ( c1 > cMax1 ) cMax1 = c1;
			if ( c2 < cMin2 ) cMin2 = c2; if ( c2 > cMax2 ) cMax2 = c2;

		}

		const centroidMin = [ cMin0, cMin1, cMin2 ];
		const centroidMax = [ cMax0, cMax1, cMax2 ];

		for ( let axis = 0; axis < 3; axis ++ ) {

			const minCentroid = centroidMin[ axis ];
			const maxCentroid = centroidMax[ axis ];

			if ( maxCentroid - minCentroid < 1e-6 ) continue;

			// Reset bins
			for ( let b = 0; b < currentBinCount; b ++ ) {

				bc[ b ] = 0;
				const b3 = b * 3;
				bbMin[ b3 ] = Infinity; bbMin[ b3 + 1 ] = Infinity; bbMin[ b3 + 2 ] = Infinity;
				bbMax[ b3 ] = - Infinity; bbMax[ b3 + 1 ] = - Infinity; bbMax[ b3 + 2 ] = - Infinity;

			}

			// Place triangles into bins
			const binScale = currentBinCount / ( maxCentroid - minCentroid );
			for ( let i = start; i < end; i ++ ) {

				const triIdx = idx[ i ];
				const cv = c[ triIdx * 3 + axis ];
				let bi = Math.floor( ( cv - minCentroid ) * binScale );
				if ( bi >= currentBinCount ) bi = currentBinCount - 1;

				bc[ bi ] ++;
				const b3 = bi * 3;
				const t3 = triIdx * 3;

				if ( bMn[ t3 ] < bbMin[ b3 ] ) bbMin[ b3 ] = bMn[ t3 ];
				if ( bMn[ t3 + 1 ] < bbMin[ b3 + 1 ] ) bbMin[ b3 + 1 ] = bMn[ t3 + 1 ];
				if ( bMn[ t3 + 2 ] < bbMin[ b3 + 2 ] ) bbMin[ b3 + 2 ] = bMn[ t3 + 2 ];
				if ( bMx[ t3 ] > bbMax[ b3 ] ) bbMax[ b3 ] = bMx[ t3 ];
				if ( bMx[ t3 + 1 ] > bbMax[ b3 + 1 ] ) bbMax[ b3 + 1 ] = bMx[ t3 + 1 ];
				if ( bMx[ t3 + 2 ] > bbMax[ b3 + 2 ] ) bbMax[ b3 + 2 ] = bMx[ t3 + 2 ];

			}

			// Build left prefix sums
			lpc[ 0 ] = bc[ 0 ];
			lpMin[ 0 ] = bbMin[ 0 ]; lpMin[ 1 ] = bbMin[ 1 ]; lpMin[ 2 ] = bbMin[ 2 ];
			lpMax[ 0 ] = bbMax[ 0 ]; lpMax[ 1 ] = bbMax[ 1 ]; lpMax[ 2 ] = bbMax[ 2 ];

			for ( let b = 1; b < currentBinCount; b ++ ) {

				const b3 = b * 3;
				const p3 = ( b - 1 ) * 3;
				lpc[ b ] = lpc[ b - 1 ] + bc[ b ];
				const lp0 = lpMin[ p3 ], lb0 = bbMin[ b3 ];
				const lp1 = lpMin[ p3 + 1 ], lb1 = bbMin[ b3 + 1 ];
				const lp2 = lpMin[ p3 + 2 ], lb2 = bbMin[ b3 + 2 ];
				lpMin[ b3 ] = lp0 < lb0 ? lp0 : lb0;
				lpMin[ b3 + 1 ] = lp1 < lb1 ? lp1 : lb1;
				lpMin[ b3 + 2 ] = lp2 < lb2 ? lp2 : lb2;
				const lxp0 = lpMax[ p3 ], lxb0 = bbMax[ b3 ];
				const lxp1 = lpMax[ p3 + 1 ], lxb1 = bbMax[ b3 + 1 ];
				const lxp2 = lpMax[ p3 + 2 ], lxb2 = bbMax[ b3 + 2 ];
				lpMax[ b3 ] = lxp0 > lxb0 ? lxp0 : lxb0;
				lpMax[ b3 + 1 ] = lxp1 > lxb1 ? lxp1 : lxb1;
				lpMax[ b3 + 2 ] = lxp2 > lxb2 ? lxp2 : lxb2;

			}

			// Build right prefix sums
			const last = currentBinCount - 1;
			const l3 = last * 3;
			rpc[ last ] = bc[ last ];
			rpMin[ l3 ] = bbMin[ l3 ]; rpMin[ l3 + 1 ] = bbMin[ l3 + 1 ]; rpMin[ l3 + 2 ] = bbMin[ l3 + 2 ];
			rpMax[ l3 ] = bbMax[ l3 ]; rpMax[ l3 + 1 ] = bbMax[ l3 + 1 ]; rpMax[ l3 + 2 ] = bbMax[ l3 + 2 ];

			for ( let b = last - 1; b >= 0; b -- ) {

				const b3 = b * 3;
				const n3 = ( b + 1 ) * 3;
				rpc[ b ] = rpc[ b + 1 ] + bc[ b ];
				const rn0 = rpMin[ n3 ], rb0 = bbMin[ b3 ];
				const rn1 = rpMin[ n3 + 1 ], rb1 = bbMin[ b3 + 1 ];
				const rn2 = rpMin[ n3 + 2 ], rb2 = bbMin[ b3 + 2 ];
				rpMin[ b3 ] = rn0 < rb0 ? rn0 : rb0;
				rpMin[ b3 + 1 ] = rn1 < rb1 ? rn1 : rb1;
				rpMin[ b3 + 2 ] = rn2 < rb2 ? rn2 : rb2;
				const rxn0 = rpMax[ n3 ], rxb0 = bbMax[ b3 ];
				const rxn1 = rpMax[ n3 + 1 ], rxb1 = bbMax[ b3 + 1 ];
				const rxn2 = rpMax[ n3 + 2 ], rxb2 = bbMax[ b3 + 2 ];
				rpMax[ b3 ] = rxn0 > rxb0 ? rxn0 : rxb0;
				rpMax[ b3 + 1 ] = rxn1 > rxb1 ? rxn1 : rxb1;
				rpMax[ b3 + 2 ] = rxn2 > rxb2 ? rxn2 : rxb2;

			}

			// Evaluate splits using prefix sums (O(bins) instead of O(bins²))
			for ( let i = 1; i < currentBinCount; i ++ ) {

				const leftIdx = ( i - 1 ) * 3;
				const rightIdx = i * 3;
				const leftCount = lpc[ i - 1 ];
				const rightCount = rpc[ i ];

				if ( leftCount === 0 || rightCount === 0 ) continue;

				// Inlined surface area: 2*(dx*dy + dy*dz + dz*dx)
				const ldx = lpMax[ leftIdx ] - lpMin[ leftIdx ];
				const ldy = lpMax[ leftIdx + 1 ] - lpMin[ leftIdx + 1 ];
				const ldz = lpMax[ leftIdx + 2 ] - lpMin[ leftIdx + 2 ];
				const leftSA = 2 * ( ldx * ldy + ldy * ldz + ldz * ldx );

				const rdx = rpMax[ rightIdx ] - rpMin[ rightIdx ];
				const rdy = rpMax[ rightIdx + 1 ] - rpMin[ rightIdx + 1 ];
				const rdz = rpMax[ rightIdx + 2 ] - rpMin[ rightIdx + 2 ];
				const rightSA = 2 * ( rdx * rdy + rdy * rdz + rdz * rdx );

				const cost = this.traversalCost +
					( leftSA / parentSA ) * leftCount * this.intersectionCost +
					( rightSA / parentSA ) * rightCount * this.intersectionCost;

				if ( cost < bestCost && cost < leafCost ) {

					bestCost = cost;
					bestAxis = axis;
					bestPos = minCentroid + ( maxCentroid - minCentroid ) * i / currentBinCount;

				}

			}

		}

		// Fallbacks
		if ( bestAxis === - 1 ) {

			if ( this.enableObjectMedianFallback ) return this.findObjectMedianSplit( start, end );
			if ( this.enableSpatialMedianFallback ) return this.findSpatialMedianSplit( start, end );
			return { success: false, method: 'fallbacks_disabled' };

		}

		return { success: true, axis: bestAxis, pos: bestPos, method: 'SAH', binsUsed: currentBinCount };

	}

	findObjectMedianSplit( start, end ) {

		const idx = this.indices;
		const c = this.centroids;
		let bestAxis = - 1;
		let bestSpread = - 1;

		for ( let axis = 0; axis < 3; axis ++ ) {

			let minC = Infinity, maxC = - Infinity;
			for ( let i = start; i < end; i ++ ) {

				const v = c[ idx[ i ] * 3 + axis ];
				if ( v < minC ) minC = v;
				if ( v > maxC ) maxC = v;

			}

			const spread = maxC - minC;
			if ( spread > bestSpread ) {

				bestSpread = spread;
				bestAxis = axis;

			}

		}

		if ( bestAxis === - 1 || bestSpread < 1e-10 ) {

			if ( this.enableSpatialMedianFallback ) return this.findSpatialMedianSplit( start, end );
			return { success: false, method: 'object_median_failed' };

		}

		// Quickselect to find median centroid value in O(N) average
		const count = end - start;
		const k = start + Math.floor( count / 2 );
		this.quickselect( start, end, k, bestAxis );

		let splitPos = c[ idx[ k ] * 3 + bestAxis ];

		// Quickselect guarantees [start,k) <= splitPos, so leftCount >= k-start > 0.
		// Check if degenerate: all elements at [k+1,end) also <= splitPos (all same value).
		let degenerate = true;
		for ( let i = k + 1; i < end; i ++ ) {

			if ( c[ idx[ i ] * 3 + bestAxis ] > splitPos ) {

				degenerate = false;
				break;

			}

		}

		if ( degenerate ) {

			// Nudge split between median and its left neighbor
			let leftMax = - Infinity;
			for ( let i = start; i < k; i ++ ) {

				const v = c[ idx[ i ] * 3 + bestAxis ];
				if ( v > leftMax ) leftMax = v;

			}

			if ( leftMax < splitPos ) {

				splitPos = ( leftMax + splitPos ) * 0.5;

			} else {

				if ( this.enableSpatialMedianFallback ) return this.findSpatialMedianSplit( start, end );
				return { success: false, method: 'object_median_degenerate' };

			}

		}

		return { success: true, axis: bestAxis, pos: splitPos, method: 'object_median' };

	}

	findSpatialMedianSplit( start, end ) {

		const idx = this.indices;
		const c = this.centroids;
		const bMn = this.bMin;
		const bMx = this.bMax;
		let bestAxis = - 1;
		let bestSpread = - 1;
		let bestMin = 0, bestMax = 0;

		for ( let axis = 0; axis < 3; axis ++ ) {

			let minB = Infinity, maxB = - Infinity;
			for ( let i = start; i < end; i ++ ) {

				const o = idx[ i ] * 3 + axis;
				if ( bMn[ o ] < minB ) minB = bMn[ o ];
				if ( bMx[ o ] > maxB ) maxB = bMx[ o ];

			}

			const spread = maxB - minB;
			if ( spread > bestSpread ) {

				bestSpread = spread;
				bestAxis = axis;
				bestMin = minB;
				bestMax = maxB;

			}

		}

		if ( bestAxis === - 1 || bestSpread < 1e-12 ) {

			return { success: false, method: 'spatial_median_failed' };

		}

		let splitPos = ( bestMin + bestMax ) * 0.5;

		// Verify split quality
		const count = end - start;
		let leftCount = 0;
		for ( let i = start; i < end; i ++ ) {

			if ( c[ idx[ i ] * 3 + bestAxis ] <= splitPos ) leftCount ++;

		}

		if ( leftCount === 0 || leftCount === count ) {

			// Force balanced via quickselect median (O(N) instead of O(N log N) sort)
			const k = start + Math.floor( count / 2 );
			this.quickselect( start, end, k, bestAxis );

			const medianVal = c[ idx[ k ] * 3 + bestAxis ];

			// Check if all centroids are identical on this axis
			let allSame = true;
			for ( let i = start; i < end; i ++ ) {

				if ( c[ idx[ i ] * 3 + bestAxis ] !== medianVal ) {

					allSame = false;
					break;

				}

			}

			if ( allSame ) {

				return { success: false, method: 'spatial_median_degenerate' };

			}

			// Nudge split between median and its neighbor to guarantee a non-empty partition
			let leftMax = - Infinity;
			for ( let i = start; i < k; i ++ ) {

				const v = c[ idx[ i ] * 3 + bestAxis ];
				if ( v > leftMax ) leftMax = v;

			}

			if ( leftMax < medianVal ) {

				splitPos = ( leftMax + medianVal ) * 0.5;

			} else {

				// leftMax == medianVal; find first element > medianVal in right half
				let rightMin = Infinity;
				for ( let i = k + 1; i < end; i ++ ) {

					const v = c[ idx[ i ] * 3 + bestAxis ];
					if ( v < rightMin ) rightMin = v;

				}

				splitPos = ( medianVal + rightMin ) * 0.5;

			}

		}

		return { success: true, axis: bestAxis, pos: splitPos, method: 'spatial_median' };

	}

	// --- Quickselect (Hoare's selection algorithm) ---

	quickselect( start, end, k, axis ) {

		const idx = this.indices;
		const c = this.centroids;

		let lo = start;
		let hi = end - 1;

		while ( lo < hi ) {

			// Median-of-three pivot selection
			const mid = ( lo + hi ) >>> 1;
			const vLo = c[ idx[ lo ] * 3 + axis ];
			const vMid = c[ idx[ mid ] * 3 + axis ];
			const vHi = c[ idx[ hi ] * 3 + axis ];

			// Sort lo, mid, hi and use mid as pivot
			if ( vLo > vMid ) {

				const t = idx[ lo ];
				idx[ lo ] = idx[ mid ];
				idx[ mid ] = t;

			}

			if ( vLo > vHi ) {

				const t = idx[ lo ];
				idx[ lo ] = idx[ hi ];
				idx[ hi ] = t;

			}

			if ( vMid > vHi ) {

				const t = idx[ mid ];
				idx[ mid ] = idx[ hi ];
				idx[ hi ] = t;

			}

			const pivot = c[ idx[ mid ] * 3 + axis ];

			// Partition around pivot
			let i = lo;
			let j = hi;

			while ( i <= j ) {

				while ( c[ idx[ i ] * 3 + axis ] < pivot ) i ++;
				while ( c[ idx[ j ] * 3 + axis ] > pivot ) j --;

				if ( i <= j ) {

					const t = idx[ i ]; idx[ i ] = idx[ j ]; idx[ j ] = t;
					i ++;
					j --;

				}

			}

			if ( j < k ) lo = i;
			if ( i > k ) hi = j;

		}

	}

	// --- Surface-area child ordering (DFS cache locality) ---

	/**
	 * Ensure left child always has >= surface area of right child.
	 * This places the larger subtree first in the DFS flat layout,
	 * improving cache locality during traversal.
	 * Iterative post-order to avoid stack overflow on deep trees.
	 */
	applySAOrdering( root ) {

		if ( ! root || ! root.leftChild ) return;

		// Iterative post-order traversal — swap after both children are processed
		const stack = [ root ];
		const order = [];

		while ( stack.length > 0 ) {

			const node = stack.pop();
			if ( ! node.leftChild || ! node.rightChild ) continue;

			order.push( node );
			stack.push( node.leftChild );
			stack.push( node.rightChild );

		}

		// Process in reverse (bottom-up)
		for ( let i = order.length - 1; i >= 0; i -- ) {

			const node = order[ i ];
			const L = node.leftChild;
			const R = node.rightChild;

			const ldx = L.maxX - L.minX, ldy = L.maxY - L.minY, ldz = L.maxZ - L.minZ;
			const rdx = R.maxX - R.minX, rdy = R.maxY - R.minY, rdz = R.maxZ - R.minZ;

			if ( rdx * rdy + rdy * rdz + rdz * rdx > ldx * ldy + ldy * ldz + ldz * ldx ) {

				node.leftChild = R;
				node.rightChild = L;

			}

		}

	}

	// --- BVH flattening (GPU-ready format) ---

	/**
	 * Flatten BVH tree into a Float32Array (16 floats per node).
	 * Layout per node (4 × vec4):
	 *   Inner: vec4( leftMin.xyz, leftChildIdx ) vec4( leftMax.xyz, rightChildIdx )
	 *          vec4( rightMin.xyz, 0 )           vec4( rightMax.xyz, 0 )
	 *   Leaf:  vec4( triOffset, triCount, 0, -1 ) [zeros × 12]
	 *
	 * This is the same format as TextureCreator.createBVHRawData,
	 * but runs inside the worker to avoid structured-clone overhead
	 * of transferring 1M+ BVHNode objects.
	 */
	flattenBVH( root ) {

		// First pass: assign indices via pre-order traversal
		const nodes = [];
		const stack = [ root ];
		while ( stack.length > 0 ) {

			const node = stack.pop();
			node._flatIndex = nodes.length;
			nodes.push( node );
			// Push right first so left is processed first (pre-order)
			if ( node.rightChild ) stack.push( node.rightChild );
			if ( node.leftChild ) stack.push( node.leftChild );

		}

		// Second pass: write flat data
		// Layout: 4 vec4 per node (16 floats)
		// Inner: [leftMin.xyz, leftChild] [leftMax.xyz, rightChild] [rightMin.xyz, 0] [rightMax.xyz, 0]
		// Leaf:  [triOffset, triCount, 0, -1] [0,0,0,0] [0,0,0,0] [0,0,0,0]
		const FLOATS_PER_NODE = 16;
		const data = new Float32Array( nodes.length * FLOATS_PER_NODE );

		for ( let i = 0; i < nodes.length; i ++ ) {

			const node = nodes[ i ];
			const o = i * FLOATS_PER_NODE;

			if ( node.leftChild ) {

				// Inner node: store children's AABBs
				const left = node.leftChild;
				const right = node.rightChild;

				data[ o ] = left.minX;
				data[ o + 1 ] = left.minY;
				data[ o + 2 ] = left.minZ;
				data[ o + 3 ] = left._flatIndex;

				data[ o + 4 ] = left.maxX;
				data[ o + 5 ] = left.maxY;
				data[ o + 6 ] = left.maxZ;
				data[ o + 7 ] = right._flatIndex;

				data[ o + 8 ] = right.minX;
				data[ o + 9 ] = right.minY;
				data[ o + 10 ] = right.minZ;
				// data[o+11] = 0 (padding)

				data[ o + 12 ] = right.maxX;
				data[ o + 13 ] = right.maxY;
				data[ o + 14 ] = right.maxZ;
				// data[o+15] = 0 (padding)

			} else {

				// Leaf node: triOffset, triCount in vec4(0), marked by leftChild = -1
				data[ o ] = node.triangleOffset;
				data[ o + 1 ] = node.triangleCount;
				// data[o+2] = 0 (padding)
				data[ o + 3 ] = - 1; // Leaf marker

			}

		}

		return data;

	}

	/**
	 * Flatten BVH tree marking frontier leaves with -2 sentinel.
	 * Returns the flat data and a frontier map for assembly.
	 * @param {BVHNode} root
	 * @returns {{ flatData: Float32Array, frontierMap: Array<{taskId: number, flatIndex: number}> }}
	 */
	flattenBVHWithFrontier( root ) {

		const FLOATS_PER_NODE = 16;

		// First pass: assign indices via pre-order traversal
		const nodes = [];
		const stack = [ root ];
		while ( stack.length > 0 ) {

			const node = stack.pop();
			node._flatIndex = nodes.length;
			nodes.push( node );
			if ( node.rightChild ) stack.push( node.rightChild );
			if ( node.leftChild ) stack.push( node.leftChild );

		}

		// Second pass: write flat data
		const data = new Float32Array( nodes.length * FLOATS_PER_NODE );
		const frontierMap = [];

		for ( let i = 0; i < nodes.length; i ++ ) {

			const node = nodes[ i ];
			const o = i * FLOATS_PER_NODE;

			if ( node.leftChild ) {

				// Inner node
				const left = node.leftChild;
				const right = node.rightChild;

				data[ o ] = left.minX;
				data[ o + 1 ] = left.minY;
				data[ o + 2 ] = left.minZ;
				data[ o + 3 ] = left._flatIndex;

				data[ o + 4 ] = left.maxX;
				data[ o + 5 ] = left.maxY;
				data[ o + 6 ] = left.maxZ;
				data[ o + 7 ] = right._flatIndex;

				data[ o + 8 ] = right.minX;
				data[ o + 9 ] = right.minY;
				data[ o + 10 ] = right.minZ;

				data[ o + 12 ] = right.maxX;
				data[ o + 13 ] = right.maxY;
				data[ o + 14 ] = right.maxZ;

			} else if ( node.isFrontier ) {

				// Frontier leaf: mark with -2 sentinel, use the taskId stored on the node
				const taskId = node.frontierTaskId;
				data[ o ] = node.triangleOffset;
				data[ o + 1 ] = node.triangleCount;
				data[ o + 2 ] = taskId;
				data[ o + 3 ] = - 2; // Frontier sentinel

				frontierMap.push( { taskId, flatIndex: i } );

			} else {

				// Regular leaf
				data[ o ] = node.triangleOffset;
				data[ o + 1 ] = node.triangleCount;
				data[ o + 3 ] = - 1; // Leaf marker

			}

		}

		return { flatData: data, frontierMap, nodeCount: nodes.length };

	}

	/**
	 * Assemble the final BVH from top-level flat data and parallel-built subtrees.
	 * @param {Float32Array} topFlatData - Flattened top-level tree with frontier sentinels
	 * @param {number} topNodeCount - Number of nodes in top-level tree
	 * @param {Array} frontierMap - Array of {taskId, flatIndex} from flattenBVHWithFrontier
	 * @param {Array<{taskId: number, flatData: Float32Array, nodeCount: number}>} subtreeResults
	 * @returns {Float32Array} Final GPU-ready BVH flat data
	 */
	assembleParallelBVH( topFlatData, topNodeCount, frontierMap, subtreeResults ) {

		const FLOATS_PER_NODE = 16;

		// Sort subtreeResults by taskId for consistent ordering
		const sortedResults = [ ...subtreeResults ].sort( ( a, b ) => a.taskId - b.taskId );

		// Calculate total node count
		let totalNodes = topNodeCount;
		for ( let i = 0; i < sortedResults.length; i ++ ) {

			totalNodes += sortedResults[ i ].nodeCount;

		}

		// Allocate final array
		const finalData = new Float32Array( totalNodes * FLOATS_PER_NODE );

		// Copy top-level data
		finalData.set( topFlatData );

		// Build taskId → frontierMap lookup
		const frontierByTaskId = new Map();
		for ( const entry of frontierMap ) {

			frontierByTaskId.set( entry.taskId, entry.flatIndex );

		}

		// Append each subtree and patch references
		let globalOffset = topNodeCount;

		for ( let i = 0; i < sortedResults.length; i ++ ) {

			const result = sortedResults[ i ];
			const subtreeData = result.flatData;
			const subtreeNodeCount = result.nodeCount;
			const destOffset = globalOffset * FLOATS_PER_NODE;

			// Copy subtree data into final array
			finalData.set( subtreeData, destOffset );

			// Adjust child indices within the subtree by adding globalOffset
			for ( let j = 0; j < subtreeNodeCount; j ++ ) {

				const o = destOffset + j * FLOATS_PER_NODE;

				// Check if inner node (not a leaf: leaf has -1 at o+3)
				if ( finalData[ o + 3 ] !== - 1 ) {

					// Adjust leftChildIndex and rightChildIndex
					finalData[ o + 3 ] += globalOffset;
					finalData[ o + 7 ] += globalOffset;

				}

			}

			// Overwrite frontier leaf with subtree root data
			const frontierFlatIndex = frontierByTaskId.get( result.taskId );
			if ( frontierFlatIndex !== undefined ) {

				const frontierOffset = frontierFlatIndex * FLOATS_PER_NODE;
				const subtreeRootOffset = destOffset;

				// Copy subtree root's 16 floats over the frontier leaf
				for ( let k = 0; k < FLOATS_PER_NODE; k ++ ) {

					finalData[ frontierOffset + k ] = finalData[ subtreeRootOffset + k ];

				}

			}

			globalOffset += subtreeNodeCount;

		}

		return finalData;

	}

	// --- Surface area helpers ---

	computeSurfaceAreaFlat( minX, minY, minZ, maxX, maxY, maxZ ) {

		const dx = maxX - minX;
		const dy = maxY - minY;
		const dz = maxZ - minZ;
		return 2 * ( dx * dy + dy * dz + dz * dx );

	}

}
