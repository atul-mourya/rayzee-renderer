import { struct } from './patches.js';

export const Ray = struct( {
	origin: 'vec3',
	direction: 'vec3'
} );

export const RayTracingMaterial = struct( {
	color: 'vec4',
	emissive: 'vec3',
	emissiveIntensity: 'float',
	roughness: 'float',
	metalness: 'float',
	ior: 'float', // Index of refraction
	transmission: 'float', // 0 = opaque, 1 = fully transparent
	thickness: 'float',
	clearcoat: 'float',
	clearcoatRoughness: 'float',
	opacity: 'float',
	transparent: 'bool',
	attenuationColor: 'vec3',
	attenuationDistance: 'float',
	dispersion: 'float',
	sheen: 'float',
	sheenRoughness: 'float',
	sheenColor: 'vec3',
	specularIntensity: 'float',
	specularColor: 'vec3',
	alphaTest: 'float',
	alphaMode: 'int', // 0: OPAQUE, 1: MASK, 2: BLEND
	side: 'int',
	depthWrite: 'int',
	albedoMapIndex: 'int',
	emissiveMapIndex: 'int',
	normalMapIndex: 'int',
	bumpMapIndex: 'int',
	bumpScale: 'float',
	displacementScale: 'float',
	metalnessMapIndex: 'int',
	roughnessMapIndex: 'int',
	displacementMapIndex: 'int',
	normalScale: 'vec2',
	albedoTransform: 'mat3',
	emissiveTransform: 'mat3',
	normalTransform: 'mat3',
	bumpTransform: 'mat3',
	metalnessTransform: 'mat3',
	roughnessTransform: 'mat3',
	displacementTransform: 'mat3',
	iridescence: 'float',
	iridescenceIOR: 'float',
	iridescenceThicknessRange: 'vec2',
	subsurface: 'float', // 0 = off, blends opaque BRDF → random-walk SSS
	subsurfaceColor: 'vec3', // single-scatter albedo (tint light picks up inside)
	subsurfaceRadius: 'vec3', // per-channel mean free path
	subsurfaceRadiusScale: 'float', // scalar multiplier on radius
	subsurfaceAnisotropy: 'float', // Henyey-Greenstein g (-1..1)
	anisotropy: 'float', // surface specular anisotropy strength (0..1)
	anisotropyRotation: 'float', // anisotropy tangent rotation (radians)
	anisotropyMapIndex: 'int', // packed linear-bucket index, -1 if none
	// Extension-texture map indices (packed bucket index, -1 if none). Fold applied in ShadeKernel.
	transmissionMapIndex: 'int',
	clearcoatMapIndex: 'int',
	clearcoatRoughnessMapIndex: 'int',
	sheenColorMapIndex: 'int',
	sheenRoughnessMapIndex: 'int',
	iridescenceMapIndex: 'int',
	iridescenceThicknessMapIndex: 'int',
	specularIntensityMapIndex: 'int',
	specularColorMapIndex: 'int',
} );

// Result of folding the glTF extension textures into their scalar factors (applyExtensionMaps).
// Each field is the material's scalar × the sampled map channel (or the scalar unchanged if no map).
export const ExtMapResult = struct( {
	transmission: 'float',
	clearcoat: 'float',
	clearcoatRoughness: 'float',
	sheenColor: 'vec3',
	sheenRoughness: 'float',
	iridescence: 'float',
	iridescenceThickness: 'float', // resolved thin-film thickness → written into iridescenceThicknessRange.y
	specularIntensity: 'float',
	specularColor: 'vec3',
} );

// Lightweight material for shadow ray evaluation — only the fields needed
// by traceShadowRay (alpha, transmission, transparency, attenuation).
export const ShadowMaterial = struct( {
	color: 'vec4',
	ior: 'float',
	transmission: 'float',
	attenuationColor: 'vec3',
	attenuationDistance: 'float',
	albedoMapIndex: 'int',
	opacity: 'float',
	transparent: 'bool',
	alphaTest: 'float',
	alphaMode: 'int',
	albedoTransform: 'mat3',
} );

// Dual direct-lighting result: shadowed (the normal NEE estimate) + unoccluded
// (same estimator with visibility forced to 1). Used by the shadow catcher to
// derive a shadow ratio = luma(shadowed) / luma(unoccluded).
export const DirectLightingDual = struct( {
	shadowed: 'vec3',
	unoccluded: 'vec3',
} );

export const Sphere = struct( {
	position: 'vec3',
	radius: 'float',
	material: RayTracingMaterial,
} );

