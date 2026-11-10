/**
 * One job of the compact layout's build off the page (pathtracer/CompactLayout.js): a range of triangles' corners, a
 * batch of objects' 4-wide trees, or a range of copy records, counted or packed.
 *
 * Input:  { type: 'corners' | 'wide' | 'copies', pieces, ...the job's own fields } — pieces as lanePieces gives them,
 *         a spilled one read on the page and moved
 * Output: what the job returns, its buffers transferred; or { error }
 */

import { runCompactJob } from './CompactJobs.js';

self.onmessage = async function ( e ) {

	try {

		const result = await runCompactJob( e.data );
		const transfer = Object.values( result ).filter( ( v ) => ArrayBuffer.isView( v ) ).map( ( v ) => v.buffer );
		self.postMessage( result, transfer );

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
