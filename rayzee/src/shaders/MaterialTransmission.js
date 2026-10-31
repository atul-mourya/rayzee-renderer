// Material Transmission & Refraction - Ported from material_transmission.fs
// Handles both volumetric transmission AND opacity-based transparency

import { Fn, wgslFn, vec3, float, int, bool as tslBool, If, select, abs, dot, reflect, refract, max, mix, clamp, exp, sqrt, normalize } from 'three/tsl';

import { struct } from './Struct.js';
import { EPSILON, MIN_ROUGHNESS, MIN_PDF, constructTBN } from './Common.js';
import { fresnelDielectric } from './Fresnel.js';
import { DistributionGGX, dielectricInterfaceAlbedo } from './MaterialProperties.js';
import { ImportanceSampleGGX, sampleGGXVNDF } from './MaterialSampling.js';
import { getRandomSample1D, getRandomSample2D, pcgHash } from './Random.js';
import { handleSubsurfaceEntry, SubsurfaceEntryResult } from './Subsurface.js';
import { materialLayers } from './SceneResources.js';

// ================================================================================
// STRUCTS (local to transmission)
// ================================================================================

const TransmissionResult = struct( {
	direction: 'vec3', // New ray direction after transmission/reflection
	throughput: 'vec3', // Color throughput including absorption
	didReflect: 'bool', // Whether the ray was reflected instead of transmitted
	pathWavelength: 'float', // 0 if path is not yet spectral, else locked wavelength in nm
} );

export const MaterialInteractionResult = struct( {
	continueRay: 'bool', // Whether the ray should continue without further BRDF evaluation
	isTransmissive: 'bool', // Flag to indicate this was a transmissive interaction
	isAlphaSkip: 'bool', // Flag to indicate this was an alpha skip
	isSubsurface: 'bool', // Flag to indicate this entered/exited a subsurface medium
	didReflect: 'bool', // Whether TIR/reflection occurred (for medium stack update)
	entering: 'bool', // Whether ray is entering or exiting medium
	direction: 'vec3', // New ray direction if continuing
	throughput: 'vec3', // Color modification for the ray
	alpha: 'float', // Alpha modification
	pathWavelength: 'float', // 0 if path is not yet spectral, else locked wavelength in nm
} );

export const Medium = struct( {
	ior: 'float',
	attenuationColor: 'vec3',
	attenuationDistance: 'float',
	dispersion: 'float',
} );

const SpectralSample = struct( {
	wavelength: 'float', // Wavelength in nanometers
	ior: 'float', // IOR at this wavelength
	colorWeight: 'vec3', // Color contribution weight
} );

export const MicrofacetTransmissionResult = struct( {
	direction: 'vec3', // Refracted/reflected direction
	halfVector: 'vec3', // Sampled half-vector
	didReflect: 'bool', // Whether TIR occurred
	pdf: 'float', // PDF of the sampled direction
	colorWeight: 'vec3', // Spectral tint to apply once; vec3(1) if locked or non-dispersive
	pathWavelength: 'float', // 0 if path is not yet spectral, else locked wavelength in nm
} );

// ================================================================================
// DISPERSION
// ================================================================================

// Cauchy IOR n(λ) = baseIOR + 0.03·dispersion / λ_µm²
const iorFromWavelength = /*@__PURE__*/ Fn( ( [ baseIOR, dispersionStrength, wavelength ] ) => {

	const wlMicron = wavelength.div( 1000.0 );
	return baseIOR.add( dispersionStrength.mul( 0.03 ).div( wlMicron.mul( wlMicron ) ) );

} );

// Wyman et al. JCGT 2013 piecewise-Gaussian fit to CIE 1931 2° observer
const cieGauss = /*@__PURE__*/ Fn( ( [ x, mu, sigmaLo, sigmaHi ] ) => {

	const sigma = select( x.lessThan( mu ), sigmaLo, sigmaHi );
	const t = x.sub( mu ).mul( sigma );
	return exp( float( - 0.5 ).mul( t ).mul( t ) );

} );

