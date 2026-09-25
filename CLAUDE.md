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
- `npm run build:engine` - Engine library only (ESM + UMD)
- `npm run build:app` - App only
- `npm run preview` - Preview production build locally

### Code Quality
- `npm run lint` - Run ESLint checks (from root)
- `npm run lint-fix` - Automatically fix ESLint issues

### Testing
- `npm test` - Run Vitest from root

### Regression Bench (`bench/`)
Headless-GPU regression detection for quality, performance, and memory. See `bench/README.md`.
- `npm run bench` - quality + memory + perf against the working tree
- `npm run bench:bless` - regenerate goldens / ground truth (required on a new machine)
- `npm run bench:ab -- main` - gate perf against another git ref (same-session interleaved A/B)
- `npm run bench:list` - show the scene corpus

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
- **`EventDispatcher.js`**: Loose coupling via events (e.g., `pathtracer:frameComplete`, `asvgf:reset`)

### Core Rendering Stages (`rayzee/src/Stages/`)
**Execution order matters** - stages run sequentially:
- **`PathTracer.js`** + **`PathTracerStage.js`**: Pure-wavefront Monte Carlo path tracer with MRT outputs. `PathTracer` (the wavefront renderer) extends the `PathTracerStage` base (shared engine/scene infrastructure).
- **`ASVGF.js`**: Real-time spatiotemporal denoising
- **`NRD.js`**: Port of NVIDIA NRD's ReBLUR (recurrent blur) denoiser — strategy `'nrd'`; reads roughness from `pathtracer:shadingNormal.w` (NormalDepth) and the secondary hit distance from `pathtracer:albedo.w` (written by Shade at camera depth 1). Progressive-aware: passes the frame through untouched once the input has `handoverFrames` samples. See `docs/NRD_DENOISER.md`. ⚠️ TSL shares texture bindings by texture uuid — every deferred-read `TextureNode` in a kernel needs its own placeholder texture (see `readNode()` there).
- **`EdgeFilter.js`**: Temporal filtering with edge preservation
- **`OverlayManager.js`** + **`helpers/`** (in `managers/`): visual helpers, drawn at **view resolution** (canvas bounding rect × DPR — so viewport zoom counts), never at the path tracer's render resolution. Two layers: a 3D scene layer (`ViewOverlayRenderer` — a transparent canvas with its own WebGPURenderer sharing the main `GPUDevice`; hosts light gizmos, the transform gizmo, and `OutlineHelper`) and a 2D HUD canvas (`TileHelper` — OIDN-denoise / AI-upscale progress borders). Both are separate canvases, so helpers can never be baked into saved images. The scene layer allocates nothing until a helper first becomes visible, and parks itself (`display:none`) when none are.

### Rendering Engine (`rayzee/src/`)
- **`PathTracerApp.js`**: Main application class managing the WebGPU renderer, scene, camera, and pipeline lifecycle
- **`PathTracer.js`** + **`PathTracerStage.js`** (in `rayzee/src/Stages/`): the pure-wavefront path tracer. `PathTracerStage` is the shared base — owns the 5 sub-managers (composition), uniforms, camera, lights, BVH/scene buffers, accumulation, completion, ASVGF coordination, mesh visibility, and lifecycle. `PathTracer extends PathTracerStage` and owns the per-frame wavefront kernel dispatch (`render()`, `_buildWavefrontKernels()`). External code accesses the sub-managers directly (see Processor classes below).
- **`index.js`**: Public API barrel export for the engine package

### App-Side Engine Integration (`app/src/lib/`)
- **`appProxy.js`**: `getApp()`, `setApp()`, `subscribeApp()` — decouples all consumers from direct app references
- **`EngineAdapter.js`**: Bridges engine events to Zustand stores
- **`VideoEncoder.js`**: WebCodecs VP9/VP8 encoder + `webm-muxer` for `.webm` video output. `VideoEncoderPipeline` class accepts `ImageBitmap` frames, encodes via `VideoEncoder` API, muxes into WebM container.

### Processor Classes (`rayzee/src/Processor/`)
PathTracer delegates to these via composition — external code accesses them directly (e.g., `stage.uniforms.get('maxBounces')`, `stage.materialData.albedoMaps`, `stage.environment.envParams`):
- **`UniformManager.js`**: Owns ~60 TSL uniform nodes. Provides `get(name)`, `set(name, value)`, `setBool()`. Uniforms created once, only `.value` mutated to preserve compiled shader graph references. PathTracer exposes dynamic getters via `_defineUniformGetters()` for backward-compat property access.
- **`MaterialDataManager.js`**: Material buffer read/write, property mapping (`updateMaterialProperty()`), feature scanning (`rescanMaterialFeatures()`), texture array management. Owns `materialStorageAttr` and `materialStorageNode`.
- **`EnvironmentManager.js`**: HDRI loading, CDF importance sampling (`buildEnvironmentCDF()`), procedural/gradient/solid sky generation, environment rotation. Owns `environmentTexture`, `envParams`, and the `envCDFTexture` (R32F CDF texture node).
- **`ShaderBuilder.js`**: shared scene texture-node factory — `createSceneTextureNodes()` builds the env / material-map / prev-frame MRT / gobo / IES nodes the kernels read, and configures the module-level shadow/alpha/gobo/IES shader state. In-place texture updates via `updateSceneTextures()` on model change (no shader rebuild).
- **`StorageTexturePool.js`**: Ping-pong MRT storage textures for progressive accumulation. `create()`, `swap()`, `getReadTextures()`, `ensureSize()`.
- **`KernelManager.js`**: Registers + dispatches the wavefront compute kernels (`register()`, `dispatch()`, `setDispatchCount()`). Used by `PathTracer` as `this._kernelManager`.
- **`PackedRayBuffer.js`** / **`QueueManager.js`**: SoA ray/hit/rng buffers + a per-pixel first-hit G-buffer (+ read helpers) and the active-index queues / atomic counters (`RAY_FLAG`, `COUNTER`) that drive wavefront stream compaction.
- **`TLASBuilder.js`**: Builds SAH BVH over placement AABBs for the top-level acceleration structure. Flattens with BLAS-pointer leaves (tag `BLAS_POINTER_LEAF`, slot [1] placement index + identity bit, slot [2] per-mesh visibility flag, slots 4–15 world-to-object rows). Caches flatten buffer across rebuilds.
- **`InstanceTable.js`**: Per-mesh BLAS metadata — tracks `blasOffset`, `blasNodeCount`, `triOffset`, `triCount`, `worldAABB` for each mesh. Provides O(1) AABB reads from BLAS root nodes. Entries indexed by meshIndex (positional).

