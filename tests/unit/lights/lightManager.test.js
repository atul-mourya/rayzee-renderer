import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DirectionalLight, Group, Object3D, PointLight, RectAreaLight, Scene, SpotLight } from 'three';
import { LightManager } from '@/core/lights/LightManager.js';

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

	describe( 'setIntensity', () => {

		it( 'edits the traced light, uploads it and restarts accumulation', () => {

			const onReset = vi.fn();
			manager = new LightManager( scene, sceneHelpers, pathTracer, { onReset } );
			const { uuid } = manager.addLight( 'PointLight' );
			pathTracer.updateLights.mockClear();
			onReset.mockClear();

			expect( manager.setIntensity( uuid, 42 ) ).toBe( true );
			expect( manager.getLight( uuid ).intensity ).toBe( 42 );
			expect( pathTracer.updateLights ).toHaveBeenCalledOnce();
			expect( onReset ).toHaveBeenCalledOnce();

		} );

		it( 'returns false for a UUID the tracer does not hold', () => {

			expect( manager.setIntensity( 'not-a-light', 1 ) ).toBe( false );
			expect( manager.getLight( 'not-a-light' ) ).toBeNull();

		} );

	} );

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

describe( 'LightManager in a three.js scene', () => {

	function setup( options ) {

		const scene = new Scene();
		const helpers = { visible: false, sync: vi.fn(), clear: vi.fn(), remove: vi.fn(), update: vi.fn() };
		const tracer = { updateLights: vi.fn() };
		return { scene, helpers, tracer, manager: new LightManager( scene, helpers, tracer, options ) };

	}

	const lightsOf = scene => scene.getObjectsByProperty( 'isLight', true );

	it( 'copies a model\'s lights in at their world placement, an area light\'s scale baked into its size', () => {

		const { scene, tracer, manager } = setup();
		const model = new Scene();
		const group = new Group();
		group.position.set( 10, 0, 0 );
		group.scale.setScalar( 2 );
		model.add( group );
		const panel = new RectAreaLight( 0xffffff, 5, 1, 3 );
		panel.position.set( 1, 0, 0 );
		const spot = new SpotLight();
		spot.position.set( 0, 2, 0 );
		const aim = new Object3D();
		aim.position.set( 0, - 1, 0 );
		spot.target = aim;
		group.add( panel, spot, aim );
		const sun = new DirectionalLight();
		sun.target.position.set( 0, 0, - 4 );
		model.add( sun );

		manager.transferSceneLights( model );

		const [ panelCopy, spotCopy, sunCopy ] = lightsOf( scene );
		expect( panelCopy ).not.toBe( panel );
		expect( panelCopy.position.toArray() ).toEqual( [ 12, 0, 0 ] );
		expect( [ panelCopy.width, panelCopy.height ] ).toEqual( [ 2, 6 ] );
		expect( panelCopy.scale.toArray() ).toEqual( [ 1, 1, 1 ] );
		expect( spotCopy.position.toArray() ).toEqual( [ 10, 4, 0 ] );
		expect( spotCopy.target ).not.toBe( aim );
		expect( spotCopy.target.parent ).toBe( scene );
		expect( spotCopy.target.position.toArray() ).toEqual( [ 10, - 2, 0 ] );
		expect( sunCopy.target.position.toArray() ).toEqual( [ 0, 0, - 4 ] );
		expect( panel.parent ).toBe( group );
		expect( tracer.updateLights ).toHaveBeenCalledOnce();

	} );

	it( 'empties the light scene for a model without lights and still uploads', () => {

		const { scene, helpers, tracer, manager } = setup();
		const model = new Scene();
		model.add( new PointLight() );
		manager.transferSceneLights( model );
		tracer.updateLights.mockClear();

		manager.transferSceneLights( new Scene() );

		expect( lightsOf( scene ) ).toEqual( [] );
		expect( tracer.updateLights ).toHaveBeenCalledOnce();
		expect( helpers.sync ).not.toHaveBeenCalled();

	} );

	it( 'removes a light together with its target, and refuses anything that is not a light', () => {

		const onReset = vi.fn();
		const { scene, helpers, manager } = setup( { onReset } );
		const { uuid } = manager.addLight( 'SpotLight' );
		const light = manager.getLight( uuid );
		const target = light.target;
		onReset.mockClear();

		expect( manager.removeLight( target.uuid ) ).toBe( false );
		expect( manager.removeLight( 'nobody' ) ).toBe( false );
		expect( onReset ).not.toHaveBeenCalled();

		expect( manager.removeLight( uuid ) ).toBe( true );
		expect( scene.children ).toEqual( [] );
		expect( helpers.remove ).toHaveBeenCalledWith( light );
		expect( onReset ).toHaveBeenCalledOnce();

	} );

	it( 'keeps the helpers in step with the lights while they are shown, and clears them when hidden', () => {

		const { scene, helpers, manager } = setup();
		manager.addLight( 'PointLight' );
		manager.updateLights();
		expect( helpers.sync ).not.toHaveBeenCalled();
		expect( helpers.update ).not.toHaveBeenCalled();

		manager.showHelpers( true );
		expect( helpers.visible ).toBe( true );
		expect( helpers.sync ).toHaveBeenLastCalledWith( lightsOf( scene ) );

		manager.addLight( 'SpotLight' );
		expect( helpers.sync ).toHaveBeenCalledTimes( 2 );
		expect( helpers.sync.mock.lastCall[ 0 ] ).toHaveLength( 2 );
		expect( helpers.update ).toHaveBeenCalled();

		manager.setShowLightHelper( false );
		expect( helpers.visible ).toBe( false );
		expect( helpers.clear ).toHaveBeenCalledOnce();

	} );

	it( 'answers to the short names too', () => {

		const { scene, tracer, manager } = setup();
		const { uuid } = manager.add( 'PointLight' );
		manager.add( 'DirectionalLight' );
		expect( manager.getAll().map( l => l.type ) ).toEqual( [ 'PointLight', 'DirectionalLight' ] );

		tracer.updateLights.mockClear();
		manager.sync();
		expect( tracer.updateLights ).toHaveBeenCalledOnce();

		expect( manager.remove( uuid ) ).toBe( true );
		manager.clear();
		expect( lightsOf( scene ) ).toEqual( [] );

	} );

	it( 'describes a sun\'s size in degrees and its gobo with a scale', () => {

		const { scene, manager } = setup();
		const sun = new DirectionalLight();
		sun.userData = { angle: Math.PI / 180, gobo: { name: 'bars', intensity: 0.5 } };
		scene.add( sun );

		const [ described ] = manager.getLights();

		expect( described.angle ).toBeCloseTo( 1, 9 );
		expect( described ).toMatchObject( { gobo: 'bars', goboIntensity: 0.5, goboInverted: false, goboScale: 5 } );

	} );

	it( 'describes a spot light\'s gobo without a scale, and its IES profile', () => {

		const { scene, manager } = setup();
		const spot = new SpotLight();
		spot.userData = { gobo: { name: 'leaves', intensity: 1, inverted: true, scale: 9 }, ies: { name: 'beam' } };
		scene.add( spot );

		const [ described ] = manager.getLights();

		expect( described ).toMatchObject( { gobo: 'leaves', goboInverted: true, ies: 'beam', iesIntensity: 1, fixtureLumens: null } );
		expect( described ).not.toHaveProperty( 'goboScale' );

	} );

	it( 'names an area light\'s shape and emission', () => {

		const { scene, manager } = setup();
		const shapes = [ 'square', 'disk', 'ellipse', 1, 0, 'rect', undefined ];
		for ( const shape of shapes ) {

			const panel = new RectAreaLight( 0xffffff, 1, 2, 2 );
			panel.position.set( 0, 3, 0 );
			panel.lookAt( 0, 0, 0 );
			panel.userData = { shape, normalize: false, spread: Math.PI / 2 };
			scene.add( panel );

		}

		const described = manager.getLights();

		expect( described.map( d => d.shape ) ).toEqual( [ 'square', 'disk', 'ellipse', 'ellipse', 'rectangle', 'rectangle', 'rectangle' ] );
		expect( described[ 0 ] ).toMatchObject( { normalize: false, spread: 90, width: 2, height: 2 } );

	} );

	it( 'puts an area light\'s target in front of it, so aiming at that target leaves it as it was', () => {

		const { scene, manager } = setup();
		const panel = new RectAreaLight( 0xffffff, 1, 2, 2 );
		panel.position.set( 0, 3, 4 );
		panel.lookAt( 0, 0, 0 );
		scene.add( panel );
		const facing = panel.quaternion.clone();

		const [ described ] = manager.getLights();
		[ 0, 2.4, 3.2 ].forEach( ( v, i ) => expect( described.target[ i ] ).toBeCloseTo( v, 6 ) );

		panel.lookAt( ...described.target );
		expect( panel.quaternion.angleTo( facing ) ).toBeLessThan( 1e-6 );

	} );

	it( 'saves a point light\'s range and falloff, and skips a kind of light it cannot make', () => {

		const { scene, manager } = setup();
		const bulb = new PointLight( 0xffffff, 3, 5, 1 );
		scene.add( bulb );
		const records = manager.serialize();
		expect( records[ 0 ] ).toMatchObject( { type: 'PointLight', distance: 5, decay: 1 } );

		const restored = manager.restore( [ { ...records[ 0 ], type: 'AmbientLight' }, records[ 0 ] ] );

		expect( restored ).toHaveLength( 1 );
		expect( restored[ 0 ] ).toMatchObject( { isPointLight: true, distance: 5, decay: 1, intensity: 3 } );
		expect( lightsOf( scene ) ).toEqual( restored );

	} );

} );
