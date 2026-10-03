# Rayzee Path Tracer - TODO List

## Bugs
- remove all hacks on rectarealight parsing and treat all the incoming serailized data. getting difference between placeholder arealight vs arealight coming with usd files
- Press and hold when "show AI" on, shows empty canvas

- audit implementation of transmission map. Scene thejunkshopsplashscreen blender splash screen
  

### MVP
- [ ] Save compiled shaders??
- [ ] engine core to be separated to make a minimal version for headless applications — half done in 9.2.0: headless mode builds no overlay, gizmo or render loop; one bundle still carries it all
- [ ] dynamic max stack in bvhtraversal
- [ ] need adaptive sampling like what we had in megakernal. its too good to have sacrifised from megakernel
- [ ] https://github.com/DennisSmolek/Fsr3 - branch already created
- [ ] tiled output for lower vram — Blender Cycles-style render-region tiling; VRAM-bounded 4K/8K final render + video. See docs/internal/specs/wavefront-tiled-output.md

### Deferred



### Known

- [x] **Default path tracer lost most light from a two-sided lamp seen from behind** (fixed 2026-10-03) — NEE
  now draws a triangle on every side it emits from and weighs by the facet's cosine; the hit-side pdfs return 0
  for a side NEE cannot draw. `veach-bidir.glb` (was −83 %): +1.1 % against camera hits alone, −0.5 % against
  bidirectional (both z ≈ 1). The emitter-hit side test uses the winding normal: the interpolated one turned away
  near a coarse sphere's silhouette and dropped light (12-segment bulbs: PT +0.24 % over camera hits, now
  +0.002 %). Residual: a 32-segment sphere still reads +0.035 % (z 11) — suspect the solid angle of edge-on
  triangles in `useSphericalSampling`'s branch.
- [x] **The environment sampler reported a density it did not draw** (fixed 2026-10-03) — the path tracer now
  samples the exact table (`EnvironmentExactTable.js`, guided search) and weighs sky hits by it; the old inverted
  tables are gone, and with them the unguarded `envTotalSum` division. Each texel weighs as the bilinear filter's
  mean over it (it was the brightest neighbour, which spread a sun three texels wide). Sunlit 1K-HDRI courtyard
  against bidirectional: −0.18 % overall / −1.3 % in shadow before, −0.02 % / −0.3 % after (with the last-bounce
  fix). Noise: a smooth sky is slightly less noisy; an HDRI's sun is now sampled over its area (soft, correct)
  rather than at a texel centre, +8–19 % RMSE in the sunlit courtyard at equal samples.
- [x] **NEE at the last bounce was weighted for a BSDF partner never traced** (fixed 2026-10-03) — every camera
  path now takes one segment past its last bounce (`RAY_FLAG.EMISSION_ONLY`, as bidirectional did), so the pair
  keeps its MIS weights. Weighing last-vertex NEE at 1 was tried first: right energy, +38 % RMSE in a gradient
  sky's shadows. Furnaces: diffuse 0.99985 → 0.99999, dielectrics 0.9991 → 0.9997, clear coat 0.99974 → 1.00000.
  Cost: the extra segment, +3–7 % GPU time a sample on the bench scenes measured (with the sampler change).
- [x] **IES profiles were read over the wrong angles** (fixed 2026-10-03) — `resampleIESToGrid` fills the whole
  0–180° × 0–360° grid the shader reads: dark outside the file's vertical range, horizontal symmetries (0–90,
  0–180, 90–270) mirrored round. Type A/B profiles still stretch as before.
