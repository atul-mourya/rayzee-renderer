import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Three.js dependencies before importing LightManager
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

	class Light {

		constructor( c, i ) {

			this.color = { r: 1, g: 1, b: 1, set() {

				return this;

			}, getHexString() {

				return 'ffffff';

			} };
			this.intensity = i || 1;
			this.position = {
				fromArray( a ) {

					this.x = a[ 0 ]; this.y = a[ 1 ]; this.z = a[ 2 ]; return this;

				},
				clone() {

					return { x: this.x, y: this.y, z: this.z };

				},
				x: 0, y: 0, z: 0
			};
			this.uuid = Math.random().toString( 36 );
			this.name = '';
			this.type = this.constructor.name;
			this.isLight = true;
			this.userData = {};

		}

		lookAt() {}

		getWorldDirection() {

			return { x: 0, y: 0, z: - 1 };

		}

	}

	return {
		EventDispatcher,
		DirectionalLight: class DirectionalLight extends Light {

			constructor( c, i ) {

				super( c, i ); this.isDirectionalLight = true; this.type = 'DirectionalLight';

			}

		},
		PointLight: class PointLight extends Light {

			constructor( c, i ) {

				super( c, i ); this.isPointLight = true; this.type = 'PointLight';

			}

		},
		SpotLight: class SpotLight extends Light {

			constructor( c, i ) {

				super( c, i );
				this.isSpotLight = true;
				this.type = 'SpotLight';
				this.angle = Math.PI / 4;
				this.target = { position: { set() {}, x: 0, y: 0, z: 0 } };

			}

		},
		RectAreaLight: class RectAreaLight extends Light {

			constructor( c, i, w, h ) {

				super( c, i );
				this.isRectAreaLight = true;
				this.type = 'RectAreaLight';
				this.width = w || 1;
				this.height = h || 1;

			}

		},
		Object3D: class {

			constructor() {

				this.position = { set() {}, x: 0, y: 0, z: 0 };

			}

		},
		MathUtils: {
			degToRad: d => d * Math.PI / 180,
			radToDeg: r => r * 180 / Math.PI,
		},
	};

} );

import { LightManager } from '@/core/managers/LightManager.js';

// ── Helpers ──────────────────────────────────────────────────

function createMockScene() {

	const children = [];

	return {
		add( obj ) {

			children.push( obj );

		},
		remove( obj ) {

			const i = children.indexOf( obj ); if ( i > - 1 ) children.splice( i, 1 );

		},
		getObjectsByProperty( prop, value ) {

			return children.filter( c => c[ prop ] === value );

		},
		getObjectByProperty( prop, value ) {

			return children.find( c => c[ prop ] === value );

		},
		_children: children,
	};

}

function createMockSceneHelpers() {

	return {
		visible: false,
		sync: vi.fn(),
		clear: vi.fn(),
		remove: vi.fn(),
	};

}

function createMockPathTracer() {

	return {
		updateLights: vi.fn(),
	};

}

// ── Tests ────────────────────────────────────────────────────

