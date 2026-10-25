import { sceneResources } from './SceneResources.js';
import {
	Fn, wgslFn, float, vec2, int, bool as tslBool, If, Loop, Break, abs, normalize, dot, cross, min, max, clamp, ceil, select, uintBitsToFloat,
} from 'three/tsl';

import { struct } from './patches.js';
import { triangleRow, instanceRows, instanceDirToWorld } from './Common.js';
import { sampleDisplacementMap, bucketTexelSize } from './TextureSampling.js';

const MIN_MARCH_STEPS = 8;
const MAX_MARCH_STEPS = 64;
const MAX_BOUNCE_MARCH_STEPS = 16;
const STEPS_PER_TEXEL = 0.25;
const BINARY_STEPS = 6;
const SLOPE_TEXELS = 1.5;

export const DisplacementResult = struct( {
	hitPoint: 'vec3',
	uv: 'vec2',
	normal: 'vec3',
} );

// Texture-space UV per raw UV, per axis.
const uvTransformScale = /*@__PURE__*/ wgslFn( `
	fn uvTransformScale( transform: mat3x3f ) -> vec2f {
		return max( vec2f( length( transform[0].xy ), length( transform[1].xy ) ), vec2f( 1e-6 ) );
	}
` );

/**
 * Tessellation-free displacement mapping via analytical UV ray marching.
 *
 * The ray is parameterized as: P(dt) = hitPoint + rayDir * dt
 * UV along the ray:           UV(dt) = hitUV + dUV_dt * dt
 * Ray height above surface:   h_ray(dt) = dt * dot(rayDir, N)
 * Displaced surface height:   h_surf(dt) = sample(UV(dt)) * displacementScale + displacementBias, as three.js
 *
 * We find dt where h_ray(dt) = h_surf(dt).
 */
