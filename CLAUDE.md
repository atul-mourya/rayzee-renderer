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
- `tests/gpu/` (Vitest project `gpu`) runs on the real GPU in Node through Dawn — the `webgpu`
  package, the same WebGPU implementation Chrome ships. `evaluate()` in `tests/gpu/gpu.js` runs a TSL
  function per element and returns the buffer, so a shader function or a CPU/GPU twin is tested in
  milliseconds. Skipped on CI (no Vulkan driver there); on a workstation a missing adapter fails the
  run. ⚠️ Dawn segfaults the process if its `create()` result is garbage-collected while a device
  lives — `tests/gpu/environment.js` holds it for that reason.

### Regression Bench (`bench/`)
Headless-GPU regression detection for quality, performance, and memory. See `bench/README.md`.
- `npm run bench` - quality + memory + perf against the working tree
- `npm run bench:bless` - regenerate goldens / ground truth (required on a new machine)
- `npm run bench:ab -- main` - gate perf against another git ref (same-session interleaved A/B)
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
when a host sets nothing — a default setting, a mode preset, a `RENDER_PROFILES` value, light units,
a sampling or BSDF change that moves the goldens — gets a `BREAKING CHANGE:` footer saying how default
renders change, so semantic-release makes it a major. Farms pin a major to pin a look and calibrate
against it; 7.28 → 9.1 moved their image by 29.5/255 with no breaking note. Two tripwires:
`tests/unit/constants/pixelDefaults.test.js` snapshots the defaults, profiles and presets (update with
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
- **`EventDispatcher.js`**: Loose coupling via events (e.g., `pathtracer:frameComplete`, `asvgf:reset`)

### Core Rendering Stages (`rayzee/src/Stages/`)
**Execution order matters** - stages run sequentially:
- **`PathTracer.js`** + **`PathTracerStage.js`**: Pure-wavefront Monte Carlo path tracer with MRT outputs. `PathTracer` (the wavefront renderer) extends the `PathTracerStage` base (shared engine/scene infrastructure).
- **`ASVGF.js`**: Real-time spatiotemporal denoising
- **`NRD.js`**: Port of NVIDIA NRD's ReBLUR (recurrent blur) denoiser — strategy `'nrd'`; reads roughness from `pathtracer:shadingNormal.w` (NormalDepth) and the secondary hit distance from `pathtracer:albedo.w` (written by Shade at camera depth 1). Progressive-aware: passes the frame through untouched once the input has `handoverFrames` samples. See `docs/NRD_DENOISER.md`. ⚠️ TSL shares texture bindings by texture uuid — every deferred-read `TextureNode` in a kernel needs its own placeholder texture (see `readNode()` there).
- **`EdgeFilter.js`**: Temporal filtering with edge preservation
- **`OverlayManager.js`** + **`helpers/`** (in `managers/`): visual helpers, drawn at **view resolution** (canvas bounding rect × DPR — so viewport zoom counts), never at the path tracer's render resolution. Two layers: a 3D scene layer (`ViewOverlayRenderer` — a transparent canvas with its own WebGPURenderer sharing the main `GPUDevice`; hosts light gizmos, the transform gizmo, and `OutlineHelper`) and a 2D HUD canvas (`TileHelper` — OIDN-denoise / AI-upscale progress borders). Both are separate canvases, so helpers can never be baked into saved images. The scene layer's renderer is created and initialised at startup, but its surface (~30 MiB) is allocated only when a helper first becomes visible, and it parks itself (`display:none`) when none are.

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
- **`EnvironmentManager.js`**: HDRI loading, CDF importance sampling (`buildEnvironmentCDF()`), physical/gradient/solid sky generation, environment rotation. Owns `environmentTexture`, `envParams`, and the `envCDFTexture` (R32F CDF texture node) — except while the physical sky is on, whose two textures `PhysicalSky` owns and fills on the GPU.
- **`ShaderBuilder.js`**: shared scene texture-node factory — `createSceneTextureNodes()` builds the env / material-map / prev-frame MRT / gobo / IES nodes the kernels read, and configures the module-level shadow/alpha/gobo/IES shader state. In-place texture updates via `updateSceneTextures()` on model change (no shader rebuild).
- **`StorageTexturePool.js`**: Ping-pong MRT storage textures for progressive accumulation. `create()`, `swap()`, `getReadTextures()`, `ensureSize()`.
- **`KernelManager.js`**: Registers + dispatches the wavefront compute kernels (`register()`, `dispatch()`, `setDispatchCount()`). Used by `PathTracer` as `this._kernelManager`.
- **`PackedRayBuffer.js`** / **`QueueManager.js`**: SoA ray/hit buffers (the path's RNG state is hit slot `HIT.RNG` — its own buffer would put Shade at 11 storage buffers; the uvec4 slot costs 12 B a ray more than the old 4 B buffer, 592 → 640 MB of ray buffers on this Mac's path budget) + a per-pixel first-hit G-buffer (+ read helpers) and the active-index queues / atomic counters (`RAY_FLAG`, `COUNTER`) that drive wavefront stream compaction.
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
- **`CDFWorker.js`**: CDF computation for environment importance sampling (HDRIs and the simple skies; the physical sky builds its own on the GPU)
- **`BVHRefitWorker.js`**: O(N) bottom-up BVH AABB refit for animated geometry (SharedArrayBuffer protocol)

### Animation & Transform System (`rayzee/src/managers/`)
glTF / pbrt animation playback and interactive object transforms:
- **`AnimationManager.js`**: Owns Three.js `AnimationMixer`. Key methods: `play()`, `stop()`, `seekTo(time)`, `setSpeed()`, `setLoop()`. Two modes, picked at `init()`: **deforming** (any SkinnedMesh or morph track) — CPU skinning via `mesh.getVertexPosition()`, returned as a per-mesh reader for `refitBVH`; **rigid** (everything else) — `update()`/`seekTo()` return null and hand only the meshes whose world matrix or visibility changed to `applyPoseCallback` → `PathTracerApp._applyAnimationPose` (placement matrices + TLAS refit, visibility flags, followed camera). `stop()` re-applies the restored pose. ⚠️ Never refit a rigid clip: triangles are shared between placements of one geometry, so baking a pose moves every copy.
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
- **Full refit** (animation): `SceneProcessor.refitBVH()` → the main thread scatters each mesh's positions into the shared triangle records as it reads them, then the worker refits the whole combined BVH (TLAS + all BLASes) in SharedArrayBuffer. Positions never cross the worker boundary.
- **Per-mesh refit** (deformation): `SceneProcessor.refitBLASes(meshIndices)` → main thread updates only affected meshes' triangles, refits their BLAS ranges, rebuilds TLAS from updated AABBs
- **Rigid move** (transform gizmo): `SceneProcessor.updateMeshTransforms(meshIndices)` → no geometry at all. Writes each placement's world matrix, rewrites its TLAS leaf's world-to-object rows, refits the TLAS. ⚠️ Use this, not `refitBLASes`, for anything that only changed a transform: triangles are shared between placements of the same geometry, so baking world positions into them moves every copy.
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
// EngineDefaults.js - TRIANGLE_DATA_LAYOUT
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
Kernels take the pair as `triangleBuffer = { geo, shade }` (`stage.triangleStorageNode`).
⚠️ Read a row only through `triangleRow( tris, triIndex, row )` (`TSL/Common.js`), and pass the
hit's `instanceLeaf`: triangles of a shared geometry are in object space, not world space.

**Two-Level BVH Layout** (packed in single GPU storage buffer):
```
Combined bvhData: [ TLAS nodes ][ BLAS_0 nodes ][ BLAS_1 nodes ]...[ BLAS_M nodes ]
```
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
  L4's host. The two differ by one level on ~0.002 % of bytes. `source: 'accumulation'` (default) reads
  `pathtracer:color`, upstream of the Compositor; `source: 'display'` reads what the Compositor
  resolves (denoised, no bloom). The result's `source` names what was read, and a `'display'` read
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
- **`app.getProvenance()`** — plain JSON of what produced the image (versions, profile by name and
  value, adapter, `settings.getEffective()`, colour, render size/samples, headless/strict/deterministic/
  lockstep). `captureHeadless` returns it as `provenance`.
- **`await app.runFinalDenoise()`** — one OIDN pass at the final tier, awaited, without the render
  loop or the upscaler (`DenoisingManager.denoiseOnce()`: waits out a run or weight load in flight,
  which `start()` would refuse or defer). OIDN must have been on while accumulating — the aux
  buffers are written only then. Failure records `denoiser.unavailable`.
- **`app.enableGPUTiming( bool )` / `await app.getGPUTimings()`** — real GPU milliseconds from WebGPU
  timestamp queries. `pipeline.getStats()` is **not** a GPU metric: it times command encoding on the
  CPU and stays flat while GPU cost doubles.

`app.stages.pathTracer.blueNoiseReady` is deprecated and always resolved: the STBN atlases were
never read by a live code path (the default sampler is Sobol), so the load was removed.

`rayzee/src/Headless.js` wraps the above as the supported entry point — `renderHeadless()` for one
frame, `openHeadless()` to keep a live app across several, `captureHeadless()` to accumulate and read
back (`denoise: true` enables OIDN before accumulating, runs `runFinalDenoise()`, reads `'display'`).
Defaults are the batch renderer's (`strict`, `profile: 'physical'`, `deterministic`). Under `strict`,
`PathTracerApp` also defaults storage off unless the host set it (`isAssetConfigured( 'storage' )`):
the download cache serves a cached copy for up to a day before revalidating. `hostMemoryGB` stands
in for `navigator.deviceMemory` (absent outside Chrome, read as 4, which caps the reserve at 2048).
`bench/harness/boot.js` boots through it, so the suite and production share one driver; the bench
passes `profile: 'viewer'` and `strict: false` explicitly, and both are load-bearing — `physical`
would change every golden, and `strict` would abort a run before the runner reported.

### Without a browser (`Platform.js`, `HeadlessCanvas.js`, `rayzee/src/node/`)
The published build renders in plain Node on Dawn. `npm run bench:node` renders the whole corpus that
way against the Chrome goldens (all 29 match, RMSE ≤ 0.0036); a textured glTF with an HDR or PNG sky
matched Chrome within 0.05 of a level per 16² block.
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
- `decodeImage( bytes, mimeType )` decodes every glTF image through `platformImagesPlugin`, which
  replaces `parser.loadImageSource` (three's needs the DOM or createImageBitmap, and `self.URL` for an
  embedded image's blob URL), and LDR skies (`loadPlatformImage`, flipY on as TextureLoader leaves it).
  ⚠️ PNGs from real exporters carry bytes after IEND; `trimPNG` cuts them, or strict decoders throw.
  ⚠️ GLTFLoader turns a failed texture into none, silently — the plugin reports `texture.build_failed`
  and a strict host's throw is deferred to the end of the load (`_throwDeferred`).
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
  `LEGACY_EVENT_NAMES`, which `PathTracerApp.dispatchEvent` sends alongside until the next major;
  `addEventListener` warns once for any other name (a listener on a wrong name fails silently —
  the 7.28.0 rename cost a host four weeks).

### Settings Provenance & Render Profiles
- **`settings.getEffective()`** — every live setting as `{ value, source, routed }`. `source` is one
  of `SETTING_SOURCE` (default / host / scene-metadata / mode-preset); `routed: false` means stored
  but reaching no stage, which is how a typo becomes a wrong image.
- **`RENDER_PROFILES`** (`EngineDefaults.js`) — product decisions for a real-time viewer that are not
  physical constants, collected so choosing between them is one flag rather than a hunt:
  `areaLightIntensityScale` (glTF placeholder area-light power), `environmentRotation`, `toneMapping`,
  `saturation`. `viewer` is the default and `ENGINE_DEFAULTS` mirrors it exactly; both show AgX at neutral
  saturation and the HDRI unrotated (0°, as Blender's unmapped world shows it), so today they differ only
  in area-light damping. `new PathTracerApp( canvas, { profile: 'physical' } )`; an unknown name
  throws rather than silently selecting viewer tuning.
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
  `SHADOW_END` (1 − 1e-4) of the way, never a fixed distance short.
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
  unable to resolve it. The host supplies `ocioRuntimeFactory` or `ocioRuntimeUrl`. The app loads
  it the first time the colour controls are opened; startup shows a baked view instead (below).
- **Baked views** (`BakedViews.js`): `saveBakedView( id )` writes a view's table to a file (gzip,
  delta-coded, 157 KB for 65³) and `loadBakedView( bytes, { expect } )` registers it with no runtime
  and no config, bit-identical to baking it. When its config later loads, `loadConfig` keeps the
  entry — no rebake, no new id, and `loadColorConfig` skips its reset — if the files hash to the
  fingerprint it was baked from (SHA-256 per file, `configFingerprint`) under the same OCIO version;
  otherwise it is released like any other view.
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
- ⚠️ **The skies reuse one texture.** `SimpleSky` clears `userData.__rayzeeColorSpace` whenever
  it rewrites pixels; without that the record says "already converted" and a new sky is never
  converted. `EnvironmentManager.markDirty()` bumps the version *without* new pixels, which is why
  this is a record and not a version check. The physical sky has no CPU pixels to convert: it bakes
  straight into the working space (`getWorkingMatrix()` folded into its spectrum → RGB weights), and
  `applyColorWorkingSpace()` bakes it again.
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
artists. The view settings come first, with artist names, in the order they are reached for:
**Tone Mapping** (OCIO view), **Style** (look; "None" reads "Default"), **Screen** (display), Exposure,
then **Save EXR**. The project settings — **Color System** (the config) and **Render In**, set once,
rebuild the scene — sit folded under **Advanced**, whose header shows them (`Blender · Rec.709`) and
whose open state is remembered in localStorage. One Tone Mapping menu, no separate curve control.
Exposure is in stops (`2^EV`); the store still holds the multiplier.

The app starts in **Blender 5.1's config** (`DEFAULT_COLOR_CONFIG` in `app/src/lib/colorManagement.js`,
identity in `colorDefaults.js`: sRGB / AgX / Medium High Contrast) from `${ASSETS_BASE_URL}/ocio/blender-5.1/`
— a `manifest.json` plus Blender's files, unmodified, and `default-view.bin`, that view baked by
`npm run color:bake`. `Viewport3D` downloads only the baked view alongside the model and shows it
before the first frame (`showStartupColor`), waiting at most `DEFAULT_COLOR_WAIT_MS` (2 s); switching
views after the first frames read as a colour jump. The config itself loads when the Color Management
group is first opened, or a texture's colour-space menu (`ensureDefaultConfig`), and keeps the baked
view. Measured on production builds, warm reload: first frame 1.38 → 0.59 s, main thread blocked before
it 870 → 220 ms, and a cold visit fetches 157 KB instead of 24 files (4.7 MB compressed) and the
0.65 MB compressed runtime.
Without the baked file (not uploaded, or its header does not match the default) startup loads the
whole config as before. ⚠️ Rerun `npm run color:bake` and upload the file whenever the config or the
default view changes. ⚠️ The app is `pause()`d from `init()` until then: every model, sky and config
load resets, and a reset's `wake()` restarts rendering unless paused — without it 3 of 5 warm reloads
drew the built-in look first. A failed default model or sky is reported and startup carries on, so the
look still loads. The spot-light gobo and IES libraries (~180 files) load after the first frame
(`lib/lightLibraries.js`); a pick made before they land waits for them.
⚠️ Those files are GPL-3.0: they live on the CDN only, staged locally in the git-ignored `.cdn-upload/`, never in the app or engine. A dev build points
elsewhere with `VITE_COLOR_CONFIG_URL`.

Every label and filter lives in `app/src/lib/colorLabels.js`, derived from what the config carries —
OCIO's guidance is to build menus from UI name, family and description, filtered by category:
- **Color System**: Blender (default), None, one preset per ACES version (the newest CG config of it) and
  "Load config folder…" — nothing else. Older builds render the same ACES and Studio configs only add
  camera spaces, so they are not offered. ⚠️ The runtime's builtin names carry no `ocio://`.
- **Render In**: spaces tagged `working-space` *and* linear (ACES: Rec.709, ACEScg, P3-D65); untagged
  configs fall back to the linear family narrowed to the well-known gamuts. Never the interchange space.
- **Screen** drops the ACES " - Display" suffix and splits SDR | HDR as Blender does (`isHdrDisplay`:
  the display space's `encoding` is `hdr-video`/`edr-video`; ACES spells that space `<USE_DISPLAY_NAME>`).
  A display this screen can't show natively (`displayCanvasFit`) says so in its tooltip.
- **Tone Mapping** labels are the view's own name, with detail added back only where two would collide.
- Screen and Tone Mapping items carry a one-line hint (`screenHint` / `toneMappingHint`), first regex match
  wins — put a specific name above the general one (`ACES Filmic` must not reach the `filmic` rule).
- **Style** follows the tone mapping as Blender's looks do — measured: with AgX Blender accepts only "AgX - …"
  looks, with Standard only the unprefixed ones. Gamut compression and LMTs are grouped as technical.
- **Texture colour space**: spaces tagged `texture`, grouped by family.
- ⚠️ `describeConfig()` must carry `categories`. Without them every tag filter silently falls back
  to name matching — the tests passed by coincidence until that was caught.

Engine defaults (no app, or before the Blender config lands): no config; a picked config opens on its
own default display and view; look None; 0 EV; render in linear Rec.709 until the artist picks another.
The accuracy readout is API-only (`status().bakeError`).

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

### Physical sky (`Processor/PhysicalSky.js`, `Processor/AtmosphereModel.js`, `Processor/SunPosition.js`, `TSL/Atmosphere.js`, `TSL/EnvironmentCDF.js`, `TSL/Sun.js`)
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
  `EquirectHDRInfo.computeCDF`, compared in `tests/gpu/atmosphere.test.js`); both are copied into
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
  bundled-HDRI levels. `SKY_PRESETS` carry an `exposure` (EV) making up ~⅔ of what a low sun loses.
- ⚠️ `EnvironmentManager.callbacks.onReset` is the **app's** reset: a bake lands after its input, often once
  the render loop is idle, and the stage's reset alone never woke it (UI edits did nothing on screen).
- ⚠️ A model load installs `meshScene.environment` (the HDRI slot) only in HDRI mode (`loadSceneData`):
  otherwise a model loaded under the sky swapped the startup HDRI in with the sun still on — lit twice.
- Sessions carry `skyModel: 'atmosphere'`; sky keys from older sessions are ignored (same names, other meanings).
- App panel (`PhysicalSkyControls.jsx`): Preset, Time of Day, Sun Direction, Haze; the rest sits behind each
  row's ⋮. Time of day goes through `sunPosition()` (`Processor/SunPosition.js`, solar time, month,
  latitude) with north along −Z; presets aim for their sun *height* on the chosen date
  (`timeForSunElevation`), so Golden Hour stays golden in December. "Set sun by: Angles" edits the raw angles.

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
  Dawn in Node, and `bench:upscale` again in Chrome before anything else.

