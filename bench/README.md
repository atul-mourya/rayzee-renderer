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

**Requirements:** Google Chrome installed (override with `CHROME_PATH`), and network access on the first run — the STBN blue-noise atlases are fetched from the asset host. The harness fails loudly rather than silently rendering with the placeholder.

## How it works

`npm run bench` starts the Vite dev server, opens `bench/harness/index.html` in headless Chrome, and drives it over the DevTools protocol. Because the engine is aliased straight to source, a bench run always measures your working tree — there is no build step to go stale.

```
bench/
  harness/    boot.js, scenes.js, index.html   # runs in the browser
  lib/        metrics.js, png.js, stats.js     # pure, unit-tested in tests/unit/bench/
  runner/     cli.js + one module per suite    # runs in Node
  baselines/  golden/, truth/, probes.json, fingerprint.json, perf.jsonl
```

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

To actually gate, use `npm run bench:ab -- <ref>`: it checks the base ref out into a git worktree and runs both sides interleaved in one session, so thermal state and driver are identical. The comparison returns `inconclusive` rather than a confident verdict when either run is too noisy.

> **`bench:ab` requires `bench/` to exist in the base ref.** The base side runs from a worktree checkout, so a ref predating this tooling has no harness to boot. Once `bench/` is committed, every later ref works. This path is implemented but has not been exercised end-to-end for that reason.

Note `pipeline.getStats()` is **not** a GPU metric — it times command encoding on the CPU and stays flat while GPU cost doubles.

### Memory — gate on growth, never absolutes

The headline test loads and unloads the same scene five times and asserts peak VRAM does not climb. That alone would have caught at least three bugs already in this repo's history.

Absolute numbers are not gated because `VRAMTracker` is approximate by construction: texture bytes are JS-dimension estimates (no mips, no row-pitch padding), buffers are never residency-probed so freeing one produces no drop, and the denoiser, upscaler, overlay renderer and swapchain are not registered at all. Growth across identical cycles is still meaningful even when the total is not.

## Baselines are machine-specific

Each baseline stores a GPU fingerprint (vendor, architecture, key limits, device memory) and the suite refuses to compare across a mismatch. This is not paranoia: the wavefront's path budget is derived from device limits and `navigator.deviceMemory`, and single-chunk vs multi-chunk are materially different code paths. Re-bless when you change machines.

## Adding a scene

Append to `SCENES` in `harness/scenes.js`. Scenes are built from three.js primitives and a procedural environment so the corpus needs no network and cannot change when the asset host does. Pin the camera explicitly — `setCamera()` runs after loading because `loadObject3D()` rebuilds the scene and may reframe. Then `npm run bench:bless -- --only your-scene`.

## Cost

The first scene load in a session compiles the whole wavefront to WGSL (~20 s on Apple M-series) and each subsequent scene load recompiles. Steady-state rendering is ~15 ms/sample at 256². A full `npm run bench` is a couple of minutes; `bench:bless` with ground truth is several more.

## Known gaps

**Perf measures a non-shipping dispatch configuration.** The harness holds the engine in deterministic mode, which turns off `_useDynamicDispatch` and the per-bounce early exit — both real performance features in production renders. Traversal, shading, material sort and kernel cost are measured faithfully, but a regression confined to those two heuristics will not show up. Fixing this needs a partial-restore mode that keeps the dispatch heuristics while still pinning the RNG.

**Ground truth can only be generated by `bench:bless --truth`.** Regenerating it from the build under test would make both truth gates self-comparisons — a systematic energy error appears at both sample counts and cancels — so the runner refuses `--truth` outside bless.

Not yet built: a PR CI workflow (there is currently no PR gate at all, and CI never lints), an HTML report with diff heatmaps, CPU-side guards for the shader-recompile contract and BVH structural invariants, and a trend dashboard over `perf.jsonl`. Denoisers are deliberately excluded from the corpus — OIDN adds an async completion dependency and deserves its own suite.
