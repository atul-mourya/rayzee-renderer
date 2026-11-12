/**
 * Bakes a band of rows of a pbrt texture bake (PBRTTextureBake bakeRows).
 *
 * Input:  { plan, combine, alpha, linear, perChannel, j0, j1 } — combine and alpha named as data (combineOf), the
 *         plan's large layers in shared memory
 * Output: { done: true, band } (rows j0..j1, transferred), or { error }
 */

import { bakeRows, combineOf } from './PBRTTextureBake.js';

self.onmessage = function ( e ) {

	const { plan, combine, alpha, linear, perChannel, j0, j1 } = e.data;

	try {

		const band = new Uint8Array( ( j1 - j0 ) * plan.width * 4 );
		bakeRows( plan, combineOf( combine ), { alphaOf: alpha ? combineOf( alpha ) : null, linear, perChannel }, j0, j1, band, j0 );
		self.postMessage( { done: true, band }, [ band.buffer ] );

	} catch ( error ) {

		self.postMessage( { error: String( error?.message || error || 'bake failed' ) } );

	}

};
