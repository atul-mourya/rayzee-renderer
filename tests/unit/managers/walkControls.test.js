import { describe, it, expect, vi } from 'vitest';
import { BoxGeometry, MathUtils, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Scene, Vector3 } from 'three';
import { WalkControls } from '@/core/managers/WalkControls.js';
import { CameraManager } from '@/core/managers/CameraManager.js';
import { InteractionManager } from '@/core/managers/InteractionManager.js';

const withProps = ( event, props ) => {

	for ( const [ key, value ] of Object.entries( props ) ) Object.defineProperty( event, key, { value } );
	return event;

};

function rig( { lookAt = new Vector3( 0, 1.6, 0 ) } = {} ) {

	const doc = new EventTarget();
	doc.defaultView = new EventTarget();
	const element = new EventTarget();
	Object.assign( element, { ownerDocument: doc, clientHeight: 600 } );

	const camera = new PerspectiveCamera( 60, 1, 0.1, 100 );
	camera.position.set( 0, 1.6, 5 );
	camera.lookAt( lookAt );
	camera.updateMatrixWorld();

	const orbit = { enabled: true, target: lookAt.clone() };
	const controls = new WalkControls( camera, element, orbit );
	controls.enabled = true;
	controls.fitSpeed( 16 );

	const key = ( type, code, props = {} ) => doc.dispatchEvent( withProps( new Event( type, { cancelable: true } ), { code, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, ...props } ) );
	const pointer = ( type, x, y ) => element.dispatchEvent( withProps( new Event( type ), { button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: y } ) );
	const drag = ( dx, dy ) => {

		pointer( 'pointerdown', 100, 100 );
		pointer( 'pointermove', 100 + dx, 100 + dy );
		pointer( 'pointerup', 100 + dx, 100 + dy );

	};

	return { doc, camera, orbit, controls, key, drag };

}

const forward = camera => camera.getWorldDirection( new Vector3() );

