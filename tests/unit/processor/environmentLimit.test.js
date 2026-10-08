import { describe, expect, it } from 'vitest';
import { DataTexture, FloatType, RGBAFormat } from 'three';
import { limitEnvironmentWidth } from '@/core/Processor/AssetLoader.js';

function sky( width, height ) {

	const data = new Float32Array( width * height * 4 );
	for ( let i = 0; i < data.length; i ++ ) data[ i ] = ( ( i * 7919 ) % 101 ) / 10;
	return new DataTexture( data, width, height, RGBAFormat, FloatType );

}

describe( 'limitEnvironmentWidth', () => {

	it( 'averages whole blocks, keeping each block\'s light', () => {

		const texture = sky( 8, 4 );
		const before = texture.image.data.slice();
		limitEnvironmentWidth( texture, 4 );

		const { data, width, height } = texture.image;
		expect( [ width, height ] ).toEqual( [ 4, 2 ] );
		expect( data.length ).toBe( 4 * 2 * 4 );
		for ( let y = 0; y < 2; y ++ ) for ( let x = 0; x < 4; x ++ ) for ( let c = 0; c < 4; c ++ ) {

			let sum = 0;
			for ( let dy = 0; dy < 2; dy ++ ) for ( let dx = 0; dx < 2; dx ++ ) sum += before[ ( ( y * 2 + dy ) * 8 + x * 2 + dx ) * 4 + c ];
			expect( data[ ( y * 4 + x ) * 4 + c ] ).toBeCloseTo( sum / 4, 5 );

		}

	} );

	it( 'averages the partial blocks at the edges over what they cover', () => {

		const texture = sky( 7, 3 );
		const before = texture.image.data.slice();
		limitEnvironmentWidth( texture, 4 );

		const { data, width, height } = texture.image;
		expect( [ width, height ] ).toEqual( [ 4, 2 ] );
		// The last column and row hold one source texel: x = 6, y = 2.
		expect( data[ ( 1 * 4 + 3 ) * 4 ] ).toBeCloseTo( before[ ( 2 * 7 + 6 ) * 4 ], 5 );

	} );

	it( 'leaves a sky within the width, or one with no float pixels, alone', () => {

		const texture = sky( 4, 2 );
		const data = texture.image.data;
		limitEnvironmentWidth( texture, 4 );
		expect( texture.image.data ).toBe( data );

		const image = { width: 8, height: 4 };
		const ldr = { image };
		limitEnvironmentWidth( ldr, 4 );
		expect( ldr.image ).toBe( image );

	} );

} );
