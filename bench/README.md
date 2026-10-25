# Rayzee regression bench

Automated detection of **quality**, **performance**, and **memory** regressions in the rendering engine.

The engine's unit tests cover CPU logic, and `tests/gpu/` runs individual TSL functions on the GPU through Dawn, but neither renders a whole scene through the stages, the kernels and the readback — which is where regressions actually happen. This bench closes that gap by rendering a fixed scene corpus in headless Chrome against a real GPU and comparing the results numerically.

## Quick start

```bash
npm run bench:list      # show the scene corpus
npm run bench:bless     # generate ground truth + goldens (first run, slow)
npm run bench           # quality + freeze + lockstep + denoise + memory + perf
npm run bench:calibrate # check this browser's CPU timing against the app (see below)
```

Individual suites:

```bash
npm run bench:quality
npm run bench:freeze       # per-pixel freeze: the same render with and without it
npm run bench:lockstep     # production path reproducible under any pacing
npm run bench:node         # the corpus in plain Node on Dawn, against the Chrome goldens
npm run bench:node -- --core   # …and again with the renderer core, which must match the full engine byte for byte
npm run bench:denoise
npm run bench:upscale      # GPU tone map against the CPU one, then the AI upscaler
npm run bench:memory
npm run bench:perf
npm run bench:kernels      # per-kernel GPU time (--only <scene>; --shipping, --env, --model for real content)
npm run bench:ab -- main    # gate perf against another git ref (`-- <base> --head <ref>` for two refs)
npm run bench:release      # the newest release tag against the one before it, logged for the trend
npm run bench:trend        # results/trend.html: the perf and A/B logs, one chart a scene
npm run bench:load         # real models loaded by phase in Node; -- --ab main, or --base-dir <checkout>, to gate
npm run bench:exposure     # auto (and local) exposure against neither, wall clock (--size 1024x1024)
npm run bench:storage       # raw OPFS throughput (see "Storage" below)
npm run bench:examples     # every example in rayzee/examples runs to the end (see "Examples" below)
npm run bench:lut          # regenerate the DFG lookup table after a lobe or sampler change
```

Useful flags: `--only scene-a,scene-b`, `--verbose`, and `--scene <id>` / `--cycles <n>` for the memory suite.
`--truth` (regenerate ground truth) is accepted only by `bench:bless`. `bench:calibrate -- --compare <file.json>`
prints the stored app timing against a new one captured in the app (before/after a CPU change, no browser needed).

## What the harness can and cannot measure

The harness renders on a real GPU and runs the engine's **CPU** work at the app's speed. Calibrated
on an Apple M5 Pro against the app in a normally-used Chrome, same model (1.9M triangles, 990
meshes):

| | app | harness |
|---|---|---|
| geometry extraction | 0.43 s | 0.44 s |
| BLAS build | 1.22 s | 0.88 s |
| textures | 0.69 s | 0.61 s |
| scene processing | 1.70 s | 1.37 s |

**That holds only while Chrome runs natively.** On Apple Silicon, a universal binary started from an
Intel process runs as Intel under Rosetta, and the preference survives native processes in between.
Homebrew's Intel coreutils `timeout` is enough: `timeout 590 npm run bench` started Chrome
translated, and its CPU work ran 5–20× slower than the app — not by a constant factor, with small
per-task costs inflating most. Scene processing read 25–38 s, and shader compile 9–23 s against
~0.3 s. The runner therefore launches the browser through `runner/arm64.sh`
(`arch -arm64 -x86_64`, see `nativeLaunchOptions()` in `runner/browser.js`), so it runs natively
whatever started the runner. To check a live run, `vmmap -summary <chrome pid> | grep "Code Type"`
must read `ARM64`, not `X86-64 (translated)`.

A distorted harness inverts rankings. This is not hypothetical: a translated run showed the BLAS
worker pool getting *slower* with more workers, the pool was capped at 2 on that evidence, and in
the app six workers beat two by 86 % — the "fix" made scene processing 55 % slower. Calibration
exists so that cannot recur silently.

**Trusted here**

- image quality against goldens and ground truth, and the denoise/freeze ratchets
- GPU kernel A/B of the same code shape within one browser session (`bench:ab`, `bench:kernels`)
- VRAM and leak detection
- CPU build-phase times and shader compile time, while the calibration line reads `calibrated`

**Confirm in the app**

- worker counts and pool sizes — the harness keeps more BLAS workers busy than the app does (3.7
  against 2.5 of 6 on the calibration model), so a concurrency ranking can still differ

### Calibration

```bash
npm run bench:calibrate                       # measure this browser
npm run bench:calibrate -- --snippet          # print the snippet to run in the app
npm run bench:calibrate -- --app profile.json # add the app half, get a verdict
```

Capturing the app half, on macOS:

```bash
npm run dev                                   # then open the app in your normal browser
npm run bench:calibrate -- --snippet          # paste the snippet into the DevTools console
pbpaste > /tmp/app-profile.json               # it copies its result to the clipboard
npm run bench:calibrate -- --app /tmp/app-profile.json
```

Use an ordinary browser window, not a private one and not a fresh profile — the point of the
reference is the environment the app actually runs in. The snippet stamps its output so a
hand-written reference cannot be mistaken for a measured one.

The first form times three model loads in the harness (the first is discarded — V8 tiers up across
repeats) and stores the result in `baselines/calibration.json`. It then prints a console snippet to
run in the app, which captures the same measurement there; save it to a file and pass it back with
`--app`.

From then on every bench run prints one line saying whether this browser's CPU numbers are within
`CALIBRATION.tolerance` (1.5×) of the app's, and marks them untrustworthy when they are not. The
comparison deliberately **refuses** rather than correcting: the error is not a scale factor, so
scaling it out would be worse than saying nothing.

Calibration is per machine and per model (the record stores the GPU fingerprint), and models are
gitignored, so `--model` points at whatever local model you calibrate with. A corpus scene will not
do — procedural primitives have too few meshes to show per-task overhead.

### The worker-busy number

`SceneProcessor.performanceMetrics.blasWorkerTime ÷ blasBuildTime` is how many BLAS workers were
busy on average. The app reports ~1.6–2.5 of 6 and a native harness run 3.7; under Rosetta the
harness reported 4–5 "busy" while doing 28× the total work. It is the cheapest single signal that a
CPU measurement is being distorted, and the calibration report prints it for both sides.

**Requirements:** Google Chrome installed (override with `CHROME_PATH`). No network access needed — every scene is procedural.

## How it works

`npm run bench` starts the Vite dev server, opens `bench/harness/index.html` in headless Chrome, and drives it over the DevTools protocol. Because the engine is aliased straight to source, a bench run always measures your working tree — there is no build step to go stale.

```
bench/
  harness/    boot.js, scenes.js, sceneSession.js, index.html, storage/   # runs in the browser
  lib/        metrics.js, png.js, stats.js, load.js   # pure, unit-tested in tests/unit/bench/
  runner/     cli.js, report.js + one module per suite    # runs in Node
  node/       run.js, resolve.js, fixtures/    # the corpus in plain Node (bench:node), compressed glTF fixtures
  load/       models.json, worker.js, measure.js, resolve.js   # bench:load: the model list, one engine per process
  tools/      gen-dfg-lut.mjs (bench:lut), make-compressed-fixtures.mjs
  baselines/  golden/, truth/, probes.json, fingerprint.json, perf.jsonl, ab.jsonl, calibration.json,
              denoise.json, freeze.json, upscale.json
  results/    quality.html, quality/, trend.html   # the last quality run's report and the trend page, git-ignored
```

## The quality report

`bench:quality`, and `bench`, which runs it, write `bench/results/quality.html` and print its `file://`
URL at the end of the run. One page with its images embedded, so it opens offline:

- a table of every scene with each gate's number and limit, a number over its limit in red;
- for each scene that failed or moved off its golden: golden, current render, difference heatmap and
  ground truth, failing scenes first. The first eight failures are shown at full size, the rest as 128 px
  thumbnails, and every image links to its full-size file;
- a thumbnail of each scene bit-identical to its golden.

The heatmap is `diffHeatmap()` (`lib/metrics.js`): each pixel's largest change against the golden in any
linear-light channel, or alpha, on a square-root ramp from black to red at the scene's largest change, so
a pixel that moved a hundredth as much still shows. Luminance alone left a hue shift black. A heatmap
thumbnail keeps each block's hottest pixel, so a single changed pixel survives the shrink.

Every run replaces the directory: the page, plus `quality/<scene>.png` (the render) and
`quality/<scene>-diff.png` for each scene that moved; goldens and ground truth are linked where they
are. On the 41-scene corpus the page is 0.7 MB when every scene is bit-identical, 1.2 MB with eleven
moved within the gates (plus 1.2 MB of full-size files) and about 5 MB when every scene fails; writing
it takes 0.1–0.7 s. `bless` writes none.

