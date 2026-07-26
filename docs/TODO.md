# Rayzee Path Tracer - TODO List

## Bugs
- when rendering done due to convergence, we need to indicate that. For example. 540 / 600, convergence completed in 540 frame before reaching 600 maxsamples

### MVP
- [ ] need adaptive sampling like what we had in megakernal. its too good to have sacrifised from megakernel
- [ ] https://github.com/DennisSmolek/Fsr3 - branch already created
- [ ] tiled output for lower vram — Blender Cycles-style render-region tiling; VRAM-bounded 4K/8K final render + video. See docs/internal/specs/wavefront-tiled-output.md
### Known

- [ ] some pixels show black in the first rendered frame even if it hits the environment map - monte carlo noise
- [ ] Soft shadows for directional lights not working when enabled from UI


### Unconfirmed
- verify shadow-cull with the single-sided quad test to verify if a single-sided surface is see-through to GI but blocks shadow rays.



---

## Features

### Chores
- [ ] minimize unwanted dependencies - <https://github.com/atul-mourya/RayTracing/network/dependencies>
- [ ] lint fix
- [x] benchmark tooling specification and implementation — `bench/`, headless-GPU quality/perf/memory regression suite. See `bench/README.md`
- [x] enhance test coverage of the engine, use headless chrome if needed — the GPU files that unit tests exclude are now covered by `bench/` against a real Metal-3 adapter
- [x] Create e2e test — `bench/` boots the engine in headless Chrome and drives it over CDP; nothing covers the React UI yet
- [ ] open issues by threejs <https://github.com/mrdoob/three.js/issues/32969> and 33061
- [x] Readme with screenshots

### Regression bench (`bench/`)

- [x] quality (dual golden + 2048-spp ground-truth reference), memory (leak cycles), perf (same-session A/B) suites
- [x] deterministic render mode + headless control API on `PathTracerApp` (public engine contract)
- [x] perf measured with the production dispatch heuristics live, verdicts on standard error of the median
- [x] STBN atlases vendored under `bench/assets/` — a reproducibility gate cannot depend on a mutable CDN
- [x] scene corpus: diffuse GI, emissive NEE, transmission, procedural sky, subsurface, anisotropy, shadow catcher, textures/normal maps, BVH refit
- [ ] verify `bench:ab` end to end — the only path never exercised on real hardware
- [ ] PR CI workflow — there is no PR gate at all today, and CI never runs ESLint despite CONTRIBUTING requiring it
- [ ] HTML report with diff heatmaps (`bench/lib/metrics.js` already has `diffHeatmap()`, unused)
- [ ] CPU-side vitest guards: shader-recompile contract, BVH structural invariants, feature-combo compile smoke
- [ ] trend dashboard over `bench/baselines/perf.jsonl`
- [ ] denoiser suite — OIDN/ASVGF need an async completion dependency, deliberately out of the main corpus
- [ ] corpus gaps: skeletal/morph animation (needs a committed .glb), dispersion, iridescence, sheen, clearcoat, alpha-cutout


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
- [x] Subsurface scattering
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

- [x] O(N) bottom-up BVH refit for animated geometry
- [x] Two-level BVH (TLAS/BLAS) with per-mesh refit for transforms
- [x] Bounded worker pool for BLAS builds (no main-thread blocking)
- [x] Ranged GPU upload (addUpdateRange) for partial buffer updates
- [x] TLAS in-place refit instead of full SAH rebuild on transform
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
- [ ] Efficient Panorama Rendering
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
- [x] Use ColorUtils.setKelvin() for light temperature
- [ ] Opacity micro map
- [ ] Shader Execution Reordering
- [ ] Mega Geometries - Compressed Clusters as input to BLAS
- [ ] Mega Geometries - PTLAS - Partitioned TLAS
- [ ] SHaRC - Spatial Hash Radiance Cache - observed issues: transparent objects blocky, glowing reflictive materials, color bleeding, baised
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
