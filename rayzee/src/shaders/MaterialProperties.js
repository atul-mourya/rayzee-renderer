import { Fn, texture, float, vec2, vec3, If, dot, max, min, sqrt, cos, exp, mix, clamp, smoothstep, floor, select } from 'three/tsl';
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three';

import { BRDFWeights, MaterialCache, MaterialClassification, DFGResult, BaseFresnel } from './Struct.js';

import { PI, PI_INV, TWO_PI, EPSILON, MIN_ROUGHNESS, MIN_CLEARCOAT_ROUGHNESS, MAX_ROUGHNESS, XYZ_TO_REC709, square, classifyMaterial } from './Common.js';

import { fresnelSchlickFloat, fresnel0ToIor, iorToFresnel0Vec3, iorToFresnel0, dielectricF0 } from './Fresnel.js';
import { materialLayers } from './SceneResources.js';
import { DFG_LUT_SIZE, DFG_DIELECTRIC_SLICES, DFG_R0_MAX, DFG_LUT_DATA } from './DFGTable.js';

// -----------------------------------------------------------------------------
// Microfacet Distribution Functions
// -----------------------------------------------------------------------------

// Guards a zero denominator only. At MIN_ROUGHNESS the peak's π·denom² is ~1e-10, and flooring it at
// EPSILON cut D 8000× while the sampler still drew the true lobe: smooth dielectrics lost up to 22 %.
const D_DENOM_FLOOR = 1e-30;

export const DistributionGGX = Fn( ( [ NoH, roughness ] ) => {

	const alpha = roughness.mul( roughness );
	const alpha2 = alpha.mul( alpha );
	const denom = NoH.mul( NoH ).mul( alpha2.sub( 1.0 ) ).add( 1.0 );
	return alpha2.div( max( float( PI ).mul( denom ).mul( denom ), D_DENOM_FLOOR ) );

} );

// Inverted-GGX sheen lobe (Estevez & Kulla 2017): GGX with α² replaced by 1/α², which turns the
// forward peak into the broad grazing rim sheen needs. Sampled by sheenSamplingRoughness below.
//
// The old `min( ..., 100 )` firefly guard is gone: it truncated the peak for sheenRoughness below
// ~0.2, and because the same function supplies the sampling pdf, a clamped D is a pdf the sampler
// never drew from. Importance sampling cancels D against its own pdf, so the raw value is safe.
export const SheenDistribution = Fn( ( [ NoH, roughness ] ) => {

	const clampedRoughness = max( roughness, MIN_ROUGHNESS );
	const alpha = clampedRoughness.mul( clampedRoughness );
	const invAlpha2 = float( 1.0 ).div( alpha.mul( alpha ) );
	const d = NoH.mul( NoH ).mul( invAlpha2.sub( 1.0 ) ).add( 1.0 );
	return invAlpha2.div( max( float( PI ).mul( d ).mul( d ), EPSILON ) );

} );

// The `roughness` to hand ImportanceSampleGGX so it draws from SheenDistribution. That helper
// builds A² = roughness⁴ while the sheen lobe is A² = 1/sheenRoughness⁴, so the parameter is the
// reciprocal. Passing sheenRoughness directly — as this used to — samples the ordinary forward
// GGX lobe and reports the inverted-GGX density for it, which is simply a different distribution.
export const sheenSamplingRoughness = Fn( ( [ roughness ] ) => {

	return float( 1.0 ).div( max( roughness, MIN_ROUGHNESS ) );

} );

// Ashikhmin/Neubelt sheen visibility — carries the 1/(4·NoV·NoL) denominator like the GGX
// visibility terms, so the lobe is D · V, never D alone.
export const VisibilitySheen = Fn( ( [ NoV, NoL ] ) => {

	return clamp( float( 1.0 ).div(
		max( float( 4.0 ).mul( NoL.add( NoV ).sub( NoL.mul( NoV ) ) ), EPSILON )
	), 0.0, 1.0 );

} );

// -----------------------------------------------------------------------------
// Rough Diffuse (EON)
// -----------------------------------------------------------------------------
// Portsmouth, Kutz & Hill, "EON: A practical energy-preserving rough diffuse BRDF" (JCGT 2025), behind OpenPBR's
// base_diffuse_roughness and Cycles' Diffuse Roughness: Fujii's Oren–Nayar plus the light lost between facets, so a
// white surface returns all it receives. Reciprocal: cosine sampling and every MIS site are unchanged.

const FON_A = 0.5 - 2.0 / ( 3.0 * Math.PI );
const FON_B = 2.0 / 3.0 - 28.0 / ( 15.0 * Math.PI );

