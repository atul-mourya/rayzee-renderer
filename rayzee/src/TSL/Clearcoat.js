import {
	Fn,
	vec3,
	int,
	dot,
	normalize,
	reflect,
	max,
	If,
} from 'three/tsl';

import { struct } from './patches.js';

import { AnisoFrame, DotProducts,
	BRDFWeights,
} from './Struct.js';
import { MIN_CLEARCOAT_ROUGHNESS, computeDotProductsAniso, anisoTangentFrame, constructTBN } from './Common.js';
import { computeAnisoAlphas, calculateBRDFWeightsFromMaterial, calculateBSDFSamplingPDF } from './MaterialProperties.js';
import { ImportanceSampleCosine, sampleGGXVNDF, sampleGGXVNDFAniso } from './MaterialSampling.js';
import { evaluateMaterialResponseFromDots } from './MaterialEvaluation.js';
import { getRandomSample1D } from './Random.js';

export const ClearcoatResult = struct( {
	brdf: 'vec3',
	L: 'vec3',
	pdf: 'float',
} );

// Improved clearcoat sampling function
// Returns vec4: xyz = brdf color, w = pdf
// L (light direction) is returned via the out pattern as a separate return
export const sampleClearcoat = Fn( ( [
	ray, hitInfo, material, randomSample, rngState,
	pixelCoord, resolution, frame, dimBase,
] ) => {

	const N = hitInfo.normal;
	const V = ray.direction.negate();

	// Clamp clearcoat roughness to avoid artifacts
	const clearcoatRoughness = max( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS );
	const baseRoughness = max( material.roughness, MIN_CLEARCOAT_ROUGHNESS );

	// The shared selection probabilities, NOT a fourth private scheme. This function used to
	// derive its own specular/clearcoat/diffuse split, so a clearcoat material was sampled with
	// one set of probabilities while every MIS site evaluated the density of another — the white
	// furnace read the resulting mismatch as an energy error that flipped sign once the other
	// sites were unified.
	const weights = BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( material ) ).toVar();
	const clearcoatWeight = weights.clearcoat.toVar();
	const specularWeight = weights.specular.toVar();

	// Choose which layer to sample
	const rand = getRandomSample1D( pixelCoord, int( 0 ), dimBase.add( int( 13 ) ), rngState, resolution, frame );

	const L = vec3( 0.0 ).toVar();
	const H = vec3( 0.0 ).toVar();

	If( rand.lessThan( clearcoatWeight ), () => {

		// Sample clearcoat layer (VNDF — see the base-specular note below)
		const ccTBN = constructTBN( { N } );
		H.assign( ccTBN.mul( sampleGGXVNDF( { V: ccTBN.transpose().mul( V ), roughness: clearcoatRoughness, Xi: randomSample } ) ) );
		L.assign( reflect( V.negate(), H ) );

	} ).ElseIf( rand.lessThan( clearcoatWeight.add( specularWeight ) ), () => {

		// Sample base specular (anisotropic VNDF when anisotropy > 0)
		If( material.anisotropy.greaterThan( 0.0 ), () => {

			const f = AnisoFrame.wrap( anisoTangentFrame( N, material.anisotropyRotation ) );
			const localV = vec3( dot( V, f.Ta ), dot( V, f.Ba ), dot( V, N ) );
			const a = computeAnisoAlphas( material.roughness, material.anisotropy );
			const localH = sampleGGXVNDFAniso( { V: localV, alphaX: a.x, alphaY: a.y, Xi: randomSample } );
			H.assign( f.Ta.mul( localH.x ).add( f.Ba.mul( localH.y ) ).add( N.mul( localH.z ) ) );

		} ).Else( () => {

			// VNDF to match the density the MIS sites evaluate for this lobe.
			const tbn = constructTBN( { N } );
			H.assign( tbn.mul( sampleGGXVNDF( { V: tbn.transpose().mul( V ), roughness: baseRoughness, Xi: randomSample } ) ) );

		} );
		L.assign( reflect( V.negate(), H ) );

	} ).Else( () => {

		// Sample diffuse
		L.assign( ImportanceSampleCosine( { N, xi: randomSample } ) );
		H.assign( normalize( V.add( L ) ) );

	} );

	// Calculate dot products (aniso-aware: also projects onto the anisotropy frame)
	const dots = DotProducts.wrap( computeDotProductsAniso( N, V, L, material ) );

	// One density for every MIS site — see calculateBSDFSamplingPDF.
	const pdf = max( calculateBSDFSamplingPDF( material, weights, dots ), 0.001 );

	// Evaluate complete BRDF
	// The same BRDF every other site evaluates — see the clearcoat note in MaterialEvaluation.
	const brdf = evaluateMaterialResponseFromDots( material, dots );

	// Return brdf, L direction, and pdf packed together
	// Caller needs L and pdf - return as struct-like output
	// We pack: result.xyz = brdf, result.w = pdf, L stored in separate output
	return ClearcoatResult( { brdf, L, pdf } );

} );
