# Rayzee Engine

[![NPM Package][npm]][npm-url]
[![Build Size][build-size]][build-size-url]
[![NPM Downloads][npm-downloads]][npmtrends-url]
[![jsDelivr Downloads][jsdelivr-downloads]][jsdelivr-url]

A real-time WebGPU path tracing engine built on Three.js. Framework-agnostic — use it with React, Vue, vanilla JS, or any other setup.

🌐 **[Live Demo](https://atul-mourya.github.io/RayTracing/)** — the same demo app linked from the root monorepo README, built on this engine.

## Table of Contents

- [Installation](#installation)
- [Getting Started](#getting-started)
  - [Vanilla JS with Vite](#vanilla-js-with-vite)
  - [Vanilla JS (no bundler)](#vanilla-js-no-bundler)
  - [React](#react)
  - [Integrating Alongside an Existing Three.js App](#integrating-alongside-an-existing-threejs-app)
  - [Vite tip](#vite-tip)
- [API Reference](#api-reference)
  - [Configuring Assets (CDN URLs & cache namespace)](#configuring-assets-cdn-urls--cache-namespace)
  - [PathTracerApp](#pathtracerapp)
  - [engine.cameraManager](#enginecameramanager)
  - [engine.lightManager](#enginelightmanager)
  - [engine.animationManager](#engineanimationmanager)
  - [Materials](#materials)
  - [engine.environmentManager](#engineenvironmentmanager)
  - [engine.denoisingManager](#enginedenoisingmanager)
  - [engine.interactionManager](#engineinteractionmanager)
  - [engine.transformManager](#enginetransformmanager)
  - [Output Methods](#output-methods)
  - [Memory Monitoring](#memory-monitoring)
  - [Events](#events)
  - [Advanced: Custom Pipeline Stages](#advanced-custom-pipeline-stages)
  - [All Exports](#all-exports)
- [Browser Requirements](#browser-requirements)
- [Optional Dependencies](#optional-dependencies)
  - [Enabling OIDN (Intel Open Image Denoise)](#enabling-oidn-intel-open-image-denoise)
  - [Enabling the AI Upscaler](#enabling-the-ai-upscaler)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Installation

```bash
npm install rayzee three
```

`three` (>=0.185.0) is a required peer dependency.

## Getting Started

### Vanilla JS with Vite

1. **Create a project**

   ```bash
   npm create vite@latest my-raytracer -- --template vanilla
   cd my-raytracer
   npm install rayzee three
   ```

2. **Set up the HTML**

   ```html
   <!-- index.html -->
   <body style="margin: 0; overflow: hidden;">
     <canvas id="viewport"></canvas>
     <script type="module" src="/main.js"></script>
   </body>
   ```

3. **Write the code**

   ```js
   // main.js
   import { PathTracerApp, EngineEvents } from 'rayzee';

   const canvas = document.getElementById('viewport');
   canvas.width = window.innerWidth;
   canvas.height = window.innerHeight;

   const engine = new PathTracerApp(canvas);
   await engine.init();

   // Load a 3D model (place .glb in public/ folder)
   await engine.loadModel('/scene.glb');

   // Or load an environment map
   // await engine.loadEnvironment('/environment.hdr');

   // Start rendering
   engine.animate();

   // Listen for events
   engine.addEventListener(EngineEvents.RENDER_COMPLETE, () => {
     console.log('Frame rendered');
   });

   // Tweak settings
   engine.settings.set('maxBounces', 8);
   engine.settings.set('exposure', 1.2);

   // Use namespaced APIs and direct methods
   engine.cameraManager.switchCamera(0);
   engine.lightManager.add('PointLight');

   // Capture the current frame as a Blob (host handles save/upload)
   const blob = await engine.screenshot();
   ```

4. **Run**

   ```bash
   npm run dev
   ```

### Vanilla JS (no bundler)

A single HTML file — no Node.js, no build step. Uses [ES module import maps](https://developer.mozilla.org/en-US/docs/Web/HTML/Element/script/type/importmap) to resolve the pre-built ESM bundle and its dependencies from a CDN.

```html
<!DOCTYPE html>
<html>
<head>
  <title>Rayzee Path Tracer</title>
  <style>body { margin: 0; overflow: hidden; background: #111; }</style>
  <script type="importmap">
  {
    "imports": {
      "three": "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.webgpu.js",
      "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.tsl.js",
      "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.185.0/build/three.webgpu.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.185.0/examples/jsm/",
      "oidn-web": "https://cdn.jsdelivr.net/npm/oidn-web@0.3.5/dist/oidn.js",
      "rayzee": "https://cdn.jsdelivr.net/npm/rayzee/dist/rayzee.es.js"
    }
  }
  </script>
</head>
<body>
  <canvas id="viewport"></canvas>
  <script type="module">
    import { PathTracerApp } from 'rayzee';

    const canvas = document.getElementById('viewport');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const engine = new PathTracerApp(canvas);
    await engine.init();
    // Replace with your own model URL
    await engine.loadModel('https://your-cdn.com/scene.glb');
    engine.animate();

    window.addEventListener('resize', () => {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      engine.onResize();
    });
  </script>
</body>
</html>
```

Serve with any static server (ES modules require HTTP, not `file://`):

```bash
npx serve .
```

> **Note**: The import map approach loads dependencies from a CDN, so initial load is slower than a bundled build. For production, use the Vite setup above.

### React

```jsx
import { useRef, useEffect } from 'react';
import { PathTracerApp } from 'rayzee';

export default function Viewport({ modelUrl }) {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;

    const engine = new PathTracerApp(canvas);
    engineRef.current = engine;

    (async () => {
      await engine.init();
      if (modelUrl) await engine.loadModel(modelUrl);
      engine.animate();
    })();

    return () => engine.dispose();
  }, [modelUrl]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100vh' }} />;
}
```

No special build config is needed — models and HDRs are loaded via URL at runtime.

### Integrating Alongside an Existing Three.js App

If your app already has a WebGL/WebGPU rasterized view and you want to add a path-traced mode on demand, run rayzee on its own **separate canvas** (WebGL and WebGPU can't share one) and toggle visibility.

```js
import { PathTracerApp } from 'rayzee';

// 1. WebGPU detection
if (!navigator.gpu || !(await navigator.gpu.requestAdapter())) return;

// 2. Overlay canvas (hidden until toggled on)
const ptCanvas = document.createElement('canvas');
Object.assign(ptCanvas.style, { position: 'absolute', inset: 0, display: 'none' });
container.appendChild(ptCanvas);

let engine = null;
async function togglePathTrace(on) {
  if (on && !engine) {
    ptCanvas.width = container.clientWidth;
    ptCanvas.height = container.clientHeight;
    engine = new PathTracerApp(ptCanvas, { autoResize: false });
    await engine.init();
    await engine.loadEnvironment('/env.hdr');             // required for realistic lighting
    await engine.loadObject3D(yourScene);                 // rayzee takes ownership — pass a clone if the host still renders it
    engine.animate();
  }
  ptCanvas.style.display = on ? 'block' : 'none';
  hostCanvas.style.display = on ? 'none' : 'block';
  on ? engine?.resume() : engine?.pause();                // pause the inactive renderer to avoid GPU contention
}
```

Key constraints:

- **`loadObject3D` takes ownership** of the passed `Object3D` (sets it as the active model, disposes the previous one). If your host app continues to render the same scene graph, pass `scene.clone(true)` — deep-cloning shares geometry/texture data, so memory cost is small. Clone once on first toggle, not on every switch.
- **Rayzee ignores `onBeforeCompile`.** It reads PBR material properties (albedo, roughness, metalness, …) directly into its own GPU buffers; custom shader injection on the host material has no effect on the path-traced view.
- **Always load an environment.** Path tracing without an env map produces a black background and no indirect lighting.
- **`three` is a peer dep on both sides.** Vite/webpack dedupe automatically. For script-tag setups, load one copy of `three` globally.

### Vite tip

When rayzee is installed from npm, its pre-built `dist/rayzee.es.js` uses worker and `import.meta.url` patterns that Vite's dep pre-bundler re-parses incorrectly. Exclude it:

```js
// vite.config.js
export default defineConfig({
  optimizeDeps: { exclude: ['rayzee'] },
});
```

## API Reference

### Configuring Assets (CDN URLs & cache namespace)

By default, the engine loads STBN blue-noise atlases, GLTF Draco/KTX2 decoders, OIDN denoiser weights, ONNX upscaler models, and the onnxruntime-web bundle from upstream CDNs. If you're self-hosting, embedding the engine alongside a different consumer of the same caches, or operating offline, override them **once before constructing `PathTracerApp`**:

```js
import { configureAssets } from 'rayzee';

configureAssets({
  // STBN atlases (PNG, decoded as Float textures)
  stbnScalarAtlas: '/assets/stbn_scalar_atlas.png',
  stbnVec2Atlas:   '/assets/stbn_vec2_atlas.png',

  // onnxruntime-web (loaded by AI upscaler worker via dynamic import)
  ortRuntimeUrl: '/ort/ort.webgpu.bundle.min.mjs',
  ortWasmPaths:  '/ort/',

  // GLTFLoader extension decoders
  dracoDecoderPath:   '/draco/',
  ktx2TranscoderPath: '/basis/',

  // Denoiser & upscaler weights
  oidnWeightsBaseUrl:    '/oidn-tzas/',
  upscalerModelBaseUrl:  '/upscaler-onnx/',

  // Prefix for engine-managed IndexedDB stores. Set to a unique value if multiple
  // apps embed the engine on the same origin to avoid cache collisions.
  cacheNamespace: 'my-app',
});

const engine = new PathTracerApp(canvas);
await engine.init();
```

All keys are optional — only what you pass is overridden. Call `getAssetConfig()` to read the current values.

### PathTracerApp

The main engine class. Extends Three.js `EventDispatcher`. Related functionality is grouped into **namespaced managers** accessed via `engine.cameraManager`, `engine.lightManager`, etc., or as direct methods on the engine instance.

```js
const engine = new PathTracerApp(canvas, options?)
```

| Parameter | Type | Description |
|---|---|---|
| `canvas` | `HTMLCanvasElement` | Rendering target |
| `options.autoResize` | `boolean` | Auto-resize on window resize (default: `true`) |
| `options.container` | `HTMLElement` | Single DOM parent the engine mounts auxiliary elements into — HUD overlay (tile borders, helpers) and denoiser canvas. Defaults to `canvas.parentNode`. |

The engine creates and mounts everything it needs (denoiser canvas, tile/HUD overlay) into a single parent on `init()`. Performance HUDs (e.g. `stats-gl`) are not bundled — listen to `EngineEvents.FRAME` and tick your own panel.

#### Lifecycle

```js
await engine.init()           // Initialize WebGPU renderer and pipeline
engine.animate()              // Start the render loop
engine.pause()                // Pause rendering
engine.resume()               // Resume rendering
engine.reset()                // Reset accumulation (restart from sample 0)
engine.dispose()              // Clean up all resources
engine.wake()                 // Resume render loop if idle
```

Constructing a new `PathTracerApp` on a canvas that already has an active instance auto-disposes the prior one — safe under React StrictMode and HMR even without explicit cleanup, though `engine.dispose()` remains the recommended teardown path.

#### Loading Assets

```js
await engine.loadModel(url)                  // Load GLB/GLTF/FBX/OBJ/STL/PLY/DAE/3MF/USDZ/ZIP
await engine.loadObject3D(object3d, name?)    // Load a Three.js Object3D directly (name is optional, defaults to 'object3d')
await engine.loadEnvironment(url)             // Load HDR/EXR environment map
engine.cancelLoad()                           // Abort an in-flight download (network phase only; no-op once processing starts)
```

`loadModel` / `loadObject3D` **replace** the current scene. To add or remove objects from a live scene without a full reload (and without reframing the camera):

```js
const id = await engine.addModel(url, { name })                  // Append a model, rebuild in place
const id = await engine.addModelFromObject3D(object3d, { name })  // Append a caller-owned Object3D (caller retains ownership)
await engine.removeSceneObject(id)                                // Remove by id — returns false if not found
engine.setSceneObjectVisibility(id, visible)                      // Toggle visibility with an O(1) BVH-leaf patch, no rebuild
```

`id` is the appended root's `Object3D.uuid`, returned by `addModel`/`addModelFromObject3D`. The built-in ground plane is permanent and can't be removed.

#### Settings

```js
engine.settings.set('maxBounces', 8)           // Set a single parameter
engine.settings.setMany({                      // Set multiple parameters at once
  maxBounces: 8,
  maxSamples: 60,
  exposure: 1.0
})
engine.settings.get('maxBounces')              // Read a parameter
engine.settings.getAll()                       // Get all current settings
```

Key settings:

| Setting | Type | Default | Description |
|---|---|---|---|
| `maxBounces` | `number` | 3 | Max ray bounce depth |
| `maxSamples` | `number` | 60 | Max accumulated samples before stopping |
| `exposure` | `number` | 1.0 | Exposure value |
| `saturation` | `number` | 1.2 | Color saturation |
| `enableEnvironment` | `boolean` | true | Use environment lighting |
| `environmentIntensity` | `number` | 1.0 | Environment light strength |
| `environmentRotation` | `number` | 270 | Environment Y-rotation (degrees) |
| `showBackground` | `boolean` | true | Show the environment as a visible backdrop for camera-miss rays (vs. a solid/transparent background) |
| `samplingTechnique` | `number` | 3 | Light-sampling / MIS technique selector |
| `fireflyThreshold` | `number` | 3.0 | Firefly clamping threshold |
| `transmissiveBounces` | `number` | 5 | Max bounces for transmissive materials |
| `maxSubsurfaceSteps` | `number` | 8 | Max random-walk steps for subsurface scattering (raised to 64 by `configureForMode('production')`) |
| `enableAlphaShadows` | `boolean` | false | Alpha-tested shadow rays (enabled by `configureForMode('production')`) |
| `enableDOF` | `boolean` | false | Enable depth of field |
| `focusDistance` | `number` | 0.8 | DOF focus distance |
| `aperture` | `number` | 5.6 | DOF aperture (f-stop) |
| `focalLength` | `number` | 50 | DOF focal length (mm) |
| `transparentBackground` | `boolean` | false | Transparent canvas background |
| `interactionModeEnabled` | `boolean` | true | Lower quality during camera movement for smoother navigation |
| `renderMode` | `number` | 0 | Internal preview(0)/production(1) flag driving accumulation & ASVGF behavior — normally set via `configureForMode()`, not written directly |
| `visMode` | `number` | 0 | Debug visualization mode (0 = off) |
| `environmentMode` | `string` | 'hdri' | Sky mode: `'hdri'` \| `'procedural'` \| `'gradient'` \| `'color'` — not routed through `engine.settings`; use `engine.environmentManager.setMode()` instead |
| `useAdaptiveSampling` | `boolean` | true | Whole-frame early-stop once convergence reaches `adaptiveStopFraction` |
| `noiseThreshold` | `number` | 0.02 | Relative-error threshold below which a pixel is considered converged |
| `darkNoiseFloor` | `number` | 0.003 | Absolute-error floor so dim pixels don't stall convergence |
| `adaptiveMinSamples` | `number` | 8 | Minimum samples before adaptive sampling can trigger |
| `adaptiveStopFraction` | `number` | 0.95 | Fraction of pixels that must converge before the frame retires |
| `usePixelFreeze` | `boolean` | false | Per-pixel freeze (Tier-2): skip individually-converged pixels via active-list compaction |
| `pixelFreezeThreshold` | `number` | 0.02 | Relative-error threshold for a pixel to become a freeze candidate |
| `pixelFreezeStability` | `number` | 8 | Consecutive candidate frames required before a pixel freezes |

See `ENGINE_DEFAULTS` for the full list with default values.

#### Rendering Modes

```js
engine.configureForMode('production')   // High quality (full-frame, 20 bounces, OIDN, controls disabled)
engine.configureForMode('interactive')  // Real-time navigation (3 bounces, controls enabled)
```

To pause rendering for image-viewing UI, set `engine.pauseRendering = true` and disable camera controls directly — the engine doesn't model viewport visibility.

---

### engine.cameraManager

Camera switching, auto-focus, DOF, and direct Three.js access.

```js
engine.cameraManager.active                  // The active PerspectiveCamera
engine.cameraManager.controls                // The OrbitControls instance
engine.cameraManager.switchCamera(index)      // Switch between scene cameras
engine.cameraManager.getNames()              // List available cameras
engine.cameraManager.focusOn(center)         // Focus orbit camera on a world-space point
engine.cameraManager.setAutoFocusMode(mode)  // 'auto' | 'manual'
engine.cameraManager.setAFScreenPoint(x, y)  // Set normalized AF screen point (0-1)
```

### engine.lightManager

Light CRUD, visual helpers, and GPU sync.

```js
engine.lightManager.add('PointLight')       // Add a light (PointLight, SpotLight, DirectionalLight, RectAreaLight)
engine.lightManager.remove(uuid)            // Remove by UUID
engine.lightManager.clear()                 // Remove all lights
engine.lightManager.getAll()                // Get all light descriptors
engine.lightManager.sync()                  // Re-upload light data to GPU
engine.lightManager.showHelpers(true)       // Toggle visual helpers
```

### engine.animationManager

GLTF animation playback controls.

```js
engine.animationManager.play(clipIndex)      // Play an animation clip
engine.animationManager.pause()              // Pause playback
engine.animationManager.resume()             // Resume playback
engine.animationManager.stop()               // Stop and reset
engine.animationManager.setSpeed(2)          // Set playback speed multiplier
engine.animationManager.setLoop(true)        // Enable/disable looping
engine.animationManager.clips                // Get available animation clips
```

### Materials

Material property updates and texture transforms — accessed as direct methods on the engine.

```js
engine.setMaterialProperty(index, property, value)  // Update a material property
engine.setTextureTransform(index, name, transform)   // Update texture transform
engine.reset()                        // Re-upload all material data to GPU
engine.stages.pathTracer.materialData.updateMaterial(index, mat)  // Replace a material
await engine.rebuildMaterials(scene)  // Full rebuild (after texture changes)

// Cap the longest edge of processed material textures (clamped to the hardware max).
// Larger = sharper textures, ~quadratic VRAM. Reprocesses the current scene by default.
await engine.setMaxTextureSize(2048)
await engine.setMaxTextureSize(4096, { reprocess: false })

// Per-mesh visibility — recommended UUID-based API (handles lookup + sync internally)
engine.setMeshVisibilityByUuid(uuid, true)             // explicit set
engine.setMeshVisibilityByUuid(uuid, prev => !prev)    // toggle via updater fn
// Returns the new visibility state, or null if the mesh wasn't found.

// Lower-level — for callers that already have a meshIndex or have mutated object.visible directly
engine.setMeshVisibility(meshIndex, visible)
engine.updateAllMeshVisibility()                  // re-sync after manual object.visible mutations

// Read access to the active scene (returns the mesh-bearing scene)
engine.getScene()
```

### engine.environmentManager

Environment maps, sky modes, and procedural generation.

```js
engine.environmentManager.params             // Current environment parameters
engine.environmentManager.texture            // The loaded environment texture
await engine.loadEnvironment(url)            // Load HDR/EXR environment map (method on engine)
await engine.environmentManager.setEnvironmentMap(tex) // Set a custom environment texture
await engine.environmentManager.setMode(mode)   // 'hdri' | 'procedural' | 'gradient' | 'color'
await engine.environmentManager.generateProcedural() // Preetham-model sky
await engine.environmentManager.generateGradient()   // Gradient sky
await engine.environmentManager.generateSolid()      // Solid color sky
engine.environmentManager.markDirty()        // Flag environment for GPU re-upload
```

### engine.denoisingManager

Denoiser strategy, ASVGF, OIDN, upscaler, and auto-exposure.

```js
// Strategy
engine.denoisingManager.setStrategy('asvgf', 'medium')  // 'none' | 'asvgf' | 'edgeaware'
engine.denoisingManager.setASVGFEnabled(true, 'medium')
engine.denoisingManager.applyASVGFPreset('high')         // 'low' | 'medium' | 'high'
engine.denoisingManager.setAutoExposure(true)

// Fine-grained parameters
engine.denoisingManager.setASVGFParams({ temporalAlpha: 0.1, phiColor: 10 })
engine.denoisingManager.setEdgeAwareParams({ pixelEdgeSharpness: 1.0 })
engine.denoisingManager.setAutoExposureParams({ keyValue: 0.18 })

// OIDN & Upscaler
engine.denoisingManager.setOIDNEnabled(true)
engine.denoisingManager.setOIDNQuality('high')
engine.denoisingManager.setUpscalerEnabled(true)
engine.denoisingManager.setUpscalerScaleFactor(2)
engine.denoisingManager.setUpscalerQuality('high')
```

### engine.interactionManager

Object picking and interaction modes.

```js
engine.interactionManager.select(object)       // Programmatically select an object
engine.interactionManager.deselect()           // Deselect the current object
engine.interactionManager.toggleSelectMode()   // Toggle object selection mode
engine.interactionManager.disableMode()        // Disable selection mode and detach gizmo
engine.interactionManager.toggleFocusMode()    // Toggle click-to-focus DOF
engine.interactionManager.on(type, handler)    // Subscribe (returns unsubscribe function)
```

### engine.transformManager

Transform gizmo controls.

```js
engine.transformManager.setMode('translate') // 'translate' | 'rotate' | 'scale'
engine.transformManager.setSpace('world')    // 'world' | 'local'
engine.transformManager.controls             // Access the underlying TransformControls
```

### Output Methods

Canvas output, screenshots, and scene statistics — accessed as direct methods on the engine.

```js
engine.getCanvas()                    // Get the canvas with the final rendered image
const blob = await engine.screenshot()           // Capture frame as Blob (default 'image/png')
const jpg  = await engine.screenshot({ type: 'image/jpeg', quality: 0.9 })
engine.getStatistics()                // Triangle count, mesh count, etc.
engine.setCanvasSize(1920, 1080)      // Set explicit canvas dimensions
engine.onResize()                     // Trigger manual resize recalculation
engine.isComplete()                   // Check if rendering has converged
engine.getFrameCount()                // Get the current accumulated frame count
engine.getMemoryInfo()                // GPU memory snapshot: { current, peak, byCategory } in bytes
```

`screenshot()` returns a `Blob` for the host to save, upload, or display. To trigger a browser download:

```js
const blob = await engine.screenshot();
const url = URL.createObjectURL(blob);
const a = Object.assign(document.createElement('a'), { href: url, download: 'render.png' });
a.click();
URL.revokeObjectURL(url);
```

---

### Memory Monitoring

Track GPU (VRAM) usage across the whole pipeline. Sizes are measured from live GPU resources (buffer `byteLength` + texture dimensions × format), so they are exact, not estimated.

```js
const { current, peak, byCategory } = engine.getMemoryInfo();   // bytes
// byCategory: { rays, queues, gbuffer, accum, geometry, materials, environment, stages }

engine.vram.resetPeak();   // reset the high-water mark to the current value
engine.vram.getReport();   // formatted one-line summary string
```

`peak` is a high-water mark, reset when a final render begins (`configureForMode('production')`). The engine's VRAM is largely monotonic — the ray pool only grows and the per-stage storage textures are fixed-size — so `peak` equals `current` during a steady render and only exceeds it after memory is released (lower resolution, a smaller scene, or removing the HDRI). The `stages` + `accum` categories (fixed 2048² storage textures) dominate the baseline.

The React app surfaces this as a `Memory: … | Peak: …` readout in the on-canvas stats overlay.

---

### Events

Subscribe to engine lifecycle events via `addEventListener`:

```js
import { EngineEvents } from 'rayzee';

engine.addEventListener(EngineEvents.RENDER_COMPLETE, (e) => {
  console.log('Render complete');
});
```

| Event | Fired when |
|---|---|
| `RENDER_COMPLETE` | Rendering has converged |
| `RENDER_RESET` | Accumulation buffer is reset |
| `FRAME` | Fires once per `animate()` tick — hook external instrumentation (stats panels, telemetry) here |
| `DENOISING_START` / `DENOISING_END` | Denoiser runs |
| `UPSCALING_START` / `UPSCALING_PROGRESS` / `UPSCALING_END` | AI upscaler runs |
| `LOADING_UPDATE` / `LOADING_RESET` | Asset loading progress |
| `STATS_UPDATE` | Performance stats updated |
| `OBJECT_SELECTED` / `OBJECT_DESELECTED` | Object selection changes |
| `OBJECT_DOUBLE_CLICKED` | Object double-clicked |
| `OBJECT_TRANSFORM_START` / `OBJECT_TRANSFORM_END` | Transform gizmo drag |
| `TRANSFORM_MODE_CHANGED` | Gizmo mode changed |
| `SELECT_MODE_CHANGED` | Selection mode toggled |
| `SETTING_CHANGED` | A render setting is modified |
| `AUTO_FOCUS_UPDATED` | Auto-focus recalculated |
| `AUTO_EXPOSURE_UPDATED` | Auto-exposure recalculated |
| `AF_POINT_PLACED` | Focus point placed on screen |
| `ANIMATION_STARTED` / `ANIMATION_PAUSED` / `ANIMATION_STOPPED` / `ANIMATION_FINISHED` | Animation lifecycle |
| `VIDEO_RENDER_PROGRESS` / `VIDEO_RENDER_COMPLETE` | Video export progress |
| `DEVICE_LOST` | The GPU device was lost (driver crash/reset) — rendering halts instead of throwing into a dead device |
| `DISPOSE` | Engine is being disposed (fires before teardown begins, so listeners can release their own references) |

### Advanced: Custom Pipeline Stages

Build custom rendering stages by extending `RenderStage`:

```js
import { RenderStage } from 'rayzee';

class MyCustomStage extends RenderStage {
  constructor() {
    super('my-stage');
  }

  render(context, writeBuffer) {
    const input = context.getTexture('pathtracer:color');
    // ... process input, write output
    context.setTexture('my-stage:output', this.outputTexture);
  }
}
```

### All Exports

```js
// Core
import { PathTracerApp, EngineEvents } from 'rayzee';

// Configuration & presets
import {
  ENGINE_DEFAULTS,
  ASVGF_QUALITY_PRESETS,
  CAMERA_PRESETS,
  CAMERA_RANGES,
  SKY_PRESETS,
  AUTO_FOCUS_MODES,
  AF_DEFAULTS,
  TRIANGLE_DATA_LAYOUT,
  BVH_LEAF_MARKERS,
  TEXTURE_CONSTANTS,
  DEFAULT_TEXTURE_MATRIX,
  MEMORY_CONSTANTS,
  PRODUCTION_RENDER_CONFIG,
  INTERACTIVE_RENDER_CONFIG,
} from 'rayzee';

// Asset URL / cache namespace overrides
import { configureAssets, getAssetConfig } from 'rayzee';

// Advanced: managers & pipeline
import {
  RenderSettings,
  CameraManager,
  LightManager,
  GoboManager,
  IESManager,
  DenoisingManager,
  OverlayManager,
  AnimationManager,
  TransformManager,
  VideoRenderManager,
  InteractionManager,
  RenderPipeline,
  RenderStage,
  StageExecutionMode,
  PipelineContext,
} from 'rayzee';

// VRAM accounting (VRAMTracker is also reachable as engine.vram)
import { VRAMTracker, bufferBytes, textureBytes } from 'rayzee';
```

## Browser Requirements

- WebGPU support (Chrome 113+, Edge 113+, Safari 18+, Firefox 141+)
- Secure context (HTTPS or localhost)

## Optional Dependencies

| Package | Purpose | Install needed? |
|---|---|---|
| `oidn-web` | Intel Open Image Denoise for high-quality final renders | Yes — `npm install oidn-web` |
| `onnxruntime-web` | AI-powered upscaling | No — loaded from CDN at runtime |

> **Note:** `onnxruntime-web` is also listed in `package.json` under `optionalDependencies` for bundler compatibility, but the engine's own runtime path always fetches it from a CDN (see `ortRuntimeUrl` / `ortWasmPaths` in [Configuring Assets](#configuring-assets-cdn-urls--cache-namespace)) rather than importing the installed package — installing it locally has no effect unless you also override those URLs to point at your own copy.

### Enabling OIDN (Intel Open Image Denoise)

OIDN provides high-quality AI denoising for final renders. It runs automatically after the render converges (reaches `maxSamples`).

1. **Install the package**

   ```bash
   npm install oidn-web
   ```

2. **Enable in your app**

   ```js
   // After engine.init() completes
   engine.denoisingManager.setOIDNEnabled(true);
   engine.denoisingManager.setOIDNQuality('balance'); // 'fast' | 'balance' | 'high'
   ```

3. **Listen for progress** (optional)

   ```js
   engine.addEventListener(EngineEvents.DENOISING_START, () => {
     console.log('Denoising started');
   });
   engine.addEventListener(EngineEvents.DENOISING_END, () => {
     console.log('Denoising complete');
   });
   ```

| Quality | Model size | Speed | Best for |
|---|---|---|---|
| `'fast'` | ~20 MB | Fastest | Quick previews |
| `'balance'` | ~50 MB | Moderate | General use (default) |
| `'high'` | ~100 MB | Slowest | Final quality renders |

> **Note:** The neural network model is downloaded on first use. Subsequent runs use the browser cache. OIDN also works with `configureForMode('production')`, which enables it automatically alongside high-quality render settings.

### Enabling the AI Upscaler

The upscaler runs ONNX super-resolution models via `onnxruntime-web`. Unlike OIDN, `onnxruntime-web` is lazily fetched from a CDN inside a Web Worker — **no npm install or import map entry is needed**.

```js
engine.denoisingManager.setUpscalerEnabled(true);
engine.denoisingManager.setUpscalerQuality('fast');      // 'fast' | 'balanced' | 'quality'
engine.denoisingManager.setUpscalerScaleFactor(2);       // 2 | 4

engine.addEventListener(EngineEvents.UPSCALING_START,    () => console.log('Upscaling started'));
engine.addEventListener(EngineEvents.UPSCALING_PROGRESS, (e) => console.log('Upscaling', e));
engine.addEventListener(EngineEvents.UPSCALING_END,      () => console.log('Upscaling complete'));
```

| Quality | Model | 2× size | 4× size |
|---|---|---|---|
| `'fast'` | SPAN | 1.6 MB | 1.6 MB |
| `'balanced'` | SRVGGNetCompact | 2.4 MB | 4.9 MB |
| `'quality'` | RRDBNet / MoSR | 67 MB | 16.5 MB |

**Chaining with OIDN:** Upscaling and OIDN **can** run together — on render completion, OIDN runs first, then its denoised output is fed into the upscaler. Enable both; no manual coordination required.

## Troubleshooting

**OIDN: `Cannot find module './tza'` (webpack)**
The `oidn-web` package uses dynamic imports that webpack cannot resolve. This does not affect Vite or other ESM-native bundlers. Add `oidn-web` to your webpack externals:

```js
// webpack.config.js
module.exports = {
  externals: {
    'oidn-web': 'oidn-web'
  }
};
```

Then load it via a script tag or import map instead:

```html
<script type="importmap">
{
  "imports": {
    "oidn-web": "https://cdn.jsdelivr.net/npm/oidn-web@0.3.5/dist/oidn.js"
  }
}
</script>
```

**OIDN: `TypeError: t.alea is not a function` or `Argument 'x' passed to 'conv2d' must be a Tensor ... got 'L'`**
You're loading `oidn-web` via `jsdelivr.net/npm/oidn-web/+esm` or `esm.sh/oidn-web`. Don't — use the **self-bundled** `/dist/oidn.js` path instead:

```diff
- "oidn-web": "https://cdn.jsdelivr.net/npm/oidn-web@0.3.5/+esm"
+ "oidn-web": "https://cdn.jsdelivr.net/npm/oidn-web@0.3.5/dist/oidn.js"
```

Why: `oidn-web` transitively depends on `@tensorflow/tfjs-core`, which does `import * as t from "seedrandom"` and calls `t.alea(...)`. jsDelivr's `/+esm` CJS→ESM shim of `seedrandom` emits only `export default` (no named exports), so `t.alea` is undefined. Swapping to `esm.sh` trades that for a different issue: deep-path imports produce multiple tfjs-core instances, so a Tensor made in one module fails `instanceof` checks in another (`got 'L'`). The `/dist/oidn.js` file in the npm package is a single pre-bundled ESM with all of tfjs inlined — no external imports, one tfjs instance, same exports. Use it.

**Black screen / "WebGPU not supported"**
Your browser may not support WebGPU. Use Chrome 113+, Edge 113+, Safari 18+, or Firefox 141+. Ensure you're on HTTPS or localhost.

**Models not loading**
If serving locally, place files in your `public/` folder and reference them with absolute paths (e.g., `/scene.glb`). For remote files, ensure the server allows CORS.

**Workers blocked by Content-Security-Policy**
Rayzee's Web Workers are embedded in the bundle and spawned from a `blob:` URL, so a strict `worker-src` policy will block them — the symptom is BVH building, texture processing, or HDRI CDF generation silently failing. Allow `blob:`:

```
Content-Security-Policy: worker-src 'self' blob:
```

Only needed if you set an explicit `worker-src` (or fall back to a restrictive `default-src`). Pages without a CSP are unaffected.

## License

MIT

[npm]: https://img.shields.io/npm/v/rayzee
[npm-url]: https://www.npmjs.com/package/rayzee
[build-size]: https://badgen.net/bundlephobia/minzip/rayzee
[build-size-url]: https://bundlephobia.com/result?p=rayzee
[npm-downloads]: https://img.shields.io/npm/dw/rayzee
[npmtrends-url]: https://www.npmtrends.com/rayzee
[jsdelivr-downloads]: https://img.shields.io/jsdelivr/npm/hm/rayzee
[jsdelivr-url]: https://www.jsdelivr.com/package/npm/rayzee
