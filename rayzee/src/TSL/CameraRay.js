/**
 * CameraRay.js — primary camera ray generation.
 *
 * Three projections behind one `cameraProjection` uniform (CAMERA_PROJECTION_IDS): pinhole (NDC through
 * cameraProjectionMatrixInverse), equirectangular 360 panorama, and orthographic (parallel rays from the
 * camera's image plane). All live in the same kernel, so switching modes writes a uniform and resets
 * accumulation — it never recompiles WGSL.
 *
 * Equirect mapping, for uv ∈ [0,1] with v = 0 at the top row:
 *   lon = mix( lonMin, lonMax, u ),  lat = mix( latMax, latMin, v )
 *   dirCam = ( sin(lon)·cos(lat), sin(lat), -cos(lon)·cos(lat) )
 * so lon = lat = 0 is camera-forward (image centre), u = 0.75 is camera-right and v = 0 is the zenith.
 */

import {
	Fn, vec3, vec4, float, int, uniform,
	If, normalize, mat3, mix, sin, cos, cross, dot, select,
} from 'three/tsl';
import { Vector2 } from 'three';

import { Ray } from './Struct.js';
import { constructTBN } from './Common.js';
import { RandomPointInCircle } from './Random.js';
import { CAMERA_PROJECTION_IDS } from '../EngineDefaults.js';

const PANORAMA = int( CAMERA_PROJECTION_IDS.equirectangular );
const ORTHOGRAPHIC = int( CAMERA_PROJECTION_IDS.orthographic );

export const isOrthographic = cameraProjection => cameraProjection.equal( ORTHOGRAPHIC );

/**
 * The projection uniforms a stage re-tracing the path tracer's primary rays needs. `sync` copies the path
 * tracer's, once a frame.
 */
export function cameraRayUniforms() {

	const u = {
		cameraProjection: uniform( 0, 'int' ),
		panoLonRange: uniform( new Vector2(), 'vec2' ),
		panoLatRange: uniform( new Vector2(), 'vec2' ),
		panoLevelHorizon: uniform( 1, 'int' ),
		/** @param {import('../managers/UniformManager.js').UniformManager} source */
		sync( source ) {

			u.cameraProjection.value = source.get( 'cameraProjection' ).value;
			u.panoLonRange.value.copy( source.get( 'panoLonRange' ).value );
			u.panoLatRange.value.copy( source.get( 'panoLatRange' ).value );
			u.panoLevelHorizon.value = source.get( 'panoLevelHorizon' ).value;

		},
	};
	return u;

}

/** Pixel uv's primary ray, for a stage holding {@link cameraRayUniforms}. */
export const cameraRayOf = ( uv01, cameraWorldMatrix, cameraProjectionMatrixInverse, u ) => ( {
	origin: cameraRayOrigin( uv01, cameraWorldMatrix, cameraProjectionMatrixInverse, u.cameraProjection ),
	direction: cameraRayDirection(
		uv01, cameraWorldMatrix, cameraProjectionMatrixInverse,
		u.cameraProjection, u.panoLonRange, u.panoLatRange, u.panoLevelHorizon
	),
} );

/** The point `distance` along pixel uv's primary ray — where a depth the path tracer measured lies. */
export const cameraRayPoint = ( uv01, distance, cameraWorldMatrix, cameraProjectionMatrixInverse, u ) => {

	const { origin, direction } = cameraRayOf( uv01, cameraWorldMatrix, cameraProjectionMatrixInverse, u );
	return origin.add( direction.mul( distance ) );

};

/** World-space primary ray origin for pixel uv: the camera, or its image plane when orthographic. */
export const cameraRayOrigin = Fn( ( [ uv01, cameraWorldMatrix, cameraProjectionMatrixInverse, cameraProjection ] ) => {

	const origin = vec3( cameraWorldMatrix[ 3 ] ).toVar();

	If( isOrthographic( cameraProjection ), () => {

		// An orthographic inverse maps x and y alone, whatever the depth.
		const onPlane = cameraProjectionMatrixInverse.mul( vec4( uv01.x.mul( 2.0 ).sub( 1.0 ), float( 1.0 ).sub( uv01.y.mul( 2.0 ) ), 0.0, 1.0 ) );
		origin.assign( cameraWorldMatrix.mul( vec4( onPlane.xy, 0.0, 1.0 ) ).xyz );

	} );

	return origin;

} );

