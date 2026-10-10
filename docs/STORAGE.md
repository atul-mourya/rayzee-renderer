# Storage (OPFS) (`rayzee/src/Storage/`)

`app.storage` is a `StorageManager` over the origin private file system, opened per
`cacheNamespace` and shared by every app on the page (`acquireSharedStorage`, ref-counted). It is
`null` when the browser has none (private windows, Node without the fake) — every caller must
work without it.
An add-on (`rayzee/addons/storage`): the OPFS implementation (`StorageManager`, `StorageOps`, `StorageWorker`, the
transports, `locks`, `events`, `openStorage`) is reached only through `renderer.setStorageOpener( acquireSharedStorage )`
— `PathTracerApp` installs it. The caches that *use* a manager stay core (`DownloadCache`, `CDFCache`, `BLASCache`,
`SpillStore`, `GeometrySpill`, `identity`, `shared`) and import area names from `Storage/areas.js`, never
`StorageManager.js`. Without the add-on, `storage: 'auto'` asked for explicitly records `capability.missing` (a warning). `configureAssets( { storage: false } )` or `new PathTracerApp( c, { storage } )`
turns it off or supplies a host manager; `openHeadless` defaults to off.
- **Areas.** Engine: `downloads` (URL cache, revalidated at most daily with a 1-byte `Range: bytes=0-0`
  GET, compared on Last-Modified and, where Content-Range is readable, the size; a failed check is
  stamped too. ⚠️ Not HEAD: the asset host's CORS rule allows GET only, so every HEAD failed CORS,
  and unstamped it retried — and logged the error — on every page load), `archives`, `scenes` (graph + BLAS cache), `cdf`, and `spill`
  (kind `scratch`). App: `renders`, `sessions`, `projects`, `jobs` (kind `user`). `cache` areas
  share a budget (30 % of quota, ≤ 100 GB) and are evicted least-recently-used, never while
  locked or pinned; `user` areas are never evicted; `scratch` is outside the budget and cleared at
  open unless an open page holds it. ⚠️ The budget caps what caches accumulate, not one write —
  a single entry larger than the budget is allowed when the disk has room. The cache total lives in
  memory (`_cacheBytes`: listed at most every 30 s, this manager's commits counted, `collect` resets
  it exactly): listing every entry's metadata on every new download cost ~0.4 ms an entry — 100
  downloads into a 1,090-entry cache took 12–14 s with 173–373 ms frames, now 0.6 s; a first visit
  read 7,968 meta files, now 377. Removals are not subtracted, so between listings it can only
  over-count (evict early), never let caches outgrow the budget.
- **Entry protocol.** An entry is a directory of files plus `meta.json`, written **last**; no valid
  meta means invisible, and `sweep()` removes it. `area.create( key )` replaces, `edit( key )`
  appends (growable files resume from their committed length). ⚠️ `create` removes the old entry
  first, so anything rewritten often (sessions, checkpoints) alternates between two keys and
  deletes the older after the commit.
- **I/O.** All writes go through sync access handles in `StorageWorker` (`createWritable` is Safari
  26+ only); reads use `File.slice` on the main thread. `EntryWriter.write` copies the data
  before its first await — muxers and stream readers reuse their buffers.
- **Locks.** Web Locks per entry (`acquireLock`, in-process fallback in Node): writers exclusive,
  readers shared with `ifAvailable`, so an entry being written counts as a miss. Sessions hold a
  lock per tab for the page's lifetime; that is how a second tab tells a live session from one to
  offer.
- **Failures** record `storage.*` issues (`unavailable`, `quota_exceeded`, `write_failed`,
  `read_failed`, `entry_corrupt`, `cache_mismatch`) as warnings and degrade to the in-memory path;
  nothing throws for lack of storage. A quota failure mid-download retries once in memory.
- **Identity.** `fileIdentity( file )` = name, size, lastModified and a SHA-256 over the head, tail
  and 14 probes (~3 MB read at any size); `identityKey()` is the string form used in keys.
- **Scene cache** (`SceneGraphCodec`, `BLASCache`): stored when the cold build took ≥ 10 s and the
  read-back is under a third of it (`worthStoring`). A parse slow enough on its own is written
  *during* the build, each array let go once written: held until the build ended, the encoded
  graph kept every array the build replaces (float normals, instance matrices) alive — ~1 GB at
  the peak on the whole Moana subset. The BLAS cache is content-checked — a
  template's stored BLAS is used only if its position checksum matches — so extraction, TLAS and
  textures always run as before. ⚠️ `Material.toJSON` stores colours as 8-bit sRGB hex and
  `MaterialLoader` rounds `ior` through `reflectivity`; the codec carries both exactly
  (`exactColors`, `exactIor`) or the warm render differs. Read sections in one forward pass of
  large windows: thousands of small `File.slice` reads took 9.8 s, one pass 0.37 s.
