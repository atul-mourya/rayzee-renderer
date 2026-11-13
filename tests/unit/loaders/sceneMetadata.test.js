import { describe, it, expect } from 'vitest';
import { extractSceneMetadata, parseSceneMetadata, withSceneAspect, requestedRender } from '@/core/loaders/SceneMetadata.js';
import { PerspectiveCamera } from 'three';

const PAYLOAD = {
	environment: {
		sourceFile: 'https://assets.rayzee.atulmourya.com/hdri/Polyhaven/raw/brown_photostudio_02_1k.hdr',
		rotation: 0,
		intensity: 1,
	},
};

describe( 'parseSceneMetadata', () => {

	it( 'reads what a file asks the renderer for, alone or beside an environment, keeping only positive counts', () => {

		expect( parseSceneMetadata( { rayzee: { render: { maxBounces: '15', samples: 1024, width: 0, height: - 2, fov: 40 } } } ) )
			.toEqual( { render: { maxBounces: 15, samples: 1024 } } );
		expect( parseSceneMetadata( { ...PAYLOAD, render: { samples: 64 } } ) ).toEqual( { ...PAYLOAD, render: { samples: 64 } } );
		expect( parseSceneMetadata( { render: { width: 0 } } ) ).toBeNull();

	} );

	it( 'reads the documented payload', () => {

		expect( parseSceneMetadata( PAYLOAD ) ).toEqual( PAYLOAD );

	} );

	it( 'accepts a JSON string container', () => {

		expect( parseSceneMetadata( JSON.stringify( PAYLOAD ) ) ).toEqual( PAYLOAD );

	} );

	it( 'accepts a stringified environment sub-object', () => {

		const stringified = { environment: JSON.stringify( PAYLOAD.environment ) };
		expect( parseSceneMetadata( stringified ) ).toEqual( PAYLOAD );

	} );

	it( 'accepts a rayzee-namespaced payload', () => {

		expect( parseSceneMetadata( { rayzee: PAYLOAD } ) ).toEqual( PAYLOAD );

	} );

	it( 'omits rotation and intensity when absent or non-numeric', () => {

		const metadata = parseSceneMetadata( { environment: { sourceFile: 'a.hdr', rotation: 'nope' } } );
		expect( metadata ).toEqual( { environment: { sourceFile: 'a.hdr' } } );

	} );

	it( 'parses numeric strings and clamps negative intensity to zero', () => {

		const metadata = parseSceneMetadata( { environment: { sourceFile: 'a.hdr', rotation: '90', intensity: '-2' } } );
		expect( metadata.environment ).toEqual( { sourceFile: 'a.hdr', rotation: 90, intensity: 0 } );

	} );

	it( 'keeps rotation 0 and intensity 0 rather than treating them as missing', () => {

		const metadata = parseSceneMetadata( { environment: { sourceFile: 'a.hdr', rotation: 0, intensity: 0 } } );
		expect( metadata.environment ).toEqual( { sourceFile: 'a.hdr', rotation: 0, intensity: 0 } );

	} );

	it( 'rejects containers with no usable environment url', () => {

		expect( parseSceneMetadata( { environment: {} } ) ).toBeNull();
		expect( parseSceneMetadata( { environment: { sourceFile: '   ' } } ) ).toBeNull();
		expect( parseSceneMetadata( { title: 'unrelated extras' } ) ).toBeNull();
		expect( parseSceneMetadata( 'not json' ) ).toBeNull();
		expect( parseSceneMetadata( null ) ).toBeNull();

	} );

} );

describe( 'extractSceneMetadata', () => {

	it( 'reads top-level glTF extras (gltf.userData)', () => {

		expect( extractSceneMetadata( { userData: PAYLOAD } ) ).toEqual( PAYLOAD );

	} );

	it( 'reads asset.extras', () => {

		expect( extractSceneMetadata( { userData: {}, asset: { extras: PAYLOAD } } ) ).toEqual( PAYLOAD );

	} );

	it( 'reads the active scene extras (scene.userData)', () => {

		expect( extractSceneMetadata( { userData: {}, scene: { userData: PAYLOAD } } ) ).toEqual( PAYLOAD );

	} );

	it( 'falls back to a non-active scene', () => {

		const gltf = { userData: {}, scene: { userData: {} }, scenes: [ { userData: {} }, { userData: PAYLOAD } ] };
		expect( extractSceneMetadata( gltf ) ).toEqual( PAYLOAD );

	} );

	it( 'returns null for a model with no metadata', () => {

		expect( extractSceneMetadata( { userData: {}, asset: { version: '2.0' }, scene: { userData: {} } } ) ).toBeNull();
		expect( extractSceneMetadata( null ) ).toBeNull();

	} );

} );

