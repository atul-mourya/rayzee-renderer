/**
 * Materials address a texture by its position in the array, so a texture that cannot be read must
 * keep its slot. Dropping it shifted every later texture onto the wrong material.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { TextureCreator } from '@/core/Processor/TextureCreator.js';
import { IssueLog } from '@/core/EngineIssues.js';

class FakeBitmap {

	constructor( width = 4, height = 4 ) {

		this.width = width;
		this.height = height;

	}

	close() {}

}

describe( 'TextureCreator — worker preparation keeps every slot', () => {

	afterEach( () => vi.unstubAllGlobals() );

	it( 'puts a placeholder where a texture fails, and reports its layer', async () => {

		vi.stubGlobal( 'ImageBitmap', FakeBitmap );
		vi.stubGlobal( 'createImageBitmap', vi.fn( async ( source ) => {

			if ( source.corrupt ) throw new Error( 'decode failed' );
			return new FakeBitmap( source.width, source.height );

		} ) );

		const issues = new IssueLog();
		const creator = new TextureCreator( { issues } );
		const prepared = await creator.prepareTexturesForWorkerDirect( [
			{ image: new FakeBitmap( 8, 8 ) },
			{ image: { corrupt: true, width: 8, height: 8 } },
			{ image: null },
			{ image: new FakeBitmap( 16, 16 ) },
		] );

		expect( prepared ).toHaveLength( 4 );
		expect( prepared[ 0 ] ).toMatchObject( { isDirect: true, width: 8 } );
		expect( prepared[ 1 ] ).toMatchObject( { isImageData: true, width: 1, height: 1 } );
		expect( prepared[ 2 ] ).toMatchObject( { isImageData: true, width: 1, height: 1 } );
		expect( prepared[ 3 ] ).toMatchObject( { isDirect: true, width: 16 } );
		expect( new Uint8ClampedArray( prepared[ 1 ].data ) ).toEqual( new Uint8ClampedArray( [ 255, 255, 255, 255 ] ) );

		expect( issues.list.map( ( i ) => [ i.code, i.detail.layer ] ) ).toEqual( [
			[ 'texture.build_failed', 1 ],
			[ 'texture.build_failed', 2 ],
		] );

	} );

	it( 'throws when strict', async () => {

		const creator = new TextureCreator( { issues: new IssueLog( { strict: true } ) } );
		await expect( creator.prepareTexturesForWorkerDirect( [ { image: null } ] ) ).rejects.toThrow( /texture.build_failed/ );

	} );

} );
