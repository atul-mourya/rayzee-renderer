# Rayzee Path Tracer - TODO List

## Bugs
- remove all hacks on rectarealight parsing and treat all the incoming serailized data. getting difference between placeholder arealight vs arealight coming with usd files
-  the Moana lava rocks render bright red. The scene file itself sets them to red, and their real colour comes from a texture format (Ptex) the pbrt loader doesn't read yet.
-  dont reload the same model using query param. instead provide a save button with autosave option. on reload load the default. users can open using file menu
-   Rough glass too bright
-   result page to show hrd when available

### MVP
- [ ] dynamic max stack in bvhtraversal
- [ ] https://github.com/DennisSmolek/Fsr3 - branch already created
- [ ] tiled output for lower vram — Blender Cycles-style render-region tiling; VRAM-bounded 4K/8K final render + video. See docs/internal/specs/wavefront-tiled-output.md

### UX issue
- Because Diffuse Roughness is only built into the renderer when a material uses it, the first move of its slider off 0 makes the renderer rebuild, so the picture stalls for a few seconds.

### Deferred



### Known

- [ ] **Light radius, what is left** (point and spot lights with a radius, and USD's sphere radius and sun angle, done
  2026-10-12; see Light radius in `CLAUDE.md`): the bidirectional and VCM integrators still treat them as points; glTF
  has no field for a radius (`docs/SCENE_IMPORT.md` → Lights from Blender's glTF exporter); the app has no control for it. ⚠️ Blender
  writes half its sun angle (10° → `angle` 5) though USD defines the full width, so its suns read half as soft.

- [ ] `usePixelFreeze` is inert on 24155522.glb — bit-identical to uniform at 150 spp, nothing reaches `pixelFreezeThreshold` 0.02, so the shipping adaptive default saves nothing on real interiors
- [ ] `thickness` is inert, so every transmissive surface is treated as a volume boundary. glTF uses `thicknessFactor == 0` to mean **thin-walled** — no refraction, tint once, attenuation ignored. A hollow thin-walled shell therefore tints baseColor at every interface crossed (4x on the Gelatinous Cube: blue 0.168^4 = 0.0008, renders black). Fix = branch on thickness, and re-add the Thickness control with a scene-relative range (three.js specifies it in local space x model scale), not the old 0..1 slider. gap-plan Phase 4.4.
  **Proper fix on branch `feat/thin-glass` (ee108cf9, not merged) — merge it rather than redoing this:** thickness 0 is a
  thin sheet (no bend, no medium, both faces' Fresnel 2R / (1 + R)) in the glass path, the opaque path's transmission
  lobe and shadow rays; importers mark solid glass with thickness 1; the app gets a "Thin" switch. Changes how glTF
  glass without a volume renders (it stops refracting).
- [ ] (low priority) OIDN made 150-spp renders slightly worse than raw (2026-08, before oidn-web 0.5.0 — re-measure). Defaults stop at 30–60 spp, so only raised caps hit it. Fix if real: fade OIDN out as the image converges.
- [ ] NRD is still worse than raw at 4–16 spp on several scenes (2026-10-14, after the 1-spp fix): alpha-cutout 1.57 / 2.21, sheen 1.13 / 1.38, clearcoat 1.05 / 1.35, shadow-catcher 1.24 / 1.37, iridescence 1.08, anisotropy 1.04 (4 / 16 spp). `bench:denoise`'s `sppLadder [1, 64]` never measures them: add a 4 or 16 rung.
- [ ] NRD treats a whole emissive material as an emitter (never blurred), so a surface with a mostly-black emissive map is left noisy; a one-pixel ring can still leak at a non-black emitter's edge (needs per-sample emission, no free G-buffer lane).
- [ ] Shadow rays through glass ignore its tint (Junk Shop's "Furniture" looks black but passes white light).
- [ ] Extension maps (transmission, clearcoat, sheen, …) are read on the base-colour map's UV transform (the coat's normal map on the base normal map's, or its own when there is none) and the first UV set; glTF gives each its own `texCoord` and `KHR_texture_transform`.
- [ ] USD MaterialX coat normals (`coat_normal`, `geometry_coat_normal`, `clearcoat_normal`) are not read: the engine has `clearcoatNormalMap` since 2026-10-15, so `mtlxNormal` can set it as it sets `normalMap`.
- [ ] OIDN's guide jumps from "see through" to "this surface" at a hard step (pure metal: roughness 0.049). Cycles' smooth ramp was tried (2026-08) and lost on 9 of 10 `bench:denoise` OIDN tests; a retry must keep one surface per pixel.
- [ ] Fluted glass (24233846.glb): firefly threshold, bounce counts and LED brightness change nothing — don't retry. The leftover noise is the LED-lit cabinet seen through the glass; it needs ReSTIR DI or a radiance cache (neither built).
- [ ] Same glass at `normalScale` 100 loses half its light: steep normals send samples under the surface and the leak guard kills them. Cycles' fix (`ensure_valid_specular_reflection`) on the shared normal brightened diffuse +17.6 % (2026-09), so it needs a separate normal for the glossy lobe.


### Unconfirmed
- verify shadow-cull with the single-sided quad test to verify if a single-sided surface is see-through to GI but blocks shadow rays.



---

## Features

### Chores
- [ ] minimize unwanted dependencies - <https://github.com/atul-mourya/RayTracing/network/dependencies>
- [ ] open issues by threejs <https://github.com/mrdoob/three.js/issues/32969> and 33061

### Regression bench (`bench/`)

- [ ] PR CI workflow — there is no PR gate at all today, and CI never runs ESLint despite CONTRIBUTING requiring it
- [ ] CPU-side vitest guards: shader-recompile contract, feature-combo compile smoke (BVH structural invariants done: `tests/unit/processor/bvhInvariants.test.js`; the memory-spill and BLAS-cache builds are not walked yet)
- [ ] corpus gap: skeletal/morph animation — needs a committed .glb, which the all-procedural rule cannot supply
- [ ] `bench:load` in Chrome — the Node side is built (`npm run bench:load`, `-- --ab main`); browser-only paths (`createImageBitmap` decoding, background kernel compile, OPFS) are not timed. Its floors (15 % and 100 ms) were set on a busy machine: re-check on a quiet one.


### General

- [ ] deno compile for dedicated destop app
- [x] Introduce Project based workflow
- [x] Save rendering state in local storage and load on app start
- [ ] export/import option for settings
- [ ] transform control redesign

### Compilation

### Rendering

- [ ] Introduce Sequenced HRDIs - https://mattepaint.com/gallery/hdri/skies/
- [ ] **Fog and light shafts** ROADMAP: "Fog and homogeneous participating media", "Volumetric lighting and shadows";
  - [ ] Follow-ups: equiangular sampling for small emitters (a tiny bright emissive ball still speckles its halo);
    fog inside glass; height falloff / heterogeneous media; the shadow catcher ignores fog; bidirectional integrators
    render without it (record `setting.ignored`)
- [ ] Lens flare
- [ ] Cone Tracing
- [ ] Clouds for the physical sky
- [ ] Volumetric rendering (heterogeneous: smoke, clouds, VDB) — homogeneous fog is the entry above
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
- [ ] Supporting GPU-compressed texture arrays requires adding  per-scene format selection at build time - the TSL compiler doesn't support clean teardown/rebuild of compute pipelines when texture binding types change.

### Environment

- [ ] Add new category of environment maps - abstract (identify files and organize)
- [ ] Revamp environment control UX

### Scene Management
- [ ] SDF-based model rendering


### Animation

- [ ] animating lights support
- [ ] Timeline scrubber for animation control
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
  unless `twosided`), `alpha` ignored, a `mix` clamping after mixing (pbrt clamps each albedo first). A default read off
  one file misleads too: `textures.cpp` gives a non-PNG image the encoding `linear`, but `Image::Read` (`util/image.cpp`)
  decodes JPG and TGA through stb_image as sRGB whatever it says, so reading every 8-bit image as sRGB matches pbrt.
  Still differs: an explicit `encoding` on a PNG colour map is ignored here (no local scene sets one). Keep one table
  per directive — pbrt's parameter names, types, defaults, and the `file:line` in pbrt-v4 they came from — and derive
  the translators and their tests from it.
- **Account for every parameter.** pbrt itself calls `ReportUnused()` on each directive. A translator that marks what it
  consumed, and a loader that reports every unconsumed or approximated parameter once with a count (as an engine issue,
  not a console list cut off at 19), would have named seven of the silent gaps on the first load: `alpha`, `twosided`,
  `uscale`/`vscale`/`udelta`/`vdelta`, an imagemap's `scale`/`invert`, `normalmap`, `MediumInterface`, and a texture
  where a number was expected (`scale`, `amount`). `displacement` and `edgelength` still are. Done 2026-10-14
  (`asset.parameters_ignored`).
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
  load would have restored it. Store only once the engine has accepted the scene (done 2026-10-14), and derive the cache
  revision from the loader's code instead of a hand-bumped `PBRT_BUILD_REVISION` (open: no build-tool-free way found; a
  unit test hashing the loader's sources against a recorded hash would catch a forgotten bump).
- **Count non-finite samples.** kroken's NaN pixels (two-sided emitter seen edge-on, fixed 057cbc41) were found by eye
  after OIDN drew them as black dots. A per-frame count in FinalWrite, recorded as an issue, makes the next one a number.

### Missing today
- [ ] **Displacement** (`texture displacement` + `edgelength`): dice to the edge length and displace along the normal at
  load, as pbrt does — kroken's rug pile, cushion tufting, bricks, rocks. Needs a per-shape triangle cap.
- [ ] **Texture classes**: `dots` (needs pbrt's Perlin noise); `fbm`, `wrinkled`, `windy`, `marble` (3D procedural);
  `directionmix` (by the normal). 2D `checkerboard` and `bilerp` are baked since 2026-10-05; `ptex` is read since
  2026-10-06 (as a colour map; its mean anywhere else).
- [ ] **Ptex past 1,024 files**: each .ptx is a texture of its own, and past 1,024 for one map type the engine renders
  the rest untextured — Moana's isCoral names 2,273, isDunesA 755. Pack small atlases onto shared pages (distinct
  Texture objects over one `source`: the extractor counts sources); the scene-graph codec would then have to store a
  page once, not once per texture.
- [ ] **Mix material**: only its colours follow the amount texture; roughness, clear coat and metalness take the
  texture's mean. Per-texel maps, or pbrt's own per-hit choice between the two materials.
- [ ] **Participating media**: only absorption inside glass is mapped (σa + σs as attenuation). Scattering, a medium in a
  non-glass shape, the camera's medium and grid/nanovdb media need volumetric path tracing (Rendering → Volumetric).
- [ ] **Single-sheet dielectric**: kroken's picture glass is one quad of `dielectric`; the card behind it renders very
  noisy at 512 spp and OIDN turns the noise into a bumpy texture. See Known → `thickness` / thin-walled; check how the
  medium stack treats an open sheet against pbrt's per-interface orientation.
- [ ] **Named spectra**: `METAL_ALBEDO` is a five-metal table and blackbody is a curve fit. Port pbrt's named spectra
  (metals, glasses) and integrate against CIE for exact F0, IOR and blackbody colour (kroken reads warmer partly here).
- [ ] **A second infinite light** is dropped (watercolor has two); the engine has one environment.
- [ ] **Spectral `eta`** is read at 550 nm (crown's gems were IOR 200 before 2026-10-14). The dispersion layer could fit
  `ior + 0.03·dispersion / λ²` to it; exact needs the sampled table in the shader.
- [ ] **Lights**: area light `filename` (an image that emits); `goniometric` → the engine's IES profiles; `projection` →
  its gobos; the infinite light's `portal`. Area light `power` done 2026-10-05.
- [ ] **Cameras**: `spherical` → the engine's panorama (a panorama is global, not per camera: needs a per-camera
  projection); `realistic` (lens files). `lensradius` / `focaldistance` → the camera's own DOF done 2026-10-05.
- [ ] **Render settings a file asks for — open question.** `Integrator` maxdepth, `Sampler` pixelsamples and the Film
  resolution are read into `sceneMetadata.render` (2026-10-05; glTF extras may carry `rayzee.render` too) but nothing
  applies them (watercolor asks for 15 bounces at 1920×1440). Undecided: apply them at all? Only to the final render
  (bounces / samples / size), leaving Preview fast? Offer them in the UI ("this scene asks for …")? Applying changes how
  those files render, and the mode presets own maxBounces and maxSamples today. Film `iso` / `exposuretime` /
  `whitebalance` not read yet.
- [ ] **Materials** approximated as diffuse: `hair`, `measured`. `subsurface` → the engine's SSS done 2026-10-05
  (named media, σa/σs, reflectance + mfp through the dipole).
- [ ] **Texture filtering** — see Features → Rendering → Texture filtering (kroken's brick dirt read patchy where pbrt's
  MIP-filtered render is even).
- [ ] `bench:pbrt` — the reference-image gate above, over a local copy of pbrt-v4-scenes (skip what is not downloaded).

---

## USD import

- [ ] **Ptex** — Moana's USD ships its .ptx (13 GB); a Ptex input reads the mesh's mean displayColor today.
- [ ] **Vertex colours** — displayColor varies per vertex; the engine has none, so each mesh takes its mean.
- [ ] **Light linking** — Moana's palm keys light only the palms (`collection:lightLink`); here every light lights everything.
- [ ] **Camera dome** — Moana's `sky_dome_cam_llc` (islandsunVIS.png) is the background, the lighting dome another image;
  the engine has one environment.
- [ ] **Meshes past a budget are still cut in read order** — with storage the budgets are 120M / 60M and the whole island
  fits (the spill turns on by itself); without storage (a private window) the budget is 45M and a quarter of the meshes
  are cut.
- [ ] **Ocean** — clear turquoise in RenderMan from `deepWaterVolume.vdb` and PxrSurface's diffuse transmission; dark here.
- [ ] **Scene cache** — the pbrt importer stores its parsed graph (`_storeGraph`); USD rebuilds every time.
- [ ] Skeletal animation, NURBS and points prims, UDIM textures, and `.usdz` through this importer.

## Scene scale (after grouped placements and buffer parts, 2026-10-08)

- [ ] **Split-BVH traversal** — a node's four vec4 are read in one branch since 2026-10-14: three parts +9–14 % →
  +4–7 % frame time, two parts unchanged at +3–8 %. The two-part cost is the two-buffer reads in the traversal loop, not
  the branches, divergence or bindings (each tested); only a different layout (parts at BLAS boundaries?) could help.
- [ ] **Member placements** — a grouped copy is one TLAS entry, but every member keeps its placement (a matrix and
  ~11 B each): 11M extra on the whole island, ~0.8 GB of CPU memory. Store the matrix once a copy.
- [ ] **glTF instancing** — EXT_mesh_gpu_instancing gives each primitive its own matrix attribute, so its parts do not
  group; group equal matrix lists by content too.
- [ ] **Placements' memory** — copy clusters (~80 B a copy on the GPU against 128) and the after-load spill (matrix lists,
  TLAS with its copy records and order maps on disk) took the island's resident CPU data from 6.9 to 2.2 GB; what stays
  is the table's columns (~1.2 GB, ~25 B a placement). A compact instancer level (position, rotation, scale) is the lever
  below that.
- [ ] **A move on a spilled island reads 3.5 GB back** (3.3 s in Chrome): every matrix list and the whole TLAS, though a
  move needs only the clusters its copies share and their members' lists. A selective restore would cut it.
- [ ] **SharedArrayBuffer chunks outlive a respill**: ~2 GB of TLAS and copy-record chunks wait for Chrome's next major
  collection after a move (non-shared buffers are freed at once with `transfer( 0 )`). Paging edits into non-shared chunks
  would need every SAB reader (the refit worker) to cope.
- [ ] **Picking and the selection outline on a spilled giant**: a model whose geometry stays on disk (1 GB and up) selects
  nothing by click and outlines nothing. The outline could read back just the selected mesh's arrays (and matrix list);
  picking needs a BVH-backed raycast rather than three.js's, which tested 51M empty copies for seconds.
- [ ] **One big upload is one big block**: Chrome keeps a shared memory block the size of each upload in flight for the
  page's life. Chunk stores and texture arrays are paced now (arrays in 64 MB slices, written to the GPU texture
  directly); the environment still goes in one `writeTexture` (392 MB on the island).