export const HitInfo = struct( {
	didHit: 'bool',
	dst: 'float',
	hitPoint: 'vec3',
	normal: 'vec3',
	uv: 'vec2',
	materialIndex: 'int',
	meshIndex: 'int',
	triangleIndex: 'int',
	boxTests: 'int',
	triTests: 'int',
} );

export const Triangle = struct( {
	posA: 'vec3',
	posB: 'vec3',
	posC: 'vec3',
	uvA: 'vec2',
	uvB: 'vec2',
	uvC: 'vec2',
	normalA: 'vec3',
	normalB: 'vec3',
	normalC: 'vec3',
	material: RayTracingMaterial,
	materialIndex: 'int',
	meshIndex: 'int',
} );

export const Pixel = struct( {
	color: 'vec4',
	samples: 'int',
} );

export const DirectionSample = struct( {
	direction: 'vec3',
	value: 'vec3',
	pdf: 'float',
	// Refraction went below the surface, so `value` (a reflection-only BRDF eval) is not usable
	// and the consumer must take the transmission throughput path instead.
	isTransmission: 'bool',
	// Spectral tint from the transmission sampler; vec3(1) for every reflection lobe.
	colorWeight: 'vec3',
} );

export const BRDFWeights = struct( {
	specular: 'float',
	diffuse: 'float',
	sheen: 'float',
	clearcoat: 'float',
	transmission: 'float',
	iridescence: 'float',
} );


// Anisotropy tangent frame in world space (rotated ONB). Shared by the sampler and
// the eval/PDF so both derive the identical frame — see anisoTangentFrame().
export const AnisoFrame = struct( {
	Ta: 'vec3', // anisotropy tangent
	Ba: 'vec3', // anisotropy bitangent
} );

export const DotProducts = struct( {
	NoL: 'float', // Normal • Light
	NoV: 'float', // Normal • View
	NoH: 'float', // Normal • Half
	VoH: 'float', // View • Half
	LoH: 'float', // Light • Half
	// Anisotropy tangent-frame projections (0 unless computed via computeDotProductsAniso).
	// T = anisotropy tangent, B = anisotropy bitangent.
	ToH: 'float', BoH: 'float',
	ToV: 'float', BoV: 'float',
	ToL: 'float', BoL: 'float',
} );

// Kulla-Conty DFG approximation outputs (computed once, consumed by both
// the multiscatter compensation factor and the total directional albedo).
export const DFGResult = struct( {
	compensation: 'vec3', // 1 + F0 * (1/Ew - 1)
	E_total: 'vec3', // clamp(E_ss * compensation, 0, 1)
} );

export const MaterialSamples = struct( {
	albedo: 'vec4',
	emissive: 'vec3',
	metalness: 'float',
	roughness: 'float',
	normal: 'vec3',
	hasTextures: 'bool',
} );

export const MaterialClassification = struct( {
	isMetallic: 'bool', // metalness > 0.7
	isRough: 'bool', // roughness > 0.8
	isSmooth: 'bool', // roughness < 0.3
	isTransmissive: 'bool', // transmission > 0.5
	hasClearcoat: 'bool', // clearcoat > 0.5
	isEmissive: 'bool', // has emissive contribution
	complexityScore: 'float', // 0-1 score for material complexity
} );

export const UVCache = struct( {
	albedoUV: 'vec2',
	normalUV: 'vec2',
	metalnessUV: 'vec2',
	emissiveUV: 'vec2',
	bumpUV: 'vec2',
	roughnessUV: 'vec2',

	// Redundancy flags
	normalBumpSameUV: 'bool',
	metalRoughSameUV: 'bool',
	albedoEmissiveSameUV: 'bool',
	allSameUV: 'bool',
} );

// Material cache — precomputed BRDF terms for the current surface hit.
// Fields are split into two groups:
//   1. BRDF evaluation: F0, NoV, diffuseColor, isPurelyDiffuse, alpha, k, alpha2
//   2. BRDF weight calc: invRoughness, metalFactor, iorFactor, maxSheenColor
// Shared inputs to calculateBRDFWeights, which is the only reader.
export const MaterialCache = struct( {
	invRoughness: 'float', // 1.0 - roughness
	metalFactor: 'float', // 0.5 + 0.5 * metalness
	iorFactor: 'float', // min(2.0 / ior, 1.0)
	maxSheenColor: 'float', // max component of sheen color
} );


// General rendering state (used across all rendering paths)
export const RenderState = struct( {
	traversals: 'int', // Remaining general bounces
	transmissiveTraversals: 'int', // Remaining transmission-specific bounces
	rayType: 'int', // Current ray type (RAY_TYPE_*)
	isPrimaryRay: 'bool', // True only for camera rays (bounceIndex == 0)
	actualBounceDepth: 'int', // True depth without manipulation
} );

