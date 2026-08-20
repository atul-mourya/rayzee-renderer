/**
 * Engine-owned default values and configuration constants.
 * These are used exclusively by the rendering engine (src/core/)
 * and should not depend on any UI framework or external modules.
 */

export const ENGINE_DEFAULTS = {
	// Canvas output
	resolution: 512,
	canvasWidth: 512,
	canvasHeight: 512,

	// Max material-texture dimension (longest edge) used when processing a scene's
	// textures into GPU arrays. Larger = sharper textures but ~quadratic VRAM. Clamped
	// to TEXTURE_CONSTANTS.MAX_TEXTURE_SIZE (hardware ceiling). Applied at scene load.
	maxTextureSize: 4096,

	toneMapping: 4,
	exposure: 1,
	saturation: 1.2,
	enableEnvironment: true,
	showBackground: true,
	transparentBackground: false,
	environmentIntensity: 1,
	backgroundIntensity: 1,
	// Solid backdrop color shown on camera-ray misses in 'color' background mode
	// (showBackground=false, transparentBackground=false). Black = legacy hidden-backdrop look.
	backgroundColor: '#000000',
	// Backdrop blur (env background only). 0 = sharp/off (no cost). Cone-jitter blur of the
	// primary-ray env lookup; lighting/reflections stay sharp. Samples = taps/frame (noise vs cost).
	backgroundBlurriness: 0,
	backgroundBlurSamples: 8,
	environmentRotation: 270.0,
	groundProjectionEnabled: false,
	groundProjectionRadius: 100,
	groundProjectionHeight: 15,
	// World Y of the projected ground plane; auto-seeded to the scene floor (min-Y) on model
	// load so models that aren't authored at y=0 sit ON the ground instead of sinking into it.
	groundProjectionLevel: 0,
	// Analytic ground-plane shadow catcher (primary-ray holdout; no geometry)
	enableGroundCatcher: false,
	groundCatcherHeight: 0,
	globalIlluminationIntensity: 1,

	// Environment Mode System
	environmentMode: 'hdri', // 'hdri' | 'procedural' | 'gradient' | 'color'

	// Gradient Sky Colors
	gradientZenithColor: '#0077BE',
	gradientHorizonColor: '#87CEEB',
	gradientGroundColor: '#654321',

	// Solid Color Sky
	solidSkyColor: '#87CEEB',

	// Procedural Sky Parameters (Preetham Model - Clear Morning preset)
	skySunAzimuth: 90,
	skySunElevation: 20,
	skySunIntensity: 15.0,
	skyRayleighDensity: 0.9,
	skyTurbidity: 0.8,
	skyMieAnisotropy: 0.76,
	skyPreset: 'clearMorning',

	// Camera projection — 'perspective' | 'equirectangular'. Panorama ranges are UI-facing degrees.
	cameraProjection: 'perspective',
	panoramaLonRange: [ - 180, 180 ],
	panoramaLatRange: [ - 90, 90 ],
	panoramaLevelHorizon: true,

	enableDOF: false,
	fov: 55,
	focusDistance: 0.8,
	aperture: 5.6,
	focalLength: 50,
	apertureScale: 1.0,
	anamorphicRatio: 1.0,

	// Auto-focus
	autoFocusMode: 'auto', // 'manual' | 'auto'
	afScreenPoint: { x: 0.5, y: 0.5 },
	afSmoothingFactor: 0.15,

	enablePathTracer: true,
	enableAccumulation: true,
	pauseRendering: false,
	maxSamples: 60,
	bounces: 3,
	transmissiveBounces: 5,
	maxSubsurfaceSteps: 8, // interactive default: low cap (bounded random-walk SSS)

	maxTransparentBounces: 32, // guard: alpha skips are free bounces, else cutout foliage eats the loop budget

	// Adaptive sampling (Blender-style): stop the frame once enough pixels drop below the noise threshold.
	useAdaptiveSampling: true,
	// √-luminance-normalized per-pixel noise below which a pixel counts as converged. Base tracks the
	// interactive tier — that is what a freshly booted engine renders before configureForMode runs.
	noiseThreshold: 0.1,
	adaptiveMinSamples: 8, // min samples before adaptive sampling can trigger
	// Fraction of pixels that must pass the 3×3-eroded convergence count before the frame retires; the
	// geometry-only fraction has to clear the same bar (PathTracer._isConvergedComplete).
	// ENGINE-INTERNAL: a calibration constant rather than a quality dial — it only means anything against
	// those two counts. configureForMode supplies the per-tier value.
	adaptiveStopFraction: 0.90,
	// Per-pixel freeze: skip tracing pixels that individually converged (noise threshold only — no dark floor,
	// which would bake dim regions too dark). Naturally engages only on static/idle views.
	// Set together with useAdaptiveSampling by the single UI switch — two tiers of one feature.
	usePixelFreeze: true,
	// ENGINE-INTERNAL, and not the sibling of noiseThreshold it looks like: freeze bars on plain relErr where
	// the frame test uses the √-normalized error, so the same number is 2-5× stricter here. Deriving it from
	// noiseThreshold was measured and rejected — a pixel frozen before it satisfies the frame test can never
	// satisfy it afterwards, so a looser bar delays the early stop rather than hastening it.
	pixelFreezeThreshold: 0.02,
	pixelFreezeStability: 8, // ENGINE-INTERNAL: consecutive candidate frames before a pixel freezes
	convergenceOverlay: false, // display-only Compositor overlay; never alters the render

	samplingTechnique: 2,
	enableEmissiveTriangleSampling: false,
	emissiveBoost: 1.0,

	fireflyThreshold: 3.0,
	// Wavefront material-coherence sort: global counting-sort of entering rays by material before
	// Shade (material-pure workgroups), under dynamic dispatch. Measured −8% at 1024²/8b. Gated on
	// material count > 8; the histogram bin count is sized per-scene to the material count.
	wavefrontSortMaterials: true,
	renderLimitMode: 'frames',
	renderTimeLimit: 30,
	renderMode: 0,
	enableAlphaShadows: false,
	tilesHelper: true, // show OIDN denoise / AI upscale tile progress overlay
	showLightHelper: false,

	directionalLightIntensity: 0,
	directionalLightColor: "#ffffff",
	directionalLightPosition: [ 1, 1, 1 ],
	directionalLightAngle: 0.0,

	// EdgeAware denoiser (spatial-only SVGF à-trous). filterStrength: final blend
	// (0 = raw, 1 = filtered). edgeAtrousIterations: à-trous passes (step 1,2,4,8,16).
	// edgePhiLuminance: variance-scaled luminance edge-stop. edgePhiNormal: normal cone
	// exponent. edgePhiDepth: RELATIVE depth tolerance (fraction of ray distance).
	filterStrength: 1.0,
	edgeAtrousIterations: 5,
	edgePhiLuminance: 4.0,
	edgePhiNormal: 64.0,
	edgePhiDepth: 0.1,

	enableOIDN: false,
	oidnQuality: 'fast',
	debugGbufferMaps: false,

	enableUpscaler: false,
	upscalerScale: 2,
	upscalerQuality: 'fast',
	upscalerHdr: true,

	debugMode: 0,
	debugThreshold: 100,
	debugModel: 0,

	enableBloom: false,
	bloomStrength: 0.2,
	bloomRadius: 0.15,
	bloomThreshold: 0.85,
	interactionModeEnabled: true,
	debugVisScale: 100,

	// Denoising strategy
	denoiserStrategy: 'none',

	enableASVGF: false,
	asvgfTemporalAlpha: 0.1,
	asvgfAtrousIterations: 8,
	asvgfPhiColor: 10.0,
	asvgfPhiNormal: 128.0,
	asvgfPhiDepth: 1.0,
	asvgfVarianceBoost: 1.0,
	asvgfMaxAccumFrames: 32,
	// Must be > 0: the gradient also rejects fireflies before the EMA smears them across
	// ~1/alpha frames. At 0 the denoiser measures ~3x worse than no denoiser at 1 spp.
	asvgfGradientStrength: 1.0,
	asvgfGradientSigmaScale: 2.0,
	asvgfGradientNoiseFloor: 0.0,
	asvgfDebugMode: 0,
	asvgfQualityPreset: 'medium',
	showAsvgfHeatmap: false,

	// Auto-exposure settings
	autoExposure: false,
	autoExposureKeyValue: 0.18,
	autoExposureMinExposure: 0.1,
	autoExposureMaxExposure: 20.0,
	autoExposureAdaptSpeedBright: 3.0,
	autoExposureAdaptSpeedDark: 0.5,
};

