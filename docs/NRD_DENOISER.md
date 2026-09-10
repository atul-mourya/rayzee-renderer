# NRD (ReBLUR) real-time denoiser

`rayzee/src/Stages/NRD.js` is a port of NVIDIA Real-Time Denoisers' **ReBLUR** to TSL compute. It is
the third real-time denoiser strategy (`denoisingManager.setStrategy( 'nrd', preset )`) next to
`asvgf` and `edgeaware`, and like them it runs inside the pipeline every frame; OIDN stays the
offline finisher.

ReBLUR is a *recurrent blur*: the history that gets reprojected each frame is last frame's
**post-blurred** output, not the raw accumulation. Blur radius shrinks as history accumulates and
grows with the distance to the secondary hit (open areas blur wide, contact shadows stay sharp), so
the filter is a temporal accumulator with a spatially adaptive kernel rather than an à-trous
wavelet like ASVGF.

## Pass chain

The stage dispatches the same six passes as `nrd::REBLUR_DIFFUSE`, in order, all 16×16 compute:

| pass | NRD source | reads | writes |
|---|---|---|---|
| PrePass | `REBLUR_PrePass` + `REBLUR_Common_SpatialFilter` | color, albedo, normalDepth, shadingNormal | `tmpA` |
| TemporalAccumulation | `REBLUR_TemporalAccumulation` (diffuse branch) | `tmpA`, `hist`, `fastHist`, `internal`, `geomPrev`, motion | `tmpB`, `dataT` |
| HistoryFix | `REBLUR_HistoryFix` | `tmpB`, `dataT` | `tmpA`, `fastHist` |
| Blur | `REBLUR_Blur` | `tmpA`, `dataT` | `tmpB` |
| PostBlur | `REBLUR_PostBlur` | `tmpB`, `dataT` | `hist`, `geomPrev` |
| TemporalStabilization | `REBLUR_TemporalStabilization` | `hist`, `dataT`, `stab` (ping), motion, color, albedo | `stab` (pong), `internal`, output |

The PrePass doubles as NRD's front end: demodulate by albedo, sanitize, convert to YCoCg, and take
the normalized hit distance from `pathtracer:albedo.w`. All internal textures hold NRD's storage
format — `float4( YCoCg, normHitDist )` — in fp16. The stabilization pass converts back to linear
RGB, remodulates, and copies to a render-resolution `RenderTarget` published as `nrd:output`.
Sky pixels (`normalDepth.w ≥ 6e4`) are passed through untouched, as NRD leaves them to the app.

Formulas — normal weight from the specular lobe half-angle, plane-distance geometry weight,
roughness weight, exponential hit-distance weight, `GetSpecMagicCurve`, `GetHitDistFactor`,
`GetAdvancedNonLinearAccumSpeed`, firefly suppressor, fast-history clamping, anti-firefly,
`ComputeAntilag` (mode 2), the 12-tap Catmull-Rom history fetch with bilinear fallback — are
transcribed from the NRD sources (`Shaders/*.hlsl*`, `Include/NRDSettings.h`). Setting names in
`NRD_DEFAULTS` are `nrd::ReblurSettings` names with their defaults, so NVIDIA's tuning guidance
applies as written.

## Inputs the engine had to grow

ReBLUR needs two guide signals the pipeline did not have:

- **Roughness.** `NormalDepth` already re-traces the primary hit deterministically to produce the
  jitter-free normal the denoiser gates on. It now also samples the material's roughness (same
  texture bucket path as the normal map, same `0.05` floor as the shade kernel) into
  `pathtracer:shadingNormal.w`, which previously held a duplicate of the depth.
