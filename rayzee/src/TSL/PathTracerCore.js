/**
 * PathTracerCore.js — shared path-tracing sampling helpers (TSL).
 *
 * Imported by the wavefront kernels (GenerateKernel / ShadeKernel):
 *  - generateSampledDirection   — BRDF direction sampling with multi-lobe CDF
 *  - regularizePathContribution — firefly suppression
 *  - computeNDCDepth            — world position → NDC depth [0,1]
 *  - handleRussianRoulette      — adaptive path termination
 */

import {
	Fn,
	wgslFn,
	bool as tslBool,
	float,
	vec3,
	int,
	max,
	min,
	clamp,
	dot,
	reflect,
	If,
	mix,
	smoothstep,
	exp,
	select,
} from 'three/tsl';

import {
	MAX_ROUGHNESS,
	MIN_CLEARCOAT_ROUGHNESS,
	MIN_PDF,
	constructTBN,
	anisoTangentFrame,
	calculateFireflyThreshold,
	applySoftSuppressionRGB,
	computeDotProductsAniso,
} from './Common.js';
import { AnisoFrame, DirectionSample, DotProducts, MaterialCache } from './Struct.js';
import { getRandomSample1D } from './Random.js';
import { sampleMicrofacetTransmission, MicrofacetTransmissionResult } from './MaterialTransmission.js';
import {
	calculateBSDFSamplingPDF,
	computeAnisoAlphas,
	calculateBRDFWeights,
	sheenSamplingRoughness,
} from './MaterialProperties.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';

import {
	ImportanceSampleCosine,
	ImportanceSampleGGX,
	sampleGGXVNDF,
	sampleGGXVNDFAniso,
} from './MaterialSampling.js';

// =============================================================================
// BRDF Direction Sampling
// =============================================================================

