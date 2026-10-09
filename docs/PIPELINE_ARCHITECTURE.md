# Pipeline Architecture

**Rayzee Path Tracing Engine - Event-Driven Rendering Pipeline**

---

## Overview

Rayzee renders through an **event-driven pipeline** of stages on WebGPU. Shaders are written in TSL (Three Shading Language) and compiled to WGSL at runtime. Two classes own the pipeline:

- **`RayzeeRenderer`** (`RayzeeRenderer.js`, entry `core.js`, published as `rayzee/core`) — the renderer core: WebGPU device, scene build, path tracer and compositor, loading, reset, `renderFrames` / `renderToBuffer`, dispose. Its pipeline is **PathTracer → Compositor**.
- **`PathTracerApp extends RayzeeRenderer`** (`PathTracerApp.js`, published as `rayzee`) — the viewer. It adds camera controls, picking, gizmo, overlays, timeline, animation playback, the denoisers and picture stages, and installs the add-ons.

The viewer plugs into the core through ~30 protected hook methods, listed under "Hooks" at the end of `RayzeeRenderer.js` (`_createExtraStages`, `_displaySources`, `_beginFrame`, `_holdTrace`, `_afterTrace`, `_beforeReset`, …). Each runs at a fixed point of the frame, reset or load sequence and does nothing in the core. The layer rules — what each layer owns, the add-ons, the boundary test — are in `docs/CORE_AND_ADDONS.md`.

### System Architecture

```
UI / React (Zustand store)
    │  getApp() / subscribeApp()      app/src/lib/appProxy.js
    ▼
PathTracerApp (viewer, `rayzee`)  ──extends──▶  RayzeeRenderer (core, `rayzee/core`)


RayzeeRenderer (core)                     PathTracerApp (viewer) adds
├─ WebGPURenderer                         ├─ cameraManager: CameraManager
├─ settings: RenderSettings               │   ├─ ViewCamera
├─ color: BasicColor                      │   └─ WalkControls
├─ assetLoader: AssetLoader               ├─ timeline: TimelineManager (CameraTrack)
├─ SceneProcessor (_sdf)                  ├─ animationManager: AnimationManager
├─ lightManager: LightManager             ├─ interactionManager, transformManager
├─ completion: CompletionTracker          ├─ goboManager, iesManager
└─ pipeline: RenderPipeline               ├─ denoisingManager: DenoisingManager
   ├─ PathTracer                          │   ├─ OIDNDenoiser
   │  ├─ UniformManager                   │   ├─ OIDNTemporalHistory
   │  ├─ MaterialDataManager              │   └─ AIUpscaler
   │  ├─ EnvironmentManager               ├─ overlayManager: OverlayManager
   │  ├─ ShaderBuilder                    │   └─ TileHelper, OutlineHelper, gizmo
   │  └─ StorageTexturePool               ├─ stages from _createExtraStages():
   ├─ [ _createExtraStages() ]            │   NormalDepth, MotionVector, NRD, ASVGF,
   └─ Compositor                          │   Variance, BilateralFilter, EdgeFilter, AutoExposure
                                          └─ add-ons: ColorManagement, PhysicalSky,
                                              BidirectionalIntegrator, ArchiveImporter, storage
```

`init()` runs `_initStorage`, `_initRenderer`, `_createCamera()`, `_initScenes`, `_initAssetPipeline`, `_initPipeline` (stages, then the pipeline), `_initManagers` and `_wireEvents`. The viewer overrides `_createCamera`, `_initAssetPipeline`, `_initPipeline`, `_initManagers` and `_wireEvents`, calling the core's version first or last as each needs.

### App Proxy (`app/src/lib/appProxy.js`)

All UI/store code reaches the viewer through `getApp()`:

```javascript
import { getApp, subscribeApp } from '@/lib/appProxy';

const app = getApp();  // the initialised app, or null
if ( app ) app.settings.set( 'maxBounces', 8 );

// Subscribe to app changes
const unsub = subscribeApp( ( app ) => {
    if ( app ) console.log( 'App ready' );
} );
```

### Settings

`app.settings` is a `RenderSettings` (`RenderSettings.js`). It holds the core's settings, each routed to a path-tracer uniform or a handler, or only stored for whoever reads it (`maxTextureSize` and `areaLightIntensityScale` at load); `ENGINE_DEFAULTS` holds exactly their defaults. Another layer adds its own with `settings.define( key, { default, apply, reset } )`; the viewer defines `interactionRenderScale`.

---

## Design

1. **Explicit order.** Stages run in the order they are added. Order matters: BilateralFilter reads what ASVGF and Variance published earlier in the same frame.
2. **Textures by name.** Stages share textures through the context, never by holding each other.
3. **Signals by event.** Stages talk over the event bus. A stage that needs the path tracer itself — its uniforms, or an extra output — is handed it in its options (`options.pathTracer`).
4. **The core names no capability.** It announces a hard restart (`pipeline:historyReset`) and a lighting change (`pipeline:lightingChanged`); each stage decides what of its own history to drop.

---

## Core Components

### 1. PipelineContext (`Pipeline/PipelineContext.js`)

Shared state for all stages: named textures, render targets, uniforms and a state object.