const wavelengthToXYZ = /*@__PURE__*/ Fn( ( [ wl ] ) => {

	const X = cieGauss( wl, 442.0, 0.0624, 0.0374 ).mul( 0.362 )
		.add( cieGauss( wl, 599.8, 0.0264, 0.0323 ).mul( 1.056 ) )
		.sub( cieGauss( wl, 501.1, 0.0490, 0.0382 ).mul( 0.065 ) );
	const Y = cieGauss( wl, 568.8, 0.0213, 0.0247 ).mul( 0.821 )
		.add( cieGauss( wl, 530.9, 0.0613, 0.0322 ).mul( 0.286 ) );
	const Z = cieGauss( wl, 437.0, 0.0845, 0.0278 ).mul( 1.217 )
		.add( cieGauss( wl, 459.0, 0.0385, 0.0725 ).mul( 0.681 ) );
	return vec3( X, Y, Z );

} );

// Sample a wavelength on [380,700]nm and return its IOR + sRGB colorWeight (CIE 1931 →
// sRGB, gamut-clipped). The (1.819, 2.773, 2.928) factors normalize the clipped per-λ
// average to vec3(1), so clear glass converges to white as samples accumulate.
const sampleWavelengthForDispersion = Fn( ( [ baseIOR, dispersionStrength, random ] ) => {

	const wl = mix( float( 380.0 ), float( 700.0 ), random ).toVar();
	const sampledIOR = iorFromWavelength( baseIOR, dispersionStrength, wl );

	const xyz = wavelengthToXYZ( wl ).toVar();
	const rgb = vec3(
		xyz.x.mul( 3.2406 ).sub( xyz.y.mul( 1.5372 ) ).sub( xyz.z.mul( 0.4986 ) ),
		xyz.x.mul( - 0.9689 ).add( xyz.y.mul( 1.8758 ) ).add( xyz.z.mul( 0.0415 ) ),
		xyz.x.mul( 0.0557 ).sub( xyz.y.mul( 0.2040 ) ).add( xyz.z.mul( 1.0570 ) ),
	);

	const colorWeight = max( rgb, vec3( 0.0 ) ).mul( vec3( 1.819, 2.773, 2.928 ) );

	return SpectralSample( {
		wavelength: wl,
		ior: sampledIOR,
		colorWeight: colorWeight,
	} );

} );

// The glass's IOR along the path: at the wavelength the path locked, else at one drawn here, whose tint applies once and
// whose wavelength the path keeps only if it crosses.
const pathIOR = Fn( ( [ ior, dispersion, pathWavelength, rngState, pixelCoord, resolution, frame, dimBase ] ) => {

	const result = SpectralSample( { wavelength: pathWavelength, ior, colorWeight: vec3( 1.0 ) } ).toVar();

	If( dispersion.greaterThan( 0.0 ), () => {

		If( pathWavelength.greaterThan( 0.0 ), () => {

			result.ior.assign( iorFromWavelength( ior, dispersion, pathWavelength ) );

		} ).Else( () => {

			const drawn = SpectralSample.wrap( sampleWavelengthForDispersion( ior, dispersion, getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 5 ) ), rngState, resolution, frame ) ) );
			result.ior.assign( drawn.ior );
			result.colorWeight.assign( drawn.colorWeight );
			result.wavelength.assign( drawn.wavelength );

		} );

	} );

	return result;

} );

// ================================================================================
// ABSORPTION
// ================================================================================

// Beer-Lambert transmittance over pathLength. attenuationDistance <= 0 (or non-finite,
// normalized to 0 by MaterialDataManager) means "no absorption".
export const calculateBeerLawAbsorption = /*@__PURE__*/ wgslFn( `
	fn calculateBeerLawAbsorption( attenuationColor: vec3f, attenuationDistance: f32, pathLength: f32 ) -> vec3f {
		if ( attenuationDistance <= 0.0f ) { return vec3f( 1.0f ); }
		let absorption = -log( max( attenuationColor, vec3f( 0.001f ) ) ) / attenuationDistance;
		return exp( -absorption * pathLength );
	}
` );

// ================================================================================
// MICROFACET TRANSMISSION
// ================================================================================

