# Rayzee — instructions for AI coding assistants

`CLAUDE.md` at the repository root is the full, maintained guide to this codebase: architecture, data layouts,
measured trade-offs and known traps. Read it before changing engine code. Where this file and `CLAUDE.md` disagree,
`CLAUDE.md` is right; this file only repeats the rules that are easiest to break.

## Layout

- `rayzee/` — the engine, published to npm as `rayzee`. Source in `rayzee/src/`.
- `app/` — the React UI. Imports the engine as `rayzee`; `@/` resolves to `app/src/`.
- The engine has three layers (`docs/CORE_AND_ADDONS.md`):
  - **Renderer core** — `RayzeeRenderer` (`rayzee/src/RayzeeRenderer.js`, published as `rayzee/core`): scene in,
    path-traced samples, image out. Pipeline: PathTracer → Compositor.
  - **Add-ons** — `rayzee/src/addons/`: physical sky, scene archives, bidirectional/VCM (an integrator in
    `rayzee/src/integrators/`), OpenColorIO colour, on-disk storage.
  - **Viewer** — `PathTracerApp extends RayzeeRenderer`: denoisers, camera controls, gizmo, overlays, timeline,
    animation. It plugs in through the hooks listed under "Hooks" at the end of `RayzeeRenderer.js`.

## Rules

- **Viewer code never goes in the core.** A core method that needs viewer behaviour gets a hook.
  `tests/unit/core/coreBoundary.test.js` fails if the core imports viewer or add-on modules.
- **No module-level shader state.** A TSL `Fn()` body runs when its kernel compiles, so per-renderer resources ride in
  the kernel's build context: `withSceneResources( kernelCall, resources )` / `sceneResources( builder )`
  (`rayzee/src/TSL/SceneResources.js`).
- **Pipeline signals name no capability:** the core emits `pipeline:historyReset` and `pipeline:lightingChanged`.
  The compositor shows the first published of `_displaySources()`.
- **Extra path-tracer outputs are requested** with `pathTracer.requestOutput( name, options )`, compiled only while
  requested. A new integrator registers with `pathTracer.registerIntegrator()`; never add integrator branches to
  `PathTracer.js`.
- **Settings:** `settings.set()`; another layer adds its own key, with its default, through `settings.define( key, { default, apply, reset } )`.
  In the app, change render parameters through the store's handlers, which call `getApp()` (`@/lib/appProxy`).
- **Uniforms are created once**; only `.value` changes, so compiled shader graphs keep their references.
- **Triangles** are read only through `triangleRow( tris, triIndex, row )` (`TSL/Common.js`), with the hit's
  `instanceLeaf`: shared geometry is in object space.
- **A rigid move** uses `updateMeshTransforms()`, never `refitBLASes()` (that would move every copy of shared geometry).
- **`ISSUE_CODES` are add-only** API; never rename or repurpose one. Callbacks handed to collaborators are cleared in
  `dispose()`.
- **React:** the app uses the React Compiler — avoid manual `useMemo` / `useCallback` / `React.memo`, which conflict with it.

## Commits

Conventional commits: every message and PR title starts with `feat:`, `fix:`, `refactor:`, `perf:`, `docs:`, `test:`,
`chore:`, `build:`, `ci:`, `style:` or `revert:` (optional scope, e.g. `fix(tsl):`). **A change to default pixels is a
breaking change** and needs a `BREAKING CHANGE:` footer.

## Commands

`npm run dev` · `npm run build` · `npm run lint` · `npm test` (unit + GPU tests on Dawn) · `npm run bench`
(quality, memory, perf and more; see `bench/README.md`) · `npm run bench:node -- --core` (the core must render every
bench scene byte-identically with the full engine).
