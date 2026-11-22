# Hardware ray tracing

WebGPU has no ray tracing: the engine walks its own BVH in WGSL (`shaders/BVHTraversal.js`). This note records what
hardware traversal would buy, measured on 2026-11-22 against the one prototype that reaches a web page:
[web-rayquery](https://github.com/ocularmagic/web-rayquery), a patched Firefox exposing wgpu's experimental ray queries
(`createBlas`, `createTlas`, `buildAccelerationStructures`, WGSL `ray_query`); where it can run; and the plan for
exploring it, headless first, then in the browser.

## How it was measured

The Firefox patch is verified on Windows (DX12, Vulkan) only, and the wgpu it carries also runs ray queries on Metal
(macOS 15+). So the measurement skips the browser and runs that same wgpu commit (`49325ca0`, the one Firefox vendors)
natively on Metal: `rq-bench` (Rust; not in the repo, as it needs wgpu from git and cargo — kept with the 2026-11-22
night notes, with a script that builds a scene in the engine in Node and writes its BVH, triangles and placements).

- **Software**: a WGSL port of `traverseBVH` / `traverseBVHShadow` — the same stack, box test, Woop triangle test, BLAS
  pointer leaves and copy clusters — reading the engine's own flattened BVH and triangle records, exported from a scene
  the engine built (that script, the engine in Node). Side culling is off for every ray kind, so both sides hit
  the same surfaces.
- **Hardware**: one BLAS a template (the triangles the engine stores for it), one TLAS instance a placement with the
  placement's matrix, `PREFER_FAST_TRACE`; closest hit = one query; shadow = `FORCE_OPAQUE | TERMINATE_ON_FIRST_HIT`.
  Both kernels then fetch the hit triangle's normals and move them to world space, as the engine's Extend does.
- **Rays**: primary (camera, one a pixel, starting at the camera's clip start as the engine's do), secondary (cosine
  bounce from each primary hit), shadow (towards a sun with a 3° jitter, from each primary hit facing it), and
  surface-to-surface shadow (from each primary hit to another one it faces, as a ray to a light inside the scene is).
  The same buffers go to both kernels, interleaved, timed by GPU pass timestamps; answers are compared ray by ray.

## Results

Apple M5 Pro (Metal ray tracing hardware), macOS 26.5, 1280×720 camera rays, wall time of 8 dispatches in one pass,
median of 12 (pass timestamps agree for the software kernels; for the ray-query pass they were unreliable on Metal).
"Agree" is the share of rays with the same answer both ways (hit or miss, and t within 0.1 %).

| scene | placements | triangles | primary | bounce | shadow (sun) | shadow (surface to surface) | agree |
|---|---|---|---|---|---|---|---|
| instanced field | 100,002 | 3,298 | 7.0× (312 → 2,178 Mrays/s) | 8.4× (171 → 1,443) | 6.1× (295 → 1,791) | 10.0× (113 → 1,130) | ≥ 99.98 % |
| instanced field | 1,000,002 | 3,298 | 9.7× (205 → 1,994) | 12.7× (115 → 1,461) | 8.5× (202 → 1,713) | 12.6× (88 → 1,107) | ≥ 99.82 % |
| instanced field | 6,000,002 | 3,298 | 9.7× (190 → 1,837) | 12.5× (115 → 1,437) | 8.9× (198 → 1,772) | — | ≥ 98.58 % |
| classroom.glb | 865 | 443,632 | 4.7× (354 → 1,653) | 7.3× (162 → 1,184) | 4.5× (521 → 2,330) | 6.4× (192 → 1,238) | ≥ 99.97 % |
| 24155522.glb (room) | 990 | 1,886,098 | 3.5× (547 → 1,900) | 6.1× (228 → 1,396) | 2.9× (754 → 2,215) | 4.7× (329 → 1,535) | ≥ 99.99 % |

The fields are three meshes (2,304 / 720 / 240 triangles) instanced on a grid over a ground plane, seen low from a corner,
so rays cross many copies: the engine builds them with copy clusters past 1M. Bounce rays gain most everywhere. Shadow
rays gain more between two surfaces than towards the sun: often unblocked, they make the software walk clear the whole
segment, while a closed room blocks every sun ray at its first hit. The room's camera starts its rays 0.1 m out (its clip
start), which takes them past a wall at the camera; measured first without it, they hit that wall and their bounces left
the model (1.9 / 2.6 / 1.4×, corrected the same day).

