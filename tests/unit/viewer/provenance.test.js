import { describe, it, expect } from 'vitest';
import { REVISION, PerspectiveCamera, Matrix4, Vector3 } from 'three';
import { viewMatrixOf } from '@/core/scene/ViewCamera.js';
import { PathTracerApp } from '@/core/viewer/PathTracerApp.js';
import { VERSION } from '@/core/Version.js';

describe( 'getProvenance', () => {

	it( 'names what produced an image, as plain JSON', () => {

		const app = new PathTracerApp( null, { strict: true } );
		app.adapterInfo = { vendor: 'apple', architecture: 'metal-3', isSoftware: false };

		const provenance = app.getProvenance();

		expect( JSON.parse( JSON.stringify( provenance ) ) ).toEqual( provenance );
		expect( provenance ).toMatchObject( {
			engine: VERSION,
			three: REVISION,
			adapter: { vendor: 'apple' },
			mode: { headless: true, strict: true, deterministic: false, lockstep: false },
			render: null,
		} );

	} );

	it( 'carries each setting with where it came from', () => {

		const app = new PathTracerApp( null );
		app.settings.set( 'maxBounces', 7, { silent: true, reset: false } );

		const { settings } = app.getProvenance();
		expect( settings.maxBounces ).toMatchObject( { value: 7, source: 'host' } );
		expect( settings.maxSamples.source ).toBe( 'default' );

	} );

	it( 'says which display-only exposure shaped an sRGB readback, since no setting records it', () => {

		const app = new PathTracerApp( null );
		expect( app.getProvenance().exposure ).toEqual( { auto: null, local: null } );

		app.stages.autoExposure = { enabled: true, getExposure: () => 2, strength: 0.3, metering: 'center', keyValue: 0.18 };
		app.stages.localExposure = { enabled: true, highlightContrast: 0.6, shadowContrast: 1, detailStrength: 1 };
		expect( app.getProvenance().exposure ).toEqual( {
			auto: { exposure: 2, strength: 0.3, metering: 'center', keyValue: 0.18 },
			local: { highlightContrast: 0.6, shadowContrast: 1, detailStrength: 1 },
		} );

	} );

	it( 'says which denoiser made the picture, since a denoised readback depends on its model', () => {

		const app = new PathTracerApp( null );
		expect( app.getProvenance().denoise ).toEqual( { live: 'none', final: null } );

		app.denoisingManager = {
			denoiserStrategy: 'oidn', finalDenoise: true, oidnQuality: 'high',
			denoiser: { currentTZAUrl: 'https://cdn/oidn/rt_hdr_calb_cnrm_large.tza', getRuntimeInfo: () => ( { precision: 'fp16' } ), _activeTileSize: 1056 },
		};
		expect( app.getProvenance().denoise ).toEqual( {
			live: 'oidn',
			final: { quality: 'high', weights: 'rt_hdr_calb_cnrm_large.tza', precision: 'fp16', tileSize: 1056 },
		} );

	} );

	it( 'says what the picture was shown at, so a saved copy of its light can be shown again', () => {

		const app = new PathTracerApp( null );
		expect( app.getProvenance().display ).toEqual( { exposure: null, backdrop: null, backdropExposure: null, overlay: null } );

		app.renderer = { toneMappingExposure: 2.5 };
		app.stages.compositor = { backdropExposure: 1 };
		expect( app.getProvenance().display ).toMatchObject( { exposure: 2.5, backdropExposure: 1 } );

		// A picture over the render (an AI upscale or neural pass): its light is not that picture.
		app._displayCanvas = () => ( { width: 820, height: 1024 } );
		expect( app.getProvenance().display.overlay ).toEqual( { width: 820, height: 1024 } );

	} );

	// A part of a split render: which samples it holds is what mergeRenders checks.
	it( 'says where the image\'s samples start, or null while the sequence runs free', () => {

		const app = new PathTracerApp( null );
		const stage = { width: 4, height: 2, frameCount: 32, isComplete: false, accumulationFirstSample: 64 };
		app.stages.pathTracer = stage;
		expect( app.getProvenance().render ).toMatchObject( { samples: 32, firstSample: 64 } );

		stage.accumulationFirstSample = null;
		expect( app.getProvenance().render.firstSample ).toBeNull();

	} );

	it( 'carries the camera the image was rendered from, as three.js keeps it', () => {

		const app = new PathTracerApp( null );
		expect( app.getProvenance().camera ).toBeNull();

		const camera = new PerspectiveCamera( 50, 2, 0.1, 100 );
		camera.position.set( 1, 2, 3 );
		camera.lookAt( 0, 0, 0 );
		camera.updateMatrixWorld();
		app.camera = camera;
		const seen = app.getProvenance().camera;

		expect( seen ).toMatchObject( { position: [ 1, 2, 3 ], fov: 50, aspect: 2, near: 0.1, far: 100, orthographic: false } );
		expect( seen.projection ).toEqual( camera.projectionMatrix.toArray() );
		// A world point in front of the camera lands on its −z axis.
		const ahead = new Vector3( 0, 0, 0 ).applyMatrix4( new Matrix4().fromArray( seen.worldToCamera ) );
		expect( [ ahead.x, ahead.y, ahead.z + Math.sqrt( 14 ) ].map( ( v ) => Math.abs( v ) < 1e-9 ) ).toEqual( [ true, true, true ] );

		// The pose rendered, not one set since without a render.
		camera.position.set( 9, 9, 9 );
		expect( app.getProvenance().camera.position ).toEqual( [ 1, 2, 3 ] );

	} );

	it( 'keeps a mirrored camera\'s mirror, as the path tracer traces it', () => {

		const app = new PathTracerApp( null );
		const camera = new PerspectiveCamera();
		camera.scale.x = - 1;
		camera.position.set( 0, 1, 5 );
		camera.updateMatrixWorld();
		app.camera = camera;

		expect( app.getProvenance().camera.worldToCamera ).toEqual( viewMatrixOf( camera, new Matrix4() ).toArray() );

	} );

	it( 'carries the area-light scale with the other settings', () => {

		expect( new PathTracerApp( null ).getProvenance().settings.areaLightIntensityScale )
			.toMatchObject( { value: 0.1, source: 'default', routed: true } );

	} );

	it( 'refuses the removed profile option rather than ignoring it', () => {

		expect( () => new PathTracerApp( null, { profile: 'physical' } ) ).toThrow( /`profile` option was removed/ );

	} );

} );