// Albedo demodulation safety floor. ASVGF and BilateralFilter MUST use the
// same value — demod (`color / safeAlbedo`) and remod (`lighting * safeAlbedo`)
// only round-trip exactly when both sides agree.
export const ALBEDO_EPS = 0.01;

// Hard ceiling the engine supports for the reserved (pre-allocated) render size. 4K (3840×2160)
// fits within 4096². Raising the reserved size to this pins ~1.5 GB of MRT textures — opt-in only.
export const MAX_RESERVABLE_RENDER_SIZE = 4096;

// Reserved render size: every per-resolution compute StorageTexture + aux buffer is pre-allocated at
// this SQUARE size and never resized at runtime (works around three.js StorageTexture-resize bugs —
// see TSL/patches history). Render resolution must not exceed it; the engine warns + ignores larger.
// It is a LIVE binding (mutable) so it can be raised (e.g. for 4K) via setReservedRenderSize(); consumers
// read it inside their constructors, and stages already built at a lower value are re-initialised in place
// by PathTracerApp.setReservedRenderResolution() — which is the device-gated API hosts should call, at any
// point in the lifecycle. Default 2048 (zero VRAM regression). See docs/internal/specs/wavefront-chunked-pool.md.
export let MAX_STORAGE_TEXTURE_SIZE = 2048;

