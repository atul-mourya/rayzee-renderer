# Scene import: folders, archives, pbrt, USD and Blender glTF lights

## Loading a folder
`loadFile( { files } )` loads a folder of files as the same folder zipped would load — `files` a folder picker's FileList
(paths from `webkitRelativePath`) or `{ path, file }` pairs. `localFolder()` (`loaders/ArchiveFormats.js`, core)
normalises it (sorted, hidden files and folders out, `name` the shared top folder, `flat` for loose files);
`ArchiveImporter.loadFolder` opens it with `openFolder()` (`ArchiveReader.js`, the shape of `openTar` / `openZip`) and
goes through the archive path (`_loadSource`), so pbrt scenes, the part prompt (`error.file` is the folder) and glTF /
OBJ resolution all apply. Every non-pbrt archive entry is now a lazy Blob (`slice`), read only when a loader asks
(`asBlob` / `textOf` / `bytesOf` there): a folder's unrelated files are never read. `sceneSource` is `local-folder`
with `folderIdentity()` (path, size, date of every file, no reads). App: `lib/folders.js` reads drops (entries and,
on Chrome, `FileSystemHandle`s), picks folders (`showDirectoryPicker`, else a `webkitdirectory` input) and keeps
handles in IndexedDB (`RayzeeFolders`) under the scene source's key, so a session or a resumed render reopens the
folder itself (`SessionDialog` asks only when access lapsed); `.rayzee` projects embed a folder under `sources/folder/`.

## Tar, OBJ + MTL, FBX and Collada
- **Tar** (`ArchiveReader.js`): ustar, GNU long names, pax `path` / `size`, contiguous files (`7`) and GNU sparse files
  (old `S` with its extension blocks, pax 0.0 / 0.1 / 1.0). A sparse entry lists its full size and `sparse`, its stored
  [ offset, length ] regions; every read fills the gaps with zeros. One whose map cannot be read or does not fit is left
  out. All 1,574 tars on the dev Mac that Python's `tarfile` reads list and read the same, five ways (2026-11-08).
