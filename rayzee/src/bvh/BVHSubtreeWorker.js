import { BVHBuilder, setBVHCore } from './BVHBuilder.js';

self.onmessage = function ( e ) {

	const {
		tasks,
		sharedTriangleData, sharedCentroids, sharedBMin, sharedBMax, sharedIndices,
		triangleCount,
		maxLeafSize, numBins, maxBins, minBins,
		reinsertionConfig,
		reportProgress,
		bvhCore
	} = e.data;
	if ( bvhCore ) setBVHCore( bvhCore );

	// Process each task sequentially
	for ( let t = 0; t < tasks.length; t ++ ) {

		const task = tasks[ t ];

		try {

			const builder = new BVHBuilder();

			// Apply configuration
			builder.maxLeafSize = maxLeafSize;
			builder.numBins = numBins;
			builder.maxBins = maxBins;
			builder.minBins = minBins;

			// Attach shared buffer views (read-only for triangles/centroids/bounds,
			// write to disjoint [start,end) range for indices)
			builder.triangles = new Float32Array( sharedTriangleData );
			builder.centroids = new Float32Array( sharedCentroids );
			builder.bMin = new Float32Array( sharedBMin );
			builder.bMax = new Float32Array( sharedBMax );
			builder.indices = new Uint32Array( sharedIndices );
			builder.totalTriangles = triangleCount;

			// Reset build state
			builder.totalNodes = 0;
			builder.processedTriangles = 0;
			builder.lastProgressUpdate = performance.now();

			builder.splitStats = {
				sahSplits: 0, objectMedianSplits: 0, spatialMedianSplits: 0,
				failedSplits: 0, avgBinsUsed: 0, totalSplitAttempts: 0,
				mortonSortTime: 0, totalBuildTime: 0,
				initTime: 0, sahBuildTime: 0, reorderTime: 0
			};

			const progressCallback = reportProgress ? ( progress ) => {

				self.postMessage( {
					type: 'progress',
					taskId: task.taskId,
					progress
				} );

			} : null;

			const startTime = performance.now();

			// The subtree, reinserted and ordered, flat (local indices from 0)
			const flatData = builder.buildRangeFlat( task.start, task.end, task.depth, progressCallback, [
				task.preMinX, task.preMinY, task.preMinZ, task.preMaxX, task.preMaxY, task.preMaxZ
			], reinsertionConfig );
			const nodeCount = flatData.length / 16;

			const buildTime = performance.now() - startTime;
			console.log( `[BVHSubtreeWorker] Task ${task.taskId}: ${( task.end - task.start ).toLocaleString()} triangles, ${nodeCount} nodes, ${Math.round( buildTime )}ms` );

			self.postMessage( {
				type: 'subtreeResult',
				taskId: task.taskId,
				flatData,
				nodeCount
			}, [ flatData.buffer ] );

		} catch ( error ) {

			console.error( `[BVHSubtreeWorker] Task ${task.taskId} error:`, error );
			self.postMessage( {
				type: 'error',
				taskId: task.taskId,
				error: error.message
			} );

		}

	}

};
