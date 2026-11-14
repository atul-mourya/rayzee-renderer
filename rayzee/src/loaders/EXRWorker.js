import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { withoutWarning } from '../Logger.js';

self.onmessage = ( { data } ) => {

	try {

		// three skips OpenEXR's camera matrices (m44f), as it should, with a warning each.
		const result = withoutWarning( '\'m44f\'', () => new EXRLoader().setDataType( data.type ).setOutputFormat( data.outputFormat ).setPart( data.part ).parse( data.buffer ) );
		self.postMessage( { result }, [ result.data.buffer ] );

	} catch ( error ) {

		self.postMessage( { error: error?.message ?? String( error ) } );

	}

};