export const generateSampledDirection = Fn( ( [
	V, N, material, xi, lobeXi, rngState,
	pixelCoord, resolution, frame, dimBase,
	// Caller-resolved material classification (avoids redundant classifyMaterial —
	// TSL Fn can't write back to caller variables, so the caller is responsible
	// for keeping psCachedClassification current and passes it in here).
	mc,
	weightsComputed, cachedBrdfWeights,
	materialCacheCached, cachedMaterialCache,
] ) => {

	const resultDirection = vec3( 0.0 ).toVar();
	const resultValue = vec3( 0.0 ).toVar();
	const resultPdf = float( 0.0 ).toVar();
	const resultIsTransmission = tslBool( false ).toVar();
	const resultColorWeight = vec3( 1.0 ).toVar();

	// Compute BRDF weights
	const weights = cachedBrdfWeights.toVar();

	If( weightsComputed.not(), () => {

		If( materialCacheCached, () => {

			weights.assign( calculateBRDFWeights( material, mc, cachedMaterialCache ) );

		} ).Else( () => {

			// Create minimal temporary cache
			const tempCache = MaterialCache( {
				invRoughness: float( 1.0 ).sub( material.roughness ),
				metalFactor: float( 0.5 ).add( float( 0.5 ).mul( material.metalness ) ),
				iorFactor: min( float( 2.0 ).div( material.ior ), 1.0 ),
				maxSheenColor: max( material.sheenColor.x, max( material.sheenColor.y, material.sheenColor.z ) ),
			} ).toVar();
			weights.assign( calculateBRDFWeights( material, mc, tempCache ) );

		} );

	} );

	// Own dimension, NOT xi.x — the lobe samplers below consume the full pair, so reusing xi.x
	// would leave it conditioned on the branch taken and confine VNDF's r=sqrt(Xi.x) to
	// [sqrt(lo),1), making the specular peak unreachable whenever a diffuse lobe competes.
	const rand = lobeXi.toVar();
	const H = vec3( 0.0 ).toVar();

	// Cumulative probability approach for sampling selection
	const cumulativeDiffuse = weights.diffuse.toVar();
	const cumulativeSpecular = cumulativeDiffuse.add( weights.specular ).toVar();
	const cumulativeSheen = cumulativeSpecular.add( weights.sheen ).toVar();
	const cumulativeClearcoat = cumulativeSheen.add( weights.clearcoat );

	// Chained If/ElseIf so emitted WGSL becomes a single mutually-exclusive branch
	// (replaces five separate If blocks gated on a `sampled` flag — divergence hotspot)
	If( rand.lessThan( cumulativeDiffuse ), () => {

		resultDirection.assign( ImportanceSampleCosine( { N, xi } ) );

	} ).ElseIf( rand.lessThan( cumulativeSpecular ), () => {

		If( material.anisotropy.greaterThan( 0.0 ), () => {

			// Shared frame → sampler and eval/PDF stay bit-identical (MIS consistency)
			const f = AnisoFrame.wrap( anisoTangentFrame( N, material.anisotropyRotation ) );
			const Ta = f.Ta;
			const Ba = f.Ba;

			const localV = vec3( dot( V, Ta ), dot( V, Ba ), dot( V, N ) );
			const a = computeAnisoAlphas( material.roughness, material.anisotropy );
			const localH = sampleGGXVNDFAniso( { V: localV, alphaX: a.x, alphaY: a.y, Xi: xi } );
			H.assign( Ta.mul( localH.x ).add( Ba.mul( localH.y ) ).add( N.mul( localH.z ) ) );

			resultDirection.assign( reflect( V.negate(), H ) );

		} ).Else( () => {

			const TBN = constructTBN( { N } );
			const localV = TBN.transpose().mul( V );

			// VNDF sampling
			const localH = sampleGGXVNDF( { V: localV, roughness: material.roughness, Xi: xi } );
			H.assign( TBN.mul( localH ) );

			resultDirection.assign( reflect( V.negate(), H ) );

		} );

	} ).ElseIf( rand.lessThan( cumulativeSheen ), () => {

		H.assign( ImportanceSampleGGX( { N, roughness: sheenSamplingRoughness( material.sheenRoughness ), Xi: xi } ) );
		resultDirection.assign( reflect( V.negate(), H ) );

		// Below-surface sheen draws are dropped, not redirected to a cosine direction: a fallback
		// would add a P(reject)·cos term to the true density that calculateBSDFSamplingPDF cannot
		// model, and dividing by the smaller modelled density inflated the lobe 23 %.

	} ).ElseIf( rand.lessThan( cumulativeClearcoat ), () => {

		// VNDF, not ImportanceSampleGGX: the mixture density reports this lobe with
		// calculateVNDFPDF, and sampling the half-vector GGX distribution instead would make the
		// reported density one this lobe never drew from.
		const clearcoatRoughness = clamp( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS, MAX_ROUGHNESS );
		const ccTBN = constructTBN( { N } );
		H.assign( ccTBN.mul( sampleGGXVNDF( { V: ccTBN.transpose().mul( V ), roughness: clearcoatRoughness, Xi: xi } ) ) );
		resultDirection.assign( reflect( V.negate(), H ) );

	} ).Else( () => {

		const entering = dot( V, N ).greaterThan( 0.0 );
		// pathWavelength=0 — the spectral lock happens downstream; colorWeight is carried out on
		// the DirectionSample so the consumer can build the transmission throughput.
		const mtResult = MicrofacetTransmissionResult.wrap( sampleMicrofacetTransmission(
			V, N, material.ior, material.roughness, entering, material.dispersion, xi, rngState, float( 0.0 ),
			pixelCoord, resolution, frame, dimBase,
		) );
		resultDirection.assign( mtResult.direction );
		// Selection probability included: this lobe is the only one that reaches its hemisphere,
		// so its density is w_transmission · pdf rather than pdf alone.
		resultPdf.assign( max( weights.transmission.mul( mtResult.pdf ), MIN_PDF ) );
		resultColorWeight.assign( mtResult.colorWeight );
		resultIsTransmission.assign( true );

	} );

	// One mixture density for every reflection lobe: any of them could have produced this
	// direction, so the chosen lobe's own pdf is not the density we sampled from.
	If( resultIsTransmission.not(), () => {

		const dotsOut = DotProducts.wrap( computeDotProductsAniso( N, V, resultDirection, material ) );
		resultValue.assign( evaluateMaterialResponseFromDots( material, dotsOut ) );
		resultPdf.assign( calculateBSDFSamplingPDF( material, weights, dotsOut ) );

	} );

	resultPdf.assign( max( resultPdf, MIN_PDF ) );

	return DirectionSample( {
		direction: resultDirection,
		value: resultValue,
		pdf: resultPdf,
		isTransmission: resultIsTransmission,
		colorWeight: resultColorWeight,
	} );

} );

