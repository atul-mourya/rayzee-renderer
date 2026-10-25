# Colour management (`rayzee/src/color/`)

`app.color` is an OpenColorIO pipeline covering all three sides: what textures and lights *mean*,
what the render happens *in*, and what it is *shown* and *saved* as. **It is inert until a host
loads a config** — the working space stays linear Rec.709, the view transforms stay three.js's own
seven, and nothing converts anything. No config means no behaviour change.

An add-on (`rayzee/addons/color`): the core's `renderer.color` is `BasicColor` (`color/BasicColor.js` — linear
Rec.709, no configs; `loadConfig` records `capability.missing`) until `renderer.setColorManagement( ColorManagement )`;
`PathTracerApp` installs it in its constructor. Shaders, `TextureCreator` and `EnvironmentManager` read whichever is
active through `color/ActiveColor.js`, never `ColorManagement.js` — that keeps OCIO out of the core
(`coreBoundary.test.js`). The core keeps `ViewTransforms`, `BuiltinViews` and `WorkingMatrix`.

```js
configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );  // the host names it
await app.loadColorConfig( { builtin: 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5' } );
app.color.setView( { display: 'sRGB - Display', view: 'ACES 2.0 - SDR 100 nits (Rec.709)', look } );
app.color.setContext( { SHOT: '010' } );          // $SHOT in the config resolves to this
app.color.setWorkingSpace( 'ACEScg' );            // then: await app.applyColorWorkingSpace()
await app.renderToBuffer( { colorSpace: 'ACES2065-1' } );   // a delivery buffer, not a picture
await app.unloadColorConfig();
```

⚠️ **Load and unload through `app.loadColorConfig()` / `app.unloadColorConfig()`**, not
`app.color` directly, once a scene exists. They undo an adopted working space *while the old
config is still loaded* — the environment is converted in place, and only the config that
converted it can convert it back. `app.color.unloadConfig()` with a space adopted records an issue
saying the environment was left converted.

- **OCIO's own console output goes through the engine logger** (`[ocio]` namespace) via the WASM
  module's `print`/`printErr` hooks — its environment is internal, so `OCIO_LOGGING_LEVEL` cannot be
  set. "Info" lines go to `debug`: the ACES CG v1.0.0 config lists four Studio-only displays as
  inactive and OCIO notes it on every load. Warnings and errors still show.
- **The engine never names the OCIO package.** It is ~6 MB of WebAssembly; a bare specifier in
  engine source would make it a hard dependency of every host, and `@vite-ignore` leaves the browser
  unable to resolve it. The host supplies `ocioRuntimeFactory` or `ocioRuntimeUrl`. The app loads
  it the first time the colour controls are opened; startup shows a baked view instead (below).
- **Baked views** (`BakedViews.js`): `saveBakedView( id )` writes a view's table to a file (gzip,
  delta-coded, 157 KB for 65³, 426 KB for 97³) and `loadBakedView( bytes, { expect } )` registers it with no runtime
  and no config, bit-identical to baking it. When its config later loads, `loadConfig` keeps the
  entry — no rebake, no new id, and `loadColorConfig` skips its reset — if the files hash to the
  fingerprint it was baked from (SHA-256 per file, `configFingerprint`) under the same OCIO version;
  otherwise it is released like any other view.
- **One registry, four consumers.** `ViewTransforms.js` is the single list; the TSL graph that
  paints the canvas, the WGSL readback (`ToneMapGPU`), the JavaScript readback (`ToneMapCPU`) and
  the host's menu are all derived from it. Adding a view at runtime therefore reaches all four —
  `getRegistryVersion()` moves and the shaders rebuild.
- ⚠️ **An OCIO view returns display-encoded colour; the built-in seven return linear.** That is what
  `outputEncoded` records. `ColorManagement` sets `renderer.outputColorSpace` to linear while an
  OCIO view is active and the readback skips its sRGB step. Get it wrong and every image is encoded
  twice — washed out with crushed blacks.
