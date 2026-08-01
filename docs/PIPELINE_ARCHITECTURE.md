# Pipeline Architecture

**Rayzee Path Tracing Engine - Event-Driven Rendering Pipeline**

---

## Overview

Rayzee uses an **event-driven pipeline** of modular rendering stages built on WebGPU. TSL (Three Shading Language) shaders are compiled to WGSL at runtime. The `PathTracerApp` manages the renderer, scene, camera, and pipeline lifecycle, while the UI/store layer accesses it via `getApp()` from appProxy.

### System Architecture

```
                    ┌─────────────────────────────────────────┐
                    │              UI / React                  │
                    │  (Zustand Store + appProxy.getApp())    │
                    └─────────────────┬───────────────────────┘
                                      │
                              ┌───────┴───────┐
                              │  appProxy     │
                              │  getApp()     │
                              │  subscribeApp()│
                              └───────┬───────┘
                                      │
                              ┌───────┴───────────────┐
                              │    PathTracerApp      │
                              │    (WebGPU Renderer)  │
                              ├───────────────────────┤
                              │ RenderSettings        │
                              │ AssetLoader           │
                              │ SceneProcessor        │
                              ├───────────────────────┤
                              │ RenderPipeline        │
                              │ ├─PathTracer          │
                              │ │ ├─UniformManager    │
                              │ │ ├─MaterialDataMgr   │
                              │ │ ├─EnvironmentMgr    │
                              │ │ ├─ShaderBuilder     │
                              │ │ └─StorageTexturePool│
                              │ ├─NormalDepth         │
                              │ ├─MotionVector        │
                              │ ├─ASVGF               │
                              │ ├─Variance            │
                              │ ├─BilateralFilter     │
                              │ ├─EdgeFilter          │
                              │ ├─AutoExposure        │
                              │ └─Compositor          │
                              ├───────────────────────┤
                              │ managers/             │
                              │  ├─CameraManager      │
                              │  ├─LightManager       │
                              │  ├─DenoisingManager   │
                              │  │  ├─OIDNDenoiser    │
                              │  │  └─AIUpscaler      │
                              │  └─OverlayManager     │
                              │     └─TileHelper      │
                              └───────────────────────┘
```

### App Proxy (`app/src/lib/appProxy.js`)

All UI/store code accesses the app via `getApp()`:

```javascript
import { getApp, subscribeApp } from '@/lib/appProxy';

const app = getApp();  // Returns app instance or null
if (app) app.setMaxBounces(8);

// Subscribe to app initialization/changes
const unsub = subscribeApp((app) => {
    if (app) console.log('App ready');
});
```

---

## Architecture Benefits

### Solved Problems

**Before (Legacy Pass Architecture):**
- Tight coupling between passes
- Implicit execution order
- Difficult to test in isolation
- Hard to add new features
- Manual texture passing between passes

**After (Pipeline Architecture):**
- ✅ Loose coupling via events
- ✅ Explicit execution order (stages added sequentially)
- ✅ Easy to test (mock context/events)
- ✅ Simple to extend (just add new stage)
- ✅ Automatic texture sharing via context

### Design Principles

1. **Single Responsibility** - Each stage does one thing well
2. **Dependency Inversion** - Stages depend on context/events, not each other
3. **Event-Driven** - Communication through pub/sub pattern
4. **Explicit Over Implicit** - Clear execution order, no hidden dependencies

---

## Core Components

### 1. PipelineContext

Shared state container for all stages.

**Purpose:**
- Store textures (for sharing between stages)
- Store state (frame counters, settings, etc.)
- Manage frame lifecycle

**Key Methods:**
```javascript
// Textures
context.setTexture('pathtracer:color', texture);
context.getTexture('pathtracer:color');

// State
context.setState('frame', 0);
context.getState('frame');

// Lifecycle
context.incrementFrame();
context.reset();
```

