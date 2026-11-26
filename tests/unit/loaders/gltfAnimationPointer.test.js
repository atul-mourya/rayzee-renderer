import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { AnimationClip, AnimationMixer, InterpolateDiscrete, MeshBasicMaterial, PerspectiveCamera, Scene, Vector3, VectorKeyframeTrack } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { animationPointerPlugin, nodeVisibilityPlugin } from '@/core/loaders/GLTFAnimationPointer.js';
import { AssetLoader } from '@/core/loaders/AssetLoader.js';
import { AnimationManager } from '@/core/viewer/animation/AnimationManager.js';

// A point light on two nodes (three.js clones it, each copy named after its node) and a spot, animated as Blender's exporter writes a light: through
// KHR_animation_pointer, with no node in the channel. Each accessor a float array in one buffer.
function lightsGLTF( { extraChannels = [] } = {} ) {

	const arrays = {
		t3: [ 0, 1, 2 ], intensity: [ 0, 10, 5 ], color: [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ],
		t2: [ 0, 2 ], outer: [ 0.5, 0.8 ], range: [ 1, 3 ],
		// Cubic spline: ( in-tangent, value, out-tangent ) a key.
		cubic: [ 7, 2, 9, - 5, 4, 3 ],
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

	// glTF 2.0 Appendix C: v(t) = (2t³ − 3t² + 1) v_k + t_d (t³ − 2t² + t) b_k + (−2t³ + 3t²) v_k+1 + t_d (t³ − t²) a_k+1.
	const hermite = ( vk, bk, vk1, ak1, td, t ) => ( 2 * t ** 3 - 3 * t ** 2 + 1 ) * vk + td * ( t ** 3 - 2 * t ** 2 + t ) * bk
		+ ( - 2 * t ** 3 + 3 * t ** 2 ) * vk1 + td * ( t ** 3 - t ** 2 ) * ak1;

	it( 'plays a cubic spline as glTF defines it, tangents and all', async () => {

		const result = await load( lightsGLTF() );
		const mixer = new AnimationMixer( result.scene );
		mixer.clipAction( result.animations[ 0 ] ).play();
		// Keys 2 then 4 over 0–2 s; out of the first 9, into the second −5: the curve overshoots the line (2.5 at 0.5 s).
		const flicker = lightsIn( result.scene ).FlickerNode[ 0 ];
		for ( const time of [ 0.25, 0.5, 1, 1.5, 1.9 ] ) {

			mixer.setTime( time );
			expect( flicker.intensity ).toBeCloseTo( hermite( 2, 9, 4, - 5, 2, time / 2 ), 5 );

		}

		mixer.setTime( 0.5 );
		expect( flicker.intensity ).toBeGreaterThan( 3.5 );

		// Scaled into the engine's units per load (tangents too), the track stays a cubic spline.
		flicker.userData.__intensityScale = 0.5;
		const manager = new AnimationManager();
		manager.init( result.scene, result.scene, [], result.animations );
		manager.seekTo( 0.5 );
		expect( flicker.intensity ).toBeCloseTo( 0.5 * hermite( 2, 9, 4, - 5, 2, 0.25 ), 5 );

	} );

	it( 'plays a cubic colour and derives a cubic cone\'s penumbra from the curve', async () => {

		const gltf = JSON.parse( lightsGLTF() );
		const add = ( array, type ) => {

			const bytes = Buffer.from( gltf.buffers[ 0 ].uri.split( ',' )[ 1 ], 'base64' );
			const extra = Buffer.from( new Float32Array( array ).buffer );
			gltf.buffers[ 0 ] = { byteLength: bytes.length + extra.length, uri: `data:application/octet-stream;base64,${Buffer.concat( [ bytes, extra ] ).toString( 'base64' )}` };
			gltf.bufferViews.push( { buffer: 0, byteOffset: bytes.length, byteLength: extra.length } );
			gltf.accessors.push( { bufferView: gltf.bufferViews.length - 1, componentType: 5126, count: type === 'VEC3' ? array.length / 9 * 3 : array.length / 3 * 3, type } );
			return gltf.accessors.length - 1;

		};

		// Red to blue from 0.5 s to 2.5 s, every tangent 0; the outer cone 0.5 to 0.8 over 0–2 s (accessor 3), tangents 0.6.
		const colour = add( [ 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0 ], 'VEC3' );
		const cone = add( [ 0.6, 0.5, 0.6, 0.6, 0.8, 0.6 ], 'SCALAR' );
		const later = add( [ 0.5, 2.5, 0 ], 'SCALAR' );
		gltf.accessors[ colour ].count = 6;
		gltf.accessors[ cone ].count = 6;
		Object.assign( gltf.accessors[ later ], { count: 2, min: [ 0.5 ], max: [ 2.5 ] } );
		const samplers = gltf.animations[ 0 ].samplers;
		samplers.push( { input: later, output: colour, interpolation: 'CUBICSPLINE' }, { input: 3, output: cone, interpolation: 'CUBICSPLINE' } );
		gltf.animations[ 0 ].channels = [
			{ sampler: samplers.length - 2, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/extensions/KHR_lights_punctual/lights/0/color' } } } },
			{ sampler: samplers.length - 1, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/extensions/KHR_lights_punctual/lights/1/spot/outerConeAngle' } } } },
		];
		const result = await load( JSON.stringify( gltf ) );
		const mixer = new AnimationMixer( result.scene );
		mixer.clipAction( result.animations[ 0 ] ).play();
		const { BulbA, SpotNode } = lightsIn( result.scene );
		// Before its first key, the first key's value (not its tangent).
		mixer.update( 0.25 );
		expect( BulbA[ 0 ].color.toArray() ).toEqual( [ 1, 0, 0 ] );
		// A quarter of the way: 0.156 of the way to blue on the curve, where the line is at 0.25.
		mixer.update( 0.75 );
		const w = hermite( 0, 0, 1, 0, 2, 0.25 );
		expect( w ).toBeCloseTo( 0.15625, 6 );
		expect( BulbA[ 0 ].color.toArray().map( v => Number( v.toFixed( 5 ) ) ) ).toEqual( [ 1 - w, 0, w ].map( v => Number( v.toFixed( 5 ) ) ) );
		mixer.update( 0.5 );
		const outer = hermite( 0.5, 0.6, 0.8, 0.6, 2, 0.75 );
		expect( SpotNode[ 0 ].angle ).toBeCloseTo( outer, 5 );
		// The penumbra track samples the curve 8 times a key span: at 1.5 s it is on a sample.
		expect( SpotNode[ 0 ].penumbra ).toBeCloseTo( 1 - 0.25 / outer, 5 );

	} );

	it( 'leaves out a pointer to anything but a light, and says which', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const { animations: [ clip ] } = await load( lightsGLTF( { extraChannels: [ '/materials/0/alphaCutoff', '/materials/3/alphaCutoff' ] } ) );
		expect( clip.tracks.some( ( t ) => /alpha/i.test( t.name ) ) ).toBe( false );
		expect( warn.mock.calls.flat().join( ' ' ) ).toMatch( /colour, metalness, roughness and emission are animated; left out \/materials\/n\/alphaCutoff(?!,)/ );
		warn.mockRestore();

	} );

	it( 'is part of every glTF load', async () => {

		const assets = new AssetLoader( new Scene(), new PerspectiveCamera(), { target: new Vector3(), maxDistance: 0, saveState() {}, update() {} } );
		const loader = await assets.createGLTFLoader();
		const { animations: [ clip ] } = await loader.parseAsync( lightsGLTF(), '' );
		expect( clip.tracks.length ).toBeGreaterThan( 0 );

	} );

} );

// Three nodes, two meshes: `Shell` (marked not visible, with the mesh `Core` beneath it) and `Lid`, whose visibility is
// keyed as KHR_animation_pointer writes a boolean: unsigned bytes, stepped.
function visibilityGLTF( { shellVisible = false } = {} ) {

	const positions = new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] );
	const times = new Float32Array( [ 0, 1, 2 ] );
	const flags = new Uint8Array( [ 1, 0, 1, 0 ] );
	const bytes = Buffer.concat( [ Buffer.from( positions.buffer ), Buffer.from( times.buffer ), Buffer.from( flags ) ] );
	return JSON.stringify( {
		asset: { version: '2.0' },
		extensionsUsed: [ 'KHR_node_visibility', 'KHR_animation_pointer' ],
		nodes: [
			{ name: 'Shell', children: [ 1 ], extensions: { KHR_node_visibility: { visible: shellVisible } } },
			{ name: 'Core', mesh: 0 },
			{ name: 'Lid', mesh: 0, extensions: { KHR_node_visibility: { visible: true } } },
		],
		meshes: [ { primitives: [ { attributes: { POSITION: 0 } } ] } ],
		scenes: [ { nodes: [ 0, 2 ] } ],
		scene: 0,
		buffers: [ { byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString( 'base64' )}` } ],
		bufferViews: [ { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }, { buffer: 0, byteOffset: 48, byteLength: 3 } ],
		accessors: [
			{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 1, 1, 0 ] },
			{ bufferView: 1, componentType: 5126, count: 3, type: 'SCALAR', min: [ 0 ], max: [ 2 ] },
			{ bufferView: 2, componentType: 5121, count: 3, type: 'SCALAR' },
		],
		animations: [ {
			name: 'Blink',
			samplers: [ { input: 1, output: 2, interpolation: 'STEP' } ],
			channels: [ { sampler: 0, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: '/nodes/2/extensions/KHR_node_visibility/visible' } } } } ],
		} ],
	} );

}

describe( 'glTF KHR_node_visibility', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );

	} );
	afterAll( () => vi.unstubAllGlobals() );

	const load = ( gltf ) => new GLTFLoader().register( animationPointerPlugin ).register( nodeVisibilityPlugin ).parseAsync( gltf, '' );
	const byName = ( scene, name ) => scene.getObjectByName( name );

	it( 'hides a node marked not visible, and what it holds with it; three.js alone shows it', async () => {

		const { scene } = await load( visibilityGLTF() );
		expect( byName( scene, 'Shell' ).visible ).toBe( false );
		// Hidden through its parent, as the engine reads a mesh's visibility.
		expect( byName( scene, 'Core' ).visible ).toBe( true );
		expect( byName( scene, 'Lid' ).visible ).toBe( true );
		expect( ( await load( visibilityGLTF( { shellVisible: true } ) ) ).scene.getObjectByName( 'Shell' ).visible ).toBe( true );
		const plain = await new GLTFLoader().parseAsync( visibilityGLTF(), '' );
		expect( plain.scene.getObjectByName( 'Shell' ).visible ).toBe( true );

	} );

	it( 'keys an animated visibility on the node it points at, stepped, and the engine sees it change', async () => {

		const result = await load( visibilityGLTF() );
		const [ clip ] = result.animations;
		const track = clip.tracks.find( ( t ) => t.name === 'Lid.visible' );
		expect( Array.from( track.values ) ).toEqual( [ true, false, true ] );
		expect( track.getInterpolation() ).toBe( InterpolateDiscrete );

		const lid = byName( result.scene, 'Lid' );
		const mixer = new AnimationMixer( result.scene );
		mixer.clipAction( clip ).play();
		const at = ( time ) => {

			mixer.setTime( time );
			return lid.visible;

		};

		expect( [ 0.5, 1.5, 1.99 ].map( at ) ).toEqual( [ true, false, false ] );

		const meshes = [];
		result.scene.traverse( ( o ) => o.isMesh && meshes.push( o ) );
		const manager = new AnimationManager();
		const poses = [];
		manager.applyPoseCallback = ( pose ) => poses.push( pose );
		manager.init( result.scene, result.scene, meshes, result.animations );
		manager.seekTo( 1.5 );
		expect( lid.visible ).toBe( false );
		expect( poses.some( ( p ) => p.visibilityChanged ) ).toBe( true );

	} );

	it( 'is part of every glTF load', async () => {

		const assets = new AssetLoader( new Scene(), new PerspectiveCamera(), { target: new Vector3(), maxDistance: 0, saveState() {}, update() {} } );
		const loader = await assets.createGLTFLoader();
		const { scene } = await loader.parseAsync( visibilityGLTF(), '' );
		expect( scene.getObjectByName( 'Shell' ).visible ).toBe( false );

	} );

} );

describe( 'glTF camera field of view through KHR_animation_pointer', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );

	} );
	afterAll( () => vi.unstubAllGlobals() );

	// A perspective camera on one node, its yfov keyed 0.4 → 1.2 rad over 2 s; a pointer at an orthographic camera's xmag.
	function cameraGLTF( interpolation = 'LINEAR' ) {

		const times = new Float32Array( [ 0, 2 ] );
		const fov = new Float32Array( interpolation === 'CUBICSPLINE' ? [ 0, 0.4, 0, 0, 1.2, 0 ] : [ 0.4, 1.2 ] );
		const bytes = Buffer.concat( [ Buffer.from( times.buffer ), Buffer.from( fov.buffer ) ] );
		const pointer = ( path ) => ( { sampler: 0, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: path } } } } );
		return JSON.stringify( {
			asset: { version: '2.0' },
			cameras: [ { type: 'perspective', perspective: { yfov: 0.8, znear: 0.1 } }, { type: 'orthographic', orthographic: { xmag: 1, ymag: 1, znear: 0.1, zfar: 10 } } ],
			nodes: [ { name: 'Cam', camera: 0 }, { name: 'Ortho', camera: 1 } ],
			scenes: [ { nodes: [ 0, 1 ] } ],
			scene: 0,
			buffers: [ { byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString( 'base64' )}` } ],
			bufferViews: [ { buffer: 0, byteOffset: 0, byteLength: 8 }, { buffer: 0, byteOffset: 8, byteLength: fov.byteLength } ],
			accessors: [
				{ bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [ 0 ], max: [ 2 ] },
				{ bufferView: 1, componentType: 5126, count: fov.length, type: 'SCALAR' },
			],
			animations: [ {
				name: 'Zoom',
				samplers: [ { input: 0, output: 1, interpolation } ],
				channels: [ pointer( '/cameras/0/perspective/yfov' ), pointer( '/cameras/1/orthographic/xmag' ) ],
			} ],
		} );

	}

	const load = ( gltf ) => new GLTFLoader().register( animationPointerPlugin ).parseAsync( gltf, '' );

	it( 'keys three\'s fov, in degrees, on the camera the node shows; a pointer at anything else of a camera is left out', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const result = await load( cameraGLTF() );
		const [ clip ] = result.animations;
		expect( clip.tracks.map( ( t ) => t.name ) ).toEqual( [ 'Cam.fov' ] );
		expect( warn.mock.calls.flat().join( ' ' ) ).toMatch( /left out \/cameras\/n\/orthographic\/xmag/ );
		warn.mockRestore();

		const camera = result.scene.getObjectByName( 'Cam' );
		const mixer = new AnimationMixer( result.scene );
		mixer.clipAction( clip ).play();
		mixer.setTime( 1 );
		expect( camera.fov ).toBeCloseTo( 0.8 * 180 / Math.PI, 4 );

		// The engine's animation manager hands the camera on, whose fov the view then takes (_followAnimatedCamera).
		const manager = new AnimationManager();
		const poses = [];
		manager.applyPoseCallback = ( pose ) => poses.push( pose );
		manager.init( result.scene, result.scene, [], result.animations );
		manager.seekTo( 1.5 );
		expect( poses.at( - 1 ).cameras ).toContain( camera );
		expect( camera.fov ).toBeCloseTo( 1.0 * 180 / Math.PI, 4 );

	} );

	it( 'plays a cubic field of view as a curve', async () => {

		const result = await load( cameraGLTF( 'CUBICSPLINE' ) );
		const mixer = new AnimationMixer( result.scene );
		mixer.clipAction( result.animations[ 0 ] ).play();
		mixer.setTime( 0.5 );
		// Flat tangents: smoothstep from 0.4 to 1.2 a quarter of the way.
		const s = 3 * 0.25 ** 2 - 2 * 0.25 ** 3;
		expect( result.scene.getObjectByName( 'Cam' ).fov ).toBeCloseTo( ( 0.4 + 0.8 * s ) * 180 / Math.PI, 4 );

	} );

} );

