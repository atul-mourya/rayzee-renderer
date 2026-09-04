/**
 * glTF RectAreaLightPlaceholder import — issue #14. The authored `intensity` is three.js
 * RectAreaLight radiance (the same files carry power = intensity·w·h·π); the engine's area-light
 * intensity is radiant power. The importer must convert through the light's WORLD area so the
 * serializer's power/(π·area) hands the shader the authored radiance, whatever the node scale.
 */
import { describe, expect, it } from 'vitest';
import { Group, Object3D, PerspectiveCamera, RectAreaLight, Scene, Vector3 } from 'three';
import { AssetLoader } from '@/core/Processor/AssetLoader.js';
import { LightSerializer } from '@/core/Processor/LightSerializer.js';
import { getRenderProfile } from '@/core/EngineDefaults.js';

const stubControls = () => ( { target: new Vector3(), maxDistance: 0, saveState() {}, update() {} } );
const newLoader = profile => new AssetLoader( new Scene(), new PerspectiveCamera(), stubControls(), { profile: getRenderProfile( profile ) } );

// Mirrors the shipped assets: a 70 x 70 placeholder authored in cm under a 0.01 node scale.
function importPlaceholder( { profile = 'physical', scale = [ 0.01, 0.01, 0.01 ], ...userData } = {} ) {

	const root = new Group();
	const scaled = new Group();
	scaled.scale.set( ...scale );
	const placeholder = new Object3D();
	placeholder.name = 'RectAreaLightPlaceholder';
	placeholder.userData = {
		type: 'RectAreaLight', name: 'ceilingLight', color: [ 1, 1, 1 ],
		intensity: 200, width: 70, height: 70, ...userData,
	};
	scaled.add( placeholder );
	root.add( scaled );

	newLoader( profile ).processModelObjects( root );
	return placeholder.children.find( o => o.isRectAreaLight );

}

// What the shader sees: L = power · (normalize ? 1/area : 1) / π, area per getAreaLight.
function serializedRadiance( light ) {

	const serializer = new LightSerializer();
	serializer.addRectAreaLight( light );
	const d = serializer.areaLightCache[ 0 ].data;
	const rectArea = 4 * new Vector3( d[ 3 ], d[ 4 ], d[ 5 ] ).cross( new Vector3( d[ 6 ], d[ 7 ], d[ 8 ] ) ).length();
	const area = d[ 15 ] > 0.5 ? rectArea * Math.PI / 4 : rectArea;
	return d[ 12 ] / Math.PI / ( d[ 13 ] > 0.5 ? area : 1 );

}

describe( 'AssetLoader — RectAreaLightPlaceholder import', () => {

	it( 'reproduces the authored radiance (physical profile)', () => {

		const light = importPlaceholder();
		expect( light.userData.normalize ).toBe( true );
		expect( light.intensity ).toBeCloseTo( 200 * Math.PI * 0.49, 6 );
		expect( serializedRadiance( light ) ).toBeCloseTo( 200, 6 );

	} );

	it( 'is independent of the node scale', () => {

		const stretched = importPlaceholder( { scale: [ 0.0116, 0.01, 0.01 ] } );
		const metres = importPlaceholder( { scale: [ 1, 1, 1 ], width: 0.7, height: 0.7 } );
		expect( serializedRadiance( stretched ) ).toBeCloseTo( 200, 6 );
		expect( serializedRadiance( metres ) ).toBeCloseTo( 200, 6 );

	} );

	it( 'honours an authored normalize: false', () => {

		const light = importPlaceholder( { normalize: false } );
		expect( light.userData.normalize ).toBe( false );
		expect( serializedRadiance( light ) ).toBeCloseTo( 200, 6 );

	} );

	it( 'applies the profile scale on top, and nothing else', () => {

		const viewer = importPlaceholder( { profile: 'viewer' } );
		expect( serializedRadiance( viewer ) ).toBeCloseTo( 200 * getRenderProfile( 'viewer' ).areaLightIntensityScale, 6 );

	} );

	it( 'does not move the authored light', () => {

		const light = importPlaceholder( { width: 70, height: 50 } );
		expect( light.position.toArray() ).toEqual( [ 0, 0, 0 ] );

	} );

} );

// A host handing over its own scene authors three.js units, where intensity is radiance in nits.
function adoptHostLight( { profile = 'physical', scale = [ 0.01, 0.01, 0.01 ], intensity = 200, width = 70, height = 70, userData = {}, times = 1 } = {} ) {

	const root = new Group();
	const scaled = new Group();
	scaled.scale.set( ...scale );
	const light = new RectAreaLight( 0xffffff, intensity, width, height );
	Object.assign( light.userData, userData );
	scaled.add( light );
	root.add( scaled );

	for ( let i = 0; i < times; i ++ ) newLoader( profile ).processModelObjects( root );
	return light;

}

describe( 'AssetLoader — host-provided RectAreaLight', () => {

	it( 'renders at the radiance three.js gives it', () => {

		expect( serializedRadiance( adoptHostLight() ) ).toBeCloseTo( 200, 6 );

	} );

	it( 'is independent of node scale and light size', () => {

		expect( serializedRadiance( adoptHostLight( { scale: [ 1, 1, 1 ], width: 0.7, height: 0.7 } ) ) ).toBeCloseTo( 200, 6 );
		expect( serializedRadiance( adoptHostLight( { scale: [ 0.0116, 0.01, 0.01 ] } ) ) ).toBeCloseTo( 200, 6 );
		expect( serializedRadiance( adoptHostLight( { width: 200, height: 35 } ) ) ).toBeCloseTo( 200, 6 );

	} );

	it( 'honours normalize:false and elliptical shape', () => {

		expect( serializedRadiance( adoptHostLight( { userData: { normalize: false } } ) ) ).toBeCloseTo( 200, 6 );
		expect( serializedRadiance( adoptHostLight( { userData: { shape: 'ellipse' } } ) ) ).toBeCloseTo( 200, 6 );

	} );

	it( 'survives a mirrored ancestor', () => {

		expect( serializedRadiance( adoptHostLight( { scale: [ - 0.01, 0.01, 0.01 ] } ) ) ).toBeCloseTo( 200, 6 );

	} );

	it( 'converts once, however often the scene is re-processed', () => {

		const once = adoptHostLight( { times: 1 } ).intensity;
		expect( adoptHostLight( { times: 3 } ).intensity ).toBeCloseTo( once, 6 );

	} );

	it( 'takes no viewer fudge — that tunes the placeholder convention only', () => {

		expect( serializedRadiance( adoptHostLight( { profile: 'viewer' } ) ) ).toBeCloseTo( 200, 6 );

	} );

	it( 'agrees with the placeholder path at equal authored radiance', () => {

		const viewerScale = getRenderProfile( 'viewer' ).areaLightIntensityScale;
		const host = serializedRadiance( adoptHostLight( { intensity: 200 * viewerScale } ) );
		expect( host ).toBeCloseTo( serializedRadiance( importPlaceholder( { profile: 'viewer' } ) ), 6 );

	} );

} );