### Asset Processing Workflow
1. **AssetLoader** loads GLB/GLTF models with automatic camera extraction
2. **GeometryExtractor** converts meshes to the 20-lane triangle records, baking single-use and emissive geometry to world space and leaving shared geometry in object space; records per-mesh `meshTriangleRanges`. It never rewrites a host's own geometry (`userData.__rayzeeExternal` subtrees are left alone), and anything skinned or morphed is given triangles of its own so a refit cannot pose every copy at once.
3. **SceneProcessor** builds two-level BVH (TLAS/BLAS): per-mesh BLAS via `BVHBuilder` (parallel for large meshes via `Promise.all`), then `TLASBuilder` builds SAH tree over mesh AABBs, then assembles combined buffer `[TLAS | BLAS_0 | BLAS_1 | ...]`. A mesh past `SPLIT_MESH_TRIANGLES` (2M) is built as spatial pieces (`Processor/SplitBLAS.js`): its records are sorted in place into pieces of ≤ 512k by halving at the centroid median of the longest axis, each piece is built by a pool worker, and the halving becomes the nodes that join them. It holds the mesh once, in the store — one build across every core held a second copy plus 44 B a triangle of scratch. Images bit-identical, frame time unchanged (22M ocean + mountain, three views, within 3 %). ⚠️ The joined BLAS travels as parts (`nodeParts`), never one array: a 610 MB request failed an 80M build with memory to spare. ⚠️ Pivots are sampled with a fixed seed: first/middle/last took a thousand passes on a terrain grid's repeating rows.
4. **TextureCreator** generates GPU textures for materials (runs in parallel with BVH build)

