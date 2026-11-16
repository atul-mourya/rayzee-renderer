import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, AnimationClip, VectorKeyframeTrack, BooleanKeyframeTrack, NumberKeyframeTrack, ColorKeyframeTrack, PropertyBinding, PointLight, SpotLight, Object3D, Float32BufferAttribute, InterpolateBezier, Scene } from 'three';
import { AnimationManager } from '@/core/viewer/animation/AnimationManager.js';
import { LightManager } from '@/core/lights/LightManager.js';

// Duplicate names at several depths, so which one a track binds depends on the walk's order.
function scene() {

	const root = new Group();
	root.name = 'root';
	const meshes = [];
	const mesh = ( name ) => {

		const m = new Mesh( new BoxGeometry(), new MeshBasicMaterial() );
		m.name = name;
		meshes.push( m );
		return m;

	};

	const a = new Group();
	a.name = 'twin';
	a.add( mesh( 'leaf' ), mesh( 'twin' ) );
	const b = new Group();
	b.name = 'b';
	const deep = new Group();
	deep.name = 'leaf';
	deep.add( mesh( 'twin' ) );
	b.add( deep, mesh( 'solo' ) );
	root.add( b, a );
	return { root, meshes, byUuid: meshes[ 2 ] };

}

describe( 'animation tracks bound from one walk', () => {

	it( 'bind the node three\'s own search finds, by name and by uuid', () => {

		const { root, meshes, byUuid } = scene();
		const names = [ 'twin', 'leaf', 'solo', 'b', byUuid.uuid, 'root', 'missing' ];
		const clip = new AnimationClip( 'move', 1, [
			...names.map( n => new VectorKeyframeTrack( `${n}.position`, [ 0, 1 ], [ 0, 0, 0, 1, 1, 1 ] ) ),
			new BooleanKeyframeTrack( 'solo.visible', [ 0, 1 ], [ true, false ] ),
		] );

		const search = PropertyBinding.findNode;
		const manager = new AnimationManager();
		manager.init( root, root, meshes, [ clip ] );

		const bound = manager.actions[ 0 ]._propertyBindings.map( p => [ p.binding.path, p.binding.node ] );
		expect( bound.length ).toBe( names.length + 1 );
		for ( const [ path, node ] of bound ) {

			const expected = PropertyBinding.findNode( root, PropertyBinding.parseTrackName( path ).nodeName );
			expect( node, path ).toBe( expected );

		}

		expect( bound.find( ( [ p ] ) => p === 'twin.position' )[ 1 ] ).toBe( root.children[ 0 ].children[ 0 ].children[ 0 ] );
		expect( PropertyBinding.findNode ).toBe( search );
		manager.dispose();

	} );

} );

