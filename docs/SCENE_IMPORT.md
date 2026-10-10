# Scene import: folders, archives, pbrt and USD

## Loading a folder
`loadFile( { files } )` loads a folder of files as the same folder zipped would load — `files` a folder picker's FileList
(paths from `webkitRelativePath`) or `{ path, file }` pairs. `localFolder()` (`Processor/archiveFormats.js`, core)
normalises it (sorted, hidden files and folders out, `name` the shared top folder, `flat` for loose files);
`ArchiveImporter.loadFolder` opens it with `openFolder()` (`ArchiveReader.js`, the shape of `openTar` / `openZip`) and
goes through the archive path (`_loadSource`), so pbrt scenes, the part prompt (`error.file` is the folder) and glTF /
OBJ resolution all apply. Every non-pbrt archive entry is now a lazy Blob (`slice`), read only when a loader asks
(`asBlob` / `textOf` / `bytesOf` there): a folder's unrelated files are never read. `sceneSource` is `local-folder`
with `folderIdentity()` (path, size, date of every file, no reads). App: `lib/folders.js` reads drops (entries and,
on Chrome, `FileSystemHandle`s), picks folders (`showDirectoryPicker`, else a `webkitdirectory` input) and keeps
handles in IndexedDB (`RayzeeFolders`) under the scene source's key, so a session or a resumed render reopens the
folder itself (`SessionDialog` asks only when access lapsed); `.rayzee` projects embed a folder under `sources/folder/`.

## Loading part of a scene archive
Archives and pbrt are an add-on (`rayzee/addons/archives`): the code lives in `Processor/ArchiveImporter.js`, which
the loader reaches only through `assetLoader.setArchiveImporter( new ArchiveImporter( assetLoader ) )`, or
`setArchiveImporterLoader( load, ARCHIVE_FORMATS )` (`ARCHIVE_FORMATS` is exported from `rayzee/core` for that), which loads it for the first archive read — `PathTracerApp` does
that, so archive reading and pbrt are a chunk of their own. The formats come from `Processor/archiveFormats.js`, so the
loader recognises an archive before the code that reads it exists. Without it a `.zip`/`.tar`/`.tgz` is not a supported format, and the error names the
add-on. The importer reads the loader's members through `this.loader`.
A pbrt scene archive (.tar / .tar.gz / .zip) is usually a root `.pbrt` that `Include`s one
subtree per element, and the whole thing rarely fits: Moana is 29 GB unpacked.
- `assetLoader.inspectArchive( file )` lists the elements without retaining any of them.
- `loadFile( file, { element } )` takes one element path or **an array of them** to load
  together. Everything above them — the root scene file, the material library, an ancestor's
  `textures` folder — comes along, and an `Include` pointing at an element that was left out
  only warns, which is what makes a partial load work.
- Past `ARCHIVE_ELEMENT_PROMPT_BYTES` (4 GB unpacked) a multi-element archive throws
  `ARCHIVE_NEEDS_ELEMENT` carrying `elements`, rather than taking all of it. The app turns that
  into a multi-select dialog. ⚠️ This applies to the **seekable .tar** path too, where indexing
  is free but *parsing* everything is what runs the tab out of memory. Selecting every element
  is a valid answer and loads the whole scene; `promptBytes` overrides the line.
- `maxTriangles` defaults to 45M and `maxPlacements` to 6M. Past either, placements are skipped
  and the build reports itself truncated. 45M is the highest rung measured to survive without
  the memory spill. Unless `memorySpill` is false (and with storage), `loadFile` defaults them to 120M / 60M
  (`SPILL_TRIANGLE_BUDGET`), and the preflight prices a streamed build by its larger phase (`spillingPeakBytes`:
  extraction holds geometry + matrix lists + resident records, the TLAS phase lists + table + tree): the whole USD
  island, 111.6M / 51.0M, estimates 8.6 GB (2026-10-09; the hard line is 9.2 GB) and loads (see USD scenes below). 89M ran out of memory in the pbrt parse,
  measured before the parse-memory work and not since.
