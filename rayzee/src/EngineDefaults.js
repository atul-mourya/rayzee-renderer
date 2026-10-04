/** Default values of the render settings and materials, and the presets built on them. */

import { sunPosition, dayOfYearForMonth } from './Processor/SunPosition.js';

/** The default sun as a time of day (solar hours), month and latitude; north lies along −Z. */
export const DEFAULT_SUN_PATH = Object.freeze( { time: 10, month: 3, latitude: 40 } );

const DEFAULT_SUN = sunPosition( { hours: DEFAULT_SUN_PATH.time, dayOfYear: dayOfYearForMonth( DEFAULT_SUN_PATH.month ), latitude: DEFAULT_SUN_PATH.latitude } );

export const ENGINE_DEFAULTS = {
	resolution: 512,

	// Max material-texture dimension (longest edge) used when processing a scene's
	// textures into GPU arrays. Larger = sharper textures but ~quadratic VRAM. Clamped
	// to TEXTURE_CONSTANTS.MAX_TEXTURE_SIZE (hardware ceiling). Applied at scene load.
	maxTextureSize: 4096,

	// AgX, matching Blender/Cycles' default view transform. ACES crushes shadows on this
	// engine's own corpus (shade 1.48 vs AgX 3.01 from identical radiance).
	toneMapping: 6,
	exposure: 1,
	saturation: 1.0, // no grade
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
	environmentRotation: 0.0, // degrees — the HDRI as authored, as Blender shows it
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

	// Solid Color Sky
	solidSkyColor: '#87CEEB',

	// Physical sky (Processor/PhysicalSky.js) — the Clear Day preset
	skySunAzimuth: 180 - DEFAULT_SUN.azimuth,
	skySunElevation: DEFAULT_SUN.elevation,
	skySunStrength: 1, // artistic multiplier on the disc and its light; 1 is physical
	skySunSize: 0.53, // angular diameter, degrees
	skyTurbidity: 2, // 1 is aerosol-free air, ~2 a clear day, 6+ hazy
	skyOzone: 300, // Dobson units
	skyAirDensity: 1,
	skyGroundAlbedo: '#959595', // 0.3 linear
	skyAltitude: 50, // metres

	// Camera projection — 'perspective' | 'orthographic' | 'equirectangular'. Panorama ranges are UI-facing degrees.
	cameraProjection: 'perspective',
	panoramaLonRange: [ - 180, 180 ],
	panoramaLatRange: [ - 90, 90 ],
	panoramaLevelHorizon: true,

	enableDOF: false,
	focusDistance: 0.8,
	aperture: 5.6,
	focalLength: 50,
	apertureScale: 1.0,
	anamorphicRatio: 1.0,
	unitsPerMetre: 1, // scene units per real metre; the lens is specified in mm
	// 'look': depth of field set by how blurry it looks, right at any scene scale; 'physical': a real lens.
	dofMode: 'look',
	dofBlur: 0.05, // look mode: a far background's blur, as a fraction of the image height

	enableAccumulation: true,
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
	integrator: 'path', // 'path' | 'bidirectional' | 'vcm'
	shadowRays: 'two', // 'all' | 'two' | 'one' — shadow rays a hit for the lamps, sky, sun and emitters (path integrator)
	enableEmissiveTriangleSampling: false,
	emissiveBoost: 1.0,

	fireflyThreshold: 3.0,
	// Cycles' Shadow Terminator → Geometry Offset, and its default: light shadow rays leave a
	// smooth-shaded triangle from the smooth surface near the terminator. 0 disables.
	shadowTerminatorOffset: 0.1,
	// Wavefront material-coherence sort: global counting-sort of entering rays by material before
	// Shade (material-pure workgroups), under dynamic dispatch. Measured −8% at 1024²/8b. Gated on
	// material count > 8; the histogram bin count is sized per-scene to the material count.
	wavefrontSortMaterials: true,
	renderLimitMode: 'frames',
	renderTimeLimit: 30,
	renderMode: 0,
	enableAlphaShadows: false,
	// Read when a model loads: scales the power of a glTF model's placeholder area lights (RectAreaLight extras).
	areaLightIntensityScale: 0.1,

	debugMode: 0,
	interactionModeEnabled: true,
	debugVisScale: 100,
};

/** The `cameraProjection` uniform's value for each setting value. */
export const CAMERA_PROJECTION_IDS = Object.freeze( { perspective: 0, equirectangular: 1, orthographic: 2 } );