describe( 'WalkControls', () => {

	it( 'walks level along the view, however far down it looks', () => {

		const { camera, orbit, controls, key } = rig( { lookAt: new Vector3( 0, - 1.3, 0 ) } );
		const distance = camera.position.distanceTo( orbit.target );

		key( 'keydown', 'KeyW' );
		controls.update( 1 );

		expect( camera.position.y ).toBeCloseTo( 1.6, 6 );
		expect( camera.position.z ).toBeCloseTo( 3, 6 );
		expect( camera.position.distanceTo( orbit.target ) ).toBeCloseTo( distance, 6 );
		expect( orbit.target.clone().sub( camera.position ).normalize().dot( forward( camera ) ) ).toBeCloseTo( 1, 6 );

	} );

	it( 'walks level looking straight down, towards the top of the picture', () => {

		const { camera, controls, key } = rig( { lookAt: new Vector3( 0, - 10, 5 ) } );
		camera.lookAt( 0, - 10, 5 - 1e-9 );
		const top = new Vector3( 0, 1, 0 ).applyQuaternion( camera.quaternion );

		key( 'keydown', 'KeyW' );
		controls.update( 1 );

		expect( camera.position.y ).toBeCloseTo( 1.6, 6 );
		expect( camera.position.clone().sub( new Vector3( 0, 1.6, 5 ) ).normalize().dot( top ) ).toBeCloseTo( 1, 6 );

	} );

	it( 'rises on E, runs with Shift and creeps with Alt', () => {

		const { camera, controls, key } = rig();

		key( 'keydown', 'KeyE' );
		controls.update( 1 );
		expect( camera.position.y ).toBeCloseTo( 3.6, 6 );
		key( 'keyup', 'KeyE' );

		key( 'keydown', 'KeyW', { shiftKey: true } );
		controls.update( 1 );
		expect( camera.position.z ).toBeCloseTo( - 3, 6 );
		key( 'keyup', 'KeyW' );

		key( 'keydown', 'KeyA', { altKey: true } );
		controls.update( 1 );
		expect( camera.position.x ).toBeCloseTo( - 0.5, 6 );

	} );

	it( 'turns so the scene follows a drag, and stops short of straight up', () => {

		const { camera, orbit, controls, drag } = rig();
		const distance = camera.position.distanceTo( orbit.target );

		drag( 100, 0 );
		expect( forward( camera ).x ).toBeLessThan( - 0.1 );
		expect( forward( camera ).y ).toBeCloseTo( 0, 6 );

		drag( 0, 10000 );
		expect( MathUtils.radToDeg( Math.asin( forward( camera ).y ) ) ).toBeCloseTo( 89, 4 );
		expect( camera.position.distanceTo( orbit.target ) ).toBeCloseTo( distance, 6 );
		expect( orbit.target.clone().sub( camera.position ).normalize().dot( forward( camera ) ) ).toBeCloseTo( 1, 6 );

		expect( controls.update( 1 ) ).toBe( false );

	} );

	it( 'keeps still while the orbit controls are off, in orbit mode, or when a key goes to a text field or a control used it', () => {

		const { camera, orbit, controls, key } = rig();
		const start = camera.position.clone();

		orbit.enabled = false;
		key( 'keydown', 'KeyW' );
		controls.update( 1 );
		orbit.enabled = true;

		controls.enabled = false;
		key( 'keydown', 'KeyW' );
		controls.update( 1 );
		controls.enabled = true;

		key( 'keydown', 'KeyW', { target: { closest: selector => selector.includes( 'input' ) ? {} : null } } );
		key( 'keydown', 'KeyS', { defaultPrevented: true } );
		key( 'keydown', 'KeyD', { metaKey: true } );
		controls.update( 1 );

		expect( camera.position.equals( start ) ).toBe( true );

	} );

	it( 'lets go of held keys when the window loses focus', () => {

		const { doc, camera, controls, key } = rig();

		key( 'keydown', 'KeyW' );
		doc.defaultView.dispatchEvent( new Event( 'blur' ) );

		expect( controls.update( 1 ) ).toBe( false );
		expect( camera.position.z ).toBe( 5 );

	} );

	it( 'wakes the render loop on the first held key only, with the key already held', () => {

		const { controls, key } = rig();
		// A woken loop runs its first frame inside the dispatch.
		const start = vi.fn( () => controls.update( 0.5 ) );
		controls.addEventListener( 'start', start );

		key( 'keydown', 'KeyW' );
		key( 'keydown', 'KeyW' );
		key( 'keydown', 'KeyA' );

		expect( start ).toHaveBeenCalledTimes( 1 );
		expect( start.mock.results[ 0 ].value ).toBe( true );

	} );

	it( 'fits the speed to cross the scene in about eight seconds', () => {

		const { controls } = rig();
		controls.speed = 5;
		controls.fitSpeed( 11.2 );

		expect( controls.speed ).toBeCloseTo( 1.4, 6 );

	} );

} );

describe( 'CameraManager navigation mode', () => {

	function manager() {

		const camera = new PerspectiveCamera( 50, 1, 0.01, 1000 );
		camera.position.set( 0, 0, 6 );
		camera.lookAt( 0, 0, 0 );
		camera.updateMatrixWorld();

		const scene = new Scene();
		const box = new Mesh( new BoxGeometry( 1, 1, 1 ), new MeshBasicMaterial() );
		box.position.z = 3;
		scene.add( box );
		scene.updateMatrixWorld( true );

		const interactionManager = Object.assign( Object.create( InteractionManager.prototype ), { raycaster: new Raycaster(), camera, scene } );
		const cm = Object.create( CameraManager.prototype );
		Object.assign( cm, {
			camera, interactionManager,
			controls: { target: new Vector3(), minDistance: 0, maxDistance: Infinity, enableRotate: true, enablePan: true, enableZoom: true, update: vi.fn() },
			walkControls: { enabled: false, release: vi.fn() },
		} );
		return cm;

	}

	it( 'hands the mouse to the walk controls', () => {

		const cm = manager();
		cm.setNavigationMode( 'walk' );

		expect( cm.walkControls.enabled ).toBe( true );
		expect( cm.navigationMode ).toBe( 'walk' );
		expect( [ cm.controls.enableRotate, cm.controls.enablePan, cm.controls.enableZoom ] ).toEqual( [ false, false, false ] );

	} );

	it( 'orbits around the surface in view once back', () => {

		const cm = manager();
		cm.setNavigationMode( 'walk' );
		cm.setNavigationMode( 'orbit' );

		expect( cm.controls.target.z ).toBeCloseTo( 3.5, 6 );
		expect( cm.controls.enableRotate ).toBe( true );
		expect( cm.walkControls.release ).toHaveBeenCalled();

	} );

} );
