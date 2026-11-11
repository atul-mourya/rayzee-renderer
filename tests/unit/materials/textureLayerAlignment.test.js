/**
 * Materials address a texture by its position in the array, so a texture that cannot be read must
 * keep its slot. Dropping it shifted every later texture onto the wrong material.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DataTexture } from 'three';
import { TextureCreator, setImageReader, holdImages, releaseImages } from '@/core/materials/TextureCreator.js';
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

describe( 'TextureCreator — images a pack alone holds go to the worker as they are', () => {

	afterEach( () => vi.unstubAllGlobals() );

	const readable = ( bitmap, { flipY = false } = {} ) => {

		const texture = new DataTexture( null, 1, 1 );
		texture.image = bitmap;
		texture.flipY = flipY;
		const read = vi.fn( async () => new FakeBitmap( bitmap.width, bitmap.height ) );
		setImageReader( texture, read );
		return { texture, read };

	};

	it( 'hands over the bitmap for the worker to copy and thumbnail, and reads it again for the next hold', async () => {

		vi.stubGlobal( 'ImageBitmap', FakeBitmap );
		const copy = vi.fn( async ( source ) => new FakeBitmap( source.width, source.height ) );
		vi.stubGlobal( 'createImageBitmap', copy );

		const bitmap = new FakeBitmap( 512, 256 );
		const { texture, read } = readable( bitmap );
		await holdImages( [ texture ] );
		const [ prepared ] = await new TextureCreator().prepareTexturesForWorkerDirect( [ texture ] );

		expect( prepared.bitmap ).toBe( bitmap );
		expect( prepared ).toMatchObject( { copy: true, width: 512, height: 256, thumbnail: { id: 0, width: 128, height: 64 } } );
		expect( copy ).not.toHaveBeenCalled();
		expect( texture.image ).toMatchObject( { width: 512, height: 256, data: null } );

		releaseImages( [ texture ] );
		await holdImages( [ texture ] );
		expect( read ).toHaveBeenCalledOnce();
		expect( texture.image ).toBeInstanceOf( FakeBitmap );
		releaseImages( [ texture ] );

	} );

	it( 'copies a bitmap another pack also holds, and one the copy flips', async () => {

		vi.stubGlobal( 'ImageBitmap', FakeBitmap );
		const copy = vi.fn( async ( source ) => new FakeBitmap( source.width, source.height ) );
		vi.stubGlobal( 'createImageBitmap', copy );

		const shared = readable( new FakeBitmap( 8, 8 ) );
		const flipped = readable( new FakeBitmap( 8, 8 ), { flipY: true } );
		await holdImages( [ shared.texture, flipped.texture ] );
		await holdImages( [ shared.texture ] );
		const prepared = await new TextureCreator().prepareTexturesForWorkerDirect( [ shared.texture, flipped.texture ] );

		expect( copy ).toHaveBeenCalledTimes( 2 );
		expect( prepared.map( ( p ) => p.copy ?? false ) ).toEqual( [ false, false ] );
		expect( shared.texture.image ).toBeInstanceOf( FakeBitmap );
		expect( flipped.texture.image ).toBeInstanceOf( FakeBitmap );
		releaseImages( [ shared.texture, flipped.texture ] );
		releaseImages( [ shared.texture ] );

	} );

} );
