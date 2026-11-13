# Troubleshooting

## The app does not start

Rayzee renders on your graphics card through **WebGPU**, which only recent browsers have: Chrome or Edge 113 or later,
Safari 18 or later, Firefox 141 or later. Without it, the app shows *Failed to load application* with one of two
messages:

- **WebGPU is not available**: the browser has no WebGPU. Update it, or use Chrome or Edge.
- **no WebGPU adapter**: the browser has WebGPU but found no graphics card it can use. Turn on hardware acceleration in
  the browser's settings (Chrome: Settings → System → *Use graphics acceleration when available*) and update your
  graphics driver. Remote desktops and virtual machines often have no usable graphics card. In Chrome, `chrome://gpu`
  shows whether WebGPU is hardware accelerated.

**The page reloads once on the first visit.** That is expected in Chrome, Edge and desktop Firefox: the app turns on a
browser feature (cross-origin isolation) that lets it build large models on all your processor's cores. Safari skips it;
the app works there, but large models load more slowly.

## A model does not load

- ***Invalid File Type***: the file is not one the app reads. See [the list](loading.md#your-own-files).
- **Textures are missing, or a `.gltf` fails**: the model is made of several files. Open them all at once (select every
  file in **File → Open**), or use **File → Open Folder…**, or drop the folder on the view.
- ***Still Loading***: another load is running. Wait for it, then try again.
- **Import from URL fails**: the link must end in `.glb`, `.gltf`, `.zip`, `.tar`, `.tgz` or `.gz`, and the server
  must let other sites download the file. Many file-sharing pages are web pages, not the file itself.
- **A Sketchfab model will not load**: its author may not allow downloads.

## The tab runs out of memory

A very large scene can fill the browser tab's memory, and the browser then closes the tab.

- **Restart the browser first.** A browser that has been open a long time has less room for big blocks of memory; the
  same scene often loads right after a restart.
- Close other heavy tabs.
- Leave **Memory Saver** on **Auto** (Tracer → Advanced), so a scene too big for memory is built through your disk. It
  needs on-disk storage, so it does not work in a private window.
- Lower **Max Texture Size** (Tracer → Advanced).
- For a big archive, load fewer parts in **Choose what to load**.

When the app can tell beforehand that a scene needs more memory than a tab can have, it refuses it with a message rather
than letting the tab crash.

**Memory:** and **Peak:** at the top left of the view show graphics memory. Lowering **Resolution** lowers it.

## The picture looks wrong

| Problem | Try |
|---|---|
| All black | The scene has no light: turn the environment's **Intensity** on, or add a light. |
| A checkerboard behind the model | **Background** is **Transparent**. |
| Stacked glass or water looks dark | Raise **Transmissive Bounces** (⋮ beside **Bounces**). |
| Dense leaves look dark | Raise **Transparent Bounces**. |
| Rooms and corners too dark | Raise **Bounces**. Preview uses 3 by default; **Render** uses 20. |
| Stray bright dots | Lower **Firefly Threshold** (Tracer → Advanced). |
| Grainy | Wait: the picture cleans up while the camera is still. Check **Real-Time Denoiser** and **Final Denoise (OIDN)**. |
| Depth of field far too strong or weak (Pro) | The model's size in its file is wrong: set **Subject Size (m)** in the Camera tab. |
| A room lit by its own lights, or light through glass, stays noisy | Try **Light Transport → Bidirectional**. |

## Rendering is slow

- Lower **Resolution**, or **Bounces** in Preview.
- Keep **Fast Navigation** on.
- **Bidirectional**, **Fog** and **Alpha Shadows** cost time; turn them off when you do not need them.
- On a very large picture, **NRD (ReBLUR)** keeps up better than **OIDN (AI)** as the live denoiser.

## My saved work is gone

- A private window keeps nothing after it closes.
- The browser may clear the site's data when the disk runs low. Open **File → Storage…** and, if it says *Not
  protected*, click **Keep data on this device**.
- To keep renders safe, save them to a file with **File → Export Renders…**, and scenes with **File → Save Project…**.

## AI edits do not work

They need your own Gemini key: see [AI edits](results.md#what-it-needs). The panel explains each failure (limit used up,
declined by Google's safety filter, no connection, key no longer valid).