// Set the reserved render size. MUST be called before pipeline construction (stages pre-allocate at
// this value and cannot resize). Clamped to [256, MAX_RESERVABLE_RENDER_SIZE]. Returns the applied value.
export function setReservedRenderSize( px ) {

	MAX_STORAGE_TEXTURE_SIZE = Math.max( 256, Math.min( MAX_RESERVABLE_RENDER_SIZE, Math.floor( px ) || 256 ) );
	return MAX_STORAGE_TEXTURE_SIZE;

}

export const ASVGF_QUALITY_PRESETS = {
	// phiColor / phiDepth are RELATIVE tolerances (fractions). Bigger = more
	// permissive. The adaptive temporal gradient (gradientStrength > 0) is always
	// on: it measures real change in units of noise σ (gradientSigmaScale), so a
	// static scene reads ~0 (no convergence penalty) and only moving lights / anim
	// / disocclusion drop history. See ASVGF._buildGradientCompute.
	low: {
		temporalAlpha: 0.1,
		gradientStrength: 0.8,
		gradientSigmaScale: 2.5,
		gradientNoiseFloor: 0.05,
		atrousIterations: 3,
		phiColor: 1.0,
		phiNormal: 64.0,
		phiDepth: 0.1,
		phiLuminance: 6.0,
		maxAccumFrames: 16,
		varianceBoost: 0.5
	},
	medium: {
		temporalAlpha: 0.03,
		gradientStrength: 1.0,
		gradientSigmaScale: 2.5,
		gradientNoiseFloor: 0.05,
		atrousIterations: 4,
		phiColor: 0.5,
		phiNormal: 128.0,
		phiDepth: 0.05,
		phiLuminance: 4.0,
		maxAccumFrames: 64,
		varianceBoost: 1.0
	},
	high: {
		temporalAlpha: 0.0,
		gradientStrength: 1.0,
		gradientSigmaScale: 2.5,
		gradientNoiseFloor: 0.05,
		atrousIterations: 6,
		phiColor: 0.3,
		phiNormal: 256.0,
		phiDepth: 0.02,
		phiLuminance: 2.0,
		maxAccumFrames: 128,
		varianceBoost: 1.5
	}
};