## Determinism

Image comparison is only meaningful if the renderer is reproducible, and by default **it is not**. The RNG itself is clean — every ray is seeded from a pure hash of `(pixel, rayIndex, frame)`, and no shader reads a clock. What varies is *which uniforms and dispatch grids are live on frame k*:

- async counter readbacks drive the per-bounce early exit and dispatch sizing, and kernels bind on `ENTERING_COUNT`, so an under-sized grid silently drops rays;
- the adaptive convergence stop retires the frame at a run-dependent sample count;
- interaction mode is a 100 ms timer that engages on the very first frame.

`app.setDeterministicMode( true )` pins all of it, and `app.renderFrames( n )` accumulates exactly `n` samples with the rAF loop parked. With those, two runs of the same scene produce **byte-identical** PNGs.

The harness reaches them through `openHeadless()` / `renderToBuffer()`, and its OIDN rungs through `runFinalDenoise()` and a `source: 'display'` readback — the same entry points a render farm uses — so a bug in the shipped headless path cannot hide from the suite that exists to catch bugs. It passes `strict: false` explicitly: `strict` would abort a run before the runner reported anything (`assertLoadedCleanly()` gives the same guarantee per load instead).

These are public engine API, not bench-only helpers — any host doing offline rendering wants them.

## What each suite gates on

### Quality — three comparisons, all required

| vs. | Reference | Answers |
|---|---|---|
| **golden** | last blessed render at the same spp | "did anything move?" |
| **ground truth** | one-time 2048-spp render | "did anything get *worse*?" |
| **white furnace** | analytic — a constant in `scenes.js` | "is the BSDF conserving energy?" |

The golden check alone is not enough, because goldens drift: regress 3 %, re-bless, regress 3 %, re-bless — twenty PRs later the renderer is materially worse and every run was green. RMSE against ground truth cannot drift, because the reference never moves. Baselines are bootstrapped on first run and thereafter change **only** via `bench:bless`.

**Bias and noise are reported separately** because they fail for different reasons:

- **Bias** — mean linear luminance vs ground truth. Catches energy bugs: a missing `4π`, a clamp eating light, a broken MIS weight. Measured from the FloatType HDR buffer, not the PNG, because tone mapping compresses a few-percent energy error away before it reaches the pixels.
- **Noise** — RMSE vs ground truth at fixed spp. Catches sampling-efficiency loss: same mean, more variance.

#### The white furnace gate, and why bias is not enough

The bias gate has one structural blind spot: its reference is a high-spp render of *the build under
test*. A systematic energy error appears in both the reference and the render, cancels, and the ratio
reads ~1.0 — so a BSDF that has always created 12 % of its energy passes forever, and re-blessing can
only entrench it.

The `furnace-*` scenes close that hole. An albedo-1 sphere in a uniform environment of radiance `L`
must render *exactly* `L` — the object becomes invisible. The reference is a constant declared in
`scenes.js`, so no amount of blessing can move it.

`arealight-analytic` does the same for the analytic-light path, which no furnace can see (a furnace
has no lights). A Lambertian plane under a square area light, with the camera framing a small patch
beneath it, must render the closed-form irradiance of a rectangle over a parallel plane times
albedo/π. It gates the light's radiance convention, the spherical-rectangle sampler, the NEE/BSDF-hit
weighting and the shadow-ray origin together; `arealights-two` sits beside it with two lights of
different size and power so the light-selection heuristic has a noise gate.

**It is a ratchet, not an absolute gate.** Several BSDFs violate energy conservation today (see
below), and gating on `|ratio − 1|` would leave the suite permanently red — which is how a gate stops
being read. Each scene's current deviation is blessed and may only **shrink**; the absolute deviation
is always printed, so the outstanding bugs stay visible without blocking unrelated work. Fix one and
`bench:bless` tightens the ratchet behind you.

Standing state as of the last bless. Every axis is now at the measurement floor — the diffuse
control, which is analytically exact, reads 0.121 pp. The worst axis was 51 pp.

| scene | ratio | off by |
|---|---|---|
| `furnace-metal-mid` | 1.00105 | 0.11 pp |
| `furnace-diffuse` | 0.99879 | 0.12 pp — control, Lambert is exact |
| `furnace-clearcoat` | 0.99858 | 0.14 pp |
| `furnace-dielectric-glossy` | 0.99775 | 0.23 pp |
| `furnace-sheen` | 0.99762 | 0.24 pp |
| `furnace-metal-rough` | 0.99730 | 0.27 pp |
| `furnace-dielectric-smooth` | 0.99731 | 0.27 pp — ratchet seeded; no golden or ground truth yet |
| `furnace-iridescence` | 0.99514 | 0.49 pp |
| `furnace-lowpoly-16` | 0.99879 | 0.12 pp — with the shadow terminator offset; 0.99650 without |
| `furnace-lowpoly-32` | 0.99879 | 0.12 pp — 0.99815 without |
| `furnace-foliage-cards` | 1.00000 | 0.00 pp — 0.51448 with rays offset along the interpolated normal |
| `furnace-displaced-glass` | 0.99991 | 0.01 pp — 1.72 with refractions starting on the relief, 1.0015 with total internal reflection weighted 1/0.95 |

The last three were measured when their fixes landed and are not blessed into `baselines/` yet;
run `npm run bench:bless -- --truth` to seed them.

#### What the furnace found, and what fixed it

Every one of these was invisible to the bias gate, and several were invisible to each other —
partially cancelling, so fixing any single one in isolation made scenes *worse*.

**Four lobe-weight schemes, and MIS that did not partition unity.** A one-sample lobe mixture is
only unbiased if every MIS site divides by the density the sampler actually drew from. Four
independent schemes had grown up instead — lobe selection in `calculateBRDFWeights`, the indirect
`combinedPdf` from `getImportanceSamplingInfo`, env-NEE's own inline pair, and a fourth inside
`sampleClearcoat`. The inline pair's `specularWeight = 1 - diffuseWeight * (1 - metalness)`
collapses to **zero for every non-metal**, so MIS believed a glossy dielectric sampled purely
cosine while the sampler picked specular about half the time. Worse,
`calculateIndirectLighting` re-selected a strategy on top of `generateSampledDirection`, and its
specular and clearcoat strategies both just returned `brdfSampleDirection` — a sample that may
have come from the diffuse or sheen lobe — so `combinedPdf`, which becomes `prevBouncePdf`, was
the density of a distribution nothing sampled from. Now one function, `calculateBSDFSamplingPDF`.

**Two BRDFs for one material.** `evaluateLayeredBRDF` carried the clearcoat layer and was called
only by `sampleClearcoat`; every NEE site called `evaluateMaterialResponseFromDots`, which had no
coat term. MIS combining two different integrands is biased however good the weights are. The coat
is now folded into the single BRDF and `evaluateLayeredBRDF` is gone.

**A floor that flattened the GGX peak.** `DistributionGGX` floored `π·denom²` at `EPSILON` (1e-6);
at `MIN_ROUGHNESS` the peak's value is ~1e-10, so D came out up to 8000× low while `sampleGGXVNDF`
still drew the true lobe. Wherever the mixture pdf held another lobe the error stopped cancelling:
a smooth white dielectric read **1.10**, and a smooth black one lost 22 % of its reflection
head-on against Cycles. `furnace-dielectric-glossy` sits at roughness 0.15, just above where it
bites, hence `furnace-dielectric-smooth`. The floor is now 1e-30, a zero-divide guard only.

**A borrowed DFG fit.** `evaluateDFG` used Karis's analytic split-sum polynomial, which fits a
*different integral* — off by up to 0.31 absolute against this BSDF. It is now a LUT integrated
from the renderer's own lobes (`bench/tools/gen-dfg-lut.mjs`), storing E at F0 = 1 and at F0 = 0;
Schlick is linear in F0, so `E(F0) = F0·(R - B) + B` is exact and no fitted shape survives
anywhere in the chain. That also unblocked replacing `GeometrySchlickGGX`'s analytic-light remap
with exact Smith, and the isotropic BRDF's separable Smith with the height-correlated form the
anisotropic path always used. Dielectrics have since moved to the exact Fresnel curve (Schlick ran
16-23 % low at 45-65°, measured against Cycles); that curve is not linear in F0, so the same table
now also carries its albedo in 17 IOR slices (`evaluateSpecularDFG`), and the furnace ratios did not
move.