- [x] **Very large triangles read dark in bands** (fixed 2026-10-03) — two causes. The hit point
  origin + t · direction sat off a large triangle by t's error (it grows with the triangle's size), so Extend stores
  a correction to the triangle's plane (`HitFacet.js`, HIT.RNG.w) and Shade applies it; and the triangle test
  rejects t within its own rounding error (pbrt-v4's bound). 400-unit floor of 2 triangles vs split 64 × 64:
  −0.3 % overall, −4.2 % in the worst band before; every band 1.0000 after. Extend time unchanged.
- [ ] **What a Blender glTF export cannot carry**, measured against Cycles renders of the same scene
  (scenes + probes in this session's scratchpad). The engine side is now at parity: point, spot and
  sun all match Cycles to render noise, and three.js' own glTF exporter writes `intensity` straight
  through, so it agrees that glTF numbers are photometric (candela / lux). What is still lost is on
  Blender's side:
  - **Area lamps are dropped entirely** — `__filter_lights_punctual` rejects `AREA` and `HEMI` with
    a warning, and glTF has no area light. The node survives as an empty. Biggest visible gap on a
    real scene; the workaround is an emissive mesh, which does export.
  - **Sun strength is exported wrong by Blender** — every sun writes 683 lux whatever its energy.
    In Blender 5.x lights carry a node tree by default and the exporter's SUN branch reads the
    Emission node's Strength (always 1.0) instead of `light.energy`; point/spot escape it only
    because their branch falls back to `energy`. Verified on 5.1.1 at energies 1 / 2 / 5.
  - **Soft shadows are lost** — glTF point/spot are true points, so a lamp's `shadow_soft_size`
    and a sun's `angle` have nowhere to go. The engine's spot sampler is named "WithRadius" but no
    radius is plumbed through the serializer.
  - Blender's COMPAT / RAW export modes write watts rather than candela and are indistinguishable
    from SPEC in the file. The importer assumes SPEC, which is Blender's default and what its own
    importer assumes.

- [ ] `usePixelFreeze` is inert on 24155522.glb — bit-identical to uniform at 150 spp, nothing reaches `pixelFreezeThreshold` 0.02, so the shipping adaptive default saves nothing on real interiors
- [ ] `thickness` is inert, so every transmissive surface is treated as a volume boundary. glTF uses `thicknessFactor == 0` to mean **thin-walled** — no refraction, tint once, attenuation ignored. A hollow thin-walled shell therefore tints baseColor at every interface crossed (4x on the Gelatinous Cube: blue 0.168^4 = 0.0008, renders black). Fix = branch on thickness, and re-add the Thickness control with a scene-relative range (three.js specifies it in local space x model scale), not the old 0..1 slider. gap-plan Phase 4.4.
- [ ] **All three denoisers cross ratio 1.0 at the shipping sample count — `bench:denoise` only tests 1 and 64 spp, so nobody had measured it.** Probed at 150 spp, 256²: oidn **1.193 / 1.082 / 1.039** on glass-transmission / alpha-cutout / textured-normalmap (all were 0.878-0.925 at 64 spp), edgeaware 0.903 / 1.086 / 1.022, asvgf 1.200 / 3.561 / 1.787. Mechanism confirmed as a denoiser bias floor: on glass-transmission, raw improved 0.00449 → 0.00301 from 64 → 150 spp (factor 1.49, matching √2.34 = 1.53) while denoised improved only 0.00415 → 0.00359 (factor 1.16), so the raw image converges past the denoiser's residual. **Do NOT change production defaults on this alone** — the bench renders 256² with adaptive sampling disabled, whereas production renders 512²-2048² and usually retires early via `adaptiveStopFraction: 0.94`; and on the real 24233846.glb at 1024² OIDN was still improving from 64 → 600 spp (68 % → 81 % flute-amplitude retention), which is in tension with a hard floor. Next steps: (1) reproduce at production resolution on a real asset before touching defaults; (2) the likely real fix is a **variance-driven strength/blend** rather than always-on full-strength denoising — skip or lerp the denoiser once the frame is converged, which is also what `filterStrength` already does for EdgeAware; (3) add a permanent high-spp gate, but NOT as a third global `sppLadder` rung (that triples cost across all strategies and scenes for an OIDN-specific question) — prefer an oidn-only high-spp check on 1-2 scenes.
- [ ] DDFA aux commit gate is a hard binary at roughness 0.049 (metals + glass; 10.2 % of the frame flips across a 0.002-wide step, same shape as Blender #85512). **Cycles' ramp was ported and REJECTED by measurement** — featureWeight = smoothstep(0, 0.5, nonspec) with additive path-sum albedo removed the discontinuity (max step delta 0.091 → 0.031) but lost on 9 of 10 `bench:denoise` oidn rungs, worst alpha-cutout @64 spp 0.880 → 1.039 (worse than not denoising) and @1 spp 0.437 → 0.648. A partition-sum albedo blends surfaces into a less decisive guide and destroys the albedo step at cutout edges. Any retry needs a scheme that keeps ONE committed surface per pixel while smoothing the *threshold* — stochastic selection converges to the same blend, so it is not the answer. Also note the port cost 8 quality goldens their bit-identical status (rmse ~1e-5) purely from extra unconditional shader work. See the note in ShadeKernel's DDFA classification block.
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

- [ ] PR CI workflow — there is no PR gate at all today, and CI never runs ESLint despite CONTRIBUTING requiring it
- [ ] HTML report with diff heatmaps (`bench/lib/metrics.js` already has `diffHeatmap()`, unused)
- [ ] CPU-side vitest guards: shader-recompile contract, BVH structural invariants, feature-combo compile smoke
- [ ] trend dashboard over `bench/baselines/perf.jsonl`
- [ ] corpus gap: skeletal/morph animation — needs a committed .glb, which the all-procedural rule cannot supply
- [ ] `bench:load` — scene loading has no gate. `bench:calibrate` times one model only to check the harness's CPU speed, and `perf.jsonl`'s `loadMs` is the procedural corpus (~18k triangles). Load a local list of real models (textured glTF, Zero-Day for many shapes sharing a `.ply`, one Moana part), skip missing ones (gitignored), in Chrome and Node; discard the first load, record parse / decode / extraction / BLAS / textures / shader compile from `performanceMetrics`; fail on a load error or recorded issue; A/B against a git ref like `bench:ab`, gated per phase. Both of 2026-09-30's load bugs were found by hand: Zero-Day's shared-`.ply` crash (shipped since 9.1.0) and Node's main-thread texture packing (4.5 → 2.1 s once moved to workers)


### General

- [x] introduce OPFS inplace of indexedDB
- [ ] deno compile for dedicated destop app
- [x] Introduce Project based workflow
- [x] Save rendering state in local storage and load on app start
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
- [ ] Clouds for the physical sky
- [ ] Volumetric rendering
- [x] Caustic support - Photon mapping &/ BDPT — bidirectional covers every light; vertex merging (`integrator: 'vcm'`, 2026-10-03) adds the specular–diffuse–specular paths no connection reaches (a point lamp's caustic seen in a mirror or through glass)
- [x] Guide bidirectional sky / sun light paths through windows (2026-10-03, `TSL/LightGuide.js`) — learned from camera escapes, no scene knowledge; classroom equal-time noise −19 % mid tones, +14 % frame time
- [ ] Normal-dependent MIS compensation (Karlík et al. 2019, Eq. 13) — precompute 512 compensated env map CDFs indexed by surface normal for ~19% improvement over current normal-independent compensation on diffuse+HDR scenes
- [ ] ReSTIR DI (Bitterli et al. 2020) — spatiotemporal resampling for many-light scenes
- [ ] https://cloud.needle.tools/hdris FastHDR

### Camera

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
- [ ] PNG image sequence export for better quality and post-processing flexibility
- [ ] Multi-clip blending - cross-fade between animation clips with configurable transition duration
- [ ] ArrayBufferTarget memory for long videos - StreamTarget upgrade
- [ ] sequence caching for smooth playback / scrubbing

---

## Performance & Architecture

### Pipeline

- [ ] GPU-CPU sync for environment in solid color sky mode

### BVH

- [ ] GPU compute refit via compute shader (level-by-level dispatch with barriers; replaces worker + SharedArrayBuffer path)
- [ ] Background BLAS rebuild after refit when SAH quality degrades
- [ ] Compact Wide BVH (CWBVH) — 4/8-way branching for GPU traversal

### Profiling

- [ ] Bottleneck identification

---

## Experiments

- [x] explore OpenColorIO OCIO color management
- [ ] Expirement with meshlet
- [ ] Neural-texture-compression <https://syllogi-graphikon.vercel.app/posts/metal-neural-texture-compression/>
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
- [x] Photon mapping (vertex merging, `integrator: 'vcm'`)
- [x] Bidirectional path tracing support — `integrator: 'bidirectional'` (every light: emitters, lamps, the sun, the environment; see CLAUDE.md)
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
- [x] NRD - Nvidia Realtime Denoiser (ReBLUR port, `Stages/NRD.js`; diffuse/specular signal split still open — see `docs/NRD_DENOISER.md`)

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
- Path Tracing a Trillion Triangles <https://community.intel.com/t5/Blogs/Tech-Innovation/Client/Path-Tracing-a-Trillion-Triangles/post/1687563>
- WebGPU Graphics Pipeline: <https://shi-yan.github.io/webgpuunleashed/Introduction/the_gpu_pipeline.html>
- See [ROADMAP.md] for long-term vision and strategic planning
- See [CONTRIBUTING.md] for development guidelines
- The Future of Path Tracing | Best Practices, Optimizations & Future Standards <https://www.youtube.com/watch?v=0IrzX4LDIx8>
- GPU optimization - 450 papers, 14 years of research. Some techniques will have evolved, but the mental models hold up: https://dl.acm.org/doi/10.1145/3570638
- https://github.com/mmp/pbrt-v4
