# Rayzee Path Tracer - TODO List

## Bugs
- remove all hacks on rectarealight parsing and treat all the incoming serailized data. getting difference between placeholder arealight vs arealight coming with usd files
- Press and hold when "show AI" on, shows empty canvas
- on model loaded, use the incoming camera, if any, instead of default
- audit implementation of transmission map. Scene thejunkshopsplashscreen blender splash screen
- [x] add diffuse transmission to the bidirectional integrator (2026-10-05, see Deferred)
  

### MVP
- [ ] Save compiled shaders??
- [x] engine core to be separated to make a minimal version for headless applications — done in 9.5.0: `rayzee/core` (`RayzeeRenderer`, its own bundle) with opt-in add-ons (formats, physical sky, archives, bidirectional, colour, storage); `PathTracerApp` is the viewer on top. See docs/CORE_AND_ADDONS.md
- [ ] dynamic max stack in bvhtraversal
- [x] need adaptive sampling like what we had in megakernal. its too good to have sacrifised from megakernel — done: one Adaptive Sampling switch (frame early-stop + per-pixel freeze, Cycles-style noise threshold and min samples), on in both modes. Pixel freeze does little on real interiors — see Known
- [ ] https://github.com/DennisSmolek/Fsr3 - branch already created
- [ ] tiled output for lower vram — Blender Cycles-style render-region tiling; VRAM-bounded 4K/8K final render + video. See docs/internal/specs/wavefront-tiled-output.md

### Deferred