- **Fewer stored triangles.** Curves are strips with adaptive segments (`curveTolerance`: how far
  a segment may stray, × the half-width; default 0.05, 0 = the old uniform strip bit for bit). A
  file included again under the same material, with no side effects, is placed as an instance of
  its first reading (`instanceIncludes`). Templates placed at identical transforms become one, and
  a template's small non-.ply shapes merge in its own space. ⚠️ Keep that grouping: without it each
  Moana Pandanus tree was ten overlapping instances and rendered 60 % slower. Anything that changes
  what the same files build bumps `PBRT_BUILD_REVISION`, or a stored graph of the old build is reused.
- **Parse memory.** The entry is picked from each `.pbrt`'s first 4 MB (`listEntryPathsFrom`:
  WorldBegin may only follow the scene-wide options); reading every file whole was 15 GB and 40 s
  for a 17-part Moana archive. Heads naming no scene, or several, fall back to full reads. A dropped
  ArrayBuffer is freed only at a major GC, which a parse reaches late, so scene text, grown arrays
  (`PBRT/buffers.js`) and merged shapes' arrays are let go explicitly with
  `ArrayBuffer.prototype.transfer`; placement lists are trimmed after the parse and freed once placed.
  First-time 80M, like for like: parse 96 → 62 s, page after the build 11.0 → 8.2 GB, output
  identical. ⚠️ A template with moving placements keeps its shapes (`_keepShapes`): those
  placements build them again after the static ones. ⚠️ A `.ply` is decoded once per file name and
  shared by every shape naming it, so a merged shape frees it only as its last direct user
  (`_lastPlyUse`), never while a template or an unmerged shape holds it: Zero-Day names one file from
  up to 320 shapes, and freeing on the first merge failed the load with a detached ArrayBuffer.
- **Lights.** `infinite` becomes the environment; a scene without one renders with the environment off
  (`sceneMetadata.environment.enabled === false`, applied at the replace-load seam, and what it replaced comes
  back with the next model unless someone changed it). `distant`, `point` and `spot` become three.js lamps in
  the engine's units (pbrt's L / I × `scale`, `power` and `illuminance` honoured; flagged as converted so the
  photometric conversion skips them; stored in the scene cache). A non-RGB light spectrum (blackbody, named) is
  brought to luminance 1 as pbrt does. `.pfm` images load (`Processor/PBRT/PFM.js`). An area light is one-sided
  unless `"bool twosided"`: `FrontSide`, its triangles rewound to face the vertex normals, or turned over by
  ReverseOrientation where it has none (`_facingEmission`). An area light's `power` scales its radiance to that power
  over the shape's area (a quadric's in its own space, a mesh's in the scene's, as pbrt measures them). A shape of
  `"float alpha" 0` is dropped: pbrt never hits it and an area light on it emits nothing (kroken's 90-unit "sun" sphere).
  Any other `alpha` is the engine's blend mode — a ray passes with chance 1 − α, shadow rays too — on a material per
  material and alpha (`_withAlpha`): a constant becomes `opacity`, a texture the colour map's alpha channel (the map's
  own image when it is the same file, its alpha decoded as pbrt decodes every 8-bit channel; baked otherwise). Bistro's
  leaves and curtains had drawn as solid cards.
- **Shapes and cameras.** `sphere`, `disk` and `cylinder` are pbrt's quadrics (`quadric()`): partial by `zmin`/`zmax`/
  `phimax`, in pbrt's uv, facing ∂p/∂u × ∂p/∂v. A `bilinearmesh` patch's corners are p00, p10, p01, p11 (not a ring),
  one patch of four points needs no indices, and without uvs a patch takes its own — watercolor's floor spots had been
  dropped. A camera's `lensradius`/`focaldistance` become its own effects (`userData.__rayzeeEffects`, applied when it is
  chosen): the same aperture radius in both DOF modes, focused by hand. `Integrator` maxdepth, `Sampler` pixelsamples
  and the Film's resolution are `sceneMetadata.render` — reported, not applied (glTF extras may carry it too).
- **Templates.** A shape inside `ObjectBegin` keeps its whole transform and a placement's goes on top, as pbrt does —
  never relative to the transform at ObjectBegin. kroken defines its cushions, blanket and rug under a `Transform` and
  places them at `Identity`; the relative reading put all of them at the world origin.