// G(μ)/π, the paper's fit (Eq. 14).
const fonG = ( mu ) => {

	const c = float( 1.0 ).sub( mu );
	return c.mul( float( 0.0571085289 ).add( c.mul( float( 0.491881867 ).add( c.mul( float( - 0.332181442 ).add( c.mul( 0.0714429953 ) ) ) ) ) ) );

};

/** EON for albedo `rho` and roughness r ∈ [0, 1]; LoV is the cosine between the two directions. */
export const diffuseEON = Fn( ( [ rho, r, NoL, NoV, LoV ] ) => {

	const A = float( 1.0 ).div( float( 1.0 ).add( r.mul( FON_A ) ) );
	const s = LoV.sub( NoL.mul( NoV ) );
	const single = rho.mul( A.mul( PI_INV ).mul( float( 1.0 ).add( r.mul( s.greaterThan( 0.0 ).select( s.div( max( NoL, NoV ) ), s ) ) ) ) );

	// ρ past 1 would take the denominator through 0.
	const p = clamp( rho, vec3( 0.0 ), vec3( 1.0 ) );
	const average = A.mul( float( 1.0 ).add( r.mul( FON_B ) ) );
	const rhoMs = p.mul( p ).mul( average ).div( vec3( 1.0 ).sub( p.mul( float( 1.0 ).sub( average ) ) ) );
	// Eq. 19's (1 − Eᵢ)(1 − Eₒ)/(1 − ⟨E⟩) with r·A cancelled, so no 0/0 at r = 0. The fit overshoots A₁ by 5e-4 at grazing.
	const lost = r.mul( A ).mul( max( float( FON_A ).sub( fonG( NoL ) ), 0.0 ) ).mul( max( float( FON_A ).sub( fonG( NoV ) ), 0.0 ) )
		.mul( 1.0 / ( FON_A - FON_B ) );
	return single.add( rhoMs.mul( lost.mul( PI_INV ) ) );

} );

// -----------------------------------------------------------------------------
// Geometry Terms
// -----------------------------------------------------------------------------

// Smith masking G1 for GGX: G1 = 2·NoV / (NoV + sqrt(α² + (1−α²)·NoV²)), α = roughness².
//
// This was `k = (roughness + 1)² / 8` — Karis's remap for ANALYTIC LIGHTS in a split-sum IBL
// pipeline, not a Smith G — and it landed in both the BRDF's G and, via calculateVNDFPDF, the
// sampling pdf. The anisotropic siblings always used the correct form, so a material shifted
// brightness between anisotropy 0 and 0.001.
const GeometrySchlickGGX = Fn( ( [ NdotV, roughness ] ) => {

	const alpha = roughness.mul( roughness );
	const alpha2 = alpha.mul( alpha );
	const denom = NdotV.add( sqrt( alpha2.add( float( 1.0 ).sub( alpha2 ).mul( NdotV.mul( NdotV ) ) ) ) );
	return float( 2.0 ).mul( NdotV ).div( max( denom, EPSILON ) );

} );

// Height-correlated Smith visibility for GGX — the isotropic twin of VisibilityGGXAniso, and
// like it this ALREADY carries the 1/(4·NoV·NoL) denominator: multiply straight by D and F.
//
// The isotropic BRDF used to assemble D·G·F/(4·NoV·NoL) with the SEPARABLE Smith G1(V)·G1(L),
// which assumes masking and shadowing are independent. They are not, and it overestimates G.
export const VisibilityGGXSmithCorrelated = Fn( ( [ NoV, NoL, roughness ] ) => {

	const alpha = roughness.mul( roughness );
	const alpha2 = alpha.mul( alpha );
	const lambdaV = NoL.mul( sqrt( alpha2.add( float( 1.0 ).sub( alpha2 ).mul( NoV.mul( NoV ) ) ) ) );
	const lambdaL = NoV.mul( sqrt( alpha2.add( float( 1.0 ).sub( alpha2 ).mul( NoL.mul( NoL ) ) ) ) );
	return float( 0.5 ).div( max( lambdaV.add( lambdaL ), EPSILON ) );

} );


