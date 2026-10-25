# Headless rendering, inside

How the offline and reproducible rendering API works: deterministic mode, `renderFrames`, readbacks, the exporters,
lockstep readbacks, provenance, background kernel compiles and GPU timing. How to use it is in
[docs/guide/headless.md](../guide/headless.md); CLAUDE.md keeps the rules.

Public renderer methods for offline rendering and reproducible output — on `RayzeeRenderer`, so the core has them too, except `runFinalDenoise()`, which is the viewer's:
- **`app.setDeterministicMode( enabled = true )`** — pins every wall-clock- and readback-dependent
  input so N samples reproduce bit-for-bit. The RNG is already pure (`hash(pixel, rayIndex, frame)`,
  no clock, no `Math.random()` in any shader); what varies is *which uniforms and dispatch grids are
  live on frame k*. Disables adaptive sampling, pixel freeze, the readback-driven per-bounce early
  exit and GPU-sized dispatch (bounces then run full grids over the identity list), interaction mode,
  auto-focus and auto-exposure. Reversible; leaves rAF stopped.
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
  L4's host. The two differ by one level on ~0.002 % of bytes; a fall back to the CPU sets the result's
  `toneMappedOn: 'cpu'` and records `output.tonemap_fallback` (a warning — strict does not throw). `source: 'accumulation'` (default) reads
  `pathtracer:color`, upstream of the Compositor; `source: 'display'` reads what the Compositor
  resolves (denoised). The result's `source` names what was read, and a `'display'` read
  that found nothing denoised while a denoiser is in use records `output.source_fallback`.