```javascript
// Textures
context.setTexture( 'pathtracer:color', texture );
context.getTexture( 'pathtracer:color' );
context.removeTexture( 'asvgf:output' );

// State
context.setState( 'renderMode', 1 );
context.getState( 'frame' );

// Lifecycle
context.incrementFrame();  // RenderPipeline, after every render()
context.reset();           // frame counters and flags; textures are kept
```

**State keys in use:**
| Key | Type | Written by |
|-----|------|------------|
| `frame` | number | RenderPipeline, after each `render()`; zeroed by `reset()` |
| `renderMode` | number | PathTracer, each frame: 0 = interactive, 1 = production |
| `tileRenderingComplete` | boolean | PathTracer, `true` on every frame it traces |
| `interactionMode` | boolean | PathTracer, true while the camera moves |
| `pathtracer:samples` | number | PathTracer's frame count (NRD's handover reads it) |
| `width` / `height` | number | RenderPipeline constructor and `setSize()` |
| `autoexposure:value` / `autoexposure:avgLuminance` | number | AutoExposure |

> The engine renders full-frame only. `tileRenderingComplete` is a legacy key kept as the PER_CYCLE gate in production mode; nothing sets it `false`. See Execution Modes below.

**Example:**
```javascript
// PathTracerStage._publishTexturesToContext()
context.setTexture( 'pathtracer:color', writeTex.color );
context.setTexture( 'pathtracer:normalDepth', writeTex.normalDepth );
context.setTexture( 'pathtracer:albedo', writeTex.albedo );

// A later stage
const color = context.getTexture( 'pathtracer:color' );
```

---

### 2. EventBus (`Pipeline/EventDispatcher.js`)

`pipeline.eventBus`, shared by every stage (`on`, `once`, `off`, `emit`, `listenerCount`, `eventNames`).

**Events (verified emitters in `rayzee/src`):**
| Event | Emitted by | Payload | Listened by |
|-------|-----------|---------|-------------|
| `pathtracer:frameComplete` | PathTracerStage, every traced frame | `{ frame, isComplete }` | — |
| `camera:moved` | PathTracerStage, on a frame the camera changed | — | NormalDepth |
| `pathtracer:interactionStart` / `pathtracer:interactionEnd` | PathTracerStage, when its CameraOptimizer enters / leaves interaction mode | — | PathTracerApp (drops / restores the render scale) |
| `pathtracer:viewpointChanged` | PathTracerStage, after interaction mode ends and the stage resets | — | Variance |
| `pipeline:historyReset` | RayzeeRenderer (`reset()` unless soft), PathTracerStage (render-mode change, 50 ms later), PathTracerApp (render-scale change) | — | ASVGF, NRD |
| `pipeline:lightingChanged` | RayzeeRenderer (model or environment load, rebuild after adding or removing an object), EnvironmentManager mode change (`callbacks.onLightingChanged`) | — | AutoExposure |
| `pipeline:reset` | `RenderPipeline.reset()` | — | PathTracerStage, NormalDepth, MotionVector, AutoExposure, OverlayManager (hides TileHelper) |
| `pipeline:resize` | `RenderPipeline.setSize()` | `{ width, height }` | PathTracerStage |
| `frame:complete` | RenderPipeline, after all stages | `{ frame, accumulatedFrames }` | — |
| `autoexposure:updated` | AutoExposure, when the exposure moves 0.005 stops or more | `{ exposure, autoExposure, targetExposure, luminance }` | PathTracerApp (re-dispatched as `EngineEvents.AUTO_EXPOSURE_UPDATED`) |
| `motionvector:computed` | MotionVector | `{ frame, isFirstFrame }` | — |
| `stage:enabled` / `stage:disabled` | `RenderStage.enable()` / `disable()` | `{ stage }` | — |

Parameters reach a stage through its methods, not events: the viewer's `DenoisingManager` calls `asvgf.updateParameters()`, `autoExposure.updateParameters()` and the like, and the sample ceiling goes through `settings.set( 'maxSamples', n )`.

> There is no `tile:changed` event — the engine renders full-frame only. TileHelper's overlay is driven by `tileProgress` / `end` events the OIDN denoiser and AI upscaler emit on themselves (DOM-style `addEventListener`, not this bus); see Overlays below.

**Example:**
```javascript
// PathTracerStage signals a finished frame
this.emit( 'pathtracer:frameComplete', { frame: this.frameCount, isComplete: this.isComplete } );

// ASVGF listens for the core's restart signal
this.on( 'pipeline:historyReset', () => this.resetTemporalData() );
```

---

### 3. RenderPipeline (`Pipeline/RenderPipeline.js`)

Runs the stages in order and owns the context and the event bus.

```javascript
const pipeline = new RenderPipeline( renderer, width, height, { issues } );

pipeline.addStage( stage );         // runs in the order added; calls stage.initialize( context, eventBus )
pipeline.render();                  // each stage whose shouldExecuteThisFrame() is true, then frame:complete
pipeline.reset();                   // pipeline:reset, every stage's reset(), context.reset()
pipeline.setSize( width, height );  // pipeline:resize, every stage's setSize()
pipeline.dispose();

pipeline.getStage( 'EdgeAwareFiltering' );  // by the stage's name
pipeline.setStageEnabled( 'NRD', false );
```