**Important State Keys:**
| Key | Type | Description |
|-----|------|-------------|
| `frame` | number | Current frame counter |
| `renderMode` | number | 0=interactive, 1=production (full-frame in both; no tile loop) |
| `tileRenderingComplete` | boolean | Set `true` by PathTracer every frame; PER_CYCLE stages gate on it |
| `interactionMode` | boolean | True during camera movement |
| `width` / `height` | number | Viewport dimensions |

> The engine renders full-frame only. `tileRenderingComplete` is a legacy state key kept as the PER_CYCLE gate — the path tracer always sets it `true` (a full frame is one complete cycle), so PER_CYCLE stages run every frame. See Execution Modes below.

**Example:**
```javascript
// PathTracer publishes its output
context.setTexture('pathtracer:color', this.colorTarget.texture);
context.setTexture('pathtracer:normalDepth', this.normalDepthTarget.texture);

// ASVGF reads PathTracer output
const colorTexture = context.getTexture('pathtracer:color');
const normalDepth = context.getTexture('pathtracer:normalDepth');
```

---

### 2. EventBus

Event-driven communication between stages.

**Purpose:**
- Decouple stages
- Enable reactive updates
- Support async workflows

**Key Events (verified emitters in `rayzee/src`):**
```javascript
'pathtracer:frameComplete'    // PathTracerStage — frame finished { frame, isComplete }
'camera:moved'                // PathTracerStage — camera transform changed
'pathtracer:viewpointChanged' // PathTracerStage — camera optimizer reset
'asvgf:reset'                 // PathTracerStage / PathTracerApp — reset ASVGF history
'asvgf:updateParameters'      // PathTracerStage — push ASVGF params
'autoexposure:resetHistory'   // PathTracerApp / EnvironmentManager — reset exposure history
'autoexposure:updated'        // AutoExposure
'motionvector:computed'       // MotionVector
'frame:complete'              // RenderPipeline — after all stages run { frame }
'pipeline:reset'              // RenderPipeline — pipeline reset
'pipeline:resize'             // RenderPipeline — viewport resized { width, height }
'stage:enabled' / 'stage:disabled' // RenderStage.enable()/disable()
```

> There is no `tile:changed` event — the engine renders full-frame only. TileHelper's overlay is driven by `tileProgress`/`end` events the OIDN denoiser and AI upscaler emit on themselves (DOM-style `addEventListener`, not this bus); see Tile Visualization below.

**Example:**
```javascript
// PathTracer signals a finished frame
this.emit('pathtracer:frameComplete', { frame: this.frameCount, isComplete: this.isComplete });

// ASVGF listens for reset
this.on('asvgf:reset', () => this.resetTemporalData());
```

---

### 3. RenderPipeline

Orchestrates stage execution.

**Purpose:**
- Manage stage lifecycle
- Execute stages in order
- Handle errors gracefully
- Track performance

**Usage:**
```javascript
const pipeline = new RenderPipeline(renderer, width, height);

// Add stages in execution order
pipeline.addStage(pathTracerStage);
pipeline.addStage(asvgfStage);
pipeline.addStage(edgeFilteringStage);
// Render all enabled stages
pipeline.render(writeBuffer);

// Lifecycle
pipeline.reset();
pipeline.setSize(width, height);
pipeline.dispose();
```

---

### 4. RenderStage (Base Class)

Base class for all stages.

#### Execution Modes

Stages declare when they execute via `executionMode` (defined in `RenderStage.js`):

```javascript
export const StageExecutionMode = {
    ALWAYS: 'always',         // Execute every frame
    PER_CYCLE: 'per_cycle',   // Execute when the path tracer completes a frame
    PER_TILE: 'per_tile',     // Execute every frame (currently equivalent to ALWAYS; unused)
    CONDITIONAL: 'conditional' // Custom logic via shouldExecute() override
};
```

`shouldExecuteThisFrame()` gates each stage: `PER_CYCLE` runs when `renderMode === 0`, or when `tileRenderingComplete === true`. Since the engine renders full-frame only and PathTracer sets `tileRenderingComplete = true` every frame, **PER_CYCLE simply means "after the path tracer finishes a frame"** — which is every frame. The mechanism survives the tile-rendering removal; it no longer skips intermediate frames because there are none.

