---
name: maintainer
description: >
  Keeps the codebase on the conventions the October 2026 cleanup set (docs/design/CONVENTIONS.md): layers, folders,
  file ownership, exports, test layout, docs and comments. Use when asked to audit, check consistency or drift, tidy
  up, or before a release; after a run of feature commits; and before adding a file, a folder or a long CLAUDE.md
  note. Runs the mechanical checks, reviews the commits since the last audit, reports drift, fixes what the user
  approves, and records the audit.
---

You keep Rayzee consistent with `docs/design/CONVENTIONS.md`. That page is the rulebook; this skill is the procedure.
You report and propose; you change code only once the user approves, and never commit or push without being asked.

## Quick question mode

Asked only "where should this go?" or "is this file/note in the right place?": answer from the rules in
`CONVENTIONS.md` (sections 2–8) in a few lines, naming the existing file that should own the code. Stop there.

## Audit

1. **Read** `docs/design/CONVENTIONS.md` whole: the rules, the accepted exceptions and the audit log. The range to
   audit starts at the last log row's end commit and ends at `HEAD` (or what the user names).
2. **Run the script:** `node .claude/skills/maintainer/check.mjs --since <start>`. `RULE` lines are breaks of a rule;
   `watch` lines need your judgement; accepted exceptions are already left out. Verify every `RULE` item before
   reporting it (open the file, `git grep -nw` the name): the script matches text, not meaning.
3. **Review what the script cannot judge**, over `git log --no-merges <start>..HEAD` and `git diff <start>..HEAD`:
   - *Layers:* viewer names in core files (`git diff <start>..HEAD -- rayzee/src ':!rayzee/src/viewer' ':!rayzee/src/addons' | grep -E "denoisingManager|cameraManager|overlayManager|autoExposure|localExposure|stages\.nrd|timeline"`);
     `bidirectional` or a capability's name added to `PathTracer.js`, `RenderSettings.js` or core events; module-level
     `let` in `shaders/`.
   - *Ownership:* methods added to `RayzeeRenderer` or `SceneProcessor` whose job has a file
     (`loaders/SceneLoading.js`, `scene/SceneEdits.js`, `output/Pictures.js`, `scene/SceneRefit.js`,
     `memory/SceneSpill.js`, `storage/BLASCache.js`, `materials/TextureCreator.js`); `Fn(` kernels added inline to
     `PathTracer.js`; each new file the script lists — does it earn its place, or does an existing file own it?
   - *Docs:* which `CLAUDE.md` sections grew, and whether the growth is rules and traps or measurements and history
     that belong in `docs/design/`; whether `.github/copilot-instructions.md`, `AGENTS.md`, `CONTRIBUTING.md` and
     `.claude/agents/*.md` still agree with `CLAUDE.md`; whether a public API change updated `docs/guide/`.
   - *Comments:* read each block the script lists. Keep API documentation and tables; flag stories, measurements,
     "added for X" and restatements of the code.
   - *Commits:* a cleanup typed `fix:` (releases a patch); a breaking mark on anything but a public API change.
4. **Report** in plain words, grouped as:
   - **Drift since the last audit** — each item: file:line, the rule (section number), what to do, how big.
   - **Older than the last audit** — found now, not new; say so.
   - **Held** — the rules that held, in one or two lines, so the user sees what was checked.
   Lead with what matters most. Do not pad with items you judged fine.
5. **Fix on approval.** Follow "How a cleanup is run" in `CONVENTIONS.md`: moves by script, one step a commit, typed
   `refactor:` / `docs:` / `test:` / `chore:`, and the checks listed there before calling a step done (for code that
   moved: lint, `npm test`, `bench:node -- --core`, builds). Re-run `check.mjs` after.
6. **Book-keep**, in `CONVENTIONS.md`:
   - append a row to the audit log: date, range (`<start>..<end>`), a one-line result, and the commits that fixed it
     (or "open: …");
   - add to the `accepted` block, verbatim as the script prints them, only the items the user chose to keep;
   - a rule the user changes is changed in the page and in `check.mjs` together.

## Rules for this skill

- The user decides what counts as drift. Never add a rule, raise a watch item to a rule, or accept an exception on
  your own; propose it.
- Do not "fix" `docs/TODO.md` without asking: it is the user's own list.
- Keep `check.mjs` fast (seconds) and dependency-free; it reports and changes nothing.
