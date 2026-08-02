// Lights Core - Ported from lights_core.fs
// Light data structures, access functions, and utility functions

import {
	Fn, wgslFn,
	vec2,
	vec3,
	float,
	int,
	If,
	dot,
	normalize,
	cross,
	length,
	abs,
	select,
	clamp,
	max,
	min,
	mix,
	tan,
	acos,
	atan,
	texture,
} from 'three/tsl';

import { struct } from './patches.js';

// ================================================================================
// LIGHT STRUCTURES
// ================================================================================

export const DirectionalLight = struct( {
	direction: 'vec3',
	color: 'vec3',
	intensity: 'float',
	angle: 'float', // Angular diameter in radians
	goboIndex: 'int', // -1 = no gobo, otherwise index into goboMaps array
	goboIntensity: 'float', // signed: negative = inverted, |value| = strength
	goboScale: 'float', // world units per gobo tile (used by directional projection)
} );

export const AreaLight = struct( {
	position: 'vec3',
	u: 'vec3', // First axis half-vector of the rectangular light
	v: 'vec3', // Second axis half-vector of the rectangular light
	color: 'vec3',
	intensity: 'float', // radiant power (Watts), Blender-style
	normalize: 'float', // 1 = power normalized over area (radiance ∝ 1/area), 0 = constant radiance
	spread: 'float', // emission cone half-fan in radians, π = full Lambertian hemisphere
	shape: 'float', // 0 = rectangle, 1 = disk/ellipse
	normal: 'vec3', // derived
	area: 'float', // derived (true world area: rect = w·h, ellipse = π/4·w·h)
} );

export const PointLight = struct( {
	position: 'vec3',
	color: 'vec3',
	intensity: 'float',
	distance: 'float', // cutoff distance (0 = infinite)
	decay: 'float', // decay exponent (2 = physically correct)
} );

export const SpotLight = struct( {
	position: 'vec3',
	direction: 'vec3',
	color: 'vec3',
	intensity: 'float',
	angle: 'float', // cone half-angle in radians
	penumbra: 'float', // penumbra factor [0,1]
	distance: 'float', // cutoff distance (0 = infinite)
	decay: 'float', // decay exponent (2 = physically correct)
	goboIndex: 'int', // -1 = no gobo, otherwise index into goboMaps array
	goboIntensity: 'float', // mask strength multiplier (0 = no mask, 1 = full mask)
	iesIndex: 'int', // -1 = no IES, otherwise index into iesProfiles array
	iesIntensity: 'float', // blend [0,1] between flat (0) and full IES distribution (1)
} );

export const LightSample = struct( {
	direction: 'vec3',
	emission: 'vec3',
	pdf: 'float',
	distance: 'float',
	lightType: 'int',
	valid: 'bool',
	// Reservoir denominator, carried out so the BSDF-hit MIS partner can rebuild the
	// selection pdf without walking every light buffer a second time.
	selectionTotalWeight: 'float',
} );

export const IndirectLightingResult = struct( {
	direction: 'vec3', // Sampled direction for next bounce
	throughput: 'vec3', // Light throughput along this path
	combinedPdf: 'float', // Weighted sum of all strategy PDFs (for NEE↔implicit MIS pairing)
} );

// Light type constants
export const LIGHT_TYPE_DIRECTIONAL = 0;
export const LIGHT_TYPE_AREA = 1;
export const LIGHT_TYPE_POINT = 2;
export const LIGHT_TYPE_SPOT = 3;

// ================================================================================
// LIGHT DATA ACCESS FUNCTIONS
// ================================================================================

