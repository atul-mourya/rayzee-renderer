# Core, capabilities and viewer

Rayzee is being split into three layers so that adding a feature rarely means editing the renderer.
This page is the boundary: what each layer owns, the rules between them, and the order of the work.

## The three layers

| Layer | Owns | Entry |
|---|---|---|
| **Renderer core** | A supported scene and camera in, path-traced samples accumulated, the image out, everything freed on dispose | `rayzee/core` → `RayzeeRenderer` |
| **Capabilities** | Optional pieces a host chooses: denoisers, extra integrators, importers, skies, picture processing | `rayzee` today; `rayzee/addons/*` as they move |
| **Viewer** | Today's complete experience assembled from the two layers below: navigation, picking, gizmo, overlays, timeline, animation playback, sessions, presets | `rayzee` → `PathTracerApp extends RayzeeRenderer` |

The React app (`app/`) sits above the viewer.

Each layer uses only the layers below it. The core imports nothing from the other two;
`tests/unit/core/coreBoundary.test.js` walks the core entry's imports and fails on any that reach above it.

## What the core supports

A scene the core renders is a three.js scene graph or a glTF file, using:

- **Materials:** the glTF / three.js physical material — base colour, metal and roughness, normal, bump and
  displacement maps, emission, alpha (blend, mask, cutout), transmission with thickness, attenuation and dispersion,
  IOR, specular, sheen, clear coat, iridescence, anisotropy, and subsurface scattering. All of these are core: they are
  one material model, and the scene decides which parts it uses.
- **Lights:** glowing meshes, an HDRI or plain-colour environment, and point, spot, rectangle and directional lamps.

Anything outside the list is reported through the issue log (`EngineIssues.js`), not drawn differently in silence.

Headless rendering and Node (`Platform.js`, `HeadlessCanvas.js`, `rayzee/node`) are core: they are how the minimal
renderer runs without a browser.

## Capabilities

| Group | Pieces |
|---|---|
| Denoisers | OIDN, ASVGF, NRD, EdgeAware, and their helper stages (NormalDepth, MotionVector, Variance, BilateralFilter) |
| Picture | AI upscaler, auto exposure, the OCIO colour pipeline (basic colour — linear working space, texture interpretation, tone mapping — stays core) |
| Light transport | Bidirectional, bidirectional + photons (VCM) |
| Skies and lamps | Physical sky, IES profiles, gobos |
| Importers | pbrt, scene archives and folders; FBX, OBJ, STL, PLY, Collada, 3MF, USD and EXR (`rayzee/addons/formats`) |
| Storage | The on-disk store behind the download and scene caches and the memory spill (the caches themselves are core and run without it) |

## Rules between the layers

1. **Who creates a resource frees it.** A capability gets read-only views of core outputs and disposes only what it made.
2. **The core announces every restart of accumulation, with its reason** (camera, scene, setting). Each capability
   decides what of its own history to keep.
3. **A capability names the outputs it needs; the core writes them.** An extra per-pixel output is compiled into the
   core's GPU programs only when something asks for it (`requestOutput`): the hit distance, and the
   normal/depth/albedo G-buffer the denoisers read.
4. **A missing capability costs nothing.** Nothing is built for it, and the core runs without it.

The viewer plugs into the core through a fixed set of protected methods on `RayzeeRenderer`, listed under "Hooks" at
the end of that file (`_beginFrame`, `_holdTrace`, `_afterTrace`, `_beforeReset`, `_releaseSceneState`, …). Each runs
at a fixed point of the frame, reset or load sequence and does nothing in the core, so the order is visible in the
code rather than spread across events. `PathTracerApp` overrides them; its setup steps (`_createCamera`,
`_createExtraStages`, `_initManagers`, `_wireEvents`) call the core's first or last, as each needs.

**Signals.** The core emits two events on the pipeline's bus and names no capability: `pipeline:historyReset` (a hard
restart; history from before is not comparable — ASVGF and NRD listen) and `pipeline:lightingChanged` (a model or
environment came in — auto exposure listens). Which processed picture the compositor shows is the builder's call:
`_displaySources()` lists the context keys in priority order, and the core's list is empty.

**Per-renderer shader resources.** Material texture buckets, shadow albedo maps, gobo and IES textures and the
alpha-shadow switch ride in each kernel's build context (`TSL/SceneResources.js`), never in module variables: a TSL
function body runs when its kernel compiles, so module state was read from whichever renderer set it last. Two
renderers in one page now share only the colour management and the on-disk storage, both page-wide by design.

**Outputs on request.** `pathTracer.requestOutput( name, options )` returns a function that withdraws the request; the
kernels rebuild before the next frame either way. `'hitDistance'` takes `encode( distance, viewZ )`: NRD passes its
normalisation, so the core's shading program holds no NRD code and leaves the output out when nobody asks.
`'gBuffer'` compiles the denoisers' normal/depth/albedo writes into Generate, Shade and FinalWrite; the viewer asks for
it at start-up (so switching a denoiser on never rebuilds), and the first `setAuxGBufferEnabled( true )` asks for it on
the core. Without it the core's programs carry none of that code, and still render byte for byte as the full engine.

