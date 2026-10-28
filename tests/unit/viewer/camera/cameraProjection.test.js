import { describe, it, expect, vi } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { CameraManager } from '@/core/viewer/camera/CameraManager.js';
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

describe( 'CameraManager clip start', () => {

	// A camera whose file gave it a near clipping plane (USD clippingRange, glTF znear).
	const imported = clipStart => {

		const camera = new PerspectiveCamera( 40, 2, clipStart, 100 );
		camera.position.set( 1, 2, 3 );
		camera.userData.clipStart = clipStart;
		return camera;

	};

	it( 'takes an imported camera\'s clip start, and none back on the default camera', () => {

		const { cm } = manager();
		cm.setCameras( [ cm.camera, imported( 1.1 ) ] );
		cm.switchCamera( 1 );
		expect( cm.camera.userData.clipStart ).toBe( 1.1 );

		cm.switchCamera( 0 );
		expect( cm.camera.userData.clipStart ).toBe( 0 );

	} );

	it( 'keeps it in a view saved from that camera, and in a saved session', () => {

		const { cm } = manager();
		cm.setCameras( [ cm.camera, imported( 1.1 ) ] );
		cm.switchCamera( 1 );
		const saved = cm.addCameraFromView();
		expect( cm.cameras[ saved ].userData.clipStart ).toBe( 1.1 );

		const state = cm.serialize();
		cm.camera.userData.clipStart = 0;
		cm.restore( state );
		expect( cm.camera.userData.clipStart ).toBe( 1.1 );
		expect( cm.cameras.find( camera => camera.userData.__rayzeeUserCamera ).userData.clipStart ).toBe( 1.1 );

	} );

	it( 'opens a new model on the default camera without one', () => {

		const { cm } = manager();
		cm.setCameras( [ cm.camera, imported( 1.1 ) ] );
		cm.switchCamera( 1 );
		cm.setCameras( [ cm.camera ] );
		expect( cm.camera.userData.clipStart ).toBe( 0 );

	} );

} );

describe( 'CameraManager cameras', () => {

	function withViews() {

		const made = manager();
		const { cm } = made;
		const model = new PerspectiveCamera( 40, 2, 0.1, 100 );
		model.position.set( 0, 0, 9 );
		cm.setCameras( [ cm.camera, model ] );
		cm.camera.position.set( 5, 1, 0 );
		cm.controls.update();
		cm.addCameraFromView();
		cm.camera.position.set( - 5, 1, 0 );
		cm.controls.update();
		cm.addCameraFromView( 'Overview' );
		cm.camera.position.set( 1, 2, 3 );
		cm.controls.update();
		return made;

	}

	it( 'names the cameras it holds, a user view by its count', () => {

		const { cm } = withViews();
		expect( cm.getNames() ).toEqual( [ 'Default Camera', 'Camera 1', 'View Camera 1', 'Overview' ] );
		expect( cm.active ).toBe( cm.camera );

	} );

	it( 'removes only the views a user added', () => {

		const { cm } = withViews();
		for ( const index of [ 0, 1, 4, - 1, 1.5, '2' ] ) expect( cm.removeCamera( index ) ).toBe( false );
		expect( cm.cameras ).toHaveLength( 4 );

	} );

	it( 'keeps the active camera when a view before it goes, and goes home when the active one does', () => {

		const { cm } = withViews();
		const switched = vi.fn();
		cm.addEventListener( EngineEvents.CAMERA_SWITCHED, switched );
		cm.switchCamera( 3 );
		expect( cm.camera.position.distanceTo( new Vector3( - 5, 1, 0 ) ) ).toBeLessThan( 1e-9 );

		expect( cm.removeCamera( 2 ) ).toBe( true );
		expect( cm.currentCameraIndex ).toBe( 2 );
		expect( cm.cameras[ 2 ].name ).toBe( 'Overview' );

		expect( cm.removeCamera( 2 ) ).toBe( true );
		expect( cm.currentCameraIndex ).toBe( 0 );
		expect( cm.cameras ).toHaveLength( 2 );
		expect( cm.camera.position.distanceTo( new Vector3( 1, 2, 3 ) ) ).toBeLessThan( 1e-9 );
		expect( switched.mock.lastCall[ 0 ].cameraIndex ).toBe( 0 );

	} );

	it( 'leaves the view that slides into a removed active view\'s place as it was', () => {

		const { cm, settings } = withViews();
		cm.switchCamera( 2 );
		settings.focusDistance = 42;
		const next = cm.cameras[ 3 ];
		const effects = { ...next.userData.__rayzeeEffects };

		cm.removeCamera( 2 );

		expect( cm.currentCameraIndex ).toBe( 0 );
		expect( next.userData.__rayzeeEffects ).toEqual( effects );
		expect( effects.focusDistance ).toBe( 5 );

	} );

	it( 'keeps the active index when a view after it goes', () => {

		const { cm } = withViews();
		cm.switchCamera( 2 );
		expect( cm.removeCamera( 3 ) ).toBe( true );
		expect( cm.currentCameraIndex ).toBe( 2 );

	} );

	it( 'falls back to the default camera for an index it does not hold', () => {

		const { cm } = withViews();
		cm.switchCamera( 1 );
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

		cm.switchCamera( 9 );

		expect( warn ).toHaveBeenCalledOnce();
		expect( cm.currentCameraIndex ).toBe( 0 );
		expect( cm.camera.position.distanceTo( new Vector3( 1, 2, 3 ) ) ).toBeLessThan( 1e-9 );
		warn.mockRestore();

	} );

	it( 'saves no effects for a view taken before the settings are wired', () => {

		const cm = new CameraManager( canvas() );
		const index = cm.addCameraFromView();
		expect( cm.cameras[ index ].userData.__rayzeeEffects ).toBeNull();

	} );

	it( 'takes a square view from a canvas with no size yet', () => {

		const element = canvas();
		element.clientWidth = 0;
		expect( new CameraManager( element ).camera.aspect ).toBe( 1 );

	} );

} );

