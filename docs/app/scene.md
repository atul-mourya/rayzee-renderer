# Camera, lights, materials, animation

Four tabs on the right, in **Preview**, change the scene itself: **Camera**, **Light**, **Material** and **Anim**. Every
change shows at once; the picture starts cleaning up again from the new state.

## Selecting things

Most edits work on what is selected.

- Turn on **Click to Select** (the pointer button in the floating controls over the view), then click an object. Click it
  again to deselect, or press <kbd>Esc</kbd>.
- Or click its row in the **Outliner** on the left.
- With **Click to Select** on, **double-click** an object to select it and open the **Material** tab.
- **Right-click** a selected object for **Hide** / **Show**, **Focus**, **Isolate** / **Un-isolate**, **Copy Material**,
  **Paste Material** and **Deselect**.

A selected object gets a move, turn and scale handle in the view. More in [Keyboard and mouse](controls.md).

## Camera

| Control | What it does |
|---|---|
| **Select Camera** | Which camera you look through. **Default Camera** is always there; cameras saved in the model file are listed by their names. **+** saves the current view as a new camera; the bin removes a camera you added. |
| **Projection** | **Perspective** sees like an eye. **Orthographic** keeps sizes the same at any distance, like a floor plan. **360° Panorama** sees all around. |
| **Aspect Ratio** | The picture's shape: **1:1**, **16:9**, **4:3**, **3:2**, **2.39:1** or **21:9**. The small button beside it swaps wide and tall. A panorama is always 2:1. |
| **FOV** | How wide the camera sees (10–90°). Changing it keeps the subject the same size on screen by moving the camera. |
| **View Height** | (Orthographic) How much of the scene fits in the picture, top to bottom, in metres. Scrolling in the view changes it too. |
| **Navigation** | **Orbit** circles the camera around a point. **Walk** moves it like a person: drag to look around and use the keys to move. |
| **Zoom to Cursor** | (Orbit) Scrolling zooms toward the point under the mouse instead of the middle of the view. |
| **Walk Speed** | (Walk) How fast the keys move the camera. |
| **Camera Position** | (Default Camera, Orbit) Drag the dot to swing the camera around. The marks are front, side, top and bottom views. |

For a panorama: **Level Horizon** keeps the horizon straight however the camera tilts, and **Longitude Min/Max** and
**Latitude Min/Max** crop how far it reaches, in degrees. Longitude goes to ±360, so a pbrt scene's panorama, which runs
from 90 down to −270, shows as it is and keeps its other end when you move one.

### Depth of field

Switch on **Depth of Field** to blur what is nearer or farther than the focus point, like a real camera. Then choose a
**Mode**:

- **Simple**: just set **Background Blur**, how blurry the far background gets.
- **Pro**: set the blur like a real camera, with **Aperture (f)**, **Focal Length (mm)** and **DOF Intensity**. Pro needs
  the model's real size: **Subject Size (m)** is the length of its longest side. If the file's size is wrong (a watch
  that reads as 4 metres), type the real length.

**Look** applies a ready-made blur: **Portrait**, **Landscape**, **Macro**, **Product**, **Architectural** or
**Cinematic**. Changing any setting makes it **Custom**.

**Focus**: click **Pick Point**, then click the spot in the view that should be sharp, or drag the small circle that
marks the focus point in the view. Focus stays on that spot as the camera moves. The reset button beside it focuses on the centre again. In **Pro**, **Focus Distance** shows the measured
distance and **Bokeh Stretch** stretches the blurry spots of light into ovals, as a widescreen film lens does.

## Light

| Control | What it does |
|---|---|
| **Emissive Geometry** | Lets glowing surfaces, such as light panels and screens, light the scene with less grain. The number sets how strongly. |
| **Lights** (+) | Adds a **Directional Light**, **Point Light**, **Spot Light** or **Area Light**. **Clear All** removes every light. |
| **Light Helper** | Shows the lights in the view as outlines you can click and move. |

Each light in the list has an eye button to hide it and a bin to remove it. Click a light to select it and show its
settings:

- **Strength** (directional) or **Power** (in watts, the others), and **Exposure**: +1 doubles it, −1 halves it.
- **Color**, or **Temperature** in kelvin (3200 a warm bulb, 6500 daylight); with **Temperature** on, **Color** becomes
  **Tint**.
- **Position**, and for lights that aim, **Target**.
- **Spot Light**: **Cone Angle**, **Penumbra** (the soft edge), **Distance** (0 means no limit) and **Decay** (2 is real
  light). **IES Profile** gives it the beam shape of a real fixture, from a library; **IES Strength** sets how strongly
  that shape applies.
- **Point Light**: **Distance** and **Decay**.
- **Directional Light**: **Softness**, how soft the shadows are (the real sun is 0.53°).
- **Area Light**: **Shape** (**Square**, **Rectangle**, **Disk**, **Ellipse**), **Size** or **Width** and **Height**,
  **Spread** (180° lights everything in front of it) and **Normalize** (on: resizing keeps the amount of light).
- **Gobo Mask** (spot and directional): a cut-out pattern over the light, such as window bars or leaves, from a library. **Mask Strength** sets how strongly it blocks; the directional light also has **Tile Scale**.

