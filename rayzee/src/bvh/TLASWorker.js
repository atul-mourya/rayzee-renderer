/**
 * Builds the TLAS off the main thread, and groups copies into clusters ({ type: 'runs' }: InstanceTable
 * splitIntoRuns over a range of shared `sorted` and `world`, its ranges past `floor` handed back).
 *
 * Only the SAH tree runs here — it is the O(n log n) half, and at 6M placements it pinned the
 * main thread for 25 s. The leaf payloads (BLAS pointer, visibility, world-to-object matrix)
 * are filled in by the caller afterwards: that pass is O(n) and cheap, and keeping it out of
 * the message avoids shipping a 16-float matrix per instance across the boundary.
 */

import { TLASBuilder } from './TLASBuilder.js';
import { splitIntoRuns } from '../scene/InstanceTable.js';
import { createLogger, fmt, applyWorkerLogLevel } from '../Logger.js';

const log = createLogger( 'bvh' );

self.onmessage = function ( e ) {

	if ( e.data.type === 'runs' ) {

		try {

			const { sorted, world, lo, hi, floor } = e.data;
			const ranges = [];
			const steps = splitIntoRuns( new Int32Array( sorted ), lo, hi, new Float32Array( world ), floor, ranges );
			while ( ! steps.next().done );
			self.postMessage( { ranges } );

		} catch ( error ) {

			self.postMessage( { error: error.message } );

		}

		return;

	}

	const { aabbs, count, logLevel, chunks = null, perChunk = 0 } = e.data;
	applyWorkerLogLevel( logLevel );

	try {

		const start = performance.now();
		// Into the caller's shared chunks when it sends them: nothing to send back. Otherwise a fresh builder per
		// message sizes its buffer exactly, so the result's ArrayBuffer can be transferred whole.
		const into = chunks ? { chunks: chunks.map( ( b ) => new Float32Array( b ) ), perChunk } : null;
		const { data, nodeCount } = new TLASBuilder().buildStructure( new Float64Array( aabbs ), count, into );
		log.debug( `TLAS ${fmt.n( nodeCount )} nodes in ${fmt.ms( performance.now() - start )}` );

		if ( into ) self.postMessage( { tlasData: null, nodeCount } );
		else self.postMessage( { tlasData: data, nodeCount }, [ data.buffer ] );

	} catch ( error ) {

		log.error( 'TLAS build failed:', error );
		self.postMessage( { error: error.message } );

	}

};
