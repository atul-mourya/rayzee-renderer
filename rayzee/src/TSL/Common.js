import { Fn, wgslFn, float, vec2, vec3, vec4, int, mat3, If, max, dot, clamp } from 'three/tsl';

import {
	AnisoFrame,
	DotProducts,
	MaterialClassification,
	RayTracingMaterial,
	ShadowMaterial,
} from './Struct.js';

export const PI = 3.14159;
export const PI_INV = 1.0 / PI;
export const TWO_PI = 2.0 * PI;
export const EPSILON = 1e-6;
export const MIN_ROUGHNESS = 0.05;
export const MIN_CLEARCOAT_ROUGHNESS = 0.089;
export const MAX_ROUGHNESS = 1.0;
export const MIN_PDF = 0.001;
export const REC709_LUMINANCE_COEFFICIENTS = vec3( 0.2126, 0.7152, 0.0722 );
import { MATERIAL_DATA_LAYOUT } from '../EngineDefaults.js';

export const MATERIAL_SLOTS = MATERIAL_DATA_LAYOUT.SLOTS_PER_MATERIAL;
export const MATERIAL_SLOT = MATERIAL_DATA_LAYOUT.SLOT;
const S = MATERIAL_SLOT;

// XYZ to sRGB color space conversion matrix
export const XYZ_TO_REC709 = mat3(
	3.2404542, - 0.9692660, 0.0556434,
	- 1.5371385, 1.8760108, - 0.2040259,
	- 0.4985314, 0.0415560, 1.0572252
);

export const sRGBToLinear = wgslFn( `
	fn sRGBToLinear( srgbColor: vec3f ) -> vec3f {

		return pow( srgbColor, vec3f( 2.2 ) );

	}
` );

export const gammaCorrection = wgslFn( `
	fn gammaCorrection( color: vec3f ) -> vec3f {

		return pow( color, vec3f( 1.0 / 2.2 ) );

	}
` );

export const square = wgslFn( `
	fn square( x: f32 ) -> f32 {

		return x * x;

	}
` );

export const squareVec3 = wgslFn( `
	fn squareVec3( x: vec3f ) -> vec3f {

		return x * x;

	}
` );

// Get maximum component of a vector
export const maxComponent = wgslFn( `
	fn maxComponent( v: vec3f ) -> f32 {

		return max( max( v.r, v.g ), v.b );

	}
` );

// Get minimum component of a vector
export const minComponent = wgslFn( `
	fn minComponent( v: vec3f ) -> f32 {

		return min( min( v.r, v.g ), v.b );

	}
` );

export const luminance = wgslFn( `
	fn luminance( color: vec3f ) -> f32 {

		return dot( color, vec3f( 0.2126, 0.7152, 0.0722 ) );

	}
` );

// Power heuristic for multiple importance sampling (balance heuristic, power=2)
export const powerHeuristic = wgslFn( `
	fn powerHeuristic( pdf1: f32, pdf2: f32 ) -> f32 {

		let p1 = pdf1 * pdf1;
		let p2 = pdf2 * pdf2;
		return p1 / max( p1 + p2, ${MIN_PDF} );

	}
` );

// Balance heuristic — optimal for MIS-compensated env map sampling (Karlík et al. 2019)
export const balanceHeuristic = wgslFn( `
	fn balanceHeuristic( pdf1: f32, pdf2: f32 ) -> f32 {

		return pdf1 / max( pdf1 + pdf2, ${MIN_PDF} );

	}
` );

