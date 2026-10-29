# Headless rendering and Node

Reproducible renders, batch rendering, running without a browser, and GPU timing.

## Deterministic & Headless Rendering

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

The RNG is already pure — `hash(pixel, rayIndex, frame)`, no clock, no `Math.random()` in any shader. What varies run to run is *which* uniforms and dispatch grids are live on frame k, so `setDeterministicMode` disables adaptive sampling, per-pixel freeze, the readback-driven per-bounce early exit and GPU-sized dispatch, interaction mode, auto-focus, and auto-exposure, and pins the sampler's seed axis to the accumulation frame. It also forces `renderLimitMode` to `'frames'` — a wall-clock render limit retires at a run-dependent sample count. It leaves the rAF loop stopped; `renderFrames` is the drive.

- `engine.isDeterministic` — whether output is currently bit-reproducible.
- `setDeterministicMode(true, { pinDispatch: false })` keeps the two dispatch heuristics active (GPU-sized dispatch and the readback-driven early exit). Output is then *not* reproducible; this exists so performance measurements reflect shipping behaviour rather than a configuration production never runs.
- `renderFrames` raises `maxSamples` if needed, and throws if something retires the render early.

### Production renders, reproducibly

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
duration `renderUntilComplete` runs those readbacks in **lockstep**: the first, issued at frame 1, is
applied at frame 2, then one issued at frame N (a multiple of 4) at frame N + 4 exactly, and the
render waits if one has not landed; every reset also starts from seed
0 and from nothing the previous render measured. It turns interaction mode off meanwhile (a
wall-clock mode for camera drags), and keeps submissions at most 2 × `drainEvery` frames ahead of
the GPU. A time limit is wall-clock by nature, so that one stop is not reproducible. Auto exposure, if you turn it
on, lands on a metering of the finished image before the closing denoise.

`engine.setLockstepReadbacks(true)` applies the same lockstep to the rAF loop and to `renderFrames`.

### Batch rendering

The supported entry point for a render farm is `rayzee/src/viewer/Headless.js`, exported from the package.
Its defaults are a batch renderer's — `strict`, deterministic, storage off —
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
`denoise: { quality: 'high', tileSize: 2048 }` also picks the model (the default is `'fast'`) and the tile cap: with no
live view to keep smooth, a larger cap is faster for more GPU memory — 1920×1080 as one tile instead of four took 27 %
less time on an M5 Pro. A tile never grows past what the GPU can dispatch (~2000² with its border), whatever the cap.
`renderToBuffer` reports the picture it read as `source`, and records `output.source_fallback` when
`'display'` was asked for, a denoiser is in use, and nothing had published — so a strict host cannot
ship a noisy image by mistake. Its `'srgb'` bytes are tone-mapped on the GPU — 9 ms at 4096×2160,
where the CPU pass it replaced took 1.4 s on an M-series Mac and 10 s on a cloud host — and match the
canvas to within one level (it rounds half a level up); `'linear'` is exact. When the GPU pass is
unavailable or fails, the CPU does it instead: the result's `toneMappedOn` says `'cpu'` rather than
`'gpu'`, and `output.tonemap_fallback` is recorded with the reason.

Constructing `PathTracerApp` yourself instead: pass `strict: true`; storage is then off unless you
set it. Outside Chrome, pass `hostMemoryGB`.

The engine has one set of defaults, the viewer's. For lens-accurate depth of field and glTF placeholder area
lights at their authored power, set `dofMode: 'physical'` and `areaLightIntensityScale: 1` — through `settings`
here, or `engine.settings` before loading the model.

**Provenance.** `engine.getProvenance()` — also `frame.provenance` from `captureHeadless` — is plain
JSON naming what produced the image: engine and three.js versions, the adapter, every live setting with its source, the colour pipeline, the render size and
samples, whether it ran headless, strict, deterministic or lockstepped, and the denoisers (`denoise.live`, and
`denoise.final`: the OIDN tier, weights file, precision and tile). `mode.lockstep` says
whether the current image was traced in lockstep, so it stays true after `renderUntilComplete` turns
lockstep back off. Store it beside each render and "what made this?" has an answer without rendering
again.

