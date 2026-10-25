# Storage and memory

On-disk caches, saved scene state, render checkpoints, and how much memory a scene may use.

## On-disk Storage (OPFS)

On `rayzee/core`, storage needs the `rayzee/addons/storage` add-on (`setStorageOpener`) — see [Renderer core](getting-started.md#renderer-core-rayzeecore).

`engine.storage` is a `StorageManager` over the browser's origin private file system, or `null` where
there is none (a private window, Node) — everything works without it, only slower. The engine keeps
its caches there: downloads (models, skies, OIDN weights — revalidated at most daily with a 1-byte `Range` request, and served from the cache meanwhile),
unpacked `.tar.gz` archives and archive indexes, built scenes (reopened without rebuilding BVHs when
the first build took ≥ 10 s), and environment sampling tables. Caches share a budget of 30 % of the
quota and are evicted least-recently-used; `engine.storage.usage()` reports each area.

A host keeps its own data beside them:

```js
import { STORAGE_KIND } from 'rayzee';

engine.storage.defineArea( 'renders', { kind: STORAGE_KIND.USER } );   // never evicted
const writer = await engine.storage.area( 'renders' ).create( 'render:42', { label: 'Render 42' } );
await writer.writeFile( 'image.png', blob );
await writer.commit();                                                // meta.json last: all or nothing

const entry = await engine.storage.area( 'renders' ).open( 'render:42' );
const file = await entry.file( 'image.png' );
entry.release();
```

`loadFile( url )` and `loadModel( url, { cacheKey } )` download through the cache — pass `cacheKey` for
a link that expires (a signed URL). `fetchFile( url, storage )` / `cachedObjectURL( url )` do the same
for a host's own assets. Failures record `storage.*` issues and fall back to memory; storage never
throws for being absent or full.

**Memory spill.** A static scene too large for memory is built through disk, so its large arrays are never all in
memory at once. By default (`memorySpill: 'auto'`) a scene spills only when its in-memory estimate passes the safe
line (7 GB) — ordinary models never do and load exactly as before; `true` spills every static scene of more than one
64 MB chunk, `false` none. The decision is made per load, and a spilling scene's environment is narrowed to 8192 texels
wide:

- Extraction and BVH building run together. Each stored range of triangles goes to a BLAS worker as
  soon as it is written, and extraction waits while more than 1 GB of triangle records are held.
  On the 55.7M-triangle Moana subset the build peak fell from 6.6 to 4.1 GB.
- The three.js geometry goes to disk after the build last reads it. Past 1 GB of it, it **stays there**
  until something needs it: `await engine.ensureSceneResident()` reads it back, and so does a rebuild of
  the same model. Meanwhile clicking the model selects nothing and a selection draws no outline (its
  arrays are empty). Less than 1 GB comes back when the build ends. On a 70M-triangle scene
  the page held 0.84 GB after extraction instead of 4.07 GB.
- Each triangle chunk and BLAS goes to the GPU, then to disk. At 50M triangles the page settles at
  7.2 GB instead of 9.1 GB.
- Once the load is done, the instance matrix lists, the top-level tree with its copy records and the
  triangle order maps go to disk too. An edit reads back what it needs (a visibility change the tree, a
  move the matrices, the tree and that object's copy records) and lands once it has; 30 s after the
  last edit it all goes back. On the Moana island the CPU data held at rest fell from 6.9 to 2.2 GB, and
  a tab in Chrome from 5.2 to 3.6 GB.
- An environment wider than 8192 pixels is box-filtered down when it loads.

With or without the spill, a mesh past 2M triangles is built as spatial pieces of ≤ 512k triangles
on a worker pool and joined under the tree that split them, so no build holds a second copy of it.

The render is unchanged. Material edits that rewrite triangles (side, transparency, emission), and
refits, read the scene back first. `refitBLASes` throws on a spilled scene until
`await engine.ensureSceneResident()`.

## Saving Scene State

```js
const state = engine.exportSceneState();      // JSON-safe: settings, sky, colour, lights, cameras,
                                              // timeline keys, material edits, hidden and moved objects
const source = engine.sceneSource;            // { kind: 'url', url, cacheKey } | { kind: 'local-file', file } | { kind: 'local-folder', folder } | ...

// later, after loading the same model again:
const { skipped } = await engine.importSceneState( state, {
  resolve: async ( request ) => {
    // { kind: 'environment', source }  → a File, a URL or null (the engine loads URL skies itself)
    // { kind: 'colorConfig', config }  → true once you have loaded it (built-in configs load themselves)
    return null;
  },
} );
```

Objects, materials and cameras are matched by position in the scene plus a name check — UUIDs
change on every load — so a different model keeps its own objects and materials and the rest still
applies; `skipped` lists what could not be put back. Texture swaps on materials are not included yet.

## Render Checkpoints

```js
const checkpoint = await engine.captureRenderCheckpoint();   // accumulation + the counters that pick the next sample
// ...a reload later, the same scene state restored and one frame rendered at the same size:
engine.restoreRenderCheckpoint( checkpoint );
engine.wake();                                               // or await engine.renderFrames( n, { reset: false } )
```

In deterministic mode the continued render is bit-identical to one that never stopped. A checkpoint
is ~60 bytes a pixel (252 MB at 2048²): the accumulated colour and aux buffers as RGBA32F plus three
per-pixel convergence buffers.

---

## Memory Monitoring

Track GPU (VRAM) usage across the whole pipeline. Sizes are measured from live GPU resources (buffer `byteLength` + texture dimensions × format), so they are exact, not estimated.

```js
const { current, peak, byCategory } = engine.getMemoryInfo();   // bytes
// byCategory: { rays, queues, gbuffer, accum, geometry, materials, environment, stages, denoiser, canvas }

engine.vram.resetPeak();   // reset the high-water mark to the current value
engine.vram.getReport();   // formatted one-line summary string
```

`peak` is a high-water mark, reset when a final render begins (`configureForMode('production')`). The engine's VRAM is largely monotonic — the ray pool only grows and the per-stage storage textures are fixed-size — so `peak` equals `current` during a steady render and only exceeds it after memory is released (lower resolution, a smaller scene, or removing the HDRI). The `stages` + `accum` categories (fixed 2048² storage textures) dominate the baseline.

`denoiser` is what the engine allocates for OIDN — its three float inputs, its half-float output and
the motion history. `canvas` is one image per presented surface (a browser may keep one or two more)
plus the buffer three.js's output pass tone-maps through. Not counted: oidn-webgpu's own network weights
and activations, which it reports by count, not by size; and the neural passes, which run on a
`GPUDevice` of their own.

The React app surfaces this as a `Memory: … | Peak: …` readout in the on-canvas stats overlay.

### CPU memory

The wall a large scene hits is not VRAM, it is contiguous `ArrayBuffer` address space on the CPU —
and how much of it a browser can still hand out falls as the tab stays up, so the same scene can
load after a restart and fail after a long session.

```js
const { preflight, allocatedBytes, peakLiveBytes, byPhase, samples } = engine.getHostMemoryInfo();
// null until a scene has been built
```

⚠️ Do not use `performance.memory.usedJSHeapSize` for this. It does not count `SharedArrayBuffer`,
and the triangle and node stores are SAB-backed, so the browser's own reading under-reports a large
scene by gigabytes.

Before extraction the engine prices the scene and applies two lines, both recording
`scene.memory_budget`:

| Estimate | What happens |
|---|---|
| above ~7,040 MB | warns, and builds anyway |
| above ~9,216 MB | **throws** — past this the renderer process is killed rather than throwing an error you could catch, so refusing early is the only useful answer |

Raise or lower the hard line with `new PathTracerApp(canvas, { maxSceneBytes })`. The estimate runs
low at the very top of its range, so the per-load `maxTriangles` cap (45M) is the more reliable
guard on a scene of that size. For a spilling build the estimate leaves out what the build keeps on
disk (the BVH, the three.js geometry, and triangle records past what a streamed build holds at once)
and prices the build by its larger phase — extraction, or the top-level tree — since the two never
hold their arrays at the same time. The whole Moana island estimates 8.6 GB that way.

---