export const CAMERA_RANGES = {
	fov: {
		min: 10,
		max: 90,
		default: ENGINE_DEFAULTS.fov
	},
	focusDistance: {
		min: 0.3,
		max: 100.0,
		default: ENGINE_DEFAULTS.focusDistance
	},
	aperture: {
		options: [ 1.4, 2.0, 2.8, 4.0, 5.6, 8.0, 11.0, 16.0 ],
		default: ENGINE_DEFAULTS.aperture
	},
	focalLength: {
		min: 0,
		max: 200,
		default: ENGINE_DEFAULTS.focalLength
	}
};

export const SKY_PRESETS = {
	clearMorning: {
		name: "Clear Morning",
		sunAzimuth: 90,
		sunElevation: 20,
		sunIntensity: 15.0,
		rayleighDensity: 0.9,
		turbidity: 0.8,
	},
	clearNoon: {
		name: "Clear Noon",
		sunAzimuth: 0,
		sunElevation: 75,
		sunIntensity: 20.0,
		rayleighDensity: 1.0,
		turbidity: 0.3,
	},
	overcast: {
		name: "Overcast",
		sunAzimuth: 0,
		sunElevation: 45,
		sunIntensity: 6.0,
		rayleighDensity: 0.6,
		turbidity: 4.0,
	},
	goldenHour: {
		name: "Golden Hour",
		sunAzimuth: 270,
		sunElevation: 10,
		sunIntensity: 19.0,
		rayleighDensity: 0.8,
		turbidity: 1.2,
	},
	sunset: {
		name: "Sunset",
		sunAzimuth: 270,
		sunElevation: 2,
		sunIntensity: 18.0,
		rayleighDensity: 0.7,
		turbidity: 2.0,
	},
	dusk: {
		name: "Dusk",
		sunAzimuth: 270,
		sunElevation: - 8,
		sunIntensity: 8.0,
		rayleighDensity: 0.5,
		turbidity: 1.5,
	}
};

export const CAMERA_PRESETS = {
	portrait: {
		name: "Portrait",
		description: "Shallow depth of field, background blur",
		fov: 45,
		focusDistance: 1.5,
		aperture: 1.4,
		focalLength: 135,
		apertureScale: 1.5
	},
	landscape: {
		name: "Landscape",
		description: "Maximum depth of field, everything in focus",
		fov: 65,
		focusDistance: 10.0,
		aperture: 16.0,
		focalLength: 24,
		apertureScale: 0.5
	},
	macro: {
		name: "Macro",
		description: "Extreme close-up with thin focus plane",
		fov: 40,
		focusDistance: 0.3,
		aperture: 2.0,
		focalLength: 100,
		apertureScale: 2.0
	},
	product: {
		name: "Product",
		description: "Sharp detail with subtle background separation",
		fov: 50,
		focusDistance: 0.8,
		aperture: 2.8,
		focalLength: 85,
		apertureScale: 1.0
	},
	architectural: {
		name: "Architectural",
		description: "Wide view with deep focus",
		fov: 75,
		focusDistance: 5.0,
		aperture: 11.0,
		focalLength: 16,
		apertureScale: 0.5
	},
	cinematic: {
		name: "Cinematic",
		description: "Dramatic depth separation with anamorphic bokeh",
		fov: 35,
		focusDistance: 3.0,
		aperture: 1.4,
		focalLength: 200,
		apertureScale: 1.8,
		anamorphicRatio: 1.5
	}
};

