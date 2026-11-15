# Results and AI edits

The **Results** tab holds the renders you saved with **Save** in the [Render tab](render-and-export.md#saving-the-render).
They stay on this device until you delete them. Rendering pauses while you are here.

## Saved renders

The left panel, **Saved Renders**, lists them newest first, each with the date, time and how long it took to render.

- Click a render to show it.
- The bin deletes it, after you confirm. Its HDR copy and AI versions go with it.
- With AI versions made, **All** and **With AI** filter the list. A purple badge shows how many versions a render has.
- The **⋯** menu on a render has **Copy edits** and **Paste edits**: everything from the Adjust, Tool and Filters tabs
  but the crop, straightening and turns, which belong to the picture they were made for.

In the view, drag to pan and scroll to zoom. **Press & Hold to See Original** shows the render without any of your edits.
The toolbar in the status bar has **Auto-fit**, the zoom controls, **Export Render** (see
[Pictures](render-and-export.md#pictures)) and **Fullscreen**.

To move renders to another browser or computer, use **File → Export Saved Renders…** and **File → Import Saved Renders…**: one zip
file with every render, its HDR copy and its AI versions. Renders already there are skipped.

## Editing a render

The **Adjust**, **Tool** and **Filters** tabs on the right edit how a saved render looks, without changing the stored
picture. Every change is kept with the render as you make it: there is nothing to save. **Undo** and **Redo** (bottom
left of the view, or <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>Z</kbd> and <kbd>Shift</kbd> + <kbd>Cmd</kbd>/<kbd>Ctrl</kbd>
+ <kbd>Z</kbd>) step through your changes to each render until you leave the page. **Reset** at the top of a tab sets
that tab's edits back to none.

Exports and AI edits start from the edited picture: cropped, turned and with every look and effect.

### Adjust

| Slider | What it does |
|---|---|
| **Brightness** | Brighter or darker, black areas included. |
| **Contrast** | Darks darker and lights lighter. Below 0 makes everything greyer. |
| **Saturation** | How strong the colours are. −100 is black and white. |
| **Hue** | Shifts every colour around the colour wheel. |
| **Exposure** | Like a camera's exposure: 100 doubles the light, −100 halves it. Black stays black. |
| **Gamma** | Brightens or darkens the mid-tones. 2.2 leaves the picture as it was. |

### Tool

- **Crop & Straighten**: pick a **Shape** (**Free**, **Original**, **1:1**, **4:5**, **3:2**, **16:9**, **9:16**) or
  click **Crop**, then drag the frame on the picture to move it and its corners or edges to size it. **Straighten**
  turns the picture up to 45° either way to level a tilted horizon; the crop shrinks so no corner is left empty.
  <kbd>Enter</kbd> or **Done** keeps the crop, <kbd>Esc</kbd> or **Cancel** goes back to how it was.
- **Turn & Flip**: turn left or right a quarter, flip left to right or upside down.
- **Watermark**: type a name or note under **Text** to put it in a corner of the picture; choose the **Corner**, its
  **Size** and **Opacity**. Empty text shows none.

### Filters

- **Looks**: **Warm**, **Cool**, **Vivid**, **Punchy**, **Matte**, **Film** and **B&W**, each shown on your render.
  **Amount** sets how strongly the chosen look applies; **None** takes it off.
- **Detail**: **Sharpen** makes fine detail crisper (zoom in to 100 % to judge it); **Clarity** gives textures and
  mid-tones more punch, or softens them below 0.
- **Effects**: **Vignette** darkens the edges below 0 and lightens them above; its **⋮** has **Size** and **Softness**.
  **Grain** adds film-like grain, the same in every export; its **⋮** has **Size**.

If the render kept an HDR copy and your screen shows HDR, the Results page shows that copy, with its highlights and
your edits.

## AI edits

The **AI** tab makes new versions of a saved render with Google's Gemini image model: add things around it, change the
light or a material, restyle it, or make it look like a photograph. Each version is kept with the render, as **v1**,
**v2** and so on.

### What it needs

Your own Gemini API key, from [Google AI Studio](https://aistudio.google.com/app/apikey). Click **Add** beside
**Gemini key**, paste it, and click **Check key**. The key is checked with Google first, then kept in this browser
only. **Remove** forgets it.

Each edit sends the picture (and any reference pictures) to Google, and Google bills your key for it.

### Making a version

1. Pick a render on the left. The **Editing** block shows what the edit starts from.
2. Describe the change under **What should change?**, or start from an idea: **Make it look real**, **Add things around
   it**, **New background**, **Change the light**, **Change a material**, **Restyle** or **Remove something**.
3. Choose the **Area**: **Whole picture**, or **Part of it** and drag a box on the picture. With **Part of it**, only the
   box changes and is blended back in.
4. Choose what **May change**: **Only what I ask** (shapes, objects and camera stay as rendered), **Style too** (light,
   colour and look may change) or **Anything**.
5. Choose the **Size**: **1K, fastest**, **2K** or **4K**.
6. Optionally add up to four **References**: pictures to take a style, a material or an object from.
7. Click **Generate v1** (the button names the next version). It usually takes 20 to 50 seconds. You can switch tabs or renders meanwhile; the version is added
   when it is ready. **Cancel** stops it.

The next edit starts from whatever is on screen: the render (with your edits) or a version. Click the **Render**
tile or a **v** tile to choose.

### Comparing versions

With a version on screen, the switch at the top right of the view compares it with the render: **Slider** (drag the
line, or use the arrow keys), **Side by side**, or the version alone. The bin on a version deletes it; the render stays.

To save a version as a file, use **Export Render** and pick it under **Picture**.

### When it fails

The panel says why, with **Try again** or **Dismiss**: the key's limit is used up for now, Google's safety filter
declined the edit, Google could not be reached, the key is no longer accepted (**Change key**), or Gemini answered
without a picture. Your prompt is kept.