- **Scene state.** `app.exportSceneState()` / `importSceneState( state, { resolve } )`
  (`SceneState/`): host-set settings (`settings.serialize()`), environment (mode, sky params, HDRI
  source), colour (config, view, look, working space, context), every light, cameras (live view,
  user cameras, per-camera effects), timeline keys, host material edits (with values —
  `_hostSet` is a Map), hidden objects, gizmo-moved objects. Objects are matched by child-index
  path, materials by index, model cameras by index — each **plus a name check**; UUIDs change per
  load. `resolve` answers what the engine cannot reach (a local HDRI, a non-builtin OCIO config).
  `toPortable` / `fromPortable` keep colours, vectors and non-finite numbers through JSON.
  `app.sceneSource` says where the model came from (`url` / `local-file` / `object3d`, with an
  archive's `element`); `sceneSourceFile` is the File of a local load. Not restored: texture swaps
  and texture-transform edits, host Object3D loads, a picked OCIO folder.
- **Sessions and projects** (app: `lib/session.js`, `lib/project.js`, `SessionDialog`): autosave
  2 s after the last change and on hide, only in Preview and only when the JSON fingerprint differs
  from the last save — an untouched startup scene is never saved. Startup offers only an unfinished
  render; saved sessions wait in File → Open Recent, and opening one whose model is on screen, still
  as it loaded (`SessionKeeper.isAsLoaded()`), reuses that model rather than loading it twice. A local
  file is never copied: restore asks the user to pick it again and checks its identity. `.rayzee`
  = zip of `project.json` + thumbnail + the local model stored inside (≤ 3.5 GB streamed).
- **Render checkpoints.** `app.captureRenderCheckpoint()` / `restoreRenderCheckpoint( cp )` —
  colour + aux MRT, m2 / streak / frozenMask, `frameCount`, `_seedTick`, aux samples and
  convergence; bit-identical continuation in deterministic mode. All six readbacks are submitted
  in one task, or the parts straddle frames. Restore does not wake the loop (a synchronous frame
  would add a sample). The app writes one every 2 min of a final render (`lib/stillJob.js`,
  ~60 B a pixel: 252 MB at 2048²) and journals video frames (`lib/videoJob.js`); both resume from
  the startup dialog. ⚠️ A resumed encoder must start on a keyframe.
- **Memory spill (`memorySpill`: `'auto'` default | true | false; app: Path Tracer → Advanced → Memory Saver,
  kept in `localStorage['rayzee-memory-spill']`).** Each build decides (`RayzeeRenderer._planSpill`, after the parse and
  before the scene's metadata environment starts loading): `'auto'` spills a static scene whose in-memory estimate
  passes `SAFE_SCENE_BYTES` (`SceneProcessor.needsSpill`, the preflight's survey without the spill), true every static
  scene, false none; storage is required either way. `sceneProcessor.spilling` / `app.sceneSpilled` say a scene went to
  disk (built to spill and over one chunk) — the after-load spill and respill run only then, and the app shows a
  "Large scene" toast on `MODEL_LOADED`. Ordinary models estimate far below the line (24155522.glb: 651 MB) and take the
  in-memory path exactly as before. ⚠️ An importer installs its own sky at the end of its read (USD dome, pbrt
  `infinite`), before the decision: `_planSpill` narrows it there and disposes it, since three.js keeps an uploaded
  texture's size. Narrowed only at decode, the island's 14308-wide sky went to the GPU whole (a 1.5 GB upload block in
  the GPU process). The width resets at each load's start, so a previous spilling scene never narrows the next one's.
  A spilling scene of more than one chunk is **extracted and built together**
  (`SceneProcessor._extractStreaming`, `GeometryExtractor.extractStreaming`): each stored range
  goes to a BLAS worker as soon as it is written (`_blasPool` takes work while it runs), and the
  extraction waits while more than `STREAM_RESIDENT_BYTES` (1 GB) of records are in memory — so
  the triangle records are never all resident. Whole Moana subset: build peak 6.6 → 4.1 GB, render
  bit-identical. ⚠️ That wait races a *timer*: racing a settled promise spun it in microtasks and
  starved the worker messages it waited for (a hung tab). The three.js geometry goes to disk too,
  from its last read until the build ends (`Storage/GeometrySpill.js`, handed over by
  `GeometryExtractor._geometryReleaser`, compressed first): never a host's (`__rayzeeExternal`), a
  deforming one, or one sharing an array with another geometry. Small arrays go out packed in 32 MB
  writes; a geometry keeps its bounds (computed before its arrays go). From `GEOMETRY_ON_DISK_BYTES` (1 GB) up it
  **stays on disk after the build** (`sdf.geometryOnDisk`; less comes back at its end — 24155522.glb's 140 MB left on disk had
  cost picking and the selection outline): `ensureGeometryResident()` / `app.ensureSceneResident()` read it back in 64 MB windows (3.9 GB in
  3.0 s at 80M), and a rebuild of the same model does so first. Picking skips the model meanwhile
  (`InteractionManager._intersectScene`): its arrays are empty, and testing 51M empty copies held the page for seconds.
  Page after extraction on the 70M fixture 4.07 → 0.84 GB, render bit-identical. A failed
  build does not read it back — the app discards a failed load's model. **After the load** (`spillAfterLoad`, from the
  renderer's `_maybeSpill`, once the initial visibility pass has used them) the InstancedMesh matrix lists the instance
  table reads go to disk (`_matrixSpill`; each mesh's `boundingBox`/`boundingSphere` set from its copies' boxes first,
  since three.js derives them from the list), the TLAS and the copy records too when copies are clustered (`_spillTLAS`,
  keeping the chunks over the group trees), and the triangle order maps (`_orderSpill`, read back by `ensureResident`). An edit reads back
  what it needs: visibility waits on `whenTLASEditable()` (the renderer applies and resets after it), a move on
  `ensureMovable( meshIndices )` (matrix lists, TLAS, that mesh's copy records — `updateMeshTransforms` returns null
  and lands when they are back). 30 s after the last edit (`RESPILL_AFTER_MS`) the renderer puts back on disk what edits
  read back (`respill`, skipped while a read is in flight); the matrix lists a restore made, and each 32 MB pack once written, are let go at once
  (`buffer.transfer( 0 )`) and page-ins read straight into their chunk (`SpillStore.readInto`), since Chrome frees a dropped
  ArrayBuffer only at a major collection, which an idle page may not reach for minutes. The BVH chunks are
  SharedArrayBuffers, which cannot be let go early: after a move on the island ~2 GB (TLAS and copy records) waits
  for that collection. Chrome, island at rest: tab 5.2 → 3.6 GB, GPU process 15.6 → 13.5 GB (with the upload pacing
  under Memory Management in `CLAUDE.md`). Moana island at rest, Node: ArrayBuffers 6.9 → 2.2 GB
  (matrices 2.4, TLAS and copy records 1.6, order maps 0.43, the two cluster columns now derived 0.19); moving its 69,856-copy mesh
  reads 3.5 GB back (1.7 s), refits in 0.1–0.2 s and uploads 40 MB, where every move had uploaded the whole 1.3 GB TLAS. An environment wider than
  `SPILL_ENVIRONMENT_WIDTH` (8192) is box-filtered down in place when it loads (`limitEnvironmentWidth`): Moana's
  14308×7154 sky was 1.6 GB of floats. Curves are built with 16-bit normals (`packUnitAttribute`, what extraction stores). ⚠️ A shared buffer handed
  to the storage worker lives until that worker next collects garbage, which it barely does: every
  spilled 64 MB chunk stayed in memory (2.5 GB of them measured), invisible to
  `measureUserAgentSpecificMemory`. `transferable()` copies shared data into a transferred buffer
  for that reason. Otherwise the spill happens **during the
  build** (`SceneProcessor._beginProgressiveSpill`): each BLAS goes to scratch as it lands, a triangle
  chunk is uploaded (`PathTracerStage.createChunkUploader`, a GPU buffer allocated after
  extraction) and spilled once every BLAS over it is built, and the combined BVH is assembled from
  scratch, uploading and spilling each chunk the fill passes (each upload awaited, `stage.drainUploads()`). Chunks
  holding emitters stay, and the TLAS chunks until the after-load spill. `setTriangleData` / `setBVHData` adopt the
  pre-filled buffers. A scene restored
  from the BLAS cache spills after upload instead (`spillToDisk`). 50M triangles: 7.2 GB at rest
  against 9.1 GB; the page peak (~11 GB, at the start of the BLAS phase) is unchanged. Readers
  page in first — `refitBVH`, `rebuildMaterials`, and `setMaterialProperty` for
  `TRIANGLE_PATCH_PROPERTIES` — while visibility and rigid moves need only what the after-load spill took (above);
  `refitBLASes` throws until `await app.ensureSceneResident()`. ⚠️ Views taken with `viewAs` keep chunk memory
  alive, which is why the store tracks them (weakly). ⚠️ Past `maxBufferSize` (4 GB here) WebGPU
  returns an invalid buffer and every write fails quietly, so the BVH and triangle stores go up in parts
  (see Buffer parts in `CLAUDE.md`); the chunk uploaders allocate them.
