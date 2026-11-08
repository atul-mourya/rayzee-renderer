# Rayzee Path Tracer - TODO List

## Bugs
- remove all hacks on rectarealight parsing and treat all the incoming serailized data. getting difference between placeholder arealight vs arealight coming with usd files
-  the Moana lava rocks render bright red. The scene file itself sets them to red, and their real colour comes from a texture format (Ptex) the pbrt loader doesn't read yet.
-  dont reload the same model using query param. instead provide a save button with autosave option. on reload load the default. users can open using file menu
-   result page to show hrd when available
-   Fast compilation on windows devices
-   pbrt camera all info parsing
-   pbrt folliage
-   make bvh an independent library
-   this fbx scene not loading correctly: https://www.fab.com/listings/578d0ceb-5ccb-425f-abd5-e791a21551b6 , /Users/atulkumar/Desktop/3DAssets/south_african_slate_quarry_low.zip

### MVP
- [ ] White balance control: reference pictures are finished after rendering — pbrt's own (watercolor's makepngs.sh:
  white balance 8000 K, ×0.8, ACES) and artists' (watercolor's are another renderer's, graded in Photoshop). pbrt's raw
  render is as blue as Rayzee's (mean xy 0.283, 0.302 both), so a render can only match them with a warmth control;
  pbrt Film `whitebalance` is unread too.
- [ ] Coat darkening (OpenPBR `coat_darkening`), on its own and done properly: reverted (was 8f9e51f3, b119e0b1) — it
  darkened many scenes and brought artifacts. pbrt coateddiffuse's Lambertian base (no specular of its own) went with it.
- [ ] dynamic max stack in bvhtraversal
- [ ] https://github.com/DennisSmolek/Fsr3 - branch already created
- [ ] tiled output for lower vram — Blender Cycles-style render-region tiling; VRAM-bounded 4K/8K final render + video. See docs/internal/specs/wavefront-tiled-output.md

### pbrt: read but not used (audit of the 26 catalog scenes, 2026-11-01)
- [ ] PixelFilter (triangle, radius 1; 25 scenes) — engine uses its own pixel reconstruction
- [ ] Not read, not in the catalog: spherical / realistic cameras (spherical becomes perspective), perspective `screenwindow`, `frameaspectratio`, shutter (motion blur), Film white balance / sensor / `cropwindow` / `maxcomponentvalue`, CameraMedium and space-filling media, non-homogeneous media, scattering inside media (σs folds into absorption)

### UX issue
- Because Diffuse Roughness is only built into the renderer when a material uses it, the first move of its slider off 0 makes the renderer rebuild, so the picture stalls for a few seconds.

### Deferred



### Known

- [ ] A scene whose file asks for bidirectional and has glass loses light through the glass: glass blocks the
  bidirectional shadow rays (see CLAUDE.md, Bidirectional integrator), and since 2026-11-07 the file's integrator is
  applied. Volumetric Caustic's glass ball renders dark where path tracing lights it; Glass of Water opens bidirectional
  too (path matched or beat it, 60268c36).
- [ ] FBX and Collada cameras' own shape is not used for the picture's (`userData.aspect`): three.js's FBXLoader puts in
  the window's when a file gives none (`AspectWidth` / `AspectHeight`) and the ColladaLoader leaves its default, so a
  given shape cannot be told from a missing one without the raw values.

- [ ] An OBJ + MTL pair in a zip (`loadOBJMTLPairFromZip`): a texture the MTL names but the zip lacks resolves loosely
  to any entry ending with its name (`k.png` → `models/oak.png`) or, past 5 characters, containing or contained in it
  (`max.png` → `maps/x.png`): the wrong texture instead of none. Lookup order pinned by `archiveImporterLookup.test.js`
  (2026-11-08); a fix would match whole names only.
- [ ] Tar: GNU sparse members (old `S` and pax 0.0 / 0.1 / 1.0) are not understood: in Python's `testtar.tar` their maps
  read as three garbage entries. Every other local tar (86 of 97 Python can read) lists and reads as Python's `tarfile`
  does, apart from a leading `./` we drop (2026-11-07). Sparse files are rare in scene archives.
