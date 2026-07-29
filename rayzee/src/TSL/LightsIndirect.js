/**
 * LightsIndirect.js - Indirect Lighting (Global Illumination)
 *
 * Pure TSL: Fn(), If(), Loop(), .toVar(), .assign() — NO wgslFn()
 *
 * Material-only bounce direction sampling. Environment is NOT an indirect
 * strategy — it is handled via deterministic NEE in LightsSampling.js.
 *
 * Contains:
 *  - calculateIndirectLighting — material multi-strategy MIS for bounce direction
 */

import { Fn, float, vec3, int, max, dot, If, select } from 'three/tsl';

import { IndirectLightingResult } from './LightsCore.js';
import { MIN_PDF } from './Common.js';
import { getRandomSample2D } from './Random.js';
import { cosineWeightedSample } from './MaterialSampling.js';






// =============================================================================
// Indirect Lighting Calculation
// =============================================================================

export const calculateIndirectLighting = Fn( ( [
	N, material,
	// brdfSample fields (DirectionSample)
	brdfSampleDirection, brdfSamplePdf, brdfSampleValue,
	// DirectionSample carries these so refraction throughput does not need a second sampler run.
	isTransmission, brdfSampleColorWeight,
	rngState,
	pixelCoord, resolution, frame, dimBase,
] ) => {

	// Initialize result
	const r_direction = vec3( 0.0 ).toVar();
	const r_throughput = vec3( 0.0 ).toVar();
	const r_combinedPdf = float( 0.0 ).toVar();

	// A non-finite pdf would poison the accumulation buffer permanently, so fall back to a
	// cosine bounce rather than dividing by it.
	If( brdfSamplePdf.greaterThan( 0.0 ).not(), () => {

		const sampleRand = getRandomSample2D( pixelCoord, int( 0 ), dimBase.add( int( 8 ) ), rngState, resolution, frame );
		r_direction.assign( cosineWeightedSample( N, sampleRand ) );
		r_throughput.assign( material.color.xyz );
		r_combinedPdf.assign( 1.0 );

	} ).Else( () => {

		// generateSampledDirection IS the sampler — this used to re-select a strategy on top of
		// it, and its strategies 1 and 4 both just returned brdfSampleDirection. So a sample that
		// the inner selection had drawn from the diffuse or sheen lobe was reported to MIS as a
		// specular-VNDF draw, making combinedPdf something no strategy actually sampled from.
		// Since prevBouncePdf is that value, and the NEE sites evaluate a mixture, the two MIS
		// strategies' weights stopped summing to 1.
		//
		// brdfSamplePdf is now the true mixture density (calculateBSDFSamplingPDF), so the
		// estimator is just f·NoL/pdf and the MIS pairs share one function by construction.
		const NoL = max( dot( N, brdfSampleDirection ), 0.0 ).toVar();
		const pdf = max( brdfSamplePdf, MIN_PDF ).toVar();

		r_direction.assign( brdfSampleDirection );
		r_combinedPdf.assign( pdf );

		// The reflection BRDF eval is invalid below the surface, so refraction carries the
		// sampler's own tint (material.color × colorWeight), mirroring handleTransmission.
		r_throughput.assign( select(
			isTransmission,
			material.color.xyz.mul( brdfSampleColorWeight ),
			brdfSampleValue.mul( NoL ).div( pdf ),
		) );

	} );

	return IndirectLightingResult( {
		direction: r_direction,
		throughput: r_throughput,
		combinedPdf: r_combinedPdf,
	} );

} );