- **OBJ + MTL textures** resolve as written, beside the OBJ and the MTL (`..` and `\` included), in `textures/`,
  `texture/`, `materials/`, then by **whole** file name anywhere — never part of one: a missing map is no texture, not
  a neighbour's. MTLLoader's base path is `''`: it joins without a slash.
- **Camera shape**: FBXLoader gives a camera naming no `AspectWidth` / `AspectHeight` the window's (and crashes in Node);
  `fbxFormat` lends it FBX's default 320 × 200, a hair off, during the synchronous parse, so only a named shape becomes
  `userData.aspect`. `colladaFormat` wraps `ColladaComposer.buildCamera` for its parse (clones carry `userData`):
  `aspect_ratio`, else `xfov` / `yfov` or `xmag` / `ymag`; with `xfov` and no `yfov` (Blender) it sets the view three
  leaves at 50°.
- **Collada repairs** (`repairCollada`, for the parse only): ColladaLoader threw on an `<image>` with no `<init_from>`
  and on an empty `<effect>` (SketchUp-style exports; `~/Downloads/Burj Khalifa.dae` is a Livspace room), and on a
  `<transparent>` holding a `<float>` (three's own old ColladaExporter, beside `<transparency>` the opacity); and it
  painted magenta (its fallback) a primitive whose material symbol the `<bind_material>` names otherwise ("default"
  against "mat0"). Now: no image (a texture naming it is none), a plain Lambert, the colour (f, f, f, f) — three's
  export comes back at its opacity — and the one material bound, when there is one (with more, the fallback stays).
  4 of the 12 local `.dae` files failed; all load (2026-11-08). ⚠️ Collada needs a `DOMParser`: in Node it fails.

## Asset kits
`findAndLoadModelFromZip` takes an archive with no main file whose shallowest models sit in two or more folders as a
kit (`kitPaths`): each object once (`_LOD<n>` stripped, the lowest kept; glTF first across formats), all parsed
without the engine (`_parseZipModel`), set out by `layOut` (rows, largest first, a quarter of the median width apart,
on y = 0) and handed over as one group. A single non-glTF, non-OBJ model goes through the same `_loadZipModels`.
Untextured materials take their folder's texture set (`textureSet`, by the name's last words, the set sharing most of
the model's name); an opacity map is baked into the colour map's alpha (`_withOpacity`), as the engine reads alpha
there only. Megascans normal maps are OpenGL's (measured against their height maps: +0.67–0.74 correlation).
FBXLoader records `unitScaleFactor` (centimetres a unit) without applying it; `fbxFormat` scales the root to metres.

## Loading part of a scene archive
Archives and pbrt are an add-on (`rayzee/addons/archives`): the code lives in `addons/archives/ArchiveImporter.js`, which
the loader reaches only through `assetLoader.setArchiveImporter( new ArchiveImporter( assetLoader ) )`, or
`setArchiveImporterLoader( load, ARCHIVE_FORMATS )` (`ARCHIVE_FORMATS` is exported from `rayzee/core` for that), which loads it for the first archive read — `PathTracerApp` does
that, so archive reading and pbrt are a chunk of their own. The formats come from `loaders/ArchiveFormats.js`, so the
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
  `tests/unit/addons/archives/pbrt/buildRevision.test.js` hashes every `.js` under `pbrt/` and `SceneGraphCodec.js`
  (comment lines, blank lines and spacing aside; a comment at the end of a code line counts) and fails until the
  recorded `{ revision, format, code }` matches, so a bump of `PBRT_BUILD_REVISION` or `SCENE_GRAPH_FORMAT` is decided
  rather than remembered. Releases change the key anyway (the package version is in it); this guards graphs stored
  between them. `npm test` runs in the release workflow, so an unrecorded change stops a release.
- **Parse memory.** The entry is picked from each `.pbrt`'s first 4 MB (`listEntryPathsFrom`:
  WorldBegin may only follow the scene-wide options); reading every file whole was 15 GB and 40 s
  for a 17-part Moana archive. Heads naming no scene, or several, fall back to full reads. A dropped
  ArrayBuffer is freed only at a major GC, which a parse reaches late, so scene text, grown arrays
  (`addons/archives/pbrt/ArrayMemory.js`) and merged shapes' arrays are let go explicitly with
  `ArrayBuffer.prototype.transfer`; placement lists are trimmed after the parse and freed once placed.
  First-time 80M, like for like: parse 96 → 62 s, page after the build 11.0 → 8.2 GB, output
  identical. ⚠️ A template with moving placements keeps its shapes (`_keepShapes`): those
  placements build them again after the static ones. ⚠️ A `.ply` is decoded once per file name and
  shared by every shape naming it, so a merged shape frees it only as its last direct user
  (`_lastPlyUse`), never while a template or an unmerged shape holds it: Zero-Day names one file from
  up to 320 shapes, and freeing on the first merge failed the load with a detached ArrayBuffer.
  Binary `.ply` files of the shape pbrt exporters write (vertex x y z, optional normal and uv, float or double; face
  `vertex_indices`, other face properties skipped) are read by `pbrt/BinaryPLY.js` straight into typed arrays — the same
  attributes, classes, index and bounds as three's PLYLoader, byte for byte on every mesh of six local scenes — and
  anything else (ASCII, colours, texcoord lists, other elements, the `__MACOSX` copies) by PLYLoader. Watercolor's
  803 meshes: 8.2 s of PLYLoader, its load 80 → 72 s.
- **Lights.** `infinite` becomes the environment — pbrt-v4's equal-area octahedral square resampled once into the
  engine's lat-long map (`EqualAreaOctahedral.js`, 4 or 16 reads a pixel, each read's angles tabulated per row and
  column: a 4096-wide sky 2.6 → 2.0 s, the same floats); a scene without one renders with the environment off
  (`sceneMetadata.environment.enabled === false`, applied at the replace-load seam, and what it replaced comes back with
  the next model unless someone changed it). `distant`, `point` and `spot` become three.js lamps in the engine's units
  (pbrt's L / I × `scale`, `power` and `illuminance` honoured; flagged as converted so the photometric conversion skips
  them; stored in the scene cache). A non-RGB light spectrum (blackbody, named, sampled) is brought to luminance 1 as
  pbrt does, in pbrt's colour: a blackbody (Planck's law) or sampled spectrum summed every 1 nm against CIE 1931
  (`emissionRGB`; blackbodies within 0.002 of pbrt-v4's own render from 1000 to 40000 K, a negative channel clipped to 0
  as the engine cannot emit one), `stdillum-A` a 2856 K blackbody, `stdillum-D65` white. pbrt's other illuminant tables
  (D50, F1–F12) are not kept: white, reported. `.pfm` images load (`addons/archives/pbrt/PFM.js`). An area light is
  one-sided unless `"bool twosided"`: a surface on both faces (`DoubleSide`) emitting from its front (`emissiveSide:
  FrontSide`), so from behind it is dark, never a hole, as in pbrt; its triangles rewound to face the vertex normals, or
  turned over by ReverseOrientation where it has none (`_facingEmission`). An area light's `power` scales its radiance
  to that power over the shape's area (a quadric's in its own space, a mesh's in the scene's, as pbrt measures them). A
  shape of `"float alpha" 0` is dropped: pbrt never hits it and an area light on it emits nothing (kroken's 90-unit
  "sun" sphere). Any other `alpha` is the engine's blend mode — a ray passes with chance 1 − α, shadow rays too — on a
  material per material and alpha (`_withAlpha`): a constant becomes `opacity`, a texture the colour map's alpha channel
  (the map's own image when it is the same file, its alpha decoded as pbrt decodes every 8-bit channel; baked
  otherwise). Bistro's leaves and curtains had drawn as solid cards.
- **Shapes and cameras.** `sphere`, `disk` and `cylinder` are pbrt's quadrics (`quadric()`): partial by `zmin`/`zmax`/
  `phimax`, in pbrt's uv, facing ∂p/∂u × ∂p/∂v. A `bilinearmesh` patch's corners are p00, p10, p01, p11 (not a ring),
  one patch of four points needs no indices, and without uvs a patch takes its own — watercolor's floor spots had been
  dropped. A camera's `lensradius`/`focaldistance` become its own effects (`userData.__rayzeeEffects`, applied when it is
  chosen): the same aperture radius in both DOF modes, focused by hand. The `Integrator` (as the engine's `integrator`:
  bdpt → bidirectional, sppm → vcm), its maxdepth and `regularize` (`pathRegularization`; path, volpath, bdpt and mlt
  take it), sppm's `radius` (`mergeRadius`, scene units), `Sampler` pixelsamples and the Film's resolution are
  `sceneMetadata.render` (glTF extras may carry it too), with `aspect` the picture's shape (`withSceneAspect`). The engine
  applies none of it; the app opens the scene at that shape with that integrator and path regularization, and shows the
  bounces and samples in Final Render. It leaves sppm's radius: see BIDIRECTIONAL.md, vertex merging's radius.
- **Defaults are pbrt-v4's** (`pbrt/defaults.test.js`): each material, light, shape, camera and baked texture read bare
  must build as with every parameter written at the default its pbrt-v4 `Create()` gives (materials.cpp, lights.cpp,
  shapes.cpp, cameras.cpp, textures.cpp). Found 2026-11-08: a `constant` texture with no `value` was dropped (pbrt: 1 —
  a bare constant roughness rendered a mirror), and one given as a named, sampled or blackbody spectrum read as NaN.
  The coat `eta` of coateddiffuse / coatedconductor is approximated, so it cannot show there.
- **Named transforms** are pbrt-v4's: `ConcatTransform` post-multiplies, `TransformBegin`/`TransformEnd` are read as
  `AttributeBegin`/`AttributeEnd` (pbrt-v4's parser does; the transform alone was pbrt-v3's — the classroom, the one
  local scene with them, parses the same), `CoordinateSystem` names the CTM (both ends), and pbrt's own "camera" (world
  from camera, at `Camera`) and "world" (at `WorldBegin`) are named too; an unknown `CoordSysTransform` warns once and
  leaves the CTM (both were silently ignored before 2026-11-08). `Import` reads as `Include` (pbrt keeps an imported
  file's named systems and transform to itself).
- **Attribute** is pbrt-v4's: `Attribute "shape"` (or `light`, `material`, `medium`, `texture`) sets defaults for the
  directives of that kind that follow in its attribute block (`AttributeEnd` takes them away); a directive's own
  parameter wins, then the latest `Attribute`, as pbrt's ParameterDictionary orders them; attributes set before
  `WorldBegin` carry in, as pbrt's do. A directive that leaves one unread is not faulted (pbrt's `mayBeUnused`); one no
  directive reads is reported once, as `Attribute <target>: name`. Each directive gets its own copy of an array (the
  builder frees a merged shape's arrays), and an include read under other attributes is read again, not reused
  (2026-11-09; attributes were dropped and reported unused before). Known gap: parameters are keyed by name, so an
  attribute of one type is shadowed by a directive's parameter of another (`texture alpha` by `float alpha`), where
  pbrt's typed lookups would take the attribute.
- **Templates.** A shape inside `ObjectBegin` keeps its whole transform and a placement's goes on top, as pbrt does —
  never relative to the transform at ObjectBegin. kroken defines its cushions, blanket and rug under a `Transform` and
  places them at `Identity`; the relative reading put all of them at the world origin.
- **Materials.** `coatedconductor` is a metal under a clear coat (pbrt's roughnesses default to 0); a textured
  roughness becomes a roughness map with pbrt's remap baked in (`applyRoughness`; the clear coat's too); `subsurface` is
  the engine's random walk (`applySubsurface`: albedo σs / σt, mean free path 1 / σt; pbrt's named media, `sigma_a`/
  `sigma_s`, or a `reflectance` inverted through the dipole at `mfp`); a sampled spectral `eta` (dielectric, subsurface)
  is read at 550 nm between its samples (`pEta`; pbrt traces it per wavelength; read as its first wavelength it gave
  crown's gems an IOR of 200); `normalmap` loads linear, a float image converted to 8 bits (`eightBit`: a material
  map takes only 8-bit texels). Every pbrt material has a relative IOR (`relativeIOR`, docs/design/SHADING.md), as pbrt
  reads eta. Glass whose `MediumInterface` interior is a homogeneous medium gets Beer–Lambert attenuation from σa + σs
  (no scattering inside). Glass with its medium outside only (Teapot (full)'s glass–tea wall, `"" "Tea"`) is turned
  over — normals negated, triangles rewound (`turnedOver`), eta inverted — so the medium is its inside and every
  crossing bends as before (`_shapeMedium`). A medium on both sides keeps the inside one; the same medium on both sides
  (a medium filling space) is not supported, reported once. `diffusetransmission` is the engine's diffuse transmission lobe,
  split at T's peak (brightest texel × tint × scale; `ctx.textureMaxRGB` scans the map's bytes, no bake layer). Each
  colour is its lobe's peak over its share × its map's brightest texel, so R and T are exact at every texel pbrt does
  not clamp while max R + max T ≤ 1; a mapped colour may pass 1, colour × map never does. A textured T is the
  diffuse transmission colour map only on the reflectance map's transform (the extension maps share it), else flat at
  its peak and reported approximated; flat too where the mesh has no uv, and in a `mix` (both read
  `userData.pbrtFlat`, the colours at their peaks). Under a shape's alpha it reads the colour map's copy carrying the
  alpha (one image, not two).
  `displacement` (pbrt-v4's bump map, a height in scene units) becomes a bump map with a `bumpDistance` (`_heightMap`):
  `scale` textures with a constant factor fold into the distance, sign included (contemporary-bathroom's floor is
  −0.05), and the image's range is stretched over the map's 8 bits, the distance taking it (a bump reads only height
  differences). Anything else is baked whole at distance 1. Bitterli's scenes carry their bump images unscaled:
  heights of up to one scene unit, as their files say.
  Textures the engine has no node for are baked on the CPU (`PBRTTextureBake.js`) into 8-bit sRGB DataTextures in
  their image's uv mapping: `mix`, `scale` by a texture, an imagemap's `scale` above 1 or `invert`, and a `mix`
  material with a textured amount (its colours baked, everything else weighed by the amount's mean). Each colour
  input is clamped to [0, 1] before mixing, as pbrt clamps an albedo. A float texture reads an image's alpha where it has
  one, else the mean of its colour, as pbrt does. 2D `checkerboard` and `bilerp` are baked too (`_proceduralTexture`).
  The baker is half the pbrt build on texture-heavy scenes, so its loops avoid per-texel work that changes nothing: at
  its own size the driving image is read at its texels (no bilinear blend, no wrap), sRGB bytes come from a table exact
  to `Math.round( 255 · linearToSRGB( v ) )` (`srgbByte`), layers read bytes through their table in plain loops, and
  float maps reuse their arrays. Every bake and layer of zero-day, crown, the bathroom, kitchen and veach-ajar hashed the
  same before and after; zero-day's `pbrtBuild` 8.54 → 4.08 s in Node, 7.18 → 3.24 s in Chrome (`bench:load --ab`).
  A one-channel map's bytes are worked out once a value and copied (`TexelMemo`, keyed by the float's bits: an 8-bit
  grey map holds at most 256 values, a colour image read as a float tens of thousands). Exporters define a texture per
  material even for one image: definitions reading a file the same way (encoding, scale, invert, uv mapping) share one
  layer (`_imageLayer`), and materials whose roughness reads the same layers and values share one bake and one texture,
  which the engine packs once (`_floatMap`'s `id`). zero-day: 23 roughness maps → 13, material textures on the GPU
  414 → 249 MB, `pbrtBuild` 3.99 → 1.84 s in Node and 2.94 → 1.72 s in Chrome; renders byte-identical.
  An imagemap's `uscale`/`vscale`/`udelta`/`vdelta` become the texture's repeat/offset. A `planar`/`spherical`/
  `cylindrical` mapping (pbrt-v4 `textures.h`; planar reads `v1`/`v2`/`udelta`/`vdelta`, the others nothing) is a uv set
  generated per shape from its world positions, taken into the space the texture was declared in (`generateUV`): a
  triangle across the seam gets copies of its vertices a turn on, a vertex on the axis its triangle's mean angle. The
  engine reads one uv set a triangle, so a surface takes its base colour's (else its first map's); a map in another set
  becomes its mean (a roughness) or is dropped, a bake input in another set its mean, each reported. A .ply shared by shapes mapped
  apart is stored once each, and pbrt maps each copy of a template where it stands, so those copies are meshes of their
  own up to 1M triangles in all (past it they share the first copy's uv, reported); a moving shape is mapped at its start.
  `dots` and `directionmix` are not supported. ⚠️ `material.clone()` drops the engine's own
  properties (diffuse transmission, subsurface): use `cloneMaterial`. Bump `PBRT_BUILD_REVISION` with any of this, or a
  stored graph of the old build comes back.
- **Parameters it does not honour.** As pbrt's `ReportUnused`: a parameter is used when it is looked up through
  `param()` (`PBRTParser.js`; the `p*` helpers and `resolveSpectrum` go through it), and `ParamUsage` counts, for each
  directive translated, the parameters nothing looked up and those a translator marks `approximated()` — a texture's
  mean where the engine takes one value, a spectrum as RGB, a default for a type it cannot read (a texture or spectrum
  `eta` through `pFloat`) — per `directive type: name`, with how many directives set it. Params stay plain objects, so
  the parse is unchanged. Shapes are accounted once their geometry is read; materials, textures, lights and media, read
  across the build, at its end; a directive never translated (an unreferenced material or texture) reports nothing, and
  each frame of a sequence counts its own Film. `loadPBRTScene` returns it as `parameters`; the importer records one
  `asset.parameters_ignored` warning (`detail.unused`, `detail.approximated`) and one console list, and keeps it with a
  stored scene, so a cached open reports it too. `Option "type name" value` is one parameter (its value had been read as
  a directive).
- **Formats.** `.tar` is indexed by seeking between headers (`indexTarHeaders`, 1 MB windows) and
  read in place. `.tar.gz` / `.tgz` is unpacked once into `archives/` while it is indexed
  (`unpackTarGz`: DecompressionStream → OPFS, 0 GB held; 1.3 GB gz in 6.4 s) and reopened from
  there in 0.15 s. With parts chosen only they are written (`filter`/`part`; a whole unpack still serves any part):
  Moana unpacks to 31 GB, a profile's quota was 11 GB, and the in-memory fallback's 1.5 GB budget silently dropped
  4,573 of isCoral's files — `objects.pbrt` among them, so every placement lost its template and nothing drew. `.zip` is read through its central directory (`openZip` / `readZipDirectory`,
  ZIP64 and UTF-8/latin1 names) — never unzipped whole; `slice( path )` of a stored entry is a
  zero-copy Blob. A `.zip` that is really a gzip (island-pbrtV4) is detected by magic. Archive
  URLs load through the download cache (`loadFile( url )`).

## USD scenes (`addons/archives/usd/`)
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
  (`curves` shape → `tessellateCurves`, per-vertex widths, ribbons oriented by normals), gprims (a Plane's `axis` is its
  normal; OpenUSD 24.05's `Cylinder_1` is a frustum, `Capsule_1` with unequal radii GeomUtil's shape: the side runs the
  spine from one radius to the other and each end is a sphere tangent to it, so it reaches past the end radius), instanceable prims and point instancers as templates (nested ones multiplied out; placements stop at the
  budget). Material bindings resolve as UsdShade's for the full purpose: a `material:binding:full` above beats a
  `material:binding` below, `bindMaterialAs = "strongerThanDescendants"` keeps a binding below it, and a point
  instancer's prototype takes its own parents' bindings, not the instancer's (collection bindings are not read; a
  binding with several targets is taken by its first, where OpenUSD ignores it). Transforms, primvars per corner, point instancers, gprim bounds and bindings are held to
  OpenUSD's own answers (`usdOpenUSDParity.test.js`, from Blender's `pxr`). ⚠️ The builder frees a shape's
  arrays after merging it, so an array is handed over once (`own()`). Materials: PxrDisneyBsdf (Burley 2015 as pbrt-v3
  reads it: clear coat ×0.25, thin diffTrans ÷2), PxrSurface's main lobes, UsdPreviewSurface with UsdUVTexture; connections
  followed through PxrColorCorrect's gamma, PxrBlend (bottom input), primvar readers and node graphs. MaterialX
  (`outputs:mtlx:surface`, read ahead of a preview surface beside it): OpenPBR (Blender's Principled BSDF), Standard
  Surface, glTF PBR and UsdPreviewSurface map parameter to parameter; a `surface` over a BSDF graph (Blender's other
  shaders) is read as its lobes say — diffuse, conductor (colour from `artistic_ior`'s reflectivity), dielectric (T or RT
  is glass), sheen, subsurface, translucent; mix, add, layer and multiply weight them; a plain diffuse gets no specular.
  Values fold to a constant, a texture with its gain (`multiply` by a constant), channel (`extract`) and placement (a
  3×3 UV matrix from `place2d`, `tiledimage`, and multiply / add / z-rotate chains, which is how Blender writes its
  Mapping node; the map is a copy, so materials sharing an image keep their own placement), or a normal / height map
  (`heighttonormal`, `bump`: MaterialX's slope, per whole UV unit over 16, times the normal map after it — Blender's
  Strength × Distance, negative when inverted — taken to `bumpScale` per texel by the map's size; not `bumpDistance`,
  whose heights are scene units);
  under a coat, its own normal map (`geometry_coat_normal`, `coat_normal`, `clearcoat_normal`; a coat height map is dropped).
  A texture mixed with a colour keeps its larger part; hue shifts of a texture and procedural nodes (noise, ramps) are
  dropped — each said once. three's MaterialXLoader is not used: it reads `.mtlx` documents, translates only
  standard_surface / gltf_pbr / open_pbr (not Blender's BSDF graphs), and builds TSL materials the path tracer cannot run. Ptex is not read: a
  Ptex input becomes the mesh's mean displayColor, where Moana bakes its Ptex, on an 8-bit grid so meshes share materials
  (the engine has no vertex colour). Cameras from apertures (vertical FOV; authored ones are the camera's `userData.aspect`:
  Blender writes the render size's shape there, Moana its 2.39:1), the RenderSettings the stage names (else the only one)
  as `sceneMetadata.render` (size, shape with `pixelAspectRatio`; its camera first, conformed by
  `aspectRatioConformPolicy`; renderer namespaces such as `ri:` are not read), an authored `clippingRange` as the clip start
  (camera rays begin that far in front, as in Cycles), Rect/Disk/Sphere/Distant lights in the engine's
  units, and the first dome light that lights the scene as the environment: USD's lat-long centre faces +Z (OpenEXR), the
  engine's +X, so `environmentRotation` = 90° − the dome's yaw. A `DomeLight_1` stands on its `poleAxis` (by default the
  stage's up axis; `Z` turns DomeLight's +Y onto +Z). Light linking is ignored. Light units follow UsdLux: the
  radiance is intensity × 2^exposure, divided by the light's size when `normalize` is on (surface area; a distant light's
  π·sin²(angle / 2)), so a normalized distant light's intensity is the irradiance on a surface facing it. No 683: USD's
  nits are render units. Spots and distant lights aim down their prim's −Z. A sphere light's `radius` becomes the point
  light's radius (unless `treatAsPoint`; see Light radius in `CLAUDE.md`) and a distant light's `angle` (default 0.53°)
  its sun's width. With `enableColorTemperature` the light's `colorTemperature` (1000–10000 K, default 6500) becomes the
  engine's light temperature (`userData.temperature`, editable apart from the colour), UsdLux's blackbody of luminance 1
  times the colour: the engine's curve is within 0.005 of OpenUSD's `BlackbodyTemperatureAsRgb` from 2300 to 10000 K.
  Not on a dome light (its hue is not applied either).
- **Fallbacks are OpenUSD's** (`usdFallbacks.test.js`): every UsdLux light, the camera, each gprim, UsdPreviewSurface,
  UsdUVTexture and the MaterialX OpenPBR, Standard Surface and glTF PBR surfaces read bare must translate as with every
  input written at OpenUSD 25.08's fallback (UsdLux / UsdGeom schemas, the Sdr registry with MaterialX's library), also
  with each zero-fallback weight turned on (glass, subsurface, coat, sheen, thin film, the specular workflow). Found
  2026-11-08: a bare Capsule took a Cylinder's radius 1 and height 2 (OpenUSD: 0.5 and 1); UsdPreviewSurface's
  clearcoatRoughness was 0 (0.01) and, under useSpecularWorkflow, its specularColor three's white (0: no specular head
  on; Blender reads it so too); OpenPBR and Standard Surface glass with no transmission_color took the base colour's tint
  (their fallback is white, clear), a subsurface with no colour the base colour (0.8 / 1 of their own), and OpenPBR's
  subsurface_radius_scale was (1, 1, 1) (1, 0.5, 0.25). Glass tinted through its depth no longer also takes the base
  colour at its surface: under OpenPBR the base colour is the opaque substrate's (`mtlxTransmissionColor`). Kept on
  purpose: an unauthored clippingRange or aperture is no clip start or picture shape (the file asked for none); a
  texture whose file is missing leaves the surface its own input (0.18 grey) where OpenUSD would use the texture node's
  fallback (black); `wrapS`/`wrapT` `useMetadata` reads as repeat (Storm: black past the edge without file metadata);
  an authored specularColor is a tint on the IOR's reflectance, as Blender and three read it (the spec: the reflectance
  itself).
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

## Lights from Blender's glTF exporter
glTF lights are photometric: point and spot in candela, sun in lux. Blender's exporter multiplies its watts by 683
(lumens per watt), and the loader takes that out again (`AssetLoader.processModelObjects`), as Blender's own importer
does. A small point, spot or sun then matches Cycles to render noise (Blender 5.1.1, 2026-10-12: floor under the lamp
within 0.25 %). What the export loses before the engine sees it:
- **Area lamps** are dropped: `__filter_lights_punctual` rejects `AREA` and `HEMI`, since glTF has no area light, and
  the node arrives as an empty. Use an emissive mesh, which exports, or export USD: Blender writes them as `RectLight` /
  `DiskLight`, and their brightness matches Cycles (2026-10-12: 0.9999, 1.0001; before Blender 5.2 their colour has the
  6500 K tint below). Blender's USD has quirks of its own: a sun is written
  at a quarter of its strength (`energy / 4`, "approximately matches Karma" in its source, so it renders at a quarter)
  and half its angle (both still so in Blender 5.3 and `main`), and before 5.2 every light is flagged as using a 6500 K
  colour temperature, which the reader applies as UsdLux says: against Cycles, red +4 %, green −2 %, blue +4 %.
- **Sun strength**: Blender 5.1.1 writes every sun at 683 lux whatever its energy (a sun of 3 W/m² renders at a third).
  The exporter's sun branch reads the light's Emission node Strength (1.0) and ignores `light.energy`. Fixed upstream in
  glTF-Blender-IO `850fb92e` (2026-07-05), which multiplies the two; it ships in Blender 5.3 (5.2.2 LTS still has the
  bug), and also multiplies a point, spot or area light's Light Falloff strength by its energy. Before 5.3: set the energy to 1
  and put the value in the Emission Strength — Cycles renders it the same, and Rayzee then matches Cycles exactly. The
  file cannot show the bug: 683 lux is also what an honest 1 W/m² sun exports as.
- **Light radius and sun angle**: glTF point and spot lights are points and its sun has no angle, so soft shadows are
  lost. A light's extras carry only custom properties, never `shadow_soft_size` or `angle`. Brightness moves too: Cycles
  lights from a disc of the light's radius facing the shaded point, so on its axis it is d² / (d² + r²) of a point —
  0.94 for a 0.5 m light 2 m away, which Rayzee renders 6 % brighter. Blender's USD export carries both, and they are read.
- **COMPAT / RAW lighting modes** write Blender's watts instead of candela and lux (COMPAT divides a point's by 4π, RAW
  writes the energy as it is), and nothing else in the file differs from SPEC. The loader assumes SPEC, Blender's
  default and what its own importer assumes.

## Blender scenes made for Cycles
Measured on Blender's Barbershop interior (2026-10-12): its own USD export, opened back in Blender, renders almost black
in Cycles, so these losses happen before the engine reads the file.
- **Lamps set by nodes**: ten of its fifteen lamps take their strength from a Light Falloff node (150–500) and their
  colour from the Emission node, with the lamp's own power left at 1 or 0.79 W. The USD exporter writes the lamp's power
  only, so they arrive 100–500× dim and white; the glTF exporter reads a Light Falloff strength and the Emission colour,
  but drops area lamps. Linear falloff and the node's Smooth have no equivalent anywhere.
- **Materials without Principled BSDF**: by default both exporters convert Principled BSDF only. Its 263 materials are
  Diffuse, Glossy and Mix Shader networks and node groups: 124 arrive with no surface (shaded grey), the rest with a
  colour and roughness, no metal, glass, emission or alpha. The USD exporter's **MaterialX Network** option (off by
  default) writes 245 of 246, but lossily: Glossy becomes a conductor, a Mix Shader driven by a Fresnel / Layer Weight
  chain gets a constant (0.5–1) in place of it, Transparent becomes a diffuse with the surface's opacity 0, and colour
  networks of ramps, noise and Pointiness are dropped or become nodes not read here. Read literally (as the engine does)
  the chairs come out half metal; reading "diffuse + uncoloured conductor" as a dielectric gloss was tried and barely
  helped, since the colours are what is lost. Converting such materials to Principled BSDF before export (OpenPBR then
  maps one to one) is the route: a Principled test scene through MaterialX matches Cycles, Mapping rotation included.
  Why, in Blender's MaterialX writer (`node_shader_*.cc`, unchanged in 5.2, 5.3 and `main` as of 2026-10-12): a Mix
  node's blend type is ignored (`TODO: Apply data->blend_type`, so Overlay / Multiply / Add are a plain mix), a Color
  Ramp writes nothing (`TODO: Implement`), an Attribute node (colour attributes) writes its default, Geometry has no
  Pointiness, Fresnel writes its IOR as the factor and Layer Weight its Blend input. The Barbershop's red chairs and
  orange sofa (a ramp over Pointiness) and green walls (colour attribute `Col`) are lost that way.
- **Volume-only objects**: a fog box (`ENV-Fog`, volume shader, no surface) arrives as a solid box around the room.
- **Curve objects**: the USD exporter writes a Curve or Text object as BasisCurves of width 2 × the point radius (2.0),
  whatever its bevel: a 6 mm wire and a ceiling rim swept with a bevel object became 2 m ribbons across the ceiling, as
  USD says (Blender's own re-import shows nothing, since a curve without bevel does not render). Turning Curves off in
  the export drops them. Convert them to meshes before export (Object → Convert → Mesh): the shapes then match Blender's
  to the millimetre.
- **Clip start**: its camera stands behind the back wall with a clip start of 1.1 m. The engine honours it (see USD
  above, and glTF `znear`); before 2026-10-12 it ignored it and rendered the wall.

