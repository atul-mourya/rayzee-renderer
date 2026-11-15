# Volumes

Smoke, clouds and fire: media whose density changes from point to point, read from a grid (an OpenVDB file, or one a
host fills or draws from noise). The even and height fog (`shaders/Fog.js`, SHADING.md → Fog) stays as it is; volumes
sit beside it and the two mix. How to use it: [docs/guide/rendering.md](../guide/rendering.md#volumes).

## What it is

- A **`Volume`** (`scene/Volumes.js`) is a three.js `Object3D`: it moves, hides and parents like any object. It holds
  a **`VolumeGrid`** of density, optionally one of emission or temperature, and the inputs Blender's Principled Volume
  names: `density`, `color` (what a scatter keeps), `anisotropy`, `emissionColor`, `emissionStrength`, `blackbody`,
  `temperature` (kelvin a unit of the temperature grid). `app.updateVolumes()` after an edit: a header is rewritten,
  or, when a grid changed or a volume came or went, everything is packed again.
- Extinction is grey: σt( x ) = `density` × grid( x ) per scene unit, the scatter's colour its albedo. One number a
  point keeps free flight exact with no spectral weights, as the fog does. Coloured extinction is left out.
- Emission is light per unit of length (Cycles' model): `emissionStrength` × `emissionColor` × g( x ), or with
  `blackbody` Cycles' Principled Volume at Blackbody Intensity `emissionStrength`: σ / π · T⁴ × the blackbody colour
  (`blackbodyToLinearRGB`, `color/WhiteBalance.js`) at T = g × `temperature`. `emissionFromAbsorption` multiplies it by
  σa, as pbrt's media emit; `emissionRamp( g )` replaces the colour outright. Either is baked into a 64-entry ramp a
  volume, read linearly, so the shader never computes a blackbody.
- A grid's index space maps to the object by `VolumeGrid.transform` (a VDB's own map), and the object to the world by
  its `matrixWorld`. Voxel centres sit at whole indices, as in OpenVDB.
- An emission grid of another box (a VDB's temperature grid usually is) is resampled onto a box covering both, in the
  density grid's index space. It stays packed while the volume has it, glowing or not: a strength dragged through 0
  rewrites a header, not the atlas and the kernels.

## On the GPU

One 3D texture, `r16float` (`rg16float` while some volume has an emission grid), holds every volume's voxels and its
majorant grid, packed as boxes (slabs, shelves, rows; a few widths tried). Each volume's box has a zero border one voxel
wide, so hardware trilinear filtering reads what OpenVDB's box sampler reads at the edge (the background). One uniform
array holds a header of 8 vec4 a volume (world → grid rows, atlas offsets, size, colour, anisotropy, majorant layout,
emission) and its ramp: up to 16 volumes, 18 KB (`VOLUME_LAYOUT`, `scene/BufferLayout.js`). Only Shade and its shadow
rays read them; no storage buffer is added (Shade binds 8 of 10) and one sampled texture is.

- **Majorants**: one cell per `c`³ voxels, c chosen so the longest side has ≤ 32 cells (pbrt keeps 16³), each the
  largest value a trilinear lookup inside the cell can read — the cell's voxels and the ring around them — × 1.001,
  rounded up to the next half float. Free flight and transmittance walk them with a 3D DDA.
- **Budget**: past 2²⁷ voxels (256 MB as `r16float`) the largest grids are halved (a 2×2×2 mean) until all fit; so is
  any side past `maxTextureDimension3D`. Recorded as `volume.downsampled`.
- **Uploads** go in slabs of ≤ 64 MB (`writeTextureLayers`), drained between: Chrome keeps its upload pool at the
  largest write in flight (CLAUDE.md → Uploads in Chrome). The CPU copy is dropped once written.
- Compiled in only while some volume is packed (`PathTracer._volumesNeeded()`, keyed on the atlas's channels), and
  emission only while some has an emission grid. A new atlas of as many channels is read through the same texture node
  (`_volumeAtlasNode`), so a repack rebuilds no shader; it is swapped in whole once uploaded. With none, every compute
  kernel's WGSL is main's (32 of 32 modules, normalised hashes, a scene with glass, emitters, lamps and the physical
  sky).

## Tracing

Per Shade segment (origin → hit), outside glass and subsurface media, in the block the fog uses:

1. **Free flight**: the fog's closed-form flight first, then delta tracking (Woodcock) through each volume the segment
   crosses, majorant cell by cell, capped at the nearest collision found so far. Extinctions add, and the first
   collision of a sum is the nearest of each one's own (the minimum of independent exponentials), so the media are
   tracked one after another. The first distance is the bounce's Sobol' dimension (`FOG_DIM.VOLUME_DISTANCE`); the rest
   the path's PCG state.
2. **Emission** (track length): along [ start, where the path scatters or meets a surface ] of each emitting volume,
   the integral of its emission from stratified points, one a four voxels crossed, 1 to 16, one jitter shared.
3. **A scatter** takes the albedo and continues along a Henyey–Greenstein draw. Its light: `fogScatterLight`
   (directional and rect lights, the sky with the balance heuristic, the sun with the power heuristic) with the
   volume's colour and anisotropy, plus `pointScatterLight` — one of the point and spot lights and the emitters, picked
   by its unshadowed light at the point, the emitter drawn from either side and weighed against the phase draw with
   the power heuristic, as its hit is. The fog's segment lights stay the fog's, dimmed by the volumes between the ray's
   start and their point (ratio tracking). Every slot's shadow ray goes through `traceFogLight`'s one loop.
4. **Shadow rays** (`traceShadowRay`) take each volume's transmittance by ratio tracking, Russian roulette below 0.1
   (pbrt-v4). A shadow ray carries no path state: its stream is seeded from the ray, the thread and the frame.

Volume scatters count as bounces (`maxBounces`), Russian roulette from the third, as fog's do. The G-buffer takes the
first scatter (normal toward the camera, the albedo), as fog's. Under the bidirectional integrators volumes are left
out (`setting.ignored`). A scene of volumes alone gets a hidden anchor triangle (`anchorVolumes`, `SceneLoading.js`):
the geometry build refuses zero triangles. Model bounds count volumes (`expandByVolumes`):
three.js's `Box3.setFromObject` sees none.

## OpenVDB

`loaders/OpenVDB.js`, core because two add-ons import it on first use: formats (`vdbFormat`, `.vdb`) and, later,
archives (USD's `OpenVDBAsset`). It reads the header and grid descriptors, then a grid's topology and buffers when
asked: any tree configuration, float, half or double values, the per-node inactive-value flags and selection masks,
Zip (fflate's `unzlibSync`), Blosc (LZ4 or zlib streams, byte shuffle; split or not) or no compression, file versions
213–225, and the linear maps (uniform scale, scale + translate, translation, affine, unitary). A frustum map, instanced
grids and vector grids are not read. ⚠️ OpenVDB's `HalfWriter` writes nothing for an empty block; full floats still
write a size.

A grid becomes dense over its active box (`file_bbox_min` / `max`, else its leaves and active tiles), halved as often
as the budget asks while the values are written. `volumeFromOpenVDB` picks `density` (else the first fog volume), a
`temperature` grid as blackbody emission (intensity 1, Blender's Quick Smoke), else `flame` / `fire` / `heat` as orange
emission. Either may be missing, not both: a fire alone (EmberGen writes `temperature` and `flames`, no density) gets a
density of zeros, so it glows and casts nothing.
- **Temperature scale** (`kelvinPerUnit`): Blender's 1000 K a unit, raised so the hottest voxel reaches 2500 K. At
  1000 K EmberGen's grids (peak ~1.3) glowed a dim red; Blender's Mantaflow (peak ~3) keeps 1000. A grid past 100 is
  taken as kelvin already.
- **Up axis** (`upAxisOf`): a file whose `creator` names a Y-up tool (Houdini — the Moana ocean says "Houdini
  18.0.499/GEO_VDBTranslator" —, Maya, Bifrost, Katana, Clarisse, Nuke) keeps its axes; any other is Z-up and turned
  `rotation.x = −π/2`. Blender and EmberGen write no creator; EmberGen's fire grows from index z 0 up to 120 while x
  and y stay centred.

Checked against what OpenVDB 13 (Blender 5.1's module) reads back from files it wrote — tiles at two levels, half
floats, an affine map, four grids of three types, inactive values of every flag, and a Mantaflow fire bake
(`tests/unit/loaders/fixtures/vdb/`, `make.py`) — and on the Moana island's `deepWaterVolume.vdb` (Houdini 18, OpenVDB
6.2, Blosc): 108M active voxels in 1.3 s, halved to 1868 × 21 × 436 for the 2048-texel limit.

## pbrt's grid media

pbrt-v4's `nanovdb` and `uniformgrid` media inside a shape (`MediumInterface "smoke" ""`) become volumes
(`_gridMediumVolumes`, `addons/archives/pbrt/PBRTSceneBuilder.js`), placed by the transform where the medium was made:
- **NanoVDB** (`addons/archives/pbrt/NanoVDB.js`): files of ABI 32 (pbrt-v4's nanovdb, 32.3), segments of grids raw,
  Zip or Blosc; float grids only, as pbrt reads them (`grid<float>()`). A grid is read dense over its active box with
  `getValue`'s values (inactive voxels and tiles included) from its root, internal and leaf nodes; index → world is its
  map. Past 2²⁷ voxels or 2048 a side a value is the mean of f³ voxels, read so (OpenVDB grids are read the same way):
  the packer would halve it anyway. A constant tile then adds its share to each coarse voxel it covers, so a large
  pruned interior costs as many steps as coarse voxels (OpenVDB.js still adds tiles voxel by voxel). On pbrt-v4-scenes' `explosion` (two grids, 4.5M active voxels each, 161 × 364 ×
  153): every one of ~37k sampled voxels equals nanovdb's own reader (a C++ dump; `make.cpp` beside the test fixture
  makes it), world-space trilinear lookups within 6e-5; each grid reads in ~150 ms.
- **Inputs**: extinction σa + σs (× `scale`), one number a point, so its luminance where the channels differ
  (`approximated`); the albedo σs over it, per channel; `g`. Emission is pbrt's σa × Le (`emissionFromAbsorption`), Le
  as the ramp: `Lescale` × pbrt's blackbody peaking at 1 (`peakBlackbodyRGB`, as the film reads it, not scaled to
  luminance 1) at ( temperature − `temperatureoffset` / `temperaturecutoff` ) × `temperaturescale`, none to 100 K. pbrt's
  film integrates the colour-matching functions × L without dividing by ∫ȳ (film.h, `ToSensorRGB`): a blackbody at peak
  1 reads ~100, which files' `Lescale` is set against. The emission grid is resampled onto the density's box, never
  grown over its own: σa × Le is zero where there is no density (a pyro file's temperature often fills its domain). A
  `uniformgrid` voxel i sits at p0 + ( i + ½ ) / n × ( p1 − p0 ); its `Le` spectrum takes the `Lescale` grid, and
  without one pbrt's default, a 1³ grid read trilinearly against zeros outside: 1 at the centre, ⅛ at the corners
  (`tentField`). A temperature there drops `Lescale` (one grid carries the temperature; reported approximated).
- **Clipped to the shape**: pbrt's medium is only inside its shape, and the explosion's sphere cuts the smoke's top
  off. Voxels outside are cleared (`_clipToShapes`): each column of voxels is inside between alternate crossings of
  the shapes' triangles, those with the medium outside (`"" "smoke"`) carving holes; where every shape has it outside
  (a camera in the smoke), it is everywhere in the grid but inside them. A column crossed an odd number of
  times (a crack) is clipped as its nearest decided neighbour within two columns; past 1 % of columns the shapes are
  not closed (a disk) and nothing is clipped, nor where a shape builds no surface; each with a warning.
- **Only where nothing but `interface` bounds it**: volumes are traced outside glass and subsurface media, so a medium
  inside glass (or any surface) stays that surface's, left clear as before; and only directly placed shapes count, not
  an object instance's.
- The steps give the page a turn (`_tick`). A scene with a volume is not stored as a graph (the codec has no volume; it
  refuses the scene rather than drop it).

Measured against a pbrt-v4 build (260 × 360, 1024 spp, firefly clamp off): with a
plain sky and a diffuse floor the sky matches to 0.1 %, the smoke and floor to 0–1 %, the fire 4.5–5.8 % bright,
2.2–3.9 % at `maxBounces` 4 — pbrt adds a medium's emission at depth < maxdepth, one segment fewer than a surface's;
pbrt's own seed-to-seed noise there is 0.5 %. The scene as written differs more for reasons outside the volume: its sky
EXR is ACES2065-1 (its `chromaticities`), its floor `coateddiffuse`, its film a Nikon D850 sensor; the engine's default
firefly clamp (3) takes the fire core to 0.73.

## Sequences

A run of numbered files (`fire_0001.vdb` …) plays as one thing on the timeline. The pieces are generic, so other
kinds of frames can use them:

- **`loaders/FrameSequence.js`**: `frameRuns( paths )` groups numbered files (folder, the name before the number,
  extension; two or more), named for what precedes the number. `FrameSequence` holds each frame's reader and a
  `decode`; `seek( time )` hands back the frame that time falls on, decoding it if needed and the next two ahead, one
  decode at a time. A seek a newer one overtakes hands back null, so playback that cannot keep up skips frames. A frame
  handed out is its owner's; frames decoded ahead and never shown are released.
- **Owners apply**: a `Volume` with a `sequence` takes a frame through `setFrame( { grid, emission } )`. The renderer's
  `seekSequences( time )` (`SceneLoading.js`) seeks every sequence, puts what changed on the GPU one update at a time,
  and restarts the render; `sequences` lists them.
- **In place on the GPU**: a sequence volume keeps a slot in the atlas `reserve` voxels a side — its first frame's a
  quarter larger, kept within the texture's side — and its majorant cell size with it. A frame that fits is written into
  the slot (`packVolumeFrame`, `updateVolumeFrames`: its voxels with the zero ring, its majorants), the header
  rewritten. A frame past the slot grows it a quarter more and packs everything again, also without a rebuild: keyed on
  the atlas itself, the kernels were rebuilt, twice where a frame ran during the upload (no atlas between), and
  EmberGen's fire showed 54 of its 101 frames on its first play. Frames are never halved by the packer: they are read at
  most 2²⁶ voxels and 2046 a side, coarser for the rest of the run once one needed it, so resolution does not flicker.
- **VDB frames** (`loaders/OpenVDBSequence.js`, its worker `OpenVDBWorker.js`): the first frame is read at load, the
  grids picked by its names; the rest in a worker, kept 2 s after its last frame. Five frames (first, last, three
  between) are opened at load for their recorded active boxes and hottest voxel (`sampleExtent`): the union sizes the
  slot (× 1.1), the resolution every frame is read at and `volume.extent`, which the model bounds and so the camera
  take; the hottest voxel sets the temperature scale. A run may start empty (EmberGen's frame 0): it then opens on its
  first frame holding anything, read in order up to the first sampled frame recording a box (`shown`, so the Anim tab's
  Frame slider shows it; playing and the video still start at 0); with none, one voxel of nothing. Without the samples a
  growing fire was framed on its first puff, read finer at first and coarser later, and its slot grew mid-play. They can
  miss a brief flare (EmberGen's fire is tallest at frames 86–90, 155 voxels against the samples' 137): the slot then
  grows once. `vdbFormat.parseSequence` makes it a format any archive or folder can hold: `ArchiveImporter` loads a zip,
  tar or folder whose models are one numbered run of a format with `parseSequence` that way (and skips the part prompt
  for it), `AssetLoader.loadModelSequence` handing it over as a model.
- **Timeline** (viewer): `TimelineManager` folds the scene's sequences into `duration` and `animates` and seeks them on
  every `seek`; `settled()` resolves once the frames show, which the video export awaits before accumulating. Playing a
  sequence alone leaves the camera controls free. The Anim tab lists each with its frame count, Frame Rate and a Frame
  slider.

Measured (Node on Dawn, M-series): the Moana ocean file as a three-frame sequence loads in 1.5 s; each later frame
decodes in 1.25 s in the worker and swaps in with 80–100 ms of main thread (half floats, majorants, a 34 MB upload). The
24-frame Mantaflow fire (48³ domain) plays live in the app at its 24 fps, skipping a few frames at the start.
EmberGen's free `Fire_01` (101 frames, temperature and flames in half floats, no density), in Node on Dawn: loads in
0.12 s, each later frame swaps in 30–56 ms, one kernel build for the whole run. In the app (Chrome, from a zip): opens
in 0.26 s on frame 1, its first play shows all 101 frames at 24 fps, the slot growing once at frame 86 with no rebuild.

## Checks and measurements

- GPU (`tests/gpu/volume.test.js`): transmittance and free flight (both the collision rate and its distribution) in a
  constant grid and in a varying one under a turned, scaled object, against Simpson's rule over the same trilinear
  field on the CPU, 0.01 of 65,536 draws a ray; the emission integral likewise. `volumeRender.test.js`: a white
  furnace through the whole engine, e^(−τ) through a black block, an emission-only block, hiding.
- Bench (blessed, bit-identical on rerun): `volume-furnace` 0.99982 of the sky (0.018 % from energy conserving),
  `volume-cloud`, `volume-fire`, `volume-lamps` (spot, sized point light, one-sided panel, fog). The fog scenes still
  match their goldens (≤ 0.00025 RMSE).
- `bench:ab` against main, unchanged within each scene's floor: spheres-gradient −0.4 %, cornell-emissive +0.2 %,
  glass-tinted-light +1.3 % (floor ±0.7, one noisy round), fog-shafts +0.9 % (floor ±1.0), fog-glow −0.6 %.
- Node on Dawn (M-series, 480 × 320): a 128-voxel cloud under the physical sky at 32 bounces 10.5 ms a sample, a smoke
  column 5.8, the Mantaflow fire 5.2. Safari's 8 KB of function variables holds with a glowing volume and fog compiled
  in (`functionVariables.test.js`).
- Denoisers: OIDN reads volumes well (0.31 of raw's error at 1 spp on the furnace); NRD's guides come from the surfaces
  behind the smoke, so it helps little (0.88) and at 1 spp on `volume-lamps` made it 3.6 % worse than no denoise.
  The volume scenes are not in the denoise gate.
