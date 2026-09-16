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
- **`TLASBuilder.js`**: Builds SAH BVH over mesh-level AABBs for the top-level acceleration structure. Flattens with BLAS-pointer leaves (marker `-2`, slot [1] `meshIndex`, slot [2] per-mesh visibility flag). Caches flatten buffer across rebuilds.
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
**Triangle Data Layout** (32 floats per triangle, vec4-aligned):
```js
// EngineDefaults.js - TRIANGLE_DATA_LAYOUT
FLOATS_PER_TRIANGLE: 32  // 8 vec4s for GPU efficiency
POSITION_A_OFFSET: 0     // 3 vec4s for positions (A,B,C)
NORMAL_A_OFFSET: 12      // 3 vec4s for normals (A,B,C)
UV_AB_OFFSET: 24         // 2 vec4s for UVs + material index
```

**Two-Level BVH Layout** (packed in single GPU storage buffer):
```
Combined bvhData: [ TLAS nodes ][ BLAS_0 nodes ][ BLAS_1 nodes ]...[ BLAS_M nodes ]
```
- **16 floats per node** (4 × vec4). Inner nodes store children's AABBs + child indices.
- **Triangle leaf** (marker `-1`): `[triOffset, triCount, 0, -1]` — absolute index into triangleData
- **BLAS-pointer leaf** (marker `-2`): `[blasRootNodeIndex, meshIndex, visibility, -2]` — TLAS leaf pointing to a BLAS root; slot [2] is the per-mesh visibility flag (1=visible, 0=hidden), read for free during traversal
- Traversal distinguishes leaf types via threshold: `nodeData0.w > -1.5` → triangle leaf, else → BLAS pointer (check per-mesh visibility, push onto stack if visible)
- **`InstanceTable`**: CPU-side per-mesh metadata (blasOffset, blasNodeCount, triOffset, triCount, worldAABB)
- **`TLASBuilder`**: SAH BVH over mesh AABBs with cached flatten buffer

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

Mode switching lives in app-store handlers `handleConfigureForPreview` / `handleConfigureForFinalRender` / `handleConfigureForResults` (in `app/src/store.js`), which delegate to the engine method `app.configureForMode( mode, { canvasWidth, canvasHeight } )` — `mode` is `'interactive' | 'production'`. `configureForMode()` batch-updates uniforms via `settings.setMany({...}, { silent: true })`, toggles OIDN/controls, and calls `reset()`.

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
  `saturation`. `viewer` is the default and `ENGINE_DEFAULTS` mirrors it exactly; `physical` selects
  AgX and drops the grade. `new PathTracerApp( canvas, { profile: 'physical' } )`; an unknown name
  throws rather than silently selecting viewer tuning.
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

### Denoising Pipeline Coordination
**Temporal filtering coordination**:
- ASVGF (real-time) vs OIDN (final quality) - never both simultaneously
- EdgeAware filtering disabled when ASVGF enabled
- Quality presets in `ASVGF_QUALITY_PRESETS` (performance/balanced/quality)

### Asset Processing Workflow
1. **AssetLoader** loads GLB/GLTF models with automatic camera extraction
2. **GeometryExtractor** converts meshes to optimized triangle data (32-float layout), records per-mesh `meshTriangleRanges`
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
9. **BVH Leaf Markers**: `-1` = triangle leaf, `-2` = BLAS-pointer leaf. Traversal uses threshold `-1.5` to distinguish. `BVHRefitter` has inline copies of these constants (cannot import EngineDefaults in worker context).
10. **InstanceTable Entry Order**: Entries are indexed by `meshIndex` (positional). Use `setEntry()` with explicit index, never push-based insertion, to avoid ordering bugs with mixed sync/async BLAS builds.
11. **Transform vs Deformation vs Animation**: a rigid move uses `updateMeshTransforms()` (matrix only — no vertex pass, no BLAS work, no triangle upload). Deformation of specific meshes uses `refitBLASes()` (per-mesh, sync, main thread). Animations use `refitBVH()` (full scene, async, worker). Don't mix them — the worker path operates on SharedArrayBuffer that must match the combined TLAS/BLAS layout. Build the positions buffer from `app.sceneMeshes`, never from your own model root (see **BVH refit data flow** above).
12. **Mesh Visibility**: Controlled per-mesh at the BLAS-pointer level in BVH traversal, NOT per-material. Use `app.updateAllMeshVisibility()` after changing `object.visible` on any Three.js object/group — it walks the parent chain to resolve world-visibility and patches the visibility flag into each TLAS leaf (slot [2]) via `_patchTLASLeafVisibility` (no separate GPU buffer). Material-level `visible` was removed from the pipeline. Front/back/double-side culling is handled inline in `traverseBVH` via the per-triangle side flag (`normalCData.w`).
