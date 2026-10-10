# Bidirectional integrator and vertex merging

`integrator: 'bidirectional'` | `'vcm'` — `integrators/BidirectionalIntegrator.js`, `TSL/Bidirectional.js`, `TSL/BidirectionalLamps.js`, `TSL/LightGenerateKernel.js`, `TSL/ConnectKernel.js`, `TSL/LightSplatKernel.js`, `TSL/MergeKernel.js`.

An add-on (`rayzee/addons/bidirectional`): `BidirectionalIntegrator` (`integrators/`) holds everything bidirectional —
its uniforms, buffers, kernels and frame steps — and `PathTracer` calls it through its integrator hooks (`beginFrame`,
`beforeShade`, `afterShade`, `resolve`, `allocate`, `registerKernels`, …) after `pathTracer.registerIntegrator( [
'bidirectional', 'vcm' ], pt => new BidirectionalIntegrator( pt ) )` — `PathTracerApp` registers it. Shade and Generate
take the bidirectional functions from `uniforms.lib`, so the core imports none of them. The `integrator` setting calls
`pathTracer.setIntegrator( name )`; choosing an unregistered integrator records `capability.missing`. Its controls are on the instance: `pt.activeIntegrator.setBidirectionalStrategy()`
and the like. ⚠️ A new integrator plugs into the same hooks; never add `if ( bidirectional )` to `PathTracer` again.
Opt-in (`settings.set( 'integrator', 'bidirectional' )`; the app's Path Tracer tab → Light Transport). Light
subpaths start on **every light**: emissive triangles, the physical sky's sun, the environment map (HDRI,
physical-sky texture, colour sky) and the four lamp types (rect/disk area, point, spot, directional). In this
mode Shade samples each of them itself; `calculateDirectLightingUnified` is not called. `'path'` builds
exactly the unidirectional kernels: everything bidirectional is JS-gated on `params.bidirectional`, and all
102 default kernels dumped over 6 scenes compare identical to the previous build apart from node ids.
- **Frame:** `lightGenerate` → light bounce loop (`extend`/[sort]/`shade`/`compact`/`lightCopyback`, the
  same kernels, rays flagged `RAY_FLAG.LIGHT_PATH`) → `lightSplat` → camera chunks, where `connect` runs
  between `shade` and `compact` and `splatResolve` before `finalWrite`. Light paths per frame =
  min(half the pixels, pool, cache slots ÷ (maxBounces + 1)): at equal time half a pixel's worth beat one on
  the interior below and the caustic room alike (`LIGHT_PATHS_PER_PIXEL`). The light pass keeps its own survivor curve in
  `bounceCounts` [2n, 4n), keyed on that count, the slot count and the loop bound.
