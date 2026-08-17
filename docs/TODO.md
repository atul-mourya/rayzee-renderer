# Rayzee Path Tracer - TODO List

## Bugs
- when rendering done due to convergence, we need to indicate that. For example. 540 / 600, convergence completed in 540 frame before reaching 600 maxsamples

### MVP
- [ ] if a mesh is selected, the outliner menus should scroll to the selected object so user can quickly see what's selected.
- [ ] dynamic max stack in bvhtraversal
- [ ] need adaptive sampling like what we had in megakernal. its too good to have sacrifised from megakernel
- [ ] https://github.com/DennisSmolek/Fsr3 - branch already created
- [ ] tiled output for lower vram — Blender Cycles-style render-region tiling; VRAM-bounded 4K/8K final render + video. See docs/internal/specs/wavefront-tiled-output.md


### Known

- [ ] Soft shadows for directional lights not working when enabled from UI
- [ ] Tier-2 frozen pixels keep folding stale `rayBuffer` samples into their own m2/variance every frame — `FinalWriteKernel`'s stats block has no `wasFrozen` guard
- [ ] `usePixelFreeze` is inert on 24155522.glb — bit-identical to uniform at 150 spp, nothing reaches `pixelFreezeThreshold` 0.02, so the shipping adaptive default saves nothing on real interiors
- [ ] indirect lights looks too weak
- [ ] **Fluted glass behind LED-lit cabinets converges far too slowly** — 24233846.glb, wardrobe with two glass shutters. Reads as an OIDN failure (mottled ribs, detail gone in the lower half) but **measured on the raw buffer it is variance, not the denoiser**: at 64 spp the panel interior has noise σ=37.6 on a mean of 69.3 (54 % relative), against a flute amplitude of only 4.0/255 — **contrast-to-noise 0.107, i.e. the signal sits ~9× below the noise floor**. OIDN is doing well to keep 68 % of the flute amplitude at 64 spp and 81 % at 600 spp; the ribs are absent from the raw 64 spp image entirely and only resolve by ~600 spp. Against Blender at matched resolution the flute *contrast* already agrees (10.0 % vs 10.44 %, 23 vs 25 ribs across the panel — same geometry, no fidelity gap); what differs is flute-vs-broadband, 18.2 vs 36.5, i.e. **~2× more residual noise competing with the detail, so ~4× more samples to match**. Root cause is the light path: camera → refract through fluted glass → small LED strip inside a closed cabinet. Refraction is a delta event so NEE cannot reach the emitter through the glass; the only route is a BSDF sample happening to hit it. Fixes worth trying, in order — (a) reduce variance on refractive→emitter paths (manifold/refractive shadow connections, or treating thin smooth glass as see-through for NEE), (b) firefly/outlier handling on the LED hits, (c) the aux guide is flat here: over the glass the aux albedo modulates only 1.3 % at the flute frequency where the colour modulates 5.8 %, so OIDN has no evidence the ribs are signal — the DDFA commit rule (`nonspec >= 0.25`) defers smooth glass to the shelf behind it. (c) is second-order next to (a). Do not chase this as a denoiser bug.


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
- [ ] denoiser suite — OIDN/ASVGF need an async completion dependency, deliberately out of the main corpus
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