- ⚠️ **`library.addToneMapping` refuses to redefine an id** — it warns and returns without
  replacing. A rebaked view keeps its id, so `registerWithRenderer` deletes the old entry first, and
  `OcioViews` reuses the *same* `Data3DTexture` and TSL node across rebakes (swapping the pixels,
  as `UniformManager` does with uniforms). Without both, the canvas runs the previous table while
  the readback runs the new one.
- **Adopting the working space is opt-in and rebuilds the scene.** A texture authored against sRGB
  primaries means different light in ACEScg, so `setWorkingSpace()` must be followed by
  `applyColorWorkingSpace()`: textures and materials re-pack from their pristine three.js sources,
  and the environment converts where it lies (its current space is recorded on the texture, which
  is what lets it be turned back off; back in linear Rec.709 the record is `'native'`, not the config's name for it,
  since an environment recorded under Blender's "Linear Rec.709" was never converted by an ACES config). The texture
  cache key includes the working space.
- **Input resolution** is tag (`userData.ocioColorSpace`) → override → the config's own file rules
  → what three.js already believes, mapped onto the config's *roles*. A default file rule matches
  everything, so it loses to three.js's own tag. `TextureCreator` runs the full named transform
  only for an *explicit* answer (tag, override, non-default rule), and refuses even that for a
  layer `_harmonizeTransfer` re-encoded or a float source the packer quantized — the bytes are no
  longer in the named space. Everything else gets the primaries matrix. The texture cache key is
  `cm.inputKey` (config + working space + overrides + context), not the working space alone.
- **Until a working space is adopted, the render is linear Rec.709 named the way *that* config
  names it** (`findNativeLinearSpace`, aliases included). A hardcoded ACES spelling broke every view
  bake on configs without that alias.
- ⚠️ **Colour lives in more buffers than the material buffer.** `EmissiveTriangleBuilder` keeps its
  own copy of each emitter's colour — the one next-event estimation lights the scene with — and the
  shader's pick probability reads the *material* buffer's. Both are converted, and
  `applyColorWorkingSpace()` rebuilds the emitter list (`rebuildEmissiveColors`); miss either and
  emitters are seen in one space and cast light in another.
- **Environment modes are `'hdri' | 'procedural' | 'color'`.** The gradient sky was removed (the physical sky covers it); a saved session that names it keeps the sky on screen (`EnvironmentManager.restore`). The eight bench scenes that used it build the same sky through `setGradientSky` (`bench/harness/scenes.js`), goldens bit-identical.
- ⚠️ **The skies reuse one texture.** `SimpleSky` clears `userData.__rayzeeColorSpace` whenever
  it rewrites pixels; without that the record says "already converted" and a new sky is never
  converted. `EnvironmentManager.markDirty()` bumps the version *without* new pixels, which is why
  this is a record and not a version check. The physical sky has no CPU pixels to convert: it bakes
  straight into the working space (`getWorkingMatrix()` folded into its spectrum → RGB weights), and
  `applyColorWorkingSpace()` bakes it again.
- **Context variables are read from the config's text** (`environment:` block plus `$VAR`
  references). OCIO's description of a loaded config does not carry file-transform paths, which is
  where they live. The panel offers one input per variable.
- **The table ceiling is managed.** Every display/view/look/context combination is its own table;
  `setView` evicts the least recently selected (never the active one) at `MAX_TABLE_TRANSFORMS`.
- **Degradations are warnings.** Every colour issue is recorded with `warn()`: `record()` defaults
  to error, and the headless entry point is strict, so an error-level record would abort a batch
  render for baking an HDR view.
- **Per-texture colour space**: `app.setTextureColorSpace( texture, choice )` — `null` (auto),
  `'srgb'`, `'linear'`, or a config space — then rebuilds. The Material tab shows it under the
  albedo and emissive maps only; every other slot is packed as data. The texture cache hash
  includes `colorSpace` and `userData.ocioColorSpace`; before it did, a changed colour space was
  answered from the cache and silently ignored.