A failed load reports itself through `LOADING_UPDATE { failed: true, status }` from
`_loadWithSceneRebuild` (`ARCHIVE_NEEDS_ELEMENT` → `LOADING_RESET`, `LOAD_IN_PROGRESS` → nothing, the
other load owns the status). ⚠️ Only the scene build used to: a failure in the parse left the app's
overlay spinning on its last step with the File menu blocked. Drag-and-drop still resets the overlay in
its own `finally`, so a failed drop shows only the console.

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
  and the build reports itself truncated. 45M is the highest rung measured to survive without
  the memory spill. With `memorySpill` on, `loadFile` defaults them to 60M / 8M
  (`SPILL_TRIANGLE_BUDGET`): the whole 15-part Moana subset (55.7M / 7.0M) loads cold under them.
  Raised per load, 80M / 4.35M loads and renders (preflight 8.51 GB, with the spill's discounts);
  89M ran out of memory in the parse, measured before the parse-memory work and not since.
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
- **Formats.** `.tar` is indexed by seeking between headers (`indexTarHeaders`, 1 MB windows) and
  read in place. `.tar.gz` / `.tgz` is unpacked once into `archives/` while it is indexed
  (`unpackTarGz`: DecompressionStream → OPFS, 0 GB held; 1.3 GB gz in 6.4 s) and reopened from
  there in 0.15 s. `.zip` is read through its central directory (`openZip` / `readZipDirectory`,
  ZIP64 and UTF-8/latin1 names) — never unzipped whole; `slice( path )` of a stored entry is a
  zero-copy Blob. A `.zip` that is really a gzip (island-pbrtV4) is detected by magic. Archive
  URLs load through the download cache (`loadFile( url )`).

### Storage (OPFS) (`rayzee/src/Storage/`)
`app.storage` is a `StorageManager` over the origin private file system, opened per
`cacheNamespace` and shared by every app on the page (`acquireSharedStorage`, ref-counted). It is
`null` when the browser has none (private windows, Node without the fake) — every caller must
work without it. `configureAssets( { storage: false } )` or `new PathTracerApp( c, { storage } )`
turns it off or supplies a host manager; `openHeadless` defaults to off.
- **Areas.** Engine: `downloads` (URL cache, revalidated at most daily with a 1-byte `Range: bytes=0-0`
  GET, compared on Last-Modified and, where Content-Range is readable, the size; a failed check is
  stamped too. ⚠️ Not HEAD: the asset host's CORS rule allows GET only, so every HEAD failed CORS,
  and unstamped it retried — and logged the error — on every page load), `archives`, `scenes` (graph + BLAS cache), `cdf`, and `spill`
  (kind `scratch`). App: `renders`, `sessions`, `projects`, `jobs` (kind `user`). `cache` areas
  share a budget (30 % of quota, ≤ 100 GB) and are evicted least-recently-used, never while
  locked or pinned; `user` areas are never evicted; `scratch` is outside the budget and cleared at
  open unless an open page holds it. ⚠️ The budget caps what caches accumulate, not one write —
  a single entry larger than the budget is allowed when the disk has room.
- **Entry protocol.** An entry is a directory of files plus `meta.json`, written **last**; no valid
  meta means invisible, and `sweep()` removes it. `area.create( key )` replaces, `edit( key )`
  appends (growable files resume from their committed length). ⚠️ `create` removes the old entry
  first, so anything rewritten often (sessions, checkpoints) alternates between two keys and
  deletes the older after the commit.
- **I/O.** All writes go through sync access handles in `StorageWorker` (`createWritable` is Safari
  26+ only); reads use `File.slice` on the main thread. `EntryWriter.write` copies the data
  before its first await — muxers and stream readers reuse their buffers.
- **Locks.** Web Locks per entry (`acquireLock`, in-process fallback in Node): writers exclusive,
  readers shared with `ifAvailable`, so an entry being written counts as a miss. Sessions hold a
  lock per tab for the page's lifetime; that is how a second tab tells a live session from one to
  offer.
- **Failures** record `storage.*` issues (`unavailable`, `quota_exceeded`, `write_failed`,
  `read_failed`, `entry_corrupt`, `cache_mismatch`) as warnings and degrade to the in-memory path;
  nothing throws for lack of storage. A quota failure mid-download retries once in memory.
- **Identity.** `fileIdentity( file )` = name, size, lastModified and a SHA-256 over the head, tail
  and 14 probes (~3 MB read at any size); `identityKey()` is the string form used in keys.
- **Scene cache** (`SceneGraphCodec`, `BLASCache`): stored when the cold build took ≥ 10 s and the
  read-back is under a third of it (`worthStoring`). A parse slow enough on its own is written
  *during* the build, each array let go once written: held until the build ended, the encoded
  graph kept every array the build replaces (float normals, instance matrices) alive — ~1 GB at
  the peak on the whole Moana subset. The BLAS cache is content-checked — a
  template's stored BLAS is used only if its position checksum matches — so extraction, TLAS and
  textures always run as before. ⚠️ `Material.toJSON` stores colours as 8-bit sRGB hex and
  `MaterialLoader` rounds `ior` through `reflectivity`; the codec carries both exactly
  (`exactColors`, `exactIor`) or the warm render differs. Read sections in one forward pass of
  large windows: thousands of small `File.slice` reads took 9.8 s, one pass 0.37 s.
- **Scene state.** `app.exportSceneState()` / `importSceneState( state, { resolve } )`
  (`SceneState/`): host-set settings (`settings.serialize()`), environment (mode, sky params, HDRI
  source), colour (config, view, look, working space, context), every light, cameras (live view,
  user cameras, per-camera effects), timeline keys, host material edits (with values —
  `_hostSet` is a Map), hidden objects, gizmo-moved objects. Objects are matched by child-index
  path, materials by index, model cameras by index — each **plus a name check**; UUIDs change per
  load. `resolve` answers what the engine cannot reach (a local HDRI, a non-builtin OCIO config).
  `toPortable` / `fromPortable` keep colours, vectors and non-finite numbers through JSON.
  `app.sceneSource` says where the model came from (`url` / `local-file` / `object3d`, with an
  archive's `element`); `sceneSourceFile` is the File of a local load. Not restored: texture swaps
  and texture-transform edits, host Object3D loads, a picked OCIO folder.
- **Sessions and projects** (app: `lib/session.js`, `lib/project.js`, `SessionDialog`): autosave
  2 s after the last change and on hide, only in Preview and only when the JSON fingerprint differs
  from the last save — an untouched startup scene is never offered. Startup asks before restoring
  (a `?model=` link offers only a session of that model, and reuses the loaded model). A local
  file is never copied: restore asks the user to pick it again and checks its identity. `.rayzee`
  = zip of `project.json` + thumbnail + the local model stored inside (≤ 3.5 GB streamed).
- **Render checkpoints.** `app.captureRenderCheckpoint()` / `restoreRenderCheckpoint( cp )` —
  colour + aux MRT, m2 / streak / frozenMask, `frameCount`, `_seedTick`, aux samples and
  convergence; bit-identical continuation in deterministic mode. All six readbacks are submitted
  in one task, or the parts straddle frames. Restore does not wake the loop (a synchronous frame
  would add a sample). The app writes one every 2 min of a final render (`lib/stillJob.js`,
  ~60 B a pixel: 252 MB at 2048²) and journals video frames (`lib/videoJob.js`); both resume from
  the startup dialog. ⚠️ A resumed encoder must start on a keyframe.
- **Memory spill (experimental, `memorySpill: true`, app flag `localStorage['rayzee-memory-spill']`).**
  A static scene of more than one chunk is **extracted and built together**
  (`SceneProcessor._extractStreaming`, `GeometryExtractor.extractStreaming`): each stored range
  goes to a BLAS worker as soon as it is written (`_blasPool` takes work while it runs), and the
  extraction waits while more than `STREAM_RESIDENT_BYTES` (1.5 GB) of records are in memory — so
  the triangle records are never all resident. Whole Moana subset: build peak 6.6 → 4.1 GB, render
  bit-identical. ⚠️ That wait races a *timer*: racing a settled promise spun it in microtasks and
  starved the worker messages it waited for (a hung tab). The three.js geometry goes to disk too,
  from its last read until the build ends (`Storage/GeometrySpill.js`, handed over by
  `GeometryExtractor._geometryReleaser`, compressed first): never a host's (`__rayzeeExternal`), a
  deforming one, or one sharing an array with another geometry. Small arrays go out packed in 32 MB
  writes and everything is read back in 64 MB windows at the end of `buildBVH` (3.9 GB in 3.0 s at
  80M). Page after extraction on the 70M fixture 4.07 → 0.84 GB, render bit-identical. A failed
  build does not read it back — the app discards a failed load's model. ⚠️ A shared buffer handed
  to the storage worker lives until that worker next collects garbage, which it barely does: every
  spilled 64 MB chunk stayed in memory (2.5 GB of them measured), invisible to
  `measureUserAgentSpecificMemory`. `transferable()` copies shared data into a transferred buffer
  for that reason. Otherwise the spill happens **during the
  build** (`SceneProcessor._beginProgressiveSpill`): each BLAS goes to scratch as it lands, a triangle
  chunk is uploaded (`PathTracerStage.createChunkUploader`, a GPU buffer allocated after
  extraction) and spilled once every BLAS over it is built, and the combined BVH is assembled from
  scratch, uploading and spilling each chunk the fill passes. Chunks holding emitters and the TLAS
  chunks stay. `setTriangleData` / `setBVHData` adopt the pre-filled buffers. A scene restored
  from the BLAS cache spills after upload instead (`spillToDisk`). 50M triangles: 7.2 GB at rest
  against 9.1 GB; the page peak (~11 GB, at the start of the BLAS phase) is unchanged. Readers
  page in first — `refitBVH`, `rebuildMaterials`, and `setMaterialProperty` for
  `TRIANGLE_PATCH_PROPERTIES` — while visibility and rigid moves never need to; `refitBLASes`
  throws until `await app.ensureSceneResident()`. ⚠️ Views taken with `viewAs` keep chunk memory
  alive, which is why the store tracks them (weakly). ⚠️ Past `maxBufferSize` (4 GB here) WebGPU
  returns an invalid buffer and every write fails quietly — `_assertFitsGPU` throws instead. The
  geo triangle buffer reaches it at 89.5M triangles, the BVH at ~67M nodes.

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

⚠️ **`PathTracerStage.sdfs` is not the processor that built the scene** — `PathTracerApp._sdf`
is. The stage's own is a leftover of the old `stage.build()` path; its `rebuildMaterials` may only
upload materials and textures from it. Re-uploading everything (`updateSceneUniforms`) put its empty
emissive data and instance table in place of the scene's, and emitters stopped being sampled.

**Texture arrays' CPU pixels** are released right after three.js uploads them (the texture's
`onUpdate`): nothing reads them again, since a rebuild packs new arrays from the three.js
sources. −716 MB on 24155522.glb. They are dropped, not returned to `SmartBufferPool`, which would
keep them alive; a cache lookup then sees `userData.buffer === null` and rebuilds.

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
  spill below) and read back when it ends.

