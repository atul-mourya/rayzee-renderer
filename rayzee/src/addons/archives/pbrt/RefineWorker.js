/**
 * Refines a displaced pbrt mesh off the main thread (LoopSubdivision refineMesh); the page moves it by its texture.
 *
 * Input:  { mesh, options } — refineMesh's arguments
 * Output: { refined } — what refineMesh returns, its buffers transferred; or { error }
 */

import { refineMesh } from './LoopSubdivision.js';

self.onmessage = function ( e ) {

	try {

		const refined = refineMesh( e.data.mesh, e.data.options );
		const { position, normal, uv, index, faces } = refined;
		self.postMessage( { refined }, [ position.buffer, normal.buffer, uv.buffer, index.buffer, faces?.buffer ].filter( Boolean ) );

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