- [ ] **Decoded material images stay in the tab**: every source image is kept decoded for the session so a material
  rebuild can repack the arrays — 4 GB for bistro's 278 2K maps, most of what is left of its 6.3 GB peak. An archive's
  image could be read again from the archive on a rebuild instead (`ARCHIVE_PATH` is on the texture).

## OIDN 0.6.0 (`oidn-webgpu`, released 2026-10-25)

Measured 2026-10-25 on the M5 Pro, our own calls: 11–21 % faster a denoise (small 720p 21.6 → 18.7 ms, large 1080p
279 → 232), output within one 8-bit level, `bench:denoise` all pass. NaN and negative input no longer spread across the
picture: in 0.5.0 one NaN pixel smeared over 60–110 pixels, and 1 % of pixels at −0.5 turned ~80 % of the frame to NaN
(small model).

### Browser and Node

### Browser
- [ ] Skip for now: `kernel: 'subgroup-matrix'` needs Chrome's unsafe-WebGPU flag and was no faster than the default on
  the M5 Pro (f16: same speed, 5× the pixel difference). Recheck once Chrome ships it without the flag.

### Node (headless)
- [ ] **Subgroup matrix on the farm GPU (NVIDIA L4, Vulkan)**: run `npm run bench:oidn` there — the default against the
  subgroup-matrix kernel, speed and pixel difference. M5 Pro: no gain (f32 accumulation 11–15 % slower, f16 0–6 %). If it
  wins, the engine would request `chromium-experimental-subgroup-matrix` when the adapter has it (Node only: Dawn needs
  `allow_unsafe_apis`), pass `kernel: 'subgroup-matrix'`, and copy `adapter.info` onto the device (dawn.node 0.6.1 leaves
  `device.adapterInfo.subgroupMatrixConfigs` empty; report drafted).
