# Opening models and skies

## Your own files

The quickest way: drag a model, a folder or a sky onto the view. The view says *Drop a model, its folder, or an HDR
environment* while you drag.

From the **File** menu:

- **Open…** picks a file: a model, an archive, a sky or a project. Select several files at once to open a model made
  of several files, such as a `.gltf` with its `.bin` and textures, or an `.obj` with its `.mtl`.
- **Open Folder…** picks a folder that holds a model and everything it uses. Chrome and Edge remember the folder, so a
  later session can reopen it.
- **Open from URL…** opens a model from a link: an `http(s)` address ending in `.glb`, `.gltf`, `.zip`, `.tar`,
  `.tgz` or `.gz`.

| Kind | Files |
|---|---|
| Models | `.glb`, `.gltf`, `.fbx`, `.obj`, `.stl`, `.ply`, `.dae`, `.3mf`, `.usd`, `.usda`, `.usdc`, `.usdz` |
| Smoke, clouds, fire | `.vdb` (OpenVDB, as Blender, Houdini and EmberGen save them) and `.nvdb` (NanoVDB). Numbered frames (`fire_0001.vdb`, …) selected together, in a folder or in a zip play as one animation in the **Anim** tab. `.vdb` files from Blender and EmberGen are stood upright; a `.nvdb` file is opened as it is stored (turn it with its handle if it lies on its side). |
| Archives | `.zip`, `.tar`, `.tar.gz`, `.tgz`, holding any of the above, or a whole pbrt-v4 or USD scene |
| Skies | `.hdr` and `.exr`, opened or dropped onto the view |
| Projects | `.rayzee`: see [Projects and storage](projects.md) |

A new model replaces the scene. While a load runs, a progress window shows each step (downloading, reading, building,
sending to the graphics card) and the time so far; a download can be stopped with **Cancel**. Opening another file
before it finishes shows *Still Loading*: wait, then try again.

### Big scenes and archives

- A large archive made of several parts (over 4 GB, or over 1 GB for USD) asks **Choose what to load**: tick the parts
  you want, then **Load selection**. The scene file, materials and textures come with them. Above about 6 GB the
  window warns that the tab may run out of memory.
- A scene too big for memory is built through your disk instead. The load says so when it finishes. See **Memory Saver**
  in the [Tracer panel](tracer.md#advanced).
- A scene that asks for its own picture shape, exposure or light transport (pbrt scenes often do) gets them when it
  opens. The next scene gets your settings back.

## The libraries

The **Assets** tab (Preview) has ready-made models, materials and skies. Click **Assets**, then one of its tabs:

| Tab | What is in it |
|---|---|
| **Models** | **Featured**: ready-to-render scenes, most of them classic rendering test scenes (kitchens, bathrooms, a Cornell box, cars). **Sketchfab**: search Sketchfab's free models. **Amazon**: product models from Amazon Berkeley Objects. |
| **Materials** | **Physically Based**: measured real materials, plus translucent ones such as **Candle wax**, **Jade** and **Soap**. **PolyHaven**: textured materials, at **1K** to **8K**. |
| **Env** | **Featured**: skies (HDRIs) ready to use. **PolyHaven**: Poly Haven's whole HDRI library, at **1K** to **4K**. |
| **Tests** | Khronos's glTF sample models, for checking how a file feature renders. |

Each library opens on its categories. Type in the search box to search all of them, or open a category and search
inside it. The star on a card keeps it at the top; the **i** opens its source page.

On a model card, **Replace** swaps the scene for it and **+ Add** adds it to the scene. Some can only replace (pbrt
scenes, and Sketchfab models packed as a zip). Sketchfab models whose authors do not allow downloads can be browsed but
not loaded. A sky loads with a click and sets the environment **Mode** to **HDRI**. How materials are applied:
[Materials from the catalogue](scene.md#materials-from-the-catalogue).

Hover over a card for more about it; the **i** opens its source page, with its author and licence.

## The sky

The environment is set in the [Tracer tab's Environment section](tracer.md#environment): a sky photo (**HDRI**), a
**Physical Sky** with a sun placed by time of day, or a **Solid Color**. With the environment's **Intensity** off and no
lights, a scene renders black.