The core builds it in `RayzeeRenderer._initPipeline()`: `stages.pathTracer`, then whatever `_createExtraStages()` returned, then `stages.compositor`.

A stage that throws is logged and recorded once per stage and phase as `stage.render_failed` (`EngineIssues.js`); a strict renderer throws there, otherwise the remaining stages still run.

---

### 4. RenderStage (Base Class, `Pipeline/RenderStage.js`)

Base class for all stages. Exported from `rayzee` (with `StageExecutionMode`, `RenderPipeline` and `PipelineContext`), not from `rayzee/core`.

**Lifecycle:** `constructor` → `initialize( context, eventBus )` (from `addStage`, calls `setupEventListeners()`) → `render( context, writeBuffer )` each frame → `reset()` / `setSize()` / `dispose()` as the pipeline calls them.

#### Execution Modes

```javascript
export const StageExecutionMode = {
    ALWAYS: 'always',          // every frame
    PER_CYCLE: 'per_cycle',    // when the path tracer has completed a frame
    PER_TILE: 'per_tile',      // every frame (same as ALWAYS; unused)
    CONDITIONAL: 'conditional' // shouldExecute() override
};
```

`shouldExecuteThisFrame()` returns false for a disabled stage. Otherwise `PER_CYCLE` runs when `renderMode === 0`, or when `tileRenderingComplete === true`. PathTracer sets that flag on every frame it traces, so **PER_CYCLE means "after the path tracer finishes a frame"** — every frame.

**Each stage's mode:**

| Stage | Mode | Layer |
|-------|------|-------|
| PathTracer | `ALWAYS` (set by `PathTracerStage`) | core |
| NormalDepth | `ALWAYS` | viewer |
| MotionVector | `ALWAYS` | viewer |
| NRD | `PER_CYCLE` | viewer |
| ASVGF | `PER_CYCLE` | viewer |
| Variance | `ALWAYS` | viewer |
| BilateralFilter | `ALWAYS` | viewer |
| EdgeFilter | `PER_CYCLE` | viewer |
| AutoExposure | `ALWAYS` | viewer |
| Compositor | `ALWAYS` | core |

No stage uses `PER_TILE` or `CONDITIONAL`.

**Key Methods to Override:**
```javascript
class MyStage extends RenderStage {

    // Required
    render( context, writeBuffer ) {
        const input = context.getTexture( 'pathtracer:color' );
        // ... dispatch or draw into this stage's own target ...
        context.setTexture( 'mystage:output', this.outputTarget.texture );
    }

    // Optional
    setupEventListeners() {
        this.on( 'pipeline:historyReset', () => this.resetHistory() );
    }

    reset() {}                      // every pipeline.reset(), soft or hard
    setSize( width, height ) {}     // every pipeline.setSize()
    dispose() {}
}
```

**Utility Methods:**
```javascript
// Events
this.emit( 'event:name', data );
this.on( 'event:name', callback );
this.once( 'event:name', callback );
this.off( 'event:name', callback );

// Logging
this.log( 'message' );
this.warn( 'warning' );
this.error( 'error' );

// Enable/Disable — emit stage:enabled / stage:disabled
this.enable();
this.disable();
this.toggle();
```

Setting `stage.enabled` directly, as `DenoisingManager` does, emits nothing.

---

## Stage Descriptions

### PathTracer (core)

`Stages/PathTracer.js` (`class PathTracer extends PathTracerStage`). The ray tracer.

**Execution Mode:** `ALWAYS` — accumulates a sample every frame until complete.

**Input:** scene geometry, materials, lights, camera.
**Output (published to context):**
- `pathtracer:color` - accumulated colour
- `pathtracer:normalDepth` - normals + depth
- `pathtracer:albedo` - albedo (denoiser guide)

**Key Features:**
- Progressive full-frame accumulation (no tile loop)
- Two-level BVH (TLAS/BLAS)
- Storage-texture MRT outputs (color / normalDepth / albedo)

**Wavefront architecture:** PathTracer is a pure wavefront tracer — there is no megakernel. Each frame is a sequence of compute kernels dispatched through `KernelManager`: **Generate → per-bounce [Extend → (Sort) → Shade → Compact] → FinalWrite**, plus a single `debug` kernel for `visMode`. An integrator installed with `registerIntegrator()` (the `rayzee/addons/bidirectional` add-on) adds its kernels through the path tracer's integrator hooks. Kernel-level detail (queues, ray buffers, stream compaction, sorting) is in `PATH_TRACER_SHADER_ARCHITECTURE.md`.

**Events Emitted:** `pathtracer:frameComplete`, `camera:moved`, `pathtracer:interactionStart` / `pathtracer:interactionEnd`, `pathtracer:viewpointChanged`, and `pipeline:historyReset` after a render-mode change — see EventBus above.
**Events Listened:** `pipeline:reset` (`reset()`), `pipeline:resize` (`setSize()`).

