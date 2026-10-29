# Scenes

Loading models and environments, and the camera, lights, materials and animation in them.

## Loading Assets

```js
await engine.loadModel(url)                  // Load a GLB/GLTF by URL
await engine.loadFile(fileOrUrl)              // Any supported file: GLB/GLTF/FBX/OBJ/STL/PLY/DAE/3MF/USD/USDZ, archives, HDR/EXR
await engine.loadFile({ files })              // A folder of files — see Loading a folder
await engine.loadObject3D(object3d, name?)    // Load a Three.js Object3D directly (name is optional, defaults to 'object3d')
await engine.loadEnvironment(url)             // Load HDR/EXR environment map
engine.cancelLoad()                           // Abort an in-flight download (network phase only; no-op once processing starts)
```

On `rayzee/core`, formats other than glTF and `.hdr` need the `rayzee/addons/formats` add-on — see [Add-ons](getting-started.md#add-ons).

`loadModel` / `loadObject3D` **replace** the current scene. A model that carries cameras opens through its first one; `cameraManager.switchCamera(0)` goes back to the default view, fitted to the model. To add or remove objects from a live scene without a full reload (and without reframing the camera):

```js
const id = await engine.addModel(url, { name })                  // Append a model, rebuild in place
const id = await engine.addModelFromObject3D(object3d, { name })  // Append a copy of a caller-owned Object3D (yours is untouched)
engine.getSceneObject(id)                                         // Resolve an id to the rendered root (the copy)
await engine.removeSceneObject(id)                                // Remove by id — returns false if not found
engine.setSceneObjectVisibility(id, visible)                      // Toggle visibility with an O(1) BVH-leaf patch, no rebuild
```

`engine.sceneModel` is the root of what is actually being rendered — for `loadObject3D` that is the engine's copy, and it is the object to mutate before `refitBVH()`.
`engine.getModelBounds()` returns the loaded models' world bounds as a `Box3` (empty when nothing is loaded), leaving
out the built-in ground plane — the box fog fills by default.

`id` is the appended root's `Object3D.uuid`, returned by `addModel`/`addModelFromObject3D`. For `addModelFromObject3D` the engine carries your object's uuid onto its copy, so the id matches the object you passed. The built-in ground plane is permanent and can't be removed.

### Loading a folder

A model that comes as several files — a `.gltf` with its `.bin` and textures, an `.obj` with its `.mtl`, a pbrt
scene — loads from its folder as the same folder zipped would, with nothing unpacked or copied: each file is read
only when the scene asks for it. On `rayzee/core` this needs the `rayzee/addons/archives` add-on.

```js
await engine.loadFile({ files: input.files });    // <input type="file" webkitdirectory>: paths from webkitRelativePath
await engine.loadFile({ name: 'Sponza', files: [  // or path + file pairs: a drop, a directory handle, fs.openAsBlob in Node
  { path: 'Sponza/sponza.gltf', file: gltf },
  { path: 'Sponza/sponza.bin', file: bin },
] });
```

Loose files picked together load the same way. Hidden files and folders (`.DS_Store`, `.git/`) are left out. The model
that loads is a `scene` / `model` / `main` / `asset` glTF when there is one, else the shallowest model, glTF first; the
others are named in an `asset.ambiguous_entry` warning. A large pbrt or USD folder of several parts asks which to load,
as an archive does (below).

A USD scene — a folder or archive whose main model is a `.usd` / `.usda` / `.usdc` layer, or a loose layer — loads
through the engine's own USD importer, part of the archives add-on: composition (sublayers, references, payloads,
inherits, specializes, variants), meshes, curves, point instancers, PxrDisneyBsdf / PxrSurface / UsdPreviewSurface
materials, cameras, lights and the dome light as the environment. Each layer is read only when composition reaches it. A
`.usdz` stays with three.js's loader (`usdFormat`). Ptex is not read: a Ptex input takes the mesh's mean
`displayColor`. `sceneSource` is `{ kind: 'local-folder', folder: { name, size, lastModified, sample, files }, key }`
— `sample` hashes every file's path, size and date, so any change inside the folder changes it — and
`sceneSourceFolder` hands the files back, as `{ name, files: [{ path, file }] }`.

### Loading part of a scene archive

