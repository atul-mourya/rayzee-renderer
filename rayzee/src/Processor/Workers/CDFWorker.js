/**
 * Web Worker for an environment map's sampling table (EnvironmentExactTable.js). Pure math — no Three.js dependencies.
 *
 * Input:  { floatData: Float32Array, width, height }
 * Output: { width, height } and the table
 */

import { buildExactEnvironmentTable } from '../EnvironmentExactTable.js';

self.onmessage = function ( e ) {

	const { floatData, width, height } = e.data;

	try {

		const table = buildExactEnvironmentTable( floatData, width, height );
		self.postMessage(
			{ width, height, ...table },
			[ table.exactConditional.buffer, table.exactMarginal.buffer, table.exactRowGuide.buffer, table.exactMarginalGuide.buffer ]
		);

	} catch ( error ) {

		self.postMessage( { error: error.message } );

	}

};