export const AUTO_FOCUS_MODES = {
	MANUAL: 'manual',
	AUTO: 'auto',
};

export const AF_DEFAULTS = {
	SMOOTHING_FACTOR: 0.15,
	RESET_THRESHOLD: 0.05,
	FALLBACK_DISTANCE: 10.0,
	SNAP_THRESHOLD: 0.5,
};

// Triangle data layout constants - shared between GeometryExtractor and TextureCreator
export const TRIANGLE_DATA_LAYOUT = {
	FLOATS_PER_TRIANGLE: 32,

	// Positions (3 vec4s = 12 floats)
	POSITION_A_OFFSET: 0,
	POSITION_B_OFFSET: 4,
	POSITION_C_OFFSET: 8,

	// Normals (3 vec4s = 12 floats)
	NORMAL_A_OFFSET: 12,
	NORMAL_B_OFFSET: 16,
	NORMAL_C_OFFSET: 20,

	// UVs and Material (2 vec4s = 8 floats)
	UV_AB_OFFSET: 24,
	UV_C_MAT_OFFSET: 28
};

// Material data layout constants — single source of truth for material buffer offsets.
// Shared between CPU writers (TextureCreator, MaterialDataManager) and GPU readers (Common.js getMaterial).
export const MATERIAL_DATA_LAYOUT = {

	SLOTS_PER_MATERIAL: 33, // vec4 slots per material
	FLOATS_PER_MATERIAL: 132, // total floats per material (33 × 4)

	// ── Flat float offsets (CPU side) ────────────────────────────────
	// Used as: data[ materialIndex * FLOATS_PER_MATERIAL + offset ]
	// Ordered for cache-line coherence: shadow/culling → BxDF core → maps → extended → transforms

	// Slot 0: ior + transmission + thickness + emissiveIntensity   [shadow]
	IOR: 0, TRANSMISSION: 1, THICKNESS: 2, EMISSIVE_INTENSITY: 3,
	// Slot 1: attenuationColor.rgb + attenuationDistance            [shadow]
	ATTENUATION_COLOR: 4, ATTENUATION_DISTANCE: 7,
	// Slot 2: opacity + side + transparent + alphaTest              [shadow + culling]
	OPACITY: 8, SIDE: 9, TRANSPARENT: 10, ALPHA_TEST: 11,
	// Slot 3: alphaMode + depthWrite + normalScale                  [shadow]
	ALPHA_MODE: 12, DEPTH_WRITE: 13, NORMAL_SCALE: 14,
	// Slot 4: color.rgb + metalness                                 [BxDF core]
	COLOR: 16, METALNESS: 19,
	// Slot 5: emissive.rgb + roughness                              [BxDF core]
	EMISSIVE: 20, ROUGHNESS: 23,
	// Slot 6: map indices (albedo, normal, roughness, metalness)    [maps]
	ALBEDO_MAP_INDEX: 24, NORMAL_MAP_INDEX: 25, ROUGHNESS_MAP_INDEX: 26, METALNESS_MAP_INDEX: 27,
	// Slot 7: map indices (emissive, bump) + clearcoat              [maps]
	EMISSIVE_MAP_INDEX: 28, BUMP_MAP_INDEX: 29, CLEARCOAT: 30, CLEARCOAT_ROUGHNESS: 31,
	// Slot 8: dispersion + visible + sheen + sheenRoughness         [extended BxDF]
	DISPERSION: 32, VISIBLE: 33, SHEEN: 34, SHEEN_ROUGHNESS: 35,
	// Slot 9: sheenColor.rgb + (reserved)                           [extended BxDF]
	SHEEN_COLOR: 36,
	// Slot 10: specularIntensity + specularColor.rgb                [extended BxDF]
	SPECULAR_INTENSITY: 40, SPECULAR_COLOR: 41,
	// Slot 11: iridescence + iridescenceIOR + iridescenceThicknessRange [extended BxDF]
	IRIDESCENCE: 44, IRIDESCENCE_IOR: 45, IRIDESCENCE_THICKNESS_RANGE: 46,
	// Slot 12: bumpScale + displacementScale + displacementMapIndex + (padding)
	BUMP_SCALE: 48, DISPLACEMENT_SCALE: 49, DISPLACEMENT_MAP_INDEX: 50,

	// ── Transform float offsets (8 floats each: 7 matrix values + 1 padding) ──
	ALBEDO_TRANSFORM: 52,
	NORMAL_TRANSFORM: 60,
	ROUGHNESS_TRANSFORM: 68,
	METALNESS_TRANSFORM: 76,
	EMISSIVE_TRANSFORM: 84,
	BUMP_TRANSFORM: 92,
	DISPLACEMENT_TRANSFORM: 100,

	// ── Subsurface scattering (3 slots appended after transforms) ────
	// Slot 27: subsurfaceColor.rgb (scatter albedo) + subsurface weight
	SUBSURFACE_COLOR: 108, SUBSURFACE: 111,
	// Slot 28: subsurfaceRadius.rgb (mean free path) + radius scale
	SUBSURFACE_RADIUS: 112, SUBSURFACE_RADIUS_SCALE: 115,
	// Slot 29: subsurfaceAnisotropy g (116) + surface anisotropy (strength 117, rotation 118, map index 119)
	SUBSURFACE_ANISOTROPY: 116, ANISOTROPY: 117, ANISOTROPY_ROTATION: 118, ANISOTROPY_MAP_INDEX: 119,
	// Slot 30: extension-texture map indices A (transmission, clearcoat, clearcoatRoughness, sheenColor)
	TRANSMISSION_MAP_INDEX: 120, CLEARCOAT_MAP_INDEX: 121, CLEARCOAT_ROUGHNESS_MAP_INDEX: 122, SHEEN_COLOR_MAP_INDEX: 123,
	// Slot 31: extension-texture map indices B (sheenRoughness, iridescence, iridescenceThickness, specularIntensity)
	SHEEN_ROUGHNESS_MAP_INDEX: 124, IRIDESCENCE_MAP_INDEX: 125, IRIDESCENCE_THICKNESS_MAP_INDEX: 126, SPECULAR_INTENSITY_MAP_INDEX: 127,
	// Slot 32: extension-texture map indices C (specularColor + 3 reserved)
	SPECULAR_COLOR_MAP_INDEX: 128,

	// ── Vec4 slot indices (GPU/TSL side) ─────────────────────────────
	// Used with getDatafromStorageBuffer( buf, matIdx, int(slot), int(SLOTS_PER_MATERIAL) )
	SLOT: {
		IOR_TRANSMISSION: 0, // [shadow] ior, transmission, thickness, emissiveIntensity
		ATTENUATION: 1, // [shadow] attenuationColor, attenuationDistance
		OPACITY_ALPHA: 2, // [shadow+culling] opacity, side, transparent, alphaTest
		ALPHA_MODE: 3, // [shadow] alphaMode, depthWrite, normalScale
		COLOR_METALNESS: 4, // [BxDF] color.rgb, metalness
		EMISSIVE_ROUGHNESS: 5, // [BxDF] emissive.rgb, roughness
		MAP_INDICES_A: 6, // [maps] albedo, normal, roughness, metalness
		MAP_INDICES_B: 7, // [maps] emissive, bump, clearcoat, clearcoatRoughness
		DISPERSION_SHEEN: 8, // [extended] dispersion, visible, sheen, sheenRoughness
		SHEEN_COLOR: 9, // [extended] sheenColor, reserved
		SPECULAR: 10, // [extended] specularIntensity, specularColor
		IRIDESCENCE: 11, // [extended] iridescence, iridescenceIOR, iridescenceThicknessRange
		BUMP_DISPLACEMENT: 12, // bumpScale, displacementScale, displacementMapIndex
		ALBEDO_TRANSFORM_A: 13, ALBEDO_TRANSFORM_B: 14,
		NORMAL_TRANSFORM_A: 15, NORMAL_TRANSFORM_B: 16,
		ROUGHNESS_TRANSFORM_A: 17, ROUGHNESS_TRANSFORM_B: 18,
		METALNESS_TRANSFORM_A: 19, METALNESS_TRANSFORM_B: 20,
		EMISSIVE_TRANSFORM_A: 21, EMISSIVE_TRANSFORM_B: 22,
		BUMP_TRANSFORM_A: 23, BUMP_TRANSFORM_B: 24,
		DISPLACEMENT_TRANSFORM_A: 25, DISPLACEMENT_TRANSFORM_B: 26,
		SUBSURFACE_A: 27, // subsurfaceColor.rgb, subsurface weight
		SUBSURFACE_B: 28, // subsurfaceRadius.rgb, subsurfaceRadiusScale
		SUBSURFACE_C: 29, // subsurfaceAnisotropy g, anisotropy, anisotropyRotation, anisotropyMapIndex
		EXT_MAP_INDICES_A: 30, // transmission, clearcoat, clearcoatRoughness, sheenColor map indices
		EXT_MAP_INDICES_B: 31, // sheenRoughness, iridescence, iridescenceThickness, specularIntensity map indices
		EXT_MAP_INDICES_C: 32, // specularColor map index + 3 reserved
	},

};

