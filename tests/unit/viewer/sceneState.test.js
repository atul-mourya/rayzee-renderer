import { describe, it, expect, vi } from 'vitest';
import { BufferGeometry, Color, Group, Mesh, MeshStandardMaterial, Object3D, PerspectiveCamera, PointLight, Scene, Vector2, Vector3 } from 'three';
import { toPortable, fromPortable } from '@/core/Portable.js';
import { captureSceneState, applySceneState, SCENE_STATE_VERSION } from '@/core/viewer/SceneState.js';
import { VERSION } from '@/core/Version.js';
import { LightManager } from '@/core/lights/LightManager.js';
import { CameraManager } from '@/core/viewer/camera/CameraManager.js';
import { CameraTrack } from '@/core/viewer/animation/CameraTrack.js';
import { RenderSettings, SETTING_SOURCE } from '@/core/RenderSettings.js';
import { MaterialDataManager } from '@/core/materials/MaterialDataManager.js';
import { MATERIAL_DATA_LAYOUT } from '@/core/scene/BufferLayout.js';

const json = value => JSON.parse( JSON.stringify( value ) );

function canvas() {

	const doc = new EventTarget();
	doc.defaultView = new EventTarget();
	const element = new EventTarget();
	Object.assign( element, { ownerDocument: doc, clientWidth: 800, clientHeight: 400, style: {}, getRootNode: () => doc } );
	return element;

}

function cameraManager( modelCameras = [] ) {

	const cm = new CameraManager( canvas() );
	const settings = { cameraProjection: 'perspective', focusDistance: 5, enableDOF: false, aperture: 16, dofBlur: 0 };
	cm.initCallbacks( {
		onResize: vi.fn(),
		onReset: vi.fn(),
		getSettings: key => settings[ key ],
		applySettings: updates => {

			Object.assign( settings, updates );
			if ( updates.cameraProjection ) cm.applyProjection( updates.cameraProjection );

		},
	} );
	cm.setCameras( [ cm.camera, ...modelCameras ] );
	return { cm, settings };

}

function lightManager() {

	const scene = new Scene();
	const helpers = { visible: false, clear: vi.fn(), remove: vi.fn(), sync: vi.fn(), update: vi.fn() };
	return new LightManager( scene, helpers, { updateLights: vi.fn() } );

}

describe( 'portable values', () => {

	it( 'keeps colours, vectors and infinities through JSON', () => {

		const value = { color: new Color( 0.1, 0.2, 0.3 ), scale: new Vector2( 1, - 1 ), far: Infinity, list: [ 1, new Vector3( 1, 2, 3 ) ], name: 'x' };
		const back = fromPortable( json( toPortable( value ) ) );

		expect( back.color.isColor ).toBe( true );
		expect( back.color.toArray() ).toEqual( value.color.toArray() );
		expect( back.scale.isVector2 ).toBe( true );
		expect( back.far ).toBe( Infinity );
		expect( back.list[ 1 ].toArray() ).toEqual( [ 1, 2, 3 ] );
		expect( back.name ).toBe( 'x' );

	} );

	it( 'leaves out what is not plain data', () => {

		expect( toPortable( { fn: () => 1, object: new Object3D(), ok: 1 } ) ).toEqual( { ok: 1 } );

	} );

} );

