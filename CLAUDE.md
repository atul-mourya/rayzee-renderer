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
- `npm run build:engine` - Engine library only: the full engine (ESM + UMD), `rayzee-core.es.js` and `addons/*.es.js` (ESM)
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
- `npm run bench:ab -- main` - gate perf against another git ref (same-session interleaved A/B)
- `npm run bench:exposure` - auto (and local) exposure against neither, wall clock (`-- --size 1024x1024`)
- `npm run bench:list` - show the scene corpus
- `npm run bench:storage` - raw OPFS throughput (write / read / `File.slice`), isolated and not; `--firefox`, `--engine`

Baselines are **machine-specific** (the wavefront path budget derives from device limits, and
single- vs multi-chunk are different code paths); the suite refuses to compare across a
mismatched GPU fingerprint. Perf absolutes are a monitored trend, never a gate — only the A/B
comparison gates.

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

Optional scope: `feat(asvgf):`, `fix(tsl):`, `refactor(pipeline):`, etc.

**A change to default pixels is a breaking change.** Anything that changes what a render looks like
when a host sets nothing — a default setting (the core's or a viewer piece's), a mode preset, light units,
a sampling or BSDF change that moves the goldens — gets a `BREAKING CHANGE:` footer saying how default
renders change, so semantic-release makes it a major. Farms pin a major to pin a look and calibrate
against it; 7.28 → 9.1 moved their image by 29.5/255 with no breaking note. Two tripwires:
`tests/unit/constants/pixelDefaults.test.js` snapshots the defaults (core and viewer pieces) and presets (update with
`-u`, then add the footer), and `bench:bless` names every golden that moved on the same GPU.

## Monorepo Structure

**Key import patterns**:
- Engine imports in app code: `import { PathTracerApp, EngineEvents } from 'rayzee'`
- App proxy: `import { getApp } from '@/lib/appProxy'` (the `@` alias resolves to `app/src/`)
- Constants from engine: `import { PRODUCTION_RENDER_CONFIG } from 'rayzee'`

## Architecture Overview

### Modern Event-Driven Pipeline (`rayzee/src/Pipeline/`)
**Recently refactored from pass-based to stage-based architecture**:
- **`RenderPipeline.js`**: Orchestrates stage execution order with shared context and event bus
- **`RenderStage.js`**: Base class for all rendering stages (replaces Three.js Pass pattern)
- **`PipelineContext.js`**: Shared state, textures, and uniforms between stages
- **`EventDispatcher.js`**: Loose coupling via events (e.g., `pathtracer:frameComplete`, `pipeline:historyReset`)

### Core Rendering Stages (`rayzee/src/Stages/`)
**Execution order matters** - stages run sequentially. The renderer core builds only PathTracer → Compositor; the viewer's
`_createExtraStages()` inserts NormalDepth, MotionVector, NRD, ASVGF, Variance, BilateralFilter, EdgeFilter,
AutoExposure and LocalExposure between them:
- **`PathTracer.js`** + **`PathTracerStage.js`**: Pure-wavefront Monte Carlo path tracer with MRT outputs. `PathTracer` (the wavefront renderer) extends the `PathTracerStage` base (shared engine/scene infrastructure).
- **`ASVGF.js`**: Real-time spatiotemporal denoising
- **`NRD.js`**: Port of NVIDIA NRD's ReBLUR (recurrent blur) denoiser — strategy `'nrd'`; reads roughness from `pathtracer:shadingNormal.w` (NormalDepth) and the secondary hit distance from `pathtracer:albedo.w` (written by Shade at camera depth 1, only because NRD asks for it: `pathTracer.requestOutput( 'hitDistance', { encode } )`, with its own normalisation). Progressive-aware: passes the frame through untouched once the input has `handoverFrames` samples. See `docs/NRD_DENOISER.md`. ⚠️ TSL shares texture bindings by texture uuid — every deferred-read `TextureNode` in a kernel needs its own placeholder texture (see `readNode()` there).
- **`EdgeFilter.js`**: Spatial-only edge-aware à-trous filter (no temporal history)
- **`LocalExposure.js`**: Unreal Engine 5's local exposure — a display-only per-pixel gain (see Local exposure below)
- **`OverlayManager.js`** + **`helpers/`** (in `managers/`): visual helpers, drawn at **view resolution** (canvas bounding rect × DPR — so viewport zoom counts), never at the path tracer's render resolution. Two layers: a 3D scene layer (`ViewOverlayRenderer` — a transparent canvas with its own WebGPURenderer sharing the main `GPUDevice`; hosts light gizmos, the transform gizmo, and `OutlineHelper`) and a 2D HUD canvas (`TileHelper` — OIDN-denoise / AI-upscale progress borders). Both are separate canvases, so helpers can never be baked into saved images. The scene layer's renderer is created and initialised at startup, but its surface (~30 MiB) is allocated only when a helper first becomes visible, and it parks itself (`display:none`) when none are.

### Rendering Engine (`rayzee/src/`)
- **`RayzeeRenderer.js`** (entry `core.js`, published as `rayzee/core`): the renderer core — WebGPU device, scene build, path tracer + compositor, loading, reset, `renderFrames` / `renderToBuffer`, dispose. It builds no denoiser, camera controls, gizmo, overlay or timeline, and `tests/unit/core/coreBoundary.test.js` fails if its imports reach one. Capabilities install on it from `rayzee/addons/*` (`formats`, `physical-sky`, `archives`, `bidirectional`, `color`, `storage`); `PathTracerApp` installs all six itself. See `docs/CORE_AND_ADDONS.md`.
- **`PathTracerApp.js`**: the viewer, `extends RayzeeRenderer` — camera manager, interaction, gizmo, overlays, timeline, animation playback, denoisers and picture stages, gobo/IES, scene state, mode presets. It plugs in through the core's hooks (listed under "Hooks" at the end of `RayzeeRenderer.js`; each runs at a fixed point of the frame, reset or load sequence). ⚠️ Viewer code goes in the viewer: a core method that needs it gets a hook, never a `this.denoisingManager?.` call.
- **`PathTracer.js`** + **`PathTracerStage.js`** (in `rayzee/src/Stages/`): the pure-wavefront path tracer. `PathTracerStage` is the shared base — owns the 5 sub-managers (composition), uniforms, camera, lights, BVH/scene buffers, accumulation, completion, ASVGF coordination, mesh visibility, and lifecycle. `PathTracer extends PathTracerStage` and owns the per-frame wavefront kernel dispatch (`render()`, `_buildWavefrontKernels()`). External code accesses the sub-managers directly (see Processor classes below).
- **`index.js`**: Public API barrel export for the engine package

### App-Side Engine Integration (`app/src/lib/`)
- **`appProxy.js`**: `getApp()`, `setApp()`, `subscribeApp()` — decouples all consumers from direct app references
- **`EngineAdapter.js`**: Bridges engine events to Zustand stores
- **`VideoEncoder.js`**: WebCodecs VP9/VP8 encoder + `webm-muxer` for `.webm` video output. `VideoEncoderPipeline` class accepts `ImageBitmap` frames, encodes via `VideoEncoder` API, muxes into WebM container.