export const getDirectionalLight = Fn( ( [ directionalLightsBuffer, index ] ) => {

	const baseIndex = index.mul( 12 );
	return DirectionalLight( {
		direction: normalize( vec3(
			directionalLightsBuffer.element( baseIndex ),
			directionalLightsBuffer.element( baseIndex.add( 1 ) ),
			directionalLightsBuffer.element( baseIndex.add( 2 ) ),
		) ),
		color: vec3(
			directionalLightsBuffer.element( baseIndex.add( 3 ) ),
			directionalLightsBuffer.element( baseIndex.add( 4 ) ),
			directionalLightsBuffer.element( baseIndex.add( 5 ) ),
		),
		intensity: directionalLightsBuffer.element( baseIndex.add( 6 ) ),
		angle: directionalLightsBuffer.element( baseIndex.add( 7 ) ),
		goboIndex: int( directionalLightsBuffer.element( baseIndex.add( 8 ) ) ),
		goboIntensity: directionalLightsBuffer.element( baseIndex.add( 9 ) ),
		goboScale: directionalLightsBuffer.element( baseIndex.add( 10 ) ),
	} );

} );

export const getAreaLight = Fn( ( [ areaLightsBuffer, index ] ) => {

	const baseIndex = index.mul( 16 );
	const u = vec3(
		areaLightsBuffer.element( baseIndex.add( 3 ) ),
		areaLightsBuffer.element( baseIndex.add( 4 ) ),
		areaLightsBuffer.element( baseIndex.add( 5 ) ),
	).toVar();
	const v = vec3(
		areaLightsBuffer.element( baseIndex.add( 6 ) ),
		areaLightsBuffer.element( baseIndex.add( 7 ) ),
		areaLightsBuffer.element( baseIndex.add( 8 ) ),
	).toVar();

	const crossUV = cross( u, v );
	const shape = areaLightsBuffer.element( baseIndex.add( 15 ) );

	// u,v are half-vectors → full rectangle area = 4·|u×v|; disk/ellipse = π/4 of that.
	const rectArea = length( crossUV ).mul( 4.0 );

	return AreaLight( {
		position: vec3(
			areaLightsBuffer.element( baseIndex ),
			areaLightsBuffer.element( baseIndex.add( 1 ) ),
			areaLightsBuffer.element( baseIndex.add( 2 ) ),
		),
		u: u,
		v: v,
		color: vec3(
			areaLightsBuffer.element( baseIndex.add( 9 ) ),
			areaLightsBuffer.element( baseIndex.add( 10 ) ),
			areaLightsBuffer.element( baseIndex.add( 11 ) ),
		),
		intensity: areaLightsBuffer.element( baseIndex.add( 12 ) ),
		normalize: areaLightsBuffer.element( baseIndex.add( 13 ) ),
		spread: areaLightsBuffer.element( baseIndex.add( 14 ) ),
		shape: shape,
		normal: normalize( crossUV ),
		area: select( shape.greaterThan( 0.5 ), rectArea.mul( 0.7853981633974483 ), rectArea ),
	} );

} );

export const getPointLight = Fn( ( [ pointLightsBuffer, index ] ) => {

	const baseIndex = index.mul( 9 );
	return PointLight( {
		position: vec3(
			pointLightsBuffer.element( baseIndex ),
			pointLightsBuffer.element( baseIndex.add( 1 ) ),
			pointLightsBuffer.element( baseIndex.add( 2 ) ),
		),
		color: vec3(
			pointLightsBuffer.element( baseIndex.add( 3 ) ),
			pointLightsBuffer.element( baseIndex.add( 4 ) ),
			pointLightsBuffer.element( baseIndex.add( 5 ) ),
		),
		intensity: pointLightsBuffer.element( baseIndex.add( 6 ) ),
		distance: pointLightsBuffer.element( baseIndex.add( 7 ) ),
		decay: pointLightsBuffer.element( baseIndex.add( 8 ) ),
	} );

} );

