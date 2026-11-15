# Projects and storage

The app keeps your work in this browser, on this device. Your models, renders and edits are not uploaded anywhere,
except the pictures you send to Google for an [AI edit](results.md#ai-edits). (The site itself counts visits with
Google Analytics.)

## Sessions

While you work in **Preview**, the app saves your scene as a *session* a couple of seconds after each change, and again
when you close or hide the tab. A session holds where the model came from, every edit (materials, lights, moved objects,
camera, sky, settings) and a small picture of the view.

**File → Open Recent…** lists your sessions and projects. Click one to reopen it: it replaces the scene you have open.

- A model opened from a link or a library reopens by itself.
- A model opened from your computer is not stored, so the app asks you to choose the file (or folder) again: **Choose
  …**, or **Skip** to keep the scene you have. Chrome and Edge can reopen a remembered folder once you **Allow access**.
- If some edits cannot be brought back, the app names them.

The app keeps your last few sessions. Each browser tab keeps its own.

## Projects

A project is a file you keep: **File → Save Project…** writes a `.rayzee` file with the session and, when the model came
from your computer, the model itself (up to 3.5 GB where the browser lets the app write the file directly, 512 MB
otherwise). A model from a link is referenced, not copied in.

Open a project with **File → Open…** or by dropping the `.rayzee` file on the view. If the
model was too large to include, keep the model file beside the project: the app asks for it.

## Storage

**File → Storage…** shows what the app keeps on this device and how much room it takes:

| Row | What it is |
|---|---|
| **Saved renders** | Your pictures on the Results page. Delete them there, one at a time. |
| **Sessions** | Your recent scenes and edits. |
| **Recent projects** | Projects opened or saved recently. |
| **Render jobs** | Unfinished video and still renders that can resume. |
| **Downloads** | Models, skies and AI weights fetched from the web. |
| **Unpacked archives** | Compressed scene archives kept unpacked. |
| **Scene cache** | Built scenes, so they reopen without building again. |
| **Sky sampling tables** | Lighting tables worked out for sky images. |
| **Memory spill** | Scene data moved out of memory while a large scene is open. |

Rows marked **cache** refill as you work and can always be cleared. Rows marked **your data** ask before they are
deleted, because that cannot be undone. **Clear all caches** clears every cache at once.

The browser may clear the app's data when your disk runs low. If the window says *Not protected*, **Keep data on this
device** asks the browser to keep it. The browser decides from how often you use the site; bookmarking it usually
helps.

In a private window the browser gives the app no storage. Everything still works, without the caches, and nothing is
kept after the window closes.

A few small choices (the export window's last settings, **Keep HDR copy**, **Memory Saver**, the **HDR** switch and your
Gemini key) are kept in the browser's own site storage. Your browser's "clear site data" removes them.
