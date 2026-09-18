/**
 * BVHRefitWorker — Off-main-thread BVH refit using SharedArrayBuffer.
 *
 * Protocol:
 *   'init'  → receives the shared triangle and node buffers (once per scene)
 *   'refit' → recomputes every node's AABB from the triangles already written there
 *
 * Positions never reach here: the main thread scatters each mesh into the shared triangle
 * records as it reads it, so no buffer the size of the scene exists on either side.
 */

import { BVHRefitter } from '../BVHRefitter.js';
import { ChunkedRecords } from '../ChunkedRecords.js';

const refitter = new BVHRefitter();

// Cached shared memory views (set once on 'init', reused every frame)
let bvhData = null;
let triData = null;
let nodeCount = 0;

self.onmessage = function ( e ) {

	const { type } = e.data;

	if ( type === 'init' ) {

		bvhData = ChunkedRecords.adopt(
			e.data.sharedBvhBufs.map( buf => new Float32Array( buf ) ),
			e.data.bvhRecordCount, 16, e.data.bvhRecordsPerChunk
		);
		// Triangles arrive as one shared buffer per chunk; a single-chunk scene is the usual case.
		triData = ChunkedRecords.adopt(
			e.data.sharedTriBufs.map( buf => new Uint32Array( buf ) ),
			e.data.triRecordCount, e.data.triLanesPerRecord, e.data.triRecordsPerChunk
		);
		nodeCount = bvhData.recordCount;
		return;

	}

	if ( type === 'refit' ) {

		try {

			const startTime = performance.now();

			refitter.refit( bvhData, triData, nodeCount );

			self.postMessage( {
				type: 'refitComplete',
				refitTimeMs: performance.now() - startTime
			} );

		} catch ( error ) {

			console.error( '[BVHRefitWorker] Refit error:', error );
			self.postMessage( { type: 'error', error: error.message } );

		}

	}

};
