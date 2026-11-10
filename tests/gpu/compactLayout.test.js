import { it, expect, beforeAll, afterAll } from 'vitest';
import { Scene, Mesh, InstancedMesh, Matrix4, PlaneGeometry, BoxGeometry, SphereGeometry, MeshPhysicalMaterial, Color } from 'three';
import { describeGPU } from './gpu.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { openHeadless } from '@/core/viewer/Headless.js';

const ROOT = new URL( '../../', import.meta.url );
const SIZE = 48;

// Vitest hands the engine's `?worker&inline` imports a dev-server path; run that file in a thread instead.
class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

// A floor, two balls of many triangles (trees with inner nodes to collapse) and a row of copies.
function scene() {

	const material = ( hex ) => new MeshPhysicalMaterial( { color: new Color( hex ), roughness: 0.6 } );
	const floor = new Mesh( new PlaneGeometry( 8, 8 ), material( 0xbbbbbb ) );
	floor.rotation.x = - Math.PI / 2;
	floor.name = 'floor';
	const ball = new Mesh( new SphereGeometry( 0.8, 64, 48 ), material( 0xcc4422 ) );
	ball.position.set( - 1, 0.8, 0 );
	ball.name = 'ball';
	const other = new Mesh( new SphereGeometry( 0.5, 48, 32 ), material( 0x2266cc ) );
	other.position.set( 1.2, 0.5, 0.6 );
	other.name = 'other';
	const copies = new InstancedMesh( new BoxGeometry( 0.25, 0.25, 0.25 ), material( 0x33aa55 ), 40 );
	for ( let i = 0; i < 40; i ++ ) copies.setMatrixAt( i, new Matrix4().makeRotationY( i * 0.3 ).setPosition( ( i % 10 ) * 0.5 - 2.25, 0.125, Math.floor( i / 10 ) * 0.5 - 2 ) );
	copies.name = 'copies';
	return new Scene().add( floor, ball, other, copies );

}

describeGPU( 'a scene loaded in the compact layout', () => {

	let app;

	beforeAll( async () => {

		configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
		app = await openHeadless( { width: SIZE, height: SIZE, strict: false } );
		app.environmentManager.params.solidSkyColor.setRGB( 1, 1, 1 );
		await app.environmentManager.setMode( 'color' );

	}, 60000 );

	afterAll( () => app?.dispose() );

	// Past the in-memory line or not, as the load's survey says.
	const load = async ( large ) => {

		app._sdf.needsSpill = () => large;
		await app.loadObject3D( scene(), 'compact' );
		app.camera.position.set( 0, 3, 5 );
		app.camera.lookAt( 0, 0.5, 0 );
		expect( app.stages.pathTracer.compactLayout ).toBe( large );

	};

	const render = async () => {

		await app.renderFrames( 4 );
		return ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data.slice();

	};

	const hide = ( name ) => {

		app.sceneMeshes.find( ( m ) => m.name === name ).visible = false;
		app.updateAllMeshVisibility();

	};

	const move = async ( name ) => {

		const index = app.sceneMeshes.findIndex( ( m ) => m.name === name );
		app.sceneMeshes[ index ].position.x -= 1.5;
		app.sceneMeshes[ index ].updateMatrixWorld();
		await app.updateMeshTransforms( [ index ] );

	};

	// Pixels further apart than a sample's noise could explain; the trees differ only in ties.
	const differing = ( a, b ) => {

		let n = 0;
		for ( let i = 0; i < a.length; i += 4 ) if ( Math.abs( a[ i ] - b[ i ] ) + Math.abs( a[ i + 1 ] - b[ i + 1 ] ) + Math.abs( a[ i + 2 ] - b[ i + 2 ] ) > 1e-3 ) n ++;
		return n;

	};

	it( 'renders as the plain layout, hides and moves what it is told to, and refuses a refit', async () => {

		await load( false );
		const plain = await render();
		hide( 'ball' );
		const plainHidden = await render();
		await move( 'other' );
		const plainMoved = await render();

		await load( true );
		const stage = app.stages.pathTracer;
		expect( stage._geoParts ).toBe( null );
		expect( stage._clusterParts?.attrs.length ).toBeGreaterThan( 0 );
		expect( stage.wideBVHStats.objectNodes ).toBeLessThan( ( stage.wideBVHStats.binaryNodes - stage.wideBVHStats.topNodes ) * 0.7 );
		expect( stage.triangleClusterStats.corners ).toBeLessThan( stage.triangleClusterStats.triangles );

		const packed = await render();
		expect( differing( packed, plain ) ).toBeLessThan( SIZE * SIZE * 0.002 );
		expect( differing( packed, plainHidden ) ).toBeGreaterThan( SIZE * SIZE * 0.02 );

		hide( 'ball' );
		expect( differing( await render(), plainHidden ) ).toBeLessThan( SIZE * SIZE * 0.002 );
		await move( 'other' );
		const moved = await render();
		expect( differing( moved, plainHidden ) ).toBeGreaterThan( SIZE * SIZE * 0.01 );
		expect( differing( moved, plainMoved ) ).toBeLessThan( SIZE * SIZE * 0.002 );

		const ball = app.sceneMeshes.findIndex( ( m ) => m.name === 'ball' );
		expect( () => app.refitBLASes( [ ball ], () => new Float32Array( 9 ) ) ).toThrow( /static/ );
		await expect( app.refitBVH( () => null ) ).rejects.toThrow( /static/ );

	}, 120000 );

	it( 'loads the next scene plain again', async () => {

		await load( true );
		await load( false );
		const stage = app.stages.pathTracer;
		expect( stage._clusterParts ).toBe( null );
		expect( stage._wideBuilt ).toBe( false );
		expect( stage._geoParts ).not.toBe( null );
		await render();

	}, 120000 );

} );
