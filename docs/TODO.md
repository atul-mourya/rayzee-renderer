# Rayzee Path Tracer - TODO List

## Bugs
- remove all hacks on rectarealight parsing and treat all the incoming serailized data. getting difference between placeholder arealight vs arealight coming with usd files
-  dont reload the same model using query param. instead provide a save button with autosave option. on reload load the default. users can open using file menu
-   Fast compilation on windows devices
-   make bvh an independent library — built as the `rayzee-bvh` package on the night of 2026-11-05 (branch
    `night/bvh-package`), not committed
- Headless, from the pbrt comparison: a crop window with the pixel offset in the sampler's seed (on
  `feat/tiled-output`), a variance layer in the EXR. Assessment:
  ~/RayzeeScratch/night/2026-11-13/headless-api/ASSESSMENT.md
- Safari: the Moana `pbrt-v4` folder (14,732 files, 32 GB) fails at its first read, `NotReadableError`, handed to the
  page's file input by `bench:load -- --safari`; a 24-file folder loads. Try a drop of the folder in the app
- Safari: a second load of watercolor (24.7M triangles) in one page runs out of memory (`RangeError: Out of memory`, or
  Safari kills the page and closes its window); a fresh page loads it in 52–58 s. Check the app's reload of a large scene

### Follow-ups from the Rust/WebAssembly night (2026-11-11)
- [ ] Find why Firefox's `extraction` is 2–2.5× and its first frame 2.4–4× Chrome's (`bench:load -- --firefox`, 2026-11-14)
- [ ] Chrome: decode a zipped image from its bytes, not `createImageBitmap( new Blob( [ bytes ] ) )`
- [ ] Moana island phases (Chrome, textured): USD read 30 s, USD build 50 s, extraction + BLAS 57 s, placing and
  measuring copies 11 s, grouping 12 s, top-level tree 12 s, writing the tree 8 s, assembling 10 s, copy records
  13 s, upload + compact 23–32 s
- [ ] USD read/build: the profile is flat (no function over 5 %, garbage collection 20 %); cut allocation, move crate
  decoding (LZ4, int decode) into workers. pbrt build: zero-day 1.7 s, hibiscus 2.6 s
  - 2026-11-12: composition no longer makes a node, a promise and four list-op merges for every name looked up
    (`siteNode`, `addArcsBelow`, `strength` as an array): isBeach + isCoral in Node allocate 8.8 → 6.8 GB, same scene
    (fingerprint); read 3.5–3.9 → 3.4–3.5 s, within noise. Decoding is 8 % of the read (`ints`); a scratch buffer for
    it changed nothing. Left: `triangulate`, `term`, `meshParams` (~1 GB together), and the 25 % in garbage collection
- [ ] Top-level tree and copy grouping in WebAssembly would copy 600 MB+ into wasm memory at the island's peak:
  only worth it with the big stores living in a shared WebAssembly.Memory
- [ ] Geometry extraction off the main thread (52–77 ns a triangle now; 111M on the island). The island's extraction
  phase (66 s profiled in Chrome): 57 % idle (waiting on BLAS workers), the giant-mesh split ~20 % (made 2× faster,
  4c232157), the fill 4.3 %, `transferable` copies for the storage worker 3.6 %, triangle uploads 3.2 %
- [ ] Meshes of 200k–2M triangles in the BLAS pool instead of one at a time through the parallel builder: no clear
  change on five models (moana-mountain blas −15 %, crown +12 % inside its noise); untried on the island
- [ ] Textures still on the page in Chrome (24155522.glb): writing the 716 MB of layers to the GPU ~200 ms
  (`writeTextureLayers`), the triangle and tree uploads ~150 ms. Starting textures before the geometry extraction
  (they need only the materials, `extractMaterialsOnly`) was tried twice: no gain in Chrome, the overlap slowing
  extraction as much as it saved