### Shader Data Access Pattern
Materials and BVH data accessed via storage buffer lookups in TSL:
```js
// Standard pattern in TSL shaders
const getDatafromStorageBuffer = Fn(([buffer, index, offset, stride]) => { ... })
```
BVH traversal (`BVHTraversal.js`) uses stack-based DFS with two-level dispatch: TLAS inner nodes → BLAS-pointer leaves (per-mesh visibility read from the leaf's slot [2]; skip BLAS if hidden, else push BLAS root onto stack) → BLAS inner nodes → triangle leaves (inline Möller-Trumbore + inline side culling via the per-triangle side flag in `normalCData.w`). Both `traverseBVH` (closest hit) and `traverseBVHShadow` (any hit, early exit) gate on mesh visibility. The visibility flag is packed into the TLAS BLAS-pointer leaf by `TLASBuilder.flatten()` and patched at runtime by `PathTracerStage._patchTLASLeafVisibility()` — there is no separate visibility buffer.

### Camera & DOF System
Thin lens in `TSL/CameraRay.js`, with two ways to size the aperture (`dofMode`, a render-profile choice —
`viewer` → `'look'`, `physical` → `'physical'`):
- **look** — radius = `dofBlur` × `focusDistance` × tan( fov / 2 ): a far background blurs by `dofBlur` of the image
  height at any scene scale. Aperture, focal length and `unitsPerMetre` are ignored. Orthographic, tan( fov / 2 ) is 1:
  a point half the view's height behind the focus plane blurs by `dofBlur`, wherever the camera stands.
- **physical** — `focalLength / 2N` mm × `unitsPerMetre` × `apertureScale`. At true size a small object behaves like
  real macro: wide open, a 4 cm watch that fills the frame is all blur.

Both focus on a **flat** plane: `focusDistance` is depth along the view axis, measured by `viewDepth()`
(`managers/InteractionManager.js`; a panorama focuses along each ray). Auto-focus resets on a new model or camera
(`resetAutoFocus()`), falls back to the orbit target's depth when nothing is under its point, and pauses in a
panorama rather than switching to manual. `CAMERA_PRESETS` are settings patches (`dofBlur` plus the lens) with
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
5. **BVH Memory**: Large models may require treelet optimization (`treeletOptimization: true`) for performance
6. **Resolution Scaling**: Path tracer resolution independent of UI — use `app.setCanvasSize( width, height )` (pixel dimensions, applied immediately; internal `_applyRenderResize()`). Requested size is clamped by `MAX_STORAGE_TEXTURE_SIZE` (`_isRenderSizeSupported`). Note: `onResize()` (reads `canvas.clientWidth/Height`) is debounced 300ms; `setCanvasSize()` is not.
7. **React Compiler**: Uses React Compiler plugin — avoid manual memoization patterns that conflict with automatic optimization
8. **Feature Guards**: Check stage availability before accessing optional stages (e.g., `app.asvgfStage?.enabled`)
9. **BVH Leaf Markers**: slot `[3]` is a u32 bit pattern — `TRIANGLE_LEAF` (0x40000000) or `BLAS_POINTER_LEAF` (0x40000001), both above `BVH_MAX_INDEX`, so `floatBitsToUint(nodeData0.w) >= BVH_MAX_INDEX` means leaf — except in a folded BVH, where a folded left child also sits above it (from 2^31) and the test is `tag >> 30 === 1`. `BVHRefitter` has inline copies of these constants (cannot import EngineDefaults in worker context).
10. **InstanceTable Entry Order**: Entries are indexed by `meshIndex` (positional). Use `setEntry()` with explicit index, never push-based insertion, to avoid ordering bugs with mixed sync/async BLAS builds.
11. **Transform vs Deformation vs Animation**: a rigid move uses `updateMeshTransforms()` (matrix only — no vertex pass, no BLAS work, no triangle upload). Deformation of specific meshes uses `refitBLASes()` (per-mesh, sync, main thread). Animations use `refitBVH()` (full scene, async, worker). Don't mix them — the worker path operates on SharedArrayBuffer that must match the combined TLAS/BLAS layout. Build the positions buffer from `app.sceneMeshes`, never from your own model root (see **BVH refit data flow** above).
12. **Mesh Visibility**: Controlled per-mesh at the BLAS-pointer level in BVH traversal, NOT per-material. Use `app.updateAllMeshVisibility()` after changing `object.visible` on any Three.js object/group — it walks the parent chain to resolve world-visibility and patches the visibility flag into each TLAS leaf (slot [2]) via `_patchTLASLeafVisibility` (no separate GPU buffer). Material-level `visible` was removed from the pipeline. Front/back/double-side culling is handled inline in `traverseBVH` via the per-triangle side flag (`normalCData.w`).
13. **Partial storage uploads**: three.js uploads an attribute whole only when its `updateRanges` is empty — any pending `addUpdateRange` cuts a later `needsUpdate = true` down to that range. Full uploads therefore clear ranges first (`PathTracerStage._updateStorageBuffer`). Without that, the TLAS-leaf range a visibility patch leaves at load swallowed the refit that followed it (`refit-deform` read +16.6 %).