// Bayer matrix 4x4 dithering — exact port of GLSL
export const applyDithering = wgslFn( `
	fn applyDithering( color: vec3f, uv: vec2f, ditheringAmount: f32, resolution: vec2f ) -> vec3f {

		let bayerRow0 = vec4f( 0.0 / 16.0, 8.0 / 16.0, 2.0 / 16.0, 10.0 / 16.0 );
		let bayerRow1 = vec4f( 12.0 / 16.0, 4.0 / 16.0, 14.0 / 16.0, 6.0 / 16.0 );
		let bayerRow2 = vec4f( 3.0 / 16.0, 11.0 / 16.0, 1.0 / 16.0, 9.0 / 16.0 );
		let bayerRow3 = vec4f( 15.0 / 16.0, 7.0 / 16.0, 13.0 / 16.0, 5.0 / 16.0 );
		let bayer = mat4x4f( bayerRow0, bayerRow1, bayerRow2, bayerRow3 );

		let pixelCoord = vec2i( uv * resolution );
		let dither = bayer[ pixelCoord.x % 4 ][ pixelCoord.y % 4 ];

		return color + ( dither - 0.5 ) * ditheringAmount / 255.0;

	}
` );

// Construct tangent-bitangent-normal matrix — exact port of GLSL
export const constructTBN = wgslFn( `
	fn constructTBN( N: vec3f ) -> mat3x3f {

		var majorAxis: vec3f;
		if ( abs( N.x ) < 0.999 ) {
			majorAxis = vec3f( 1.0, 0.0, 0.0 );
		} else {
			majorAxis = vec3f( 0.0, 1.0, 0.0 );
		}
		let T = normalize( cross( N, majorAxis ) );
		let B = normalize( cross( N, T ) );
		return mat3x3f( T, B, N );

	}
` );

export const computeDotProducts = Fn( ( [ N, V, L ] ) => {

	const H = V.add( L ).toVar();
	const lenSq = dot( H, H ).toVar();
	H.assign( lenSq.greaterThan( EPSILON ).select( H.div( lenSq.sqrt() ), vec3( 0.0, 0.0, 1.0 ) ) );

	return DotProducts( {
		NoL: max( dot( N, L ), 0.001 ),
		NoV: max( dot( N, V ), 0.001 ),
		NoH: max( dot( N, H ), 0.001 ),
		VoH: max( dot( V, H ), 0.001 ),
		LoH: max( dot( L, H ), 0.001 ),
		ToH: float( 0.0 ), BoH: float( 0.0 ),
		ToV: float( 0.0 ), BoV: float( 0.0 ),
		ToL: float( 0.0 ), BoL: float( 0.0 ),
	} );

} );

// Anisotropy tangent frame: arbitrary ONB from N (matching constructTBN + normal mapping),
// rotated by anisotropyRotation. Single source of truth for sampler AND eval/PDF so their
// frames are bit-identical (required for MIS consistency).
export const anisoTangentFrame = Fn( ( [ N, rotation ] ) => {

	const majorAxis = N.x.abs().lessThan( 0.999 ).select( vec3( 1.0, 0.0, 0.0 ), vec3( 0.0, 1.0, 0.0 ) );
	const T0 = N.cross( majorAxis ).normalize();
	const B0 = N.cross( T0 ).normalize();
	const c = rotation.cos();
	const s = rotation.sin();
	return AnisoFrame( { Ta: T0.mul( c ).add( B0.mul( s ) ), Ba: B0.mul( c ).sub( T0.mul( s ) ) } );

} );