// The only fallback for a property a three.js material doesn't carry: MeshPhysicalMaterial's own
// default (glTF with the extension absent), or the value that turns an engine-only feature off.
export const MATERIAL_DEFAULTS = deepFreeze( {
	color: [ 1, 1, 1 ],
	emissive: [ 0, 0, 0 ],
	emissiveIntensity: 1,
	roughness: 1,
	metalness: 0,
	ior: 1.5,
	opacity: 1,
	transmission: 0,
	thickness: 0,
	attenuationColor: [ 1, 1, 1 ],
	attenuationDistance: Infinity,
	dispersion: 0,
	sheen: 0,
	sheenRoughness: 1,
	sheenColor: [ 0, 0, 0 ],
	specularIntensity: 1,
	specularColor: [ 1, 1, 1 ],
	clearcoat: 0,
	clearcoatRoughness: 0,
	iridescence: 0,
	iridescenceIOR: 1.3,
	iridescenceThicknessRange: [ 100, 400 ],
	normalScale: [ 1, 1 ],
	bumpScale: 1,
	displacementScale: 1,
	transparent: 0,
	alphaTest: 0,
	alphaMode: 0,
	side: 0,
	depthWrite: 1,
	subsurface: 0,
	subsurfaceColor: [ 1, 1, 1 ],
	subsurfaceRadius: [ 1, 0.2, 0.1 ],
	subsurfaceRadiusScale: 1,
	subsurfaceAnisotropy: 0,
	anisotropy: 0,
	anisotropyRotation: 0,
	// KHR_materials_diffuse_transmission: the share of the diffuse lobe passed through to the other side.
	diffuseTransmission: 0,
	diffuseTransmissionColor: [ 1, 1, 1 ],
} );

function deepFreeze( object ) {

	for ( const value of Object.values( object ) ) if ( typeof value === 'object' ) Object.freeze( value );
	return Object.freeze( object );

}

// Render quality configurations.
// 'interactive' — low-sample, bounded bounces, no offline denoising, controls enabled.
// 'production'  — high-sample, deep bounces, OIDN enabled, controls disabled.
export const PRODUCTION_RENDER_CONFIG = {
	// maxSamples is a CEILING: adaptive sampling retires the frame once adaptiveStopFraction of pixels converge,
	// so easy scenes finish well under it while hard GI scenes use the full budget.
	// Below 24 a ray that spends its transmissive budget is shaded opaque — black pixels, not dim glass.
	maxSamples: 30, bounces: 20, transmissiveBounces: 24, maxSubsurfaceSteps: 64,
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
	// 12, not 5: a spent budget leaves black glass and costs MORE — the ray then bounces diffusely.
	transmissiveBounces: 12,
	maxSubsurfaceSteps: ENGINE_DEFAULTS.maxSubsurfaceSteps,
	// On, like production. The final pass costs one cheap denoise when the preview settles, and both
	// neural passes need a denoised frame to be worth running — on Monte-Carlo noise the upscaler
	// measured worse than a plain resize. ⚠️ `DENOISER_DEFAULTS.enableOIDN` stays false: the bench
	// renders against it and every quality golden would move.
	enableOIDN: true, oidnQuality: 'fast',
	interactionModeEnabled: true,
	useAdaptiveSampling: true, // idle refine stops early when converged; frozen during motion
	noiseThreshold: 0.1, // loose: preview wants a fast settle, not a clean one
	usePixelFreeze: true, // speeds up idle refinement on heavy/high-res views; inert while moving (freeze resets)
};

// The RenderSettings a mode preset owns. configureForMode applies these, and anything that borrows a
// mode for a while (the video renderer) restores exactly these keys.
export function modePresetSettings( config ) {

	return {
		maxSamples: config.maxSamples,
		maxBounces: config.bounces,
		transmissiveBounces: config.transmissiveBounces,
		maxSubsurfaceSteps: config.maxSubsurfaceSteps,
		enableAlphaShadows: config.enableAlphaShadows ?? false,
		// Tier-1 convergence early-stop
		useAdaptiveSampling: config.useAdaptiveSampling ?? false,
		noiseThreshold: config.noiseThreshold ?? ENGINE_DEFAULTS.noiseThreshold,
		adaptiveStopFraction: config.adaptiveStopFraction ?? ENGINE_DEFAULTS.adaptiveStopFraction,
		adaptiveMinSamples: config.adaptiveMinSamples ?? ENGINE_DEFAULTS.adaptiveMinSamples,
		// Tier-2 per-pixel freeze
		usePixelFreeze: config.usePixelFreeze ?? false,
		pixelFreezeThreshold: config.pixelFreezeThreshold ?? ENGINE_DEFAULTS.pixelFreezeThreshold,
		pixelFreezeStability: config.pixelFreezeStability ?? ENGINE_DEFAULTS.pixelFreezeStability,
		interactionModeEnabled: config.interactionModeEnabled ?? ENGINE_DEFAULTS.interactionModeEnabled,
	};

}