/** World-space primary ray direction for pixel uv, from {@link cameraRayOrigin}. */
export const cameraRayDirection = Fn( ( [
	uv01, cameraWorldMatrix, cameraProjectionMatrixInverse,
	cameraProjection, panoLonRange, panoLatRange, panoLevelHorizon
] ) => {

	const direction = vec3( 0.0 ).toVar();

	If( cameraProjection.equal( PANORAMA ), () => {

		const lon = mix( panoLonRange.x, panoLonRange.y, uv01.x ).toVar();
		const lat = mix( panoLatRange.y, panoLatRange.x, uv01.y ).toVar();
		const cosLat = cos( lat ).toVar();

		const right = vec3( 0.0 ).toVar();
		const up = vec3( 0.0 ).toVar();
		const back = vec3( 0.0 ).toVar();

		If( panoLevelHorizon.equal( int( 1 ) ), () => {

			// Yaw-only frame — orbit pitch/roll must not tilt the panorama. The flattened column
			// is normalized below, so it needs no pre-normalize.
			const flat = vec3( cameraWorldMatrix[ 2 ].x, 0.0, cameraWorldMatrix[ 2 ].z ).toVar();
			// Straight up/down: the camera's own up vector is the horizontal one.
			If( dot( flat, flat ).lessThan( float( 1e-8 ) ), () => {

				flat.assign( vec3( cameraWorldMatrix[ 1 ].x, 0.0, cameraWorldMatrix[ 1 ].z ) );

			} );

			back.assign( normalize( flat ) );
			up.assign( vec3( 0.0, 1.0, 0.0 ) );
			right.assign( cross( up, back ) );

		} ).Else( () => {

			right.assign( normalize( vec3( cameraWorldMatrix[ 0 ] ) ) );
			up.assign( normalize( vec3( cameraWorldMatrix[ 1 ] ) ) );
			back.assign( normalize( vec3( cameraWorldMatrix[ 2 ] ) ) );

		} );

		direction.assign( normalize(
			right.mul( sin( lon ).mul( cosLat ) )
				.add( up.mul( sin( lat ) ) )
				.sub( back.mul( cos( lon ).mul( cosLat ) ) )
		) );

	} ).ElseIf( isOrthographic( cameraProjection ), () => {

		direction.assign( normalize( vec3( cameraWorldMatrix[ 2 ] ) ).negate() );

	} ).Else( () => {

		const ndcPos = vec3( uv01.x.mul( 2.0 ).sub( 1.0 ), float( 1.0 ).sub( uv01.y.mul( 2.0 ) ), 1.0 );
		const rayDirCS = cameraProjectionMatrixInverse.mul( vec4( ndcPos, 1.0 ) );

		direction.assign( normalize( mat3(
			cameraWorldMatrix[ 0 ].xyz,
			cameraWorldMatrix[ 1 ].xyz,
			cameraWorldMatrix[ 2 ].xyz
		).mul( rayDirCS.xyz.div( rayDirCS.w ) ) ) );

	} );

	return direction;

} );

export const generateRayFromCamera = Fn( ( [
	uv01, rngState,
	cameraWorldMatrix, cameraProjectionMatrixInverse,
	cameraProjection, panoLonRange, panoLatRange, panoLevelHorizon,
	enableDOF, focalLength, aperture, focusDistance, unitsPerMetre, apertureScale, anamorphicRatio, dofMode, dofBlur
] ) => {

	const rayOriginWorld = cameraRayOrigin( uv01, cameraWorldMatrix, cameraProjectionMatrixInverse, cameraProjection ).toVar();
	// .toVar() so the two reads below don't inline the whole projection graph twice.
	const rayDirectionWorld = cameraRayDirection(
		uv01, cameraWorldMatrix, cameraProjectionMatrixInverse,
		cameraProjection, panoLonRange, panoLatRange, panoLevelHorizon
	).toVar();

	const resultOrigin = rayOriginWorld.toVar();
	const resultDirection = rayDirectionWorld.toVar();

	const lookMode = dofMode.equal( int( 1 ) );
	const lensOpen = lookMode.and( dofBlur.greaterThan( 0.0 ) ).or( lookMode.not().and( focalLength.greaterThan( 0.0 ) ).and( aperture.lessThan( 64.0 ) ) );

	If( enableDOF.and( lensOpen ).and( focusDistance.greaterThan( 0.001 ) ), () => {

		// Orthographic 1: the blur then does not change with where the camera stands.
		const halfViewHeight = select( cameraProjection.equal( PANORAMA ), panoLatRange.y.sub( panoLatRange.x ).mul( 0.5 ),
			select( isOrthographic( cameraProjection ), float( 1.0 ), cameraProjectionMatrixInverse[ 1 ].y ) );
		const apertureRadius = select( lookMode,
			// A far background blurs by dofBlur of the image height, whatever the scene's scale.
			dofBlur.mul( focusDistance ).mul( halfViewHeight ),
			// f/N is the aperture's diameter, not its radius.
			focalLength.div( aperture.mul( 2.0 ) ).mul( 0.001 ).mul( unitsPerMetre ).mul( apertureScale )
		);

		const randomPoint = RandomPointInCircle( rngState );
		// Anamorphic squeeze — stretch horizontally for oval bokeh
		const lensX = randomPoint.x.mul( anamorphicRatio.max( 0.01 ) );
		const lensY = randomPoint.y;

		const lensOffset = vec3( 0.0 ).toVar();
		const focusAlongRay = focusDistance.toVar();

		If( cameraProjection.equal( PANORAMA ), () => {

			// Every pixel points a different way, so the lens plane is built around the ray. The
			// camera's right/up would skew bokeh into a slit away from the image centre.
			lensOffset.assign( constructTBN( { N: rayDirectionWorld } ).mul( vec3( lensX, lensY, 0.0 ) ) );

		} ).Else( () => {

			const camRight = normalize( vec3( cameraWorldMatrix[ 0 ] ) );
			const camUp = normalize( vec3( cameraWorldMatrix[ 1 ] ) );
			lensOffset.assign( camRight.mul( lensX ).add( camUp.mul( lensY ) ) );

			// A flat focal plane: focusDistance is depth along the view axis, not distance along the ray.
			focusAlongRay.assign( focusDistance.div( dot( rayDirectionWorld, normalize( vec3( cameraWorldMatrix[ 2 ] ) ) ).negate() ) );

		} );

		resultOrigin.assign( rayOriginWorld.add( lensOffset.mul( apertureRadius ) ) );
		resultDirection.assign( normalize( rayOriginWorld.add( rayDirectionWorld.mul( focusAlongRay ) ).sub( resultOrigin ) ) );

	} );

	return Ray( {
		origin: resultOrigin,
		direction: resultDirection,
	} );

} );
