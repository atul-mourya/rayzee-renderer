/**
 * Tessellates a run of a USD BasisCurves prim's curves off the main thread (PBRTCurves splitCurveSpec).
 *
 * Input:  { id, spec } — a tessellateCurves spec
 * Output: { id, built } — what tessellateCurves returns, its buffers transferred; or { id, error }
 */

import { tessellateCurves } from './PBRTCurves.js';

self.onmessage = async function ( e ) {

	const { id, spec } = e.data;

	try {

		const built = await tessellateCurves( spec );
		const transfer = built ? [ built.positions.buffer, built.indices.buffer, built.radii?.buffer, built.uvs?.buffer ].filter( Boolean ) : [];
		self.postMessage( { id, built }, transfer );

	} catch ( error ) {

		self.postMessage( { id, error: error.message } );

	}

};
