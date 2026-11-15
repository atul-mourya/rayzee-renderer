# Final renders and export

Set the scene up in **Preview**, then click **Render** in the top bar for the finished picture. Save it to keep it on the
[Results page](results.md), or export it straight to a file.

## The Render tab

Clicking **Render** restarts the picture at full quality: 20 light bounces, shadows from cut-out parts, the AI clean-up
at **High**, and a tight noise target. The camera is locked while it renders. The right panel shrinks to what matters
for a finished picture:

| Control | What it does |
|---|---|
| **Bounces** | How many times light may bounce. Starts at 20 here. |
| **Resolution** | The longer side of the picture, in pixels: 256 to 4096 (default 2048). Its shape comes from **Aspect Ratio** in Preview's [Camera tab](scene.md#camera). |
| **Output** | The size of the finished picture, including any AI enlargement. |
| **Final Denoise (OIDN)** | Removes the grain with AI once the render is done. On by default. |
| **OIDN Quality** | **Fast**, **Fast (clean aux)**, **Balance** or **High** (default here). |
| **Tile Helper** | Outlines each piece of the picture as the AI clean-up works through it. |
| **AI Upscaler** | Enlarges the finished picture **2x** or **4x**, so you can render small and deliver large. **Quality**: **Fast**, **Balanced** or **Quality**. |

Some scene files (pbrt scenes, for example) ask for a number of bounces and samples. The panel shows what they ask for,
but does not apply it: this renderer stops once the picture is clean, then removes the grain.

### How long it renders

The strip over the view shows progress and sets the limits:

- **Frames:** the number of samples so far, out of a limit you can type (30 in **Render**, 60 in **Preview**). Click
  **Frames:** to stop by samples.
- **Time:** the seconds so far. Click **Time:** to stop by time instead, then type the limit (30 seconds by default).
- **Auto** (adaptive sampling) stops early once the picture stops changing. In **Render** it shows the setting; change
  it in Preview's Tracer tab.

A tick appears beside whichever limit ended the render. **Memory:** and **Peak:** show how much graphics memory the scene
uses.

Press <kbd>Space</kbd> to pause or resume, or to render again once it is done.

### Saving the render

When the render and its AI clean-up are done, three controls appear at the top right of the view:

- **Keep HDR copy** also keeps the full-range (EXR) image, so exposure and tone mapping can be changed later, and the
  picture exported as EXR or HDR, without rendering again. On by default.
- **Save** adds the render to the [Results page](results.md).
- **Ignore** hides the controls. Nothing is saved.

Renders are not saved by themselves: only **Save** keeps one.

### If the page reloads during a render

A render that runs longer than two minutes is checkpointed every two minutes. If the page reloads or the browser
closes, the app asks *Finish the final render?* when it opens again. **Resume** reopens the scene and carries on from the
saved samples; **Discard render** throws it away.

## Pictures

Open the export window from **File → Export Picture…**, the **Export Picture** button (a camera) in the status bar's toolbar,
or, for a saved render, **Export Render** on the Results page. It remembers your last choices.

| Format | Good for |
|---|---|
| **PNG** | No quality loss, for sharing and editing. **Colour depth**: **8-bit** or **16-bit** (smoother gradients for editing). |
| **JPEG** | The web and email. Keeps HDR highlights on HDR screens. |
| **WebP** | Small, keeps transparency. |
| **HEIC** | Apple's photo format, small. Keeps HDR highlights on HDR screens. |
| **AVIF** | The smallest. Keeps HDR highlights on HDR screens. |
| **EXR** | All the light, for Photoshop, Nuke or Blender. |
| **HDR** | All the light, in the older Radiance format. |

**HEIC** and **AVIF** are greyed out where the browser cannot write them.

Other choices, depending on the format:

- **Quality** (JPEG, WebP, HEIC, AVIF): higher keeps more detail and makes a larger file.
- **HDR** (JPEG, HEIC, AVIF, on an HDR screen): keeps the bright highlights your screen shows. Viewers that do not
  understand them show the normal picture.
- **Picture** (EXR, HDR): **As on screen** keeps exposure, tone mapping and look, so the file opens looking like the
  screen. **Raw light** is what compositing programs expect; they apply a look of their own.
- **Precision** (EXR): **Half** (smaller, plenty for most work) or **Full** (every value exact, twice the size).
- **Colour space** (Raw light): keep the render's own unless your program asks for another, such as ACES2065-1.
- **Extra layers** (EXR, Raw light): **Surface colour**, **Surface direction** and **Distance**, saved in the same file
  for compositing. The first two need a denoiser on while the picture renders.
- **Upscaled picture**: save the larger picture the AI upscaler made, instead of the render itself.

A line at the bottom shows the size and what the file will hold. Press **Export**; the file downloads as
`render-` followed by the date and time.

For a saved render, **Picture** chooses **With your edits** (the Results page's adjustments), **As rendered**, or one of
its AI versions. EXR and HDR are offered only when the render was saved with **Keep HDR copy**.

## Videos

A video needs something that moves: an animated model, or two or more camera keyframes (see
[Animation](scene.md#animation)). Open the export window from **File → Export Video…** or **Export Video…** in the
**Anim** tab, and choose the **Video** tab.

| Choice | Options |
|---|---|
| **Format** | **MP4** (plays everywhere), **WebM** (smaller, plays in browsers), **PNG frames** (a picture a frame, for video editors), **EXR frames** (all the light, a file a frame) |
| **Quality** | **Standard**, **High** or **Best**, each with its size per minute |
| **Frame rate** | 24, 25, 30 or 60 frames a second |

The video has the size of the picture now: the **Output** size of the tab you are in (Preview's **Resolution** starts at
512, Render's at 2048). The export window shows the size before you start. Each frame is rendered with 60 samples and
cleaned up with AI. Press **Render video** (or **Render frames**). Progress shows in the **Anim** tab and in a
pill over the view; **Cancel Render** stops and throws the video away.

Frames go into a folder you choose, where the browser allows it (Chrome and Edge); elsewhere they are saved together as
one zip file.

### Resuming a video

Every finished frame is kept on this device as it is made. If the page reloads or the browser crashes, the app asks
*Finish the video render?* when it opens: **Resume** reopens the scene and renders the rest, **Discard frames** throws
them away. The **Anim** tab shows the same choice as **Resume video** and **Discard**. A video can only resume at the
size it started at. Frames going into a zip file cannot be resumed.