### TSL Shader Modules (`rayzee/src/TSL/`)
23 TSL files using `Fn()`, `If()`, `Loop()`, `.toVar()`:
- `pathTracerMain.js`, `bvhTraverse.js`, `materialSampling.js`, `environmentSampling.js`
- `disney.js`, `transmission.js`, `directLighting.js`, `fog.js`, etc.

### Multi-Threading Architecture (`rayzee/src/Processor/Workers/`)
Critical for maintaining 60fps during heavy computations:
- **`BVHWorker.js`**: Off-main-thread BVH construction using SAH splitting with treelet optimization
- **`TexturesWorker.js`**: Batch texture processing with memory-optimized chunking
- **`BVHSubtreeWorker.js`**: BVH subtree optimization for GPU traversal
- **`CDFWorker.js`**: CDF computation for environment importance sampling
- **`BVHRefitWorker.js`**: O(N) bottom-up BVH AABB refit for animated geometry (SharedArrayBuffer protocol)

### Animation & Transform System (`rayzee/src/managers/`)
GLTF skeletal/morph animation playback and interactive object transforms with BVH refit:
- **`AnimationManager.js`**: Owns Three.js `AnimationMixer`, CPU skinning via `mesh.getVertexPosition()`, and position extraction. Key methods: `play()`, `stop()`, `seekTo(time)`, `setSpeed()`, `setLoop()`. Uses two-phase extraction: skin unique vertices first, then assemble triangles from index buffer.
- **`TransformManager.js`**: Interactive translate/rotate/scale gizmo via Three.js `TransformControls`. Creates its own `Scene` for gizmo rendering (not SceneHelpers — its `visible` guard blocks gizmo). On drag end, calls `app.updateMeshTransforms( affectedIndices )` — a gizmo only changes a placement's matrix, and triangles are stored in object space, so nothing per-vertex is read or written. Keyboard shortcuts: W=translate, E=rotate, R=scale (consolidated in `App.jsx`).
- **`VideoRenderManager.js`**: Offline frame-by-frame animation video export. Drives seek → BVH refit → SPP accumulation → OIDN denoise → canvas capture cycle per frame. Saves/restores engine state, stops rAF loop during render, delivers `ImageBitmap` frames via callback for encoding.
- **`BVHRefitter.js`** (in `Processor/`): O(N) refit algorithm — reverse pre-order traversal for bottom-up AABB recomputation. Supports both full-buffer `refit()` and per-BLAS `refitRange(startNode, nodeCount)`. Handles BLAS-pointer nodes in TLAS (reads BLAS root bounds).

**Animation data flow**:
1. `AssetLoader` preserves `data.animations` from GLTFLoader
2. `AnimationManager.init()` creates mixer on GLTF model root (with fallback to scene root for track resolution)
3. Per frame: `mixer.update(delta)` → `scene.updateMatrixWorld(true)` → `getVertexPosition()` per vertex → `refitBVH(positions)` via worker
4. `PathTracer.updateTriangleData()` / `updateBVHData()` — fast GPU buffer writes (no reallocation)

**Transform data flow**:
1. User selects object → `TransformManager.attach(object)` + `OutlineHelper` shows outline
2. Drag gizmo → `OrbitControls` disabled, `app.needsReset = true` per frame (real-time outline updates)
3. Drag end → `_recomputeAndRefit()` → `app.updateMeshTransforms(affectedIndices)`
4. Per-placement matrix write + TLAS leaf inverse rewrite + TLAS AABB refit → upload the TLAS range only → accumulation restart

**BVH refit data flow (two-level)**:
- **Full refit** (animation): `SceneProcessor.refitBVH()` → the main thread scatters each mesh's positions into the shared triangle records as it reads them, then the worker refits the whole combined BVH (TLAS + all BLASes) in SharedArrayBuffer. Positions never cross the worker boundary.
- **Per-mesh refit** (deformation): `SceneProcessor.refitBLASes(meshIndices)` → main thread updates only affected meshes' triangles, refits their BLAS ranges, rebuilds TLAS from updated AABBs
- **Rigid move** (transform gizmo): `SceneProcessor.updateMeshTransforms(meshIndices)` → no geometry at all. Writes each placement's world matrix, rewrites its TLAS leaf's world-to-object rows, refits the TLAS. ⚠️ Use this, not `refitBLASes`, for anything that only changed a transform: triangles are shared between placements of the same geometry, so baking world positions into them moves every copy.
- **Positions**: both accept either a per-mesh callback `(meshIndex, triCount) => Float32Array` — asked for one mesh at a time, and free to hand back the same scratch buffer each call — or a scene-wide Float32Array of 9 floats per triangle for **every triangle in the scene**, meshes in `app.sceneMeshes` order (public getter; DFS pre-order over `meshScene`, so it *includes* the engine-owned hidden ground-projection disk and any multi-material split product), triangles in index order, world space. **Prefer the callback**: the scene-wide array is 1,030 MB at 30M triangles and will not allocate at that size. Walking your own model instead of `sceneMeshes` silently misaligns either shape. Both are length-checked and throw; before that a short buffer wrote NaN through every AABB with no error and the scene just vanished.