- **Materials.** `coatedconductor` is a metal under a clear coat (pbrt's roughnesses default to 0); a textured
  roughness becomes a roughness map with pbrt's remap baked in (`applyRoughness`; the clear coat's too); `subsurface` is
  the engine's random walk (`applySubsurface`: albedo σs / σt, mean free path 1 / σt; pbrt's named media, `sigma_a`/
  `sigma_s`, or a `reflectance` inverted through the dipole at `mfp`); `normalmap` loads linear, a float image converted to 8 bits (`eightBit`: a material
  map takes only 8-bit texels). Glass whose `MediumInterface` interior is a homogeneous medium gets Beer–Lambert
  attenuation from σa + σs (no scattering inside). `diffusetransmission` is the engine's diffuse transmission lobe.
  Textures the engine has no node for are baked on the CPU (`PBRTTextureBake.js`) into 8-bit sRGB DataTextures in
  their image's uv mapping: `mix`, `scale` by a texture, an imagemap's `scale` above 1 or `invert`, and a `mix`
  material with a textured amount (its colours baked, everything else weighed by the amount's mean). Each colour
  input is clamped to [0, 1] before mixing, as pbrt clamps an albedo. A float texture reads an image's alpha where it has
  one, else the mean of its colour, as pbrt does. 2D `checkerboard` and `bilerp` are baked too (`_proceduralTexture`).
  An imagemap's `uscale`/`vscale`/`udelta`/`vdelta` become the texture's repeat/offset; `planar`/`spherical`/
  `cylindrical` mappings, `dots` and `directionmix` are not supported. ⚠️ `material.clone()` drops the engine's own
  properties (diffuse transmission, subsurface): use `cloneMaterial`. Bump `PBRT_BUILD_REVISION` with any of this, or a
  stored graph of the old build comes back.
- **Formats.** `.tar` is indexed by seeking between headers (`indexTarHeaders`, 1 MB windows) and
  read in place. `.tar.gz` / `.tgz` is unpacked once into `archives/` while it is indexed
  (`unpackTarGz`: DecompressionStream → OPFS, 0 GB held; 1.3 GB gz in 6.4 s) and reopened from
  there in 0.15 s. With parts chosen only they are written (`filter`/`part`; a whole unpack still serves any part):
  Moana unpacks to 31 GB, a profile's quota was 11 GB, and the in-memory fallback's 1.5 GB budget silently dropped
  4,573 of isCoral's files — `objects.pbrt` among them, so every placement lost its template and nothing drew. `.zip` is read through its central directory (`openZip` / `readZipDirectory`,
  ZIP64 and UTF-8/latin1 names) — never unzipped whole; `slice( path )` of a stored entry is a
  zero-copy Blob. A `.zip` that is really a gzip (island-pbrtV4) is detected by magic. Archive
  URLs load through the download cache (`loadFile( url )`).

## USD scenes (`Processor/USD/`)
A folder or archive whose main model is a USD layer (`ArchiveImporter._mainModelPath`), and a loose `.usd`/`.usda`/`.usdc`
(`AssetLoader.loadModelFromFile`), load through the USD importer in the archives add-on; a `.usdz` stays with three's
USDLoader. Each layer is read only when composition reaches it (`USDFiles` over the folder's or archive's entries).
- **Layers** (`USDLayer.js`): one in-memory shape for both formats. Text through `USDText.js`; crate through `Crate`, our own
  reader of OpenUSD's format (0.4.0 on). ⚠️ three's USDCParser was not usable: it decodes paths with the wrong count from 0.8.0
  (every name after the root shifted), misreads arrays before 0.5.0 (a rank precedes the size), and drops payloads, list
  ops' lists and dictionaries; its USDAParser misreads `prepend payload` and nested `over` prims. Crate values decode on
  first read (`PropSpec.value`): Moana's 3.1 GB of crate files decode whole in 2.8 s, most never read at all.