// =============================================================================
// Firefly Suppression
// =============================================================================

export const regularizePathContribution = /*@__PURE__*/ wgslFn( `
	fn regularizePathContribution( contribution: vec3f, pathLength: f32, fireflyThreshold: f32, frame: i32 ) -> vec3f {
		// Indirect-only clamp: pathLength 0 is a direct/primary contribution (bounce-0 hit, direct NEE,
		// or a directly-viewed backdrop/sun) — that is signal, not a firefly, and clamping it darkens
		// legitimately bright pixels. Fireflies arise on indirect bounces, so only suppress pathLength>=1.
		if ( pathLength < 0.5 ) {
			return contribution;
		}
		let threshold = calculateFireflyThreshold( fireflyThreshold, i32( pathLength ), frame );
		return applySoftSuppressionRGB( contribution, threshold, 0.5f );
	}
`, [ calculateFireflyThreshold, applySoftSuppressionRGB ] );

// ── Shared sampling helpers (used by the wavefront kernels) ──

// World position → NDC depth [0,1] for motion-vector reprojection.
export const computeNDCDepth = /*@__PURE__*/ wgslFn( `
	fn computeNDCDepth( worldPos: vec3f, cameraProjectionMatrix: mat4x4f, cameraViewMatrix: mat4x4f ) -> f32 {
		let clipPos = cameraProjectionMatrix * cameraViewMatrix * vec4f( worldPos, 1.0f );
		let ndcDepth = clipPos.z / clipPos.w * 0.5f + 0.5f;
		return clamp( ndcDepth, 0.0f, 1.0f );
	}
` );