// -----------------------------------------------------------------------------
// Directional albedo LUT
// -----------------------------------------------------------------------------
//   R  specular E(NoV, roughness) at F0 = 1  — the divisor the multiscatter compensation needs
//   G  sheen    E(NoV, sheenRoughness)        — inverted-GGX lobe with Ashikhmin/Neubelt
//                                               visibility; what the base must be attenuated by
//   B  specular E(NoV, roughness) at F0 = 0  — Schlick's bias term, for metals
//   A  unused (RGBA because RGB float textures are not portable)
//
// All hemisphere integrals of this renderer's own lobes. Schlick is linear in F0, so
// E(F0) = F0·(R - B) + B is exact for any F0 — no fitted shape anywhere in the chain.
//
// Dielectrics use the exact Fresnel curve, F = mix( f0, f90, s ) with s = dielectricFresnelWeight,
// so E = f0·(R - S) + f90·S where S is the albedo of s. S depends on eta, so blocks 1.. of the
// table hold it in DFG_DIELECTRIC_SLICES slices uniform in r0 = (eta - 1)/(eta + 1) up to
// DFG_R0_MAX, neighbouring pairs side by side (R = slice k, G = slice k + 1) so one fetch
// interpolates. Interpolation between slices is within 0.0012 of a direct integral. B and A of the
// block holding slice k as R carry a rough dielectric interface's albedo at that slice (sampleDielectric:
// entering, then leaving), the last slice's in one block more.
//
// This replaces Karis's analytic split-sum polynomial. That polynomial is a fit for a DIFFERENT
// integral (the split-sum IBL approximation) and is simply not the albedo of the BSDF integrated
// here: measured against this table it is off by up to 0.31 absolute, over-correcting at mid
// roughness (implying 0.725 where the truth is 0.899) and under-correcting at high roughness
// (0.45 where the truth is 0.343). Those two are exactly the +11 % and -26 % the white furnace
// reported on metal.
//
// 16×16, row = NoV, column = roughness, sampled at ENDPOINTS (index i is i/15), so the table
// covers roughness 1.0 rather than stopping at the last texel centre — that shortfall alone left
// rough metal 8.6 pp dark. Bilinear reconstruction lands within 0.002 rms / 0.018 max of a
// 262k-sample reference. Regenerate with `npm run bench:lut` if a lobe or its sampler changes —
// the table is only valid for the exact BRDF/sampler pair it was integrated from, and drifting out
// of calibration is exactly the failure this replaced.
const DFG_LUT_BLOCKS = DFG_DIELECTRIC_SLICES + 1; // block 0, one per neighbouring slice pair, the last slice's interface

const _dfgLutTexture = new DataTexture( DFG_LUT_DATA, DFG_LUT_SIZE * DFG_LUT_BLOCKS, DFG_LUT_SIZE, RGBAFormat, FloatType );
_dfgLutTexture.minFilter = LinearFilter;
_dfgLutTexture.magFilter = LinearFilter;
_dfgLutTexture.wrapS = ClampToEdgeWrapping;
_dfgLutTexture.wrapT = ClampToEdgeWrapping;
_dfgLutTexture.generateMipmaps = false;
_dfgLutTexture.needsUpdate = true;

const dfgLutNode = texture( _dfgLutTexture );
dfgLutNode.setUpdateMatrix( false );

// Remaps a (roughness, NoV) query onto the LUT's texel centres. Entry i holds the value at
// i/(N-1), so a raw fetch would read the endpoints half a texel early at both ends.
// Blocks sit side by side, so roughness is clamped: past 1 it would read the next block.
const dfgLutUV = ( roughness, NoV, block = 0 ) => vec2(
	clamp( roughness, 0.0, 1.0 ).mul( DFG_LUT_SIZE - 1 ).add( 0.5 ).add( float( block ).mul( DFG_LUT_SIZE ) ).div( DFG_LUT_SIZE * DFG_LUT_BLOCKS ),
	clamp( NoV, 0.0, 1.0 ).mul( ( DFG_LUT_SIZE - 1 ) / DFG_LUT_SIZE ).add( 0.5 / DFG_LUT_SIZE ),
);

/**
 * Directional albedo of the sheen lobe — what fraction of incoming light it reflects, and so
 * exactly what the base layer underneath must be attenuated by for the pair to conserve energy.
 * Near zero head-on and rising toward grazing, because sheen is a rim lobe.
 */
export const sheenDirectionalAlbedo = Fn( ( [ NoV, sheenRoughness ] ) => {

	return clamp( dfgLutNode.sample( dfgLutUV( sheenRoughness, NoV ) ).g, 0.0, 1.0 );

} );

// -----------------------------------------------------------------------------
// Kulla-Conty Multiscatter Energy Compensation
// -----------------------------------------------------------------------------
// Single-scatter GGX loses energy for rough surfaces because it ignores light
// bouncing multiple times between microfacets. This function returns a per-channel
// multiplicative factor for the specular BRDF that compensates for this loss.
// Based on: Kulla & Conty 2017 + Karis 2014 analytical DFG approximation.

