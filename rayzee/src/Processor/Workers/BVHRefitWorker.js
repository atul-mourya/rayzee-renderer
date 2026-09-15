/**
 * BVHRefitWorker — Off-main-thread BVH refit using SharedArrayBuffer.
 *
 * Protocol:
 *   'init'  → receives SharedArrayBuffers + index map (once per scene)
 *   'refit' → reads shared positions, writes shared bvh/tri data (per frame)
 */

import { BVHRefitter } from '../BVHRefitter.js';
import { ChunkedRecords } from '../ChunkedRecords.js';

const FLOATS_PER_NODE = 16;
const refitter = new BVHRefitter();

// Cached shared memory views (set once on 'init', reused every frame)
let bvhData = null;
let triData = null;
let posData = null;
let bvhToOriginal = null;
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
		posData = new Float32Array( e.data.sharedPosBuf );
		bvhToOriginal = e.data.bvhToOriginal; // transferred Uint32Array
		nodeCount = bvhData.recordCount;
		return;

	}

	if ( type === 'refit' ) {

		try {

			const startTime = performance.now();

			refitter.updateTrianglePositions( triData, posData, bvhToOriginal );
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