- [ ] **Light radius, what is left** (point and spot lights with a radius, and USD's sphere radius and sun angle, done
  2026-10-12; see Light radius in `CLAUDE.md`): the bidirectional and VCM integrators still treat them as points; glTF
  has no field for a radius (`docs/SCENE_IMPORT.md` → Lights from Blender's glTF exporter); the app has no control for it. ⚠️ Blender
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
- [ ] OIDN's guide jumps from "see through" to "this surface" at a hard step (pure metal: roughness 0.049). Cycles' smooth ramp was tried (2026-08) and lost on 9 of 10 `bench:denoise` OIDN tests; a retry must keep one surface per pixel.
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
- [ ] CPU-side vitest guards: shader-recompile contract, feature-combo compile smoke (BVH structural invariants done: `tests/unit/processor/bvhInvariants.test.js`; the memory-spill and BLAS-cache builds are not walked yet)
- [ ] corpus gap: skeletal/morph animation — needs a committed .glb, which the all-procedural rule cannot supply


### General

- [ ] deno compile for dedicated destop app
- [x] Introduce Project based workflow
- [x] Save rendering state in local storage and load on app start
- [ ] export/import option for settings
- [ ] transform control redesign

### Compilation

### Rendering

- [ ] The light tree splits by position only; pbrt-v4's SAOH adds an orientation term to the split. Cones are the
  tighter of the children's union and the node's own since 2026-11-08 (unions had made a gently curved panel's nodes
  whole spheres): in a room of curved LED strips, downlights and a sphere lamp (2,240 emitters), selections landing on
  an emitter facing away 8.1 → 6.6 % (`~/RayzeeScratch/night/2026-11-08/light-tree-cones/scripts/wasted.mjs`).
- [ ] Introduce Sequenced HRDIs - https://mattepaint.com/gallery/hdri/skies/
- [ ] **Fog and light shafts** ROADMAP: "Fog and homogeneous participating media", "Volumetric lighting and shadows";
  - [ ] Follow-ups: fog inside glass; density varying other than with height (noise, VDB); the shadow catcher ignores
    fog; the bidirectional integrators render without it (they record `setting.ignored`). Height falloff and emitters
    lit along each segment are done (2026-10-31, see `docs/design/SHADING.md` → Fog).
  - [ ] A bright speckle remains wherever a bounced ray passes close to a small bright emitter in fog: the segment's
    light from one point of it goes as 1 / (the ray's distance from that point). Drawing the point with the segment in
    view (Cycles' light tree takes a segment) would soften it.
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
    (`bench:kernels`). Changes default pixels: ship opt-in first, then turn on, saying how renders change.
- [ ] Normal-dependent MIS compensation (Karlík et al. 2019, Eq. 13) — precompute 512 compensated env map CDFs indexed by surface normal for ~19% improvement over current normal-independent compensation on diffuse+HDR scenes
- [ ] ReSTIR DI (Bitterli et al. 2020) — spatiotemporal resampling for many-light scenes
- [ ] https://cloud.needle.tools/hdris FastHDR

### Camera

### Lighting

### Materials

- [ ] implement pending Physical material properties
- [ ] **Dispersion grain** — a path through dispersive glass carries one wavelength, so even BK7 (Abbe 64), whose split
  is barely visible once converged, doubled transparent-machines' error at 64 spp (0.022 → 0.047, rainbow speckle on
  every edge). Since 2026-11-07 the wavelength is drawn by how much it adds to the picture (`sampleWavelengthForDispersion`,
  three logistic lobes on the CIE → sRGB weights; weight variance 7.5 → 4.6): 0.047 → 0.039. Hero wavelengths would not
  help: pbrt too drops to one at a dispersive interface (`TerminateSecondary`). Left: following one wavelength is the cost.
  Also not glTF's: `MaterialEvaluation` saturates the base colour of a dispersive transmissive material.
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
  An explicit `encoding` on a PNG colour map is honoured since 2026-11-07 (decoded and baked to sRGB). Keep one table
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
  and 3D procedural textures need anything more. Position-based mappings done 2026-10-14.
- **Validate at the loader → engine boundary.** A float EXR normal map failed the whole load (`IndexSizeError` in
  `TextureCreator`). The engine should convert a texel format it cannot pack and record an issue for that texture,
  never abort the scene. Done 2026-10-12: float and half-float maps pack as 8-bit (`rgba8Pixels`), and a layer that
  cannot be converted takes a placeholder and an issue instead of failing its bucket.
- **The engine ties emission side to surface side.** A one-sided pbrt light became `FrontSide`, which also made its back
  see-through to camera rays; in pbrt it stays opaque (and black). Done 2026-11-04: a material's `emissiveSide`, an
  emitting side in the triangle flags apart from culling.
- **Never cache a failed load.** The archive scene cache stored a 3 GB graph from a load the engine then rejected; the next
  load would have restored it. Store only once the engine has accepted the scene (done 2026-10-14), and derive the cache
  revision from the loader's code instead of a hand-bumped `PBRT_BUILD_REVISION` (no build-tool-free way found; since
  2026-11-07 `buildRevision.test.js` hashes the loader's and the graph codec's code against a recorded hash, so a change
  fails until the bump is decided).
- **Count non-finite samples.** kroken's NaN pixels (two-sided emitter seen edge-on, fixed 057cbc41) were found by eye
  after OIDN drew them as black dots. A per-frame count in FinalWrite, recorded as an issue, makes the next one a number.
  Partly since 2026-10-25: OIDN counts them in its input (`denoiser.non_finite_input`), but only while it runs.

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
- [ ] **Spectra, what is left**: pbrt's illuminant tables other than A and D65 (D50, F1–F12, `illum-acesD60`) and
  spectra read from a file light white (reported); a reflectance given as ( λ, value ) samples reads as its mean grey,
  and a blackbody one as its hue at 1 (pbrt reflects the curve itself, peaking at 1). Blackbody and sampled emission
  done 2026-11-08: Planck's law or the samples against CIE 1931, within 0.002 of pbrt-v4's own render (the old curve was
  up to 0.07 off: kroken's 6500 K sky and lights too yellow, zero-day's 2300 K too red). Named spectra done 2026-11-07:
  pbrt's seven glasses (`GLASS_ETA`, read like any spectral `eta`; kroken's F11 was 1.5, now 1.78) and seven metals
  (`METAL_ALBEDO`: normal-incidence reflectance of each one's eta and k through CIE 1931 under D65, Real-Time
  Rendering's table to 3 digits; brass was grey, TiO2 50 % grey metal where it reflects 24 %, MgO 90 % where it reflects
  7 %).