The environment and the sun are set in the [Tracer tab](tracer.md#environment), not here.

## Smoke, clouds and fire

**Add → Cloud** puts a cloud above what the camera looks at; **Add → Smoke** a column of smoke in front of it, both
sized to the view. A `.vdb` file opened from **File → Open** comes in the same way. Select one in the **Outliner** (it
cannot be clicked in the view) and move it with its handle; the **Material** tab then shows:

| Setting | What it does |
|---|---|
| **Density** | How thick it is: how much light it stops along each metre |
| **Color** | The colour of the light it scatters: white for clouds, grey or darker for smoke |
| **Glow Toward Light** | How much brighter it looks facing the light, as clouds do around the sun |
| **Fire Brightness** | (A file with flames) how brightly they glow; 0 turns them off |
| **Temperature** or **Fire Color** | How hot the flames are (dim red when cool, yellow-white when hot), or the colour they glow |

A dense white cloud needs many **Bounces** to look bright; **Render** uses more than **Preview**. Path Tracing only.

## Material

Select an object first; until then the tab says *Please select an object to customize its material properties*. It has
two parts: **Properties** and **Textures**.

### Properties

Always shown: **Color**, **Roughness** (0 a mirror-like shine, 1 matte), **Metalness** (1 metal, 0 everything else),
**Diffuse Roughness** (a flat, powdery look, as on plaster or clay), **Specular Intensity**, **Specular Color**,
**Emissive** (the colour it glows; black is none) and **Emissive Intensity**.

Each switch below adds a layer and shows its settings:

| Switch | For | Settings |
|---|---|---|
| **Enable Clearcoat** | car paint, varnish | **Clearcoat**, **Clearcoat Roughness** |
| **Enable Transmission** | glass, water | **IOR** (water 1.33, glass 1.5, diamond 2.4), **Transmission**, **Attenuation Color** and **Attenuation Distance** for coloured glass |
| **Enable Subsurface** | skin, wax, marble | **Amount**, **Scatter Color**, **Translucency**; more under **⋮** |
| **Enable Translucency** | leaves, paper, lampshades | **Amount**, **Color** |
| **Enable Transparency** | see-through without bending light | **Transparent**, **Opacity**, **Alpha Test** (cuts away parts of the image) |
| **Enable Iridescence** | soap bubbles, oil slicks | **Iridescence**, **Iridescence IOR** |
| **Enable Sheen** | velvet, cloth | **Sheen**, **Sheen Roughness**, **Sheen Color** |
| **Enable Anisotropy** | brushed metal | **Anisotropy**, **Rotation (°)** |
| **Enable Dispersion** | prisms, diamonds (needs Transmission) | **Dispersion** |

**Enable Subsurface** starts the surface as candle wax. **Assets → Materials** has more, such as jade, milk and skin.

**Side** sets which side of each surface shows: **Front**, **Back** or **Double**.

### Textures

One card for each image the material uses. On a card: **Change texture** picks a new image from your computer and
**Remove texture** clears it. Opened, a card has **Offset**, **Repeat** and **Rotation (°)**, and the strength of a
normal, bump or displacement map (**Normal Scale**, **Bump Scale**, **Displacement Scale**). **Sync Repeat** makes
**Repeat** change on every image of the material at once.

Colour images have a **Color Space** menu: leave it on **Auto** unless the colours look wrong.

**Add Texture** fills an empty slot: **+ Albedo (Color)**, **+ Normal**, **+ Roughness**, **+ Metalness**,
**+ Emissive**, **+ Bump** and **+ Displacement**.

### Materials from the catalogue

**Assets → Materials** has two libraries: **Physically Based** (measured real materials, plus the app's translucent ones
such as **Candle wax**, **Jade** and **Soap**) and **PolyHaven** (textured materials, at 1K to 8K). Either:

- select an object, then click a material card; or
- drag a card onto an object in the view. The object under the cursor is outlined, and the material lands on it.

A PolyHaven material replaces the material on every part that shares it. With nothing selected, a click on a PolyHaven
card does nothing.

## Animation

The **Anim** tab plays a model's own animation and moves the camera for a video.

**Clips.** If the model has animations, pick one in **Animation Clip** and press **Play** (then **Pause** / **Resume**,
and the stop button). **Speed** sets how fast it plays and **Loop** plays it again from the start. **Duration** shows
its length. A model without animation says so; you can still make a video by moving the camera.

**Sequences.** Smoke or fire opened as numbered frames shows here by name with its number of frames. **Frame Rate**
sets how many frames play each second; **Frame** shows one frame to look at. **Play** plays it (the camera stays free
to move; **Stop Preview** ends it), and **Export Video…** renders every frame. Large frames take about a second each
to read, so they play slowly in the view but export normally.

**Camera keyframes.** Frame a view, then press **+ Keyframe**. Each key is placed 2 seconds after the last; type a time
to pace the move. Each key has buttons to go to its view, replace it with the current view, or remove it. With two or
more keys:

- **Preview Move** plays the camera move (**Stop Preview** ends it).
- **Move Camera in Video** (only when the model also has a clip) moves the camera along the keys while the clip plays.

**Video.** **Render Loops** sets how many times the clip plays in the video. **Video Duration** shows how long the video
will be and how many frames it has. **Export Video…** opens the export window: see
[Final renders and export](render-and-export.md#videos).
