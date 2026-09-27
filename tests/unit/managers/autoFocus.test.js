/**
 * Auto-focus with nothing under its point: focus where the camera orbits, never a distance
 * remembered from another model; and a pause, not a switch to manual, in a panorama.
 * Called off the prototype, with a real camera and raycaster.
 */
import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Scene, Vector3 } from 'three';
import { CameraManager } from '@/core/managers/CameraManager.js';
import { InteractionManager } from '@/core/managers/InteractionManager.js';

function manager( { target = new Vector3() } = {} ) {

	const camera = new PerspectiveCamera( 50, 1, 0.01, 1000 );
	camera.position.set( 0, 0, 6 );
	camera.lookAt( 0, 0, 0 );
	camera.updateMatrixWorld();

	const cm = Object.create( CameraManager.prototype );
	Object.assign( cm, {
		camera, controls: { target }, autoFocusMode: 'auto', afScreenPoint: { x: 0.5, y: 0.5 }, afSmoothingFactor: 0.15,
		interactionManager: Object.assign( Object.create( InteractionManager.prototype ), { raycaster: new Raycaster(), camera } ), _lastValidFocusDistance: null, _smoothedFocusDistance: null,
		_afPointDirty: false, _afSuspended: false, _listeners: {},
	} );
	cm.dispatchEvent = vi.fn();
	return cm;

}

const frame = ( cm, meshScene, focus = 0, projection = 0 ) => {

	const setFocusDistance = vi.fn();
	cm.interactionManager.scene = meshScene;
	cm.updateAutoFocus( {
		assetLoader: { getSceneScale: () => 2 }, currentFocusDistance: focus,
		pathTracer: { enableDOF: { value: 1 }, cameraProjection: { value: projection } }, setFocusDistance, softReset: vi.fn(), hardReset: vi.fn(),
	} );
	return setFocusDistance.mock.calls.at( - 1 )?.[ 0 ];

};

function sceneWithBoxAt( z ) {

	const scene = new Scene();
	const box = new Mesh( new BoxGeometry( 1, 1, 1 ), new MeshBasicMaterial() );
	box.position.z = z;
	scene.add( box );
	scene.updateMatrixWorld( true );
	return scene;

}

describe( 'auto-focus', () => {

	it( 'focuses on the orbit target, not ten model sizes away', () => {

		expect( frame( manager(), new Scene() ) ).toBeCloseTo( 6, 6 );

	} );

	it( 'forgets the last model once the camera list is replaced', () => {

		const cm = manager();
		expect( frame( cm, sceneWithBoxAt( 3 ) ) ).toBeCloseTo( 2.5, 6 );

		cm.setCameras( [ cm.camera ] );
		expect( frame( cm, new Scene(), 2.5 ) ).toBeCloseTo( 6, 6 );

	} );

	it( 'pauses in a panorama, keeping its mode, and measures again once back', () => {

		const cm = manager();
		expect( frame( cm, sceneWithBoxAt( 3 ), 0, 1 ) ).toBeUndefined();
		expect( cm.autoFocusMode ).toBe( 'auto' );
		expect( frame( cm, sceneWithBoxAt( 3 ) ) ).toBeCloseTo( 2.5, 6 );

	} );

	it( 'reports the distance in scene units as well as divided by the model size', () => {

		const cm = manager();
		frame( cm, sceneWithBoxAt( 3 ) );

		expect( cm.dispatchEvent ).toHaveBeenCalledWith( expect.objectContaining( { worldDistance: 2.5, distance: 1.25 } ) );

	} );

} );
