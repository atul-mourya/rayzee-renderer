
// Ray distance NormalDepth writes on a miss. Max finite half-float, so miss−miss diffs stay 0
// rather than Inf−Inf=NaN.
export const GBUFFER_MISS_DEPTH = 65504.0;
export const GBUFFER_MISS_THRESHOLD = 6e4;

// Albedo demodulation safety floor. ASVGF and BilateralFilter MUST use the
// same value — demod (`color / safeAlbedo`) and remod (`lighting * safeAlbedo`)
// only round-trip exactly when both sides agree.
export const ALBEDO_EPS = 0.01;

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

// normHitDist = hitDist / (A + B·viewZ). A constant, not a uniform: the Shade write and the NRD
// decode must agree, and the normalization is a pure round trip.
export const NRD_HIT_DIST_A = 3.0;
export const NRD_HIT_DIST_B = 0.1;

// NRD ReBLUR port (Stages/NRD.js). Names follow nrd::ReblurSettings so NVIDIA's tuning notes apply.
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

const ASVGF_MEDIUM = ASVGF_QUALITY_PRESETS.medium;

// What the live denoisers, the final OIDN pass and the AI upscaler start with; a host's own state seeds from these.
export const DENOISER_DEFAULTS = {
	denoiserStrategy: 'none', // the live view's denoiser: 'none' | 'edgeaware' | 'asvgf' | 'nrd' | 'oidn'

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

	// ASVGF runs its quality preset whenever it is switched on, so its values are that preset's.
	enableASVGF: false,
	asvgfQualityPreset: 'medium',
	asvgfTemporalAlpha: ASVGF_MEDIUM.temporalAlpha,
	asvgfAtrousIterations: ASVGF_MEDIUM.atrousIterations,
	asvgfPhiColor: ASVGF_MEDIUM.phiColor,
	asvgfPhiNormal: ASVGF_MEDIUM.phiNormal,
	asvgfPhiDepth: ASVGF_MEDIUM.phiDepth,
	asvgfPhiLuminance: ASVGF_MEDIUM.phiLuminance,
	asvgfVarianceBoost: ASVGF_MEDIUM.varianceBoost,
	asvgfMaxAccumFrames: ASVGF_MEDIUM.maxAccumFrames,
	// Must be > 0: the gradient also rejects fireflies before the EMA smears them across
	// ~1/alpha frames. At 0 the denoiser measures ~3x worse than no denoiser at 1 spp.
	asvgfGradientStrength: ASVGF_MEDIUM.gradientStrength,
	asvgfGradientSigmaScale: ASVGF_MEDIUM.gradientSigmaScale,
	asvgfGradientNoiseFloor: ASVGF_MEDIUM.gradientNoiseFloor,
	asvgfDebugMode: 0,
	showAsvgfHeatmap: false,

	// NRD (ReBLUR port) real-time denoiser — see NRD_DEFAULTS / NRD_QUALITY_PRESETS.
	nrdQualityPreset: 'medium',
	nrdDebugMode: 0,
};
