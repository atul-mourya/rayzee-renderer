# Keyboard and mouse

## Moving the camera (Preview)

**Orbit** (the default; **Camera → Navigation**):

| Mouse | Does |
|---|---|
| Left drag | Turn around the point you look at |
| Right drag, or <kbd>Shift</kbd> / <kbd>Ctrl</kbd> / <kbd>⌘</kbd> + left drag | Pan |
| Middle drag | Move closer or further |
| Scroll | Zoom toward the point under the mouse (**Zoom to Cursor**, on by default) |

On a touch screen: one finger turns, two fingers pinch to zoom and drag to pan.

With an **Orthographic** camera, scrolling changes **View Height** instead of moving the camera.

**Walk** (**Camera → Navigation → Walk**): drag to look around, and move with the keys.

| Key | Does |
|---|---|
| <kbd>W</kbd> / <kbd>↑</kbd> | Forward |
| <kbd>S</kbd> / <kbd>↓</kbd> | Back |
| <kbd>A</kbd> / <kbd>←</kbd> | Left |
| <kbd>D</kbd> / <kbd>→</kbd> | Right |
| <kbd>E</kbd> / <kbd>Q</kbd> | Up / down |
| hold <kbd>Shift</kbd> | Four times faster |
| hold <kbd>Alt</kbd> / <kbd>Option</kbd> | Four times slower |

**Walk Speed** in the Camera tab sets the base speed.

The camera cannot move in **Render** and **Results**.

## Anywhere

| Key | Does |
|---|---|
| <kbd>Space</kbd> | Pause or resume the render; once it is done, render again (not on the **Results** page). After you tab to a button, Space presses that button instead |
| <kbd>R</kbd> | Reset the camera to where it started (same as **Reset Camera**) |
| <kbd>Esc</kbd> | Deselect |

These do nothing while you type in a text box.

## Selecting and moving objects

- Turn on **Click to Select** (top centre of the view), then click an object. Click it again, or empty space, to
  deselect. Double-click an object to select it and open the **Material** tab.
- Or click its row in the Outliner.
- A selected object shows a handle. Drag its arrows, rings or boxes to move, turn or resize it. Pick which with
  **Translate**, **Rotate** and **Scale** in the toolbar at the bottom right, and **World Space** / **Local Space** for
  its axes. The handle has no keyboard shortcuts.
- Right-click (with something selected) for **Hide** / **Show**, **Focus** (look at it), **Isolate** / **Un-isolate**
  (hide everything else), **Copy Material**, **Paste Material** and **Deselect**. The menu works on the selected object,
  not on what is under the mouse. Arrow keys and <kbd>Enter</kbd> work in it too.

## Picking the focus point

With **Depth of Field** on, a small circle in the view marks the focus point: drag it to focus somewhere else. Or click
**Pick Point** in the Camera tab, then click the spot that should be sharp. A panorama keeps its focus distance and has
no focus point.

## Looking at the picture (Render and Results)

| Mouse | Does |
|---|---|
| Left drag | Pan the picture |
| Scroll, or pinch on a trackpad | Zoom the picture (5–300 %) |
| Press and hold (Results) | Show the render without your adjustments |

This zoom only changes how large the picture shows, not the render. **Auto-fit** in the toolbar fits it to the view
again.

## Sliders and numbers

Click a slider's track to jump, or drag. Click the number beside it to type an exact value, then press <kbd>Enter</kbd>.
Values snap to marked points (such as 0 or 1) when close.
