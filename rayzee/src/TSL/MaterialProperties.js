import { Fn, texture, float, vec2, vec3, If, dot, max, min, sqrt, cos, exp, mix, clamp, smoothstep } from 'three/tsl';
import { ClampToEdgeWrapping, DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three';

import { BRDFWeights, MaterialCache, MaterialClassification, DFGResult } from './Struct.js';

import { PI, PI_INV, TWO_PI, EPSILON, MIN_ROUGHNESS, MIN_CLEARCOAT_ROUGHNESS, MAX_ROUGHNESS, XYZ_TO_REC709, square, classifyMaterial } from './Common.js';

import { fresnelSchlickFloat, fresnel0ToIor, iorToFresnel0Vec3, iorToFresnel0 } from './Fresnel.js';

// -----------------------------------------------------------------------------
// Microfacet Distribution Functions
// -----------------------------------------------------------------------------

export const DistributionGGX = Fn( ( [ NoH, roughness ] ) => {

	const alpha = roughness.mul( roughness );
	const alpha2 = alpha.mul( alpha );
	const denom = NoH.mul( NoH ).mul( alpha2.sub( 1.0 ) ).add( 1.0 );
	return alpha2.div( max( float( PI ).mul( denom ).mul( denom ), EPSILON ) );

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
// Geometry Terms
// -----------------------------------------------------------------------------

// Smith masking G1 for GGX: G1 = 2·NoV / (NoV + sqrt(α² + (1−α²)·NoV²)), α = roughness².
//
// This was `k = (roughness + 1)² / 8` — Karis's remap for ANALYTIC LIGHTS in a split-sum IBL
// pipeline, not a Smith G — and it landed in both the BRDF's G and, via calculateVNDFPDF, the
// sampling pdf. The anisotropic siblings always used the correct form, so a material shifted
// brightness between anisotropy 0 and 0.001.
export const GeometrySchlickGGX = Fn( ( [ NdotV, roughness ] ) => {

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
//   B  specular E(NoV, roughness) at F0 = 0  — Schlick's bias term
//   A  unused (RGBA because RGB float textures are not portable)
//
// All hemisphere integrals of this renderer's own lobes. Schlick is linear in F0, so
// E(F0) = F0·(R - B) + B is exact for any F0 — no fitted shape anywhere in the chain.
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
const DFG_LUT_SIZE = 16;
const _dfgLutData = new Float32Array( [
	1.0000, 0.0302, 0.9039, 1.0000, 0.9712, 0.0898, 0.8635, 1.0000, 0.8914, 0.6742, 0.6952, 1.0000, 0.9176, 1.1716, 0.5703, 1.0000, 0.9447, 1.3763, 0.4529, 1.0000, 0.9592, 1.3948, 0.3509, 1.0000, 0.9658, 1.3111, 0.2690, 1.0000, 0.9679, 1.1830, 0.2061, 1.0000, 0.9669, 1.0453, 0.1588, 1.0000, 0.9639, 0.9156, 0.1237, 1.0000, 0.9592, 0.8006, 0.0978, 1.0000, 0.9533, 0.7013, 0.0786, 1.0000, 0.9465, 0.6167, 0.0644, 1.0000, 0.9388, 0.5447, 0.0537, 1.0000, 0.9304, 0.4836, 0.0457, 1.0000, 0.9214, 0.4314, 0.0395, 1.0000,
	1.0000, 0.0026, 0.7082, 1.0000, 0.9976, 0.0086, 0.7027, 1.0000, 0.9605, 0.1171, 0.6408, 1.0000, 0.9009, 0.4003, 0.5153, 1.0000, 0.8888, 0.6973, 0.4009, 1.0000, 0.9003, 0.8744, 0.3086, 1.0000, 0.9117, 0.9308, 0.2352, 1.0000, 0.9171, 0.9098, 0.1786, 1.0000, 0.9163, 0.8501, 0.1361, 1.0000, 0.9105, 0.7761, 0.1045, 1.0000, 0.9007, 0.7008, 0.0813, 1.0000, 0.8876, 0.6301, 0.0641, 1.0000, 0.8720, 0.5661, 0.0514, 1.0000, 0.8545, 0.5094, 0.0418, 1.0000, 0.8354, 0.4596, 0.0345, 1.0000, 0.8152, 0.4160, 0.0290, 1.0000,
	1.0000, 0.0003, 0.4889, 1.0000, 0.9994, 0.0020, 0.4874, 1.0000, 0.9894, 0.0281, 0.4696, 1.0000, 0.9511, 0.1226, 0.4131, 1.0000, 0.9046, 0.2856, 0.3306, 1.0000, 0.8809, 0.4505, 0.2533, 1.0000, 0.8752, 0.5628, 0.1913, 1.0000, 0.8737, 0.6152, 0.1439, 1.0000, 0.8693, 0.6237, 0.1084, 1.0000, 0.8596, 0.6057, 0.0821, 1.0000, 0.8444, 0.5742, 0.0629, 1.0000, 0.8245, 0.5370, 0.0487, 1.0000, 0.8007, 0.4985, 0.0382, 1.0000, 0.7739, 0.4613, 0.0303, 1.0000, 0.7450, 0.4264, 0.0244, 1.0000, 0.7147, 0.3943, 0.0199, 1.0000,
	1.0000, 0.0000, 0.3277, 1.0000, 0.9999, 0.0007, 0.3272, 1.0000, 0.9955, 0.0104, 0.3205, 1.0000, 0.9751, 0.0486, 0.2969, 1.0000, 0.9352, 0.1290, 0.2521, 1.0000, 0.8955, 0.2363, 0.1989, 1.0000, 0.8698, 0.3371, 0.1513, 1.0000, 0.8545, 0.4098, 0.1136, 1.0000, 0.8416, 0.4511, 0.0850, 1.0000, 0.8258, 0.4674, 0.0639, 1.0000, 0.8050, 0.4664, 0.0484, 1.0000, 0.7792, 0.4547, 0.0369, 1.0000, 0.7489, 0.4370, 0.0285, 1.0000, 0.7152, 0.4164, 0.0223, 1.0000, 0.6791, 0.3948, 0.0176, 1.0000, 0.6416, 0.3732, 0.0140, 1.0000,
	1.0000, 0.0000, 0.2121, 1.0000, 0.9999, 0.0000, 0.2119, 1.0000, 0.9976, 0.0047, 0.2095, 1.0000, 0.9854, 0.0224, 0.1999, 1.0000, 0.9564, 0.0638, 0.1784, 1.0000, 0.9163, 0.1289, 0.1472, 1.0000, 0.8792, 0.2046, 0.1149, 1.0000, 0.8508, 0.2736, 0.0871, 1.0000, 0.8274, 0.3262, 0.0653, 1.0000, 0.8038, 0.3603, 0.0489, 1.0000, 0.7767, 0.3787, 0.0368, 1.0000, 0.7450, 0.3853, 0.0278, 1.0000, 0.7089, 0.3836, 0.0213, 1.0000, 0.6693, 0.3766, 0.0164, 1.0000, 0.6275, 0.3662, 0.0127, 1.0000, 0.5845, 0.3541, 0.0100, 1.0000,
	1.0000, 0.0000, 0.1317, 1.0000, 1.0000, 0.0000, 0.1317, 1.0000, 0.9985, 0.0025, 0.1311, 1.0000, 0.9904, 0.0121, 0.1277, 1.0000, 0.9694, 0.0356, 0.1186, 1.0000, 0.9343, 0.0766, 0.1026, 1.0000, 0.8935, 0.1309, 0.0831, 1.0000, 0.8558, 0.1889, 0.0644, 1.0000, 0.8226, 0.2410, 0.0488, 1.0000, 0.7906, 0.2821, 0.0366, 1.0000, 0.7566, 0.3112, 0.0275, 1.0000, 0.7188, 0.3296, 0.0207, 1.0000, 0.6771, 0.3395, 0.0157, 1.0000, 0.6322, 0.3430, 0.0120, 1.0000, 0.5854, 0.3420, 0.0092, 1.0000, 0.5379, 0.3380, 0.0071, 1.0000,
	1.0000, 0.0000, 0.0778, 1.0000, 1.0000, 0.0000, 0.0778, 1.0000, 0.9990, 0.0015, 0.0779, 1.0000, 0.9931, 0.0073, 0.0773, 1.0000, 0.9774, 0.0220, 0.0743, 1.0000, 0.9481, 0.0490, 0.0673, 1.0000, 0.9079, 0.0883, 0.0569, 1.0000, 0.8651, 0.1349, 0.0456, 1.0000, 0.8239, 0.1820, 0.0352, 1.0000, 0.7839, 0.2242, 0.0267, 1.0000, 0.7427, 0.2585, 0.0201, 1.0000, 0.6986, 0.2844, 0.0152, 1.0000, 0.6513, 0.3026, 0.0114, 1.0000, 0.6014, 0.3144, 0.0087, 1.0000, 0.5501, 0.3212, 0.0066, 1.0000, 0.4989, 0.3243, 0.0051, 1.0000,
	1.0000, 0.0000, 0.0432, 1.0000, 1.0000, 0.0000, 0.0432, 1.0000, 0.9992, 0.0010, 0.0435, 1.0000, 0.9947, 0.0048, 0.0440, 1.0000, 0.9826, 0.0145, 0.0437, 1.0000, 0.9582, 0.0333, 0.0415, 1.0000, 0.9208, 0.0622, 0.0368, 1.0000, 0.8760, 0.0993, 0.0307, 1.0000, 0.8291, 0.1403, 0.0244, 1.0000, 0.7818, 0.1806, 0.0189, 1.0000, 0.7336, 0.2168, 0.0144, 1.0000, 0.6832, 0.2471, 0.0109, 1.0000, 0.6303, 0.2712, 0.0082, 1.0000, 0.5755, 0.2895, 0.0062, 1.0000, 0.5201, 0.3029, 0.0047, 1.0000, 0.4656, 0.3123, 0.0036, 1.0000,
	1.0000, 0.0000, 0.0221, 1.0000, 1.0000, 0.0000, 0.0222, 1.0000, 0.9995, 0.0007, 0.0225, 1.0000, 0.9958, 0.0033, 0.0232, 1.0000, 0.9860, 0.0102, 0.0239, 1.0000, 0.9656, 0.0237, 0.0238, 1.0000, 0.9316, 0.0454, 0.0224, 1.0000, 0.8869, 0.0750, 0.0196, 1.0000, 0.8363, 0.1101, 0.0162, 1.0000, 0.7831, 0.1473, 0.0128, 1.0000, 0.7282, 0.1833, 0.0099, 1.0000, 0.6715, 0.2160, 0.0076, 1.0000, 0.6130, 0.2442, 0.0057, 1.0000, 0.5535, 0.2676, 0.0043, 1.0000, 0.4942, 0.2866, 0.0033, 1.0000, 0.4368, 0.3017, 0.0025, 1.0000,
	1.0000, 0.0000, 0.0102, 1.0000, 1.0000, 0.0000, 0.0103, 1.0000, 0.9998, 0.0004, 0.0105, 1.0000, 0.9965, 0.0024, 0.0111, 1.0000, 0.9884, 0.0074, 0.0120, 1.0000, 0.9710, 0.0175, 0.0127, 1.0000, 0.9404, 0.0342, 0.0126, 1.0000, 0.8971, 0.0580, 0.0117, 1.0000, 0.8446, 0.0879, 0.0101, 1.0000, 0.7867, 0.1215, 0.0083, 1.0000, 0.7258, 0.1562, 0.0066, 1.0000, 0.6629, 0.1898, 0.0051, 1.0000, 0.5988, 0.2207, 0.0039, 1.0000, 0.5345, 0.2482, 0.0030, 1.0000, 0.4716, 0.2719, 0.0022, 1.0000, 0.4115, 0.2922, 0.0017, 1.0000,
	1.0000, 0.0000, 0.0041, 1.0000, 1.0000, 0.0000, 0.0041, 1.0000, 0.9999, 0.0003, 0.0043, 1.0000, 0.9970, 0.0018, 0.0047, 1.0000, 0.9901, 0.0056, 0.0054, 1.0000, 0.9751, 0.0133, 0.0061, 1.0000, 0.9476, 0.0265, 0.0065, 1.0000, 0.9063, 0.0458, 0.0065, 1.0000, 0.8531, 0.0712, 0.0059, 1.0000, 0.7918, 0.1013, 0.0051, 1.0000, 0.7256, 0.1341, 0.0041, 1.0000, 0.6568, 0.1676, 0.0033, 1.0000, 0.5871, 0.2002, 0.0025, 1.0000, 0.5182, 0.2308, 0.0019, 1.0000, 0.4517, 0.2586, 0.0015, 1.0000, 0.3891, 0.2836, 0.0011, 1.0000,
	1.0000, 0.0000, 0.0013, 1.0000, 1.0000, 0.0000, 0.0014, 1.0000, 0.9999, 0.0002, 0.0014, 1.0000, 0.9974, 0.0014, 0.0017, 1.0000, 0.9913, 0.0043, 0.0021, 1.0000, 0.9783, 0.0104, 0.0026, 1.0000, 0.9534, 0.0210, 0.0030, 1.0000, 0.9143, 0.0369, 0.0033, 1.0000, 0.8615, 0.0585, 0.0032, 1.0000, 0.7979, 0.0852, 0.0029, 1.0000, 0.7271, 0.1159, 0.0024, 1.0000, 0.6528, 0.1487, 0.0020, 1.0000, 0.5776, 0.1822, 0.0016, 1.0000, 0.5040, 0.2151, 0.0012, 1.0000, 0.4339, 0.2465, 0.0009, 1.0000, 0.3692, 0.2758, 0.0007, 1.0000,
	1.0000, 0.0000, 0.0003, 1.0000, 1.0000, 0.0000, 0.0003, 1.0000, 1.0000, 0.0001, 0.0004, 1.0000, 0.9977, 0.0010, 0.0005, 1.0000, 0.9923, 0.0034, 0.0007, 1.0000, 0.9807, 0.0083, 0.0010, 1.0000, 0.9581, 0.0169, 0.0012, 1.0000, 0.9214, 0.0301, 0.0015, 1.0000, 0.8695, 0.0486, 0.0015, 1.0000, 0.8044, 0.0724, 0.0015, 1.0000, 0.7299, 0.1007, 0.0013, 1.0000, 0.6504, 0.1325, 0.0011, 1.0000, 0.5699, 0.1663, 0.0009, 1.0000, 0.4916, 0.2010, 0.0007, 1.0000, 0.4181, 0.2353, 0.0006, 1.0000, 0.3513, 0.2686, 0.0004, 1.0000,
	1.0000, 0.0000, 0.0000, 1.0000, 1.0000, 0.0000, 0.0000, 1.0000, 1.0000, 0.0000, 0.0001, 1.0000, 0.9979, 0.0008, 0.0001, 1.0000, 0.9930, 0.0028, 0.0002, 1.0000, 0.9826, 0.0068, 0.0003, 1.0000, 0.9619, 0.0139, 0.0004, 1.0000, 0.9274, 0.0250, 0.0006, 1.0000, 0.8769, 0.0409, 0.0006, 1.0000, 0.8112, 0.0620, 0.0007, 1.0000, 0.7337, 0.0881, 0.0006, 1.0000, 0.6495, 0.1185, 0.0005, 1.0000, 0.5637, 0.1522, 0.0005, 1.0000, 0.4808, 0.1881, 0.0004, 1.0000, 0.4039, 0.2250, 0.0003, 1.0000, 0.3350, 0.2619, 0.0002, 1.0000,
	1.0000, 0.0000, 0.0000, 1.0000, 1.0000, 0.0000, 0.0000, 1.0000, 1.0000, 0.0000, 0.0000, 1.0000, 0.9980, 0.0006, 0.0000, 1.0000, 0.9936, 0.0023, 0.0000, 1.0000, 0.9841, 0.0056, 0.0001, 1.0000, 0.9651, 0.0115, 0.0001, 1.0000, 0.9327, 0.0210, 0.0002, 1.0000, 0.8837, 0.0348, 0.0002, 1.0000, 0.8179, 0.0535, 0.0002, 1.0000, 0.7381, 0.0775, 0.0002, 1.0000, 0.6497, 0.1064, 0.0002, 1.0000, 0.5589, 0.1396, 0.0002, 1.0000, 0.4713, 0.1763, 0.0002, 1.0000, 0.3911, 0.2154, 0.0001, 1.0000, 0.3203, 0.2557, 0.0001, 1.0000,
	1.0000, 0.0000, 0.0000, 1.0000, 1.0000, 0.0000, 0.0000, 1.0000, 1.0000, 0.0000, 0.0000, 1.0000, 0.9980, 0.0005, 0.0000, 1.0000, 0.9939, 0.0019, 0.0000, 1.0000, 0.9854, 0.0047, 0.0000, 1.0000, 0.9677, 0.0097, 0.0000, 1.0000, 0.9372, 0.0178, 0.0000, 1.0000, 0.8899, 0.0298, 0.0000, 1.0000, 0.8245, 0.0466, 0.0000, 1.0000, 0.7430, 0.0685, 0.0000, 1.0000, 0.6508, 0.0959, 0.0000, 1.0000, 0.5552, 0.1284, 0.0000, 1.0000, 0.4631, 0.1656, 0.0000, 1.0000, 0.3794, 0.2065, 0.0000, 1.0000, 0.3069, 0.2500, 0.0000, 1.0000,
] );

const _dfgLutTexture = new DataTexture( _dfgLutData, DFG_LUT_SIZE, DFG_LUT_SIZE, RGBAFormat, FloatType );
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
const dfgLutUV = ( roughness, NoV ) => vec2( roughness, NoV )
	.mul( ( DFG_LUT_SIZE - 1 ) / DFG_LUT_SIZE )
	.add( 0.5 / DFG_LUT_SIZE );

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

// Single Karis DFG evaluation that returns both outputs the BRDF needs:
//   compensation — multiscatter energy compensation factor for the specular lobe
//   E_total      — total specular directional albedo (single-scatter × compensation)
// Both share the same dfgScale/dfgBias/Ew polynomial, so computing them together
// halves the polynomial work versus calling two separate functions.
export const evaluateDFG = Fn( ( [ F0, NoV, roughness ] ) => {

	const lut = dfgLutNode.sample( dfgLutUV( roughness, NoV ) ).toVar();

	// Directional albedo at F0 = 1 and F0 = 0. Schlick is linear in F0, so these two pin the
	// whole family exactly: E(F0) = F0·(Ew - bias) + bias. This used to be Karis's analytic
	// split-sum polynomial, which fits a DIFFERENT integral — off by up to 0.31 absolute against
	// this BSDF, and the source of metal's +11 %/-26 % white-furnace error.
	const Ew = max( lut.r, 0.05 ).toVar();
	const bias = clamp( lut.b, 0.0, 1.0 ).toVar();
	const scale = max( Ew.sub( bias ), 0.0 );

	// Kulla-Conty: 1 + F0·(1/Ew - 1).
	const compensation = vec3( 1.0 ).add( F0.mul( float( 1.0 ).div( Ew ).sub( 1.0 ) ) );

	const E_ss = max( F0.mul( scale ).add( vec3( bias ) ), vec3( 0.0 ) );
	const E_total = clamp( E_ss.mul( compensation ), vec3( 0.0 ), vec3( 1.0 ) );

	return DFGResult( { compensation, E_total } );

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
	const v2 = max( dot( v, v ), EPSILON );
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
export const smithG1Aniso = Fn( ( [ alphaT, alphaB, ToV, BoV, NoV ] ) => {

	const t = alphaT.mul( ToV );
	const b = alphaB.mul( BoV );
	const num = t.mul( t ).add( b.mul( b ) );
	const nov2 = max( NoV.mul( NoV ), EPSILON );
	const lambda = sqrt( float( 1.0 ).add( num.div( nov2 ) ) ).sub( 1.0 ).mul( 0.5 );
	return float( 1.0 ).div( lambda.add( 1.0 ) );

} );

// Anisotropic VNDF pdf over the reflected direction: G1(V)·D(H) / (4·NoV).
export const calculateVNDFPDFAniso = Fn( ( [ alphaT, alphaB, NoH, ToH, BoH, NoV, ToV, BoV ] ) => {

	const D = DistributionGGXAniso( alphaT, alphaB, NoH, ToH, BoH );
	const G1 = smithG1Aniso( alphaT, alphaB, ToV, BoV, NoV );
	return D.mul( G1 ).div( max( NoV.mul( 4.0 ), EPSILON ) );

} );


// -----------------------------------------------------------------------------
// Iridescence Evaluation
// -----------------------------------------------------------------------------

export const evalSensitivity = Fn( ( [ OPD, shift ] ) => {

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

export const calculateBRDFWeights = Fn( ( [ material, mc, cache ] ) => {

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
	const sheen = material.sheen.mul( cache.maxSheenColor ).toVar();

	const clearcoat = float( 0.0 ).toVar();
	If( mc.hasClearcoat, () => {

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
	const iridescenceWeight = material.iridescence.mul( iridescenceBase )
		.mul( float( 0.5 ).add( float( 0.5 ).mul(
			material.iridescenceThicknessRange.y.sub( material.iridescenceThicknessRange.x ).div( 1000.0 )
		) ) )
		.mul( float( 0.5 ).add( float( 0.5 ).mul( material.iridescenceIOR.div( 2.0 ) ) ) );
	const iridescenceShift = min( iridescenceWeight, diffuse );
	specular.addAssign( iridescenceShift );
	diffuse.subAssign( iridescenceShift );

	// Single normalization pass
	const total = specular.add( diffuse ).add( sheen ).add( clearcoat ).add( transmission );
	const invTotal = float( 1.0 ).div( max( total, 0.001 ) );

	return BRDFWeights( {
		specular: specular.mul( invTotal ),
		diffuse: diffuse.mul( invTotal ),
		sheen: sheen.mul( invTotal ),
		clearcoat: clearcoat.mul( invTotal ),
		transmission: transmission.mul( invTotal ),
		iridescence: float( 0.0 ),
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
export const calculateBSDFSamplingPDF = Fn( ( [ material, weights, dots ] ) => {

	const pdf = float( 0.0 ).toVar();

	If( dots.NoL.greaterThan( 0.0 ), () => {

		pdf.addAssign( weights.diffuse.mul( dots.NoL ).mul( PI_INV ) );

		const specPdf = float( 0.0 ).toVar();
		If( material.anisotropy.greaterThan( 0.0 ), () => {

			const a = computeAnisoAlphas( material.roughness, material.anisotropy );
			specPdf.assign( calculateVNDFPDFAniso( a.x, a.y, dots.NoH, dots.ToH, dots.BoH, dots.NoV, dots.ToV, dots.BoV ) );

		} ).Else( () => {

			// Raw roughness, not clamped: sampleGGXVNDF is called with material.roughness, and a
			// clamp here would report a density the sampler never drew from.
			specPdf.assign( calculateVNDFPDF( dots.NoH, dots.NoV, material.roughness ) );

		} );
		pdf.addAssign( weights.specular.mul( specPdf ) );

		If( weights.sheen.greaterThan( 0.0 ), () => {

			const sheenPdf = SheenDistribution( dots.NoH, material.sheenRoughness )
				.mul( dots.NoH ).div( max( float( 4.0 ).mul( dots.VoH ), EPSILON ) );
			pdf.addAssign( weights.sheen.mul( sheenPdf ) );

		} );

		If( weights.clearcoat.greaterThan( 0.0 ), () => {

			const ccRoughness = clamp( material.clearcoatRoughness, MIN_CLEARCOAT_ROUGHNESS, MAX_ROUGHNESS );
			pdf.addAssign( weights.clearcoat.mul( calculateVNDFPDF( dots.NoH, dots.NoV, ccRoughness ) ) );

		} );

	} );

	return pdf;

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