// glTF/three.js spell "no volume absorption" as attenuationDistance = Infinity, while the GPU
// contract is `> 0 = on` (calculateBeerLawAbsorption). Every writer into ATTENUATION_DISTANCE
// collapses both spellings to 0 so no shader divides by Inf.
export const normalizeAttenuationDistance = d => ( Number.isFinite( d ) && d > 0 ? d : 0 );

// BVH node leaf markers
export const BVH_LEAF_MARKERS = {
	TRIANGLE_LEAF: - 1, // Leaf containing triangle references
	BLAS_POINTER_LEAF: - 2, // TLAS leaf pointing to a BLAS root node
};

// Texture processing constants
export const TEXTURE_CONSTANTS = {
	PIXELS_PER_MATERIAL: 30,
	RGBA_COMPONENTS: 4,
	VEC4_PER_TRIANGLE: 8,
	VEC4_PER_BVH_NODE: 4,
	FLOATS_PER_VEC4: 4,
	MIN_TEXTURE_WIDTH: 4,
	MAX_CONCURRENT_WORKERS: Math.min( typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4, 6 ),
	BUFFER_POOL_SIZE: 20,
	CANVAS_POOL_SIZE: 12,
	CACHE_SIZE_LIMIT: 50,
	// Hardware ceiling for a single texture-array dimension (WebGPU maxTextureDimension2D
	// guaranteed minimum). The configurable maxTextureSize setting is clamped to this.
	MAX_TEXTURE_SIZE: 8192,
	// Default cap applied when no maxTextureSize is supplied (engine standalone use).
	DEFAULT_MAX_TEXTURE_SIZE: 4096,
	// Max layers (textures) per bucket array. Also the packing stride for (bucket, layer).
	MAX_TEXTURES_LIMIT: 128,
	// Size buckets per colorSpace pool. Material maps are grouped into this many
	// longest-edge size classes so a small map no longer pays a large neighbour's
	// footprint. 4 → ~8 bound material arrays (4 sRGB + 4 linear).
	MATERIAL_BUCKET_COUNT: 4,
	// Packing stride: a map's stored index encodes bucketId * BUCKET_LAYER_STRIDE + layer.
	// Also the per-bucket layer cap. Kept at the WebGPU portable maxTextureArrayLayers floor (256)
	// so a consolidated bucket (which merges several map types of one size) stays portable.
	BUCKET_LAYER_STRIDE: 256,
};