export const getSpotLight = Fn( ( [ spotLightsBuffer, index ] ) => {

	const baseIndex = index.mul( 20 );
	return SpotLight( {
		position: vec3(
			spotLightsBuffer.element( baseIndex ),
			spotLightsBuffer.element( baseIndex.add( 1 ) ),
			spotLightsBuffer.element( baseIndex.add( 2 ) ),
		),
		direction: normalize( vec3(
			spotLightsBuffer.element( baseIndex.add( 3 ) ),
			spotLightsBuffer.element( baseIndex.add( 4 ) ),
			spotLightsBuffer.element( baseIndex.add( 5 ) ),
		) ),
		color: vec3(
			spotLightsBuffer.element( baseIndex.add( 6 ) ),
			spotLightsBuffer.element( baseIndex.add( 7 ) ),
			spotLightsBuffer.element( baseIndex.add( 8 ) ),
		),
		intensity: spotLightsBuffer.element( baseIndex.add( 9 ) ),
		angle: spotLightsBuffer.element( baseIndex.add( 10 ) ),
		penumbra: spotLightsBuffer.element( baseIndex.add( 11 ) ),
		distance: spotLightsBuffer.element( baseIndex.add( 12 ) ),
		decay: spotLightsBuffer.element( baseIndex.add( 13 ) ),
		goboIndex: int( spotLightsBuffer.element( baseIndex.add( 14 ) ) ),
		goboIntensity: spotLightsBuffer.element( baseIndex.add( 15 ) ),
		iesIndex: int( spotLightsBuffer.element( baseIndex.add( 16 ) ) ),
		iesIntensity: spotLightsBuffer.element( baseIndex.add( 17 ) ),
		// slots 18, 19 reserved (vec4 padding)
	} );

} );

// ================================================================================
// UTILITY FUNCTIONS
// ================================================================================

// Utility function to validate ray direction
export const isDirectionValid = /*@__PURE__*/ wgslFn( `
	fn isDirectionValid( direction: vec3f, surfaceNormal: vec3f ) -> bool {
		return dot( direction, surfaceNormal ) > 0.0f;
	}
` );

// Distance attenuation based on Frostbite PBR. Integer exponents factored as
// repeated multiplies — pow(x, 4) and pow(x, 2) are far cheaper this way.
export const getDistanceAttenuation = /*@__PURE__*/ wgslFn( `
	fn getDistanceAttenuation( lightDistance: f32, cutoffDistance: f32, decayExponent: f32 ) -> f32 {
		var distanceFalloff = 1.0f / max( pow( lightDistance, decayExponent ), 0.01f );
		if ( cutoffDistance > 0.0f ) {
			let r = lightDistance / cutoffDistance;
			let r2 = r * r;
			let ratio = r2 * r2;
			let window = clamp( 1.0f - ratio, 0.0f, 1.0f );
			distanceFalloff *= window * window;
		}
		return distanceFalloff;
	}
` );

// Spot light attenuation
export const getSpotAttenuation = /*@__PURE__*/ wgslFn( `
	fn getSpotAttenuation( coneCosine: f32, penumbraCosine: f32, angleCosine: f32 ) -> f32 {
		return smoothstep( coneCosine, penumbraCosine, angleCosine );
	}
` );


// ================================================================================
// SPOT LIGHT GOBO (PROJECTION MASK) SAMPLING
// ================================================================================

// Module-level state for spot light gobo masks.
// Set by ShaderBuilder before graph construction.
let _goboMapsTexNode = null;

/**
 * Set the DataArrayTexture node used to sample spot light gobo masks.
 * Must be called before the shader graph is constructed.
 * @param {TextureNode} node - TSL texture node for the gobo DataArrayTexture
 */
export function setGoboMapsTexture( node ) {

	_goboMapsTexNode = node;

}