describe( 'CameraManager navigation', () => {

	it( 'orbits around a point it is told to focus on', () => {

		const { cm } = manager();
		cm._onReset.mockClear();

		cm.focusOn( new Vector3( 1, 2, 3 ) );
		cm.focusOn( null );

		expect( cm.controls.target.toArray() ).toEqual( [ 1, 2, 3 ] );
		expect( cm._onReset ).toHaveBeenCalledOnce();

	} );

	it( 'ignores an orthographic size that is not a positive number', () => {

		const { cm, setProjection } = manager();
		setProjection( 'orthographic' );
		cm.setOrthoHeight( 4 );
		cm._onReset.mockClear();

		for ( const height of [ 0, - 2, NaN, undefined ] ) cm.setOrthoHeight( height );

		expect( cm.orthoHeight ).toBeCloseTo( 4, 9 );
		expect( cm._onReset ).not.toHaveBeenCalled();

	} );

	it( 'walks with the orbit gestures off, and orbits again round the surface ahead, if there is one', () => {

		const { cm } = manager();
		expect( cm.navigationMode ).toBe( 'orbit' );

		cm.setNavigationMode( 'walk' );
		expect( cm.navigationMode ).toBe( 'walk' );
		expect( [ cm.controls.enableRotate, cm.controls.enablePan, cm.controls.enableZoom ] ).toEqual( [ false, false, false ] );
		cm.setNavigationMode( 'walk' );
		expect( cm.navigationMode ).toBe( 'walk' );

		cm.setNavigationMode( 'orbit' );
		expect( cm.controls.enableRotate ).toBe( true );
		expect( cm.controls.target.length() ).toBeLessThan( 1e-9 );

		cm.setInteractionManager( { pickSurface: vi.fn( () => ( { distance: 4 } ) ) } );
		cm.setNavigationMode( 'walk' );
		cm.setNavigationMode( 'orbit' );
		const ahead = cm.camera.position.clone().addScaledVector( cm.camera.getWorldDirection( new Vector3() ), 4 );
		expect( cm.controls.target.distanceTo( ahead ) ).toBeLessThan( 1e-9 );
		expect( cm.interactionManager.pickSurface ).toHaveBeenCalledWith( 0, 0 );

	} );

	it( 'moves the walk before the orbit each frame', () => {

		const { cm } = manager();
		const walk = vi.spyOn( cm.walkControls, 'update' );
		const orbit = vi.spyOn( cm.controls, 'update' );

		cm.updateControls();

		expect( walk ).toHaveBeenCalledOnce();
		expect( orbit ).toHaveBeenCalledOnce();
		expect( walk.mock.invocationCallOrder[ 0 ] ).toBeLessThan( orbit.mock.invocationCallOrder[ 0 ] );

	} );

	it( 'holds the orbit still while the AF point is being placed', () => {

		const { cm } = manager();
		cm.enterAFPointPlacementMode();
		expect( cm.controls.enabled ).toBe( true );

		const interaction = { enterAFPointPlacementMode: vi.fn(), exitAFPointPlacementMode: vi.fn() };
		cm.setInteractionManager( interaction );
		cm.enterAFPointPlacementMode();
		expect( interaction.enterAFPointPlacementMode ).toHaveBeenCalledOnce();
		expect( cm.controls.enabled ).toBe( false );

		cm.exitAFPointPlacementMode();
		expect( interaction.exitAFPointPlacementMode ).toHaveBeenCalledOnce();
		expect( cm.controls.enabled ).toBe( true );

	} );

	it( 'lets go of the canvas on dispose', () => {

		const { cm, setProjection } = manager();
		setProjection( 'orthographic' );
		const heights = vi.fn();
		cm.addEventListener( EngineEvents.ORTHO_HEIGHT_UPDATED, heights );
		const walk = vi.spyOn( cm.walkControls, 'dispose' );
		const orbit = vi.spyOn( cm.controls, 'dispose' );

		cm.dispose();
		cm.camera.zoom = 2;
		cm.controls.dispatchEvent( { type: 'change' } );

		expect( walk ).toHaveBeenCalledOnce();
		expect( orbit ).toHaveBeenCalledOnce();
		expect( heights ).not.toHaveBeenCalled();

	} );

} );