describe( 'LightManager', () => {

	let scene, sceneHelpers, pathTracer, manager;

	beforeEach( () => {

		scene = createMockScene();
		sceneHelpers = createMockSceneHelpers();
		pathTracer = createMockPathTracer();
		manager = new LightManager( scene, sceneHelpers, pathTracer );

	} );

	// ── addLight ─────────────────────────────────────────────

	describe( 'addLight', () => {

		it( 'should return a descriptor for DirectionalLight', () => {

			const result = manager.addLight( 'DirectionalLight' );

			expect( result ).not.toBeNull();
			expect( result ).toHaveProperty( 'uuid' );
			expect( result ).toHaveProperty( 'type', 'DirectionalLight' );
			expect( result ).toHaveProperty( 'intensity', 1.0 );

		} );

		it( 'should return a descriptor for PointLight', () => {

			const result = manager.addLight( 'PointLight' );

			expect( result ).not.toBeNull();
			expect( result ).toHaveProperty( 'uuid' );
			expect( result ).toHaveProperty( 'type', 'PointLight' );
			expect( result ).toHaveProperty( 'intensity', 1000 ); // Power in Watts (Blender-style)

		} );

		it( 'should return a descriptor for SpotLight', () => {

			const result = manager.addLight( 'SpotLight' );

			expect( result ).not.toBeNull();
			expect( result ).toHaveProperty( 'uuid' );
			expect( result ).toHaveProperty( 'type', 'SpotLight' );
			expect( result ).toHaveProperty( 'intensity', 1000 ); // Power in Watts (Blender-style)

		} );

		it( 'should return a descriptor for RectAreaLight', () => {

			const result = manager.addLight( 'RectAreaLight' );

			expect( result ).not.toBeNull();
			expect( result ).toHaveProperty( 'uuid' );
			expect( result ).toHaveProperty( 'type', 'RectAreaLight' );
			expect( result ).toHaveProperty( 'intensity', 100 ); // Watts (Blender-style)
			expect( result ).toHaveProperty( 'normalize', true );
			expect( result ).toHaveProperty( 'shape', 'rectangle' );

		} );

		it( 'should return null for an invalid light type', () => {

			const result = manager.addLight( 'InvalidType' );

			expect( result ).toBeNull();

		} );

		it( 'should add the created light to the scene', () => {

			manager.addLight( 'DirectionalLight' );

			const lights = scene.getObjectsByProperty( 'isLight', true );
			expect( lights.length ).toBe( 1 );
			expect( lights[ 0 ].isDirectionalLight ).toBe( true );

		} );

		it( 'should call pathTracer.updateLights after adding a light', () => {

			manager.addLight( 'PointLight' );

			expect( pathTracer.updateLights ).toHaveBeenCalled();

		} );

	} );

	// ── removing lights ──────────────────────────────────────

	describe( 'onLightRemoved', () => {

		let onLightRemoved;

		beforeEach( () => {

			onLightRemoved = vi.fn();
			manager = new LightManager( scene, sceneHelpers, pathTracer, { onLightRemoved } );

		} );

		it( 'reports a light while it is still in the scene', () => {

			const { uuid } = manager.addLight( 'PointLight' );
			const light = scene.getObjectByProperty( 'uuid', uuid );
			light.removeFromParent = () => scene.remove( light );
			let inSceneWhenReported = false;
			onLightRemoved.mockImplementation( l => {

				inSceneWhenReported = scene._children.includes( l );

			} );

			manager.removeLight( uuid );

			// A selected light must be let go of before it leaves; the gizmo warned every frame.
			expect( onLightRemoved ).toHaveBeenCalledWith( light );
			expect( inSceneWhenReported ).toBe( true );

		} );

		it( 'reports every light that clearLights removes', () => {

			manager.addLight( 'PointLight' );
			manager.addLight( 'DirectionalLight' );
			const lights = scene.getObjectsByProperty( 'isLight', true );

			manager.clearLights();

			expect( onLightRemoved ).toHaveBeenCalledTimes( 2 );
			expect( onLightRemoved.mock.calls.map( c => c[ 0 ] ) ).toEqual( lights );

		} );

		it( 'is dropped on dispose', () => {

			manager.addLight( 'PointLight' );

			manager.dispose();

			expect( onLightRemoved ).not.toHaveBeenCalled();
			expect( manager._onLightRemoved ).toBeNull();

		} );

	} );

	// ── dispose ──────────────────────────────────────────────

	describe( 'dispose', () => {

		it( 'should clear sceneHelpers before nulling the ref', () => {

			manager.addLight( 'DirectionalLight' );
			const helpersRef = sceneHelpers;

			manager.dispose();

			expect( helpersRef.clear ).toHaveBeenCalled();

		} );

		it( 'should remove all lights from the scene', () => {

			manager.addLight( 'DirectionalLight' );
			manager.addLight( 'PointLight' );
			manager.addLight( 'SpotLight' );

			// Pre-check: three lights present (SpotLight adds a target → 4 children, but only 3 with isLight=true)
			expect( scene.getObjectsByProperty( 'isLight', true ).length ).toBe( 3 );

			manager.dispose();

			expect( scene.getObjectsByProperty( 'isLight', true ).length ).toBe( 0 );

		} );

		it( 'should null external refs so the manager releases scene/pathTracer', () => {

			manager.dispose();

			expect( manager.scene ).toBeNull();
			expect( manager.pathTracer ).toBeNull();
			expect( manager.sceneHelpers ).toBeNull();
			expect( manager._onReset ).toBeNull();

		} );

		it( 'should be idempotent — calling dispose twice does not throw', () => {

			manager.addLight( 'PointLight' );

			expect( () => {

				manager.dispose();
				manager.dispose();

			} ).not.toThrow();

		} );

		it( 'should not call sceneHelpers.clear on the second dispose call', () => {

			manager.dispose();
			sceneHelpers.clear.mockClear();

			manager.dispose();

			expect( sceneHelpers.clear ).not.toHaveBeenCalled();

		} );

		it( 'should work even when no lights were added', () => {

			expect( () => manager.dispose() ).not.toThrow();
			expect( manager.scene ).toBeNull();

		} );

	} );

} );
