/**
 * Subsurface.js - Random-walk subsurface scattering.
 *
 * Reuses the refraction interface + medium stack (PathTracerCore.js). The new physics
 * is inside the medium: a ray collides mid-flight (sigma_s > 0) and scatters via a
 * Henyey-Greenstein phase function instead of flying straight + absorbing (glass).
 */

import {
	Fn,
	float,
	int,
	vec3,
	If,
	select,
	abs,
	dot,
	clamp,
	max,
	exp,
	log,
	sqrt,
	cos,
	sin,
	normalize,
	reflect,
	refract,
} from 'three/tsl';

import { struct } from './patches.js';
import { TWO_PI, EPSILON, constructTBN } from './Common.js';
import { getRandomSample1D, getRandomSample2D } from './Random.js';
import { iorToFresnel0, fresnelSchlickFloat } from './Fresnel.js';
import { ImportanceSampleGGX } from './MaterialSampling.js';

// ================================================================================
// STRUCTS
// ================================================================================

export const CollisionSample = struct( {
	didScatter: 'bool',
	t: 'float', // collision distance (clamped to surfaceDist when no scatter)
	weight: 'vec3', // throughput multiplier for the segment (chromatic-MIS)
} );

export const MediumCoeffs = struct( {
	sigmaT: 'vec3',
	sigmaS: 'vec3',
	sigmaA: 'vec3',
} );

export const SubsurfaceEntryResult = struct( {
	direction: 'vec3',
	throughput: 'vec3',
	didReflect: 'bool',
} );

// ================================================================================
// HENYEY-GREENSTEIN PHASE SAMPLING
// ================================================================================

// Returns a scattered direction (unit). cosTheta is relative to the propagation dir
// `wi`, so g > 0 is forward scattering. Inverse-CDF sampling is exact, so the brute-force
// walk needs no extra weight at the vertex (hence no pdf is returned).
export const sampleHenyeyGreenstein = Fn( ( [ wi, g, xi ] ) => {

	const cosTheta = float( 0.0 ).toVar();

	If( abs( g ).lessThan( 0.001 ), () => {

		cosTheta.assign( float( 1.0 ).sub( xi.x.mul( 2.0 ) ) ); // isotropic; avoids 1/(2g)

	} ).Else( () => {

		const denom = max( float( 1.0 ).sub( g ).add( g.mul( 2.0 ).mul( xi.x ) ), 1e-4 );
		const sqrTerm = float( 1.0 ).sub( g.mul( g ) ).div( denom );
		cosTheta.assign( float( 1.0 ).add( g.mul( g ) ).sub( sqrTerm.mul( sqrTerm ) ).div( g.mul( 2.0 ) ) );

	} );

	cosTheta.assign( clamp( cosTheta, - 1.0, 1.0 ) );
	const sinTheta = sqrt( max( float( 0.0 ), float( 1.0 ).sub( cosTheta.mul( cosTheta ) ) ) );
	const phi = float( TWO_PI ).mul( xi.y );

	// Basis with wi as 3rd column → result is already unit length.
	const TBN = constructTBN( { N: wi } );
	return TBN.mul( vec3( sinTheta.mul( cos( phi ) ), sinTheta.mul( sin( phi ) ), cosTheta ) );

} );

// ================================================================================
// CHROMATIC COLLISION-DISTANCE SAMPLING (hero-channel spectral MIS)
// ================================================================================

// Per-channel sigma_t can't be represented by one scalar distance. Pick a channel
// ∝ throughput, sample t against it, and weight by the balance-heuristic combined pdf
// p̄ = Σ pmf_c·p_c — the shared scalar p̄ is what suppresses color fireflies.
export const sampleChromaticCollision = Fn( ( [
	sigmaT, sigmaS, beta, surfaceDist, rngState,
	pixelCoord, resolution, frame, dimBase,
] ) => {

	const w = max( beta, vec3( 1e-4 ) ); // floor so no channel goes unsampled
	const pmf = w.div( w.x.add( w.y ).add( w.z ) ).toVar();

	// .toVar() pins the single RNG draw (else it re-executes per comparison → state drift).
	const u = getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 10 ) ), rngState, resolution, frame ).toVar();
	const cSigmaT = float( 0.0 ).toVar();
	If( u.lessThan( pmf.x ), () => {

		cSigmaT.assign( sigmaT.x );

	} ).ElseIf( u.lessThan( pmf.x.add( pmf.y ) ), () => {

		cSigmaT.assign( sigmaT.y );

	} ).Else( () => {

		cSigmaT.assign( sigmaT.z );

	} );

	const xi = getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 9 ) ), rngState, resolution, frame ).toVar();
	const t = log( max( float( 1.0 ).sub( xi ), 1e-6 ) ).negate().div( max( cSigmaT, 1e-6 ) ).toVar();

	const didScatter = t.lessThan( surfaceDist ).toVar();
	const tOut = t.toVar();
	const weight = vec3( 0.0 ).toVar();

	If( didScatter, () => {

		const Tr = exp( sigmaT.mul( t ).negate() ).toVar();
		const pBar = dot( pmf, sigmaT.mul( Tr ) );
		weight.assign( sigmaS.mul( Tr ).div( max( pBar, 1e-6 ) ) );

	} ).Else( () => {

		const Tr = exp( sigmaT.mul( surfaceDist ).negate() ).toVar();
		const pBar = dot( pmf, Tr );
		weight.assign( Tr.div( max( pBar, 1e-6 ) ) );
		tOut.assign( surfaceDist );

	} );

	return CollisionSample( { didScatter, t: tOut, weight } );

} );