- **Strategies:** camera path hits the light (Shade), NEE (Shade, `bidirectionalEmissiveNEE` /
  `bidirectionalSunNEE` — the path tracer's own sun pass is off in this mode), one connection per camera
  vertex (ConnectKernel: a light path picked uniformly, then one of its stored vertices that fits the bounce
  budget, weighted by that count — Davidovič et al. 2014's light vertex cache), and light tracing to the
  pinhole (LightSplatKernel). Light tracing needs a pinhole — perspective with DOF off — and otherwise the
  camera's dVCM starts at 0, which removes it from every weight. A camera path at the bounce limit takes one
  more segment flagged `RAY_FLAG.EMISSION_ONLY` (in either integrator: it is the BSDF-hit partner of the last
  vertex's NEE; Shade ends it before reading any texture when it lands on an opaque surface that does not glow),
  so the camera-hits-light strategy reaches the longest paths too and the weights still sum to one there.
- **The source table** (`sourceCdf`, `BidirectionalIntegrator._updateSourceTable`, rebuilt each frame): a running sum over
  the sun, the emitters, the environment, then each lamp list at `sourceOffsets[ LIGHT_TYPE ]`, by the
  luminous flux each sends into the scene — π·boost·power for emitters; for the sun, a directional light and
  the environment (∫L dω, `environment.exactTable.radianceIntegral`) what crosses the scene's disc; 4πI a
  point, 2π(1 − cos θ)I a spot, P (×A when not normalised) a rect light. It is sized to the lamp lists'
  capacity, which a growing list rebuilds with the kernels. A light path's origin code is its triangle, or
  −1 − its source.
- **Lights at infinity** (sun, environment, directional) start on a disc of the scene's bounding radius facing
  the drawn direction. The bounds are the *visible* placements' box, read from the TLAS as the GPU has it
  (`_visibleSceneBounds`, six branch-and-bound searches): the engine keeps a hidden 240-unit ground plane,
  which made the disc 100× too large. Shade undoes `misOnHit`'s distance at their first hit, since a light at
  infinity has none. Beside lamps or emitters they get light paths for `INFINITE_LIGHT_PATH_SHARE` (5 %) of
  their flux: most of what crosses the disc lands where their NEE does better, and on the 1.9M-triangle
  interior (HDRI + six rect lamps) the sky's 89 % of light paths had made light tracing the noisiest strategy.
  Alone they still get every light path, so their caustics keep them.
- **Light guide** (`TSL/LightGuide.js`, `pt.activeIntegrator.setLightGuiding( bool )`, default on): where on that disc a light
  path starts is learned from camera paths. Each escape at p toward ω counts one in p's cell of the disc
  facing ω (64² cells, 16 octahedral direction bins, in the counter buffer at `COUNTER.GUIDE` — Shade has no
  binding to spare); a kernel folds the counts into running sums at frames 1, 2, 4 … 32, then every 32nd,
  copied into a 4097 × 16 R32F texture. A start is drawn from a learned cell with chance 0.8, uniformly over
  the disc otherwise (`GUIDE_UNIFORM_SHARE`), and every density — light paths, the camera side's sun /
  environment / directional weights — reads `guidedDiscPdf`, so it stays unbiased whatever was learned. A
  reset clears the counts. `tests/gpu/lightGuide.test.js` holds the sampler to its density. Classroom
  (sky + sun through windows) at 256², equal time against unguided: noise −19 % in mid tones, −13 % bright,
  −3 % dark, at +14 % frame time; now below the path tracer in mid tones. Correct to −0.23 % against it.
  An interior lit mainly by lamps (Livspace) is unchanged.
- **Lamps** (`TSL/BidirectionalLamps.js`): NEE picks one with the path tracer's reservoir — same importance,
  same dimensions — less its bounce-depth factor, which a light path cannot know. A lamp's light path
  multiplies that pick into dVCM at its first opaque vertex, with that vertex's normal and material
  (`lampPickPdf`), times a rect light's spherical-rectangle density there. A point, spot or sharp
  directional lamp has no hit strategy, so its light paths start with dVC 0; so does a soft directional one,
  which nothing adds at a miss. Falloff other than inverse-square (decay, cutoff, the near clamp) and a
  directional gobo apply where the light path first lands (`landLampPath`); spot cone, penumbra, gobo and
  IES at emission. Rect lights are not geometry: each camera continuation, after any scatter including
  refraction, is tested against them with a glass-blocking shadow ray (`bidirectionalAreaHit`), where the
  path tracer's own BSDF-hit term follows reflection only.
- **Environment** (`Processor/EnvironmentExactTable.js`; `sampleEnvironmentExact` / `environmentPdfExact`,
  `TSL/Environment.js`): both integrators' NEE, light paths and the miss weight share one table — each cell
  drawn as often as the density it reports, both read from the same running sums. Cells are capped at 1024
  wide; each texel weighs as the bilinear filter's mean over it (1/8, 6/8, 1/8 along each axis: a cell has
  weight wherever the filtered map has light, a sharp texel's neighbours only their share — the brightest
  neighbour it replaced spread a sun three texels wide), less the mean (MIS compensation, Karlík et al. 2019);
  every cell keeps 1e-4 of the mean, so the sphere stays covered. A draw inverts the sums: two guides an entry
  (Chen & Hsu's cutpoints, `GUIDES_PER_ENTRY`) name its entry at once in most draws, else a binary search between
  the guides. Layout (`packExactTable`), ( w + 1 ) × h RGBA: texel ( x, y ) is row y's entry x — its running sum,
  the one below, the guides of steps 2x and 2x + 1 — and texel ( w, y ) the rows' entry y; a draw is two reads per
  dimension, a density two reads in all. Built in `CDFWorker` for HDRIs and colour skies (cached as `cdf:5`), on
  the GPU for the physical sky (`EnvironmentCDF.js`, its twin without the filter); `envTotalSum` > 0 (the path
  tracer) and `bidirectional.envTable` say it is there. It replaced an interpolated inverted table that reported
  the texel's density, not its own (on a 1K HDRI with a sun NEE alone read 4 % bright for upward surfaces and 59 %
  dark from below). The search it first used cost Shade 9–13 % against main; this layout brought the frame back to
  +3 % median (`bench:ab -- main`, no scene slower). ⚠️ An alias table (one read a dimension) was as fast and
  unbiased but doubled a furnace's noise: it breaks the samples' stratification, which inversion keeps — the bench's
  CONVERGENCE gate caught it. ⚠️ Shade is near a register limit: measure Shade changes in place (`bench:kernels`).
  `tests/gpu/environmentExact.test.js` holds the table to its density cell by cell.
- **MIS:** Georgiev 2012's dVCM/dVC recursion, power heuristic, densities from `calculateMaterialPDF` both
  ways round everywhere (`misOnHit` / `misOnScatter` / `misOnSpecular` / `misPartial`). Russian roulette and
  the transparency-layer picks are left out of every density alike, so the weights still sum to one.
  Refraction, a subsurface boundary and a delta lobe are not connectible: dVCM 0, dVC × cos. The partial
  sums ride in `HIT.RNG.yz`. `tests/gpu/bidirectionalMis.test.js` checks a two-bounce path's strategies
  against the power heuristic from explicit densities — for an emitter, a point and a directional lamp, and
  the environment; a dropped exponent or a light at infinity's undone distance fails it.
- ⚠️ **Light tracing obeys the camera's face culling.** Its segment to the pinhole stands in for the primary
  ray, which sees through single-sided faces from behind, so it traces `traverseBVHShadowCameraCulled`, and
  a light vertex on a face the camera would cull carries `extra` = 1 and is not splatted. Hitting both
  sides there blocked every light-traced point of a room seen from outside through its walls: light
  tracing read −21 % and the combined image −12 % on `BDPT.glb`'s default view.
- ⚠️ **A light path ends where light arrives from below the shading normal** (`dot( V, N ) <= 0`, a bump or
  normal map tilting N past the incoming direction). A camera path never samples that direction and NEE
  rejects it, so the light side must count it as zero too; `lightEndCosine`'s absolute values had kept
  it, and an interior with bump-mapped walls read +0.84 % (each strategy alone was exact — only the
  weights stopped summing to one).
- ⚠️ **Geometry terms use the exact facet** (`exactFacetN` in Shade, from `hitFacet`): the hit record keeps
  the facet to 11 bits, which cannot hold "straight up" (it decodes 0.03° off), and at grazing views that
  tilt made light tracing read 0.09 % dark against a closed-form reference.
- **Storage:** Shade binds 8 storage buffers with one part each (10 is the device limit, and BVH/triangle parts take the
  rest — see Buffer parts in `CLAUDE.md`), so the light vertex cache is the hit buffer's tail
  (`HIT_STRIDE_BIDIRECTIONAL`, `PackedRayBuffer.cachedVertex`) and a camera vertex's pending connection is
  four more HIT slots (`pendingVertex`). Cache slots are path-major, `path × (maxBounces + 1) + depth`; a
  path's vertex count rides in its first slot's tag lane with a 24-bit frame tag, so nothing is appended
  atomically and the render is deterministic. Light tracing adds into a u32-per-channel image, fixed point
  ×16384 with stochastic rounding (no float atomics; integer sums are order-free). A weighted splat is
  capped at `SPLAT_MAX` (4096): only light tracing *alone* comes near it (a sun path carries the flux of
  the whole disc). Cost: +512 MB at the default pool (cache 256 MB, pending slots 256 MB) plus 12 B per
  reserved pixel.
- ⚠️ **Glass blocks the bidirectional shadow rays** (`traceShadowRayRefractiveOpaque`), every light's:
  light through it travels the light subpaths. The path tracer's shadow rays pass straight through glass,
  which counts that light a second time, so in a glass scene the two integrators legitimately differ — the
  unbiased reference there is the path tracer with emissive NEE off (and, for the sky, `envTotalSum` set to 0,
  which turns its NEE and the miss weight off).
- ⚠️ **A light subpath carries importance:** Shade undoes refraction's (n1/n2)², evaluates the BSDF with V
  and L swapped (`evaluateMaterialResponse` is not reciprocal — energy compensation keys on NoV), and
  applies the shading-normal correction (Veach 5.3.2, `lightEndCosine`) to light-side cosines.
- **Emitter sides:** emission follows the triangle's side flag (half each way for DoubleSide). NEE draws a
  triangle on every side it emits from (`sideAccepts` on the winding normal, the facet's cosine for the
  density) and the hit-side pdfs return 0 for a side it cannot draw; front-only NEE had cost the path tracer
  83 % of a two-sided lamp seen from behind. ⚠️ The emitter-hit side test uses the winding normal
  (`windingNormal`, `HitFacet.js`): the interpolated one turned away near a coarse sphere's silhouette.
  ⚠️ Every side test takes a **unit** normal: `sideAccepts` has a ±1e-4 threshold, and a raw cross product of a
  small triangle is under it — a 3 cm bulb's NEE density read 0 on the light side and bidirectional counted its
  light twice (2.0× on the floor). `tests/gpu/emitterSides.test.js` holds it at 1 and 1e-3 units.
- **Verification** (`pt.activeIntegrator.setBidirectionalStrategy( 'hit' | 'nee' | 'connect' | 'lightTrace', { alone } )`
  keeps one strategy, MIS-weighted or alone at full weight). A lamp over a matte floor has a closed form
  (Lambert's polygon formula): every strategy alone and the combination land within noise of it (all
  |bias| ≤ 0.02 %). Exact-length references come from the path tracer with emissive NEE off at
  maxBounces + 1. Sunlit courtyard (5° sun, 4 bounces) against NEE alone: combined −0.002 %, light tracing
  −0.002 %, connections +0.23 % (z 1.1), camera hits +0.16 % (z 0.6). Each lamp type over the floor has a
  closed form too (I·cos/d³, a smoothstepped cone, Lambert, a parallel disk, E·cos), as does a uniform or
  painted-sun sky over it: every strategy alone and the combination within noise, the weighted views
  summing to 100.00 %. In a room at 4 bounces each lamp, all five at once, and a sky through the open side
  match the path tracer (lamps) or the BSDF-only path tracer (sky) within ±0.06 %, with glass too; a rect
  light behind glass matches the same room with an emissive panel (+0.052 % against +0.050 %).
- **Measured** (Apple M-series): the 1.9M-triangle interior (HDRI + six rect lamps + emitters) at 512², 3
  bounces, 16.8 → 34.3 ms a frame; kernels compile in ~0.4 s on a switch. At equal GPU time (256 against
  125 spp, each against its own 4096-spp image) it is 23 % lower in screen RMSE (1.67 against 2.17 levels):
  dark rooms 28 % lower, mid tones 18 % lower, sky-lit walls 5 % higher. Before the sky's share, the
  compensated table and half the light paths it was 2.02 against 2.17, sky-lit walls 2.2× higher. Caustic room at 64 spp: RMSE against the
  unbiased reference 10× lower than path tracing; Cornell with emissive NEE off 4.7× lower, with it on
  equal. Equal time, error variance against an independent reference: `BDPT.glb` (lamp behind a door)
  2.2–2.9× lower; Sponza's sunlit arcade 1.6× *higher* and a ceiling-lit room 1.7× higher — light reached
  directly is already what camera paths + NEE do best (those three predate the changes above). A room lit only
  through a window stays 1.5× better path traced; a spot or a sky with a sun through a glass ball is light the
  path tracer never converges to (−0.75 % and −7.7 %, its shadow rays passing the glass straight). Bench:
  `cornell-bidirectional` and `lamps-bidirectional` take their truth from the path tracer (`truthSettings`,
  new in `bench/runner/quality.js`), `caustic-bidirectional` and `sky-bidirectional` from themselves. They
  catch dropped connections (−4.9 / −4.3 %), dropped light tracing (−8.2 / −8.5 %), an emitter NEE weight
  blind to light paths (+13 / +11 %), no lamp or environment light paths (−30 %, −24 %), the lamp pick left
  out at landing (−15 %), the environment's miss weight blind to light paths (+4.2 %) and its density off by a
  factor (×140). `lamps-bidirectional` has a
  rough metal ball because only there does a rect light's continuation hit carry weight: in an all-matte
  room both of its terms could be dropped unnoticed.
- **Vertex merging** (`integrator: 'vcm'`, `TSL/MergeKernel.js`; Georgiev et al. 2012): bidirectional plus
  photon merging, the one strategy for light no connection reaches — a point lamp's caustic seen in a mirror or
  through glass (specular–diffuse–specular). Each camera vertex Shade leaves pending (now also at the bounce limit)
  gathers this frame's light vertices within its radius; a merged path of k scattering vertices needs
  cameraDepth + l ≤ maxBounces + 1. MIS: Georgiev's dVM is dVC / η² at the merge vertex (η = πr² · light paths),
  so nothing new is stored: `misOnScatter` adds η² of the vertex it leaves to dVC, `misPartial` η² of the vertex a
  sum ends at, and a merge weighs both sides with `misMergePartial` and 1 / η². `bidirectionalMis.test.js` checks a
  two-bounce path's six strategies with a different η at each vertex.
  - **The radius is a pixel's footprint where it gathers** (`mergeRadiusAt`: `mergeConst` + `mergeSlope` ·
    distance from the camera, ≥ `mergeMin`; constant for orthographic), default 1 px (`pt.activeIntegrator.setMergeRadius( px )`),
    shrinking as n^−⅛ (α = 0.75). A function of position alone, so both subpaths agree on η anywhere. ⚠️ A fraction
    of the scene's radius (SmallVCM's choice) made the classroom's 30 cm (its bounds include the outdoors): 5× the
    frame time and 92 % of the image merged. And `sceneRadius` was only measured with a light at infinity.
  - **Trust** (`pt.activeIntegrator.setMergeTrust( t )`, default 0.25): the weights take η × t. Any density the strategies agree on
    still sums to one; light only merging reaches keeps weight 1 (the mirror caustic is identical at 1 and 0.25),
    and light other strategies reach goes back to them unblurred. Merging's bias is boundary bias (a sphere past a
    crease or a small object): Livspace read +6.1 % at 2 px, +0.69 % at 1 px, +0.17 % at 1 px with trust 0.25; the
    classroom +0.95 / +0.28 / +0.08 %. ⚠️ Rejecting light vertices of a differently facing surface (a corner's
    other wall) made it −3 % instead: their light stands in for the sphere past the crease.
  - **Grid:** light vertices are filed by their radius in shells (ratio 1.25; a sphere reaches at most two), each a
    hash grid of cells 2 · its largest radius / (1 − slope) wide — one list a cell through the cached record's spare
    lane (`next`, record quad 3 .w; `extra` moved to the material word's top 8 bits). `mergeClear` + `mergeInsert`
    after the light pass; `merge` after `connect` walks 2³ cells per shell, counting a light vertex only in its own
    shell and cell (a hash collision would count it twice), at most 1024 a cell. Heads: a power of two ≥ the cache
    slots (16 MB at 4M).
  - **Measured** (Apple M-series): frame time over bidirectional +9 % classroom and +28 % Livspace (256², 1 px),
    +5 % glass of water (512², 2 px). The SDS test (`sds-mirror` / `sds-mirror-bulb` in the test-scene manifest): with a 3 cm
    bulb a camera path can hit, bidirectional with the firefly limit off reaches the mirror caustic at 4096 spp
    (0.2329) where merging does at 512 (0.2301, overall −0.02 %); with the default limit bidirectional loses it
    (0.07). Cornell box, merging alone against bidirectional: −0.14 % (z 1.3). Where other strategies already
    work it costs more than it saves (Livspace and the classroom +7–8 % noise at equal time); it is for caustics
    seen in mirrors and through glass. Bench: `mirror-caustic-vcm` (truth from itself).
- **Not covered:** emissive textures (NEE and light paths both use the per-triangle emission); a dispersion
  wavelength shared between the subpaths. Without merging, specular–diffuse–specular paths from a lamp no camera
  path can hit (a point, spot or sharp directional lamp) have no strategy at all — `'vcm'` covers them. Connections test the
  camera end against the facet, where NEE and the bounce leak guard use the interpolated normal: smooth
  meshes can differ at grazing directions.