**Usage by Stage Type:**

| Mode | Use Case | Example Stages |
|------|----------|---------------|
| `ALWAYS` | Accumulator stages | PathTracer |
| `PER_CYCLE` | Post-processing, denoisers, filters | ASVGF, EdgeFilter, BilateralFilter |
| `PER_TILE` | Currently unused | - |
| `CONDITIONAL` | Custom `shouldExecute()` logic | - |

**Example:**
```javascript
export class MyDenoiserStage extends RenderStage {
    constructor(options = {}) {
        super('MyDenoiser', {
            ...options,
            executionMode: StageExecutionMode.PER_CYCLE
        });
    }

    render(context, writeBuffer) {
        // Runs after PathTracer publishes a completed frame.
    }
}
```

**Key Methods to Override:**
```javascript
class MyStage extends RenderStage {

    // Required: Render this stage
    render(context, writeBuffer) {
        // Read from context
        const input = context.getTexture('previous:output');

        // Render
        renderer.setRenderTarget(this.outputTarget);
        this.quad.render(renderer);

        // Write to context
        context.setTexture('mystage:output', this.outputTarget.texture);
    }

    // Optional: Setup event listeners
    setupEventListeners() {
        this.on('asvgf:reset', () => { ... });
    }

    // Optional: Reset state
    reset() {
        this.frameCount = 0;
    }

    // Optional: Resize render targets
    setSize(width, height) {
        this.outputTarget.setSize(width, height);
    }

    // Optional: Cleanup
    dispose() {
        this.outputTarget.dispose();
        this.material.dispose();
    }
}
```

**Utility Methods:**
```javascript
// Events
this.emit('event:name', data);
this.on('event:name', callback);
this.off('event:name', callback);

// Logging
this.log('message');
this.warn('warning');
this.error('error');

// Enable/Disable
this.enable();
this.disable();
```

---

## Stage Descriptions

### PathTracer

`Stages/PathTracer.js` (`class PathTracer extends PathTracerStage`). Core ray tracing renderer.

**Execution Mode:** `ALWAYS` (set by the `PathTracerStage` base) — accumulates a sample every frame.

**Input:** Scene geometry, materials, camera
**Output (published to context):**
- `pathtracer:color` - Accumulated color
- `pathtracer:normalDepth` - G-buffer (normals + depth)
- `pathtracer:albedo` - Albedo (for denoisers)

**Key Features:**
- Progressive full-frame accumulation (no tile loop)
- BVH acceleration (two-level TLAS/BLAS)
- Material sampling (PBR, emissive, etc.)
- Storage-texture MRT outputs (color / normalDepth / albedo)

**Wavefront architecture:** PathTracer is a pure wavefront tracer — there is no megakernel / monolithic `PathTracerPass`. Each frame is a sequence of decomposed compute kernels dispatched via `KernelManager`: **Generate → per-bounce [Extend → (Sort) → Shade → Compact] → FinalWrite**, plus a single-pass **DebugKernel** for `visMode`. The kernel-level detail (queues, ray buffers, stream compaction, sorting) lives in `PATH_TRACER_SHADER_ARCHITECTURE.md`; this doc only covers its place in the stage pipeline.

**Events Emitted:**
- `pathtracer:frameComplete` - After each frame `{ frame, isComplete }`
- `camera:moved` - When the camera transform changes
- (plus `asvgf:*` coordination events — see EventBus above)

#### Composition Architecture

`PathTracer` extends `PathTracerStage`. The base (`Stages/PathTracerStage.js`) owns the renderer-agnostic state and delegates data management to 5 focused sub-managers via composition; the subclass adds the wavefront kernel orchestration (`render()`, `KernelManager`/`QueueManager`/`PackedRayBuffer` wiring):

