# Rayzee regression bench

Automated detection of **quality**, **performance**, and **memory** regressions in the rendering engine.

The engine's unit tests cover CPU logic, and `tests/gpu/` runs individual TSL functions on the GPU through Dawn, but neither renders a whole scene through the stages, the kernels and the readback — which is where regressions actually happen. This bench closes that gap by rendering a fixed scene corpus in headless Chrome against a real GPU and comparing the results numerically.

## Quick start

```bash
npm run bench:list      # show the scene corpus
npm run bench:bless     # generate ground truth + goldens (first run, slow)
npm run bench           # quality + freeze + lockstep + denoise + memory + perf
npm run bench:calibrate # check this browser's CPU timing against the app
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
npm run bench:storage       # raw OPFS throughput
npm run bench:examples     # every example in rayzee/examples runs to the end
npm run bench:lut          # regenerate the DFG lookup table after a lobe or sampler change
```

Useful flags: `--only scene-a,scene-b`, `--verbose`, and `--scene <id>` / `--cycles <n>` for the memory suite.
`--truth` (regenerate ground truth) is accepted only by `bench:bless`. `bench:calibrate -- --compare <file.json>`
prints the stored app timing against a new one captured in the app (before/after a CPU change, no browser needed).

## What the harness can and cannot measure

It renders on a real GPU and runs the engine's CPU work at the app's speed — while Chrome runs natively. On Apple
Silicon a browser started from an Intel process runs translated, its CPU work 5–20× slower, so the runner launches
Chrome through `runner/arm64.sh`. `npm run bench:calibrate` measures this browser against the app; every run then says
whether its CPU numbers are within tolerance.

**Trusted here**

- image quality against goldens and ground truth, and the denoise/freeze ratchets
- GPU kernel A/B of the same code shape within one browser session (`bench:ab`, `bench:kernels`)
- VRAM and leak detection
- CPU build-phase times and shader compile time, while the calibration line reads `calibrated`

**Confirm in the app**

- worker counts and pool sizes — the harness keeps more BLAS workers busy than the app does (3.7
  against 2.5 of 6 on the calibration model), so a concurrency ranking can still differ

The calibration steps and numbers, and the worker-busy signal: [docs/design/BENCH.md](../docs/design/BENCH.md).

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

| suite | gates on |
|---|---|
| `bench:quality` | every scene against its golden ("did anything move?"), its high-spp ground truth ("did anything get worse?", bias and noise apart) and, for the `furnace-*` scenes, the white furnace ("is energy conserved?", a ratchet on each scene's ratio) |
| `bench:freeze` | each scene with and without per-pixel freeze: RMSE against truth, frozen ÷ unfrozen |
| `bench:lockstep` | `renderUntilComplete()` with adaptive sampling on, under four submission pacings: the same sample count and a bit-identical accumulation from all four |
| `bench:denoise` | what each denoiser does to the error: denoised ÷ raw RMSE against ground truth, a ratio, so nothing to bless away; `oidn-tiled` runs the multi-tile path |
| `bench:upscale` | the GPU tone map against the CPU one, then the AI upscaler's accuracy against a native render and its detail |
| `bench:memory` | VRAM growth over repeated load/unload of an untextured and a textured scene, and app create/dispose; never absolutes |
| `bench:perf` | nothing: GPU milliseconds of the compute passes, logged to `baselines/perf.jsonl` as a trend, and OIDN's network time |
| `bench:ab` | the perf gate: both trees in one browser, measured in alternating rounds; logged to `baselines/ab.jsonl` |
| `bench:node` | the corpus in plain Node on Dawn against the Chrome goldens; `-- --core` the core against the full engine, byte for byte |
| `bench:load` | real models loaded by phase in Node: fails on a load error or engine issue; against another checkout, gates each phase |
| `bench:storage` | nothing: OPFS throughput, with and without cross-origin isolation |
| `bench:examples` | every example in `rayzee/examples/` runs to the end with no error or warning |

The harness also audits texture bindings: a stage whose texture nodes bind too late to be safe is reported.

Each suite in full — the furnace gate and what it found, what the A/B gate can resolve, the freeze and lockstep traps,
the tiled OIDN rung, memory, storage and examples — and every scene's mutation test and the known gaps:
[docs/design/BENCH.md](../docs/design/BENCH.md).

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

Known gaps — what no suite catches yet — are listed at the end of [docs/design/BENCH.md](../docs/design/BENCH.md).
