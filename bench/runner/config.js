/**
 * Bench runner configuration — thresholds, paths and browser flags.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname( fileURLToPath( import.meta.url ) );

export const PATHS = {
	repoRoot: path.resolve( here, '..', '..' ),
	benchRoot: path.resolve( here, '..' ),
	baselines: path.resolve( here, '..', 'baselines' ),
	golden: path.resolve( here, '..', 'baselines', 'golden' ),
	truth: path.resolve( here, '..', 'baselines', 'truth' ),
	probes: path.resolve( here, '..', 'baselines', 'probes.json' ),
	fingerprint: path.resolve( here, '..', 'baselines', 'fingerprint.json' ),
	perfLog: path.resolve( here, '..', 'baselines', 'perf.jsonl' ),
	harness: path.resolve( here, '..', 'harness', 'index.html' ),
};

export const DEV_SERVER = {
	command: 'npm',
	args: [ 'run', 'dev' ],
	cwd: PATHS.repoRoot,
	// The app's vite config does not pin a port and falls back when 5173 is taken, so the
	// runner parses the actual URL out of stdout rather than assuming one.
	readyPattern: /Local:\s+(http:\/\/[^\s]+)/,
	timeoutMs: 90_000,
};

export const CHROME = {
	// Overridable for CI / other platforms.
	executablePath: process.env.CHROME_PATH
		|| '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
	args: [
		'--enable-unsafe-webgpu',
		'--use-angle=metal',
		'--no-sandbox',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-component-update',
		'--disable-background-networking',
		'--disable-sync',
		// Without these a headless page is treated as hidden and setTimeout is clamped to
		// ~1 s, which the render loop hits on every yield.
		'--disable-background-timer-throttling',
		'--disable-backgrounding-occluded-windows',
		'--disable-renderer-backgrounding',
		'--disable-ipc-flooding-protection',
	],
};

export const TIMEOUTS = {
	// The first scene load in a session compiles the whole wavefront to WGSL (~20 s
	// measured on Apple M-series); ground-truth renders are thousands of samples.
	boot: 180_000,
	sceneLoad: 180_000,
	render: 900_000,
};

/**
 * Quality gates.
 *
 * Two independent signals, because they fail for different reasons:
 *  - `bias`  — mean linear luminance vs ground truth. Catches energy bugs (a missing 4π,
 *              a clamp eating light, a broken MIS weight). Should be near zero always.
 *  - `noise` — RMSE vs ground truth at fixed spp. Catches sampling-efficiency loss.
 *
 * The golden comparison is deliberately looser than the truth comparison: goldens exist
 * to flag "something moved", truth exists to flag "something got worse".
 */
export const QUALITY_GATES = {
	// vs ground truth — these cannot drift, because the reference never moves.
	truth: {
		maxBiasRatioDelta: 0.005, // 0.5 % mean-luminance shift
		maxRmseIncrease: 0.02, // RMSE may not worsen by more than 2 % relative
	},
	// vs the last blessed golden.
	//
	// Deterministic mode makes an unchanged render BIT-IDENTICAL to its golden (rmse
	// exactly 0), so these only need headroom for legitimate last-bit drift from a
	// three.js bump, a driver update or a Chrome update — not for renderer noise.
	// Calibrated against a seeded 3 % energy regression, which produced rmse 0.0096 and
	// would have slipped under a 0.01 limit; the per-pixel check never fired at all,
	// because a uniform brightening moves every pixel a little and none of them a lot.
	golden: {
		maxRmse: 0.002,
		maxFractionOverThreshold: 0.01, // 1 % of pixels may differ perceptibly
		pixelThreshold: 0.01,
	},
	// White furnace — a RATCHET, not an absolute gate. Several BSDFs are known to violate
	// energy conservation today (see bench/README.md), so gating on |ratio - 1| would leave the
	// suite permanently red, which is how a gate stops being read. Instead each scene's current
	// deviation is blessed and may only shrink. The absolute deviation is always reported, so
	// the outstanding bugs stay visible without blocking unrelated work.
	//
	// The tolerance only needs headroom for last-bit drift from a three.js/driver/Chrome bump:
	// deterministic mode makes an unchanged render bit-identical, so the ratio is exactly
	// reproducible run to run.
	furnace: {
		maxDeviationIncrease: 0.001, // 0.1 percentage points
	},
};

export const MEMORY_GATES = {
	leakCycles: 5,
	// Cycled unless --scene overrides. A textured scene is not optional here: every VRAM leak
	// in this repo's history was in the texture path (disabled-stage GPUTexture retention, the
	// TextureCache use-after-free, the per-textured-swap GPUTexture leak), and the untextured
	// scene that used to be the sole default allocates no texture arrays at all — so the suite
	// was watching the one code path with no leak history in it.
	leakScenes: [ 'spheres-gradient', 'textured-normalmap' ],
	// Peak VRAM growth across N identical load/unload cycles. Nonzero tolerance because
	// lazy allocations legitimately land on cycle 2 (e.g. a stage's first dispatch).
	maxPeakGrowthBytes: 8 * 1024 * 1024,
	// A monotonic climb across every cycle is a leak even when each step is small.
	forbidMonotonicGrowth: true,
};

export const PERF = {
	warmupSamples: 16, // discarded: the first render after a load pays WGSL compilation
	// Each measurement renders exactly ONE sample then resolves timestamp queries.
	// Resolving once after an N-sample render would report whichever frame landed last,
	// not the average — that produced cv > 100 % before this was fixed.
	// Production dispatch sizing is readback-driven, so per-frame cost is legitimately
	// bimodal (cv 30-40 %) even when throughput is stable. Resolving a ~10 % regression
	// through that needs roughly (2*sqrt(2)*cv/0.10)^2 samples; at 3-5 ms of GPU each,
	// 150 costs under a second per scene. Fewer samples do not make the gate quieter —
	// they make every verdict 'inconclusive', which is a gate that never fires.
	measureSamples: 150,
	// Fraction of the slowest readings discarded as driver/OS scheduling hiccups rather
	// than renderer cost.
	trimFraction: 0.2,

	// A/B only. The verdict's noise floor comes from the spread BETWEEN these rounds, not
	// from within-run sampling error — see compareReplicates in lib/stats.js for the measured
	// reason. Two rounds is the minimum that can estimate anything; three is the useful floor.
	abRepeats: 3,
	// Per round, so total samples per side stay comparable to a single 150-sample pass and an
	// A/B costs roughly what it did before replication was added. The per-round standard error
	// is correspondingly wider, which no longer matters because it is not what gates.
	abMeasureSamples: 60,
	// Absolute band below which an A/B delta is called unchanged, whatever the rounds say.
	//
	// MACHINE-SPECIFIC, and calibrated by measurement rather than chosen: a self-A/B of HEAD
	// against itself on an idle M-series produced per-scene deltas up to 6.2 %, because the two
	// harnesses are separate WebGPU devices in one browser and the second page created is
	// systematically a little slower. No amount of replication removes that — it is a bias, not
	// variance — so the band has to sit above it. 8 % leaves a thin margin over the worst
	// observed case, which means this gate resolves roughly a 10 % regression and nothing
	// finer. Re-derive it with `bench:ab -- HEAD` on a clean tree before trusting it elsewhere.
	//
	// The excursions concentrate in the two cheapest scenes (< 1 ms/sample), where fixed
	// per-dispatch overhead is a large fraction of the measurement.
	abUnchangedPct: 8,
};
