# Rayzee Path Tracer - TODO List

## Bugs


### MVP
- [ ] dynamic max stack in bvhtraversal
- [ ] need adaptive sampling like what we had in megakernal. its too good to have sacrifised from megakernel
- [ ] https://github.com/DennisSmolek/Fsr3 - branch already created
- [ ] tiled output for lower vram — Blender Cycles-style render-region tiling; VRAM-bounded 4K/8K final render + video. See docs/internal/specs/wavefront-tiled-output.md

### Deferred
- Reconsider continuous viewport denoising. 512²/fast is now 20 ms of library time; the old feasibility audit set the bar at ≤15 ms when TFJS made it 3–4× slower. Close enough to reopen, but it's a project, not a task — the blockers that audit found were in our cadence code (frozen frameCount during interaction, reset() aborting to tile 0), not the library.

Dead ends already closed, no action: kernel overrides (auto → FP16 Direct is fastest on Apple; Spatial is 0.57×), engine: 'webnn' (no WebGPU interop in Chrome), modelSpec (our blobs validate against the built-ins), dynamicTile (correctly pinned off).


### Known

- [ ] Tier-2 frozen pixels keep folding stale `rayBuffer` samples into their own m2/variance every frame — `FinalWriteKernel`'s stats block has no `wasFrozen` guard
- [ ] `usePixelFreeze` is inert on 24155522.glb — bit-identical to uniform at 150 spp, nothing reaches `pixelFreezeThreshold` 0.02, so the shipping adaptive default saves nothing on real interiors
- [ ] indirect lights looks too weak
- [ ] `thickness` is inert, so every transmissive surface is treated as a volume boundary. glTF uses `thicknessFactor == 0` to mean **thin-walled** — no refraction, tint once, attenuation ignored. A hollow thin-walled shell therefore tints baseColor at every interface crossed (4x on the Gelatinous Cube: blue 0.168^4 = 0.0008, renders black). Fix = branch on thickness, and re-add the Thickness control with a scene-relative range (three.js specifies it in local space x model scale), not the old 0..1 slider. gap-plan Phase 4.4.
- [ ] **All three denoisers cross ratio 1.0 at the shipping sample count — `bench:denoise` only tests 1 and 64 spp, so nobody had measured it.** Probed at 150 spp (`PRODUCTION_RENDER_CONFIG.maxSamples`), 256²: oidn **1.193 / 1.082 / 1.039** on glass-transmission / alpha-cutout / textured-normalmap (all were 0.878-0.925 at 64 spp), edgeaware 0.903 / 1.086 / 1.022, asvgf 1.200 / 3.561 / 1.787. Mechanism confirmed as a denoiser bias floor: on glass-transmission, raw improved 0.00449 → 0.00301 from 64 → 150 spp (factor 1.49, matching √2.34 = 1.53) while denoised improved only 0.00415 → 0.00359 (factor 1.16), so the raw image converges past the denoiser's residual. **Do NOT change production defaults on this alone** — the bench renders 256² with adaptive sampling disabled, whereas production renders 512²-2048² and usually retires early via `adaptiveStopFraction: 0.94`; and on the real 24233846.glb at 1024² OIDN was still improving from 64 → 600 spp (68 % → 81 % flute-amplitude retention), which is in tension with a hard floor. Next steps: (1) reproduce at production resolution on a real asset before touching defaults; (2) the likely real fix is a **variance-driven strength/blend** rather than always-on full-strength denoising — skip or lerp the denoiser once the frame is converged, which is also what `filterStrength` already does for EdgeAware; (3) add a permanent high-spp gate, but NOT as a third global `sppLadder` rung (that triples cost across all strategies and scenes for an OIDN-specific question) — prefer an oidn-only high-spp check on 1-2 scenes.
- [ ] DDFA aux commit gate is a hard binary at roughness 0.049 (metals + glass; 10.2 % of the frame flips across a 0.002-wide step, same shape as Blender #85512). **Cycles' ramp was ported and REJECTED by measurement** — featureWeight = smoothstep(0, 0.5, nonspec) with additive path-sum albedo removed the discontinuity (max step delta 0.091 → 0.031) but lost on 9 of 10 `bench:denoise` oidn rungs, worst alpha-cutout @64 spp 0.880 → 1.039 (worse than not denoising) and @1 spp 0.437 → 0.648. A partition-sum albedo blends surfaces into a less decisive guide and destroys the albedo step at cutout edges. Any retry needs a scheme that keeps ONE committed surface per pixel while smoothing the *threshold* — stochastic selection converges to the same blend, so it is not the answer. Also note the port cost 8 quality goldens their bit-identical status (rmse ~1e-5) purely from extra unconditional shader work. See the note in ShadeKernel's DDFA classification block.
- [ ] `runDenoise` **self-blesses any missing ratchet key on a plain comparison run** — `next[ id ] = stored[ id ] ?? { ratio, ... }` (bench/runner/denoise.js:231). Pre-existing keys are correctly never overwritten, but a newly added scene/strategy records whatever the very first run happens to measure, and the failure text still says "Run `npm run bench:bless`" even though the run already wrote it. That is how `spheres-gradient/oidn/64` got blessed at **1.347** — a value where OIDN actively hurts — as its permanent floor. Consider bootstrapping only under `--bless`, and sanity-checking a bootstrap value against `mustHelpAtLowSpp` before recording it.
- [ ] Non-levers on the fluted-glass shot, measured, do not retry: **firefly threshold** (1e9 / 15 / 3 give flute snr 48.8 / 48.9 / 49.0 — the panel's bright pixels are direct-path signal, which `regularizePathContribution` deliberately exempts at `pathLength < 0.5`); **bounce budget** (`maxBounces` 4 / 12 / 24 all identical — RR retires paths well before 12); **`transmissiveBounces`** (inert, the glass has `transmission 0`); **LED intensity** (10x dimmer moves relMSE only 0.304 -> 0.290). Emissive NEE *is* working — disabling it costs 40 % of the panel's energy (roiLum 0.0526 -> 0.0313) and raises relMSE 0.386 -> 0.449.
- [ ] Residual fluted-glass noise is the **see-through view of the LED-lit cabinet**, not the glass: isolating the two terms by opacity gives relMSE 0.075 for the reflection alone vs 0.304 for the pass-through alone (0.386 for the real 0.4 mix, so the alpha lottery adds selection variance on top of the worse branch). That is GI inside a small closed bright box — the levers are ReSTIR DI or a radiance cache, not anything local to the glass.
- [ ] `normalScale` sweep on the glass shows the engine is spec-correct but fragile at extreme scales: at scale 100 the shading normal is near-tangent everywhere, the shading-normal leak guard in `ShadeKernel` kills the below-horizon lobe samples, and the panel loses **half its energy** (roiLum 0.0577 at scale 100 vs 0.1173 at scale 1). glTF's own formula is what the engine implements, so clamping the scale would be wrong; the principled fix is Cycles-style `ensure_valid_specular_reflection` (Schussler et al. 2017) on the shading normal, so steep normals bend instead of terminating the path. Not built or measured.


### Unconfirmed
- verify shadow-cull with the single-sided quad test to verify if a single-sided surface is see-through to GI but blocks shadow rays.



---

## Features

### Chores
- [ ] minimize unwanted dependencies - <https://github.com/atul-mourya/RayTracing/network/dependencies>
- [ ] open issues by threejs <https://github.com/mrdoob/three.js/issues/32969> and 33061

### Regression bench (`bench/`)

- [ ] robust dispersion (MAD, not sd) for the A/B noise floor — one wild round currently makes ~1/3 of scenes report `inconclusive`
- [ ] the two sub-1 ms scenes are too cheap to measure reliably; either exclude them from perf or raise their sample count
- [ ] PR CI workflow — there is no PR gate at all today, and CI never runs ESLint despite CONTRIBUTING requiring it
- [ ] HTML report with diff heatmaps (`bench/lib/metrics.js` already has `diffHeatmap()`, unused)
- [ ] CPU-side vitest guards: shader-recompile contract, BVH structural invariants, feature-combo compile smoke
- [ ] trend dashboard over `bench/baselines/perf.jsonl`
- [ ] corpus gap: skeletal/morph animation — needs a committed .glb, which the all-procedural rule cannot supply
- [ ] coverage gap: the Tier-2 list-driven generate path is never exercised — `setDeterministicMode` disables `usePixelFreeze`, so a bug rendering at RMSE 4.49 instead of 0.03 passed all 21 scenes


### General

- [ ] deno compile for dedicated destop app
- [ ] Introduce Project based workflow
- [ ] Save rendering state in local storage and load on app start
- [ ] export/import option for settings
- [ ] transform control redesign

### Compilation
- [ ] compileAsync for compute shader

### Rendering

- [ ] Introduce Sequenced HRDIs - https://mattepaint.com/gallery/hdri/skies/
- [ ] God Rays
- [ ] Fog
- [ ] Lens flare
- [ ] Cone Tracing
- [ ] Realistic sky rendering (Volumetric atmosphere and clouds)
- [ ] Volumetric rendering
- [ ] Caustic support - Photon mapping &/ BDPT
- [ ] Realtime OIDN denoising with WebGPU compute shader implementation
- [ ] Normal-dependent MIS compensation (Karlík et al. 2019, Eq. 13) — precompute 512 compensated env map CDFs indexed by surface normal for ~19% improvement over current normal-independent compensation on diffuse+HDR scenes
- [ ] ReSTIR DI (Bitterli et al. 2020) — spatiotemporal resampling for many-light scenes
- [ ] https://cloud.needle.tools/hdris FastHDR

### Camera

- [ ] first person camera mode controls as an alternative to orbit controls
- [ ] Orthographic Camera Support

### Lighting


### Materials

- [ ] implement pending Physical material properties
- [ ] transmission support for displacement materials
- [ ] Supporting GPU-compressed texture arrays requires adding  per-scene format selection at build time - the TSL compiler doesn't support clean teardown/rebuild of compute pipelines when texture binding types change.

### Environment

- [ ] Add new category of environment maps - abstract (identify files and organize)
- [ ] Revamp environment control UX
- [ ] the output of gradient light should look like hemisphere light in threejs

### Scene Management
- [ ] SDF-based model rendering


### Animation

- [ ] animating lights support
- [ ] Timeline scrubber for animation control
- [ ] Camera animation - interpolate camera path keyframes during video render
- [ ] PNG image sequence export for better quality and post-processing flexibility
- [ ] Multi-clip blending - cross-fade between animation clips with configurable transition duration
- [ ] ArrayBufferTarget memory for long videos - StreamTarget upgrade
- [ ] sequence caching for smooth playback / scrubbing

---

## Performance & Architecture

### Pipeline

- [ ] GPU-CPU sync for environment in procedural sky, gradient sky, solid color sky modes

### BVH

- [ ] Object-space triangles + instance transform buffer for true instancing
- [ ] GPU compute refit via compute shader (level-by-level dispatch with barriers; replaces worker + SharedArrayBuffer path)
- [ ] Background BLAS rebuild after refit when SAH quality degrades
- [ ] Compact Wide BVH (CWBVH) — 4/8-way branching for GPU traversal

### Profiling

- [ ] Bottleneck identification

---

## Experiments

- [ ] Offscreen canvas rendering - <https://threejs.org/manual/#en/offscreencanvas>
- [ ] Ray-Guiding based on Octahedron Mapping CDF
- [ ] Full Disney BSDF
- [x] Efficient Panorama Rendering
- [ ] RCAS (Robust Contrast Adaptive Sharpening)
- [ ] Sparse Radiance Cascades
- [x] Screen-space radiance caching
- [x] No Kulla-Conty or Turquin energy compensation
- [x] ReSTIR-based sampling techniques - Branch open with name "ReSTIR"
- [x] stackless BVH traversal - slowness expected
- [x] Bindless texture - True hardware-level bindless isn't available in WebGPU
- [x] irradiance probes,
- [ ] SPOM (Silhouette Parallax Occlusion Mapping) ->  more suited for rasterization
- [ ] Photon mapping
- [ ] Bidirectional path tracing support
- [ ] Experiment PLOC for maximum BVH performance scenarios
- [x] tiered-material-buffer-access generalization - already at its practical optimum
- [ ] Opacity micro map
- [ ] Shader Execution Reordering
- [ ] Mega Geometries - Compressed Clusters as input to BLAS
- [ ] Mega Geometries - PTLAS - Partitioned TLAS
- [ ] SHaRC - Spatial Hash Radiance Cache - observed issues: transparent objects blocky, glowing reflictive materials, color bleeding, baised. **Root cause measured**: single-scale hashing only covers 59% of first indirect hits from a 1/16 seed — see the ORCA probe below, where 6 levels take the same scene to 99.7%
- [ ] ORCA multi-scale radiance cache (SIGGRAPH '26 Greenberg) — probed on both axes with `node bench/tools/orca-probe.mjs`. **Coverage GO**: 99.7% hit rate on 24155522.glb at the talk's 1/16 sparse rate (they report 98-99%); hierarchy depth is the whole effect, 1 level 59% → 6 levels 99.7%. **Quality: the price is a permanent +5-6% brightening of the indirect term (+4.7% of the frame) and ~23% median per-pixel error, bought against a 2.3x variance reduction.** Three things make that price fixed rather than tunable: 4x more seed paths does not move it (1/4 sparse +6.1% vs 1/64 +6.0%, so it is spatial aggregation error, not sampling error); voxel size barely moves it (2px +5.4% → 32px +6.7%, the hierarchy self-normalises onto a similar sample population whatever the base scale); and the one lever that does — fewer levels — trades it straight back for coverage (1 level = +4.1% bias but only 66% hit rate, and the perf case needs >98%). Unweighted indirect bias is ~0%, so the error is structured and correlates with throughput rather than being random. Verdict unchanged: preview-only, off past frame N, never in final render. Not yet tried from the talk and would soften the per-pixel error: dithered lookup (Binder2018), probability-weighted downrez, radiance clamp before store
- [ ] ORCA Tier-3 budgeted sampling (SIGGRAPH '26 Greenberg) — built, measured, parked on branch `experiment/orca-tier3-budgeted-sampling`. Neutral quality + 23% slower on 24155522.glb; won −8..−12% at half the rays on glass-transmission only. Resume by restoring survivor-curve dispatch sizing under `budgetOn` — that is the entire 23%
- [ ] Rerservoir sampling ( only per pixel, not neighboring )
- [ ] emissive triangles as trianle lights -  do research
- [ ] Chromatic adaptation transform (CAT)
- [ ] Auto white balance
  
---

## AI Integration

- [ ] Explore AI-driven denoising techniques beyond OIDN
- [ ] <https://upscalerjs.com/models/>
- [ ] <https://enhance.addy.ie/>
- [ ] NRD - Nvidia Realtime Denoiser

## AI Upscaler

### Performance

- [ ] Custom model URL support — let users provide their own ONNX SR model
- [ ] Estimated time remaining based on per-tile timing
- [ ] FSR 2.x port

---

## Documentation

- [ ] Shader code architecture documentation
- [ ] Asset processing documentation

---

## References

- WebGPU Graphics Pipeline: <https://shi-yan.github.io/webgpuunleashed/Introduction/the_gpu_pipeline.html>
- See [ROADMAP.md] for long-term vision and strategic planning
- See [CONTRIBUTING.md] for development guidelines
- The Future of Path Tracing | Best Practices, Optimizations & Future Standards <https://www.youtube.com/watch?v=0IrzX4LDIx8>
- GPU optimization - 450 papers, 14 years of research. Some techniques will have evolved, but the mental models hold up: https://dl.acm.org/doi/10.1145/3570638
- https://github.com/mmp/pbrt-v4