// The opaque path's transmission lobe: a refraction about a GGX facet (a reflection under total internal reflection).
export const sampleMicrofacetTransmission = Fn( ( [
	V, N, ior, roughness, entering, dispersion, xi, rngState, pathWavelength,
	pixelCoord, resolution, frame, dimBase,
], builder ) => {

	const layers = materialLayers( builder );
	const result = MicrofacetTransmissionResult( {
		direction: vec3( 0.0 ),
		halfVector: vec3( 0.0 ),
		didReflect: false,
		pdf: float( 0.0 ),
		colorWeight: vec3( 1.0 ),
		pathWavelength: pathWavelength,
	} ).toVar();

	const glassIOR = ior.toVar();
	if ( layers.dispersion ) {

		const glass = SpectralSample.wrap( pathIOR( ior, dispersion, pathWavelength, rngState, pixelCoord, resolution, frame, dimBase ) );
		glassIOR.assign( glass.ior );
		result.colorWeight.assign( glass.colorWeight );
		result.pathWavelength.assign( glass.wavelength );

	}

	const etaRatio = select( entering, float( 1.0 ).div( glassIOR ), glassIOR ).toVar();

	const microfacet = () => {

		// Use minimum roughness to avoid numerical issues for rough surfaces
		const transmissionRoughness = max( MIN_ROUGHNESS, roughness );

		// Sample the microfacet normal with GGX distribution
		const H = ImportanceSampleGGX( { N, roughness: transmissionRoughness, Xi: xi } ).toVar();
		result.halfVector.assign( H );

		// HoV and NoH serve both the TIR and the refraction density, as does D.
		const HoV = clamp( dot( H, V ), 0.001, 1.0 ).toVar();
		const NoH = clamp( dot( N, H ), 0.001, 1.0 ).toVar();
		const D = DistributionGGX( NoH, transmissionRoughness ).toVar();
		const refractDir = refract( V.negate(), H, etaRatio ).toVar();

		// Check for total internal reflection
		If( dot( refractDir, refractDir ).lessThan( 0.001 ), () => {

			// TIR occurred, use reflection instead
			result.direction.assign( reflect( V.negate(), H ) );
			result.didReflect.assign( true );

			// Reflection PDF: D(H) * NoH / (4 * VoH) — reuses the hoisted D + dots.
			result.pdf.assign( D.mul( NoH ).div( max( float( 4.0 ).mul( HoV ), MIN_PDF ) ) );

		} ).Else( () => {

			// Successful refraction
			result.direction.assign( refractDir );
			result.didReflect.assign( false );

			const HoL = clamp( dot( H, refractDir ), 0.001, 1.0 );

			// Account for change of measure due to refraction (Jacobian)
			const sqrtDenom = HoV.add( etaRatio.mul( HoL ) );
			const jacobian = abs( HoL ).div( sqrtDenom.mul( sqrtDenom ) );

			// Final PDF for microfacet transmission
			result.pdf.assign( D.mul( NoH ).mul( jacobian ) );

		} );

	};

	// For smooth surfaces with dispersion, use perfect refraction with spectral IOR
	if ( ! layers.dispersion ) microfacet();
	else If( roughness.lessThanEqual( 0.05 ).and( dispersion.greaterThan( 0.0 ) ), () => {

		result.halfVector.assign( N );

		// Perfect refraction using surface normal
		const refractDir = refract( V.negate(), N, etaRatio ).toVar();

		// Check for total internal reflection
		If( dot( refractDir, refractDir ).lessThan( 0.001 ), () => {

			result.direction.assign( reflect( V.negate(), N ) );
			result.didReflect.assign( true );

		} ).Else( () => {

			result.direction.assign( refractDir );

		} );

		result.pdf.assign( 1.0 );

	} ).Else( microfacet );

	return result;

} );

// ================================================================================
// DIELECTRIC INTERFACE
// ================================================================================

export const DielectricSample = struct( {
	direction: 'vec3',
	didReflect: 'bool',
	weight: 'float', // what the drawn lobe carries over its chance; 0 when it leaves on the wrong side of N
} );

// Smith's Λ for GGX at |cos θ| = c, with α² = a2.
const smithLambda = ( c, a2 ) => sqrt( a2.add( float( 1.0 ).sub( a2 ).mul( c.mul( c ) ) ) ).div( c ).sub( 1.0 ).mul( 0.5 );

