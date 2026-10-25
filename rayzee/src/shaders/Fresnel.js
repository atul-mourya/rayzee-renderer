import { Fn, float, vec3, max, clamp, sqrt, select } from 'three/tsl';

const EPSILON = 1e-6;

// Schlick exponent factored as 4 multiplies — pow(x, 5.0) compiles to
// exp2(5*log2(x)) on most backends, far slower than (x²)²·x.
const pow5 = ( c ) => {

	const c2 = c.mul( c );
	return c2.mul( c2 ).mul( c );

};

export const fresnel = Fn( ( [ f0, NoV, roughness ] ) => {

	const maxR = max( vec3( float( 1.0 ).sub( roughness ) ), f0 );
	return f0.add( maxR.sub( f0 ).mul( pow5( float( 1.0 ).sub( NoV ) ) ) );

} );

export const fresnelSchlickFloat = Fn( ( [ cosTheta, F0 ] ) => {

	const clampedCos = clamp( cosTheta, 0.0, 1.0 );
	return F0.add( float( 1.0 ).sub( F0 ).mul( pow5( float( 1.0 ).sub( clampedCos ) ) ) );

} );

export const fresnelSchlick = Fn( ( [ cosTheta, F0 ] ) => {

	const clampedCos = clamp( cosTheta, 0.0, 1.0 );
	return F0.add( vec3( 1.0 ).sub( F0 ).mul( pow5( float( 1.0 ).sub( clampedCos ) ) ) );

} );

export const fresnel0ToIor = Fn( ( [ fresnel0 ] ) => {

	const sqrtF0 = sqrt( fresnel0 );
	return vec3( 1.0 ).add( sqrtF0 ).div( max( vec3( 1.0 ).sub( sqrtF0 ), vec3( EPSILON ) ) );

} );

export const iorToFresnel0Vec3 = Fn( ( [ transmittedIor, incidentIor ] ) => {

	const diff = transmittedIor.sub( vec3( incidentIor ) );
	const sum = max( transmittedIor.add( vec3( incidentIor ) ), vec3( EPSILON ) );
	const ratio = diff.div( sum );
	return ratio.mul( ratio );

} );

export const iorToFresnel0 = Fn( ( [ transmittedIor, incidentIor ] ) => {

	const diff = transmittedIor.sub( incidentIor );
	const sum = max( transmittedIor.add( incidentIor ), EPSILON );
	const ratio = diff.div( sum );
	return ratio.mul( ratio );

} );

export const dielectricF0 = ( ior ) => vec3( iorToFresnel0( ior, float( 1.0 ) ) );

// Unpolarised reflectance of a smooth dielectric interface, eta = n_transmitted / n_incident.
// Returns 1 under total internal reflection. Schlick runs 16-23 % low at 45-65° for eta 1.5.
export const fresnelDielectric = Fn( ( [ cosI, eta ] ) => {

	const c = clamp( cosI, 0.0, 1.0 );
	const g2 = eta.mul( eta ).sub( 1.0 ).add( c.mul( c ) );
	const g = sqrt( max( g2, 0.0 ) );
	const A = g.sub( c ).div( max( g.add( c ), EPSILON ) );
	const B = c.mul( g.add( c ) ).sub( 1.0 ).div( max( c.mul( g.sub( c ) ).add( 1.0 ), EPSILON ) );
	return select( g2.greaterThan( 0.0 ), clamp( A.mul( A ).mul( 0.5 ).mul( B.mul( B ).add( 1.0 ) ), 0.0, 1.0 ), float( 1.0 ) );

} );

// The exact curve rescaled to run 0 head-on to 1 at grazing, so F = mix( f0, f90, weight ) keeps
// KHR_materials_specular's f0/f90 controls. With f0 = F0(eta) and f90 = 1 it is fresnelDielectric.
export const dielectricFresnelWeight = Fn( ( [ cosI, eta ] ) => {

	const F0 = iorToFresnel0( eta, float( 1.0 ) );
	return clamp( fresnelDielectric( cosI, eta ).sub( F0 ).div( max( float( 1.0 ).sub( F0 ), EPSILON ) ), 0.0, 1.0 );

} );