// Sample a spot light's gobo mask. Returns 1.0 if no gobo assigned.
// Projects the surface direction onto a plane perpendicular to the light's
// forward axis at unit distance; cone edge maps to UV ±0.5 around centre.
//
// `lightDir` = unit direction from surface TO light (matches `LightSample.direction`).
export const sampleSpotGoboMask = /*@__PURE__*/ Fn( ( [ light, lightDir ] ) => {

	const mask = float( 1.0 ).toVar();

	If( light.goboIndex.greaterThanEqual( int( 0 ) ), () => {

		const forward = light.direction.toVar();
		const toSurface = lightDir.negate().toVar();
		const cosAlpha = dot( toSurface, forward ).toVar();

		If( cosAlpha.greaterThan( 0.0 ), () => {

			// Orthonormal basis around forward axis
			const up = select(
				abs( forward.z ).lessThan( 0.999 ),
				vec3( 0.0, 0.0, 1.0 ),
				vec3( 1.0, 0.0, 0.0 ),
			);
			const T = normalize( cross( up, forward ) ).toVar();
			const B = cross( forward, T );

			// Project onto plane perpendicular to forward at distance 1
			const invCos = float( 1.0 ).div( cosAlpha ).toVar();
			const px = dot( toSurface, T ).mul( invCos );
			const py = dot( toSurface, B ).mul( invCos );

			// Cone edge → ±tan(angle); map to UV [0,1]
			const invTan = float( 0.5 ).div( max( tan( light.angle ), float( 1e-4 ) ) ).toVar();
			const u = clamp( px.mul( invTan ).add( 0.5 ), float( 0.0 ), float( 1.0 ) );
			const v = clamp( py.mul( invTan ).add( 0.5 ), float( 0.0 ), float( 1.0 ) );

			if ( _goboMapsTexNode ) {

				// Sample min(.r, .a) so masks encoded in either RGB-luminance
				// or alpha (Kenney's "Transparent" variants store the shape in alpha
				// with RGB=white) both produce the expected result.
				// Sign of goboIntensity encodes inversion: negative = inverted, |value| = strength.
				const tex = texture( _goboMapsTexNode, vec2( u, v ) ).depth( light.goboIndex );
				const sample = min( tex.r, tex.a );
				const inverted = light.goboIntensity.lessThan( 0.0 );
				const effective = select( inverted, float( 1.0 ).sub( sample ), sample );
				const strength = clamp( abs( light.goboIntensity ), float( 0.0 ), float( 1.0 ) );
				mask.assign( mix( float( 1.0 ), effective, strength ) );

			}

		} ).Else( () => {

			// Behind the light — emit zero so back-hemisphere is dark.
			mask.assign( 0.0 );

		} );

	} );

	return mask;

} );

// Sample a directional light's gobo mask. Returns 1.0 if no gobo assigned.
// Projects the shading point onto a plane perpendicular to the light direction;
// the mask is tiled at `light.goboScale` world units per tile so a single mask
// can cover any scene size by adjusting the scale.
//
// `surfacePoint` = world-space position of the surface being shaded.
export const sampleDirectionalGoboMask = /*@__PURE__*/ Fn( ( [ light, surfacePoint ] ) => {

	const mask = float( 1.0 ).toVar();

	If( light.goboIndex.greaterThanEqual( int( 0 ) ), () => {

		// `light.direction` in this engine points FROM target TOWARD the light.
		// Project surface point onto plane perpendicular to that axis.
		const axis = light.direction.toVar();

		const up = select(
			abs( axis.z ).lessThan( 0.999 ),
			vec3( 0.0, 0.0, 1.0 ),
			vec3( 1.0, 0.0, 0.0 ),
		);
		const T = normalize( cross( up, axis ) ).toVar();
		const B = cross( axis, T );

		const invScale = float( 1.0 ).div( max( light.goboScale, float( 1e-4 ) ) ).toVar();
		const u = dot( surfacePoint, T ).mul( invScale ).add( 0.5 ).toVar();
		const v = dot( surfacePoint, B ).mul( invScale ).add( 0.5 ).toVar();

		// Tile by fract so a single mask can cover any scene size.
		const uTiled = u.sub( u.floor() );
		const vTiled = v.sub( v.floor() );

		if ( _goboMapsTexNode ) {

			const tex = texture( _goboMapsTexNode, vec2( uTiled, vTiled ) ).depth( light.goboIndex );
			const sample = min( tex.r, tex.a );
			const inverted = light.goboIntensity.lessThan( 0.0 );
			const effective = select( inverted, float( 1.0 ).sub( sample ), sample );
			const strength = clamp( abs( light.goboIntensity ), float( 0.0 ), float( 1.0 ) );
			mask.assign( mix( float( 1.0 ), effective, strength ) );

		}

	} );

	return mask;

} );

