# API: events, issues and exports

Events, the degradation contract, logging, custom pipeline stages, and every export.

## Events

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
| `SHADERS_COMPILING` | The path tracer compiles its shaders in the background (`event.compiling` true, then false) — after a model load, a new material layer, a light transport switch. The page stays responsive; the canvas keeps its last frame until they are ready, and `renderFrames()` waits for them |
| `RENDER_RESET` | Accumulation buffer is reset |
| `FRAME` | Fires once per `animate()` tick — hook external instrumentation (stats panels, telemetry) here |
| `DENOISING_START` / `DENOISING_END` | Denoiser runs. `event.continuous` is `true` for a cadence denoise of the still-accumulating image, `false` for the one that ends a render |
| `DENOISER_LOADING` | The denoiser fetches and builds a network (`event.loading` true, then false) — on first use and on a quality change. A denoise asked for meanwhile starts once it is ready |
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
| `AUTO_EXPOSURE_UPDATED` | Auto exposure moved — `exposure` (applied, with the manual exposure), `autoExposure` (its own part), `targetExposure`, `luminance` (metered) |
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

## Degradation contract

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
| `asset.parameters_ignored` | a pbrt scene sets parameters the loader ignores (`detail.unused`) or only approximates (`detail.approximated`), each `directive type: name` with how many directives set it — a warning |
| `texture.build_failed` / `texture.processing_fallback` / `texture.limit_exceeded` | a texture could not be built, fell back to a slower path, or exceeded the per-map-type cap |
| `environment.load_failed` | the environment map failed to load |
| `setting.unknown_key` | a setting name reached no stage — how a typo becomes a wrong image |
| `render.size_declined` / `render.reserve_capped` | the requested render size or reserve exceeded device limits |
| `stage.render_failed` | a pipeline stage threw (recorded once per stage and phase) |
| `scene.memory_budget` | the scene needs more CPU memory than is safe, or more than is possible |
| `emissive.instances_collapsed` | an emissive instanced mesh was too large to expand, so its copies light the scene as one |
| `refit.shared_geometry` | a deform was asked for on a mesh that shares its triangles, and was skipped |
| `denoiser.unavailable` | a requested denoise or upscale produced nothing — the denoiser was not built, OIDN was off while accumulating, or the pass needs a canvas in a document |
| `denoiser.non_finite_input` | the render handed OIDN NaN or infinite pixels (`detail.color` / `albedo` / `normal`: how many), which were treated as zero — a warning, recorded again only after a clean frame |
| `output.source_fallback` | `renderToBuffer( { source: 'display' } )` found no denoised picture and returned the raw accumulation |
| `output.tonemap_fallback` | `renderToBuffer`'s `'srgb'` bytes were tone-mapped on the CPU, not the GPU — the picture is the same within a level, only slower (a warning: strict does not throw) |
| `output.pass_unavailable` | `exportImage` was asked for an EXR layer it cannot write, such as `albedo` or `normal` with no denoiser on (`detail.pass`); the file is written without it |
| `light.placeholder_skipped` | a `RectAreaLightPlaceholder` node lacked `userData.name` or `userData.type: 'RectAreaLight'`, so no light was made for it |
| `capability.missing` | a feature was asked for whose add-on is not installed on the core (procedural sky, an unregistered integrator, a colour config, storage) — names the add-on |
| `color.config_load_failed` / `viewTransform.bake_failed` / `viewTransform.display_mismatch` | a colour config failed to load (the previous one stays), a view could not be rebaked, or a view targets a display the canvas cannot show (a saved buffer is still right) — warnings |
| `storage.unavailable` / `storage.quota_exceeded` / `storage.write_failed` / `storage.read_failed` / `storage.entry_corrupt` / `storage.cache_mismatch` | on-disk storage is off or failed; the engine carries on in memory — warnings |

`asset.unreachable` also covers what the engine fetches for itself: OIDN weights, IES profiles and
gobos (`detail.asset` says which).

`init()` cannot degrade past a missing GPU, so these three always reject it with an
`EngineIssueError`, strict or not, and are recorded too. `error.cause` is the WebGPU error, when there was one:

| Code | Raised when |
|---|---|
| `webgpu.unavailable` | there is no `navigator.gpu`, or three.js could start only WebGL2 on the canvas |
| `adapter.unavailable` | `requestAdapter()` returned no adapter or rejected — no GPU, or no driver for it |
| `device.unavailable` | the adapter was found but `requestDevice()` rejected |

```js
try { await engine.init(); } catch (error) { metrics.failure = error.code ?? 'unknown'; }
```

`settings.getEffective()` is the companion for the `setting.unknown_key` case: it returns every live
setting as `{ value, source, routed }`, and `routed: false` means stored but reaching no stage.

---

## Logging

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

## Advanced: Custom Pipeline Stages

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

To run between the path tracer and the compositor, subclass the renderer and return the stage from
`_createExtraStages()` (call the parent's and add yours); for the compositor to show its picture, list
`'my-stage:output'` in `_displaySources()`. `pipeline.addStage()` after `init()` appends after the
compositor. A stage that needs an extra path-tracer output asks for it with
`stages.pathTracer.requestOutput( name, options )` — `'gBuffer'` (the normal/depth and albedo a denoiser reads; the
viewer asks for it itself) or `'hitDistance'`. Each is compiled into the path tracer only while asked for.

## All Exports

```js
// The full engine (it also exports RayzeeRenderer)
import { PathTracerApp, EngineEvents, LEGACY_EVENT_NAMES } from 'rayzee';

// The renderer core and its add-ons (see Renderer core)
import { RayzeeRenderer } from 'rayzee/core';
import { PhysicalSky } from 'rayzee/addons/physical-sky';
import { ArchiveImporter } from 'rayzee/addons/archives';
import { BidirectionalIntegrator } from 'rayzee/addons/bidirectional';
import { ColorManagement } from 'rayzee/addons/color';
import { acquireSharedStorage } from 'rayzee/addons/storage';

// Headless rendering (see Deterministic & Headless Rendering)
import { renderHeadless, openHeadless, captureHeadless } from 'rayzee';

// File writers behind exportImage(), for pixels a host already has (see Saving a file)
import {
  IMAGE_FORMATS, encodePNG, encodeEXR, encodeHDR, encodeWithCanvas, encodeGainMapJPEG,
  encodeStill, canEncodeStill, prepareStill,
} from 'rayzee/encoders';

// Platform services for hosts without a browser (see Running in Node)
import { configurePlatform, getPlatform } from 'rayzee';
import { nodePlatform, NodeWorker } from 'rayzee/node';

// Configuration & presets
import {
  ENGINE_DEFAULTS,
  DENOISER_DEFAULTS,
  AUTO_EXPOSURE_DEFAULTS,
  LOCAL_EXPOSURE_DEFAULTS,
  AUTO_FOCUS_DEFAULTS,
  DENOISER_STRATEGIES,
  SKY_DEFAULTS,
  DEFAULT_SUN_PATH,
  DEFAULT_VIEW,
  TRIANGLE_DATA_LAYOUT,
  BVH_LEAF_MARKERS,
  PRODUCTION_RENDER_CONFIG,
  INTERACTIVE_RENDER_CONFIG,
  MAX_RESERVABLE_RENDER_SIZE,
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