```
PathTracer  (Stages/PathTracer.js — wavefront render() + kernel orchestration)
  └── PathTracerStage  (Stages/PathTracerStage.js — base, sub-manager composition)
        ├── uniforms: UniformManager           (managers/UniformManager.js)
        ├── materialData: MaterialDataManager  (managers/MaterialDataManager.js)
        ├── environment: EnvironmentManager    (managers/EnvironmentManager.js)
        ├── shaderBuilder: ShaderBuilder       (Processor/ShaderBuilder.js)
        └── storageTextures: StorageTexturePool (Processor/StorageTexturePool.js)
```

The base keeps: constructor, `reset()`, `build()`, `setupMaterial()`, scene/light/camera uniform updates, event emission, ASVGF coordination, and disposal. The subclass keeps: `render()` (the per-bounce kernel loop) and kernel/buffer lifecycle. Data management is delegated to the sub-managers.

**Sub-Manager Access Pattern:**

External code (other stages, PathTracerApp) accesses sub-managers directly:

```javascript
// UniformManager — get/set TSL uniform nodes
const maxBounces = stage.uniforms.get('maxBounces');      // returns TSL uniform node
stage.uniforms.set('maxBounces', 12);                     // sets node.value

// Dynamic getters on PathTracer (shorthand for uniforms)
stage.maxBounces;                // equivalent to stage.uniforms.get('maxBounces')
stage.cameraWorldMatrix;         // equivalent to stage.uniforms.get('cameraWorldMatrix')

// MaterialDataManager
stage.materialData.materialStorageAttr;   // StorageInstancedBufferAttribute
stage.materialData.materialStorageNode;   // storage().toReadOnly() node
stage.materialData.albedoMaps;            // DataArrayTexture
stage.materialData.updateMaterialProperty(index, property, value);

// EnvironmentManager
stage.environment.environmentTexture;     // current env texture
stage.environment.envParams;              // { type, color, ... }
await stage.environment.setEnvironmentMap(envMap);
await stage.environment.generateProceduralSkyTexture();

// ShaderBuilder — builds/refreshes the scene texture nodes the kernels read
stage.shaderBuilder.createSceneTextureNodes(stage, storageTextures);
stage.shaderBuilder.updateSceneTextures(stage);  // in-place texture node update
stage.shaderBuilder.getSceneTextureNodes();

// StorageTexturePool
stage.storageTextures.swap();
stage.storageTextures.getReadTextures();  // returns current read textures
stage.storageTextures.ensureSize(width, height);

// VRAMTracker (on the PathTracer subclass) — current/peak GPU memory
stage.vramTracker.measure();              // { current, peak, byCategory } in bytes
stage.vramTracker.resetPeak();            // reset the high-water mark
```