describe( 'glTF animation pointers a file gets wrong', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );

	} );
	afterAll( () => vi.unstubAllGlobals() );

	it( 'leaves out a cubic spline without three values a key, saying so, rather than hang on play', async () => {

		const gltf = JSON.parse( lightsGLTF() );
		// The cubic accessor holds 6 values for 2 keys; claim 3 keys' times by pointing it at the 3-key time accessor.
		gltf.animations[ 0 ].samplers[ 4 ].input = 0;
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const result = await new GLTFLoader().register( animationPointerPlugin ).parseAsync( JSON.stringify( gltf ), '' );
		expect( result.animations[ 0 ].tracks.some( ( t ) => t.name === 'FlickerNode.intensity' ) ).toBe( false );
		expect( warn.mock.calls.flat().join( ' ' ) ).toMatch( /lights\/2\/intensity has a cubic spline whose values are not three a key/ );
		warn.mockRestore();

	} );

	it( 'reads a cubic visibility (which the extension forbids) by its values, not its tangents', async () => {

		const gltf = JSON.parse( visibilityGLTF() );
		// Two keys, laid out ( in, value, out ): tangents 1, values off then on.
		const flags = Buffer.from( new Uint8Array( [ 1, 0, 1, 1, 1, 1 ] ) );
		const bytes = Buffer.concat( [ Buffer.from( gltf.buffers[ 0 ].uri.split( ',' )[ 1 ], 'base64' ), flags ] );
		gltf.buffers[ 0 ] = { byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString( 'base64' )}` };
		gltf.bufferViews.push( { buffer: 0, byteOffset: bytes.length - 6, byteLength: 6 } );
		gltf.accessors.push( { bufferView: gltf.bufferViews.length - 1, componentType: 5121, count: 6, type: 'SCALAR' } );
		gltf.accessors.push( { bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [ 0 ], max: [ 1 ] } );
		gltf.animations[ 0 ].samplers[ 0 ] = { input: gltf.accessors.length - 1, output: gltf.accessors.length - 2, interpolation: 'CUBICSPLINE' };
		const result = await new GLTFLoader().register( animationPointerPlugin ).parseAsync( JSON.stringify( gltf ), '' );
		expect( Array.from( result.animations[ 0 ].tracks.find( ( t ) => t.name === 'Lid.visible' ).values ) ).toEqual( [ false, true ] );

	} );

} );

describe( 'glTF material properties through KHR_animation_pointer', () => {

	beforeAll( () => {

		if ( typeof ProgressEvent === 'undefined' ) vi.stubGlobal( 'ProgressEvent', class extends Event {} );

	} );
	afterAll( () => vi.unstubAllGlobals() );

	// Two meshes share material 0, a third has material 1: the base colour of 0 keyed red → blue (its alpha too), the
	// emission strength of 1 keyed 1 → 9 over 2 s.
	function materialsGLTF() {

		const arrays = { positions: [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ], times: [ 0, 2 ], base: [ 1, 0, 0, 0.5, 0, 0, 1, 1 ], strength: [ 1, 9 ] };
		const bytes = Buffer.from( new Float32Array( Object.values( arrays ).flat() ).buffer );
		let at = 0;
		const bufferViews = Object.values( arrays ).map( ( a ) => {

			const view = { buffer: 0, byteOffset: at, byteLength: a.length * 4 };
			at += a.length * 4;
			return view;

		} );
		const pointer = ( sampler, path ) => ( { sampler, target: { path: 'pointer', extensions: { KHR_animation_pointer: { pointer: path } } } } );
		return JSON.stringify( {
			asset: { version: '2.0' },
			extensionsUsed: [ 'KHR_animation_pointer', 'KHR_materials_emissive_strength' ],
			materials: [
				{ name: 'Paint', pbrMetallicRoughness: { baseColorFactor: [ 1, 0, 0, 1 ] } },
				{ name: 'Screen', emissiveFactor: [ 1, 1, 1 ], extensions: { KHR_materials_emissive_strength: { emissiveStrength: 1 } } },
			],
			meshes: [ { primitives: [ { attributes: { POSITION: 0 }, material: 0 } ] }, { primitives: [ { attributes: { POSITION: 0 }, material: 1 } ] } ],
			nodes: [ { name: 'Left', mesh: 0 }, { name: 'Right', mesh: 0, translation: [ 2, 0, 0 ] }, { name: 'Monitor', mesh: 1 } ],
			scenes: [ { nodes: [ 0, 1, 2 ] } ],
			scene: 0,
			buffers: [ { byteLength: bytes.length, uri: `data:application/octet-stream;base64,${bytes.toString( 'base64' )}` } ],
			bufferViews,
			accessors: [
				{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 1, 1, 0 ] },
				{ bufferView: 1, componentType: 5126, count: 2, type: 'SCALAR', min: [ 0 ], max: [ 2 ] },
				{ bufferView: 2, componentType: 5126, count: 2, type: 'VEC4' },
				{ bufferView: 3, componentType: 5126, count: 2, type: 'SCALAR' },
			],
			animations: [ {
				name: 'Fade',
				samplers: [ { input: 1, output: 2 }, { input: 1, output: 3 } ],
				channels: [
					pointer( 0, '/materials/0/pbrMetallicRoughness/baseColorFactor' ),
					pointer( 1, '/materials/1/extensions/KHR_materials_emissive_strength/emissiveStrength' ),
				],
			} ],
		} );

	}

	const load = ( gltf ) => new GLTFLoader().register( animationPointerPlugin ).parseAsync( gltf, '' );

	it( 'keys three\'s material property on every mesh drawn with the material, a base colour without its alpha', async () => {

		const result = await load( materialsGLTF() );
		const [ clip ] = result.animations;
		expect( clip.tracks.map( ( t ) => t.name ).sort() ).toEqual( [ 'Left.material.color', 'Monitor.material.emissiveIntensity', 'Right.material.color' ] );
		expect( Array.from( clip.tracks.find( ( t ) => t.name === 'Left.material.color' ).values ) ).toEqual( [ 1, 0, 0, 0, 0, 1 ] );

		const mixer = new AnimationMixer( result.scene );
		mixer.clipAction( clip ).play();
		mixer.setTime( 0.5 );
		const left = result.scene.getObjectByName( 'Left' ), monitor = result.scene.getObjectByName( 'Monitor' );
		expect( left.material.color.toArray().map( ( v ) => Number( v.toFixed( 6 ) ) ) ).toEqual( [ 0.75, 0, 0.25 ] );
		expect( monitor.material.emissiveIntensity ).toBeCloseTo( 3, 6 );

	} );

	it( 'reaches the engine as edits of the materials whose values moved, once a material, and back on stop', async () => {

		const result = await load( materialsGLTF() );
		const meshes = [];
		result.scene.traverse( ( o ) => o.isMesh && meshes.push( o ) );
		const manager = new AnimationManager();
		const poses = [];
		manager.applyPoseCallback = ( pose ) => poses.push( pose );
		manager.init( result.scene, result.scene, meshes, result.animations );

		manager.seekTo( 1 );
		const sent = poses.flatMap( ( p ) => p.materials ?? [] );
		// Left and Right share Paint: its colour goes once.
		expect( sent.map( ( m ) => `${m.mesh.material.name}.${m.property}` ).sort() ).toEqual( [ 'Paint.color', 'Screen.emissiveIntensity' ] );
		expect( sent.find( ( m ) => m.property === 'emissiveIntensity' ).value ).toBeCloseTo( 5, 6 );
		const colour = sent.find( ( m ) => m.property === 'color' ).value;
		expect( colour.toArray().map( ( v ) => Number( v.toFixed( 6 ) ) ) ).toEqual( [ 0.5, 0, 0.5 ] );
		// A copy: the clip moving the material on does not move what was sent.
		expect( colour ).not.toBe( result.scene.getObjectByName( 'Left' ).material.color );

		poses.length = 0;
		manager.seekTo( 1 );
		expect( poses.flatMap( ( p ) => p.materials ?? [] ) ).toEqual( [] );

		manager.play();
		manager.stop();
		const back = poses.flatMap( ( p ) => p.materials ?? [] );
		expect( back.find( ( m ) => m.property === 'emissiveIntensity' )?.value ).toBe( 1 );
		expect( back.find( ( m ) => m.property === 'color' )?.value.toArray() ).toEqual( [ 1, 0, 0 ] );

		// What was sent belongs to this scene: a static model loaded next must not hold its materials.
		manager.dispose();
		expect( manager._sentMaterials.size ).toBe( 0 );

	} );

	// Restored values as the engine gets them, per `material.property`.
	const restored = ( poses ) => Object.fromEntries( poses.flatMap( ( p ) => p.materials ?? [] )
		.map( ( m ) => [ `${m.mesh.material.name}.${m.property}`, m.value?.isColor ? m.value.toArray() : m.value ] ) );

	it( 'puts a deforming scene\'s materials back on stop', async () => {

		const result = await load( materialsGLTF() );
		const meshes = [];
		result.scene.traverse( ( o ) => o.isMesh && meshes.push( o ) );
		// A skinned mesh anywhere makes the scene deforming: its pose stays on stop, its materials must not.
		meshes.push( { isSkinnedMesh: true, geometry: meshes[ 0 ].geometry } );
		const manager = new AnimationManager();
		const poses = [];
		manager.applyPoseCallback = ( pose ) => poses.push( pose );
		manager.init( result.scene, result.scene, meshes, result.animations );

		manager.seekTo( 1 );
		poses.length = 0;
		manager.stop();
		expect( restored( poses ) ).toEqual( { 'Paint.color': [ 1, 0, 0 ], 'Screen.emissiveIntensity': 1 } );

	} );

	it( 'puts another clip\'s materials back when a clip that keys none is played', async () => {

		const result = await load( materialsGLTF() );
		const meshes = [];
		result.scene.traverse( ( o ) => o.isMesh && meshes.push( o ) );
		const slide = new AnimationClip( 'Slide', 2, [ new VectorKeyframeTrack( 'Left.position', [ 0, 2 ], [ 0, 0, 0, 1, 0, 0 ] ) ] );
		const manager = new AnimationManager();
		const poses = [];
		manager.applyPoseCallback = ( pose ) => poses.push( pose );
		manager.init( result.scene, result.scene, meshes, [ ...result.animations, slide ] );

		manager.seekTo( 1, 0 );
		poses.length = 0;
		manager.seekTo( 1, 1 );
		expect( restored( poses ) ).toEqual( { 'Paint.color': [ 1, 0, 0 ], 'Screen.emissiveIntensity': 1 } );

	} );

	it( 'leaves out a property an unlit material lacks, saying so', async () => {

		const result = await load( materialsGLTF() );
		const json = JSON.parse( materialsGLTF() );
		json.extensionsUsed.push( 'KHR_materials_unlit' );
		json.materials[ 1 ].extensions.KHR_materials_unlit = {};
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const unlit = await load( JSON.stringify( json ) );
		expect( unlit.scene.getObjectByName( 'Monitor' ).material ).toBeInstanceOf( MeshBasicMaterial );
		expect( unlit.animations[ 0 ].tracks.map( ( t ) => t.name ).sort() ).toEqual( [ 'Left.material.color', 'Right.material.color' ] );
		expect( warn.mock.calls.flat().join( ' ' ) ).toMatch( /material 1 has no emissiveIntensity/ );
		warn.mockRestore();
		expect( result.animations[ 0 ].tracks ).toHaveLength( 3 );

	} );

	it( 'applies a pose\'s properties as one batch of edits that are not the host\'s, and restarts once', async () => {

		const { PathTracerApp } = await import( '@/core/viewer/PathTracerApp.js' );
		const calls = [];
		const mesh = { userData: { materialIndex: 4 } };
		const app = {
			_sdf: {
				instanceTable: {},
				updateMaterialEmissive: () => calls.push( [ 'one emitter edit' ] ),
				updateMaterialsEmissive: ( edits ) => calls.push( [ 'emitters', edits.map( ( e ) => e.property ) ] ),
			},
			stages: { pathTracer: { materialData: { updateMaterialProperty: ( ...args ) => calls.push( [ 'material', ...args ] ) } } },
			_uploadEmissivePayload() {},
			lightManager: null,
			reset: ( ...args ) => calls.push( [ 'reset', ...args ] ),
		};
		PathTracerApp.prototype._applyAnimationPose.call( app, { meshIndices: [], visibilityChanged: false, cameras: [], lights: [], materials: [
			{ mesh, property: 'emissiveIntensity', value: 7 },
			{ mesh, property: 'emissive', value: 'white' },
			{ mesh: { userData: {} }, property: 'roughness', value: 0.2 },
		] } );
		expect( calls ).toEqual( [
			[ 'material', 4, 'emissiveIntensity', 7, false ],
			[ 'material', 4, 'emissive', 'white', false ],
			[ 'emitters', [ 'emissiveIntensity', 'emissive' ]],
			[ 'reset' ],
		] );

	} );

} );
