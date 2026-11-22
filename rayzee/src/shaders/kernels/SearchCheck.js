import { Fn, instanceIndex, instancedArray, If, float, vec3, vec4, bool, dot, select, abs, max } from 'three/tsl';
import { Vector3, Matrix4 } from 'three';
import { projectionInverseOf } from '../../scene/ViewCamera.js';
import { Ray, HitInfo } from '../Struct.js';
import { traverseBVH, traverseBVHShadow } from '../BVHTraversal.js';
import { offsetRayOrigin } from '../Common.js';
import { windingNormal } from '../HitFacet.js';
import { KernelManager } from '../../pathtracer/KernelManager.js';
import { withSceneResources } from '../SceneResources.js';

/** Rays a check traces both ways: a 64² grid of camera rays, a bounce from each hit and a shadow ray along it. */
const SEARCH_CHECK_RAYS = 4096;
/** Past this share of rays answered differently, a search is not used. */
export const MAX_SEARCH_DISAGREEMENT = 0.001;

/**
 * A search standing in for the BVH walk (`SceneSearch`, SceneResources.js) traced against the walk before it is used:
 * camera rays, then from where the walk's camera ray lands a bounce (either side) and a shadow ray, the same rays both
 * ways. Hits agree on the triangle, or on the distance where two triangles meet. Built and freed per check.
 *
 * @param {import('../../pathtracer/PathTracer.js').PathTracer} stage - its scene and camera
 * @param {Object} resources - the scene resources its kernels are built with, without a search
 * @param {import('../SceneResources.js').SceneSearch} search
 * @returns {Promise<?{ rays: number, disagree: number, disagreement: number }>} null before a scene is built
 */
export async function checkSceneSearch( stage, resources, search, rays = SEARCH_CHECK_RAYS ) {

	const nodes = stage.sceneStorageNodes?.();
	if ( ! nodes ) return null;

	const { primary, bounce } = checkRays( stage, rays );
	const primaryRays = instancedArray( primary, 'vec4' );
	const bounceDirections = instancedArray( bounce, 'vec4' );
	const traced = instancedArray( rays * 2, 'vec4' ); // the walk's bounce: origin + valid, direction + shadow length
	const answers = [ instancedArray( rays * 2, 'vec4' ), instancedArray( rays * 2, 'vec4' ) ];
	const kernels = [
		withSceneResources( walkKernel( nodes, primaryRays, bounceDirections, traced, answers[ 0 ] ), { ...resources, search: null } ),
		withSceneResources( searchKernel( nodes, primaryRays, traced, answers[ 1 ] ), { ...resources, search } ),
	].map( ( kernel ) => kernel.compute( rays ) );

	const renderer = stage.renderer;
	try {

		for ( const kernel of kernels ) {

			if ( KernelManager.canCompileInBackground ) await renderer.compileComputeAsync( kernel );
			renderer.compute( kernel );

		}

		const [ walk, other ] = await Promise.all( answers.map( async ( a ) => new Float32Array( await renderer.getArrayBufferAsync( a.value ) ) ) );
		const disagree = countDisagreements( walk, other, rays );
		return { rays, disagree, disagreement: disagree / rays };

	} finally {

		for ( const kernel of kernels ) kernel.dispose();
		for ( const buffer of [ primaryRays, bounceDirections, traced, ...answers ] ) buffer.value.dispose?.();

	}

}

// Camera rays through a jittered grid (origin + 0, direction + 0) and a random direction a ray for its bounce.
function checkRays( stage, rays ) {

	const side = Math.ceil( Math.sqrt( rays ) );
	// From the camera itself: its uniforms are written at the first frame, which the check comes before.
	const camera = stage.camera;
	camera.updateMatrixWorld();
	const toWorld = camera.matrixWorld;
	const fromClip = projectionInverseOf( camera, new Matrix4() );
	const near = new Vector3(), far = new Vector3();
	const primary = new Float32Array( rays * 8 ), bounce = new Float32Array( rays * 4 );
	let seed = 0x2545f491;
	const random = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 4294967296 );
	for ( let i = 0; i < rays; i ++ ) {

		const x = ( ( i % side ) + random() ) / side * 2 - 1, y = ( Math.floor( i / side ) + random() ) / side * 2 - 1;
		near.set( x, y, - 1 ).applyMatrix4( fromClip ).applyMatrix4( toWorld );
		far.set( x, y, 1 ).applyMatrix4( fromClip ).applyMatrix4( toWorld ).sub( near ).normalize();
		primary.set( [ near.x, near.y, near.z, 0, far.x, far.y, far.z, 0 ], i * 8 );
		const z = random() * 2 - 1, a = random() * Math.PI * 2, r = Math.sqrt( 1 - z * z );
		bounce.set( [ r * Math.cos( a ), r * Math.sin( a ), z, 0 ], i * 4 );

	}

	return { primary, bounce };

}

const answer = ( hit ) => [ hit.get( 'dst' ), float( hit.get( 'triangleIndex' ) ) ];

// 1 where a camera hit's winding and interpolated normal face the ray differently: culling by either is right there.
const silhouette = ( hit, direction, bvh, triangles ) => select( hit.didHit.and(
	dot( windingNormal( triangles, bvh, hit.triangleIndex, hit.instanceLeaf ), direction ).lessThan( 0.0 )
		.notEqual( dot( hit.normal, direction ).lessThan( 0.0 ) ) ), float( 1 ), float( 0 ) );