- [ ] **A second infinite light** is dropped; the engine has one environment. Not a loss in watercolor (checked
  2026-11-08): its two are the same image and scale, each limited to one window by `portal` (pbrt's
  `PortalImageInfiniteLight::Le` is 0 outside it), and one environment with the portal ignored lights both windows
  alike. Two different infinite lights (an image and a constant, say) would need summing into one.
- [ ] **Lights**: area light `filename` (an image that emits); `goniometric` → the engine's IES profiles; `projection` →
  its gobos; the infinite light's `portal`. Area light `power` done 2026-10-05.
- [ ] **Cameras**: `spherical` → the engine's panorama (a panorama is global, not per camera: needs a per-camera
  projection); `realistic` (lens files). `lensradius` / `focaldistance` → the camera's own DOF done 2026-10-05.
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

- [ ] GPU-CPU sync for environment in solid color sky mode
- [ ] Zero-Day loaded as a single frame (`animation: false`) built in 77.6 s for 4.0M triangles, the 9-frame clip in 38.3 s for 2.2M (measured once, busy machine) — check with `bench:load`.
  Re-measured 2026-11-07 with `bench:load` (Node on Dawn, quiet machine, 27977388, median of 3): the frame ready in
  12.0 s (4.0M triangles), the clip in 11.5 s (2.2M, 6,177 meshes); `pbrtBuild` is 8.5 s of each. Chrome not timed.
- [ ] **OIDN at 1920×1080 runs as 4 tiles**: a live refresh (oidn-web 0.5.0, Apple M-series, visible tab, 2026-10-11) takes 67 ms as 4 tiles (178 MB), 58 ms as 2 (280 MB), 50 ms as 1 (483 MB). oidn-webgpu 0.6.0 (M5 Pro on battery, 2026-10-25, not like for like with those): 80 ms as 4 tiles, 56–59 ms as 1 in the app; 57 / 42 ms in Node (0.5.0: 66 ms as 4 tiles). The tile cap is now an area, so wide frames that fit stay whole (1280×720: 33 → 22 ms); going past it is a memory trade. NRD (+15 ms a frame at 1080p) stays for large views until OIDN keeps up there. Tried and rejected (2026-10-11, `git stash` "half-size OIDN while moving"): denoising the half-size render while moving gave ~3× the pictures a second but boiled visibly more — blotch flicker on 24155522.glb at 1024², full 3.34, ¾ 4.22, ½ 5.06.
- [ ] **Fast Navigation flaps on heavy scenes at 1080p** (NRD, or no live denoiser): full-size frames take the GPU past 100 ms a frame, interaction mode times out between them, and the pending drop to half size does not take hold. 24155522.glb at 1920×1080 under NRD: half size reached only after 4.1 s of moving.
  Could not reproduce 2026-11-07 (27977388): a 5 s drag (`controls.rotateLeft` every 8 ms) dropped to half size after
  118 ms under NRD, 96 ms with none, 12 ms under OIDN, and held it to the end, one drop and one restore each.

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
- [ ] Shader Execution Reordering (hardware) — blocked until WebGPU has ray tracing (gpuweb #11054 / #11056 open). The software version shipped as the material sort (`SortGlobalKernels.js`): −8 % on the corpus, −2 % on 24155522.glb, where shading without shadow rays is ~8 % of the frame
- [x] Sort rays before tracing — tried 2026-11-06 (stash "ray-sort trial"), no gain. 24155522.glb at 1024²: an origin key makes Extend's later bounces 7 % faster, a 16-bit origin × direction key 16 %, but the sort eats it (frame −0.3 % / −0.3 %). Shade ordered by hit position instead of material: −8 % frame on 24155522 (shadow rays), but +1.4–17 % on the 8 other models — same pattern as the shadow passes stash; needs a per-scene signal nobody has found
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
- [x] Estimated time remaining based on per-tile timing (`UPSCALING_PROGRESS.secondsLeft`, shown on the app's badge)
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
