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
	denoise: path.resolve( here, '..', 'baselines', 'denoise.json' ),
	freeze: path.resolve( here, '..', 'baselines', 'freeze.json' ),
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

/**
 * Tier-2 per-pixel freeze — the one shipping path no other suite reaches, because `loadScene`
 * pins deterministic mode and that clears `usePixelFreeze`. A bug here rendered at RMSE 4.49
 * instead of 0.03 and passed all 21 quality scenes.
 *
 * Scenes chosen for two different shapes of generate-path work rather than for coverage breadth:
 * smooth diffuse GI where most pixels go quiet early, and emissive NEE where they do not.
 */
export const FREEZE_GATES = {
	// alpha-cutout was measured and REMOVED, not overlooked: its freeze ratio swings 69.6 % across
	// five identical runs (1.765-2.993), because which pixels the frozen set catches on a cutout
	// edge is highly sensitive to readback timing. No ratchet loose enough to be stable there
	// retains any power to detect a regression. The two kept scenes span 3.7 % and 0.9 %.
	scenes: [ 'spheres-gradient', 'cornell-emissive' ],

	// At the SHIPPING threshold (0.02 / stability 8) freeze is measurably inert: 0.00 % of pixels
	// move on every corpus scene at 64 spp, which matches the two standing notes that it does
	// nothing on real interiors either. A rung run there would be hollow by construction — it
	// would compare a render against itself and pass forever. These loosened values are the
	// mildest measured setting that actually freezes pixels (0.77 % of the frame), so the code
	// path executes. This tests the PATH, not the shipping thresholds.
	testThreshold: 0.10,
	testStability: 4,

	// Minimum fraction of perceptibly-differing pixels for the run to count as having exercised
	// freeze at all. Not mere non-identity: both arms are non-deterministic, so readback jitter
	// alone can separate two images. Measured 0.77 % when freeze engages, ~0 when it does not.
	minEngagedFraction: 0.002,

	// Sized from measurement, not taste: five repeat runs spread 3.7 % (spheres-gradient) and
	// 0.9 % (cornell-emissive). 25 % is ~7x the worst of those, and the seeded over-eager freeze
	// that this rung must catch produced +60.7 % and +129.4 % on the same two scenes.
	maxRatioIncrease: 0.25,

	// Backstop against a bad first bless. The ratchet above is relative, so blessing a broken
	// build would make the breakage the permanent floor — which is exactly how
	// spheres-gradient/oidn/64 got blessed at a ratio where the denoiser actively hurts.
	//
	// Legitimate cost at the test threshold is 1.5-2.2x: freezing a pixel at 10 % relative error
	// stops refining it while it is still visibly noisy, which is why shipping uses 0.02 — 5x
	// stricter. 4x leaves room for that while staying far under the 150x the known bug produced.
	maxAbsoluteRatio: 4.0,
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

	// ── App create/dispose retention ──
	//
	// A separate axis from the load/unload loop above: that one reuses a single app and reads
	// VRAMTracker's JS-side estimates, so it is structurally blind to a disposed app whose whole
	// object graph stays reachable. Which is what shipped — a handler on the GPUDevice captured
	// `this`, and the device outlives dispose() through three's module-level listener singletons,
	// so every app ever created stayed alive at ~107 MiB of typed arrays each.
	lifecycleCycles: 4,
	// The texture path, deliberately: the retained bytes are overwhelmingly material texture
	// arrays, and an untextured scene shrinks the signal to the point of hiding it.
	lifecycleScene: 'textured-normalmap',
	// Zero tolerance. A disposed app still reachable after a forced collection is a leak with no
	// benign reading, and the check is machine-independent — unlike any byte count.
	maxLiveDisposedApps: 0,
	// Backstop for retention that survives the app object itself — a freed app whose texture
	// arrays are still held by some cache would pass the WeakRef check and fail here.
	//
	// The floor is not zero: ~2.4 MiB/cycle currently leaks inside three.js, where `Textures`
	// leaves a listener on module-level texture singletons and the node system's property cache
	// pins materials, keeping each renderer's backend, device and WGSL source strings reachable
	// for the page's lifetime. Reproducible to 0.1 MiB across runs and scenes — post-GC reachable
	// bytes is a deterministic measurement, so the limit can sit close to the floor. 4 MiB is
	// 1.7x the floor and 1.7x under the 6.7 MiB/cycle the original leak produced at this scene
	// size. Do not raise it to accommodate a regression; the floor itself is a known bug.
	maxReachableGrowthBytesPerCycle: 4 * 1024 * 1024,
};

/**
 * Real-time denoiser gates.
 *
 * The metric is a RATIO: RMSE(denoised, ground truth) / RMSE(undenoised, ground truth) at the
 * same sample count. Below 1 the denoiser earned its place; above 1 it is making the image
 * worse than not running it at all. A ratio needs no golden and cannot be re-blessed into
 * looking fine, which is the point — the ASVGF chain shipped at 4.7x on a converged image and
 * every existing gate stayed green, because they all compare the path tracer's own
 * accumulation buffer and never look at what the denoiser did to it.
 *
 * Two gates, because a denoiser fails in two directions:
 *
 *  - `mustHelpAtLowSpp` — an ABSOLUTE floor at the bottom rung. That is the regime a real-time
 *    denoiser exists for; failing it means the denoiser is disconnected, mis-wired, or reading
 *    the wrong texture.
 *
 *  - `maxRatioIncrease` — a RATCHET on every rung, following the white-furnace precedent. Both
 *    filters are still above 1.0 at high sample counts, so gating absolutely there would leave
 *    the suite permanently red — which is how a gate stops being read. Blessed ratios may only
 *    shrink, and the absolute ratio is printed on every line so the gap stays visible.
 */