describe( 'lights a clip moves', () => {

	it( 'are handed over with a pose: a light under an animated node, and one whose target is animated', () => {

		const root = new Group();
		root.name = 'root';
		const mesh = new Mesh( new BoxGeometry(), new MeshBasicMaterial() );
		const rig = new Group();
		rig.name = 'rig';
		const lamp = new PointLight();
		rig.add( lamp );
		const spot = new SpotLight();
		const aim = new Object3D();
		aim.name = 'aim';
		spot.target = aim;
		const still = new PointLight();
		root.add( mesh, rig, spot, aim, still );

		const clip = new AnimationClip( 'move', 1, [
			new VectorKeyframeTrack( 'rig.position', [ 0, 1 ], [ 0, 0, 0, 4, 0, 0 ] ),
			new VectorKeyframeTrack( 'aim.position', [ 0, 1 ], [ 0, 0, 0, 0, - 2, 0 ] ),
		] );
		const manager = new AnimationManager();
		const poses = [];
		manager.applyPoseCallback = ( pose ) => poses.push( pose );
		manager.init( root, root, [ mesh ], [ clip ] );
		manager.seekTo( 0.5 );

		expect( poses.at( - 1 ).lights ).toEqual( [ lamp, spot ] );
		expect( lamp.getWorldPosition( lamp.position.clone() ).x ).toBe( 2 );

	} );

	it( 'are handed over when a clip animates only their intensity, colour or visibility', () => {

		const root = new Group();
		const mesh = new Mesh( new BoxGeometry(), new MeshBasicMaterial() );
		const lamp = new PointLight( 0xffffff, 1 );
		lamp.name = 'lamp';
		const still = new PointLight();
		root.add( mesh, lamp, still );
		const clip = new AnimationClip( 'dim', 1, [
			new NumberKeyframeTrack( 'lamp.intensity', [ 0, 1 ], [ 1, 5 ] ),
			new ColorKeyframeTrack( 'lamp.color', [ 0, 1 ], [ 1, 1, 1, 1, 0, 0 ] ),
			new BooleanKeyframeTrack( 'lamp.visible', [ 0, 0.75 ], [ true, false ] ),
		] );
		const traced = new Scene();
		const lights = new LightManager( traced, { visible: false }, { updateLights() {} } );
		lights.transferSceneLights( root );
		const [ copy ] = traced.getObjectsByProperty( 'isLight', true );
		const manager = new AnimationManager();
		const poses = [];
		manager.applyPoseCallback = ( pose ) => {

			poses.push( pose );
			lights.followSources( pose.lights );

		};

		manager.init( root, root, [ mesh ], [ clip ] );
		manager.seekTo( 0.5 );

		expect( poses.at( - 1 ).lights ).toEqual( [ lamp ] );
		expect( [ copy.intensity, ...copy.color.toArray(), copy.visible ] ).toEqual( [ 3, 1, 0.5, 0.5, true ] );
		manager.seekTo( 0.9 );
		expect( copy.visible ).toBe( false );

	} );

	it( 'report a clip\'s end once its last pose has reached the lights', () => {

		const root = new Group();
		const mesh = new Mesh( new BoxGeometry(), new MeshBasicMaterial() );
		const lamp = new PointLight( 0xffffff, 1 );
		lamp.name = 'lamp';
		root.add( mesh, lamp );
		const manager = new AnimationManager();
		const seen = [];
		manager.applyPoseCallback = () => seen.push( [ 'pose', lamp.intensity ] );
		manager.onFinished = () => seen.push( [ 'finished', lamp.intensity ] );
		manager.init( root, root, [ mesh ], [ new AnimationClip( 'dim', 1, [ new NumberKeyframeTrack( 'lamp.intensity', [ 0, 1 ], [ 1, 5 ] ) ] ) ] );
		manager.setLoop( false );
		manager.play();
		manager.timer.update = () => {};

		manager.timer.getDelta = () => 2;
		manager.update();

		expect( seen.slice( - 2 ) ).toEqual( [[ 'pose', 5 ], [ 'finished', 5 ]] );
		expect( manager.isPlaying ).toBe( false );

	} );

	it( 'play a light\'s intensity in the units the loader converted it to, the clip itself left as it was', () => {

		const root = new Group();
		const mesh = new Mesh( new BoxGeometry(), new MeshBasicMaterial() );
		const lamp = new PointLight( 0xffffff, 0.5 );
		lamp.name = 'lamp';
		lamp.userData.__intensityScale = 0.25;
		root.add( mesh, lamp );
		const clip = new AnimationClip( 'dim', 1, [ new NumberKeyframeTrack( 'lamp.intensity', [ 0, 1 ], [ 2, 6 ] ) ] );
		const manager = new AnimationManager();
		manager.init( root, root, [ mesh ], [ clip ] );
		manager.seekTo( 0.5 );
		expect( lamp.intensity ).toBe( 1 );
		expect( Array.from( clip.tracks[ 0 ].values ) ).toEqual( [ 2, 6 ] );
		// Stopped, the light is back where it was loaded.
		manager.stop();
		expect( lamp.intensity ).toBe( 0.5 );

	} );

	const rig = ( scale, { outside = false } = {} ) => {

		const scene = new Group();
		const root = new Group();
		const mesh = new Mesh( new BoxGeometry(), new MeshBasicMaterial() );
		mesh.name = 'box';
		const lamp = new PointLight( 0xffffff, 0.5 );
		lamp.name = 'lamp';
		lamp.userData.__intensityScale = scale;
		root.add( mesh );
		( outside ? scene : root ).add( lamp );
		scene.add( root );
		return { scene, root, mesh, lamp };

	};

	it( 'scale a clip by the light it lands on in each load, the model root\'s or the scene\'s, sharing its other tracks', () => {

		const dim = new NumberKeyframeTrack( 'lamp.intensity', [ 0, 1 ], [ 2, 6 ] );
		const move = new VectorKeyframeTrack( 'box.position', [ 0, 1 ], [ 0, 0, 0, 1, 0, 0 ] );
		const clip = new AnimationClip( 'dim', 1, [ dim, move ] );
		for ( const scale of [ 0.25, 0.5 ] ) {

			const { scene, root, mesh, lamp } = rig( scale );
			const manager = new AnimationManager();
			manager.init( scene, root, [ mesh ], [ clip ] );
			manager.seekTo( 0.5 );
			expect( lamp.intensity ).toBe( 4 * scale );
			expect( manager.actions[ 0 ].getClip().tracks[ 1 ] ).toBe( move );

		}

		// A clip binding nothing under the model root plays against the scene's.
		const { scene, root, mesh, lamp } = rig( 0.25, { outside: true } );
		const manager = new AnimationManager();
		manager.init( scene, root, [ mesh ], [ new AnimationClip( 'dim', 1, [ dim ] ) ] );
		manager.seekTo( 0.5 );
		expect( lamp.intensity ).toBe( 1 );
		expect( Array.from( dim.values ) ).toEqual( [ 2, 6 ] );

	} );

	it( 'scale a Bezier intensity track\'s handles with its keys', () => {

		const track = new NumberKeyframeTrack( 'lamp.intensity', [ 0, 1 ], [ 2, 6 ], InterpolateBezier );
		track.settings = { inTangents: new Float32Array( [ - 0.3, 2, 0.7, 6 ] ), outTangents: new Float32Array( [ 0.3, 2, 1.3, 6 ] ) };
		const { scene, root, mesh, lamp } = rig( 0.25 );
		const manager = new AnimationManager();
		manager.init( scene, root, [ mesh ], [ new AnimationClip( 'dim', 1, [ track ] ) ] );
		const scaled = manager.actions[ 0 ].getClip().tracks[ 0 ];
		expect( Array.from( scaled.settings.inTangents ) ).toEqual( Array.from( new Float32Array( [ - 0.3, 0.5, 0.7, 1.5 ] ) ) );
		expect( Array.from( scaled.settings.outTangents ) ).toEqual( Array.from( new Float32Array( [ 0.3, 0.5, 1.3, 1.5 ] ) ) );
		manager.seekTo( 0.5 );
		expect( lamp.intensity ).toBeCloseTo( 1, 6 );

	} );

	it( 'leave a morphing clip\'s lights on its last pose when it stops, with the meshes', () => {

		const { scene, root, mesh, lamp } = rig( 1 );
		mesh.geometry.morphAttributes.position = [ new Float32BufferAttribute( mesh.geometry.attributes.position.array.slice(), 3 ) ];
		mesh.updateMorphTargets();
		const clip = new AnimationClip( 'pulse', 1, [
			new NumberKeyframeTrack( 'box.morphTargetInfluences[0]', [ 0, 1 ], [ 0, 1 ] ),
			new NumberKeyframeTrack( 'lamp.intensity', [ 0, 1 ], [ 2, 6 ] ),
		] );
		const manager = new AnimationManager();
		const poses = [];
		manager.applyPoseCallback = ( pose ) => poses.push( pose );
		manager.init( scene, root, [ mesh ], [ clip ] );
		manager.play( 0 );
		manager.seekTo( 0.5 );
		poses.length = 0;
		manager.stop();
		expect( lamp.intensity ).toBe( 0.5 );
		expect( poses ).toEqual( [] );

	} );

} );