- [ ] Textured island: preflight 8,811 MB against the 9,216 MB line; Ptex's per-face vertices add ~870 MB of geometry.
  A load in a tab that had held the island before failed narrowing the sky (`ArrayBuffer.transfer`'s smaller block):
  the narrowed texels now stay in place when that block cannot be had
- [ ] Ptex: float Ptex (displacement) becomes its mean; a pbrt or USD scene with Ptex is not stored as a graph;
  triangle-mesh Ptex is approximate

### MVP
- [ ] Coat darkening (OpenPBR `coat_darkening`), on its own and done properly: reverted (was 8f9e51f3, b119e0b1) — it
  darkened many scenes and brought artifacts. pbrt coateddiffuse's Lambertian base (no specular of its own) went with it.
- [ ] https://github.com/DennisSmolek/Fsr3 (no FSR3 branch here any more)
- [ ] tiled output for lower vram — Blender Cycles-style render-region tiling; VRAM-bounded 4K/8K final render + video. See docs/internal/specs/wavefront-tiled-output.md; unmerged branches `feat/tiled-output` and `feat/tiled-output-v2`

### pbrt: read but not used (audit of the 26 catalog scenes, 2026-11-01)
- [ ] PixelFilter: box, triangle and Gaussian are drawn (`pixelFilter`, 2026-11-10; a file naming none gets pbrt's
  Gaussian); Mitchell and Lanczos are not (negative lobes: a weight of ±1 a sample, which a plain average cannot carry),
  and none under the bidirectional integrators (light tracing would need splats spread by the filter)
- [ ] Not read, not in the catalog: realistic cameras, an off-centre `screenwindow` or a `screenwindow` / `frameaspectratio` the film stretches (drawn centred at the film's aspect; an orthographic one off centre could be exact, a sideways move of the camera), shutter (motion blur), Film sensor response curves (approximated: its white balance is read) / `cropwindow`, CameraMedium and space-filling media, non-homogeneous media, scattering inside media (σs folds into absorption)

### UX issue
- Because Diffuse Roughness is only built into the renderer when a material uses it, the first move of its slider off 0 makes the renderer rebuild, so the picture stalls for a few seconds.

### Deferred



### Known

- [ ] A scene whose file asks for bidirectional and has glass loses light through the glass: glass blocks the
  bidirectional shadow rays (see CLAUDE.md, Bidirectional integrator), and since 2026-11-07 the file's integrator is
  applied. Volumetric Caustic's glass ball renders dark where path tracing lights it; Glass of Water opens bidirectional
  too (path matched or beat it, 60268c36).
- [ ] **Light radius, what is left** (see Light radius in `CLAUDE.md`): the bidirectional and VCM integrators still treat them as points; glTF
  has no field for a radius (`docs/design/SCENE_IMPORT.md` → Lights from Blender's glTF exporter); the app has no control for it. ⚠️ Blender
  writes half its sun angle (10° → `angle` 5) though USD defines the full width, so its suns read half as soft.

- [ ] `thickness` is inert, so every transmissive surface is treated as a volume boundary. glTF uses `thicknessFactor == 0` to mean **thin-walled** — no refraction, tint once, attenuation ignored. A hollow thin-walled shell therefore tints at every interface crossed (√ baseColor each since 11.16, as Cycles: 4 crossings on the Gelatinous Cube give blue 0.168² = 0.028; before, 0.168⁴ = 0.0008 and it rendered black). Fix = branch on thickness, and re-add the Thickness control with a scene-relative range (three.js specifies it in local space x model scale), not the old 0..1 slider. gap-plan Phase 4.4.
  **Proper fix on branch `feat/thin-glass` (ee108cf9, not merged) — merge it rather than redoing this** (it predates the
  11.16 glass colour: its sheet tint and shadow-ray branch need the colour transmittance and `transmissionTint`): thickness 0 is a
  thin sheet (no bend, no medium, both faces' Fresnel 2R / (1 + R)) in the glass path, the opaque path's transmission
  lobe and shadow rays; importers mark solid glass with thickness 1; the app gets a "Thin" switch. Changes how glTF
  glass without a volume renders (it stops refracting).
- [ ] Shadow rays cross glass in a straight line (coloured since 11.16, see `docs/design/SHADING.md` → Light through
  glass): within ~1 % of refraction for panes, but a thick block lands ±7 % off, as the light really bends through it.
- [ ] Rough, part-transmissive glass reads 0.96–0.97 in a closed white furnace (T 0.25–0.75, IOR 1.5, roughness
  0.7–1, 32 bounces; T 0 reads 1.000 and T 1 0.998). Cause found 2026-11-04: the straight shadow rays, not the BSDF.
  From inside the sphere, environment NEE crosses the wall straight (T, no Fresnel, no total internal reflection),
  while BSDF paths through the same wall keep the last opaque scatter's pdf and are balance-weighted against it, so the
  two estimate different light. With NEE blocked by glass and every path that crossed glass weighed 1, the furnace
  reads 0.999 (roughness 1) and 0.995 (0.2). Weighing only glass reflections 1 (NEE never draws them) recovers a third:
  0.964 → 0.975, but overshoots at roughness 0.2 (1.0065). The 0.97 at roughness 0.2 in `furnace-glass-*` is the
  8-bounce limit (32 bounces: 1.000). A fix is the "Light through glass" trade (noise-free coloured shadows behind
  panes against this bias), not a bug fix; the same cause as the thick-block line above. Experiments:
  `~/RayzeeScratch/night/2026-11-04/rough-glass-furnace/`.
- [ ] Extension maps (transmission, clearcoat, sheen, …) are read on the base-colour map's UV transform (the coat's normal map on the base normal map's, or its own when there is none) and the first UV set; glTF gives each its own `texCoord` and `KHR_texture_transform`.
- [ ] Fluted glass (24233846.glb): firefly threshold, bounce counts and LED brightness change nothing — don't retry. The leftover noise is the LED-lit cabinet seen through the glass; it needs ReSTIR DI or a radiance cache (neither built).
- [ ] Same glass at `normalScale` 100 loses half its light: steep normals send samples under the surface and the leak guard kills them. Cycles' fix (`ensure_valid_specular_reflection`) on the shared normal brightened diffuse +17.6 % (2026-09), so it needs a separate normal for the glossy lobe.


### Unconfirmed

---

## Features

### Chores
- [ ] minimize unwanted dependencies - <https://github.com/atul-mourya/RayTracing/network/dependencies>
- [ ] open issue by threejs <https://github.com/mrdoob/three.js/issues/32969> (33061 fixed in r185: StorageTextures now resize in place)

### Regression bench (`bench/`)

- [ ] PR CI workflow — there is no PR gate at all today, and CI never runs ESLint despite CONTRIBUTING requiring it
- [ ] CPU-side vitest guards: shader-recompile contract, feature-combo compile smoke


### General

- [ ] docs to include more visual elements like graphs, charts, images etc
- [ ] deno compile for dedicated destop app
- [ ] export/import option for settings
- [ ] transform control redesign

### Compilation

### Rendering
- [ ] Explore neural textures: example <https://cornell-neural.utsubo.io/>
- [ ] Volumes, what is left (docs/design/VOLUMES.md): USD `OpenVDBAsset` (Moana ocean); pbrt's `rgbgrid` and `cloud`
  media, its camera medium; scenes with a volume stored as graphs; inside glass and subsurface; coloured extinction; NEE
  toward glowing volumes; NRD guides; picking; sparse bricks.
- [ ] Introduce Sequenced HRDIs - https://mattepaint.com/gallery/hdri/skies/
- [ ] **Fog and light shafts** ROADMAP: "Fog and homogeneous participating media", "Volumetric lighting and shadows";
  - [ ] Follow-ups: fog inside glass; the shadow catcher ignores fog; the bidirectional integrators render without it
    (they record `setting.ignored`).
  - [ ] A bright speckle remains wherever a bounced ray passes close to a small bright emitter in fog: the segment's
    light from one point of it goes as 1 / (the ray's distance from that point). Drawing the point with the segment in
    view (Cycles' light tree takes a segment) would soften it.
- [ ] Lens flare
- [ ] Cone Tracing
- [ ] Clouds for the physical sky
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
    (`bench:kernels`). Changes default pixels: ship opt-in first, then turn on, saying how renders change.
- [ ] Normal-dependent MIS compensation (Karlík et al. 2019, Eq. 13) — precompute 512 compensated env map CDFs indexed by surface normal for ~19% improvement over current normal-independent compensation on diffuse+HDR scenes
- [ ] ReSTIR DI (Bitterli et al. 2020) — spatiotemporal resampling for many-light scenes
- [ ] https://cloud.needle.tools/hdris FastHDR

### Camera
- [ ] Panorama "level horizon" levels to +y: under a scene camera whose up is not +y it turns oddly while orbiting

### Lighting

### Materials

- [ ] implement pending Physical material properties
- [ ] **Dispersion grain** — a path through dispersive glass carries one wavelength, so even BK7 (Abbe 64), whose split
  is barely visible once converged, doubled transparent-machines' error at 64 spp (0.022 → 0.047, rainbow speckle on
  every edge). Since 2026-11-07 the wavelength is drawn by how much it adds to the picture (`sampleWavelengthForDispersion`,
  three logistic lobes on the CIE → sRGB weights; weight variance 7.5 → 4.6): 0.047 → 0.039. Hero wavelengths would not
  help: pbrt too drops to one at a dispersive interface (`TerminateSecondary`). Left: following one wavelength is the cost.
  (`MaterialEvaluation` no longer saturates a dispersive part-transmissive material's base colour, which glTF never
  asked for: 2026-11-08, `tests/gpu/dispersion.test.js`.)
- [ ] Supporting GPU-compressed texture arrays requires adding  per-scene format selection at build time - the TSL compiler doesn't support clean teardown/rebuild of compute pipelines when texture binding types change.

### Environment

- [ ] Add new category of environment maps - abstract (identify files and organize)
- [ ] Revamp environment control UX

### Scene Management
- [ ] SDF-based model rendering


### Animation

- [ ] glTF light tracks (intensity, colour) need three's KHR_animation_pointer plugin, which the engine does not register
- [ ] A session restores hidden objects but skips model lights (`SceneState.js`, `! object.isLight`): a light hidden in
  the outliner comes back with its eye open while its copy stays off
- [ ] Timeline scrubber for animation control
- [ ] Multi-clip blending - cross-fade between animation clips with configurable transition duration
- [ ] sequence caching for smooth playback / scrubbing

---

## pbrt-v4 import

### Missing today
- [ ] **Displacement past the cap**: a `plymesh`'s displacement is diced at load as pbrt does (2026-11-20), but kroken's
  ten meshes each pass `displacementTriangles` (1M; pbrt makes 4–54M) and are diced coarser: the carpet at 0.89 cm for
  pbrt's 0.1. The detail lost could go back as a bump map from the same texture.
- [ ] **Texture classes**: `dots` (needs pbrt's Perlin noise); `fbm`, `wrinkled`, `windy`, `marble` (3D procedural);
  `directionmix` on shapes other than triangle meshes (plymesh, bilinear patches, quadrics) and nested in `scale` /
  `mix` textures. 2D `checkerboard` and `bilerp` are baked since 2026-10-05.
- [ ] **Mix material**: colours, clear coat, roughness and metalness follow the amount texture (baked per texel); the
  surface stays the mean where either material has a roughness, metalness or coat map of its own, and IOR,
  transmission and the rest always do. pbrt's own per-hit choice between the two materials would cover all of it.
- [ ] **Participating media**: a homogeneous medium is only absorption inside glass (σa + σs as attenuation); its
  scattering, one in a non-glass shape, a grid medium inside glass and the camera's medium need volumetric tracing.
- [ ] **Single-sheet dielectric**: kroken's picture glass is one quad of `dielectric`; the card behind it renders very
  noisy at 512 spp and OIDN turns the noise into a bumpy texture. See Known → `thickness` / thin-walled; check how the
  medium stack treats an open sheet against pbrt's per-interface orientation.
- [ ] **Spectra, what is left**: a named illuminant used as a reflectance reads grey; EXR area-light images and
  material maps ignore their `chromaticities` (skies honour them).
- [ ] **Lights**: `goniometric` → IES; `projection` → gobos; infinite `portal`.
- [ ] **Cameras**: `realistic` (lens files). (`spherical` opens as the engine's panorama: lat-long for `equirectangular`,
  the equal-area projection for pbrt's default `equalarea`, 2026-11-09.)
- [ ] **Materials**: `hair`, `measured` load as diffuse.
- [ ] **Texture filtering** — see Features → Rendering → Texture filtering (kroken's brick dirt read patchy where pbrt's
  MIP-filtered render is even).
- [ ] **One table per directive**: pbrt-v4's parameter names, types, defaults and the `file:line` they come from, the
  translators and their tests derived from it (`pbrt/defaults.test.js` checks the defaults by hand today).
- [ ] `bench:pbrt` against pbrt-v4-scenes' published reference images, with their own post applied
  (`docs/design/SCENE_IMPORT.md` → Extending it): today it renders references with a local pbrt-v4 build (`RAYZEE_PBRT`).
- [ ] **Pick one scene of several**: a zip or folder of several pbrt scenes (pbrt-v4-scenes' hair zip, 11) opens the
  shortest-named and only the console names the rest; the app has no way to open another (`pbrtEntry` exists). Its
  numbered names also fool `findFrameSequence`: `hair-eumel-2` and `-8` load as one two-frame animation.

---

## USD import

- [ ] **Vertex colours** — displayColor varies per vertex; the engine has none, so each mesh takes its mean.
- [ ] **Light linking** — Moana's palm keys light only the palms (`collection:lightLink`); here every light lights everything.
- [ ] **Camera dome** — Moana's `sky_dome_cam_llc` (islandsunVIS.png) is the background, the lighting dome another image;
  the engine has one environment.
- [ ] **Meshes past a budget are still cut in read order** — with storage the budgets are 120M / 60M and the whole island
  fits (the spill turns on by itself); without storage (a private window) the budget is 45M and a quarter of the meshes
  are cut.
- [ ] **Ocean** — clear turquoise in RenderMan from `deepWaterVolume.vdb` and PxrSurface's diffuse transmission; dark here.
- [ ] **PxrSurface's specular, unchecked** — RenderMan's primary specular is likely off unless authored (its face and
  edge colours default to black), while the importer keeps the engine's default specular on. No `PxrSurface.args` here
  to confirm; Moana's one PxrSurface (the ocean) authors its specular, so nothing local changes.
- [ ] Skeletal animation, NURBS and points prims, UDIM textures, and `.usdz` through this importer.

## Scene scale (after grouped placements and buffer parts, 2026-10-08)

- [ ] **Split-BVH traversal** — a node's four vec4 are read in one branch since 2026-10-14: three parts +9–14 % →
  +4–7 % frame time, two parts unchanged at +3–8 %. The two-part cost is the two-buffer reads in the traversal loop, not
  the branches, divergence or bindings (each tested); only a different layout (parts at BLAS boundaries?) could help.
- [ ] **Member placements** — a grouped copy is one TLAS entry, but every member keeps its placement (a matrix and
  ~11 B each): 11M extra on the whole island, ~0.8 GB of CPU memory. Store the matrix once a copy.
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
- [ ] **Material images still held**: pbrt's baked and float maps (52 of Bistro's 292, ~176 MB) and a glTF's images in
  Safari (three.js reads them with TextureLoader) stay decoded. A glTF keeps its image files' bytes for a rebuild, which
  Chrome holds in its browser process (+0.13–0.17 GB on 24155522). A rebuild decodes every map again, holding a 256 MB
  group's sources at once (Bistro: tab 5.3 GB during one, settled 1.4 GB).

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

- [ ] **OIDN at 1920×1080 runs as 4 tiles**: a live refresh (oidn-web 0.5.0, Apple M-series, visible tab, 2026-10-11) takes 67 ms as 4 tiles (178 MB), 58 ms as 2 (280 MB), 50 ms as 1 (483 MB). oidn-webgpu 0.6.0 (M5 Pro on battery, 2026-10-25, not like for like with those): 80 ms as 4 tiles, 56–59 ms as 1 in the app; 57 / 42 ms in Node (0.5.0: 66 ms as 4 tiles). The tile cap is now an area, so wide frames that fit stay whole (1280×720: 33 → 22 ms); going past it is a memory trade. NRD (+15 ms a frame at 1080p) stays for large views until OIDN keeps up there. Tried and rejected (2026-10-11, `git stash` "half-size OIDN while moving"): denoising the half-size render while moving gave ~3× the pictures a second but boiled visibly more — blotch flicker on 24155522.glb at 1024², full 3.34, ¾ 4.22, ½ 5.06.

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

- [x] Experiment with meshlet — three r187's meshlet pipelines, measured 2026-10-31: not worth it (camera rays are
  2.6–3.2 % of a frame)
- [ ] Neural-texture-compression <https://syllogi-graphikon.vercel.app/posts/metal-neural-texture-compression/>
- [ ] Offscreen canvas rendering - <https://threejs.org/manual/#en/offscreencanvas>
- [ ] Ray-Guiding based on Octahedron Mapping CDF
- [ ] Full Disney BSDF
- [ ] RCAS (Robust Contrast Adaptive Sharpening)
- [ ] Sparse Radiance Cascades
- [x] Screen-space radiance caching
- [x] No Kulla-Conty or Turquin energy compensation
- [x] ReSTIR-based sampling techniques - Branch open with name "ReSTIR"
- [x] stackless BVH traversal - slowness expected
- [x] Bindless texture - True hardware-level bindless isn't available in WebGPU
- [x] irradiance probes,
- [ ] SPOM (Silhouette Parallax Occlusion Mapping) ->  more suited for rasterization
- [ ] Experiment PLOC for maximum BVH performance scenarios
- [x] tiered-material-buffer-access generalization - already at its practical optimum
- [ ] Opacity micro map
- [ ] Shader Execution Reordering (hardware) — blocked until WebGPU has ray tracing (gpuweb #11054 / #11056 open). The software version shipped as the material sort (`SortGlobalKernels.js`): −8 % on the corpus, −2 % on 24155522.glb, where shading without shadow rays is ~8 % of the frame
- [x] Sort rays before tracing — tried 2026-11-06 (stash "ray-sort trial"), no gain. 24155522.glb at 1024²: an origin key makes Extend's later bounces 7 % faster, a 16-bit origin × direction key 16 %, but the sort eats it (frame −0.3 % / −0.3 %). Shade ordered by hit position instead of material: −8 % frame on 24155522 (shadow rays), but +1.4–17 % on the 8 other models — same pattern as the shadow passes stash; needs a per-scene signal nobody has found
- [ ] Mega Geometries - Compressed Clusters as input to BLAS
- [ ] Mega Geometries - PTLAS - Partitioned TLAS
- [ ] SHaRC - Spatial Hash Radiance Cache - observed issues: transparent objects blocky, glowing reflictive materials, color bleeding, baised. **Root cause measured**: single-scale hashing only covers 59% of first indirect hits from a 1/16 seed — see the ORCA probe below, where 6 levels take the same scene to 99.7%
- [ ] ORCA multi-scale radiance cache (SIGGRAPH '26 Greenberg) — probed on both axes with `node bench/tools/orca-probe.mjs`. **Coverage GO**: 99.7% hit rate on 24155522.glb at the talk's 1/16 sparse rate (they report 98-99%); hierarchy depth is the whole effect, 1 level 59% → 6 levels 99.7%. **Quality: the price is a permanent +5-6% brightening of the indirect term (+4.7% of the frame) and ~23% median per-pixel error, bought against a 2.3x variance reduction.** Three things make that price fixed rather than tunable: 4x more seed paths does not move it (1/4 sparse +6.1% vs 1/64 +6.0%, so it is spatial aggregation error, not sampling error); voxel size barely moves it (2px +5.4% → 32px +6.7%, the hierarchy self-normalises onto a similar sample population whatever the base scale); and the one lever that does — fewer levels — trades it straight back for coverage (1 level = +4.1% bias but only 66% hit rate, and the perf case needs >98%). Unweighted indirect bias is ~0%, so the error is structured and correlates with throughput rather than being random. Verdict unchanged: preview-only, off past frame N, never in final render. Not yet tried from the talk and would soften the per-pixel error: dithered lookup (Binder2018), probability-weighted downrez, radiance clamp before store
- [ ] ORCA Tier-3 budgeted sampling (SIGGRAPH '26 Greenberg) — built, measured, parked (its branch, `experiment/orca-tier3-budgeted-sampling`, is no longer here). Neutral quality + 23% slower on 24155522.glb; won −8..−12% at half the rays on glass-transmission only. Resume by restoring survivor-curve dispatch sizing under `budgetOn` — that is the entire 23%
- [ ] Rerservoir sampling ( only per pixel, not neighboring )
- [ ] emissive triangles as trianle lights -  do research
- [ ] Auto white balance
  
---

## AI Integration

- [ ] Explore AI-driven denoising techniques beyond OIDN
- [ ] <https://upscalerjs.com/models/>
- [ ] <https://enhance.addy.ie/>
- [ ] NRD: split the diffuse and specular signals (see `docs/design/NRD_DENOISER.md`)

## AI Upscaler

### Performance

- [ ] Custom model URL support — let users provide their own ONNX SR model
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
- interesting test contents: https://www.thepixellab.net/exclusive-page-2