### Sub-managers and Processor Classes (`rayzee/src/managers/`, `rayzee/src/Processor/`)
PathTracer delegates to these via composition — external code accesses them directly (e.g., `stage.uniforms.get('maxBounces')`, `stage.materialData.srgbBuckets`, `stage.environment.envParams`). UniformManager, MaterialDataManager and EnvironmentManager live in `managers/`, the rest in `Processor/`:
- **`UniformManager.js`**: Owns ~60 TSL uniform nodes. Provides `get(name)`, `set(name, value)` (booleans are converted inside `set`). Uniforms created once, only `.value` mutated to preserve compiled shader graph references. The four light lists are written in place too (`LIGHT_FLOATS` × 16 a type, `PathTracerStage._writeLightList`): the shader bakes a list's length, so lists sized per scene compiled a new shade program per light count and dropped a light added after a build. A list grows only past its capacity, and that rebuilds the kernels. PathTracer exposes dynamic getters via `_defineUniformGetters()` for backward-compat property access.
- **`MaterialDataManager.js`**: Material buffer read/write, property mapping (`updateMaterialProperty()`), texture arrays (`srgbBuckets` — albedo/emissive — and `linearBuckets`, consolidated by size). The material block sits at the front of the stage's **scene data buffer**, the light data (light BVH, emissive triangles, bit-trail map) behind it: one Shade binding for both (`callbacks.adoptMaterials` → `PathTracerStage._adoptMaterials`; `materialStorageAttr`/`Node` are that buffer). Material reads are unchanged; light reads go through `stage.lightDataNode`, which adds `lightVec4Offset`. Edits upload only the material region (`_uploadMaterials`, an update range), light rebuilds only theirs.
- **`EnvironmentManager.js`**: HDRI loading, CDF importance sampling (`buildEnvironmentCDF()`), physical/solid sky generation, environment rotation. Owns `environmentTexture`, `envParams`, and the `envCDFTexture` (RGBA32F, the environment's sampling table as `packExactTable` lays it out; `exactTable`) — except while the physical sky is on, whose two textures `PhysicalSky` owns and fills on the GPU.
- **`ShaderBuilder.js`**: scene texture-node factory — `createSceneTextureNodes()` builds the environment, previous-frame MRT, gobo and IES texture nodes and hands back the scene's storage nodes. In-place updates via `updateSceneTextures()` / `updateGoboMaps()` / `updateIESProfiles()` on model change (no shader rebuild). The material buckets belong to PathTracer, and every per-renderer resource reaches a kernel through its build context (`TSL/SceneResources.js`, pitfall 14), never module state.
- **`StorageTexturePool.js`**: Ping-pong MRT storage textures for progressive accumulation. `create()`, `swap()`, `getReadTextures()`, `ensureSize()`.
- **`KernelManager.js`**: Registers + dispatches the wavefront compute kernels (`register()`, `dispatch()`, `setDispatchForCount()`, `setDispatchForGrid()`). Used by `PathTracer` as `this._kernelManager`.
- **`PackedRayBuffer.js`** / **`QueueManager.js`**: SoA ray/hit buffers (the path's RNG state is hit slot `HIT.RNG` — its own buffer would put Shade at 11 storage buffers; the uvec4 slot costs 12 B a ray more than the old 4 B buffer, 592 → 640 MB of ray buffers on this Mac's path budget) + the first-hit G-buffer as the hit buffer's last region (`_gBufferBase`, one uvec4 a path; as a buffer of its own it took a Shade binding the BVH parts need) (+ read helpers) and the active-index queues / atomic counters (`RAY_FLAG`, `COUNTER`) that drive wavefront stream compaction.
- **`TLASBuilder.js`**: Builds SAH BVH over TLAS entry AABBs for the top-level acceleration structure (an entry is a placement, a grouped copy, or — past 1M entries — a copy cluster). Flattens with BLAS-pointer leaves (tag `BLAS_POINTER_LEAF`, slot [1] entry index + identity bit, slot [2] visibility flag, slots 4–15 world-to-object rows) or cluster leaves (`CLUSTER_LEAF`). Caches flatten buffer across rebuilds.
- **`InstanceTable.js`**: per-**placement** metadata (template, TLAS leaf, visibility, transform) in typed columns, plus per-template BLAS offsets/sizes and object boxes. Transforms are runs read in place (`matrixRow( p )`), groups map placements to TLAS entries (`entryOf` / `repOf`), and copy clusters add records (`recordEntry`, `clusterLeaf`, `clusterOf`). Placements are positional: write them with `setEntry()` / `setAlias()` at an explicit index.

### TSL Shader Modules (`rayzee/src/TSL/`)
44 files using `Fn()`, `If()`, `Loop()`, `.toVar()`:
- Wavefront kernels: `GenerateKernel.js`, `ExtendKernel.js`, `ShadeKernel.js`, `CompactKernel.js`, `FinalWriteKernel.js`, `SortGlobalKernels.js`, `DebugKernel.js`; bidirectional/VCM: `LightGenerateKernel.js`, `ConnectKernel.js`, `LightSplatKernel.js`, `MergeKernel.js`
- Traversal and shading: `BVHTraversal.js`, `MaterialEvaluation.js`, `MaterialSampling.js`, `MaterialTransmission.js`, `Subsurface.js`, `LightsDirect.js`, `LightsSampling.js`, `EmissiveSampling.js`, `Environment.js`, `TextureSampling.js`, `SceneResources.js`, etc.

### Multi-Threading Architecture (`rayzee/src/Processor/Workers/`)
Critical for maintaining 60fps during heavy computations:
- **`BVHWorker.js`**: Off-main-thread BVH construction using binned SAH splitting and reinsertion
- **`TexturesWorker.js`**: Batch texture processing with memory-optimized chunking
- **`BVHSubtreeWorker.js`**: builds subtrees of one large mesh's BVH in parallel (`ParallelBVHBuilder.js`)
- **`TLASWorker.js`**, **`PackWorker.js`** (texture packing without a canvas, in Node), **`AIUpscalerWorker.js`** (viewer)
- **`CDFWorker.js`**: CDF computation for environment importance sampling (HDRIs and the simple skies; the physical sky builds its own on the GPU)
- **`BVHRefitWorker.js`**: O(N) bottom-up BVH AABB refit for animated geometry (SharedArrayBuffer protocol)

### Animation & Transform System (`rayzee/src/managers/`)
glTF / pbrt animation playback and interactive object transforms:
- **`AnimationManager.js`**: Owns Three.js `AnimationMixer`. Key methods: `play()`, `stop()`, `seekTo(time)`, `setSpeed()`, `setLoop()`. Two modes, picked at `init()`: **deforming** (any SkinnedMesh or morph track) — CPU skinning via `mesh.getVertexPosition()`, returned as a per-mesh reader for `refitBVH`; **rigid** (everything else) — `update()`/`seekTo()` update only the subtrees the clip's tracks name (or the whole model in one pass when those cover most of it), return null and hand only the meshes whose world matrix or visibility changed to `applyPoseCallback` → `PathTracerApp._applyAnimationPose` (placement matrices + TLAS refit, visibility flags, followed camera). `stop()` re-applies the restored pose. ⚠️ Never refit a rigid clip: triangles are shared between placements of one geometry, so baking a pose moves every copy.
- **pbrt animation** (`Processor/PBRT/PBRTAnimation.js`): a frame sequence (`frame25.pbrt`, `frame35.pbrt`, … in one directory) loads as ONE clip, keyed at frame number / 30 fps. Each frame's shapes are aligned with the previous frame's (LCS over geometry+material+emission keys), so a moved shape keeps one mesh; shapes that come and go get a visibility track switching halfway between keys (float32 key times made an exact-key seek show the previous frame); moving placements become `placement_N` Groups; a template redefined by a frame becomes a variant `name @frame`. `ActiveTransform`/`TransformTimes` become two keys. Moving shapes are never merged. `loadFile( file, { animation: false } )` or a `pbrtEntry` loads one frame. An animated embedded camera is followed while selected (`userData.__rayzeeSourceUuid` links the switcher's copy to the animated original).
- **`TransformManager.js`**: Interactive translate/rotate/scale gizmo via Three.js `TransformControls`. Creates its own `Scene` for gizmo rendering (not SceneHelpers — its `visible` guard blocks gizmo). On drag end, calls `app.updateMeshTransforms( affectedIndices )` — a gizmo only changes a placement's matrix, and triangles are stored in object space, so nothing per-vertex is read or written. The mode changes only from the viewport toolbar: the letter keys belong to walk mode, so the gizmo has no shortcuts.
- **`VideoRenderManager.js`**: Offline frame-by-frame animation video export. Drives seek → BVH refit → SPP accumulation → OIDN denoise → canvas capture cycle per frame. Saves/restores engine state, stops rAF loop during render, delivers `ImageBitmap` frames via callback for encoding. A `timeline` option seeks `app.timeline` in video time each frame, with or without a clip (without one the video lasts `timeline.duration`).
- **`timeline/`** — authored animation, meant to grow into the full animation system (more tracks, a scrubber). `TimelineManager` (`app.timeline`) combines the tracks (`duration`, `animates`, `seek( time )`) and owns playback: `play()`/`stop()` on three's `Timer`, advanced from `animate()` before the controls update, controls locked; `configureForMode` stops it. `TIMELINE_CHANGED` fires on key edits (`track`) and playback. Each track owns its keys and how it applies them — a new track gets its own `addKey`/`seek`, and the manager only folds it into those three. `CameraTrack` is the first: keys of `{ time, position, target, fov, orthoHeight }`, sampled through three.js `InterpolateSmooth` keyframe tracks — position and target (lookAt, so a shared subject stays centred), FOV, log orthographic height. ⚠️ three's `ZeroSlopeEnding` flattens only the start (the end tangent is half the last slope), so each end gets a mirrored key instead and time is clamped to the keys. Keys come from `cameraManager.captureView()` and play through `applyPose()`. They are not cameras: `+` in the Camera tab saves cameras, the Anim tab keys the timeline. A replace-load clears them with the saved cameras.

**Animation data flow**:
1. `AssetLoader` preserves `data.animations` from GLTFLoader (or the pbrt builder's clip)
2. `AnimationManager.init()` creates mixer on the model root (with fallback to scene root for track resolution)
3. Per frame: `mixer.update(delta)` → `mixerRoot.updateMatrixWorld(true)` → deforming: `getVertexPosition()` per vertex → `refitBVH(positions)` via worker; rigid: `applyPoseCallback` → `updateMeshTransforms` + TLAS range upload
4. Deforming: `PathTracer.updateTriangleData()` / `updateBVHData()` — fast GPU buffer writes (no reallocation). Moved emitters' light BVH is rebuilt once motion stops (pause/stop/finish/seek), not per playback frame.

**Transform data flow**:
1. User selects object → `TransformManager.attach(object)` + `OutlineHelper` shows outline
2. Drag gizmo → `OrbitControls` disabled, `app.needsReset = true` per frame (real-time outline updates)
3. Drag end → `_recomputeAndRefit()` → `app.updateMeshTransforms(affectedIndices)`
4. Per-placement matrix write + TLAS leaf inverse rewrite + TLAS AABB refit → upload the TLAS range only → accumulation restart

**BVH refit data flow (two-level)**:
- **Full refit** (animation): `SceneProcessor.refitBVH()` → the main thread scatters each mesh's positions into the shared triangle records as it reads them, then the worker refits the combined BVH (TLAS + BLASes) in SharedArrayBuffer. Positions never cross the worker boundary. A reader may return null for a mesh that did not change: it is skipped, and when any owner is skipped the worker refits only the BLASes it was handed positions for, then the TLAS from every BLAS root's stored box (`BVHRefitter.refitPartial`, bit-identical to a full refit), and only those ranges are uploaded. AnimationManager's reader does that for every mesh that is not skinned and whose world matrix and morph weights match its last read (classroom, 8 skinned of 359 meshes: 42 → 7 ms an update).
- **Per-mesh refit** (deformation): `SceneProcessor.refitBLASes(meshIndices)` → main thread updates only affected meshes' triangles, refits their BLAS ranges, rebuilds TLAS from updated AABBs
- **Rigid move** (transform gizmo): `SceneProcessor.updateMeshTransforms(meshIndices)` → no geometry at all. Writes each placement's world matrix, rewrites its TLAS leaf's world-to-object rows, refits the TLAS top down (`_refitTLAS( leaves )`): a node keeps its children's boxes in its own slots, so only the paths from the moved placements' leaves to the root are visited, and every other box is the one the tree holds. With copy clusters, the moved copy records are uploaded one range a chunk (`takeMovedRecordRanges`), since a spilled scene has only those chunks back. ⚠️ Use this, not `refitBLASes`, for anything that only changed a transform: triangles are shared between placements of the same geometry, so baking world positions into them moves every copy.
- **Positions**: both accept either a per-mesh callback `(meshIndex, triCount) => Float32Array` — asked for one mesh at a time, and free to hand back the same scratch buffer each call — or a scene-wide Float32Array of 9 floats per triangle for **every triangle in the scene**, meshes in `app.sceneMeshes` order (public getter; DFS pre-order over `meshScene`, so it *includes* the engine-owned hidden ground-projection disk and any multi-material split product), triangles in index order, world space. **Prefer the callback**: the scene-wide array is 1,030 MB at 30M triangles and will not allocate at that size. Walking your own model instead of `sceneMeshes` silently misaligns either shape. Both are length-checked and throw; before that a short buffer wrote NaN through every AABB with no error and the scene just vanished.

**Video render data flow**:
1. `VideoRenderManager.renderAnimation()` saves engine state, stops rAF, configures final-render mode
2. Per frame: `AnimationManager.seekTo(time)` → `timeline.seek(videoTime)`, after the clip so it beats a followed model camera, then auto-focus re-measured → `refitBVH(positions)` (deforming; rigid poses are applied inside `seekTo`) → `stopAnimation()` (kill rAF restart from reset)
3. Tight loop: `pipeline.render()` until `pathTracer.isComplete`, yielding every 4 passes
4. If OIDN enabled: `_waitForDenoise()` wraps `DENOISING_END` event as promise (30s timeout)
5. `getCanvas()` → `createImageBitmap()` → `onFrame(bitmap)` callback → `VideoEncoderPipeline.addFrame()`
6. On complete: `encoder.finalize()` → `.webm` Blob → browser download. Engine state restored.

### State Management (`app/src/store.js`)
Zustand-based stores with **automatic 3D engine synchronization**:
- `usePathTracerStore` - Rendering parameters with handlers that use `getApp()` from appProxy
- `useAssetsStore` - Model/environment loading state
- `useCameraStore` - Camera controls, DOF, walk speed, orthographic view height
- `useAnimationStore` - Clip playback, speed/loop, camera keyframes mirrored from `app.timeline` (`syncTimeline` on `TIMELINE_CHANGED`; the rules are the pure selectors `videoDuration` / `videoUsesTimeline`), video render
- Transform state (`transformMode`, `transformSpace`, `isTransforming`) lives in `useStore` with handlers that sync to engine via `getApp()?.transform.setMode()`
- Mesh/group visibility (`toggleMeshVisibility`, `setMeshVisibility`) lives in `useStore` — toggles `object.visible` on the Three.js object then calls `app.updateAllMeshVisibility()` to update the per-mesh GPU visibility buffer
- Pattern: `handleChange()` utility creates handlers that update both store state and the app, triggering `app.reset()` for immediate visual feedback

### React Hooks for Engine Integration
- **`useActiveApp()`**: Returns the current app instance, re-renders on app changes (uses `subscribeApp()` internally)

### Data Layout & GPU Optimization
**Triangle Data Layout** (20 u32 lanes per triangle = 80 B, 5 vec4s). The buffer is bound as
`uvec4`, so a reader binds `'uvec4'` and floats come back through `uintBitsToFloat`:
```js
// Processor/BufferLayout.js - TRIANGLE_DATA_LAYOUT
FLOATS_PER_TRIANGLE: 20         // 5 vec4s; positions carry their own normal
POSITION_A/B/C_OFFSET: 0/4/8    // f32 xyz, normal packed in the spare .w lane
NORMAL_A/B/C_PACKED_OFFSET: 3/7/11  // oct16 (packNormalOct), ~0.03° worst case
UV_AB_OFFSET: 12, UV_C_OFFSET: 16   // f32
MATERIAL_FLAGS_OFFSET: 18       // materialIndex | side << 24 | shadowBlockerBits << 26
MESH_INDEX_OFFSET: 19
```
On the GPU the five rows are split across two buffers — rows 0–2 (positions + packed normals) in
`triangleGeoAttr`, rows 3–4 (UVs, flags, mesh index) in `triangleShadeAttr` — because one buffer of
80 B a triangle hit the 4 GB storage-buffer limit at 53.6M; geo alone at 48 B reaches 89.5M. The CPU
records stay whole; `PathTracerStage._uploadTriangles` splits them on every upload path.
Kernels take the pair as `triangleBuffer = { geo, shade }` (`stage.triangleStorageNode`). When no material samples a
texture (`usesTextureCoordinates`, `SceneProcessor.textureCoordinates`) the shade store holds only flags and mesh index,
a `uvec2` a triangle (24 B less; `withoutUV` on the pair), and `triangleRow` reads its UVs as zero; `rebuildMaterials`
brings them back when a texture arrives.
**Buffer parts.** Dawn caps one buffer at 4 GiB − 4 even where Metal allows 13.3 GB, so past
`maxStorageBufferBindingSize` the BVH, geo and shade stores are each split into parts of whole records
(`StorageParts` in `TSL/patches.js`; `stage._bvhParts` / `_geoParts` / `_shadeParts`), read through
`splitStorage` (`TSL/Common.js`): `getDatafromStorageBuffer` → `storageElement` picks the part with an
`If` chain. A store that fits one buffer is a plain node and compiles exactly the old code. Every part is a
binding: Shade binds 5 others (rays, hits, counters, active indices, scene data), so parts total ≤ 5 of the
device's 10 — `_assertBindings` refuses before upload. The BVH and geo both in two parts fit (Shade and
two VCM kernels then sit at 10). Measured on Moana parts in Node, forced with `stage.bufferPartBytes`
(a test hook): images byte-identical; frame time +5–8 % for a split BVH, ±0 for split geo.
`tests/gpu/splitBuffers.test.js` traces folded and unfolded trees over 2–3 parts against single buffers.
⚠️ Read a row only through `triangleRow( tris, triIndex, row )` (`TSL/Common.js`), and pass the
hit's `instanceLeaf`: triangles of a shared geometry are in object space, not world space.

**Two-Level BVH Layout** (packed in one logical GPU array, in parts past 4 GB). ⚠️ An empty scene's tree is one empty triangle leaf
(`emptyBVH()` in `RayzeeRenderer.js`): sixteen zeros read as an inner node whose children are itself, and a CPU walk of
the TLAS (the bidirectional integrator's `_visibleSceneBounds`) searched it forever whenever a frame ran between an
unload and the next build:
```
Combined bvhData: [ TLAS nodes ][ group trees | empty leaf ][ BLAS_0 nodes ]...[ BLAS_M nodes ][ copy records ]
```
`table.blasBase` is where the BLASes start; TLAS-range uploads, spill residency and the BLAS cache all use it.
- **16 floats per node** (4 × vec4). Inner nodes store children's AABBs + child indices.
- Indices and leaf tags in slot `[3]` are **u32 bit patterns**, read with `floatBitsToUint`.
  Stored as float *values* they rounded past 2^24 and sent rays to a neighbouring node, which
  silently erased geometry from large scenes. Every valid index is below `BVH_MAX_INDEX` (2^30)
  and the tags sit above it, so `nodeTag >= BVH_MAX_INDEX` means leaf — in an unfolded BVH.
- **Folded leaves** (past `FOLD_LEAVES_TRIANGLES`, 40M stored triangles): every triangle leaf of
  ≤ 15 is folded into its parent (`Processor/BVHLeafFold.js`). The child slot holds
  `~( first << 4 | count )`, the very value traversal pushes, so folded references sit from 2^31
  up and a leaf node is `tag >> 30 === 1`. BLAS nodes halve (55.7M Moana: 50.1M → 32.0M nodes with
  the TLAS, 3.1 → 2.0 GB); images bit-identical. The tree buffer carries `foldedLeaves` and the
  traversal emits the folded code only for it: that code cost 0.5–3.7 % of GPU time in every
  variant tried (22M ocean + mountain, three views), so an unfolded tree keeps the old code exactly.
  ⚠️ Rebase through `rebaseNodes` and refit through `BVHRefitter` — both read folded children.
- **Triangle leaf** (`BVH_LEAF_MARKERS.TRIANGLE_LEAF`, 0x40000000): `[triOffset, triCount, 0, tag]`
- **BLAS-pointer leaf** (`BLAS_POINTER_LEAF`, 0x40000001): `[rootNodeIndex, entry, visibility, tag]`,
  and slots 4–15 hold the world-to-object matrix rows. Slot `[1]` carries the **TLAS entry** index
  masked by `TLAS_PLACEMENT_MASK` (the placement, unless placements are grouped); its bit 30 (`TLAS_LEAF_IDENTITY`)
  says the matrix is identity, which is how a baked placement tells traversal to skip the ray transform.
- **Grouped placements** (`InstanceTable.setGroups`): instanced meshes sharing one `instanceMatrix` attribute under the
  same host transform (non-emissive, non-deforming — `GeometryExtractor._instanceGroups`) are one object: each copy is
  ONE TLAS entry whose root is a small tree over the members' BLAS roots (plain inner nodes in the copies' shared object
  space, so traversal is unchanged). Members keep their placements, so transforms, visibility and refit stay per mesh;
  `entryOf` / `repOf` map placements and entries. A hidden member's child points at the empty leaf with a far point box
  (`BVH_EMPTY_BOX`; an inverted box is entered everywhere), and the refitter reads that box back as empty. A part moved
  alone takes its siblings along (`SceneProcessor._withGroupSiblings`). The pbrt/USD builder shares one attribute
  between a template's shapes at the same relative transform, and its placement budget counts copies. Whole Moana
  island: 50.99M TLAS entries → 39.92M; a five-part render byte-identical grouped or not, 224k → 154k entries.
  `tests/gpu/groupedInstances.test.js` holds hits, hidden members and refits to the ungrouped tree.
- **Copy clusters** (past `CLUSTER_MIN_ENTRIES`, 1M TLAS entries; `config.clusterCopies`): the TLAS is built over leaves
  of up to `CLUSTER_SIZE` (4) neighbouring copies of any objects — the entries halved at the centre median of their widest
  axis (`InstanceTable.formClusters`), so the count is ⌈entries / 4⌉ before any bounds (the BLAS cache needs `blasBase`
  then). Each copy's world-to-object rows are a 48 B record after the BLASes (`recordNodeStart`, `copyRecordBase` on the
  buffer); the leaf (`CLUSTER_LEAF`, layout in `BufferLayout.js`) holds byte boxes of each copy on a power-of-two grid and
  one word a copy: root | identity | `CLUSTER_COPY_HIDDEN`, so visibility and identity are per copy. ~80 B a copy against
  128; Moana's 39.9M entries → 10M leaves. Traversal pushes the copies a ray reaches nearest-first as
  `COPY_ENTRY | leaf << 2 | k` and handles one with `Continue()`: nesting the node visit in an `Else` overflowed the JS
  stack building the island's Shade. `instanceLeaf` is then the record index. Cost +17–20 % frame time on clustered
  scenes (plant set and island). ⚠️ Grouping copies of one object only (Morton order) made loose leaves and 2.2× the
  traversal time — the grouping, not the code (one copy a leaf: +7–11 %).
- **Geometry storage is hybrid.** A geometry used by exactly one placement — or one that emits
  light — is **baked to world space** behind an identity leaf. A geometry shared by several
  placements stays in **object space** and the ray is moved into it on entry. Emissive instanced
  meshes are expanded to per-instance triangles so every copy lights the scene.
- **`InstanceTable`**: per-**placement** metadata (a million instances cost a matrix each, not a
  million Object3Ds). `sourceMesh[placement]` names the template; `placementRunOf(template)`
  gives that template's contiguous run. ⚠️ Never index it with a mesh/template index.
  Transforms are **runs of rows** (`matrixRow( p )` returns the offset into `rowArray`, which it sets): an InstancedMesh
  hosted at the origin is read in its own `instanceMatrix` list, never copied, and the first write to such a run copies
  it into an array of the table's own (`_writeRow`), so a move never rewrites the three.js matrices. The copy into one
  pool was 3 GB beside the lists on the Moana island, and the allocation that failed it in Chrome. `table.world` exists
  only when one own run holds everything (tests).
- **`TLASBuilder`**: SAH BVH over entry AABBs (`writeEntryWorldAABBs`) with cached flatten buffer

## Key Development Patterns

### Event-Driven Stage Communication
**Critical**: Stages communicate via events, not direct coupling:
```js
// PathTracer emitting events
this.eventBus.emit('pathtracer:frameComplete', { frame, samples });
this.eventBus.emit('pipeline:historyReset');     // the core's restart signal, never a capability's name

// ASVGF listening for events
this.eventBus.on('pathtracer:frameComplete', this.handlePathTracerComplete.bind(this));
this.eventBus.on('pipeline:historyReset', this.resetTemporalData.bind(this));
```

### Pipeline Context Texture Sharing
**Automatic texture passing** via context (no manual references):
```js
// Stage publishes outputs to context
context.setTexture('pathtracer:color', this.colorTarget.texture);
context.setTexture('pathtracer:normalDepth', this.normalDepthTarget.texture);

// Downstream stages read from context
const pathTracerColor = context.getTexture('pathtracer:color');
const variance = context.getTexture('variance:output');
```

### Progressive Rendering Modes
Engine quality tiers — the engine API takes `'interactive' | 'production'`:
- **Interactive** (`INTERACTIVE_RENDER_CONFIG`): Low samples (1 SPP, 3 bounces) for real-time navigation. Camera controls enabled.
- **Production** (`PRODUCTION_RENDER_CONFIG`): High quality (1 SPP, 20 bounces, OIDN). Full-frame. Camera controls disabled.

The app maps its UI tab labels (`appMode: 'preview' | 'final-render' | 'results'`) onto these engine tiers. The `'results'` tab is purely UI — when active, the app sets `app.pauseRendering = true` and disables controls directly; the engine has no `'results'` mode of its own.

Mode switching lives in app-store handlers `handleConfigureForPreview` / `handleConfigureForFinalRender` / `handleConfigureForResults` (in `app/src/store.js`), which delegate to the engine method `app.configureForMode( mode, { canvasWidth, canvasHeight } )` — `mode` is `'interactive' | 'production'`. `configureForMode()` applies `modePresetSettings( config )` (`EngineDefaults.js`) — the one list of settings a preset owns — via `settings.setMany`, toggles OIDN/controls, and calls `reset()`. `VideoRenderManager` saves and restores exactly that list, so a new preset-owned key goes there, never inline.

**While the camera moves** (interaction mode; "Fast Navigation" in the UI), `PathTracerApp` drops the render to display × `interactionRenderScale` and restores it 100 ms after the last move. Bounces and emissive NEE are untouched; the firefly limit is 8× the user's threshold (every moving frame is frame 0, where the limit is tightest). ⚠️ The wavefront reads its resolution from the **canvas backing store**, so the drop resizes that (`renderer.setSize( w, h, false )`) — `pipeline.setSize` alone is inert. The denoising manager keeps the full size, and the drop is skipped while OIDN is the live denoiser: a resize drops its motion history and shows the raw render until the next denoise (rebuilding the network itself costs only 3–30 ms on oidn-web 0.5.0).

### Deterministic / Headless Rendering API
Public renderer methods for offline rendering and reproducible output — on `RayzeeRenderer`, so the core has them too, except `runFinalDenoise()`, which is the viewer's:
- **`app.setDeterministicMode( enabled = true )`** — pins every wall-clock- and readback-dependent
  input so N samples reproduce bit-for-bit. The RNG is already pure (`hash(pixel, rayIndex, frame)`,
  no clock, no `Math.random()` in any shader); what varies is *which uniforms and dispatch grids are
  live on frame k*. Disables adaptive sampling, pixel freeze, the readback-driven per-bounce early
  exit and dynamic dispatch sizing (kernels bind on `ENTERING_COUNT`, so an under-sized grid silently
  drops rays), interaction mode, auto-focus and auto-exposure. Reversible; leaves rAF stopped.
- **`await app.renderFrames( n, { reset, yieldEvery, onProgress, allowEarlyRetire } )`** —
  accumulates `n` samples synchronously, returning the count reached. Raises
  `maxSamples` through the settings handler (`completionThreshold` is a cached JS number — writing
  the uniform alone does nothing), and calls `stopAnimation()` after `reset()` because `reset()`
  re-wakes rAF.
  ⚠️ **`renderFrames` and adaptive sampling are mutually exclusive.** A frame retired by
  `_isConvergedComplete()` stops advancing `frameCount` (`PathTracer.render()` early-returns at the
  top), so a fixed-count loop can never reach `n`. `setDeterministicMode` clears
  `useAdaptiveSampling`, which is why the bench never hits it; anything running the shipping
  adaptive path must pass `allowEarlyRetire: true` and compare the returned count against `n`.
- **`await app.renderToBuffer( { colorSpace, preserveAlpha, source } )`** — pixels without the canvas, so it
  works headless, works while the page is hidden, and cannot pick up a helper overlay. `'linear'`
  is the raw accumulation, `'srgb'` applies exposure/saturation/tone curve in the output pass's
  order, within one level of the canvas — on the GPU (`PackedToneMapper`, `input: 'texture'`): 9 ms
  at 4096×2160 where the CPU's `toneMapToRGBA8`, now the fallback, took 1.4 s here and 10 s on a cloud
  L4's host. The two differ by one level on ~0.002 % of bytes; a fall back to the CPU sets the result's
  `toneMappedOn: 'cpu'` and records `output.tonemap_fallback` (a warning — strict does not throw). `source: 'accumulation'` (default) reads
  `pathtracer:color`, upstream of the Compositor; `source: 'display'` reads what the Compositor
  resolves (denoised). The result's `source` names what was read, and a `'display'` read
  that found nothing denoised while a denoiser is in use records `output.source_fallback`.
- **`await app.renderUntilComplete( { reset, denoise, signal, drainEvery, onProgress } )`** — the
  production counterpart of `renderFrames`: adaptive sampling stays on, the loop stops on the
  ceiling, convergence or the time limit (the time limit was never honoured outside `animate()`), and
  the final denoise runs once. It shares `_traceFrame()` / `_completionInfo()` with `animate()`, so
  the two cannot drift. For its duration the stage's readbacks run in **lockstep**
  (`PathTracer.setLockstepReadbacks`, also `app.setLockstepReadbacks()`): the survivor curve and the
  convergence counters are read every 4 frames and applied exactly 4 frames later, `render()` traces
  nothing while one is due and in flight (`stage.readbackWait()` is the promise — every driver loop
  awaits it rather than spin), and each reset clears the curve and rewinds the seed. Measured at
  400×300 with adaptive on: free-running gave 45 / 72 / 45 / 43 spp and four different images across
  pacings; lockstep 48 spp and one image every time. ⚠️ It turns interaction mode off meanwhile: that
  mode is a 100 ms wall-clock timer that engages on the first frame after a load, frames in it do not
  count, and with nothing awaited the loop spun synchronously and starved the timer (a bench hang).
  ⚠️ A moved camera never skips a lockstep readback (only interaction mode does): a reset's frame 0 sees the camera
  as moved whenever the frame before traced another view, and skipping it there made the first render after a load
  differ (glass-transmission, one pixel).
- **`app.getProvenance()`** — plain JSON of what produced the image (versions, adapter, `settings.getEffective()`, colour, render size/samples, headless/strict/deterministic/
  lockstep). `captureHeadless` returns it as `provenance`. `mode.lockstep` is `stage.accumulationLockstep` —
  whether the current image was traced in lockstep from a lockstep reset, not the live setting, which
  `renderUntilComplete` restores on return. A checkpoint restore reports false (the curve is not saved).
- **`await app.runFinalDenoise()`** — one OIDN pass at the final tier, awaited, without the render
  loop or the upscaler (`DenoisingManager.denoiseOnce()`: waits out a run or weight load in flight,
  which `start()` would refuse or defer). OIDN must have been on while accumulating — the aux
  buffers are written only then. Failure records `denoiser.unavailable`.
- **`pathTracer.requestOutput( 'gBuffer' )`** compiles the denoisers' normal/depth/albedo writes into Generate, Shade
  and FinalWrite (`gBuffer` build param; `'hitDistance'` implies it). `PathTracerApp` asks for it in `_initManagers`,
  so a denoiser toggles only the live `auxGBufferEnabled` uniform; on the bare core the first
  `setAuxGBufferEnabled( true )` asks for it (one rebuild). Without it the core's kernels carry none of that code.
- **Kernels compile in the background.** `_buildWavefrontKernels` ends in `_compileKernels()`: `KernelManager.compile()`
  runs three's `compileComputeAsync` (WGSL built in steps that yield, pipelines through `createComputePipelineAsync`).
  Until it resolves `render()` traces nothing and the canvas keeps its last frame; `readbackWait()` returns the
  promise, so every driver loop (`animate`, `renderFrames`, `renderUntilComplete`, video export) awaits it rather than
  spin; `EngineEvents.SHADERS_COMPILING` brackets it (a badge on the app's picture, `PictureStatus` in `LoadingOverlay.jsx`,
  which also shows the denoiser's model load, the closing denoise, the AI upscale and a video export; a load's loading
  panel stays up through it instead — `resetLoading` holds while `isCompilingShaders`, in the store). A newer build supersedes
  an older compile (`_kernelGeneration`). The debug-view kernel registers `eager: false` and compiles at first
  dispatch. Measured on a layer combination new to the browser: page freeze 3.7 s → 0.4 s (the main thread still
  builds the WGSL), the new image 4.1 → 4.6 s. ⚠️ The old synchronous first-dispatch compile only looked fast: the
  frame was submitted after 0.2 s and the GPU finished it after 4 s — time a first frame to
  `queue.onSubmittedWorkDone()`, not to `frameCount`.
- **`app.enableGPUTiming( bool )` / `await app.getGPUTimings()`** — real GPU milliseconds from WebGPU
  timestamp queries. `pipeline.getStats()` is **not** a GPU metric: it times command encoding on the
  CPU and stays flat while GPU cost doubles. ⚠️ The `render` part overlaps the compute before it (Apple M-series: 2.0 ms read for
  passes the wall clock puts under 0.15 ms): compare totals only between setups that draw alike.

`app.stages.pathTracer.blueNoiseReady` is deprecated and always resolved: the STBN atlases were
never read by a live code path (the default sampler is Sobol), so the load was removed.

`rayzee/src/Headless.js` wraps the above as the supported entry point — `renderHeadless()` for one
frame, `openHeadless()` to keep a live app across several, `captureHeadless()` to accumulate and read
back (`denoise: true` enables OIDN before accumulating, runs `runFinalDenoise()`, reads `'display'`).
Defaults are the batch renderer's (`strict`, `deterministic`); its `settings` are applied before the load and again
after it, since some are read while a model loads (`areaLightIntensityScale`). Under `strict`,
the renderer also defaults storage off unless the host set it (`isAssetConfigured( 'storage' )`):
the download cache serves a cached copy for up to a day before revalidating. `hostMemoryGB` stands
in for `navigator.deviceMemory` (absent outside Chrome, read as 4, which caps the reserve at 2048).
`bench/harness/boot.js` boots through it, so the suite and production share one driver; the bench
passes `strict: false` explicitly, and it is load-bearing — `strict` would abort a run before the runner reported.

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
- **`configurePlatform( { Worker, decodeImage } )`** is the seam; `rayzee/node` (plain source, exported
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
  and a strict host's throw is deferred to the end of the load (`_throwDeferred`).
  ⚠️ An image an extension decodes (KHR_texture_basisu → KTX2Loader) arrives with that loader: the plugin hands it the
  bytes (`loader.parse`), never `decodeImage` — before that no KTX2 texture loaded in Node. Without `decodeImage` and
  with no DOM (`hasImageDecoder()`), `missingImageDecoderPlugin` fails each image with what to configure; three's own
  path threw `self is not defined` and took the whole load down.
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
  guard; `initWithoutFrameLoop` lends an inert one for that call. three's `FileLoader` constructs a
  `ProgressEvent` per streamed chunk; `nodePlatform()` defines one — the only global it sets.

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
- `Promise.allSettled` swallows a strict host's throw; `TextureCreator` rethrows the first rejected
  result for that reason. Any new allSettled aggregation needs the same. Likewise a catch that
  retries or re-records must rethrow an `EngineIssueError` untouched.
- **App events** are `EngineEvents` values only. A renamed one keeps its old string in
  `LEGACY_EVENT_NAMES`, which `RayzeeRenderer.dispatchEvent` sends alongside until the next major;
  `addEventListener` warns once for any other name (a listener on a wrong name fails silently —
  the 7.28.0 rename cost a host four weeks).

### Settings Provenance & Render Profiles
- **`settings.getEffective()`** — every live setting as `{ value, source, routed }`. `source` is one
  of `SETTING_SOURCE` (default / host / scene-metadata / mode-preset); `routed: false` means stored
  but reaching no stage, which is how a typo becomes a wrong image.
- **Each layer declares its own settings.** `RenderSettings`' table is the core's alone and names no viewer piece;
  another layer adds a key with `settings.define( key, { default, apply, reset } )` (the viewer: `interactionRenderScale`),
  bringing its own default, and gets provenance, events, `serialize()` and reset like a core key. The viewer's rules
  for a core key go in the bindings it passes (`_settingsBindings`: `applyExposure` becomes auto exposure's compensation while that is on, `onCameraProjection`
  moves a motion-vector denoiser to edge-aware for a panorama) — never `denoisingManager` in `RenderSettings`.
- **One set of defaults, each kept by its owner.** `ENGINE_DEFAULTS` (`EngineDefaults.js`) is exactly the settings
  table: every key a `RenderSettings` route of the same name, every route's default there (`engineDefaults.test.js`
  holds both ways), frozen. Starting state that is not a setting sits with its owner: `SKY_DEFAULTS` and
  `DEFAULT_SUN_PATH` in `managers/EnvironmentManager.js`, `DEFAULT_VIEW` (AgX) in `Color/ViewTransforms.js`. Values read
  at one moment are stored-only routes read there — `maxTextureSize` and `areaLightIntensityScale` at load
  (`setMaxTextureSize()` also reprocesses now), `wavefrontSortMaterials` at the next kernel build. A viewer piece keeps
  its own beside its code — `DENOISER_DEFAULTS` (`Stages/DenoiserSettings.js`),
  `AUTO_EXPOSURE_DEFAULTS` (`Stages/AutoExposure.js`), `LOCAL_EXPOSURE_DEFAULTS` (`Stages/LocalExposure.js`),
  `AUTO_FOCUS_DEFAULTS` (`managers/CameraManager.js`) — and the app
  builds its store from those plus its own keys and menus (`app/src/Constants.js`: `CAMERA_PRESETS`, `SKY_PRESETS`,
  `CAMERA_RANGES`; its store keeps the names `bounces`, `debugMode` and `toneMapping`, which saved sessions carry).
  The render profiles are gone: the engine ships the viewer tuning (AgX, neutral saturation, the HDRI unrotated,
  `dofMode: 'look'`, glTF placeholder area lights at `areaLightIntensityScale` 0.1) and a host sets otherwise through
  `settings` — a batch renderer wanting the old `physical` sets `areaLightIntensityScale: 1` and `dofMode: 'physical'`,
  before the model loads. The `profile` constructor option throws, so a farm cannot keep passing it unnoticed.
- **Material defaults** — `MATERIAL_DEFAULTS` (`EngineDefaults.js`) is the only fallback for a
  property a three.js material lacks (MeshPhysicalMaterial's own values), and `packMaterial()`
  (`Processor/MaterialPacking.js`) is the only writer of the material block, for the scene upload
  and runtime edits alike. `app.getMaterialPropertySource( i, prop )` answers
  `material | mapped | default | host`. Weights and roughnesses (`UNIT_RANGE_PROPERTIES`) are clamped
  to [0, 1] there and in `updateMaterialProperty`: the Mercedes glTF ships chrome with
  `clearcoatFactor: 4`, `1 − clearcoat·E` went negative, and OIDN grew the negative samples into blobs.
  ⚠️ Never derive a default from another property: "metalness factor > 0.1 ⇒ IOR 2.5" made every
  ORM-textured glTF 4.6× too shiny on its non-metal parts.
- **Fresnel** — every dielectric interface (base layer, clear coat, glass, SSS boundary, glass
  shadows) uses the exact unpolarised Fresnel, `fresnelDielectric` in `TSL/Fresnel.js`, as Cycles
  does; metals and iridescence stay Schlick. The base keeps KHR_materials_specular's f0/f90 via
  `mix( f0, f90, dielectricFresnelWeight )` (`baseFresnelParams`), so specularIntensity 0 removes
  the reflection. The DFG LUT holds that weight's albedo in 17 IOR slices beside the Schlick terms —
  one texture, one extra fetch; regenerate with `npm run bench:lut` if a lobe or sampler changes.
  ⚠️ `DistributionGGX` floors its denominator at 1e-30, not `EPSILON`: at `MIN_ROUGHNESS` the peak
  is ~1e-10, and a 1e-6 floor cut D 8000× while the sampler drew the true lobe (a smooth white
  dielectric read 1.10 in the furnace). `furnace-dielectric-smooth` gates it.
- **Exact mirrors** — Shade floors roughness at `MIN_ROUGHNESS` (0.05; below it the GGX peak is
  narrower than f32 can evaluate), which rendered roughness-0 mirrors ~1 cm blurry at 2 m. A plain
  reflector authored below the floor (no anisotropy, clear coat, transmission or SSS) now gets
  roughness **0**, the delta-lobe marker: `generateSampledDirection` reflects about N and returns
  `DELTA_PDF` (1e6) with the value scaled so value·NoL/pdf is reflectance ÷ selection chance, which
  makes every MIS weight against it 1; the BSDF drops the lobe (GGX is exactly 0 at roughness 0), and
  `evaluateSpecularDeltaFromDots` gives its reflectance under the same sheen/coat attenuation.
  Glass already refracted exactly below 0.05; clear coat keeps its 0.089 floor.
  `furnace-metal-mirror` (1.00000) and `furnace-dielectric-mirror` gate it.
- **Diffuse transmission** (KHR_materials_diffuse_transmission; `material.diffuseTransmission`, `diffuseTransmissionColor`,
  engine properties three.js does not have) — a thin surface passes that share of its diffuse lobe to the other side:
  reflected (1 − dt)·baseColor/π, transmitted kD·dt·colour/π with the reflected diffuse's own budget kD (what the
  specular lobes leave, less metal and specular transmission) under the same sheen and coat attenuation
  (`evaluateDiffuseTransmission`). It enters no medium. The sampler draws it with the diffuse weight's dt share
  (`BRDFWeights.diffuseTransmission`, cosine about −N, density `diffuseTransmissionPdf`); `evaluateMaterialResponse` /
  `calculateMaterialPDF` answer a direction below N with it, so every MIS site agrees. NEE lights the surface from
  behind at every site — lamps (and their importance), the rect-light BSDF hit, environment and sun, emissive
  triangles (`throughSurface` on the samplers): the cosine below N, the shadow ray off the other side of the facet
  (`backOrigin`, no terminator lift). A transmission draw must cross the geometric surface (the leak guard's mirror
  case), is never flagged UNDER_SURFACE, and sets SUN_NEE. **Compiled in only while some material has it**
  (a material layer — see **Material layers** below). Bidirectional and VCM carry it: light subpaths cross the surface,
  NEE reaches through it, and a connection, light-tracing splat or merge may reach a vertex from behind — the BSDF and
  both densities then take the normal on the far side (`facingSide`), the cosines absolute, the shadow ray off that side;
  a light vertex records in `extra` which of its sides the camera culls (bit 0 near, bit 1 far). Packed at 39 (factor) and 129–131 (colour); slot 33
  holds the two map indices and `getMaterial` reads it only when the factor is above 0. Maps (`diffuseTransmissionMap`,
  its A channel, linear bucket; `diffuseTransmissionColorMap`, RGB, sRGB bucket) fold in through `applyExtensionMaps`
  on the albedo map's uv transform. Loaders: glTF through `GLTFDiffuseTransmission.js` (factors and both textures,
  via `parser.assignTexture`); pbrt `diffusetransmission` with dt = max(T), base R / (1 − dt), colour T / dt, exact
  while max(R) + max(T) ≤ 1. `tests/gpu/diffuseTransmission.test.js` holds energy (the split moves it, creates none),
  the lobe's draw rate and sampler/NEE agreement; `furnace-diffuse-transmission` (a closed sphere, 0.99989) and
  `translucent-panel` (lit from behind, truth with emissive NEE off: +0.017 %) gate it. Khronos'
  DiffuseTransmissionTest / Teacup / Plant render as their reference viewers show them.
