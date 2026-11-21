import { describe, it, expect, beforeAll } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { decodePFM } from '@/core/loaders/PFM.js';
import { AssetLoader } from '@/core/loaders/AssetLoader.js';
import { pfmFormat } from '@/core/addons/formats.js';

const enc = new TextEncoder();

// three's FileLoader makes one per streamed chunk; Node has none.
beforeAll( () => {

	globalThis.ProgressEvent ??= class extends Event {};

} );

describe( 'PFM', () => {

	const pfm = ( header, floats, little ) => {

		const head = enc.encode( header );
		const bytes = new Uint8Array( head.length + floats.length * 4 );
		bytes.set( head );
		const view = new DataView( bytes.buffer, head.length );
		floats.forEach( ( v, i ) => view.setFloat32( i * 4, v, little ) );
		return bytes;

	};

	it( 'reads RGB rows bottom first in either byte order, scaled by |scale|', () => {

		const rows = [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 ];
		const little = decodePFM( pfm( 'PF\n2 2\n-1.0\n', rows, true ) );
		expect( [ little.width, little.height ] ).toEqual( [ 2, 2 ] );
		expect( [ ...little.data.slice( 0, 8 ) ] ).toEqual( [ 1, 2, 3, 1, 4, 5, 6, 1 ] );

		const big = decodePFM( pfm( 'PF\n2 2\n2\n', rows, false ) );
		expect( big.data[ 12 ] ).toBe( 20 );

	} );

	it( 'reads grey images into all three channels and rejects others', () => {

		const grey = decodePFM( pfm( 'Pf 1 1 -1 ', [ 0.5 ], true ) );
		expect( [ ...grey.data ] ).toEqual( [ 0.5, 0.5, 0.5, 1 ] );
		expect( () => decodePFM( enc.encode( 'P6\n1 1\n255\n' ) ) ).toThrow();
		expect( () => decodePFM( pfm( 'PF\n2 2\n-1\n', [ 1, 2 ], true ) ) ).toThrow( /truncated/ );

	} );

	it( 'opens as a sky once its format is registered', async () => {

		const loader = new AssetLoader( new Scene(), new PerspectiveCamera(), { target: new Vector3(), saveState() {}, update() {} } );
		const url = URL.createObjectURL( new Blob( [ pfm( 'PF\n2 1\n-1\n', [ 1, 2, 3, 4, 5, 6 ], true ) ] ) );
		loader._viaCache = async () => ( { url, cached: true, release() {} } );
		await expect( loader.loadEnvironmentByExtension( 'https://example.com/sky.pfm', 'pfm' ) ).rejects.toThrow( /rayzee\/addons\/formats/ );
		loader.registerFormat( pfmFormat );
		const sky = await loader.loadEnvironmentByExtension( 'https://example.com/sky.pfm', 'pfm' );
		URL.revokeObjectURL( url );
		expect( [ sky.image.width, sky.image.height ] ).toEqual( [ 2, 1 ] );
		expect( Array.from( sky.image.data ) ).toEqual( [ 1, 2, 3, 1, 4, 5, 6, 1 ] );

	} );

} );