describe( 'CameraManager auto-focus each frame', () => {

	// A surface straight ahead, `depth` along the view axis.
	function wired( { stage = {} } = {} ) {

		const { cm } = manager();
		const values = { focusDistance: 5 };
		const settings = { get: key => values[ key ], set: vi.fn( ( key, value ) => ( values[ key ] = value ) ) };
		const pathTracer = { enableDOF: { value: true }, cameraProjection: { value: 0 }, resetCount: 0, ...stage };
		let depth = 10;
		const point = () => cm.camera.position.clone().addScaledVector( cm.camera.getWorldDirection( new Vector3() ), depth );
		cm.setInteractionManager( { pickSurface: vi.fn( () => ( { point: point() } ) ) } );
		const softReset = vi.fn();
		const hardReset = vi.fn();
		cm.initAutoFocus( { assetLoader: { getSceneScale: () => 2 }, pathTracer, settings, softReset, hardReset } );
		const frame = d => {

			depth = d;
			pathTracer.resetCount ++;
			cm.updateAutoFocus();

		};

		return { cm, values, settings, softReset, hardReset, frame };

	}

	it( 'writes the focus silently into the settings, eases small changes and snaps large ones', () => {

		const { cm, values, settings, softReset, frame } = wired();
		const reported = vi.fn();
		cm.addEventListener( EngineEvents.AUTO_FOCUS_UPDATED, reported );

		frame( 10 );
		expect( settings.set ).toHaveBeenLastCalledWith( 'focusDistance', expect.closeTo( 10, 9 ), { silent: true } );
		expect( reported.mock.lastCall[ 0 ] ).toMatchObject( { distance: expect.closeTo( 5, 9 ), worldDistance: expect.closeTo( 10, 9 ) } );
		expect( softReset ).toHaveBeenCalledOnce();

		frame( 12 );
		expect( values.focusDistance ).toBeCloseTo( 10.3, 9 );
		expect( softReset ).toHaveBeenCalledOnce();

		frame( 30 );
		expect( values.focusDistance ).toBeCloseTo( 30, 9 );
		expect( softReset ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'starts over on a moved AF point, with a hard reset', () => {

		const { cm, values, hardReset, frame } = wired();
		frame( 10 );
		cm.setAFScreenPoint( 0.5, 0.5 );

		frame( 12 );

		expect( values.focusDistance ).toBeCloseTo( 12, 9 );
		expect( hardReset ).toHaveBeenCalledOnce();

	} );

	it( 'leaves the focus alone in manual mode, while a final render is being traced, or with nothing to pick with', () => {

		const manual = wired();
		manual.cm.setAutoFocusMode( 'manual' );
		manual.frame( 10 );
		expect( manual.settings.set ).not.toHaveBeenCalled();

		const tracing = wired( { stage: { isReady: true, renderMode: { value: 1 }, frameCount: 3, isComplete: false } } );
		tracing.frame( 10 );
		expect( tracing.settings.set ).not.toHaveBeenCalled();
		expect( tracing.cm.interactionManager.pickSurface ).not.toHaveBeenCalled();

		const done = wired( { stage: { isReady: true, renderMode: { value: 1 }, frameCount: 3, isComplete: true } } );
		done.frame( 10 );
		expect( done.settings.set ).toHaveBeenCalled();

		const blind = wired();
		blind.cm.setInteractionManager( null );
		blind.frame( 10 );
		expect( blind.settings.set ).not.toHaveBeenCalled();

		expect( () => new CameraManager( canvas() ).updateAutoFocus() ).not.toThrow();

	} );

	it( 'focuses ten scene sizes away when nothing is under the point and the orbit target is behind the camera', () => {

		const { cm, values, frame } = wired();
		cm.interactionManager.pickSurface = () => null;
		cm.controls.target.copy( cm.camera.position ).addScaledVector( cm.camera.getWorldDirection( new Vector3() ), - 3 );

		frame( 0 );

		expect( values.focusDistance ).toBe( 20 );

	} );

} );

describe( 'CameraManager sessions', () => {

	it( 'restores nothing from no state', () => {

		const { cm } = manager();
		expect( cm.restore( null ) ).toEqual( { mismatched: [] } );
		expect( cm.restore( undefined ) ).toEqual( { mismatched: [] } );

	} );

	it( 'brings back an orthographic view the user saved, at its size', () => {

		const { cm, setProjection } = manager();
		setProjection( 'orthographic' );
		cm.setOrthoHeight( 6 );
		cm.addCameraFromView( 'Plan' );
		const state = JSON.parse( JSON.stringify( cm.serialize() ) );
		expect( state.cameras[ 1 ] ).toMatchObject( { user: true, orthographic: true, fov: null, aspect: null } );
		expect( state.cameras[ 1 ].frustum ).toHaveLength( 4 );
		delete state.cameras[ 1 ].zoom;

		const other = manager().cm;
		other.restore( state );

		const plan = other.cameras[ 1 ];
		expect( plan ).toBeInstanceOf( OrthographicCamera );
		expect( plan.name ).toBe( 'Plan' );
		expect( plan.zoom ).toBe( 1 );
		expect( ( plan.top - plan.bottom ) / plan.zoom ).toBeCloseTo( 6, 9 );
		expect( plan.userData.__rayzeeOrbitTarget.toArray() ).toEqual( [ 0, 0, 0 ] );

	} );

	it( 'reports a model camera it cannot match, and opens on the default camera when that was the active one', () => {

		const { cm } = manager();
		const shot = new PerspectiveCamera( 35, 1.5, 0.1, 100 );
		shot.name = 'Shot A';
		cm.setCameras( [ cm.camera, shot ] );
		cm.switchCamera( 1 );
		cm.switchCamera( 0 );
		cm.switchCamera( 1 );
		const state = JSON.parse( JSON.stringify( cm.serialize() ) );
		expect( state.current ).toBe( 1 );
		expect( state.cameras[ 1 ].effects ).not.toBeNull();

		const other = manager().cm;
		const renamed = new PerspectiveCamera( 35, 1.5, 0.1, 100 );
		renamed.name = 'Shot B';
		other.setCameras( [ other.camera, renamed ] );

		expect( other.restore( state ) ).toEqual( { mismatched: [ 'Shot A' ] } );
		expect( other.currentCameraIndex ).toBe( 0 );
		expect( renamed.userData.__rayzeeEffects ).toBeUndefined();

	} );

} );