- **Material layers** — clear coat, sheen, iridescence, anisotropy, subsurface, dispersion and diffuse transmission
  (`MATERIAL_LAYERS`, `TSL/SceneResources.js`) are compiled into the kernels only while some material has the layer's
  factor above 0 (`MaterialDataManager.materialLayers()`). The set rides in each kernel's build context
  (`resources.materialLayers`); a function body reads it with `materialLayers( builder )` and leaves the layer's code
  out with a plain JS `if` — the weight, density, sampling link, extension maps and Shade's paths (the coat sampler,
  the subsurface walk and boundary). Shade also zeroes each absent layer's factor after `getMaterial`. Outside a
  scene kernel (a GPU test) every layer is in. A scene load rebuilds the kernels for its exact set; an edit that turns
  a layer on rebuilds before the next frame (`onMaterialFeaturesChanged` → `_layersToCompile`), one that turns it off
  waits for the next build, so dragging a slider through 0 does not recompile twice. ⚠️ Removing a layer's code must
  be exact for a material without it: the iridescence weight keeps `min( 0, diffuse )` (it moves a negative diffuse
  weight to specular even at 0), and a sampling link may go only because its weight is 0 and so its cumulative bound
  equals the previous one. `tests/gpu/materialLayers.test.js` holds a layer-free material bit-identical with every
  layer compiled out; every bench golden is unchanged scene by scene. Frame time (`bench:ab`, 28 scenes, Apple
  M-series): −3.9 to −24.3 %, median −9.6 % — scenes with a layer gain too, from the others going.