**Outputs on request.** `pathTracer.requestOutput( name, options )` compiles an extra per-pixel output into Shade while someone asks for it; the kernels rebuild before the next frame. It returns a function that withdraws the request. The one output today is `'hitDistance'`: `encode( distance, viewZ )` returns a [0, 1] value written to `pathtracer:albedo.w`, only while the aux outputs are on. The viewer's NRD stage requests it at construction and withdraws it on dispose.

#### Composition Architecture

`PathTracer` extends `PathTracerStage`. The base (`Stages/PathTracerStage.js`) owns the renderer-agnostic state and delegates data management to 5 sub-managers; the subclass adds the wavefront kernel orchestration (`render()`, `KernelManager` / `QueueManager` / `PackedRayBuffer` wiring):

```
PathTracer  (Stages/PathTracer.js — wavefront render() + kernel orchestration)
  └── PathTracerStage  (Stages/PathTracerStage.js — base, sub-manager composition)
        ├── uniforms: UniformManager           (managers/UniformManager.js)
        ├── materialData: MaterialDataManager  (managers/MaterialDataManager.js)
        ├── environment: EnvironmentManager    (managers/EnvironmentManager.js)
        ├── shaderBuilder: ShaderBuilder       (Processor/ShaderBuilder.js)
        └── storageTextures: StorageTexturePool (Processor/StorageTexturePool.js)
```

The base keeps: constructor, `reset()`, `build()`, `setupMaterial()`, scene/light/camera uniform updates, event emission, the history reset on a render-mode change, and disposal. The subclass keeps `render()` (the per-bounce kernel loop) and the kernel/buffer lifecycle.

**Sub-Manager Access Pattern:**

External code (other stages, the renderer) accesses sub-managers directly:

```javascript
// UniformManager — TSL uniform nodes
const maxBounces = stage.uniforms.get( 'maxBounces' );   // the uniform node
stage.uniforms.set( 'maxBounces', 12 );                  // sets node.value

// Getters defined by PathTracerStage._defineUniformGetters()
stage.maxBounces;           // same as stage.uniforms.get( 'maxBounces' )
stage.cameraWorldMatrix;    // same as stage.uniforms.get( 'cameraWorldMatrix' )

// MaterialDataManager
stage.materialData.materialStorageAttr;   // the scene data buffer: materials, then the light data
stage.materialData.materialStorageNode;   // storage( …, 'vec4' ).toReadOnly() node; light reads use stage.lightDataNode
stage.materialData.srgbBuckets;           // DataArrayTexture | null per size bucket — colour maps
stage.materialData.linearBuckets;         // DataArrayTexture | null per size bucket — data maps
stage.materialData.updateMaterialProperty( index, property, value );

// EnvironmentManager
stage.environment.environmentTexture;     // current environment texture
stage.environment.envParams;              // { mode, sky / solid-colour parameters }
await stage.environment.setEnvironmentMap( envMap );
await stage.environment.generateProceduralSkyTexture();  // needs the physical-sky add-on

// ShaderBuilder — the scene texture nodes the kernels read
stage.shaderBuilder.createSceneTextureNodes( stage, storageTextures );
stage.shaderBuilder.updateSceneTextures( stage );  // in-place node update
stage.shaderBuilder.getSceneTextureNodes();

// StorageTexturePool
stage.storageTextures.swap();
stage.storageTextures.getReadTextures();
stage.storageTextures.ensureSize( width, height );

// VRAMTracker (on the PathTracer subclass)
stage.vramTracker.measure();     // { current, peak, byCategory } in bytes
stage.vramTracker.resetPeak();
```

`generateProceduralSkyTexture()` bakes only once the `rayzee/addons/physical-sky` add-on is installed with `environmentManager.setProceduralSky( PhysicalSky )` — the viewer does this in `_initManagers()`. Without it the call records `capability.missing` and resolves.

`VRAMTracker` (`Processor/VRAMTracker.js`) is owned by the `PathTracer` subclass, not one of the 5 sub-managers. Its providers are thunks that read live GPU resources, summed by real size and de-duplicated by identity. The path tracer registers its own (rays — the hit buffer with its G-buffer region —, queues, G-buffer, accumulation, geometry, materials with the light data, environment, integrator); the core's `_ensureVRAMWiring()` adds every other stage's textures and render targets and the canvas, and the viewer's `_registerVRAM()` hook adds the denoiser. The renderer exposes it as `vram` and `getMemoryInfo()`, and measures on a burst's first frames, every 30th frame, and on scene rebuild, environment load and resolution change.

**Callback Pattern:**

Sub-managers report back through callbacks rather than holding the stage:

```javascript
// PathTracerStage constructor
this.materialData.callbacks.onReset = () => this.reset();
this.environment.callbacks.onReset = () => this.reset();
this.environment.callbacks.getSceneTextureNodes = () => this.shaderBuilder.getSceneTextureNodes();

// RayzeeRenderer._initManagers() — replaces the environment's
this.environmentManager.callbacks.onLightingChanged = () => this.pipeline.eventBus.emit( 'pipeline:lightingChanged' );
this.environmentManager.callbacks.onReset = () => this.reset();
```

The renderer swaps the environment's `onReset` for its own `reset()`, not the stage's: a sky bake lands after its input, often once the render loop is idle, and only the renderer's reset wakes the loop (it also emits `pipeline:historyReset`).