// Adaptive Russian roulette (megakernel parity: PathTracerCore.js:302 on `main`, gap #7). Returns the
// survival probability (≥minProb) when the path continues, or 0.0 when terminated. Material-importance +
// throughput + env-direction aware, with a dynamic minBounces floor and exponential depth decay — replaces
// the flat `clamp(maxThroughput,0.05,0.95)` test. Unbiased either way; this just terminates the *right* rays
// (keeps smooth-metal / transmissive / emissive chains alive longer) → less noise per sample.
// Takes the already-computed MaterialClassification `mc` directly (the wavefront classifies once per shade).
export const handleRussianRoulette = Fn( ( [
	depth, throughput, mc, rayDirection, rngState,
	pixelCoord, resolution, frame, dimBase,
	enableEnvironmentLight,
] ) => {

	const result = float( 1.0 ).toVar();

	If( depth.greaterThanEqual( int( 3 ) ), () => {

		const throughputStrength = max( max( max( throughput.x, throughput.y ), throughput.z ), 0.0 ).toVar();

		// Energy-conserving early termination for very low throughput paths (compensated)
		If( throughputStrength.lessThan( 0.0008 ).and( depth.greaterThan( int( 4 ) ) ), () => {

			const lowThroughputProb = max( throughputStrength.mul( 125.0 ), 0.01 );
			const rrSample = getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 3 ) ), rngState, resolution, frame );
			result.assign( select( rrSample.lessThan( lowThroughputProb ), lowThroughputProb, float( 0.0 ) ) );

		} ).Else( () => {

			// Importance boosts: deeper budget for transport types that physically carry energy farther.
			const materialImportance = mc.complexityScore.toVar();
			If( mc.isMetallic.and( mc.isSmooth ).and( depth.lessThan( int( 7 ) ) ), () => {

				materialImportance.addAssign( 0.3 );

			} );
			If( mc.isTransmissive.and( depth.lessThan( int( 6 ) ) ), () => {

				materialImportance.addAssign( 0.25 );

			} );
			If( mc.isEmissive.and( depth.lessThan( int( 4 ) ) ), () => {

				materialImportance.addAssign( 0.15 );

			} );
			materialImportance.assign( clamp( materialImportance, 0.0, 1.0 ) );

			// Dynamic minimum bounces
			const minBounces = int( 3 ).toVar();
			If( materialImportance.greaterThan( 0.6 ), () => {

				minBounces.assign( 5 );

			} ).ElseIf( materialImportance.greaterThan( 0.4 ), () => {

				minBounces.assign( 4 );

			} );

			If( depth.lessThan( minBounces ), () => {

				result.assign( 1.0 );

			} ).Else( () => {

				const estMaterialImportance = mc.complexityScore.toVar();
				If( mc.isMetallic.and( mc.isSmooth ), () => {

					estMaterialImportance.addAssign( 0.15 );

				} );
				If( mc.isTransmissive.and( mc.hasClearcoat ), () => {

					estMaterialImportance.addAssign( 0.12 );

				} );
				If( mc.isEmissive, () => {

					estMaterialImportance.addAssign( 0.1 );

				} );
				estMaterialImportance.assign( clamp( estMaterialImportance, 0.0, 1.0 ) );

				const directionImportance = float( 0.5 ).toVar();
				If( enableEnvironmentLight.and( throughputStrength.greaterThan( 0.01 ) ), () => {

					const cosTheta = clamp( rayDirection.y, 0.0, 1.0 );
					directionImportance.assign( mix( float( 0.3 ), float( 0.8 ), cosTheta.mul( cosTheta ) ) );

				} );

				const throughputWeight = smoothstep( float( 0.001 ), float( 0.1 ), throughputStrength );
				const pathContribution = throughputStrength.mul(
					mix( estMaterialImportance.mul( 0.7 ), directionImportance, 0.3 ),
				).mul( throughputWeight ).toVar();

				// Smooth early→deep continuation probability (no discrete depth brackets)
				const earlyProb = clamp(
					materialImportance.mul( 0.4 ).add( throughputStrength.mul( 0.6 ) ).mul( 1.2 ),
					0.15, 0.95,
				);
				const deepProb = clamp(
					throughputStrength.mul( 0.4 ).add( materialImportance.mul( 0.1 ) ),
					0.03, 0.6,
				);

				const depthT = clamp( float( depth.sub( minBounces ) ).div( 10.0 ), 0.0, 1.0 );
				const rrProb = mix( earlyProb, deepProb, depthT ).toVar();

				rrProb.assign( mix( rrProb, max( rrProb, pathContribution ), 0.4 ) );

				If( materialImportance.greaterThan( 0.5 ), () => {

					const boostFactor = materialImportance.sub( 0.5 ).mul( 0.6 );
					rrProb.assign( mix( rrProb, float( 1.0 ), boostFactor ) );

				} );

				const depthDecay = float( 0.12 ).add( materialImportance.mul( 0.08 ) );
				const depthFactor = exp( float( depth.sub( minBounces ) ).negate().mul( depthDecay ) );
				rrProb.mulAssign( depthFactor );

				const minProb = select( mc.isEmissive, float( 0.04 ), float( 0.02 ) );
				rrProb.assign( max( rrProb, minProb ) );

				const rrSample = getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 3 ) ), rngState, resolution, frame );
				result.assign( select( rrSample.lessThan( rrProb ), rrProb, float( 0.0 ) ) );

			} );

		} );

	} );

	return result;

} );
