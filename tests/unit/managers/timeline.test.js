import { describe, it, expect, vi, afterEach } from 'vitest';
import { Vector3 } from 'three';
import { CameraTrack } from '@/core/managers/timeline/CameraTrack.js';
import { TimelineManager } from '@/core/managers/timeline/TimelineManager.js';
import { CameraManager } from '@/core/managers/CameraManager.js';
import { EngineEvents } from '@/core/EngineEvents.js';

const pose = ( x, z, { fov = 50, orthoHeight = 4 } = {} ) => ( {
	position: new Vector3( x, 1, z ),
	target: new Vector3(),
	fov,
	orthoHeight,
} );

// Three keys around the origin, unevenly spaced in time.
function track() {

	const t = new CameraTrack();
	t.add( pose( 5, 0, { fov: 40, orthoHeight: 2 } ), 0 );
	t.add( pose( 0, 5 ), 1 );
	t.add( pose( - 5, 0, { fov: 60, orthoHeight: 8 } ), 4 );
	return t;

}

describe( 'CameraTrack', () => {

	it( 'passes through each key at its own time', () => {

		const t = track();

		for ( const key of t.keys ) {

			const at = t.sample( key.time );
			expect( at.position.distanceTo( key.position ), `key at ${key.time}s` ).toBeLessThan( 1e-5 );
			expect( at.fov ).toBeCloseTo( key.fov, 4 );
			expect( at.orthoHeight ).toBeCloseTo( key.orthoHeight, 4 );

		}

	} );

	it( 'starts and ends at rest, glides through the keys between, and holds outside them', () => {

		const t = track();
		const speed = ( time, dt = 1e-3 ) => t.sample( time + dt ).position.distanceTo( t.sample( time ).position ) / dt;

		expect( speed( 0 ) ).toBeLessThan( 0.05 );
		expect( speed( 4 - 1e-3 ) ).toBeLessThan( 0.05 );
		expect( speed( 1 ) ).toBeGreaterThan( 1 );

		expect( t.sample( - 2 ).position.distanceTo( t.keys[ 0 ].position ) ).toBeLessThan( 1e-5 );
		expect( t.sample( 9 ).position.distanceTo( t.keys[ 2 ].position ) ).toBeLessThan( 1e-5 );

	} );

	it( 'keeps its keys in time order, and moves a key when its time changes', () => {

		const t = track();
		const [ first ] = t.keys;
		t.setTime( first.id, 6 );

		expect( t.keys.map( k => k.time ) ).toEqual( [ 1, 4, 6 ] );
		expect( t.duration ).toBe( 6 );
		expect( t.sample( 6 ).position.distanceTo( first.position ) ).toBeLessThan( 1e-5 );

	} );

	it( 'survives two keys at the same time', () => {

		const t = track();
		t.setTime( t.keys[ 1 ].id, 0 );

		const at = t.sample( 0.5 );
		expect( Number.isFinite( at.position.x + at.position.y + at.position.z ) ).toBe( true );

	} );

	it( 'holds a single key, and has nothing to say without one', () => {

		const t = new CameraTrack();
		expect( t.sample( 1 ) ).toBeNull();

		t.add( pose( 2, 3 ), 1 );
		expect( t.sample( 0 ).position.distanceTo( new Vector3( 2, 1, 3 ) ) ).toBeLessThan( 1e-5 );

	} );

	it( 'keeps its own copy of a pose', () => {

		const t = new CameraTrack();
		const p = pose( 1, 1 );
		t.add( p, 0 );
		p.position.set( 9, 9, 9 );

		expect( t.keys[ 0 ].position.x ).toBe( 1 );

	} );

} );

