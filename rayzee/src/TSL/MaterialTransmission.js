// Material Transmission & Refraction - Ported from material_transmission.fs
// Handles both volumetric transmission AND opacity-based transparency

import { Fn, wgslFn, vec3, float, int, bool as tslBool, If, select, abs, dot, reflect, refract, max, mix, clamp, exp } from 'three/tsl';

import { struct } from './patches.js';
import { EPSILON, MIN_ROUGHNESS, MIN_PDF } from './Common.js';
import { iorToFresnel0, fresnelSchlickFloat } from './Fresnel.js';
import { DistributionGGX } from './MaterialProperties.js';
import { ImportanceSampleGGX } from './MaterialSampling.js';
import { getRandomSample1D, getRandomSample2D, pcgHash } from './Random.js';
import { handleSubsurfaceEntry, SubsurfaceEntryResult } from './Subsurface.js';

// ================================================================================
// STRUCTS (local to transmission)
// ================================================================================

export const TransmissionResult = struct( {
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

export const SpectralSample = struct( {
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

// MediumStack as a struct with fixed-size slots
export const MediumStack = struct( {
	m0_ior: 'float',
	m0_attenuationColor: 'vec3',
	m0_attenuationDistance: 'float',
	m0_dispersion: 'float',
	m1_ior: 'float',
	m1_attenuationColor: 'vec3',
	m1_attenuationDistance: 'float',
	m1_dispersion: 'float',
	m2_ior: 'float',
	m2_attenuationColor: 'vec3',
	m2_attenuationDistance: 'float',
	m2_dispersion: 'float',
	m3_ior: 'float',
	m3_attenuationColor: 'vec3',
	m3_attenuationDistance: 'float',
	m3_dispersion: 'float',
	depth: 'int',
} );

// ================================================================================
// DISPERSION
// ================================================================================

// Cauchy IOR n(λ) = baseIOR + 0.03·dispersion / λ_µm²
export const iorFromWavelength = /*@__PURE__*/ Fn( ( [ baseIOR, dispersionStrength, wavelength ] ) => {

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
export const sampleWavelengthForDispersion = Fn( ( [ baseIOR, dispersionStrength, random ] ) => {

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

// ================================================================================
// ABSORPTION
// ================================================================================

// Apply Beer's law absorption
export const calculateBeerLawAbsorption = /*@__PURE__*/ wgslFn( `
	fn calculateBeerLawAbsorption( attenuationColor: vec3f, attenuationDistance: f32, thickness: f32 ) -> vec3f {
		if ( attenuationDistance <= 0.0f ) { return vec3f( 1.0f ); }
		// Convert RGB attenuation color to absorption coefficients
		let absorption = -log( max( attenuationColor, vec3f( 0.001f ) ) ) / attenuationDistance;
		// Apply Beer's law
		return exp( -absorption * thickness );
	}
` );

// ================================================================================
// SHADOW TRANSMITTANCE
// ================================================================================

export const calculateShadowTransmittance = Fn( ( [ rayDir, normal, material, entering ] ) => {

	const n1 = select( entering, float( 1.0 ), material.ior ).toVar();
	const n2 = select( entering, material.ior, float( 1.0 ) ).toVar();

	const cosThetaI = abs( dot( normal, rayDir ) );
	const sinThetaT2 = n1.mul( n1 ).div( n2.mul( n2 ) ).mul( float( 1.0 ).sub( cosThetaI.mul( cosThetaI ) ) );

	// Handle total internal reflection
	const result = float( 0.0 ).toVar();

	If( sinThetaT2.lessThanEqual( 1.0 ), () => {

		// Calculate Fresnel reflectance
		const F0 = iorToFresnel0( n2, n1 );
		const Fr = fresnelSchlickFloat( cosThetaI, F0 );

		// Base transmission: what gets through after Fresnel reflection
		const baseTransmission = float( 1.0 ).sub( Fr ).mul( material.transmission ).toVar();

		// Apply Beer's law absorption for exiting rays
		If( entering.not().and( material.attenuationDistance.greaterThan( 0.0 ) ), () => {

			const absorption = calculateBeerLawAbsorption( { attenuationColor: material.attenuationColor, attenuationDistance: material.attenuationDistance, thickness: material.thickness } );
			baseTransmission.assign( baseTransmission.mul( absorption.x.add( absorption.y ).add( absorption.z ).div( 3.0 ) ) );

		} );

		result.assign( clamp( baseTransmission, 0.0, 1.0 ) );

	} );

	return result;

} );

// ================================================================================
// MICROFACET TRANSMISSION
// ================================================================================

export const sampleMicrofacetTransmission = Fn( ( [
	V, N, ior, roughness, entering, dispersion, xi, rngState, pathWavelength,
	pixelCoord, resolution, frame, dimBase,
] ) => {

	const result = MicrofacetTransmissionResult( {
		direction: vec3( 0.0 ),
		halfVector: vec3( 0.0 ),
		didReflect: false,
		pdf: float( 0.0 ),
		colorWeight: vec3( 1.0 ),
		pathWavelength: pathWavelength,
	} ).toVar();

	// For smooth surfaces with dispersion, use perfect refraction with spectral IOR
	If( roughness.lessThanEqual( 0.05 ).and( dispersion.greaterThan( 0.0 ) ), () => {

		result.halfVector.assign( N );
		result.didReflect.assign( false );

		const eta = ior;
		const etaRatio = select( entering, float( 1.0 ).div( eta ), eta ).toVar();

		// Reuse the path's locked wavelength if any; else sample a new one and tint once.
		If( pathWavelength.greaterThan( 0.0 ), () => {

			const lockedIOR = iorFromWavelength( ior, dispersion, pathWavelength );
			etaRatio.assign( select( entering, float( 1.0 ).div( lockedIOR ), lockedIOR ) );

		} ).Else( () => {

			const spectralSample = SpectralSample.wrap( sampleWavelengthForDispersion( ior, dispersion, getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 5 ) ), rngState, resolution, frame ) ) );
			etaRatio.assign( select( entering, float( 1.0 ).div( spectralSample.ior ), spectralSample.ior ) );
			result.colorWeight.assign( spectralSample.colorWeight );
			result.pathWavelength.assign( spectralSample.wavelength );

		} );

		// Perfect refraction using surface normal
		const refractDir = refract( V.negate(), N, etaRatio ).toVar();

		// Check for total internal reflection
		If( dot( refractDir, refractDir ).lessThan( 0.001 ), () => {

			result.direction.assign( reflect( V.negate(), N ) );
			result.didReflect.assign( true );
			result.pdf.assign( 1.0 );

		} ).Else( () => {

			result.direction.assign( refractDir );
			result.pdf.assign( 1.0 );

		} );

	} ).Else( () => {

		// Use minimum roughness to avoid numerical issues for rough surfaces
		const transmissionRoughness = max( MIN_ROUGHNESS, roughness );

		// Sample the microfacet normal with GGX distribution
		const H = ImportanceSampleGGX( { N, roughness: transmissionRoughness, Xi: xi } ).toVar();
		result.halfVector.assign( H );

		// Compute IOR ratio
		const etaRatio = select( entering, float( 1.0 ).div( ior ), ior ).toVar();

		// Reuse the path's locked wavelength if any; else sample a new one and tint once.
		If( dispersion.greaterThan( 0.0 ), () => {

			If( pathWavelength.greaterThan( 0.0 ), () => {

				const lockedIOR = iorFromWavelength( ior, dispersion, pathWavelength );
				etaRatio.assign( select( entering, float( 1.0 ).div( lockedIOR ), lockedIOR ) );

			} ).Else( () => {

				const spectralSample = SpectralSample.wrap( sampleWavelengthForDispersion( ior, dispersion, getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 5 ) ), rngState, resolution, frame ) ) );
				etaRatio.assign( select( entering, float( 1.0 ).div( spectralSample.ior ), spectralSample.ior ) );
				result.colorWeight.assign( spectralSample.colorWeight );
				result.pathWavelength.assign( spectralSample.wavelength );

			} );

		} );

		// Compute refracted direction using the sampled half-vector. HoV and NoH
		// are needed by both the TIR and the transmission PDF branches below, so
		// hoist them once here (VoH == HoV — same dot product). DistributionGGX D
		// is also identical between the two branches (calculateGGXPDF builds the
		// same D internally for the TIR branch), so share it too.
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

	} );

	return result;

} );

// ================================================================================
// TRANSMISSION HANDLER
// ================================================================================

export const handleTransmission = Fn( ( [
	rayDir, normal, material, entering, rngState,
	pixelCoord, resolution, frame, dimBase,
	currentMediumIOR, previousMediumIOR, pathWavelength,
] ) => {

	const result = TransmissionResult( {
		direction: vec3( 0.0 ),
		throughput: vec3( 1.0 ),
		didReflect: false,
		pathWavelength: pathWavelength,
	} ).toVar();

	// Setup surface normal based on ray direction
	const N = select( entering, normal, normal.negate() ).toVar();
	const V = rayDir.negate().toVar();

	// Calculate IOR transition using precomputed medium stack values
	// Entering: n1 = current medium IOR (where ray is), n2 = material IOR (where ray goes)
	// Exiting: n1 = material IOR (where ray is), n2 = previous medium IOR (where ray returns to)
	const n1 = select( entering, currentMediumIOR, material.ior ).toVar();
	const n2 = select( entering, material.ior, previousMediumIOR ).toVar();

	// Calculate basic reflection/refraction parameters
	const cosThetaI = abs( dot( N, rayDir ) );
	const sinThetaT2 = n1.mul( n1 ).div( n2.mul( n2 ) ).mul( float( 1.0 ).sub( cosThetaI.mul( cosThetaI ) ) );
	const totalInternalReflection = sinThetaT2.greaterThan( 1.0 ).toVar();

	const F0 = iorToFresnel0( n2, n1 );
	const Fr = select( totalInternalReflection, float( 1.0 ), fresnelSchlickFloat( cosThetaI, F0 ) ).toVar();

	const reflectProb = float( 0.0 ).toVar();

	If( totalInternalReflection, () => {

		reflectProb.assign( 1.0 );

	} ).Else( () => {

		// Pure Fresnel reflection probability for dielectrics
		// The outer code (handleMaterialTransparency) already handles the transmission probability
		// split, so inside handleTransmission we only need Fresnel-based reflect/transmit decisions
		const dielectricReflect = Fr;
		// For metals: mostly reflect regardless of transmission setting
		const metallicReflect = float( 0.95 );

		// Blend based on metalness
		reflectProb.assign( mix( dielectricReflect, metallicReflect, material.metalness ) );

	} );

	// Conservative clamp
	reflectProb.assign( clamp( reflectProb, 0.05, 0.95 ) );

	// Force reflection if TIR, otherwise probabilistically choose
	const doReflect = totalInternalReflection.or( getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 4 ) ), rngState, resolution, frame ).lessThan( reflectProb ) ).toVar();
	result.didReflect.assign( doReflect );

	// Choose random sample for microfacet sampling
	const xi = getRandomSample2D( pixelCoord, int( 0 ), dimBase.add( int( 4 ) ), rngState, resolution, frame ).toVar();

	If( doReflect, () => {

		// Reflection at a transmissive surface — no wavelength locking
		If( material.roughness.greaterThan( 0.05 ), () => {

			const mtResult = MicrofacetTransmissionResult.wrap( sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, float( 0.0 ), xi, rngState, float( 0.0 ), pixelCoord, resolution, frame, dimBase ) );
			result.direction.assign( mtResult.direction );

		} ).Else( () => {

			result.direction.assign( reflect( rayDir, N ) );

		} );

		// Energy-conserving reflection: Fresnel-weighted with PDF compensation
		result.throughput.assign( material.color.xyz.mul( Fr ).div( max( reflectProb, 0.05 ) ) );

	} ).Else( () => {

		// Transmission/refraction path
		If( material.roughness.greaterThan( 0.05 ).or( material.dispersion.greaterThan( 0.0 ) ), () => {

			const mtResult = MicrofacetTransmissionResult.wrap( sampleMicrofacetTransmission( V, N, material.ior, material.roughness, entering, material.dispersion, xi, rngState, pathWavelength, pixelCoord, resolution, frame, dimBase ) );
			result.pathWavelength.assign( mtResult.pathWavelength );

			If( mtResult.didReflect, () => {

				// TIR during intended transmission: compensate for selection probability
				result.direction.assign( mtResult.direction );
				result.didReflect.assign( true );
				result.throughput.assign( material.color.xyz.div( max( float( 1.0 ).sub( reflectProb ), 0.05 ) ) );

			} ).Else( () => {

				result.direction.assign( mtResult.direction );
				result.throughput.assign( mtResult.colorWeight );

			} );

		} ).Else( () => {

			// Simple refraction for completely smooth, non-dispersive surfaces
			result.direction.assign( refract( rayDir, N, n1.div( n2 ) ) );
			result.throughput.assign( vec3( 1.0 ) );

		} );

		// Common transmission calculations
		If( result.didReflect.not(), () => {

			// Apply material color for transmission
			result.throughput.mulAssign( material.color.xyz );

			// Non-symmetric transport correction: radiance scales by (n1/n2)² at refractive interface
			// due to solid angle compression/expansion (cancels for round-trip enter+exit paths)
			result.throughput.mulAssign( n1.mul( n1 ).div( max( n2.mul( n2 ), EPSILON ) ) );

			// KHR_materials_volume absorption is applied per-bounce in PathTracerCore based
			// on the actual ray path length inside the medium (driven by the medium stack).
			// No entry-point thickness approximation here — that would double-count.

			// Fresnel transmission factor with PDF compensation
			result.throughput.mulAssign( float( 1.0 ).sub( Fr ).div( max( float( 1.0 ).sub( reflectProb ), 0.05 ) ) );

		} );

	} );

	return result;

} );

// ================================================================================
// MATERIAL TRANSPARENCY HANDLER
// ================================================================================

export const handleMaterialTransparency = Fn( ( [
	ray, normal, material, rngState,
	pixelCoord, resolution, frame, dimBase,
	transmissiveTraversals,
	currentMediumIOR, previousMediumIOR,
	pathWavelength,
] ) => {

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

				const entering = dot( ray.direction, normal ).lessThan( 0.0 );

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
		If( handled.not().and( material.subsurface.greaterThan( 0.0 ) ), () => {

			const entering = dot( ray.direction, normal ).lessThan( 0.0 );
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