export const DENOISE_GATES = {
	// A ladder, not a single point: the ASVGF regression was a CROSSOVER — it helped at low
	// sample counts and hurt at high ones, so either rung alone would have missed it. Two rungs
	// keeps the suite affordable.
	sppLadder: [ 1, 64 ],
	strategies: [
		{ id: 'asvgf', preset: 'medium' },
		{ id: 'edgeaware' },
		// OIDN was ungated, which left every change to the DDFA aux albedo/normal guide
		// unmeasurable. 'high' is the clean-aux tier production uses.
		{ id: 'oidn', preset: 'high' },
		// The rung above renders inside one tile, so overlap is zero and the tiled path — tile
		// seams, per-tile progressive paint, the overlap-padded inference — is never executed.
		// Both the tile-size waste and the blank-output-canvas bug lived there and neither was
		// visible to this suite. A 128 cap forces 2x2 tiles at the 256 render size. Its ratio is
		// legitimately worse than the single-tile rung (small tiles are below OIDN's own
		// minTileDim), so it carries its own blessed entry.
		{ id: 'oidn', preset: 'high', tileCap: 128, label: 'oidn-tiled' },
	],
	// Chosen for what the edge-stops key on rather than for coverage breadth: diffuse GI (the
	// baseline case), high-variance transmission (the noisiest input the denoiser sees), and
	// textures (albedo demodulation plus mapped normals — the two G-buffer signals the spatial
	// filter weights on).
	//
	// `cornell-emissive` is the obvious fourth and is DELIBERATELY ABSENT: its render is not
	// load-order stable (mean luminance flips +16.6 % once enough scenes load in a session and
	// stays flipped), so the ratio would depend on whether this ran standalone or after
	// `bench quality`. Engine bug, not a suite one — see bench/README.md. Put it back once fixed.
	scenes: [ 'spheres-gradient', 'glass-transmission', 'textured-normalmap' ],
	// Denoised RMSE must be below raw at the cheapest rung. Absolute, not blessed — but the
	// margin is thinner than it looks: the tightest observed combination is
	// textured-normalmap/asvgf at 0.982. That is deliberate rather than lucky. Deterministic
	// mode makes both renders bit-identical run to run, so the ratio has no measurement noise
	// and a thin margin costs nothing in flakiness — it only moves when code moves.
	mustHelpAtLowSpp: 1.0,
	// Ratchet headroom. Deterministic mode makes an unchanged render bit-identical, so this
	// only needs room for last-bit drift from a three.js / driver / Chrome bump.
	maxRatioIncrease: 0.02,
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

/**
 * Per-kernel GPU profiling (`bench kernels`).
 *
 * Exists because `perf`/`ab` cannot resolve the work that actually dominates this renderer. Two
 * reasons, both measured: the corpus renders at 256², where the wavefront's fixed per-bounce cost is
 * ~24 % of the frame and traversal is nearly invisible; and ms/sample for the whole frame buries a
 * change to one kernel under every other pass. This mode fixes both — it renders where the frame is
 * compute-bound and attributes GPU time per kernel, so a change to `extend` is judged against
 * `extend`'s own noise floor rather than the frame's.
 *
 * Single-tree profiling only. It does not gate; `ab` remains the gate.
 */
export const KERNELS = {
	// Where traversal is actually visible. At 256² the per-bounce floor dominates; prior profiling
	// put the marginal cost at ~30.6 ns/px with a ~2.4 ms floor, so the floor is ~3 % of a 1536²
	// frame versus ~24 % of a 512² one. 1024² is comfortably compute-bound and still quick.
	renderSize: { width: 1024, height: 1024 },

	// Scenes worth profiling by default: geometry-heavy enough that traversal dominates. Kept short
	// because every sample here costs ~16x a 256² one. Override with --only.
	defaultScenes: [ 'spheres-gradient', 'cornell-emissive', 'glass-transmission' ],

	warmupSamples: 8, // pays the WGSL recompile the render-size change forces
	// Per round. Deliberately smaller than PERF.measureSamples: the per-kernel signal is far
	// cleaner than frame total (no cross-kernel interference), and 1024² samples are expensive.
	measureSamples: 40,
	// The noise floor comes from the spread BETWEEN rounds, not from within-round SE — the same
	// reason compareReplicates exists for the A/B gate. Three rounds is the useful minimum.
	rounds: 3,
	trimFraction: 0.2,
	// Kernels below this share of frame GPU time are folded into an "other" row, so the table shows
	// where time goes rather than 20 rows of noise.
	reportThresholdPct: 0.5,
};
