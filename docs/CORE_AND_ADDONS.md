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
| Importers | pbrt and scene archives; OBJ, FBX, USD, STL and the other three.js loaders (already loaded on demand) |
| Storage | Download and scene caches, memory spill |

## Rules between the layers

1. **Who creates a resource frees it.** A capability gets read-only views of core outputs and disposes only what it made.
2. **The core announces every restart of accumulation, with its reason** (camera, scene, setting). Each capability
   decides what of its own history to keep.
3. **A capability names the outputs it needs; the core writes them.** Extra per-pixel outputs (normal, depth, albedo,
   roughness, hit distance) are compiled into the core's GPU programs only when something asks for them.
4. **A missing capability costs nothing.** Nothing is built for it, and the core runs without it.

The viewer plugs into the core through a fixed set of protected methods on `RayzeeRenderer`, listed under "Hooks" at
the end of that file (`_beginFrame`, `_holdTrace`, `_afterTrace`, `_beforeReset`, `_releaseSceneState`, …). Each runs
at a fixed point of the frame, reset or load sequence and does nothing in the core, so the order is visible in the
code rather than spread across events. `PathTracerApp` overrides them; its setup steps (`_createCamera`,
`_createExtraStages`, `_initManagers`, `_wireEvents`) call the core's first or last, as each needs.

**Outputs on request.** `pathTracer.requestOutput( name, options )` returns a function that withdraws the request; the
kernels rebuild before the next frame either way. `'hitDistance'` takes `encode( distance, viewZ )`: NRD passes its
normalisation, so the core's shading program holds no NRD code and leaves the output out when nobody asks.

## Decisions

- **One package.** Capabilities live in `rayzee` under import paths (`rayzee/core` now, `rayzee/addons/*` as they
  move), with one version and one release.
- **Not a breaking change.** `rayzee` and `PathTracerApp` keep their API; the viewer still builds every capability.
  Default renders stay the same pixel for pixel, checked against the bench's reference images.

## Steps

1. **Boundary** — this page. Done.
2. **Minimal renderer** — done. `RayzeeRenderer` (`RayzeeRenderer.js`, entry `core.js`) is the core class
   `PathTracerApp` extends. It imports and builds no denoiser, camera controls, gizmo, overlay or timeline
   (`coreBoundary.test.js`). `npm run bench:node -- --core` renders every bench scene with it after the full engine:
   36 of 36 byte-identical, and the full engine still matches the Chrome references.
   Download: the core is 1,253 KB (341 KB compressed) against 1,560 KB (420 KB) for `rayzee`; 162 of the 198 modules,
   69,700 of 89,100 lines.
3. **NRD out of the core shading program** — done (outputs on request, above). The full engine's GPU programs are
   byte-identical to before (125 of 125 over 7 scenes); the core's shading program differs only by the missing
   hit-distance block.
4. **Compile only what a scene uses** — measured, not built. With subsurface and clear coat cut out of Shade, its
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

## What still ties the layers

- **Module-level shader state.** The alpha-shadow switch, shadow albedo maps, gobo and IES textures and the material
  texture buckets are set at module level when a scene builds (`ShaderBuilder.createSceneTextureNodes`), so two live
  renderers in one process share them and the last build wins — run them one after the other. Fixing this is what
  makes a capability, or a second view, safe to load beside a renderer.
- **The core still carries capabilities:** pbrt and archives (`AssetLoader` → `PBRT/`), storage, the OCIO pipeline,
  the physical sky (`EnvironmentManager` → `PhysicalSky`) and bidirectional / VCM (in `PathTracer` and Shade, compiled
  out unless chosen). These are the next extractions, in roughly that order of size.
- **Names the core knows:** the Compositor's list of denoiser outputs (`asvgf:output`, `nrd:output`, …) and the
  `asvgf:reset` / `denoiser:reset` / `autoexposure:resetHistory` events the core emits. A capability should register
  its output and listen for the core's restart signal instead.
