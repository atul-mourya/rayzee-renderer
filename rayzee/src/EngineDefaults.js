/** Default values of the render settings and materials, and the presets built on them. */

/**
 * The default of every render setting, under the setting's own name: each key is a RenderSettings route
 * and nothing else lives here. A viewer piece keeps its own defaults beside its code.
 */
export const ENGINE_DEFAULTS = deepFreeze( {

	// Light paths
	maxBounces: 3,
	transmissiveBounces: 5,
	maxSubsurfaceSteps: 8, // a low cap on the subsurface random walk; the final tier raises it
	maxTransparentBounces: 32, // alpha skips are free bounces; uncapped, cutout foliage eats the loop
	integrator: 'path', // 'path' | 'bidirectional' | 'vcm'
	shadowRays: 'two', // 'all' | 'two' | 'one' — shadow rays a hit (path integrator)
	samplingTechnique: 2, // 0 PCG, 1 Halton, 2 Sobol
	enableEmissiveTriangleSampling: false,
	emissiveBoost: 1.0,
	enableAlphaShadows: false,
	fireflyThreshold: 3.0,
	shadowTerminatorOffset: 0.1, // Cycles' Geometry Offset at Blender's default; 0 turns it off
	globalIlluminationIntensity: 1,
	wavefrontSortMaterials: true, // sort rays by material before Shade (above 8 materials); read when kernels build

	// Sampling and convergence
	maxSamples: 60,
	renderLimitMode: 'frames',
	renderTimeLimit: 30,
	renderMode: 0, // 0 preview, 1 production; configureForMode() sets it
	useAdaptiveSampling: true,
	noiseThreshold: 0.1, // a pixel under this √-luminance noise has converged; the interactive tier's value
	adaptiveMinSamples: 8,
	adaptiveStopFraction: 0.90, // a calibration, not a dial: the share of converged pixels that retires a frame
	usePixelFreeze: true,
	// Stricter than noiseThreshold on purpose: it tests plain relative error, and a pixel frozen before it
	// passes the frame's own test never will.
	pixelFreezeThreshold: 0.02,
	pixelFreezeStability: 8, // candidate frames in a row before a pixel freezes
	convergenceOverlay: false, // display only; never alters the render
	interactionModeEnabled: true,

	// Output
	exposure: 1,
	saturation: 1.0, // no grade
	transparentBackground: false,
	backgroundColor: '#000000', // what a camera miss shows when the backdrop is a solid colour

	// Environment and background
	enableEnvironment: true,
	environmentIntensity: 1,
	environmentRotation: 0.0, // degrees; 0 is the HDRI as authored, as Blender shows it
	showBackground: true,
	backgroundIntensity: 1,
	backgroundBlurriness: 0, // blurs the backdrop only; lighting and reflections stay sharp
	backgroundBlurSamples: 8,
	groundProjectionEnabled: false,
	groundProjectionRadius: 100,
	groundProjectionHeight: 15,
	groundProjectionLevel: 0, // world Y of the projected ground; seeded to the scene's floor on load
	enableGroundCatcher: false,
	groundCatcherHeight: 0,

	// Camera
	cameraProjection: 'perspective', // 'perspective' | 'orthographic' | 'equirectangular'
	panoramaLonRange: [ - 180, 180 ], // degrees
	panoramaLatRange: [ - 90, 90 ],
	panoramaLevelHorizon: true,
	enableDOF: false,
	dofMode: 'look', // 'look': set by how blurry it looks, right at any scene scale; 'physical': a real lens
	dofBlur: 0.05, // look mode: a far background's blur, as a fraction of the image height
	focusDistance: 0.8,
	aperture: 5.6,
	focalLength: 50,
	apertureScale: 1.0,
	anamorphicRatio: 1.0,
	unitsPerMetre: 1, // scene units per real metre; the lens is in mm

	// Read when a model loads
	maxTextureSize: 4096, // longest edge of a material texture; clamped to the hardware ceiling
	areaLightIntensityScale: 0.1, // power of a glTF model's placeholder area lights (RectAreaLight extras)

	// Debug
	visMode: 0, // a debug view (TSL/Debugger.js); 0 renders normally
	debugVisScale: 100,

} );

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
	maxSamples: ENGINE_DEFAULTS.maxSamples, bounces: ENGINE_DEFAULTS.maxBounces,
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
