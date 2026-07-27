/**
 * parallelBVHBuilder - Multi-core BVH construction orchestrator.
 *
 * This file is intentionally separate from BVHBuilder.js to avoid
 * circular worker imports. Workers import BVHBuilder; this file
 * creates workers — keeping them in the same module would create
 * a cycle that Vite cannot resolve.
 */

import BVHWorker from './Workers/BVHWorker.js?worker&inline';
import BVHSubtreeWorker from './Workers/BVHSubtreeWorker.js?worker&inline';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'bvh' );

const FPT = 32; // FLOATS_PER_TRIANGLE
const PARALLEL_THRESHOLD = 50000;
const MAX_PARALLEL_WORKERS = 8;

/**
 * Build BVH using multiple cores.
 *
 * Phase 1: Coordinator worker initializes data, builds top-level tree.
 * Phase 2: Subtree workers build independent subtrees in parallel.
 * Phase 3: Coordinator assembles final BVH and reorders triangles.
 *
 * @param {Float32Array} triangles - Triangle data (32 floats per triangle)
 * @param {number} depth - Maximum BVH depth
 * @param {Function|null} progressCallback - Optional progress callback (0-100)
 * @param {Object} config - Builder config (maxLeafSize, numBins, treelet settings, etc.)
 * @returns {Promise<{bvhData: Float32Array, bvhRoot: true, reorderedTriangles: Float32Array, splitStats: Object}>}
 */
export function buildBVHParallel( triangles, depth, progressCallback, config ) {

	const triangleCount = triangles.byteLength / ( FPT * 4 );
	const numWorkers = Math.min( navigator.hardwareConcurrency || 4, MAX_PARALLEL_WORKERS );
	const parallelDepth = Math.ceil( Math.log2( numWorkers * 2.5 + 1 ) );

	log.debug( `parallel build ${fmt.n( triangleCount )} triangles · ${numWorkers} workers · parallelDepth ${parallelDepth}` );

	return new Promise( ( resolve, reject ) => {

		( async () => {

			// Allocate SharedArrayBuffers
			const sharedTriangleData = new SharedArrayBuffer( triangles.byteLength );
			new Float32Array( sharedTriangleData ).set( triangles );

			const sharedCentroids = new SharedArrayBuffer( triangleCount * 3 * 4 );
			const sharedBMin = new SharedArrayBuffer( triangleCount * 3 * 4 );
			const sharedBMax = new SharedArrayBuffer( triangleCount * 3 * 4 );
			const sharedIndices = new SharedArrayBuffer( triangleCount * 4 );
			const sharedMortonCodes = new SharedArrayBuffer( triangleCount * 4 );
			const sharedReorderBuffer = new SharedArrayBuffer( triangleCount * FPT * 4 );

			// Phase 1: Coordinator worker
			const coordinatorWorker = new BVHWorker();

			let phase1Stats = null;
			const allWorkers = [ coordinatorWorker ];

			// Shared mutable state for phase 2 timer (accessible across closures)
			const timerRef = { id: null };

			// Guard against multiple fallback invocations from concurrent worker errors
			let settled = false;

			const cleanup = () => {

				if ( timerRef.id ) {

					clearTimeout( timerRef.id );
					timerRef.id = null;

				}

				for ( const w of allWorkers ) {

					try {

						w.terminate();

					} catch { /* ignore */ }

				}

			};

			const fallbackToSingle = ( reason ) => {

				if ( settled ) return;
				settled = true;
				log.warn( `parallel build failed (${reason}), falling back to single worker` );
				cleanup();
				// Copy from SharedArrayBuffer to regular ArrayBuffer for transfer
				const restoredBuffer = new ArrayBuffer( sharedTriangleData.byteLength );
				new Float32Array( restoredBuffer ).set( new Float32Array( sharedTriangleData ) );
				const restoredTriangles = new Float32Array( restoredBuffer );
				resolve( buildSingleWorker( restoredTriangles, depth, progressCallback, config ) );

			};

			coordinatorWorker.onerror = ( error ) => {

				fallbackToSingle( `coordinator error: ${error.message}` );

			};

			coordinatorWorker.onmessage = ( e ) => {

				const msg = e.data;

				if ( msg.error || msg.type === 'error' ) {

					fallbackToSingle( msg.error );
					return;

				}

				// Phase 1 progress
				if ( msg.type === 'progress' && progressCallback ) {

					const scaledProgress = Math.floor( msg.progress * 0.3 );
					progressCallback( scaledProgress );
					return;

				}

				// Phase 1 complete
				if ( msg.type === 'phase1Result' ) {

					phase1Stats = msg.splitStats;
					handlePhase2(
						msg, numWorkers, sharedTriangleData, sharedCentroids,
						sharedBMin, sharedBMax, sharedIndices, sharedReorderBuffer,
						triangleCount, progressCallback, coordinatorWorker,
						allWorkers, cleanup, fallbackToSingle, resolve, timerRef,
						config
					).catch( err => fallbackToSingle( err.message ) );
					return;

				}

				// Phase 3 complete
				if ( msg.type === 'assembleResult' ) {

					settled = true;
					cleanup();
					const reorderedTriangles = new Float32Array( sharedReorderBuffer );
					resolve( { bvhData: msg.bvhData, bvhRoot: true, reorderedTriangles, originalToBvh: msg.originalToBvh || null, splitStats: phase1Stats || {} } );
					return;

				}

			};

			// Start Phase 1
			progressCallback && progressCallback( 0 );

			coordinatorWorker.postMessage( {
				type: 'buildPhase1',
				sharedTriangleData,
				sharedCentroids,
				sharedBMin,
				sharedBMax,
				sharedIndices,
				sharedMortonCodes,
				triangleCount,
				depth,
				parallelDepth,
				reportProgress: !! progressCallback,
				treeletOptimization: config.treeletOptimization
			} );

		} )().catch( ( error ) => {

			log.warn( 'parallel build setup failed:', error );
			reject( error );

		} );

	} );

}