**Video render data flow**:
1. `VideoRenderManager.renderAnimation()` saves engine state, stops rAF, configures final-render mode
2. Per frame: `AnimationManager.seekTo(time)` → `refitBVH(positions)` → `stopAnimation()` (kill rAF restart from reset)
3. Tight loop: `pipeline.render()` until `pathTracer.isComplete`, yielding every 4 passes
4. If OIDN enabled: `_waitForDenoise()` wraps `DENOISING_END` event as promise (30s timeout)
5. `getCanvas()` → `createImageBitmap()` → `onFrame(bitmap)` callback → `VideoEncoderPipeline.addFrame()`
6. On complete: `encoder.finalize()` → `.webm` Blob → browser download. Engine state restored.

### State Management (`app/src/store.js`)
Zustand-based stores with **automatic 3D engine synchronization**:
- `usePathTracerStore` - Rendering parameters with handlers that use `getApp()` from appProxy
- `useAssetsStore` - Model/environment loading state
- `useCameraStore` - Camera controls with DOF presets
- `useAnimationStore` - Animation playback, clip selection, speed/loop controls
- Transform state (`transformMode`, `transformSpace`, `isTransforming`) lives in `useStore` with handlers that sync to engine via `getApp()?.transform.setMode()`
- Mesh/group visibility (`toggleMeshVisibility`, `setMeshVisibility`) lives in `useStore` — toggles `object.visible` on the Three.js object then calls `app.updateAllMeshVisibility()` to update the per-mesh GPU visibility buffer
- Pattern: `handleChange()` utility creates handlers that update both store state and the app, triggering `app.reset()` for immediate visual feedback

### React Hooks for Engine Integration
- **`useActiveApp()`**: Returns the current app instance, re-renders on app changes (uses `subscribeApp()` internally)

### Data Layout & GPU Optimization
**Triangle Data Layout** (20 u32 lanes per triangle = 80 B, 5 vec4s). The buffer is bound as
`uvec4`, so a reader binds `'uvec4'` and floats come back through `uintBitsToFloat`:
```js
// EngineDefaults.js - TRIANGLE_DATA_LAYOUT
FLOATS_PER_TRIANGLE: 20         // 5 vec4s; positions carry their own normal
POSITION_A/B/C_OFFSET: 0/4/8    // f32 xyz, normal packed in the spare .w lane
NORMAL_A/B/C_PACKED_OFFSET: 3/7/11  // oct16 (packNormalOct), ~0.03° worst case
UV_AB_OFFSET: 12, UV_C_OFFSET: 16   // f32
MATERIAL_FLAGS_OFFSET: 18       // materialIndex | side << 24 | shadowBlockerBits << 26
MESH_INDEX_OFFSET: 19
```
⚠️ Any new reader of `triangleStorageAttr` must bind `uvec4` **and** pass the hit's
`instanceLeaf`: triangles of a shared geometry are in object space, not world space.

**Two-Level BVH Layout** (packed in single GPU storage buffer):
```
Combined bvhData: [ TLAS nodes ][ BLAS_0 nodes ][ BLAS_1 nodes ]...[ BLAS_M nodes ]
```
- **16 floats per node** (4 × vec4). Inner nodes store children's AABBs + child indices.
- Indices and leaf tags in slot `[3]` are **u32 bit patterns**, read with `floatBitsToUint`.
  Stored as float *values* they rounded past 2^24 and sent rays to a neighbouring node, which
  silently erased geometry from large scenes. Every valid index is below `BVH_MAX_INDEX` (2^30)
  and the tags sit above it, so `nodeTag >= BVH_MAX_INDEX` means leaf.
- **Triangle leaf** (`BVH_LEAF_MARKERS.TRIANGLE_LEAF`, 0x40000000): `[triOffset, triCount, 0, tag]`
- **BLAS-pointer leaf** (`BLAS_POINTER_LEAF`, 0x40000001): `[blasRootNodeIndex, placement, visibility, tag]`,
  and slots 4–15 hold the world-to-object matrix rows. Slot `[1]` carries the **placement** index
  masked by `TLAS_PLACEMENT_MASK`; its bit 30 (`TLAS_LEAF_IDENTITY`) says the matrix is identity,
  which is how a baked placement tells traversal to skip the ray transform.
- **Geometry storage is hybrid.** A geometry used by exactly one placement — or one that emits
  light — is **baked to world space** behind an identity leaf. A geometry shared by several
  placements stays in **object space** and the ray is moved into it on entry. Emissive instanced
  meshes are expanded to per-instance triangles so every copy lights the scene.
- **`InstanceTable`**: per-**placement** metadata (a million instances cost a matrix each, not a
  million Object3Ds). `sourceMesh[placement]` names the template; `placementRunOf(template)`
  gives that template's contiguous run. ⚠️ Never index it with a mesh/template index.