// Anisotropy-aware dot products: computeDotProducts + tangent-frame projections of H/V/L
// (0 for isotropic materials, so aniso branches gated on anisotropy>0 are a no-op).
export const computeDotProductsAniso = Fn( ( [ N, V, L, material ] ) => {

	const H = V.add( L ).toVar();
	const lenSq = dot( H, H ).toVar();
	H.assign( lenSq.greaterThan( EPSILON ).select( H.div( lenSq.sqrt() ), vec3( 0.0, 0.0, 1.0 ) ) );

	const ToH = float( 0.0 ).toVar();
	const BoH = float( 0.0 ).toVar();
	const ToV = float( 0.0 ).toVar();
	const BoV = float( 0.0 ).toVar();
	const ToL = float( 0.0 ).toVar();
	const BoL = float( 0.0 ).toVar();

	If( material.anisotropy.greaterThan( 0.0 ), () => {

		const f = AnisoFrame.wrap( anisoTangentFrame( N, material.anisotropyRotation ) );
		ToH.assign( dot( f.Ta, H ) ); BoH.assign( dot( f.Ba, H ) );
		ToV.assign( dot( f.Ta, V ) ); BoV.assign( dot( f.Ba, V ) );
		ToL.assign( dot( f.Ta, L ) ); BoL.assign( dot( f.Ba, L ) );

	} );

	return DotProducts( {
		NoL: max( dot( N, L ), 0.001 ),
		NoV: max( dot( N, V ), 0.001 ),
		NoH: max( dot( N, H ), 0.001 ),
		VoH: max( dot( V, H ), 0.001 ),
		LoH: max( dot( L, H ), 0.001 ),
		ToH, BoH, ToV, BoV, ToL, BoL,
	} );

} );

export const calculateFireflyThreshold = wgslFn( `
	fn calculateFireflyThreshold( baseThreshold: f32, bounceIndex: i32, frame: i32 ) -> f32 {

		let depthFactor = 1.0 / ( 1.0 + f32( bounceIndex ) * 0.1 );
		let relaxation = sqrt( f32( frame + 1 ) );
		return baseThreshold * depthFactor * relaxation;

	}
` );

// Apply soft suppression to prevent harsh clipping — exact port of GLSL
export const applySoftSuppression = wgslFn( `
	fn applySoftSuppression( value: f32, threshold: f32, dampingFactor: f32 ) -> f32 {

		if ( value <= threshold ) {
			return value;
		}
		let excess = value - threshold;
		let suppressionFactor = threshold / ( threshold + excess * dampingFactor );
		return value * suppressionFactor;

	}
` );

// Apply soft suppression to RGB color while preserving hue — exact port of GLSL
export const applySoftSuppressionRGB = wgslFn( `
	fn applySoftSuppressionRGB( color: vec3f, threshold: f32, dampingFactor: f32 ) -> vec3f {

		let lum = dot( color, vec3f( 0.2126, 0.7152, 0.0722 ) );
		if ( lum <= threshold ) {
			return color;
		}
		let suppressedLum = applySoftSuppression( lum, threshold, dampingFactor );
		if ( lum > ${EPSILON} ) {
			return color * ( suppressedLum / lum );
		}
		return color;

	}
`, [ applySoftSuppression ] );

// Pre-computed material classification for faster branching
export const classifyMaterial = Fn( ( [ metalness, roughness, transmission, clearcoat, emissive, subsurface ] ) => {

	const isMetallic = metalness.greaterThan( 0.7 ).toVar();
	const isRough = roughness.greaterThan( 0.8 );
	const isSmooth = roughness.lessThan( 0.3 ).toVar();
	const isTransmissive = transmission.greaterThan( 0.5 ).toVar();
	const hasClearcoat = clearcoat.greaterThan( 0.5 ).toVar();
	const isSubsurface = subsurface.greaterThan( 0.0 ); // only feeds complexityScore below

	// Fast emissive check using sum
	const emissiveMag = emissive.x.add( emissive.y ).add( emissive.z );
	const isEmissive = emissiveMag.greaterThan( 0.0 ).toVar();

	// Enhanced complexity score with better material importance weighting
	const baseComplexity = float( 0.15 ).mul( float( isMetallic ) )
		.add( float( 0.25 ).mul( float( isSmooth ) ) )
		.add( float( 0.45 ).mul( float( isTransmissive ) ) )
		.add( float( 0.35 ).mul( float( hasClearcoat ) ) )
		.add( float( 0.3 ).mul( float( isEmissive ) ) )
		.add( float( 0.4 ).mul( float( isSubsurface ) ) ); // SSS walks are deep + high-value → keep alive in RR

	// Add material interaction complexity
	const interactionComplexity = float( 0.0 ).toVar();
	If( isMetallic.and( isSmooth ), () => {

		interactionComplexity.addAssign( 0.15 );

	} );
	If( isTransmissive.and( hasClearcoat ), () => {

		interactionComplexity.addAssign( 0.2 );

	} );
	If( isEmissive.and( isTransmissive.or( isMetallic ) ), () => {

		interactionComplexity.addAssign( 0.1 );

	} );

	const complexityScore = clamp( baseComplexity.add( interactionComplexity ), 0.0, 1.0 );

	return MaterialClassification( { isMetallic, isRough, isSmooth, isTransmissive, hasClearcoat, isEmissive, complexityScore } );

} );