**Key Design Constraint:** TSL uniform nodes and texture nodes are created once and never replaced — only `.value` is mutated. This preserves compiled shader graph references. All sub-managers follow this pattern.

**Per-renderer shader resources.** Material texture buckets, the albedo maps alpha-cutout shadow rays read, gobo and IES textures and the alpha-shadow switch ride in each kernel's build context (`TSL/SceneResources.js`). A kernel's root is built with `withSceneResources( call, resources )` (`PathTracer._buildWavefrontKernels`, NormalDepth), and a TSL function body reads them with `sceneResources( builder )`, which throws when the kernel was built without them. They are never module state: a TSL function body runs when its kernel compiles, often at its first dispatch, so a module variable would be read from whichever renderer set it last.

---

### Compositor (core)

`Stages/Compositor.js`. **Execution Mode:** `ALWAYS`. The last stage: it picks the picture, grades saturation, sets alpha (opaque unless a transparent background is on) and draws to the canvas.

**Which picture.** `resolveLightTexture()` returns, in order:
1. the first published key of `displaySources`, the list `_displaySources()` returned when the stages were created;
2. `pathtracer:color`.

The core's `_displaySources()` returns `[]`, so the core shows the accumulation. The viewer's returns `[ 'oidn:output', 'edgeFiltering:output', 'bilateralFiltering:output', 'asvgf:output', 'nrd:output' ]`. The list is read once, in `_createStages()`. `resolveLightSource( context )` also returns the key it came from; `renderToBuffer( { source: 'display' } )` reads through it.

With the `convergenceOverlay` setting on, it draws a convergence heat map from `pathtracer:color` and the path tracer's convergence buffers instead.

Exposure is not applied here: the renderer's output pass applies `renderer.toneMappingExposure` (inside its tone-mapping branch only), the view transform, then sRGB unless the view already encodes.

---

### Viewer stages

`PathTracerApp._createExtraStages()` builds these. NRD, ASVGF, Variance, BilateralFilter and EdgeFilter start disabled; AutoExposure follows `AUTO_EXPOSURE_DEFAULTS.autoExposure`. `DenoisingManager.setDenoiserStrategy()` turns the real-time denoisers on one at a time and clears their context textures on a switch; `DenoisingManager._syncGBufferStages()` keeps NormalDepth and MotionVector on only while something consumes them.

