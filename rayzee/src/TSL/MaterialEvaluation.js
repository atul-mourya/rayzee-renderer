import {
	Fn, float, vec3,
	If, max, min, clamp, mix
} from 'three/tsl';

import { DotProducts, DFGResult } from './Struct.js';
import { PI_INV, MIN_CLEARCOAT_ROUGHNESS, computeDotProductsAniso } from './Common.js';
import { fresnelSchlick, fresnelSchlickFloat, dielectricF0 } from './Fresnel.js';
import {
	DistributionGGX, SheenDistribution, VisibilitySheen, VisibilityGGXSmithCorrelated,
	sheenDirectionalAlbedo, evaluateDFG,
	computeAnisoAlphas, DistributionGGXAniso, VisibilityGGXAniso,
} from './MaterialProperties.js';
import { evalIridescence } from './MaterialProperties.js';

// =============================================================================
// MATERIAL EVALUATION
// =============================================================================

// -----------------------------------------------------------------------------
// Main Material Response Evaluation
// -----------------------------------------------------------------------------

// Body of evaluateMaterialResponse taking precomputed dot products. Callers
// that also need calculateMaterialPDF for the same (V, L, N) should share dots
// to save one computeDotProducts call.
export const evaluateMaterialResponseFromDots = Fn( ( [ material, dots ] ) => {

	const result = vec3( 0.0 ).toVar();

	// Early exit for purely diffuse materials (skip if iridescent)
	// `sheen` is in the guard because this fast path returns a bare Lambert term: without it a
	// rough sheen material lost its sheen lobe entirely — silently, since the fast path is only
	// taken above roughness 0.98.
	If( material.roughness.greaterThan( 0.98 )
		.and( material.metalness.lessThan( 0.02 ) )
		.and( material.transmission.equal( 0.0 ) )
		.and( material.clearcoat.equal( 0.0 ) )
		.and( material.sheen.equal( 0.0 ) )
		.and( material.iridescence.equal( 0.0 ) ), () => {

		result.assign( material.color.rgb.mul( float( 1.0 ).sub( material.metalness ) ).mul( PI_INV ) );

	} ).Else( () => {

		// Calculate base F0 with specular parameters, clamped to physically valid range
		const F0 = clamp(
			mix( dielectricF0( material.ior ).mul( material.specularColor ), material.color.rgb, material.metalness )
				.mul( material.specularIntensity ),
			vec3( 0.0 ), vec3( 1.0 )
		).toVar();

		// Modify material color for dispersive materials to enhance color separation
		const materialColor = material.color.rgb.toVar();
		If( material.dispersion.greaterThan( 0.0 ).and( material.transmission.greaterThan( 0.5 ) ), () => {

			// For highly dispersive transmissive materials, boost color saturation
			const dispersionEffect = clamp( material.dispersion.mul( 0.1 ), 0.0, 0.8 );
			const maxComp = max( max( materialColor.r, materialColor.g ), materialColor.b );
			const minComp = min( min( materialColor.r, materialColor.g ), materialColor.b );
			If( maxComp.greaterThan( minComp ), () => {

				const saturatedColor = materialColor.sub( minComp ).div( maxComp.sub( minComp ) );
				materialColor.assign( mix( materialColor, saturatedColor, dispersionEffect.mul( 0.3 ) ) );

			} );

		} );

		// Add iridescence effect if enabled
		If( material.iridescence.greaterThan( 0.0 ), () => {

			// Per glTF KHR_materials_iridescence spec: use max thickness when no texture
			const thickness = material.iridescenceThicknessRange.y;
			const iridescenceFresnel = evalIridescence( float( 1.0 ), material.iridescenceIOR, dots.VoH, thickness, F0 );
			F0.assign( mix( F0, iridescenceFresnel, material.iridescence ) );

		} );

		// Precalculate shared terms
		const F = fresnelSchlick( dots.VoH, F0 );

		// Single-scatter specular BRDF (anisotropic when material.anisotropy > 0; the aniso
		// visibility term already carries the 1/(4·NoV·NoL) denominator)
		const specularSS = vec3( 0.0 ).toVar();
		If( material.anisotropy.greaterThan( 0.0 ), () => {

			const a = computeAnisoAlphas( material.roughness, material.anisotropy );
			const Da = DistributionGGXAniso( a.x, a.y, dots.NoH, dots.ToH, dots.BoH );
			const Va = VisibilityGGXAniso( a.x, a.y, dots.ToV, dots.BoV, dots.ToL, dots.BoL, dots.NoV, dots.NoL );
			specularSS.assign( F.mul( Da.mul( Va ) ) );

		} ).Else( () => {

			const D = DistributionGGX( dots.NoH, material.roughness );
			const Vis = VisibilityGGXSmithCorrelated( dots.NoV, dots.NoL, material.roughness );
			specularSS.assign( D.mul( Vis ).mul( F ) );

		} );

		// Shared DFG evaluation — compensation factor and total directional albedo
		// come from the same polynomial.
		const dfg = DFGResult.wrap( evaluateDFG( F0, dots.NoV, material.roughness ) );
		const specular = specularSS.mul( dfg.compensation );

		// Diffuse energy budget from hemisphere-integrated specular albedo (includes multiscatter)
		// Transmission removes energy from diffuse just as metalness does — KHR_materials_transmission
		// defines transmission as replacing the diffuse component.
		const kD = vec3( 1.0 ).sub( dfg.E_total )
			.mul( float( 1.0 ).sub( material.metalness ) )
			.mul( float( 1.0 ).sub( material.transmission ) );
		const diffuse = kD.mul( materialColor ).mul( PI_INV );

		const baseLayer = diffuse.add( specular ).toVar();

		// Optimize sheen calculation
		If( material.sheen.greaterThan( 0.0 ), () => {

			// D · V, not · NoL — callers apply the cosine when they integrate.
			const sheenDist = SheenDistribution( dots.NoH, material.sheenRoughness );
			const sheenVis = VisibilitySheen( dots.NoV, dots.NoL );
			const sheenTerm = material.sheenColor.mul( material.sheen ).mul( sheenDist ).mul( sheenVis );

			// Attenuate the base by the lobe's actual directional albedo, so what the base loses is
			// what the coat returns. See gen-dfg-lut.mjs for the integral.
			const sheenE = sheenDirectionalAlbedo( dots.NoV, material.sheenRoughness );
			const sheenReflectance = clamp( material.sheenColor.mul( material.sheen ).mul( sheenE ), vec3( 0.0 ), vec3( 1.0 ) );
			const sheenAttenuation = vec3( 1.0 ).sub( sheenReflectance );

			result.assign( baseLayer.mul( sheenAttenuation ).add( sheenTerm ) );

		} ).Else( () => {

			result.assign( baseLayer );

		} );

		// The coat lives here, not in a separate layered-BRDF function: every strategy has to
		// evaluate the same integrand or MIS is biased however good the weights are.
		If( material.clearcoat.greaterThan( 0.0 ), () => {

			const ccRoughness = max( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS );
			const ccF0 = vec3( 0.04 );

			// A GGX lobe like any other, so same multiscatter treatment; its albedo is what the
			// base underneath loses.
			const ccDfg = DFGResult.wrap( evaluateDFG( ccF0, dots.NoV, ccRoughness ) );

			const ccD = DistributionGGX( dots.NoH, ccRoughness );
			const ccVis = VisibilityGGXSmithCorrelated( dots.NoV, dots.NoL, ccRoughness );
			const ccF = fresnelSchlickFloat( dots.VoH, float( 0.04 ) );
			const ccLobe = vec3( ccD.mul( ccVis ).mul( ccF ) ).mul( ccDfg.compensation );


			const ccAttenuation = vec3( 1.0 ).sub( ccDfg.E_total.mul( material.clearcoat ) );

			result.assign( result.mul( ccAttenuation ).add( ccLobe.mul( material.clearcoat ) ) );

		} );

	} );

	return result;

} );

// Wrapper that computes dot products internally. Use this when you don't already
// have dots; otherwise prefer evaluateMaterialResponseFromDots to share the work.
export const evaluateMaterialResponse = Fn( ( [ V, L, N, material ] ) => {

	const dots = DotProducts.wrap( computeDotProductsAniso( N, V, L, material ) );
	return evaluateMaterialResponseFromDots( material, dots );

} );

