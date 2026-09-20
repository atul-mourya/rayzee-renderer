/**
 * glTF punctual light import. glTF states point/spot intensity in candela and directional in
 * lux — photometric units, which three.js also uses for the same properties. The engine is
 * radiometric (Blender Watts), so the importer divides the luminous efficacy back out, exactly
 * as Blender's own glTF importer does. Verified against Cycles: a 100 W point light 3 m above a
 * 0.5-grey plane renders 0.1407 in both.
 */
import { describe, expect, it } from 'vitest';
import { DirectionalLight, Group, PerspectiveCamera, PointLight, Scene, SpotLight, Vector3 } from 'three';
import { AssetLoader } from '@/core/Processor/AssetLoader.js';
import { LightSerializer } from '@/core/Processor/LightSerializer.js';
import { getRenderProfile } from '@/core/EngineDefaults.js';

const LUMENS_PER_WATT = 683;

const stubControls = () => ( { target: new Vector3(), maxDistance: 0, saveState() {}, update() {} } );
const newLoader = () => new AssetLoader( new Scene(), new PerspectiveCamera(), stubControls(), { profile: getRenderProfile( 'physical' ) } );

// What Blender's exporter writes for a lamp of `watts` (io_scene_gltf2, SPEC lighting mode).
const exportedCandela = watts => watts * LUMENS_PER_WATT / ( 4 * Math.PI );
const exportedLux = wattsPerSqM => wattsPerSqM * LUMENS_PER_WATT;

function importLight( light, { times = 1 } = {} ) {

	const root = new Group();
	root.add( light );
	const loader = newLoader();
	for ( let i = 0; i < times; i ++ ) loader.processModelObjects( root );
	return light;

}

describe( 'AssetLoader — glTF punctual light import', () => {

	it( 'recovers the authored wattage of a point light', () => {

		const light = importLight( new PointLight( 0xffffff, exportedCandela( 100 ) ) );
		expect( light.intensity ).toBeCloseTo( 100, 6 );

		const serializer = new LightSerializer();
		serializer.addPointLight( light );
		// data[ 6 ] is radiant intensity W/sr — what Cycles computes as P/4π.
		expect( serializer.pointLightCache[ 0 ].data[ 6 ] ).toBeCloseTo( 100 / ( 4 * Math.PI ), 6 );

	} );

	it( 'recovers the authored wattage of a spot light', () => {

		const light = importLight( new SpotLight( 0xffffff, exportedCandela( 50 ) ) );
		expect( light.intensity ).toBeCloseTo( 50, 6 );

	} );

	it( 'recovers the authored irradiance of a sun', () => {

		const light = importLight( new DirectionalLight( 0xffffff, exportedLux( 3.5 ) ) );
		expect( light.intensity ).toBeCloseTo( 3.5, 6 );

		const serializer = new LightSerializer();
		serializer.addDirectionalLight( light );
		expect( serializer.directionalLightCache[ 0 ].data[ 6 ] ).toBeCloseTo( 3.5, 6 );

	} );

	it( 'converts once, however many times the tree is processed', () => {

		expect( importLight( new PointLight( 0xffffff, exportedCandela( 100 ) ), { times: 3 } ).intensity ).toBeCloseTo( 100, 6 );
		expect( importLight( new DirectionalLight( 0xffffff, exportedLux( 3.5 ) ), { times: 3 } ).intensity ).toBeCloseTo( 3.5, 6 );

	} );

} );
