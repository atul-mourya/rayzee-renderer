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

### Quality — two comparisons, both required

| vs. | Reference | Answers |
|---|---|---|
| **golden** | last blessed render at the same spp | "did anything move?" |
| **ground truth** | one-time 2048-spp render | "did anything get *worse*?" |

The golden check alone is not enough, because goldens drift: regress 3 %, re-bless, regress 3 %, re-bless — twenty PRs later the renderer is materially worse and every run was green. RMSE against ground truth cannot drift, because the reference never moves. Baselines are bootstrapped on first run and thereafter change **only** via `bench:bless`.

**Bias and noise are reported separately** because they fail for different reasons:

- **Bias** — mean linear luminance vs ground truth. Catches energy bugs: a missing `4π`, a clamp eating light, a broken MIS weight. Measured from the FloatType HDR buffer, not the PNG, because tone mapping compresses a few-percent energy error away before it reaches the pixels.
- **Noise** — RMSE vs ground truth at fixed spp. Catches sampling-efficiency loss: same mean, more variance.

### Performance — same-session A/B only

`npm run bench:perf` records real GPU milliseconds (WebGPU timestamp queries) to `baselines/perf.jsonl` as a **monitored trend, not a gate**. A stored number is thermally meaningless on a laptop and would produce false alarms until people ignore it. The trend log is what catches the every-PR-is-+2 % drift that per-run thresholds never see.

Each measurement renders **exactly one sample** and resolves the timestamp queries immediately. Resolving once after an N-sample render reports whichever frame happened to land last rather than the average — that produced `cv > 100 %` and one scene reading implausibly faster than a simpler one before it was fixed.

Perf runs with the **production dispatch heuristics active** (`setPerfMode`), unlike image comparison which needs them pinned off for reproducibility. Benchmarking with them off measures a configuration production never runs. The cost is that per-frame time becomes legitimately bimodal — dispatch sizing is readback-driven — so `cv` sits at 30–40 % even when throughput is rock stable.

**What the gate can actually resolve.** Verdicts are judged on the *standard error of the median*, not per-sample spread, with a per-scene noise floor of 2σ. Measured on Apple M-series at n=120: 0.4 % to 6.6 % median SE depending on scene, which resolves regressions of roughly **2 % to 17 %** respectively. Smaller changes report `inconclusive` rather than guessing. If a scene you care about sits at the wrong end of that, raise `PERF.measureSamples` — the error shrinks as 1/√n and each sample is only a few ms of GPU.

To actually gate, use `npm run bench:ab -- <ref>`: it checks the base ref out into a git worktree and runs both sides interleaved in one session, so thermal state and driver are identical. The comparison returns `inconclusive` rather than a confident verdict when either run is too noisy.

> **`bench:ab` requires `bench/` to exist in the base ref.** Each side boots the harness from its *own* tree — Vite's `server.fs.allow` resolves to the tree the dev server runs in, so serving one tree's harness to the other's server returns 403. A ref predating this tooling therefore has no harness to boot and cannot be used as a base.

Note `pipeline.getStats()` is **not** a GPU metric — it times command encoding on the CPU and stays flat while GPU cost doubles.

### Memory — gate on growth, never absolutes

The headline test loads and unloads the same scene five times and asserts peak VRAM does not climb. That alone would have caught at least three bugs already in this repo's history.

Absolute numbers are not gated because `VRAMTracker` is approximate by construction: texture bytes are JS-dimension estimates (no mips, no row-pitch padding), buffers are never residency-probed so freeing one produces no drop, and the denoiser, upscaler, overlay renderer and swapchain are not registered at all. Growth across identical cycles is still meaningful even when the total is not.

## Baselines are machine-specific

Each baseline stores a GPU fingerprint (vendor, architecture, key limits, device memory) and the suite refuses to compare across a mismatch. This is not paranoia: the wavefront's path budget is derived from device limits and `navigator.deviceMemory`, and single-chunk vs multi-chunk are materially different code paths. Re-bless when you change machines.

## The scene corpus

Nine scenes, one failure axis each. `npm run bench:list` prints them with what they cover.

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

Everything is built from three.js primitives, procedural `DataTexture`s and a procedural
environment, so the corpus needs no network and cannot change when the asset host does. Texture
sizes deliberately differ (128 / 64 / 256) so three different size buckets in the packed texture
arrays are exercised, and UV repeat/offset are non-identity so a texture-matrix regression shows as
shifted detail rather than passing unnoticed.

`refit-deform` is the odd one: it builds at pose A, deforms, and then calls `app.refitBVH()` rather
than loading pose B directly, because building at pose B would exercise a fresh SAH build — the one
path it exists not to test. Its positions come from `app.sceneMeshes`, **not** from the rig, and that
distinction is load-bearing: the engine also owns a hidden ground-projection disk that lands first in
the triangle buffer, so a rig-only walk is 32 triangles short and offset by 32 for everything after
it. Building this scene surfaced two real engine gaps — no public accessor for that ordering, and
`refitBVH()` silently writing NaN through the whole BVH on a short buffer instead of throwing.

## Adding a scene

Append to `SCENES` in `harness/scenes.js`, then `npm run bench:bless -- --truth --only your-scene`.

Two rules that are easy to get wrong:

- **Pin the camera explicitly**, via `setCamera()` *after* loading — `loadObject3D()` rebuilds the
  scene and may reframe.
- **Every engine setting the scene touches must be listed in its `settings` object**, even one the
  engine then overwrites itself (`groundCatcherHeight` is auto-seeded to the scene's min-Y on load).
  `sceneSettingsFloor()` builds the per-load reset from the union of those keys, so a setting mutated
  outside them leaks into whichever scene loads next and makes results depend on scene order.

Then check the render actually contains what you meant. A scene that renders bare environment still
blesses cleanly, and its low noise makes the numbers look *better* than the rest of the corpus — a
suspiciously small `rmseVsTruth` is the tell.

## Cost

The first scene load in a session compiles the whole wavefront to WGSL (~20 s on Apple M-series) and each subsequent scene load recompiles. Steady-state rendering is ~15 ms/sample at 256². A full `npm run bench` over the nine-scene corpus is several minutes; `bench:bless --truth` is considerably more, because each scene renders a 1-2 k-sample reference.

## Known gaps

**Ground truth can only be generated by `bench:bless --truth`.** Regenerating it from the build under test would make both truth gates self-comparisons — a systematic energy error appears at both sample counts and cancels — so the runner refuses `--truth` outside bless.

**`bench:ab` has not been exercised end to end on real hardware.** It is the only path in the suite
without a verified run behind it. Use a base ref at or after the perf-measurement fixes — earlier
refs measured a different dispatch configuration and will report a real delta rather than ~0 %.

Not yet built: a PR CI workflow (there is currently no PR gate at all, and CI never lints), an HTML report with diff heatmaps, CPU-side guards for the shader-recompile contract and BVH structural invariants, and a trend dashboard over `perf.jsonl`. Denoisers are deliberately excluded from the corpus — OIDN adds an async completion dependency and deserves its own suite.

Corpus gaps: skeletal/morph animation (needs a committed `.glb` — `refit-deform` covers the refit
machinery but not `AnimationManager`), dispersion, iridescence, sheen, clearcoat, alpha cutout.
