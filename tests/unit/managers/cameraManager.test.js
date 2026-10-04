import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock( 'three', () => {

	class EventDispatcher {

		constructor() {

			this._listeners = {};

		}
		addEventListener( t, l ) {

			( this._listeners[ t ] ||= [] ).push( l );

		}
		removeEventListener( t, l ) {

			if ( this._listeners[ t ] ) {

				const i = this._listeners[ t ].indexOf( l ); if ( i > - 1 ) this._listeners[ t ].splice( i, 1 );

			}

		}
		dispatchEvent( e ) {

			( this._listeners[ e.type ] || [] ).forEach( l => l( e ) );

		}

	}

	class PerspectiveCamera {

		constructor( fov = 50, aspect = 1, near = 0.1, far = 1000 ) {

			this.fov = fov;
			this.aspect = aspect;
			this.near = near;
			this.far = far;
			this.position = { x: 0, y: 0, z: 0, set( x, y, z ) {

				this.x = x; this.y = y; this.z = z;

			}, copy: vi.fn(), clone: vi.fn( function () {

				return { ...this };

			} ) };
			this.quaternion = { copy: vi.fn(), clone: vi.fn( function () {

				return { ...this };

			} ) };
			this.name = '';
			this.updateProjectionMatrix = vi.fn();
			this.updateMatrixWorld = vi.fn();

		}

	}

	return {
		EventDispatcher,
		PerspectiveCamera,
		Vector3: class {

			constructor( x = 0, y = 0, z = 0 ) {

				this.x = x; this.y = y; this.z = z;

			} copy( v ) {

				this.x = v.x; this.y = v.y; this.z = v.z; return this;

			} subVectors( a, b ) {

				this.x = a.x - b.x; this.y = a.y - b.y; this.z = a.z - b.z; return this;

			} normalize() {

				return this;

			} multiplyScalar() {

				return this;

			} add() {

				return this;

			} addScaledVector() {

				return this;

			} length() {

				return 1;

			} applyQuaternion() {

				return this;

			}

		},
	};

} );

vi.mock( 'three/addons/controls/OrbitControls.js', () => ( {
	OrbitControls: class {

		constructor() {

			this.target = { x: 0, y: 0, z: 0, copy: vi.fn(), clone: vi.fn( function () {

				return { ...this };

			} ) };
			this.enabled = true;
			this.screenSpacePanning = false;
			this.zoomToCursor = false;

		}

		update() {}
		saveState() {}
		dispose() {}
		addEventListener() {}
		removeEventListener() {}

	}
} ) );

vi.mock( '@/core/managers/WalkControls.js', () => ( {
	WalkControls: class {

		update() {}
		release() {}
		dispose() {}

	}
} ) );

vi.mock( '@/core/EngineEvents.js', () => ( {
	EngineEvents: { AUTO_FOCUS_UPDATED: 'AUTO_FOCUS_UPDATED' }
} ) );

const { CameraManager } = await import( '@/core/managers/CameraManager.js' );

function createMockCanvas() {

	return { clientWidth: 800, clientHeight: 600 };

}

describe( 'CameraManager', () => {

	let manager;

	beforeEach( () => {

		manager = new CameraManager( createMockCanvas() );

	} );

	// ── constructor ───────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'stores camera and controls', () => {

			expect( manager.camera ).toBeDefined();
			expect( manager.controls ).toBeDefined();

		} );

		it( 'initializes with default camera in cameras list', () => {

			expect( manager.cameras ).toHaveLength( 1 );
			expect( manager.cameras[ 0 ] ).toBe( manager.camera );

		} );

		it( 'starts at camera index 0', () => {

			expect( manager.currentCameraIndex ).toBe( 0 );

		} );

		it( 'initializes AF state', () => {

			expect( manager.afScreenPoint ).toEqual( { x: 0.5, y: 0.5 } );

		} );

	} );

	// ── setCameras ────────────────────────────────────────────

	describe( 'setCameras', () => {

		it( 'replaces camera list', () => {

			const cam2 = { name: 'ModelCam' };
			manager.setCameras( [ manager.camera, cam2 ] );
			expect( manager.cameras ).toHaveLength( 2 );

		} );

	} );

	// ── getCameraNames ────────────────────────────────────────

	describe( 'getCameraNames', () => {

		it( 'returns ["Default Camera"] for single camera', () => {

			expect( manager.getCameraNames() ).toEqual( [ 'Default Camera' ] );

		} );

		it( 'returns named cameras', () => {

			const cam2 = { name: 'Front' };
			manager.setCameras( [ manager.camera, cam2 ] );

			const names = manager.getCameraNames();
			expect( names[ 0 ] ).toBe( 'Default Camera' );
			expect( names[ 1 ] ).toBe( 'Front' );

		} );

		it( 'uses "Camera N" for unnamed cameras', () => {

			const cam2 = { name: '' };
			manager.setCameras( [ manager.camera, cam2 ] );

			const names = manager.getCameraNames();
			expect( names[ 1 ] ).toBe( 'Camera 1' );

		} );

		it( 'handles empty cameras list', () => {

			manager.cameras = [];
			expect( manager.getCameraNames() ).toEqual( [ 'Default Camera' ] );

		} );

		it( 'handles null cameras', () => {

			manager.cameras = null;
			expect( manager.getCameraNames() ).toEqual( [ 'Default Camera' ] );

		} );

	} );

	// ── switchCamera guard ────────────────────────────────────

	describe( 'switchCamera', () => {

		it( 'returns early for empty cameras', () => {

			manager.cameras = [];
			// Should not throw
			expect( () => manager.switchCamera( 0, 5, vi.fn(), vi.fn() ) ).not.toThrow();

		} );

		it( 'returns early for null cameras', () => {

			manager.cameras = null;
			expect( () => manager.switchCamera( 0, 5, vi.fn(), vi.fn() ) ).not.toThrow();

		} );

	} );

} );
