import { afterEach, describe, expect, it, vi } from 'vitest';
import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { AssetLoader } from '@/core/loaders/AssetLoader.js';
import { EngineEvents, setStatusCallback } from '@/core/EngineEvents.js';

describe( 'download progress', () => {

	afterEach( () => {

		setStatusCallback( null );
		vi.restoreAllMocks();

	} );

	it( 'reports at most every 100 ms, the last chunk always', () => {

		let clock = 1000;
		vi.spyOn( performance, 'now' ).mockImplementation( () => clock );
		const sent = [];
		setStatusCallback( e => e.type === EngineEvents.LOADING_UPDATE && sent.push( e.loadedBytes ) );

		const loader = new AssetLoader( new Scene(), new PerspectiveCamera(), { target: new Vector3() } );
		const onProgress = loader._downloadProgress( 'Downloading Model...', true );
		const chunk = loaded => onProgress( { loaded, total: 100, lengthComputable: true } );

		chunk( 10 );
		clock += 30;
		chunk( 20 );
		clock += 30;
		chunk( 30 );
		expect( sent ).toEqual( [ 10 ] );

		clock += 40;
		chunk( 40 );
		expect( sent ).toEqual( [ 10, 40 ] );

		clock += 10;
		chunk( 100 );
		expect( sent ).toEqual( [ 10, 40, 100 ] );

	} );

} );