// ================================================================================
// PARAMETER → COEFFICIENT MAPPING (Cycles-style)
// ================================================================================

// sigma_t = 1/(radius·scale), sigma_s = albedo·sigma_t, sigma_a = sigma_t - sigma_s.
// subsurfaceColor is the single-scatter albedo, so the per-event weight carries the tint.
export const subsurfaceCoefficients = Fn( ( [ subsurfaceColor, subsurfaceRadius, radiusScale ] ) => {

	const r = max( subsurfaceRadius.mul( radiusScale ), vec3( 1e-4 ) );
	const sigmaT = vec3( 1.0 ).div( r );
	const sigmaS = subsurfaceColor.mul( sigmaT );
	const sigmaA = max( sigmaT.sub( sigmaS ), vec3( 0.0 ) );

	return MediumCoeffs( { sigmaT, sigmaS, sigmaA } );

} );

// ================================================================================
// DIELECTRIC BOUNDARY (enter / exit the SSS medium)
// ================================================================================

// Dielectric interface driven by material.ior: reflect (Fresnel/TIR) or refract across
// the boundary. No color tint — the scattering color lives in sigma_s.
export const handleSubsurfaceEntry = Fn( ( [
	rayDir, normal, material, entering, rngState,
	pixelCoord, resolution, frame, dimBase,
	currentMediumIOR, previousMediumIOR,
] ) => {

	const result = SubsurfaceEntryResult( {
		direction: vec3( 0.0 ),
		throughput: vec3( 1.0 ),
		didReflect: false,
	} ).toVar();

	const N = select( entering, normal, normal.negate() ).toVar();
	const n1 = select( entering, currentMediumIOR, material.ior ).toVar();
	const n2 = select( entering, material.ior, previousMediumIOR ).toVar();

	const cosThetaI = abs( dot( N, rayDir ) );
	const sinThetaT2 = n1.mul( n1 ).div( max( n2.mul( n2 ), EPSILON ) ).mul( float( 1.0 ).sub( cosThetaI.mul( cosThetaI ) ) );
	const tir = sinThetaT2.greaterThan( 1.0 ).toVar();

	const F0 = iorToFresnel0( n2, n1 );
	const Fr = select( tir, float( 1.0 ), fresnelSchlickFloat( cosThetaI, F0 ) ).toVar();
	const reflectProb = clamp( Fr, 0.02, 0.98 ).toVar();

	const doReflect = tir.or( getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 11 ) ), rngState, resolution, frame ).lessThan( reflectProb ) ).toVar();
	result.didReflect.assign( doReflect );

	If( doReflect, () => {

		// GGX-sampled reflection: a perfect mirror here makes SSS surfaces read as polished ceramic.
		const xiR = getRandomSample2D( pixelCoord, int( 0 ), dimBase.add( int( 5 ) ), rngState, resolution, frame );
		const H = ImportanceSampleGGX( { N, roughness: material.roughness, Xi: xiR } );
		const reflDir = reflect( rayDir, H ).toVar();
		If( dot( reflDir, N ).lessThanEqual( 0.0 ), () => {

			reflDir.assign( reflect( rayDir, N ) ); // rough sample dipped below surface

		} );
		result.direction.assign( reflDir );
		result.throughput.assign( vec3( Fr.div( max( reflectProb, 0.02 ) ) ) );

	} ).Else( () => {

		const refrDir = refract( rayDir, N, n1.div( max( n2, EPSILON ) ) ).toVar();

		If( dot( refrDir, refrDir ).lessThan( 0.0001 ), () => {

			result.direction.assign( reflect( rayDir, N ) );
			result.didReflect.assign( true );

		} ).Else( () => {

			result.direction.assign( normalize( refrDir ) );
			// (1-Fr) transmission + (n1/n2)² radiance scale (cancels round-trip).
			const radianceScale = n1.mul( n1 ).div( max( n2.mul( n2 ), EPSILON ) );
			result.throughput.assign( vec3(
				float( 1.0 ).sub( Fr ).div( max( float( 1.0 ).sub( reflectProb ), 0.02 ) ).mul( radianceScale )
			) );

		} );

	} );

	return result;

} );