describe( 'LightManager sessions', () => {

	it( 'restores every light as it was, targets and masks included', () => {

		const a = lightManager();
		a.addLight( 'SpotLight' );
		a.addLight( 'RectAreaLight' );
		a.addLight( 'DirectionalLight' );
		const [ spot, rect, sun ] = a.scene.getObjectsByProperty( 'isLight', true );
		spot.color.setRGB( 0.25, 0.5, 0.75 );
		spot.angle = 0.3;
		spot.penumbra = 0.4;
		spot.target.position.set( 1, 0, - 2 );
		spot.userData.gobo = { name: 'bars', index: 3, intensity: 0.5, inverted: true, scale: 5 };
		rect.width = 3;
		rect.rotation.set( 0.2, 0.4, 0 );
		sun.userData.angle = 0.01;

		const records = json( a.serialize() );
		const b = lightManager();
		const restored = b.restore( records );

		expect( restored.map( l => l.type ) ).toEqual( [ 'SpotLight', 'RectAreaLight', 'DirectionalLight' ] );
		const withoutUuid = lights => lights.map( light => ( { ...light, uuid: undefined } ) );
		expect( withoutUuid( b.getLights() ) ).toEqual( withoutUuid( a.getLights() ) );
		expect( restored[ 0 ].color.toArray() ).toEqual( [ 0.25, 0.5, 0.75 ] );
		expect( restored[ 0 ].target.parent ).toBe( b.scene );
		expect( restored[ 1 ].quaternion.toArray() ).toEqual( rect.quaternion.toArray() );
		expect( restored[ 0 ].userData.gobo ).toEqual( spot.userData.gobo );

	} );

	it( 'keeps host lights through a rebuild that re-transfers the model lights', () => {

		const lights = lightManager();
		lights.addLight( 'PointLight' );

		const model = new Scene();
		const fromFile = new Object3D();
		model.add( fromFile );
		const light = new ( lights.scene.children[ 0 ].constructor )();
		light.name = 'from the file';
		fromFile.add( light );

		lights.transferSceneLights( model, { keepUserLights: true } );
		expect( lights.getLights().map( l => l.name ).sort() ).toEqual( [ 'Point 1', 'from the file' ] );

		lights.transferSceneLights( model, { keepUserLights: true } );
		expect( lights.getLights() ).toHaveLength( 2 );

		lights.transferSceneLights( model );
		expect( lights.getLights().map( l => l.name ) ).toEqual( [ 'from the file' ] );

	} );

} );

describe( 'CameraManager sessions', () => {

	it( 'restores the view, the cameras the user added and which one is active', () => {

		const model = new PerspectiveCamera( 35, 1.5, 0.1, 100 );
		model.name = 'Shot A';
		model.position.set( 3, 2, 1 );

		const { cm: a, settings } = cameraManager( [ model ] );
		a.camera.position.set( 0, 3, 8 );
		a.controls.target.set( 0, 1, 0 );
		a.controls.update();
		a.addCameraFromView( 'Mine' );
		a.switchCamera( 1 );
		Object.assign( settings, { enableDOF: true, aperture: 2.8 } );
		a.switchCamera( 2 );
		a.camera.position.set( - 4, 5, 6 );
		a.controls.target.set( 1, 1, 1 );
		a.controls.update();
		a.setAFScreenPoint( 0.2, 0.7 );

		const state = json( a.serialize() );

		const copy = model.clone();
		const { cm: b } = cameraManager( [ copy ] );
		const { mismatched } = b.restore( state );

		expect( mismatched ).toEqual( [] );
		expect( b.getCameraNames() ).toEqual( a.getCameraNames() );
		expect( b.currentCameraIndex ).toBe( 2 );
		expect( b.camera.position.toArray() ).toEqual( a.camera.position.toArray() );
		expect( b.camera.quaternion.toArray() ).toEqual( a.camera.quaternion.toArray() );
		expect( b.controls.target.toArray() ).toEqual( [ 1, 1, 1 ] );
		expect( b.cameras[ 1 ].userData.__rayzeeEffects ).toMatchObject( { enableDOF: true, aperture: 2.8 } );
		expect( b.cameras[ 2 ].userData.__rayzeeOrbitTarget.toArray() ).toEqual( [ 0, 1, 0 ] );
		expect( b.afScreenPoint ).toEqual( { x: 0.2, y: 0.7 } );

		b.switchCamera( 0 );
		a.switchCamera( 0 );
		expect( b.camera.position.toArray() ).toEqual( a.camera.position.toArray() );

	} );

	it( 'keeps a model camera that no longer matches as it loaded', () => {

		const model = new PerspectiveCamera();
		model.name = 'Old';
		const { cm: a } = cameraManager( [ model ] );
		a.cameras[ 1 ].userData.__rayzeeEffects = { aperture: 1 };
		const state = json( a.serialize() );

		const renamed = new PerspectiveCamera();
		renamed.name = 'New';
		const { cm: b } = cameraManager( [ renamed ] );
		expect( b.restore( state ).mismatched ).toEqual( [ 'Old' ] );
		expect( renamed.userData.__rayzeeEffects ).toBeUndefined();

	} );

} );