// Storage buffer access — flat 1D indexing (WebGPU native)
// No 2D coordinate math needed: directly indexes into the buffer
export const getDatafromStorageBuffer = Fn( ( [ buffer, stride, sampleIndex, dataOffset ] ) => {

	const elementIndex = stride.mul( dataOffset ).add( sampleIndex );
	return buffer.element( elementIndex );

} );

// Reconstruct mat3 from two vec4s — exact port of GLSL
export const arrayToMat3 = wgslFn( `
	fn arrayToMat3( data1: vec4f, data2: vec4f ) -> mat3x3f {

		return mat3x3f(
			data1.xyz,
			vec3f( data1.w, data2.xy ),
			vec3f( data2.zw, 1.0 )
		);

	}
` );

export const getMaterial = Fn( ( [ materialIndex, materialBuffer ] ) => {

	const data0 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.COLOR_METALNESS ), int( MATERIAL_SLOTS ) ).toVar();
	const data1 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.EMISSIVE_ROUGHNESS ), int( MATERIAL_SLOTS ) ).toVar();
	const data2 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.IOR_TRANSMISSION ), int( MATERIAL_SLOTS ) ).toVar();
	const data3 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ATTENUATION ), int( MATERIAL_SLOTS ) ).toVar();
	const data4 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.DISPERSION_SHEEN ), int( MATERIAL_SLOTS ) ).toVar();
	const data5 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.SHEEN_COLOR ), int( MATERIAL_SLOTS ) ).toVar();
	const data6 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.SPECULAR ), int( MATERIAL_SLOTS ) ).toVar();
	const data7 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.IRIDESCENCE ), int( MATERIAL_SLOTS ) ).toVar();
	const data8 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.MAP_INDICES_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data9 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.MAP_INDICES_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data10 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.OPACITY_ALPHA ), int( MATERIAL_SLOTS ) ).toVar();
	const data11 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ALPHA_MODE ), int( MATERIAL_SLOTS ) ).toVar();
	const data12 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.BUMP_DISPLACEMENT ), int( MATERIAL_SLOTS ) ).toVar();
	const data13 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ALBEDO_TRANSFORM_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data14 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ALBEDO_TRANSFORM_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data15 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.NORMAL_TRANSFORM_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data16 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.NORMAL_TRANSFORM_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data17 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ROUGHNESS_TRANSFORM_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data18 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ROUGHNESS_TRANSFORM_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data19 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.METALNESS_TRANSFORM_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data20 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.METALNESS_TRANSFORM_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data21 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.EMISSIVE_TRANSFORM_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data22 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.EMISSIVE_TRANSFORM_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data23 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.BUMP_TRANSFORM_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data24 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.BUMP_TRANSFORM_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data25 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.DISPLACEMENT_TRANSFORM_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data26 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.DISPLACEMENT_TRANSFORM_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data27 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.SUBSURFACE_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data28 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.SUBSURFACE_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data29 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.SUBSURFACE_C ), int( MATERIAL_SLOTS ) ).toVar();
	const data30 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.EXT_MAP_INDICES_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data31 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.EXT_MAP_INDICES_B ), int( MATERIAL_SLOTS ) ).toVar();
	const data32 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.EXT_MAP_INDICES_C ), int( MATERIAL_SLOTS ) ).toVar();

	return RayTracingMaterial( {
		color: vec4( data0.rgb, 1.0 ),
		metalness: data0.a,
		emissive: data1.rgb,
		roughness: data1.a,
		ior: data2.r,
		transmission: data2.g,
		thickness: data2.b,
		emissiveIntensity: data2.a,
		attenuationColor: data3.rgb,
		attenuationDistance: data3.a,
		dispersion: data4.r,
		sheen: data4.b,
		sheenRoughness: data4.a,
		sheenColor: data5.rgb,
		specularIntensity: data6.r,
		specularColor: data6.gba,
		iridescence: data7.r,
		iridescenceIOR: data7.g,
		iridescenceThicknessRange: data7.ba,
		subsurfaceColor: data27.rgb,
		subsurface: data27.a,
		subsurfaceRadius: data28.rgb,
		subsurfaceRadiusScale: data28.a,
		subsurfaceAnisotropy: data29.r,
		anisotropy: data29.g,
		anisotropyRotation: data29.b,
		anisotropyMapIndex: int( data29.a ),
		transmissionMapIndex: int( data30.r ),
		clearcoatMapIndex: int( data30.g ),
		clearcoatRoughnessMapIndex: int( data30.b ),
		sheenColorMapIndex: int( data30.a ),
		sheenRoughnessMapIndex: int( data31.r ),
		iridescenceMapIndex: int( data31.g ),
		iridescenceThicknessMapIndex: int( data31.b ),
		specularIntensityMapIndex: int( data31.a ),
		specularColorMapIndex: int( data32.r ),
		albedoMapIndex: int( data8.r ),
		normalMapIndex: int( data8.g ),
		roughnessMapIndex: int( data8.b ),
		metalnessMapIndex: int( data8.a ),
		emissiveMapIndex: int( data9.r ),
		bumpMapIndex: int( data9.g ),
		clearcoat: data9.b,
		clearcoatRoughness: data9.a,
		opacity: data10.r,
		side: int( data10.g ),
		transparent: data10.b,
		alphaTest: data10.a,
		alphaMode: int( data11.r ),
		depthWrite: int( data11.g ),
		normalScale: vec2( data11.b, data11.b ),
		bumpScale: data12.r,
		displacementScale: data12.g,
		displacementMapIndex: int( data12.b ),
		albedoTransform: arrayToMat3( { data1: data13, data2: data14 } ),
		normalTransform: arrayToMat3( { data1: data15, data2: data16 } ),
		roughnessTransform: arrayToMat3( { data1: data17, data2: data18 } ),
		metalnessTransform: arrayToMat3( { data1: data19, data2: data20 } ),
		emissiveTransform: arrayToMat3( { data1: data21, data2: data22 } ),
		bumpTransform: arrayToMat3( { data1: data23, data2: data24 } ),
		displacementTransform: arrayToMat3( { data1: data25, data2: data26 } ),
	} );

} );