// The walk: camera ray (culled as Extend culls it), then the bounce and shadow rays it hands the search.
const walkKernel = ( { bvh, triangles }, primaryRays, bounceDirections, traced, out ) => Fn( () => {

	const origin = primaryRays.element( instanceIndex.mul( 2 ) ).xyz;
	const direction = primaryRays.element( instanceIndex.mul( 2 ).add( 1 ) ).xyz;
	const camera = HitInfo.wrap( traverseBVH( Ray( { origin, direction } ), bvh, triangles, bool( false ), bool( true ) ) ).toVar();
	const [ cameraDistance, cameraTriangle ] = answer( camera );
	const at = instanceIndex.mul( 2 );
	out.element( at ).assign( vec4( cameraDistance, cameraTriangle, - 1, - 1 ) );
	out.element( at.add( 1 ) ).assign( vec4( - 1, 0, silhouette( camera, direction, bvh, triangles ), 0 ) );
	traced.element( at ).assign( vec4( 0.0 ) );
	If( camera.didHit, () => {

		// As Shade leaves a surface: off the triangle's own plane, on the side the ray came from.
		const facet = windingNormal( triangles, bvh, camera.triangleIndex, camera.instanceLeaf ).toVar();
		const facing = select( dot( facet, direction ).lessThan( 0.0 ), facet, facet.negate() ).toVar();
		const d = bounceDirections.element( instanceIndex ).xyz;
		const bounceDirection = select( dot( d, facing ).lessThan( 0.0 ), d.negate(), d ).toVar();
		const bounceOrigin = offsetRayOrigin( camera.hitPoint, facing ).toVar();
		const shadowLength = camera.dst.max( 1e-3 );
		traced.element( at ).assign( vec4( bounceOrigin, 1.0 ) );
		traced.element( at.add( 1 ) ).assign( vec4( bounceDirection, shadowLength ) );
		const ray = Ray( { origin: bounceOrigin, direction: bounceDirection } );
		const bounceHit = HitInfo.wrap( traverseBVH( ray, bvh, triangles, bool( false ), bool( false ) ) ).toVar();
		const shadow = HitInfo.wrap( traverseBVHShadow( ray, bvh, triangles, shadowLength ) ).toVar();
		const [ bounceDistance, bounceTriangle ] = answer( bounceHit );
		out.element( at ).assign( vec4( cameraDistance, cameraTriangle, bounceDistance, bounceTriangle ) );
		// Where a bounce's hits are rounding's to decide (an edge, its own triangle again): 1e-3 of the origin's scale.
		const o = abs( bounceOrigin );
		out.element( at.add( 1 ) ).assign( vec4( float( shadow.didHit ), max( 1.0, max( o.x, max( o.y, o.z ) ) ).mul( 1e-3 ), silhouette( camera, direction, bvh, triangles ), 0.0 ) );

	} );

} )();

// The search, on the same rays.
const searchKernel = ( { bvh, triangles }, primaryRays, traced, out ) => Fn( () => {

	const origin = primaryRays.element( instanceIndex.mul( 2 ) ).xyz;
	const direction = primaryRays.element( instanceIndex.mul( 2 ).add( 1 ) ).xyz;
	const camera = HitInfo.wrap( traverseBVH( Ray( { origin, direction } ), bvh, triangles, bool( false ), bool( true ) ) ).toVar();
	const [ cameraDistance, cameraTriangle ] = answer( camera );
	const at = instanceIndex.mul( 2 );
	const edge = silhouette( camera, direction, bvh, triangles );
	out.element( at ).assign( vec4( cameraDistance, cameraTriangle, - 1, - 1 ) );
	out.element( at.add( 1 ) ).assign( vec4( - 1, 0, edge, 0 ) );
	const bounceOrigin = traced.element( at ).toVar();
	If( bounceOrigin.w.greaterThan( 0.5 ), () => {

		const bounce = traced.element( at.add( 1 ) ).toVar();
		const ray = Ray( { origin: vec3( bounceOrigin.xyz ), direction: vec3( bounce.xyz ) } );
		const bounceHit = HitInfo.wrap( traverseBVH( ray, bvh, triangles, bool( false ), bool( false ) ) ).toVar();
		const shadow = HitInfo.wrap( traverseBVHShadow( ray, bvh, triangles, bounce.w ) ).toVar();
		const [ bounceDistance, bounceTriangle ] = answer( bounceHit );
		out.element( at ).assign( vec4( cameraDistance, cameraTriangle, bounceDistance, bounceTriangle ) );
		out.element( at.add( 1 ) ).assign( vec4( float( shadow.didHit ), 0.0, edge, 0.0 ) );

	} );

} )();

const MISS = 1e19;
const sameHit = ( t0, tri0, t1, tri1, near = 0 ) => ( t0 >= MISS && t1 >= MISS ) || Math.min( t0, t1 ) < near
	|| ( t0 < MISS && t1 < MISS && ( tri0 === tri1 || Math.abs( t0 - t1 ) <= 1e-4 * Math.max( 1, t0 ) ) );

/**
 * Rays whose camera hit, bounce hit or shadow answer differ; a bounce either search hits within `near` of its start
 * (lane 5) agrees, rounding's to decide, and a camera hit either search marks a silhouette (lane 6) agrees: culling by
 * winding and by the interpolated normal part there. @private (exported for tests)
 */
export function countDisagreements( walk, other, rays ) {

	let disagree = 0;
	for ( let i = 0; i < rays; i ++ ) {

		const w = i * 8;
		const silhouette = walk[ w + 6 ] === 1 || other[ w + 6 ] === 1;
		const differs = ! ( silhouette || sameHit( walk[ w ], walk[ w + 1 ], other[ w ], other[ w + 1 ] ) )
			|| ! sameHit( walk[ w + 2 ], walk[ w + 3 ], other[ w + 2 ], other[ w + 3 ], walk[ w + 5 ] )
			|| walk[ w + 4 ] !== other[ w + 4 ];
		if ( differs ) disagree ++;

	}

	return disagree;

}