describe( 'TimelineManager', () => {

	afterEach( () => vi.restoreAllMocks() );

	function timeline() {

		const doc = new EventTarget();
		doc.defaultView = new EventTarget();
		const canvas = new EventTarget();
		Object.assign( canvas, { ownerDocument: doc, clientWidth: 800, clientHeight: 400, style: {}, getRootNode: () => doc } );

		const cm = new CameraManager( canvas );
		cm.camera.position.set( 0, 3, 8 );
		cm.controls.update();
		const onReset = vi.fn();
		return { cm, onReset, tl: new TimelineManager( { cameraManager: cm, onReset } ) };

	}

	const frame = ( cm, x, z ) => {

		cm.camera.position.set( x, 2, z );
		cm.controls.target.set( 0, 0, 0 );
		cm.controls.update();

	};

	it( 'keys the current view, two seconds after the last key, without touching the camera list', () => {

		const { cm, tl } = timeline();
		const cameras = cm.cameras.length;

		frame( cm, 6, 0 );
		tl.camera.addKey();
		frame( cm, 0, 6 );
		tl.camera.addKey();

		expect( tl.camera.keys.map( k => k.time ) ).toEqual( [ 0, 2 ] );
		expect( tl.camera.keys[ 1 ].position.distanceTo( new Vector3( 0, 2, 6 ) ) ).toBeLessThan( 1e-9 );
		expect( tl.duration ).toBe( 2 );
		expect( tl.animates ).toBe( true );
		expect( cm.cameras.length ).toBe( cameras );

	} );

	it( 'tells the app when keys change and when playback starts and stops', () => {

		const { cm, tl } = timeline();
		const changes = vi.fn();
		tl.addEventListener( EngineEvents.TIMELINE_CHANGED, changes );

		const key = tl.camera.addKey();
		frame( cm, 1, 1 );
		tl.camera.updateKey( key.id );
		tl.camera.setTime( key.id, 3 );
		tl.camera.remove( key.id );
		expect( changes.mock.calls.map( ( [ e ] ) => e.track ) ).toEqual( [ 'camera', 'camera', 'camera', 'camera' ] );

		tl.play();
		tl.stop();
		expect( changes ).toHaveBeenCalledTimes( 6 );
		expect( changes.mock.calls[ 4 ][ 0 ].track ).toBeUndefined();

	} );

	it( 'puts the camera where the timeline has it, once there are keys', () => {

		const { cm, tl } = timeline();
		expect( tl.seek( 1 ) ).toBe( false );

		frame( cm, 6, 0 );
		tl.camera.addKey();
		frame( cm, 0, 6 );
		tl.camera.addKey();

		expect( tl.seek( 0 ) ).toBe( true );
		expect( cm.camera.position.distanceTo( new Vector3( 6, 2, 0 ) ) ).toBeLessThan( 1e-5 );
		expect( cm.controls.target.length() ).toBeLessThan( 1e-5 );

	} );

	it( 'plays in the viewport with the controls locked, ending at the last key', async () => {

		const { cm, tl, onReset } = timeline();
		frame( cm, 6, 0 );
		tl.camera.addKey();
		frame( cm, 0, 6 );
		tl.camera.addKey();

		let now = 1000;
		vi.spyOn( performance, 'now' ).mockImplementation( () => now );
		const done = tl.play();

		tl.update();
		expect( onReset ).toHaveBeenCalled();
		expect( cm.controls.enabled ).toBe( false );
		expect( tl.isPlaying ).toBe( true );

		now += 2500;
		tl.update();
		await done;

		expect( tl.isPlaying ).toBe( false );
		expect( cm.controls.enabled ).toBe( true );
		expect( cm.camera.position.distanceTo( new Vector3( 0, 2, 6 ) ) ).toBeLessThan( 1e-5 );

	} );

	it( 'stops early, and clears with a new scene', async () => {

		const { cm, tl } = timeline();
		tl.camera.addKey();
		tl.camera.addKey();

		const done = tl.play();
		tl.clear();
		await done;

		expect( tl.isPlaying ).toBe( false );
		expect( cm.controls.enabled ).toBe( true );
		expect( tl.camera.keys ).toEqual( [] );

	} );

} );
