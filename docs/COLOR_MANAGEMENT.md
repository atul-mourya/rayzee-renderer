# Colour management (`rayzee/src/Color/`)

`app.color` is an OpenColorIO pipeline covering all three sides: what textures and lights *mean*,
what the render happens *in*, and what it is *shown* and *saved* as. **It is inert until a host
loads a config** — the working space stays linear Rec.709, the view transforms stay three.js's own
seven, and nothing converts anything. No config means no behaviour change.

An add-on (`rayzee/addons/color`): the core's `renderer.color` is `BasicColor` (`Color/BasicColor.js` — linear
Rec.709, no configs; `loadConfig` records `capability.missing`) until `renderer.setColorManagement( ColorManagement )`;
`PathTracerApp` installs it in its constructor. Shaders, `TextureCreator` and `EnvironmentManager` read whichever is
active through `Color/ActiveColor.js`, never `ColorManagement.js` — that keeps OCIO out of the core
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
  delta-coded, 157 KB for 65³) and `loadBakedView( bytes, { expect } )` registers it with no runtime
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
  is what lets it be turned back off). The texture cache key includes the working space.
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
  `configure` so a Display P3 view gets `display-p3` and keeps it. HDR views are not shown in HDR:
  that needs the renderer's canvas format changed to half-float at construction and a PQ-to-
  extended-range conversion.
- **EXR export** (`app/src/lib/colorManagement.js` → `saveEXR`) writes
  `renderToBuffer( { source: 'display' } )` — the denoised image the viewport shows,
  read through `Processor/TextureReadback.js` (a pixel-exact copy pass, since OIDN's output is an
  ExternalTexture no render target owns) — in the chosen space through three's `EXRExporter`. ⚠️ The readback is top row first and the exporter
  assumes bottom row first, so rows are flipped before encoding. A PNG screenshot is a picture and
  never takes an export space.

## The app's section (`ColorManagementSection.jsx`)

Its own group in the Path Tracer tab, modelled on Blender — the OCIO client that does most for
artists. The view settings come first, with artist names, in the order they are reached for:
**Tone Mapping** (OCIO view), **Style** (look; "None" reads "Default"), **Screen** (display), Exposure,
then **Save EXR**. The project settings — **Color System** (the config) and **Render In**, set once,
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
- **Screen** drops the ACES " - Display" suffix and splits SDR | HDR as Blender does (`isHdrDisplay`:
  the display space's `encoding` is `hdr-video`/`edr-video`; ACES spells that space `<USE_DISPLAY_NAME>`).
  A display this screen can't show natively (`displayCanvasFit`) says so in its tooltip.
- **Tone Mapping** labels are the view's own name, with detail added back only where two would collide.
- Screen and Tone Mapping items carry a one-line hint (`screenHint` / `toneMappingHint`), first regex match
  wins — put a specific name above the general one (`ACES Filmic` must not reach the `filmic` rule).
- **Style** follows the tone mapping as Blender's looks do — measured: with AgX Blender accepts only "AgX - …"
  looks, with Standard only the unprefixed ones. Gamut compression and LMTs are grouped as technical.
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
processor during the bake.

⚠️ Grid index 0 is baked from **exactly 0**, not from 2^minEv. Without that, true black leaves the
table one code value above zero and every render has a raised black floor.

**Measured** (Apple M-series, ACES 2.0 SDR view, `bench:upscale` gates GPU against CPU):

| | |
|---|---|
| table vs OCIO CPU | mean 0.07, p95 0.19 code values; 99.85 % within 2 — measured on the half table the GPU samples, which the CPU readback now samples too |
| live canvas vs readback | 0.5 levels, identical for OCIO and built-in views — the readback's deliberate half-level bias (screenshot pixel crops, measured in the app) |
| worst case | ~18 code values on saturated colours brighter than white — a clip edge in ACES 2.0's gamut compressor that no table can represent |
| GPU readback | **+1.4 µs/megapixel** over any analytic curve (~3 %); the pass is memory-bound, so the seven built-ins are indistinguishable from each other |
| CPU readback | 60 ms/megapixel, against 27 (None) and 76 (three.js AgX) — the table is *cheaper* than the polynomial it replaces |
| bake | 20 ms at 33³, 93–127 ms at 65³ |
| VRAM | 2.10 MB per registered view at 65³, **per device** |
| host memory | 2.1 MB per registered view — the CPU sampler reads the half table in place through a shared 256 KB decode table (a float copy used to add 4.4 MB a view) |
| runtime | 4.76 MB wasm + 1.39 MB Naga, fetched only when a config is opened; starts in ~32 ms and reserves a 64 MB WebAssembly heap; a config loads in ~35 ms |
| adopting a working space | 1.9 s on the 3.5M-tri / 642-texture test model, of which ~1.1 s is the ordinary material rebuild and 0.62 s texture conversion (was 3.0 s: three `Math.pow` a pixel, now a sqrt-indexed 64K table, 0.09 % of values one level off). Still on the main thread. Reverting ~1.0 s |
| EXR save | ~100 ms at 512²; the float copy target is released after each save (132 MB at 4K) |

`MAX_TABLE_TRANSFORMS` is 12: the readback binds every table in one shader and WebGPU only
guarantees 16 sampled textures per stage.