/**
 * Handle Phase 2: distribute subtree tasks to worker pool and collect results.
 * @private
 */
async function handlePhase2(
	phase1Result, numWorkers, sharedTriangleData, sharedCentroids,
	sharedBMin, sharedBMax, sharedIndices, sharedReorderBuffer,
	triangleCount, progressCallback, coordinatorWorker,
	allWorkers, cleanup, fallbackToSingle, resolve, timerRef,
	config
) {

	const { topFlatData, topNodeCount, frontierTasks, frontierMap } = phase1Result;

	if ( ! frontierTasks || frontierTasks.length === 0 ) {

		// No frontier tasks — top-level tree is the complete BVH
		// Still need to reorder triangles via coordinator
		log.debug( 'no frontier tasks, assembling with top-level tree only' );
		coordinatorWorker.postMessage( {
			type: 'assemble',
			topFlatData,
			topNodeCount,
			frontierMap: [],
			subtreeResults: [],
			sharedTriangleData,
			sharedIndices,
			sharedReorderBuffer,
			triangleCount
		}, [ topFlatData.buffer ] );
		return;

	}

	log.debug( `phase 2 distributing ${frontierTasks.length} tasks across ${numWorkers} workers` );

	// Distribute tasks using greedy least-loaded assignment
	const sortedTasks = [ ...frontierTasks ].sort( ( a, b ) => ( b.end - b.start ) - ( a.end - a.start ) );
	const workerTaskBuckets = Array.from( { length: Math.min( numWorkers, sortedTasks.length ) }, () => [] );
	const workerLoads = new Array( workerTaskBuckets.length ).fill( 0 );

	for ( const task of sortedTasks ) {

		// Find worker with least load
		let minIdx = 0;
		for ( let i = 1; i < workerLoads.length; i ++ ) {

			if ( workerLoads[ i ] < workerLoads[ minIdx ] ) minIdx = i;

		}

		workerTaskBuckets[ minIdx ].push( task );
		workerLoads[ minIdx ] += task.end - task.start;

	}

	// Track results
	const subtreeResults = [];
	let completedTasks = 0;
	const totalTasks = frontierTasks.length;
	const totalSubtreeTriangles = frontierTasks.reduce( ( sum, t ) => sum + ( t.end - t.start ), 0 );
	let completedSubtreeTriangles = 0;

	// Timeout for Phase 2
	timerRef.id = setTimeout( () => {

		fallbackToSingle( 'Phase 2 timeout (30s)' );

	}, 30000 );

	const onAllSubtreesDone = () => {

		clearTimeout( timerRef.id );
		timerRef.id = null;

		progressCallback && progressCallback( 85 );

		// Collect transferable buffers for Phase 3
		const transferables = [];

		if ( phase1Result.topFlatData && phase1Result.topFlatData.buffer ) {

			transferables.push( phase1Result.topFlatData.buffer );

		}

		for ( const result of subtreeResults ) {

			if ( result.flatData && result.flatData.buffer ) {

				transferables.push( result.flatData.buffer );

			}

		}

		// Phase 3: send to coordinator for assembly
		coordinatorWorker.postMessage( {
			type: 'assemble',
			topFlatData: phase1Result.topFlatData,
			topNodeCount,
			frontierMap,
			subtreeResults,
			sharedTriangleData,
			sharedIndices,
			sharedReorderBuffer,
			triangleCount
		}, transferables );

	};

	// Create subtree workers and dispatch
	const actualWorkerCount = workerTaskBuckets.length;

	for ( let w = 0; w < actualWorkerCount; w ++ ) {

		const bucket = workerTaskBuckets[ w ];
		if ( bucket.length === 0 ) continue;

		const subtreeWorker = new BVHSubtreeWorker();

		allWorkers.push( subtreeWorker );

		subtreeWorker.onerror = ( error ) => {

			fallbackToSingle( `subtree worker error: ${error.message}` );

		};

		subtreeWorker.onmessage = ( ev ) => {

			const msg = ev.data;

			if ( msg.type === 'error' ) {

				fallbackToSingle( `subtree task ${msg.taskId} error: ${msg.error}` );
				return;

			}

			if ( msg.type === 'progress' && progressCallback ) {

				const scaledProgress = 30 + Math.floor( ( completedSubtreeTriangles / totalSubtreeTriangles ) * 55 );
				progressCallback( Math.min( scaledProgress, 85 ) );
				return;

			}

			if ( msg.type === 'subtreeResult' ) {

				subtreeResults.push( {
					taskId: msg.taskId,
					flatData: msg.flatData,
					nodeCount: msg.nodeCount
				} );

				const task = frontierTasks.find( t => t.taskId === msg.taskId );
				if ( task ) completedSubtreeTriangles += task.end - task.start;

				completedTasks ++;

				if ( progressCallback ) {

					const scaledProgress = 30 + Math.floor( ( completedSubtreeTriangles / totalSubtreeTriangles ) * 55 );
					progressCallback( Math.min( scaledProgress, 85 ) );

				}

				if ( completedTasks === totalTasks ) {

					// Terminate subtree workers (not coordinator)
					for ( const sw of allWorkers ) {

						if ( sw !== coordinatorWorker ) {

							try {

								sw.terminate();

							} catch { /* ignore */ }

						}

					}

					onAllSubtreesDone();

				}

			}

		};

		subtreeWorker.postMessage( {
			tasks: bucket,
			sharedTriangleData,
			sharedCentroids,
			sharedBMin,
			sharedBMax,
			sharedIndices,
			triangleCount,
			maxLeafSize: config.maxLeafSize,
			numBins: config.numBins,
			maxBins: config.maxBins,
			minBins: config.minBins,
			treeletConfig: config.treeletOptimization,
			reinsertionConfig: config.reinsertionOptimization,
			reportProgress: !! progressCallback
		} );

	}

}

