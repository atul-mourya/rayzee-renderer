import { describe, it, expect } from 'vitest';
import { DataTexture } from 'three';
import { TextureCreator } from '@/core/Processor/TextureCreator.js';
import { IssueLog } from '@/core/EngineIssues.js';

// Rows 0..h-1, each filled with its own index, so orientation is visible.
function rows( width, height, { flipY = false } = {} ) {

	const data = new Uint8Array( width * height * 4 );
	for ( let y = 0; y < height; y ++ ) data.fill( y * 10, y * width * 4, ( y + 1 ) * width * 4 );
	const texture = new DataTexture( data, width, height );
	texture.flipY = flipY;
	return texture;

}

const layerRow = ( array, layer, row ) => {

	const { width, height } = array.image;
	return array.image.data[ ( layer * height + row ) * width * 4 ];

};

describe( 'TextureCreator — packing without a browser', () => {

	it( 'copies a layer that already fits its bucket exactly', () => {

		const creator = new TextureCreator();
		const packed = creator.processOnCPU( [ rows( 64, 4 ), rows( 64, 4 ) ] );

		expect( packed.image ).toMatchObject( { width: 64, height: 4, depth: 2 } );
		expect( [ 0, 1, 2, 3 ].map( ( y ) => layerRow( packed, 1, y ) ) ).toEqual( [ 0, 10, 20, 30 ] );

	} );

	it( 'puts the last row first for a flipY texture', () => {

		const packed = new TextureCreator().processOnCPU( [ rows( 64, 4, { flipY: true } ) ] );
		expect( [ 0, 1, 2, 3 ].map( ( y ) => layerRow( packed, 0, y ) ) ).toEqual( [ 30, 20, 10, 0 ] );

	} );

	it( 'resamples a smaller layer into the bucket', () => {

		const packed = new TextureCreator().processOnCPU( [ rows( 64, 4 ), rows( 64, 2 ) ] );
		const column = [ 0, 1, 2, 3 ].map( ( y ) => layerRow( packed, 1, y ) );

		expect( column[ 0 ] ).toBe( 0 );
		expect( column[ 3 ] ).toBe( 10 );
		expect( column[ 1 ] ).toBeGreaterThanOrEqual( column[ 0 ] );
		expect( column[ 2 ] ).toBeLessThanOrEqual( column[ 3 ] );

	} );

	it( 'keeps the slot of an image it cannot read, and says so', () => {

		const issues = new IssueLog();
		const creator = new TextureCreator( { issues } );
		const packed = creator.processOnCPU( [ { image: { width: 4, height: 4 } }, rows( 64, 4 ) ] );

		expect( packed.image.depth ).toBe( 2 );
		expect( layerRow( packed, 1, 3 ) ).toBe( 30 );
		expect( issues.list[ 0 ] ).toMatchObject( { code: 'texture.build_failed', detail: { layer: 0 } } );

	} );

} );
