import { BVHBuilder } from '../BVHBuilder.js';
import { createLogger, fmt, applyWorkerLogLevel } from '../../utils/Logger.js';

const log = createLogger( 'bvh' );

const FPT = 32; // FLOATS_PER_TRIANGLE

// --- Message dispatcher ---

self.onmessage = function ( e ) {

	const data = e.data;
	const type = data.type;

	// Workers get their own globals, so the main thread forwards its level per message.
	applyWorkerLogLevel( data.logLevel );

	if ( type === 'buildPhase1' ) {

		handlePhase1( data );

	} else if ( type === 'assemble' ) {

		handleAssemble( data );

	} else {

		// Legacy: full single-worker build (backward compatible)
		handleFullBuild( data );

	}

};

// --- Phase 1: Init + Morton sort + top-level SAH build ---

function handlePhase1( data ) {

	const {
		sharedTriangleData, sharedCentroids, sharedBMin, sharedBMax,
		sharedIndices, sharedMortonCodes,
		triangleCount, depth, parallelDepth,
		reportProgress, treeletOptimization
	} = data;

	try {

		const builder = new BVHBuilder();

		if ( treeletOptimization ) {

			builder.setTreeletConfig( treeletOptimization );

		}

		const progressCallback = reportProgress ? ( progress ) => {

			self.postMessage( { type: 'progress', progress } );

		} : null;

		// Attach shared buffer views
		builder.triangles = new Float32Array( sharedTriangleData );
		builder.centroids = new Float32Array( sharedCentroids );
		builder.bMin = new Float32Array( sharedBMin );
		builder.bMax = new Float32Array( sharedBMax );
		builder.indices = new Uint32Array( sharedIndices );
		builder.mortonCodes = new Uint32Array( sharedMortonCodes );
		builder.totalTriangles = triangleCount;

		// Reset state
		builder.totalNodes = 0;
		builder.processedTriangles = 0;
		builder.lastProgressUpdate = performance.now();

		builder.splitStats = {
			sahSplits: 0, objectMedianSplits: 0, spatialMedianSplits: 0,
			failedSplits: 0, avgBinsUsed: 0, totalSplitAttempts: 0,
			mortonSortTime: 0, totalBuildTime: 0, treeletOptimizationTime: 0,
			treeletsProcessed: 0, treeletsImproved: 0, averageSAHImprovement: 0,
			initTime: 0, sahBuildTime: 0, reorderTime: 0
		};

		const startTime = performance.now();

		// Phase 1a: Initialize per-triangle arrays (writes into shared buffers)
		const initStart = performance.now();
		builder.initializeTriangleArrays();
		builder.splitStats.initTime = performance.now() - initStart;

		// Phase 1b: Morton code spatial clustering
		builder.sortTrianglesByMortonCode();

		// Phase 1c: Build top-level tree to parallelDepth
		builder.frontierTasks = [];
		const sahStart = performance.now();
		const root = builder.buildNodeRecursiveToDepth( 0, triangleCount, depth, parallelDepth, progressCallback );
		builder.splitStats.sahBuildTime = performance.now() - sahStart;

		// Phase 1d: Surface-area child ordering (DFS cache locality)
		builder.applySAOrdering( root );

		// Phase 1e: Flatten top-level tree with frontier sentinels
		const flattenStart = performance.now();
		const { flatData, frontierMap, nodeCount } = builder.flattenBVHWithFrontier( root );
		const flattenTime = performance.now() - flattenStart;

		const totalTime = performance.now() - startTime;
		log.debug( `phase 1 ${fmt.ms( totalTime )} (init ${fmt.ms( builder.splitStats.initTime )} · morton ${fmt.ms( builder.splitStats.mortonSortTime )} · SAH ${fmt.ms( builder.splitStats.sahBuildTime )} · flatten ${fmt.ms( flattenTime )}) · ${builder.frontierTasks.length} frontier tasks` );

		self.postMessage( {
			type: 'phase1Result',
			topFlatData: flatData,
			topNodeCount: nodeCount,
			frontierTasks: builder.frontierTasks,
			frontierMap,
			splitStats: builder.splitStats
		}, [ flatData.buffer ] );

	} catch ( error ) {

		log.error( 'phase 1 failed:', error );
		self.postMessage( { type: 'error', error: error.message } );

	}

}

// --- Phase 3: Assemble final BVH + reorder triangles ---