**Energy splits that were guesses.** Both layered lobes attenuated the base by an invented factor
instead of the lobe's actual albedo: sheen used `(1 - sheenRoughness) * 0.5 + 0.25`, claiming 0.55
where the truth is ~0.01 head-on; clearcoat used `1 - clearcoat·F·(2 - F)` off the per-sample
half-vector Fresnel. Both now read their own directional albedo from the LUT.

**Sheen was a BRDF in name only.** `sheenColor · sheen · D · NoL` — no visibility term, and a
cosine the caller already applies. The lobe was sampled with `ImportanceSampleGGX( sheenRoughness )`
while its density came from `SheenDistribution`, which is GGX with A² = 1/roughness⁴ — the
reciprocal, so sampler and pdf described different distributions. And the pure-diffuse fast path
in `evaluateMaterialResponseFromDots` did not test `material.sheen`, so any sheen material above
roughness 0.98 silently lost its sheen lobe entirely.

**A fallback that made a density unrepresentable.** A below-surface sheen reflection used to fall
back to a cosine direction, so the lobe also emitted cosine-distributed directions: the true
density is `w_sheen·p_sheen + P(reject)·w_sheen·cos`, and `calculateBSDFSamplingPDF` cannot know
`P(reject)`. Dividing by the smaller modelled density inflated the lobe 23 % — measured 0.308
against an exact analytic 0.25. The sample is now simply lost, which keeps the density exact.