- **Hit distance.** The shade kernel writes the length of the first segment after the primary
  opaque scatter (alpha-skip distance included, misses saturate) into a previously unused 16-bit
  lane of the per-pixel G-buffer, normalized NRD-style as `hitDist / (A + B·viewZ)`. `A` and `B` are
  the shared `NRD_HIT_DIST_A`/`_B` constants: the write and the decode must agree, and the
  normalization is a pure round trip, so nothing is gained by making it tunable at runtime.
  `FinalWrite` decodes it into `pathtracer:albedo.w` and accumulates it with the other aux channels.
  OIDN consumes albedo as three channels, so its aux guide is unaffected. `writeGBuffer` preserves
  that lane so the later DDFA albedo commits do not zero it; `Generate` clears it explicitly.

Both are only produced while a denoiser (or OIDN) has the aux G-buffer switched on, so the default
interactive path pays nothing.

## Deviations from NRD, and why

- **One fused signal.** The wavefront outputs one radiance buffer. NRD's `REBLUR_DIFFUSE_SPECULAR`
  wants separate diffuse and specular radiance + hit distance. The port runs the diffuse branch on
  the fused demodulated lighting but keeps the *surface roughness* in every lobe-dependent formula
  (lobe half-angle, `specMagicCurve` radius scaling, roughness weights), so smooth surfaces get the
  tight kernel a specular signal would and rough ones the wide diffuse kernel. Specular virtual
  motion (reprojecting the reflected point) and the curvature estimate are not attempted. Splitting
  the signal in the wavefront is the natural next step; it needs a second radiance lane per path
  and a fourth MRT attachment.
- **Progressive-aware.** NRD assumes a fresh 1-spp input every frame. Here the input is the path
  tracer's running mean once the camera stops, so `k = frameCount + 1` samples are already inside
  it. The history blend uses inverse-variance weighting `k / (k + accumSpeed)` (identical to NRD's
  `1 / (1 + accumSpeed)` at `k = 1`), the spatial radii and history-fix stride use
  `accumSpeed + k`, and the pre-pass footprint shrinks by `1/k`. On top of that a *handover* term
  `saturate( k / handoverFrames )` (default `2·maxAccumulatedFrameNum`) scales every history and
  clamp term to zero, and once `k ≥ handoverFrames` the stage publishes the path tracer's own
  texture and skips its dispatches. The filter hands the image back as it converges instead of
  blurring a clean render — the failure mode the denoise bench exists to catch — and the 64-spp
  rung measures exactly 1.000. While passing through, the geometry history and previous camera
  freeze, so the stage marks them stale: a camera move is a *soft* reset (no `denoiser:reset`), and
  reprojecting a one-frame motion vector into a 60-frame-old G-buffer would otherwise keep whichever
  taps happened to pass the plane test.
- **Lobe volume.** `NRD_MAX_PERCENT_OF_LOBE_VOLUME` is 0.75 in NRD, with a source comment that it
  is probably too much. It is exposed as `lobeVolumePercent` and defaults to 0.1: with no history
  yet, NRD's 60° diffuse cone smeared shading across strongly curved surfaces (bench
  `spheres-gradient` at 1 spp: 1.115 → 0.993) while the other scenes were unaffected.
- **Hit-distance normalization ignores roughness.** NRD's `C` term makes smooth surfaces store a
  smaller normalized value. The front end runs before the primary roughness is known, so both sides
  use `A + B·viewZ` only; the two are consistent, which is all ReBLUR requires.
- **No material-ID gate.** NRD leaves material IDs to the app and disables the test by default. An
  identity gate was tried here (weight zero across a material boundary) and dropped. It cost a
  full-size G-buffer texture to carry one scalar, billed to every real-time denoiser, and identity is
  the wrong shape for the question: two dielectrics with matching BRDFs should share taps. It did buy
  `glass-transmission` 0.688 → 0.672 at 1 spp, so the removal is a deliberate trade, not a free one.
  The continuous form of the same test — gating on albedo similarity, using the albedo guide the
  pre-pass already binds — would recover it without the texture and is the obvious follow-up.
- **Screen-space kernel sampling for every roughness** (NRD's default for diffuse, optional for
  specular), with NRD's diffuse anisotropic skew. A 2×2 disocclusion footprint decides Catmull-Rom
  eligibility instead of NRD's 4×4. The anti-firefly window is 7×7 (NRD's performance-mode radius).
