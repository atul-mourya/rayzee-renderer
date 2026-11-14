import { readVolumeFrame } from './OpenVDB.js';

self.onmessage = ( { data } ) => {

	try {

		const { grid, emission, factor } = readVolumeFrame( data.bytes, data.request );
		const plain = ( g ) => g && { width: g.width, height: g.height, depth: g.depth, data: g.data, transform: g.transform.elements, name: g.name };
		self.postMessage( { result: { grid: plain( grid ), emission: plain( emission ), factor } }, [ grid?.data.buffer, emission?.data.buffer ].filter( Boolean ) );

	} catch ( error ) {

		self.postMessage( { error: error?.message ?? String( error ) } );

	}

};
