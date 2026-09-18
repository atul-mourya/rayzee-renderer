import { Fn, float, vec2, int, If, Loop, abs, normalize, dot, max, uintBitsToFloat } from 'three/tsl';

import { struct } from './patches.js';
import { getDatafromStorageBuffer, TRI_STRIDE, instanceRows, instanceDirToWorld } from './Common.js';
import { sampleDisplacementMap, bucketTexelSize, getLinearBucketTextures } from './TextureSampling.js';

// Ray-displacement intersection configuration
const MAX_MARCH_STEPS = 32;
const MIN_MARCH_STEPS = 16;
const BINARY_STEPS = 5;

export const DisplacementResult = struct( {
	hitPoint: 'vec3',
	uv: 'vec2',
	normal: 'vec3',
	height: 'float',
} );

/**
 * Tessellation-free displacement mapping via analytical UV ray marching.
 *
 * Instead of projecting march points onto the triangle to get barycentrics (which
 * causes UV distortion from clamping), this computes the ray's UV trajectory
 * analytically using the triangle's actual tangent vectors (dP/du, dP/dv).
 *
 * The ray is parameterized as: P(dt) = hitPoint + rayDir * dt
 * UV along the ray:           UV(dt) = hitUV + dUV_dt * dt
 * Ray height above surface:   h_ray(dt) = dt * dot(rayDir, N)
 * Displaced surface height:   h_surf(dt) = (sample(UV(dt)) - 0.5) * scale
 *
 * We find dt where h_ray(dt) = h_surf(dt).
 */
