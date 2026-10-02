# Rayzee Engine

[![NPM Package][npm]][npm-url]
[![Build Size][build-size]][build-size-url]
[![NPM Downloads][npm-downloads]][npmtrends-url]
[![jsDelivr Downloads][jsdelivr-downloads]][jsdelivr-url]

A real-time WebGPU path tracing engine built on Three.js. Framework-agnostic — use it with React, Vue, vanilla JS, or any other setup.

🌐 **[Live Demo](https://atul-mourya.github.io/rayzee-renderer/)** — the same demo app linked from the root monorepo README, built on this engine.

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
  - [Camera Projection (Orthographic, 360° Panorama)](#camera-projection-orthographic-360-panorama)
  - [engine.lightManager](#enginelightmanager)
  - [engine.animationManager](#engineanimationmanager)
  - [engine.timeline](#enginetimeline)
  - [Materials](#materials)
  - [Colour Management](#colour-management)
  - [engine.environmentManager](#engineenvironmentmanager)
  - [engine.denoisingManager](#enginedenoisingmanager)
  - [engine.interactionManager](#engineinteractionmanager)
  - [engine.transformManager](#enginetransformmanager)
  - [Moving and Deforming Objects](#moving-and-deforming-objects)
  - [Degradation contract](#degradation-contract)
  - [Output Methods](#output-methods)
  - [Render Resolution Reserve](#render-resolution-reserve)
  - [Memory Monitoring](#memory-monitoring)
  - [Logging](#logging)
  - [Deterministic & Headless Rendering](#deterministic--headless-rendering)
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
      "oidn-web": "https://cdn.jsdelivr.net/npm/oidn-web@0.4.0/dist/oidn.js",
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
    await engine.loadObject3D(yourScene);                 // rayzee renders its own copy — yourScene is left untouched
    engine.animate();
  }
  ptCanvas.style.display = on ? 'block' : 'none';
  hostCanvas.style.display = on ? 'none' : 'block';
  on ? engine?.resume() : engine?.pause();                // pause the inactive renderer to avoid GPU contention
}
```

Key constraints:

- **`loadObject3D` copies the passed `Object3D`.** The engine never reparents, rewrites or disposes your tree, so handing it a subtree of a scene your host still renders is safe — no clone needed on your side. The copy shares geometry, material and texture data by reference, so it costs scene-graph nodes, not GPU memory, and any ancestor transform is baked in so the model renders where your host sees it. The flip side: later edits to the object you passed do not reach the render. Mutate `engine.sceneModel` (the copy) and call `refitBVH()`/`refitBLASes()` instead.
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

By default, the engine loads GLTF Draco/KTX2 decoders, OIDN denoiser weights, ONNX upscaler models, and the onnxruntime-web bundle from upstream CDNs. If you're self-hosting, embedding the engine alongside a different consumer of the same caches, or operating offline, override them **once before constructing `PathTracerApp`**:

```js
import { configureAssets } from 'rayzee';

configureAssets({
  // onnxruntime-web (loaded by AI upscaler worker via dynamic import)
  ortRuntimeUrl: '/ort/ort.webgpu.bundle.min.mjs',
  ortWasmPaths:  '/ort/',

  // GLTFLoader extension decoders
  dracoDecoderPath:   '/draco/',
  ktx2TranscoderPath: '/basis/',

  // Denoiser & upscaler weights
  oidnWeightsBaseUrl:    '/oidn-tzas/',
  upscalerModelBaseUrl:  '/upscaler-onnx/',

  // OpenColorIO runtime (~6 MB of WebAssembly) — the engine never names the package, so a host
  // that loads colour configs supplies it, bundled or served. Unset, colour management stays inert.
  ocioRuntimeFactory: () => import('@bb-studio/ocio'),   // or: ocioRuntimeUrl: '/vendor/ocio/index.js'
  ocioWasmUrl: '/vendor/ocio/ocio-wasm.wasm',            // optional override for the .wasm

  // Names the engine's on-disk storage (an OPFS directory). Set a unique value if several
  // apps embed the engine on the same origin, so their caches stay apart.
  cacheNamespace: 'my-app',

  // On-disk storage: 'auto' (default) where the browser has it, false for none.
  storage: 'auto',
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
| `canvas` may be `null` | | Headless: the engine makes its own canvas and runs no render loop — see [Running in Node](#running-in-node) |
| `options.headless` | `boolean` | Headless with a canvas of your own (default: `true` when `canvas` is `null`) |
| `options.autoResize` | `boolean` | Auto-resize on window resize (default: `true`; always off headless) |
| `options.container` | `HTMLElement` | Single DOM parent the engine mounts auxiliary elements into — HUD overlay (tile borders, helpers) and denoiser canvas. Defaults to `canvas.parentNode`. |
| `options.strict` | `boolean` | Throw an `EngineIssueError` where the engine would otherwise degrade and carry on (default: `false`). See [Degradation contract](#degradation-contract). |
| `options.profile` | `string` | `'viewer'` (default) or `'physical'` — product tuning that is not a physical constant: area-light scale, environment rotation, tone mapping, saturation. An unknown name throws. |
| `options.maxSceneBytes` | `number` | Raise or lower the CPU memory ceiling a scene may need before the engine refuses it (default 9,216 MB). See [Memory monitoring](#memory-monitoring). |
| `options.hostMemoryGB` | `number` | The host's memory, for runtimes without Chrome's `navigator.deviceMemory` (which then read as 4 GB and cap the render reserve at 2048). Sizes the reserve and the path pool. |
| `options.storage` | `false \| 'auto' \| StorageManager` | On-disk storage (default: `configureAssets( { storage } )`; off under `strict` unless you set it there or here). A manager you pass stays yours to dispose. See [On-disk storage](#on-disk-storage-opfs). |
| `options.memorySpill` | `boolean` | Experimental, default `false`: build a large static scene through disk — triangle records, BLAS nodes and the three.js geometry are written out as the build finishes with them — and raise the pbrt triangle and placement caps to 60M / 8M. See [On-disk storage](#on-disk-storage-opfs). |

The engine creates and mounts everything it needs (denoiser canvas, tile/HUD overlay) into a single parent on `init()`. Performance HUDs (e.g. `stats-gl`) are not bundled — listen to `EngineEvents.FRAME` and tick your own panel.

#### Lifecycle

```js
await engine.init()           // Initialize WebGPU renderer and pipeline
engine.animate()              // Start the render loop
engine.pause()                // Pause rendering
engine.resume()               // Resume rendering
engine.reset()                // Reset accumulation (restart from sample 0)
engine.reset(false, { motion: true })  // Same, when only placements or geometry moved: keeps OIDN's motion history
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
const id = await engine.addModelFromObject3D(object3d, { name })  // Append a copy of a caller-owned Object3D (yours is untouched)
engine.getSceneObject(id)                                         // Resolve an id to the rendered root (the copy)
await engine.removeSceneObject(id)                                // Remove by id — returns false if not found
engine.setSceneObjectVisibility(id, visible)                      // Toggle visibility with an O(1) BVH-leaf patch, no rebuild
```

`engine.sceneModel` is the root of what is actually being rendered — for `loadObject3D` that is the engine's copy, and it is the object to mutate before `refitBVH()`.

`id` is the appended root's `Object3D.uuid`, returned by `addModel`/`addModelFromObject3D`. For `addModelFromObject3D` the engine carries your object's uuid onto its copy, so the id matches the object you passed. The built-in ground plane is permanent and can't be removed.

##### Loading part of a scene archive

A pbrt-v4 scene archive (`.tar`, `.tar.gz`, `.zip`) is usually a root `.pbrt` file that includes one
subtree per element, and the whole thing rarely fits in a browser tab — Moana is 29 GB unpacked.
The archive can be inspected without retaining any of it, then loaded one element at a time:

```js
const { kind, root, elements, entryCount, totalBytes } = await engine.inspectArchive(file);

await engine.loadFile(file, { element: elements[0].path });   // one element
await engine.loadFile(file, { element: [ a.path, b.path ] }); // several together
```

Everything above a chosen element comes along — the root scene file, the material library, an
ancestor's `textures` folder — and an `Include` pointing at an element you left out only warns,
which is what makes a partial load work. Selecting every element is a valid answer and loads the
whole scene.

Past 4 GB unpacked, a multi-element archive **throws** `ARCHIVE_NEEDS_ELEMENT` rather than taking
all of it. The error carries the element list, so a host can turn it into a picker:

```js
try {
  await engine.loadFile(file);
} catch (err) {
  if (err.code === 'ARCHIVE_NEEDS_ELEMENT') showPicker(err.elements, err.root, err.totalBytes);
  else throw err;
}
```

Per-load options for pbrt archives:

| Option | Default | Effect |
|---|---|---|
| `promptBytes` | 4 GB | moves the line past which a multi-element archive asks for elements |
| `maxTriangles` | 45M (60M with `memorySpill`) | past it, placements are skipped and the build reports itself truncated |
| `maxPlacements` | 6M (8M with `memorySpill`) | the same, for placements |
| `curveTolerance` | 0.05 | how far a curve segment may stray, × the curve's half-width; curves become strips with adaptive segments. `0` gives the old uniform strips bit for bit |
| `instanceIncludes` | `true` | a file included again under the same material, with no side effects, is placed as an instance of its first reading instead of being read and stored again |

45M is the highest rung measured to survive without the spill; raising either cap is a deliberate
act on a fresh browser tab. With `memorySpill`, 80M stored triangles (4.35M placements) have loaded
and rendered; an 89M load ran out of memory while parsing, and WebGPU's 4 GB buffer limit stops the
triangle data at 89.5M in any case.

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
| `saturation` | `number` | 1.0 | Color saturation (1 = no grade) |
| `enableEnvironment` | `boolean` | true | Use environment lighting |
| `environmentIntensity` | `number` | 1.0 | Environment light strength |
| `environmentRotation` | `number` | 0 | Environment Y-rotation (degrees); 0 shows the HDRI as authored, as Blender's unmapped world does |
| `showBackground` | `boolean` | true | Show the environment as a visible backdrop for camera-miss rays (vs. a solid/transparent background) |
| `samplingTechnique` | `number` | 2 | Sampler: `0` PCG, `1` scrambled Halton, `2` Owen-scrambled Sobol |
| `integrator` | `string` | 'path' | `'path'` \| `'bidirectional'`. Bidirectional also traces light subpaths from every light — emissive surfaces, rect/disk, point, spot and directional lights, the sun and the environment — far faster for caustics and light through small openings, about 2× the cost per sample. On a lamp-lit interior with an HDRI it is ~20 % less noisy at equal time; a room lit only through a window stays better path traced. Switching rebuilds the kernels |
| `fireflyThreshold` | `number` | 3.0 | Firefly clamping threshold |
| `shadowTerminatorOffset` | `number` | 0.1 | Cycles' Shadow Terminator → Geometry Offset: near the light's terminator on a smooth-shaded low-poly mesh, light and environment shadow rays start on the smooth surface the vertex normals describe, not the flat facet. Blender's default; `0` disables |
| `transmissiveBounces` | `number` | 5 | Max bounces for transmissive materials |
| `maxSubsurfaceSteps` | `number` | 8 | Max random-walk steps for subsurface scattering (raised to 64 by `configureForMode('production')`) |
| `enableAlphaShadows` | `boolean` | false | Alpha-tested shadow rays (enabled by `configureForMode('production')`) |
| `enableDOF` | `boolean` | false | Enable depth of field |
| `dofMode` | `string` | 'look' | `'look'`: the blur is set by `dofBlur`, the same at any scene scale; `'physical'`: a real lens set by `aperture`, `focalLength` and `unitsPerMetre`. The `physical` render profile defaults to `'physical'` |
| `dofBlur` | `number` | 0.05 | Look mode: how far a distant background blurs, as a fraction of the image height |
| `focusDistance` | `number` | 0.8 | DOF focus distance in scene units — depth along the view axis (the focal plane is flat) |
| `aperture` | `number` | 5.6 | Physical mode: f-stop |
| `focalLength` | `number` | 50 | Physical mode: focal length (mm) |
| `unitsPerMetre` | `number` | 1 | Physical mode: scene units per real metre, for files whose units are not metres. It carries over between model loads — reset it when the new file's units differ |
| `transparentBackground` | `boolean` | false | Transparent canvas background |
| `interactionModeEnabled` | `boolean` | true | Render at lower resolution while the camera moves, keeping the full bounce budget ("Fast Navigation" in the app) |
| `interactionRenderScale` | `number` | 0.5 | Per-axis render scale while the camera moves (0.5 = a quarter of the pixels); `1` turns the drop off. Ignored while OIDN is the live denoiser |
| `renderMode` | `number` | 0 | Internal preview(0)/production(1) flag driving accumulation & ASVGF behavior — normally set via `configureForMode()`, not written directly |
| `visMode` | `number` | 0 | Debug visualization mode (0 = off) |
| `environmentMode` | `string` | 'hdri' | Sky mode: `'hdri'` \| `'procedural'` \| `'color'` — not routed through `engine.settings`; use `engine.environmentManager.setMode()` instead |
| `cameraProjection` | `string` | 'perspective' | `'perspective'` \| `'orthographic'` \| `'equirectangular'` — see [Camera Projection](#camera-projection-orthographic-360-panorama) |
| `panoramaLonRange` | `[number, number]` | `[-180, 180]` | Panorama longitude sweep, degrees, left→right |
| `panoramaLatRange` | `[number, number]` | `[-90, 90]` | Panorama latitude sweep, degrees, bottom→top |
| `panoramaLevelHorizon` | `boolean` | true | Yaw-only panorama basis, so orbit pitch/roll can't tilt the horizon |
| `useAdaptiveSampling` | `boolean` | true | Whole-frame early-stop once convergence reaches `adaptiveStopFraction` |
| `noiseThreshold` | `number` | 0.02 | √-luminance-normalized per-pixel noise below which a pixel counts as converged |
| `adaptiveMinSamples` | `number` | 8 | Minimum samples before adaptive sampling can trigger |
| `adaptiveStopFraction` | `number` | 0.95 | Fraction of pixels that must converge before the frame retires |
| `usePixelFreeze` | `boolean` | true | Per-pixel freeze (Tier-2): skip individually-converged pixels via active-list compaction |
| `pixelFreezeThreshold` | `number` | 0.02 | Relative-error threshold for a pixel to become a freeze candidate |
| `pixelFreezeStability` | `number` | 8 | Consecutive candidate frames required before a pixel freezes |

See `ENGINE_DEFAULTS` for the full list with default values. The default look is AgX (`toneMapping: 6`) at neutral saturation; tone mapping is chosen through [Colour Management](#colour-management) (`engine.color.setActiveView( id )`), not `settings`.

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
engine.cameraManager.active                  // The active camera: a PerspectiveCamera that can turn orthographic
engine.cameraManager.controls                // The OrbitControls instance
engine.cameraManager.switchCamera(index)      // Switch between scene cameras
engine.cameraManager.getNames()              // List available cameras
engine.cameraManager.focusOn(center)         // Focus orbit camera on a world-space point
engine.cameraManager.setAutoFocusMode(mode)  // 'auto' | 'manual'
engine.cameraManager.setAFScreenPoint(x, y)  // Set normalized AF screen point (0-1)
engine.cameraManager.setNavigationMode(mode) // 'orbit' | 'walk'
engine.cameraManager.walkControls.speed      // Walk speed, scene units per second
engine.cameraManager.orthoHeight             // Orthographic view height, scene units, wheel zoom included
engine.cameraManager.setOrthoHeight(height)  // Set it
```

**Walk mode** is first-person navigation: drag to look, W A S D or the arrow keys to walk level, E and Q to
rise and sink, Shift faster, Alt slower. A new model resets `speed` so the walk crosses it in about eight
seconds. Keys are ignored while focus is in a text field, list or menu, and when a focused control has
already used the key. The mode obeys `controls.enabled`, so anything that locks the orbit camera locks walking
too. Switching back to `'orbit'` circles the surface at the centre of the view.

### Camera Projection (Orthographic, 360° Panorama)

Three camera models live behind the `cameraProjection` setting. All are compiled into the same kernel, so switching writes a uniform and resets accumulation — it never recompiles WGSL.

#### Orthographic

```js
engine.settings.set('cameraProjection', 'orthographic');
engine.cameraManager.setOrthoHeight(12);   // the view's height in scene units
engine.addEventListener(EngineEvents.ORTHO_HEIGHT_UPDATED, ({ height }) => {}); // the wheel changed it
```

Rays are parallel and start on the camera's image plane, so nothing behind the camera is seen and nothing shrinks with distance. Switching keeps what the view shows at the orbit target: turning orthographic sizes the view from the orbit distance and field of view, and turning back moves the camera to match. The wheel then zooms by changing the view's size rather than moving the camera. A new model is framed the same way.

`engine.cameraManager.active` stays the same object — it switches its own projection and reports `isOrthographicCamera` — so picking, the transform gizmo and the overlays follow without anything being re-pointed. Imported orthographic cameras (glTF, and pbrt's `Camera "orthographic"`) switch the projection to orthographic at their own size, and a camera left orthographic comes back so; any other camera switches it back to perspective. Every denoiser, auto-focus and depth of field keep working. An environment at infinity is seen from a single direction, so the background is one colour.

#### 360° Panorama

```js
engine.settings.set('cameraProjection', 'equirectangular');

// Optional: crop the sweep. Degrees, [min, max].
engine.settings.set('panoramaLonRange', [-90, 90]);   // VR180
engine.settings.set('panoramaLatRange', [0, 90]);     // upper hemisphere only
engine.settings.set('panoramaLevelHorizon', true);    // default — orbit pitch won't tilt the panorama
```

The mapping puts camera-forward at the image centre, the zenith at the top row, and yaw-right at increasing u. Full-sphere output is 2:1 — **size the canvas accordingly** (`engine.setCanvasSize(w, w / 2)`); the engine renders whatever aspect you give it and will stretch the sphere otherwise. A cropped range changes the natural aspect to match `lonRange / latRange`.

Depth of field still works: the lens plane is built from each ray's own frame, not the camera's, so bokeh stays round across the whole sweep.

Two features are incompatible with a non-frustum camera and the engine switches them off for you when panorama is enabled:

- **ASVGF** falls back to the `edgeaware` denoiser — ASVGF's motion vectors unproject through the projection matrix, which is meaningless when every pixel is its own direction.
- **Auto-focus** pauses and focus holds its last distance — it raycasts via `Raycaster.setFromCamera`, which only understands a frustum. It resumes when you leave the panorama.

Read the denoiser outcome back rather than duplicating the rule (`engine.denoisingManager.denoiserStrategy`); it is not restored automatically when you leave the panorama.

### engine.lightManager

Light CRUD, visual helpers, and GPU sync.

```js
engine.lightManager.add('PointLight')       // Add a light (PointLight, SpotLight, DirectionalLight, RectAreaLight)
engine.lightManager.remove(uuid)            // Remove by UUID
engine.lightManager.clear()                 // Remove all lights
engine.lightManager.getAll()                // Get all light descriptors
engine.lightManager.setIntensity(uuid, 40)  // Set one light's power and re-upload
engine.lightManager.getLight(uuid)          // The traced three.js light, to edit other properties
engine.lightManager.sync()                  // Re-upload light data to GPU after editing a light
engine.lightManager.showHelpers(true)       // Toggle visual helpers
```

The path tracer traces **copies** of a model's lights, made when the model loads. Changing a light
inside the loaded model does nothing; change the copy — `getLight(uuid)` with a UUID from `getAll()` —
and call `sync()`, or use `setIntensity()`.

Light `intensity` follows Blender: radiant power in watts for point, spot and area lights, irradiance in W/m² for directional. Dividing power by area only means something in metres, so the engine assumes **one world unit is one metre**; scenes authored in cm or mm must carry that scale in their node transforms, as glTF exporters do. glTF `RectAreaLightPlaceholder` nodes author `intensity` as three.js radiance (their `power` field is `intensity · width · height · π`); the importer converts it to power through the light's world area so the authored radiance is reproduced exactly, then applies the profile's `areaLightIntensityScale`.

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

### engine.timeline

Authored animation: keyframed tracks on one time axis, in seconds. The camera's is the first track; the timeline is where lights and objects will join it. A model's own clips stay with `engine.animationManager`, and saved cameras (`engine.addCamera()`) stay cameras — a keyframe is not a camera.

```js
const camera = engine.timeline.camera          // the camera's track
const key = camera.addKey()                    // key the current view, 2 s after the last key
camera.addKey(5)                               // …or at a time
camera.updateKey(key.id)                       // give a key the current view
camera.setTime(key.id, 3.5)                    // retime it; keys stay in time order
camera.remove(key.id)
camera.keys                                    // [{ id, time, position, target, fov, orthoHeight }]

engine.timeline.duration                       // seconds to the last key of any track
engine.timeline.animates                       // a track has two keys or more
engine.timeline.seek(2.5)                      // put the scene where the timeline has it at 2.5 s
await engine.timeline.play()                   // run it in the viewport, controls locked
engine.timeline.stop()                         // or stop early

// Keys changed ({ track: 'camera' }) or playback started or stopped ({ track: undefined })
engine.addEventListener(EngineEvents.TIMELINE_CHANGED, ({ track }) => {})

// A video of the move through a still scene; pass clipIndex too to move the camera during a clip
await new VideoRenderManager(engine).renderAnimation({ timeline: engine.timeline, fps: 30, onFrame });
```

Between keys the camera glides along a smooth curve through their positions while looking along another through their targets, so a subject every key looks at stays in frame. It leaves the first key and reaches the last at rest, runs straight through the keys between, and holds still outside them. FOV, or an orthographic view's height, blends too, in the projection in use. The curves are three.js keyframe tracks (`InterpolateSmooth`). With auto-focus on, focus is measured again on every video frame, and the view is put back when the render ends. A new model clears the keys, as it clears saved cameras.

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

// Where a packed value came from: 'material' | 'mapped' | 'default' | 'host'
engine.getMaterialPropertySource(index, 'ior')
```

A property a three.js material lacks falls back to `MATERIAL_DEFAULTS` (exported) — MeshPhysicalMaterial's own values, so a glTF metallic material gets IOR 1.5, not a guess derived from its metalness. Weights and roughnesses (metalness, roughness, transmission, opacity, clearcoat, sheen, iridescence, …) are clamped to [0, 1] on upload and on `setMaterialProperty`.

### Colour Management

`engine.color` is an OpenColorIO pipeline: what textures and lights mean, what the render happens in, and what it is shown and saved as. **It is inert until a config is loaded** — the render stays linear Rec.709 and the view transforms are three.js's own seven, so a host that never loads one sees no change. The host supplies the runtime (`ocioRuntimeFactory` or `ocioRuntimeUrl` in [`configureAssets`](#configuring-assets-cdn-urls--cache-namespace)).

```js
configureAssets({ ocioRuntimeFactory: () => import('@bb-studio/ocio') });

await engine.loadColorConfig({ builtin: 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5' }); // a runtime built-in
await engine.loadColorConfig({ files, configPath: 'config.ocio', id: 'studio' });  // or a folder: [{ relativePath, data }]

engine.color.setView({ display: 'sRGB - Display', view: 'ACES 2.0 - SDR 100 nits (Rec.709)', look: null });
engine.color.setLook(look);                  // a look from status().config.looks, on the active view
engine.color.setActiveView(id);              // any registered view, OCIO or built-in (three.js constant)
engine.color.setContext({ SHOT: '010' });    // $SHOT in the config resolves to this
engine.color.status();                       // config, working space, active view, registered views

engine.color.setWorkingSpace('ACEScg');      // render in the config's space…
await engine.applyColorWorkingSpace();       // …which rebuilds textures, materials and the environment

await engine.setTextureColorSpace(texture, 'srgb');   // null (auto), 'srgb', 'linear' or a config space
const { data } = await engine.renderToBuffer({ colorSpace: 'ACES2065-1', source: 'display' }); // float delivery buffer
await engine.unloadColorConfig();
```

- **Load and unload through `engine.loadColorConfig()` / `unloadColorConfig()`** once a scene exists: they undo an adopted working space while the config that converted the environment is still loaded.
- A view is baked to a log2 shaper and a 65³ table, interpolated tetrahedrally; the same table drives the canvas, the GPU and CPU readbacks and the menu (`listViewTransforms()`, `onRegistryChange()`). An OCIO view returns display-encoded colour, so the engine switches the output pass to linear while one is active.
- **Baked views.** `await engine.color.saveBakedView(id)` writes a view's table to a file (157 KB gzip for 65³), and `await engine.color.loadBakedView(bytes, { expect })` registers it with no runtime and no config — show the look on the first frame, load the config later. When that config loads, a baked view whose files match the fingerprint it was baked from is kept as is: no rebake, no new id, no restart.
- `renderToBuffer({ colorSpace })` takes `'srgb'` (display bytes through the active view), `'linear'` (the working-space accumulation) or a config colour space; `source: 'display'` reads what the viewport shows, denoised, instead of the raw accumulation.
- Degradations (a view that cannot bake, a display the canvas cannot show) are recorded as warnings in the [degradation contract](#degradation-contract).

### engine.environmentManager

Environment maps, sky modes, and procedural generation.

```js
engine.environmentManager.params             // Current environment parameters
engine.environmentManager.texture            // The loaded environment texture
await engine.loadEnvironment(url)            // Load HDR/EXR environment map (method on engine)
await engine.environmentManager.setEnvironmentMap(tex) // Set a custom environment texture
await engine.environmentManager.setMode(mode)   // 'hdri' | 'procedural' | 'color'
await engine.environmentManager.generateProcedural() // Physical sky: spectral, multiple scattering, analytic sun
await engine.environmentManager.generateSolid()      // Solid color sky
engine.environmentManager.markDirty()        // Flag environment for GPU re-upload
```

The physical sky (mode `'procedural'`) is set through `params`, then baked. It is baked and
importance-sampled entirely on the GPU (~1.6 ms per sun move), so bake on every slider event rather
than debouncing: requests made in one task become one bake, and the promise resolves once the
environment has caught up. The sun is drawn and sampled as a light of its own, not from the texture.

```js
import { sunPosition, dayOfYearForMonth } from 'rayzee';

const p = engine.environmentManager.params;
const { azimuth, elevation } = sunPosition( { hours: 17.5, dayOfYear: dayOfYearForMonth( 6 ), latitude: 40 } );
const az = ( 180 - azimuth ) * Math.PI / 180, el = elevation * Math.PI / 180;   // north along −Z, east along +X
p.skySunDirection.set( Math.cos( el ) * Math.sin( az ), Math.sin( el ), Math.cos( el ) * Math.cos( az ) );
p.skyTurbidity = 3;          // haze, 1–10; also skyOzone (Dobson units), skyAirDensity (× Earth's),
                             // skyGroundAlbedo (Color), skyAltitude (m), skySunSize (°), skySunStrength
await engine.environmentManager.generateProcedural();
```

### engine.denoisingManager

Denoiser strategy, ASVGF, OIDN, upscaler, and auto-exposure.

```js
// Strategy
engine.denoisingManager.setStrategy('asvgf', 'medium')  // 'none' | 'asvgf' | 'edgeaware'
engine.denoisingManager.denoiserStrategy                 // read back the active strategy (derived from stage state)
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
engine.denoisingManager.setStrategy('oidn')              // OIDN owns the live view; see below
engine.denoisingManager.setTemporalHistory(false)        // live OIDN without the motion history (default on)
engine.denoisingManager.continuousDenoiseInterval = 250   // cap refreshes at 4/sec (default 8 = uncapped)
engine.denoisingManager.setUpscalerEnabled(true)
engine.denoisingManager.setUpscalerScaleFactor(2)         // 2 or 4
engine.denoisingManager.setUpscalerQuality('high')        // ESRGAN only
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

### Moving and Deforming Objects

Three calls update a loaded scene without rebuilding it. They differ in how much work they do, and
picking the wrong one is the usual source of trouble.

```js
engine.updateMeshTransforms(meshIndices)            // an object moved, rotated or scaled
engine.refitBLASes(meshIndices, positions)          // specific objects' vertices changed
await engine.refitBVH(positions)                    // the whole scene is posed anew, e.g. animation
```

**`updateMeshTransforms` is the one a gizmo drag wants.** Triangles are stored in each object's own
space, so a rigid move only rewrites a matrix — no vertex pass, no geometry upload. Using
`refitBLASes` for a move instead rewrites vertices needlessly, and drags along any other object
sharing the same geometry.

All three take **indices into `engine.sceneMeshes`**, which is a depth-first walk of the rendered
scene and includes the engine's own hidden ground disk. Build your index list from that array, never
from your own model root, or the two orders silently disagree.

Positions are **world space**, 9 floats per triangle (`ax,ay,az, bx,by,bz, cx,cy,cz`), triangles in
index order. Two shapes are accepted:

```js
// Preferred: a per-mesh callback, asked for one mesh at a time. You may hand back the same
// scratch buffer on every call.
await engine.refitBVH((meshIndex, triCount) => myPositionsFor(meshIndex));

// Also works: one array for every triangle in the scene, meshes in sceneMeshes order.
// 1,030 MB at 30M triangles, and will not allocate at that size — prefer the callback.
await engine.refitBVH(sceneWideFloat32Array);
```

Both shapes are length-checked and throw on a mismatch. Before that check existed, a short buffer
wrote NaN through every bounding box with no error and the scene simply vanished.

An object that shares its geometry with another cannot be deformed — writing its vertices would
move every copy. `refitBLASes` skips such a mesh and records a `refit.shared_geometry` issue.
Anything skinned or morphed is given triangles of its own at load, so this only fires when the
wrong mesh was handed over.

---

### Degradation contract

The engine degrades rather than fails, which is right for a viewer and backwards for a batch
renderer, so one option decides which you get:

```js
const engine = new PathTracerApp(canvas, { strict: true });  // throw at the point of degradation
```

Lenient hosts read the log instead:

```js
engine.issues        // every recorded issue, newest last
engine.issueErrors   // just the ones a strict host would have thrown on
engine.addEventListener(EngineEvents.ISSUE, ({ issue }) => report(issue));
```

Each issue carries `{ code, message, detail, severity, at }`. `ISSUE_CODES` is **add-only API
surface** — pin a version and branch on the strings; they are never renamed or repurposed.

| Code | Raised when |
|---|---|
| `adapter.software` | the GPU is a software rasteriser (SwiftShader, llvmpipe, lavapipe, WARP) |
| `asset.unreachable` / `asset.ambiguous_entry` | the asset could not be fetched, or an archive held several candidate models |
| `asset.archive_too_large` / `asset.entry_too_large` | an archive or one of its entries exceeded the byte budget |
| `texture.build_failed` / `texture.processing_fallback` / `texture.limit_exceeded` | a texture could not be built, fell back to a slower path, or exceeded the per-map-type cap |
| `environment.load_failed` | the environment map failed to load |
| `setting.unknown_key` | a setting name reached no stage — how a typo becomes a wrong image |
| `render.size_declined` / `render.reserve_capped` | the requested render size or reserve exceeded device limits |
| `stage.render_failed` | a pipeline stage threw (recorded once per stage and phase) |
| `scene.memory_budget` | the scene needs more CPU memory than is safe, or more than is possible |
| `emissive.instances_collapsed` | an emissive instanced mesh was too large to expand, so its copies light the scene as one |
| `refit.shared_geometry` | a deform was asked for on a mesh that shares its triangles, and was skipped |
| `denoiser.unavailable` | a requested denoise or upscale produced nothing — the denoiser was not built, OIDN was off while accumulating, or the pass needs a canvas in a document |
| `output.source_fallback` | `renderToBuffer( { source: 'display' } )` found no denoised picture and returned the raw accumulation |
| `output.tonemap_fallback` | `renderToBuffer`'s `'srgb'` bytes were tone-mapped on the CPU, not the GPU — the picture is the same within a level, only slower (a warning: strict does not throw) |
| `light.placeholder_skipped` | a `RectAreaLightPlaceholder` node lacked `userData.name` or `userData.type: 'RectAreaLight'`, so no light was made for it |

`asset.unreachable` also covers what the engine fetches for itself: OIDN weights, IES profiles and
gobos (`detail.asset` says which).

`settings.getEffective()` is the companion for the `setting.unknown_key` case: it returns every live
setting as `{ value, source, routed }`, and `routed: false` means stored but reaching no stage.

---

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

### Render Resolution Reserve

Every compute `StorageTexture` and aux buffer is pre-allocated at one square dimension — the *reserve* — and `setCanvasSize()` refuses anything larger. The default is 2048, so 4K output needs the reserve raised first.

```js
engine.setReservedRenderResolution(4096)          // raise to 4K (longest edge)
engine.setReservedRenderResolution(2048, { allowLower: true })   // lower, paying a rebuild, to reclaim VRAM
engine.getReservedRenderResolution()              // the reserve actually in force
```

The request is **device-capped**: a 4096 reserve pins roughly 1.5 GB of MRT textures, so it is only granted on hosts reporting ≥ 8 GB and a ≥ 1 GB `maxStorageBufferBindingSize`; weaker devices clamp to 2048, recorded as `render.reserve_capped`. The memory figure is `options.hostMemoryGB`, else `navigator.deviceMemory`, else an assumed 4 — so outside Chrome, pass it. `MAX_RESERVABLE_RENDER_SIZE` (4096) is the ceiling on any request.

Raises are monotonic unless you pass `allowLower` — UI-driven callers ask for whatever the current view needs, and honouring every decrease made the reserve oscillate across preview↔render switches, paying a full kernel rebuild each time.

Callable at any point in the lifecycle:

- **Before `init()`** — recorded and applied during `init()`, after the device exists but before the stages are constructed, so they allocate at the raised size directly. The device gate cannot run without a device, so the return value here is the *request*, not the verdict.
- **After `init()`** — applied immediately, re-initialising the reserved GPU storage in place.

Either way the verdict arrives as `EngineEvents.RESERVED_RENDER_SIZE_CHANGED`:

```js
engine.addEventListener(EngineEvents.RESERVED_RENDER_SIZE_CHANGED, e => console.log('reserve:', e.size));
engine.setReservedRenderResolution(4096);
await engine.init();
console.log(engine.getReservedRenderResolution());   // 4096, or 2048 if the device declined
```

---

### Memory Monitoring

Track GPU (VRAM) usage across the whole pipeline. Sizes are measured from live GPU resources (buffer `byteLength` + texture dimensions × format), so they are exact, not estimated.

```js
const { current, peak, byCategory } = engine.getMemoryInfo();   // bytes
// byCategory: { rays, queues, gbuffer, accum, geometry, materials, environment, stages, denoiser, canvas }

engine.vram.resetPeak();   // reset the high-water mark to the current value
engine.vram.getReport();   // formatted one-line summary string
```

`peak` is a high-water mark, reset when a final render begins (`configureForMode('production')`). The engine's VRAM is largely monotonic — the ray pool only grows and the per-stage storage textures are fixed-size — so `peak` equals `current` during a steady render and only exceeds it after memory is released (lower resolution, a smaller scene, or removing the HDRI). The `stages` + `accum` categories (fixed 2048² storage textures) dominate the baseline.

`denoiser` is what the engine allocates for OIDN — its three float inputs, its half-float output and
the motion history. `canvas` is one image per presented surface (a browser may keep one or two more)
plus the buffer three.js's output pass tone-maps through. Not counted: oidn-web's own network weights
and activations, which it reports by count, not by size; and the neural passes, which run on a
`GPUDevice` of their own.

The React app surfaces this as a `Memory: … | Peak: …` readout in the on-canvas stats overlay.

#### CPU memory

The wall a large scene hits is not VRAM, it is contiguous `ArrayBuffer` address space on the CPU —
and how much of it a browser can still hand out falls as the tab stays up, so the same scene can
load after a restart and fail after a long session.

```js
const { preflight, allocatedBytes, peakLiveBytes, byPhase, samples } = engine.getHostMemoryInfo();
// null until a scene has been built
```

⚠️ Do not use `performance.memory.usedJSHeapSize` for this. It does not count `SharedArrayBuffer`,
and the triangle and node stores are SAB-backed, so the browser's own reading under-reports a large
scene by gigabytes.

Before extraction the engine prices the scene and applies two lines, both recording
`scene.memory_budget`:

| Estimate | What happens |
|---|---|
| above ~7,040 MB | warns, and builds anyway |
| above ~9,216 MB | **throws** — past this the renderer process is killed rather than throwing an error you could catch, so refusing early is the only useful answer |

Raise or lower the hard line with `new PathTracerApp(canvas, { maxSceneBytes })`. The estimate runs
low at the very top of its range, so the per-load `maxTriangles` cap (45M) is the more reliable
guard on a scene of that size. With `memorySpill` the estimate leaves out what the build keeps on
disk (the BVH, and triangle records past what a streamed build holds at once).

---

### Logging

Leveled, namespaced console output, shared with the engine's Web Workers. The default level is `info`, which hides per-mesh and per-texture detail; drop to `debug` to see it.

```js
import { Logger, createLogger, fmt, LOG_LEVELS } from 'rayzee';

Logger.setLevel('debug');       // 'silent' | 'error' | 'warn' | 'info' | 'debug'
Logger.getLevel();
Logger.isEnabled('debug');      // gate expensive message construction
Logger.only('bvh', 'gpu');      // restrict debug to these namespaces (implies setLevel('debug'))
Logger.only();                  // clear the namespace filter
Logger.refresh();               // re-read the level from globals/localStorage
```

The chosen level persists in `localStorage` under `rayzeeLogLevel` (namespace filter: `rayzeeLogNamespaces`), so it survives a reload. The engine does not install a global itself — expose one from your host if you want console access without an import; the demo app does `globalThis.rayzee = { log: Logger, ... }`, which is what makes `rayzee.log.setLevel('debug')` work there.

`createLogger(namespace)` returns a channel with `error` / `warn` / `info` / `debug` plus `summary(headline, details)`, which prints one `info` line with the detail lines folded into a collapsed group. `fmt` holds the formatting helpers those summaries use — `n`, `ms`, `mb`, `px`, `count`, `list`. `LOG_LEVELS` is the name→severity map.

---

### Deterministic & Headless Rendering

For offline rendering, regression testing, and benchmarking — drive accumulation yourself instead of the rAF loop, and get bit-reproducible output.

```js
engine.setDeterministicMode(true);          // pin everything wall-clock- or readback-dependent
const samples = await engine.renderFrames(256, {
  reset: true,                              // restart accumulation from sample 0
  yieldEvery: 8,                            // yield to the event loop every N passes (0 disables)
  onProgress: n => console.log(n),
});
const blob = await engine.screenshot();
engine.setDeterministicMode(false);         // restore the previous configuration
```

The RNG is already pure — `hash(pixel, rayIndex, frame)`, no clock, no `Math.random()` in any shader. What varies run to run is *which* uniforms and dispatch grids are live on frame k, so `setDeterministicMode` disables adaptive sampling, per-pixel freeze, the readback-driven per-bounce early exit and dynamic dispatch sizing, interaction mode, auto-focus, and auto-exposure, and pins the sampler's seed axis to the accumulation frame. It also forces `renderLimitMode` to `'frames'` — a wall-clock render limit retires at a run-dependent sample count. It leaves the rAF loop stopped; `renderFrames` is the drive.

- `engine.isDeterministic` — whether output is currently bit-reproducible.
- `setDeterministicMode(true, { pinDispatch: false })` keeps the two readback-driven dispatch heuristics active. Output is then *not* reproducible; this exists so performance measurements reflect shipping behaviour rather than a configuration production never runs.
- `renderFrames` raises `maxSamples` if needed, and throws if something retires the render early.

#### Production renders, reproducibly

Deterministic mode buys reproducibility by turning adaptive sampling off. To render the way the
product does — adaptive sampling, pixel freeze and the per-bounce early exit all on — and still get
the same image for the same input, drive the render with `renderUntilComplete`:

```js
engine.configureForMode('production');
const { samples, retiredBy, denoised } = await engine.renderUntilComplete({ signal });
// retiredBy: 'samples' | 'converged' | 'timeLimit'
```

It renders without `requestAnimationFrame` until the sample ceiling, convergence or the time limit —
whichever comes first — then runs the final OIDN denoise once, and fires `RENDER_COMPLETE` as the
loop does. Adaptive sampling decides from counts read back from the GPU; normally each is applied
whenever it lands, so the frame that retires depends on how fast frames are submitted. For its
duration `renderUntilComplete` runs those readbacks in **lockstep**: one issued at frame N is applied
at frame N + 4 exactly, and the render waits if it has not landed; every reset also starts from seed
0 and from nothing the previous render measured. It turns interaction mode off meanwhile (a
wall-clock mode for camera drags), and keeps submissions at most 2 × `drainEvery` frames ahead of
the GPU. A time limit is wall-clock by nature, so that one stop is not reproducible; neither is
auto-exposure, if you turn it on.

`engine.setLockstepReadbacks(true)` applies the same lockstep to the rAF loop and to `renderFrames`.

#### Batch rendering

The supported entry point for a render farm is `rayzee/src/Headless.js`, exported from the package.
Its defaults are a batch renderer's — `strict`, `profile: 'physical'`, deterministic, storage off —
so a degraded render throws instead of shipping:

```js
import { openHeadless, captureHeadless } from 'rayzee';

const app = await openHeadless({ canvas, model: url, width: 1920, height: 1080 });
try {
  const frame = await captureHeadless(app, { samples: 256, denoise: true });
  // frame.data: RGBA8 (colorSpace 'srgb') or Float32 (colorSpace 'linear')
  // frame.source: what was read — 'oidn' here, 'accumulation' without denoise
  // frame.issues: everything the engine survived, when not strict
} finally {
  app.dispose();
}
```

`denoise: true` turns OIDN on before accumulating (it reads the albedo and normal buffers, which
are written only while it is on), runs **one** final denoise with `app.runFinalDenoise()`, and reads
it back with `renderToBuffer( { source: 'display' } )`. Driving it yourself is the same three calls.
`renderToBuffer` reports the picture it read as `source`, and records `output.source_fallback` when
`'display'` was asked for, a denoiser is in use, and nothing had published — so a strict host cannot
ship a noisy image by mistake. Its `'srgb'` bytes are tone-mapped on the GPU — 9 ms at 4096×2160,
where the CPU pass it replaced took 1.4 s on an M-series Mac and 10 s on a cloud host — and match the
canvas to within one level (it rounds half a level up); `'linear'` is exact. When the GPU pass is
unavailable or fails, the CPU does it instead: the result's `toneMappedOn` says `'cpu'` rather than
`'gpu'`, and `output.tonemap_fallback` is recorded with the reason.

Constructing `PathTracerApp` yourself instead: pass `strict: true`; storage is then off unless you
set it. Outside Chrome, pass `hostMemoryGB`.

**Provenance.** `engine.getProvenance()` — also `frame.provenance` from `captureHeadless` — is plain
JSON naming what produced the image: engine and three.js versions, the profile by name *and* by
value, the adapter, every live setting with its source, the colour pipeline, the render size and
samples, and whether it ran headless, strict, deterministic or lockstepped. `mode.lockstep` says
whether the current image was traced in lockstep, so it stays true after `renderUntilComplete` turns
lockstep back off. Store it beside each render and "what made this?" has an answer without rendering
again.

**Pinning a look.** A change to what a render looks like when a host sets nothing — a default
setting, a mode preset, a profile's values, light units — is released as a **major**, with the
change described under BREAKING CHANGES in the release notes. Pin a major to pin a look; read the
notes before moving to the next one.

#### Running in Node

The published build renders in plain Node on Dawn — the `webgpu` package, the WebGPU implementation
inside Chrome — with no browser and no DOM shim:

```js
import { create, globals } from 'webgpu';
import sharp from 'sharp';
import { configurePlatform, openHeadless } from 'rayzee';
import { nodePlatform } from 'rayzee/node';

Object.assign(globalThis, globals);
const gpu = create([]);                       // keep a reference: Dawn crashes if it is collected
Object.defineProperty(navigator, 'gpu', { value: gpu });

const decodeImage = async (bytes) => {
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};
configurePlatform(nodePlatform({ decodeImage }));   // after the webgpu globals, before any app
const app = await openHeadless({ width: 1920, height: 1080, hostMemoryGB: 16 });   // no canvas: headless
await app.loadModel('https://…/room.glb');
const { samples } = await app.renderUntilComplete();
const frame = await app.renderToBuffer({ source: 'display' });
app.dispose();
```

- **No canvas means headless.** `new PathTracerApp(null)` — or `{ headless: true }` — makes its own
  canvas (a WebGPU context over a plain texture), runs no render loop (drive it with `renderFrames` or
  `renderUntilComplete`), and builds neither the overlay renderer nor the transform gizmo.
- **`configurePlatform({ Worker, decodeImage })`** is where a host without a browser supplies what one
  would. `nodePlatform()` from `rayzee/node` fills it: `NodeWorker`, the Web Worker API over
  `worker_threads`, runs the engine's inlined workers; `decodeImage(bytes, mimeType)` is yours — PNG,
  JPEG or WebP to RGBA8, straight alpha, top row first — since the engine carries no decoder. It decodes
  every glTF image, embedded or not, and JPEG/PNG skies. PNGs with bytes after `IEND`, which browsers
  accept and strict decoders refuse, are trimmed first; a texture that still fails is recorded as
  `texture.build_failed` rather than dropped. Measured on a 91-texture model: `sharp` and
  `@napi-rs/canvas` (`await loadImage()`, then a 2D canvas) both decode in parallel, ~0.3 s against
  pngjs's 2.5 s serial. The canvas route premultiplies, which zeroes colour under alpha 0 and loses
  it under low alpha; `sharp` is exact. `jpeg-js` differs from libjpeg-turbo by up to 63 levels.
- **`nodePlatform()` wraps the `webgpu` queue**, so install its globals first. dawn.node 0.6.1
  segfaults on `writeBuffer` / `writeTexture` from a `SharedArrayBuffer`, which WebGPU allows and the
  engine's triangle and BVH stores are once a scene is large; those uploads are copied out, 64 MB at
  a time.
- **Textures are packed on the CPU** where there is no `createImageBitmap`: exact when a map fits its
  bucket, bilinear otherwise (a browser's canvas filter differs slightly there). A bucket over 8 MB
  packs in a worker, reading images decoded by `decodeImage` in place (they are kept in shared
  memory): on the main thread it held up the BVH workers, and a 1.9M-triangle, 91-texture model
  loaded in 4.1–4.9 s. It now loads in 2.1 s, against Chrome's 2.9 s on the same machine.
- `nodePlatform()` also defines `ProgressEvent`, which three.js's `FileLoader` constructs while
  streaming; that is the only global it sets. three.js's own Draco and KTX2 workers call the global
  `Worker`, so a model using either also needs `globalThis.Worker = NodeWorker`.

Measured on this bench's corpus: all 29 scenes match the Chrome goldens (`npm run bench:node`, RMSE
≤ 0.0036, no pixel over 0.02 — the readback's tone map accounts for most of it), and a textured glTF with an
HDR or a PNG sky matches Chrome block for block within 0.05 of a level. Not available
without a browser: on-disk storage (OPFS), gobo libraries (they draw on a 2D canvas), and the AI
upscaler.

#### GPU timing

```js
engine.enableGPUTiming(true);                       // off by default — the queries themselves cost time
const { compute, render, total } = await engine.getGPUTimings();
const { kernels, unattributed, frame } = await engine.getKernelGPUTimings();
```

WebGPU timestamp queries are the only true GPU metric here — `pipeline.getStats()` times command *encoding* on the CPU and stays flat while GPU cost doubles. Both methods return `null` when the device lacks `timestamp-query` or timing was never enabled.

`getKernelGPUTimings()` attributes each compute pass of the last resolved frame back to a wavefront kernel name. Durations are **summed per kernel across the frame**, so `extend` reports its whole per-frame cost over every bounce iteration, not one bounce. `unattributed` collects passes belonging to no registered kernel (other stages, denoisers), so `sum(kernels) + unattributed` reconciles with `total`.

Neither method can see the OIDN denoise — `oidn-web` submits on its own command encoders, outside
the stages three.js times. It carries its own profiler instead:

```js
engine.profileNextDenoise();                          // arms one capture; per-denoise, not sticky
const { profile, runtime } = await engine.getDenoiseProfile();
```

`profile` is the per-layer GPU timing of that denoise; `runtime` reports the selected engine and
precision, the model, kernel capabilities, tile state and resource counts — which is the way to
confirm FP16 actually engaged on a given GPU rather than inferring it from the device's feature
list. Both need `timestamp-query`, and `getDenoiseProfile()` returns `null` when OIDN is not set up.

### On-disk Storage (OPFS)

`engine.storage` is a `StorageManager` over the browser's origin private file system, or `null` where
there is none (a private window, Node) — everything works without it, only slower. The engine keeps
its caches there: downloads (models, skies, OIDN weights — revalidated at most daily with a 1-byte `Range` request, and served from the cache meanwhile),
unpacked `.tar.gz` archives and archive indexes, built scenes (reopened without rebuilding BVHs when
the first build took ≥ 10 s), and environment sampling tables. Caches share a budget of 30 % of the
quota and are evicted least-recently-used; `engine.storage.usage()` reports each area.

A host keeps its own data beside them:

```js
import { STORAGE_KIND } from 'rayzee';

engine.storage.defineArea( 'renders', { kind: STORAGE_KIND.USER } );   // never evicted
const writer = await engine.storage.area( 'renders' ).create( 'render:42', { label: 'Render 42' } );
await writer.writeFile( 'image.png', blob );
await writer.commit();                                                // meta.json last: all or nothing

const entry = await engine.storage.area( 'renders' ).open( 'render:42' );
const file = await entry.file( 'image.png' );
entry.release();
```

`loadFile( url )` and `loadModel( url, { cacheKey } )` download through the cache — pass `cacheKey` for
a link that expires (a signed URL). `fetchFile( url, storage )` / `cachedObjectURL( url )` do the same
for a host's own assets. Failures record `storage.*` issues and fall back to memory; storage never
throws for being absent or full.

**Memory spill (experimental).** With `memorySpill: true`, a static scene of more than one 64 MB chunk
is built through disk, so its large arrays are never all in memory at once:

- Extraction and BVH building run together. Each stored range of triangles goes to a BLAS worker as
  soon as it is written, and extraction waits while more than 1.5 GB of triangle records are held.
  On the 55.7M-triangle Moana subset the build peak fell from 6.6 to 4.1 GB.
- The three.js geometry goes to disk after the build last reads it, and comes back when the build
  ends. On a 70M-triangle scene the page held 0.84 GB after extraction instead of 4.07 GB.
- Each triangle chunk and BLAS goes to the GPU, then to disk. At 50M triangles the page settles at
  7.2 GB instead of 9.1 GB.

With or without the spill, a mesh past 2M triangles is built as spatial pieces of ≤ 512k triangles
on a worker pool and joined under the tree that split them, so no build holds a second copy of it.

The render is unchanged. Visibility and rigid moves need nothing read back. Material edits that
rewrite triangles (side, transparency, emission), and refits, read it back first. `refitBLASes`
throws on a spilled scene until `await engine.ensureSceneResident()`.

### Saving Scene State

```js
const state = engine.exportSceneState();      // JSON-safe: settings, sky, colour, lights, cameras,
                                              // timeline keys, material edits, hidden and moved objects
const source = engine.sceneSource;            // { kind: 'url', url, cacheKey } | { kind: 'local-file', file } | ...

// later, after loading the same model again:
const { skipped } = await engine.importSceneState( state, {
  resolve: async ( request ) => {
    // { kind: 'environment', source }  → a File, a URL or null (the engine loads URL skies itself)
    // { kind: 'colorConfig', config }  → true once you have loaded it (built-in configs load themselves)
    return null;
  },
} );
```

Objects, materials and cameras are matched by position in the scene plus a name check — UUIDs
change on every load — so a different model keeps its own objects and materials and the rest still
applies; `skipped` lists what could not be put back. Texture swaps on materials are not included yet.

### Render Checkpoints

```js
const checkpoint = await engine.captureRenderCheckpoint();   // accumulation + the counters that pick the next sample
// ...a reload later, the same scene state restored and one frame rendered at the same size:
engine.restoreRenderCheckpoint( checkpoint );
engine.wake();                                               // or await engine.renderFrames( n, { reset: false } )
```

In deterministic mode the continued render is bit-identical to one that never stopped. A checkpoint
is ~60 bytes a pixel (252 MB at 2048²): the accumulated colour and aux buffers as RGBA32F plus three
per-pixel convergence buffers.

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
| `DENOISING_START` / `DENOISING_END` | Denoiser runs. `event.continuous` is `true` for a cadence denoise of the still-accumulating image, `false` for the one that ends a render |
| `UPSCALING_START` / `UPSCALING_PROGRESS` / `UPSCALING_END` | AI upscaler runs |
| `LOADING_UPDATE` / `LOADING_RESET` | Asset loading progress. A failed load ends with `failed: true` and the error as `status`; an archive that asks which parts to load ends with `LOADING_RESET` |
| `STATS_UPDATE` | Performance stats updated |
| `OBJECT_SELECTED` / `OBJECT_DESELECTED` | Object selection changes |
| `OBJECT_DOUBLE_CLICKED` | Object double-clicked |
| `OBJECT_TRANSFORM_START` / `OBJECT_TRANSFORM_END` | Transform gizmo drag |
| `TRANSFORM_MODE_CHANGED` | Gizmo mode changed |
| `SELECT_MODE_CHANGED` | Selection mode toggled |
| `SETTING_CHANGED` | A render setting is modified |
| `AUTO_FOCUS_UPDATED` | Auto-focus recalculated — `worldDistance` in scene units, `distance` divided by the model's size |
| `ORTHO_HEIGHT_UPDATED` | An orthographic view's height changed — `height` in scene units |
| `AUTO_EXPOSURE_UPDATED` | Auto-exposure recalculated |
| `AF_POINT_PLACED` | Focus point placed on screen |
| `ANIMATION_STARTED` / `ANIMATION_PAUSED` / `ANIMATION_STOPPED` / `ANIMATION_FINISHED` | Animation lifecycle |
| `VIDEO_RENDER_PROGRESS` / `VIDEO_RENDER_COMPLETE` | Video export progress |
| `DEVICE_LOST` | The GPU device was lost (driver crash/reset) — rendering halts instead of throwing into a dead device |
| `DISPOSE` | Engine is being disposed (fires before teardown begins, so listeners can release their own references) |
| `ISSUE` | An issue was recorded — see [Degradation contract](#degradation-contract) |
| `MODEL_LOADED` / `OBJECT3D_LOADED` / `MODEL_ADDED` / `SCENE_OBJECT_REMOVED` / `SCENE_UNLOADED` | Scene content changed |
| `SCENE_REBUILD` / `SCENE_SPILLED` / `SCENE_METADATA_APPLIED` | The scene was rebuilt, moved to disk, or had its authored environment applied |
| `ENVIRONMENT_LOADED` / `TEXTURES_REPROCESSED` | An environment or the texture arrays were (re)built |
| `CAMERAS_UPDATED` / `CAMERA_SWITCHED` / `FOCUS_CHANGED` | Camera list, active camera, or focus distance changed |
| `RESOLUTION_CHANGED` / `RESERVED_RENDER_SIZE_CHANGED` | The render size or the reserve changed |
| `STORAGE_CHANGED` / `TIMELINE_CHANGED` | On-disk storage or timeline keys changed |

Several of these used to be plain strings (`'ModelLoaded'`, `'RenderComplete'`, `'resolution_changed'`, …).
The engine still dispatches each under its old name as well, until the next major; `LEGACY_EVENT_NAMES`
maps new to old. Listening for a name the engine never dispatches logs a warning once, since such a
listener fails silently otherwise.

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
import { PathTracerApp, EngineEvents, LEGACY_EVENT_NAMES } from 'rayzee';

// Platform services for hosts without a browser (see Running in Node)
import { configurePlatform, getPlatform } from 'rayzee';
import { nodePlatform, NodeWorker } from 'rayzee/node';

// Configuration & presets
import {
  ENGINE_DEFAULTS,
  ASVGF_QUALITY_PRESETS,
  CAMERA_PRESETS,
  CAMERA_RANGES,
  SKY_PRESETS,
  DEFAULT_SUN_PATH,
  AUTO_FOCUS_MODES,
  AF_DEFAULTS,
  TRIANGLE_DATA_LAYOUT,
  BVH_LEAF_MARKERS,
  TEXTURE_CONSTANTS,
  DEFAULT_TEXTURE_MATRIX,
  MEMORY_CONSTANTS,
  PRODUCTION_RENDER_CONFIG,
  INTERACTIVE_RENDER_CONFIG,
  MAX_RESERVABLE_RENDER_SIZE,
  RENDER_PROFILES,
  MATERIAL_DEFAULTS,
} from 'rayzee';

// Colour management — engine.color is the instance a host normally uses; these build UI against
// it, or reach the view-transform registry without an app
import {
  ColorManagement, getActiveColorManagement, isColorManaged, DEFAULT_WORKING_SPACE,
  listViewTransforms, getViewTransform, addViewTransform, removeViewTransform, onRegistryChange,
  buildOcioView, addOcioView, addAllOcioViews,
  convertColor, convertPixelsF32, extractMatrix, hasColorSpace,
  displayCanvasFit,
} from 'rayzee';

// Where the sun stands for a solar time, date and latitude (degrees; azimuth clockwise from north)
import { sunPosition, timeForSunElevation, dayOfYearForMonth } from 'rayzee';

// Leveled/namespaced logging, shared with the workers
import { Logger, createLogger, fmt, LOG_LEVELS } from 'rayzee';

// Asset URL / cache namespace overrides
import { configureAssets, getAssetConfig } from 'rayzee';

// On-disk storage (OPFS): caches, host areas, downloads, file identity
import {
  openStorage, StorageManager, STORAGE_KIND, ENGINE_AREAS, acquireLock, heldLockNames,
  fileIdentity, identityKey, sameIdentity,
  DownloadCache, DOWNLOAD_POLICY, fetchFile, nameFromUrl, cachedObjectURL,
} from 'rayzee';

// Archives read in place, one entry at a time
import { openZip, readZipDirectory } from 'rayzee';

// Scene state as plain data (engine.exportSceneState), and the engine version as built
import { SCENE_STATE_VERSION, toPortable, fromPortable, VERSION } from 'rayzee';

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
  TimelineManager,
  CameraTrack,
  InteractionManager,
  RenderPipeline,
  RenderStage,
  StageExecutionMode,
  PipelineContext,
} from 'rayzee';

// VRAM accounting (VRAMTracker is also reachable as engine.vram)
import { VRAMTracker, bufferBytes, textureBytes } from 'rayzee';

// Degradation contract — see above. ISSUE_CODES is add-only; pin a version and branch on it.
import { ISSUE_CODES, ISSUE_SEVERITY, IssueLog, EngineIssueError } from 'rayzee';

// CPU memory: price a scene before loading it, or measure what can still be placed
import {
  MemoryLedger,
  estimateSceneBytes,
  probeAddressSpace,
  SAFE_SCENE_BYTES,
  MAX_SCENE_BYTES,
} from 'rayzee';

// Adapter description — flags software rasterisers (SwiftShader, llvmpipe, lavapipe, WARP)
import { describeAdapter } from 'rayzee';

// Dev-only: texture-binding aliasing guard. Two TextureNodes still holding the default
// EmptyTexture when a kernel is first compiled can share one GPU binding — nothing throws,
// the aliased node just reads someone else's texture. Off by default; costs a per-stage
// snapshot when on. Intended for test harnesses, not production.
import { setBindingAudit, getBindingAuditFindings, clearBindingAuditFindings } from 'rayzee';
```

## Browser Requirements

- WebGPU support (Chrome 113+, Edge 113+, Safari 18+, Firefox 141+)
- Secure context (HTTPS or localhost)

## Optional Dependencies

| Package | Purpose | Install needed? |
|---|---|---|
| `oidn-web` | Intel Open Image Denoise for high-quality final renders | Yes — `npm install oidn-web` (**>=0.4.0**) |
| `onnxruntime-web` | AI-powered upscaling | No — loaded from CDN at runtime |
| `@bb-studio/ocio` | OpenColorIO runtime for [Colour Management](#colour-management) (~6 MB WebAssembly) | Only to load colour configs — `npm install @bb-studio/ocio`, then pass it as `ocioRuntimeFactory` |

> **Note:** `onnxruntime-web` is also listed in `package.json` under `optionalDependencies` for bundler compatibility, but the engine's own runtime path always fetches it from a CDN (see `ortRuntimeUrl` / `ortWasmPaths` in [Configuring Assets](#configuring-assets-cdn-urls--cache-namespace)) rather than importing the installed package — installing it locally has no effect unless you also override those URLs to point at your own copy.

### Enabling OIDN (Intel Open Image Denoise)

OIDN provides high-quality AI denoising. It runs automatically once the render converges (reaches
`maxSamples`), and — in `'interactive'` mode — also on a cadence while the image is still
accumulating, so a preview shows a clean picture as it refines instead of only at the end. See
[Continuous denoising](#continuous-denoising).

1. **Install the package**

   ```bash
   npm install oidn-web
   ```

2. **Enable in your app**

   ```js
   // After engine.init() completes
   engine.denoisingManager.setOIDNEnabled(true);
   engine.denoisingManager.setOIDNQuality('balance'); // 'fast' | 'fast-clean' | 'balance' | 'high'
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

| Quality | Weights | Aux guide | Best for |
|---|---|---|---|
| `'fast'` | 0.6 MB | point-sampled | Low sample counts — the default |
| `'fast-clean'` | 0.6 MB | accumulated | Converged frames, at `'fast'`'s cost |
| `'balance'` | 1.8 MB | accumulated | General use |
| `'high'` | 7.3 MB | accumulated | Final renders — used by `configureForMode('production')` |

#### When the denoiser runs

Two independent decisions, because they answer different questions — *what cleans the view while the
render works*, and *does the finished image get a proper pass*:

```js
engine.denoisingManager.setStrategy('oidn');    // 'none' | 'edgeaware' | 'asvgf' | 'nrd' | 'oidn'
engine.denoisingManager.setOIDNEnabled(false);  // a full OIDN pass on the finished image
```

Exactly one denoiser owns the live view, which is why OIDN is an entry in that list rather than a
parallel switch — two of them would mean paying for a per-frame denoise whose result the OIDN
overlay immediately covers. But choosing OIDN there says nothing about the finished image, and
switching the final pass on says nothing about the live view. All six combinations are reachable:

| `setStrategy` | `setOIDNEnabled` | Camera moving | Still, accumulating | Finished |
|---|---|---|---|---|
| `'none'` | `false` | raw | raw | raw |
| `'none'` | `true` | raw | raw | OIDN |
| `'asvgf'` | `false` | ASVGF | ASVGF | ASVGF's last frame |
| `'asvgf'` | `true` | ASVGF | ASVGF | OIDN |
| `'oidn'` | `false` | OIDN, from the motion history | OIDN, refreshing | one last refresh |
| `'oidn'` | `true` | OIDN, from the motion history | OIDN, refreshing | OIDN, full quality |

`denoiser.enabled` is the union of the two — "OIDN is in use at all", which is what the aux G-buffer
wiring needs — so read the two decisions back from `denoisingManager.denoiserStrategy` and
`denoisingManager.finalDenoise`, not from it.

With OIDN on the live view and the final pass off, the render still closes with one more refresh: the
cadence's last tick lands short of the end, and the picture should match the render that finished. On
a 150-sample render that gap measured **11 samples at 512²** and **1 at 1024²** — larger where the
renderer is fast, because more samples land between refreshes. It uses whatever model the refreshes
were already on: no reload for an image the user never asked to be denoised at full quality.

In the app that is `Real-Time Denoiser` (None / EdgeAware / ASVGF / NRD / **OIDN (AI)**) and the
`Final Denoise (OIDN)` switch. Deterministic mode pins the live refreshes off, since which frame a
wall-clock cadence lands on is not reproducible.

Leaving the live view raw is not just "denoising off" — it is the only way to see the true noise
level, which is how you judge whether a render has actually settled. That is row one and row two.

#### While the view moves

Every frame restarts while the camera or an object moves, so a refresh would otherwise denoise one
fresh sample with its own independent noise, and OIDN's guesses would jump from refresh to refresh
("boiling"). Instead each restarted frame is blended into a per-pixel **motion history**, reprojected
into the current view, and the live refreshes denoise that. Measured on a 1.7M-triangle interior at
512² against 128-sample references: blotchy flicker 2.12 → 0.90 while orbiting and 1.72 → 0.78 moving
forward, each frame 16 % closer to the clean render, refresh rate unchanged.

- Reflections and a moving object's lighting do not travel with the surface, so shiny pixels and
  pixels of moved objects keep only about 2 frames of history.
- When the view stops, the history is blended into the fresh accumulation and fades out over the
  first 16 samples; the final denoise always reads the plain accumulation.
- A reset that changes what the scene looks like (a light, a material, a setting) drops the history.
  Moves go through `reset(true)` (the camera) or `reset(false, { motion: true })`, which the engine's
  own `updateMeshTransforms`, `refitBVH`, `refitBLASes` and animation playback already use.
- Moved placements are followed through their matrices when they move through
  `updateMeshTransforms` or rigid animation; deformed geometry is rejected by its changed depth.
- Cost, only while OIDN owns the live view: +154 MB of VRAM at 512², +232 MB at 1024², and ~5 % GPU
  per frame while moving, mostly the `NormalDepth` stage it switches on. At a size the refresh
  cadence has proven too slow to denoise while moving (the raw render owns the view there), both are
  released until the size changes.

`setTemporalHistory(false)` returns to denoising the single fresh frame.

#### Quality while it runs vs. quality when it finishes

`oidnQuality` is **the quality of the finished image**. The refreshes along the way use the cheapest
model that reads the same kind of aux buffer, and the chosen model is put back for the last denoise:

| `oidnQuality` | refreshes use | finished image |
|---|---|---|
| `fast` | `fast` | `fast` |
| `fast-clean` / `balance` / `high` | `fast-clean` | as chosen |

Two constraints shape that table, and neither is optional:

- **The aux kind must not change mid-render.** `setCleanAuxNormal()` throws away the accumulated
  albedo/normal, so a refresh model that disagreed with the final one would leave the final denoise
  reading an aux buffer one sample deep. That is why the cheap model is `fast-clean` and not `fast`.
- **The cheap model only takes over once a denoise has measured too slow to be a live view
  (`> 120 ms`).** A tier a machine can afford is kept — at 512² that is every tier. The verdict
  survives a camera move, because the device does not get faster between them; it is re-taken when
  the tier or the resolution changes. Past it, each render swaps twice (to the cheap model when the
  view moves, back for the finished image). A swap costs 10-20 ms on oidn-web 0.4.0, and each model's
  weights are downloaded once and kept, so a swap never goes back to the network.

#### What paces the refreshes

Two knobs with two different jobs, and the gap between refreshes is whichever is larger:

- **The cost floor protects the renderer.** The gap is at least twice what the last denoise actually
  cost, so denoising never takes more than about half the wall clock, at any resolution, on any GPU.
  This is not configurable, and it is what binds at the default.
- **`continuousDenoiseInterval` caps the refresh rate in absolute terms**, for a host that wants
  fewer updates than the renderer could afford — a laptop on battery, or a viewport where 30 updates
  a second is distracting. The default (8 ms) is below any real denoise cost, so it never binds:
  refreshes run as often as the cost floor allows. Raising it gives a flat `1000 / interval` cap.

Measured, `fast` model:

| `continuousDenoiseInterval` | 8 | 50 | 100 | 200 | 400 |
|---|---|---|---|---|---|
| 512² (denoise 12 ms) | 35/sec | 18/sec | 9.6/sec | 4.9/sec | 2.6/sec |
| 1024² (denoise 50 ms) | 9/sec | 9/sec | 9/sec | 4.9/sec | 2.6/sec |

The two columns converge once the interval is the larger of the two — below that the cost floor is
holding 1024² down to 9/sec regardless of what the interval says.

A fixed millisecond interval cannot do this job: the same `fast` model measures 14 ms at 512², 48 ms
at 1024² and ~800 ms at 2048². Measured where the GPU is saturated (1536²), the multiplier is the
whole trade — 1x gives 1.6 refreshes/sec at 62 % of the sample rate, 2x gives 0.8/sec at 89 %, 3x
gives 0.6/sec at 97 %.

This replaced a sample-growth gate (refresh only once the sample count had grown 1.4x), which was
written when a denoise cost 100-330 ms. Once the output pack moved to the GPU and a denoise got
cheap, that gate only cost refreshes: removing it took 512² from 2 to 31 refreshes/sec and 1024²
from 2 to 8.9, both at an unchanged sample rate, while 1536² and 2048² did not move at all because
the cost floor already bound there. Refreshing faster is also *smoother*, not shimmerier — less
changes underneath between refreshes.

Nothing runs while the camera is moving; the raw frame shows during navigation.

Cadence runs are tagged so a host can tell them apart from the denoise that ends a render:

```js
engine.addEventListener(EngineEvents.DENOISING_END, e => {
  if (e.continuous) return;   // a background refresh, not the final image
  saveResult();
});
```

`'fast'` and `'fast-clean'` are the same network size and cost the same to run; they differ only in
which auxiliary guide their weights expect. That makes the ordering **not** a simple quality ladder:
at 1 spp the accumulated guide has one sample, so `'fast-clean'` is fed something it was not trained
for and measures materially worse than `'fast'` (on a transmission-heavy scene, more than double the
RMSE). Once the guide converges it wins by a few percent — but `'high'` beats it there anyway. Pick
`'fast'` for previews and `'high'` for output; `'fast-clean'` is for the narrow case of denoising a
converged frame on a budget.

Denoise cost scales with frame area, and the tile tracks the frame so that a frame fitting inside one
tile pays no overlap padding — at 1024x1024 that is roughly 1.8x faster than tiling it. A cap
(default 1024) bounds the one-time activation allocation, so larger frames tile and stay
memory-bounded. Raise or lower it with
`engine.denoisingManager.denoiser.updateConfiguration({ tileSize: 2048 })`; the effective tile is
`min( max( width, height ), tileSize )`.

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
    "oidn-web": "https://cdn.jsdelivr.net/npm/oidn-web@0.4.0/dist/oidn.js"
  }
}
</script>
```

**OIDN from a CDN**
Load the self-bundled `/dist/oidn.js` path rather than `/+esm` or `esm.sh` — it is a single pre-bundled ESM with no external imports, and it is the path this engine is tested against.

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
