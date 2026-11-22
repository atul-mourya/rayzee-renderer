/**
 * A search standing in for the BVH walk (`SceneSearch`, the hardware search's seam) gives only distance, triangle,
 * placement and barycentrics; the walk's own code completes the record. A brute-force search over every triangle must
 * then trace as the walk does: the same triangle, distance, uv, normal and shadow answer.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { Fn, If, Loop, select, instanceIndex, instancedArray, storage, vec2, vec4, float, int, bool, cross, dot, abs, uintBitsToFloat } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { describeGPU, createRenderer } from './gpu.js';
import { BVHBuilder } from '@/core/bvh/BVHBuilder.js';
import { traverseBVH, traverseBVHShadow } from '@/core/shaders/BVHTraversal.js';
import { Ray } from '@/core/shaders/Struct.js';
import { withSceneResources } from '@/core/shaders/SceneResources.js';
import { triangleGeoRows, triangleRow } from '@/core/shaders/Common.js';
import { TRI_SIDE_SHIFT } from '@/core/scene/BufferLayout.js';
import { countDisagreements } from '@/core/shaders/kernels/SearchCheck.js';
import { ISSUE_CODES } from '@/core/EngineIssues.js';
import { nodePlatform } from '@/core/node/NodePlatform.js';
import { NodeWorker } from '@/core/node/NodeWorker.js';
import { configurePlatform } from '@/core/Platform.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { openHeadless } from '@/core/viewer/Headless.js';
import { Scene, Mesh, MeshStandardMaterial, BoxGeometry, SphereGeometry, PlaneGeometry, DirectionalLight } from 'three';

const LANES = 20;
const TRIANGLES = 2000;
const RAYS = 4096;
const SHADOW_DISTANCE = 25;

let seed = 11;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

function scene() {

	const data = new Uint32Array( TRIANGLES * LANES );
	const f = new Float32Array( data.buffer );
	for ( let i = 0; i < TRIANGLES; i ++ ) {

		const x = rand() * 20, y = rand() * 20, z = rand() * 20;
		f.set( [ x, y, z ], i * LANES );
		f.set( [ x + rand(), y + rand() * 0.2, z ], i * LANES + 4 );
		f.set( [ x, y + rand(), z + rand() ], i * LANES + 8 );
		for ( const lane of [ 3, 7, 11 ] ) data[ i * LANES + lane ] = ( rand() * 0xffffffff ) >>> 0;
		f.set( [ rand(), rand(), rand(), rand() ], i * LANES + 12 );
		f.set( [ rand(), rand() ], i * LANES + 16 );
		data[ i * LANES + 18 ] = ( 2 << TRI_SIDE_SHIFT ) | ( i % 7 );
		data[ i * LANES + 19 ] = i % 5;

	}

	const builder = new BVHBuilder();
	const bvh = builder.flattenBVH( builder.buildSync( data ) );
	return { bvh, triangles: builder.reorderedTriangleData };

}

function rays() {

	const origins = new Float32Array( RAYS * 4 ), dirs = new Float32Array( RAYS * 4 );
	for ( let i = 0; i < RAYS; i ++ ) {

		origins.set( [ rand() * 30 - 5, rand() * 30 - 5, - 10 ], i * 4 );
		const d = [ rand() - 0.5, rand() - 0.5, 1 ];
		const l = Math.hypot( ...d );
		dirs.set( d.map( v => v / l ), i * 4 );

	}

	return { origins, dirs };

}

// Every triangle, Möller–Trumbore, either side: the nearest within maxDistance (no triangle here blocks outright, so
// the shadow search's answer is the nearest too).
// hidden: mesh indices the walk passes (hidden meshes are skipped at their TLAS leaf)
const bruteForce = ( tris, count = TRIANGLES, hidden = [] ) => ( { origin, direction, maxDistance = float( 1e20 ) } ) => {

	const best = float( maxDistance ).toVar();
	const triangle = int( - 1 ).toVar();
	const barycentrics = vec2( 0.0 ).toVar();
	Loop( { start: int( 0 ), end: int( count ) }, ( { i } ) => {

		const [ a, b, c ] = triangleGeoRows( tris, i ).map( ( row ) => uintBitsToFloat( row.xyz ).toVar() );
		const e1 = b.sub( a ).toVar(), e2 = c.sub( a ).toVar();
		const p = cross( direction, e2 ).toVar();
		const det = dot( e1, p ).toVar();
		const mesh = int( triangleRow( tris, i, 4 ).w );
		const shown = hidden.reduce( ( ok, m ) => ok.and( mesh.notEqual( int( m ) ) ), abs( det ).greaterThan( 1e-12 ) );
		If( shown, () => {

			const s = origin.sub( a ).div( det ).toVar();
			const u = dot( s, p ).toVar();
			const q = cross( s, e1 ).toVar();
			const v = dot( direction, q ).toVar();
			const t = dot( e2, q ).toVar();
			If( u.greaterThanEqual( 0.0 ).and( v.greaterThanEqual( 0.0 ) ).and( u.add( v ).lessThanEqual( 1.0 ) ).and( t.greaterThan( 1e-6 ) ).and( t.lessThan( best ) ), () => {

				best.assign( t );
				triangle.assign( i );
				barycentrics.assign( vec2( u, v ) );

			} );

		} );

	} );

	// A miss reports distance 0, as the hardware does: the walk's record keeps its own.
	const didHit = triangle.greaterThanEqual( int( 0 ) );
	return { didHit, distance: select( didHit, best, float( 0 ) ), triangle, instanceLeaf: int( - 1 ), barycentrics };

};

async function trace( renderer, bvhNodes, triangles, { origins, dirs }, standIn ) {

	const bvh = storage( new StorageInstancedBufferAttribute( bvhNodes, 4 ), 'vec4', bvhNodes.length / 4 ).toReadOnly();
	const geo = new Uint32Array( TRIANGLES * 12 ), shade = new Uint32Array( TRIANGLES * 8 );
	for ( let i = 0; i < TRIANGLES; i ++ ) {

		geo.set( triangles.subarray( i * LANES, i * LANES + 12 ), i * 12 );
		shade.set( triangles.subarray( i * LANES + 12, i * LANES + 20 ), i * 8 );

	}

	const tris = {
		geo: storage( new StorageInstancedBufferAttribute( geo, 4 ), 'uvec4', TRIANGLES * 3 ).toReadOnly(),
		shade: storage( new StorageInstancedBufferAttribute( shade, 4 ), 'uvec4', TRIANGLES * 2 ).toReadOnly(),
	};

	const o = instancedArray( origins, 'vec4' ), d = instancedArray( dirs, 'vec4' );
	const out = instancedArray( RAYS * 3, 'vec4' );
	const never = () => ( { didHit: bool( false ), distance: float( 1e20 ), triangle: int( - 1 ), instanceLeaf: int( - 1 ), barycentrics: vec2( 0.0 ) } );
	const search = standIn === 'never' ? { closestHit: never, shadowHit: never }
		: standIn ? { closestHit: bruteForce( tris ), shadowHit: bruteForce( tris ) } : null;
	const kernel = withSceneResources( Fn( () => {

		const ray = Ray( { origin: o.element( instanceIndex ).xyz, direction: d.element( instanceIndex ).xyz } );
		const hit = traverseBVH( ray, bvh, tris, bool( false ), bool( true ) ).toVar();
		const shadow = traverseBVHShadow( ray, bvh, tris, float( SHADOW_DISTANCE ) ).toVar();
		const at = instanceIndex.mul( 3 );
		out.element( at ).assign( vec4( hit.get( 'dst' ), float( hit.get( 'triangleIndex' ) ), float( hit.get( 'materialIndex' ) ), float( hit.get( 'meshIndex' ) ) ) );
		out.element( at.add( 1 ) ).assign( vec4( hit.get( 'normal' ), hit.get( 'uv' ).x ) );
		out.element( at.add( 2 ) ).assign( vec4( hit.get( 'uv' ).y, float( shadow.get( 'didHit' ) ), shadow.get( 'dst' ), float( shadow.get( 'triangleIndex' ) ) ) );

	} )(), { alphaShadows: null, search } ).compute( RAYS );

	await renderer.computeAsync( kernel );
	return new Float32Array( await renderer.getArrayBufferAsync( out.value ) );

}

describeGPU( 'a search standing in for the BVH walk', () => {

	let renderer, walk, standIn, never;

	beforeAll( async () => {

		renderer = await createRenderer();
		const { bvh, triangles } = scene();
		const light = rays();
		walk = await trace( renderer, bvh, triangles, light, false );
		standIn = await trace( renderer, bvh, triangles, light, true );
		never = await trace( renderer, bvh, triangles, light, 'never' );

	} );

	afterAll( () => renderer?.dispose() );

	it( 'is what the kernel searches with', () => {

		for ( let r = 0; r < RAYS; r ++ ) {

			expect( never[ r * 12 ] ).toBeGreaterThanOrEqual( 1e19 );
			expect( never[ r * 12 + 9 ] ).toBe( 0 );

		}

	} );

	it( 'completes its hits into the walk\'s records', () => {

		let hits = 0, shadowed = 0, sameTriangle = 0;
		for ( let r = 0; r < RAYS; r ++ ) {

			const w = walk.subarray( r * 12, r * 12 + 12 ), s = standIn.subarray( r * 12, r * 12 + 12 );
			if ( w[ 0 ] < 1e19 ) hits ++;
			if ( w[ 9 ] > 0.5 ) shadowed ++;
			expect( s[ 9 ], `ray ${r} shadow` ).toBe( w[ 9 ] );
			if ( w[ 0 ] >= 1e19 ) {

				expect( s[ 0 ], `ray ${r} misses` ).toBeGreaterThanOrEqual( 1e19 );
				continue;

			}

			expect( Math.abs( s[ 0 ] - w[ 0 ] ), `ray ${r} distance` ).toBeLessThan( 1e-4 * w[ 0 ] );
			if ( s[ 1 ] !== w[ 1 ] ) continue; // two triangles at one distance
			sameTriangle ++;
			// material, mesh, normal, uv: the walk's own completion, from barycentrics found another way
			expect( s[ 2 ] ).toBe( w[ 2 ] );
			expect( s[ 3 ] ).toBe( w[ 3 ] );
			for ( const k of [ 4, 5, 6, 7, 8 ] ) expect( Math.abs( s[ k ] - w[ k ] ), `ray ${r} lane ${k}` ).toBeLessThan( 1e-4 );

		}

		expect( hits ).toBeGreaterThan( RAYS * 0.15 );
		expect( shadowed ).toBeGreaterThan( RAYS * 0.1 );
		expect( sameTriangle ).toBeGreaterThan( hits * 0.999 );

	} );

} );

const ROOT = new URL( '../../', import.meta.url );

// Vitest hands the engine's `?worker&inline` imports a dev-server path; run that file in a thread instead.
class SourceWorker extends NodeWorker {

	constructor( url, options ) {

		const file = new URL( String( url ).replace( /^\//, '' ).split( '?' )[ 0 ], ROOT );
		super( `data:text/javascript,${ encodeURIComponent( `import ${ JSON.stringify( file.href ) };` ) }`, options );

	}

}

it( 'counts the rays two searches answer differently', () => {

	// per ray: camera distance, triangle, bounce distance, triangle, shadow, 3 unused
	const ray = ( ...v ) => [ ...v, 0, 0, 0 ];
	const walk = new Float32Array( [ ray( 2, 5, 1e20, - 1, 0 ), ray( 2, 5, 3, 7, 1 ), ray( 1e20, - 1, - 1, - 1, - 1 ), ray( 4, 1, 1e20, - 1, 0 ) ].flat() );
	const same = new Float32Array( [ ray( 2, 5, 1e20, - 1, 0 ), ray( 2.0000001, 6, 3, 7, 1 ), ray( 1e20, - 1, - 1, - 1, - 1 ), ray( 4, 1, 1e20, - 1, 0 ) ].flat() );
	expect( countDisagreements( walk, same, 4 ) ).toBe( 0 ); // another triangle at the same distance agrees
	const other = new Float32Array( [ ray( 2, 6, 1e20, - 1, 0 ), ray( 2, 5, 1e20, - 1, 1 ), ray( 1e20, - 1, - 1, - 1, - 1 ), ray( 4, 1, 1e20, - 1, 1 ) ].flat() );
	expect( countDisagreements( walk, other, 4 ) ).toBe( 2 ); // a nearer miss on the bounce, a shadow answer
	// a bounce hit at its start is rounding's: another triangle there, or the miss beyond, agrees within lane 5's zone
	const near = new Float32Array( [ 3, 1, 0.0005, 9, 1, 0.001, 0, 0 ] );
	expect( countDisagreements( near, new Float32Array( [ 3, 1, 2, 8, 1, 0, 0, 0 ] ), 1 ) ).toBe( 0 );
	expect( countDisagreements( new Float32Array( [ 3, 1, 0.5, 9, 1, 0.001, 0, 0 ] ), new Float32Array( [ 3, 1, 2, 8, 1, 0, 0, 0 ] ), 1 ) ).toBe( 1 );
	// a camera hit on a silhouette (lane 6) is either search's to keep
	expect( countDisagreements( new Float32Array( [ 3, 1, 2, 8, 1, 0, 0, 0 ] ), new Float32Array( [ 2, 5, 2, 8, 1, 0, 1, 0 ] ), 1 ) ).toBe( 0 );
	expect( countDisagreements( new Float32Array( [ 3, 1, 2, 8, 1, 0, 0, 0 ] ), new Float32Array( [ 2, 5, 2, 8, 1, 0, 0, 0 ] ), 1 ) ).toBe( 1 );

} );

describeGPU( 'a search in the path tracer', () => {

	let app, plain, triangles;
	const render = async () => {

		await app.renderFrames( 4 );
		return ( await app.renderToBuffer( { colorSpace: 'linear' } ) ).data.slice();

	};

	const settle = async () => {

		const pt = app.stages.pathTracer;
		while ( pt.readbackWait() ) await pt.readbackWait();

	};

	beforeAll( async () => {

		configurePlatform( { ...nodePlatform(), Worker: SourceWorker } );
		configureAssets( { oidnWeightsBaseUrl: new URL( 'tests/__nothing__/', ROOT ).href } );
		app = await openHeadless( { width: 32, height: 32, strict: false } );
		const floor = new Mesh( new PlaneGeometry( 8, 8 ), new MeshStandardMaterial() );
		floor.rotation.x = - Math.PI / 2;
		const box = new Mesh( new BoxGeometry( 1, 1, 1 ), new MeshStandardMaterial( { color: 0xff8040 } ) );
		box.position.set( - 1, 0.5, 0 );
		const ball = new Mesh( new SphereGeometry( 0.6, 24, 12 ), new MeshStandardMaterial( { color: 0x4080ff } ) );
		ball.position.set( 1, 0.6, 0 );
		await app.loadObject3D( new Scene().add( floor, box, ball, new DirectionalLight( 0xffffff, 3 ) ), 'search' );
		app.camera.position.set( 0, 2.5, 4 );
		app.camera.lookAt( 0, 0.4, 0 );
		app.camera.updateMatrixWorld( true );
		app.cameraManager?.controls?.target.set( 0, 0.4, 0 );
		app.cameraManager?.controls?.update();
		triangles = app.stages.pathTracer.triangleCount;
		plain = await render();

	} );

	afterAll( () => app?.dispose() );

	it( 'keeps a search that agrees with the walk', async () => {

		const pt = app.stages.pathTracer;
		const { triangles: tris } = pt.sceneStorageNodes();
		const hidden = app.sceneMeshes.map( ( m, i ) => {

			let shown = true;
			m.traverseAncestors( ( a ) => shown &&= a.visible );
			return m.visible && shown ? - 1 : i;

		} ).filter( ( i ) => i >= 0 );
		const search = { closestHit: bruteForce( tris, triangles, hidden ), shadowHit: bruteForce( tris, triangles, hidden ) };
		app.clearIssues();
		pt.setSceneSearch( search );
		await settle();
		expect( pt._search ).toBe( search );
		expect( app.issues.filter( ( i ) => i.code === ISSUE_CODES.SEARCH_DISAGREES ) ).toEqual( [] );
		const image = await render();
		let sum = 0, sumPlain = 0;
		for ( let i = 0; i < image.length; i ++ ) if ( i % 4 !== 3 ) {

			sum += image[ i ];
			sumPlain += plain[ i ];

		}

		expect( Math.abs( sum / sumPlain - 1 ) ).toBeLessThan( 0.02 );
		pt.setSceneSearch( null );
		await settle();

	} );

	it( 'drops a search that disagrees, and renders with the walk', async () => {

		const pt = app.stages.pathTracer;
		const never = () => ( { didHit: bool( false ), distance: float( 1e20 ), triangle: int( - 1 ), instanceLeaf: int( - 1 ), barycentrics: vec2( 0.0 ) } );
		app.clearIssues();
		pt.setSceneSearch( { closestHit: never, shadowHit: never } );
		await settle();
		expect( pt._search ).toBe( null );
		const issue = app.issues.find( ( i ) => i.code === ISSUE_CODES.SEARCH_DISAGREES );
		expect( issue?.severity ).toBe( 'warning' );
		expect( issue.detail.disagreement ).toBeGreaterThan( 0.5 );
		expect( Array.from( await render() ) ).toEqual( Array.from( plain ) );

	} );

} );