export const refineDisplacedIntersection = Fn( ( [
	ray, hitInfo, triangleBuffer, material, bounceIndex, bvhBuffer, instanceLeaf
] ) => {

	const resultHitPoint = hitInfo.hitPoint.toVar();
	const resultUV = hitInfo.uv.toVar();
	const resultNormal = hitInfo.normal.toVar();
	const resultHeight = float( 0.0 ).toVar();

	// Fetch triangle vertex data
	const triIdx = hitInfo.triangleIndex;

	const pA = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, triIdx, int( 0 ), int( TRI_STRIDE ) ).xyz ).toVar();
	const pB = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, triIdx, int( 1 ), int( TRI_STRIDE ) ).xyz );
	const pC = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, triIdx, int( 2 ), int( TRI_STRIDE ) ).xyz );

	const uvData1 = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, triIdx, int( 3 ), int( TRI_STRIDE ) ) ).toVar();
	const uvData2 = uintBitsToFloat( getDatafromStorageBuffer( triangleBuffer, triIdx, int( 4 ), int( TRI_STRIDE ) ).xy );

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

		const scale = material.displacementScale.div( float( 10.0 ) ); // Arbitrary scale factor for height
		const rayDir = ray.direction;

		// Compute UV velocity along the ray: dUV/dt
		// Project ray direction onto surface tangent plane
		const NdotD = dot( rayDir, N ).toVar();
		const rayProj = rayDir.sub( N.mul( NdotD ) ).toVar();

		// Solve: rayProj = du_dt * T + dv_dt * B
		// Using the Gram matrix inverse of [T, B]
		const TdotT = dot( T, T );
		const TdotB = dot( T, B );
		const BdotB = dot( B, B );
		const detJ = TdotT.mul( BdotB ).sub( TdotB.mul( TdotB ) ).toVar();

		If( abs( detJ ).greaterThan( 1e-10 ), () => {

			const invDetJ = float( 1.0 ).div( detJ );
			const rayProjDotT = dot( rayProj, T );
			const rayProjDotB = dot( rayProj, B );

			const du_dt = BdotB.mul( rayProjDotT ).sub( TdotB.mul( rayProjDotB ) ).mul( invDetJ );
			const dv_dt = TdotT.mul( rayProjDotB ).sub( TdotB.mul( rayProjDotT ) ).mul( invDetJ );
			const dUV_dt = vec2( du_dt, dv_dt ).toVar();

			// Ray height change per unit dt: how fast the ray moves along the surface normal
			const dh_ray_dt = NdotD.toVar();

			// March range: displacement shell extends ±0.5*scale from base surface
			// Compute dt range to traverse the full shell
			const absNdotD = max( abs( dh_ray_dt ), 0.001 );
			const dtShell = scale.div( absNdotD ).toVar();

			// Adaptive step count: full steps on primary ray, half on deeper bounces
			const marchSteps = int( bounceIndex.equal( int( 0 ) ).select(
				int( MAX_MARCH_STEPS ), int( MIN_MARCH_STEPS )
			) ).toVar();

			// Start from above the shell, march through
			const dtStart = dtShell.negate().toVar();
			const dtEnd = dtShell;
			const dtStep = dtEnd.sub( dtStart ).div( float( marchSteps ) ).toVar();

			// Track for binary refinement
			const prevDt = dtStart.toVar();
			const currDt = dtStart.toVar();
			const found = int( 0 ).toVar();

			// Linear march through displacement shell
			Loop( { start: int( 0 ), end: marchSteps, type: 'int', condition: '<' }, ( { i } ) => {

				If( found.equal( int( 0 ) ), () => {

					const dt = dtStart.add( dtStep.mul( float( i ) ) ).toVar();

					// UV at this point along the ray
					const marchUV = hitInfo.uv.add( dUV_dt.mul( dt ) );

					// Ray height above base surface at this dt
					const rayHeight = dt.mul( dh_ray_dt );

					// Displaced surface height
					const heightSample = sampleDisplacementMap(
						material.displacementMapIndex, marchUV, material.displacementTransform,
					);
					const surfaceHeight = heightSample.sub( 0.5 ).mul( scale );

					// Ray crosses below displaced surface → intersection
					If( rayHeight.lessThanEqual( surfaceHeight ).and( i.greaterThan( int( 0 ) ) ), () => {

						found.assign( 1 );
						currDt.assign( dt );

					} ).Else( () => {

						prevDt.assign( dt );

					} );

				} );

			} );

			// Binary refinement
			If( found.equal( int( 1 ) ), () => {

				const loDt = prevDt.toVar();
				const hiDt = currDt.toVar();

				Loop( { start: int( 0 ), end: int( BINARY_STEPS ), type: 'int', condition: '<' }, () => {

					const midDt = loDt.add( hiDt ).mul( 0.5 ).toVar();
					const midUV = hitInfo.uv.add( dUV_dt.mul( midDt ) );
					const midRayHeight = midDt.mul( dh_ray_dt );
					const midSample = sampleDisplacementMap(
						material.displacementMapIndex, midUV, material.displacementTransform,
					);
					const midSurfHeight = midSample.sub( 0.5 ).mul( scale );

					If( midRayHeight.lessThanEqual( midSurfHeight ), () => {

						hiDt.assign( midDt );

					} ).Else( () => {

						loDt.assign( midDt );

					} );

				} );

				// Final intersection
				const finalDt = loDt.add( hiDt ).mul( 0.5 ).toVar();
				const finalUV = hitInfo.uv.add( dUV_dt.mul( finalDt ) ).toVar();
				const finalPoint = hitInfo.hitPoint.add( rayDir.mul( finalDt ) );

				const finalHeight = sampleDisplacementMap(
					material.displacementMapIndex, finalUV, material.displacementTransform,
				);
				const displacedHeight = finalHeight.sub( 0.5 ).mul( scale );

				// Compute displaced normal from height-field gradients using UV tangent vectors.
				// Finite-difference step = one texel of the SELECTED bucket array's real dimensions.
				const texel = bucketTexelSize( getLinearBucketTextures(), material.displacementMapIndex ).toVar();
				const hC = finalHeight;
				const hU = sampleDisplacementMap(
					material.displacementMapIndex, finalUV.add( vec2( texel.x, 0.0 ) ), material.displacementTransform,
				);
				const hV = sampleDisplacementMap(
					material.displacementMapIndex, finalUV.add( vec2( 0.0, texel.y ) ), material.displacementTransform,
				);

				// Perturb normal using actual tangent/bitangent from UV parameterization
				const Tn = normalize( T ).toVar();
				const Bn = normalize( B ).toVar();
				const gradU = hU.sub( hC ).mul( scale );
				const gradV = hV.sub( hC ).mul( scale );
				const displacedNormal = normalize(
					N.sub( Tn.mul( gradU ) ).sub( Bn.mul( gradV ) )
				);

				resultHitPoint.assign( finalPoint );
				resultUV.assign( finalUV );
				resultNormal.assign( displacedNormal );
				resultHeight.assign( displacedHeight );

			} );

		} );

	} );

	return DisplacementResult( { hitPoint: resultHitPoint, uv: resultUV, normal: resultNormal, height: resultHeight } );

} );