On `rayzee/core`, archives and pbrt need the `rayzee/addons/archives` add-on — see [Renderer core](getting-started.md#renderer-core-rayzeecore).

A pbrt-v4 scene archive (`.tar`, `.tar.gz`, `.zip`) is usually a root `.pbrt` file that includes one
subtree per element, and the whole thing rarely fits in a browser tab — Moana is 29 GB unpacked.
The archive can be inspected without retaining any of it, then loaded one element at a time:

```js
const { kind, root, elements, entryCount, totalBytes } = await engine.inspectArchive(file);

await engine.loadFile(file, { element: elements[0].prefix });     // one element
await engine.loadFile(file, { element: [ a.prefix, b.prefix ] }); // several together
```

Everything above a chosen element comes along — the root scene file, the material library, an
ancestor's `textures` folder — and an `Include` pointing at an element you left out only warns,
which is what makes a partial load work. Selecting every element is a valid answer and loads the
whole scene.

Past 4 GB unpacked (a USD scene: past 1 GB of layers), a multi-element archive or folder **throws**
`ARCHIVE_NEEDS_ELEMENT` rather than taking all of it. The error carries the element list — each
`{ name, prefix, files, bytes, scenes }` — so a host can turn it into a picker:

```js
try {
  await engine.loadFile(file);
} catch (err) {
  if (err.code === 'ARCHIVE_NEEDS_ELEMENT') showPicker(err.elements, err.root, err.totalBytes);
  else throw err;
}
```

Per-load options for pbrt and USD scenes:

| Option | Default | Effect |
|---|---|---|
| `promptBytes` | 4 GB | moves the line past which a multi-element archive asks for elements |
| `maxTriangles` | 45M (120M with storage, unless `memorySpill: false`) | past it, placements are skipped and the build reports itself truncated (a USD scene thins curve sets and point instancers first, and never cuts a mesh short unless meshes alone are over) |
| `maxPlacements` | 6M (60M with storage, unless `memorySpill: false`) | the same, for placements |
| `curveTolerance` | 0.05 | how far a curve segment may stray, × the curve's half-width; curves become strips with adaptive segments. `0` gives the old uniform strips bit for bit |
| `instanceIncludes` | `true` | a file included again under the same material, with no side effects, is placed as an instance of its first reading instead of being read and stored again |

45M is the highest rung measured to survive without the spill, which is why the caps rise only where the build can
spill; the preflight still refuses what cannot fit. With the spill, the whole Moana USD island — 111.6M triangles, 51.0M
placed copies — loads and renders in Chrome on a 24 GB Apple M-series in about 4½ minutes. Past
WebGPU's 4 GB buffer limit the triangle and node stores go up in parts, so buffer size no longer caps a
scene. Past 1M placed copies the top-level tree is built over clusters of four neighbouring copies
(about 80 bytes a copy instead of 128), which costs such a scene 17–20 % frame time and nothing below
that size.

## engine.cameraManager

Camera switching, auto-focus, DOF, and direct Three.js access.

```js
engine.cameraManager.active                  // The active camera: a PerspectiveCamera that can turn orthographic
engine.cameraManager.controls                // The OrbitControls instance
engine.cameraManager.switchCamera(index)      // Switch between scene cameras
engine.cameraManager.getNames()              // List available cameras
engine.cameraManager.focusOn(center)         // Focus orbit camera on a world-space point
engine.cameraManager.setAutoFocusMode(mode)  // 'auto' | 'manual'
engine.cameraManager.setAFScreenPoint(x, y)  // Set normalized AF screen point (0-1)
engine.cameraManager.setNavigationMode(mode) // 'orbit' | 'walk'
engine.cameraManager.walkControls.speed      // Walk speed, scene units per second
engine.cameraManager.orthoHeight             // Orthographic view height, scene units, wheel zoom included
engine.cameraManager.setOrthoHeight(height)  // Set it
```

**Walk mode** is first-person navigation: drag to look, W A S D or the arrow keys to walk level, E and Q to
rise and sink, Shift faster, Alt slower. A new model resets `speed` so the walk crosses it in about eight
seconds. Keys are ignored while focus is in a text field, list or menu, and when a focused control has
already used the key. The mode obeys `controls.enabled`, so anything that locks the orbit camera locks walking
too. Switching back to `'orbit'` circles the surface at the centre of the view.

## Camera Projection (Orthographic, 360° Panorama)

Three camera models live behind the `cameraProjection` setting. All are compiled into the same kernel, so switching writes a uniform and resets accumulation — it never recompiles WGSL.

### Orthographic

```js
engine.settings.set('cameraProjection', 'orthographic');
engine.cameraManager.setOrthoHeight(12);   // the view's height in scene units
engine.addEventListener(EngineEvents.ORTHO_HEIGHT_UPDATED, ({ height }) => {}); // the wheel changed it
```

Rays are parallel and start on the camera's image plane, so nothing behind the camera is seen and nothing shrinks with distance. Switching keeps what the view shows at the orbit target: turning orthographic sizes the view from the orbit distance and field of view, and turning back moves the camera to match. The wheel then zooms by changing the view's size rather than moving the camera. A new model is framed the same way.

`engine.cameraManager.active` stays the same object — it switches its own projection and reports `isOrthographicCamera` — so picking, the transform gizmo and the overlays follow without anything being re-pointed. Imported orthographic cameras (glTF, and pbrt's `Camera "orthographic"`) switch the projection to orthographic at their own size, and a camera left orthographic comes back so; any other camera switches it back to perspective. Every denoiser, auto-focus and depth of field keep working. An environment at infinity is seen from a single direction, so the background is one colour.

### 360° Panorama

```js
engine.settings.set('cameraProjection', 'equirectangular');

// Optional: crop the sweep. Degrees, [min, max].
engine.settings.set('panoramaLonRange', [-90, 90]);   // VR180
engine.settings.set('panoramaLatRange', [0, 90]);     // upper hemisphere only
engine.settings.set('panoramaLevelHorizon', true);    // default — orbit pitch won't tilt the panorama
```

The mapping puts camera-forward at the image centre, the zenith at the top row, and yaw-right at increasing u. Full-sphere output is 2:1 — **size the canvas accordingly** (`engine.setCanvasSize(w, w / 2)`); the engine renders whatever aspect you give it and will stretch the sphere otherwise. A cropped range changes the natural aspect to match `lonRange / latRange`.

Depth of field still works: the lens plane is built from each ray's own frame, not the camera's, so bokeh stays round across the whole sweep.

Two features are incompatible with a non-frustum camera and the engine switches them off for you when panorama is enabled:

- **NRD** hands the view to OIDN — NRD's motion vectors unproject through the projection matrix, which is meaningless when every pixel is its own direction. OIDN keeps working (without its motion history). Asking for `'nrd'` while in a panorama runs `'oidn'` and records `denoiser.unavailable`.
- **Auto-focus** pauses and focus holds its last distance — it raycasts via `Raycaster.setFromCamera`, which only understands a frustum. It resumes when you leave the panorama.

Read the denoiser outcome back rather than duplicating the rule (`engine.denoisingManager.denoiserStrategy`); it is not restored automatically when you leave the panorama.

## engine.lightManager

Light CRUD, visual helpers, and GPU sync.

```js
engine.lightManager.add('PointLight')       // Add a light (PointLight, SpotLight, DirectionalLight, RectAreaLight)
engine.lightManager.remove(uuid)            // Remove by UUID
engine.lightManager.clear()                 // Remove all lights
engine.lightManager.getAll()                // Get all light descriptors
engine.lightManager.setIntensity(uuid, 40)  // Set one light's power and re-upload
engine.lightManager.getLight(uuid)          // The traced three.js light, to edit other properties
engine.lightManager.sync()                  // Re-upload light data to GPU after editing a light
engine.lightManager.showHelpers(true)       // Toggle visual helpers
```

The path tracer traces **copies** of a model's lights, made when the model loads. Changing a light
inside the loaded model does nothing; change the copy — `getLight(uuid)` with a UUID from `getAll()` —
and call `sync()`, or use `setIntensity()`.

Light `intensity` follows Blender: radiant power in watts for point, spot and area lights, irradiance in W/m² for directional. Dividing power by area only means something in metres, so the engine assumes **one world unit is one metre**; scenes authored in cm or mm must carry that scale in their node transforms, as glTF exporters do. glTF `RectAreaLightPlaceholder` nodes author `intensity` as three.js radiance (their `power` field is `intensity · width · height · π`); the importer converts it to power through the light's world area so the authored radiance is reproduced exactly, then applies the profile's `areaLightIntensityScale`.

## engine.animationManager

GLTF animation playback controls.

```js
engine.animationManager.play(clipIndex)      // Play an animation clip
engine.animationManager.pause()              // Pause playback
engine.animationManager.resume()             // Resume playback
engine.animationManager.stop()               // Stop and reset
engine.animationManager.setSpeed(2)          // Set playback speed multiplier
engine.animationManager.setLoop(true)        // Enable/disable looping
engine.animationManager.clips                // Get available animation clips
```

## engine.timeline

Authored animation: keyframed tracks on one time axis, in seconds. The camera's is the first track; the timeline is where lights and objects will join it. A model's own clips stay with `engine.animationManager`, and saved cameras (`engine.addCamera()`) stay cameras — a keyframe is not a camera.

```js
const camera = engine.timeline.camera          // the camera's track
const key = camera.addKey()                    // key the current view, 2 s after the last key
camera.addKey(5)                               // …or at a time
camera.updateKey(key.id)                       // give a key the current view
camera.setTime(key.id, 3.5)                    // retime it; keys stay in time order
camera.remove(key.id)
camera.keys                                    // [{ id, time, position, target, fov, orthoHeight }]

engine.timeline.duration                       // seconds to the last key of any track
engine.timeline.animates                       // a track has two keys or more
engine.timeline.seek(2.5)                      // put the scene where the timeline has it at 2.5 s
await engine.timeline.play()                   // run it in the viewport, controls locked
engine.timeline.stop()                         // or stop early

// Keys changed ({ track: 'camera' }) or playback started or stopped ({ track: undefined })
engine.addEventListener(EngineEvents.TIMELINE_CHANGED, ({ track }) => {})

// A video of the move through a still scene; pass clipIndex too to move the camera during a clip
await new VideoRenderManager(engine).renderAnimation({ timeline: engine.timeline, fps: 30, onFrame });
```

Between keys the camera glides along a smooth curve through their positions while looking along another through their targets, so a subject every key looks at stays in frame. It leaves the first key and reaches the last at rest, runs straight through the keys between, and holds still outside them. FOV, or an orthographic view's height, blends too, in the projection in use. The curves are three.js keyframe tracks (`InterpolateSmooth`). With auto-focus on, focus is measured again on every video frame, and the view is put back when the render ends. A new model clears the keys, as it clears saved cameras.

## Materials

Material property updates and texture transforms — accessed as direct methods on the engine.

```js
engine.setMaterialProperty(index, property, value)  // Update a material property
engine.setTextureTransform(index, name, transform)   // Update texture transform
engine.reset()                        // Re-upload all material data to GPU
engine.stages.pathTracer.materialData.updateMaterial(index, mat)  // Replace a material
await engine.rebuildMaterials(scene)  // Full rebuild (after texture changes)

// Cap the longest edge of processed material textures (clamped to the hardware max).
// Larger = sharper textures, ~quadratic VRAM. Reprocesses the current scene by default;
// settings.set('maxTextureSize', n) stores it for the next load instead.
await engine.setMaxTextureSize(2048)
await engine.setMaxTextureSize(4096, { reprocess: false })

// Per-mesh visibility — recommended UUID-based API (handles lookup + sync internally)
engine.setMeshVisibilityByUuid(uuid, true)             // explicit set
engine.setMeshVisibilityByUuid(uuid, prev => !prev)    // toggle via updater fn
// Returns the new visibility state, or null if the mesh wasn't found.

// Lower-level — for callers that already have a meshIndex or have mutated object.visible directly
engine.setMeshVisibility(meshIndex, visible)
engine.updateAllMeshVisibility()                  // re-sync after manual object.visible mutations
// With memorySpill, an edit whose top-level tree is on disk lands once it is read back (a moment later).

// Read access to the active scene (returns the mesh-bearing scene)
engine.getScene()

// Where a packed value came from: 'material' | 'mapped' | 'default' | 'host'
engine.getMaterialPropertySource(index, 'ior')
```

A material map read from a model file — a glTF's image (not in Safari, where three.js reads them as `<img>` elements) or
any image in a folder or archive — holds no pixels once the texture arrays are built: its `image` is `{ width, height,
data: null, thumbnail }`, `thumbnail` a 128-pixel `ImageBitmap` in a browser, and a rebuild (`rebuildMaterials`,
`setMaxTextureSize`, a colour space change) decodes it again from the file's bytes, which the engine keeps for that. A
PNG or JPEG is not decoded before the arrays are packed. To draw or read a map's pixels yourself, use `thumbnail` or keep
your own copy of the image; textures you create are left as they are.

A property a three.js material lacks falls back to `MATERIAL_DEFAULTS` (exported) — MeshPhysicalMaterial's own values, so a glTF metallic material gets IOR 1.5, not a guess derived from its metalness. Weights and roughnesses (metalness, roughness, transmission, opacity, clearcoat, sheen, iridescence, …) are clamped to [0, 1] on upload and on `setMaterialProperty`.

## engine.environmentManager

Environment maps, sky modes, and procedural generation.

```js
engine.environmentManager.params             // Current environment parameters
engine.environmentManager.texture            // The loaded environment texture
await engine.loadEnvironment(url)            // Load HDR/EXR environment map (method on engine)
await engine.environmentManager.setEnvironmentMap(tex) // Set a custom environment texture
await engine.environmentManager.setMode(mode)   // 'hdri' | 'procedural' | 'color'
await engine.environmentManager.generateProcedural() // Physical sky: spectral, multiple scattering, analytic sun (core: needs rayzee/addons/physical-sky)
await engine.environmentManager.generateSolid()      // Solid color sky
engine.environmentManager.markDirty()        // Flag environment for GPU re-upload
```

The physical sky (mode `'procedural'`) is set through `params`, then baked. It is baked and
importance-sampled entirely on the GPU (~1.6 ms per sun move), so bake on every slider event rather
than debouncing: requests made in one task become one bake, and the promise resolves once the
environment has caught up. The sun is drawn and sampled as a light of its own, not from the texture.

```js
import { sunPosition, dayOfYearForMonth } from 'rayzee';

const p = engine.environmentManager.params;
const { azimuth, elevation } = sunPosition( { hours: 17.5, dayOfYear: dayOfYearForMonth( 6 ), latitude: 40 } );
const az = ( 180 - azimuth ) * Math.PI / 180, el = elevation * Math.PI / 180;   // north along −Z, east along +X
p.skySunDirection.set( Math.cos( el ) * Math.sin( az ), Math.sin( el ), Math.cos( el ) * Math.cos( az ) );
p.skyTurbidity = 3;          // haze, 1–10; also skyOzone (Dobson units), skyAirDensity (× Earth's),
                             // skyGroundAlbedo (Color), skyAltitude (m), skySunSize (°), skySunStrength
await engine.environmentManager.generateProcedural();
```

## engine.interactionManager

Object picking and interaction modes.

```js
engine.interactionManager.select(object)       // Programmatically select an object
engine.interactionManager.deselect()           // Deselect the current object
engine.interactionManager.toggleSelectMode()   // Toggle object selection mode
engine.interactionManager.disableMode()        // Disable selection mode and detach gizmo
engine.interactionManager.toggleFocusMode()    // Toggle click-to-focus DOF
engine.interactionManager.on(type, handler)    // Subscribe (returns unsubscribe function)
```

## engine.transformManager

Transform gizmo controls.

```js
engine.transformManager.setMode('translate') // 'translate' | 'rotate' | 'scale'
engine.transformManager.setSpace('world')    // 'world' | 'local'
engine.transformManager.controls             // Access the underlying TransformControls
```

## Moving and Deforming Objects

Three calls update a loaded scene without rebuilding it. They differ in how much work they do, and
picking the wrong one is the usual source of trouble.

```js
engine.updateMeshTransforms(meshIndices)            // an object moved, rotated or scaled
engine.refitBLASes(meshIndices, positions)          // specific objects' vertices changed
await engine.refitBVH(positions)                    // the whole scene is posed anew, e.g. animation
```

**`updateMeshTransforms` is the one a gizmo drag wants.** Triangles are stored in each object's own
space, so a rigid move only rewrites a matrix — no vertex pass, no geometry upload — and refits only the
tree nodes above what moved, uploading just those. Using `refitBLASes` for a move instead rewrites
vertices needlessly, and drags along any other object sharing the same geometry. It returns
`{ refitTimeMs, placements }`, or `null` on a `memorySpill` scene whose matrices or tree are on disk:
the move then lands once they are read back.

All three take **indices into `engine.sceneMeshes`**, which is a depth-first walk of the rendered
scene and includes the engine's own hidden ground disk. Build your index list from that array, never
from your own model root, or the two orders silently disagree.

Positions are **world space**, 9 floats per triangle (`ax,ay,az, bx,by,bz, cx,cy,cz`), triangles in
index order. Two shapes are accepted:

```js
// Preferred: a per-mesh callback, asked for one mesh at a time. You may hand back the same
// scratch buffer on every call.
await engine.refitBVH((meshIndex, triCount) => myPositionsFor(meshIndex));

// Also works: one array for every triangle in the scene, meshes in sceneMeshes order.
// 1,030 MB at 30M triangles, and will not allocate at that size — prefer the callback.
await engine.refitBVH(sceneWideFloat32Array);
```

Both shapes are length-checked and throw on a mismatch. Before that check existed, a short buffer
wrote NaN through every bounding box with no error and the scene simply vanished.

An object that shares its geometry with another cannot be deformed — writing its vertices would
move every copy. `refitBLASes` skips such a mesh and records a `refit.shared_geometry` issue.
Anything skinned or morphed is given triangles of its own at load, so this only fires when the
wrong mesh was handed over.

---

