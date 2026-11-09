/**
 * Disposing an animation with three's real mixer: every node it moved is back where it started, and many animated
 * nodes take no time (three's uncacheRoot recounted every remaining binding at each removal).
 */
import { describe, it, expect } from 'vitest';
import { AnimationClip, BoxGeometry, Group, Mesh, VectorKeyframeTrack } from 'three';
import { AnimationManager } from '@/core/viewer/animation/AnimationManager.js';

describe( 'disposing an animation', () => {

	it( 'puts every animated node back and takes no time over thousands of them', () => {

		const COUNT = 6000;
		const root = new Group();
		const geometry = new BoxGeometry();
		const meshes = Array.from( { length: COUNT }, ( _, i ) => {

			const mesh = new Mesh( geometry );
			mesh.name = `m${i}`;
			mesh.position.set( i, 0, 0 );
			root.add( mesh );
			return mesh;

		} );
		const tracks = meshes.map( ( m, i ) => new VectorKeyframeTrack( `${m.name}.position`, [ 0, 1 ], [ i, 0, 0, i, 5, 0 ] ) );
		const manager = new AnimationManager();
		manager.init( root, root, meshes, [ new AnimationClip( 'move', 1, tracks ) ] );
		manager.play( 0 );
		manager.mixer.update( 0.5 );
		expect( meshes[ 7 ].position.y ).toBeCloseTo( 2.5 );
		// Paused where it stands: still a moved pose for dispose to undo.
		manager.mixer.timeScale = 0;
		manager.mixer.update( 0.5 );
		expect( meshes[ 7 ].position.y ).toBeCloseTo( 2.5 );

		const t = performance.now();
		manager.dispose();
		const ms = performance.now() - t;
		expect( meshes.every( ( m, i ) => m.position.x === i && m.position.y === 0 ) ).toBe( true );
		expect( manager.mixer ).toBeNull();
		expect( ms ).toBeLessThan( 250 );

	} );

} );