**Against the shipped kernel.** With shipping dispatch and one bounce, the engine's own Extend took 7.5 / 11.5 ms on the
100K / 1M fields and 9.2 / 15.5 ms on the classroom and room, against 5.7 / 8.6 / 8.3 / 5.7 ms for the port's camera plus
bounce walks: Extend also traces the emission-only segment after the last bounce, writes the hit records, culls camera
rays by side and is compiled by Tint rather than naga.

**Builds.** The hardware TLAS is built on the GPU in 3.7 / 30 / 297 ms for 100K / 1M / 6M instances (a rebuild, which is
what a rigid move needs); the engine's whole BVH build for the same fields took 0.22 / 0.67 / 3.4 s on the CPU. BLASes:
25 ms for the classroom's 865, 52 ms for the room's 990.

**Memory.** The hardware TLAS costs ~290 bytes an instance (29 / 281 / 1,679 MB) against the engine's 12 / 77 / 458 MB for
its whole tree there (copy clusters keep a copy to ~76 bytes) — 3.7× more, the one place hardware is worse. Per triangle
the two are close: ~34 bytes of BLAS (classroom, measured with a separate vertex copy) against the engine's ~39 bytes of
BVH node. (Metal's `currentAllocatedSize` lags buffer frees, so BLAS deltas measured beside other allocations are not
reliable; the TLAS ones scale exactly with the instance count.)

**Robustness.** At 6M instances the experimental path is not reliable here: in 4 of 10 runs the TLAS answered as if
most instances were missing (bounce rays: 12,035 hits where the software walk finds 208,471 — the same wrong numbers each
time, and no error from wgpu or Metal). At 1M and below every run was right. Where the two agree less than 100 % it
grows with the scene's extent (0.02 / 0.18 / 1.4 % of bounce rays on fields 0.6 / 2 / 4.9 km across): rounding at
those coordinates, not the traversal stack — 64 and 96 entries answer as the engine's 40 do.

**Conclusion.** Hardware traversal is 2.9–13× faster on identical rays, most for bounce rays and instanced scenes, and
builds the top level 10–60× faster; its top level takes ~3.7× the memory. It is not usable in any shipped browser, and
at 6M instances wgpu's Metal path still gives wrong answers now and then.

## Where it can run (2026-11)

| Where | GPU library | Ray queries |
|---|---|---|
| Chrome, Edge, Electron | Dawn | no — drafts for the standard since 2026-10: gpuweb #11053 / #11054 (acceleration structures), #11056 (WGSL ray query) |
| Firefox | wgpu | prototype only: web-rayquery, a local build with a pref, verified on Windows, under wgpu's names |
| Safari | WebKit | no |
| Node (`rayzee/node`, `bench:node`) | Dawn (`webgpu` package) | no: none of its 26 features on this Mac |
| Deno | wgpu | not in its JavaScript API (`deno_webgpu` at 49325ca0 has no acceleration-structure call) |
| a wgpu host of our own | wgpu | Vulkan (Linux, Windows), DX12 ray tracing tier 1.1 (Windows), Metal (macOS 15+) |

The hardware: NVIDIA RTX, AMD RX 6000 on, Intel Arc; Apple silicon reports Metal ray tracing from M1, but the units are
there from M3 only (M1 / M2 should gain little). The software walk stays wherever the feature is missing (SwiftShader in
Docker, older GPUs).

## Strategy

One engine, two searches: the software walk stays the reference and the fallback, the hardware one replaces it call site
by call site, chosen at startup from the device's features. Headless first, because there we choose the GPU library; the
browser follows the standard. Each phase ends at a gate, a number deciding whether the next one is worth doing.

### Phase 0 — size the prize (no engine change)