- **Ray spawn points** — every ray leaving a surface starts at `offsetRayOrigin( p, n )`
  (`TSL/Common.js`, Cycles' classic ray_offset: 1e-5 along n within 1 unit of the origin, 32 float ULPs
  per axis beyond), with n the **facet** normal on the side the new ray leaves. ⚠️ The hit record's
  `normal` is the interpolated one; the facet normal rides in its spare lane (`TSL/HitFacet.js`, packed
  by Extend). Offsetting along the interpolated normal broke foliage: cards whose vertex normals all
  point up had pass-through rays moved within the card's own plane, re-hit it until the transparent
  guard ended the path, and drew black (`furnace-foliage-cards` gates it). ⚠️ Never a fixed
  distance: the old 1 mm let rays out of sub-millimetre grooves, and a 14 cm camera read up to 14 %
  bright in its crevices against Cycles — the same model scaled 100× matched. A shadow ray towards a
  sampled light point (area lights and emissive NEE alike) is re-aimed from that origin and stops
  `SHADOW_END` (1 − 1e-4) of the way, never a fixed distance short. ⚠️ The hit point Shade rebuilds,
  origin + t · direction, sits off a large triangle by t's own error, which grows with the triangle's size:
  points on a 400-unit two-triangle floor fell under it and read up to 4 % dark in bands. Extend moves the stored
  distance along the ray onto the triangle's plane (`HitFacet.js` `surfaceOffset`, not where the ray grazes it), and
  the closest-hit triangle test rejects t within its rounding error (pbrt-v4's bound). ⚠️ Storing the correction in a
  slot of its own cost Extend 10–15 % (one more scattered write a ray: it is memory-bound), and the bound in the
  shadow test cost Shade ~4 % in registers alone; shadow rays start lifted off their surface and skip it
  (`RayTriangleGeometryShadow`). Every band reads 1.0000 against the floor split 64 × 64, both integrators.
- **Shadow terminator** — Cycles' Shadow Terminator → Geometry Offset (`TSL/ShadowTerminator.js`,
  setting `shadowTerminatorOffset`, 0.1 as in Blender, 0 off), ported from Cycles 5.1's
  `kernel/light/sample.h`: near the terminator, light and environment shadow rays from a smooth-shaded
  triangle start on the smooth surface its vertex normals describe. Bounce rays and the BSDF-hit
  area-light ray are not lifted, as in Cycles. The low-poly white furnaces read 0.99650 → 0.99879
  (16 segments) and 0.99815 → 0.99879 (32), the same as the smooth sphere. Extend computes the lift
  and packs it beside the facet normal (11:11 octahedral, then the lift's top 10 half-float bits).
  Cost on the 1.7M-triangle test interior at 1024²: +1.2 % GPU per sample, 0.26 ms of it the work.
  ⚠️ `bench:ab` read +7–9 % on identical code for two scenes that day: net any A/B of a self-run.
  ⚠️ Shade's `Ngeo`/`NgeoFF` are the interpolated normal, not the facet (`facetN` is), and the hit
  keeps texture UVs, not barycentrics.
- **Fewer shadow rays** (`shadowRays`: `'two'` default, `'all'`, `'one'`; path integrator only) — `'all'` is a shadow ray
  per kind of light (the lamp pick, environment, sun, emissive triangles). Otherwise each kind offers its sample
  unshadowed to `lightPick` (`TSL/LightsSampling.js`): `'one'` keeps one with chance ∝ its luminance × √(the share of its
  kind's rays that got through here) and traces only it, divided by that chance; `'two'` always traces the strongest as
  well. MIS weights are unchanged, so both stay unbiased; the rect-light BSDF-hit ray is kept. A scene with no more
  light kinds than the mode traces rays compiles as `'all'` (`_pickedShadowRays`, checked every frame, so a kind
  that appears rebuilds the kernels): there the pick would only add its bookkeeping. The learned visibility
  (`TSL/LightVisibility.js`) sits in the counter buffer past the light guide: tries/visible per cell × kind, a cell ~1/32
  of its distance from the camera (power of two) and its facing axis. Shade reads the learned half and adds to the fresh
  half; `visibilityFold` merges them after each frame, so a render repeats bit for bit. A reset clears it unless only
  the camera moved. Equal-time error against `'all'` (Apple M-series): 24155522.glb with the physical sky `'one'` 1.63×
  samples/s, 0.66–0.76; `'two'` 1.23×, 0.82–0.84; small scenes `'one'` 0.89–0.98, `'two'` 1.00. ⚠️ `'one'` loses
  where a white sun and a blue sky are both in view — a sample carries one light's colour, not their mix:
  `shadow-catcher-ground` 1.54–1.92, `sheen-velvet` 1.18–1.33 (`'two'` 1.00 and 0.96). On ten real scenes (three Livspace
  interiors, a small room, two classrooms, kitchen, bathroom, Sponza and a product shot under the physical sky) `'two'`
  won 5–23 % on six, fell back on three and was even (1.02, within ±3 % timing noise) on the small room, where `'one'`
  lost 1.7×; under HDRIs `'two'` 0.86–0.92 where it picks. `mixed-lights` is the only bench scene with three kinds, so the
  only one where the pick runs (a dropped 1/P reads −2.9 %). Time them in rounds paired against `'all'`: the GPU here
  drifts ±7 % between rounds. Rejected: a control variate (add
  every light × its learned visibility, trace one to correct it) — no better than `'one'`, and 7.7 % of a single sample's
  channels negative on the interior, which the denoisers are fed.
- **`app.adapterInfo`** / exported `describeAdapter( adapter )` — flags SwiftShader, llvmpipe,
  lavapipe and WARP. `init()` throws outright when three.js has substituted a WebGL2 backend, since
  the wavefront path is compute-only and every frame would fail against an empty canvas.

### State-Engine Synchronization Pattern
**Critical**: All UI state changes must sync with the app via `getApp()`:
```js
// app/src/store.js - handleChange pattern
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

### Colour management (`rayzee/src/Color/`)
Full notes: [docs/COLOR_MANAGEMENT.md](docs/COLOR_MANAGEMENT.md) — the API, input resolution, baked views, the app's
panel and its labels, the startup view, and the shaper + table with its measurements.

`app.color` is an OpenColorIO pipeline: what textures and lights mean, the working space, and what is shown and saved.
**Inert until a host loads a config** — linear Rec.709, three.js's seven views, nothing converted. An add-on
(`rayzee/addons/color`): the core's `renderer.color` is `BasicColor` until `setColorManagement( ColorManagement )`
(`PathTracerApp` installs it). Shaders, `TextureCreator` and `EnvironmentManager` read it through `Color/ActiveColor.js`,
never `ColorManagement.js` (`coreBoundary.test.js`). The engine never names the OCIO package: the host supplies
`ocioRuntimeFactory` / `ocioRuntimeUrl`. `ViewTransforms.js` is the one registry behind the canvas, both readbacks and
the menu. A view is baked to a log2 shaper + 65³ table; `MAX_TABLE_TRANSFORMS` is 12 (16 sampled textures a stage).
Colour issues are recorded with `warn()` (headless is strict). Environment modes are `'hdri' | 'procedural' | 'color'`;
the gradient sky is gone (`EnvironmentManager.restore` keeps an old session's on screen).
- ⚠️ Once a scene exists, load and unload through `app.loadColorConfig()` / `unloadColorConfig()`: only the config that
  converted the environment can convert it back.
- ⚠️ An OCIO view returns display-encoded colour, the built-ins linear (`outputEncoded`). Get it wrong and every image
  is encoded twice.
- ⚠️ `library.addToneMapping` refuses to redefine an id: a rebake deletes the old entry and reuses the same
  `Data3DTexture` and TSL node, or canvas and readback run different tables.
- ⚠️ `setWorkingSpace()` must be followed by `applyColorWorkingSpace()`: it re-packs textures and materials, converts
  the environment in place and rebuilds the emitter list (`EmissiveTriangleBuilder` keeps its own colour copy).
- ⚠️ `SimpleSky` clears `userData.__rayzeeColorSpace` on every rewrite, or a new sky is never converted. The physical
  sky bakes straight into the working space.
- ⚠️ Grid index 0 is baked from exactly 0, or every render has a raised black floor.
- ⚠️ App: rerun `npm run color:bake` and upload `default-view.bin` whenever the default config or view changes. The
  GPL-3.0 config files live on the CDN only, never in the repo. `describeConfig()` must carry `categories`.

### Physical sky (`Processor/PhysicalSky.js`, `Processor/AtmosphereModel.js`, `Processor/SunPosition.js`, `TSL/Atmosphere.js`, `TSL/EnvironmentCDF.js`, `TSL/Sun.js`)
An add-on (`rayzee/addons/physical-sky`): the core bakes 'procedural' mode only through the class
`environmentManager.setProceduralSky( PhysicalSky )` installed, or `setProceduralSkyLoader( load )`, which imports it
the first time 'procedural' mode is baked — `PathTracerApp` does that, so the add-on is a chunk of its own that a
session without the physical sky never downloads — and records `capability.missing` without either. The core's own sun shading (`TSL/Sun.js`) imports only `Processor/SolarLimb.js`.
Environment mode `'procedural'` ("Physical Sky" in the app). Bruneton's Earth constants (Rayleigh from
Bodhaine 1999, ozone, Ångström aerosols from turbidity), 16 spectral bins of 25 nm → CIE 1931 → linear
Rec.709, baked on the GPU into a 1024×512 equirect in the engine's own mapping (row 0 = nadir).
Multiple scattering is Hillaire 2020 extended: the incoming field is kept per (height ×
azimuth-from-sun) cell, three orders are computed explicitly (ground bounces included) and only the tail
uses 1/(1 − f). Against the Monte Carlo reference in `tests/gpu/skyReference.js`: day within ~6 %,
sunset ~8 %, twilight ~16 %; plain Hillaire was 25 % dark at the horizon and 2–5× bright at twilight.
- **Nothing leaves the GPU.** The sky is computed per equirect row × 256 azimuths from the sun (π·s²,
  mirrored: radiance depends on elevation and that azimuth only) and filled into the equirect; the
  importance-sampling table is built beside it (`TSL/EnvironmentCDF.js`, the GPU twin of
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
  row's ⋮. Time of day goes through `sunPosition()` (`Processor/SunPosition.js`, solar time, month,
  latitude) with north along −Z; presets aim for their sun *height* on the chosen date
  (`timeForSunElevation`), so Golden Hour stays golden in December. "Set sun by: Angles" edits the raw angles.

### Bidirectional integrator (`integrator: 'bidirectional'` | `'vcm'`)
Full notes: [docs/BIDIRECTIONAL.md](docs/BIDIRECTIONAL.md) — frame order, strategies, the source table, lights at
infinity, the light guide, lamps, the exact environment table, MIS, storage, verification, measurements and vertex
merging.

An add-on (`rayzee/addons/bidirectional`): `BidirectionalIntegrator` (`integrators/`) owns its uniforms, buffers,
kernels and frame steps; `PathTracer` calls it through integrator hooks (`beginFrame`, `beforeShade`, `afterShade`,
`resolve`, `allocate`, `registerKernels`, …) once `registerIntegrator()` has it (`PathTracerApp` does). Shade and
Generate take its functions from `uniforms.lib`; controls are on `pt.activeIntegrator`. `'path'` compiles exactly the
unidirectional kernels (everything is JS-gated on `params.bidirectional`). Light subpaths start on every light;
strategies are camera hits, NEE, one light-vertex-cache connection per camera vertex, light tracing to a pinhole, and
with `'vcm'` vertex merging; Georgiev's dVCM/dVC MIS, power heuristic. Shared with the path tracer: a camera path at the
bounce limit takes one more segment flagged `RAY_FLAG.EMISSION_ONLY` (the BSDF-hit partner of the last NEE), and the
environment's exact table (`Processor/EnvironmentExactTable.js`) serves both integrators' NEE and the miss weight.
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
- **One denoiser owns the live view** — `Real-Time Denoiser` is a one-of-N choice (None / EdgeAware /
  ASVGF / NRD / **OIDN**), and `Final Denoise (OIDN)` is the separate question of whether the
  finished image gets a pass. Two live denoisers would mean paying for one whose result the other
  covers.
- **Every denoiser publishes a texture; the Compositor picks the newest.** `asvgf:output`,
  `nrd:output`, `edgeFiltering:output`, `bilateralFiltering:output`, `oidn:output` — the viewer's `_displaySources()`
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
- **OIDN motion history** (`Passes/OIDNTemporalHistory.js`, `oidnTemporalHistory`, default on): while
  OIDN owns the live view, each restarted frame is blended into a reprojected per-pixel history and
  live refreshes denoise that instead of one fresh sample (independent 1-spp inputs are what boils).
  It needs the NormalDepth stage (jitter-free depth, roughness, and `pathtracer:instanceLeaf`, which
  NormalDepth writes only when `setInstanceLeafOutput( true )`). It is dropped, with NormalDepth, at a
  size the cadence has proven too slow to denoise while moving (`_movingHopeless`). Shiny
  pixels and pixels of moved objects keep ~2 frames: reflections and a moving object's lighting do
  not follow the surface, and following a rotating object with a long history measured worse. Still
  frames merge the history in, fading out over 16 samples; the final denoise always reads the plain
  accumulation. ⚠️ Each pixel takes ONE history pixel and shared picks split their length: bilinear
  history, or copies, is correlated noise and OIDN keeps it as grain. ⚠️ Clamping history to the
  noisy frame's neighbourhood darkens the image — don't. `reset( true )` and
  `reset( false, { motion: true } )` keep the history; any other reset, including the path tracer
  resetting itself unannounced, drops it. Code that moves a placement calls
  `denoisingManager.notePlacementMoving()` first (`_notePlacementsMoving`) so the history follows it.
- **OIDN model swaps** (refreshes run the cheap tier, the finished image the chosen one) cost 10-20 ms
  on oidn-web 0.4.0, and `OIDNDenoiser._fetchWeights` keeps each model's bytes, so a swap never
  re-downloads. ⚠️ A `[Buffer "outputPass"] used in submit while destroyed` error is **oidn-web's**
  output pass, not three.js's: a tile's writes land a microtask after it starts, so a UNet must not
  be disposed under a run in flight — `_loadUNetWeights` aborts it and yields a macrotask first.
- EdgeAware filtering disabled when ASVGF enabled
- Quality presets in `ASVGF_QUALITY_PRESETS` (performance/balanced/quality)
- ⚠️ `Processor/ToneMapGPU.js` is a second implementation of `toneMapToRGBA8` and must stay
  bug-compatible with it, rounding included. It serves the neural passes (packed half input) and
  `renderToBuffer`'s sRGB readback (float texture input, alpha kept). `tests/gpu/toneMapParity.test.js` checks the two on
  Dawn in Node, and `bench:upscale` again in Chrome before anything else. Its `output: 'planar'` mode feeds the
  AI upscaler's network float planes encoded with a 2.2 power, not the sRGB curve — what the upscaler always used.
- **OIDN sees the frame inside a 16 px mirrored border** (`OIDN_BORDER`, `oidnInputSize()`), each side then rounded
  up to 16. At the network's own boundary — its zero padding, or oidn-web 0.5.0 repeating the edge pixel up to a
  multiple of 16 — the outer pixels came out worse than not denoising at all. Outer 3 px against a 2048-spp
  reference (four scenes, 250×140 to 1500×844, 1–64 spp): 0.4–0.7× of 0.4.0's error; 0.5.0 alone was 1.3× worse at
  the bottom at 4 spp. A multiple of 16 keeps the frame on the network's pooling grid, so pixels away from the edges
  denoise exactly as without it (an 8 px border moved them ±2 %). One compute pass packs all three inputs, border
  included (`_copyInputs`); autoexposure meters the frame only; the tile cap applies to the frame, so the border
  never splits a frame that fits one tile. Cost: 3–11 % more denoise time, most on small frames.

### Auto exposure (`Stages/AutoExposure.js`, viewer)
Meters `pathtracer:color` on the GPU, adapts on the CPU. Two kernels in one pass: tiles (≤ 64×64, ≥ 8 px a side) averaged in
linear light, weighted by alpha (a transparent or black background is left out), then a 256-bin log2 histogram whose
percentile-clipped mean (fractional bins) is read back. Averaging before the log is what keeps a 1-spp image metering like
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

### Local exposure (`Stages/LocalExposure.js`, viewer; off in the engine, on in the app)
Unreal Engine 5's: a bilateral grid of log luminance (cells of 128 px, 32 one-stop bins of exposed luminance) blended
60/40 with a blurred 1/32 picture as the base layer; the base's contrast around middle grey is scaled
(`highlightContrast`, `shadowContrast`; the app's Balance Highlights amount 40 % = 0.6) and detail kept (`detailStrength`). It
changes only what is shown, as a per-pixel gain before exposure and the view, written three ways in that file — the
compositor's TSL (`gainNode`, installed with `compositor.setDisplayGain`), WGSL for `PackedToneMapper`'s `gain` (every
tone-mapped readback, the AI upscaler and the neural passes, through the core hook `_displayGain()`), and JavaScript
for the CPU tone map (`pixelGain`) — kept identical by `tests/gpu/localExposure.test.js`. Canvas vs readback: 0.5
levels, the readback's usual bias. EXR stays scene-referred. The grid is built from `pathtracer:color` on restarts and
the metering schedule: 0.05 / 0.13 / 0.5 ms at 540p / 1080p / 4K (Dawn, M-series); the compositor's gain +0.05 ms at
1080p. ⚠️ The compositor reads its position from `screenUV` (y down = texture row 0); `uv()` is not guaranteed to be.
The app's `DEFAULT_STATE` turns it on (the engine stays off, so a farm keeps its look); `applyExposureToEngine()` in the
store puts the panel's auto and local exposure on the engine at startup and after a session restores the panel. The app
shows only Auto Exposure (Follow View: Gently / More / Fully = strength 0.3 / 0.6 / 1), Exposure and Balance Highlights
(Amount); metering, range, shadows and detail stay engine-only, so a session cannot carry a value no control shows.

### Asset Processing Workflow
1. **AssetLoader** loads GLB/GLTF models with automatic camera extraction. The core reads glTF/GLB, `.hdr` and LDR
   images (`CORE_FORMATS`); every other format is a descriptor registered with `assetLoader.registerFormat()`
   (`Processor/FileFormats.js` — the `rayzee/addons/formats` add-on; `PathTracerApp` registers `allFormats`), read
   through one shared path (`_loadModelWithFormat`). glTF's Draco, KTX2 and meshopt decoders are imported per file:
   `decodersOnDemand` (`GLTFDecoders.js`) wraps `loader.parse` and searches the JSON for the extension names first.
   An archive's inner models go through the same registry; pbrt's EXR maps use the archive importer's own EXRLoader
   (`_exrLoader`), registered or not. On the core-browser example the host's main chunk went 577 → 534 KB gzip and the
   seven model-loader chunks are no longer emitted.
2. **GeometryExtractor** converts meshes to the 20-lane triangle records, baking single-use and emissive geometry to world space and leaving shared geometry in object space; records per-mesh `meshTriangleRanges`. It never rewrites a host's own geometry (`userData.__rayzeeExternal` subtrees are left alone), and anything skinned or morphed is given triangles of its own so a refit cannot pose every copy at once.
3. **SceneProcessor** builds two-level BVH (TLAS/BLAS): per-mesh BLAS via `BVHBuilder` (parallel for large meshes via `Promise.all`), then `TLASBuilder` builds SAH tree over mesh AABBs, then assembles combined buffer `[TLAS | BLAS_0 | BLAS_1 | ...]`. A mesh past `SPLIT_MESH_TRIANGLES` (2M) is built as spatial pieces (`Processor/SplitBLAS.js`): its records are sorted in place into pieces of ≤ 512k by halving at the centroid median of the longest axis, each piece is built by a pool worker, and the halving becomes the nodes that join them. It holds the mesh once, in the store — one build across every core held a second copy plus 44 B a triangle of scratch. Images bit-identical, frame time unchanged (22M ocean + mountain, three views, within 3 %). ⚠️ The joined BLAS travels as parts (`nodeParts`), never one array: a 610 MB request failed an 80M build with memory to spare. ⚠️ Pivots are sampled with a fixed seed: first/middle/last took a thousand passes on a terrain grid's repeating rows.
4. **TextureCreator** generates GPU textures for materials (runs in parallel with BVH build)

A failed load reports itself through `LOADING_UPDATE { failed: true, status }` from
`_loadWithSceneRebuild` (`ARCHIVE_NEEDS_ELEMENT` → `LOADING_RESET`, `LOAD_IN_PROGRESS` → nothing, the
other load owns the status). ⚠️ Only the scene build used to: a failure in the parse left the app's
overlay spinning on its last step with the File menu blocked. Drag-and-drop still resets the overlay in
its own `finally`, so a failed drop shows only the console.

### Folders, archives, pbrt and USD
Full notes: [docs/SCENE_IMPORT.md](docs/SCENE_IMPORT.md) — folder loading, partial archive loads, pbrt (budgets, parse
memory, lights, shapes, templates, materials, formats) and USD (layers, composition, translation, parts, budgets, the
Moana island measurements).

- **Folders**: `loadFile( { files } )` loads a folder as the same folder zipped would (`localFolder()` →
  `ArchiveImporter.loadFolder` → the archive path). Archive entries are lazy Blobs, read only when a loader asks.
- **Archives and pbrt** are an add-on (`rayzee/addons/archives`, `Processor/ArchiveImporter.js`), reached through
  `assetLoader.setArchiveImporter()` or `setArchiveImporterLoader( load, ARCHIVE_FORMATS )`. `.tar` is read in place,
  `.tar.gz` unpacked once into OPFS `archives/`, `.zip` read through its central directory. `loadFile( file, { element } )`
  takes one element path or an array. Past `ARCHIVE_ELEMENT_PROMPT_BYTES` (4 GB) a multi-element archive throws
  `ARCHIVE_NEEDS_ELEMENT` (the app's part dialog), on the seekable `.tar` path too. Budgets: `maxTriangles` 45M /
  `maxPlacements` 6M, or 120M / 60M with memory spill (`SPILL_TRIANGLE_BUDGET`).
- **USD** (`Processor/USD/`, same add-on; a `.usdz` stays with three's USDLoader): our own crate reader (three's
  parsers are not usable), on-demand composition (`USDStage.js`), translated into the pbrt builder's IR (`USDScene.js`).
  Past `USD_ELEMENT_PROMPT_BYTES` (1 GB) it throws `ARCHIVE_NEEDS_ELEMENT`; a counting pass fits curves and point
  instancers to the budgets (`USDSceneReader.fit`), and meshes are never thinned.
- ⚠️ Anything that changes what the same pbrt files build bumps `PBRT_BUILD_REVISION`, or a stored graph of the old
  build is reused.
- ⚠️ Keep the template grouping (templates at identical transforms become one): without it Moana's trees rendered 60 %
  slower.
- ⚠️ A `.ply` is shared by every shape naming it and freed only by its last direct user (`_lastPlyUse`).
- ⚠️ A shape inside `ObjectBegin` keeps its whole transform and a placement's goes on top — never relative to the
  transform at ObjectBegin.
- ⚠️ `material.clone()` drops the engine's own properties (diffuse transmission, subsurface): use `cloneMaterial`.
- ⚠️ The builder frees a shape's arrays after merging it: hand an array over once (`own()`).

### Storage (OPFS) (`rayzee/src/Storage/`)
Full notes: [docs/STORAGE.md](docs/STORAGE.md) — areas and the cache budget, the entry protocol, I/O, locks, identity,
the scene cache, scene state, sessions and projects, render checkpoints, and memory spill in full.

`app.storage` is a `StorageManager` over the origin private file system, shared per `cacheNamespace`
(`acquireSharedStorage`). It is `null` where there is none (private windows, Node) — **every caller must work without
it**; failures record `storage.*` warnings and fall back to memory. An add-on (`rayzee/addons/storage`, installed with
`renderer.setStorageOpener()`); the caches that use it (`DownloadCache`, `CDFCache`, `BLASCache`, `SpillStore`,
`GeometrySpill`) stay core and import area names from `Storage/areas.js`. Areas are `cache` (one shared budget, evicted
least-recently-used), `user` (never evicted) or `scratch` (`spill`, cleared at open). Also here:
`app.exportSceneState()` / `importSceneState()`, the app's sessions and `.rayzee` projects, and render checkpoints
(`captureRenderCheckpoint()` / `restoreRenderCheckpoint()`).
- ⚠️ An entry's `meta.json` is written last (no meta = invisible); `create` removes the old entry first, so anything
  rewritten often alternates between two keys.
- ⚠️ `EntryWriter.write` copies its data before its first await. Download revalidation is a 1-byte `Range` GET, never
  HEAD (the asset host's CORS allows GET only).
- ⚠️ The scene-cache codec carries colours and `ior` exactly (`exactColors`, `exactIor`): `Material.toJSON` rounds both.
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
Access via Path Tracer tab → Debug Mode (`TSL/Debugger.js`; modes 1–10 run the one-pass `DebugKernel`):
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
Event-driven stage pipeline with TSL compute kernels compiled to WGSL. All engine code lives in `rayzee/src/`. The path tracer is a pure-wavefront renderer: `PathTracer extends PathTracerStage`, where the base delegates to 5 sub-managers: `UniformManager`, `MaterialDataManager`, `EnvironmentManager`, `ShaderBuilder`, and `StorageTexturePool`. External code (other stages, PathTracerApp) accesses sub-managers directly — e.g., `stage.uniforms.get()`, `stage.materialData.*`, `stage.environment.*`. See `docs/PIPELINE_ARCHITECTURE.md` and `docs/PATH_TRACER_SHADER_ARCHITECTURE.md` for details.

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

**Texture arrays' CPU pixels** are released right after three.js uploads them (the texture's
`onUpdate`): nothing reads them again, since a rebuild packs new arrays from the three.js
sources. −716 MB on 24155522.glb. They are dropped, not returned to `SmartBufferPool`, which would
keep them alive; a cache lookup then sees `userData.buffer === null` and rebuilds.

**Uploads in Chrome.** Every `writeBuffer`, `writeTexture` and `mappedAtCreation` goes through a shared memory pool
mapped in both the tab and the GPU process; it grows to the most ever sent before the GPU caught up and is kept until
the page closes (reused, never shrunk; destroying the buffer does not return it). Measured on Chrome 154: 1 GB in 64 MB
writes left 1 GB behind, in 8 MB writes too; awaiting `onSubmittedWorkDone` after each left 64 MB, in the same time.
So big uploads are paced: chunk uploaders return `stage.drainUploads()` and the spilling build awaits it,
`SceneProcessor.uploadChunks` sends a multi-chunk store chunk by chunk before `uploadToPathTracer` adopts it, and the
load uploads texture buckets one at a time (`renderer.initTexture`; three.js otherwise sends every layer in the first
frame). 24155522.glb: pool 1,054 → 412 MB; the startup scene 330 → 35 MB. ⚠️ A single upload still takes a block its size:
the environment (392 MB on the Moana island) goes in one `writeTexture`. With no emitter active the bit-trail map is a
4-float placeholder (Shade reads it only while `emissiveTriangleCount > 0`): one over every triangle was 446 MB on the
island, in the tab, on the GPU and in the pool.

**CPU memory (`Processor/HostMemory.js`)** — the scaling wall for a large scene is not RAM, it is
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
  With `memorySpill` that mirror is on disk for the build (`Storage/GeometrySpill.js`, see Memory
  spill in `docs/STORAGE.md`) and read back when it ends.

### Shader Data Access Pattern
Materials and BVH data accessed via storage buffer lookups in TSL:
```js
// Standard pattern in TSL shaders
const getDatafromStorageBuffer = Fn(([buffer, index, offset, stride]) => { ... })
```
BVH traversal (`BVHTraversal.js`) uses stack-based DFS with two-level dispatch: TLAS inner nodes → BLAS-pointer leaves (per-mesh visibility read from the leaf's slot [2]; skip BLAS if hidden, else push BLAS root onto stack) → BLAS inner nodes → triangle leaves (inline Möller-Trumbore + inline side culling via the per-triangle side flag, flags word bits 24–25). Both `traverseBVH` (closest hit) and `traverseBVHShadow` (any hit, early exit) gate on mesh visibility. ⚠️ Side culling is for what the camera sees: Extend culls only a ray not yet `REDIRECTED`, or one flagged `UNDER_SURFACE` (a scatter the shading normal sent under its own facet — without it the low-poly furnaces lose energy). Every other bounce, like every shadow ray, hits both sides: culled bounces passed through hollow single-sided models (open-bottomed furniture) and lit the floor beneath them. A single-sided emitter a bounce hits from behind emits nothing, as NEE never samples it there. The visibility flag is packed into the TLAS BLAS-pointer leaf by `TLASBuilder.flatten()` and patched at runtime by `PathTracerStage._patchTLASLeafVisibility()` — there is no separate visibility buffer.

### Camera & DOF System
Thin lens in `TSL/CameraRay.js`, with two ways to size the aperture (`dofMode`, default `'look'`):
- **look** — radius = `dofBlur` × `focusDistance` × tan( fov / 2 ): a far background blurs by `dofBlur` of the image
  height at any scene scale. Aperture, focal length and `unitsPerMetre` are ignored. Orthographic, tan( fov / 2 ) is 1:
  a point half the view's height behind the focus plane blurs by `dofBlur`, wherever the camera stands.
- **physical** — `focalLength / 2N` mm × `unitsPerMetre` × `apertureScale`. At true size a small object behaves like
  real macro: wide open, a 4 cm watch that fills the frame is all blur.

Both focus on a **flat** plane: `focusDistance` is depth along the view axis, measured by `viewDepth()`
(`managers/InteractionManager.js`; a panorama focuses along each ray). Auto-focus resets on a new model or camera
(`resetAutoFocus()`), falls back to the orbit target's depth when nothing is under its point, and pauses in a
panorama rather than switching to manual. Its CPU raycast (stock three.js, no BVH; 6.7 ms on Sponza) runs again
only when the view, the AF point or `stage.resetCount` changed — every scene change resets the render, so
anything that moves geometry without a reset leaves focus stale. The app's `CAMERA_PRESETS` are settings patches (`dofBlur` plus the lens) with
no field of view or focus distance, so a preset never moves the camera. `dofBlur` is a per-camera effect;
`dofMode` is not. The app's panel is a **Simple | Pro** switch over `dofMode`, remembered in localStorage.

**Orthographic** (`cameraProjection: 'orthographic'`, uniform id 2 in `CAMERA_PROJECTION_IDS`): rays are parallel and
start on the camera's image plane (`cameraRayOrigin()` in `TSL/CameraRay.js`). The live camera is a `ViewCamera`
(`managers/ViewCamera.js`), a PerspectiveCamera that switches its own projection, so every holder of it — both
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

**Walk mode** (`cameraManager.setNavigationMode( 'walk' )`, `managers/WalkControls.js`) rides on the OrbitControls
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
8. **Feature Guards**: Check stage availability before accessing optional stages (e.g., `app.stages.asvgf?.enabled`). A bare `RayzeeRenderer` has only `stages.pathTracer` and `stages.compositor`
9. **BVH Leaf Markers**: slot `[3]` is a u32 bit pattern — `TRIANGLE_LEAF` (0x40000000) or `BLAS_POINTER_LEAF` (0x40000001), both above `BVH_MAX_INDEX`, so `floatBitsToUint(nodeData0.w) >= BVH_MAX_INDEX` means leaf — except in a folded BVH, where a folded left child also sits above it (from 2^31) and the test is `tag >> 30 === 1`. They live in `Processor/BufferLayout.js`, which imports nothing, so the worker-side `BVHBuilder`, `BVHLeafFold` and `BVHRefitter` import them rather than keeping copies.
10. **InstanceTable Entry Order**: Entries are indexed by `meshIndex` (positional). Use `setEntry()` with explicit index, never push-based insertion, to avoid ordering bugs with mixed sync/async BLAS builds.
11. **Transform vs Deformation vs Animation**: a rigid move uses `updateMeshTransforms()` (matrix only — no vertex pass, no BLAS work, no triangle upload). Deformation of specific meshes uses `refitBLASes()` (per-mesh, sync, main thread). Animations use `refitBVH()` (full scene, async, worker). Don't mix them — the worker path operates on SharedArrayBuffer that must match the combined TLAS/BLAS layout. Build the positions buffer from `app.sceneMeshes`, never from your own model root (see **BVH refit data flow** above).
12. **Mesh Visibility**: Controlled per-mesh at the BLAS-pointer level in BVH traversal, NOT per-material. Use `app.updateAllMeshVisibility()` after changing `object.visible` on any Three.js object/group — it walks the parent chain to resolve world-visibility and patches the visibility flag into each TLAS leaf (slot [2]) via `_patchTLASLeafVisibility` (no separate GPU buffer). Material-level `visible` was removed from the pipeline. Front/back/double-side culling is handled inline in `traverseBVH` via the per-triangle side flag, for camera rays only (see Shader Data Access Pattern).
13. **Partial storage uploads**: three.js uploads an attribute whole only when its `updateRanges` is empty — any pending `addUpdateRange` cuts a later `needsUpdate = true` down to that range. Full uploads therefore clear ranges first (`PathTracerStage._updateStorageBuffer`). Without that, the TLAS-leaf range a visibility patch leaves at load swallowed the refit that followed it (`refit-deform` read +16.6 %).
14. **No module-level shader state**: a TSL function's body runs when its kernel *compiles* (often the first dispatch), not when the JS builds the graph, so a module variable is read from whichever renderer or stage set it last. Per-renderer resources (material buckets, shadow albedo maps, gobo/IES textures, the alpha-shadow switch) ride in the kernel's build context instead: `withSceneResources( kernelCall, resources )` at the root, `sceneResources( builder )` in a function body (`TSL/SceneResources.js`). A kernel that reads them without the context throws. `bench:node -- --core` runs the core beside the full engine to hold this. Colour management stays page-wide by design (one OCIO runtime).
15. **Pass values, not expressions, into a Fn that loops**: an argument expression is generated where the Fn first reads it. If that read sits in a `Loop` after a `Break()` that can fire first, every later read sees zero. The bidirectional emitter-hit weight passed `origin.sub( … )` to `calculateLightBVHPdf`; a one-node light tree left the walk before reading it, so the pdf was measured from the world origin (+6 % on a grazing-lit floor, since the integrator landed). `.toVar()` the argument.