**A faceted terminator on low-poly spheres.** Smooth shading promises light up to the smooth
surface's horizon, but a shadow ray leaving the flat facet near it is blocked by that facet or its
neighbours, so a 16-segment sphere drew its outline into the shading and read 0.99650 against the smooth sphere's 0.99879. The
1 mm spawn offset used to hide most of it; scale-aware offsets exposed it. Light and environment
shadow rays now start on the smooth surface the vertex normals describe (`shaders/ShadowTerminator.js`,
a port of Cycles 5.1's geometry offset, default 0.1): both low-poly spheres read 0.99879, the same as
the smooth one, with 46 % and 20 % less noise.

**Pass-through rays that never left the card.** Spawned rays were offset along the hit record's
normal, which is the *interpolated* one. Foliage cards ship vertex normals that all point up, so on a
vertical card the offset moved a ray passing through a transparent texel within the card's own
plane; it hit the same card again until the transparent-bounce guard ended the path, and the cards
drew black. Rays now step off the facet normal, which Extend packs into the hit record
(`shaders/HitFacet.js`). `furnace-foliage-cards` — six crossed, fully transparent cards in a white
furnace — read 0.51448 before and 1.00000 after; no other scene has cards whose normals disagree with
their facets, which is why nothing else caught it.

**A diffuse lobe on glass.** Neither `calculateBRDFWeights` nor `kD` carried a
`(1 - transmission)` factor, so a fully transmissive dielectric kept a full diffuse term it should
not have — `KHR_materials_transmission` defines transmission as *replacing* the diffuse component.
The sampler duly spent ~23 % of glass samples proposing cosine directions whose BRDF value is ~0
while refraction went under-sampled at 42 %. This was masked on main by an ad-hoc override in the
old outer selection (`transmissionImportance = max( ..., 0.8 )`, `diffuseImportance *= 0.2`) that
the unified path removed, which is how it surfaced. Fixing the factor rather than restoring the
override cut glass-transmission noise 62 % and dispersion-glass 12 %.

Energy aside, correct densities cut noise sharply. RMSE vs ground truth fell on all 14 image
scenes — clearcoat-carpaint −74 %, glass-transmission −55 %, refit-deform −54 %, spheres-gradient
−47 %, iridescence −39 %, down to −11 % on sheen-velvet.

The LUT is only valid for the BRDF/sampler pair it was integrated from. Change a lobe without
regenerating and the compensation drifts back out of calibration — which the ratchet will catch.

### Performance — same-session A/B only

`npm run bench:perf` records GPU milliseconds of the compute passes — the path tracer — (WebGPU timestamp queries) to `baselines/perf.jsonl` as a **monitored trend, not a gate**. A stored number is thermally meaningless on a laptop and would produce false alarms until people ignore it. The trend log is what catches the every-PR-is-+2 % drift that per-run thresholds never see. Each line records the commit it measured and `dirty: true` when the working tree differed from it (the bench's own `baselines/` excluded).

The run ends with **OIDN**: `oidn-fast` and `oidn-high` are the network's GPU milliseconds for one 1920×1080 denoise
(four tiles at the default cap), every tile's layers summed by the library's own timestamps — packing and the output pass
are not in it (`measureDenoiseGPU` in `harness/boot.js`, `PERF.denoise`). Their workload names the model, precision and
tile: another model or tile size breaks the line, and a library upgrade shows as a step in it. `bench:perf -- --only oidn` measures just these. 2026-10-25 (oidn-webgpu
0.6.0, M5 Pro, Chrome): 49.1 and 223.1 ms. `npm run bench:oidn` (Node) compares OIDN's kernels on whatever GPU it runs
on — the default against the experimental subgroup-matrix kernel, speed and pixel difference — for trying a new GPU
(the farm's NVIDIA L4) before the engine changes its choice.

Each measurement renders **exactly one sample** and resolves the timestamp queries immediately. Resolving once after an N-sample render reports whichever frame happened to land last rather than the average — that produced `cv > 100 %` and one scene reading implausibly faster than a simpler one before it was fixed.

⚠️ **Render-pass timestamps overlap, so perf times compute passes only.** On Apple M-series a render pass's timestamps overlap the compute before it and each other, and read either ~0 or most of it: `glass-transmission` at 256² read 1.8 ms compute + 2.0 ms render, and renders at 1.95 ms a sample by the wall clock with the GPU drained. Summed into the total, as perf did until 2026-10-14, they flipped small scenes between two speeds at random: across the corpus measured twice in one tab, compute moved by at most ±2 % on every scene while the render part swung (`spheres-procedural-sky` 0.05 ↔ 0.30 ms, `translucent-panel` 0.13 ↔ 0.02 ms), and that noise is what held the A/B band at 8 %. The runner reads `getGPUTimings().compute` itself (`measureGPUPerSample` in `runner/browser.js`), so both sides of an A/B measure alike whatever their harness. A change to a render pass (the compositor, a display gain) is invisible to `bench:perf` and `bench:ab`: time it by the wall clock, as `bench:exposure` does (`measureWallPerSample`). Measured 2026-10-10, auto exposure against none: −0.4 to +0.7 % a sample, with local exposure +0.1 to +3.2 % at 256² and −0.4 to +1.0 % at 1024², all within noise.

Perf runs with the **production dispatch heuristics active** (`setPerfMode`), unlike image comparison which needs them pinned off for reproducibility. Benchmarking with them off measures a configuration production never runs. The cost is that per-frame time becomes legitimately bimodal — dispatch sizing is readback-driven — so `cv` sits at 30–40 % even when throughput is rock stable.

To gate, use `npm run bench:ab -- <ref>`. It checks the base ref out into a git worktree, serves both trees at once, drives both from **one browser**, and measures each scene in three alternating rounds per side.

> **Bidirectional scenes are measured one side at a time.** Both sides holding a bidirectional scene's extra buffers
> (~0.5 GB each) lost the WebGPU device on an Apple M-series machine (`caustic-bidirectional`). Before measuring a
> scene whose integrator is not `'path'`, `bench:ab` releases the other side's scene and integrator buffers
> (`release()`); that side reloads its scene on its own turn, as every measurement does.

#### The trend page and the A/B log

`npm run bench:trend` writes `results/trend.html` from `baselines/perf.jsonl` and `baselines/ab.jsonl`: one chart a
scene (GPU ms a sample, one point a run, runs evenly spaced) and a table of the logged A/B runs. It reads the logs only.

- Each perf run records, per scene, what the scene asks of the renderer — `workload()` in the harness: triangles,
  materials and the material layers in use, lights by kind, the sun, emissive triangles, environment, integrator,
  camera and the scene's own settings — and `only` when `--only` cut the run short. Where a scene's workload changed
  between two runs its line breaks and the break says what changed, so a scene given more to do is not read as an
  engine regression. The physical sky's sun (2026-09-29) made `anisotropy-brushed`, `sheen-velvet` and
  `iridescence-thinfilm` 43–45 % slower between two runs, and nothing in the log could say so. Runs from before this
  field draw no break.
- A scene is flagged slower or faster when its last 3 runs since its last break all sit past the median of the runs
  before them, and their median is 10 % or more away (`TREND` in `runner/config.js`): 10 % is what identical code read
  in two sessions, so one run is never flagged. Only runs from the machine with the most runs are shown.
- `bench:ab` appends to `ab.jsonl` when both sides are commits (a clean working tree, or `--head <ref>`): each scene's
  times, verdict, noise floor and per-round deltas, and which parts of the scene differed between the two trees (null when the base's
  harness predates `workload()`). A run on uncommitted code is an experiment and is not logged, nor is a ref against
  itself.
- `npm run bench:release` runs `bench:ab` between the two newest release tags reachable from HEAD, both checked out as
  worktrees, so the working tree does not matter. Run it after each release. The page chains runs whose base is the
  previous run's head and multiplies them into a total: a small change repeated each release grows there in step,
  while the noise of independent runs grows only as the square root of their count.
- Runs from 2026-10-14 record `measure: 'compute'` (`computeMs`, `computeP95Ms`); earlier ones summed compute and render
  passes (`medianGpuMs`), so each line breaks there and A/B runs chain only with runs of the same measure.
- Both logs are committed with the rest of `baselines/`.

> **`bench:ab` requires `bench/` to exist in the base ref.** Each side boots the harness from its *own* tree — Vite's `server.fs.allow` resolves to the tree the dev server runs in, so serving one tree's harness to the other's server returns 403. A ref predating this tooling therefore has no harness to boot and cannot be used as a base.

#### What the gate can actually resolve — and how that was established

About **a 3 % change** since 2026-10-14, when the gate began timing compute passes only (see below); before that roughly a 10 % regression and nothing finer. Both are measured limits, not design targets, and the path to them is worth recording because every intermediate answer looked fine and was wrong.

A harness's *within-run* standard error is 0.4–2 % at these sample counts, and the first version of the gate used it as the noise floor. Three experiments showed that number is not an honest uncertainty for an A/B:

| comparison | reproducibility on **identical code** |
|---|---|
| repeat measurements, one harness, one session | 0.6–1.2 % — matches the reported SE |
| two sequential browser sessions | up to **9.9 %** |
| two coexisting WebGPU devices in one browser | up to **12.4 %** |

Judged against a ±1 % floor, a self-A/B of `HEAD` against itself returned two to three false `slower` verdicts out of nine scenes and a failing exit code. A perf gate that fails on unchanged code gets disabled within a week, so the floor had to come from somewhere real.

Two changes fixed it. Both sides now run in one browser (removing the session boundary), and each scene is measured in several **paired rounds** whose per-round *ratio* is the statistic. The pairing matters more than the replication: the dominant noise is common-mode, and one observed round measured 3.0 ms/sample on *both* sides where its neighbours measured 4.3 on both. Independent medians turn that into a ±27 % noise floor — a gate that never fires. The ratio is untouched by it.

What replication cannot remove is a **bias**, and there was one: the tab opened second read up to ~13 % slower on identical code, round after round. It came from tab state, not from the two WebGPU devices — bringing each side's tab to the front before measuring it removed it. Self-A/B, 8 scenes × 3 rounds: 24 of 40 `unchanged` (12 false `slower`) before, 23 of 24 (no false verdict, one `inconclusive`) after; the four sub-1 ms scenes went from 2 of 16 to 16 of 16. After the fix, |delta| on identical code over 93 comparisons: median 0.8 %, p95 6 %, max 7.5 %. `PERF.abUnchangedPct` was 8 %, just above that worst case.

Most of that worst case was the render-pass timestamps (see the warning above), not the renderer. Timing compute passes only, three self-A/Bs of HEAD, 123 comparisons: |delta| median 0.4 %, p95 1.2 %, max 1.8 %, every verdict `unchanged` and none `inconclusive` (a release A/B on the total had 10 of 41 inconclusive). `PERF.abUnchangedPct` is now 3 %. Against known changes: compiling out unused material layers (3d487220) reads `faster` on 33 of 34 scenes by 4.1–12.4 %, median 8 % — about half of them inside the old band — and tracing instances in object space (9f5ca6df) reads glass +5.2 % and alpha-cutout +8.3 %, each scene's rounds within a point of each other. The band is **machine-specific** — re-derive it with `bench:ab -- HEAD` before trusting the numbers on other hardware.

Every verdict prints its own floor, its per-round deltas, and the absolute spread of each side, so a marginal call is visibly marginal:

```
unchanged    spheres-gradient           1.65 → 1.63 ms (+0.9 %)
             floor ±3.5 %, per-round delta -32.8 / +0.9 / +3.0 %, absolute spread base 43.2 % / head 9.7 %
```

The floor is built from the median absolute deviation of the round ratios, not their standard
deviation, so one wild round (the −32.8 % above) does not swamp two that agree. With sd that line read
`inconclusive` at ±23 %.

A wide *absolute* spread beside a tight per-round delta is machine drift the pairing already cancelled — adding rounds will not narrow it and does not need to.

Note `pipeline.getStats()` is **not** a GPU metric — it times command encoding on the CPU and stays flat while GPU cost doubles.

### Per-pixel freeze — the path determinism hides

`setDeterministicMode` clears `usePixelFreeze`, and every quality scene loads through it. So the
Tier-2 freeze path shipped to every user with no gate having rendered a single pixel through it —
a bug there rendered at RMSE 4.49 instead of 0.03 and passed all 21 scenes.

`bench freeze` renders each scene twice, identical except for `usePixelFreeze`, and reports
`RMSE vs truth, frozen ÷ unfrozen`. Three things about it are not obvious, and each one was a
wrong first attempt:

**Both arms keep deterministic mode on.** The intuitive design — frozen render vs the deterministic
golden — measures the *dispatch heuristics*, not freeze, because leaving deterministic mode restores
them and they move up to 12 % of pixels between two identical runs. A seeded fault that disabled
freeze entirely passed that version. Deterministic mode is left on and `usePixelFreeze` re-armed
afterwards; the dispatch pins are stage fields, not settings, so they survive.

**The thresholds are deliberately loosened** (`0.10` / stability `4`, against a shipping `0.02` / `8`).
At shipping values freeze is measurably *inert*: 0.00 % of pixels move on every corpus scene, which
matches the standing note that it does nothing on real interiors either. A rung run there would
compare a render against itself and pass forever. This gates the code path, not the shipping
thresholds — the same bargain `BASE_SETTINGS` makes by pinning `fireflyThreshold` to `1e9`.

**It asserts it did something.** The frozen arm must differ from the unfrozen one by at least 0.2 %
of pixels. Freeze barely moves a correct image, so "barely moved" and "never ran" are
indistinguishable unless measured — without this the rung reproduces, one level up, exactly the
blind spot it exists to remove. `--bless` refuses to record a scene that fails it.

Both gates are mutation-tested: a freeze that silently no-ops trips the engagement check on every
scene, and one that freezes still-noisy pixels trips the ratchet by +26 % and +94 %.

`alpha-cutout` was measured and dropped rather than overlooked — its ratio swings **69.6 %** across
five identical runs, because which pixels the frozen set catches on a cutout edge is very sensitive
to readback timing. No ratchet loose enough to be stable there detects anything. The two kept scenes
spread 3.7 % and 0.9 %, which is what sizes the 25 % ratchet.

That instability is still unexplained. The obvious suspect — frozen pixels folding stale samples
into their own variance, which drives the freeze decision — was fixed and **ruled out**: it halved
the spread on both kept scenes but left `alpha-cutout` chaotic (36.7 % → 51.9 % across five runs).

### Lockstep — the production path, reproducible

Every other suite pins deterministic mode, and that turns adaptive sampling off — so nothing tested
that the configuration a render farm ships renders the same image twice. `bench lockstep` renders
each scene through `renderUntilComplete()` with adaptive sampling, pixel freeze and the
readback-driven early exit all live, under four submission pacings (no draining, the default, a
drain after every frame, 8 ms of CPU per frame), and requires the same sample count and a
bit-identical linear accumulation from all four. Nothing is blessed: the four runs are compared with
each other.

Mutation-tested: with lockstep switched off inside `renderUntilComplete`, spheres-gradient retired
at 64 / 37 / 23 / 29 spp across the four pacings and cornell-emissive at 64 / 33 / 30 / 45 — every
pacing a different image. With it on: 24, 32 and 20 spp, identical across all four.

The first pacing is also the first render after another scene, so the suite holds a render independent of
what was traced before it too. A mismatch on the first pacing alone is that, not the pacing: glass-transmission
differed in one pixel because the frame after the reset saw the camera as moved (the previous frame traced
another view), which skipped its readback and delayed the survivor curve by four frames.

### Node — the corpus without a browser

`npm run bench:node` builds the engine and renders every scene that has a golden in plain Node on Dawn
(`bench/node/run.js`), through the published build and only the seams a Node host has:
`navigator.gpu` from the `webgpu` package and `configurePlatform( nodePlatform() )`. The scenes load
through the same `sceneSession.js` as the browser harness, so they cannot mean different things in
the two runtimes. Each render is read back with `renderToBuffer( { colorSpace: 'srgb' } )` and
compared with the Chrome golden: RMSE ≤ 0.004 and no more than 1 % of pixels over 0.02. It cannot be
bit-exact — two Dawn builds compile the WGSL, and the readback's tone map is within a level of the canvas the
goldens came from; measured, every scene reads RMSE 0.0019–0.0036.

Mutation-tested: flipping the CPU texture packer's rows fails textured-normalmap at RMSE 0.198 and
alpha-cutout at 0.014. A new browser dependency fails the scene that reaches it.

It then loads two compressed glTF fixtures against uncompressed twins — Draco geometry (`knot-draco.glb`) and a Basis
KTX2 texture (`checker-ktx2.glb`), in `bench/node/fixtures/`, rebuilt with `bench/tools/make-compressed-fixtures.mjs` —
serving three's own decoders from `node_modules` so nothing touches the network, and runs
`rayzee/examples/core-node.mjs` in a process of its own. Last, `bench/tools/export-check.mjs` saves a render through
`exportImage()` in every format Node has and reads each file back: 8- and 16-bit PNG against the readback, EXR with its
albedo, normal and depth layers (depth against the floor's exact distance), Radiance HDR, each as rendered and as shown,
and `rayzee/encoders` alone writing the same PNG. `--only compressed-gltf`, `--only example` or `--only export` runs
just that part.

`--core` renders each scene a second time with the renderer core (`RayzeeRenderer` from `rayzee/core`, with the
physical-sky and bidirectional add-ons installed), alive beside the full engine, and requires the two to match byte
for byte. It holds the core/viewer split to "same pixels", and it is what found module-level shader state shared
between two renderers in one process (see `shaders/SceneResources.js`).

### Scene loading — real models, by phase

Every other suite loads procedural scenes of a few thousand triangles, so nothing gated loading a real model:
`bench:calibrate` times one model only to check the browser's CPU speed, and `perf.jsonl`'s `loadMs` is the corpus.
Both of 2026-09-30's load bugs were found by hand — Zero-Day's shared-`.ply` crash (shipped since 9.1.0) and Node
packing textures on the main thread (4.5 → 2.1 s once moved to workers). `bench:load` loads a list of real models in
Node on Dawn and fails on a load error or a recorded engine issue; against another checkout it gates every phase.

```bash
npm run bench:load                                   # this checkout: medians by phase, fails on errors and issues
npm run bench:load -- --ab main                      # A/B against a git ref (a temporary worktree, removed after)
npm run bench:load -- --base-dir ../baseline         # A/B against any checkout; --head-dir picks the other side
npm run bench:load -- --only crown,zero-day --rounds 5
npm run bench:load -- --heavy                        # also the models marked heavy (kroken: 40M triangles)
npm run bench:load -- --strict                       # warnings fail too
npm run bench:load -- --json out.json                # every load's phases, counts, memory and issues
npm run bench:load -- --config list.json             # a model list of your own; its roots win over RAYZEE_BENCH_MODELS
```

**The models** are listed in `load/models.json`, each with a path relative to a models root and, for an archive or a
folder, the `loadFile` options it needs (a Moana `element`). Models are gitignored, so the roots are the user's:
`app/public/models` by default, or `RAYZEE_BENCH_MODELS` / `--models`, `:`-separated — the Moana island and kroken live
outside the repo, e.g. `RAYZEE_BENCH_MODELS=app/public/models:~/Desktop/3DAssets`. A model under no root is skipped
with a note, never failed.

**How a side runs.** Each checkout's engine is built as the npm package ships it (ES, into a temporary folder outside
the checkout, ~0.3 s) and runs in a Node process of its own (`load/worker.js`), which `load/resolve.js` points at that
build; the measuring code is this checkout's for both sides, so a checkout without `bench/load` can still be the base.
Every measured load follows an unmeasured one of the same model in the same process (V8 tiers the engine's code up
across repeats). Alone, one process loads each model once unmeasured and `--rounds` times measured; in an A/B each
round starts both sides in fresh processes, alternating who goes first. Between loads the scene is unloaded and
collected, so each load's memory is its own. A load reaches no network: the worker serves three's Draco and KTX2
decoders from the checkout's own `three` on a local port, answers OIDN's weight download (every app makes it at
startup, denoising or not) with a 404, and refuses any other fetch, which fails the run — downloading the decoders
had failed a classroom load with no code change, and timed the network inside `parse`.

**The phases** (`LOAD_PHASES` in `lib/load.js`), nested as they run:

| phase | from |
|---|---|
| `ready` | `loadFile` called → the first frame finished on the GPU (`queue.onSubmittedWorkDone()`) |
| `load` | `loadFile` itself |
| `parse` | `loadFile` → `buildBVH` starts: reading, parsing, decoding — inside it `pbrtParse` / `pbrtBuild` (`archives.lastPBRTStats`) and `decode` (busy time in the host's `decodeImage`) |
| `scene` | `SceneProcessor.performanceMetrics`: `extraction`, `blas`, `tlas`, `assemble`, and `textures`, built beside the BVH |
| `upload` | `buildBVH` end → `setupMaterial` (buffers and texture buckets to the GPU) |
| `kernels`, `finish` | `setupMaterial` (the wavefront kernels' graphs), then the environment table and settings |
| `firstFrame` | `loadFile` returned → one sample done: the kernels compile at first dispatch in Node, so this is the shader compile |

The bench marks `buildBVH` and `setupMaterial` by wrapping them on the instance; no engine code knows about it.

**The gate.** A load fails on an error, a request to the network, or an engine issue of severity error (warnings are listed; `--strict` fails on
them too). Against another checkout, phases are compared like `bench:ab`: per-round ratios (`compareReplicates`), so
what the machine was doing in a round cancels, and a phase is `slower` only when its median paired change passes both
the relative floor (`LOAD.gates.unchangedPct`, 15 %, or the rounds' own spread if wider) and `minDeltaMs` (100 ms) —
a 3 ms TLAS that takes 5 ms is +67 % and means nothing — and moved the same way in every round. A regression shows
in its phase and in each phase it runs inside; the deepest one that moved is marked `← here` and named in the summary. The build's host peak
(`getHostMemoryInfo().peakLiveBytes`) is counted rather than sampled, so it is compared without noise: up by
`memoryPct` and `minMemoryBytes` fails. Sampled RSS and the VRAM tracker's peak are printed, not gated. Two sides that
built different scenes (triangle, mesh or material counts) are named, since then the times compare different work.

**Measured** (2026-10-14, Apple M5 Pro, 18 cores, shared all night with other agents' builds, tests and renders —
load average 5–16, swap 14 of 15 GB used):

- **A delay is named where it is.** 300 ms added at the top of `SceneProcessor._createMaterialTextures` in a throwaway
  checkout, A/B against the same tree without it, 3 rounds: `textures` slower on all four models it ran (24155522
  +255 ms, its textures overlapping the BVH; classroom +300, crown +343, moana-hibiscus +297), the same in every round,
  and no other phase slower — `slower: 24155522 textures, classroom textures, crown textures, moana-hibiscus textures`.
- **Identical code stays green.** The first version kept one process per side for the whole run, with floors of 10 %
  and 50 ms; `--ab main` against this branch (the same engine) read three phases slower — classroom `blas` +25 % in
  all three rounds, 24155522 `extraction` +10 % — and classroom's first frame −42 % in all three. A process carries a
  bias of its own, which pairing cannot cancel; hence a fresh process per round, every round agreeing, and the
  floors above it. Since then: a self-A/B of the four quick models (one load stalled 1054 s, another 134 s, while the
  machine swapped) and `--ab main` over the default list: nothing slower, six phases inconclusive (rounds
  disagreeing), the rest unchanged.
- **A load error or an error issue fails the run.** A glTF folder whose image is not a PNG loads, but records
  `texture.build_failed`; a .glb cut to 4 KB throws in GLTFLoader. Both fail (`--config` with a list of its own); a
  model under no root is skipped.
- **Cost.** The default list alone, 1 warm-up + 3 loads each: 142 s; `--ab main` over the same list,
  3 rounds: 371 s; the four quick models A/B, 3 rounds, while the
  machine was busier: 554 s.

Times are wall clock on the CPU, from a process that shares the machine — another build or test run lands in them.
The paired rounds cancel what both sides of a round share; what they cannot cancel shows as a wide floor, and the
floor is printed on every line.

**Not covered.** Chrome: `measure.js` uses no Node API so a page could share it, but the harness for it (serving each
side's build with an import map, files handed over as disk-backed `File`s through `DOM.setFileInputFiles`) is not
built, so browser-only paths — `createImageBitmap` decoding, the background kernel compile, OPFS — are not timed.

### Denoisers — a ratio, so there is nothing to bless away

Every other suite measures the path tracer's own accumulation buffer. Nothing measured what the
**denoisers** did to it, so a denoiser chain once shipped making a converged image ~4.7× further from
ground truth than not denoising at all, with every suite green.

The statistic is a ratio, not an image:

```
ratio = RMSE( denoised, ground truth ) / RMSE( undenoised, ground truth )
```

Both renders happen in the same session, on the same build, at the same sample count, so the
comparison is self-normalising: a genuine path-tracer improvement moves numerator and denominator
together. There is no golden to re-bless into looking fine.

**Two rungs, because the failure is a crossover.** That regression *helped* at low sample counts and
*hurt* at high ones — any single sample count would have missed it in one direction or the other.
`DENOISE_GATES.sppLadder` is `[1, 64]`: the real-time regime the denoiser exists for, and a converged one.

| gate | kind | what it catches |
|---|---|---|
| `mustHelpAtLowSpp` | absolute, 1 spp | denoiser disconnected, mis-wired, or reading the wrong texture |
| `maxRatioIncrease` | ratchet, every rung | any drift away from ground truth, even while still net-positive |

The ratchet follows the white-furnace precedent. A denoiser can sit at or above 1.0 at 64 spp, so
gating absolutely there would leave the suite permanently red — which is how a gate stops being read.
Blessed ratios may only shrink, and the absolute ratio is printed on every line, pass or fail, so a
scene sitting at 2.0× never reads as clean.

Standing state as of the last bless (`baselines/denoise.json`):

| scene | nrd @1 | nrd @64 | oidn @1 | oidn @64 | oidn-tiled @1 | oidn-tiled @64 |
|---|---|---|---|---|---|---|
| `spheres-gradient` | 0.935 | 1.000 | 0.553 | 0.974 | 0.553 | 0.974 |
| `glass-transmission` | 0.622 | 1.000 | 0.521 | 0.783 | 0.521 | 0.783 |
| `textured-normalmap` | 0.897 | 1.000 | 0.504 | 0.852 | 0.504 | 0.852 |

`nrd` (the ReBLUR port, `docs/NRD_DENOISER.md`) is 1.000 at 64 spp by construction: past its
handover point it republishes the path tracer's own texture, so a converged render is never touched.
ASVGF and EdgeAware had rungs here until they were removed (2026-10): OIDN beat both on every scene,
and ASVGF stood at 0.91–2.04 at 64 spp.

When triaging a denoiser failure, check whether `rawRmse` moved first — if it did not, no path-tracer
commit can be responsible and the cause is in the denoiser or in the baseline itself.

### The tiled OIDN rung

The suite renders at 256×256, which fits inside a single OIDN tile — so the tiled path never runs.
`oidn-tiled` caps the tile at 128, which with the denoiser's 16 px border (288²) is 3×3 tiles. Since
oidn-web 0.5.0 a tile's halo is half the network's receptive field (112 px for the large model), so
at this size every tile's input is the whole frame and its ratios match `oidn` exactly: the rung
gates the multi-tile path — per-tile writes and their crop — not seams. Two traps are worth knowing
if you add a rung that varies a *config* rather than a strategy:

- `setOIDNQuality` does not await `updateQuality`, and `_setupUNetDenoiser` early-returns while a
  load is in flight, so a config change applied straight after a quality switch is silently dropped.
- Nothing resets the tile cap, so a tiled rung leaks its cap into every rung after it, across
  scenes. The first version of this gate reported the tiled and untiled rungs as bit-identical for
  exactly that reason — which reads convincingly as "tiling is seam-free, as designed".

`setDenoiser` therefore settles the load, always reapplies the cap (restoring the engine's own
default when none is asked for), and returns the tile edge baked into the live UNet so the runner
can assert it. Reset whatever config a rung varies, for every other rung, and assert the live value.

`bench denoise --bless` records the ratchet **without** touching the quality goldens, so a denoiser
change does not force a re-bless of the path tracer's baselines.

Only a bless writes `baselines/denoise.json`. A new scene or strategy fails on a plain run until it
is blessed, and a bless refuses (and exits non-zero on) any rung that fails the absolute gates —
non-finite output, or `mustHelpAtLowSpp` at 1 spp.

Scene choice is about what the edge-stops key on, not coverage breadth: diffuse GI (the baseline
case), high-variance transmission (the noisiest input the denoiser sees), and textures (albedo
demodulation plus mapped normals — the two G-buffer signals NRD's edge-stops and OIDN's aux inputs weigh).

**`cornell-emissive` is deliberately absent, and why is worth reading.** It is the best firefly scene
in the corpus and the natural fourth entry. Its render is not load-order stable: mean luminance flips
from 0.28864 to 0.33667 (**+16.6 %**) once enough scenes have been loaded in a session, and stays
flipped — a one-way transition on cumulative loads, not on any particular predecessor. The ratio then
depends on whether `bench denoise` ran standalone or after `bench quality`, which no ratchet can
survive. It reproduces with the harness's own denoiser reset removed, so it is an **engine** bug:
the scene runs with `enableEnvironment: false`, so the extra energy can only be emissive, and it
appears after some buffer-growth threshold. The same fragility sits under the quality suite's cornell
golden, which is only correct because cornell happens to load second in `SCENES`. Put the scene back
once that is fixed.

Output is read through `capturePNG`, i.e. composited and tone-mapped — what a user sees. That costs
sensitivity to pure energy shifts, which is fine: energy is the bias gate's job in `quality.js`. What
survives tone mapping is structure, and structure is what a denoiser is accused of destroying. A
separate `denoisedNonFinite()` probe reads the denoiser's own output (OIDN's through a `'display'`
readback) for NaN/Inf, because `probes()` only sees the path tracer buffer — a `pow(0.0, 0.0)` in a
filter weight put NaN on ~12 % of pixels with nothing in the suite reacting.

OIDN is in the suite as `oidn` and `oidn-tiled` (see the table above).

### Texture binding audit — a structural guard, not a metric

`setBindingAudit(true)` (on in the harness, off in production) reports stages whose `TextureNode`s
are bound too late to be safe. Two nodes still holding the default `EmptyTexture` when a stage first
dispatches can end up sharing one GPU binding, which then resolves to whichever is assigned last.
Nothing throws; the stage still produces a plausible image, because the aliased node reads a real
texture — just not its own.

That is how the ASVGF regression happened (the stage was removed in 2026-10). Its bilateral filter's
variance node aliased onto its colour node, so the luminance edge-stop read ASVGF's history counter as
its variance. σ_l came out 5–6 orders of magnitude too wide and the à-trous degenerated into a
near-unconditional blur. It was invisible from outside the shader: inputs and outputs both looked
reasonable, and only dumping the kernel's own σ_l exposed it.

The snapshot is taken at the first `renderer.compute` call, not before or after `render()` — the
binding assignments and the compile are interleaved inside that one call, and by the time it returns
everything is bound. The first version of this guard sampled after `render()` and silently caught
nothing. StorageTexture-typed nodes are exempt: `textureLoad` codegen only emits the required `level`
parameter while the node still holds `EmptyTexture`, so binding those post-compile is deliberate.

Mutation-tested both ways when it was added — reverting the fix made it name the exact node; with
the fix in place it was silent across every stage.

### Memory — gate on growth, never absolutes

The headline test loads and unloads the same scene five times and asserts peak VRAM does not climb. That alone would have caught at least three bugs already in this repo's history.

It runs over **two** scenes (`MEMORY_GATES.leakScenes`), one untextured and one textured, and the textured one is not optional: all three of those historical leaks were in the texture path, and the untextured scene that was once the sole default allocates no texture arrays at all. The suite was watching the one code path with no leak history in it.

Absolute numbers are not gated because `VRAMTracker` is approximate by construction: texture bytes are JS-dimension estimates (no mips, no row-pitch padding), buffers are never residency-probed so freeing one produces no drop, and the denoiser, upscaler, overlay renderer and swapchain are not registered at all. Growth across identical cycles is still meaningful even when the total is not.

#### App create/dispose — a second axis the load/unload loop cannot see

The loop above reuses one app for every cycle, so it says nothing about whether disposing an app
releases it. That gap shipped a leak: a handler assigned to the `GPUDevice` captured `this`, and the
device outlives `dispose()` (three's `Textures` leaves listeners on module-level texture singletons,
and `RenderObjects.dispose()` drops its chain maps without disposing the render objects), so every
app ever constructed stayed reachable — about 107 MiB of triangle, BVH and texture arrays each,
linear and unbounded. Reported as issue #11.

So a second loop creates, loads, renders and disposes a throwaway app four times on its own canvas,
and gates two ways:

- **`live`** — disposed apps still strongly reachable, via a `WeakRef` per instance read after a
  forced collection over CDP. Zero tolerance, and machine-independent in a way no byte count is.
- **`reachable`** — post-GC bytes for the realm from `performance.measureUserAgentSpecificMemory()`.

The second metric exists because the obvious one lies. `Runtime.getHeapUsage` and every V8 heap
counter **exclude ArrayBuffer backing stores**, and what a retained app holds is almost entirely
typed arrays — which is why the original report measured the object heap growing 4 % while RSS grew
40 % and concluded the leak was outside the object graph. It was not. RSS itself is unusable as a
gate: the Metal allocator moves it by ±500 MiB run to run. `measureUserAgentSpecificMemory()` sees
external bytes, is taken post-GC, and reproduces to 0.1 MiB.

Its floor is not zero — ~2.4 MiB/cycle still leaks inside three.js, keeping each renderer's backend,
device and WGSL source strings alive — so the limit sits at 4 MiB/cycle, above that floor and below
what a real regression produces. Raising it to accommodate a failure is the wrong move; the floor is
itself a known bug.

Both gates were verified against the unfixed engine: `live` reports 4 of 4 and `reachable` 6.6
MiB/cycle, and the suite exits 1. A gate that has never been shown to fail is not a gate.

### Storage — throughput numbers, not a gate

`npm run bench:storage` measures the origin private file system the engine keeps its caches and
spill in: sync-access-handle and writable writes, `File.slice` reads, random reads, and with
`--gz archive.tar.gz` the gunzip-to-disk pipeline `.tar.gz` archives are unpacked through. Each runs
with and without cross-origin isolation, because production (GitHub Pages) is not isolated. It is
served by a small static server rather than Vite, so those headers are the only difference between
the two runs.

```bash
npm run bench:storage -- --size 2048            # MiB written and read (default 2048)
npm run bench:storage -- --gz scene.tar.gz      # add the gunzip pipeline
npm run bench:storage -- --firefox              # the same in Firefox (FIREFOX_PATH)
npm run bench:storage -- --engine               # the engine's own round trip (exits 1 on a mismatch)
npm run bench:storage -- --engine --tar a.tar --gz b.tar.gz
```

The last form loads each archive through the engine and prints time, triangles and peak memory:
a `.tar` read in place, and a `.tar.gz` three times — the first load (unpacked to storage), the
second (reopened from storage) and one with storage off, as before storage existed.

### Examples — every one runs to the end

`npm run bench:examples` builds the engine and runs each example in `rayzee/examples/` as a user would: `core-node.mjs`
and `render.mjs` as Node processes, `core-browser` and `viewer-browser` through their npm scripts in headless Chrome,
all against this tree. An example passes when it finishes — the core page reaches its 512 samples, the viewer page
shows its denoised image — with no thrown error and no console error or warning. The browser examples print every
engine issue as a warning, so a renamed setting fails too, not only a removed method. `--only core-node,render`
picks examples; `--verbose` forwards the pages' consoles. About 30 s here. It needs the network (the viewer page
loads its model, HDRI and denoiser weights from CDNs), so it is not part of `npm run bench`.

Verified against both ways the old viewer example broke: `engine.set( 'bounces', 8 )` fails as `uncaught: engine.set
is not a function`, and `engine.settings.set( 'bounces', 8 )` as `warn: rayzee: unknown setting "bounces"`.

## Baselines are machine-specific

Each baseline stores a GPU fingerprint (vendor, architecture, key limits, device memory) and the suite refuses to compare across a mismatch. This is not paranoia: the wavefront's path budget is derived from device limits and `navigator.deviceMemory`, and single-chunk vs multi-chunk are materially different code paths. Re-bless when you change machines.

## The scene corpus

Thirty-six scenes, one failure axis each — twenty-two image scenes plus fourteen `furnace-*` energy
probes. `npm run bench:list` prints them with what they cover.

| scene | pins |
|---|---|
| `spheres-gradient` | diffuse GI, GGX metal/rough response, gradient env importance sampling (the sky is built by the bench itself: `setGradientSky` in `harness/scenes.js`, since the engine's Gradient mode was removed) |
| `cornell-emissive` | emissive-triangle NEE, MIS weighting, colour bleeding |
| `glass-transmission` | transmission, TIR, IOR sweep, transmissive bounce cap, rough refraction |
| `spheres-procedural-sky` | physical sky bake, its GPU-built importance-sampling table, the analytic sun's NEE and MIS |
| `subsurface-marble` | random-walk SSS — chromatic collision sampling, HG phase, medium stack, step cap |
| `anisotropy-brushed` | anisotropic GGX sampler/eval/PDF across tangent rotations, plus the isotropic path |
| `shadow-catcher-ground` | analytic ground-plane catcher — NEE dual-sum ratio, coverage gate, occlusion |
| `textured-normalmap` | texture arrays — albedo/normal/roughness, size buckets, UV transform, normalScale |
| `refit-deform` | BVH refit — BLAS bounds after vertex deformation, TLAS after a rigid move |
| `dispersion-glass` | Cauchy spectral IOR, per-path wavelength locking, spectral vs microfacet entry |
| `iridescence-thinfilm` | thin-film F0 modulation across film thickness and IOR, dielectric and metal bases |
| `sheen-velvet` | sheen distribution across roughness, coloured sheen, base-layer attenuation |
| `clearcoat-carpaint` | coat Fresnel and coat roughness over a rough base, the `clearcoat > 0.5` threshold |
| `alpha-cutout` | alpha MASK and BLEND on camera *and* shadow rays, transmittance attenuation |
| `arealight-analytic` | analytic area light against closed-form irradiance — power→radiance convention, spherical-rectangle NEE, NEE/BSDF MIS, shadow-ray origin |
| `arealights-two` | two area lights of unequal size, power, shape and spread — reservoir selection, per-light MIS, disk sampling, spread attenuation |
| `instanced-storage` | object-space shared geometry, InstancedMesh placements, a mirrored placement's winding, an emissive geometry placed twice — the storage paths every other scene skips |
| `mixed-lights` | the default `shadowRays: 'two'`: a rect lamp, a glowing panel and a painted-sun sky — the only scene with three light kinds, so the only one where the pick runs; its truth is one shadow ray per kind |
| `cornell-bidirectional` | the bidirectional integrator — light subpaths, connections, light tracing and their MIS; its truth is the path tracer's estimate of the same room (`truthSettings`) |
| `caustic-bidirectional` | bidirectional through glass and a mirror — light-traced caustics, MIS across specular vertices, importance through refraction |
| `lamps-bidirectional` | bidirectional with every lamp type as a light-path source — the source table, the lamp pick at both ends, lamps no camera path can hit, a rect light reached by the continuation (in rough metal); truth from the path tracer |
| `sky-bidirectional` | bidirectional with a painted-sun sky as a light-path source — the exact environment table, NEE and the miss weight from it, sunlight through glass |
| `mirror-caustic-vcm` | vertex merging (`integrator: 'vcm'`): a point lamp over a glass ball, its caustic on the floor seen in a mirror — light no connection reaches, only a merge; the shell grid, the per-vertex merge factor |
| `furnace-diffuse` | white furnace control — Lambert energy conservation, and that the rig itself is sound |
| `furnace-dielectric-glossy` | dielectric specular energy at low roughness (the most sensitive point) |
| `furnace-dielectric-smooth` | the same at `MIN_ROUGHNESS`, where a floored GGX denominator read 1.10 |
| `furnace-dielectric-mirror` | an exact dielectric reflector (roughness 0, the delta lobe) |
| `furnace-metal-mirror` | an exact metal mirror — the delta lobe's value and its MIS weight of 1 |
| `furnace-metal-mid` | metal multiscatter compensation overshoot at mid roughness |
| `furnace-metal-rough` | single-scattering GGX deficit at r = 1 — the opposite failure to `metal-mid` |
| `furnace-clearcoat` | clearcoat layer energy on top of the base |
| `furnace-sheen` | sheen lobe energy and base-layer attenuation |
| `furnace-iridescence` | thin-film energy across the film-thickness range |
| `furnace-multibounce` | multi-bounce transport — Russian-roulette compensation, NEE/MIS under occlusion |
| `furnace-lowpoly-16` | shading-normal energy loss at 16-segment tessellation |
| `furnace-lowpoly-32` | the same at 32 segments — the pair separates tessellation from the shading model; both also gate the shadow terminator offset |
| `furnace-foliage-cards` | alpha pass-through on crossed cards whose vertex normals point away from the facet — ray spawn off the facet, not the interpolated normal |

Everything is built from three.js primitives, procedural `DataTexture`s and a procedural
environment, so the corpus needs no network and cannot change when the asset host does. Texture
sizes deliberately differ (128 / 64 / 256) so three different size buckets in the packed texture
arrays are exercised, and UV repeat/offset are non-identity so a texture-matrix regression shows as
shifted detail rather than passing unnoticed.

Several scenes include one element with the feature switched **off** — `anisotropy: 0`,
`iridescence: 0`, `dispersion: 0`, `sheen: 0`, `clearcoat: 0` — because each of those selects a
separate branch that the enabled path must not disturb. Covering only the enabled side leaves the
guard's other half untested.

### Every scene has been mutation-tested

A scene that renders the right picture for the wrong reason still blesses cleanly. So for each
scene, the feature it claims to cover was disabled and the suite re-run: **8 of 8 mutations were
caught**, with 1.8–15 % energy-bias deltas and 21–1164 % RMSE increases. The two bidirectional
scenes were mutated three ways — connections dropped (−4.9 / −4.3 % bias), light tracing dropped (−8.2 /
−8.5 %), NEE's weight blind to the light subpaths (+13 / +11 %) — and both failed every time. The lamp and sky
scenes failed for every one of six more: no lamp or environment light paths (−30 / −24 %), the lamp pick left
out where a light path lands (−15 %), either term of a rect light's hit weight dropped (+0.1 / +0.3 %, golden
differing on 0.7 % of pixels), the environment's miss weight blind to light paths (+4.2 %) and its density off
by a factor (×140). The margins matter as much
as the pass — a scene detected only at the threshold is one refactor away from being decorative.

That pass also demonstrated why both gates exist. Flattening `textured-normalmap`'s UV transform to
identity moved **45 % of pixels** while shifting mean luminance by **−0.025 %**: the golden check
caught it outright and the energy gate never fired. An energy bug is the mirror image.

This is not a one-off. `refit-deform` was originally committed rendering nothing but sky — the geometry
had silently vanished — and blessed green, because a featureless image is quiet and therefore scored
*better* than the rest of the corpus. A suspiciously small `rmseVsTruth` is the tell.

`refit-deform` is the odd one: it builds at pose A, deforms, and then calls `app.refitBVH()` rather
than loading pose B directly, because building at pose B would exercise a fresh SAH build — the one
path it exists not to test. Its positions come from `app.sceneMeshes`, **not** from the rig, and that
distinction is load-bearing: the engine also owns a hidden ground-projection disk that lands first in
the triangle buffer, so a rig-only walk is 32 triangles short and offset by 32 for everything after
it. Building this scene surfaced two real engine gaps — no public accessor for that ordering, and
`refitBVH()` silently writing NaN through the whole BVH on a short buffer instead of throwing.

## Adding a scene

Append to `SCENES` in `harness/scenes.js`, then `npm run bench:bless -- --truth --only your-scene`.

If the scene needs a field the runner gates on, add it to the `scenes()` projection in
`harness/boot.js` as well. `build` is a function and cannot cross the CDP boundary, so the whole
spec is never returned — the field list is explicit, and a field missing from it arrives
`undefined` in the runner and the gate silently does not run.

Two rules that are easy to get wrong:

- **A scene may take its truth from another estimator of the same image** — `truthSettings` applies
  only to the ground-truth render (`cornell-bidirectional` uses `{ integrator: 'path' }`), so the gate
  holds two integrators to each other rather than each to itself. Like every runner field it must be
  listed in `scenes()` in `harness/boot.js`.
- **Pin the camera explicitly**, via `setCamera()` *after* loading — `loadObject3D()` rebuilds the
  scene and may reframe.
- **Every engine setting the scene touches must be listed in its `settings` object**, even one the
  engine then overwrites itself (`groundCatcherHeight` is auto-seeded to the scene's min-Y on load).
  `session.settingsFloor()` (`harness/sceneSession.js`) builds the per-load reset from the union of those keys, so a setting mutated
  outside them leaks into whichever scene loads next and makes results depend on scene order.

Then do two things that are not optional:

1. **Look at the golden PNG.** A scene that renders bare environment still blesses cleanly, and its
   low noise makes the numbers look *better* than the rest of the corpus — a suspiciously small
   `rmseVsTruth` is the tell. Compare yours against the others in `baselines/probes.json`.
2. **Mutation-test it.** Disable the feature the scene claims to cover, re-run `bench:quality`, and
   confirm it FAILS — then revert. If it passes, the scene is decorative. Watch the *margin* too: a
   blown-out or washed-out scene can be detected only by the bit-exact golden check while the energy
   and convergence gates sit silent, which means it will stop detecting anything the moment the
   golden is legitimately re-blessed for an unrelated reason. Both scenes here that showed that
   pattern were fixed by dimming `environmentIntensity` so highlights stopped clipping.

> If you re-bless after changing a scene's geometry, materials or lighting, pass `--truth` as well.
> Without it the existing ground-truth PNG is kept, and every future run measures the new scene
> against a reference rendered from the old one.

## Cost

Each scene load compiles the wavefront to WGSL, ~0.2–0.4 s on Apple M-series. Steady-state GPU cost is 0.9–4.3 ms/sample at 256² depending on scene. `npm run bench:quality` over the 36-scene corpus takes ~40 s end to end, and a one-scene `bench:kernels` ~7 s; `bench:bless --truth` is considerably more, because each scene renders a 1–2 k-sample reference. `bench:ab` boots two harnesses and measures every scene both refs share × 2 sides × 3 rounds (36 today), so budget longer again — `--only` is your friend while iterating.

## Known gaps

**Ground truth can only be generated by `bench:bless --truth`.** Regenerating it from the build under test would make both truth gates self-comparisons — a systematic energy error appears at both sample counts and cancels — so the runner refuses `--truth` outside bless.

**Single rounds still run wild** — one self-A/B round read +23.8 % on compute alone. The MAD floor absorbs one per
scene, and two that agree used to make a false verdict: the first `bench:release` (v11.7.0 → v11.8.0, 2026-10-14,
timing compute + render) called `furnace-metal-mid` `slower` +56 % (rounds +60.8 / −34.4 / +56.0 %) and
`furnace-dielectric-mirror` `faster` −37 % (−37.2 / −37.7 / +97.0 %), both trees reading ~1.05 and ~1.6 ms in different
rounds — the render-pass timestamps, not the renderer. A round past the unchanged band the other way withdraws the
verdict (`inconclusive`); a round that dips inside the band does not.

**Perf absolutes in `perf.jsonl` come from a single un-replicated pass** (`bench:perf`), so they
inherit exactly the between-session variance that made the old A/B unreliable. They are fine for the
purpose they have — spotting slow drift across many runs — but a single entry is not evidence.

Not yet built: a PR CI workflow (there is currently no PR gate at all; lint runs only in the release workflow on `main`), and CPU-side guards for the shader-recompile contract and BVH structural invariants.

Worth building next, in rough order of catch-per-line — all four are gaps the ASVGF investigation
(a denoiser since removed) had to work around by hand:

- **`__bench.readTexture(name)` over `PipelineContext`,** with automatic HalfFloat decode. Every
  finding in that investigation came from reading intermediate targets, which no suite can do. The
  decode is not optional: a HalfFloat target reads back as raw `Uint16` bit patterns, which is how a
  gradient value clamped to `[0,1]` first showed up as `1320`.
- **A convergence-monotonicity invariant.** The bug's signature was denoised error *plateauing*
  while raw kept falling. "Does error still improve as spp rises" is cheap and catches every
  stuck-filter bug.
- **Per-frame trace hooks** (`render(n, { onFrame })`). The temporal defects were all trajectory
  bugs — history going 2→1→2→3, a reset firing 50 ms late, motion vectors valid-but-zero. End-state
  metrics are blind to them.
- **Golden the debug views.** NRD ships five (`setNRDDebugMode`), plus the `visMode` views; they
  are UI-only today. Capturing them gives cheap structural coverage of the
  history, motion and gradient fields.

One caveat on the existing tooling: `getGPUTimings().total` is **not** usable for stage-level A/B. It
reported the (since removed) ASVGF chain as 9 % *faster* across five paired rounds where synced wall clock says
+4–6 %; it does not survive a change in pass count. The perf suite's use of it is fine (pass mix is
constant there), but do not reach for it to price a stage.

**`alpha-cutout`'s shadow-ray half is detected by three gates but not the per-pixel one.** Turning
`enableAlphaShadows` off trips energy bias, convergence and golden RMSE, but moves only 0.86 % of
pixels — under the 1 % per-pixel limit — because a shadow occupies a small fraction of the frame. It
is well covered; just not by that particular gate.

Corpus gap: skeletal/morph animation. `refit-deform` covers the refit machinery but not
`AnimationManager` — an actual animated clip needs a committed `.glb`, which is the one thing the
"everything is procedural" rule cannot supply.