### Known

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
- [x] compileAsync for compute shader (2026-10-04) — every kernel rebuild compiles in the background (`KernelManager.compile()`); page freeze on a new layer combination 3.7 s → 0.4 s, `SHADERS_COMPILING` event + app label

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
- [x] Diffuse transmission in the bidirectional integrator and VCM (2026-10-05) — light subpaths cross the surface; NEE, connections, light tracing and merges reach a vertex from behind (`facingSide`). `translucent-panel-bidirectional` reads +0.016 % against the path tracer, the furnace 0.99946. Found on the way: the emitter-hit MIS weight measured its NEE density from the world origin whenever the light tree was one node (a TSL argument first read after a loop's `Break`), +6 % on a grazing-lit floor since the integrator landed — fixed, six bidirectional baselines re-blessed. Still open: NRD at 1 spp on `cornell-bidirectional` / `caustic-bidirectional` reads 4.6–4.8× worse than no denoising (same on main)
- [ ] **Texture filtering (mipmaps + a level per hit)** — explored 2026-10-05 with a throwaway prototype, nothing kept.
  Today the packed texture arrays have no mips (`generateMipmaps = false` in `TextureCreator`) and every lookup reads
  level 0; three r186 builds mips per array layer when asked (one flag, +33 % texture memory).
  - **Why: quality at low samples, not speed.** 24155522.glb at 2048², every lookup forced to level 0 / 8: 155 ms a frame
    both. On a checker floor to the horizon (pbrt-v4's camera footprint at each hit, shrunk by max(⅛, 1/√spp)), RMSE
    against 2048 spp unfiltered — far band: 1 spp 0.159 → 0.064, 4 spp 0.074 → 0.012, 16 spp 0.036 → 0.0034, 1024 spp
    0.0027 → 0.0024; mid band better to 64 spp, then a lasting slight blur (1024 spp 0.0015 → 0.0050); near band even.
    Shows most in Preview and while moving (calm distant textures, no shimmer), and in a cleaner albedo for OIDN.
  - ⚠️ A fixed one-pixel footprint over-blurs everywhere: pixel jitter already integrates the pixel. Shrink it with samples.
  - **To build:** mips on the array buckets; dp/dx, dp/dy at the hit from the camera (pbrt-v4 `Approximate_dp_dxy`) →
    duv/dx, duv/dy through the triangle's uv Jacobian and each map's transform → `textureSampleGrad` with an anisotropic
    sampler (a single level over-blurs grazing floors sideways); every material map; bump steps at the level's texel
    size; alpha cutouts keep level 0 or get alpha-preserving mips (MASK foliage thins at distance otherwise); light
    subpaths level 0.
  - **Risks:** Shade is near a register limit and the footprint needs the hit triangle's rows — measure in place
    (`bench:kernels`). Changes default pixels: ship opt-in first, turn on in a major.
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

## pbrt-v4 import

### Learnings (kroken pass, 2026-10-04)
Compared against pbrt-v4-scenes' `images/kroken/camera-1.png`: chaise cushions, blanket and rug were missing, every coated
metal was grey, a hidden 90-unit sphere lit the room, and the glass jars were clear. Eleven loader bugs; none was hard
once looked at. How it should have been built so they could not happen:
- **Translate from pbrt's source, not from the scenes at hand.** Every bug was a guessed meaning: template shapes stored
  "relative to the transform at ObjectBegin" (invented — pbrt keeps the whole transform), lights two-sided (pbrt: one-sided
  unless `twosided`), `alpha` ignored, a `mix` clamping after mixing (pbrt clamps each albedo first). Still guessed today:
  conductor roughness defaults to 0.1 (pbrt 0), and every 8-bit image is read as sRGB (pbrt: only PNG; JPG/TGA are
  linear unless `encoding` says otherwise). Keep one table per directive — pbrt's parameter names, types, defaults, and
  the `file:line` in pbrt-v4 they came from — and derive the translators and their tests from it.
- **Account for every parameter.** pbrt itself calls `ReportUnused()` on each directive. A translator that marks what it
  consumed, and a loader that reports every unconsumed or approximated parameter once with a count (as an engine issue,
  not a console list cut off at 19), would have named seven of the silent gaps on the first load: `alpha`, `twosided`,
  `uscale`/`vscale`/`udelta`/`vdelta`, an imagemap's `scale`/`invert`, `normalmap`, `MediumInterface`, and a texture
  where a number was expected (`scale`, `amount`). `displacement` and `edgelength` still are.
- **Gate against pbrt's own images.** pbrt-v4-scenes ships a reference for every camera. Render each at its own camera,
  film size and `maxdepth`, apply the reference's post (kroken's `makepngs.sh`: OptiX denoise, white balance 6200 K, ACES
  filmic) and compare per 16² block: a missing object or a grey metal is a block that fails outright.
- **One generic texture strategy, not a special case per class.** pbrt evaluates a texture graph per hit; the engine
  samples image × constant per slot. Bake any uv-mapped graph to an image (now done for `mix`, `scale` by a texture,
  `scale` > 1, `invert`, a `mix` material's colours — `PBRTTextureBake.js`), and turn position-based mappings (planar,
  spherical, cylindrical) into a generated uv set per shape so they bake too. Only direction-dependent (`directionmix`)
  and 3D procedural textures need anything more.
- **Validate at the loader → engine boundary.** A float EXR normal map failed the whole load (`IndexSizeError` in
  `TextureCreator`). The engine should convert a texel format it cannot pack and record an issue for that texture,
  never abort the scene.
- **The engine ties emission side to surface side.** A one-sided pbrt light becomes `FrontSide`, which also makes its back
  see-through to camera rays; in pbrt it stays opaque (and black). An emitter-side flag apart from culling.
- **Never cache a failed load.** The archive scene cache stored a 3 GB graph from a load the engine then rejected; the next
  load would have restored it. Store only once the engine has accepted the scene, and derive the cache revision from the
  loader's code instead of a hand-bumped `PBRT_BUILD_REVISION`.
- **Count non-finite samples.** kroken's NaN pixels (two-sided emitter seen edge-on, fixed 057cbc41) were found by eye
  after OIDN drew them as black dots. A per-frame count in FinalWrite, recorded as an issue, makes the next one a number.

### Missing today
- [ ] **Displacement** (`texture displacement` + `edgelength`): dice to the edge length and displace along the normal at
  load, as pbrt does — kroken's rug pile, cushion tufting, bricks, rocks. Needs a per-shape triangle cap.
- [ ] **Texture mappings** `planar` / `spherical` / `cylindrical` → a generated uv set (see learnings): kroken's book
  spines, magazine covers, cups, wooden sphere fall back to the mesh's uv today.
- [ ] **Texture classes**: `dots` (needs pbrt's Perlin noise); `fbm`, `wrinkled`, `windy`, `marble` (3D procedural);
  `directionmix` (by the normal); `ptex` (only a like-named material's colour today). 2D `checkerboard` and `bilerp`
  are baked since 2026-10-05.
- [ ] **Mix material**: only its colours follow the amount texture; roughness, clear coat and metalness take the
  texture's mean. Per-texel maps, or pbrt's own per-hit choice between the two materials.
- [x] **Textured roughness** — a roughness map with pbrt's remap baked in, the clear coat's too (2026-10-05; crown's gold).
- [ ] **Participating media**: only absorption inside glass is mapped (σa + σs as attenuation). Scattering, a medium in a
  non-glass shape, the camera's medium and grid/nanovdb media need volumetric path tracing (Rendering → Volumetric).
- [ ] **Single-sheet dielectric**: kroken's picture glass is one quad of `dielectric`; the card behind it renders very
  noisy at 512 spp and OIDN turns the noise into a bumpy texture. See Known → `thickness` / thin-walled; check how the
  medium stack treats an open sheet against pbrt's per-interface orientation.
- [ ] **Named spectra**: `METAL_ALBEDO` is a five-metal table and blackbody is a curve fit. Port pbrt's named spectra
  (metals, glasses) and integrate against CIE for exact F0, IOR and blackbody colour (kroken reads warmer partly here).
- [ ] **Lights**: area light `filename` (an image that emits); `goniometric` → the engine's IES profiles; `projection` →
  its gobos; the infinite light's `portal`. Area light `power` done 2026-10-05.
- [x] **Shapes**: `cylinder`, partial `sphere`/`disk`, pbrt's uv (2026-10-05). Also fixed: `bilinearmesh` corner order
  (p00 p10 p01 p11) and a four-point patch without indices (watercolor's floor spots were dropped).
- [ ] **Cameras**: `spherical` → the engine's panorama (a panorama is global, not per camera: needs a per-camera
  projection); `realistic` (lens files). `lensradius` / `focaldistance` → the camera's own DOF done 2026-10-05.
- [ ] **Render settings a file asks for — open question.** `Integrator` maxdepth, `Sampler` pixelsamples and the Film
  resolution are read into `sceneMetadata.render` (2026-10-05; glTF extras may carry `rayzee.render` too) but nothing
  applies them (watercolor asks for 15 bounces at 1920×1440). Undecided: apply them at all? Only to the final render
  (bounces / samples / size), leaving Preview fast? Offer them in the UI ("this scene asks for …")? Applying changes how
  those files render, and the mode presets own maxBounces and maxSamples today. Film `iso` / `exposuretime` /
  `whitebalance` not read yet.
- [x] **Shape `alpha`** between 0 and 1, or a texture — the engine's blend mode, per shape–material pair (2026-10-05;
  bistro's leaves and curtains, watercolor's splatters).
- [ ] **Materials** approximated as diffuse: `hair`, `measured`. `subsurface` → the engine's SSS done 2026-10-05
  (named media, σa/σs, reflectance + mfp through the dipole).
- [ ] **Texture filtering** — see Features → Rendering → Texture filtering (kroken's brick dirt read patchy where pbrt's
  MIP-filtered render is even).
- [ ] `bench:pbrt` — the reference-image gate above, over a local copy of pbrt-v4-scenes (skip what is not downloaded).

---

## Performance & Architecture

### Pipeline

- [ ] GPU-CPU sync for environment in solid color sky mode

### Core and add-ons — make more of the core opt-in

The core should support three.js objects and glTF/GLB out of the box; everything else a host chooses. Sizes are
minified + gzip of the three.js loader alone (three is external, so it lands in the host's bundle, not ours).

- [x] **Model formats as add-ons** (2026-10-04) — `rayzee/addons/formats` (`fbxFormat` … `exrFormat`, `allFormats`),
  registered with `assetLoader.registerFormat()`; one shared load path replaced seven wrappers (AssetLoader 1,622 →
  1,351 lines); a host's own format registers the same way. Archives kept `setArchiveImporter` (already public).
- [x] **glTF decoders on demand** (2026-10-04) — `GLTFDecoders.js` reads the glTF's JSON for the extension names
  before the parse and imports only those decoders; Node's Draco and KTX2 fixtures still match their twins.
- [x] **EXR environments** (2026-10-04) — `exrFormat` in the formats add-on; pbrt archives keep their own EXRLoader.
  Host bundle (core-browser example): main chunk 577 → 534 KB gzip, and the seven model-loader chunks are gone.
- [x] **Material layers compiled only when used** (2026-10-04) — clear coat, sheen, iridescence, anisotropy,
  subsurface, dispersion, diffuse transmission (`materialLayers( builder )`). Images unchanged; frame time median
  −9.6 % (−3.9 to −24.3 %) over 28 scenes. Specular transmission is the one big layer left (glass handling,
  shadow rays through glass) — needs the sampler's leftover `Else` (rand ≥ the summed weights) kept exact.
- [x] **G-buffer on request** (2026-10-04) — `requestOutput( 'gBuffer' )`; the viewer asks at start-up, the core's
  kernels leave it out. Core still renders byte for byte as the full engine.
- [ ] The bidirectional NEE in Shade (~250 lines, ~2.9 KB gzip of source, ~1 % of the core) could move into the add-on
  as one function taking Shade's locals; the ~40 small `if ( bdpt )` sites (MIS bookkeeping) would stay. Low value.
- [ ] The memory spill's orchestration in `SceneProcessor` (~6 KB): moving it needs hooks inside the three hardest build
  functions, testable only on 50M-triangle loads. Low value.

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
