# Results and AI edits

The **Results** tab holds the renders you saved with **Save** in the [Render tab](render-and-export.md#saving-the-render).
They stay on this device until you delete them. Rendering pauses while you are here.

## Saved renders

The left panel, **Saved Renders**, lists them newest first, each with the date, time and how long it took to render.

- Click a render to show it.
- The bin deletes it, after you confirm. Its HDR copy and AI versions go with it.
- With AI versions made, **All** and **With AI** filter the list. A purple badge shows how many versions a render has.

In the view, drag to pan and scroll to zoom. **Press & Hold to See Original** shows the render without your adjustments.
The toolbar has **Auto-fit**, the zoom controls, **Export Render** (see
[Pictures](render-and-export.md#pictures)) and **Fullscreen**.

To move renders to another browser or computer, use **File → Export Saved Renders…** and **File → Import Saved Renders…**: one zip
file with every render, its HDR copy and its AI versions. Renders already there are skipped.

## Adjust

The **Adjust** tab on the right edits how a saved render looks, without changing the stored picture:

| Slider | What it does |
|---|---|
| **Brightness** | Brighter or darker, black areas included. |
| **Contrast** | Darks darker and lights lighter. Below 0 makes everything greyer. |
| **Saturation** | How strong the colours are. −100 is black and white. |
| **Hue** | Shifts every colour around the colour wheel. |
| **Exposure** | Like a camera's exposure: 100 doubles the light, −100 halves it. Black stays black. |
| **Gamma** | Brightens or darkens the mid-tones. 2.2 leaves the picture as it was. |

**Save** (top right of the view) keeps the adjustments with the render. **Reset** in the panel sets every slider back to
neutral; the round button at the bottom left of the view (**Reset Processing**) goes back to the render's saved
adjustments.

If the render kept an HDR copy and your screen shows HDR, the Results page shows that copy, with its highlights.

The **Tool** and **Filters** tabs are not built yet.

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

The next edit starts from whatever is on screen: the render (with its adjustments) or a version. Click the **Render**
tile or a **v** tile to choose.

### Comparing versions

With a version on screen, the switch at the top right of the view compares it with the render: **Slider** (drag the
line, or use the arrow keys), **Side by side**, or the version alone. The bin on a version deletes it; the render stays.

To save a version as a file, use **Export Render** and pick it under **Picture**.

### When it fails

The panel says why, with **Try again** or **Dismiss**: the key's limit is used up for now, Google's safety filter
declined the edit, Google could not be reached, the key is no longer accepted (**Change key**), or Gemini answered
without a picture. Your prompt is kept.