// Directional albedo of the base specular layer, and the Kulla-Conty factor that goes with it:
//   compensation — multiscatter energy compensation factor for the specular lobe
//   E_total      — total specular directional albedo (single-scatter × compensation)
// The dielectric half follows the exact Fresnel curve (f0, f90, eta), the metal half Schlick at
// F0m, blended by metalness and then toward Schlick at iridF by `iridescence` — the same blend the
// BRDF applies to F. `F0` is the Kulla-Conty tint.
export const evaluateSpecularDFG = Fn( ( [ f0, f90, eta, F0m, metalness, iridF, iridescence, F0, NoV, roughness ] ) => {

	const lut = dfgLutNode.sample( dfgLutUV( roughness, NoV ) ).toVar();

	const t = clamp( eta.sub( 1.0 ).div( eta.add( 1.0 ) ).div( DFG_R0_MAX ), 0.0, 1.0 ).mul( DFG_DIELECTRIC_SLICES - 1 ).toVar();
	const k = min( floor( t ), float( DFG_DIELECTRIC_SLICES - 2 ) ).toVar();
	const pair = dfgLutNode.sample( dfgLutUV( roughness, NoV, k.add( 1.0 ) ) ).toVar();
	const S = clamp( mix( pair.r, pair.g, t.sub( k ) ), 0.0, 1.0 );

	// Directional albedo at F0 = 1 and F0 = 0 pin the Schlick family exactly: E(F0) = F0·(Ew - bias) + bias.
	const Ew = max( lut.r, 0.05 ).toVar();
	const bias = clamp( lut.b, 0.0, 1.0 ).toVar();

	const E_dielectric = f0.mul( Ew.sub( S ) ).add( vec3( f90.mul( S ) ) );
	const E_metal = F0m.mul( Ew.sub( bias ) ).add( vec3( bias ) );
	const E_iridescent = iridF.mul( Ew.sub( bias ) ).add( vec3( bias ) );
	const E_ss = max( mix( mix( E_dielectric, E_metal, metalness ), E_iridescent, iridescence ), vec3( 0.0 ) );

	// Kulla-Conty: 1 + F0·(1/Ew - 1).
	const compensation = vec3( 1.0 ).add( F0.mul( float( 1.0 ).div( Ew ).sub( 1.0 ) ) );
	const E_total = clamp( E_ss.mul( compensation ), vec3( 0.0 ), vec3( 1.0 ) );

	return DFGResult( { compensation, E_total } );

} );

// Directional albedo of a rough dielectric interface as sampleDielectric draws it — reflection, plus refraction's share
// of the light (radiance's (n1/n2)² aside) — at eta = n2 / n1, entering (eta > 1) or leaving (eta < 1).
export const dielectricInterfaceAlbedo = Fn( ( [ NoV, roughness, eta ] ) => {

	const leaving = eta.lessThan( 1.0 );
	const n = select( leaving, float( 1.0 ).div( eta ), eta );
	const t = clamp( n.sub( 1.0 ).div( n.add( 1.0 ) ).div( DFG_R0_MAX ), 0.0, 1.0 ).mul( DFG_DIELECTRIC_SLICES - 1 ).toVar();
	const k = min( floor( t ), float( DFG_DIELECTRIC_SLICES - 2 ) ).toVar();
	const E = mix(
		dfgLutNode.sample( dfgLutUV( roughness, NoV, k.add( 1.0 ) ) ).ba,
		dfgLutNode.sample( dfgLutUV( roughness, NoV, k.add( 2.0 ) ) ).ba,
		t.sub( k ),
	);
	return max( select( leaving, E.y, E.x ), 0.05 );

} );

// KHR_materials_specular: the dielectric keeps specularColor off its grazing reflectance, and
// specularIntensity scales both ends, so 0 removes the dielectric reflection entirely.
export const baseFresnelParams = Fn( ( [ material, color ] ) => {

	const f0 = min( dielectricF0( material.ior ).mul( material.specularColor ), vec3( 1.0 ) ).mul( material.specularIntensity );
	const F0m = clamp( color.mul( material.specularIntensity ), vec3( 0.0 ), vec3( 1.0 ) );

	return BaseFresnel( {
		f0,
		f90: material.specularIntensity,
		eta: max( material.ior, 1.0 ),
		F0m,
		F0: clamp( mix( f0, F0m, material.metalness ), vec3( 0.0 ), vec3( 1.0 ) ),
	} );

} );

// -----------------------------------------------------------------------------
// PDF Calculation Helpers
// -----------------------------------------------------------------------------