// Synthetic diffuse-white material for the analytic ground-plane shadow catcher.
// No geometry/material buffer is involved — the plane is shaded as a matte Lambertian
// so the direct-lighting estimator yields an irradiance-weighted shadow ratio (the
// diffuse BRDF is constant and cancels in shadowed/unoccluded). All fields are set to
// inert defaults; only color/roughness/metalness/transmission affect the lighting path.
export const diffuseGroundMaterial = Fn( () => {

	const idn = mat3( 1, 0, 0, 0, 1, 0, 0, 0, 1 );
	return RayTracingMaterial( {
		color: vec4( 1.0, 1.0, 1.0, 1.0 ),
		emissive: vec3( 0.0 ),
		emissiveIntensity: float( 0.0 ),
		roughness: float( 1.0 ),
		metalness: float( 0.0 ),
		ior: float( 1.5 ),
		transmission: float( 0.0 ),
		thickness: float( 0.0 ),
		clearcoat: float( 0.0 ),
		clearcoatRoughness: float( 0.0 ),
		opacity: float( 1.0 ),
		transparent: float( 0.0 ),
		attenuationColor: vec3( 1.0 ),
		attenuationDistance: float( 0.0 ),
		dispersion: float( 0.0 ),
		sheen: float( 0.0 ),
		sheenRoughness: float( 1.0 ),
		sheenColor: vec3( 0.0 ),
		specularIntensity: float( 1.0 ),
		specularColor: vec3( 1.0 ),
		alphaTest: float( 0.0 ),
		alphaMode: int( 0 ),
		side: int( 0 ),
		depthWrite: int( 1 ),
		albedoMapIndex: int( - 1 ),
		emissiveMapIndex: int( - 1 ),
		normalMapIndex: int( - 1 ),
		bumpMapIndex: int( - 1 ),
		bumpScale: float( 1.0 ),
		displacementScale: float( 0.0 ),
		metalnessMapIndex: int( - 1 ),
		roughnessMapIndex: int( - 1 ),
		displacementMapIndex: int( - 1 ),
		normalScale: vec2( 1.0, 1.0 ),
		albedoTransform: idn,
		emissiveTransform: idn,
		normalTransform: idn,
		bumpTransform: idn,
		metalnessTransform: idn,
		roughnessTransform: idn,
		displacementTransform: idn,
		iridescence: float( 0.0 ),
		iridescenceIOR: float( 1.3 ),
		iridescenceThicknessRange: vec2( 100.0, 400.0 ),
		subsurface: float( 0.0 ),
		subsurfaceColor: vec3( 1.0 ),
		subsurfaceRadius: vec3( 1.0, 0.2, 0.1 ),
		subsurfaceRadiusScale: float( 1.0 ),
		subsurfaceAnisotropy: float( 0.0 ),
		anisotropy: float( 0.0 ),
		anisotropyRotation: float( 0.0 ),
		anisotropyMapIndex: int( - 1 ),
		transmissionMapIndex: int( - 1 ),
		clearcoatMapIndex: int( - 1 ),
		clearcoatRoughnessMapIndex: int( - 1 ),
		sheenColorMapIndex: int( - 1 ),
		sheenRoughnessMapIndex: int( - 1 ),
		iridescenceMapIndex: int( - 1 ),
		iridescenceThicknessMapIndex: int( - 1 ),
		specularIntensityMapIndex: int( - 1 ),
		specularColorMapIndex: int( - 1 ),
	} );

} );

