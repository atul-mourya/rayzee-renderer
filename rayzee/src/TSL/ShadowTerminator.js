/**
 * Cycles' shadow terminator geometry offset (kernel/light/sample.h, Blender 5.1).
 *
 * Near the terminator of a smooth-shaded low-poly surface, a light's shadow ray leaving the flat
 * facet is blocked by that facet or its neighbours although the smooth normal says the point is lit,
 * which draws the mesh's outline into the shading. Starting the ray on the smooth surface the vertex
 * normals describe — lifted along the normal by a parabolic estimate, bounded by each vertex's
 * tangent plane — removes it. Only light and environment shadow rays use it, as in Cycles.
 *
 * Extend computes the lift with the facet normal (HitFacet.js), where the triangle's corners were just
 * read, and packs both into the hit record's spare lane.
 */

import { vec3, float, max, min, dot, length, clamp, select, If } from 'three/tsl';
import { instanceRows, instanceDirToWorld, offsetRayOrigin } from './Common.js';

/**
 * The lift at full strength, as a signed length along the hit's smooth normal, from the triangle's
 * corners (see HitFacet.js). Cycles lifts along the object-to-world image of that normal; the two
 * agree unless the placement scales non-uniformly. Zero on a flat-shaded triangle.
 *
 * @param {Object} p - corners and vertex normals as stored (object space when `instanced`), and
 *   `faceN`, the world facet normal on the viewer's side
 */
export function shadowTerminatorLift( { V0, V1, V2, N0, N1, N2, hitPoint, instanced, bvhBuffer, instanceLeaf, faceN } ) {

	const scale = float( 0.0 ).toVar();

	const P = hitPoint.toVar();
	If( instanced, () => {

		const rows = instanceRows( bvhBuffer, instanceLeaf );
		P.assign( vec3(
			rows[ 0 ].xyz.dot( hitPoint ).add( rows[ 0 ].w ),
			rows[ 1 ].xyz.dot( hitPoint ).add( rows[ 1 ].w ),
			rows[ 2 ].xyz.dot( hitPoint ).add( rows[ 2 ].w ),
		) );

	} );

	// The hit record keeps texture UVs, not barycentrics.
	const e1 = V1.sub( V0 ).toVar();
	const e2 = V2.sub( V0 ).toVar();
	const ep = P.sub( V0 ).toVar();
	const d11 = dot( e1, e1 );
	const d12 = dot( e1, e2 );
	const d22 = dot( e2, e2 );
	const den = d11.mul( d22 ).sub( d12.mul( d12 ) ).toVar();

	If( den.greaterThan( d11.mul( d22 ).mul( 1e-12 ) ), () => {

		const dp1 = dot( ep, e1 );
		const dp2 = dot( ep, e2 );
		const v = clamp( d22.mul( dp1 ).sub( d12.mul( dp2 ) ).div( den ), 0.0, 1.0 ).toVar();
		const w = clamp( d11.mul( dp2 ).sub( d12.mul( dp1 ) ).div( den ), 0.0, float( 1.0 ).sub( v ) ).toVar();
		const u = float( 1.0 ).sub( v ).sub( w ).toVar();

		const Pl = V0.mul( u ).add( V1.mul( v ) ).add( V2.mul( w ) ).toVar();
		const nLocal = N0.mul( u ).add( N1.mul( v ) ).add( N2.mul( w ) ).toVar();
		const n = nLocal.toVar();
		If( instanced, () => {

			const rows = instanceRows( bvhBuffer, instanceLeaf );
			n.assign( instanceDirToWorld( { r0: rows[ 0 ].xyz, r1: rows[ 1 ].xyz, r2: rows[ 2 ].xyz, v: nLocal } ) );

		} );

		// Parabolic approximation.
		const a = dot( N2.sub( N0 ), V0.sub( V2 ) );
		const b = dot( N2.sub( N1 ), V1.sub( V2 ) );
		const c = dot( N1.sub( N0 ), V1.sub( V0 ) );
		const h = a.mul( u ).mul( u.sub( 1.0 ) ).add( a.add( b ).add( c ).mul( u ).mul( v ) ).add( b.mul( v ).mul( v.sub( 1.0 ) ) ).toVar();

		// Bounded by the local linear envelope of the vertices' tangent planes.
		If( dot( n, faceN ).greaterThan( 0.0 ), () => {

			const h0 = max( dot( V0.sub( Pl ), N0 ).add( max( max( dot( V1.sub( V0 ), N0 ), dot( V2.sub( V0 ), N0 ) ), 0.0 ) ), 0.0 );
			const h1 = max( dot( V1.sub( Pl ), N1 ).add( max( max( dot( V0.sub( V1 ), N1 ), dot( V2.sub( V1 ), N1 ) ), 0.0 ) ), 0.0 );
			const h2 = max( dot( V2.sub( Pl ), N2 ).add( max( max( dot( V0.sub( V2 ), N2 ), dot( V1.sub( V2 ), N2 ) ), 0.0 ) ), 0.0 );
			h.assign( max( min( min( h0, h1 ), h2 ), h.mul( 0.5 ) ) );

		} ).Else( () => {

			const h0 = max( dot( Pl.sub( V0 ), N0 ).add( max( max( dot( V0.sub( V1 ), N0 ), dot( V0.sub( V2 ), N0 ) ), 0.0 ) ), 0.0 );
			const h1 = max( dot( Pl.sub( V1 ), N1 ).add( max( max( dot( V1.sub( V0 ), N1 ), dot( V1.sub( V2 ), N1 ) ), 0.0 ) ), 0.0 );
			const h2 = max( dot( Pl.sub( V2 ), N2 ).add( max( max( dot( V2.sub( V0 ), N2 ), dot( V2.sub( V1 ), N2 ) ), 0.0 ) ), 0.0 );
			h.assign( min( min( min( h0, h1 ), h2 ).negate(), h.mul( 0.5 ) ) );

		} );

		scale.assign( length( n ).mul( h ) );

	} );

	return scale;

}

/**
 * A shadow ray's origin towards direction `L`: lifted by the share of the lift Cycles gives a
 * direction this close to the terminator, then offset as every spawned ray is.
 *
 * @param {Object} p
 * @param {Node} p.lift - the hit's unit smooth normal times the lift's scale
 * @param {Node} p.smoothN - the interpolated normal on the viewer's side (Cycles' sd->N)
 * @param {Node} p.cutoff - the geometry offset setting; 0 disables
 */
export function shadowTerminatorOrigin( { hitPoint, offsetNormal, lift, faceN, smoothN, L, cutoff } ) {

	// Cycles lifts towards the back for a transmitted direction; NEE here only lights the front.
	const NL = dot( smoothN, L );
	const NgL = dot( faceN, L );
	const c = max( cutoff, 1e-6 );
	const amount = select(
		cutoff.greaterThan( 0.0 ).and( NL.greaterThan( 0.0 ) ),
		select(
			NL.lessThan( cutoff ),
			clamp( float( 2.0 ).sub( NgL.add( NL ).div( c ) ), 0.0, 1.0 ),
			clamp( float( 1.0 ).sub( NgL.div( c ) ), 0.0, 1.0 ),
		),
		float( 0.0 ),
	);
	return offsetRayOrigin( hitPoint.add( lift.mul( amount ) ), offsetNormal );

}
