# The Tracer panel

In **Preview**, the **Tracer** tab on the right holds the settings for how the picture is made: light bounces, colour,
the surroundings, grain removal and a few advanced switches. It has five sections:

- [Path Tracer](#path-tracer): bounces, light transport and picture size
- [Color Management](#color-management): exposure, tone mapping and colour
- [Environment](#environment): what lights the scene from around it, the background and fog
- [Denoising](#denoising): grain removal and AI enlargement
- [Advanced](#advanced): texture size, memory, sampling and debug views

Hover over any label to read what it does. A **⋮** button at the end of a row opens more settings for that row. A
slider with a power button beside it can be switched off as a whole.

> **Note:** switching between **Preview** and **Render** sets some of these again: **Bounces**, **Transmissive Bounces**,
> **Subsurface Steps**, **Alpha Shadows**, **Final Denoise (OIDN)**, **OIDN Quality**, **Fast Navigation**,
> **Adaptive Sampling** and **Noise Threshold**. Preview starts fast (3 bounces); Render starts thorough (20 bounces).
> Everything else keeps your value.

## Path Tracer

| Control | What it does |
|---|---|
| **Enable** | Turns realistic rendering on. Off shows a quick, plainly lit preview. |
| **Fast Navigation** | Lowers the detail while the camera moves, so moving stays smooth. Full detail returns when you stop. |
| **Bounces** | How many times light may bounce between surfaces (0–20). More fills corners and rooms with light, but renders slower. |
| **Light Transport** | **Path Tracing** suits most scenes. **Bidirectional** is about twice as slow, but better for rooms lit by their own lights, and for the bright patterns light makes through glass. **Bidirectional + Photons** also catches those patterns in mirrors and water. Experimental. |
| **Resolution** | The length of the picture's longer side, in pixels: 256 to 4096. Larger is sharper and slower. |
| **Output** | The size of the finished picture. Its shape comes from **Aspect Ratio** in the [Camera tab](scene.md#camera). |

The **⋮** beside **Bounces** has three more limits. Raise them only when something looks too dark:

- **Transmissive Bounces**: how many times light may pass through glass, water and other clear materials. Raise it when
  stacked glass looks dark.
- **Transparent Bounces**: how many see-through layers, such as cut-out leaves, light may pass. Raise it when dense
  foliage looks dark.
- **Subsurface Steps**: how far light may wander inside skin, wax and other soft materials.

Some scene files ask for a light transport of their own. The app uses it for that scene, and gives the next scene back
your choice unless you changed it.

## Color Management

Rayzee shows colour the way Blender does: it opens with Blender's **AgX** tone mapping and its **Medium High
Contrast** style. The first time you open this section it loads the colour system, which takes a moment.

| Control | What it does |
|---|---|
| **Tone Mapping** | How the light in the scene becomes a picture: how bright areas fade to white and how shadows keep detail. **AgX** is natural and film-like (recommended), **ACES** the film and VFX standard, **Neutral** keeps product colours accurate. |
| **Style** | An extra finishing look on top of the tone mapping, such as more contrast or black and white. **Default** is the tone mapping alone. |
| **Screen** | The kind of screen the picture is meant for. **sRGB** suits almost every computer screen; the **HDR** column is for HDR TVs. |
| **HDR** | Shown on an HDR screen only. Lets bright lights shine brighter than white on this screen. Saved pictures are not affected. |
| **Auto Exposure** | Sets the brightness for you from what the camera sees, as a camera does. Its **⋮** has **Follow View**: **Gently** (default), **More** or **Fully**, for how much the brightness changes as you look around. |
| **Exposure** | Brighter or darker, in stops: +1 doubles the brightness, −1 halves it. With **Auto Exposure** on, this row is called **Adjust** and shifts the brightness Auto picks. |
| **White Balance** | The colour of light to show as white, in kelvin. Lower makes the picture cooler, higher warmer. Off by default. |
| **Balance Highlights** | Tones down bright windows and sunlit walls while keeping their detail. On by default. Its **⋮** has **Amount**. |

A physical sky preset, or a scene file, can also set **Exposure**.

**Advanced** (at the bottom of the section) is for studio work; most scenes never need it:

- **Color System**: where the tone mappings and styles come from. **Blender** (default), **None** (the engine's own
  curves), an **ACES** version, or **Load config folder…** for a studio's own OpenColorIO folder (the `.ocio` file
  with its LUTs beside it). Changing it can rebuild the scene.
- **Render In**: the colours the render works in. Keep **Rec.709** unless your project asks for another, such as
  **ACEScg**. Changing it rebuilds the scene and changes the look.
- A config that names shots or looks by variables shows a text box for each.

Each texture can also be told how to read its colours: see **Color Space** in the
[Material tab](scene.md#textures).

## Environment

The environment is what surrounds the scene and lights it from outside.

| Control | What it does |
|---|---|
| **Mode** | **HDRI** (a photo of a real place), **Physical Sky** (a sky with a sun) or **Solid Color**. Loading a sky from **Assets → Env** switches back to **HDRI**. |
| **Sky Color** | (Solid Color) The colour of the light around the scene. |
| **Intensity** | How strongly the surroundings light the scene. Switch it off to keep only the scene's own lights. |
| **Background** | What shows behind the model: **Environment**, **Color** or **Transparent**. It does not change the lighting. |
| **Background Intensity**, **Background Blur**, **Blur Samples** | (Background: Environment) How bright and how soft the background looks, without changing the light. |
| **Background Color** | (Background: Color) The flat colour behind the model. |
| **Shadow Catcher** | An invisible floor that shows only the model's shadows, for placing the model into a photo. **Catcher Height** sets where it sits; it starts at the scene's lowest point. |
| **Rotation** | (HDRI) Turns the surroundings, which moves where the light comes from. |
| **Ground Projection** | (HDRI) Turns the bottom of the photo into a floor, so the model stands on it. The number sets its size; **Projection Height** is how high the photo was taken. |
| **Fog** | Fills the scene with haze, so light from windows and light sources shows as beams. The number sets how thick it is. Path Tracing only. |
| **Fog Color**, **Glow Toward Light**, **Height** | (Fog on) The haze's colour, how much brighter it looks toward the light, and where it sits: **Everywhere**, **Low** or **Ground**. |

### Physical Sky

A real atmosphere and sun. Pick a **Preset** first: **Clear Day**, **Clear Morning**, **Clear Noon**, **Hazy Afternoon**,
**Golden Hour**, **Sunset**, **Blue Hour** or **Mountain Air**. A preset sets the sun, the haze and the exposure.

| Control | What it does |
|---|---|
| **Time of Day** | Where the sun is in its daily path. Drag it and the sky follows as you move. |
| **Sun Direction** | Turns the compass, so the sun rises and sets on another side of the scene. |
| **Haze** | Low is a clear blue sky, high a white, misty one. |

The **⋮** beside **Time of Day** has **Set sun by** (**Time of day** or **Angles**), **Month**, **Latitude**, **Sun
Size** and **Sun Strength**. With **Angles**, the sun is placed by **Sun Height** and **Sun Rotation** instead. The
**⋮** beside **Haze** has **Ground** (the ground's colour), **Altitude**, **Ozone** and **Air Density**.

## Denoising

A path-traced picture starts grainy and gets cleaner the longer the camera stays still. A denoiser removes the grain
sooner.

| Control | What it does |
|---|---|
| **Real-Time Denoiser** | Removes grain while you work. **OIDN (AI)** (default) is the cleanest; **NRD (ReBLUR)** keeps up better on very large pictures; **None** shows the raw picture. |
| **Final Denoise (OIDN)** | Removes the grain from the finished render with AI, once it is done. Turning it off also turns off the **AI Upscaler**. |
| **OIDN Quality** | How hard the AI clean-up works: **Fast**, **Fast (clean aux)**, **Balance** or **High**. **High** keeps the most detail and is slowest. |
| **AI Upscaler** | Makes the finished render bigger with AI, so you can render small and deliver large. Needs a denoised picture. |
| **Scale Factor** | (AI Upscaler on) **2x** or **4x** on each side. |
| **Quality** | (AI Upscaler on) **Fast**, **Balanced** or **Quality**. |

With **NRD (ReBLUR)** chosen, a few more controls appear: **Quality Preset** (**Low**, **Medium**, **High**) and the
sliders it sets (**Max History**, **Blur Radius**, **Pre-pass Radius**), **Anti-Firefly**, and **Debug View**, which
shows what the denoiser sees instead of the picture.

If both **Final Denoise (OIDN)** is off and the live denoiser is not OIDN, the panel says: *Turn on Final Denoise
(OIDN) to use the AI passes — they need a clean image.*

## Advanced

| Control | What it does |
|---|---|
| **Max Texture Size** | The largest size a material image is kept at: 1024 to 8192 (default 4096). Smaller saves memory and loads faster, but looks less sharp up close. Changing it rebuilds the textures. |
| **Memory Saver** | Stores scenes too big for memory on your disk. **Auto** (default) does this only when needed; **Always** and **Never** force it. Takes effect on the next load. |
| **Accumulation** | Builds the picture up over time, so it gets cleaner while the camera is still. Off shows a fresh, grainy picture every frame. |
| **Firefly Threshold** | Hides stray bright dots. Lower hides more, but can also dim real highlights. |
| **Shadow Terminator** | Smooths the jagged line between light and shadow on rounded objects made of flat pieces. 0 turns it off; 0.1 suits most scenes. |
| **Alpha Shadows** | Lets cut-out parts, such as leaves or lace, cast shadows of their real shape. Slower. On by default in Render. |
| **Adaptive Sampling** | Keeps working on the grainy parts of the picture and stops on the clean ones, so renders finish sooner. Its **⋮** has **Noise Threshold** (how clean each part must get) and **Min Samples**. |
| **Debug Mode** | Shows one ingredient of the picture instead of the picture: **Normals**, **Depth**, **Albedo**, **Emissive**, **Indirect (GI)**, **Env Reflection**, **Triangle Tests**, **Box Tests**, **Stratified Samples**, **Env Luminance** or **NaN / Inf**. For finding problems. |
| **Convergence Overlay** | Colours the picture by how clean each part is: red still grainy, yellow nearly done, grey finished (blue: frozen). Display only. |

**Display Threshold** appears with **Triangle Tests** and **Box Tests**: how many tests show as full white.
