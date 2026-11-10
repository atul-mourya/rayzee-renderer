import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, AnimationClip, VectorKeyframeTrack, BooleanKeyframeTrack, PropertyBinding } from 'three';
import { AnimationManager } from '@/core/viewer/animation/AnimationManager.js';

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