**Pinning a look.** A change to what a render looks like when a host sets nothing — a default
setting, a mode preset, light units — is released as a **major**, with the
change described under BREAKING CHANGES in the release notes. Pin a major to pin a look; read the
notes before moving to the next one.

### Running in Node

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
- **`configurePlatform({ Worker, decodeImage, readFile })`** is where a host without a browser supplies what one
  would. `nodePlatform()` from `rayzee/node` fills it: `NodeWorker`, the Web Worker API over
  `worker_threads`, runs the engine's inlined workers; `decodeImage(bytes, mimeType)` is yours — PNG,
  JPEG or WebP to RGBA8, straight alpha, top row first — since the engine carries no decoder. It decodes
  every glTF image, embedded or not, and JPEG/PNG skies. PNGs with bytes after `IEND`, which browsers
  accept and strict decoders refuse, are trimmed first; a texture that still fails is recorded as
  `texture.build_failed` rather than dropped. Without `decodeImage`, each glTF image is recorded that way with what to
  configure (a strict host's load throws), and the model loads untextured. KTX2 (Basis) textures need no
  `decodeImage`: three's KTX2 loader decodes them, in a `NodeWorker` the engine lends it. Measured on a 91-texture model: `sharp` and
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
  memory, and only while they are packed): on the main thread it held up the BVH workers, and a
  1.9M-triangle, 91-texture model loaded in 4.1–4.9 s. It now loads in 2.1 s, against Chrome's 2.9 s
  on the same machine.
- **Offline: OIDN weights from disk.** Node's `fetch` cannot open `file:` URLs, so `nodePlatform()` also hands
  the engine a file reader, and what it downloads itself — the OIDN weights, IES profiles — can come from a folder:
  `configureAssets({ oidnWeightsBaseUrl: 'file:///opt/rayzee/oidn/' })`, holding the `.tza` files the tiers
  name (`rt_hdr_alb_nrm_small`, `rt_hdr_calb_cnrm_small`, `rt_hdr_calb_cnrm`, `rt_hdr_calb_cnrm_large`).
- `nodePlatform()` also defines `ProgressEvent`, which three.js's `FileLoader` constructs while
  streaming; that is the only global it sets. three.js's own Draco and KTX2 loaders call the global
  `Worker`; the engine lends them `NodeWorker` for the length of each glTF parse, so a Draco or KTX2
  model loads with nothing set by the host.

Measured on this bench's corpus: all 29 scenes match the Chrome goldens (`npm run bench:node`, RMSE
≤ 0.0036, no pixel over 0.02 — the readback's tone map accounts for most of it), and a textured glTF with an
HDR or a PNG sky matches Chrome block for block within 0.05 of a level. Not available
without a browser: on-disk storage (OPFS), gobo libraries (they draw on a 2D canvas), and the AI
upscaler.

### GPU timing

```js
engine.enableGPUTiming(true);                       // off by default — the queries themselves cost time
const { compute, render, total } = await engine.getGPUTimings();
const { kernels, unattributed, frame } = await engine.getKernelGPUTimings();
```

WebGPU timestamp queries are the only true GPU metric here — `pipeline.getStats()` times command *encoding* on the CPU and stays flat while GPU cost doubles. Both methods return `null` when the device lacks `timestamp-query` or timing was never enabled.

`getKernelGPUTimings()` attributes each compute pass of the last resolved frame back to a wavefront kernel name. Durations are **summed per kernel across the frame**, so `extend` reports its whole per-frame cost over every bounce iteration, not one bounce. `unattributed` collects passes belonging to no registered kernel (other stages, denoisers), so `sum(kernels) + unattributed` reconciles with `total`.

Neither method can see the OIDN denoise — `oidn-webgpu` submits on its own command encoders, outside
the stages three.js times. It carries its own profiler instead:

```js
engine.profileNextDenoise();                          // arms one capture; per-denoise, not sticky
const { profile, runtime } = await engine.getDenoiseProfile();
```

`profile` is the per-layer GPU timing of that denoise; `runtime` reports the selected engine and
precision, the model, kernel capabilities, tile state and resource counts — which is the way to
confirm FP16 actually engaged on a given GPU rather than inferring it from the device's feature
list. Both need `timestamp-query`, and `getDenoiseProfile()` returns `null` when OIDN is not set up.