describe( 'timeline and settings sessions', () => {

	it( 'restores camera keys', () => {

		const a = new CameraTrack();
		a.add( { position: new Vector3( 1, 2, 3 ), target: new Vector3(), fov: 40, orthoHeight: 2 }, 0 );
		a.add( { position: new Vector3( 4, 5, 6 ), target: new Vector3( 1, 0, 0 ), fov: 50, orthoHeight: 3 }, 2 );

		const b = new CameraTrack();
		b.restore( json( a.serialize() ) );

		expect( b.serialize() ).toEqual( a.serialize() );
		expect( b.sample( 1 ).position.toArray() ).toEqual( a.sample( 1 ).position.toArray() );

	} );

	it( 'saves only what a host set and leaves out keys this engine does not route', () => {

		const a = new RenderSettings( { maxBounces: 4, exposure: 1 } );
		a.set( 'maxBounces', 12 );
		a.setMany( { environmentRotation: 35 }, { source: SETTING_SOURCE.SCENE_METADATA } );
		const saved = json( a.serialize() );
		expect( saved ).toEqual( { maxBounces: 12 } );

		const b = new RenderSettings( { maxBounces: 4 } );
		expect( b.restore( { ...saved, retiredSetting: 3 } ) ).toEqual( [ 'retiredSetting' ] );
		expect( b.getEffective().maxBounces ).toMatchObject( { value: 12, source: SETTING_SOURCE.HOST } );

	} );

	it( 'records the value of every material property a host set', () => {

		const materials = new MaterialDataManager( null );
		materials.materialStorageAttr = { array: new Float32Array( MATERIAL_DATA_LAYOUT.FLOATS_PER_MATERIAL * 2 ) };
		materials._notifyReset = () => {};

		materials.updateMaterialProperty( 1, 'roughness', 0.25 );
		materials.updateMaterialProperty( 1, 'attenuationColor', new Color( 0.5, 0.25, 1 ) );
		materials.updateMaterialProperty( 1, 'attenuationDistance', Infinity );

		const edits = json( materials.serializeHostEdits() );
		expect( edits ).toHaveLength( 1 );
		expect( edits[ 0 ].index ).toBe( 1 );
		const props = fromPortable( edits[ 0 ].props );
		expect( props.roughness ).toBe( 0.25 );
		expect( props.attenuationColor.toArray() ).toEqual( [ 0.5, 0.25, 1 ] );
		expect( props.attenuationDistance ).toBe( Infinity );

	} );

} );

// The same model loaded twice: equal shape and names, new uuids.
function loadedScene() {

	const root = new Scene();
	const model = Object.assign( new Group(), { name: 'Room' } );
	const table = Object.assign( new Group(), { name: 'Table' } );
	const top = Object.assign( new Mesh( new BufferGeometry(), new MeshStandardMaterial( { name: 'Oak' } ) ), { name: 'Top' } );
	const leg = Object.assign( new Mesh( new BufferGeometry(), [ new MeshStandardMaterial( { name: 'Steel' } ) ] ), { name: 'Leg' } );
	const lamp = Object.assign( new Mesh( new BufferGeometry(), new MeshStandardMaterial( { name: 'Shade' } ) ), { name: 'Lamp' } );
	const bulb = Object.assign( new PointLight(), { visible: false } );
	top.userData.materialIndex = 0;
	leg.userData.materialIndex = 1;
	lamp.userData.materialIndex = 2;
	table.add( top, leg );
	model.add( table, lamp, bulb );
	root.add( model );
	return { root, model, table, top, leg, lamp, bulb };

}

function stateApp( scene = loadedScene() ) {

	return {
		scene,
		meshScene: scene.root,
		sceneModel: scene.model,
		sceneMeshes: [ scene.top, scene.leg, scene.lamp ],
		assetLoader: { sceneSourceKey: 'room.glb' },
		stages: { pathTracer: { materialData: { materialCount: 3, serializeHostEdits: () => [] } } },
		settings: { serialize: () => ( { exposure: 2 } ), restore: vi.fn( () => [] ) },
		environmentManager: { hdriSource: 'https://x.test/studio.hdr', serialize: () => ( { hdri: 'https://x.test/studio.hdr' } ), restore: vi.fn( async () => {} ) },
		color: null,
		lightManager: { serialize: () => [ { type: 'PointLight' } ], restore: vi.fn( () => [] ) },
		cameraManager: { serialize: () => ( { active: 0 } ), restore: vi.fn( () => ( { mismatched: [] } ) ) },
		timeline: { serialize: () => ( { keys: [ 1 ] } ), restore: vi.fn() },
		transformManager: { movedObjects: [], noteMoved: vi.fn() },
		addModel: vi.fn( async () => {} ),
		setMaterialProperty: vi.fn(),
		updateAllMeshVisibility: vi.fn(),
		updateMeshTransforms: vi.fn(),
		loadEnvironment: vi.fn( async () => {} ),
		loadFile: vi.fn( async () => {} ),
		loadColorConfig: vi.fn( async () => {} ),
		unloadColorConfig: vi.fn( async () => {} ),
		applyColorWorkingSpace: vi.fn( async () => {} ),
		_dispatchCamerasUpdated: vi.fn(),
		reset: vi.fn(),
	};

}