- **`TLASBuilder`**: SAH BVH over placement AABBs with cached flatten buffer

## Key Development Patterns

### Event-Driven Stage Communication
**Critical**: Stages communicate via events, not direct coupling:
```js
// PathTracer emitting events
this.eventBus.emit('pathtracer:frameComplete', { frame, samples });
this.eventBus.emit('asvgf:reset');
this.eventBus.emit('tile:changed', { tileX, tileY });

// ASVGF listening for events
this.eventBus.on('pathtracer:frameComplete', this.handlePathTracerComplete.bind(this));
this.eventBus.on('asvgf:reset', this.resetTemporalData.bind(this));
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

**While the camera moves** (interaction mode; "Fast Navigation" in the UI), `PathTracerApp` drops the render to display × `interactionRenderScale` and restores it 100 ms after the last move. Bounces and emissive NEE are untouched; the firefly limit is 8× the user's threshold (every moving frame is frame 0, where the limit is tightest). ⚠️ The wavefront reads its resolution from the **canvas backing store**, so the drop resizes that (`renderer.setSize( w, h, false )`) — `pipeline.setSize` alone is inert. The denoising manager keeps the full size, and the drop is skipped while OIDN is the live denoiser (it rebuilds its network on every size change).

### Deterministic / Headless Rendering API
Public `PathTracerApp` methods for offline rendering and reproducible output:
- **`app.setDeterministicMode( enabled = true )`** — pins every wall-clock- and readback-dependent
  input so N samples reproduce bit-for-bit. The RNG is already pure (`hash(pixel, rayIndex, frame)`,
  no clock, no `Math.random()` in any shader); what varies is *which uniforms and dispatch grids are
  live on frame k*. Disables adaptive sampling, pixel freeze, the readback-driven per-bounce early
  exit and dynamic dispatch sizing (kernels bind on `ENTERING_COUNT`, so an under-sized grid silently
  drops rays), interaction mode, auto-focus and auto-exposure. Reversible; leaves rAF stopped.
- **`await app.renderFrames( n, { reset, yieldEvery, onProgress, allowEarlyRetire } )`** —
  accumulates `n` samples synchronously, returning the count reached. Awaits the STBN atlases (until
  they land the sampler reads a constant-0.5 placeholder that bakes into accumulation), raises
  `maxSamples` through the settings handler (`completionThreshold` is a cached JS number — writing
  the uniform alone does nothing), and calls `stopAnimation()` after `reset()` because `reset()`
  re-wakes rAF.
  ⚠️ **`renderFrames` and adaptive sampling are mutually exclusive.** A frame retired by
  `_isConvergedComplete()` stops advancing `frameCount` (`PathTracer.render()` early-returns at the
  top), so a fixed-count loop can never reach `n`. `setDeterministicMode` clears
  `useAdaptiveSampling`, which is why the bench never hits it; anything running the shipping
  adaptive path must pass `allowEarlyRetire: true` and compare the returned count against `n`.
- **`await app.renderToBuffer( { colorSpace, preserveAlpha } )`** — pixels without the canvas, so it
  works headless, works while the page is hidden, and cannot pick up a helper overlay. `'linear'`
  is the raw accumulation, `'srgb'` applies exposure/saturation/tone curve in the output pass's
  order. ⚠️ Reads `pathtracer:color`, **upstream of the Compositor** — denoising and bloom are
  absent. Use `getCanvas()` for what the viewport shows.
- **`app.enableGPUTiming( bool )` / `await app.getGPUTimings()`** — real GPU milliseconds from WebGPU
  timestamp queries. `pipeline.getStats()` is **not** a GPU metric: it times command encoding on the
  CPU and stays flat while GPU cost doubles.

`app.stages.pathTracer.blueNoiseReady` resolves when both STBN atlases have loaded.

`rayzee/src/Headless.js` wraps the above as the supported entry point — `renderHeadless()` for one
frame, `openHeadless()` to keep a live app across several, `captureHeadless()` to accumulate and read
back. Defaults are the batch renderer's (`strict`, `profile: 'physical'`, `deterministic`).
`bench/harness/boot.js` boots through it, so the suite and production share one driver; the bench
passes `profile: 'viewer'` and `strict: false` explicitly, and both are load-bearing — `physical`
would change every golden, and `strict` would abort a run before the runner reported.

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
  result for that reason. Any new allSettled aggregation needs the same.

### Settings Provenance & Render Profiles
- **`settings.getEffective()`** — every live setting as `{ value, source, routed }`. `source` is one
  of `SETTING_SOURCE` (default / host / scene-metadata / mode-preset); `routed: false` means stored
  but reaching no stage, which is how a typo becomes a wrong image.
- **`RENDER_PROFILES`** (`EngineDefaults.js`) — product decisions for a real-time viewer that are not
  physical constants, collected so choosing between them is one flag rather than a hunt:
  `areaLightIntensityScale` (glTF placeholder area-light power), `environmentRotation`, `toneMapping`,
  `saturation`. `viewer` is the default and `ENGINE_DEFAULTS` mirrors it exactly; both show AgX at neutral
  saturation. `new PathTracerApp( canvas, { profile: 'physical' } )`; an unknown name
  throws rather than silently selecting viewer tuning.
- **Material defaults** — `MATERIAL_DEFAULTS` (`EngineDefaults.js`) is the only fallback for a
  property a three.js material lacks (MeshPhysicalMaterial's own values), and `packMaterial()`
  (`Processor/MaterialPacking.js`) is the only writer of the material block, for the scene upload
  and runtime edits alike. `app.getMaterialPropertySource( i, prop )` answers
  `material | mapped | default | host`. ⚠️ Never derive a default from another property: "metalness
  factor > 0.1 ⇒ IOR 2.5" made every ORM-textured glTF 4.6× too shiny on its non-metal parts.
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

`app.color` is an OpenColorIO pipeline covering all three sides: what textures and lights *mean*,
what the render happens *in*, and what it is *shown* and *saved* as. **It is inert until a host
loads a config** — the working space stays linear Rec.709, the view transforms stay three.js's own
seven, and nothing converts anything. No config means no behaviour change.

```js
configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );  // the host names it
await app.loadColorConfig( { builtin: 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5' } );
app.color.setView( { display: 'sRGB - Display', view: 'ACES 2.0 - SDR 100 nits (Rec.709)', look } );
app.color.setContext( { SHOT: '010' } );          // $SHOT in the config resolves to this
app.color.setWorkingSpace( 'ACEScg' );            // then: await app.applyColorWorkingSpace()
await app.renderToBuffer( { colorSpace: 'ACES2065-1' } );   // a delivery buffer, not a picture
await app.unloadColorConfig();
```

⚠️ **Load and unload through `app.loadColorConfig()` / `app.unloadColorConfig()`**, not
`app.color` directly, once a scene exists. They undo an adopted working space *while the old
config is still loaded* — the environment is converted in place, and only the config that
converted it can convert it back. `app.color.unloadConfig()` with a space adopted records an issue
saying the environment was left converted.

- **OCIO's own console output goes through the engine logger** (`[ocio]` namespace) via the WASM
  module's `print`/`printErr` hooks — its environment is internal, so `OCIO_LOGGING_LEVEL` cannot be
  set. "Info" lines go to `debug`: the ACES CG v1.0.0 config lists four Studio-only displays as
  inactive and OCIO notes it on every load. Warnings and errors still show.
- **The engine never names the OCIO package.** It is ~6 MB of WebAssembly; a bare specifier in
  engine source would make it a hard dependency of every host, and `@vite-ignore` leaves the browser
  unable to resolve it. The host supplies `ocioRuntimeFactory` or `ocioRuntimeUrl`. The app does
  this lazily, on first open of the config menu, so a session that never touches colour pays
  nothing.
- **One registry, four consumers.** `ViewTransforms.js` is the single list; the TSL graph that
  paints the canvas, the WGSL readback (`ToneMapGPU`), the JavaScript readback (`ToneMapCPU`) and
  the host's menu are all derived from it. Adding a view at runtime therefore reaches all four —
  `getRegistryVersion()` moves and the shaders rebuild.
- ⚠️ **An OCIO view returns display-encoded colour; the built-in seven return linear.** That is what
  `outputEncoded` records. `ColorManagement` sets `renderer.outputColorSpace` to linear while an
  OCIO view is active and the readback skips its sRGB step. Get it wrong and every image is encoded
  twice — washed out with crushed blacks.
- ⚠️ **`library.addToneMapping` refuses to redefine an id** — it warns and returns without
  replacing. A rebaked view keeps its id, so `registerWithRenderer` deletes the old entry first, and
  `OcioViews` reuses the *same* `Data3DTexture` and TSL node across rebakes (swapping the pixels,
  as `UniformManager` does with uniforms). Without both, the canvas runs the previous table while
  the readback runs the new one.
- **Adopting the working space is opt-in and rebuilds the scene.** A texture authored against sRGB
  primaries means different light in ACEScg, so `setWorkingSpace()` must be followed by
  `applyColorWorkingSpace()`: textures and materials re-pack from their pristine three.js sources,
  and the environment converts where it lies (its current space is recorded on the texture, which
  is what lets it be turned back off). The texture cache key includes the working space.
- **Input resolution** is tag (`userData.ocioColorSpace`) → override → the config's own file rules
  → what three.js already believes, mapped onto the config's *roles*. A default file rule matches
  everything, so it loses to three.js's own tag. `TextureCreator` runs the full named transform
  only for an *explicit* answer (tag, override, non-default rule), and refuses even that for a
  layer `_harmonizeTransfer` re-encoded or a float source the packer quantized — the bytes are no
  longer in the named space. Everything else gets the primaries matrix. The texture cache key is
  `cm.inputKey` (config + working space + overrides + context), not the working space alone.
- **Until a working space is adopted, the render is linear Rec.709 named the way *that* config
  names it** (`findNativeLinearSpace`, aliases included). A hardcoded ACES spelling broke every view
  bake on configs without that alias.
- ⚠️ **Colour lives in more buffers than the material buffer.** `EmissiveTriangleBuilder` keeps its
  own copy of each emitter's colour — the one next-event estimation lights the scene with — and the
  shader's pick probability reads the *material* buffer's. Both are converted, and
  `applyColorWorkingSpace()` rebuilds the emitter list (`rebuildEmissiveColors`); miss either and
  emitters are seen in one space and cast light in another.
- ⚠️ **The skies reuse one texture.** `ProceduralSky` / `SimpleSky` clear
  `userData.__rayzeeColorSpace` whenever they rewrite pixels; without that the record says
  "already converted" and a new sky is never converted. `EnvironmentManager.markDirty()` bumps the
  version *without* new pixels, which is why this is a record and not a version check.
- **Context variables are read from the config's text** (`environment:` block plus `$VAR`
  references). OCIO's description of a loaded config does not carry file-transform paths, which is
  where they live. The panel offers one input per variable.
- **The table ceiling is managed.** Every display/view/look/context combination is its own table;
  `setView` evicts the least recently selected (never the active one) at `MAX_TABLE_TRANSFORMS`.
- **Degradations are warnings.** Every colour issue is recorded with `warn()`: `record()` defaults
  to error, and the headless entry point is strict, so an error-level record would abort a batch
  render for baking an HDR view.
- **Per-texture colour space**: `app.setTextureColorSpace( texture, choice )` — `null` (auto),
  `'srgb'`, `'linear'`, or a config space — then rebuilds. The Material tab shows it under the
  albedo and emissive maps only; every other slot is packed as data. The texture cache hash
  includes `colorSpace` and `userData.ocioColorSpace`; before it did, a changed colour space was
  answered from the cache and silently ignored.
- **Views rebake lazily.** A `$SHOT` or working-space change rebakes the view on screen;
  `setActiveView` refreshes any other when it is next chosen (`_isStale`). Twelve registered
  views at ~0.1 s each used to freeze the UI for over a second.
- **Display P3 reaches the screen.** three.js configures the WebGPU canvas without a colour space
  (always sRGB) and reconfigures it on every resize. `ColorManagement` wraps that context's
  `configure` so a Display P3 view gets `display-p3` and keeps it. HDR views are not shown in HDR:
  that needs the renderer's canvas format changed to half-float at construction and a PQ-to-
  extended-range conversion.
- **EXR export** (`app/src/lib/colorManagement.js` → `saveEXR`) writes
  `renderToBuffer( { source: 'display' } )` — the denoised image the viewport shows, without bloom,
  read through `Processor/TextureReadback.js` (a pixel-exact copy pass, since OIDN's output is an
  ExternalTexture no render target owns) — in the chosen space through three's `EXRExporter`. ⚠️ The readback is top row first and the exporter
  assumes bottom row first, so rows are flipped before encoding. A PNG screenshot is a picture and
  never takes an export space.

#### The app's section (`ColorManagementSection.jsx`)

Its own group in the Path Tracer tab, modelled on Blender — the OCIO client that does most for
artists: project settings first (**Color**, **Render In** — set once, rebuild the scene), then view
settings (Display, View, Look, Exposure), then **Save EXR**. One **View** menu, no separate
tone-mapping control. Exposure is in stops (`2^EV`); the store still holds the multiplier.

Every label and filter lives in `app/src/lib/colorLabels.js`, derived from what the config carries —
OCIO's guidance is to build menus from UI name, family and description, filtered by category:
- **Color**: one preset per ACES version (the newest CG config of it), "Load config folder…" as a
  menu item, other versions grouped below. ⚠️ The runtime's builtin names carry no `ocio://`.
- **Render In**: spaces tagged `working-space` *and* linear (ACES: Rec.709, ACEScg, P3-D65); untagged
  configs fall back to the linear family narrowed to the well-known gamuts. Never the interchange space.
- **Display** drops the ACES " - Display" suffix and lists what this screen can show first
  (`displayCanvasFit` in `rayzee/src/Color/Displays.js`, the one rule the canvas also uses).
- **View** labels are the view's own name, with detail added back only where two would collide.
- **Look** follows the view as Blender's does — measured: with AgX Blender accepts only "AgX - …"
  looks, with Standard only the unprefixed ones. Gamut compression and LMTs are grouped as technical.
- **Texture colour space**: spaces tagged `texture`, grouped by family.
- ⚠️ `describeConfig()` must carry `categories`. Without them every tag filter silently falls back
  to name matching — the tests passed by coincidence until that was caught.

Defaults: no config; display and view from the config's defaults; look None; 0 EV; render in
linear Rec.709 until the artist picks another. The accuracy readout is API-only (`status().bakeError`).

#### Shaper + table

A view is baked to a log2 shaper over 25 stops feeding a 65³ cube, interpolated tetrahedrally —
the arrangement OCIO emits for its own GPU path. OCIO is the source of truth and the validator, not
the runtime: a table is the only representation that is identical in a TSL graph, a WGSL compute
pass and plain JavaScript, and a saved image differing from the viewport is a worse failure than a
third of a code value. `entry.error` carries what the table cost, measured against the real
processor during the bake.

⚠️ Grid index 0 is baked from **exactly 0**, not from 2^minEv. Without that, true black leaves the
table one code value above zero and every render has a raised black floor.

**Measured** (Apple M-series, ACES 2.0 SDR view, `bench:upscale` gates GPU against CPU):

| | |
|---|---|
| table vs OCIO CPU | mean 0.07, p95 0.19 code values; 99.85 % within 2 — measured on the half table the GPU samples, which the CPU readback now samples too |
| live canvas vs readback | 0.5 levels, identical for OCIO and built-in views — the readback's deliberate half-level bias (screenshot pixel crops, measured in the app) |
| worst case | ~18 code values on saturated colours brighter than white — a clip edge in ACES 2.0's gamut compressor that no table can represent |
| GPU readback | **+1.4 µs/megapixel** over any analytic curve (~3 %); the pass is memory-bound, so the seven built-ins are indistinguishable from each other |
| CPU readback | 60 ms/megapixel, against 27 (None) and 76 (three.js AgX) — the table is *cheaper* than the polynomial it replaces |
| bake | 20 ms at 33³, 93–127 ms at 65³ |
| VRAM | 2.10 MB per registered view at 65³, **per device** |
| host memory | 2.1 MB per registered view — the CPU sampler reads the half table in place through a shared 256 KB decode table (a float copy used to add 4.4 MB a view) |
| runtime | 4.76 MB wasm + 1.39 MB Naga, fetched only when a config is opened; starts in ~32 ms and reserves a 64 MB WebAssembly heap; a config loads in ~35 ms |
| adopting a working space | 1.9 s on the 3.5M-tri / 642-texture test model, of which ~1.1 s is the ordinary material rebuild and 0.62 s texture conversion (was 3.0 s: three `Math.pow` a pixel, now a sqrt-indexed 64K table, 0.09 % of values one level off). Still on the main thread. Reverting ~1.0 s |
| EXR save | ~100 ms at 512²; the float copy target is released after each save (132 MB at 4K) |

`MAX_TABLE_TRANSFORMS` is 12: the readback binds every table in one shader and WebGPU only
guarantees 16 sampled textures per stage.

### Denoising Pipeline Coordination
- **One denoiser owns the live view** — `Real-Time Denoiser` is a one-of-N choice (None / EdgeAware /
  ASVGF / NRD / **OIDN**), and `Final Denoise (OIDN)` is the separate question of whether the
  finished image gets a pass. Two live denoisers would mean paying for one whose result the other
  covers.
- **Every denoiser publishes a texture; the Compositor picks the newest.** `asvgf:output`,
  `nrd:output`, `edgeFiltering:output`, `oidn:output` — `Compositor._resolveSourceTexture()` is the
  priority chain and `DenoisingManager._clearDenoiserTextures()` is the list that wipes them. There
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
- A **final render suspends the live refresh** (`setCadenceSuspended`, first statement of
  `configureForMode`): it shows its own accumulation and denoises once at the end. Leaving it running
  denoised the image twice and raced the renderer's output-pass rebuild.
- EdgeAware filtering disabled when ASVGF enabled
- Quality presets in `ASVGF_QUALITY_PRESETS` (performance/balanced/quality)

### Neural post passes (`rayzee/src/dlss/`)
Two DLSS ports that run **once, when a render completes**, on the hook `DenoisingManager.onRenderComplete`
already provided for the ONNX upscaler — not on a cadence. Both are off by default and both need a
denoised frame; on raw Monte-Carlo noise they measurably lose to a plain resize, so the app disables
their switches unless `Final Denoise (OIDN)` is on.
- **Super resolution** (`DLSSSuperRes.js`) is a second *backend* of the existing AI Upscaler
  (`denoisingManager.upscalerBackend`, `'esrgan' | 'dlss'`), fixed at 2x. **Retouch**
  (`DLSSNeural.js`) changes appearance, not resolution, and is its own switch.
- Order is **denoise → retouch (at render size) → super resolution (2x) → tone map**, scene-referred
  throughout. The retouch pass runs *first* deliberately: above `DLSS_NR_MAX_PIXELS` (4.19 MP) it
  takes minutes and then **loses every GPU device in the page**, and at render size it is a quarter
  of the pixels it would see after the upscale.
- ⚠️ Every crossing of the CPU boundary is a compute pass — `readDenoisedHalf` packs the denoised
  frame on the renderer's device, results leave a model's device as display bytes or packed halves.
  Converting in JS cost more than the network itself at production sizes. **Do not reintroduce a
  linear-float path**; `Processor/ToneMapGPU.js` is the GPU tone curve these read back through.
- ⚠️ `ToneMapGPU.js` is a second implementation of `toneMapToRGBA8` and must stay bug-compatible with
  it, rounding included. `bench:upscale` gates the two against each other on a real device, because
  vitest has no GPU.
- ⚠️ Each model brings **its own `GPUDevice`**, not shareable. With both on the page holds three.
- ⚠️ `app/public/dlss/dlss-runtime.js` is a **vendored, patched** bundle. The edits are marked
  `rayzee-patch` and written up in `app/public/dlss/PATCHES.md`; re-vendoring without re-applying
  them breaks the retouch pass. Its URL is `AssetConfig.dlssRuntimeUrl` — a plain script the host
  serves, since it installs `globalThis.DLSSRuntime` and cannot be imported.

### Asset Processing Workflow
1. **AssetLoader** loads GLB/GLTF models with automatic camera extraction
2. **GeometryExtractor** converts meshes to the 20-lane triangle records, baking single-use and emissive geometry to world space and leaving shared geometry in object space; records per-mesh `meshTriangleRanges`. It never rewrites a host's own geometry (`userData.__rayzeeExternal` subtrees are left alone), and anything skinned or morphed is given triangles of its own so a refit cannot pose every copy at once.
3. **SceneProcessor** builds two-level BVH (TLAS/BLAS): per-mesh BLAS via `BVHBuilder` (parallel for large meshes via `Promise.all`), then `TLASBuilder` builds SAH tree over mesh AABBs, then assembles combined buffer `[TLAS | BLAS_0 | BLAS_1 | ...]`
4. **TextureCreator** generates GPU textures for materials (runs in parallel with BVH build)

### Loading part of a scene archive
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
  and the build reports itself truncated. 45M is the highest rung measured to survive — 50M
  killed the renderer outright — so raising it is a deliberate act on a fresh browser.

## Development Commands

### Debug Visualizations (visMode uniform)
Access via Path Tracer tab → Debug Mode:
- `1-2`: BVH traversal statistics (triangle/box tests)
- `3`: Ray distance visualization
- `4`: Surface normals
- `6`: Environment map luminance heat map
- `7`: Environment importance sampling PDF

### Performance Profiling
The engine emits `EngineEvents.FRAME` once per `animate()` tick. Hosts attach their own stats panel (e.g. `stats-gl`) — the app does this in `app/src/components/layout/Viewports/StatsPanel.jsx`. Other built-in profiling signals:
- Triangle intersection counters in shaders
- BVH construction timings with treelet optimization metrics
- Memory usage tracking for texture arrays
- Progressive rendering convergence monitoring

## Critical Implementation Details

### Pipeline Architecture
Event-driven stage pipeline with TSL compute kernels compiled to WGSL. All engine code lives in `rayzee/src/`. The path tracer is a pure-wavefront renderer: `PathTracer extends PathTracerStage`, where the base delegates to 5 sub-managers: `UniformManager`, `MaterialDataManager`, `EnvironmentManager`, `ShaderBuilder`, and `StorageTexturePool`. External code (other stages, PathTracerApp) accesses sub-managers directly — e.g., `stage.uniforms.get()`, `stage.materialData.*`, `stage.environment.*`. See `docs/PIPELINE_ARCHITECTURE.md` and `docs/PATH_TRACER_SHADER_ARCHITECTURE.md` for details.

### Memory Management
Web Workers handle large data processing with chunked allocation:
```js
// TexturesWorker.js pattern
const MEMORY_LIMITS = {
    MAX_BYTES_PER_TEXTURE: 256 * 1024 * 1024,  // 256MB chunks
    ADAPTIVE_CHUNK_SIZE: true                   // Dynamic based on texture dimensions
}
```

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

### Shader Data Access Pattern
Materials and BVH data accessed via storage buffer lookups in TSL:
```js
// Standard pattern in TSL shaders
const getDatafromStorageBuffer = Fn(([buffer, index, offset, stride]) => { ... })
```
BVH traversal (`BVHTraversal.js`) uses stack-based DFS with two-level dispatch: TLAS inner nodes → BLAS-pointer leaves (per-mesh visibility read from the leaf's slot [2]; skip BLAS if hidden, else push BLAS root onto stack) → BLAS inner nodes → triangle leaves (inline Möller-Trumbore + inline side culling via the per-triangle side flag in `normalCData.w`). Both `traverseBVH` (closest hit) and `traverseBVHShadow` (any hit, early exit) gate on mesh visibility. The visibility flag is packed into the TLAS BLAS-pointer leaf by `TLASBuilder.flatten()` and patched at runtime by `PathTracerStage._patchTLASLeafVisibility()` — there is no separate visibility buffer.

### Camera & DOF System
Photography-inspired presets (`CAMERA_PRESETS`) for portrait/landscape/macro with proper focal length calculations. Focus picking via click-to-focus interaction mode.

## Common Pitfalls & Solutions

1. **Store Updates**: Always use provided handlers (e.g., `handleBouncesChange`) rather than direct setters — they sync with the app via `getApp()`
2. **App Access**: Always use `getApp()` from `@/lib/appProxy` to access the app instance
3. **TSL Hot Reload**: TSL shader changes hot-reload normally via Vite
4. **Worker Data Transfer**: Use transferable objects for large arrays to avoid main thread blocking
5. **BVH Memory**: Large models may require treelet optimization (`treeletOptimization: true`) for performance
6. **Resolution Scaling**: Path tracer resolution independent of UI — use `app.setCanvasSize( width, height )` (pixel dimensions, applied immediately; internal `_applyRenderResize()`). Requested size is clamped by `MAX_STORAGE_TEXTURE_SIZE` (`_isRenderSizeSupported`). Note: `onResize()` (reads `canvas.clientWidth/Height`) is debounced 300ms; `setCanvasSize()` is not.
7. **React Compiler**: Uses React Compiler plugin — avoid manual memoization patterns that conflict with automatic optimization
8. **Feature Guards**: Check stage availability before accessing optional stages (e.g., `app.asvgfStage?.enabled`)
9. **BVH Leaf Markers**: slot `[3]` is a u32 bit pattern — `TRIANGLE_LEAF` (0x40000000) or `BLAS_POINTER_LEAF` (0x40000001), both above `BVH_MAX_INDEX`, so `floatBitsToUint(nodeData0.w) >= BVH_MAX_INDEX` means leaf. `BVHRefitter` has inline copies of these constants (cannot import EngineDefaults in worker context).
10. **InstanceTable Entry Order**: Entries are indexed by `meshIndex` (positional). Use `setEntry()` with explicit index, never push-based insertion, to avoid ordering bugs with mixed sync/async BLAS builds.
11. **Transform vs Deformation vs Animation**: a rigid move uses `updateMeshTransforms()` (matrix only — no vertex pass, no BLAS work, no triangle upload). Deformation of specific meshes uses `refitBLASes()` (per-mesh, sync, main thread). Animations use `refitBVH()` (full scene, async, worker). Don't mix them — the worker path operates on SharedArrayBuffer that must match the combined TLAS/BLAS layout. Build the positions buffer from `app.sceneMeshes`, never from your own model root (see **BVH refit data flow** above).
12. **Mesh Visibility**: Controlled per-mesh at the BLAS-pointer level in BVH traversal, NOT per-material. Use `app.updateAllMeshVisibility()` after changing `object.visible` on any Three.js object/group — it walks the parent chain to resolve world-visibility and patches the visibility flag into each TLAS leaf (slot [2]) via `_patchTLASLeafVisibility` (no separate GPU buffer). Material-level `visible` was removed from the pipeline. Front/back/double-side culling is handled inline in `traverseBVH` via the per-triangle side flag (`normalCData.w`).
