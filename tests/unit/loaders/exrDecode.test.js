import { describe, it, expect, vi, afterEach } from 'vitest';
import { FloatType, HalfFloatType, LoadingManager } from 'three';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';

const created = vi.hoisted( () => ( { count: 0 } ) );
vi.mock( '@/core/loaders/EXRWorker.js?worker&inline', async () => {

	const { inProcessWorker } = await import( '../bvh/bvhInvariants.js' );
	const Base = inProcessWorker( () => import( '@/core/loaders/EXRWorker.js' ) );
	return { default: class extends Base {

		constructor() {

			super();
			created.count ++;

		}

	} };

} );

import { decodeEXR, WorkerEXRLoader } from '@/core/loaders/EXRDecode.js';
import { encodeEXR } from '@/core/output/ImageEncoders.js';
import { configurePlatform } from '@/core/Platform.js';

const width = 19, height = 23;
const rgba = Float32Array.from( { length: width * height * 4 }, ( _, i ) => ( ( i * 7919 ) % 1000 ) / 37 - 3 );

async function exrBytes() {

	const channels = [ 'R', 'G', 'B', 'A' ].map( ( name, offset ) => ( { name, data: rgba, stride: 4, offset, type: 'float' } ) );
	return new Uint8Array( await ( await encodeEXR( { width, height, channels } ) ).arrayBuffer() );

}

afterEach( () => {

	configurePlatform( { Worker: undefined } );
	vi.unstubAllGlobals();

} );

describe( 'decodeEXR', () => {

	for ( const workers of [ false, true ] ) {

		it( `decodes as EXRLoader.parse does, ${workers ? 'in a worker' : 'without workers'}`, async () => {

			if ( workers ) configurePlatform( { Worker: class {} } );
			const bytes = await exrBytes();

			for ( const type of [ FloatType, HalfFloatType ] ) {

				const want = new EXRLoader().setDataType( type ).parse( bytes.slice().buffer );
				const got = await decodeEXR( bytes.slice().buffer, { type } );
				expect( [ got.width, got.height, got.type, got.format, got.colorSpace ] ).toEqual( [ want.width, want.height, want.type, want.format, want.colorSpace ] );
				expect( got.data ).toEqual( want.data );

			}

		} );

	}

	it( 'shares up to four workers across a burst and rejects a file it cannot read', async () => {

		configurePlatform( { Worker: class {} } );
		created.count = 0;
		const bytes = await exrBytes();
		const all = await Promise.all( Array.from( { length: 10 }, () => decodeEXR( bytes.slice().buffer, { type: FloatType } ) ) );
		expect( all.every( r => r.width === width ) ).toBe( true );
		expect( created.count ).toBeGreaterThan( 0 );
		expect( created.count ).toBeLessThanOrEqual( 4 );

		await expect( decodeEXR( new Uint8Array( 64 ).buffer ) ).rejects.toThrow();

	} );

} );

describe( 'WorkerEXRLoader', () => {

	it( 'loads a texture as EXRLoader does, and the manager finishes only once it is decoded', async () => {

		configurePlatform( { Worker: class {} } );
		const bytes = await exrBytes();
		vi.stubGlobal( 'fetch', vi.fn( async () => new Response( bytes.slice() ) ) );
		vi.stubGlobal( 'ProgressEvent', class {

			constructor( type, init ) {

				Object.assign( this, init, { type } );

			}

		} );

		const done = vi.fn();
		const manager = new LoadingManager( done );
		const texture = await new WorkerEXRLoader( manager ).setDataType( FloatType ).loadAsync( 'https://example.com/sky.exr' );
		const want = new EXRLoader().setDataType( FloatType ).parse( bytes.slice().buffer );

		expect( [ texture.image.width, texture.image.height, texture.type, texture.flipY, texture.generateMipmaps ] ).toEqual( [ width, height, FloatType, false, false ] );
		expect( texture.image.data ).toEqual( want.data );
		await vi.waitFor( () => expect( done ).toHaveBeenCalledTimes( 1 ) );

	} );

} );
