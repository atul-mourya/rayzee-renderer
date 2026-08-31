# Rayzee regression bench

Automated detection of **quality**, **performance**, and **memory** regressions in the rendering engine.

The engine's unit tests cover CPU logic well, but every GPU file — all of `TSL/`, every stage, `PathTracerApp`, the texture and shader processors — is excluded from them. That exclusion list is almost exactly the list of files where regressions actually happen. This bench closes that gap by rendering a fixed scene corpus in headless Chrome against a real GPU and comparing the results numerically.

## Quick start

```bash
npm run bench:list      # show the scene corpus
npm run bench:bless     # generate ground truth + goldens (first run, slow)
npm run bench           # quality + denoise + memory + perf
```

Individual suites:

```bash
npm run bench:quality
npm run bench:denoise
npm run bench:memory
npm run bench:perf
npm run bench:ab -- main    # gate perf against another git ref
```

Useful flags: `--only scene-a,scene-b`, `--verbose`, `--truth` (regenerate ground truth), `--scene <id>` and `--cycles <n>` for the memory suite.

**Requirements:** Google Chrome installed (override with `CHROME_PATH`). No network access needed — every scene is procedural and the STBN atlases are vendored (see below).

## How it works

`npm run bench` starts the Vite dev server, opens `bench/harness/index.html` in headless Chrome, and drives it over the DevTools protocol. Because the engine is aliased straight to source, a bench run always measures your working tree — there is no build step to go stale.

```
bench/
  harness/    boot.js, scenes.js, index.html   # runs in the browser
  lib/        metrics.js, png.js, stats.js     # pure, unit-tested in tests/unit/bench/
  runner/     cli.js + one module per suite    # runs in Node
  assets/     noise/stbn_*_atlas.png           # vendored engine assets
  baselines/  golden/, truth/, probes.json, fingerprint.json, perf.jsonl
```

### Reference inputs are vendored, not fetched

The engine defaults its STBN blue-noise atlases to `assets.rayzee.atulmourya.com`. The harness
overrides that with `configureAssets()` and loads byte-identical copies from `bench/assets/noise/`
instead. A reproducibility gate whose reference inputs live on a mutable host is not reproducible:
a re-encode there would silently invalidate every golden in the repo, and an outage would stop the
suite entirely. The copies are byte-for-byte upstream, verified by all four pre-existing goldens
still rendering bit-identically after the switch.

The load is still asserted after `blueNoiseReady`, because a missing atlas does not throw — the
sampler falls back to a constant-0.5 placeholder and bakes degenerate "noise" permanently into the
accumulation buffer, which looks like a regression or, worse, gets blessed as one.

## Determinism

Image comparison is only meaningful if the renderer is reproducible, and by default **it is not**. The RNG itself is clean — every ray is seeded from a pure hash of `(pixel, rayIndex, frame)`, and no shader reads a clock. What varies is *which uniforms and dispatch grids are live on frame k*:

- async counter readbacks drive the per-bounce early exit and dispatch sizing, and kernels bind on `ENTERING_COUNT`, so an under-sized grid silently drops rays;
- the adaptive convergence stop retires the frame at a run-dependent sample count;
- interaction mode is a 100 ms timer that engages on the very first frame;
- the STBN atlas loads asynchronously, and until it lands the sampler reads a constant-0.5 placeholder that gets baked permanently into the accumulation buffer.

`app.setDeterministicMode( true )` pins all of it, and `app.renderFrames( n )` accumulates exactly `n` samples with the rAF loop parked. With those, two runs of the same scene produce **byte-identical** PNGs.

The harness reaches them through `openHeadless()` / `renderToBuffer()` — the same entry point a render farm uses — so a bug in the shipped headless path cannot hide from the suite that exists to catch bugs. It passes `profile: 'viewer'` and `strict: false` explicitly: `physical` would change every golden, and `strict` would abort a run before the runner reported anything (`assertLoadedCleanly()` gives the same guarantee per load instead).

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
| `furnace-iridescence` | 0.99514 | 0.49 pp |

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

