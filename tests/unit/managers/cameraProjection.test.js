import { describe, it, expect, vi } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { CameraManager } from '@/core/managers/CameraManager.js';
import { EngineEvents } from '@/core/EngineEvents.js';

function canvas() {

	const doc = new EventTarget();
	doc.defaultView = new EventTarget();
	const element = new EventTarget();
	Object.assign( element, { ownerDocument: doc, clientWidth: 800, clientHeight: 400, style: {}, getRootNode: () => doc } );
	return element;

}

// The engine's side of the settings: the projection lives there, and its handler calls back.
function manager() {

	const cm = new CameraManager( canvas() );
	const settings = { cameraProjection: 'perspective', focusDistance: 5 };
	cm.initCallbacks( {
		onResize: vi.fn(),
		onReset: vi.fn(),
		getSettings: key => settings[ key ],
		applySettings: updates => {

			Object.assign( settings, updates );
			if ( updates.cameraProjection ) cm.applyProjection( updates.cameraProjection );

		},
	} );

	const setProjection = projection => cm._applySettings( { cameraProjection: projection } );

	cm.camera.position.set( 0, 3, 8 );
	cm.controls.target.set( 0, 0, 0 );
	cm.controls.update();
	return { cm, settings, setProjection };

}

// Half the height the view covers at the orbit target.
const halfHeightAtTarget = cm => cm.camera.isOrthographicCamera
	? cm.camera.orthoHalfHeight / cm.camera.zoom
	: cm.camera.position.distanceTo( cm.controls.target ) * Math.tan( cm.camera.fov * Math.PI / 360 ) / cm.camera.zoom;

