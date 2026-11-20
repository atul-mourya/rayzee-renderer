import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AnimationMixer, InterpolateDiscrete, PerspectiveCamera, Scene, Vector3 } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { animationPointerPlugin } from '@/core/loaders/GLTFAnimationPointer.js';
import { AssetLoader } from '@/core/loaders/AssetLoader.js';

// A point light on two nodes (three.js clones it, each copy named after its node) and a spot, animated as Blender's exporter writes a light: through
// KHR_animation_pointer, with no node in the channel. Each accessor a float array in one buffer.
function lightsGLTF( { extraChannels = [] } = {} ) {

	const arrays = {
		t3: [ 0, 1, 2 ], intensity: [ 0, 10, 5 ], color: [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ],
		t2: [ 0, 2 ], outer: [ 0.5, 0.8 ], range: [ 1, 3 ],
		// Cubic spline: ( in-tangent, value, out-tangent ) a key.
		cubic: [ 9, 2, 9, 9, 4, 9 ],
		emissive: [ 1, 2 ],
	};
	const names = Object.keys( arrays );
	const bytes = new Float32Array( names.flatMap( ( n ) => arrays[ n ] ) );
	let offset = 0;
	const bufferViews = [], accessors = [];
	for ( const n of names ) {

		const length = arrays[ n ].length;
		const type = n === 'color' ? 'VEC3' : 'SCALAR';
		bufferViews.push( { buffer: 0, byteOffset: offset * 4, byteLength: length * 4 } );
		const count = type === 'VEC3' ? length / 3 : length;
		const accessor = { bufferView: bufferViews.length - 1, componentType: 5126, count, type };
		if ( n.startsWith( 't' ) ) Object.assign( accessor, { min: [ Math.min( ...arrays[ n ] ) ], max: [ Math.max( ...arrays[ n ] ) ] } );
		accessors.push( accessor );
		offset += length;

	}

	const at = ( n ) => names.indexOf( n );
	const pointer = ( sampler, path ) => ( { sampler, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: path } } } } );
	return JSON.stringify( {
		asset: { version: '2.0' },
		extensionsUsed: [ 'KHR_lights_punctual', 'KHR_animation_pointer' ],
		extensions: { KHR_lights_punctual: { lights: [
			{ type: 'point', name: 'Bulb', intensity: 3 },
			{ type: 'spot', name: 'Spot', spot: { innerConeAngle: 0.25, outerConeAngle: 0.5 } },
			{ type: 'point', name: 'Flicker' },
		] } },
		nodes: [
			{ name: 'BulbA', extensions: { KHR_lights_punctual: { light: 0 } } },
			{ name: 'BulbB', translation: [ 2, 0, 0 ], extensions: { KHR_lights_punctual: { light: 0 } } },
			{ name: 'SpotNode', extensions: { KHR_lights_punctual: { light: 1 } } },
			{ name: 'FlickerNode', extensions: { KHR_lights_punctual: { light: 2 } } },
		],
		scenes: [ { nodes: [ 0, 1, 2, 3 ] } ],
		scene: 0,
		buffers: [ { byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from( bytes.buffer ).toString( 'base64' )}` } ],
		bufferViews, accessors,
		animations: [ {
			name: 'Lights',
			samplers: [
				{ input: at( 't3' ), output: at( 'intensity' ) },
				{ input: at( 't3' ), output: at( 'color' ) },
				{ input: at( 't2' ), output: at( 'outer' ) },
				{ input: at( 't2' ), output: at( 'range' ), interpolation: 'STEP' },
				{ input: at( 't2' ), output: at( 'cubic' ), interpolation: 'CUBICSPLINE' },
				{ input: at( 't2' ), output: at( 'emissive' ) },
			],
			channels: [
				pointer( 0, '/extensions/KHR_lights_punctual/lights/0/intensity' ),
				pointer( 1, '/extensions/KHR_lights_punctual/lights/0/color' ),
				pointer( 2, '/extensions/KHR_lights_punctual/lights/1/spot/outerConeAngle' ),
				pointer( 3, '/extensions/KHR_lights_punctual/lights/1/range' ),
				pointer( 4, '/extensions/KHR_lights_punctual/lights/2/intensity' ),
				...extraChannels.map( ( path ) => pointer( 5, path ) ),
			],
		} ],
	} );

}

const lightsIn = ( scene ) => {

	const lights = {};
	scene.traverse( ( o ) => {

		if ( o.isLight ) ( lights[ o.name ] ??= [] ).push( o );

	} );
	return lights;

};

describe( 'glTF KHR_animation_pointer on lights', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );

	} );
	afterAll( () => vi.unstubAllGlobals() );

	const load = ( gltf ) => new GLTFLoader().register( animationPointerPlugin ).parseAsync( gltf, '' );

	it( 'is skipped by three.js alone: a clip with no light track', async () => {

		const result = await new GLTFLoader().parseAsync( lightsGLTF(), '' );
		expect( result.animations[ 0 ].tracks ).toEqual( [] );

	} );

	it( 'keys each light\'s intensity, colour and range to its three.js properties, on every copy of a light', async () => {

		const { animations: [ clip ] } = await load( lightsGLTF() );
		const byName = Object.fromEntries( clip.tracks.map( ( t ) => [ t.name, t ] ) );
		const bulbs = Object.keys( byName ).filter( ( n ) => n.endsWith( '.intensity' ) && n.startsWith( 'Bulb' ) );
		expect( bulbs ).toHaveLength( 2 );
		for ( const name of bulbs ) expect( Array.from( byName[ name ].values ) ).toEqual( [ 0, 10, 5 ] );
		const color = Object.values( byName ).find( ( t ) => t.name.endsWith( '.color' ) );
		expect( Array.from( color.values ) ).toEqual( [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ] );
		const range = byName[ 'SpotNode.distance' ];
		expect( Array.from( range.values ) ).toEqual( [ 1, 3 ] );
		expect( range.getInterpolation() ).toBe( InterpolateDiscrete );
		expect( clip.duration ).toBe( 2 );

	} );

	it( 'turns a spot\'s cone angles into three\'s angle and penumbra, the other cone as loaded', async () => {

		const { animations: [ clip ] } = await load( lightsGLTF() );
		const angle = clip.tracks.find( ( t ) => t.name === 'SpotNode.angle' );
		const penumbra = clip.tracks.find( ( t ) => t.name === 'SpotNode.penumbra' );
		expect( Array.from( angle.values ) ).toEqual( [ 0.5, 0.8 ].map( Math.fround ) );
		// Sampled 8 times between the outer cone's keys: 1 − inner / outer is not linear in it.
		expect( penumbra.times ).toHaveLength( 9 );
		expect( penumbra.values[ 0 ] ).toBeCloseTo( 1 - 0.25 / 0.5, 6 );
		expect( penumbra.values[ 4 ] ).toBeCloseTo( 1 - 0.25 / 0.65, 6 );
		expect( penumbra.values[ 8 ] ).toBeCloseTo( 1 - 0.25 / 0.8, 6 );

	} );

	it( 'plays on the lights: halfway between keys, the copies alike', async () => {

		const result = await load( lightsGLTF() );
		const mixer = new AnimationMixer( result.scene );
		mixer.clipAction( result.animations[ 0 ] ).play();
		mixer.update( 0.5 );
		const { BulbA, BulbB, SpotNode } = lightsIn( result.scene );
		for ( const bulb of [ ...BulbA, ...BulbB ] ) {

			expect( bulb.intensity ).toBeCloseTo( 5, 6 );
			expect( bulb.color.toArray().map( ( v ) => Number( v.toFixed( 6 ) ) ) ).toEqual( [ 0.5, 0.5, 0 ] );

		}

		expect( SpotNode[ 0 ].angle ).toBeCloseTo( 0.575, 6 );
		expect( SpotNode[ 0 ].distance ).toBe( 1 );

	} );

	it( 'steps the penumbra on a stepped cone\'s own keys, and gives a directional light no range', async () => {

		const gltf = JSON.parse( lightsGLTF() );
		gltf.extensions.KHR_lights_punctual.lights[ 0 ].type = 'directional';
		gltf.animations[ 0 ].samplers[ 2 ].interpolation = 'STEP';
		gltf.animations[ 0 ].channels.push( { sampler: 3, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/extensions/KHR_lights_punctual/lights/0/range' } } } } );
		const { animations: [ clip ] } = await load( JSON.stringify( gltf ) );
		const penumbra = clip.tracks.find( ( t ) => t.name === 'SpotNode.penumbra' );
		expect( Array.from( penumbra.times ) ).toEqual( [ 0, 2 ] );
		expect( penumbra.values[ 1 ] ).toBeCloseTo( 1 - 0.25 / 0.8, 6 );
		expect( penumbra.getInterpolation() ).toBe( InterpolateDiscrete );
		expect( clip.tracks.some( ( t ) => t.name.startsWith( 'Bulb' ) && t.name.endsWith( '.distance' ) ) ).toBe( false );

		// A stepped inner cone of three keys over the loaded outer (0.5): each key's own value from its own time on
		// (the intensity accessor's 0, 10, 5 serve as angles here, for the arithmetic).
		const inner = JSON.parse( lightsGLTF() );
		inner.animations[ 0 ].samplers.push( { input: 0, output: 1, interpolation: 'STEP' } );
		inner.animations[ 0 ].channels = [ { sampler: inner.animations[ 0 ].samplers.length - 1, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/extensions/KHR_lights_punctual/lights/1/spot/innerConeAngle' } } } } ];
		const steps = ( await load( JSON.stringify( inner ) ) ).animations[ 0 ].tracks.find( ( t ) => t.name === 'SpotNode.penumbra' );
		expect( Array.from( steps.values ) ).toEqual( [ 1, 1 - 10 / 0.5, 1 - 5 / 0.5 ] );

	} );

	it( 'plays a cubic spline\'s values linearly, without its tangents', async () => {

		const { animations: [ clip ] } = await load( lightsGLTF() );
		expect( Array.from( clip.tracks.find( ( t ) => t.name === 'FlickerNode.intensity' ).values ) ).toEqual( [ 2, 4 ] );

	} );

	it( 'leaves out a pointer to anything but a light, and says which', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const { animations: [ clip ] } = await load( lightsGLTF( { extraChannels: [ '/materials/0/emissiveFactor', '/materials/3/emissiveFactor' ] } ) );
		expect( clip.tracks.some( ( t ) => /emissive/.test( t.name ) ) ).toBe( false );
		expect( warn.mock.calls.flat().join( ' ' ) ).toMatch( /only lights are animated; left out \/materials\/n\/emissiveFactor(?!,)/ );
		warn.mockRestore();

	} );

	it( 'is part of every glTF load', async () => {

		const assets = new AssetLoader( new Scene(), new PerspectiveCamera(), { target: new Vector3(), maxDistance: 0, saveState() {}, update() {} } );
		const loader = await assets.createGLTFLoader();
		const { animations: [ clip ] } = await loader.parseAsync( lightsGLTF(), '' );
		expect( clip.tracks.length ).toBeGreaterThan( 0 );

	} );

} );