**A borrowed DFG fit.** `evaluateDFG` used Karis's analytic split-sum polynomial, which fits a
*different integral* — off by up to 0.31 absolute against this BSDF. It is now a LUT integrated
from the renderer's own lobes (`bench/tools/gen-dfg-lut.mjs`), storing E at F0 = 1 and at F0 = 0;
Schlick is linear in F0, so `E(F0) = F0·(R - B) + B` is exact and no fitted shape survives
anywhere in the chain. That also unblocked replacing `GeometrySchlickGGX`'s analytic-light remap
with exact Smith, and the isotropic BRDF's separable Smith with the height-correlated form the
anisotropic path always used.

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

`npm run bench:perf` records real GPU milliseconds (WebGPU timestamp queries) to `baselines/perf.jsonl` as a **monitored trend, not a gate**. A stored number is thermally meaningless on a laptop and would produce false alarms until people ignore it. The trend log is what catches the every-PR-is-+2 % drift that per-run thresholds never see.

Each measurement renders **exactly one sample** and resolves the timestamp queries immediately. Resolving once after an N-sample render reports whichever frame happened to land last rather than the average — that produced `cv > 100 %` and one scene reading implausibly faster than a simpler one before it was fixed.

Perf runs with the **production dispatch heuristics active** (`setPerfMode`), unlike image comparison which needs them pinned off for reproducibility. Benchmarking with them off measures a configuration production never runs. The cost is that per-frame time becomes legitimately bimodal — dispatch sizing is readback-driven — so `cv` sits at 30–40 % even when throughput is rock stable.

To gate, use `npm run bench:ab -- <ref>`. It checks the base ref out into a git worktree, serves both trees at once, drives both from **one browser**, and measures each scene in three alternating rounds per side.

> **`bench:ab` requires `bench/` to exist in the base ref.** Each side boots the harness from its *own* tree — Vite's `server.fs.allow` resolves to the tree the dev server runs in, so serving one tree's harness to the other's server returns 403. A ref predating this tooling therefore has no harness to boot and cannot be used as a base.

#### What the gate can actually resolve — and how that was established

Roughly **a 10 % regression, and nothing finer.** That is a measured limit, not a design target, and the path to it is worth recording because every intermediate answer looked fine and was wrong.

A harness's *within-run* standard error is 0.4–2 % at these sample counts, and the first version of the gate used it as the noise floor. Three experiments showed that number is not an honest uncertainty for an A/B:

| comparison | reproducibility on **identical code** |
|---|---|
| repeat measurements, one harness, one session | 0.6–1.2 % — matches the reported SE |
| two sequential browser sessions | up to **9.9 %** |
| two coexisting WebGPU devices in one browser | up to **12.4 %** |

Judged against a ±1 % floor, a self-A/B of `HEAD` against itself returned two to three false `slower` verdicts out of nine scenes and a failing exit code. A perf gate that fails on unchanged code gets disabled within a week, so the floor had to come from somewhere real.

Two changes fixed it. Both sides now run in one browser (removing the session boundary), and each scene is measured in several **paired rounds** whose per-round *ratio* is the statistic. The pairing matters more than the replication: the dominant noise is common-mode, and one observed round measured 3.0 ms/sample on *both* sides where its neighbours measured 4.3 on both. Independent medians turn that into a ±27 % noise floor — a gate that never fires. The ratio is untouched by it.

What replication cannot remove is a **bias**: the two harnesses are separate WebGPU devices, and the second page created is consistently a little slower, worth up to 6.2 % on the cheapest scenes. `PERF.abUnchangedPct` (8 %) is set above that measured worst case, which is what costs the gate its fine resolution. It is **machine-specific** — re-derive it with `bench:ab -- HEAD` on a clean tree before trusting the numbers on other hardware.

Every verdict prints its own floor, its per-round deltas, and the absolute spread of each side, so a marginal call is visibly marginal:

```
unchanged    shadow-catcher-ground      0.85 → 0.90 ms (+5.2 %)
             floor ±11.2 %, per-round delta +18.8 / +0.0 / +3.5 %, absolute spread base 2.0 % / head 18.7 %
```

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

### Denoisers — a ratio, so there is nothing to bless away

Every other suite measures the path tracer's own accumulation buffer. Nothing measured what the
**denoisers** did to it, so the entire ASVGF / EdgeAware chain was ungated — and it shipped making
a converged image ~4.7× further from ground truth than not denoising at all, with every suite green.

The statistic is a ratio, not an image:

```
ratio = RMSE( denoised, ground truth ) / RMSE( undenoised, ground truth )
```

Both renders happen in the same session, on the same build, at the same sample count, so the
comparison is self-normalising: a genuine path-tracer improvement moves numerator and denominator
together. There is no golden to re-bless into looking fine.

**Two rungs, because the failure is a crossover.** The ASVGF regression *helped* at low sample
counts and *hurt* at high ones — any single sample count would have missed it in one direction or
the other. `DENOISE_GATES.sppLadder` is `[1, 64]`: the real-time regime the denoiser exists for, and
a converged one.

| gate | kind | what it catches |
|---|---|---|
| `mustHelpAtLowSpp` | absolute, 1 spp | denoiser disconnected, mis-wired, or reading the wrong texture |
| `maxRatioIncrease` | ratchet, every rung | any drift away from ground truth, even while still net-positive |

The ratchet follows the white-furnace precedent. ASVGF is still **above 1.0 at 64 spp** on two of
three scenes, so gating absolutely there would leave the suite permanently red — which is how a gate
stops being read. Blessed ratios may only shrink, and the absolute ratio is printed on every line,
pass or fail, so a scene sitting at 2.0× never reads as clean.

Standing state as of the last bless (`baselines/denoise.json`):

| scene | asvgf @1 | asvgf @64 | edgeaware @1 | edgeaware @64 | oidn @1 | oidn @64 | oidn-tiled @1 | oidn-tiled @64 |
|---|---|---|---|---|---|---|---|---|
| `spheres-gradient` | 0.957 | 2.041 | 0.751 | 0.906 | 0.621 | 1.348 | 0.621 | 1.343 |
| `glass-transmission` | 0.704 | 0.912 | 0.616 | 0.711 | 0.518 | 0.924 | 0.518 | 0.914 |
| `textured-normalmap` | 0.993 | 1.304 | 0.885 | 0.984 | 0.518 | 0.882 | 0.517 | 0.889 |

**EdgeAware is no longer the offender at convergence — ASVGF is.** EdgeAware now sits at 0.71–0.98
at 64 spp, below 1.0 on every scene, while ASVGF ranges 0.91–2.04. That inverted with
`1728a985 fix(edge-filter): …`, which dropped `phiLuminance` from 4.0 to 1.0 and stopped seeding
σ_l from `max(temporal, spatial)` once the EMA is warm.

It is a **crossover**, and this suite's two-rung ladder is what makes it legible: the same change
moved EdgeAware @64 from 2.359/2.245/2.996 down to 0.906/0.711/0.984 while pushing @1 *up* from
0.524/0.426/0.806 to 0.751/0.616/0.885. Less blur always scores worse on RMSE at 1 spp, so read
alone the cheap rung reads as a regression and the expensive one as a large win. The @1 rungs still
clear the absolute floor.

That was blessed late: the ratios above stood unchanged from Aug 1 while the fix landed Aug 17, so
the suite ran red on `edgeaware @1` for weeks. When triaging a denoiser failure, check whether
`rawRmse` moved first — if it did not, no path-tracer commit can be responsible and the cause is in
the denoiser or in the baseline itself.

The remaining ASVGF residual is the older story: both filters carry a filtered variance between
à-trous passes, so σ_l tightens as the signal smooths (measured on `BilateralFilter`: 0.636 → 0.261
→ 0.115 → 0.056 over four passes, with weightSum falling 0.75 → 0.33). Before that, each pass
recomputed σ_l from the same unfiltered `variance:output` and damage grew linearly with pass count —
1.39 / 2.27 / 3.30 / 4.34 / 5.74 for 1–6 passes. Per-pass **compounding** is fixed; per-pass
**cost** is not, so the next investigation belongs on the normal/depth/colour gates and on the
intrinsic cost of blending an already-converged image.