- **Composition** (`USDStage.js`): sublayers, references, payloads, inherits, specializes and variant sets, per prim on
  demand, as a tree of nodes in strength order (a prim index). Variants are evaluated after the other arcs, so a stronger
  site selects a set a referenced layer defines (Moana's `over "geometry" ( variants = … )` per copy). Each node maps the
  paths its layer authors into the stage's namespace, so bindings and connections land on composed prims.
  `instanceKey()` leaves out the sites that only hold a copy's own opinions — with them every Moana tree was its own
  prototype. `release()` drops composed prims and non-root layers after each child of a top prim (one Moana element).
- **Translation** (`USDScene.js`) writes the pbrt builder's IR, so USD gets its instancing, budgets, merging and curves:
  meshes (fan triangulation, `leftHanded` reversed, faceVarying primvars per corner, GeomSubset materials), BasisCurves
  (`curves` shape → `tessellateCurves`, per-vertex widths, ribbons oriented by normals), gprims, instanceable prims and
  point instancers as templates (nested ones multiplied out; placements stop at the budget). ⚠️ The builder frees a shape's
  arrays after merging it, so an array is handed over once (`own()`). Materials: PxrDisneyBsdf (Burley 2015 as pbrt-v3
  reads it: clear coat ×0.25, thin diffTrans ÷2), PxrSurface's main lobes, UsdPreviewSurface with UsdUVTexture; connections
  followed through PxrColorCorrect's gamma, PxrBlend (bottom input), primvar readers and node graphs. Ptex is not read: a
  Ptex input becomes the mesh's mean displayColor, where Moana bakes its Ptex, on an 8-bit grid so meshes share materials
  (the engine has no vertex colour). Cameras from apertures (vertical FOV), Rect/Disk/Sphere/Distant lights in the engine's
  units, and the first dome light that lights the scene as the environment: USD's lat-long centre faces +Z (OpenEXR), the
  engine's +X, so `environmentRotation` = 90° − the dome's yaw. Light linking is ignored.
- **Parts** (`listUSDParts`): past `USD_ELEMENT_PROMPT_BYTES` (1 GB of layers) the importer throws `ARCHIVE_NEEDS_ELEMENT` with
  the prims under the root's top prims that bring in sibling directories (Moana's 20 `elements/<name>`). `elementFilter`
  leaves out only the unchosen siblings, so `usd/materials/` comes along; references into them are counted, not warned.
- **Budgets** (`USDSceneReader.fit`): a counting pass first (no positions decoded) prices meshes, curves and placements —
  a copy costs one placement per distinct relative transform among its template's shapes, as the builder places the
  shapes at one transform by one shared matrix list (one TLAS entry a copy, see Grouped placements in `CLAUDE.md`). Past the budgets, curve
  sets and point instancers are thinned by `fill()`: small sets kept whole, the rest sharing what is left (fronds stay,
  grass and ground cover thin), each pick a fixed hash under a quota, so loads repeat and never overshoot. Meshes are never
  thinned: past the triangle budget on their own, what is read last is cut. The note lands in `ISSUE_CODES.SCENE_MEMORY_BUDGET`
  and the app's "Loaded" toast. A mesh read again under another prim of one part (same specs) shares its geometry
  (`geometryKey`, kept whole by the builder); curves without normals are one ribbon. ⚠️ Before the counting pass the
  budget went first come, first served, and selecting every part dropped all after the first four whole.
- **Measured** (Moana USD v2.1, whole island): 61.6M mesh triangles, 49M of curves, 39.9M copies (50.99M placements and
  TLAS entries before grouping; the counts below are from then, when a copy cost one placement per shape). 45M / 6M: a
  quarter of the meshes cut, no curves. 60M / 8M: 1.1M of mesh cut. 80M / 8M: everything, 36 % of curves,
  13 % of scattered copies — in Chrome with memory spill, 2 min 50 s to the first frame, 10.8 GB, renders the hero shot.
  **All of it** (2026-10-08, 120M / 60M, memory spill): 111.6M triangles, 51.0M placements → 39.9M entries → 10M copy
  clusters; Chrome on a 24 GB M-series loads it in 304 s (tab peak ~13 GB, GPU buffers 13.1 GB, GPU process ~16 GB) and
  renders the hero shot, swapping ~25 GB beside the other apps open. Node with a disk-backed storage: same, ~5 min.
  With the after-load spill, paced uploads and the bit-trail placeholder (same day): 265–270 s, tab peak ~12 GB and
  3.6 GB at rest, GPU buffers 12.7 GB, GPU process ~14 GB (13.5 GB at rest).
  With no flag (`memorySpill: 'auto'`, 2026-10-09) it spills on its own: 279 s on a production build, sky 7154 wide.
  Through the app (File → Open Folder, all parts): ~5 fps at 512² afterwards. ⚠️ The outliner drew a row per shape
  (1.36M DOM nodes, ~1 fps): it now mounts children 200 at a time. Chrome's `usedJSHeapSize` (5.4 GB here) counts the
  engine's ArrayBuffers too — matrix lists, table, TLAS, order maps, sky — not only JS objects.
