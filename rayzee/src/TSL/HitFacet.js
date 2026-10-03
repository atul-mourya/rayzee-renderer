/**
 * The hit triangle's facet normal, packed into the hit record's spare lane by Extend.
 *
 * The hit record's `normal` is the interpolated vertex normal. Rays spawned from a surface must be
 * offset along the facet itself — Cycles' ray_offset uses Ng — or a vertex normal bent away from its
 * facet (foliage cards whose normals all point up) moves the origin within the card's own plane,
 * and the continued ray hits the same card again. The lane also carries the shadow terminator lift.
 *
 * Layout: facet normal as an 11:11 octahedral pair (about 0.1°), then the lift's half float
 * truncated to its top 10 bits (sign, exponent, 4 mantissa bits).
 */

import {
	vec2, vec3, float, int, uint, max, abs, dot, cross, normalize, clamp, round, select, If, uintBitsToFloat,
	packHalf2x16, unpackHalf2x16,
} from 'three/tsl';
import {
	unpackTriangleNormal, triangleRow, instanceRows, instanceFaceNormalToWorld, instancePointToWorld,
} from './Common.js';
import { shadowTerminatorLift } from './ShadowTerminator.js';

/**
 * @returns {{ faceN: Node, liftScale: Node, surfaceOffset: Node }} the facet normal on the viewer's side (the
 *   interpolated one for a degenerate triangle), the terminator lift (0 unless `liftEnabled`), and how far along
 *   faceN `hitPoint` lies from the triangle's plane (ExtendKernel moves the stored distance onto it)
 */
export function hitFacet( { triangleBuffer, bvhBuffer, triIdx, instanceLeaf, hitPoint, smoothNormal, viewDir, didHit, liftEnabled } ) {

	const faceN = vec3( 0.0, 0.0, 1.0 ).toVar();
	const liftScale = float( 0.0 ).toVar();
	const surfaceOffset = float( 0.0 ).toVar();

	If( didHit, () => {

		const recA = triangleRow( triangleBuffer, triIdx, 0 ).toVar();
		const recB = triangleRow( triangleBuffer, triIdx, 1 ).toVar();
		const recC = triangleRow( triangleBuffer, triIdx, 2 ).toVar();
		const V0 = uintBitsToFloat( recA.xyz ).toVar();
		const V1 = uintBitsToFloat( recB.xyz ).toVar();
		const V2 = uintBitsToFloat( recC.xyz ).toVar();

		// Shared geometry is stored in object space.
		const faceLocal = cross( V1.sub( V0 ), V2.sub( V0 ) ).toVar();
		const face = faceLocal.toVar();
		const instanced = instanceLeaf.greaterThanEqual( int( 0 ) );
		If( instanced, () => {

			face.assign( instanceFaceNormalToWorld( instanceRows( bvhBuffer, instanceLeaf ), faceLocal ) );

		} );

		const degenerate = dot( face, face ).lessThanEqual( 0.0 ).toVar();
		const n = select( degenerate, smoothNormal, normalize( face ) ).toVar();
		faceN.assign( select( dot( n, viewDir ).lessThan( 0.0 ), n.negate(), n ) );

		const corner = V0.toVar();
		If( instanced, () => {

			corner.assign( instancePointToWorld( instanceRows( bvhBuffer, instanceLeaf ), V0 ) );

		} );
		surfaceOffset.assign( select( degenerate, float( 0.0 ), dot( corner.sub( hitPoint ), faceN ) ) );

		If( liftEnabled, () => {

			liftScale.assign( shadowTerminatorLift( {
				V0, V1, V2,
				N0: unpackTriangleNormal( recA.w ), N1: unpackTriangleNormal( recB.w ), N2: unpackTriangleNormal( recC.w ),
				hitPoint, instanced, bvhBuffer, instanceLeaf, faceN,
			} ) );

		} );

	} );

	return { faceN, liftScale, surfaceOffset };

}

/**
 * The triangle's unit winding normal in world space: what the traversal's front/back test sees (a mirrored
 * placement keeps its object-space sense). The interpolated normal can face the other way near a coarse mesh's
 * silhouette. Unit length because sideAccepts has a threshold: a raw cross product of a small triangle is under it.
 */
export function windingNormal( triangleBuffer, bvhBuffer, triIdx, instanceLeaf ) {

	const V0 = uintBitsToFloat( triangleRow( triangleBuffer, triIdx, 0 ).xyz ).toVar();
	const local = cross( uintBitsToFloat( triangleRow( triangleBuffer, triIdx, 1 ).xyz ).sub( V0 ), uintBitsToFloat( triangleRow( triangleBuffer, triIdx, 2 ).xyz ).sub( V0 ) ).toVar();
	const n = local.toVar();
	If( instanceLeaf.greaterThanEqual( int( 0 ) ), () => {

		n.assign( instanceFaceNormalToWorld( instanceRows( bvhBuffer, instanceLeaf ), local ) );

	} );
	return normalize( n );

}

// Per component: TSL's select() on a bvec is not component-wise.
const signNotZero = v => vec2( select( v.x.greaterThanEqual( 0.0 ), 1.0, - 1.0 ), select( v.y.greaterThanEqual( 0.0 ), 1.0, - 1.0 ) );

export function packHitFacet( faceN, liftScale ) {

	const p = faceN.xy.div( max( abs( faceN.x ).add( abs( faceN.y ) ).add( abs( faceN.z ) ), 1e-20 ) ).toVar();
	If( faceN.z.lessThan( 0.0 ), () => {

		p.assign( vec2( 1.0 ).sub( abs( p.yx ) ).mul( signNotZero( p ) ) );

	} );
	const q = round( clamp( p, - 1.0, 1.0 ).mul( 0.5 ).add( 0.5 ).mul( 2047.0 ) );
	const h = packHalf2x16( vec2( liftScale, 0.0 ) ).bitAnd( uint( 0xffff ) ).shiftRight( uint( 6 ) );
	return uint( q.x ).bitOr( uint( q.y ).shiftLeft( uint( 11 ) ) ).bitOr( h.shiftLeft( uint( 22 ) ) );

}

/** @returns {{ faceN: Node, liftScale: Node }} */
export function unpackHitFacet( bits ) {

	const e = vec2(
		float( bits.bitAnd( uint( 0x7ff ) ) ),
		float( bits.shiftRight( uint( 11 ) ).bitAnd( uint( 0x7ff ) ) ),
	).div( 2047.0 ).mul( 2.0 ).sub( 1.0 ).toVar();
	const z = float( 1.0 ).sub( abs( e.x ) ).sub( abs( e.y ) ).toVar();
	If( z.lessThan( 0.0 ), () => {

		e.assign( vec2( 1.0 ).sub( abs( e.yx ) ).mul( signNotZero( e ) ) );

	} );
	const liftScale = unpackHalf2x16( bits.shiftRight( uint( 22 ) ).shiftLeft( uint( 6 ) ) ).x;
	return { faceN: normalize( vec3( e, z ) ), liftScale };

}