- **Views rebake lazily.** A `$SHOT` or working-space change rebakes the view on screen;
  `setActiveView` refreshes any other when it is next chosen (`_isStale`). Twelve registered
  views at ~0.1 s each used to freeze the UI for over a second.
- **Display P3 reaches the screen.** three.js configures the WebGPU canvas without a colour space
  (always sRGB) and reconfigures it on every resize. `ColorManagement` wraps that context's
  `configure` so a Display P3 view gets `display-p3` and keeps it (also when chosen before the first frame).
  ⚠️ Chrome keeps the colour space and format a WebGPU canvas had at its first copy (drawImage, createImageBitmap)
  for every later copy, so after a Screen or HDR switch thumbnails and video frames were read wrongly: a Display P3
  video frame kept P3 codes (61 levels), a save with HDR on was 21 levels dull, and a thumbnail after HDR off was the
  old picture, with WebGPU copy errors. The wrapper sets the canvas width again (unchanged) whenever the format or
  colour space changes, which resets it; `toBlob` was never affected.
- **Every display shows what it would emit** (Blender's Display Emulation "Automatic"). `canvasFitOf()`
  (`OcioViews.js`) measures, through the config, whether a display's encoding *is* a canvas colour space:
  decoding test codes to the display connection space must give sRGB's (or Display P3's) curve and primaries
  within 0.2 %. Only sRGB and Display P3 pass — Blender's and ACES's; ACES's "Display P3 HDR" too, extended.
  Every other display — Rec.1886's 2.4 and gamma 2.2's curves, Rec.2020, cinema P3-D65, PQ, HLG — is baked
  converted: OCIO's output decoded to the connection space (`displayReferenceSpace()`, CIE XYZ D65, 1.0 =
  100 nits; configs list it inactive, so the YAML is read) and encoded for the canvas, into sRGB for a
  Rec.709 gamut and Display P3 for a wider one (`ocio.canvas`, `ocio.emulated` on the registry entry). So
  the canvas, `renderToBuffer( 'srgb' )`, saved pictures, OIDN's and the upscaler's inputs all show the same
  picture; an HDR display's table keeps its range (up to ~2.7 encoded) for the HDR canvas and is clipped at
  white everywhere else. Before, Rec.1886 and gamma 2.2 went to an sRGB canvas as they were, and the other
  displays' codes were shown and saved as if sRGB. A view landing in a scene-referred space (Blender's
  "Filmic Log") and data views ("Raw") are shown as they are. `cm.displayFit( display )` and
  `cm.canvasColorSpace` (also `status().canvasColorSpace`, `renderToBuffer`'s `displayColorSpace`) say which;
  the AI upscaler and the neural passes tag their pixels with it (`ImageData` `colorSpace`), and a video frame
  is converted to sRGB (the WebM is Rec.709).
  ⚠️ A display's light, not its codes, is what a picture keeps: a file in a display's own encoding (PQ for
  an HDR video) is an export's job, from OCIO with the same view.
- **HDR on screen** (`app.color.setHdrOutput( true )`, off in the engine; the app turns it on while
  `(dynamic-range: high)` matches, switch "HDR" in the panel, remembered per device). The canvas shows the
  active view's HDR version from the config — `hdrViewFor` (`addons/color/Displays.js`): the same tone mapping on
  one of the config's HDR displays, 1000 nits first, then P3, an EDR display, PQ (Blender's AgX → "AgX - HDR
  1000 nits" on Rec.2100-PQ; ACES 1.3's "ACES 1.0 - SDR Video" → "ACES 1.1 - HDR Video (1000 nits & P3 lim)");
  an untagged view (Standard, Un-tone-mapped) is its own; Filmic and Khronos Neutral have none
  (`status().hdr.reason` 'no-hdr-version'), and built-in None shows unclamped. `buildCanvasView`
  (`OcioViews.js`) bakes it like any view: OCIO's display output is decoded to the display connection space
  (CIE XYZ D65, 1.0 = 100 nits — Blender's reference white; configs list it inactive, so
  `displayReferenceSpace()` reads the YAML), turned into the canvas colour space (CSS Color 4 matrices) and
  encoded with the sRGB curve extended past 1 and mirrored below 0. It is not a registry entry: readbacks,
  OIDN and the upscaler keep the view itself. Blender's AgX HDR matches its SDR AgX to grey (0.18 → 0.181)
  and reaches 10× white; ACES 2.0 HDR puts grey at 0.145 against SDR's 0.100, by design. The screen clips
  what it cannot reach, as Blender does: no web API reports the headroom without a permission prompt. A
  view chosen on an HDR display needs no HDR version: its table already holds the range, and only the
  canvas widens.
  - The canvas: `renderer.backend.parameters.outputType = HalfFloatType` and `backend.updateSize()` —
    three.js reads the format, and from it `toneMapping: { mode: 'extended' }`, when it next configures
    the canvas, and its pipelines key on the format. Only for a canvas on screen (`no-screen` otherwise).
  - The Compositor draws the canvas version in one pass (`setCanvasTransform`), with the renderer's tone
    mapping and output colour space set to none for that draw; `renderPicture()` draws the view itself. It is the
    material's `outputNode`, not its `colorNode`: three.js clamps a colour node at 0, and below 0 is light outside the
    canvas's gamut (a saturated green under AgX - Very High Contrast: −0.34 in red and blue, shown as 0).
    `getCanvas()` (saves, thumbnails, video frames, the upscaler's input) draws the view, copies it to a 2D
    canvas in the canvas colour space whenever the canvas is half-float, and redraws the screen. A capture then
    matches HDR off within one level (1920×1080: 4.4 % of channels one lower, mean −0.04, from the half-float
    canvas's rounding); +0.1 ms a capture. A Display P3 picture saves with its ICC profile (iCCP), HDR on or off.
  - The last four HDR versions are kept (`RECENT_CANVAS_VIEWS`, 2.2 MB on the card and in memory each), so
    switching back to a look with HDR on takes 0.6 ms instead of a 40–60 ms bake.
  - Startup: `default-view-hdr.bin` beside `default-view.bin` (`npm run color:bake` writes both;
    `saveBakedView( id, { hdr: true } )`, `loadBakedView` keeps it for its view). Without it the app loads
    the config to bake (0.06–0.4 s on the main thread).
  - Measured (M5 Pro, Chrome 155, 1920×1080): the canvas draw 0.12 ms against 0.16 ms SDR (one pass instead
    of two); the canvas texture 8 B a pixel instead of 4. Table error against OCIO 0.33 code values mean, up to
    ~1 % of brightness in saturated colours at the 1000-nit clip. A converted display costs nothing a frame
    (0.166 ms against 0.163 ms) and 38–41 ms a bake against 31 ms; measuring a display's fit 0.3–18 ms, once a
    config. A Display P3 video frame converted to sRGB +0.05 ms (+0.23 with HDR on); an upscaler tile of
    Display P3 pixels put into its sRGB canvas 2 ms against 0.07 (512²).
- **EXR and HDR export** (`app.exportImage( { format: 'exr' | 'hdr' } )`, the app's Export window) writes
  `renderToBuffer( { source: 'display' } )` — the denoised image the viewport shows, read through
  `output/TextureReadback.js` (a pixel-exact copy pass, since OIDN's output is an ExternalTexture no render target
  owns) — in `color.exportSpace` through our own writers (`output/ImageEncoders.js`), top line first. The albedo layer
  is converted with it. `chromaticities( space )` measures a space's primaries through the config's CIE XYZ D65
  interchange role; they arrive adapted to D65, so the writer snaps a known gamut (Rec.709, Rec.2020, P3, ACES AP0/AP1,
  E-Gamut) back to its own primaries and white. A PNG is a picture and never takes an export space. With `asShown`
  ("As on screen" in the app, its default) the file holds the light the screen emits instead — the view, look, exposure
  and display gain applied, the canvas encoding undone, or the canvas's HDR version while it shows one — so macOS and
  other viewers, which put raw light through a plain curve of their own, show it as the screen does (0.7 levels of 255
  from the screen on the camera scene, against 6.8 for raw light). Photo viewers still show EXR and HDR files in
  normal range; an HDR screen's picture with its highlights goes in a JPEG, HEIC or AVIF with a gain map
  (`exportImage( { gainMap: true } )`), which Preview, Photos, Chrome and Safari show in HDR.
- **Saved renders in HDR** (the Results page). A save keeps the render's light as an EXR ("Keep HDR copy", on by
  default), and its `rayzee` attribute records how the picture was shown: `display` (the exposure, auto exposure's
  included, the backdrop state and the exposure a solid backdrop is held at) from `getProvenance()`, and the viewer's
  `exposure.local`. `app.createPictureView( canvas )` (`viewer/picture/PictureView.js`, loaded on first use) shows such a file
  as the screen showed it: a renderer of its own on the main device (`createRendererOnDevice`, as the view overlay's;
  an HDR canvas: half-float, extended range, the view's canvas colour space, no depth buffer) running a Compositor and a
  LocalExposure of their own — the same code as the viewport, fed the saved light as `pathtracer:color` in a
  `PipelineContext` of its own — through the saved view's HDR version (`color.hdrVersionOf( view )`: the very table the
  screen used while this session holds it, so the startup's needs no config or runtime; else baked and kept with the
  recent ones). The live view is left as it is. Only the EXR's header is read first (`rayzee` attribute); its pixels are
  decoded only when it will be shown, and three flips its rows on the GPU as it uploads them. Against the live HDR
  canvas of the test interior (2048², 30 samples): mean 0.03 %, worst pixel 3 %, highlights to 9.3× white; shown in
  0.3–0.45 s at 2048², almost all of it decoding the EXR on the main thread. Not shown, with a reason, when the screen
  shows no HDR, the file predates the record, its config is not the one loaded, or a later `show()` took over; the
  page then shows its 8-bit picture.
  - The panel's edits go after the view (`PictureView.setGrade`; `pictureGrade` in `app/src/lib/ImageProcessor.js`),
    as on the 8-bit picture: brightness and contrast on the encoded colour, then saturation, hue and exposure on it
    decoded with 2.2, encoded with the panel's gamma. Up to white they match `ImageProcessorComposer`'s GLSL, copied into
    JavaScript, within half a level (`tests/gpu/pictureGrade.test.js`; the WebGL composer itself runs in no test); past white the colour carries on (hue turns it scaled down to white), and
    below 0 — light outside the canvas's gamut — is kept, so the defaults change nothing (0.13 levels of rounding).
  - ⚠️ The compositor's held backdrop takes the exposure whenever it draws through a canvas transform, not by the
    renderer's view: the picture view's renderer has none.

## The app's section (`ColorManagementSection.jsx`)

Its own group in the Path Tracer tab, modelled on Blender — the OCIO client that does most for
artists. The view settings come first, with artist names, in the order they are reached for:
**Tone Mapping** (OCIO view), **Style** (look; "None" reads "Default"), **Screen** (display), Exposure.
Saving an EXR, and its colour space, is the Export window's. The project settings — **Color System** (the config) and **Render In**, set once,
rebuild the scene — sit folded under **Advanced**, whose header shows them (`Blender · Rec.709`) and
whose open state is remembered in localStorage. One Tone Mapping menu, no separate curve control.
Exposure is in stops (`2^EV`); the store still holds the multiplier.

The app starts in **Blender 5.1's config** (`DEFAULT_COLOR_CONFIG` in `app/src/lib/colorManagement.js`,
identity in `colorDefaults.js`: sRGB / AgX / Medium High Contrast) from `${ASSETS_BASE_URL}/ocio/blender-5.1/`
— a `manifest.json` plus Blender's files, unmodified, and `default-view.bin`, that view baked by
`npm run color:bake`. `Viewport3D` downloads only the baked view alongside the model and shows it
before the first frame (`showStartupColor`), waiting at most `DEFAULT_COLOR_WAIT_MS` (2 s); switching
views after the first frames read as a colour jump. The config itself loads when the Color Management
group is first opened, or a texture's colour-space menu (`ensureDefaultConfig`), and keeps the baked
view. Measured on production builds, warm reload: first frame 1.38 → 0.59 s, main thread blocked before
it 870 → 220 ms, and a cold visit fetches 157 KB instead of 24 files (4.7 MB compressed) and the
0.65 MB compressed runtime.
Without the baked file (not uploaded, or its header does not match the default) startup loads the
whole config as before. ⚠️ Rerun `npm run color:bake` and upload the file whenever the config or the
default view changes. ⚠️ The app is `pause()`d from `init()` until then: every model, sky and config
load resets, and a reset's `wake()` restarts rendering unless paused — without it 3 of 5 warm reloads
drew the built-in look first. A failed default model or sky is reported and startup carries on, so the
look still loads. The spot-light gobo and IES libraries (~180 files) load after the first frame
(`lib/lightLibraries.js`); a pick made before they land waits for them.
⚠️ Those files are GPL-3.0: they live on the CDN only, staged locally in the git-ignored `.cdn-upload/`, never in the app or engine. A dev build points
elsewhere with `VITE_COLOR_CONFIG_URL`.

Every label and filter lives in `app/src/lib/colorLabels.js`, derived from what the config carries —
OCIO's guidance is to build menus from UI name, family and description, filtered by category:
- **Color System**: Blender (default), None, one preset per ACES version (the newest CG config of it) and
  "Load config folder…" — nothing else. Older builds render the same ACES and Studio configs only add
  camera spaces, so they are not offered. ⚠️ The runtime's builtin names carry no `ocio://`.
- **Render In**: spaces tagged `working-space` *and* linear (ACES: Rec.709, ACEScg, P3-D65); untagged
  configs fall back to the linear family narrowed to the well-known gamuts. Never the interchange space.
- **Screen** drops the ACES " - Display" suffix and splits SDR | HDR as Blender does (the engine's `isHdrDisplay`:
  the display space's `encoding` is `hdr-video`/`edr-video`; ACES spells that space `<USE_DISPLAY_NAME>`). A
  display shown converted (`cm.displayFit`) says so in its tooltip. Choosing one keeps the tone mapping
  (`matchingView`: AgX ↔ "AgX - HDR 1000 nits", ACES 2.0 SDR ↔ HDR 1000 nits, the same release first, P3
  first) and its look when the new view offers it; only a tone mapping the display lacks falls back to the
  display's default. Before, every switch went to the default — "Standard" in Blender's config.
- **HDR** (only while the screen reports `(dynamic-range: high)`): on unless turned off, kept in localStorage
  `rayzee-hdr-screen`; "unavailable" beside it when the tone mapping has no HDR version.
- **Tone Mapping** labels are the view's own name, with detail added back only where two would collide.
- Screen and Tone Mapping items carry a one-line hint (`screenHint` / `toneMappingHint`), first regex match
  wins — put a specific name above the general one (`ACES Filmic` must not reach the `filmic` rule).
- **Style** follows the tone mapping as Blender's looks do — measured: with AgX Blender accepts only "AgX - …"
  looks, with Standard only the unprefixed ones. A look's prefix is matched against every view the config has
  and by tone mapping (`sameToneMapping`), so "AgX - Punchy" also suits "AgX - HDR 1000 nits"; matched against
  one display's views, an HDR display offered Filmic's looks for AgX. Gamut compression and LMTs are grouped as
  technical.
- **Every combination** is held by `tests/unit/color/colorCombinations.test.js` on ACES 2.0, ACES 1.3 (OCIO 2.4
  and 2.1) and Blender 5.1: every display × view × offered look against OCIO's display light, with and without
  its HDR version and in another working space; the Screen switch both ways; the HDR switch on every view.
  Checked in Chrome (2026-10-24, an HDR Display P3 screen) with 32 emitters of known light: what the canvas holds,
  read off the GPU, against OCIO for Blender's 604 combinations with HDR on and off, ACES 2.0's 148, ACES 1.3's 72
  and the seven built-ins, plus every working space and two exposures; readback, saved picture and thumbnail
  alike. Blender 590 of 604 within 3 levels / 3 %, the rest within 3.4 levels / 4.1 %; ACES 2.0 and 1.3 all; canvas
  and readback within 1 level of each other everywhere. False Color, wrong on every display until it was split at its
  lookup (below), passes everywhere. Every view of every display again in each wider working space (P3, Rec.2020,
  ACEScg): all within 3 levels but ACES 1.3's view in Rec.2020 and ACEScg (10.7 levels, one bright primary), its HDR 2000
  view (6.4–7.4) and ACES 2.0's in ACEScg (3.2 SDR, 5 for HDR 1000 P3). Filmic, Filmic Log, Khronos PBR Neutral and the
  plain encodings were 75–130 levels off there before the table could take Rec.709's axes (below).
- **Texture colour space**: spaces tagged `texture`, grouped by family.
- ⚠️ `describeConfig()` must carry `categories`. Without them every tag filter silently falls back
  to name matching — the tests passed by coincidence until that was caught.

Engine defaults (no app, or before the Blender config lands): no config; a picked config opens on its
own default display and view; look None; 0 EV; render in linear Rec.709 until the artist picks another.
The accuracy readout is API-only (`status().bakeError`).

## Shaper + table

A view is baked to a log2 shaper over 25 stops feeding a 65³ cube, interpolated tetrahedrally —
the arrangement OCIO emits for its own GPU path. OCIO is the source of truth and the validator, not
the runtime: a table is the only representation that is identical in a TSL graph, a WGSL compute
pass and plain JavaScript, and a saved image differing from the viewport is a worse failure than a
third of a code value. `entry.error` carries what the table cost, measured against the real
processor during the bake: `mean`, `p95` and `max` over 4,000 render-like colours, and `edge`, the worst over Rec.709's
primaries, secondaries and half mixes at 2^-3..2^4, in the space rendered in. An SDR display's table is measured as it
shows, 0..1 (an HDR screen shows that view's HDR version instead); only an HDR display's is measured past it.

**Where a table measures poorly** (`tableScore`: a saturated colour 5 levels off, or a mean of 0.4) the bake tries the
same view on linear Rec.709's axes, then at 97³, each kept when its score is under 0.8 of the other's and its mean no
worse (`bakeView`). A host that passes `size` gets that size; a rebake chooses again (`ocio.requestedSize`).
- **Rec.709's axes** (`pre`, the 3×3 from the working space, applied before the shaper, which clamps its negatives):
  rendering in a wider space, a view that works channel by channel in Rec.709 — Filmic, Khronos PBR Neutral, a plain
  encoding — bends hardest where a Rec.709 channel crosses 0, which the working space's axes put inside a cell. Pure
  Rec.709 colours were up to 130 levels off in Filmic from ACEScg, 0.6 on Rec.709's axes. A view that keeps wider
  colours (ACES, AgX) measures worse there and stays.
- **97³** (7.3 MB, against 2.1): ACES 1.3 on sRGB 9.1 → 1.1 levels; the app's default AgX + Medium High Contrast
  6.0 → 3.4. Some views read worse at 97, so the closer is kept.
- Over 263 tables (Blender's and ACES 2.0's configs, every display, in each working space they offer) 24 take Rec.709's
  axes and 68 grow: a saturated colour over 10 levels off on 47 → 6, over 6 on 84 → 19, the worst 130 → 32 levels
  (ACES 2.0's HDR 1000 P3 view in ACEScg at 11× white), the worst mean 0.48 → 0.40.
- ⚠️ The Compositor draws a table view itself, canvas and picture alike (`_viewQuadFor`): three.js's output pass first
  stores the frame in half floats, and on Rec.709's axes that rounding of a wider working space showed (a pure green in
  ACEScg read 51 levels of red in Filmic Log, where the readback, reading floats, read 1). Same cost a draw.

**The derived config** (`OcioViews.js`): the loaded config's text plus, for each view transform defined from the scene
reference, a scene-referred colour space holding it, built the first time a bake needs it (~20 ms; the runtime's
mounted folder is found by its `.ocio` text, so LUTs resolve). Two bakes use it:
- **A display shown converted bakes from its light**, the view transform's output, not its codes decoded: Rec.1886's and
  Rec.2020's encodings are `ExponentTransform`s that clip at 0, which put a kink inside a cell wherever a colour left the
  display's gamut. Its table is baked twice from the one OCIO output, as light (`linear`, encoded after the lookup in
  all four places) and encoded, and keeps light only where that at least halves the worst error: encoded follows a
  tone curve better (mean 0.2 against 0.4 levels over 223 tables), light a colour whose light crosses 0 in a cell. The
  display's own clip at 0 comes after the lookup (`clip`: to its primaries, clipped, back), found by sending a colour
  outside it through OCIO: without it Standard on Rec.2020 rendering in ACEScg was 61 levels off, with it 1.
- **A view that steps through a `.spi1d` after a grey value is split there** (Blender's False Color: AgX, then luminance,
  then `AgX_False_Color.spi1d`): the part before is a colour space, the lookup and the rest a named transform. The cube
  holds the grey value and a curve of the lookup's 4096 entries after it gives the colour, in the same texture's extra
  slices (`curve` on the entry). The two halves reproduce OCIO's False Color exactly (2,004 colours, difference 0).

⚠️ Grid index 0 is baked from **exactly 0**, not from 2^minEv. Without that, true black leaves the
table one code value above zero and every render has a raised black floor.

**Measured** (Apple M-series, ACES 2.0 SDR view, `bench:upscale` gates GPU against CPU):

| | |
|---|---|
| table vs OCIO CPU | mean 0.07, p95 0.19 code values; 99.85 % within 2 — measured on the half table the GPU samples, which the CPU readback now samples too |
| live canvas vs readback | 0.5 levels, identical for OCIO and built-in views — the readback's deliberate half-level bias (screenshot pixel crops, measured in the app) |
| worst case | 32 code values: a Rec.709 blue at 11× white through ACES 2.0's HDR 1000 P3 view, rendered in ACEScg (65³: 53) |
| GPU readback | **+1.4 µs/megapixel** over any analytic curve (~3 %); the pass is memory-bound, so the seven built-ins are indistinguishable from each other |
| CPU readback | 60 ms/megapixel, against 27 (None) and 76 (three.js AgX) — the table is *cheaper* than the polynomial it replaces |
| bake | 20 ms at 33³, 93–127 ms at 65³; with the choice, median 71 ms (53 at 65³ alone), the slowest tenth 0.53 s (0.12). Blender's eight sRGB views at config load: 447 ms in linear Rec.709 (~260), 1.05 s in ACEScg |
| VRAM | 2.10 MB per registered view at 65³, 7.3 MB at 97³, **per device** |
| host memory | 2.1 MB per registered view — the CPU sampler reads the half table in place through a shared 256 KB decode table (a float copy used to add 4.4 MB a view) |
| runtime | 4.76 MB wasm + 1.39 MB Naga, fetched only when a config is opened; starts in ~32 ms and reserves a 64 MB WebAssembly heap; a config loads in ~35 ms |
| adopting a working space | 1.9 s on the 3.5M-tri / 642-texture test model, of which ~1.1 s is the ordinary material rebuild and 0.62 s texture conversion (was 3.0 s: three `Math.pow` a pixel, now a sqrt-indexed 64K table, 0.09 % of values one level off). Still on the main thread. Reverting ~1.0 s |
| EXR save | ~100 ms at 512²; the float copy target is released after each save (132 MB at 4K) |

`MAX_TABLE_TRANSFORMS` is 12: the readback binds every table in one shader and WebGPU only
guarantees 16 sampled textures per stage.
