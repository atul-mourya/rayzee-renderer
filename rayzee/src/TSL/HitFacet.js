/**
 * The hit triangle's facet normal, packed into the hit record's spare lane by Extend.
 *
 * The hit record's `normal` is the interpolated vertex normal. Rays spawned from a surface must be
 * offset along the facet itself — Cycles' ray_offset uses Ng — or a vertex normal bent away from its
 * facet (foliage cards whose normals all point up) moves the origin within the card's own plane,
 * and the continued ray hits the same card again.
 *
 * Layout: facet normal as an 11:11 octahedral pair (about 0.1°); the top 10 bits are free.
 */

import {
	vec2, vec3, float, int, uint, max, abs, dot, cross, normalize, clamp, round, select, If, uintBitsToFloat,
} from 'three/tsl';
import { getDatafromStorageBuffer, TRI_STRIDE, instanceRows, instanceFaceNormalToWorld } from './Common.js';

/**
 * @returns {{ faceN: Node }} the facet normal on the viewer's side (the interpolated one for a
 *   degenerate triangle)
 */
export function hitFacet( { triangleBuffer, bvhBuffer, triIdx, instanceLeaf, smoothNormal, viewDir, didHit } ) {

	const faceN = vec3( 0.0, 0.0, 1.0 ).toVar();

	If( didHit, () => {

		const recA = getDatafromStorageBuffer( triangleBuffer, triIdx, int( 0 ), int( TRI_STRIDE ) ).toVar();
		const recB = getDatafromStorageBuffer( triangleBuffer, triIdx, int( 1 ), int( TRI_STRIDE ) ).toVar();
		const recC = getDatafromStorageBuffer( triangleBuffer, triIdx, int( 2 ), int( TRI_STRIDE ) ).toVar();
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

		const n = select( dot( face, face ).greaterThan( 0.0 ), normalize( face ), smoothNormal ).toVar();
		faceN.assign( select( dot( n, viewDir ).lessThan( 0.0 ), n.negate(), n ) );

	} );

	return { faceN };

}

// Per component: TSL's select() on a bvec is not component-wise.
const signNotZero = v => vec2( select( v.x.greaterThanEqual( 0.0 ), 1.0, - 1.0 ), select( v.y.greaterThanEqual( 0.0 ), 1.0, - 1.0 ) );

export function packHitFacet( faceN ) {

	const p = faceN.xy.div( max( abs( faceN.x ).add( abs( faceN.y ) ).add( abs( faceN.z ) ), 1e-20 ) ).toVar();
	If( faceN.z.lessThan( 0.0 ), () => {

		p.assign( vec2( 1.0 ).sub( abs( p.yx ) ).mul( signNotZero( p ) ) );

	} );
	const q = round( clamp( p, - 1.0, 1.0 ).mul( 0.5 ).add( 0.5 ).mul( 2047.0 ) );
	return uint( q.x ).bitOr( uint( q.y ).shiftLeft( uint( 11 ) ) );

}

/** @returns {{ faceN: Node }} */
export function unpackHitFacet( bits ) {

	const e = vec2(
		float( bits.bitAnd( uint( 0x7ff ) ) ),
		float( bits.shiftRight( uint( 11 ) ).bitAnd( uint( 0x7ff ) ) ),
	).div( 2047.0 ).mul( 2.0 ).sub( 1.0 ).toVar();
	const z = float( 1.0 ).sub( abs( e.x ) ).sub( abs( e.y ) ).toVar();
	If( z.lessThan( 0.0 ), () => {

		e.assign( vec2( 1.0 ).sub( abs( e.yx ) ).mul( signNotZero( e ) ) );

	} );
	return { faceN: normalize( vec3( e, z ) ) };

}