## Decisions

- **One package.** Capabilities live in `rayzee` under import paths (`rayzee/core` now, `rayzee/addons/*` as they
  move), with one version and one release.
- **Not a breaking change.** `rayzee` and `PathTracerApp` keep their API; the viewer still builds every capability.
  Default renders stay the same pixel for pixel, checked against the bench's reference images.

## Steps

1. **Boundary** — this page. Done.
2. **Minimal renderer** — done. `RayzeeRenderer` (`RayzeeRenderer.js`, entry `core.js`) is the core class
   `PathTracerApp` extends. It imports and builds no denoiser, camera controls, gizmo, overlay or timeline
   (`coreBoundary.test.js`). `npm run bench:node -- --core` renders every bench scene with it beside the full engine:
   36 of 36 byte-identical, and the full engine still matches the Chrome references.
   Download: the core is 1,253 KB (341 KB compressed) against 1,560 KB (420 KB) for `rayzee`; 162 of the 198 modules,
   69,700 of 89,100 lines.
3. **NRD out of the core shading program** — done (outputs on request, above). The full engine's GPU programs are
   byte-identical to before (125 of 125 over 7 scenes); the core's shading program differs only by the missing
   hit-distance block.
4. **Compile only what a scene uses** — built (2026-10-04) for seven material layers: clear coat, sheen, iridescence,
   anisotropy, subsurface, dispersion and diffuse transmission compile into the kernels only while some material
   has them (`materialLayers( builder )`, `TSL/SceneResources.js`). Every bench image unchanged; frame time −3.9 to
   −24.3 %, median −9.6 % over 28 scenes. The measurement that led to it: With subsurface and clear coat cut out of Shade, its
   sampling and the BSDF (Shade, MaterialTransmission, MaterialEvaluation, MaterialProperties, PathTracerCore), scenes
   without them still matched their references and ran faster, alternating runs at 1024² in Chrome (Apple M-series):

   | Scene | Shade ms, all layers | Shade ms, cut | Frame |
   |---|---|---|---|
   | furnace-diffuse | 3.40 / 3.38 | 3.22 / 3.22 | −2.4 % |
   | textured-normalmap | 3.40 / 3.39 | 3.21 / 3.19 | −3.0 % |
   | alpha-cutout | 6.45 / 6.46 | 6.13 / 6.07 | −3.6 % |
   | furnace-multibounce | 12.73 / 12.75 | 12.02 / 12.54 | noisy, ~−1 % |

   About 5 % of Shade, 2.5–3.6 % of the frame, for two layers; compile time did not change (~0.7 s a scene in Node
   either way). Worth doing once material layers are modules, each with its own switch, and a material edit that turns
   one on rebuilds the kernels as `requestOutput` does. Not worth a separate project now.
5. **Physical sky as an add-on** — done. `rayzee/addons/physical-sky` exports `PhysicalSky`; the core's
   `environmentManager.setProceduralSky( PhysicalSky )` installs it, and `PathTracerApp` does so itself. Asked for
   'procedural' mode without it, the core records `capability.missing` (it throws under `strict`). The core reaches
   none of its modules; the sun it shades keeps only the limb-darkening constant (`Processor/SolarLimb.js`). The core
   now downloads 326 KB compressed (from 341). `bench:node -- --core` installs it on the core.
6. **Per-renderer shader resources** — done (above); the Node bench now runs the core beside the full engine.
7. **Archives and pbrt as an add-on** — done. `rayzee/addons/archives` exports `ArchiveImporter` (the archive half
   of the old `AssetLoader`, moved whole) with the readers and pbrt behind it; `assetLoader.setArchiveImporter()`
   installs it, `PathTracerApp` does so itself, and without it an archive's error names the add-on. The spill budgets
   moved to `Processor/HostMemory.js`. `classroom.zip` and `veach-ajar.zip` render byte-identically with the last commit and
   with the core plus the add-on. That check found a core bug the viewer had hidden: a load frames the camera with
   `lookAt()`, which leaves its world matrix stale, and only the orbit controls refreshed it — `renderFrames` now
   does, each pass. The core downloads 289 KB compressed (from 326).
8. **Bidirectional and vertex merging as an add-on** — done. `rayzee/addons/bidirectional` exports
   `BidirectionalIntegrator`; the path tracer has integrator hooks instead of bidirectional code
   (`registerIntegrator`, `setIntegrator`, `activeIntegrator`; `PathTracer.js` 2,718 → 2,116 lines), and Shade and
   Generate take the bidirectional functions from the integrator's uniforms. The GPU programs are unchanged apart
   from internal name numbers (209 of 209 over 10 scenes, five of them bidirectional or VCM), and the core plus the
   add-on renders all 36 bench scenes byte-identically with the full engine.

