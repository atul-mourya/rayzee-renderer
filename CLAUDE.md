# Rayzee Real-Time Path Tracer - AI Coding Instructions

## Overview
**Rayzee** is a sophisticated real-time path tracing web application built with Three.js, React, and a WebGPU renderer, organized as a **monorepo** with two packages: `rayzee/` (the standalone rendering engine, publishable to npm) and `app/` (the React UI application). The core rendering pipeline implements Monte Carlo path tracing with BVH acceleration and progressive denoising — running in the browser via TSL (Three Shading Language) shaders compiled to WGSL.

## External Documentation
- **Three.js LLM docs**: See [llms.txt](llms.txt) for pointers to the full Three.js documentation including TSL (Three Shading Language) reference. Use these when working on Three.js or TSL shader code.

## Commands

### Code Intelligence

Prefer LSP over Grep/Read for code navigation — it's faster, precise, and avoids reading entire files:
- `workspaceSymbol` to find where something is defined
- `findReferences` to see all usages across the codebase
- `goToDefinition` / `goToImplementation` to jump to source
- `hover` for type info without reading the file

Use Grep only when LSP isn't available or for text/pattern searches (comments, strings, config).

After writing or editing code, check LSP diagnostics and fix errors before proceeding.

### Development
- `npm run dev` - Start development server (Vite, delegates to app workspace) on http://localhost:5173
- `npm run build` - Build engine lib then app
- `npm run build:engine` - Engine library only: the full engine (ESM + UMD), `rayzee-core.es.js`, `encoders.es.js` and `addons/*.es.js` (ESM)
- `npm run build:app` - App only
- `npm run preview` - Preview production build locally

### Code Quality
- `npm run lint` - Run ESLint checks (from root)
- `npm run lint-fix` - Automatically fix ESLint issues

### Testing
- `npm test` - Run Vitest from root
- `tests/gpu/` (Vitest project `gpu`) runs on the real GPU in Node through Dawn — the `webgpu`
  package, the same WebGPU implementation Chrome ships. `evaluate()` in `tests/gpu/gpu.js` runs a TSL
  function per element and returns the buffer, so a shader function or a CPU/GPU twin is tested in
  milliseconds. Skipped on CI (no Vulkan driver there); on a workstation a missing adapter fails the
  run. ⚠️ Dawn segfaults the process if its `create()` result is garbage-collected while a device
  lives — `tests/gpu/environment.js` holds it for that reason. ⚠️ An invalid kernel does not throw:
  `evaluate()` returns zeros. A literal `int( -1 )` instance leaf did that, folded into an
  out-of-bounds BVH read the WGSL compiler rejects; pass such values in as data (`uvTangent.test.js`).

### Regression Bench (`bench/`)
Headless-GPU regression detection for quality, performance, and memory. See `bench/README.md`.
- `npm run bench` - quality, freeze, lockstep, denoise, memory and perf against the working tree
- `npm run bench:bless` - regenerate goldens / ground truth (required on a new machine)
- `npm run bench:ab -- main` - gate perf against another git ref (same-session interleaved A/B; `--head <ref>` for two refs). Logged to `baselines/ab.jsonl` when both sides are commits
- `npm run bench:release` - `bench:ab` between the two newest release tags; run it after each release
- `npm run bench:trend` - `bench/results/trend.html`: the perf and A/B logs, one chart a scene, drift flagged, a line broken where the scene itself changed (each perf run records the scene's workload)
- `npm run bench:load` - real models loaded by phase in Node (models gitignored: `RAYZEE_BENCH_MODELS`); fails on a load error or engine issue, `-- --ab main` / `--base-dir <checkout>` gates each phase
- `npm run bench:exposure` - auto (and local) exposure against neither, wall clock (`-- --size 1024x1024`)
- `npm run bench:list` - show the scene corpus
- `npm run bench:storage` - raw OPFS throughput (write / read / `File.slice`), isolated and not; `--firefox`, `--engine`
- `npm run bench:oidn` - OIDN's kernels on this GPU in Node: default against subgroup matrix, speed and pixel difference
- `npm run bench:examples` - every example in `rayzee/examples/` (two Node, two pages in headless Chrome) runs to the
  end against this tree with no error or warning; needs the network. The browser ones run on the engine source through
  `rayzee/examples/vite.config.js` (`npm run example:browser` / `example:viewer`), so they track the working tree

Baselines are **machine-specific** (the wavefront path budget derives from device limits, and
single- vs multi-chunk are different code paths); the suite refuses to compare across a
mismatched GPU fingerprint. Perf absolutes are a monitored trend, never a gate — only the A/B
comparison gates. Perf times the GPU **compute passes only**: render-pass timestamps overlap the compute on Apple GPUs and
flipped small scenes between two speeds; on compute the A/B band is 3 %.

### Release
- `npm run release` - Create semantic release (requires environment variables)

### Commit & PR Conventions
Use **conventional commits**. Every commit message and PR title **must** start with a type prefix:
- `feat:` — A new feature
- `fix:` — A bug fix
- `refactor:` — Code refactoring (no behavior change)
- `chore:` — Maintenance, deps, config, tooling
- `docs:` — Documentation only
- `style:` — Formatting, whitespace (no logic change)
- `perf:` — Performance improvement
- `test:` — Adding or updating tests
- `build:` — Build system or external deps
- `ci:` — CI/CD configuration
- `revert:` — Reverts a previous commit

Optional scope: `feat(nrd):`, `fix(tsl):`, `refactor(pipeline):`, etc.

**A change to default pixels is a breaking change.** Anything that changes what a render looks like
when a host sets nothing — a default setting (the core's or a viewer piece's), a mode preset, light units,
a sampling or BSDF change that moves the goldens — gets a `BREAKING CHANGE:` footer saying how default
renders change, so semantic-release makes it a major. Farms pin a major to pin a look and calibrate
against it; 7.28 → 9.1 moved their image by 29.5/255 with no breaking note. Two tripwires:
`tests/unit/core/pixelDefaults.test.js` snapshots the defaults (core and viewer pieces) and presets (update with
`-u`, then add the footer), and `bench:bless` names every golden that moved on the same GPU.

## Monorepo Structure

**`rayzee/src/`, one folder a job** (lowercase; a worker sits beside the code that starts it):
- root — entries (`index.js`, `core.js`), `RayzeeRenderer.js` and its API (`RenderSettings`, `EngineDefaults`,
  `EngineEvents`, `EngineIssues`, `AssetConfig`, `Platform`, `HeadlessCanvas`), `Logger.js`, `Portable.js`; the loading/stats status channel is in `EngineEvents.js`
- `pipeline/` stages, context, events, Compositor · `pathtracer/` the path tracer stage, uniforms, kernel dispatch,
  ray queues and buffers · `shaders/` TSL functions, `shaders/kernels/` the compute kernels
- `scene/` scene → GPU data (extraction, instance table, buffer layout, live camera; `SceneProcessor`'s refits, moves and
  background BLAS rebuilds in `SceneRefit.js`, its spill in `memory/SceneSpill.js`, its stored BLASes in
  `storage/BLASCache.js`, its material textures in `materials/TextureCreator.js`) · `bvh/` · `lights/` ·
  `materials/` (and texture arrays) · `environment/` (HDRI, skies, sun) · `loaders/` · `memory/` · `output/` (readbacks,
  their tone mapping, `rayzee/encoders`) · `color/` · `storage/` (the caches; the OPFS manager is an add-on) · `node/`
- `addons/` one folder an add-on, its entry `index.js` beside its code (`formats.js` is one file): `archives/` (with
  `pbrt/`, `usd/`), `bidirectional/` (integrator, shaders, kernels), `color/` (OCIO), `physical-sky/`, `storage/`
- `viewer/` everything only `PathTracerApp` uses: `camera/`, `overlays/`, `animation/`, `denoise/`, `picture/`,
  `lights/` (gobo, IES). ⚠️ The core imports nothing from `viewer/` or `addons/`; whatever only the full entry reaches
  lives in `viewer/`, whatever only an add-on reaches in its folder (`coreBoundary.test.js` holds all three).

**Docs**: `docs/guide/` is the engine's user guide and API reference (`rayzee/README.md`, the npm page, links there);
`docs/design/` holds how it works inside. A public API change updates the guide.

**Key import patterns**:
- Engine imports in app code: `import { PathTracerApp, EngineEvents } from 'rayzee'`
- App proxy: `import { getApp } from '@/lib/appProxy'` (the `@` alias resolves to `app/src/`)
- Constants from engine: `import { PRODUCTION_RENDER_CONFIG } from 'rayzee'`

## Architecture Overview

### Modern Event-Driven Pipeline (`rayzee/src/pipeline/`)
**Recently refactored from pass-based to stage-based architecture**:
- **`RenderPipeline.js`**: Orchestrates stage execution order with shared context and event bus
- **`RenderStage.js`**: Base class for all rendering stages (replaces Three.js Pass pattern)
- **`PipelineContext.js`**: Shared state, textures, and uniforms between stages
- **`EventDispatcher.js`**: Loose coupling via events (e.g., `pathtracer:frameComplete`, `pipeline:historyReset`)

### Core Rendering Stages (`pathtracer/`, `pipeline/`, `viewer/denoise/`, `viewer/picture/`)
**Execution order matters** - stages run sequentially. The renderer core builds only PathTracer → Compositor; the viewer's
`_createExtraStages()` inserts NormalDepth, MotionVector, NRD, AutoExposure and LocalExposure between them:
- **`PathTracer.js`** + **`PathTracerStage.js`**: Pure-wavefront Monte Carlo path tracer with MRT outputs. `PathTracer` (the wavefront renderer) extends the `PathTracerStage` base (shared engine/scene infrastructure).
- **`NRD.js`**: Port of NVIDIA NRD's ReBLUR (recurrent blur) denoiser — strategy `'nrd'`; reads roughness from `pathtracer:shadingNormal.w` (NormalDepth; negated on an emitter, NRD's material-ID slot) and the secondary hit distance from `pathtracer:albedo.w` (written by Shade at camera depth 1, only because NRD asks for it: `pathTracer.requestOutput( 'hitDistance', { encode } )`, with its own normalisation). Progressive-aware: passes the frame through untouched once the input has `handoverFrames` samples. ⚠️ ReBLUR's weights are geometry only, so whatever the blur reaches must hold the same lighting: the fused radiance is demodulated by both lobes' albedo, emitters never feed a neighbour, nor black-albedo samples (emission, sky or specular alone) a lit one. See `docs/design/NRD_DENOISER.md`. ⚠️ TSL shares texture bindings by texture uuid — a deferred-read `TextureNode` is non-mergeable (`mergeable = false`, three r187) so the reads can share one placeholder (see `readNode()` there).
- **`LocalExposure.js`**: Unreal Engine 5's local exposure — a display-only per-pixel gain (see Local exposure below)
- **`OverlayManager.js`** and its helpers (in `viewer/overlays/`): visual helpers, drawn at **view resolution** (canvas bounding rect × DPR — so viewport zoom counts), never at the path tracer's render resolution. Two layers: a 3D scene layer (`ViewOverlayRenderer` — a transparent canvas with its own WebGPURenderer sharing the main `GPUDevice`; hosts light gizmos, the transform gizmo, and `OutlineHelper`) and a 2D HUD canvas (`TileHelper` — OIDN-denoise / AI-upscale progress borders). Both are separate canvases, so helpers can never be baked into saved images. The scene layer's renderer is created and initialised at startup, but its surface (~30 MiB) is allocated only when a helper first becomes visible, and it parks itself (`display:none`) when none are.

### Rendering Engine (`rayzee/src/`)
- **`RayzeeRenderer.js`** (entry `core.js`, published as `rayzee/core`): the renderer core — WebGPU device, scene build, path tracer + compositor, loading, reset, `renderFrames` / `renderToBuffer`, dispose. It builds no denoiser, camera controls, gizmo, overlay or timeline, and `tests/unit/core/coreBoundary.test.js` fails if its imports reach one. Capabilities install on it from `rayzee/addons/*` (`formats`, `physical-sky`, `archives`, `bidirectional`, `color`, `storage`); `PathTracerApp` installs all six itself. See `docs/design/CORE_AND_ADDONS.md`. Loading and spill planning live in
  `loaders/SceneLoading.js`, scene edits (refit, transforms, materials, visibility) in `scene/SceneEdits.js`, readbacks and
  exports in `output/Pictures.js`: functions taking the renderer first, each behind a one-line method on the class.
- **`PathTracerApp.js`**: the viewer, `extends RayzeeRenderer` — camera manager, interaction, gizmo, overlays, timeline, animation playback, denoisers and picture stages, gobo/IES, scene state, mode presets. It plugs in through the core's hooks (listed under "Hooks" at the end of `RayzeeRenderer.js`; each runs at a fixed point of the frame, reset or load sequence). ⚠️ Viewer code goes in the viewer: a core method that needs it gets a hook, never a `this.denoisingManager?.` call.
- **`PathTracer.js`** + **`PathTracerStage.js`** (in `rayzee/src/pathtracer/`): the pure-wavefront path tracer. `PathTracerStage` is the shared base — owns the 5 sub-managers (composition), uniforms, camera, lights, BVH/scene buffers, accumulation, completion, denoiser history resets, mesh visibility, and lifecycle. `PathTracer extends PathTracerStage` and owns the per-frame wavefront kernel dispatch (`render()`, `_buildWavefrontKernels()`). External code accesses the sub-managers directly (see Sub-managers below).
- **`index.js`**: Public API barrel export for the engine package

