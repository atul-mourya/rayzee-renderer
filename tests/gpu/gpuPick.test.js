/**
 * A GPU pick traces the rendered BVH: over a grid of rays it finds the object (and InstancedMesh copy) and distance
 * three's raycast finds among the visible meshes; a hidden mesh in front, which three's raycast still hits, it passes.
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { Scene, Mesh, InstancedMesh, BoxGeometry, SphereGeometry, PlaneGeometry, MeshPhysicalMaterial, Matrix4, Vector3, Raycaster, FrontSide } from 'three';
import { describeGPU } from './gpu.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { openHeadless } from '@/core/viewer/Headless.js';

const ROOT = new URL( '../../', import.meta.url );

class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

const material = ( name ) => new MeshPhysicalMaterial( { name, roughness: 0.5 } );

describeGPU( 'GPU picking', () => {

	let app;

	beforeAll( async () => {

		configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
		configureAssets( { oidnWeightsBaseUrl: new URL( 'tests/__nothing__/', ROOT ).href } );
		app = await openHeadless( { width: 32, height: 32, strict: false } );

		const floor = new Mesh( new PlaneGeometry( 12, 12 ), material( 'floor' ) );
		floor.name = 'floor';
		floor.rotation.x = - Math.PI / 2;
		const box = new Mesh( new BoxGeometry( 1, 1, 1 ), material( 'box' ) );
		box.name = 'box';
		box.position.set( - 1.6, 0.5, 0 );
		const ball = new Mesh( new SphereGeometry( 0.5, 24, 12 ), material( 'ball' ) );
		ball.name = 'ball';
		ball.position.set( 1.6, 0.5, 0 );

		// One geometry and material on two meshes: stored once, in object space, behind a leaf each.
		const shared = new BoxGeometry( 0.6, 0.6, 0.6 ), twinMaterial = material( 'twin' );
		const twinA = new Mesh( shared, twinMaterial );
		twinA.name = 'twinA';
		twinA.position.set( - 0.5, 0.3, 1.2 );
		twinA.rotation.y = 0.4;
		const twinB = new Mesh( shared, twinMaterial );
		twinB.name = 'twinB';
		twinB.position.set( 0.5, 0.3, 1.2 );
		twinB.scale.setScalar( 1.3 );

		// Tall, behind the rest: in view above it.
		const crowd = new InstancedMesh( new BoxGeometry( 0.4, 1.8, 0.4 ), material( 'crowd' ), 3 );
		crowd.name = 'crowd';
		for ( let i = 0; i < 3; i ++ ) crowd.setMatrixAt( i, new Matrix4().makeTranslation( - 0.9 + i * 0.9, 0.9, - 2.5 ) );

		// In front of the box, hidden: the render looks through it.
		const ghost = new Mesh( new BoxGeometry( 0.8, 0.8, 0.2 ), material( 'ghost' ) );
		ghost.name = 'ghost';
		ghost.position.set( - 1.6, 0.5, 1 );
		ghost.visible = false;

		// One-sided and turned away from the camera: culled for camera rays by both.
		const away = new Mesh( new PlaneGeometry( 0.8, 0.8 ), Object.assign( material( 'away' ), { side: FrontSide } ) );
		away.name = 'away';
		away.position.set( 1.6, 0.6, 1.6 );
		away.rotation.y = Math.PI;

		await app.loadObject3D( new Scene().add( floor, box, ball, twinA, twinB, crowd, ghost, away ), 'pick' );
		app.updateAllMeshVisibility();
		app.camera.position.set( 0, 2.2, 6 );
		app.camera.lookAt( 0, 0.4, 0 );
		app.camera.updateMatrixWorld();
		await app.renderFrames( 1 );

	}, 60000 );

	afterAll( () => app?.dispose() );

	// three's raycast over the same scene, hidden meshes left out as the render leaves them out.
	function reference( x, y ) {

		const raycaster = new Raycaster();
		raycaster.setFromCamera( { x, y }, app.camera );
		const visible = ( o ) => {

			for ( let n = o; n; n = n.parent ) if ( ! n.visible ) return false;
			return true;

		};

		return raycaster.intersectObjects( app.meshScene.children, true ).find( h => h.object.isMesh && visible( h.object ) && h.object !== app.assetLoader.floorPlane ) ?? null;

	}

	it( 'finds what three\'s raycast finds among visible meshes: object, copy and distance', async () => {

		const seen = new Set();
		let rays = 0;
		for ( let y = - 0.9; y <= 0.9; y += 0.08 ) for ( let x = - 0.9; x <= 0.9; x += 0.08 ) {

			const want = reference( x, y );
			const got = await app.interactionManager.pickSurfaceAsync( x, y, { anySurface: true } );
			rays ++;
			if ( ! want ) {

				expect( got ).toBe( null );
				continue;

			}

			expect( got, `ray ${x.toFixed( 2 )}, ${y.toFixed( 2 )}` ).not.toBe( null );
			expect( got.object?.name ).toBe( want.object.name );
			if ( want.instanceId !== undefined ) expect( got.instanceId ).toBe( want.instanceId );
			expect( Math.abs( got.distance - want.distance ) ).toBeLessThan( 1e-3 * want.distance );
			seen.add( want.object.name + ( want.instanceId ?? '' ) );

		}

		expect( rays ).toBeGreaterThan( 200 );
		for ( const name of [ 'floor', 'box', 'ball', 'twinA', 'twinB', 'crowd0', 'crowd1', 'crowd2' ] ) expect( seen ).toContain( name );
		expect( seen ).not.toContain( 'ghost' );

	} );

	it( 'sees through a hidden mesh, which the CPU pick still returns, and selects a copy as the CPU pick does', async () => {

		const at = new Vector3( - 1.6, 0.5, 0.5 ).project( app.camera );
		expect( app.interactionManager.pickSurface( at.x, at.y )?.object.name ).toBe( 'ghost' );
		expect( ( await app.interactionManager.pickSurfaceAsync( at.x, at.y ) ).object.name ).toBe( 'box' );

		const copy = new Vector3( 0.9, 1.6, - 2.3 ).project( app.camera );
		expect( app.interactionManager.pickSurface( copy.x, copy.y )?.object.name ).toBe( 'crowd' );
		expect( await app.interactionManager.pickSurfaceAsync( copy.x, copy.y ) ).toMatchObject( { object: { name: 'crowd' }, instanceId: 2 } );

	} );

} );