Gate: a projected ≥ 1.3× a frame on room-sized models, or ≥ 2× on large instanced scenes, on a platform users render
on. Otherwise stop, and run Phase 0 again when the standard ships.

**Frame split (2026-11-22, M5 Pro): the gate is passed in every scene.** The engine in Node (Dawn), shipping dispatch,
every pixel traced (adaptive sampling and the pixel freeze off), 1280×720, the views above; each kernel's GPU time, median
of 16 frames, two rounds (spread ≤ 3 %, once 9 %). Shadow walks are Shade's drop when every shadow ray answers
"unblocked" without walking (a measurement-only switch in `traceShadowRay`; paths continue as before). The projection
divides Extend by between the camera- and bounce-ray speedups and the shadow walks by the speedup of the engine's own
shadow rays (recorded from that frame and replayed in `rq-bench`, below; the fields: the surface-to-surface one), and keeps
the rest.

| scene | preset | frame | Extend | shadow walks | search | projected gain | if search were free |
|---|---|---|---|---|---|---|---|
| classroom | interactive (3 bounces) | 36.2 ms | 11.9 ms | 15.6 ms | 76 % | 2.7–2.8× | 4.2× |
| classroom | final (20 bounces) | 45.6 ms | 15.0 ms | 20.1 ms | 77 % | 2.7–2.9× | 4.3× |
| room | interactive | 109.4 ms | 27.0 ms | 68.1 ms | 87 % | 3.5–4.0× | 7.6× |
| room | final | 167.3 ms | 38.9 ms | 105.7 ms | 86 % | 3.5–3.9× | 7.4× |
| field 100K | interactive | 16.5 ms | 8.7 ms | 4.3 ms | 79 % | 3.2–3.3× | 4.8× |
| field 100K | final | 17.3 ms | 8.9 ms | 4.9 ms | 80 % | 3.3–3.4× | 4.9× |
| field 1M | interactive | 22.9 ms | 13.4 ms | 6.0 ms | 85 % | 4.3–4.5× | 6.5× |
| field 1M | final | 23.6 ms | 13.7 ms | 6.4 ms | 85 % | 4.4–4.6× | 6.7× |

Limits: one GPU; the speedups are a naga build of the walk against Metal's units, not Tint's build of the shipped one;
"unblocked" also skips the alpha and glass decisions a hardware candidate loop keeps (the final preset tests alpha).

- **Shadow walks are the bigger half in rooms**: 15.6 of 36 ms in the classroom, 68 of 109 ms in the room (43–62 % of
  the frame), more than Extend. Counted (measurement-only counters): 1.62 / 1.29 shadow rays a hit (classroom / room;
  `shadowRays: 'two'`), against one Extend ray; in the room glass sends 24 % of them searching again from the pane.
- **The engine's own shadow rays**, recorded from one frame (3.5 M in the classroom, 5.5 M in the room at the interactive
  preset; the room's are 3.8 m long at the median, every light inside it) and replayed in `rq-bench` (`--rays`): the
  hardware is 6.4–6.5× faster on the classroom's and 7.7–7.9× on the room's. A lean kernel walks them in 11.9 / 24.4 ms
  against 15.6 / 68.1 ms inside Shade: Shade's walks run 1.3× slower in the classroom and ~2.2× in the room once the
  glass re-walks are counted (each pane also reads its material).
- **The room's 75 ms Shade** (the 2026-11-22 bench page) is real: 80 ms at 720p with shipping dispatch, 62 % of it
  shadow walks. The October figure it was set against was a half-size moving frame of the default view, outside the
  room: not comparable, so no sign of a slowdown and no A/B run.
- **Other GPUs**: `rq-bench` now builds for Linux (Vulkan) and Windows (DX12, Vulkan), checked to compile for both, with
  memory from wgpu's allocator report there; its `README.md` says how to run it. Not run yet: no such GPU here.
- **Phase 2's first gate is passed** (below): the engine renders on wgpu, under Deno, as on Dawn.

### Phase 1 — one seam, software only

