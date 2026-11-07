
// Ray distance NormalDepth writes on a miss. Max finite half-float, so miss−miss diffs stay 0
// rather than Inf−Inf=NaN.
export const GBUFFER_MISS_DEPTH = 65504.0;
export const GBUFFER_MISS_THRESHOLD = 6e4;

// The live view's denoisers, for setDenoiserStrategy.
export const DENOISER_STRATEGIES = Object.freeze( [ 'none', 'nrd', 'oidn' ] );

// normHitDist = hitDist / (A + B·viewZ). A constant, not a uniform: the Shade write and the NRD
// decode must agree, and the normalization is a pure round trip.
export const NRD_HIT_DIST_A = 3.0;
export const NRD_HIT_DIST_B = 0.1;

// NRD ReBLUR port (viewer/denoise/NRD.js). Names follow nrd::ReblurSettings so NVIDIA's tuning notes apply.
export const NRD_DEFAULTS = {
	maxAccumulatedFrameNum: 30,
	maxFastAccumulatedFrameNum: 6,
	maxStabilizedFrameNum: 63,
	historyFixFrameNum: 3,
	historyFixBasePixelStride: 14,
	prepassBlurRadius: 30,
	minBlurRadius: 1,
	maxBlurRadius: 30,
	lobeAngleFraction: 0.15,
	roughnessFraction: 0.15,
	planeDistanceSensitivity: 0.02,
	minHitDistanceWeight: 0.1,
	fastHistoryClampingSigmaScale: 2.0,
	fireflySuppressorMinRelativeScale: 2.0,
	enableAntiFirefly: true,
	antilagLuminanceSigmaScale: 2.0,
	antilagLuminanceSensitivity: 3.0,
	disocclusionThreshold: 0.01,
	convergenceS: 1.0,
	convergenceB: 0.2,
	convergenceP: 0.8,
	// Share of the lobe the normal weight accepts before any history exists. NRD's own constant is
	// 0.75, which its source flags as probably too much; at that width it smears curved surfaces.
	lobeVolumePercent: 0.1,
	// Progressive handover: input sample count at which the denoiser passes the render through untouched.
	// 0 = 2 · maxAccumulatedFrameNum.
	handoverFrames: 0,
};

// Keys a preset may override. Applying one resets every key to its default first, so a preset only
// states its deltas and `medium` can be empty.
export const NRD_PRESET_KEYS = [
	'maxAccumulatedFrameNum', 'maxFastAccumulatedFrameNum', 'maxStabilizedFrameNum',
	'historyFixFrameNum', 'prepassBlurRadius', 'maxBlurRadius', 'enableAntiFirefly',
];

export const NRD_QUALITY_PRESETS = {
	// Short history + no pre-pass: most responsive, noisiest.
	low: {
		maxAccumulatedFrameNum: 16,
		maxFastAccumulatedFrameNum: 4,
		maxStabilizedFrameNum: 16,
		historyFixFrameNum: 2,
		prepassBlurRadius: 0,
		maxBlurRadius: 20,
		enableAntiFirefly: false,
	},
	// nrd::ReblurSettings defaults.
	medium: {},
	// Longer history and wider kernels: smoother, more lag on lighting change.
	high: {
		maxAccumulatedFrameNum: 45,
		maxFastAccumulatedFrameNum: 8,
		historyFixFrameNum: 4,
		prepassBlurRadius: 40,
		maxBlurRadius: 40,
	},
};

// A denoised pixel leans back towards its input where it changed by more than the input's noise explains: over a
// (2·radius + 1)² window, variance / change is the share of the denoised colour with the least squared error. OIDN
// starts at minSamples. `slack` scales the variance: where a few samples carry the light (caustics) a window's estimate
// can read low, and leaning on it brings the input's own noise back as specks.
export const DENOISE_BLEND = { radius: 4, minSamples: 8, slack: 1.25 };

export const DENOISE_BLEND_WGSL = /* wgsl */`
fn denoiseBlend( denoised: vec3f, input: vec3f, change: f32, variance: f32, weight: f32 ) -> vec3f {
	let share = select( 1.0, min( variance / change, 1.0 ), change > 0.0 );
	return mix( denoised, input, weight * ( 1.0 - share ) );
}`;

/** How far OIDN's blend may lean towards the input at `samples` per pixel: 0 below minSamples, 1 from twice that. */
export const denoiseBlendWeight = ( samples, minSamples = DENOISE_BLEND.minSamples ) =>
	Math.min( Math.max( ( samples - minSamples ) / minSamples, 0 ), 1 );

// What the live denoisers, the final OIDN pass and the AI upscaler start with; a host's own state seeds from these.
export const DENOISER_DEFAULTS = {
	denoiserStrategy: 'none', // the live view's denoiser, one of DENOISER_STRATEGIES

	enableOIDN: false,
	oidnQuality: 'fast',
	// OIDN as the live-view denoiser, refreshing the accumulating image. Set by choosing 'oidn' in
	// the real-time denoiser list, so that only ever one thing denoises the live view — not by
	// `enableOIDN`, which is the separate question of whether the finished image gets a pass.
	continuousDenoise: false,
	// Lower bound on the gap between cadence denoises. DenoisingManager also floors that gap at a
	// multiple of what the last denoise actually cost, and above ~1024² that is what binds — this
	// value only governs where a denoise is cheap. 8 ms measured 31 refreshes/sec at 512² at an
	// unchanged sample rate; 50 ms measured 18/sec for nothing in return.
	continuousDenoiseInterval: 8,
	// While the view moves, feed OIDN the reprojected history of restarted frames, not one sample.
	oidnTemporalHistory: true,

	enableUpscaler: false,
	upscalerScale: 2,
	upscalerQuality: 'fast',
	upscalerHdr: true,

	// NRD (ReBLUR port) real-time denoiser — see NRD_DEFAULTS / NRD_QUALITY_PRESETS.
	nrdQualityPreset: 'medium',
	nrdDebugMode: 0,
};