// ── Shadow material thin reader (7 slot reads instead of 27) ─────────────
// Only fetches fields needed by traceShadowRay: alpha, transmission, attenuation, albedo transform.

export const getShadowMaterial = Fn( ( [ materialIndex, materialBuffer ] ) => {

	const data2 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.IOR_TRANSMISSION ), int( MATERIAL_SLOTS ) ).toVar();
	const data3 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ATTENUATION ), int( MATERIAL_SLOTS ) ).toVar();
	const data8 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.MAP_INDICES_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data10 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.OPACITY_ALPHA ), int( MATERIAL_SLOTS ) ).toVar();
	const data11 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ALPHA_MODE ), int( MATERIAL_SLOTS ) ).toVar();
	const data13 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ALBEDO_TRANSFORM_A ), int( MATERIAL_SLOTS ) ).toVar();
	const data14 = getDatafromStorageBuffer( materialBuffer, materialIndex, int( S.ALBEDO_TRANSFORM_B ), int( MATERIAL_SLOTS ) ).toVar();

	return ShadowMaterial( {
		color: vec4( 1.0 ), // Shadow path never samples full textures; color.a is always 1.0
		ior: data2.r,
		transmission: data2.g,
		attenuationColor: data3.rgb,
		attenuationDistance: data3.a,
		albedoMapIndex: int( data8.r ),
		opacity: data10.r,
		transparent: data10.b,
		alphaTest: data10.a,
		alphaMode: int( data11.r ),
		albedoTransform: arrayToMat3( { data1: data13, data2: data14 } ),
	} );

} );