- **Kernel rotation** is per frame (NRD's `NRD_FRAME` mode) keyed on the path tracer's seed frame,
  so deterministic renders stay deterministic.

## Memory and cost

Nine fp16 RGBA `StorageTexture`s at the reserved render size (`MAX_STORAGE_TEXTURE_SIZE`, 2048²
default), 32 MiB each, about 288 MiB — the same class as the ASVGF chain. `releaseGPUMemory()` frees
them when another strategy is chosen; `reallocateReservedStorage()` rebuilds them on a reserved-size
change. The previous-frame normal and view depth are half-float like the rest: the plane test's
tolerance (`planeDistanceSensitivity`, 2 % of view depth) is 20-40× half-float's relative error.

Six dispatches per frame, but they are NRD's sparse 8-tap Poisson kernels rather than dense à-trous
passes, which makes the chain cheaper than either existing real-time denoiser. Measured per-sample
wall clock on `spheres-gradient` (Apple M-series, medium preset, includes CPU dispatch cost):

| render size | path tracer alone | + NRD | + ASVGF | + EdgeAware |
|---|---|---|---|---|
| 256² | 3.79 ms | +0.71 | +0.67 | +0.79 |
| 1024² | 14.34 ms | +2.03 | +8.16 | +9.82 |

At 256² all three are dominated by fixed dispatch overhead; 1024² is where the tap count shows.

## Controls

`NRD_QUALITY_PRESETS` — `low` (16-frame history, no pre-pass), `medium` (NRD defaults), `high`
(45-frame history, wider kernels). The app exposes the preset, max history, blur and pre-pass
radius, anti-firefly, and a debug view selector. Any field in `NRD_DEFAULTS` can be set through
`denoisingManager.setNRDParams( { ... } )`.

Debug views (`setNRDDebugMode`): 1 history length, 2 normalized hit distance, 3 roughness, 4 fast
history, 5 disocclusion bits.

`denoiser:reset` (emitted with `asvgf:reset` on every hard reset) drops the history; camera moves
are soft resets and are handled by the motion-vector reprojection.

## Validation

`npm run bench:denoise` includes an `nrd` rung (`bench/runner/config.js`). The metric is
RMSE(denoised) / RMSE(raw) against ground truth at 1 and 64 spp on three scenes; below 1.0 means the
denoiser helped. The 1-spp rung is an absolute gate, the rest ratchet against
`bench/baselines/denoise.json`. Medium preset, 256² render:

| scene | nrd @1 | nrd @64 | asvgf @1 | asvgf @64 | edgeaware @1 | edgeaware @64 |
|---|---|---|---|---|---|---|
| `spheres-gradient` | 0.992 | 1.000 | 0.957 | 2.041 | 0.751 | 0.906 |
| `glass-transmission` | 0.688 | 1.000 | 0.704 | 0.912 | 0.616 | 0.711 |
| `textured-normalmap` | 0.903 | 1.000 | 0.993 | 1.304 | 0.885 | 0.984 |

The 64-spp column is exactly 1.000 by construction (handover pass-through). The 1-spp rung on
`spheres-gradient` — 40-pixel diffuse spheres lit by a smooth gradient — is the regime ReBLUR's
geometry-only weights like least (no luminance term, hit distance saturated on every pixel); the
other two scenes are where it beats ASVGF.

## Diagnosing a broken frame

A TSL detail that cost a day here: uniform texture bindings are shared by texture uuid, so several
`TextureNode`s that all hold the shared `EmptyTexture` at compile time collapse into one binding and
every read returns whichever texture was bound last. Each deferred read node in this stage therefore
owns a 1×1 placeholder (`readNode()` in the constructor). Symptoms were a chroma-collapsed image
(the blur pass reading the per-pixel data texture as its colour signal) and history that never
accumulated (the temporal pass reading colour as previous-frame geometry), with no error anywhere.
