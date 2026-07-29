# Rayzee regression bench

Automated detection of **quality**, **performance**, and **memory** regressions in the rendering engine.

The engine's unit tests cover CPU logic well, but every GPU file — all of `TSL/`, every stage, `PathTracerApp`, the texture and shader processors — is excluded from them. That exclusion list is almost exactly the list of files where regressions actually happen. This bench closes that gap by rendering a fixed scene corpus in headless Chrome against a real GPU and comparing the results numerically.

## Quick start

```bash
npm run bench:list      # show the scene corpus
npm run bench:bless     # generate ground truth + goldens (first run, slow)
npm run bench           # quality + memory + perf
```

Individual suites:

```bash
npm run bench:quality
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

### Memory — gate on growth, never absolutes

The headline test loads and unloads the same scene five times and asserts peak VRAM does not climb. That alone would have caught at least three bugs already in this repo's history.

It runs over **two** scenes (`MEMORY_GATES.leakScenes`), one untextured and one textured, and the textured one is not optional: all three of those historical leaks were in the texture path, and the untextured scene that was once the sole default allocates no texture arrays at all. The suite was watching the one code path with no leak history in it.

Absolute numbers are not gated because `VRAMTracker` is approximate by construction: texture bytes are JS-dimension estimates (no mips, no row-pitch padding), buffers are never residency-probed so freeing one produces no drop, and the denoiser, upscaler, overlay renderer and swapchain are not registered at all. Growth across identical cycles is still meaningful even when the total is not.

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

Not yet built: a PR CI workflow (there is currently no PR gate at all, and CI never lints), an HTML report with diff heatmaps, CPU-side guards for the shader-recompile contract and BVH structural invariants, and a trend dashboard over `perf.jsonl`. Denoisers are deliberately excluded from the corpus — OIDN adds an async completion dependency and deserves its own suite.

**`alpha-cutout`'s shadow-ray half is detected by three gates but not the per-pixel one.** Turning
`enableAlphaShadows` off trips energy bias, convergence and golden RMSE, but moves only 0.86 % of
pixels — under the 1 % per-pixel limit — because a shadow occupies a small fraction of the frame. It
is well covered; just not by that particular gate.

Corpus gap: skeletal/morph animation. `refit-deform` covers the refit machinery but not
`AnimationManager` — an actual animated clip needs a committed `.glb`, which is the one thing the
"everything is procedural" rule cannot supply.