// Longest-edge size ladder for a given cap, ascending.
// cap=4096, count=4 → [512, 1024, 2048, 4096].
export function getTextureBucketSizes( maxTextureSize, count = TEXTURE_CONSTANTS.MATERIAL_BUCKET_COUNT ) {

	const sizes = [];
	for ( let i = count - 1; i >= 0; i -- ) {

		sizes.push( Math.max( TEXTURE_CONSTANTS.MIN_TEXTURE_WIDTH, Math.round( maxTextureSize / Math.pow( 2, i ) ) ) );

	}

	return sizes;

}

// Bucket index for a texture, by its power-of-2 longest edge vs the cap's ladder.
// Larger-than-cap maps land in the top bucket (downscaled to cap, as before).
export function getTextureBucketId( width, height, maxTextureSize, count = TEXTURE_CONSTANTS.MATERIAL_BUCKET_COUNT ) {

	const longest = Math.max( width || 1, height || 1 );
	const pot = Math.pow( 2, Math.ceil( Math.log2( longest ) ) );
	const sizes = getTextureBucketSizes( maxTextureSize, count );
	for ( let i = 0; i < sizes.length; i ++ ) if ( pot <= sizes[ i ] ) return i;
	return sizes.length - 1;

}

// Pack (bucketId, layer) into the single int slot a material map index occupies.
export function packTextureIndex( bucketId, layer ) {

	return bucketId * TEXTURE_CONSTANTS.BUCKET_LAYER_STRIDE + layer;

}