9. **OCIO colour as an add-on** — done. `rayzee/addons/color` exports `ColorManagement` and the OCIO helpers (views,
   input spaces, conversions, table baking); `renderer.setColorManagement( ColorManagement )` installs it, and
   `PathTracerApp` does so itself. Without it the core's `renderer.color` is `BasicColor`: linear Rec.709, three.js's
   seven view transforms, and `loadColorConfig()` records `capability.missing` and rejects naming the add-on. The
   shaders and readbacks read the active colour management through `Color/ActiveColor.js`, so either one serves them.
   About 3,060 of the 3,885 colour lines left the core; it keeps the view-transform registry, the built-in views and
   the working matrix. The core plus the add-on renders all 36 bench scenes byte-identically with the full engine.

10. **On-disk storage as an add-on** — done. `rayzee/addons/storage` exports `acquireSharedStorage` and the OPFS
   implementation behind it (`StorageManager`, its worker, transports and locks); `renderer.setStorageOpener(
   acquireSharedStorage )` installs it, and `PathTracerApp` does so itself. The caches that use storage stay in the
   core, unchanged: each takes a manager or null, and without one a download lands in memory and nothing is cached.
   Asked for storage without the add-on, the core records `capability.missing` as a warning, as every storage failure
   is. The core plus the add-on renders all 36 bench scenes byte-identically with the full engine.

   Downloads, compressed: the core 263 KB, `rayzee` 432 KB. Beyond the core: physical sky 11 KB, archives 40 KB,
   bidirectional 14 KB, colour 14 KB, storage 8 KB.
11. **Each layer declares its own settings** — done. `RenderSettings` holds only the core's settings and names no
   viewer piece; `settings.define( key, { default, apply, reset } )` adds another layer's, with the same provenance, events,
   session saving and reset. The viewer defines `interactionRenderScale` (the core has no moving-camera resolution
   drop), and keeps its own rules for two core settings through the bindings it passes: auto exposure leaves a manual
   `exposure` unshown while it drives the picture, and a panorama moves a motion-vector denoiser to edge-aware. The
   viewer's capabilities (denoisers, upscaler, auto exposure) keep their own methods, as before. Asked for a key only
   the viewer defines, the core records `setting.unknown_key`, as for any key nothing applies.
12. **Treelet optimiser removed** — measured on five models (33k to 1.9M triangles) it bought at most 0.57 % tree
   SAH and no measurable render speed for 2–24× the BLAS build time. Default trees are byte-identical.
13. **Draco and KTX2 in Node** — three's loaders start their own workers after awaiting a decoder, out of
   `createWorker`'s reach; each glTF parse now runs inside `withHostWorker()` (`Platform.js`), which lends the host's
   worker class only where there is no global one.

   Downloads now, compressed: the core 249 KB (the treelet optimiser was bundled three times), `rayzee` 418 KB.
14. **The viewer loads two add-ons on first use** — `PathTracerApp` installs the physical sky and the archive importer
   with loaders (`setProceduralSkyLoader`, `setArchiveImporterLoader`), so each is a chunk of its own, fetched the first
   time the physical sky is baked or an archive is read. What `rayzee` loads at startup beyond the core went from 169 to
   121 KB compressed; the app's startup JavaScript from 1,214 to 1,175 KB. Colour and storage are used at startup, and
   choosing an integrator applies at once (a lazy one would trace plain frames meanwhile and break reproducible
   renders), so those three stay eager.
15. **Examples** — `rayzee/examples/core-node.mjs` renders with the core alone in Node (`npm run example:node`; the Node
   bench runs it), and `rayzee/examples/core-browser/` is the core plus the physical sky in a page
   (`npm run example:browser`).
16. **File formats as an add-on** — the core reads glTF/GLB, `.hdr` and LDR images. FBX, OBJ, STL, PLY, Collada, 3MF,
   USD and EXR are descriptors in `rayzee/addons/formats` (`fbxFormat` … `exrFormat`, `allFormats`), registered with
   `assetLoader.registerFormat()` and read through one shared path in place of seven copies (`AssetLoader.js`
   1,622 → 1,351 lines); a host's own format registers the same way. glTF's Draco, KTX2 and meshopt decoders are
   imported only for a file that uses them (`GLTFDecoders.js`). Built as a host would (the core-browser example):
   the main chunk 577 → 534 KB gzip, and the seven model-loader chunks are no longer emitted.

## What still ties the layers

- **Shade still holds the bidirectional branches** (compiled out unless an integrator passes its uniforms); moving
  them out means a shading kernel of the integrator's own.
- **The memory spill's orchestration is in `SceneProcessor`** (streamed extraction, progressive spill, page-in). It
  does nothing without storage, but it is core code; moving it out means a build-step hook in the scene processor.
- **Colour and storage are one per page.** The active colour management (`Color/ActiveColor.js`) and the shared OPFS
  manager serve every renderer in the page, by design: a config is a page-wide choice, the texture cache keys on it,
  and one origin has one file system.