describe( 'CameraManager projection', () => {

	it( 'turns orthographic showing what the perspective view showed at the orbit target', () => {

		const { cm, setProjection } = manager();
		const before = halfHeightAtTarget( cm );
		const position = cm.camera.position.clone();

		setProjection( 'orthographic' );

		expect( cm.camera.isOrthographicCamera ).toBe( true );
		expect( halfHeightAtTarget( cm ) ).toBeCloseTo( before, 6 );
		expect( cm.orthoHeight ).toBeCloseTo( 2 * before, 6 );
		expect( cm.camera.position.distanceTo( position ) ).toBeLessThan( 1e-9 );

	} );

	it( 'zooms an orthographic view by its size, and turns back into the perspective view of that size', () => {

		const { cm, setProjection } = manager();
		setProjection( 'orthographic' );

		cm.camera.zoom = 2;
		cm.camera.updateProjectionMatrix();
		const zoomed = halfHeightAtTarget( cm );
		const direction = cm.camera.getWorldDirection( new Vector3() );

		setProjection( 'perspective' );

		expect( cm.camera.isPerspectiveCamera ).toBe( true );
		expect( cm.camera.zoom ).toBe( 1 );
		expect( halfHeightAtTarget( cm ) ).toBeCloseTo( zoomed, 6 );
		expect( cm.camera.getWorldDirection( new Vector3() ).dot( direction ) ).toBeCloseTo( 1, 9 );

	} );

	it( 'reports the view height when the wheel zooms, and once per change', () => {

		const { cm, setProjection } = manager();
		const heights = [];
		cm.addEventListener( EngineEvents.ORTHO_HEIGHT_UPDATED, e => heights.push( e.height ) );

		setProjection( 'orthographic' );
		cm.camera.zoom = 4;
		cm.camera.updateProjectionMatrix();
		cm.controls.dispatchEvent( { type: 'change' } );
		cm.controls.dispatchEvent( { type: 'change' } );
		cm.setOrthoHeight( 3 );

		expect( heights.length ).toBe( 3 );
		expect( heights[ 1 ] ).toBeCloseTo( heights[ 0 ] / 4, 9 );
		expect( heights[ 2 ] ).toBe( 3 );
		expect( cm.camera.zoom ).toBe( 1 );

	} );

	it( 'switches to an imported orthographic camera at its own size, and back to perspective after', () => {

		const { cm, settings } = manager();
		const imported = new OrthographicCamera( - 4, 4, 2.5, - 2.5, 0.1, 100 );
		imported.zoom = 2;
		imported.position.set( 5, 0, 0 );
		imported.lookAt( 0, 0, 0 );
		const lens = new PerspectiveCamera( 40, 1, 0.1, 100 );
		lens.position.set( 0, 0, 9 );
		cm.setCameras( [ cm.camera, imported, lens ] );

		cm.switchCamera( 1 );
		expect( settings.cameraProjection ).toBe( 'orthographic' );
		expect( cm.orthoHeight ).toBeCloseTo( 2.5, 9 );
		expect( cm.camera.fov ).toBe( 60 );

		cm.switchCamera( 2 );
		expect( settings.cameraProjection ).toBe( 'perspective' );
		expect( cm.camera.isPerspectiveCamera ).toBe( true );
		expect( cm.camera.fov ).toBe( 40 );

	} );

	it( 'gives each camera back the projection it was left in', () => {

		const { cm, settings, setProjection } = manager();
		const lens = new PerspectiveCamera( 40, 1, 0.1, 100 );
		cm.setCameras( [ cm.camera, lens ] );

		setProjection( 'orthographic' );
		cm.setOrthoHeight( 7 );
		cm.switchCamera( 1 );
		expect( settings.cameraProjection ).toBe( 'perspective' );

		cm.switchCamera( 0 );
		expect( settings.cameraProjection ).toBe( 'orthographic' );
		expect( cm.orthoHeight ).toBeCloseTo( 7, 9 );

	} );

	it( 'keeps a 360° panorama across cameras that are not orthographic', () => {

		const { cm, settings, setProjection } = manager();
		cm.setCameras( [ cm.camera, new PerspectiveCamera( 40, 1, 0.1, 100 ) ] );

		setProjection( 'equirectangular' );
		cm.switchCamera( 1 );

		expect( settings.cameraProjection ).toBe( 'equirectangular' );
		expect( cm.camera.isPerspectiveCamera ).toBe( true );

	} );

	it( 'saves a view taken while orthographic as an orthographic camera of that size', () => {

		const { cm, settings, setProjection } = manager();
		setProjection( 'orthographic' );
		cm.setOrthoHeight( 6 );

		const index = cm.addCameraFromView();
		expect( cm.cameras[ index ] ).toBeInstanceOf( OrthographicCamera );

		setProjection( 'perspective' );
		cm.switchCamera( index );
		expect( settings.cameraProjection ).toBe( 'orthographic' );
		expect( cm.orthoHeight ).toBeCloseTo( 6, 9 );

	} );

	it( 'reframes an orthographic view on a new model like a perspective one', () => {

		const { cm, setProjection } = manager();
		setProjection( 'orthographic' );
		cm.setOrthoHeight( 0.01 );

		cm.fitOrthographic();

		expect( cm.orthoHeight ).toBeCloseTo( 2 * cm.camera.position.distanceTo( cm.controls.target ) * Math.tan( Math.PI / 6 ), 6 );

	} );

} );

describe( 'CameraManager poses', () => {

	it( 'captures the view: where it is, what it looks at, and what it shows there', () => {

		const { cm, setProjection } = manager();
		const pose = cm.captureView();

		expect( pose.position.equals( cm.camera.position ) ).toBe( true );
		expect( pose.target.equals( cm.controls.target ) ).toBe( true );
		expect( pose.fov ).toBe( cm.camera.fov );
		expect( pose.orthoHeight ).toBeCloseTo( 2 * cm.camera.position.length() * Math.tan( Math.PI / 6 ), 9 );

		setProjection( 'orthographic' );
		cm.setOrthoHeight( 3 );
		expect( cm.captureView().orthoHeight ).toBeCloseTo( 3, 9 );

	} );

	it( 'places the camera at a pose, looking at its target, sized for the projection in use', () => {

		const { cm, setProjection } = manager();
		const pose = { position: new Vector3( 4, 1, 4 ), target: new Vector3( 1, 0, 0 ), fov: 35, orthoHeight: 5 };

		cm.applyPose( pose );
		const toTarget = pose.target.clone().sub( pose.position ).normalize();
		expect( cm.camera.getWorldDirection( new Vector3() ).dot( toTarget ) ).toBeCloseTo( 1, 9 );
		expect( cm.camera.fov ).toBe( 35 );
		expect( cm.controls.target.equals( pose.target ) ).toBe( true );

		setProjection( 'orthographic' );
		cm.applyPose( pose );
		expect( cm.orthoHeight ).toBeCloseTo( 5, 9 );

	} );

} );