### The tiled OIDN rung

The suite renders at 256×256, which fits inside a single OIDN tile — so overlap is zero and the
tiled path never runs. `oidn-tiled` caps the tile at 128 to force 2×2 tiles at the same render size,
which is why its ratios differ slightly from `oidn`. Two traps are worth knowing if you add a rung
that varies a *config* rather than a strategy:

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

Scene choice is about what the edge-stops key on, not coverage breadth: diffuse GI (the baseline
case), high-variance transmission (the noisiest input the denoiser sees), and textures (albedo
demodulation plus mapped normals — the two G-buffer signals the spatial filter weights on).

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
separate `denoisedNonFinite()` probe reads the denoiser's own output target for NaN/Inf, because
`probes()` only sees the path tracer buffer — a `pow(0.0, 0.0)` in the bilateral weight put NaN on
~12 % of pixels with nothing in the suite reacting.

OIDN is still excluded: it adds an async completion dependency and deserves its own suite.

### Texture binding audit — a structural guard, not a metric

`setBindingAudit(true)` (on in the harness, off in production) reports stages whose `TextureNode`s
are bound too late to be safe. Two nodes still holding the default `EmptyTexture` when a stage first
dispatches can end up sharing one GPU binding, which then resolves to whichever is assigned last.
Nothing throws; the stage still produces a plausible image, because the aliased node reads a real
texture — just not its own.

That is how the ASVGF regression happened. `BilateralFilter._varianceTexNode` aliased onto
`_readTexNode`, so the luminance edge-stop read `asvgf:demodulated.w` — ASVGF's history counter — as
its variance. σ_l came out 5–6 orders of magnitude too wide and the à-trous degenerated into a
near-unconditional blur. It was invisible from outside the shader: inputs and outputs both looked
reasonable, and only dumping the kernel's own σ_l exposed it.

The snapshot is taken at the first `renderer.compute` call, not before or after `render()` — the
binding assignments and the compile are interleaved inside that one call, and by the time it returns
everything is bound. The first version of this guard sampled after `render()` and silently caught
nothing. StorageTexture-typed nodes are exempt: `textureLoad` codegen only emits the required `level`
parameter while the node still holds `EmptyTexture`, so binding those post-compile is deliberate
(see `ASVGF.render`).

Mutation-tested both ways — reverting the `BilateralFilter` fix makes it name the exact node;
with the fix in place it is silent across all nine stages.

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

## Baselines are machine-specific

Each baseline stores a GPU fingerprint (vendor, architecture, key limits, device memory) and the suite refuses to compare across a mismatch. This is not paranoia: the wavefront's path budget is derived from device limits and `navigator.deviceMemory`, and single-chunk vs multi-chunk are materially different code paths. Re-bless when you change machines.

## The scene corpus

Twenty-one scenes, one failure axis each — fourteen image scenes plus seven `furnace-*` energy
probes. `npm run bench:list` prints them with what they cover.

| scene | pins |
|---|---|
| `spheres-gradient` | diffuse GI, GGX metal/rough response, gradient env importance sampling |
| `cornell-emissive` | emissive-triangle NEE, MIS weighting, colour bleeding |
| `glass-transmission` | transmission, TIR, IOR sweep, transmissive bounce cap, rough refraction |
| `spheres-procedural-sky` | procedural sky evaluation, environment CDF |
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
| `furnace-diffuse` | white furnace control — Lambert energy conservation, and that the rig itself is sound |
| `furnace-dielectric-glossy` | dielectric specular energy at low roughness (the most sensitive point) |
| `furnace-metal-mid` | metal multiscatter compensation overshoot at mid roughness |
| `furnace-metal-rough` | single-scattering GGX deficit at r = 1 — the opposite failure to `metal-mid` |
| `furnace-clearcoat` | clearcoat layer energy on top of the base |
| `furnace-sheen` | sheen lobe energy and base-layer attenuation |
| `furnace-iridescence` | thin-film energy across the film-thickness range |

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
caught**, with 1.8–15 % energy-bias deltas and 21–1164 % RMSE increases. The margins matter as much
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