| Stage (`name`) | On while | Reads | Publishes |
|----------------|----------|-------|-----------|
| NormalDepth | a denoiser, EdgeFilter/BilateralFilter or the OIDN motion history needs it | `pathtracer:color` (size only) | `pathtracer:normalDepth` (replaces the path tracer's), `pathtracer:prevNormalDepth`, `pathtracer:shadingNormal`, `pathtracer:instanceLeaf` (opt-in) |
| MotionVector | ASVGF or NRD is on | `pathtracer:normalDepth` | `motionVector:screenSpace`, `motionVector:worldSpace`, `motionVector:motion` (alias of screenSpace) |
| NRD | strategy `'nrd'` | `pathtracer:color`, `:albedo`, `:normalDepth`, `:shadingNormal`, `motionVector:screenSpace` | `nrd:output` |
| ASVGF | strategy `'asvgf'` | `pathtracer:color`, `:albedo`, `:normalDepth`, `:prevNormalDepth`, `motionVector:screenSpace` | `asvgf:output`, `asvgf:demodulated`, `asvgf:gradient` |
| Variance (`VarianceEstimation`) | strategies `'asvgf'`, `'edgeaware'` | `pathtracer:color` | `variance:output` |
| BilateralFilter (`BilateralFiltering`) | strategy `'asvgf'` | `asvgf:demodulated` (else `asvgf:output`, else `pathtracer:color`), `pathtracer:normalDepth`, `:shadingNormal`, `:albedo`, `variance:output` | `bilateralFiltering:output` |
| EdgeFilter (`EdgeAwareFiltering`) | strategy `'edgeaware'` | `pathtracer:color`, `:normalDepth`, `:shadingNormal`, `:albedo`, `variance:output` | `edgeFiltering:output` |
| AutoExposure | `DenoisingManager.setAutoExposureEnabled( true )` | `pathtracer:color` | state `autoexposure:value` / `autoexposure:avgLuminance`; sets `renderer.toneMappingExposure` |
| LocalExposure | `app.setLocalExposure( true )` | `pathtracer:color` | a grid and blurred picture its gain reads: the compositor's `setDisplayGain` and readbacks' `_displayGain()` |

OIDN is not a stage. `DenoisingManager` reads the path tracer's colour, normal/depth and albedo storage textures directly (`storageTextures.getReadTextures()`) and publishes its result as `oidn:output`.

### ASVGF

**Purpose:** the temporal half of the ASVGF strategy. A temporal gradient (anti-lag) and temporal accumulation of albedo-demodulated lighting, with motion vectors from MotionVector.
**Execution Mode:** `PER_CYCLE`

The spatial half is BilateralFilter: a 5×5 à-trous wavelet over `asvgf:demodulated`, guided by `variance:output`, remodulated by albedo on its last pass. Its `bilateralFiltering:output` is what the Compositor shows.

**Debug output:** `stage.heatmapTarget` — a public `RenderTarget` for host-side overlays, not in the context, written only after `setHeatmapEnabled( true )`.

**Events Listened:**
- `pipeline:historyReset` - drop temporal history (`resetTemporalData()`)

`reset()` is a no-op: motion vectors handle camera moves.

---

### NRD

**Purpose:** port of NVIDIA Real-Time Denoisers' ReBLUR (recurrent blur). Full write-up: `docs/NRD_DENOISER.md`.
**Execution Mode:** `PER_CYCLE`

**Input:**
- `pathtracer:color`, `pathtracer:albedo` (`.w` = normalised hit distance, requested through `requestOutput( 'hitDistance', { encode } )`)
- `pathtracer:normalDepth`, `pathtracer:shadingNormal` (`.w` = roughness)
- `motionVector:screenSpace`

**Output:**
- `nrd:output` - denoised, remodulated colour

**Key Features:**
- Six compute passes: PrePass, TemporalAccumulation, HistoryFix, Blur, PostBlur, TemporalStabilization
- Passes the input through when a guide is missing
- Progressive-aware: once `pathtracer:samples` + 1 reaches `handoverFrames`, it republishes the input and skips its passes

**Events Listened:**
- `pipeline:historyReset` - drop history

---

### EdgeFilter

**Purpose:** spatial-only SVGF à-trous on the accumulated frame — no temporal reprojection, motion vectors or history.
**Execution Mode:** `PER_CYCLE`

Demodulates by albedo, runs `iterations` à-trous passes with variance-guided luminance, shading-normal and relative-depth edge-stops, and remodulates on the last. It passes `pathtracer:color` through when a guide is missing and while the camera moves (`interactionMode`).

---

### Overlays

The overlay is not a stage. After each frame `animate()` calls the `_renderHelperOverlay()` hook; the viewer draws `OverlayManager` there, at view resolution, on canvases of its own, so helpers never reach a saved image.

`TileHelper` (`managers/helpers/TileHelper.js`, registered by `OverlayManager`) draws the progress border of the **OIDN denoiser** and **AI upscaler**, which process the final image in tiles. It listens for `tileProgress` / `end` events they emit on themselves (`OverlayManager._wireDenoiserTileEvents`), and hides on `pipeline:reset`.

---

## Execution Flow

### Per frame

`animate()` (or `renderFrames()` / `renderUntilComplete()`) calls `_traceFrame()`, which runs `pipeline.render()`:

```
1. PathTracer.render()                [ALWAYS]
   ↓ sets 'tileRenderingComplete' = true
   ↓ runs the wavefront kernels (Generate → bounces → FinalWrite)
   ↓ publishes pathtracer:color / normalDepth / albedo; state renderMode, interactionMode, pathtracer:samples
   ↓ emits pathtracer:frameComplete (and camera:moved when the camera changed)

2. Viewer stages, in order, each only while enabled
   NormalDepth → MotionVector → NRD → ASVGF → Variance → BilateralFilter → EdgeFilter → AutoExposure

3. Compositor.render()                 [ALWAYS]
   ↓ picks its source, grades saturation, draws to the canvas through the renderer's output pass

4. RenderPipeline: frame + 1, emits frame:complete
```

Then the `_afterTrace()` hook runs, and `animate()` calls `_renderHelperOverlay()`. `animate()` skips tracing when `_holdTrace()` says so (the viewer may hold while the view moves and an OIDN denoise is in flight) and stops the loop once the render is complete.

`renderMode` (0 = interactive, 1 = production) still tunes quality — production traces its first frame with one bounce — but neither mode tiles the frame, so no PER_CYCLE stage is skipped.

### Reset

`renderer.reset( soft )`:

```
_beforeReset( keepHistory )        hook — the viewer's DenoisingManager.beforeReset()
pipeline.reset()                   pipeline:reset, every stage's reset(), context.reset()
pipeline:historyReset              only when not soft
_afterReset()                      hook
completion reset, wake(), EngineEvents.RENDER_RESET
```

A camera move is a soft reset from `animate()`, so temporal denoisers keep their history across it.

### Pipeline Integration

```
Core:    [PathTracer → Compositor]
Viewer:  [PathTracer → NormalDepth → MotionVector → NRD → ASVGF → Variance → BilateralFilter → EdgeFilter → AutoExposure → Compositor]
    ↓
Compositor → renderer output pass (exposure, view transform, sRGB) → canvas
    ↓
_renderHelperOverlay() → OverlayManager (viewer): outline, scene helpers, HUD at view resolution
```

`renderer.toneMapping` is an id in the view-transform registry (`Color/ViewTransforms.js`): three.js's seven built-in curves, plus OpenColorIO views baked to tables once the `rayzee/addons/color` add-on is installed (`renderer.setColorManagement( ColorManagement )`; the viewer does). Without it `renderer.color` is the core's `BasicColor` (`Color/BasicColor.js`): linear Rec.709, the built-in views, nothing converted. An OCIO view returns colour already encoded for its display, so `ColorManagement` sets `renderer.outputColorSpace` to linear while one is active. The readbacks (`ToneMapGPU`, `ToneMapCPU`) read the same registry, so a saved image matches the canvas.

---

## Texture Flow

### Context Texture Registry

Built from every `context.setTexture()` / `getTexture()` in `rayzee/src`.

| Texture Key | Producer | Consumers | Description |
|-------------|----------|-----------|-------------|
| `pathtracer:color` | PathTracer | Compositor (fallback), ASVGF, NRD, EdgeFilter, Variance, BilateralFilter (fallback input; alpha), AutoExposure, NormalDepth (size only) | Accumulated colour |
| `pathtracer:normalDepth` | PathTracer; replaced by NormalDepth while it runs | ASVGF, NRD, EdgeFilter, BilateralFilter, MotionVector, OIDN motion history | Normals + depth. NormalDepth's: geometric normal, jitter-free linear ray distance |
| `pathtracer:albedo` | PathTracer | ASVGF, NRD, EdgeFilter, BilateralFilter | Albedo (denoiser guide). `.w` holds the hit distance only while a stage has called `requestOutput( 'hitDistance', { encode } )` — the viewer's NRD |
| `pathtracer:prevNormalDepth` | NormalDepth | ASVGF, OIDN motion history | The previous traced frame's normals + depth |
| `pathtracer:shadingNormal` | NormalDepth | NRD, EdgeFilter, BilateralFilter, OIDN motion history | Normal-mapped normal; `.w` = material roughness |
| `pathtracer:instanceLeaf` | NormalDepth (opt-in, `setInstanceLeafOutput( true )`) | OIDN motion history | r32uint: the hit's transformed TLAS leaf + 1, 0 = none |
| `motionVector:screenSpace` | MotionVector | ASVGF, NRD | xy = motion (current − previous uv), z = depth, w = validity |
| `motionVector:worldSpace` | MotionVector | - | xyz = world velocity, w = validity |
| `motionVector:motion` | MotionVector | - | Alias of `motionVector:screenSpace` |
| `asvgf:output` | ASVGF | Compositor, BilateralFilter (fallback) | Temporally accumulated, remodulated colour |
| `asvgf:demodulated` | ASVGF | BilateralFilter | Demodulated lighting + history |
| `asvgf:gradient` | ASVGF | - | Temporal gradient |
| `variance:output` | Variance | BilateralFilter, EdgeFilter | Luminance mean, second moment, temporal variance, spatial variance |
| `bilateralFiltering:output` | BilateralFilter | Compositor | ASVGF strategy's final picture |
| `edgeFiltering:output` | EdgeFilter | Compositor | Filtered colour |
| `nrd:output` | NRD | Compositor | ReBLUR-denoised colour (see `docs/NRD_DENOISER.md`) |
| `oidn:output` | DenoisingManager (OIDN) | Compositor | OIDN's latest denoised picture, held until the next one lands |

The Compositor shows only keys in its display list (see Compositor above). `DenoisingManager._clearDenoiserTextures()` removes the denoiser keys when the strategy changes.

---

## Adding a New Stage

### Step 1: Create Stage Class

**Choose the Execution Mode:**
- **ALWAYS** - work every frame regardless of the path tracer's state
- **PER_CYCLE** - post-processing that needs a completed path-tracer frame
- **CONDITIONAL** - custom logic (override `shouldExecute()`)

```javascript
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';  // a host: from 'rayzee'
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import { uv, uniform } from 'three/tsl';

export class MyCustomStage extends RenderStage {

    constructor( renderer, options = {} ) {

        super( 'MyCustom', {
            ...options,
            executionMode: StageExecutionMode.PER_CYCLE
        } );

        this.renderer = renderer;
        this.outputTarget = new RenderTarget( options.width || 1, options.height || 1 );

        this.intensity = uniform( 1.0 );

        // Updatable texture node — only .value changes, the shader does not recompile
        this._inputTexNode = new TextureNode();

        this.material = new MeshBasicNodeMaterial();
        this.material.outputNode = this._inputTexNode.sample( uv() ).mul( this.intensity );
        this.quad = new QuadMesh( this.material );

    }

    render( context ) {

        if ( ! this.enabled ) return;

        const inputTexture = context.getTexture( 'pathtracer:color' );
        if ( ! inputTexture ) return;

        this._inputTexNode.value = inputTexture;

        this.renderer.setRenderTarget( this.outputTarget );
        this.quad.render( this.renderer );
        this.renderer.setRenderTarget( null );

        context.setTexture( 'mycustom:output', this.outputTarget.texture );

    }

    setSize( width, height ) {

        this.outputTarget.setSize( width, height );

    }

    dispose() {

        this.outputTarget.dispose();
        this.material.dispose();
        this.context?.removeTexture( 'mycustom:output' );

    }

}
```

Give every `TextureNode` a kernel reads its real texture before the kernel first runs: two nodes still holding the default empty texture share one GPU binding (`Pipeline/BindingAudit.js` checks this when `setBindingAudit( true )`; the bench turns it on). A node read later than that gets its own placeholder texture (`readNode()` in `NRD.js`).

### Step 2: Add to Pipeline

A viewer stage goes in `PathTracerApp._createExtraStages()`, in pipeline order. To be shown, its output key must be in `_displaySources()`, in priority order:

```javascript
// PathTracerApp.js
_createExtraStages() {

    const { renderer, stages } = this;
    // ... existing stages ...
    stages.myCustom = new MyCustomStage( renderer, { enabled: false } );

    return [
        stages.normalDepth, stages.motionVector, stages.nrd, stages.asvgf,
        stages.variance, stages.bilateralFilter, stages.edgeFilter, stages.autoExposure,
        stages.myCustom,   // runs before the Compositor
    ];

}

_displaySources() {

    return [ 'mycustom:output', 'oidn:output', 'edgeFiltering:output', 'bilateralFiltering:output', 'asvgf:output', 'nrd:output' ];

}
```

On the core alone, subclass `RayzeeRenderer` and override the same two hooks. The core adds the returned stages between PathTracer and the Compositor; the pipeline's `setSize()` sizes them.

If the stage needs a per-pixel output the path tracer does not write, it asks with `pathTracer.requestOutput( name, options )` (pass the path tracer in through the stage's options) rather than the core naming the stage. `'hitDistance'` is the one output so far; a new one is added to Shade the same way.

### Step 3: Add Store Handler (Optional)

```javascript
// app/src/store.js — handleChange calls the updater with ( val, app ), then app.reset()
handleMyCustomIntensity: handleChange(
    val => set( { myCustomIntensity: val } ),
    ( val, app ) => { app.stages.myCustom.intensity.value = val; }
),
```

---

## Best Practices

### Do

- **Share textures through the context** - format `stageName:textureName`
- **Handle missing inputs** - fall back or pass the input through (NRD, EdgeFilter)
- **Return early when disabled**
- **Pick the right execution mode** - PER_CYCLE for post-processing, ALWAYS for work every frame
- **Remove your context textures and dispose your targets** in `dispose()`
- **Mutate `.value`** on uniform and texture nodes; never replace a node a compiled kernel holds
- **Use `getApp()` from appProxy** in UI code - never hold the app in a component

### Don't

- **Don't reach into other stages for textures** - read them from the context
- **Don't name a capability in the core** - add a hook, a context key or `requestOutput`
- **Don't keep per-renderer shader state in module variables** - use the kernel's build context (`TSL/SceneResources.js`)
- **Don't allocate in `render()`** - allocate in the constructor or on resize
- **Don't drop history on every reset** - listen for `pipeline:historyReset`; a soft reset (a camera move) keeps it

---

## Performance Considerations

1. **Disabled stages cost nothing per frame** — `shouldExecuteThisFrame()` skips them before `render()`.
2. **Skip work the frame does not need** — ASVGF skips its gradient dispatch when `gradientStrength` is 0 and the heatmap is off; NRD skips its passes past the handover; EdgeFilter passes through while the camera moves.
3. **Lazy initialization** — the Compositor builds its convergence-overlay material on first enable, so the normal display path carries none of its bindings.
4. **Ping-pong targets** — NormalDepth, Variance and ASVGF alternate two textures for current and previous frame.

### Performance Monitoring

```javascript
pipeline.setStatsEnabled( true );
pipeline.logStats();  // per-stage timing
```

These time command **encoding** on the CPU, not GPU execution: on a compute-heavy pipeline they stay flat while GPU cost doubles. For GPU milliseconds use `app.enableGPUTiming( true )` and `await app.getGPUTimings()` (WebGPU timestamp queries).

---

## Debugging

### Check Pipeline State

```javascript
// Dev builds expose the app as `app` in the browser console (appProxy.js)
app.pipeline.getInfo();
// stage names and enabled states, context state, texture names, event names

app.pipeline.context.getTextureNames();

app.pipeline.eventBus.listenerCount( 'pipeline:historyReset' );

app.issues;  // includes stage.render_failed for a stage that threw
```

### Debug Stage Execution

```javascript
// Log each stage skipped this frame (disabled, or gated by its execution mode)
app.pipeline.setStatsEnabled( true );
app.pipeline.stats.logSkipped = true;

app.pipeline.context.getState( 'tileRenderingComplete' );
// true once the path tracer has traced a frame; PER_CYCLE stages then run.
```

---

## Common Patterns

### Reading from Previous Stage

```javascript
// BilateralFilter: the newest picture available
const inputTex = context.getTexture( this.inputTextureName )
    || context.getTexture( 'asvgf:output' )
    || context.getTexture( 'pathtracer:color' );
if ( ! inputTex ) return;
```

### Passing Through

```javascript
// NRD: no guides ⇒ no guidance. Pass through rather than blur blind.
if ( ! albedoTex || ! ndTex || ! snTex || ! motionTex ) {
    context.setTexture( 'nrd:output', colorTex );
    return;
}
```

### Sizing From the Input

```javascript
// Stages size their targets from the texture they read, not only from setSize()
const img = colorTex.image;
if ( img && img.width > 0 && img.height > 0 &&
    ( img.width !== this.outputTarget.width || img.height !== this.outputTarget.height ) ) {
    this.setSize( img.width, img.height );
}
```

---

## See Also

- `docs/CORE_AND_ADDONS.md` — the core, capability and viewer layers and the rules between them
- `docs/PATH_TRACER_SHADER_ARCHITECTURE.md` — the wavefront kernels
- `docs/NRD_DENOISER.md` — the NRD port