// Calculate PDF for VNDF sampling
// Formula: G1(V) * D(H) / (NoV * 4)
export const calculateVNDFPDF = Fn( ( [ NoH, NoV, roughness ] ) => {

	const D = DistributionGGX( NoH, roughness );
	const G1 = GeometrySchlickGGX( NoV, roughness );
	return D.mul( G1 ).div( max( NoV.mul( 4.0 ), EPSILON ) );

} );

// -----------------------------------------------------------------------------
// Anisotropic GGX (Filament / three.js convention — matches WebGLRenderer/glTF)
// -----------------------------------------------------------------------------
// alphaB = roughness² (bitangent axis), alphaT = mix(roughness², 1, anisotropy²) (tangent axis).
// Returns vec2( alphaT, alphaB ). Both floored so smooth anisotropic surfaces stay stable.
export const computeAnisoAlphas = Fn( ( [ roughness, anisotropy ] ) => {

	const alphaB = max( roughness.mul( roughness ), 1e-4 ).toVar();
	const alphaT = max( mix( alphaB, float( 1.0 ), anisotropy.mul( anisotropy ) ), 1e-4 );
	return vec2( alphaT, alphaB );

} );

// Anisotropic GGX normal distribution (Filament D_GGX_Anisotropic). Reduces exactly to
// DistributionGGX when alphaT == alphaB.
export const DistributionGGXAniso = Fn( ( [ alphaT, alphaB, NoH, ToH, BoH ] ) => {

	const a2 = alphaT.mul( alphaB );
	const v = vec3( alphaB.mul( ToH ), alphaT.mul( BoH ), a2.mul( NoH ) );
	const v2 = max( dot( v, v ), D_DENOM_FLOOR );
	const w2 = a2.div( v2 );
	return a2.mul( w2.mul( w2 ) ).div( PI );

} );

// Anisotropic Smith height-correlated visibility (three.js V_GGX_SmithCorrelated_Anisotropic).
// Already includes the 1/(4·NoV·NoL) denominator — multiply directly by D and F.
export const VisibilityGGXAniso = Fn( ( [ alphaT, alphaB, ToV, BoV, ToL, BoL, NoV, NoL ] ) => {

	const gv = NoL.mul( vec3( alphaT.mul( ToV ), alphaB.mul( BoV ), NoV ).length() );
	const gl = NoV.mul( vec3( alphaT.mul( ToL ), alphaB.mul( BoL ), NoL ).length() );
	return float( 0.5 ).div( max( gv.add( gl ), EPSILON ) );

} );

// Anisotropic Smith masking G1 (for the VNDF pdf). G1 = 1 / (1 + Λ).
const smithG1Aniso = Fn( ( [ alphaT, alphaB, ToV, BoV, NoV ] ) => {

	const t = alphaT.mul( ToV );
	const b = alphaB.mul( BoV );
	const num = t.mul( t ).add( b.mul( b ) );
	const nov2 = max( NoV.mul( NoV ), EPSILON );
	const lambda = sqrt( float( 1.0 ).add( num.div( nov2 ) ) ).sub( 1.0 ).mul( 0.5 );
	return float( 1.0 ).div( lambda.add( 1.0 ) );

} );

// Anisotropic VNDF pdf over the reflected direction: G1(V)·D(H) / (4·NoV).
const calculateVNDFPDFAniso = Fn( ( [ alphaT, alphaB, NoH, ToH, BoH, NoV, ToV, BoV ] ) => {

	const D = DistributionGGXAniso( alphaT, alphaB, NoH, ToH, BoH );
	const G1 = smithG1Aniso( alphaT, alphaB, ToV, BoV, NoV );
	return D.mul( G1 ).div( max( NoV.mul( 4.0 ), EPSILON ) );

} );


// -----------------------------------------------------------------------------
// Iridescence Evaluation
// -----------------------------------------------------------------------------

const evalSensitivity = Fn( ( [ OPD, shift ] ) => {

	const phase = float( TWO_PI ).mul( OPD ).mul( 1.0e-9 );
	const val = vec3( 5.4856e-13, 4.4201e-13, 5.2481e-13 );
	const pos = vec3( 1.6810e+06, 1.7953e+06, 2.2084e+06 );
	const vr = vec3( 4.3278e+09, 9.3046e+09, 6.6121e+09 );

	const xyz = val.mul( sqrt( float( TWO_PI ).mul( vr ) ) )
		.mul( cos( pos.mul( phase ).add( shift ) ) )
		.mul( exp( square( { x: phase } ).negate().mul( vr ) ) )
		.toVar();

	xyz.x.addAssign(
		float( 9.7470e-14 ).mul( sqrt( float( TWO_PI ).mul( 4.5282e+09 ) ) )
			.mul( cos( float( 2.2399e+06 ).mul( phase ).add( shift.x ) ) )
			.mul( exp( float( - 4.5282e+09 ).mul( square( { x: phase } ) ) ) )
	);

	return XYZ_TO_REC709.mul( xyz.div( 1.0685e-7 ) );

} );