- **Pin the camera explicitly**, via `setCamera()` *after* loading — `loadObject3D()` rebuilds the
  scene and may reframe.
- **Every engine setting the scene touches must be listed in its `settings` object**, even one the
  engine then overwrites itself (`groundCatcherHeight` is auto-seeded to the scene's min-Y on load).
  `sceneSettingsFloor()` builds the per-load reset from the union of those keys, so a setting mutated
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

The first scene load in a session compiles the whole wavefront to WGSL (~20 s on Apple M-series) and each subsequent scene load recompiles. Steady-state GPU cost is 0.9–4.3 ms/sample at 256² depending on scene. A full `npm run bench` over the fourteen-scene corpus is several minutes; `bench:bless --truth` is considerably more, because each scene renders a 1–2 k-sample reference. `bench:ab` boots two harnesses and measures 14 scenes × 2 sides × 3 rounds, so budget longer again — `--only` is your friend while iterating.

## Known gaps

**Ground truth can only be generated by `bench:bless --truth`.** Regenerating it from the build under test would make both truth gates self-comparisons — a systematic energy error appears at both sample counts and cancels — so the runner refuses `--truth` outside bless.

**A third of the corpus can report `inconclusive` on any given A/B run.** One wildly-off round out
of three inflates the standard deviation enough to cross the trust cap, even when the other two
rounds agree closely. A robust dispersion estimate (MAD rather than sd) would rescue that case while
still refusing a verdict on genuinely erratic scenes — measured by hand on the run above, it would
have turned one of three `inconclusive` results into a clean `unchanged` and left the other two
alone. The two scenes that are erratic every time are the two cheapest (`spheres-procedural-sky` and
`shadow-catcher-ground`, both under 1 ms/sample), where fixed per-dispatch overhead is a large share
of the measurement; they carry little perf signal and are best read as quality scenes.

**Perf absolutes in `perf.jsonl` come from a single un-replicated pass** (`bench:perf`), so they
inherit exactly the between-session variance that made the old A/B unreliable. They are fine for the
purpose they have — spotting slow drift across many runs — but a single entry is not evidence.

Not yet built: a PR CI workflow (there is currently no PR gate at all, and CI never lints), an HTML report with diff heatmaps, CPU-side guards for the shader-recompile contract and BVH structural invariants, and a trend dashboard over `perf.jsonl`. OIDN is still outside the corpus — it adds an async completion dependency and deserves its own suite.

Worth building next, in rough order of catch-per-line — all four are gaps the ASVGF investigation
had to work around by hand:

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
- **Golden the debug heatmaps.** ASVGF ships six modes rendering to `heatmapTarget`, plus the
  `visMode` views; they are UI-only today. Capturing them gives cheap structural coverage of the
  history, motion and gradient fields.

One caveat on the existing tooling: `getGPUTimings().total` is **not** usable for stage-level A/B. It
reported the ASVGF chain as 9 % *faster* across five paired rounds where synced wall clock says
+4–6 %; it does not survive a change in pass count. The perf suite's use of it is fine (pass mix is
constant there), but do not reach for it to price a stage.

**`alpha-cutout`'s shadow-ray half is detected by three gates but not the per-pixel one.** Turning
`enableAlphaShadows` off trips energy bias, convergence and golden RMSE, but moves only 0.86 % of
pixels — under the 1 % per-pixel limit — because a shadow occupies a small fraction of the frame. It
is well covered; just not by that particular gate.

Corpus gap: skeletal/morph animation. `refit-deform` covers the refit machinery but not
`AnimationManager` — an actual animated clip needs a committed `.glb`, which is the one thing the
"everything is procedural" rule cannot supply.