// One crossing of a dielectric interface, eta = n2 / n1 with N on V's side (Walter et al. 2007, facets drawn from the
// normals V sees, Heitz 2018). The exact Fresnel at the drawn facet picks reflection or refraction, which then weighs
// G2 / G1(V) — 0 if it ends on the wrong side of N — over the interface's albedo, giving back the light the facets
// trade among themselves. At or below MIN_ROUGHNESS the facet is N itself and the weight 1.
export const sampleDielectric = Fn( ( [ V, N, eta, roughness, xi, pick ] ) => {

	const rough = roughness.greaterThan( MIN_ROUGHNESS ).toVar();
	const NoV = max( dot( N, V ), 1e-4 ).toVar();
	const H = N.toVar();

	If( rough, () => {

		// A shading normal can lean past V; the facets are then drawn as for a grazing V.
		const TBN = constructTBN( { N } ).toVar();
		const localV = TBN.transpose().mul( V );
		H.assign( TBN.mul( sampleGGXVNDF( { V: normalize( vec3( localV.xy, NoV ) ), roughness, Xi: xi } ) ) );

	} );

	const didReflect = pick.lessThan( fresnelDielectric( dot( V, H ), eta ) ).toVar();
	const direction = select( didReflect, reflect( V.negate(), H ), refract( V.negate(), H, float( 1.0 ).div( eta ) ) ).toVar();
	const weight = float( 1.0 ).toVar();

	If( rough, () => {

		const NoL = dot( N, direction ).toVar();
		const alpha = roughness.mul( roughness );
		const a2 = alpha.mul( alpha ).toVar();
		const g1 = smithLambda( NoV, a2 ).add( 1.0 ).toVar();
		const g2 = g1.add( smithLambda( max( abs( NoL ), 1e-4 ), a2 ) );
		weight.assign( select( NoL.greaterThan( 0.0 ).equal( didReflect ), g1.div( g2 ).div( dielectricInterfaceAlbedo( NoV, roughness, eta ) ), float( 0.0 ) ) );

	} );

	return DielectricSample( { direction, didReflect, weight } );

} );

// ================================================================================
// TRANSMISSION HANDLER
// ================================================================================

export const handleTransmission = Fn( ( [
	rayDir, normal, material, entering, rngState,
	pixelCoord, resolution, frame, dimBase,
	currentMediumIOR, previousMediumIOR, pathWavelength,
], builder ) => {

	const result = TransmissionResult( {
		direction: vec3( 0.0 ),
		throughput: vec3( 1.0 ),
		didReflect: false,
		pathWavelength: pathWavelength,
	} ).toVar();

	const N = select( entering, normal, normal.negate() ).toVar();
	const V = rayDir.negate().toVar();

	const glassIOR = material.ior.toVar();
	const colorWeight = vec3( 1.0 ).toVar();
	const wavelength = pathWavelength.toVar();
	if ( materialLayers( builder ).dispersion ) {

		const glass = SpectralSample.wrap( pathIOR( material.ior, material.dispersion, pathWavelength, rngState, pixelCoord, resolution, frame, dimBase ) );
		glassIOR.assign( glass.ior );
		colorWeight.assign( glass.colorWeight );
		wavelength.assign( glass.wavelength );

	}

	// Entering, the ray goes from the medium it is in into the glass; leaving, from the glass into the one around it.
	const n1 = select( entering, currentMediumIOR, glassIOR ).toVar();
	const n2 = select( entering, glassIOR, previousMediumIOR ).toVar();

	const crossing = DielectricSample.wrap( sampleDielectric(
		V, N, n2.div( n1 ), material.roughness,
		getRandomSample2D( pixelCoord, int( 0 ), dimBase.add( int( 4 ) ), rngState, resolution, frame ),
		getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 4 ) ), rngState, resolution, frame ),
	) );

	result.direction.assign( crossing.direction );
	result.didReflect.assign( crossing.didReflect );
	result.throughput.assign( material.color.xyz.mul( crossing.weight ) );

	If( crossing.didReflect.not(), () => {

		// Radiance scales by (n1/n2)² into the other medium's solid angle (it cancels over a way in and out). Volume
		// absorption is applied along the path inside, from the medium stack.
		result.throughput.mulAssign( colorWeight.mul( n1.mul( n1 ).div( max( n2.mul( n2 ), EPSILON ) ) ) );
		result.pathWavelength.assign( wavelength );

	} );

	return result;

} );

// ================================================================================
// MATERIAL TRANSPARENCY HANDLER
// ================================================================================

