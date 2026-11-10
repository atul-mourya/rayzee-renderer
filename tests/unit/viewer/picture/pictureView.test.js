/**
 * The Results page's HDR picture shows a saved render's light only where that light is its picture: a save made while
 * another picture showed over the render (an AI upscale or neural pass) records it, and is not shown from its light.
 */
import { describe, it, expect } from 'vitest';
import { PictureView } from '@/core/viewer/picture/PictureView.js';
import { encodeEXR } from '@/core/output/ImageEncoders.js';

const saved = async ( record ) => {

	const data = new Float32Array( 4 ).fill( 0.5 );
	const channels = [ 'R', 'G', 'B', 'A' ].map( ( name, offset ) => ( { name, data, stride: 4, offset, type: 'half' } ) );
	return encodeEXR( { width: 1, height: 1, channels, text: { rayzee: JSON.stringify( record ) } } );

};

describe( 'PictureView.show', () => {

	const view = () => new PictureView( { color: { hdrOutput: true, hdrVersionOf: () => ( { table: null, reason: 'needs-config' } ) }, device: null }, null );

	it( 'leaves a save whose picture was another one over its light to that picture', async () => {

		const record = { display: { exposure: 1, overlay: { width: 820, height: 1024 } }, color: { view: 'AgX' } };
		expect( await view().show( await saved( record ) ) ).toEqual( { shown: false, reason: 'overlay' } );

	} );

	it( 'goes on to the view for a save whose light is its picture', async () => {

		for ( const overlay of [ null, undefined ] ) {

			const record = { display: { exposure: 1, overlay }, color: { view: 'AgX' } };
			expect( await view().show( await saved( record ) ) ).toEqual( { shown: false, reason: 'needs-config' } );

		}

	} );

} );