- **`await app.exportImage( { format, bitDepth, quality, precision, colorSpace, passes, source, upscaled, alpha, metadata } )`**
  — the picture as a file (`{ blob, extension, mimeType, colorSpace, passes, … }`). PNG (8 or 16 bits: `renderToBuffer(
  { bitDepth: 16 } )`, the tone mappers' `rgba16` output), JPEG and WebP hold the canvas's picture (the upscaler's while it
  shows, `upscaled`); OpenEXR (half/float, ZIP) and Radiance HDR hold the light, in the working space or `colorSpace`
  (default `color.exportSpace`) — or with `asShown` (the app's default, "As on screen") the light the screen emits for
  the picture: the view's output decoded to linear in the canvas primaries (tone mappers' `displayLinear` output), or
  while the canvas shows an HDR version, that version (`compositor.renderShown()` into a float target), highlights above
  1 kept. Viewers only apply their own curve to raw light, which is why a raw file never looked like the screen.
  Photo viewers (macOS Preview, Quick Look) show EXR and Radiance HDR in normal range anyway; what they show in HDR is a
  gain map. `gainMap: true` on jpeg, heic or avif (needs the screen showing HDR, `exportInfo().hdr`) writes the SDR
  picture plus a log2 gain to the HDR version (ISO 21496-1 parameters, one set for three channels, offsets 1/64):
  `jpegWithGainMap` lays it out as libultrahdr (XMP hdrgm + ISO version, MPF before SOS, gain map with XMP + ISO),
  `heifFile` as libavif ('tmap' item, dimg → [picture, gain map], 'altr' group [tmap, picture], 'tmap' brand). HEIC and
  AVIF are one keyframe from WebCodecs (HEVC, AV1; 8-bit, quantizer mode; the RGBA frame labelled Rec.709 so no gamut
  conversion runs; AV1's av1C built from its sequence header, temporal delimiters dropped). macOS 26's ImageIO reads
  all three as ISO gain maps and CoreImage's `expandToHDR` matches the app's HDR picture within 3–4 % (compression).
  ⚠️ Chrome (macOS) starts its first hardware video encoder of a browser launch in ~5 s, HEVC or H.264 alike, then in
  ~2 ms (Apple's own: 60 ms); an encoder asked for meanwhile waits only for the rest, and nothing stalls. The Export window
  starts one on open (`prepareStill( 'heic' )`, 64×64, nothing encoded): first HDR HEIC 4.9 s → 0.12 s. Writers in
  `output/ImageEncoders.js`, loaded on first use and published alone as `rayzee/encoders` (core, not an add-on); a
  re-export from `index.js` had put them in every host's startup download (app: 1,108 → 1,099 KB gzip). PNG, EXR and
  RGBE are our own over `CompressionStream`, paced so no task passes ~30 ms; JPEG/WebP go through `OffscreenCanvas` (not in
  Node). EXR layers: `albedo`/`normal` are the denoisers' accumulated aux buffers (`stage.readAuxBuffers()`, only while
  aux is on, else `output.pass_unavailable`); `depth` is measured on demand by `shaders/kernels/DepthPass.js` — one unjittered ray a
  pixel centre, past culled faces and alpha cut-outs, view-axis distance, 1e10 for sky, always float. A Display P3 PNG
  carries cICP and a generated ICC v4 profile; EXR/HDR record chromaticities, snapped to the standard gamut
  (`standardChromaticities`) since OCIO reports them adapted to D65. Render details go in as PNG iTXt / EXR attributes
  (provenance without scene or adapter). `exportInfo()` says what can be written now. `bench:node` runs
  `bench/tools/export-check.mjs`, which reads every file back. ⚠️ In TSL an arrow `() => Break()` emits `break;` twice.
- **`await app.renderUntilComplete( { reset, denoise, signal, drainEvery, onProgress } )`** — the
  production counterpart of `renderFrames`: adaptive sampling stays on, the loop stops on the
  ceiling, convergence or the time limit (the time limit was never honoured outside `animate()`), and
  the final denoise runs once. It shares `_traceFrame()` / `_completionInfo()` with `animate()`, so
  the two cannot drift. For its duration the stage's readbacks run in **lockstep**
  (`PathTracer.setLockstepReadbacks`, also `app.setLockstepReadbacks()`): the survivor curve and the
  convergence counters are read at frame 1 (applied at 2), then every 4 frames and applied exactly 4 frames later
  (never at frame 0: a final render traces it with one bounce, and that curve sized nothing for frames 1–7 — 9 % of a
  30-spp render at 1080p and 4096²), `render()` traces
  nothing while one is due and in flight (`stage.readbackWait()` is the promise — every driver loop
  awaits it rather than spin), and each reset clears the curve and rewinds the seed. Measured at
  400×300 with adaptive on: free-running gave 45 / 72 / 45 / 43 spp and four different images across
  pacings; lockstep 48 spp and one image every time. ⚠️ It turns interaction mode off meanwhile: that
  mode is a 100 ms wall-clock timer that engages on the first frame after a load, frames in it do not
  count, and with nothing awaited the loop spun synchronously and starved the timer (a bench hang).
  ⚠️ A moved camera never skips a lockstep readback (only interaction mode does): a reset's frame 0 sees the camera
  as moved whenever the frame before traced another view, and skipping it there made the first render after a load
  differ (glass-transmission, one pixel).
- **`app.getProvenance()`** — plain JSON of what produced the image (versions, adapter, `settings.getEffective()`, colour, render size/samples, headless/strict/deterministic/
  lockstep). `captureHeadless` returns it as `provenance`. `mode.lockstep` is `stage.accumulationLockstep` —
  whether the current image was traced in lockstep from a lockstep reset, not the live setting, which
  `renderUntilComplete` restores on return. A checkpoint restore reports false (the curve is not saved).
- **`await app.runFinalDenoise()`** — one OIDN pass at the final tier, awaited, without the render
  loop or the upscaler (`DenoisingManager.denoiseOnce()`: waits out a run or weight load in flight,
  which `start()` would refuse or defer). OIDN must have been on while accumulating — the aux
  buffers are written only then. Failure records `denoiser.unavailable`.
- **`pathTracer.requestOutput( 'gBuffer' )`** compiles the denoisers' normal/depth/albedo writes into Generate, Shade
  and FinalWrite (`gBuffer` build param; `'hitDistance'` implies it). `PathTracerApp` asks for it in `_initManagers`,
  so a denoiser toggles only the live `auxGBufferEnabled` uniform; on the bare core the first
  `setAuxGBufferEnabled( true )` asks for it (one rebuild). Without it the core's kernels carry none of that code.
- **Kernels compile in the background.** `_buildWavefrontKernels` ends in `_compileKernels()`: `KernelManager.compile()`
  runs three's `compileComputeAsync` (WGSL built in steps that yield, pipelines through `createComputePipelineAsync`).
  Until it resolves `render()` traces nothing and the canvas keeps its last frame; `readbackWait()` returns the
  promise, so every driver loop (`animate`, `renderFrames`, `renderUntilComplete`, video export) awaits it rather than
  spin; `EngineEvents.SHADERS_COMPILING` brackets it (a badge on the app's picture, `PictureStatus` in `LoadingOverlay.jsx`,
  which also shows the denoiser's model load, the closing denoise, the AI upscale and a video export; a load's loading
  panel stays up through it instead — `resetLoading` holds while `isCompilingShaders`, in the store). A newer build supersedes
  an older compile (`_kernelGeneration`). The debug-view kernel registers `eager: false` and compiles at first
  dispatch. Measured on a layer combination new to the browser: page freeze 3.7 s → 0.4 s (the main thread still
  builds the WGSL), the new image 4.1 → 4.6 s. ⚠️ The old synchronous first-dispatch compile only looked fast: the
  frame was submitted after 0.2 s and the GPU finished it after 4 s — time a first frame to
  `queue.onSubmittedWorkDone()`, not to `frameCount`.
- **`app.enableGPUTiming( bool )` / `await app.getGPUTimings()`** — real GPU milliseconds from WebGPU
  timestamp queries. `pipeline.getStats()` is **not** a GPU metric: it times command encoding on the
  CPU and stays flat while GPU cost doubles. ⚠️ The `render` part overlaps the compute before it (Apple M-series: 2.0 ms read for
  passes the wall clock puts under 0.15 ms): compare totals only between setups that draw alike.

`app.stages.pathTracer.blueNoiseReady` is deprecated and always resolved: the STBN atlases were
never read by a live code path (the default sampler is Sobol), so the load was removed.

`rayzee/src/viewer/Headless.js` wraps the above as the supported entry point — `renderHeadless()` for one
frame, `openHeadless()` to keep a live app across several, `captureHeadless()` to accumulate and read
back (`denoise: true` enables OIDN before accumulating, runs `runFinalDenoise()`, reads `'display'`).
Defaults are the batch renderer's (`strict`, `deterministic`); its `settings` are applied before the load and again
after it, since some are read while a model loads (`areaLightIntensityScale`). Under `strict`,
the renderer also defaults storage off unless the host set it (`isAssetConfigured( 'storage' )`):
the download cache serves a cached copy for up to a day before revalidating. `hostMemoryGB` stands
in for `navigator.deviceMemory` (absent outside Chrome, read as 4, which caps the reserve at 2048).
`bench/harness/boot.js` boots through it, so the suite and production share one driver; the bench
passes `strict: false` explicitly, and it is load-bearing — `strict` would abort a run before the runner reported.