export const handleMaterialTransparency = Fn( ( [
	ray, normal, entering, material, rngState,
	pixelCoord, resolution, frame, dimBase,
	transmissiveTraversals,
	currentMediumIOR, previousMediumIOR,
	pathWavelength,
], builder ) => {

	const result = MaterialInteractionResult( {
		continueRay: false,
		isTransmissive: false,
		isAlphaSkip: false,
		isSubsurface: false,
		didReflect: false,
		entering: false,
		direction: ray.direction,
		throughput: vec3( 1.0 ),
		alpha: float( 1.0 ),
		pathWavelength: pathWavelength,
	} ).toVar();

	// Fast path for fully opaque, non-scattering materials (most common case).
	// Subsurface materials are opaque (transmission==0) but must NOT take this path.
	If( material.alphaMode.equal( int( 0 ) ).and( material.transmission.lessThanEqual( 0.0 ) ).and( material.subsurface.lessThanEqual( 0.0 ) ), () => {

		// no interaction needed

	} ).Else( () => {

		const alphaRand = getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 6 ) ), rngState, resolution, frame );
		const transmissionRand = getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 7 ) ), rngState, resolution, frame );
		const transmissionSeed = pcgHash( { state: rngState } );

		const handled = tslBool( false ).toVar();

		// BLEND mode
		If( material.alphaMode.equal( int( 2 ) ), () => {

			const finalAlpha = material.color.a.mul( material.opacity );

			// Use stochastic transparency for blend mode
			If( alphaRand.greaterThan( finalAlpha ), () => {

				result.continueRay.assign( true );
				result.direction.assign( ray.direction );
				result.throughput.assign( vec3( 1.0 ) );
				result.alpha.assign( 0.0 );
				result.isAlphaSkip.assign( true );
				handled.assign( true );

			} ).Else( () => {

				result.alpha.assign( finalAlpha );

			} );

		} );

		// MASK mode
		If( handled.not().and( material.alphaMode.equal( int( 1 ) ) ), () => {

			const cutoff = select( material.alphaTest.greaterThan( 0.0 ), material.alphaTest, float( 0.5 ) );

			// Effective alpha = textureAlpha (in color.a) × baseColorFactor.a (opacity).
			// color.a base is 1.0, so factor-only MASK (no albedo map) relies on opacity.
			If( material.color.a.mul( material.opacity ).lessThan( cutoff ), () => {

				result.continueRay.assign( true );
				result.direction.assign( ray.direction );
				result.throughput.assign( vec3( 1.0 ) );
				result.alpha.assign( 0.0 );
				result.isAlphaSkip.assign( true );
				handled.assign( true );

			} ).Else( () => {

				result.alpha.assign( 1.0 );

			} );

		} );

		If( handled.not().and( material.transmission.greaterThan( 0.0 ) ).and( transmissiveTraversals.greaterThan( int( 0 ) ) ), () => {

			// Only apply transmission with probability equal to the transmission value
			If( transmissionRand.lessThan( material.transmission ), () => {

				const transResult = TransmissionResult.wrap( handleTransmission(
					ray.direction, normal, material, entering, transmissionSeed,
					pixelCoord, resolution, frame, dimBase,
					currentMediumIOR, previousMediumIOR, pathWavelength,
				) );

				result.direction.assign( transResult.direction );
				result.throughput.assign( transResult.throughput );
				result.continueRay.assign( true );
				result.isTransmissive.assign( true );
				result.didReflect.assign( transResult.didReflect );
				result.entering.assign( entering );
				result.alpha.assign( float( 1.0 ).sub( material.transmission ) );
				result.pathWavelength.assign( transResult.pathWavelength );

			} );

		} );

		// Subsurface (independent of transmission; works at transmission==0). Entry is a lottery
		// (prob = weight) so 1-weight falls through to the opaque BRDF; exit is deterministic.
		if ( materialLayers( builder ).subsurface ) If( handled.not().and( material.subsurface.greaterThan( 0.0 ) ), () => {

			const doEnter = entering.not().or( getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 8 ) ), rngState, resolution, frame ).lessThan( material.subsurface ) );

			If( doEnter, () => {

				const ssResult = SubsurfaceEntryResult.wrap( handleSubsurfaceEntry(
					ray.direction, normal, material, entering, rngState,
					pixelCoord, resolution, frame, dimBase,
					currentMediumIOR, previousMediumIOR,
				) ).toVar();

				result.direction.assign( ssResult.direction );
				result.throughput.assign( ssResult.throughput );
				result.continueRay.assign( true );
				result.isSubsurface.assign( true );
				result.didReflect.assign( ssResult.didReflect );
				result.entering.assign( entering );
				result.alpha.assign( 1.0 );

			} );

		} );

	} );

	return result;

} );