Every search goes through two calls with one hit contract (distance, triangle, barycentrics, placement, side):
- **closest hit**: Extend (`traverseBVH`), NormalDepth, DepthPass, GPUPick, the debug kernel;
- **any hit**: `traceShadowRay` / `traceShadowRayRefractiveOpaque` (`LightsDirect.js`). They already take the walk as
  an argument, and every shadow ray goes through them: Shade's, fog's, light sampling's and the bidirectional
  integrator's (light tracing passes the camera-culled walk).

The software walk behind both, byte for byte: no bench golden may move (the gate). It ships alone and changes nothing.

**Built 2026-11-22 (branch `feat/search-seam`).** A `SceneSearch` (`closestHit`, `shadowHit`) rides in a kernel's build
context and returns distance, triangle, placement and barycentrics; `traverseBVH` and `traverseBVHShadow` take it when
there is one and complete the record with the walk's own code (`completeHit`). The gate: all 81 compute modules the
engine builds with every feature on, both integrators, the debug view, depth pass, pick and NRD's NormalDepth, are the
same WGSL byte for byte as before. A brute-force search held to the walk on a GPU test agrees ray for ray.
`pathTracer.setSceneSearch()` also runs Phase 3's self-check (below).

**Shadow rays as their own step — prototyped 2026-11-22: kept for the hardware search, not worth it in software.** Shade
writes each shadow ray (the lamps', the environment's, the sun's, the area light its BSDF sample hit, the emitters', or
the pick's) with its unshadowed light and the path's throughput; a kernel after it walks them and adds what gets through
with Shade's own firefly suppression, in Shade's order. Pictures match to rounding (largest difference 4 × 10⁻⁶ on a mean
of 2.7; classroom and room, both presets). GPU frame, interactive / final: room −10 / −9 %, classroom +5–9 / +5 %,
100K field +5 / +3–8 %, 1M field ±0. The walks run faster outside Shade only where Shade is heavy (the room 68 → 54 ms,
the classroom 15.6 → 15.3 ms), and the records cost ~3 ms a frame to write and read and 272 B a path (251 MB at 720p, up
to 1.1 GB at the 4.2M-path budget). A record half the size (packed direction and light) would roughly halve both; not
tried. For the hardware search the shape still holds: one small kernel to swap for raw WGSL with a ray query, Shade
untouched.

### Phase 2 — headless on a wgpu host

1. **Does the engine run on wgpu at all? Yes (2026-11-22, Deno 2.9.8, M5 Pro).** The built engine (`rayzee/dist`, main),
   its Node platform (`nodePlatform()`) and three shims: no-op `requestAnimationFrame` / `cancelAnimationFrame` (Deno has
   `self` but no frames, and three stops its loop through them); `NodeWorker` as the global `Worker` (Deno's takes modules
   only, and three's Draco decoder starts classic ones; the engine lends its host class only where there is no global
   `Worker`); `createImageBitmap` and `OffscreenCanvas` hidden (Deno has both but no 2D context, so texture packing took
   the browser path and failed). naga compiles every kernel (20 in ~3 s cold, ~0.9 s warm). Against Node (Dawn), same
   build, 1280×720, 16 samples: the classroom and the 1.9M-triangle room match — overall brightness within 0.007 %, 32²
   blocks typically 0.01–0.4 % apart against 1–2.5 % between two Node renders of other samples (the compilers round a few
   operations differently, and a path now and then takes another branch). GPU frame within 0–5 % of Dawn's; frames a
   second without readbacks 1–9 % slower. ⚠️ Readbacks are slow there: one each frame (the GPU timer) added ~30 ms a
   frame. The bench corpus under Deno: all 59 scenes pass against the Chrome goldens (OIDN ratio 0.554 against 0.553).
   A 64-sample final render: classroom 2.96 s on Node, 3.25 s on Deno; room 11.16 / 11.86 s (readbacks +4–7 % of the
   time on Deno, +1–4 % on Node). A Deno host would carry the shims in a `denoPlatform()`.
2. **A host binding** giving JavaScript acceleration structures: through Deno's WebGPU (Rust, in the wgpu repository) or
   a Node add-on over wgpu. It takes the standard draft's names (`acceleration-structure`, `createAccelerationStructure`,
   `buildAccelerationStructure`), so the engine's code is the one a browser will need; the Firefox prototype's
   (`experimental-ray-query`, `createBlas`, `createTlas`) map onto them in one adapter.
