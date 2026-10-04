---
name: debug-pipeline
description: >
  Debug the rendering pipeline. Diagnoses why the render output looks wrong by tracing data flow
  through pipeline stages, checking context textures, event wiring, and the Compositor's display sources.
  Use when the rendered image is black, flickering, shows ghosting, or has visual artifacts.
allowed-tools: Read, Glob, Grep, Bash(npm run lint*), Bash(npm run build*)
---

You are debugging the Rayzee rendering pipeline. Follow this systematic diagnostic process.

## Step 1: Identify the Symptom
Ask the user (if not already clear) which symptom they see:
- **Black screen** → likely a disabled stage publishing dark output, or context texture missing
- **Flickering** → temporal data not persisting, ping-pong swap issue, or reset loop
- **Ghosting/smearing** → ASVGF temporal accumulation bug, motion vector error, or camera matrix mismatch
- **Wrong colors** → Compositor showing the wrong picture from its display sources
- **NaN artifacts (white/black pixels)** → normalize(vec3(0)) on miss rays, or uninitialized data
- **Y-flipped image** → QuadMesh UV Y-flip not handled in screen-space shader

## Step 2: Check the Compositor's Display Sources
The Compositor (`rayzee/src/Stages/Compositor.js`) shows the first published texture of the display sources, which the
renderer passes in from its `_displaySources()` hook, and falls back to `pathtracer:color`:
- Renderer core (`RayzeeRenderer.js`): no sources — it always shows the accumulation
- Viewer (`PathTracerApp.js`): `oidn:output` → `edgeFiltering:output` → `bilateralFiltering:output` → `asvgf:output` → `nrd:output`
- `bloom:output` is checked before them, though no stage publishes it today

**If a higher-priority stage is enabled but outputting black/wrong data, it overrides the correct output.**
`DenoisingManager._clearDenoiserTextures()` is what wipes stale denoiser outputs on a strategy switch.

## Step 3: Trace Texture Flow
For each stage in the pipeline:
1. What does it read from `context.getTexture()`?
2. What does it publish via `context.setTexture()`?
3. Is the stage enabled? (`RenderStage` defaults to `enabled: true`; the viewer builds its denoiser stages disabled)
4. On denoiser switch, are stale textures cleaned from context?

## Step 4: Check Event Wiring
Verify events are properly connected:
- `pathtracer:frameComplete` → triggers downstream stages
- `pipeline:historyReset` → the core's hard restart; ASVGF and NRD clear temporal history
- `pipeline:lightingChanged` → new model or environment; auto exposure re-adapts
- `pathtracer:interactionStart` / `interactionEnd` → the viewer's moving-camera resolution drop

## Step 5: Camera Matrix Consistency
If the issue involves depth, normals, or motion vectors:
- Stages MUST sync camera matrices from PathTracer uniforms
- Reading from the camera object directly causes timing mismatches
- Pattern: `this.cameraWorldMatrix.value.copy(pt.cameraWorldMatrix.value)`

## Step 6: TSL Shader Checks
If the issue is in shader output:
- Check for per-renderer data read from module state inside a `Fn()` body — it must come from `sceneResources( builder )` (`TSL/SceneResources.js`); a second renderer or stage in the page otherwise overwrites it
- Check for `normalize(vec3(0))` NaN on background pixels
- Check `outputNode` vs `colorNode` (colorNode destroys .w channel for opaque materials)
- Check If/Else chains (separate `If()` blocks contaminate output)

## Step 7: Report Findings
Provide a clear diagnosis with:
- Root cause identified
- Which file(s) and line(s) are affected
- Suggested fix with code