- [ ] **Native denoiser for video export (evaluate)**: oidn-webgpu-native 0.1.1's C API (prebuilt for Linux x86_64,
  Windows and macOS; its own wgpu device, CPU images, signed normals) took 33–44 % less time than 0.6.0 in Chrome on an
  M4 Max and 64–70 % less on an RTX 4060 (upstream's numbers; RTX output unchecked). On paper for this M5 Pro at 1080p:
  large ~112 ms + ~15 ms to read colour and guides back (measured: 5–8 + 8–10 ms) + the C API's own copies, against
  171 ms for the WebGPU denoise as one tile — ~20–30 ms a frame saved, and nothing for the small model. Worth it only
  where the GPU gains like the RTX 4060 (a farm on NVIDIA): measure `bench:oidn` and the package's `oidn-webgpu-bench`
  on the L4 first. Its prebuilt binary was not run here (needs your OK).

---

## Performance & Architecture

### Pipeline

- [ ] GPU-CPU sync for environment in solid color sky mode
- [ ] Every `PathTracerApp` downloads OIDN's weights at startup, even with no denoiser; offline that records an error-severity `asset.unreachable`.
- [ ] Zero-Day loaded as a single frame (`animation: false`) built in 77.6 s for 4.0M triangles, the 9-frame clip in 38.3 s for 2.2M (measured once, busy machine) — check with `bench:load`.
- [ ] **OIDN at 1920×1080 runs as 4 tiles**: a live refresh (oidn-web 0.5.0, Apple M-series, visible tab, 2026-10-11) takes 67 ms as 4 tiles (178 MB), 58 ms as 2 (280 MB), 50 ms as 1 (483 MB). oidn-webgpu 0.6.0 (M5 Pro on battery, 2026-10-25, not like for like with those): 80 ms as 4 tiles, 56–59 ms as 1 in the app; 57 / 42 ms in Node (0.5.0: 66 ms as 4 tiles). The tile cap is now an area, so wide frames that fit stay whole (1280×720: 33 → 22 ms); going past it is a memory trade. NRD (+15 ms a frame at 1080p) stays for large views until OIDN keeps up there. Tried and rejected (2026-10-11, `git stash` "half-size OIDN while moving"): denoising the half-size render while moving gave ~3× the pictures a second but boiled visibly more — blotch flicker on 24155522.glb at 1024², full 3.34, ¾ 4.22, ½ 5.06.
- [ ] **Fast Navigation flaps on heavy scenes at 1080p** (NRD, or no live denoiser): full-size frames take the GPU past 100 ms a frame, interaction mode times out between them, and the pending drop to half size does not take hold. 24155522.glb at 1920×1080 under NRD: half size reached only after 4.1 s of moving.

### Core and add-ons — make more of the core opt-in

The core should support three.js objects and glTF/GLB out of the box; everything else a host chooses. Sizes are
minified + gzip of the three.js loader alone (three is external, so it lands in the host's bundle, not ours).

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
