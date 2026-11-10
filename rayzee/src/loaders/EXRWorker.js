import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

self.onmessage = ( { data } ) => {

	try {

		const result = new EXRLoader().setDataType( data.type ).setOutputFormat( data.outputFormat ).setPart( data.part ).parse( data.buffer );
		self.postMessage( { result }, [ result.data.buffer ] );

	} catch ( error ) {

		self.postMessage( { error: error?.message ?? String( error ) } );

	}

};