export const evalIridescence = Fn( ( [ outsideIOR, eta2, cosTheta1, thinFilmThickness, baseF0 ] ) => {

	// Force iridescenceIor -> outsideIOR when thinFilmThickness -> 0.0
	const iridescenceIor = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) ).toVar();

	// Evaluate the cosTheta on the base layer (Snell law)
	const sinTheta2Sq = square( { x: outsideIOR.div( iridescenceIor ) } ).mul( float( 1.0 ).sub( square( { x: cosTheta1 } ) ) );

	// Handle TIR
	const cosTheta2Sq = float( 1.0 ).sub( sinTheta2Sq ).toVar();
	const result = vec3( 0.0 ).toVar();

	If( cosTheta2Sq.lessThan( 0.0 ), () => {

		result.assign( vec3( 1.0 ) );

	} ).Else( () => {

		const cosTheta2 = sqrt( cosTheta2Sq ).toVar();

		// First interface
		const R0 = iorToFresnel0( iridescenceIor, outsideIOR );
		const R12 = fresnelSchlickFloat( cosTheta1, R0 ).toVar();
		const T121 = float( 1.0 ).sub( R12 ).toVar();
		const phi12 = iridescenceIor.lessThan( outsideIOR ).select( float( PI ), float( 0.0 ) );
		const phi21 = float( PI ).sub( phi12 );

		// Second interface
		const baseIOR = fresnel0ToIor( clamp( baseF0, 0.0, 0.9999 ) ).toVar();
		const R1 = iorToFresnel0Vec3( baseIOR, iridescenceIor ).toVar();
		const R23 = vec3(
			fresnelSchlickFloat( cosTheta2, R1.x ),
			fresnelSchlickFloat( cosTheta2, R1.y ),
			fresnelSchlickFloat( cosTheta2, R1.z )
		).toVar();
		const phi23 = vec3(
			baseIOR.x.lessThan( iridescenceIor ).select( float( PI ), float( 0.0 ) ),
			baseIOR.y.lessThan( iridescenceIor ).select( float( PI ), float( 0.0 ) ),
			baseIOR.z.lessThan( iridescenceIor ).select( float( PI ), float( 0.0 ) )
		);

		const OPD = float( 2.0 ).mul( iridescenceIor ).mul( thinFilmThickness ).mul( cosTheta2 ).toVar();
		const phi = vec3( phi21 ).add( phi23 ).toVar();

		// Compound terms
		const R123 = clamp( vec3( R12 ).mul( R23 ), 1e-5, 0.9999 ).toVar();
		const r123 = sqrt( R123 ).toVar();
		const Rs = vec3( T121.mul( T121 ) ).mul( R23 ).div( vec3( 1.0 ).sub( R123 ) ).toVar();

		// Reflectance term for m = 0 (DC term amplitude)
		const C0 = vec3( R12 ).add( Rs ).toVar();
		const I = C0.toVar();
		const Cm = Rs.sub( vec3( T121 ) ).toVar();

		// Unrolled loop for m = 1, 2
		Cm.mulAssign( r123 );
		I.addAssign( Cm.mul( float( 2.0 ).mul( evalSensitivity( float( 1.0 ).mul( OPD ), float( 1.0 ).mul( phi ) ) ) ) );

		Cm.mulAssign( r123 );
		I.addAssign( Cm.mul( float( 2.0 ).mul( evalSensitivity( float( 2.0 ).mul( OPD ), float( 2.0 ).mul( phi ) ) ) ) );

		result.assign( max( I, vec3( 0.0 ) ) );

	} );

	return result;

} );

// -----------------------------------------------------------------------------
// BRDF Weight Calculation
// -----------------------------------------------------------------------------