export const refineDisplacedIntersection = Fn( ( [
	ray, hitInfo, triangleBuffer, material, bounceIndex, bvhBuffer, instanceLeaf
], builder ) => {

	const resultHitPoint = hitInfo.hitPoint.toVar();
	const resultUV = hitInfo.uv.toVar();
	const resultNormal = hitInfo.normal.toVar();

	// Fetch triangle vertex data
	const triIdx = hitInfo.triangleIndex;

	const pA = uintBitsToFloat( triangleRow( triangleBuffer, triIdx, 0 ).xyz ).toVar();
	const pB = uintBitsToFloat( triangleRow( triangleBuffer, triIdx, 1 ).xyz );
	const pC = uintBitsToFloat( triangleRow( triangleBuffer, triIdx, 2 ).xyz );

	const uvData1 = uintBitsToFloat( triangleRow( triangleBuffer, triIdx, 3 ) ).toVar();
	const uvData2 = uintBitsToFloat( triangleRow( triangleBuffer, triIdx, 4 ).xy );

	const uvA = uvData1.xy.toVar();
	const uvB = uvData1.zw;
	const uvC = uvData2;

	// Compute tangent vectors from triangle edges + UV differences. The ray, the hit point and
	// the normal are all in world space; a triangle that belongs to a placement is not, so its
	// edges are moved before they are used, or the marching frame is half in each space.
	const edge1 = pB.sub( pA ).toVar();
	const edge2 = pC.sub( pA ).toVar();

	If( instanceLeaf.greaterThanEqual( int( 0 ) ), () => {

		const rows = instanceRows( bvhBuffer, instanceLeaf );
		const r = { r0: rows[ 0 ].xyz, r1: rows[ 1 ].xyz, r2: rows[ 2 ].xyz };
		edge1.assign( instanceDirToWorld( { ...r, v: edge1 } ) );
		edge2.assign( instanceDirToWorld( { ...r, v: edge2 } ) );

	} );

	const dUV1 = uvB.sub( uvA ).toVar();
	const dUV2 = uvC.sub( uvA ).toVar();
	const det = dUV1.x.mul( dUV2.y ).sub( dUV2.x.mul( dUV1.y ) ).toVar();

	// Skip displacement for degenerate UV mapping
	If( abs( det ).greaterThan( 1e-8 ), () => {

		const invDet = float( 1.0 ).div( det );

		// dP/du and dP/dv — world-space tangent vectors from UV parameterization
		const T = edge1.mul( dUV2.y ).sub( edge2.mul( dUV1.y ) ).mul( invDet ).toVar();
		const B = edge2.mul( dUV1.x ).sub( edge1.mul( dUV2.x ) ).mul( invDet ).toVar();
		const N = hitInfo.normal.toVar();

		const scale = material.displacementScale;
		const bias = material.displacementBias;
		const rayDir = ray.direction;

		const NdotD = dot( rayDir, N ).toVar();
		const rayProj = rayDir.sub( N.mul( NdotD ) ).toVar();

		const TdotT = dot( T, T );
		const TdotB = dot( T, B );
		const BdotB = dot( B, B );
		const detJ = TdotT.mul( BdotB ).sub( TdotB.mul( TdotB ) ).toVar();

		If( abs( detJ ).greaterThan( 1e-10 ), () => {

			// Dual basis of (T, B): dot( Td, T ) = 1, dot( Td, B ) = 0, and likewise Bd.
			const invDetJ = float( 1.0 ).div( detJ );
			const Td = T.mul( BdotB ).sub( B.mul( TdotB ) ).mul( invDetJ ).toVar();
			const Bd = B.mul( TdotT ).sub( T.mul( TdotB ) ).mul( invDetJ ).toVar();
			const dUV_dt = vec2( dot( rayProj, Td ), dot( rayProj, Bd ) ).toVar();

			// +1 when the ray arrives from the side N points to.
			const side = select( NdotD.lessThan( 0.0 ), float( 1.0 ), float( - 1.0 ) ).toVar();
			const under = ( dt, height ) => dt.mul( NdotD ).sub( height.mul( scale ).add( bias ) ).mul( side ).lessThanEqual( 0.0 );
			const heightAt = uv => sampleDisplacementMap( material.displacementMapIndex, uv, material.displacementTransform );

			// Enter the shell [bias, bias + scale] on the ray's side, never behind the ray's origin.
			const top = max( bias, bias.add( scale ) );
			const bottom = min( bias, bias.add( scale ) );
			const slope = side.negate().mul( max( abs( NdotD ), 0.001 ) );
			const dtStart = max( select( side.greaterThan( 0.0 ), top, bottom ).div( slope ), hitInfo.dst.negate() ).toVar();
			const dtEnd = select( side.greaterThan( 0.0 ), bottom, top ).div( slope ).toVar();

			// One step per few texels the ray crosses, so a grazing ray does not step over the gaps.
			const texelsPerUV = uvTransformScale( { transform: material.displacementTransform } )
				.div( bucketTexelSize( sceneResources( builder ).linearBuckets, material.displacementMapIndex ) ).toVar();
			const texelsCrossed = dUV_dt.mul( texelsPerUV ).length().mul( dtEnd.sub( dtStart ) );
			const maxSteps = select( bounceIndex.equal( int( 0 ) ), float( MAX_MARCH_STEPS ), float( MAX_BOUNCE_MARCH_STEPS ) );
			const marchSteps = select( dtEnd.greaterThan( dtStart ),
				int( clamp( ceil( texelsCrossed.mul( STEPS_PER_TEXEL ) ), float( MIN_MARCH_STEPS ), maxSteps ) ), int( 0 ) ).toVar();
			const dtStep = dtEnd.sub( dtStart ).div( max( float( marchSteps ), 1.0 ) ).toVar();

			const loDt = dtStart.toVar();
			const hiDt = dtStart.toVar();
			const found = tslBool( false ).toVar();

			Loop( { start: int( 1 ), end: marchSteps.add( 1 ), type: 'int', condition: '<' }, ( { i } ) => {

				const dt = dtStart.add( dtStep.mul( float( i ) ) ).toVar();

				If( under( dt, heightAt( hitInfo.uv.add( dUV_dt.mul( dt ) ) ) ), () => {

					found.assign( true );
					hiDt.assign( dt );
					Break();

				} );

				loDt.assign( dt );

			} );

			If( found, () => {

				Loop( { start: int( 0 ), end: int( BINARY_STEPS ), type: 'int', condition: '<' }, () => {

					const midDt = loDt.add( hiDt ).mul( 0.5 ).toVar();

					If( under( midDt, heightAt( hitInfo.uv.add( dUV_dt.mul( midDt ) ) ) ), () => {

						hiDt.assign( midDt );

					} ).Else( () => {

						loDt.assign( midDt );

					} );

				} );

				const finalDt = loDt.add( hiDt ).mul( 0.5 ).toVar();
				const finalUV = hitInfo.uv.add( dUV_dt.mul( finalDt ) ).toVar();

				// Central differences over a few texels: an 8-bit map's steps make one-texel slopes flicker.
				const step = vec2( SLOPE_TEXELS ).div( texelsPerUV ).toVar();
				const dhdu = heightAt( finalUV.add( vec2( step.x, 0.0 ) ) ).sub( heightAt( finalUV.sub( vec2( step.x, 0.0 ) ) ) ).mul( scale ).div( step.x.mul( 2.0 ) );
				const dhdv = heightAt( finalUV.add( vec2( 0.0, step.y ) ) ).sub( heightAt( finalUV.sub( vec2( 0.0, step.y ) ) ) ).mul( scale ).div( step.y.mul( 2.0 ) );
				resultNormal.assign( normalize( N.sub( Td.mul( dhdu ) ).sub( Bd.mul( dhdv ) ) ) );

				// A point behind the base triangle goes up onto its plane: rays spawned below it would hit it.
				const faceN = normalize( cross( Td, Bd ) );
				const moveDir = select( finalDt.greaterThan( 0.0 ), rayDir.sub( faceN.mul( dot( rayDir, faceN ) ) ), rayDir );
				resultHitPoint.assign( hitInfo.hitPoint.add( moveDir.mul( finalDt ) ) );
				resultUV.assign( finalUV );

			} );

		} );

	} );

	return DisplacementResult( { hitPoint: resultHitPoint, uv: resultUV, normal: resultNormal } );

} );
