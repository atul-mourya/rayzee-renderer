import { Fn, float, vec3, sqrt, max, dot, cross, pow, cos, sin, abs, normalize, select, If } from 'three/tsl';

import { LIMB_DARKENING_EXPONENT } from '../Processor/AtmosphereModel.js';

const LIMB_EXPONENT = vec3( ...LIMB_DARKENING_EXPONENT );
// µ^α averages to 2 / (α + 2) over the disc, so this keeps the mean at `sunRadiance`.
const LIMB_NORM = vec3( ...LIMB_DARKENING_EXPONENT.map( a => ( a + 2 ) / 2 ) );

/**
 * Radiance the physical sky's sun sends along `dir`: limb darkened, and nothing below the sky's
 * horizon. `sunParams` = ( cos half-angle, solid angle, 1 / sin² half-angle, horizon dip sin ).
 */
export const sunRadianceToward = /*@__PURE__*/ Fn( ( [ dir, sunDirection, sunRadiance, sunParams ] ) => {

	const out = vec3( 0 ).toVar();
	If( dot( dir, sunDirection ).greaterThanEqual( sunParams.x ).and( dir.y.greaterThanEqual( sunParams.w.negate() ) ), () => {

		const c = cross( dir, sunDirection );
		const mu = sqrt( max( float( 1 ).sub( dot( c, c ).mul( sunParams.z ) ), 1e-8 ) );
		out.assign( sunRadiance.mul( pow( vec3( mu ), LIMB_EXPONENT ) ).mul( LIMB_NORM ) );

	} );
	return out;

} );

/** A direction uniform in solid angle over the sun disc. */
export const sampleSunDisc = /*@__PURE__*/ Fn( ( [ sunDirection, sunParams, xi ] ) => {

	// 1 − cosθ straight from the solid angle: 1 − cos(half-angle) cancels to nothing in f32.
	const oneMinusCos = xi.x.mul( sunParams.y.mul( 1 / ( 2 * Math.PI ) ) );
	const cosT = float( 1 ).sub( oneMinusCos );
	const sinT = sqrt( max( oneMinusCos.mul( float( 2 ).sub( oneMinusCos ) ), 0 ) );
	const phi = xi.y.mul( 2 * Math.PI );
	const w = sunDirection;
	const u = normalize( cross( select( abs( w.x ).greaterThan( 0.9 ), vec3( 0, 1, 0 ), vec3( 1, 0, 0 ) ), w ) );
	const v = cross( w, u );
	return normalize( w.mul( cosT ).add( u.mul( cos( phi ) ).add( v.mul( sin( phi ) ) ).mul( sinT ) ) );

} );