// ================================================================================
// IES PROFILE (PHOTOMETRIC INTENSITY) SAMPLING
// ================================================================================

// Module-level texture node for IES profile DataArrayTexture.
// Set by ShaderBuilder before graph construction.
let _iesProfilesTexNode = null;

/**
 * Bind the DataArrayTexture node carrying all loaded IES profiles.
 * @param {TextureNode} node
 */
export function setIESProfilesTexture( node ) {

	_iesProfilesTexNode = node;

}

// Sample a spot light's IES profile. Returns a normalized multiplier in [0,1]
// (or 1.0 if no profile assigned).
//
// IES texture layout: U = horizontal angle (0..360°), V = vertical angle (0..180°)
// where V=0 is along the light's "forward" axis (the spot's direction).
//
// `lightDir` = unit direction from surface TO light (matches LightSample.direction).
export const sampleIESProfile = /*@__PURE__*/ Fn( ( [ light, lightDir ] ) => {

	const result = float( 1.0 ).toVar();

	If( light.iesIndex.greaterThanEqual( int( 0 ) ), () => {

		const forward = light.direction.toVar();
		const toSurface = lightDir.negate().toVar();

		// Vertical angle: between forward axis and emission direction. 0 = on axis (V=0),
		// PI = anti-axis (V=1).
		const cosV = clamp( dot( toSurface, forward ), float( - 1.0 ), float( 1.0 ) );
		const vAngle = acos( cosV );
		const v = clamp( vAngle.div( float( Math.PI ) ), float( 0.0 ), float( 1.0 ) );

		// Horizontal angle: project emission direction onto plane perpendicular to forward.
		const up = select(
			abs( forward.z ).lessThan( 0.999 ),
			vec3( 0.0, 0.0, 1.0 ),
			vec3( 1.0, 0.0, 0.0 ),
		);
		const T = normalize( cross( up, forward ) ).toVar();
		const B = cross( forward, T );

		const px = dot( toSurface, T );
		const py = dot( toSurface, B );
		// atan2 → [-PI, PI]; remap to [0, 2PI] then to [0, 1].
		const phi = atan( py, px );
		const u = phi.div( float( 2.0 * Math.PI ) ).add( 0.5 );

		if ( _iesProfilesTexNode ) {

			const sample = texture( _iesProfilesTexNode, vec2( u, v ) ).depth( light.iesIndex ).r;
			// Blend between flat (1.0) and full profile by iesIntensity.
			const strength = clamp( light.iesIntensity, float( 0.0 ), float( 1.0 ) );
			result.assign( mix( float( 1.0 ), sample, strength ) );

		}

	} );

	return result;

} );

// ================================================================================
// CONE SAMPLING FOR SOFT DIRECTIONAL SHADOWS
// ================================================================================

export const sampleCone = /*@__PURE__*/ wgslFn( `
	fn sampleCone( direction: vec3f, halfAngle: f32, xi: vec2f ) -> vec3f {
		let cosHalfAngle = cos( halfAngle );
		let cosTheta = cosHalfAngle + xi.x * ( 1.0f - cosHalfAngle );
		let sinTheta = sqrt( 1.0f - cosTheta * cosTheta );
		let phi = 6.28318530717958647692f * xi.y;
		// Create local coordinate system
		let up = select( vec3f( 1.0f, 0.0f, 0.0f ), vec3f( 0.0f, 0.0f, 1.0f ), abs( direction.z ) < 0.999f );
		let tangent = normalize( cross( up, direction ) );
		let bitangent = cross( direction, tangent );
		// Convert to world space
		let localDir = vec3f( sinTheta * cos( phi ), sinTheta * sin( phi ), cosTheta );
		return normalize( tangent * localDir.x + bitangent * localDir.y + direction * localDir.z );
	}
` );