export const calculateBRDFWeights = Fn( ( [ material, mc, cache ], builder ) => {

	const layers = materialLayers( builder );
	// Use precomputed values from cache
	const invRoughness = cache.invRoughness;
	const metalFactor = cache.metalFactor;

	// Optimized specular calculation using classification
	const baseSpecularWeight = float( 0.0 ).toVar();

	If( mc.isMetallic, () => {

		baseSpecularWeight.assign( max( invRoughness.mul( metalFactor ), 0.7 ) );

	} ).ElseIf( mc.isSmooth, () => {

		baseSpecularWeight.assign( invRoughness.mul( metalFactor ).mul( 1.2 ) );

	} ).Else( () => {

		baseSpecularWeight.assign( max( invRoughness.mul( metalFactor ), material.metalness.mul( 0.1 ) ) );

	} );

	const specular = baseSpecularWeight.mul( material.specularIntensity ).toVar();
	// (1 - transmission) is load-bearing: a fully transmissive dielectric has no diffuse lobe, and
	// without this glass spent ~23 % of its samples proposing cosine directions whose BRDF value is
	// ~0 while refraction went under-sampled. The old inline MIS weights in LightsSampling had this
	// factor; lobe selection never did.
	const diffuse = float( 1.0 ).sub( baseSpecularWeight )
		.mul( float( 1.0 ).sub( material.metalness ) )
		.mul( float( 1.0 ).sub( material.transmission ) ).toVar();
	const sheen = ( layers.sheen ? material.sheen.mul( cache.maxSheenColor ) : float( 0.0 ) ).toVar();

	const clearcoat = float( 0.0 ).toVar();
	if ( layers.clearcoat ) If( mc.hasClearcoat, () => {

		clearcoat.assign( material.clearcoat.mul( invRoughness ).mul( 0.4 ) );

	} ).Else( () => {

		clearcoat.assign( material.clearcoat.mul( invRoughness ).mul( 0.35 ) );

	} );

	const transmission = float( 0.0 ).toVar();
	If( mc.isTransmissive, () => {

		const transmissionBase = cache.iorFactor.mul( invRoughness ).mul( 0.8 );
		transmission.assign( material.transmission.mul( transmissionBase )
			.mul( float( 0.6 ).add( float( 0.4 ).mul( material.ior.div( 2.0 ) ) ) )
			.mul( float( 1.0 ).add( material.dispersion.mul( 0.6 ) ) ) );

	} ).Else( () => {

		const transmissionBase = cache.iorFactor.mul( invRoughness ).mul( 0.7 );
		transmission.assign( material.transmission.mul( transmissionBase )
			.mul( float( 0.5 ).add( float( 0.5 ).mul( material.ior.div( 2.0 ) ) ) )
			.mul( float( 1.0 ).add( material.dispersion.mul( 0.5 ) ) ) );

	} );

	// Iridescence: shifts energy from diffuse to specular since it modifies specular F0
	// This preserves the total weight (no inflation) while increasing specular importance
	const iridescenceBase = invRoughness.mul( mc.isSmooth.select( float( 0.6 ), float( 0.5 ) ) );
	// Off, the weight is 0 but the shift is kept: min( 0, diffuse ) still moves a negative diffuse weight to specular.
	const iridescenceWeight = layers.iridescence ? material.iridescence.mul( iridescenceBase )
		.mul( float( 0.5 ).add( float( 0.5 ).mul(
			material.iridescenceThicknessRange.y.sub( material.iridescenceThicknessRange.x ).div( 1000.0 )
		) ) )
		.mul( float( 0.5 ).add( float( 0.5 ).mul( material.iridescenceIOR.div( 2.0 ) ) ) ) : float( 0.0 );
	const iridescenceShift = min( iridescenceWeight, diffuse );
	specular.addAssign( iridescenceShift );
	diffuse.subAssign( iridescenceShift );

	// The diffuse lobe's transmitted share is drawn on the other side, in proportion.
	const diffuseTransmission = ( layers.diffuseTransmission ? diffuse.mul( material.diffuseTransmission ) : float( 0.0 ) ).toVar();
	diffuse.subAssign( diffuseTransmission );

	// Single normalization pass
	const total = specular.add( diffuse ).add( sheen ).add( clearcoat ).add( transmission ).add( diffuseTransmission );
	const invTotal = float( 1.0 ).div( max( total, 0.001 ) );

	return BRDFWeights( {
		specular: specular.mul( invTotal ),
		diffuse: diffuse.mul( invTotal ),
		sheen: sheen.mul( invTotal ),
		clearcoat: clearcoat.mul( invTotal ),
		transmission: transmission.mul( invTotal ),
		iridescence: float( 0.0 ),
		diffuseTransmission: diffuseTransmission.mul( invTotal ),
	} );

} );

