/**
 * getSceneObject() resolves the id returned by addModel/addModelFromObject3D to the root the
 * engine renders for it — for an appended Object3D that is the engine's copy, not the caller's.
 * Called off the prototype so the test needs no GPU-backed instance.
 */
import { describe, expect, it } from 'vitest';
import { Group, Scene } from 'three';
import { PathTracerApp } from '@/core/PathTracerApp.js';

const getSceneObject = ( meshScene, id ) =>
	PathTracerApp.prototype.getSceneObject.call( { meshScene }, id );

describe( 'PathTracerApp.getSceneObject', () => {

	it( 'returns the tagged root for its id', () => {

		const meshScene = new Scene();
		const root = new Group();
		root.userData.__rayzeeSceneObject = true;
		meshScene.add( root );

		expect( getSceneObject( meshScene, root.uuid ) ).toBe( root );

	} );

	it( 'ignores untagged roots such as the built-in ground plane', () => {

		const meshScene = new Scene();
		const ground = new Group();
		meshScene.add( ground );

		expect( getSceneObject( meshScene, ground.uuid ) ).toBe( null );

	} );

	it( 'returns null for an unknown id, and with no scene', () => {

		expect( getSceneObject( new Scene(), 'nope' ) ).toBe( null );
		expect( getSceneObject( null, 'nope' ) ).toBe( null );

	} );

} );