`VRAMTracker` (`Processor/VRAMTracker.js`) is owned by the `PathTracer` subclass (not one of the base's 5 sub-managers). It registers thunk providers that read live GPU resources — ray/queue buffers, scene geometry, materials, environment, the accumulation pool, and (via `PathTracerApp`) every other stage's storage textures — and sums their real `byteLength`/texture sizes, de-duplicated by identity. `PathTracerApp` exposes it as `app.vram` / `app.getMemoryInfo()` and re-measures per frame plus on scene/environment/resolution change.

**Callback Pattern:**

Sub-managers use callbacks to communicate back without circular dependencies:

```javascript
// In PathTracer constructor:
this.materialData.callbacks.onReset = () => this.reset();
this.environment.callbacks.onReset = () => this.reset();
this.environment.callbacks.getSceneTextureNodes = () =>
    this.shaderBuilder.getSceneTextureNodes();
```

**Key Design Constraint:** TSL uniform nodes and texture nodes are created once and never replaced — only `.value` is mutated. This preserves compiled shader graph references. All sub-managers follow this pattern.

---

### ASVGF

**Purpose:** Adaptive Spatially-Varying Global Filtering (denoiser)
**Execution Mode:** `PER_CYCLE` - Only denoises complete frames

**Input:**
- `pathtracer:color`
- `pathtracer:normalDepth`

**Output:**
- `asvgf:output` - Denoised color (context texture)
- `asvgf:variance` - Variance map (context texture)
- `asvgf:temporalColor` - Temporal accumulation (context texture)
- `stage.heatmapTarget` - Public `RenderTarget` for host-side debug overlays (not in context — only written when `setHeatmapEnabled(true)`)

**Key Features:**
- Motion vector calculation
- Temporal accumulation
- Variance estimation
- A-trous wavelet filtering
- Edge-aware filtering

**Events Listened:**
- `asvgf:reset` - Reset temporal history

---

### EdgeFilter

**Purpose:** Temporal edge-aware filtering (alternative to ASVGF)
**Execution Mode:** `PER_CYCLE` - Only filters complete frames

**Input:**
- `pathtracer:color`
- `pathtracer:normalDepth`

**Output:**
- `edgeFiltering:output` - Filtered color

**Key Features:**
- Edge detection
- Temporal accumulation
- Pixel sharpness control
- Iteration-based filtering

**Note:** Typically disabled when ASVGF is enabled

---

### Tile Visualization (OverlayManager)

The path tracer renders full-frame, so there are no path-trace tiles to draw. `TileHelper` (`managers/helpers/TileHelper.js`, registered by `OverlayManager`) survives only to draw the progress border of the **OIDN denoiser** and **AI upscaler**, which process the final image in tiles. It listens for `tileProgress` / `end` events the denoiser/upscaler emit on themselves (via DOM-style `addEventListener`, wired in `OverlayManager._wireDenoiserTileEvents` — not the pipeline event bus). It renders on a 2D canvas overlay so the border is never baked into saved images.

---

## Execution Flow

### Per-Frame Flow (full-frame, both render modes)

The engine renders full-frame every frame. PathTracer accumulates one sample, marks the frame complete, and all enabled stages run:

```
1. PathTracer.render() [ALWAYS]
   ↓ runs the wavefront kernel sequence (Generate → bounces → FinalWrite)
   ↓ writes 'pathtracer:color', 'pathtracer:normalDepth', 'pathtracer:albedo' to context
   ↓ sets 'tileRenderingComplete' = true
   ↓ emits 'pathtracer:frameComplete'

2. ASVGF.render() [PER_CYCLE] ✅ Executes
   ↓ reads 'pathtracer:color', 'pathtracer:normalDepth'
   ↓ writes 'asvgf:output', 'asvgf:variance' to context

3. EdgeFilter.render() [PER_CYCLE] ✅ Executes
   ↓ reads 'pathtracer:color', 'pathtracer:normalDepth'
   ↓ writes 'edgeFiltering:output' to context

5. Compositor.render() → renderer's output pass (tone mapping + sRGB) → Screen
   ↓ then OverlayManager renders outline + helpers on top
```

`renderMode` (0=interactive, 1=production) still tunes quality — e.g. production forces bounces/SPP to 1 on the first frame and drives the OIDN denoise/upscale path — but neither mode subdivides the frame into tiles. Since `tileRenderingComplete` is always `true`, no PER_CYCLE stage is ever skipped.

### Pipeline Integration

```
RenderPipeline.render(writeBuffer)
    ↓ executes stages sequentially
[PathTracer → NormalDepth → MotionVector → ASVGF → Variance → BilateralFilter → EdgeFilter → AutoExposure → Compositor]
    ↓
Compositor → renderer.toneMapping output pass (tone curve + sRGB) → Screen
    ↓
OverlayManager → outline + scene helpers + HUD (at display resolution)
```

---

## Texture Flow

### Context Texture Registry

| Texture Key | Producer | Consumers | Description |
|-------------|----------|-----------|-------------|
| `pathtracer:color` | PathTracer | ASVGF, EdgeFilter, Compositor | Accumulated path traced color |
| `pathtracer:normalDepth` | PathTracer | ASVGF, EdgeFilter, MotionVector | G-buffer: normals + depth |
| `pathtracer:albedo` | PathTracer | ASVGF, BilateralFilter | Albedo (denoiser guide) |
| `asvgf:output` | ASVGF | Compositor | Denoised color |
| `variance:output` | Variance | BilateralFilter | Variance map |
| `asvgf:temporalColor` | ASVGF | - | Temporal accumulation |
| `edgeFiltering:output` | EdgeFilter | Compositor | Filtered color |

---

## Adding a New Stage

### Step 1: Create Stage Class

**Choose the Right Execution Mode:**
- **ALWAYS** - If your stage accumulates data or provides real-time feedback
- **PER_CYCLE** - If your stage does post-processing/filtering (most common for new stages; runs after the path tracer finishes a frame)
- **CONDITIONAL** - If you have complex custom logic (override `shouldExecute()`)

```javascript
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { MeshBasicNodeMaterial, QuadMesh, RenderTarget, TextureNode } from 'three/webgpu';
import { uv, uniform } from 'three/tsl';

export class MyCustomStage extends RenderStage {

    constructor(renderer, options = {}) {
        super('MyCustom', {
            ...options,
            executionMode: StageExecutionMode.PER_CYCLE // Choose appropriate mode
        });

        this.renderer = renderer;

        // Create render target
        this.outputTarget = new RenderTarget(
            options.width,
            options.height
        );

        // TSL uniform
        this.intensity = uniform(1.0);

        // Updatable texture node
        this._inputTexNode = new TextureNode();

        // Build TSL shader — sample input and apply intensity
        const shader = this._inputTexNode.sample(uv()).mul(this.intensity);

        this.material = new MeshBasicNodeMaterial();
        this.material.outputNode = shader;

        this.quad = new QuadMesh(this.material);
    }

    setupEventListeners() {
        this.on('mycustom:update', (data) => {
            this.material.uniforms.intensity.value = data.intensity;
        });
    }

    render(context, writeBuffer) {
        if (!this.enabled) return;

        // Read input from context
        const inputTexture = context.getTexture('pathtracer:color');
        if (!inputTexture) return;

        // Swap texture node value (no shader recompile)
        this._inputTexNode.value = inputTexture;

        // Render to output target
        this.renderer.setRenderTarget(this.outputTarget);
        this.quad.render(this.renderer);

        // Publish to context
        context.setTexture('mycustom:output', this.outputTarget.texture);
    }

    setSize(width, height) {
        this.outputTarget.setSize(width, height);
    }

    dispose() {
        this.outputTarget.dispose();
        this.material.dispose();
    }
}
```

### Step 2: Add to Pipeline

```javascript
// In PathTracerApp.js setupPipeline()
import { MyCustomStage } from './Stages/MyCustomStage.js';

const myStage = new MyCustomStage(this.renderer, {
    width: this.width,
    height: this.height,
    enabled: true
});

// Add in desired execution order
this.pipeline.addStage(pathTracer);
this.pipeline.addStage(asvgf);
this.pipeline.addStage(myStage);  // ← Add here
this.pipeline.addStage(compositor);
```

### Step 3: Add Store Handler (Optional)

```javascript
// In app/src/store.js - uses getApp() from appProxy
handleMyCustomIntensity: handleChange(
    val => set({ myCustomIntensity: val }),
    val => getApp().myStage.intensity.value = val
),
```

---

## Best Practices

### Do's ✅

- **Use context for texture sharing** - Don't pass textures directly between stages
- **Emit events for state changes** - Let other stages react
- **Check enabled state** - Early return if disabled
- **Choose correct execution mode** - PER_CYCLE for post-processing, ALWAYS for accumulators
- **Dispose resources** - Clean up in dispose()
- **Use meaningful texture keys** - Format: `stageName:textureName`
- **Document events** - What data is emitted
- **Handle missing inputs gracefully** - Check if textures exist
- **Use `getApp()` from appProxy** - Never store direct app references in components

### Don'ts ❌

- **Don't access other stages directly** - Use context/events
- **Don't assume execution order** - Stages should work independently
- **Don't leak render targets** - Always dispose
- **Don't allocate in render loop** - Pre-allocate in constructor
- **Don't modify shared state without events** - Others won't know
- **Don't forget to check this.enabled** - Wasted GPU cycles

---

## Performance Considerations

### Optimization Tips

1. **Conditional Execution**
   ```javascript
   render(context, writeBuffer) {
       if (!this.enabled) return;  // Early exit
       // ... expensive work
   }
   ```

2. **Lazy Initialization**
   ```javascript
   if (!this.copyMaterial) {
       this.copyMaterial = new ShaderMaterial({...});
   }
   ```

3. **Render Target Reuse**
   ```javascript
   // Ping-pong between two targets
   [this.targetA, this.targetB] = [this.targetB, this.targetA];
   ```

4. **Event Debouncing**
   ```javascript
   this.on('expensive:event', debounce(() => {
       // ... expensive operation
   }, 100));
   ```

### Performance Monitoring

```javascript
pipeline.setStatsEnabled(true);
pipeline.logStats();  // Shows per-stage timing
```

---

## Debugging

### Enable Debug Logging

```javascript
// In stage constructor
this.debug = true;

// In render method
if (this.debug) {
    console.log('[MyStage] Rendering with:', {
        enabled: this.enabled,
        inputTexture: !!inputTexture,
        frame: context.getState('frame')
    });
}
```

### Check Pipeline State

```javascript
// In browser console
getApp().pipeline.getInfo();
// Returns: stage names, enabled states, execution order

getApp().pipeline.context.textures;
// Shows all registered textures

getApp().pipeline.eventBus.listenerCount('asvgf:reset');
// Check event listeners
```

### Debug Stage Execution

```javascript
// Log any stages skipped this frame (e.g. disabled stages)
getApp().pipeline.stats.enabled = true;
getApp().pipeline.stats.logSkipped = true;

getApp().pipeline.context.getState('tileRenderingComplete');
// Always true (full-frame). PER_CYCLE stages run whenever this is true.
```

---

## Common Patterns

### Reading from Previous Stage

```javascript
render(context, writeBuffer) {
    // Try multiple sources (priority order)
    let input = context.getTexture('asvgf:output');
    if (!input) input = context.getTexture('pathtracer:color');
    if (!input) {
        this.warn('No input texture');
        return;
    }
    // ... use input
}
```

### Copying to writeBuffer

```javascript
render(context, writeBuffer) {
    // Render to own target
    renderer.setRenderTarget(this.outputTarget);
    this.quad.render(renderer);

    // Publish to context
    context.setTexture('mystage:output', this.outputTarget.texture);

    // Copy to writeBuffer
    if (writeBuffer && !this.renderToScreen) {
        this.copyTexture(renderer, this.outputTarget, writeBuffer);
    }
}
```

### Temporal Accumulation

```javascript
render(context, writeBuffer) {
    // Blend current with previous
    this.material.uniforms.tCurrent.value = currentTexture;
    this.material.uniforms.tPrevious.value = this.prevTarget.texture;
    this.material.uniforms.alpha.value = 0.1;  // Blend factor

    renderer.setRenderTarget(this.currentTarget);
    this.quad.render(renderer);

    // Swap for next frame
    [this.currentTarget, this.prevTarget] =
        [this.prevTarget, this.currentTarget];
}
```

---

## Summary

The Pipeline architecture provides:

- ✅ **Modularity** - Each stage is independent
- ✅ **Testability** - Mock context/events for unit tests
- ✅ **Extensibility** - Add stages without modifying existing code
- ✅ **Maintainability** - Clear responsibilities, easy to understand
- ✅ **Performance** - Enable/disable stages dynamically, declarative execution modes
- ✅ **Flexibility** - Events enable reactive workflows

**Execution Modes:** Stages declaratively control when they run via `executionMode`. The engine renders full-frame only, so `PER_CYCLE` resolves to "after the path tracer finishes a frame" — every frame.

**Wavefront path tracer:** The PathTracer stage is a pure wavefront tracer (decomposed compute kernels), not a megakernel. See `PATH_TRACER_SHADER_ARCHITECTURE.md`.

**TSL:** TSL shaders compile JavaScript shader definitions to WGSL at runtime, enabling path tracing on WebGPU without hand-written WGSL.

**Result:** Clean, maintainable, and scalable WebGPU rendering pipeline with TSL shaders.