// Default texture matrix for materials
export const DEFAULT_TEXTURE_MATRIX = [ 0, 0, 1, 1, 0, 0, 0, 1 ];

// Render quality configurations.
// 'interactive' — low-sample, bounded bounces, no offline denoising, controls enabled.
// 'production'  — high-sample, deep bounces, OIDN enabled, controls disabled.
export const PRODUCTION_RENDER_CONFIG = {
	// maxSamples is a CEILING: adaptive sampling retires the frame once adaptiveStopFraction of pixels converge,
	// so easy scenes finish well under it while hard GI scenes use the full budget.
	maxSamples: 150, bounces: 20, transmissiveBounces: 8, maxSubsurfaceSteps: 64,
	renderMode: 1, enableAlphaShadows: true,
	// 'high' is the only tier that reaches OIDN's _large weights (calb_cnrm); ~2x denoise cost.
	enableOIDN: true, oidnQuality: 'high',
	interactionModeEnabled: false,
	// 0.94 against the eroded count ≈ the old raw-count 0.98; erosion holds the fraction a few points lower.
	useAdaptiveSampling: true,
	noiseThreshold: 0.02,
	adaptiveStopFraction: 0.94,
	usePixelFreeze: true,
};

export const INTERACTIVE_RENDER_CONFIG = {
	maxSamples: ENGINE_DEFAULTS.maxSamples, bounces: ENGINE_DEFAULTS.bounces,
	renderMode: ENGINE_DEFAULTS.renderMode, enableAlphaShadows: ENGINE_DEFAULTS.enableAlphaShadows,
	transmissiveBounces: ENGINE_DEFAULTS.transmissiveBounces,
	maxSubsurfaceSteps: ENGINE_DEFAULTS.maxSubsurfaceSteps,
	enableOIDN: false, oidnQuality: 'fast',
	interactionModeEnabled: true,
	useAdaptiveSampling: true, // idle refine stops early when converged; frozen during motion
	noiseThreshold: 0.1, // loose: preview wants a fast settle, not a clean one
	usePixelFreeze: true, // speeds up idle refinement on heavy/high-res views; inert while moving (freeze resets)
};

// Memory management constants
export const MEMORY_CONSTANTS = {
	MAX_BUFFER_MEMORY: 1024 * 1024 * 1024,
	MAX_TEXTURE_MEMORY: 2048 * 1024 * 1024,
	CLEANUP_THRESHOLD: 0.8,
	CHUNK_SIZE_THRESHOLD: 64 * 1024 * 1024,
	STREAM_BATCH_SIZE: 4
};
