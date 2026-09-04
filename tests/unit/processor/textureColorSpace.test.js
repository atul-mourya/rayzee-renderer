/**
 * A bucket array carries one colorSpace and the shader reads each material slot from a fixed
 * pool, so a texture whose declared encoding disagrees with its pool is re-encoded instead of
 * re-routed. An untagged texture must keep its pool's convention — that is what every loader
 * produces for glTF colour and data maps.
 */
import { describe, expect, it } from 'vitest';
import { DataTexture, LinearSRGBColorSpace, NoColorSpace, SRGBColorSpace } from 'three';
import { TextureCreator } from '@/core/Processor/TextureCreator.js';

const MID = 128;

// One 1x1 layer per texture, all mid-grey, so a re-encode is visible as a byte change.
function arrayTexOf( count ) {

	const data = new Uint8Array( count * 4 ).fill( MID );
	for ( let i = 0; i < count; i ++ ) data[ i * 4 + 3 ] = 200; // alpha must survive untouched
	return { image: { data, width: 1, height: 1, depth: count }, needsUpdate: false };

}

const texWith = colorSpace => {

	const t = new DataTexture( new Uint8Array( 4 ), 1, 1 );
	t.colorSpace = colorSpace;
	return t;

};

function harmonize( spaces, srgbPool ) {

	const arrayTex = arrayTexOf( spaces.length );
	new TextureCreator()._harmonizeTransfer( arrayTex, spaces.map( texWith ), srgbPool );
	return { data: arrayTex.image.data, needsUpdate: arrayTex.needsUpdate };

}

describe( 'TextureCreator — per-layer colour-space harmonization', () => {

	it( 'leaves a layer that already agrees with its pool untouched', () => {

		expect( harmonize( [ SRGBColorSpace ], true ).data[ 0 ] ).toBe( MID );
		expect( harmonize( [ LinearSRGBColorSpace ], false ).data[ 0 ] ).toBe( MID );

	} );

	it( 'defers to the pool convention when a texture declares nothing', () => {

		for ( const space of [ NoColorSpace, undefined ] ) {

			expect( harmonize( [ space ], true ).data[ 0 ] ).toBe( MID );
			expect( harmonize( [ space ], false ).data[ 0 ] ).toBe( MID );

		}

	} );

	it( 'encodes a linear texture bound for the colour pool, so the GPU decode round-trips', () => {

		// sRGB OETF of 128/255 is 188; the shader's decode returns the original mid-grey.
		const { data, needsUpdate } = harmonize( [ LinearSRGBColorSpace ], true );
		expect( data[ 0 ] ).toBeGreaterThan( MID );
		expect( data[ 0 ] ).toBe( 188 );
		expect( needsUpdate ).toBe( true );

	} );

	it( 'decodes an sRGB texture bound for the data pool, which gets no GPU decode', () => {

		const { data } = harmonize( [ SRGBColorSpace ], false );
		expect( data[ 0 ] ).toBeLessThan( MID );
		expect( data[ 0 ] ).toBe( 55 );

	} );

	it( 'converts only the disagreeing layer, and never alpha', () => {

		const { data } = harmonize( [ SRGBColorSpace, LinearSRGBColorSpace, NoColorSpace ], true );
		expect( [ data[ 0 ], data[ 4 ], data[ 8 ] ] ).toEqual( [ MID, 188, MID ] );
		expect( [ data[ 3 ], data[ 7 ], data[ 11 ] ] ).toEqual( [ 200, 200, 200 ] );

	} );

	it( 'keeps layer order when a texture without an image is dropped', () => {

		// _normalizeTexturesForProcessing skips imageless textures, so layer 0 is the linear one.
		const arrayTex = arrayTexOf( 1 );
		const imageless = new DataTexture( new Uint8Array( 4 ), 1, 1 );
		imageless.image = null;
		new TextureCreator()._harmonizeTransfer( arrayTex, [ imageless, texWith( LinearSRGBColorSpace ) ], true );
		expect( arrayTex.image.data[ 0 ] ).toBe( 188 );

	} );

	it( 'is a no-op on a texture array with no pixel data', () => {

		expect( () => new TextureCreator()._harmonizeTransfer( null, [], true ) ).not.toThrow();
		expect( () => new TextureCreator()._harmonizeTransfer( {}, [], false ) ).not.toThrow();

	} );

} );