const sections = ( { skipped } ) => skipped.map( s => s.section );

describe( 'captureSceneState', () => {

	it( 'records the edits by place and name, as plain JSON', () => {

		const app = stateApp();
		const { scene } = app;
		scene.leg.visible = false;
		scene.table.position.set( 1, 2, 3 );
		app.transformManager.movedObjects = [ scene.table, new Object3D() ];
		app.stages.pathTracer.materialData.serializeHostEdits = () => [ { index: 2, props: { roughness: 0.3 } }, { index: 9, props: {} } ];
		scene.root.add(
			Object.assign( new Group(), { name: 'vase.glb', userData: { __rayzeeSceneObject: true, __rayzeeName: 'Vase', __rayzeeSourceUrl: 'https://x.test/vase.glb', __rayzeeCacheKey: 'v1' } } ),
			Object.assign( new Group(), { name: 'Mug', userData: { __rayzeeSceneObject: true } } ),
		);
		scene.model.userData.__rayzeeSceneObject = true;

		const state = captureSceneState( app );

		expect( json( state ) ).toEqual( state );
		expect( state ).toMatchObject( {
			v: SCENE_STATE_VERSION,
			engine: VERSION,
			scene: { key: 'room.glb', name: 'Room', meshes: 3, materials: 3 },
			appended: [ { name: 'Vase', url: 'https://x.test/vase.glb', cacheKey: 'v1' }, { name: 'Mug', url: null, cacheKey: null } ],
			settings: { exposure: 2 },
			environment: { hdri: 'https://x.test/studio.hdr' },
			color: null,
			lights: [ { type: 'PointLight' } ],
			cameras: { active: 0 },
			timeline: { keys: [ 1 ] },
			materials: [ { index: 2, props: { roughness: 0.3 }, name: 'Shade' }, { index: 9, props: {}, name: '' } ],
			hidden: [[ 0, 0, 1 ], [ 0, 2 ]],
			moved: [ { path: [ 0, 0 ], name: 'Table', position: [ 1, 2, 3 ], quaternion: [ 0, 0, 0, 1 ], scale: [ 1, 1, 1 ] } ],
		} );

	} );

	it( 'records the colour pipeline by config and view, and the working space only once adopted', () => {

		const app = stateApp();
		app.color = { status: () => ( {
			config: { id: 'studio-config' },
			activeView: { display: 'sRGB', view: 'AgX', configId: 'other' },
			workingSpaceAdopted: false,
			workingSpace: 'ACEScg',
			context: { SHOT: '010' },
		} ) };
		expect( captureSceneState( app ).color ).toEqual( {
			config: { id: 'studio-config' },
			view: { display: 'sRGB', view: 'AgX', look: null },
			transform: null,
			workingSpace: null,
			context: { SHOT: '010' },
		} );

		app.color = { status: () => ( { activeTransform: { id: 'filmic' }, workingSpaceAdopted: true, workingSpace: 'ACEScg' } ) };
		expect( captureSceneState( app ).color ).toEqual( { config: null, view: null, transform: 'filmic', workingSpace: 'ACEScg', context: null } );

	} );

} );