### App-Side Engine Integration (`app/src/lib/`)
- **`appProxy.js`**: `getApp()`, `setApp()`, `subscribeApp()` — decouples all consumers from direct app references
- **`EngineAdapter.js`**: Bridges engine events to Zustand stores
- **`exporter.js`** + **`components/layout/TopBar/ExportDialog.jsx`**: the Export window (File → Export Picture… / Export
  Video…, the viewport's camera button, the Results page's export button, the Anim tab's Export Video…), opened through
  `useStore.exportRequest`. Picture choices persist in localStorage, video choices in `useAnimationStore.videoExport`; the
  EXR colour space is `app.color.exportSpace`. A saved render exports its picture (edited, as rendered, AI) or its EXR
  copy, as saved or converted to Radiance HDR. Both import `rayzee/encoders` only when used (the window on open).
- **`VideoEncoder.js`**: WebCodecs encodes, Mediabunny muxes MP4 (H.264, level picked by size, odd sides cropped) or WebM
  (VP9, then VP8); imported only when a video is exported (Mediabunny is 40 KB gzip). `videoJob.js` journals each frame's
  chunks and muxes at the end (MP4 index first, `fastStart: 'reserve'`); a job from before the Export window has no
  `container` and is WebM. PNG/EXR frame sequences render through `exportImage()` (`captureFrame: false` on
  `VideoRenderManager`) into a folder from `showDirectoryPicker` — kept by `folders.js`, asked for again at the Resume
  click — or, with no folder access, one zip that cannot be resumed.

### Sub-managers and Path Tracer Classes
PathTracer delegates to these via composition — external code accesses them directly (e.g., `stage.uniforms.get('maxBounces')`, `stage.materialData.srgbBuckets`, `stage.environment.envParams`). MaterialDataManager lives in `materials/`, EnvironmentManager in `environment/`, TLASBuilder in `bvh/`, InstanceTable in `scene/`, the rest in `pathtracer/`:
- **`UniformManager.js`**: Owns ~60 TSL uniform nodes. Provides `get(name)`, `set(name, value)` (booleans are converted inside `set`). Uniforms created once, only `.value` mutated to preserve compiled shader graph references. The four light lists are written in place too (`LIGHT_FLOATS` × 16 a type, `PathTracerStage._writeLightList`): the shader bakes a list's length, so lists sized per scene compiled a new shade program per light count and dropped a light added after a build. A list grows only past its capacity, and that rebuilds the kernels. PathTracer exposes dynamic getters via `_defineUniformGetters()` for backward-compat property access.
- **`MaterialDataManager.js`**: Material buffer read/write, property mapping (`updateMaterialProperty()`), texture arrays (`srgbBuckets` — albedo/emissive — and `linearBuckets`, consolidated by size). The material block sits at the front of the stage's **scene data buffer**, the light data (light BVH, emissive triangles, bit-trail map) behind it: one Shade binding for both (`callbacks.adoptMaterials` → `PathTracerStage._adoptMaterials`; `materialStorageAttr`/`Node` are that buffer). Material reads are unchanged; light reads go through `stage.lightDataNode`, which adds `lightVec4Offset`. Edits upload only the material region (`_uploadMaterials`, an update range), light rebuilds only theirs.
- **`EnvironmentManager.js`**: HDRI loading, CDF importance sampling (`buildEnvironmentCDF()`), physical/solid sky generation, environment rotation. Owns `environmentTexture`, `envParams`, and the `envCDFTexture` (RGBA32F, the environment's sampling table as `packExactTable` lays it out; `exactTable`) — except while the physical sky is on, whose two textures `PhysicalSky` owns and fills on the GPU.
- **`ShaderBuilder.js`**: scene texture-node factory — `createSceneTextureNodes()` builds the environment, previous-frame MRT, gobo and IES texture nodes and hands back the scene's storage nodes. In-place updates via `updateSceneTextures()` / `updateGoboMaps()` / `updateIESProfiles()` on model change (no shader rebuild). The material buckets belong to PathTracer, and every per-renderer resource reaches a kernel through its build context (`shaders/SceneResources.js`, pitfall 14), never module state.
- **`StorageTexturePool.js`**: Ping-pong MRT storage textures for progressive accumulation. `create()`, `swap()`, `getReadTextures()`, `ensureSize()`.
- **`KernelManager.js`**: Registers + dispatches the wavefront compute kernels (`register()`, `dispatch()`, `setDispatchForCount()`, `setDispatchForGrid()`, `setIndirect()` — sized from workgroup counts written on the GPU). Used by `PathTracer` as `this._kernelManager`. The camera loop's bounce kernels are GPU-sized: whatever sets `ENTERING_COUNT` (`initActiveIndices`, `seedEnter`, the copyback) also writes the bounce's workgroup counts, into `_bounceSizes[ bounce % 2 ]` (a dispatch may not write the buffer it is sized from, so an even bounce's copyback writes the odd one's). All of them must be `[ LIST_WG_SIZE, 1, 1 ]`; the build throws otherwise.
- **`PackedRayBuffer.js`** / **`QueueManager.js`**: SoA ray/hit buffers (the path's RNG state is hit slot `HIT.RNG` — its own buffer would put Shade at 11 storage buffers; the uvec4 slot costs 12 B a ray more than the old 4 B buffer, 592 → 640 MB of ray buffers on this Mac's path budget) + the first-hit G-buffer as the hit buffer's last region (`_gBufferBase`, one uvec4 a path; as a buffer of its own it took a Shade binding the BVH parts need) (+ read helpers) and the active-index queues / atomic counters (`RAY_FLAG`, `COUNTER`) that drive wavefront stream compaction.
- **`TLASBuilder.js`**: Builds SAH BVH over TLAS entry AABBs for the top-level acceleration structure (an entry is a placement, a grouped copy, or — past 1M entries — a copy cluster). Flattens with BLAS-pointer leaves (tag `BLAS_POINTER_LEAF`, slot [1] entry index + identity bit, slot [2] visibility flag, slots 4–15 world-to-object rows) or cluster leaves (`CLUSTER_LEAF`). Caches flatten buffer across rebuilds.
- **`InstanceTable.js`**: per-**placement** metadata (template, TLAS leaf, visibility, transform) in typed columns, plus per-template BLAS offsets/sizes and object boxes. Transforms are runs read in place (`matrixRow( p )`), groups map placements to TLAS entries (`entryOf` / `repOf`), and copy clusters add records (`recordEntry`, `clusterLeaf`, `clusterOf`). Placements are positional: write them with `setEntry()` / `setAlias()` at an explicit index.

### TSL Shader Modules (`rayzee/src/shaders/`)
TSL modules using `Fn()`, `If()`, `Loop()`, `.toVar()`:
- Wavefront kernels (`shaders/kernels/`, with `DepthPass.js`): `GenerateKernel.js`, `ExtendKernel.js`, `ShadeKernel.js`, `CompactKernel.js` (and the active list's bookkeeping), `FinalWriteKernel.js` (and the pixel freeze), `SortGlobalKernels.js`, `DebugKernel.js`; bidirectional/VCM (in `addons/bidirectional/`): `LightGenerateKernel.js`, `ConnectKernel.js`, `LightSplatKernel.js`, `MergeKernel.js`
- Traversal and shading: `BVHTraversal.js`, `MaterialEvaluation.js`, `MaterialSampling.js`, `MaterialTransmission.js`, `Subsurface.js`, `LightsDirect.js`, `LightsSampling.js`, `EmissiveSampling.js`, `Environment.js`, `TextureSampling.js`, `SceneResources.js`, etc.

### Multi-Threading Architecture (workers beside the code that starts them)
Critical for maintaining 60fps during heavy computations. BVH and TLAS workers are in `bvh/`, the texture ones in
`materials/`, `CDFWorker` in `environment/`, `AIUpscalerWorker` in `viewer/picture/`, `StorageWorker` in `addons/storage/`:
- **`BVHWorker.js`**: Off-main-thread BVH construction using binned SAH splitting and reinsertion
- **`TexturesWorker.js`**: Batch texture processing with memory-optimized chunking
- **`BVHSubtreeWorker.js`**: builds subtrees of one large mesh's BVH in parallel (`ParallelBVHBuilder.js`)
- **`TLASWorker.js`**, **`PackWorker.js`** (texture packing without a canvas, in Node), **`AIUpscalerWorker.js`** (viewer)
- **`CDFWorker.js`**: CDF computation for environment importance sampling (HDRIs and the simple skies; the physical sky builds its own on the GPU)
- **`BVHRefitWorker.js`**: O(N) bottom-up BVH AABB refit for animated geometry (SharedArrayBuffer protocol)

### Animation & Transform System (`rayzee/src/viewer/animation/`, `viewer/overlays/`)
Full notes: [docs/design/ANIMATION.md](docs/design/ANIMATION.md) — both playback modes, pbrt frame sequences, the gizmo,
video export, the timeline and camera track, and each data flow (animation, transform, refit, video render).
- **`AnimationManager.js`** owns three's `AnimationMixer` (`play`, `stop`, `seekTo`, `setSpeed`, `setLoop`). **Deforming**
  (any SkinnedMesh or morph track): CPU skinning, handed to `refitBVH` as a per-mesh reader. **Rigid** (everything else):
  only the meshes whose matrix or visibility changed go to `applyPoseCallback` → `PathTracerApp._applyAnimationPose`.
  ⚠️ Never refit a rigid clip: triangles are shared between placements of one geometry, so baking a pose moves every copy.
- **pbrt animation** (`addons/archives/pbrt/PBRTAnimation.js`): a `frameN.pbrt` sequence loads as one clip at 30 fps.
- **`TransformManager.js`**: the translate/rotate/scale gizmo; drag end calls `app.updateMeshTransforms( indices )`. No
  shortcuts: the letter keys belong to walk mode.
- **`VideoRenderManager.js`**: offline export, frame by frame (seek → refit → accumulate → OIDN → capture); saves and
  restores engine state.
- **`TimelineManager.js`** + **`CameraTrack.js`** (`app.timeline`): authored tracks, each owning its keys and how it
  applies them; playback on three's `Timer`. ⚠️ three's `ZeroSlopeEnding` flattens only the start (the end tangent is
  half the last slope), so each end gets a mirrored key instead and time is clamped to the keys. Timeline keys are not
  saved cameras.

**Moving geometry: three paths, never mixed** (pitfall 11):
- **Rigid move** (gizmo, rigid clips): `SceneProcessor.updateMeshTransforms( meshIndices )` writes matrices and TLAS
  leaves and refits the TLAS top down; no geometry. ⚠️ Use this, not `refitBLASes`, for anything that only changed a
  transform: triangles are shared between placements of the same geometry, so baking world positions into them moves
  every copy.
- **Per-mesh deformation**: `refitBLASes( meshIndices )`, main thread.
- **Full refit** (deforming animation): `refitBVH( positions )` in a worker over SharedArrayBuffer; a reader returning
  null for an unchanged mesh makes it a partial refit.
- **Positions**: a per-mesh callback `( meshIndex, triCount ) => Float32Array` (preferred; may hand back one scratch
  buffer) or one scene-wide array of 9 floats a triangle — every triangle, meshes in `app.sceneMeshes` order (which
  includes the hidden ground-projection disk and split products), world space. Walking your own model instead of
  `sceneMeshes` silently misaligns either shape; both are length-checked and throw.

### State Management (`app/src/store/`, one file a store; `@/store` is its index)
Zustand-based stores with **automatic 3D engine synchronization**:
- `usePathTracerStore` - Rendering parameters with handlers that use `getApp()` from appProxy
- `useAssetsStore` - Model/environment loading state
- `useCameraStore` - Camera controls, DOF, walk speed, orthographic view height
- `useAnimationStore` - Clip playback, speed/loop, camera keyframes mirrored from `app.timeline` (`syncTimeline` on `TIMELINE_CHANGED`; the rules are the pure selectors `videoDuration` / `videoUsesTimeline`), video render
- Transform state (`transformMode`, `transformSpace`, `isTransforming`) lives in `useStore` with handlers that sync to engine via `app.transformManager.setMode()`
- Mesh/group visibility (`toggleMeshVisibility`, `setMeshVisibility`) lives in `useStore` — toggles `object.visible` on the Three.js object then calls `app.updateAllMeshVisibility()` to update the per-mesh GPU visibility buffer
- Pattern: `handleChange()` utility creates handlers that update both store state and the app, triggering `app.reset()` for immediate visual feedback

### React Hooks for Engine Integration
- **`useActiveApp()`**: Returns the current app instance, re-renders on app changes (uses `subscribeApp()` internally)

### Data Layout & GPU Optimization
Full notes: [docs/design/PATH_TRACER_SHADER_ARCHITECTURE.md](docs/design/PATH_TRACER_SHADER_ARCHITECTURE.md), "Data
Layouts" and "More on the scene buffers" — every buffer, buffer parts, folded leaves, grouped placements, copy
clusters and the instance table, with measurements.

**Triangle Data Layout** (20 u32 lanes per triangle = 80 B, 5 vec4s). The buffer is bound as
`uvec4`, so a reader binds `'uvec4'` and floats come back through `uintBitsToFloat`:
```js
// scene/BufferLayout.js - TRIANGLE_DATA_LAYOUT
FLOATS_PER_TRIANGLE: 20         // 5 vec4s; positions carry their own normal
POSITION_A/B/C_OFFSET: 0/4/8    // f32 xyz, normal packed in the spare .w lane
NORMAL_A/B/C_PACKED_OFFSET: 3/7/11  // oct16 (packNormalOct), ~0.03° worst case
UV_AB_OFFSET: 12, UV_C_OFFSET: 16   // f32
MATERIAL_FLAGS_OFFSET: 18       // materialIndex | side << 24 | shadowBlockerBits << 26
MESH_INDEX_OFFSET: 19
```
On the GPU rows 0–2 (positions + packed normals) are `triangleGeoAttr` and rows 3–4 (UVs, flags, mesh index)
`triangleShadeAttr`; the CPU records stay whole and `PathTracerStage._uploadTriangles` splits them. Kernels take
`triangleBuffer = { geo, shade }`; with no textured material the shade store is a `uvec2` a triangle (`withoutUV`).
⚠️ Read a row only through `triangleRow( tris, triIndex, row )` (`shaders/Common.js`), and pass the
hit's `instanceLeaf`: triangles of a shared geometry are in object space, not world space.

**Buffer parts.** Past `maxStorageBufferBindingSize` (Dawn: 4 GiB − 4) the BVH, geo and shade stores split into parts
of whole records (`StorageParts`, `shaders/ThreePatches.js`), read through `splitStorage` (`shaders/Common.js`). Every
part is a binding and Shade binds 5 others, so parts total ≤ 5 (`_assertBindings` refuses before upload).

**Two-Level BVH Layout** — `[ TLAS nodes ][ group trees | empty leaf ][ BLAS_0 ]…[ BLAS_M ][ copy records ]`;
`table.blasBase` is where the BLASes start. 16 floats (4 vec4) a node. Indices and leaf tags in slot `[3]` are **u32 bit
patterns** (`floatBitsToUint`): every index is below `BVH_MAX_INDEX` (2^30) and the tags above it. ⚠️ An empty scene's
tree is one empty triangle leaf (`emptyBVH()` in `RayzeeRenderer.js`): sixteen zeros read as an inner node whose
children are itself, and a CPU walk of the TLAS searched it forever.
- **Triangle leaf** (`TRIANGLE_LEAF`, 0x40000000): `[triOffset, triCount, 0, tag]`. **BLAS-pointer leaf**
  (`BLAS_POINTER_LEAF`, 0x40000001): `[rootNodeIndex, entry, visibility, tag]`, slots 4–15 the world-to-object rows;
  bit 30 of the entry (`TLAS_LEAF_IDENTITY`) marks a baked placement whose ray transform is skipped.
- **Folded leaves** (past `FOLD_LEAVES_TRIANGLES`, 40M triangles): leaves of ≤ 15 fold into the parent as
  `~( first << 4 | count )`, so a leaf node is `tag >> 30 === 1`. ⚠️ Rebase through `rebaseNodes` and refit through
  `BVHRefitter` — both read folded children.
- **Grouped placements** (`InstanceTable.setGroups`): instanced meshes sharing one `instanceMatrix` under one host
  transform are one TLAS entry a copy; members keep their placements (`entryOf` / `repOf`). A hidden member points at
  the empty leaf with `BVH_EMPTY_BOX` (an inverted box is entered everywhere).
- **Copy clusters** (past `CLUSTER_MIN_ENTRIES`, 1M entries): TLAS leaves of up to 4 neighbouring copies
  (`CLUSTER_LEAF`), each copy's rows a 48 B record after the BLASes. Traversal handles a copy with `Continue()`: an
  `Else` overflowed the JS stack building the island's Shade. ⚠️ Grouping copies of one object only (Morton order)
  made loose leaves and 2.2× the traversal time — the grouping, not the code.
- **Hybrid geometry**: single-use or emissive geometry is baked to world space behind an identity leaf; shared geometry
  stays in object space and the ray moves into it.
- **`InstanceTable`** is per **placement**: `sourceMesh[p]` names the template, `placementRunOf( template )` its run.
  ⚠️ Never index it with a mesh/template index. Transforms are runs read in place (`matrixRow( p )`); the first write
  copies a run (`_writeRow`), so a move never rewrites three's matrices.

## Key Development Patterns

### Event-Driven Stage Communication
**Critical**: Stages communicate via events, not direct coupling:
```js
// PathTracer emitting events
this.eventBus.emit('pathtracer:frameComplete', { frame, samples });
this.eventBus.emit('pipeline:historyReset');     // the core's restart signal, never a capability's name

// A temporal denoiser listening for events
this.eventBus.on('pipeline:historyReset', this.resetHistory.bind(this));
```

### Pipeline Context Texture Sharing
**Automatic texture passing** via context (no manual references):
```js
// Stage publishes outputs to context
context.setTexture('pathtracer:color', this.colorTarget.texture);
context.setTexture('pathtracer:normalDepth', this.normalDepthTarget.texture);

// Downstream stages read from context
const pathTracerColor = context.getTexture('pathtracer:color');
const denoised = context.getTexture('nrd:output');
```

### Progressive Rendering Modes
Engine quality tiers — the engine API takes `'interactive' | 'production'`:
- **Interactive** (`INTERACTIVE_RENDER_CONFIG`): Low samples (1 SPP, 3 bounces) for real-time navigation. Camera controls enabled.
- **Production** (`PRODUCTION_RENDER_CONFIG`): High quality (1 SPP, 20 bounces, OIDN). Full-frame. Camera controls disabled.

The app maps its UI tab labels (`appMode: 'preview' | 'final-render' | 'results'`) onto these engine tiers. The `'results'` tab is purely UI — when active, the app sets `app.pauseRendering = true` and disables controls directly; the engine has no `'results'` mode of its own.

Mode switching lives in app-store handlers `handleConfigureForPreview` / `handleConfigureForFinalRender` / `handleConfigureForResults` (in `app/src/store/pathTracer.js`), which delegate to the engine method `app.configureForMode( mode, { canvasWidth, canvasHeight } )` — `mode` is `'interactive' | 'production'`. `configureForMode()` applies `modePresetSettings( config )` (`EngineDefaults.js`) — the one list of settings a preset owns — via `settings.setMany`, toggles OIDN/controls, and calls `reset()`. `VideoRenderManager` saves and restores exactly that list, so a new preset-owned key goes there, never inline.

**While the camera moves** (interaction mode; "Fast Navigation" in the UI), `PathTracerApp` drops the render to display × `interactionRenderScale` and restores it 100 ms after the last move. Bounces and emissive NEE are untouched; the firefly limit is 8× the user's threshold (every moving frame is frame 0, where the limit is tightest). ⚠️ The wavefront reads its resolution from the **canvas backing store**, so the drop resizes that (`renderer.setSize( w, h, false )`) — `pipeline.setSize` alone is inert. The denoising manager keeps the full size, and the drop is skipped while OIDN is the live denoiser: a resize drops its motion history and shows the raw render until the next denoise (rebuilding the network itself costs only 5–45 ms on oidn-webgpu 0.6.0).

### Deterministic / Headless Rendering API
How to use it: [docs/guide/headless.md](docs/guide/headless.md). Inside, with measurements:
[docs/design/HEADLESS.md](docs/design/HEADLESS.md) — every method below in full, the exporters (HDR gain maps, EXR
layers, HEIC/AVIF), lockstep readbacks and background compiles.

On `RayzeeRenderer`, so the core has them too, except `runFinalDenoise()` (the viewer's):
- **`setDeterministicMode( enabled = true )`** — pins every wall-clock- and readback-dependent input (adaptive sampling,
  pixel freeze, the per-bounce early exit, GPU-sized dispatch, interaction mode, auto-focus, auto exposure), so N
  samples reproduce bit for bit; the RNG is already pure. Reversible; leaves rAF stopped.
- **`renderFrames( n, { reset, yieldEvery, onProgress, allowEarlyRetire } )`** — accumulates `n` samples, raising
  `maxSamples` through the settings handler (`completionThreshold` is a cached JS number) and calling `stopAnimation()`
  after `reset()`. ⚠️ **`renderFrames` and adaptive sampling are mutually exclusive.** A frame retired by
  `_isConvergedComplete()` stops advancing `frameCount`, so a fixed-count loop never reaches `n`; with adaptive on, pass
  `allowEarlyRetire: true` and compare the returned count against `n`.
- **`renderToBuffer( { colorSpace, preserveAlpha, source } )`** — pixels without the canvas. `'srgb'` tone-maps on the
  GPU (`PackedToneMapper`); the CPU's `toneMapToRGBA8` is the fallback (`toneMappedOn: 'cpu'`, `output.tonemap_fallback`).
  `source: 'accumulation'` (default) or `'display'` (what the Compositor resolves, denoised).
- **`exportImage( { format, bitDepth, … } )`** — PNG, JPEG, WebP, HEIC/AVIF (gain maps), OpenEXR and Radiance HDR.
  Writers in `output/ImageEncoders.js`, published alone as `rayzee/encoders`: never re-export them from `index.js` (that
  put them in every host's startup download). EXR layers: `albedo`/`normal` while aux is on, `depth` from
  `shaders/kernels/DepthPass.js`. `bench:node` reads every file back (`bench/tools/export-check.mjs`). ⚠️ Chrome (macOS)
  starts its first hardware video encoder of a browser launch in ~5 s; the Export window starts one on open
  (`prepareStill( 'heic' )`). ⚠️ In TSL an arrow `() => Break()` emits `break;` twice.
- **`renderUntilComplete( { reset, denoise, signal, drainEvery, onProgress } )`** — production's counterpart: adaptive
  sampling on, stops on the ceiling, convergence or time limit, one final denoise; shares `_traceFrame()` /
  `_completionInfo()` with `animate()`. Its readbacks run in **lockstep** (`setLockstepReadbacks`): read at frame 1, then
  every 4 frames, applied exactly 4 frames later; `render()` traces nothing while one is due and in flight, and every
  driver loop awaits `stage.readbackWait()` rather than spin. ⚠️ It turns interaction mode off meanwhile: that mode is
  a 100 ms wall-clock timer, and a loop with nothing awaited starved it (a bench hang). ⚠️ A moved camera never skips a
  lockstep readback (only interaction mode does): skipping it made the first render after a load differ.
- **`getProvenance()`** — plain JSON of what produced the image; `mode.lockstep` says whether this image was traced in
  lockstep from a lockstep reset.
- **`runFinalDenoise()`** — one awaited OIDN pass at the final tier (`DenoisingManager.denoiseOnce()`); OIDN must have
  been on while accumulating (the aux buffers are written only then). Failure records `denoiser.unavailable`.
- **`pathTracer.requestOutput( 'gBuffer' )`** compiles the denoisers' G-buffer writes in (`'hitDistance'` implies it).
  `PathTracerApp` asks for it; the bare core does on the first `setAuxGBufferEnabled( true )`.
- **Kernels compile in the background**: `_buildWavefrontKernels` ends in `_compileKernels()` (`compileComputeAsync`).
  Until it resolves `render()` traces nothing and `readbackWait()` returns the promise; `EngineEvents.SHADERS_COMPILING`
  brackets it; a newer build supersedes (`_kernelGeneration`); the debug kernel is `eager: false`. ⚠️ Time a first frame
  to `queue.onSubmittedWorkDone()`, not to `frameCount`: the old synchronous compile submitted after 0.2 s and the GPU
  finished it after 4 s.
- **`enableGPUTiming( bool )` / `getGPUTimings()`** — real GPU milliseconds; `pipeline.getStats()` times CPU encoding
  only. ⚠️ The `render` part overlaps the compute before it (Apple M-series): compare totals only between setups that
  draw alike.

`rayzee/src/viewer/Headless.js` is the supported entry point — `renderHeadless()`, `openHeadless()`, `captureHeadless()`
(`denoise: true` runs `runFinalDenoise()` and reads `'display'`). Its defaults are a batch renderer's (`strict`,
`deterministic`, storage off unless the host set it), and its `settings` apply before the load and again after it.
`bench/harness/boot.js` boots through it with `strict: false`, which is load-bearing: `strict` would abort a run before
the runner reported.

### Without a browser (`Platform.js`, `HeadlessCanvas.js`, `rayzee/src/node/`)
The published build renders in plain Node on Dawn. `npm run bench:node` renders the whole corpus that
way against the Chrome goldens (all 36 match, RMSE ≤ 0.0036); `-- --core` then renders it again with the renderer
core alone, which must match the full engine byte for byte (36 of 36). It also renders a Draco and a KTX2 (Basis)
glTF against uncompressed twins (`bench/node/fixtures/`, built by `bench/tools/make-compressed-fixtures.mjs`; three's
decoders served from `node_modules`, no network), `checker.glb` split into a folder (`.gltf`, `.bin`, a texture with a
space in its name) that must match it exactly, and runs `rayzee/examples/core-node.mjs` as a host would. A textured
glTF with an HDR or PNG sky matched Chrome within 0.05 of a level per 16² block.
- **No canvas ⇒ headless** (`new PathTracerApp( null )`, or `{ headless: true }`; `openHeadless` without
  one): `createHeadlessCanvas()` gives three.js a WebGPU context over a plain texture, `wake()` is inert
  and `animate()` throws — drive it with `renderFrames` / `renderUntilComplete` — and the overlay renderer
  and gizmo are not built. The InteractionManager stays: auto-focus picks through it.
- **`configurePlatform( { Worker, decodeImage, readFile } )`** is the seam (`readFile` serves `DownloadCache` the
  `file:` URLs Node's `fetch` refuses: OIDN weights and IES profiles from disk); `rayzee/node` (plain source, exported
  from `src/`, never bundled) has `nodePlatform()` and `NodeWorker` (Web Worker over `worker_threads`,
  data:/blob:, module or classic). Every engine worker starts through `createWorker( Ctor )`, which
  swaps the host class in for the global `Worker` while the bundled constructor runs — the inlined
  wrappers call `new Worker(…)` themselves. Use `hasWorkers()` / `hardwareThreads()`, never `typeof
  Worker` or `navigator.*` directly. ⚠️ `rayzee/node` must not import engine modules: a host has the
  dist's copy of Platform.js, and a second copy would hold its own, unconsulted state.
- three's DRACOLoader and KTX2Loader start their own workers with `new Worker(…)` after awaiting a decoder
  download, which `createWorker` cannot reach. Every glTF parse in `AssetLoader` runs inside
  `withHostWorker( task )` (`Platform.js`): where there is no global `Worker`, the host's class is lent as one
  for the whole parse (overlapping parses share one loan) and removed after. Without it a Draco model failed to
  load in Node with `Worker is not defined`.
- `decodeImage( bytes, mimeType )` decodes every glTF image through `platformImagesPlugin`, which
  replaces `parser.loadImageSource` (three's needs the DOM or createImageBitmap, and `self.URL` for an
  embedded image's blob URL), and LDR skies (`loadPlatformImage`, flipY on as TextureLoader leaves it).
  ⚠️ PNGs from real exporters carry bytes after IEND; `trimPNG` cuts them, or strict decoders throw.
  ⚠️ GLTFLoader turns a failed texture into none, silently — the plugin reports `texture.build_failed`
  and a strict host's throw is deferred to the end of the load (`_throwDeferred`). Archive, pbrt and USD images go
  through it too (`platformImageFromBytes`, else `createImageBitmap`); one nothing can decode is reported the same way
  and its surfaces render untextured — before, a textured USD threw `createImageBitmap is not defined` in Node.
  ⚠️ An image an extension decodes (KHR_texture_basisu → KTX2Loader) arrives with that loader: the plugin hands it the
  bytes (`loader.parse`), never `decodeImage` — before that no KTX2 texture loaded in Node. Without `decodeImage` and
  with no DOM (`hasImageDecoder()`), `missingImageDecoderPlugin` fails each image with what to configure; three's own
  path threw `self is not defined` and took the whole load down.
- Float and half-float maps (an archive's EXR, HDR or PFM) are clamped to RGBA8 first (`rgba8Pixels`): read as bytes
  they were noise in Node and failed the whole bucket in the browser (Blender's MaterialX bump maps are EXR).
- With no `createImageBitmap`, `TextureCreator.processOnCPU` packs raw pixels: exact when a layer fits
  its bucket, bilinear otherwise (`ResampleRGBA8.js`). A bucket over 8 MB packs in `PackWorker`, at
  most cores − 1 at a time; `platformImagesPlugin` keeps decoded images in SharedArrayBuffers so they
  cross without a copy. On the main thread it starved the BVH workers (busy 1.3 of 5): 24155522.glb
  loaded in 4.1–4.9 s in Node, now 2.1 s against Chrome's 2.9 s (1.7 s with textures stubbed).
  ⚠️ Vitest does not inline `?worker&inline` (a dev URL NodeWorker refuses), so the unit test drives
  PackWorker's handler in-process, and no corpus bucket reaches 8 MB: only a real textured model runs
  the thread. A failed worker packs on the main thread and records `texture.processing_fallback`.
- ⚠️ dawn.node 0.6.1 segfaults on `queue.writeBuffer` / `writeTexture` from a `SharedArrayBuffer` (the
  triangle and BVH stores, once a scene is large). `nodePlatform()` wraps `GPUQueue.prototype` to copy
  those out, 64 MB at a time, and so needs the `webgpu` globals installed first. `NodeWorker`'s
  bootstrap uses `process.getBuiltinModule`, never `require`: a thread inherits `--input-type=module`.
- ⚠️ three's `Animation.start()` calls `self.requestAnimationFrame` inside `renderer.init()` with no
  guard; `initWithoutFrameLoop` lends an inert one for that call (and stops the loop, pitfall 18).
  three's `FileLoader` constructs a `ProgressEvent` per streamed chunk; `nodePlatform()` defines one —
  the only global it sets.

### Degradation Contract (`EngineIssues.js`)
The engine degrades rather than fails — right for a viewer, backwards for a batch renderer. Every
degrade-and-continue site records a structured issue instead of only warning, and one policy decides
what that means: `new PathTracerApp( canvas, { strict: true } )` throws an `EngineIssueError` at the
point of degradation; otherwise read `app.issues` / `app.issueErrors`, or listen for
`EngineEvents.ISSUE`. `ISSUE_CODES` is **add-only API surface** — hosts pin a version and branch on
the strings, so never rename or repurpose one.
- Adding a site is one `this._issues?.record( code, message, detail )` call. The log is built first
  in the app constructor and injected into `RenderSettings`, `AssetLoader`, `SceneProcessor` →
  `TextureCreator`, and `RenderPipeline` (which records `stage.render_failed` once per stage+phase —
  a broken stage throws every frame).
- ⚠️ Any callback handed to a collaborator must be cleared in `dispose()`. `IssueLog.detach()` exists
  because `onIssue` captured the app and the most recently disposed app stayed reachable. Only
  `npm run bench:memory` catches this class — unit tests cannot.
- What nothing can continue past goes through `IssueLog.fail()` (records, then throws in any mode): `init()` rejects
  with `webgpu.unavailable` / `adapter.unavailable` / `device.unavailable`, the WebGPU error as `cause`. The engine
  requests the one adapter and device itself and hands three.js the device (`THREE_DEVICE_FEATURES` mirrors three's
  feature list); three destroys only a device it created, so `dispose()` destroys ours once three's teardown settles.
- `Promise.allSettled` swallows a strict host's throw; `TextureCreator` rethrows the first rejected
  result for that reason. Any new allSettled aggregation needs the same. Likewise a catch that
  retries or re-records must rethrow an `EngineIssueError` untouched.
- **App events** are `EngineEvents` values only. A renamed one keeps its old string in
  `LEGACY_EVENT_NAMES`, which `RayzeeRenderer.dispatchEvent` sends alongside until the next major;
  `addEventListener` warns once for any other name (a listener on a wrong name fails silently —
  the 7.28.0 rename cost a host four weeks).
- **`app.adapterInfo`** / exported `describeAdapter( adapter )` — flags SwiftShader, llvmpipe,
  lavapipe and WARP. `init()` throws outright when three.js has substituted a WebGL2 backend, since
  the wavefront path is compute-only and every frame would fail against an empty canvas.

### Settings Provenance & Render Profiles
- **`settings.getEffective()`** — every live setting as `{ value, source, routed }`. `source` is one
  of `SETTING_SOURCE` (default / host / scene-metadata / mode-preset); `routed: false` means stored
  but reaching no stage, which is how a typo becomes a wrong image.
- **Each layer declares its own settings.** `RenderSettings`' table is the core's alone and names no viewer piece;
  another layer adds a key with `settings.define( key, { default, apply, reset } )` (the viewer: `interactionRenderScale`),
  bringing its own default, and gets provenance, events, `serialize()` and reset like a core key. The viewer's rules
  for a core key go in the bindings it passes (`_settingsBindings`: `applyExposure` becomes auto exposure's compensation while that is on, `onCameraProjection`
  hands a motion-vector denoiser's view to OIDN for a panorama) — never `denoisingManager` in `RenderSettings`.
- **One set of defaults, each kept by its owner.** `ENGINE_DEFAULTS` (`EngineDefaults.js`) is exactly the settings
  table: every key a `RenderSettings` route of the same name, every route's default there (`engineDefaults.test.js`
  holds both ways), frozen. Starting state that is not a setting sits with its owner: `SKY_DEFAULTS` and
  `DEFAULT_SUN_PATH` in `environment/EnvironmentManager.js`, `DEFAULT_VIEW` (AgX) in `color/ViewTransforms.js`. Values read
  at one moment are stored-only routes read there — `maxTextureSize` and `areaLightIntensityScale` at load
  (`setMaxTextureSize()` also reprocesses now), `wavefrontSortMaterials` at the next kernel build. A viewer piece keeps
  its own beside its code — `DENOISER_DEFAULTS` (`viewer/denoise/DenoiserSettings.js`),
  `AUTO_EXPOSURE_DEFAULTS` (`viewer/picture/AutoExposure.js`), `LOCAL_EXPOSURE_DEFAULTS` (`viewer/picture/LocalExposure.js`),
  `AUTO_FOCUS_DEFAULTS` (`viewer/camera/CameraManager.js`) — and the app
  builds its store from those plus its own keys and menus (`app/src/Constants.js`: `CAMERA_PRESETS`, `SKY_PRESETS`,
  `CAMERA_RANGES`; its store keeps the names `bounces`, `debugMode` and `toneMapping`, which saved sessions carry).
  The render profiles are gone: the engine ships the viewer tuning (AgX, neutral saturation, the HDRI unrotated,
  `dofMode: 'look'`, glTF placeholder area lights at `areaLightIntensityScale` 0.1) and a host sets otherwise through
  `settings` — a batch renderer wanting the old `physical` sets `areaLightIntensityScale: 1` and `dofMode: 'physical'`,
  before the model loads. The `profile` constructor option throws, so a farm cannot keep passing it unnoticed.

### Materials and shading (`shaders/`, `materials/`)
Full notes: [docs/design/SHADING.md](docs/design/SHADING.md) — each item below with its packing slots, loaders, tests,
bench gates and measurements.
- **Material defaults**: `MATERIAL_DEFAULTS` (`EngineDefaults.js`) is the only fallback for a property a three.js
  material lacks, and `packMaterial()` (`materials/MaterialPacking.js`) the only writer of the material block;
  `app.getMaterialPropertySource( i, prop )` says where a value came from. Weights and roughnesses are clamped to [0, 1]
  (`UNIT_RANGE_PROPERTIES`). ⚠️ Never derive a default from another property: "metalness factor > 0.1 ⇒ IOR 2.5" made
  every ORM-textured glTF 4.6× too shiny on its non-metal parts.
- **Fresnel**: every dielectric interface uses the exact unpolarised Fresnel (`fresnelDielectric`, `shaders/Fresnel.js`);
  metals and iridescence stay Schlick. Regenerate the DFG LUT with `npm run bench:lut` if a lobe or sampler changes.
  ⚠️ `DistributionGGX` floors its denominator at 1e-30, not `EPSILON`: at `MIN_ROUGHNESS` the peak is ~1e-10, and a
  1e-6 floor cut D 8000× while the sampler drew the true lobe (`furnace-dielectric-smooth` gates it).
- **Exact mirrors**: a plain reflector authored below `MIN_ROUGHNESS` (0.05) gets roughness 0, the delta lobe
  (`DELTA_PDF`), whose MIS weights are all 1.
- **Diffuse transmission** (KHR_materials_diffuse_transmission), **diffuse roughness** (EON, in `diffuseLobe`) and the
  **clear coat normal** (its own normal, never the base's map) each reach every MIS site and both integrators through
  one function. ⚠️ EON's form is 0/0 at roughness 0 and only near Lambert in f32: roughness 0 branches to the old
  Lambert expression, bit for bit.
- **Material layers** (`MATERIAL_LAYERS`, `shaders/SceneResources.js`): clear coat, sheen, iridescence, anisotropy,
  subsurface, dispersion, diffuse transmission and diffuse roughness compile in only while some material has them
  (`materialLayers( builder )`, a plain JS `if`). ⚠️ Removing a layer's code must be exact for a material without it:
  the iridescence weight keeps `min( 0, diffuse )`, and a sampling link may go only because its weight is 0.
- **Glass** (`sampleDielectric`, `shaders/MaterialTransmission.js`): a facet drawn from the visible normals, the exact
  Fresnel at that facet picks reflection or refraction, weight G2 / G1(V) over the interface's albedo
  (`dielectricInterfaceAlbedo`, the DFG LUT's B/A); a draw on the wrong side of N ends the path. When transmission's
  lottery declines, Shade sets `material.transmission` to 0 so the opaque base is itself (it lost (1 − T) twice).
  Only refraction takes the base colour, √ of it a crossing (`transmissionTint`: a way in and out takes it once, as in
  Cycles); reflections stay the light's. ⚠️ Change the glass sampler, rerun `npm run bench:lut`; `furnace-glass-*` gate it.
- **Light through glass**: `traceShadowRay` crosses glass straight and returns a **colour** (`transmissionTint` of base
  colour × map per face, absorption per channel); `traceShadowRayRefractiveOpaque` (bidirectional) stays a float. A path
  refracted to an emitter is MIS-weighed from the last opaque scatter: the MIS ray length runs on across a refraction
  (path integrator only). Thin panes match refraction alone within ~1 %, thick blocks ±7 %. Compiled in only while some
  material transmits (`usesGlass`, like the material layers): otherwise shadow rays carry a float. `glass-tinted-light`
  gates it.
- **Transmission map**: factor × the map's R, in Shade and in shadow rays. ⚠️ `SceneProcessor` adopts every per-type
  texture list through `_adoptTextureLists` (`TEXTURE_LISTS`): a list kept from an earlier extraction drops that map
  type after `rebuildMaterials()`.
- **Displacement** (`shaders/Displacement.js`): three.js's meaning, marched in Shade, no tessellation. ⚠️ A point the
  march finds behind the base triangle is moved onto its plane: rays spawned below it all hit that triangle. ⚠️ Glass
  and subsurface: the relief is not geometry, so the triangle decides entering vs leaving, and only a reflection leaves
  from the relief; total internal reflection keeps chance 1.
- **Bump maps** step one texel of the map as authored (`BUMP_MAP_WIDTH`/`HEIGHT`, the bump transform's unused third row,
  written from `bumpMapSize` at extraction), never of the stored layer: packing stretches every layer to its array's
  size, so a 512² wall map packed with 1024² maps rendered at half strength, and adding a texture to a scene changed
  another's relief. ⚠️ A transform write skips that row (`updateTextureTransform`, elements 2 and 5).
- **Ray spawn points**: every ray leaving a surface starts at `offsetRayOrigin( p, n )` (`shaders/Common.js`), n the
  **facet** normal on the side the ray leaves. ⚠️ The hit record's `normal` is the interpolated one; the facet normal
  rides in its spare lane (`shaders/HitFacet.js`). ⚠️ Never a fixed distance; a shadow ray towards a sampled light point
  is re-aimed from that origin and stops `SHADOW_END` (1 − 1e-4) of the way. ⚠️ The hit point Shade rebuilds sits off a
  large triangle by t's own error: Extend moves the stored distance onto the triangle's plane (`surfaceOffset`), and the
  closest-hit test rejects t within its rounding error. ⚠️ Storing that correction in a slot of its own cost Extend
  10–15 % (it is memory-bound); shadow rays start lifted off their surface and skip it.
- **Shadow terminator** (`shaders/ShadowTerminator.js`, `shadowTerminatorOffset`, 0.1, Cycles' Geometry Offset): light
  and environment shadow rays from a smooth-shaded triangle start on its smooth surface. ⚠️ Shade's `Ngeo`/`NgeoFF` are
  the interpolated normal, not the facet (`facetN` is), and the hit keeps texture UVs, not barycentrics.
- **Fewer shadow rays** (`shadowRays`: `'two'` default, `'all'`, `'one'`; path integrator only): each kind of light
  offers its sample to `lightPick`, which stays unbiased; learned visibility in `shaders/LightVisibility.js`. ⚠️ `'one'`
  loses where a white sun and a blue sky are both in view — a sample carries one light's colour, not their mix.
- **Light radius**: a point or spot light with `userData.radius` is lit as Cycles' Soft Falloff (NEE only), compiled in
  only while some light has one.
- **Fog** (`shaders/Fog.js`; settings `fogDensity` per scene unit, `fogColor`, `fogAnisotropy`, `fogBounds`,
  `fogHeightFalloff`, `fogFloor`): a medium in a box, by default the models' bounds (`getModelBounds()`, no ground
  plane), so the sky and sun light it from outside; even, or thinning as e^(−falloff · h) above `fogFloor` (default
  the models' floor) with a closed-form optical depth and free flight (`fogOpticalDepth`, `fogFreeFlight`; falloff 0
  takes the homogeneous expressions exactly). Compiled in only while the density is above 0
  (`PathTracer._fogNeeded()`), path integrator only (else `setting.ignored`). Free flight in Shade before the miss
  branch; a scatter takes the lights, sky and sun MIS'd against the phase draw (`fogScatterLight`), point and spot
  lights and the emitters share one light along every segment, picked per segment and drawn equiangularly
  (`fogSegmentLight`), and every shadow ray takes the fog's transmittance (`traceShadowRay` via `SceneResources.fog`).
  ⚠️ The fog's shadow rays go through one call site (`traceFogLight`): each `traceShadowRay` call inlines the whole
  BVH walk. ⚠️ A segment's emitter point is drawn from a reference point in the span, so from either side
  (`sampleLightBVHTriangleAnySide`): drawn as surface NEE draws, the sides facing away from the reference were left to
  the phase draw at a weight below 1 (−1 %). The app turns its Thickness into a density by the models' longest side,
  its Height (Everywhere / Low / Ground) into a falloff halving the density at 25 % / 6 % of the models' height with
  the same haze over each spot of the floor, and gives an object seen from outside a cube around it and the camera (a
  box seen from outside shows its edges).
- ⚠️ `bench:ab` read +7–9 % on identical code for two scenes on one day: net any A/B of a self-run.

### State-Engine Synchronization Pattern
**Critical**: All UI state changes must sync with the app via `getApp()`:
```js
// app/src/store/ui.js - handleChange pattern
import { getApp } from '@/lib/appProxy';

const handleChange = (setter, appUpdater, needsReset = true) => val => {
    setter(val);
    const app = getApp();
    if (app) {
        appUpdater(val);
        needsReset && app.reset();  // Triggers immediate re-render
    }
};
```
Always use `getApp()` from `@/lib/appProxy` to access the app instance. Never use store setters directly for render parameters — always use provided handlers like `handleBouncesChange`, `handleSamplesChange`.

### Colour management (`rayzee/src/addons/color/`, `rayzee/src/color/`)
Full notes: [docs/design/COLOR_MANAGEMENT.md](docs/design/COLOR_MANAGEMENT.md) — the API, input resolution, baked views, the app's
panel and its labels, the startup view, and the shaper + table with its measurements.

`app.color` is an OpenColorIO pipeline: what textures and lights mean, the working space, and what is shown and saved.
**Inert until a host loads a config** — linear Rec.709, three.js's seven views, nothing converted. An add-on
(`rayzee/addons/color`): the core's `renderer.color` is `BasicColor` until `setColorManagement( ColorManagement )`
(`PathTracerApp` installs it). Shaders, `TextureCreator` and `EnvironmentManager` read it through `color/ActiveColor.js`,
never `ColorManagement.js` (`coreBoundary.test.js`). The engine never names the OCIO package: the host supplies
`ocioRuntimeFactory` / `ocioRuntimeUrl`. `ViewTransforms.js` is the one registry behind the canvas, both readbacks and
the menu. A view is baked to a log2 shaper + 65³ table — or, where that measures poorly, on linear Rec.709's axes (`pre`)
and at 97³, each kept if closer (`bakeView`); `MAX_TABLE_TRANSFORMS` is 12 (16 sampled textures a stage).
Colour issues are recorded with `warn()` (headless is strict). Environment modes are `'hdri' | 'procedural' | 'color'`;
the gradient sky is gone (`EnvironmentManager.restore` keeps an old session's on screen).
- ⚠️ Once a scene exists, load and unload through `app.loadColorConfig()` / `unloadColorConfig()`: only the config that
  converted the environment can convert it back. Back in linear Rec.709 it is recorded as `'native'`, never by the
  config's name for that space: recorded as Blender's "Linear Rec.709", an ACES config could not convert it again.
- ⚠️ An OCIO view returns display-encoded colour, the built-ins linear (`outputEncoded`). Get it wrong and every image
  is encoded twice.
- ⚠️ `library.addToneMapping` refuses to redefine an id: a rebake deletes the old entry and reuses the same
  `Data3DTexture` and TSL node, or canvas and readback run different tables.
- ⚠️ `setWorkingSpace()` must be followed by `applyColorWorkingSpace()`: it re-packs textures and materials, converts
  the environment in place and rebuilds the emitter list (`EmissiveTriangleBuilder` keeps its own colour copy).
- ⚠️ `SimpleSky` clears `userData.__rayzeeColorSpace` on every rewrite, or a new sky is never converted. The physical
  sky bakes straight into the working space.
- ⚠️ Grid index 0 is baked from exactly 0, or every render has a raised black floor.
- A display shown converted bakes from the view's light (a derived config holds each view transform as a colour space),
  as light or encoded, whichever is closer; a view stepping through a `.spi1d` after a grey value (False Color) is split
  there into the cube and a curve in the texture's extra slices. Both in docs/design/COLOR_MANAGEMENT.md, "Shaper + table".
- ⚠️ The Compositor draws a table view itself (`_viewQuadFor`), canvas and picture alike, never through three's output
  pass: that stores the frame in half floats first, and on Rec.709's axes a wider working space's rounding showed (a pure
  green in ACEScg, 51 levels of red in Filmic Log; the readback, reading floats, 1).
- **HDR on screen** (`app.color.setHdrOutput()`, off in the engine; the app follows `(dynamic-range: high)`): the canvas
  goes half-float, extended range, and shows the view's HDR version from the config (`hdrViewFor`; AgX → "AgX - HDR 1000
  nits"), decoded to 1.0 = 100 nits (`buildCanvasView`). ⚠️ It is not a registry entry and never reaches a readback:
  saved pictures go through `getCanvas()`, which draws the view itself (`compositor.renderPicture()`) into a 2D copy.
  ⚠️ The canvas format is three's `backend.parameters.outputType`, read at its next configure (`backend.updateSize()`).
  ⚠️ The HDR version is drawn through `outputNode`: three.js clamps a colour node at 0, which cut light outside the
  canvas's gamut. ⚠️ Chrome keeps the colour space and format a WebGPU canvas had at its first copy (drawImage,
  createImageBitmap) for every later one: after a Screen or HDR switch, thumbnails and video frames came out in the wrong
  colours (Display P3: 61 levels) or showed an old picture. The `configure` wrapper sets the canvas width again whenever
  either changes, which resets it. `toBlob` was never affected.
- **Saved renders in HDR**: the EXR a save keeps records how its picture was shown (`getProvenance().display` — the
  exposure, auto exposure's included, and a held backdrop — plus the viewer's `exposure.local`, in the file's `rayzee`
  attribute). The Results page shows it through `app.createPictureView( canvas )` (`viewer/picture/PictureView.js`): a renderer
  of its own on the main device running the same Compositor, LocalExposure and HDR version of the saved view
  (`color.hdrVersionOf`: the screen's own table while held, so the startup's needs no config), then the panel's edits after the view
  (`pictureGrade` in `app/src/lib/ImageProcessor.js`; `tests/gpu/pictureGrade.test.js` holds it to a JavaScript copy of
  `ImageProcessorComposer`'s GLSL, which runs in WebGL and so in no test).
  Against the live HDR canvas: mean 0.03 %, worst 3 %. A save from before this record, or under another config, shows
  its 8-bit picture.
- **Every display shows the light it would emit**: only sRGB and Display P3 are canvas encodings (`canvasFitOf()`
  measures it through the config); every other display's view is baked converted for the canvas (`ocio.emulated`,
  `ocio.canvas`), so screen, readbacks and pictures agree. The Screen switch keeps the tone mapping (`matchingView`).
  `tests/unit/addons/color/colorCombinations.test.js` holds every display × view × look on four configs.
- ⚠️ App: rerun `npm run color:bake` and upload `default-view.bin` and `default-view-hdr.bin` whenever the default config
  or view changes. The GPL-3.0 config files live on the CDN only, never in the repo. `describeConfig()` must carry
  `categories`.

### Physical sky (`addons/physical-sky/PhysicalSky.js`, `addons/physical-sky/AtmosphereModel.js`, `environment/SunPosition.js`, `addons/physical-sky/Atmosphere.js`, `addons/physical-sky/EnvironmentCDF.js`, `shaders/Sun.js`)
An add-on (`rayzee/addons/physical-sky`): the core bakes 'procedural' mode only through the class
`environmentManager.setProceduralSky( PhysicalSky )` installed, or `setProceduralSkyLoader( load )`, which imports it
the first time 'procedural' mode is baked — `PathTracerApp` does that, so the add-on is a chunk of its own that a
session without the physical sky never downloads — and records `capability.missing` without either. The core's own sun shading (`shaders/Sun.js`) imports only `environment/SolarLimb.js`.
Environment mode `'procedural'` ("Physical Sky" in the app). Bruneton's Earth constants (Rayleigh from
Bodhaine 1999, ozone, Ångström aerosols from turbidity), 16 spectral bins of 25 nm → CIE 1931 → linear
Rec.709, baked on the GPU into a 1024×512 equirect in the engine's own mapping (row 0 = nadir).
Multiple scattering is Hillaire 2020 extended: the incoming field is kept per (height ×
azimuth-from-sun) cell, three orders are computed explicitly (ground bounces included) and only the tail
uses 1/(1 − f). Against the Monte Carlo reference in `tests/gpu/skyReference.js`: day within ~6 %,
sunset ~8 %, twilight ~16 %; plain Hillaire was 25 % dark at the horizon and 2–5× bright at twilight.
- **Nothing leaves the GPU.** The sky is computed per equirect row × 256 azimuths from the sun (π·s²,
  mirrored: radiance depends on elevation and that azimuth only) and filled into the equirect; the
  importance-sampling table is built beside it (`addons/physical-sky/EnvironmentCDF.js`, the GPU twin of
  `EquirectHDRInfo.computeCDF`, compared in `tests/gpu/atmosphere.test.js`, packed as `packExactTable` packs it);
  both are copied into
  textures created without pixels (`source.dataReady = false`). Only the table's two normalisers come
  back, a few frames later — the frames between use the previous bake's. ⚠️ Such a texture has no
  `image.data`: `buildEnvironmentCDF`, `convertTexturePixels` and the other CPU readers skip it, and
  `_isPhysicalSky` marks what `EnvironmentManager` must not dispose (`PhysicalSky` owns it).
- **Cost** (GPU, M-series). Sun move: sky 1.2 ms + table 0.46 ms (was ~5 ms plus an 8 MB readback, a
  worker CDF and an upload). Air change (turbidity, ozone, air density, ground, sun size): +24 ms of
  multiple scattering. First bake compiles, ~250 ms. ~70 MB of GPU buffers, freed when the mode is left.
  `generateProceduralSkyTexture()` bakes at once — one bake per task, up to 4 queued
  (`SKY_BAKES_IN_FLIGHT`) — and resolves once the environment has caught up. Dragging Time of Day bakes
  on every slider event: 120/s on the camera scene, 67/s at a steady 60 fps on the 1.9M-triangle test
  model. ⚠️ Never debounce it: the store's 10 ms trailing debounce never fired during a drag (slider
  events come every 8–16 ms), and serialising each bake on its stats readback capped it at 16/s.
- **Rendering cost:** the sun is one more NEE pass per bounce (~1.8 ms/frame at 1024² on
  `anisotropy-brushed`) — ⚠️ the Preetham sky it replaced never registered its sun light
  (`numDirectionalLights` stayed 0), so `main` comparisons read that as a regression.
- **The sun is not in the texture.** It is drawn and sampled analytically: `hasSun`, `sunDirection` (world),
  `sunRadiance` (disc average, working space), `sunParams` = (cos half-angle, solid angle, 1/sin², horizon
  dip). NEE is pass 1 of the environment loop in `calculateDirectLightingUnified` (2D dim +9); its BSDF
  partner is the miss branch, MIS'd through `RAY_FLAG.SUN_NEE` (set at an opaque scatter whose direction
  NEE could have drawn; transmission leaves it clear so the sun shows through glass at full weight).
  Limb darkening (Hestroffer & Magnan 1998) and the sky's horizon apply to both.
- `refreshSun()` rotates the sun by the environment rotation and converts it to the working space — call
  it after either changes (`setEnvironmentRotation` and `applyColorWorkingSpace` do).
- Units: physical luminance / 683 × `SKY_RADIANCE_SCALE` (1/32), so a clear noon lights the ground at
  bundled-HDRI levels. The app's `SKY_PRESETS` carry an `exposure` (EV) making up ~⅔ of what a low sun loses.
- ⚠️ `EnvironmentManager.callbacks.onReset` is the **renderer's** reset: a bake lands after its input, often once
  the render loop is idle, and the stage's reset alone never woke it (UI edits did nothing on screen).
  `callbacks.onLightingChanged` (a new environment) emits `pipeline:lightingChanged`, which auto exposure listens for.
- ⚠️ A model load installs `meshScene.environment` (the HDRI slot) only in HDRI mode (`loadSceneData`):
  otherwise a model loaded under the sky swapped the startup HDRI in with the sun still on — lit twice.
- Sessions carry `skyModel: 'atmosphere'`; sky keys from older sessions are ignored (same names, other meanings).
- App panel (`PhysicalSkyControls.jsx`): Preset, Time of Day, Sun Direction, Haze; the rest sits behind each
  row's ⋮. Time of day goes through `sunPosition()` (`environment/SunPosition.js`, solar time, month,
  latitude) with north along −Z; presets aim for their sun *height* on the chosen date
  (`timeForSunElevation`), so Golden Hour stays golden in December. "Set sun by: Angles" edits the raw angles.

### Bidirectional integrator (`integrator: 'bidirectional'` | `'vcm'`)
Full notes: [docs/design/BIDIRECTIONAL.md](docs/design/BIDIRECTIONAL.md) — frame order, strategies, the source table, lights at
infinity, the light guide, lamps, the exact environment table, MIS, storage, verification, measurements and vertex
merging.

An add-on (`rayzee/addons/bidirectional`): `BidirectionalIntegrator` (`addons/bidirectional/`) owns its uniforms, buffers,
kernels and frame steps; `PathTracer` calls it through integrator hooks (`beginFrame`, `beforeShade`, `afterShade`,
`resolve`, `allocate`, `registerKernels`, `bounceKernels`, …) once `registerIntegrator()` has it (`PathTracerApp` does). Shade and
Generate take its functions from `uniforms.lib`; controls are on `pt.activeIntegrator`. `'path'` compiles exactly the
unidirectional kernels (everything is JS-gated on `params.bidirectional`). Light subpaths start on every light;
strategies are camera hits, NEE, one light-vertex-cache connection per camera vertex, light tracing to a pinhole, and
with `'vcm'` vertex merging; Georgiev's dVCM/dVC MIS, power heuristic. Shared with the path tracer: a camera path at the
bounce limit takes one more segment flagged `RAY_FLAG.EMISSION_ONLY` (the BSDF-hit partner of the last NEE), and the
environment's exact table (`environment/EnvironmentExactTable.js`) serves both integrators' NEE and the miss weight.
- ⚠️ A new integrator plugs into the same hooks; never add `if ( bidirectional )` to `PathTracer`.
- ⚠️ Light tracing obeys the camera's face culling (`traverseBVHShadowCameraCulled`).
- ⚠️ A light path ends where light arrives from below the shading normal; geometry terms use the exact facet
  (`exactFacetN`), not the hit record's 11-bit one.
- ⚠️ Glass blocks the bidirectional shadow rays, so in a glass scene the integrators legitimately differ; the unbiased
  reference is the path tracer with emissive NEE off.
- ⚠️ A light subpath carries importance: undo refraction's (n1/n2)², swap V and L in the BSDF, apply the shading-normal
  correction (`lightEndCosine`).
- ⚠️ Emitter side tests take a **unit** winding normal (`sideAccepts` has a ±1e-4 threshold).
- ⚠️ An alias table for the environment doubled a furnace's noise (it breaks stratification). Shade is near a register
  limit and binds 8 of 10 storage buffers: measure Shade changes in place (`bench:kernels`).
- Check one strategy with `pt.activeIntegrator.setBidirectionalStrategy( 'hit' | 'nee' | 'connect' | 'lightTrace',
  { alone } )`. Bench: `cornell-`, `lamps-`, `caustic-`, `sky-bidirectional`, `mirror-caustic-vcm`.

### Denoising Pipeline Coordination
- **One denoiser owns the live view** — `Real-Time Denoiser` is a one-of-N choice (`DENOISER_STRATEGIES`: None / NRD /
  **OIDN**; the engine starts on none, the app on OIDN), and `Final Denoise (OIDN)` is the separate question of whether the
  finished image gets a pass. Two live denoisers would mean paying for one whose result the other
  covers. Any other name records `denoiser.unavailable` and runs none; `'nrd'` in a panorama runs `'oidn'`. A live refresh that
  ends after OIDN stopped owning the view is not shown. ASVGF and EdgeAware were removed (2026-10): OIDN
  beat both still and moving, EdgeAware passed raw frames through while the camera moved, and ASVGF made converged
  images worse than none.
- **Every denoiser publishes a texture; the Compositor picks the newest.** `nrd:output`, `oidn:output` — the viewer's `_displaySources()`
  hook is the priority list (first published wins; the core's is empty), handed to the Compositor, and
  `DenoisingManager._clearDenoiserTextures()` is the list that wipes them. A new denoiser goes in both. There
  is one canvas: OIDN writes its result into a picture on the card (`ExternalTexture` wrapping a raw
  `GPUTexture`) rather than painting a second canvas. The only other canvas belongs to the **AI
  upscaler**, which works in ordinary pixels and shows a picture larger than the render.
- ⚠️ **"Hold the last clean frame" is not a rule, it is the absence of one**: while `oidn:output` is
  published the Compositor keeps drawing it, so a reset shows the previous denoised frame instead of
  dropping to noise. `abort( canvas, { keepDisplay } )` decides whether it stays.
- ⚠️ **`animate()` does not always trace.** While the view is moving and a denoise is in flight, the
  frame is skipped (`DenoisingManager.skipsTrace()`): accumulation is off, the canvas shows the
  denoised picture, and the next denoise reads the newest frame — so tracing it only starves the
  denoise. Measured inside a room at 512²: 19 → 42 refreshes/sec.
- ⚠️ **The closing denoise redraws through `_presentDisplay()`, never `refreshFrame()`.** Waking the
  loop made a finished render nothing had marked complete (`renderFrames`, a video export) look newly
  finished, and it denoised the same image a second time.
- A **final render suspends the live refresh** (`setCadenceSuspended`, first statement of
  `configureForMode`): it shows its own accumulation and denoises once at the end. Leaving it running
  denoised the image twice and raced the renderer's output-pass rebuild.
- **OIDN motion history** (`viewer/denoise/OIDNTemporalHistory.js`, `oidnTemporalHistory`, default on): while
  OIDN owns the live view, each restarted frame is blended into a reprojected per-pixel history and
  live refreshes denoise that instead of one fresh sample (independent 1-spp inputs are what boils).
  It needs the NormalDepth stage (jitter-free depth, roughness, and `pathtracer:instanceLeaf`, which
  NormalDepth writes only when `setInstanceLeafOutput( true )`). It is dropped, with NormalDepth, at a
  size the cadence has proven too slow to denoise while moving (`_movingHopeless`), through a final render and in a panorama. Shiny
  pixels and pixels of moved objects keep ~2 frames: reflections and a moving object's lighting do
  not follow the surface, and following a rotating object with a long history measured worse. Still
  frames merge the history in, fading out over 16 samples; the final denoise always reads the plain
  accumulation. ⚠️ Each pixel takes ONE history pixel and shared picks split their length: bilinear
  history, or copies, is correlated noise and OIDN keeps it as grain. ⚠️ Clamping history to the
  noisy frame's neighbourhood darkens the image — don't. `reset( true )` and
  `reset( false, { motion: true } )` keep the history; any other reset, including the path tracer
  resetting itself unannounced, drops it. Code that moves a placement calls
  `denoisingManager.notePlacementMoving()` first (`_notePlacementsMoving`) so the history follows it.
- **OIDN model swaps** (refreshes run the cheap tier, the finished image the chosen one) cost 10–50 ms
  on oidn-webgpu 0.6.0, and `OIDNDenoiser._fetchWeights` keeps each model's bytes, so a swap never
  re-downloads. ⚠️ A `[Buffer "outputPass"] used in submit while destroyed` error is **oidn-webgpu's**
  output pass, not three.js's: a tile's writes land a microtask after it starts, so a UNet must not
  be disposed under a run in flight — `_loadUNetWeights` aborts it and yields a macrotask first.
- ⚠️ `output/ToneMapGPU.js` is a second implementation of `toneMapToRGBA8` and must stay
  bug-compatible with it, rounding included. It serves the neural passes (packed half input) and
  `renderToBuffer`'s sRGB readback (float texture input, alpha kept). `tests/gpu/toneMapParity.test.js` checks the two on
  Dawn in Node, and `bench:upscale` again in Chrome before anything else. Its `output: 'planar'` mode feeds the
  AI upscaler's network float planes encoded with a 2.2 power, not the sRGB curve — what the upscaler always used.
- **OIDN sees the frame inside a 16 px mirrored border** (`OIDN_BORDER`, `oidnInputSize()`), each side then rounded
  up to 16. At the network's own boundary — its zero padding, or oidn-webgpu repeating the edge pixel up to a
  multiple of 16 — the outer pixels came out worse than not denoising at all. Outer 3 px against a 2048-spp
  reference (four scenes, 250×140 to 1500×844, 1–64 spp): 0.4–0.7× of 0.4.0's error; 0.5.0 alone was 1.3× worse at
  the bottom at 4 spp. A multiple of 16 keeps the frame on the network's pooling grid, so pixels away from the edges
  denoise exactly as without it (an 8 px border moved them ±2 %). One compute pass packs all three inputs, border
  included (`_copyInputs`); autoexposure meters the frame only; the tile cap applies to the frame, so the border
  never splits a frame that fits one tile. Cost: 3–11 % more denoise time, most on small frames. The cap is an area
  (`tileSize`² with the border): oidn-webgpu's cost and memory follow the tile's area, so a wide frame that fits stays
  one tile (1280×720: 22 ms, against 33 ms as two). ⚠️ No tile may pass `OIDN_MAX_TILE_PIXELS` (65,535 × 64, halo
  included): its first layer dispatches a workgroup per 64 pixels in one dimension, and past that the GPU rejects the
  work with no `error` callback and `done` reports a denoise that never ran (a 2560×1600 frame at `tileSize: 2048`).
  `_resolveTileSize` clamps any cap to 1808. The pack also zeroes NaN and ±Inf (0.6.0 makes +Inf the largest float,
  which blew up into a blob) and counts them per input: `denoiser.non_finite_input`, once until a clean frame.

### Auto exposure (`viewer/picture/AutoExposure.js`, viewer)
Meters `pathtracer:color` on the GPU, adapts on the CPU. Two kernels in one pass: tiles (≤ 64×64, ≥ 8 px a side) averaged in
linear light, weighted by the path tracer's coverage (alpha), then a 256-bin log2 histogram whose percentile-clipped mean
(fractional bins) is read back. By the backdrop (`pathtracer:backdrop` state): the environment (also seen through windows)
is metered in full, a transparent one weighed out by coverage, and under a solid colour only fully covered pixels count —
a partly covered one (an edge, a window onto the backdrop) carries the backdrop's colour. Counting a grey backdrop around
a dollhouse view had moved the exposure +1.2–1.7 stops on one Livspace room and −0.9–1.2 on another; a window onto it,
0.08. **A solid backdrop is held**: the Compositor (`setBackdropExposure`, the viewer passes the manual exposure) and every
tone-mapped readback (`_displayGain().backdrop`, `PackedToneMapper` / `toneMapToRGBA8`'s `heldGain`) show it at the manual
exposure with no local exposure gain, blended by coverage; local exposure builds from fully covered pixels too. So neither
auto exposure nor the backdrop's colour moves the other (app: the backdrop reads 99 at auto 0.52 and 4.10 alike; a room
moved 0.02 levels from a grey to a black backdrop, was 7). The neural super-resolution input has no coverage (alpha 1),
so its output shows the backdrop at the picture's exposure. ⚠️ `pathtracer:color`'s alpha is coverage in every backdrop
mode (FinalWrite no longer forces 1): whatever shows or reads it makes it opaque unless `transparentBackground` — the
Compositor, `renderToBuffer`, the AI upscaler's HDR capture. A new reader of that alpha does the same. Averaging before the log is what keeps a 1-spp image metering like
the converged one (24155522.glb, 1080p: the old per-pixel log drifted 1.06 stops from 1 to 256 spp). Large tiles skip whole
8×8 blocks, never single pixels: a skipped pixel's memory is fetched anyway. It meters only when no reading is in flight,
less often as samples grow (`meterInterval`), and luminance is taken in the working space.
- It aims at `blendExposureEV( room, view, strength )` (`autoExposureStrength`, default 0.3; 1 = follow every view): a room
  level, learned over ~4 s of camera motion and moved in full with every reading under a still camera (the viewer's
  `_noteExposureView()` tells the two apart), goes through a curve that damps it to `strength` within 1.5 stops of the
  manual exposure and follows it fully past 3; the view adds its difference from the room at `strength`. Averaging to grey
  is what made it milky: on five Livspace rooms, 4 views each, the view-to-view swing was −1 to +2.35 stops at 100 %,
  ±0.85 at 30 %; a sky 16× dimmer under a still camera is still corrected in full. A camera switch re-meters afresh.
  ⚠️ "Every reading", not only the first after a restart: a final render traces frame 0 with one bounce (renderMode 1),
  and a room held at that reading exposed design (9).glb's finished image +2.10 stops (milky) where Gently gives +1.00.
  `autoExposureMinExposure` / `MaxExposure` (default ±8 stops, Bevy's range) cap only where the exposure
  lands. ⚠️ Never clamp the view's reading before the blend: a scene needing +6 with a ±2 range read as "lit near its
  exposure" and was damped to +1.07 instead of landing on +2.
- The exposure moves in stops: `update()` every loop frame from `_beginFrame` eases (`adaptExposureEV`: speed in stops/s
  while far, exponential within 1.5 stops) while the image restarts every frame, and lands in ~0.3 s (`LAND_SECONDS`)
  once it has two samples; `advance( seconds )` eases once a frame in video time (VideoRenderManager); `instant` snaps
  (a host's choice). The eased tail took ~8 s to land a 1.4-stop change, so a 16-sample render finished at 0.8 s and
  drifted on for 7 more; now 0.48 s, at completion. Every finished render is read once more and landed on
  (`_finishImage()`), before RENDER_COMPLETE and the closing denoise or upscale (`_announceComplete()` in the loop), so a
  saved image has its own exposure; with auto exposure off it returns null and completion stays synchronous. A final render keeps the exposure it starts with until 8 samples (`holdSamples`): snapping to each
  reading, its 20 bounces read a 0.4-stop dip and back within 0.2 s at 2–8 samples. `_settling()` keeps a finished
  render's loop running until it lands. The manual exposure is its compensation (`setCompensation`).
- ⚠️ Never clear the in-flight reading from a reset, nor reuse the ReadbackBuffer while it is mapped: the old stage did on
  every camera move, and 236 of 237 readings failed silently — the exposure never moved while the camera did.
- ⚠️ `onChange` wakes only a finished render's idle loop: `renderFrames` and a video export drive frames themselves.
- Cost a metering (Dawn, Apple M-series): 540p 0.03 ms, 1080p 0.08 ms (every pixel), 4K 0.12 ms.

### Local exposure (`viewer/picture/LocalExposure.js`, viewer; off in the engine, on in the app)
Unreal Engine 5's: a bilateral grid of log luminance (cells of 128 px, 32 one-stop bins of exposed luminance) blended
60/40 with a blurred 1/32 picture as the base layer; the base's contrast around middle grey is scaled
(`highlightContrast`, `shadowContrast`; the app's Balance Highlights amount 40 % = 0.6) and detail kept (`detailStrength`). It
changes only what is shown, as a per-pixel gain before exposure and the view, written three ways in that file — the
compositor's TSL (`gainNode`, installed with `compositor.setDisplayGain`), WGSL for `PackedToneMapper`'s `gain` (every
tone-mapped readback, the AI upscaler and the neural passes, through the core hook `_displayGain()`), and JavaScript
for the CPU tone map (`pixelGain`) — kept identical by `tests/gpu/localExposure.test.js`. Canvas vs readback: 0.5
levels, the readback's usual bias. EXR stays scene-referred. The grid is built from `pathtracer:color` on restarts and
the metering schedule: 0.05 / 0.13 / 0.5 ms at 540p / 1080p / 4K (Dawn, M-series); the compositor's gain +0.05 ms at
1080p. Under a solid backdrop (`pathtracer:backdrop` 'color') the grid and the blurred picture take fully covered pixels
only, the blur carrying that share and dividing it out after both passes, and the backdrop takes no gain (see Auto
exposure); otherwise unchanged. ⚠️ The compositor reads its position from `screenUV` (y down = texture row 0); `uv()` is not guaranteed to be.
The app's `DEFAULT_STATE` turns it on (the engine stays off, so a farm keeps its look); `applyPanelToEngine()` in the
store puts the panel's live denoiser and auto and local exposure on the engine at startup and after a session restores the panel. The app
shows only Auto Exposure (Follow View: Gently / More / Fully = strength 0.3 / 0.6 / 1), Exposure and Balance Highlights
(Amount); metering, range, shadows and detail stay engine-only, so a session cannot carry a value no control shows.

### Asset Processing Workflow
1. **AssetLoader** loads GLB/GLTF models with automatic camera extraction. The core reads glTF/GLB, `.hdr` and LDR
   images (`CORE_FORMATS`); every other format is a descriptor registered with `assetLoader.registerFormat()`
   (`addons/formats.js` — the `rayzee/addons/formats` add-on; `PathTracerApp` registers `allFormats`), read
   through one shared path (`_loadModelWithFormat`). glTF's Draco, KTX2 and meshopt decoders are imported per file:
   `decodersOnDemand` (`GLTFDecoders.js`) wraps `loader.parse` and searches the JSON for the extension names first.
   An archive's inner models go through the same registry; pbrt's EXR maps use the archive importer's own EXRLoader
   (`_exrLoader`), registered or not. On the core-browser example the host's main chunk went 577 → 534 KB gzip and the
   seven model-loader chunks are no longer emitted.
2. **GeometryExtractor** converts meshes to the 20-lane triangle records, baking single-use and emissive geometry to world space and leaving shared geometry in object space; records per-mesh `meshTriangleRanges`. It never rewrites a host's own geometry (`userData.__rayzeeExternal` subtrees are left alone), and anything skinned or morphed is given triangles of its own so a refit cannot pose every copy at once.
3. **SceneProcessor** builds two-level BVH (TLAS/BLAS): per-mesh BLAS via `BVHBuilder` (parallel for large meshes via `Promise.all`), then `TLASBuilder` builds SAH tree over mesh AABBs, then assembles combined buffer `[TLAS | BLAS_0 | BLAS_1 | ...]`. A mesh past `SPLIT_MESH_TRIANGLES` (2M) is built as spatial pieces (`bvh/SplitBLAS.js`): its records are sorted in place into pieces of ≤ 512k by halving at the centroid median of the longest axis, each piece is built by a pool worker, and the halving becomes the nodes that join them. It holds the mesh once, in the store — one build across every core held a second copy plus 44 B a triangle of scratch. Images bit-identical, frame time unchanged (22M ocean + mountain, three views, within 3 %). ⚠️ The joined BLAS travels as parts (`nodeParts`), never one array: a 610 MB request failed an 80M build with memory to spare. ⚠️ Pivots are sampled with a fixed seed: first/middle/last took a thousand passes on a terrain grid's repeating rows.
4. **TextureCreator** generates GPU textures for materials (runs in parallel with BVH build)

A failed load reports itself through `LOADING_UPDATE { failed: true, status }` from
`_loadWithSceneRebuild` (`ARCHIVE_NEEDS_ELEMENT` → `LOADING_RESET`, `LOAD_IN_PROGRESS` → nothing, the
other load owns the status). ⚠️ Only the scene build used to: a failure in the parse left the app's
overlay spinning on its last step with the File menu blocked. Drag-and-drop still resets the overlay in
its own `finally`, so a failed drop shows only the console.

### Folders, archives, pbrt and USD
Full notes: [docs/design/SCENE_IMPORT.md](docs/design/SCENE_IMPORT.md) — folder loading, partial archive loads, pbrt (budgets, parse
memory, lights, shapes, templates, materials, formats) and USD (layers, composition, translation, parts, budgets, the
Moana island measurements), and what Blender's glTF exporter loses of a scene's lights.

- **Folders**: `loadFile( { files } )` loads a folder as the same folder zipped would (`localFolder()` →
  `ArchiveImporter.loadFolder` → the archive path). Archive entries are lazy Blobs, read only when a loader asks.
- **Archives and pbrt** are an add-on (`rayzee/addons/archives`, `addons/archives/ArchiveImporter.js`), reached through
  `assetLoader.setArchiveImporter()` or `setArchiveImporterLoader( load, ARCHIVE_FORMATS )`. `.tar` is read in place,
  `.tar.gz` unpacked once into OPFS `archives/`, `.zip` read through its central directory. `loadFile( file, { element } )`
  takes one element path or an array. Past `ARCHIVE_ELEMENT_PROMPT_BYTES` (4 GB) a multi-element archive throws
  `ARCHIVE_NEEDS_ELEMENT` (the app's part dialog), on the seekable `.tar` path too. Budgets: `maxTriangles` 45M /
  `maxPlacements` 6M, or 120M / 60M with memory spill (`SPILL_TRIANGLE_BUDGET`).
- **USD** (`addons/archives/usd/`, same add-on; a `.usdz` stays with three's USDLoader): our own crate reader (three's
  parsers are not usable), on-demand composition (`USDStage.js`), translated into the pbrt builder's IR (`USDScene.js`).
  Past `USD_ELEMENT_PROMPT_BYTES` (1 GB) it throws `ARCHIVE_NEEDS_ELEMENT`; a counting pass fits curves and point
  instancers to the budgets (`USDSceneReader.fit`), and meshes are never thinned. MaterialX networks (`outputs:mtlx:surface`)
  are read in `USDScene.js` (OpenPBR, Standard Surface, glTF PBR, BSDF graphs; values fold to constant / texture + gain +
  UV matrix); three's MaterialXLoader is not used — it builds TSL materials the path tracer cannot run.
- **Parameters it does not honour** are reported as pbrt's `ReportUnused` does: a lookup through `param()` (or `pFloat` /
  `pString` / `pBool` / `resolveSpectrum`, which use it) marks a parameter used, and `ParamUsage` counts each translated
  directive's unmarked or `approximated()` parameters per `directive type: name`, recorded once as
  `asset.parameters_ignored` (a warning). ⚠️ A translator reads a value through `param()`, never `params.x.value`, or
  that parameter is reported ignored; a bare `params.x` is a presence check (or a read that is no use: hashing, freeing).
- ⚠️ Anything that changes what the same pbrt files build bumps `PBRT_BUILD_REVISION`, or a stored graph of the old
  build is reused.
- ⚠️ Keep the template grouping (templates at identical transforms become one): without it Moana's trees rendered 60 %
  slower.
- ⚠️ A `.ply` is shared by every shape naming it and freed only by its last direct user (`_lastPlyUse`).
- ⚠️ A shape inside `ObjectBegin` keeps its whole transform and a placement's goes on top — never relative to the
  transform at ObjectBegin.
- ⚠️ `material.clone()` drops the engine's own properties (diffuse transmission, subsurface): use `cloneMaterial`.
- ⚠️ The builder frees a shape's arrays after merging it: hand an array over once (`own()`).

### Storage (OPFS) (`rayzee/src/addons/storage/`, `rayzee/src/storage/`)
Full notes: [docs/design/STORAGE.md](docs/design/STORAGE.md) — areas and the cache budget, the entry protocol, I/O, locks, identity,
the scene cache, scene state, sessions and projects, render checkpoints, and memory spill in full.

`app.storage` is a `StorageManager` over the origin private file system, shared per `cacheNamespace`
(`acquireSharedStorage`). It is `null` where there is none (private windows, Node) — **every caller must work without
it**; failures record `storage.*` warnings and fall back to memory. An add-on (`rayzee/addons/storage`, installed with
`renderer.setStorageOpener()`); the caches that use it (`DownloadCache`, `CDFCache`, `BLASCache`, `SpillStore`,
`GeometrySpill`) stay core and import area names from `storage/StorageAreas.js`. Areas are `cache` (one shared budget, evicted
least-recently-used), `user` (never evicted) or `scratch` (`spill`, cleared at open). Also here:
`app.exportSceneState()` / `importSceneState()`, the app's sessions and `.rayzee` projects, and render checkpoints
(`captureRenderCheckpoint()` / `restoreRenderCheckpoint()`).
- ⚠️ An entry's `meta.json` is written last (no meta = invisible); `create` removes the old entry first, so anything
  rewritten often alternates between two keys.
- ⚠️ `EntryWriter.write` copies its data before its first await. Download revalidation is a 1-byte `Range` GET, never
  HEAD (the asset host's CORS allows GET only).
- ⚠️ The scene-cache codec carries colours and `ior` exactly (`exactColors`, `exactIor`): `Material.toJSON` rounds both.
  It decodes a file once for all the textures that read it: decoded per texture, each took its own array layer.
- ⚠️ A stored pbrt graph gets its `meta.json` only once the engine has accepted the load
  (`assetLoader.commitPendingGraph( model )`, end of `_loadWithSceneRebuild` / `_onAssetLoaded`); a failed, superseded
  or disposed load aborts it. A new replace-load seam must commit too, or nothing is ever stored.
- **Memory spill** (`memorySpill`: `'auto'` default | true | false): `RayzeeRenderer._planSpill` decides per build;
  `'auto'` spills a static scene past `SAFE_SCENE_BYTES`, and ordinary models never do. A spilling scene of more than one
  chunk is extracted and built together; its three.js geometry goes to disk during the build (and stays there past
  `GEOMETRY_ON_DISK_BYTES`); after the load the matrix lists, TLAS, copy records and order maps go too
  (`spillAfterLoad`), are read back per edit (`whenTLASEditable()`, `ensureMovable()`) and go back 30 s later.
- ⚠️ `refitBLASes` throws on a spilled scene until `await app.ensureSceneResident()`; picking skips the model while its
  geometry is on disk.
- ⚠️ A shared buffer handed to the storage worker lives until that worker collects garbage: `transferable()` copies it.
  Views taken with `viewAs` keep chunk memory alive.
- ⚠️ The streaming build's wait races a timer, never a settled promise (that spun in microtasks and hung the tab).

## Development Commands

### Debug Visualizations (visMode uniform)
Access via Path Tracer tab → Debug Mode (`shaders/Debugger.js`; modes 1–10 run the one-pass `DebugKernel`):
- `1` Normals · `2` Depth · `3` Albedo · `4` Emissive · `5` Indirect (GI) · `6` Environment reflection
- `7` Triangle tests · `8` Box tests per camera ray (value = count ÷ `debugVisScale`; red when over)
- `9` Stratified samples · `10` Environment luminance
- `11` NaN / Inf (in FinalWrite, bypasses accumulation)

⚠️ Mode `1` perturbs normal maps in the fallback `cross( up, N )` frame, not Shade's UV tangent frame
(`triangleUVTangent`), so it cannot show whether a normal map is oriented right: compare lit renders.
`tests/gpu/uvTangent.test.js` holds that frame to the tangent of the transformed UVs, mirrored and
turned `KHR_texture_transform`s included.

### Performance Profiling
The engine emits `EngineEvents.FRAME` once per `animate()` tick. Hosts attach their own stats panel (e.g. `stats-gl`) — the app does this in `app/src/components/layout/Viewports/StatsPanel.jsx`. Other built-in profiling signals:
- Triangle intersection counters in shaders
- BVH construction timings and split statistics
- Memory usage tracking for texture arrays
- Progressive rendering convergence monitoring

## Critical Implementation Details

### Pipeline Architecture
Event-driven stage pipeline with TSL compute kernels compiled to WGSL. All engine code lives in `rayzee/src/`. The path tracer is a pure-wavefront renderer: `PathTracer extends PathTracerStage`, where the base delegates to 5 sub-managers: `UniformManager`, `MaterialDataManager`, `EnvironmentManager`, `ShaderBuilder`, and `StorageTexturePool`. External code (other stages, PathTracerApp) accesses sub-managers directly — e.g., `stage.uniforms.get()`, `stage.materialData.*`, `stage.environment.*`. See `docs/design/PIPELINE_ARCHITECTURE.md` and `docs/design/PATH_TRACER_SHADER_ARCHITECTURE.md` for details.

### Memory Management
Material texture arrays pack in `TexturesWorker`, each layer drawn straight into the full array
(chunking only when that allocation fails: the size-triggered chunking it replaced allocated the
whole array anyway and copied every chunk twice — 7 × 4096² took 1.1 s, now 0.23 s). A bucket of
≥ 8192² source pixels splits across up to 4 workers drawing into one SharedArrayBuffer
(`_packAcrossWorkers`, largest sources dealt first — downscaling an 8K map is ~175 ms, a map at size
~20 ms), when the page is cross-origin isolated. Times Square 8K: textures 1.1 s → 0.5 s, load
2.1 → 1.7 s. A bucket over 2 GB of source streams through a worker (`processInWorkerStreaming`),
resized on the main thread as `processOnMainThreadStreaming` does. ⚠️ Every path keeps its own
resampling: `worker-direct` scales by `drawImage`, the others by `createImageBitmap` — moving a
resize to another thread or call changed thousands of bytes a bucket.

⚠️ **`PathTracerStage.sdfs` is not the processor that built the scene** — `RayzeeRenderer._sdf`
is. The stage's own is a leftover of the old `stage.build()` path; its `rebuildMaterials` may only
upload materials and textures from it. Re-uploading everything (`updateSceneUniforms`) put its empty
emissive data and instance table in place of the scene's, and emitters stopped being sampled.

**Texture arrays' CPU pixels** are released right after they are uploaded (the texture's
`onUpdate`): nothing reads them again, since a rebuild packs new arrays from the three.js
sources. −716 MB on 24155522.glb. They are dropped, not returned to `SmartBufferPool`, which would
keep them alive; a cache lookup then sees `userData.buffer === null` and rebuilds.

**Replaced arrays are freed once nothing binds them.** A material rebuild (a colour-space or texture edit) packs new
arrays, binds them, then frees the ones bound before (`PathTracerStage.rebuildMaterials`); the next load frees a
rebuild's (`SceneLoading`). Kept, the load's set stayed beside the new one: 716 MB more on 24155522.glb after any colour
change. A bucket left empty points at its node's own placeholder (`refreshBucketTextureNodes`), never a freed array.

**Material images are decoded only to be packed.** Every glTF image three's ImageBitmapLoader would read, embedded or a
file of its own (`browserImagesPlugin`; in Node every glTF image, `platformImagesPlugin`; Safari's TextureLoader is not
covered), and every image of a folder or archive carry a reader (`setImageReader`, `materials/TextureCreator.js`); a PNG
or JPEG arrives without pixels, its size from its header (`imageHeaderSize`), and the packer holds a group's images while
it packs them (`holdImages` / `releaseImages`, counted per source) and lets them go, `image` then `{ width, height, data:
null, thumbnail }` (128 px, the app's preview). A rebuild decodes them again (24155522.glb 0.68 → 0.79 s). Chrome, tab
after a GC: Bistro 5.2 → 1.5–1.8 GB, peak 6.3 → 3.4–3.6 GB, load 15–20 → 9–11 s; 24155522.glb 1.56 → 1.13 GB (peak 2.6 →
1.5), as a .gltf with its images beside it 1.77 → 1.16 GB. A glTF keeps its image files' bytes as Blobs, which Chrome holds
in its browser process: +0.13–0.17 GB there on 24155522 (an archive's are slices of its files). ⚠️ Compare tab memory
after a GC (a heap snapshot forces one): main's tab carried ~1 GB of garbage for seconds after a load, and either side
read up to 0.8 GB high until it ran. ⚠️ Code that reads a material map's pixels holds it first (the pbrt builder's
`_readPixels`, released when the build ends). ⚠️ An archive unpacked to OPFS (`source.transient`) hands its images over
as copies: that storage can be evicted once the load lets go of it.

**A large bucket is never whole in memory.** Past `PACK_GROUP_BYTES` (256 MB) TextureCreator packs it 256 MB of layers
at a time and hands each group to its `layerSink` (`textureLayerSink( renderer )` in `PathTracerStage.js`), which writes
it straight into the GPU array (created with `source.dataReady = false`). Each group is packed by the whole bucket's
strategy and size (`dims` through every `process*` path and the worker), so its bytes are a whole pack's. Bistro (pbrt,
278 2K maps beside 4 GB of decoded images) held 1.7 + 2.3 GB arrays until the upload: the second failed to allocate, or
Chrome killed the tab. Now the tab peaks at 6.3 GB (7.3 GB in the app). ⚠️ Free each group at once (`transfer( 0 )`) and reuse one
SharedArrayBuffer across groups: left to GC, a dozen dead groups (+3.3 GB) piled up first.

**Uploads in Chrome.** Every `writeBuffer`, `writeTexture` and `mappedAtCreation` goes through a shared memory pool
mapped in both the tab and the GPU process; it grows to the most ever sent before the GPU caught up and is kept until
the page closes (reused, never shrunk; destroying the buffer does not return it). Measured on Chrome 154: 1 GB in 64 MB
writes left 1 GB behind, in 8 MB writes too; awaiting `onSubmittedWorkDone` after each left 64 MB, in the same time.
So big uploads are paced: chunk uploaders return `stage.drainUploads()` and the spilling build awaits it,
`SceneProcessor.uploadChunks` sends a multi-chunk store chunk by chunk before `uploadToPathTracer` adopts it, and
texture arrays go up 64 MB at a time (`uploadTextureArrays`, writing the GPU texture itself; three.js otherwise sends
every layer in the first frame). 24155522.glb: pool 1,054 → 412 MB; the startup scene 330 → 35 MB; bistro 1.9 GB →
under 0.2 GB. ⚠️ A single upload still takes a block its size: the environment (392 MB on the Moana island) goes in
one `writeTexture`. With no emitter active the bit-trail map is a 4-float placeholder (Shade reads it only while
`emissiveTriangleCount > 0`): one over every triangle was 446 MB on the island, in the tab, on the GPU and in the pool.

**CPU memory (`memory/HostMemory.js`)** — the scaling wall for a large scene is not RAM, it is
contiguous ArrayBuffer *address space*, and how much of it a process can hand out falls as the host
stays up. A 40M-triangle Moana needs ~7.3 GB and a fresh renderer places 7.0–9.5 GB, so the same
build loads after a reboot and fails after a long session.
- `estimateSceneBytes({ triangles, placements, geometryBytes })` prices a scene before extraction.
  `SceneProcessor._preflightMemory()` runs it and applies two lines, both recording
  `ISSUE_CODES.SCENE_MEMORY_BUDGET`: above `SAFE_SCENE_BYTES` (7,040 MB) it **warns** and builds
  anyway; above `MAX_SCENE_BYTES` (9,216 MB, override with `config.maxSceneBytes`) it **throws**.
  The hard line exists because past it the renderer process is killed rather than throwing —
  measured on Moana, 40M (7.3 GB) and 45M (8.5 GB) load and render, 50M dies at 9.4 GB resident
  with nothing caught and nothing logged. There is no degrading past that, only refusing early.
- `probeAddressSpace( bytes )` measures what can still be placed. ⚠️ **Only cheap when small.**
  8.6 GB of 64 MB buffers costs 102 ms on an idle page and never shows as resident; the same probe
  taken while the parser holds 3.6 GB pushes the renderer to 9.2 GB and doubles a 40M load
  (135 s → 268 s). Probe one build step, at the moment that step runs — see
  `_checkAssemblyHeadroom()`, which tests only the combined BVH right before it is allocated.
- `app.getHostMemoryInfo()` returns the preflight, per-phase allocations and live samples for the
  last build. ⚠️ `performance.memory.usedJSHeapSize` does **not** count SharedArrayBuffer, and the
  triangle and BVH stores are SAB-backed, so the browser's own heap reading under-reports a large
  scene by gigabytes. Use this instead.
- Measured at 40M: peak live 7,350 MB against a 7,289 MB final resident set. The BLAS→BVH handoff
  already releases as it fills, so there is no build transient left worth attacking — the only
  remaining lever is the resident set itself (the three.js geometry mirror is 1,832 MB of it).
  With `memorySpill` that mirror is on disk for the build (`storage/GeometrySpill.js`, see Memory
  spill in `docs/design/STORAGE.md`) and read back when it ends.

### Shader Data Access Pattern
Materials and BVH data accessed via storage buffer lookups in TSL:
```js
// Standard pattern in TSL shaders
const getDatafromStorageBuffer = Fn(([buffer, index, offset, stride]) => { ... })
```
BVH traversal (`BVHTraversal.js`) uses stack-based DFS with two-level dispatch: TLAS inner nodes → BLAS-pointer leaves (per-mesh visibility read from the leaf's slot [2]; skip BLAS if hidden, else push BLAS root onto stack) → BLAS inner nodes → triangle leaves (inline Möller-Trumbore + inline side culling via the per-triangle side flag, flags word bits 24–25). Both `traverseBVH` (closest hit) and `traverseBVHShadow` (any hit, early exit) gate on mesh visibility. ⚠️ Side culling is for what the camera sees: Extend culls only a ray not yet `REDIRECTED`, or one flagged `UNDER_SURFACE` (a scatter the shading normal sent under its own facet — without it the low-poly furnaces lose energy). Every other bounce, like every shadow ray, hits both sides: culled bounces passed through hollow single-sided models (open-bottomed furniture) and lit the floor beneath them. A single-sided emitter a bounce hits from behind emits nothing, as NEE never samples it there. The visibility flag is packed into the TLAS BLAS-pointer leaf by `TLASBuilder.flatten()` and patched at runtime by `PathTracerStage._patchTLASLeafVisibility()` — there is no separate visibility buffer.

### Camera & DOF System
Thin lens in `shaders/CameraRay.js`, with two ways to size the aperture (`dofMode`, default `'look'`):
- **look** — radius = `dofBlur` × `focusDistance` × tan( fov / 2 ): a far background blurs by `dofBlur` of the image
  height at any scene scale. Aperture, focal length and `unitsPerMetre` are ignored. Orthographic, tan( fov / 2 ) is 1:
  a point half the view's height behind the focus plane blurs by `dofBlur`, wherever the camera stands.
- **physical** — `focalLength / 2N` mm × `unitsPerMetre` × `apertureScale`. At true size a small object behaves like
  real macro: wide open, a 4 cm watch that fills the frame is all blur.

Both focus on a **flat** plane: `focusDistance` is depth along the view axis, measured by `viewDepth()`
(`viewer/camera/InteractionManager.js`; a panorama focuses along each ray). Auto-focus resets on a new model or camera
(`resetAutoFocus()`), falls back to the orbit target's depth when nothing is under its point, and pauses in a
panorama rather than switching to manual. Its CPU raycast (stock three.js, no BVH; 6.7 ms on Sponza) runs again
only when the view, the AF point or `stage.resetCount` changed — every scene change resets the render, so
anything that moves geometry without a reset leaves focus stale. The app's `CAMERA_PRESETS` are settings patches (`dofBlur` plus the lens) with
no field of view or focus distance, so a preset never moves the camera. `dofBlur` is a per-camera effect;
`dofMode` is not. The app's panel is a **Simple | Pro** switch over `dofMode`, remembered in localStorage.

**Clip start** (`camera.userData.clipStart`, uniform `cameraClipStart`): an imported camera's near clipping plane, as
Cycles honours it — camera rays start on a plane that far in front of the camera (`cameraClipDistance`, a sphere for a
panorama), so a camera behind a wall sees through it (Blender's Barbershop interior). Set from a USD `clippingRange`
only when authored (UsdGeom's fallback of 1 would clip every camera) and from glTF `znear` (`cameraClipPlugin`); carried
by `_placeAt`, saved views and sessions; 0 on the default camera, whose `near` is the viewer's own (maxDim / 100) and
never clips. ⚠️ Every camera-ray site honours it: Generate and Debug kernels, NormalDepth (its depth stays measured
from the camera), bidirectional light tracing (no splat in front of the plane, shadow ray ends on it, the skipped length
rides in mis_ray_t), and picking / auto-focus (`raycaster.near`).

**Orthographic** (`cameraProjection: 'orthographic'`, uniform id 2 in `CAMERA_PROJECTION_IDS`): rays are parallel and
start on the camera's image plane (`cameraRayOrigin()` in `shaders/CameraRay.js`). The live camera is a `ViewCamera`
(`scene/ViewCamera.js`), a PerspectiveCamera that switches its own projection, so every holder of it — both
controls, picking, the gizmo, the overlays, the path tracer — follows without being re-pointed; three.js reads the
type from `isPerspectiveCamera` / `isOrthographicCamera` and the frustum from `top`/`bottom`/`left`/`right`, which
it derives from `orthoHalfHeight`. The wheel changes `zoom`, not the camera's position, and `cameraManager.orthoHeight`
(world units, zoom included) is reported by `EngineEvents.ORTHO_HEIGHT_UPDATED`. Turning orthographic keeps what the
view showed at the orbit target; turning back moves the camera to keep it. Ortho is per camera (an imported
OrthographicCamera, or one left orthographic, comes back so); a panorama stays global. The denoisers all keep
working: NormalDepth, MotionVector, NRD (its `gOrthoMode`: constant view vector, pixel footprint that does not grow
with depth) and the OIDN history reconstruct each pixel from that image-plane origin.
⚠️ Anything that bakes the camera's type at build time has to rebuild on a switch — `OutlineNode` picks its depth
conversion once, which is why `OutlineHelper` rebuilds itself (and `OutlineNode.dispose()` empties the selection
array it was given, so copy it first).

**Walk mode** (`cameraManager.setNavigationMode( 'walk' )`, `viewer/camera/WalkControls.js`) rides on the OrbitControls
rather than replacing them: it turns off their gestures, moves only while `controls.enabled` (so every existing
lock — gizmo drag, AF placement, final render — applies), and keeps `controls.target` ahead of the camera,
because `controls.update()` re-aims the camera at the target every frame. A held key moves the camera from
`animate()`, so the key-down wakes the loop *after* the key is recorded as held.

## Common Pitfalls & Solutions

1. **Store Updates**: Always use provided handlers (e.g., `handleBouncesChange`) rather than direct setters — they sync with the app via `getApp()`
2. **App Access**: Always use `getApp()` from `@/lib/appProxy` to access the app instance
3. **TSL Hot Reload**: TSL shader changes hot-reload normally via Vite
4. **Worker Data Transfer**: Use transferable objects for large arrays to avoid main thread blocking
5. **BVH quality**: the builder is binned SAH plus reinsertion. Treelet restructuring was removed (2026-10): on five models it bought ≤0.6 % tree SAH, no measurable render speed, for 2–24× the BLAS build time. Judge any new tree post-pass by render time per sample, not SAH alone
6. **Resolution Scaling**: Path tracer resolution independent of UI — use `app.setCanvasSize( width, height )` (pixel dimensions, applied immediately; internal `_applyRenderResize()`). Requested size is clamped by `MAX_STORAGE_TEXTURE_SIZE` (`_isRenderSizeSupported`). Note: `onResize()` (reads `canvas.clientWidth/Height`) is debounced 300ms; `setCanvasSize()` is not.
7. **React Compiler**: Uses React Compiler plugin — avoid manual memoization patterns that conflict with automatic optimization
8. **Feature Guards**: Check stage availability before accessing optional stages (e.g., `app.stages.nrd?.enabled`). A bare `RayzeeRenderer` has only `stages.pathTracer` and `stages.compositor`
9. **BVH Leaf Markers**: slot `[3]` is a u32 bit pattern — `TRIANGLE_LEAF` (0x40000000) or `BLAS_POINTER_LEAF` (0x40000001), both above `BVH_MAX_INDEX`, so `floatBitsToUint(nodeData0.w) >= BVH_MAX_INDEX` means leaf — except in a folded BVH, where a folded left child also sits above it (from 2^31) and the test is `tag >> 30 === 1`. They live in `scene/BufferLayout.js`, which imports nothing, so the worker-side `BVHBuilder`, `BVHLeafFold` and `BVHRefitter` import them rather than keeping copies.
10. **InstanceTable Entry Order**: Entries are indexed by `meshIndex` (positional). Use `setEntry()` with explicit index, never push-based insertion, to avoid ordering bugs with mixed sync/async BLAS builds.
11. **Transform vs Deformation vs Animation**: a rigid move uses `updateMeshTransforms()` (matrix only — no vertex pass, no BLAS work, no triangle upload). Deformation of specific meshes uses `refitBLASes()` (per-mesh, sync, main thread). Animations use `refitBVH()` (full scene, async, worker). Don't mix them — the worker path operates on SharedArrayBuffer that must match the combined TLAS/BLAS layout. Build the positions buffer from `app.sceneMeshes`, never from your own model root (see **Moving geometry** above).
12. **Mesh Visibility**: Controlled per-mesh at the BLAS-pointer level in BVH traversal, NOT per-material. Use `app.updateAllMeshVisibility()` after changing `object.visible` on any Three.js object/group — it walks the parent chain to resolve world-visibility and patches the visibility flag into each TLAS leaf (slot [2]) via `_patchTLASLeafVisibility` (no separate GPU buffer). Material-level `visible` was removed from the pipeline. Front/back/double-side culling is handled inline in `traverseBVH` via the per-triangle side flag, for camera rays only (see Shader Data Access Pattern).
13. **Partial storage uploads**: three.js uploads an attribute whole only when its `updateRanges` is empty — any pending `addUpdateRange` cuts a later `needsUpdate = true` down to that range. Full uploads therefore clear ranges first (`PathTracerStage._updateStorageBuffer`). Without that, the TLAS-leaf range a visibility patch leaves at load swallowed the refit that followed it (`refit-deform` read +16.6 %).
14. **No module-level shader state**: a TSL function's body runs when its kernel *compiles* (often the first dispatch), not when the JS builds the graph, so a module variable is read from whichever renderer or stage set it last. Per-renderer resources (material buckets, shadow albedo maps, gobo/IES textures, the alpha-shadow switch) ride in the kernel's build context instead: `withSceneResources( kernelCall, resources )` at the root, `sceneResources( builder )` in a function body (`shaders/SceneResources.js`). A kernel that reads them without the context throws. `bench:node -- --core` runs the core beside the full engine to hold this. Colour management stays page-wide by design (one OCIO runtime).
15. **Pass values, not expressions, into a Fn that loops**: an argument expression is generated where the Fn first reads it. If that read sits in a `Loop` after a `Break()` that can fire first, every later read sees zero. The bidirectional emitter-hit weight passed `origin.sub( … )` to `calculateLightBVHPdf`; a one-node light tree left the walk before reading it, so the pdf was measured from the world origin (+6 % on a grazing-lit floor, since the integrator landed). `.toVar()` the argument.
16. **A TSL `select` is per channel only from three r187** (#34425): before it, `ConditionalNode` built a vector condition
   as one `bool` that followed its first channel, and a view's encode showed green 0.055 on magenta where 0 belongs. The
   colour encodes keep `mix( a, b, step( edge, x ) )`, per channel on any version.
17. **A TSL branch callback returns nothing**: `If( c, () => v.assign( x ) )` hands back the assign node, which
   `ConditionalNode` reads as a return value — it warns "Return statement used in an inline 'Fn()'" and comments a
   `return` out. Give every `If`/`Else` callback a block body.
18. **three's frame loop is stopped**: a three.js renderer asks for a frame every display refresh from `init()` for as
   long as it lives, drawing or not (mrdoob/three.js#29712, closed as not planned). Idle, the canvas's and the overlay's
   cost 2 % of a core in the tab and 0.9 % in the GPU process; stopped, under 0.05 % and 0.1 %. `initWithoutFrameLoop`
   stops it (every renderer, `createRendererOnDevice` too) and `takeFrameStep( renderer )` takes three's step (node
   frame id, per-frame counters) once for each frame drawn: the render loop, `renderFrames`, `renderUntilComplete`,
   the video export, `_presentDisplay`, the overlay's `begin()`, the picture view. ⚠️ A new place that draws outside
   those takes the step first: the selection outline renders once per frame id, and `getKernelGPUTimings` reads the
   newest frame's passes. It reaches into `renderer._animation`: re-check on each three.js upgrade. ⚠️ r187 starts the
   loop from every `render()` and `compute()`, so `initWithoutFrameLoop` also blanks the instance's `start()`.