describe( 'withSceneAspect', () => {

	it( 'asks for the shape of the size the file requests, else of the camera the scene opens on, where it has one', () => {

		const camera = new PerspectiveCamera();
		camera.userData.aspect = 2.39;
		const pbrt = { environment: { enabled: false }, render: { integrator: 'path', width: 1280, height: 720 } };
		expect( withSceneAspect( pbrt, camera ) ).toEqual( { ...pbrt, render: { ...pbrt.render, aspect: 1280 / 720 } } );
		expect( withSceneAspect( null, camera ) ).toEqual( { render: { aspect: 2.39 } } );
		// USD's RenderSettings give their own, the pixels' shape included.
		expect( withSceneAspect( { render: { width: 500, height: 400, aspect: 2.5 } }, camera ).render.aspect ).toBe( 2.5 );
		expect( withSceneAspect( PAYLOAD, new PerspectiveCamera() ) ).toBe( PAYLOAD );
		expect( withSceneAspect( null ) ).toBeNull();

	} );

} );

describe( 'requestedRender', () => {

	const host = { width: 1920, height: 1080 };

	it( 'asks for nothing without a render block, or with one the host already matches', () => {

		expect( requestedRender( null, host ) ).toBeNull();
		expect( requestedRender( { width: 1920, height: 1080 }, host ) ).toBeNull();
		expect( requestedRender( { aspect: 16 / 9 }, host ) ).toBeNull();

	} );

	it( 'takes a pbrt file\'s settings by the engine\'s names, its samples and its size', () => {

		const render = {
			integrator: 'bidirectional', maxBounces: 17, samples: 64, width: 800, height: 600, aspect: 4 / 3,
			exposure: 0.5, whiteBalance: 6500, sampleClamp: 10, pixelFilter: 'gaussian', pixelFilterRadius: 1.5,
			pathRegularization: true, mergeRadius: 0.01,
		};
		expect( requestedRender( render, host ) ).toEqual( {
			settings: {
				integrator: 'bidirectional', maxBounces: 17, exposure: 0.5, whiteBalance: 6500, sampleClamp: 10,
				pixelFilter: 'gaussian', pixelFilterRadius: 1.5, pathRegularization: true,
			},
			samples: 64, width: 800, height: 600,
		} );

	} );

	it( 'reshapes the host\'s size to an asked aspect on its longer side', () => {

		expect( requestedRender( { aspect: 2 }, host ) ).toMatchObject( { width: 1920, height: 960 } );
		expect( requestedRender( { aspect: 0.5 }, host ) ).toMatchObject( { width: 960, height: 1920 } );
		expect( requestedRender( { aspect: 1 }, { width: 600, height: 800 } ) ).toMatchObject( { width: 800, height: 800 } );

	} );

	it( 'carries a panorama\'s projection and framing', () => {

		const render = { cameraProjection: 'equirectangular', panoramaLonRange: [ 90, - 270 ], panoramaLatRange: [ - 90, 90 ], panoramaLevelHorizon: false, aspect: 2 };
		expect( requestedRender( render, host ).settings ).toEqual( {
			cameraProjection: 'equirectangular', panoramaLonRange: [ 90, - 270 ], panoramaLatRange: [ - 90, 90 ], panoramaLevelHorizon: false,
		} );

	} );

	it( 'names only settings the engine has', async () => {

		const { ENGINE_DEFAULTS } = await import( '@/core/EngineDefaults.js' );
		const every = { integrator: 'path', maxBounces: 1, exposure: 1, whiteBalance: 1, sampleClamp: 1, pixelFilter: 'box', pixelFilterRadius: 1, pathRegularization: true, cameraProjection: 'perspective', panoramaLonRange: [ 0, 1 ], panoramaLatRange: [ 0, 1 ], panoramaLevelHorizon: true };
		for ( const key of Object.keys( requestedRender( every, host ).settings ) ) expect( ENGINE_DEFAULTS, key ).toHaveProperty( key );

	} );

} );
