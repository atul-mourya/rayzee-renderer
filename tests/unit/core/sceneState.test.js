import { describe, it, expect, vi } from 'vitest';
import { Color, Object3D, PerspectiveCamera, Scene, Vector2, Vector3 } from 'three';
import { toPortable, fromPortable } from '@/core/SceneState/portable.js';
import { LightManager } from '@/core/managers/LightManager.js';
import { CameraManager } from '@/core/managers/CameraManager.js';
import { CameraTrack } from '@/core/managers/timeline/CameraTrack.js';
import { RenderSettings, SETTING_SOURCE } from '@/core/RenderSettings.js';
import { MaterialDataManager } from '@/core/managers/MaterialDataManager.js';
import { MATERIAL_DATA_LAYOUT } from '@/core/EngineDefaults.js';

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
