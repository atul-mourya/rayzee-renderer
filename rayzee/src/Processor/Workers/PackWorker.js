/**
 * Packs RGBA8 layers into one texture array off the main thread, for hosts without a browser, where
 * TextureCreator.processOnCPU would otherwise hold up the BVH workers it feeds.
 *
 * Input:  { layers: [{ data: Uint8Array (SharedArrayBuffer-backed), width, height, flipY }], width, height }
 * Output: { data: Uint8Array } — its buffer transferred
 */

import { resampleRGBA8 } from '../ResampleRGBA8.js';

self.onmessage = function ( e ) {

	const { layers, width, height } = e.data;

	try {

		const layerBytes = width * height * 4;
		const data = new Uint8Array( layerBytes * layers.length );
		layers.forEach( ( layer, i ) => resampleRGBA8( layer, data, i * layerBytes, width, height ) );
		self.postMessage( { data }, [ data.buffer ] );

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