// ================================================================================
// AREA LIGHT INTERSECTION TEST
// ================================================================================

// Returns float: t distance if hit, -1.0 if no hit
export const intersectAreaLight = Fn( ( [ light, rayOrigin, rayDirection ] ) => {

	const normal = light.normal;
	const denom = dot( normal, rayDirection );

	const result = float( - 1.0 ).toVar();

	// Quick rejection (backface culling and near-parallel rays)
	If( denom.lessThan( - 0.0001 ), () => {

		const invDenom = float( 1.0 ).div( denom );
		const t = dot( light.position.sub( rayOrigin ), normal ).mul( invDenom ).toVar();

		// Skip intersections behind the ray
		If( t.greaterThan( 0.001 ), () => {

			// Optimized rectangle test using vector rejection
			const hitPoint = rayOrigin.add( rayDirection.mul( t ) );
			const localPoint = hitPoint.sub( light.position );

			// Normalized u/v directions
			const uLen = length( light.u );
			const vLen = length( light.v );
			const u_dir = light.u.div( uLen );
			const v_dir = light.v.div( vLen );

			// Project onto axes, normalized to [-1,1] across the half-extents
			const u_proj = dot( localPoint, u_dir ).div( uLen );
			const v_proj = dot( localPoint, v_dir ).div( vLen );

			// Rectangle: |u|≤1 ∧ |v|≤1.  Disk/ellipse: u²+v²≤1.
			const inside = select(
				light.shape.greaterThan( 0.5 ),
				u_proj.mul( u_proj ).add( v_proj.mul( v_proj ) ).lessThanEqual( 1.0 ),
				abs( u_proj ).lessThanEqual( 1.0 ).and( abs( v_proj ).lessThanEqual( 1.0 ) ),
			);

			If( inside, () => {

				result.assign( t );

			} );

		} );

	} );

	return result;

} );

// ================================================================================
// SPHERICAL RECTANGLE SAMPLING (Ureña et al. 2013, "An Area-Preserving
// Parametrization for Spherical Rectangles"). Same scheme Cycles uses for rect
// area lights — samples the light's solid angle directly, giving pdf = 1/S in
// solid-angle measure (much lower variance than uniform-area sampling for
// large/near lights). Inputs:
//   o  = shading point (ray origin)
//   s  = rectangle corner = center - u - v
//   ex = full edge vector along u (= 2·u)
//   ey = full edge vector along v (= 2·v)
// ================================================================================

// Solid angle S subtended by the rectangle from o (used for the BSDF-hit MIS pdf).
export const sphQuadSolidAngle = /*@__PURE__*/ wgslFn( `
	fn sphQuadSolidAngle( o: vec3f, s: vec3f, ex: vec3f, ey: vec3f ) -> f32 {
		let PI = 3.141592653589793f;
		let exl = length( ex );
		let eyl = length( ey );
		let x = ex / max( exl, 1e-12f );
		let y = ey / max( eyl, 1e-12f );
		var z = cross( x, y );
		let d = s - o;
		var z0 = dot( d, z );
		if ( z0 > 0.0f ) { z = -z; z0 = -z0; }
		let x0 = dot( d, x );
		let y0 = dot( d, y );
		let x1 = x0 + exl;
		let y1 = y0 + eyl;
		let v00 = vec3f( x0, y0, z0 );
		let v01 = vec3f( x0, y1, z0 );
		let v10 = vec3f( x1, y0, z0 );
		let v11 = vec3f( x1, y1, z0 );
		let n0 = normalize( cross( v00, v10 ) );
		let n1 = normalize( cross( v10, v11 ) );
		let n2 = normalize( cross( v11, v01 ) );
		let n3 = normalize( cross( v01, v00 ) );
		let g0 = acos( clamp( -dot( n0, n1 ), -1.0f, 1.0f ) );
		let g1 = acos( clamp( -dot( n1, n2 ), -1.0f, 1.0f ) );
		let g2 = acos( clamp( -dot( n2, n3 ), -1.0f, 1.0f ) );
		let g3 = acos( clamp( -dot( n3, n0 ), -1.0f, 1.0f ) );
		return g0 + g1 + g2 + g3 - 2.0f * PI;
	}
` );