describe( 'CameraManager reset view', () => {

	it( 'puts the default camera back at the framing saved for it', () => {

		const { cm } = manager();
		cm.controls.saveState();
		const home = cm.camera.position.clone();

		cm.camera.position.set( 6, 1, - 2 );
		cm.controls.target.set( 1, 1, 1 );
		cm.controls.update();
		cm.resetView();

		expect( cm.camera.position.distanceTo( home ) ).toBeLessThan( 1e-9 );
		expect( cm.controls.target.length() ).toBeLessThan( 1e-9 );

	} );

	it( 'puts a model camera back at its own pose and field of view, not the default framing', () => {

		const { cm } = manager();
		cm.controls.saveState();
		const lens = new PerspectiveCamera( 40, 1, 0.1, 100 );
		lens.position.set( 0, 2, 9 );
		lens.lookAt( 0, 2, 0 );
		lens.updateMatrixWorld();
		cm.setCameras( [ cm.camera, lens ] );
		cm.switchCamera( 1 );

		cm.camera.position.set( 7, 0, 3 );
		cm.camera.fov = 70;
		cm.camera.updateProjectionMatrix();
		cm.controls.update();
		cm._onReset.mockClear();
		cm.resetView();

		expect( cm.camera.position.distanceTo( lens.position ) ).toBeLessThan( 1e-9 );
		expect( cm.camera.getWorldDirection( new Vector3() ).dot( lens.getWorldDirection( new Vector3() ) ) ).toBeCloseTo( 1, 9 );
		expect( cm.camera.fov ).toBe( 40 );
		expect( cm.controls.target.distanceTo( new Vector3( 0, 2, 4 ) ) ).toBeLessThan( 1e-9 );
		expect( cm._onReset ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'orbits a saved camera around the target it was saved with', () => {

		const { cm } = manager();
		cm.controls.target.set( 0, 1, 0 );
		cm.controls.update();
		const index = cm.addCameraFromView();
		cm.switchCamera( index );
		const saved = cm.camera.position.clone();

		cm.camera.position.set( - 5, 4, 1 );
		cm.controls.target.set( 2, 0, 0 );
		cm.controls.update();
		cm.resetView();

		expect( cm.currentCameraIndex ).toBe( index );
		expect( cm.camera.position.distanceTo( saved ) ).toBeLessThan( 1e-9 );
		expect( cm.controls.target.distanceTo( new Vector3( 0, 1, 0 ) ) ).toBeLessThan( 1e-9 );

	} );

	it( 'gives an imported orthographic camera back its own size', () => {

		const { cm } = manager();
		const imported = new OrthographicCamera( - 4, 4, 2.5, - 2.5, 0.1, 100 );
		imported.zoom = 2;
		imported.position.set( 5, 0, 0 );
		imported.lookAt( 0, 0, 0 );
		cm.setCameras( [ cm.camera, imported ] );
		cm.switchCamera( 1 );

		cm.camera.zoom = 3;
		cm.camera.updateProjectionMatrix();
		cm.resetView();

		expect( cm.camera.isOrthographicCamera ).toBe( true );
		expect( cm.orthoHeight ).toBeCloseTo( 2.5, 9 );

	} );

} );