/**
 * Single-worker build path (used as fallback from parallel).
 * @private
 */
function buildSingleWorker( triangles, depth, progressCallback, config ) {

	return new Promise( ( resolve, reject ) => {

		( async () => {

			const worker = new BVHWorker();

			const triangleCount = triangles.byteLength / ( FPT * 4 );
			const useShared = typeof SharedArrayBuffer !== 'undefined';
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

				worker.terminate();
				const reorderedTriangles = sharedReorderBuffer
					? new Float32Array( sharedReorderBuffer )
					: transferredTriangles;

				resolve( { bvhData, bvhRoot: true, reorderedTriangles, originalToBvh: originalToBvh || null, splitStats: treeletStats || {} } );

			};

			worker.onerror = ( error ) => {

				worker.terminate();
				reject( error );

			};

			const transferBuffer = triangles.buffer;
			worker.postMessage( {
				triangleData: transferBuffer,
				triangleByteOffset: triangles.byteOffset,
				triangleByteLength: triangles.byteLength,
				triangleCount,
				depth,
				reportProgress: !! progressCallback,
				sharedReorderBuffer,
				treeletOptimization: config.treeletOptimization,
				reinsertionOptimization: config.reinsertionOptimization
			}, [ transferBuffer ] );

		} )().catch( ( error ) => {

			log.warn( 'single worker fallback failed:', error );
			reject( error );

		} );

	} );

}

/**
 * Check if parallel BVH build should be used.
 * @param {number} triangleCount
 * @returns {boolean}
 */
export function shouldUseParallelBuild( triangleCount ) {

	return typeof Worker !== 'undefined'
		&& typeof SharedArrayBuffer !== 'undefined'
		&& triangleCount >= PARALLEL_THRESHOLD;

}
