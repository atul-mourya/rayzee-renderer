# Conventions

How the code is laid out and kept tidy: the rules the October 2026 cleanup set, how a cleanup is run, what was done
and what was left on purpose, and a log of the checks since. `/maintainer` (`.claude/skills/maintainer/`) audits the
code against this page; `node .claude/skills/maintainer/check.mjs` runs the part a script can check.

A rule changes here and in `check.mjs` together, and only once the maintainer of the repository agrees.

## Why

By October 2026 the engine worked but was hard to find one's way in: `Processor/` held 81 unrelated files,
`managers/` and `utils/` were grab bags, the core/viewer line existed only in an import test, four files passed
3,000 lines (`RayzeeRenderer.js` 4,495, `SceneProcessor.js` 4,523, the app's `store.js` 3,185, `ShadeKernel.js`),
`utils.js` held 29 helpers of which 12 were used only by their own tests, `rayzee/README.md` was 2,075 lines,
`CLAUDE.md` was near its 150k-character limit, and tests sat in folders the source no longer had.

## The rules

Each rule says how it is checked: a **test** fails the build, **check** is `check.mjs`, **review** is a person (or
`/maintainer`) reading the change.

### 1. Three layers

The **renderer core** (`RayzeeRenderer`, `rayzee/core`), the **add-ons** (`rayzee/addons/*`) and the **viewer**
(`PathTracerApp extends RayzeeRenderer`). Each uses only the layers below it. Detail: `CORE_AND_ADDONS.md`.

- The core imports nothing from `viewer/` or `addons/`; whatever only the full entry reaches lives in `viewer/`,
  whatever only an add-on reaches in that add-on's folder. *Test:* `tests/unit/core/coreBoundary.test.js`.
- A core method that needs viewer behaviour gets a hook (the "Hooks" list at the end of `RayzeeRenderer.js`), never a
  `this.denoisingManager?.` call. *Review.*
- An add-on is installed through a setter (`setProceduralSky`, `setArchiveImporter`, `setColorManagement`,
  `setStorageOpener`, `registerIntegrator`, `registerFormat`); asked for without it, the core records
  `capability.missing`. *Review.*
- Pipeline signals name no capability (`pipeline:historyReset`, `pipeline:lightingChanged`); extra path-tracer outputs
  are asked for (`requestOutput`); a new integrator plugs into the integrator hooks, never `if ( bidirectional )` in
  `PathTracer.js`. *Review.*
- Per-renderer shader resources ride in the kernel's build context (`shaders/SceneResources.js`), never module
  variables. *Review;* `bench:node -- --core` catches a leak between renderers.
- Each layer declares its own settings (`settings.define`) and keeps its own defaults beside its code;
  `ENGINE_DEFAULTS` is exactly the core's settings table. *Test:* `engineDefaults.test.js`.

### 2. Folders

- `rayzee/src` is one folder a job, lowercase: `pipeline/ pathtracer/ shaders/ (kernels/) scene/ bvh/ lights/
  materials/ environment/ loaders/ memory/ output/ color/ storage/ node/ addons/ viewer/`. No catch-alls (`utils/`,
  `helpers/`, `managers/`, `misc/`, `common/`). *Check.*
- The root holds only the entries and the public API: `index.js`, `core.js`, `RayzeeRenderer.js`, `RenderSettings.js`,
  `EngineDefaults.js`, `EngineEvents.js`, `EngineIssues.js`, `AssetConfig.js`, `Platform.js`, `HeadlessCanvas.js`,
  `Logger.js`, `Portable.js`, `Version.js`. A new root file is asked about first. *Check.*
- An add-on is one folder, `addons/<name>/`, its entry `index.js` beside its code (`formats.js` is one file). Folder
  names match the published path (`physical-sky`). *Test* (coreBoundary) and *check.*
- `viewer/` has a subfolder a job: `camera/ overlays/ animation/ denoise/ picture/ lights/`.
- A worker sits in the folder of the job that starts it (`bvh/BVHWorker.js`). *Review.*

### 3. Files

- Modules are PascalCase (`SceneLoading.js`); entries and folders lowercase (`index.js`, `core.js`). *Check.*
- **A new file must earn its place.** Code goes into the file that already owns it. A new file is right only when
  several files share it and it cannot live in one of them (it runs in a worker, or must not pull shader code into a
  manager). One file per concern, inside an existing folder. *Review* (`check.mjs --since` lists new files).
- No grab-bag files (`utils.js`, `helpers.js`). A helper lives with the code that uses it. *Check* (folders) and
  *review* (files).
- A generated file is written whole by its generator (`shaders/DFGTable.js` by `npm run bench:lut`), never pasted.
- A case-only rename needs `git rm --cached` of the old name: macOS hides it. *Check.*

### 4. Big files

A class that grows past what one person can read is split **by job**, not by size:

- Its methods move to the folder of their job as functions taking the owner first (`app`, `processor`), and every
  public method stays on the class as a one-line call with its documentation, so the API and subclass overrides do
  not change. The examples: `loaders/SceneLoading.js`, `scene/SceneEdits.js`, `output/Pictures.js` (from
  `RayzeeRenderer`); `scene/SceneRefit.js`, `memory/SceneSpill.js`, `storage/BLASCache.js`,
  `materials/TextureCreator.js` (from `SceneProcessor`).
- New code of one of those jobs goes into that file, not back onto the class. *Review.*
- Compute kernels live in `shaders/kernels/`, never inline in `PathTracer.js`. *Review.*
- `check.mjs` lists files over 2,000 lines and their growth since the last audit; a split is decided with the
  maintainer, not done because a number was passed.

### 5. Exports and dead code

- Export only what another file imports. A name used only in its own file is not exported; a name used nowhere is
  deleted. *Check.*
- A helper used only by its own test is dead code: it goes, with its test. *Check* (as a watch item: some test seams
  are deliberate).
- What `index.js`, `core.js`, an add-on entry, `rayzee/node` or `rayzee/encoders` exports is public API: removing it
  is a breaking change.

### 6. Tests

- `tests/unit/` mirrors `rayzee/src`: a test sits in the folder of the module it exercises (`core/` for the root
  files, `addons/<name>/`, `viewer/<job>/`); `app/` and `bench/` hold tests of those. `tests/gpu/` runs on Dawn.
  *Check.*
- Tests import the engine through `@/core/…`, never a relative path into `rayzee/src`. *Check.*

### 7. The app

- `app/src/store/`: one file a store (`ui.js` keeps the general store with its three small siblings), re-exported by
  `index.js`, so every `@/store` import is unchanged. *Check.*
- `lib/` is engine integration and helpers (no `utils/` folder); `services/` the outside catalogues; hooks are
  `useX.js` (`use-toast.js` keeps the UI kit's name); components PascalCase, the UI kit's `components/ui/` its own
  kebab-case. *Check.*
- Controls are few and in plain words; expert knobs stay in the engine API.

### 8. Docs

- `CLAUDE.md` holds rules, traps (⚠️) and short summaries, under 150k characters. Long notes, measurements and history
  go to `docs/design/<TOPIC>.md`, with a one-paragraph summary, every ⚠️ and a link left behind. *Check* (warns past
  135k).
- `docs/guide/` is for people using the engine; a public API change updates it. `docs/design/` is how it works inside.
- `rayzee/README.md` is the npm page: install, a quick start, links. `bench/README.md` is a how-to; its detail is
  `docs/design/BENCH.md`. *Check* (length).
- `.github/copilot-instructions.md` repeats only the easiest rules to break, and where it disagrees `CLAUDE.md` is
  right. A rule changed in `CLAUDE.md` is changed there, in `CONTRIBUTING.md` and in `.claude/agents/` too. *Review.*
- A doc that names a file names one that exists. *Check.*

### 9. Comments

Short, and only where the reason is not obvious: a hidden constraint, a workaround, a trap. Measurements, root-cause
stories and "added for X" go in the commit message. Public API keeps its documentation; a table of values (sampler
dimensions) is fine. *Check* lists added comment blocks of 5+ lines for review.

### 10. Commits and releases

- Conventional commits; `refactor:` changes no behaviour and releases nothing, so a cleanup is typed `refactor:`,
  `docs:`, `test:` or `chore:` — a `fix:` releases a patch. *Check* (types).
- Breaking (`!` or the footer) only for a public API change, never for a look. *Check* lists them for review.
- Nothing is committed or pushed without the maintainer's say: a push to `main` is a release.

## How a cleanup is run

1. **Plan first, as one page:** the full map (every file, old path → new path), built from the import graph, not
   from memory; the open questions listed with a recommendation each; the open branches it will collide with.
2. **One step a commit, moves apart from edits.** A move commit changes paths and import lines only. Moves are
   scripted (the import graph or the syntax tree: acorn and magic-string), never by hand; `this` → `app` is the only
   change a moved method's body gets.
3. **Prove nothing changed:** lint; `build:engine` (every entry) and `build:app`; `npm test`; `bench:node -- --core`
   identical line for line to the run before; every kernel's WGSL byte-identical where kernels moved;
   `bench:examples`; `dist/` within bytes; the app in Chrome (load, render, denoise, export).
4. **Known traps:** a moved file's relative `import( './x' )` must be rewritten too (builds catch it, tests do not); a
   path rewrite can double a segment (`addons/addons/`) — grep after every move; case-only renames on macOS; the dev
   server keeps a deleted module's transform cached — touch its importers; every named import must still be exported
   by its target.
5. **Review the whole branch before merging**, and fold the review's findings into the same series.

## History

| Date | Step | Commits | Release |
|---|---|---|---|
| 2026-10-03/04 | Core, add-ons and viewer split; outputs on request; per-renderer shader resources; formats add-on | `4f796b02`, `6461bc0c`, `66bfad98`, `35bd9564`, `30f91a88`, `c6c726c9` … | 9.5.0 |
| 2026-10-04 | Docs pass: every tracked `.md` audited, copilot-instructions cut to rules and a pointer | `dd507731`..`f1cce4ce` | 9.5.0 |
| 2026-10-05 | Defaults: `ENGINE_DEFAULTS` is the settings table, each piece keeps its own, render profiles gone | `9b6a66d2`, `15333696` | 11.0.0 |
| 2026-10-25 | Round 1: app leftovers out; `rayzee/src` regrouped by job (209 of 229 files); tests moved to match; `RayzeeRenderer`, `SceneProcessor` and the app store split by job; `utils.js` dissolved; review follow-ups | `d47c3990`, `d775d020`, `e3bd1b7c`, `1115c970`, `ee52a3a3`, `887bdca5`, `e0ca675c`, `c8dacc2e` | 11.15.0 |
| 2026-10-26 | Round 2: DFG table generated; 13 dead exports gone, 54 un-exported; `.gitignore` 159 → 55 lines; each add-on in its own folder; README split into `docs/guide/`; one naming rule; `SceneProcessor`'s caches and textures with their owners | `d3b47bcb`, `db5d7afc`, `ec2b8ee1`, `ca114a22` | 11.15.1 |
| 2026-10-26 | Round 3: inline kernels into `shaders/kernels/`; `CLAUDE.md` 140k → 109k; bench README a how-to; remaining tests laid out like the source | `3a02f4a9`, `459931ea`, `25547379`, `afb5616d`, `350f47ac` | 11.15.1 |

### Left on purpose

- `ShadeKernel.js` stays whole: one `Fn` whose parts share locals (passing them between `Fn`s has cost Shade 1–2 %
  where measured).
- The bidirectional branches stay in Shade (about 80 sites: a Shade fork or dozens of hooks), and the spill
  orchestration in `SceneProcessor` (hooks in its three hardest build functions for ~6 KB).
- The app tidy (round 3's step E) was proposed and not done.
- `docs/TODO.md` is tracked (`a274353d`): ignored, a hundred old branches would have overwritten or deleted it.

## Accepted exceptions

Items `check.mjs` would report that were looked at and kept, one a line, exactly as the script prints them.

```accepted
```

## Audit log

The next audit starts at the last row's end commit.

| Date | Range | Result | Fixed in |
|---|---|---|---|
| 2026-10-26 | the cleanup itself | rounds 1–3 | `350f47ac` |
| 2026-11-08 | `350f47ac..1bfc9b42` (118 commits) | Layout, layers and splits held. Drift: `copilot-instructions.md` still called a pixel change breaking; `CLAUDE.md` 109k → 124k, "Materials and shading" doubled; 42 added comment blocks of 5+ lines, 16 of them stories or measurements; `fogDensityAt`, `uvTangentOf` exported for their own file only. Open: 4 dead paths in `docs/TODO.md` (the user's list); "Memory Management" and "Denoising" in `CLAUDE.md` grew ~2k each. Older: 7 exports only tests use; `tests/unit/core/constants.test.js` tests the app | `7f087412`, `6f47328b`, `fea299d6` |
| 2026-11-08 | `1bfc9b42..7881dcac` (18 commits) | Layers, ownership, splits, exports and comments held; new files earn their place. One drift caught before commit: a measurement in a new `CLAUDE.md` ⚠️ (denoiser lean-back), moved to `NRD_DENOISER.md`. Older, still open: the 4 dead paths in `docs/TODO.md` (the user's list), 7 exports only tests use, `constants.test.js` | `7881dcac` |