// -----------------------------------------------------------------------------
// BSDF sampling density — the single source of truth for MIS
// -----------------------------------------------------------------------------
// The exact density of the direction generateSampledDirection produces, for the upper hemisphere.
//
// That sampler picks lobe j with probability weights.j then samples lobe j, so the density of a
// resulting direction is the sum over every lobe that could have produced it. Two separate
// requirements force every MIS site through this one function: the weights must sum to 1, which
// needs both strategies evaluating the same p_bsdf; and each estimator must divide by its own
// true density.
//
// Transmission is absent because it only produces NoL < 0. `weights` is normalised over all
// lobes including transmission, so omitting its term is exact, not an approximation.
export const calculateBSDFSamplingPDF = Fn( ( [ material, weights, dots ], builder ) => {

	const layers = materialLayers( builder );
	const pdf = float( 0.0 ).toVar();

	If( dots.NoL.greaterThan( 0.0 ), () => {

		pdf.addAssign( weights.diffuse.mul( dots.NoL ).mul( PI_INV ) );

		const specPdf = float( 0.0 ).toVar();
		// Raw roughness, not clamped: sampleGGXVNDF is called with material.roughness, and a
		// clamp here would report a density the sampler never drew from.
		const isotropic = () => {

			specPdf.assign( calculateVNDFPDF( dots.NoH, dots.NoV, material.roughness ) );

		};

		if ( ! layers.anisotropy ) isotropic();
		else If( material.anisotropy.greaterThan( 0.0 ), () => {

			const a = computeAnisoAlphas( material.roughness, material.anisotropy );
			specPdf.assign( calculateVNDFPDFAniso( a.x, a.y, dots.NoH, dots.ToH, dots.BoH, dots.NoV, dots.ToV, dots.BoV ) );

		} ).Else( isotropic );
		pdf.addAssign( weights.specular.mul( specPdf ) );

		if ( layers.sheen ) If( weights.sheen.greaterThan( 0.0 ), () => {

			const sheenPdf = SheenDistribution( dots.NoH, material.sheenRoughness )
				.mul( dots.NoH ).div( max( float( 4.0 ).mul( dots.VoH ), EPSILON ) );
			pdf.addAssign( weights.sheen.mul( sheenPdf ) );

		} );

		if ( layers.clearcoat ) If( weights.clearcoat.greaterThan( 0.0 ), () => {

			const ccRoughness = clamp( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS, MAX_ROUGHNESS );
			pdf.addAssign( weights.clearcoat.mul( calculateVNDFPDF( dots.coatNoH, dots.coatNoV, ccRoughness ) ) );

		} );

	} );

	return pdf;

} );

// The sampling density below the surface (cosBelow = −N·L > 0): only the diffuse transmission lobe draws there,
// chosen with probability `weight` (BRDFWeights.diffuseTransmission).
export const diffuseTransmissionPdf = Fn( ( [ weight, cosBelow ] ) => {

	return weight.mul( cosBelow ).mul( PI_INV );

} );

// The diffuse transmission lobe's selection probability, for samplers outside the classify-once path.
export const diffuseTransmissionWeight = Fn( ( [ material ] ) => {

	return BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( material ) ).diffuseTransmission;

} );

// Selection probabilities from `material` alone, for samplers outside the wavefront's
// classify-once path. Must be the same weights whose density calculateBSDFSamplingPDF reports.
export const calculateBRDFWeightsFromMaterial = Fn( ( [ material ] ) => {

	const mc = MaterialClassification.wrap( classifyMaterial(
		material.metalness, material.roughness, material.transmission,
		material.clearcoat, material.emissive, material.subsurface,
	) );

	const cache = MaterialCache( {
		invRoughness: float( 1.0 ).sub( material.roughness ),
		metalFactor: float( 0.5 ).add( float( 0.5 ).mul( material.metalness ) ),
		iorFactor: min( float( 2.0 ).div( material.ior ), 1.0 ),
		maxSheenColor: max( material.sheenColor.x, max( material.sheenColor.y, material.sheenColor.z ) ),
	} );

	return calculateBRDFWeights( material, mc, cache );

} );

// calculateBSDFSamplingPDF for callers holding only `material` and `dots`. Rebuilds the
// classification and weight cache, so prefer the struct-taking form where those already exist
// (the wavefront classifies once per shade).
export const calculateBSDFSamplingPDFFromMaterial = Fn( ( [ material, dots ] ) => {

	const weights = BRDFWeights.wrap( calculateBRDFWeightsFromMaterial( material ) );
	return calculateBSDFSamplingPDF( material, weights, dots );

} );

// -----------------------------------------------------------------------------
// Importance Sampling Info
// -----------------------------------------------------------------------------


// -----------------------------------------------------------------------------
// Material Cache Creation
// -----------------------------------------------------------------------------