describe( 'applySceneState', () => {

	function saved( edit = () => {} ) {

		const before = stateApp();
		edit( before );
		return json( captureSceneState( before ) );

	}

	it( 'refuses another version', async () => {

		await expect( applySceneState( stateApp(), { v: 99 } ) ).rejects.toThrow( /version 99/ );
		await expect( applySceneState( stateApp(), null ) ).rejects.toThrow( /version undefined/ );

	} );

	it( 'puts visibility, moves and material edits back on a fresh load of the same scene', async () => {

		const state = saved( ( app ) => {

			app.scene.leg.visible = false;
			app.scene.bulb.visible = true;
			app.scene.table.position.set( 0, 5, 0 );
			app.scene.table.scale.setScalar( 2 );
			app.transformManager.movedObjects = [ app.scene.table ];
			app.stages.pathTracer.materialData.serializeHostEdits = () => [ { index: 0, props: { roughness: 0.3, color: toPortable( new Color( 1, 0, 0 ) ) } } ];

		} );
		const app = stateApp();
		const { top, leg, table, lamp, bulb } = app.scene;
		const color = top.material.color;

		const { skipped } = await applySceneState( app, state );

		expect( skipped ).toEqual( [] );
		expect( leg.visible ).toBe( false );
		expect( top.visible && lamp.visible && table.visible ).toBe( true );
		expect( bulb.visible ).toBe( false );
		expect( app.updateAllMeshVisibility ).toHaveBeenCalledOnce();
		expect( table.position.toArray() ).toEqual( [ 0, 5, 0 ] );
		expect( table.matrixWorld.elements[ 0 ] ).toBe( 2 );
		expect( app.transformManager.noteMoved ).toHaveBeenCalledWith( table );
		expect( app.updateMeshTransforms ).toHaveBeenCalledWith( [ 0, 1 ] );
		expect( top.material.roughness ).toBe( 0.3 );
		expect( top.material.color ).toBe( color );
		expect( color.toArray() ).toEqual( [ 1, 0, 0 ] );
		expect( app.setMaterialProperty ).toHaveBeenCalledWith( 0, 'roughness', 0.3 );
		expect( app.settings.restore ).toHaveBeenCalledWith( { exposure: 2 } );
		expect( app.lightManager.restore ).toHaveBeenCalledWith( [ { type: 'PointLight' } ] );
		expect( app.cameraManager.restore ).toHaveBeenCalledWith( { active: 0 } );
		expect( app._dispatchCamerasUpdated ).toHaveBeenCalledOnce();
		expect( app.timeline.restore ).toHaveBeenCalledWith( { keys: [ 1 ] } );
		expect( app.reset ).toHaveBeenCalledOnce();

	} );

	it( 'leaves objects and materials as loaded when the scene is another one, and says so', async () => {

		const state = saved( ( app ) => {

			app.scene.leg.visible = false;
			app.stages.pathTracer.materialData.serializeHostEdits = () => [ { index: 0, props: { roughness: 0.3 } } ];

		} );
		const app = stateApp();
		app.sceneMeshes = app.sceneMeshes.slice( 1 );

		const result = await applySceneState( app, state );

		expect( sections( result ) ).toEqual( [ 'scene' ] );
		expect( result.skipped[ 0 ] ).toMatchObject( { saved: { meshes: 3 }, now: { meshes: 2 } } );
		expect( app.scene.leg.visible ).toBe( true );
		expect( app.setMaterialProperty ).not.toHaveBeenCalled();
		expect( app.settings.restore ).toHaveBeenCalled();
		expect( app.reset ).toHaveBeenCalledOnce();

	} );

	it( 'skips a renamed material or object, and keeps going', async () => {

		const state = saved( ( app ) => {

			app.transformManager.movedObjects = [ app.scene.lamp ];
			app.stages.pathTracer.materialData.serializeHostEdits = () => [ { index: 1, props: { metalness: 1 } }, { index: 2, props: { roughness: 0.1 } } ];

		} );
		const app = stateApp();
		app.scene.leg.material[ 0 ].name = 'Iron';
		app.scene.lamp.name = 'Sconce';

		const result = await applySceneState( app, state );

		expect( result.skipped ).toEqual( [
			{ section: 'materials', reason: 'no such material', index: 1, name: 'Steel' },
			{ section: 'moved', reason: 'no such object', name: 'Lamp' },
		] );
		expect( app.setMaterialProperty.mock.calls ).toEqual( [[ 2, 'roughness', 0.1 ]] );
		expect( app.updateMeshTransforms ).not.toHaveBeenCalled();

	} );

	it( 'adds the appended models back by URL, and says which it could not', async () => {

		const state = saved( ( app ) => app.scene.root.add(
			Object.assign( new Group(), { userData: { __rayzeeSceneObject: true, __rayzeeName: 'Vase', __rayzeeSourceUrl: 'vase.glb', __rayzeeCacheKey: 'v1' } } ),
			Object.assign( new Group(), { userData: { __rayzeeSceneObject: true, __rayzeeName: 'Mug' } } ),
			Object.assign( new Group(), { userData: { __rayzeeSceneObject: true, __rayzeeName: 'Bowl', __rayzeeSourceUrl: 'bowl.glb' } } ),
		) );
		const app = stateApp();
		app.addModel = vi.fn( async ( url ) => {

			if ( url === 'bowl.glb' ) throw new Error( '404' );

		} );

		const { skipped } = await applySceneState( app, state );

		expect( app.addModel.mock.calls ).toEqual( [[ 'vase.glb', { name: 'Vase', cacheKey: 'v1' } ], [ 'bowl.glb', { name: 'Bowl', cacheKey: undefined } ]] );
		expect( skipped ).toEqual( [
			{ section: 'appended', reason: 'added from memory, not a file', name: 'Mug' },
			{ section: 'appended', reason: '404', name: 'Bowl' },
		] );

	} );

	it( 'names the settings and model cameras it could not restore', async () => {

		const app = stateApp();
		app.settings.restore = () => [ 'retired' ];
		app.cameraManager.restore = () => ( { mismatched: [ 'Cam.001' ] } );

		const { skipped } = await applySceneState( app, saved() );
		expect( skipped ).toEqual( [
			{ section: 'settings', reason: 'not settings in this engine', keys: [ 'retired' ] },
			{ section: 'cameras', reason: 'model cameras changed', names: [ 'Cam.001' ] },
		] );

	} );

	it( 'gives restored lights their gobo and IES profile once those are loaded', async () => {

		const app = stateApp();
		const light = { uuid: 'L1', userData: { gobo: { name: 'window', scale: 2 }, ies: { name: 'cone', intensity: 3 } } };
		app.lightManager.restore = () => [ light ];
		app.goboManager = { entries: [ {} ], setLightGobo: vi.fn() };
		app.iesManager = { entries: [], setSpotLightProfile: vi.fn() };

		await applySceneState( app, saved() );
		expect( app.goboManager.setLightGobo ).toHaveBeenCalledWith( 'L1', 'window', { name: 'window', scale: 2 } );
		expect( app.iesManager.setSpotLightProfile ).not.toHaveBeenCalled();

		app.iesManager.entries = [ {} ];
		await applySceneState( app, saved() );
		expect( app.iesManager.setSpotLightProfile ).toHaveBeenCalledWith( 'L1', 'cone', 3, { applyAutoCone: false } );

	} );

	describe( 'the environment', () => {

		const withSky = ( hdri ) => ( { ...saved(), environment: { hdri } } );

		it( 'reloads a URL sky that differs, and restores the rest of its state', async () => {

			const app = stateApp();
			await applySceneState( app, withSky( 'https://x.test/dusk.hdr' ) );
			expect( app.loadEnvironment ).toHaveBeenCalledWith( 'https://x.test/dusk.hdr' );
			expect( app.environmentManager.restore ).toHaveBeenCalledWith( { hdri: 'https://x.test/dusk.hdr' } );

			const same = stateApp();
			await applySceneState( same, withSky( 'https://x.test/studio.hdr' ) );
			expect( same.loadEnvironment ).not.toHaveBeenCalled();

		} );

		it( 'asks the host for a local sky: a file, a URL, or nothing', async () => {

			const file = { name: 'dusk.hdr' };
			const app = stateApp();
			const resolve = vi.fn( async () => file );
			await applySceneState( app, withSky( 'dusk.hdr' ), { resolve } );
			expect( resolve ).toHaveBeenCalledWith( { kind: 'environment', source: 'dusk.hdr' } );
			expect( app.loadFile ).toHaveBeenCalledWith( file );

			await applySceneState( app, withSky( 'dusk.hdr' ), { resolve: async () => 'blob:sky' } );
			expect( app.loadEnvironment ).toHaveBeenCalledWith( 'blob:sky' );

			const { skipped } = await applySceneState( app, withSky( 'dusk.hdr' ) );
			expect( skipped ).toEqual( [ { section: 'environment', reason: 'source unavailable', source: 'dusk.hdr' } ] );

		} );

		it( 'skips a sky that fails to load, and still restores the environment state', async () => {

			const app = stateApp();
			app.loadEnvironment = async () => {

				throw new Error( 'bad header' );

			};

			const { skipped } = await applySceneState( app, withSky( 'https://x.test/dusk.hdr' ) );
			expect( skipped ).toEqual( [ { section: 'environment', reason: 'bad header', source: 'https://x.test/dusk.hdr' } ] );
			expect( app.environmentManager.restore ).toHaveBeenCalledOnce();

		} );

	} );

	describe( 'the colour pipeline', () => {

		class ColorPipeline {

			static builtins = [ { name: 'studio-config' } ];

			static async listBuiltinConfigs() {

				return ColorPipeline.builtins;

			}

			constructor( status = {} ) {

				this._status = status;
				this.workingSpaceAdopted = !! status.workingSpaceAdopted;
				this.workingSpace = status.workingSpace;
				this.setContext = vi.fn();
				this.setView = vi.fn();
				this.setActiveView = vi.fn();
				this.setWorkingSpace = vi.fn();

			}

			status() {

				return this._status;

			}

		}

		const withColor = ( color ) => ( { ...saved(), color } );
		const view = { display: 'sRGB', view: 'AgX', look: null };

		it( 'leaves a pipeline already as saved alone', async () => {

			const app = stateApp();
			app.color = new ColorPipeline( { config: { id: 'studio-config' }, activeView: { ...view } } );
			await applySceneState( app, withColor( { config: { id: 'studio-config' }, view } ) );
			expect( app.color.setView ).not.toHaveBeenCalled();
			expect( app.loadColorConfig ).not.toHaveBeenCalled();

		} );

		it( 'loads a built-in config the host did not, then the view, context and working space', async () => {

			const app = stateApp();
			app.color = new ColorPipeline();
			const resolve = vi.fn( async () => false );

			const { skipped } = await applySceneState( app, withColor( { config: { id: 'studio-config' }, view, context: { SHOT: '1' }, workingSpace: 'ACEScg' } ), { resolve } );

			expect( skipped ).toEqual( [] );
			expect( resolve ).toHaveBeenCalledWith( { kind: 'colorConfig', config: { id: 'studio-config' } } );
			expect( app.loadColorConfig ).toHaveBeenCalledWith( { builtin: 'studio-config', registerViews: false } );
			expect( app.color.setContext ).toHaveBeenCalledWith( { SHOT: '1' } );
			expect( app.color.setView ).toHaveBeenCalledWith( view );
			expect( app.color.setWorkingSpace ).toHaveBeenCalledWith( 'ACEScg' );
			expect( app.applyColorWorkingSpace ).toHaveBeenCalledOnce();

		} );

		it( 'takes a config the host loaded itself', async () => {

			const app = stateApp();
			app.color = new ColorPipeline();
			await applySceneState( app, withColor( { config: { id: 'ocio://custom' }, transform: 'filmic' } ), { resolve: async () => true } );
			expect( app.loadColorConfig ).not.toHaveBeenCalled();
			expect( app.color.setActiveView ).toHaveBeenCalledWith( 'filmic' );

		} );

		it( 'skips a config nobody can load', async () => {

			const app = stateApp();
			app.color = new ColorPipeline();
			const { skipped } = await applySceneState( app, withColor( { config: { id: 'lost-config' }, view } ) );
			expect( skipped ).toEqual( [ { section: 'color', reason: 'config unavailable', config: 'lost-config' } ] );
			expect( app.color.setView ).not.toHaveBeenCalled();

		} );

		it( 'unloads a config a session saved without, and records a step that fails', async () => {

			const app = stateApp();
			app.color = new ColorPipeline( { config: { id: 'studio-config' }, workingSpaceAdopted: true, workingSpace: 'ACEScg' } );
			await applySceneState( app, withColor( { config: null, view: null } ) );
			expect( app.unloadColorConfig ).toHaveBeenCalledOnce();
			expect( app.color.setWorkingSpace ).toHaveBeenCalledWith( undefined );

			app.unloadColorConfig = async () => {

				throw new Error( 'runtime gone' );

			};

			const { skipped } = await applySceneState( app, withColor( { config: null, view: null } ) );
			expect( skipped ).toEqual( [ { section: 'color', reason: 'runtime gone', config: null } ] );

		} );

	} );

} );
