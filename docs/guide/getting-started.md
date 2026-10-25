# Getting started

Install and a first scene with Vite are in the [engine README](../../rayzee/README.md#installation). This page covers the other setups, where the engine fetches its helpers from, the two renderer classes and the add-ons.

## Vanilla JS (no bundler)

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
      "three": "https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.webgpu.js",
      "three/tsl": "https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.tsl.js",
      "three/webgpu": "https://cdn.jsdelivr.net/npm/three@0.186.0/build/three.webgpu.js",
      "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.186.0/examples/jsm/",
      "oidn-webgpu/": "https://cdn.jsdelivr.net/npm/oidn-webgpu@0.6.0/",
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
    // Light it: a model alone renders black. The physical sky needs no file.
    await engine.environmentManager.setMode('procedural');
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

## React

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

## Integrating Alongside an Existing Three.js App

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

## Vite tip

When rayzee is installed from npm, its pre-built `dist/rayzee.es.js` uses worker and `import.meta.url` patterns that Vite's dep pre-bundler re-parses incorrectly. Exclude it:

```js
// vite.config.js
export default defineConfig({
  optimizeDeps: { exclude: ['rayzee'] },
});
```

## Configuring Assets (CDN URLs & cache namespace)

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

## PathTracerApp

The main engine class. Extends `RayzeeRenderer`, the [renderer core](#renderer-core-rayzeecore), which extends three.js's `EventDispatcher`. Related functionality is grouped into **namespaced managers** accessed via `engine.cameraManager`, `engine.lightManager`, etc., or as direct methods on the engine instance.

```js
const engine = new PathTracerApp(canvas, options?)
```

| Parameter | Type | Description |
|---|---|---|
| `canvas` | `HTMLCanvasElement` | Rendering target |
| `canvas` may be `null` | | Headless: the engine makes its own canvas and runs no render loop — see [Running in Node](headless.md#running-in-node) |
| `options.headless` | `boolean` | Headless with a canvas of your own (default: `true` when `canvas` is `null`) |
| `options.autoResize` | `boolean` | Auto-resize on window resize (default: `true`; always off headless) |
| `options.container` | `HTMLElement` | Single DOM parent the engine mounts auxiliary elements into — HUD overlay (tile borders, helpers) and denoiser canvas. Defaults to `canvas.parentNode`. |
| `options.strict` | `boolean` | Throw an `EngineIssueError` where the engine would otherwise degrade and carry on (default: `false`). See [Degradation contract](api.md#degradation-contract). |
| `options.maxSceneBytes` | `number` | Raise or lower the CPU memory ceiling a scene may need before the engine refuses it (default 9,216 MB). See [Memory monitoring](storage.md#memory-monitoring). |
| `options.hostMemoryGB` | `number` | The host's memory, for runtimes without Chrome's `navigator.deviceMemory` (which then read as 4 GB and cap the render reserve at 2048). Sizes the reserve and the path pool. |
| `options.storage` | `false \| 'auto' \| StorageManager` | On-disk storage (default: `configureAssets( { storage } )`; off under `strict` unless you set it there or here). A manager you pass stays yours to dispose. See [On-disk storage](storage.md#on-disk-storage-opfs). |
| `options.memorySpill` | `'auto' \| boolean` | Default `'auto'`: build a static scene through disk when it would not fit in memory — triangle records, BLAS nodes and the three.js geometry are written out as the build finishes with them, and the instance matrix lists, the top-level tree and the triangle order maps once the load is done. `'auto'` does so only for a scene whose in-memory estimate passes the safe line (7 GB); `true` for every static scene; `false` never. Unless `false`, the pbrt and USD triangle and placement caps rise to 120M / 60M. Needs storage. Change it later with `engine.setMemorySpill( mode )`; `engine.sceneSpilled` says whether the current scene went to disk. See [On-disk storage](storage.md#on-disk-storage-opfs). |

The engine creates and mounts everything it needs (denoiser canvas, tile/HUD overlay) into a single parent on `init()`. Performance HUDs (e.g. `stats-gl`) are not bundled — listen to `EngineEvents.FRAME` and tick your own panel.

### Lifecycle

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

## Renderer core (`rayzee/core`)

`PathTracerApp` is built on `RayzeeRenderer`, the renderer without the viewer: a scene and camera in, path-traced samples accumulated, the image out. The denoisers, camera controls, gizmo, overlays, timeline and animation playback exist only in `PathTracerApp`; six capabilities come as add-ons — file formats beyond glTF and `.hdr`, the physical sky, scene archives, bidirectional path tracing, OpenColorIO colour and on-disk storage. Its entry point downloads about 30 % less at startup (277 KB against 404 KB compressed). It takes the same constructor options except `container`, and renders the same pixels.

```js
import { RayzeeRenderer } from 'rayzee/core';

const renderer = await new RayzeeRenderer(canvas).init();
await renderer.loadModel('/models/scene.glb');
renderer.camera.position.set(0, 2, 6);   // the camera it renders from; reset() after moving it
renderer.camera.lookAt(0, 0, 0);
renderer.reset();
await renderer.renderFrames(256);
const image = await renderer.renderToBuffer({ colorSpace: 'srgb' });
renderer.dispose();
```

Runnable examples live in the repository's `rayzee/examples/`, each run against the engine in that checkout:

| Example | What it shows | Run (from the repository root) |
|---|---|---|
| `core-node.mjs` | the core alone, in Node, writing a PNG | `npm run example:node` |
| `core-browser/` | the core plus the physical sky, accumulating on a canvas | `npm run example:browser` |
| `viewer-browser/` | the full engine in a page: a model, an HDRI, OIDN on the finished image | `npm run example:viewer` |
| `render.mjs` | the full engine in Node: any model and sky, any size, denoised, saved as `render.png` (options at the top of the file) | `npm run example:render -- --model scene.glb` |

`npm run bench:examples` runs all four and fails if any of them throws or logs an error or warning.

### Add-ons

Six capabilities install on the core explicitly. `PathTracerApp` installs all six itself, so nothing in this
section applies to it.

| Add-on | Import | Install | When | Without it |
|---|---|---|---|---|
| File formats | `fbxFormat`, `objFormat`, `stlFormat`, `plyFormat`, `colladaFormat`, `threeMFFormat`, `usdFormat`, `exrFormat` or `allFormats` from `rayzee/addons/formats` | `renderer.assetLoader.registerFormat(objFormat, exrFormat)` | after `init()` | only glTF/GLB, `.hdr` and images load; any other file's error names the add-on |
| Physical sky | `PhysicalSky` from `rayzee/addons/physical-sky` | `renderer.environmentManager.setProceduralSky(PhysicalSky)` | after `init()` | `'procedural'` mode records `capability.missing` (throws under `strict`) |
| Scene archives, folders and pbrt | `ArchiveImporter` from `rayzee/addons/archives` | `renderer.assetLoader.setArchiveImporter(new ArchiveImporter(renderer.assetLoader))` | after `init()` | `.zip`, `.tar`, `.tgz` and folders do not load, and the error names the add-on |
| Bidirectional and VCM | `BidirectionalIntegrator` from `rayzee/addons/bidirectional` | `renderer.stages.pathTracer.registerIntegrator(['bidirectional', 'vcm'], pt => new BidirectionalIntegrator(pt))` | after `init()` | choosing either integrator records `capability.missing` (throws under `strict`) and keeps the current one |
| OpenColorIO colour | `ColorManagement` from `rayzee/addons/color` | `renderer.setColorManagement(ColorManagement)` | before or after `init()` | linear Rec.709 through three.js's own tone mappers; `loadColorConfig()` records `capability.missing` and rejects |
| On-disk storage | `acquireSharedStorage` from `rayzee/addons/storage` | `renderer.setStorageOpener(acquireSharedStorage)` | **before** `init()` | downloads land in memory and nothing is cached between visits |

`init()` creates the asset loader, the environment manager and the path tracer stage, which is why four of them come
after it. Storage is opened during `init()`, so its opener has to be set first.

All six, in that order:

```js
import { RayzeeRenderer, configureAssets } from 'rayzee/core';
import { acquireSharedStorage } from 'rayzee/addons/storage';
import { ColorManagement } from 'rayzee/addons/color';
import { ArchiveImporter } from 'rayzee/addons/archives';
import { PhysicalSky } from 'rayzee/addons/physical-sky';
import { BidirectionalIntegrator } from 'rayzee/addons/bidirectional';
import { allFormats } from 'rayzee/addons/formats';

configureAssets({ ocioRuntimeFactory: () => import('@bb-studio/ocio') });

const renderer = new RayzeeRenderer(canvas);
renderer.setStorageOpener(acquireSharedStorage);             // before init()
renderer.setColorManagement(ColorManagement);
await renderer.init();
renderer.assetLoader.registerFormat(...allFormats);
renderer.assetLoader.setArchiveImporter(new ArchiveImporter(renderer.assetLoader));
renderer.environmentManager.setProceduralSky(PhysicalSky);
renderer.stages.pathTracer.registerIntegrator(['bidirectional', 'vcm'], pt => new BidirectionalIntegrator(pt));
```

**Loading on first use.** The physical sky and the archive importer can be installed as loaders instead, so their code
is fetched only the first time the sky is baked or an archive is read — `PathTracerApp` does this. The archive loader
takes the formats it reads, which `rayzee/core` exports, so the loader recognises an archive before its code exists:

```js
import { ARCHIVE_FORMATS } from 'rayzee/core';

renderer.environmentManager.setProceduralSkyLoader(() => import('rayzee/addons/physical-sky').then((m) => m.PhysicalSky));
renderer.assetLoader.setArchiveImporterLoader(
  () => import('rayzee/addons/archives').then((m) => new m.ArchiveImporter(renderer.assetLoader)),
  ARCHIVE_FORMATS,
);
```

Colour, storage and the integrators have no loader: colour and storage are used at startup, and an integrator applies
the moment it is chosen (a lazy one would trace plain frames meanwhile and break reproducible renders).

**File formats.** The core reads glTF/GLB (Draco, KTX2 and meshopt decoders are fetched only for a file that uses
them), `.hdr` and LDR images. FBX, OBJ, STL, PLY, Collada, 3MF, USDZ and EXR are formats to register — import only
those you read and a bundler leaves the rest out; each three.js loader is downloaded the first time its format is read
(a `.usd` / `.usda` / `.usdc` layer is read by the engine's own USD importer, in the archives add-on below):

```js
import { objFormat, usdFormat, exrFormat } from 'rayzee/addons/formats';

renderer.assetLoader.registerFormat(objFormat, usdFormat, exrFormat);
await renderer.loadFile(objFile);
```

A format of your own registers the same way. A model format's `parse` gets the file and resolves to the model; an
environment format's `createLoader` returns a three.js loader whose `loadAsync` resolves to a texture:

```js
renderer.assetLoader.registerFormat({
  name: 'Point cloud (XYZ)', label: 'XYZ', type: 'model', extensions: ['xyz'],
  async parse(file, { filename }) {
    return { model: buildPoints(await file.text(), filename) };
  },
});
```

**Physical sky**, for `environmentMode: 'procedural'`:

```js
renderer.environmentManager.setProceduralSky(PhysicalSky);
await renderer.environmentManager.setMode('procedural');
```

**Bidirectional path tracing and vertex merging**, for `integrator: 'bidirectional' | 'vcm'`:

```js
renderer.stages.pathTracer.registerIntegrator(['bidirectional', 'vcm'], pt => new BidirectionalIntegrator(pt));
renderer.settings.set('integrator', 'bidirectional');
```

Its controls are on the active integrator (the same on `PathTracerApp`):

```js
const integrator = renderer.stages.pathTracer.activeIntegrator;
integrator.setMergeRadius(1);                        // 'vcm': gather radius in pixels
integrator.setMergeTrust(0.25);                      // 'vcm': how far merging is trusted against the other strategies
integrator.setLightGuiding(true);                    // learn where light paths from the sky and sun start
integrator.setBidirectionalStrategy('connect', { alone: true });  // keep one strategy, for verification
```

**Scene archives** (`.zip`, `.tar`, `.tar.gz`) and the pbrt scenes in them:

```js
renderer.assetLoader.setArchiveImporter(new ArchiveImporter(renderer.assetLoader));
await renderer.loadFile(archiveFile);
```

**OpenColorIO colour management** — configs, their views and looks, working spaces and export spaces. The host supplies
the OCIO runtime (the engine never names the package). Without the add-on, pick a tone mapper on the three.js renderer
instead (`renderer.renderer.toneMapping = AgXToneMapping`):

```js
configureAssets({ ocioRuntimeFactory: () => import('@bb-studio/ocio') });
renderer.setColorManagement(ColorManagement);
await renderer.loadColorConfig({ builtin: 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5' });
```

**On-disk storage** (the browser's origin private file system), for the download, environment and scene caches and
the `memorySpill` option. Asking for it without the add-on (`storage: 'auto'`) records a `capability.missing` warning;
`storage: false` turns it off either way:

```js
const renderer = new RayzeeRenderer(canvas);
renderer.setStorageOpener(acquireSharedStorage);
await renderer.init();
```

Several renderers, core or full, can live in one page; they share only the colour management and the on-disk storage,
which are page-wide.

Code of your own that adds a setting declares it on the renderer's settings, with its default, so it gets the same
provenance, change events and session saving as the built-in ones:

```js
renderer.settings.define('myGlowStrength', { default: 1, apply: (value) => glow.setStrength(value), reset: true });
renderer.settings.set('myGlowStrength', 2);
```

## Troubleshooting

**OIDN: `Cannot find module './tza'` (webpack)**
The `oidn-webgpu` package uses dynamic imports that webpack cannot resolve. This does not affect Vite or other ESM-native bundlers. Add the engine's import of it to your webpack externals:

```js
// webpack.config.js
module.exports = {
  externals: {
    'oidn-webgpu/dist/oidn.js': 'oidn-webgpu/dist/oidn.js'
  }
};
```

Then load it via a script tag or import map instead:

```html
<script type="importmap">
{
  "imports": {
    "oidn-webgpu/dist/oidn.js": "https://cdn.jsdelivr.net/npm/oidn-webgpu@0.6.0/dist/oidn.js"
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