// Sample a direction toward the rectangle uniformly in solid angle.
// Returns vec4( pointOnRect.xyz, pdf ); pdf = 1/S. pdf <= 0 signals the caller
// to fall back to uniform-area sampling (degenerate / tiny solid angle).
export const sampleSphQuad = /*@__PURE__*/ wgslFn( `
	fn sampleSphQuad( o: vec3f, s: vec3f, ex: vec3f, ey: vec3f, uv: vec2f ) -> vec4f {
		let PI = 3.141592653589793f;
		let exl = length( ex );
		let eyl = length( ey );
		let x = ex / max( exl, 1e-12f );
		let y = ey / max( eyl, 1e-12f );
		var z = cross( x, y );
		let d = s - o;
		var z0 = dot( d, z );
		if ( z0 > 0.0f ) { z = -z; z0 = -z0; }
		let z0sq = z0 * z0;
		let x0 = dot( d, x );
		let y0 = dot( d, y );
		let x1 = x0 + exl;
		let y1 = y0 + eyl;
		let y0sq = y0 * y0;
		let y1sq = y1 * y1;
		let v00 = vec3f( x0, y0, z0 );
		let v01 = vec3f( x0, y1, z0 );
		let v10 = vec3f( x1, y0, z0 );
		let v11 = vec3f( x1, y1, z0 );
		let n0 = normalize( cross( v00, v10 ) );
		let n1 = normalize( cross( v10, v11 ) );
		let n2 = normalize( cross( v11, v01 ) );
		let n3 = normalize( cross( v01, v00 ) );
		let g0 = acos( clamp( -dot( n0, n1 ), -1.0f, 1.0f ) );
		let g1 = acos( clamp( -dot( n1, n2 ), -1.0f, 1.0f ) );
		let g2 = acos( clamp( -dot( n2, n3 ), -1.0f, 1.0f ) );
		let g3 = acos( clamp( -dot( n3, n0 ), -1.0f, 1.0f ) );
		let b0 = n0.z;
		let b1 = n2.z;
		let b0sq = b0 * b0;
		let k = 2.0f * PI - g2 - g3;
		let S = g0 + g1 + g2 + g3 - 2.0f * PI;

		if ( S <= 1e-5f ) {
			return vec4f( 0.0f, 0.0f, 0.0f, -1.0f );
		}

		let au = uv.x * S + k;
		let sinAu = sin( au );
		let fu = ( cos( au ) * b0 - b1 ) / max( abs( sinAu ), 1e-7f ) * sign( sinAu );
		var cu = select( -1.0f, 1.0f, fu >= 0.0f ) / sqrt( fu * fu + b0sq );
		cu = clamp( cu, -1.0f, 1.0f );

		var xu = -( cu * z0 ) / max( sqrt( 1.0f - cu * cu ), 1e-7f );
		xu = clamp( xu, x0, x1 );

		let dd = sqrt( xu * xu + z0sq );
		let h0 = y0 / sqrt( dd * dd + y0sq );
		let h1 = y1 / sqrt( dd * dd + y1sq );
		let hv = h0 + uv.y * ( h1 - h0 );
		let hv2 = hv * hv;
		var yv = y1;
		if ( hv2 < 1.0f - 1e-6f ) {
			yv = ( hv * dd ) / sqrt( 1.0f - hv2 );
		}

		let p = o + xu * x + yv * y + z0 * z;
		return vec4f( p, 1.0f / S );
	}
` );