function handleAssemble( data ) {

	const {
		topFlatData, topNodeCount, frontierMap, subtreeResults,
		sharedTriangleData, sharedIndices, sharedReorderBuffer,
		triangleCount
	} = data;

	try {

		const startTime = performance.now();
		const builder = new BVHBuilder();

		// Assemble the final BVH
		const bvhData = builder.assembleParallelBVH(
			topFlatData, topNodeCount, frontierMap, subtreeResults
		);

		// Reorder triangles using final indices from SharedArrayBuffer
		const indices = new Uint32Array( sharedIndices );
		const src = new Float32Array( sharedTriangleData );
		const dst = new Float32Array( sharedReorderBuffer );

		for ( let i = 0; i < triangleCount; i ++ ) {

			const srcOff = indices[ i ] * FPT;
			const dstOff = i * FPT;
			dst.set( src.subarray( srcOff, srcOff + FPT ), dstOff );

		}

		// Build inverse index map for BVH refit
		const originalToBvh = new Uint32Array( triangleCount );
		for ( let i = 0; i < triangleCount; i ++ ) {

			originalToBvh[ indices[ i ] ] = i;

		}

		const totalTime = performance.now() - startTime;
		log.debug( `phase 3 assemble + reorder ${fmt.ms( totalTime )} (${fmt.mb( bvhData.byteLength )} BVH)` );

		self.postMessage( {
			type: 'assembleResult',
			bvhData,
			originalToBvh,
			triangleCount
		}, [ bvhData.buffer, originalToBvh.buffer ] );

	} catch ( error ) {

		log.error( 'assembly failed:', error );
		self.postMessage( { type: 'error', error: error.message } );

	}

}

// --- Legacy: full single-worker build ---

function handleFullBuild( data ) {

	const { triangleData, triangleByteOffset, triangleByteLength, depth, reportProgress, treeletOptimization, reinsertionOptimization, sharedReorderBuffer, maxLeafSize, numBins, maxBins, minBins } = data;
	const builder = new BVHBuilder();
	// Honor the build params forwarded from SceneProcessor (previously ignored → default leaf 8).
	if ( maxLeafSize !== undefined ) builder.maxLeafSize = maxLeafSize;
	if ( numBins !== undefined ) builder.numBins = numBins;
	if ( maxBins !== undefined ) builder.maxBins = maxBins;
	if ( minBins !== undefined ) builder.minBins = minBins;

	try {

		if ( treeletOptimization ) {

			builder.setTreeletConfig( treeletOptimization );

		}

		if ( reinsertionOptimization ) {

			builder.setReinsertionConfig( reinsertionOptimization );

		}

		const progressCallback = reportProgress ? ( progress ) => {

			self.postMessage( { progress } );

		} : null;

		const inputTriangles = triangleByteOffset !== undefined
			? new Float32Array( triangleData, triangleByteOffset, triangleByteLength / 4 )
			: new Float32Array( triangleData );

		const reorderTarget = sharedReorderBuffer
			? new Float32Array( sharedReorderBuffer )
			: null;

		const bvhRoot = builder.buildSync( inputTriangles, depth, progressCallback, reorderTarget );

		const flattenStart = performance.now();
		const bvhData = builder.flattenBVH( bvhRoot );
		const flattenTime = performance.now() - flattenStart;
		log.debug( `flatten ${fmt.ms( flattenTime )} (${fmt.mb( bvhData.byteLength )})` );

		const originalToBvh = builder.originalToBvhMap || null;

		if ( sharedReorderBuffer ) {

			const transferables = [ bvhData.buffer ];
			if ( originalToBvh ) transferables.push( originalToBvh.buffer );

			self.postMessage( {
				bvhData,
				originalToBvh,
				triangleCount: inputTriangles.length / 32,
				treeletStats: builder.splitStats
			}, transferables );

		} else {

			const reorderedFloat32Array = builder.reorderedTriangleData;
			const triangleCount = reorderedFloat32Array.byteLength / ( 32 * 4 );

			const transferables = [ bvhData.buffer, reorderedFloat32Array.buffer ];
			if ( originalToBvh ) transferables.push( originalToBvh.buffer );

			self.postMessage( {
				bvhData,
				triangles: reorderedFloat32Array,
				originalToBvh,
				triangleCount,
				treeletStats: builder.splitStats
			}, transferables );

		}

	} catch ( error ) {

		log.error( 'build failed:', error );
		self.postMessage( { error: error.message } );

	}

}