3. **three.js** (r187) has no acceleration-structure binding and no ray-query node: the binding and the WGSL `enable` go
   in through `ThreePatches.js`, and the hardware search is raw WGSL inserted into the kernels (OIDN's passes are raw
   WGSL today). Its syntax is not settled (the draft weighs five forms for reading a hit), so it lives in one file that
   emits both dialects: naga's now, the standard's later.
4. **Structures.** One BLAS a template, read from the geo store itself (stride 16, `firstVertex` = its first triangle × 3;
   the store gains the BLAS-input usage). One TLAS instance a placement, its id the placement index (24 bits: 16.7M);
   hidden meshes through the instance mask.
5. **Order.** Extend first (closest hit, opaque, both sides; camera rays that must cull stay on the software walk), then
   opaque shadow rays (stop at the first hit). Each call site picks hardware or software on its own, so whatever is not
   ported yet stays software.

**Built 2026-11-22 (M5 Pro, a patched Deno; `pathtracer/HardwareSearch.js`, setting `hardwareRayTracing`).** Deno
2.9.8's WebGPU gained the `wgpu-ray-query` feature and `GPUDevice.createRayScene( vertexBuffer, stride, geometries,
instances )` → a `GPURayScene` (one BLAS a geometry, one TLAS; binds as `accelerationStructure: {}`) with
`updateInstances( instances )`, `updateGeometries( vertexBuffer, geometries, instances )` and `destroy()`
(a patch to Deno's `ext/webgpu` and one to naga's Metal writer, kept with the study, not in the repo). The engine requests the feature where
the adapter has it and, with the setting on, hands the kernels a `SceneSearch` whose WGSL placeholders
`ThreePatches.js` §4 fills when three builds the pipeline (and binds the structures in a group after three's).
- Structures: a BLAS a template from a copy of the geo store (stride 16); a TLAS instance a visible placement, its mask
  whether the template blocks light outright; a table of ( TLAS leaf + 1 | template side << 24, first triangle ). They
  follow the stage's edit counters (`placementEdits`: moves, visibility, material flags; `geometryEdits`: refits and the
  background rebuild after one) at the start of each frame; a structure that changed is checked again (below).
- Hit-finding (Extend): one opaque closest hit past the origin's rounding error (the walk's triangle test clears pbrt's
  bound; a query cannot). A camera ray keeps only the faces the walk keeps — `sideAccepts` on the interpolated normal in
  object space — and searches again just past a face it would cull, up to 8 whole queries (the hardware's own culling is
  by winding: at a coarse mesh's silhouette the two part, and the faces it kept there shaded dark, −0.3 % on the field).
- Shadow rays: any instance that blocks outright (first hit ends it), else the nearest surface among the rest, from
  which `traceShadowRay` walks on as now (glass, cut-outs). Past the origin's rounding error too: a query from a surface
  finds it again, which the walk's shadow rays never do.
- Pictures, 1280×720, 16 samples, against the walk: brightness within 0.06 %, 16² blocks median 0.01–0.4 %, worst
  0.07–2.8 %; the walk against itself with another seed: median 1.1–2.7 %, worst 7–13 %. After a move, a hidden object
  and a refit (classroom): the same. The bench corpus with the hardware on: 59 of 59 against the Chrome goldens.
- GPU frame, interactive / final:

  | Scene | Walk | Hardware |
  |---|---|---|
  | Classroom | 37.2 / 46.7 ms | **13.4 / 16.9 (2.8×)** |
  | Room (1.9M triangles) | 111.9 / 175.6 | **34.7 / 60.2 (3.2× / 2.9×)** |
  | 100K-instance field | 16.7 / 17.3 | **5.9–10.6** (the timer is noisy at this size) |

  Extend 6–8× faster (room 28.0 → 3.8 ms), Shade 2.5–3× (room 80 → 27 ms).
- ⚠️ **On Metal, wgpu (naga 29) never ends a candidate loop**: `rayQueryProceed` returns a flag set at initialisation
  and never cleared (`RAY_QUERY_MODERN_SUPPORT = false`), so `while ( rayQueryProceed( &rq ) )` spins every thread. On
  the room it hung the GPU until macOS's watchdog restarted WindowServer (the Mac rebooted). One `rayQueryProceed` a
  query and opaque geometry only, until naga supports it; `tests/unit/pathtracer/hardwareSearch.test.js` fails on a `while ( rayQueryProceed`.
- ⚠️ naga's Metal output also ignored `CULL_BACK_FACING` / `CULL_FRONT_FACING` (a TODO on winding): patched locally;
  `CULL_BACK_FACING` culls what three.js calls a triangle's back. The engine no longer relies on either.
- Not on the hardware yet: NormalDepth, DepthPass and GPU picking (built without the search), and light tracing's
  camera-culled shadow rays. Kernels with the search use two more storage buffers: Shade reaches 10 of 10.

Gate: quality goldens within noise, ≥ 99.9 % of rays agreeing with the software walk in a GPU test, and frames as much
faster as Phase 0 projected.

### Phase 3 — close the gaps (in order of need)

- **Camera-ray culling per material**: done, the walk's own rule (above); a template mixing sides counts as both.
- **Alpha-tested and transmissive shadows**: done without a candidate loop (above); a candidate loop would let a
  see-through instance's opaque triangles end the search early, once naga's Metal output can run one.
- **Moves — done**: a move, visibility or material-flag change rebuilds the TLAS (3.7 / 30 / 297 ms at 100K / 1M / 6M
  instances); a refit copies the geo store again and rebuilds every BLAS (not yet only the refitted ones). The draft
  adds refit and compaction; wgpu's binding has neither.
- **Large scenes**: ~290 B a TLAS instance (1.7 GB at 6M) and at most 16.7M instances a TLAS (DX12's limit, wgpu's
  24-bit id): the island's 51M placements (~15 GB) do not fit. Small instanced copies grouped into shared BLASes, or
  such scenes kept on the software walk. The compact layout (spilled scenes) keeps no plain positions, which a BLAS reads.
  Built: the walk (and `mode.searchFallback` says why) for the compact layout, copy clusters, a store in parts, data on
  disk and past 20M triangles — the copy of the geo store and the BLASes beside it, unmeasured past the room. Giving the
  geo store the BLAS-input usage would drop the copy.
- **Robustness — built with Phase 1**: after each kernel build with a search, 4,096 camera rays, a bounce and a shadow
  ray from each hit, traced both ways before the first frame; past 0.1 % answered differently, the walk and
  `search.disagrees`. That would have caught Metal's wrong 6M TLAS. Built: after an edit the structures follow, checked
  again once 2 s have passed since the last check (emptied on purpose: caught, 4,095 of 4,096 rays, and the next render
  equals the walk's). Rounding counts as agreement — a bounce either search hits within 10⁻³ of the origin's scale, a
  camera hit on a face whose winding and interpolated normal face the ray differently.
- **The bidirectional integrator**: light tracing's camera-culled shadow rays, and its connections.

### Phase 4 — the browser (the app)

- **Chrome, Edge, Safari**: nothing to build until one ships the feature; follow gpuweb #11053 / #11054 / #11056. Worth
  raising there now: a TLAS's instances arrive as a JavaScript list of dictionaries, each with a nested matrix array —
  slow and large for millions of placements; build could take them from a GPU buffer, as the draft's refit already
  does. Vertex stride and format are per geometry in the draft, so our geo rows work unchanged.
- **The Firefox prototype** (Windows) runs Phase 2's engine code in a page through the adapter: the first browser test.
- **The app** needs nothing of its own: the engine picks hardware when the device has it, and `getProvenance()` and the
  stats say which search ran.

**Risks**: owning a GPU binding, the standard's final shape, TLAS memory on large scenes, wgpu's Metal bug at 6M
instances, its never-ending candidate loop (above), readback latency under Deno. (three.js and naga on our kernels: fine, Phase 2.1.)
