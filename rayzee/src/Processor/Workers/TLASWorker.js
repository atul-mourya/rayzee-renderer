/**
 * Builds the TLAS off the main thread.
 *
 * Only the SAH tree runs here — it is the O(n log n) half, and at 6M placements it pinned the
 * main thread for 25 s. The leaf payloads (BLAS pointer, visibility, world-to-object matrix)
 * are filled in by the caller afterwards: that pass is O(n) and cheap, and keeping it out of
 * the message avoids shipping a 16-float matrix per instance across the boundary.
 */

import { TLASBuilder } from '../TLASBuilder.js';
import { createLogger, fmt, applyWorkerLogLevel } from '../../utils/Logger.js';

const log = createLogger( 'bvh' );

self.onmessage = function ( e ) {

	const { aabbs, count, logLevel } = e.data;
	applyWorkerLogLevel( logLevel );

	try {

		const start = performance.now();
		// A fresh builder per message sizes its buffer exactly, so the result's ArrayBuffer can
		// be transferred whole rather than copied out of a reused, oversized one.
		const { data, nodeCount } = new TLASBuilder().buildStructure( new Float64Array( aabbs ), count );
		log.debug( `TLAS ${fmt.n( nodeCount )} nodes in ${fmt.ms( performance.now() - start )}` );

		self.postMessage( { tlasData: data, nodeCount }, [ data.buffer ] );

	} catch ( error ) {

		log.error( 'TLAS build failed:', error );
		self.postMessage( { error: error.message } );

	}

};
