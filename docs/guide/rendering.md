# Rendering

Settings, quality modes, colour, denoising, and saving pictures.

## Settings

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
| `renderLimitMode` | `string` | 'frames' | What else can stop the render: `'frames'` only `maxSamples`; `'time'` `maxSamples` or `renderTimeLimit`, whichever comes first; `'timeOnly'` only `renderTimeLimit` (`maxSamples` is ignored while the limit is above 0). Convergence (`useAdaptiveSampling`) can stop it in every mode |
| `renderTimeLimit` | `number` | 30 | Seconds of rendering before the time limit stops it, in `'time'` and `'timeOnly'`; `0` turns the limit off. Raising it after it stopped a render continues that render, unless another limit has been reached |
| `exposure` | `number` | 1.0 | Exposure value |
| `saturation` | `number` | 1.0 | Color saturation (1 = no grade) |
| `enableEnvironment` | `boolean` | true | Use environment lighting |
| `environmentIntensity` | `number` | 1.0 | Environment light strength |
| `environmentRotation` | `number` | 0 | Environment Y-rotation (degrees); 0 shows the HDRI as authored, as Blender's unmapped world does |
| `areaLightIntensityScale` | `number` | 0.1 | Power of a glTF model's placeholder area lights (RectAreaLight extras), read when the model loads, so set it first; 1 is the authored power |
| `maxTextureSize` | `number` | 4096 | Longest edge of a material texture, read when a model loads (clamped to the hardware ceiling); `setMaxTextureSize()` applies it to the current scene too |
| `wavefrontSortMaterials` | `boolean` | true | Sort rays by material before shading, above 8 materials; read when the shaders next build |
| `showBackground` | `boolean` | true | Show the environment as a visible backdrop for camera-miss rays (vs. a solid/transparent background) |
| `samplingTechnique` | `number` | 2 | Sampler: `0` PCG, `1` scrambled Halton, `2` Owen-scrambled Sobol |
| `integrator` | `string` | 'path' | `'path'` \| `'bidirectional'` \| `'vcm'` (on the core, needs the bidirectional add-on). Bidirectional also traces light subpaths from every light — emissive surfaces, rect/disk, point, spot and directional lights, the sun and the environment — far faster for caustics and light through small openings, about 2× the cost per sample. On a lamp-lit interior with an HDRI it is ~20 % less noisy at equal time; a room lit only through a window stays better path traced. `'vcm'` adds photon merging, for caustics seen in mirrors and through glass. Switching rebuilds the kernels |
| `fireflyThreshold` | `number` | 3.0 | Firefly clamping threshold |
| `shadowTerminatorOffset` | `number` | 0.1 | Cycles' Shadow Terminator → Geometry Offset: near the light's terminator on a smooth-shaded low-poly mesh, light and environment shadow rays start on the smooth surface the vertex normals describe, not the flat facet. Blender's default; `0` disables |
| `fogDensity` | `number` | 0 | Fog: how much light it stops per scene unit (extinction). `0` is no fog and compiles it out. See [Fog](#fog) |
| `fogColor` | `string` | '#ffffff' | The colour the fog scatters (its albedo); the rest of what it stops is absorbed |
| `fogAnisotropy` | `number` | 0 | Henyey–Greenstein `g`, −0.95…0.95: above 0 the fog scatters forward, so beams look brighter facing the light |
| `fogBounds` | `{min, max}` \| `null` | null | The box the fog fills, as `{ min: [x, y, z], max: [x, y, z] }`; `null` fills the loaded models' bounds (`getModelBounds()`) |
| `fogHeightFalloff` | `number` | 0 | Per scene unit: above `fogFloor` the density falls as `e^(−falloff · height)`, so the fog lies low; `0` is even fog |
| `fogFloor` | `number` \| `null` | null | The height the falloff starts from, full density below it; `null` is the loaded models' floor |
| `transmissiveBounces` | `number` | 5 | Max bounces for transmissive materials |
| `maxSubsurfaceSteps` | `number` | 8 | Max random-walk steps for subsurface scattering (raised to 64 by `configureForMode('production')`) |
| `enableAlphaShadows` | `boolean` | false | Alpha-tested shadow rays (enabled by `configureForMode('production')`) |
| `enableDOF` | `boolean` | false | Enable depth of field |
| `dofMode` | `string` | 'look' | `'look'`: the blur is set by `dofBlur`, the same at any scene scale; `'physical'`: a real lens set by `aperture`, `focalLength` and `unitsPerMetre`. |
| `dofBlur` | `number` | 0.05 | Look mode: how far a distant background blurs, as a fraction of the image height |
| `focusDistance` | `number` | 0.8 | DOF focus distance in scene units — depth along the view axis (the focal plane is flat) |
| `aperture` | `number` | 5.6 | Physical mode: f-stop |
| `focalLength` | `number` | 50 | Physical mode: focal length (mm) |
| `unitsPerMetre` | `number` | 1 | Physical mode: scene units per real metre, for files whose units are not metres. It carries over between model loads — reset it when the new file's units differ |
| `transparentBackground` | `boolean` | false | Transparent canvas background |
| `interactionModeEnabled` | `boolean` | true | Render at lower resolution while the camera moves, keeping the full bounce budget ("Fast Navigation" in the app) |
| `interactionRenderScale` | `number` | 0.5 | Per-axis render scale while the camera moves (0.5 = a quarter of the pixels); `1` turns the drop off. Ignored while OIDN is the live denoiser. `PathTracerApp` only |
| `renderMode` | `number` | 0 | Internal preview(0)/production(1) flag driving accumulation & denoiser history — normally set via `configureForMode()`, not written directly |
| `visMode` | `number` | 0 | Debug visualization mode (0 = off) |
| `environmentMode` | `string` | 'hdri' | Sky mode: `'hdri'` \| `'procedural'` \| `'color'` — not routed through `engine.settings`; use `engine.environmentManager.setMode()` instead |
| `cameraProjection` | `string` | 'perspective' | `'perspective'` \| `'orthographic'` \| `'equirectangular'` — see [Camera Projection](scenes.md#camera-projection-orthographic-360-panorama) |
| `panoramaLonRange` | `[number, number]` | `[-180, 180]` | Panorama longitude sweep, degrees, left→right |
| `panoramaLatRange` | `[number, number]` | `[-90, 90]` | Panorama latitude sweep, degrees, bottom→top |
| `panoramaLevelHorizon` | `boolean` | true | Yaw-only panorama basis, so orbit pitch/roll can't tilt the horizon |
| `useAdaptiveSampling` | `boolean` | true | Whole-frame early-stop once convergence reaches `adaptiveStopFraction` |
| `noiseThreshold` | `number` | 0.1 | √-luminance-normalized per-pixel noise below which a pixel counts as converged (the production preset uses 0.02) |
| `adaptiveMinSamples` | `number` | 8 | Minimum samples before adaptive sampling can trigger |
| `adaptiveStopFraction` | `number` | 0.90 | Fraction of pixels that must converge before the frame retires (the production preset uses 0.94) |
| `usePixelFreeze` | `boolean` | true | Per-pixel freeze (Tier-2): skip individually-converged pixels via active-list compaction |
| `pixelFreezeThreshold` | `number` | 0.02 | Relative-error threshold for a pixel to become a freeze candidate |
| `pixelFreezeStability` | `number` | 8 | Consecutive candidate frames required before a pixel freezes |

See `ENGINE_DEFAULTS` for the full list with default values — every key in it is a setting of the same name. The default look is AgX (`DEFAULT_VIEW`) at neutral saturation; tone mapping is chosen through [Colour Management](#colour-management) (`engine.color.setActiveView( id )`), not `settings`. On the core without the colour add-on, set `renderer.renderer.toneMapping`.

## Fog

A haze in a box, lit by everything in the scene — the sky and the sun from outside it too, so light coming through a
window shows as a beam. Even, or thinning with height into a mist that lies on the ground. Path integrator only: under
`'bidirectional'` or `'vcm'` it is left out and `setting.ignored` is recorded.

```js
engine.settings.setMany({ fogDensity: 0.1, fogColor: '#fff4e6', fogAnisotropy: 0.4 })
```

- **Density is per scene unit.** A density `d` lets `e^(−d·x)` of the light through `x` units of fog, so `0.1` in a
  6 m room stops about half the light crossing it. Scale it with the scene: `getModelBounds()` gives its size.
- **The box.** By default the fog fills the loaded models' bounds (the auto-created ground plane is left out), which is
  right for a room seen from inside. Seen from outside, a box shows its edges: give an object a `fogBounds` that holds
  the camera too. The app does this itself — a room is filled to its bounds, an object gets a cube around it and the
  camera.
- **Height.** `fogHeightFalloff` thins the fog above `fogFloor` (by default the models' floor): the density halves every
  `0.693 / falloff` units up, and below the floor it stays at `fogDensity`. A room 3 units high with a falloff of `0.77`
  keeps a tenth of its floor's density at the ceiling. Changing it needs no shader rebuild.

  ```js
  engine.settings.setMany({ fogDensity: 0.5, fogHeightFalloff: 2 })   // mist lying on the ground
  ```

- **Lights.** Point and spot lights, and glowing surfaces while `enableEmissiveTriangleSampling` is on, light the fog
  along every ray through it (equiangular sampling), so a spot's cone and the halo of a small bright bulb converge
  quickly; the sun, the sky and rect lights light it at scatter points, weighed against the phase function. With
  `shadowRays` `'two'` or `'one'` the fog traces as few shadow rays as a surface does.
- **Cost.** Turning it on rebuilds the shaders once. On a sunlit room with a spot light and a glowing ball it took
  about half again the GPU time a sample (M-series, 512²); off, every shader is exactly as without the feature.
  Thinning with height costs nothing measurable.
- Fog is not drawn inside glass or subsurface objects, and the ground-plane shadow catcher ignores it.

## Rendering Modes

```js
engine.configureForMode('production')   // High quality (full-frame, 20 bounces, OIDN, controls disabled)
engine.configureForMode('interactive')  // Real-time navigation (3 bounces, controls enabled)
```

To pause rendering for image-viewing UI, set `engine.pauseRendering = true` and disable camera controls directly — the engine doesn't model viewport visibility.

---

## Colour Management

On `rayzee/core` this is the `rayzee/addons/color` add-on — see [Renderer core](getting-started.md#renderer-core-rayzeecore).

`engine.color` is an OpenColorIO pipeline: what textures and lights mean, what the render happens in, and what it is shown and saved as. **It is inert until a config is loaded** — the render stays linear Rec.709 and the view transforms are three.js's own seven, so a host that never loads one sees no change. The host supplies the runtime (`ocioRuntimeFactory` or `ocioRuntimeUrl` in [`configureAssets`](getting-started.md#configuring-assets-cdn-urls--cache-namespace)).

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
- A view is baked to a log2 shaper and a 65³ table, interpolated tetrahedrally — where that measures poorly, on linear Rec.709's axes and at 97³, whichever is closer (`entry.error` says what it cost); the same table drives the canvas, the GPU and CPU readbacks and the menu (`listViewTransforms()`, `onRegistryChange()`). An OCIO view returns display-encoded colour, so the engine switches the output pass to linear while one is active.
- **Baked views.** `await engine.color.saveBakedView(id)` writes a view's table to a file (157 KB gzip for 65³, 426 KB for 97³), and `await engine.color.loadBakedView(bytes, { expect })` registers it with no runtime and no config — show the look on the first frame, load the config later. When that config loads, a baked view whose files match the fingerprint it was baked from is kept as is: no rebake, no new id, no restart.
- `renderToBuffer({ colorSpace })` takes `'srgb'` (display bytes through the active view), `'linear'` (the working-space accumulation) or a config colour space; `source: 'display'` reads what the viewport shows, denoised, instead of the raw accumulation.
- Degradations (a view that cannot bake, a display the canvas cannot show) are recorded as warnings in the [degradation contract](api.md#degradation-contract).

## engine.denoisingManager

Denoiser strategy, NRD, OIDN, upscaler, and auto-exposure. Auto exposure meters the accumulated image on the GPU
and moves in stops; it follows a room level learned as the camera moves plus a damped share of each view, so a scene lit
for its manual exposure stays near it while one lit far off is corrected in full. It eases while the image restarts
every frame (a moving camera, playback) and lands within about a third of a second once the image builds up, so a
finished render shows its own exposure at any sample count. While it is on, `exposure` is its compensation.

```js
// Strategy
engine.denoisingManager.setStrategy('nrd', 'medium')    // DENOISER_STRATEGIES: 'none' | 'nrd' | 'oidn'
engine.denoisingManager.denoiserStrategy                 // read back the active strategy (derived from stage state)
engine.denoisingManager.applyNRDPreset('high')           // 'low' | 'medium' | 'high'
engine.denoisingManager.setAutoExposure(true)

// Fine-grained parameters
engine.denoisingManager.setNRDParams({ maxAccumulatedFrameNum: 16, maxBlurRadius: 20 })
engine.denoisingManager.setAutoExposureParams({
  strength: 0.3,           // 0..1, how far it follows each view; 1 averages every view to middle grey
  metering: 'center',      // 'average' | 'center' | 'spot' (at the auto-focus point)
  minExposure: 2 ** -8,    // how far it may go from the manual exposure (default ±8 stops)
  maxExposure: 2 ** 8,
  keyValue: 0.18,          // the grey it aims the average at
})

// OIDN & Upscaler
engine.denoisingManager.setOIDNEnabled(true)
engine.denoisingManager.setOIDNQuality('high')
engine.denoisingManager.setStrategy('oidn')              // OIDN owns the live view; see below
engine.denoisingManager.setTemporalHistory(false)        // live OIDN without the motion history (default on)
engine.denoisingManager.continuousDenoiseInterval = 250   // cap refreshes at 4/sec (default 8 = uncapped)
engine.denoisingManager.setUpscalerEnabled(true)
engine.denoisingManager.setUpscalerScaleFactor(2)         // 2 or 4
engine.denoisingManager.setUpscalerQuality('quality')     // 'fast' | 'balanced' | 'quality'
```

## Local exposure

Unreal Engine 5's local exposure: brings large bright (and, if asked, dark) areas toward middle grey while keeping their
detail. It changes only what is shown — the canvas, `renderToBuffer( { colorSpace: 'srgb' } )`, the AI upscaler and the
neural passes apply the same per-pixel gain; EXR and `'linear'` reads stay scene-referred. Off by default.

```js
engine.setLocalExposure(true)
engine.setLocalExposureParams({
  highlightContrast: 0.6,  // contrast of the base layer above middle grey; 1 = unchanged
  shadowContrast: 1,       // below middle grey; < 1 lifts shadows
  detailStrength: 1,       // contrast of detail within the base layer
})
```

## Output Methods

Canvas output, screenshots, saved files and scene statistics — accessed as direct methods on the engine.

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

### Saving a file

`exportImage()` writes the render as a file and returns `{ blob, extension, mimeType, width, height, colorSpace, … }`.
It works on the core too, and headless.

| `format` | What the file holds |
|---|---|
| `'png'` (`bitDepth: 8` or `16`), `'jpeg'`, `'webp'` | the picture the canvas shows: exposure, view and denoising applied; at 8 bits, JPEG and WebP, the AI upscaler's picture while one shows (`upscaled: false` skips it) |
| `'heic'`, `'avif'` | the same picture, written by the browser's video encoder |
| `'exr'` (`precision: 'half'` or `'float'`), `'hdr'` (Radiance) | the light itself, before exposure and view, in the working space or `colorSpace`; with `asShown: true`, the light the screen gives off for the picture, so any viewer shows it as the screen does |

```js
const { blob, extension } = await engine.exportImage({ format: 'png', bitDepth: 16 });
const exr = await engine.exportImage({ format: 'exr', passes: ['albedo', 'normal', 'depth'] });
const photo = await engine.exportImage({ format: 'jpeg', gainMap: true });   // an HDR photo
engine.exportInfo();   // what can be written now: { width, height, upscaled, hdr, layers: { albedo, normal, depth } }
```

- **HDR photos.** `gainMap: true` on `'jpeg'`, `'heic'` or `'avif'` adds a gain map — a second, small picture that
  says how much brighter each part of the HDR version is (ISO 21496-1; Ultra HDR in a JPEG). Photo viewers that read gain
  maps show the file in HDR, others the normal picture. It needs the screen showing HDR
  (`engine.color.setHdrOutput(true)` on an HDR display; `exportInfo().hdr`).
- **EXR layers.** `albedo` and `normal` are the denoisers' guide images, so they exist only while a denoiser is on;
  `depth` is measured when asked for. A layer that cannot be written records `output.pass_unavailable`.
- **Where each works.** JPEG, WebP, HEIC and AVIF need a browser (its canvas or video encoder); PNG, EXR and HDR work in
  Node too. `canEncodeStill('heic')` from `rayzee/encoders` says whether this browser can write HEIC or AVIF.
- Render details (samples, size, view, settings, versions) go into the file, except a WebP, unless `metadata: false`.
  An EXR's also say how its picture was shown (the exposure, auto exposure's included, local exposure and a held
  backdrop). The file writers download on the first export, not at startup.
- **Showing a saved EXR again.** `await engine.createPictureView(canvas)` (the viewer, `PathTracerApp`) gives a
  picture view on a canvas of your own; `await view.show(exrBlob)` draws the raw EXR exactly as an HDR screen showed it,
  through the same view, exposure and local exposure, and returns `{ shown, reason }` (`reason`: the screen shows no HDR,
  the file has no such details, its colour config is not the one loaded, or a later `show()` took over). It reads the
  file's header first and decodes the pixels only of a file it shows. `view.setGrade(fn)` adds your own edit after
  the view, a TSL function of the shown colour; `view.redraw()` after its uniforms change; `view.dispose()`.

The writers are also a module of their own, `rayzee/encoders`, for pixels a host already has. It is part of the
package, not an add-on: nothing to install, and importing it loads nothing else (9 KB compressed).

```js
import { encodePNG, encodeEXR, encodeHDR, IMAGE_FORMATS } from 'rayzee/encoders';

const png = await encodePNG({ data, width, height });   // RGBA, Uint8Array (8 bits) or Uint16Array (16), top row first
const hdr = await encodeHDR({ data: floats, width, height });   // RGBA Float32Array
const exr = await encodeEXR({ width, height, channels: [
  { name: 'R', data: floats, stride: 4, offset: 0 },
  { name: 'G', data: floats, stride: 4, offset: 1 },
  { name: 'B', data: floats, stride: 4, offset: 2 },
] });
```

Chrome on macOS takes about 5 seconds to start its first hardware video encoder after the browser launches, and about
2 ms after that. HEIC and MP4 both use it. `prepareStill('heic')` starts it ahead of time without encoding anything,
for example when an export menu opens.

---

## Render Resolution Reserve

The *reserve* is the largest render the engine accepts, one square dimension: `setCanvasSize()` refuses anything larger, and the per-pixel buffers (12 bytes a pixel) are allocated at it. The textures follow the render size, so a raised reserve costs only those buffers until a render that large runs. The default is 2048, so 4K output needs the reserve raised first.

```js
engine.setReservedRenderResolution(4096)          // raise to 4K (longest edge)
engine.setReservedRenderResolution(2048, { allowLower: true })   // lower, paying a rebuild, to reclaim VRAM
engine.getReservedRenderResolution()              // the reserve actually in force
```

The request is **device-capped**: a 4K render holds roughly 1.5 GB of MRT textures, so a 4096 reserve is only granted on hosts reporting ≥ 8 GB and a ≥ 1 GB `maxStorageBufferBindingSize`; weaker devices clamp to 2048, recorded as `render.reserve_capped`. The memory figure is `options.hostMemoryGB`, else `navigator.deviceMemory`, else an assumed 4 — so outside Chrome, pass it. `MAX_RESERVABLE_RENDER_SIZE` (4096) is the ceiling on any request.

Raises are monotonic unless you pass `allowLower` — UI-driven callers ask for whatever the current view needs, and honouring every decrease made the reserve oscillate across preview↔render switches, paying a full kernel rebuild each time.

Callable at any point in the lifecycle:

- **Before `init()`** — recorded and applied during `init()`, after the device exists but before the stages are constructed, so they allocate at the raised size directly. The device gate cannot run without a device, so the return value here is the *request*, not the verdict.
- **After `init()`** — applied immediately, rebuilding the per-pixel buffers in place once a scene has built them.

Either way the verdict arrives as `EngineEvents.RESERVED_RENDER_SIZE_CHANGED`:

```js
engine.addEventListener(EngineEvents.RESERVED_RENDER_SIZE_CHANGED, e => console.log('reserve:', e.size));
engine.setReservedRenderResolution(4096);
await engine.init();
console.log(engine.getReservedRenderResolution());   // 4096, or 2048 if the device declined
```

---

## Optional Dependencies

| Package | Purpose | Install needed? |
|---|---|---|
| `oidn-webgpu` | Intel Open Image Denoise for high-quality final renders | Yes — `npm install oidn-webgpu` (**>=0.6.0**; it was `oidn-web` up to 0.5.0) |
| `onnxruntime-web` | AI-powered upscaling | No — loaded from CDN at runtime |
| `@bb-studio/ocio` | OpenColorIO runtime for [Colour Management](#colour-management) (~6 MB WebAssembly) | Only to load colour configs — `npm install @bb-studio/ocio`, then pass it as `ocioRuntimeFactory` |

> **Note:** `onnxruntime-web` is also listed in `package.json` under `optionalDependencies` for bundler compatibility, but the engine's own runtime path always fetches it from a CDN (see `ortRuntimeUrl` / `ortWasmPaths` in [Configuring Assets](getting-started.md#configuring-assets-cdn-urls--cache-namespace)) rather than importing the installed package — installing it locally has no effect unless you also override those URLs to point at your own copy.

### Enabling OIDN (Intel Open Image Denoise)

OIDN provides high-quality AI denoising. It runs automatically once the render converges (reaches
`maxSamples`), and — in `'interactive'` mode — also on a cadence while the image is still
accumulating, so a preview shows a clean picture as it refines instead of only at the end. See
[When the denoiser runs](#when-the-denoiser-runs).

1. **Install the package**

   ```bash
   npm install oidn-webgpu
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
engine.denoisingManager.setStrategy('oidn');    // 'none' | 'nrd' | 'oidn'
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
| `'nrd'` | `false` | NRD | NRD, then raw once it hands over | NRD's last frame, or raw past the handover |
| `'nrd'` | `true` | NRD | NRD, then raw once it hands over | OIDN |
| `'oidn'` | `false` | OIDN, from the motion history | OIDN, refreshing | one last refresh |
| `'oidn'` | `true` | OIDN, from the motion history | OIDN, refreshing | OIDN, full quality |

`denoiser.enabled` is the union of the two — "OIDN is in use at all", which is what the aux G-buffer
wiring needs — so read the two decisions back from `denoisingManager.denoiserStrategy` and
`denoisingManager.finalDenoise`, not from it.

With OIDN on the live view and the final pass off, the render still closes with one more refresh: the
cadence's last tick lands short of the end, and the picture should match the render that finished. On
a 150-sample render that gap measured **11 samples at 512²** and **1 at 1024²** — larger where the
renderer is fast, because more samples land between refreshes. It uses whatever model the refreshes
were already on: no reload for an image the user never asked to be denoised at full quality. A final render
(`configureForMode( 'production' )`) has no live view to match, so with the final pass off it finishes undenoised.

In the app that is `Real-Time Denoiser` (None / NRD / **OIDN (AI)**, OIDN by default) and the
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
  view moves, back for the finished image). A swap costs 10–50 ms on oidn-webgpu 0.6.0 (the large model the most), and each model's
  weights are downloaded once and kept, so a swap never goes back to the network. Nothing is downloaded
  until OIDN is first switched on (as the live denoiser or for the finished image).

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
`engine.denoisingManager.denoiser.updateConfiguration({ tileSize: 2048 })`: a frame no larger in area than
`tileSize`² is one tile, a larger one is split into tiles of at most `tileSize`, and no tile grows past what the GPU
can dispatch (about 2000² with its border and overlap) — past that the denoise would silently do nothing.

> **Note:** The neural network model is downloaded on first use. Subsequent runs use the browser cache. OIDN also works with `configureForMode('production')`, which enables it automatically alongside high-quality render settings.

### Enabling the AI Upscaler

The upscaler runs ONNX super-resolution models via `onnxruntime-web`. Unlike OIDN, `onnxruntime-web` is lazily fetched from a CDN inside a Web Worker — **no npm install or import map entry is needed**.

```js
engine.denoisingManager.setUpscalerEnabled(true);
engine.denoisingManager.setUpscalerQuality('fast');      // 'fast' | 'balanced' | 'quality'
engine.denoisingManager.setUpscalerScaleFactor(2);       // 2 | 4

engine.addEventListener(EngineEvents.UPSCALING_START,    () => console.log('Upscaling started'));
engine.addEventListener(EngineEvents.UPSCALING_PROGRESS, (e) => console.log('Upscaling', e.progress, e.secondsLeft));
engine.addEventListener(EngineEvents.UPSCALING_END,      () => console.log('Upscaling complete'));
```

`UPSCALING_PROGRESS` fires once a tile: `progress` is the share done (0–1) and `secondsLeft` the time the tiles still
to go should take, from the tiles done so far. It is `null` until two tiles are done: the first carries the model's
warm-up.

| Quality | Model | 2× size | 4× size |
|---|---|---|---|
| `'fast'` | SPAN | 1.6 MB | 1.6 MB |
| `'balanced'` | SRVGGNetCompact | 2.4 MB | 4.9 MB |
| `'quality'` | RRDBNet / MoSR | 67 MB | 16.5 MB |

**Chaining with OIDN:** Upscaling and OIDN **can** run together — on render completion, OIDN runs first, then its denoised output is fed into the upscaler. Enable both; no manual coordination required.

