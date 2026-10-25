import { wgslFn } from 'three/tsl';

// =============================================================================
// MATERIAL SAMPLING
// =============================================================================
// Importance sampling primitives: GGX, cosine-weighted hemisphere, VNDF.

// -----------------------------------------------------------------------------
// Basic Sampling Functions
// -----------------------------------------------------------------------------

export const ImportanceSampleGGX = /*@__PURE__*/ wgslFn( `
	fn ImportanceSampleGGX( N: vec3f, roughness: f32, Xi: vec2f ) -> vec3f {
		let alpha = roughness * roughness;
		let phi = 6.28318530717958647692f * Xi.x;
		let cosTheta = sqrt( ( 1.0f - Xi.y ) / ( 1.0f + ( alpha * alpha - 1.0f ) * Xi.y ) );
		let sinTheta = sqrt( max( 0.0f, 1.0f - cosTheta * cosTheta ) );
		let H = vec3f( cos( phi ) * sinTheta, sin( phi ) * sinTheta, cosTheta );
		// TBN construction
		let up = select( vec3f( 1.0f, 0.0f, 0.0f ), vec3f( 0.0f, 0.0f, 1.0f ), abs( N.z ) < 0.999f );
		let tangent = normalize( cross( up, N ) );
		let bitangent = cross( N, tangent );
		return normalize( tangent * H.x + bitangent * H.y + N * H.z );
	}
` );

export const ImportanceSampleCosine = /*@__PURE__*/ wgslFn( `
	fn ImportanceSampleCosine( N: vec3f, xi: vec2f ) -> vec3f {
		let T = normalize( cross( N, N.yzx + vec3f( 0.1f, 0.2f, 0.3f ) ) );
		let B = cross( N, T );
		let phi = 6.28318530717958647692f * xi.x;
		let cosTheta = sqrt( 1.0f - xi.y );
		let sinTheta = sqrt( xi.y );
		let localDir = vec3f( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );
		return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
	}
` );

export const cosineWeightedSample = /*@__PURE__*/ wgslFn( `
	fn cosineWeightedSample( N: vec3f, xi: vec2f ) -> vec3f {
		let T = normalize( cross( N, N.yzx + vec3f( 0.1f, 0.2f, 0.3f ) ) );
		let B = cross( N, T );
		let phi = 6.28318530717958647692f * xi.y;
		let cosTheta = sqrt( 1.0f - xi.x );
		let sinTheta = sqrt( xi.x );
		let localDir = vec3f( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );
		return normalize( T * localDir.x + B * localDir.y + N * localDir.z );
	}
` );

// -----------------------------------------------------------------------------
// VNDF Sampling (Visible Normal Distribution Function)
// -----------------------------------------------------------------------------

export const sampleGGXVNDF = /*@__PURE__*/ wgslFn( `
	fn sampleGGXVNDF( V: vec3f, roughness: f32, Xi: vec2f ) -> vec3f {
		let alpha = roughness * roughness;
		// Transform view direction to local space
		let Vh = normalize( vec3f( alpha * V.x, alpha * V.y, V.z ) );
		// Construct orthonormal basis around view direction
		let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
		let T1 = select( vec3f( 1.0f, 0.0f, 0.0f ), vec3f( -Vh.y, Vh.x, 0.0f ) / sqrt( lensq ), lensq > 1e-8f );
		let T2 = cross( Vh, T1 );
		// Sample point with polar coordinates (r, phi)
		let r = sqrt( Xi.x );
		let phi = 6.28318530717958647692f * Xi.y;
		let t1 = r * cos( phi );
		let t2tmp = r * sin( phi );
		let s = 0.5f * ( 1.0f + Vh.z );
		let t2 = ( 1.0f - s ) * sqrt( 1.0f - t1 * t1 ) + s * t2tmp;
		// Compute normal
		let Nh = T1 * t1 + T2 * t2 + Vh * sqrt( max( 0.0f, 1.0f - t1 * t1 - t2 * t2 ) );
		// Transform the normal back to the ellipsoid configuration
		return normalize( vec3f( alpha * Nh.x, alpha * Nh.y, max( 0.0f, Nh.z ) ) );
	}
` );

// Anisotropic VNDF: identical to sampleGGXVNDF but stretches x/y by separate alphas.
// V is in the anisotropy tangent frame (x=tangent, y=bitangent, z=normal); returns local H.
export const sampleGGXVNDFAniso = /*@__PURE__*/ wgslFn( `
	fn sampleGGXVNDFAniso( V: vec3f, alphaX: f32, alphaY: f32, Xi: vec2f ) -> vec3f {
		let Vh = normalize( vec3f( alphaX * V.x, alphaY * V.y, V.z ) );
		let lensq = Vh.x * Vh.x + Vh.y * Vh.y;
		let T1 = select( vec3f( 1.0f, 0.0f, 0.0f ), vec3f( -Vh.y, Vh.x, 0.0f ) / sqrt( lensq ), lensq > 1e-8f );
		let T2 = cross( Vh, T1 );
		let r = sqrt( Xi.x );
		let phi = 6.28318530717958647692f * Xi.y;
		let t1 = r * cos( phi );
		let t2tmp = r * sin( phi );
		let s = 0.5f * ( 1.0f + Vh.z );
		let t2 = ( 1.0f - s ) * sqrt( 1.0f - t1 * t1 ) + s * t2tmp;
		let Nh = T1 * t1 + T2 * t2 + Vh * sqrt( max( 0.0f, 1.0f - t1 * t1 - t2 * t2 ) );
		return normalize( vec3f( alphaX * Nh.x, alphaY * Nh.y, max( 0.0f, Nh.z ) ) );
	}
` );
