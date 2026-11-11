/**
 * Writes one Ptex file's faces into shared pages off the main thread (Ptex.js writePtexFile).
 *
 * Input:  { info, blocks, slots, pages, size, power } — pages are views of SharedArrayBuffers
 * Output: {} once written; or { error }
 */

import { writePtexFile } from './Ptex.js';

self.onmessage = function ( e ) {

	const { info, blocks, slots, pages, size, power } = e.data;

	try {

		writePtexFile( info, blocks, slots, pages, size, power );
		self.postMessage( {} );

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
