# Contributing to Rayzee

Thank you for your interest in contributing to Rayzee! This guide covers setup, conventions and how changes are
checked. `CLAUDE.md` at the repository root is the detailed guide to the engine's architecture and its known traps.

## 🚀 Getting Started

### Prerequisites

- **Node.js** >= 20.19.0 and **npm** (the repo is an npm workspace with a `package-lock.json`)
- A browser with WebGPU: Chrome or Edge 113+, Safari 18+, Firefox 141+
- Basic knowledge of JavaScript, React and three.js; path tracing helps but is not required

### Development Setup

1. **Fork and clone**
   ```bash
   git clone https://github.com/YOUR_USERNAME/rayzee-renderer.git
   cd rayzee-renderer
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start the development server**
   ```bash
   npm run dev
   ```

4. **Verify the setup**: open http://localhost:5173, load a model, and check the console for errors.

## 🗂 Repository Layout

```
rayzee/                   # The engine, published to npm as `rayzee`
├── src/
│   ├── RayzeeRenderer.js # The renderer core (`rayzee/core`)
│   ├── PathTracerApp.js  # The viewer: denoisers, controls, gizmo, overlays, timeline
│   ├── addons/           # Optional capabilities (physical sky, archives, bidirectional, colour, storage)
│   ├── integrators/      # Alternative light-transport integrators (bidirectional / VCM)
│   ├── Stages/           # Pipeline stages (path tracer, denoisers, compositor)
│   ├── TSL/              # TSL shader modules and wavefront kernels
│   ├── Processor/        # Scene building: BVH, textures, geometry, loaders
│   ├── managers/         # Sub-managers (uniforms, materials, environment, camera, lights, …)
│   └── Pipeline/         # RenderPipeline, RenderStage, PipelineContext
└── README.md             # The package's API reference
app/                      # The React UI
└── src/
    ├── components/       # React components (ui/ and layout/)
    ├── hooks/            # Custom hooks
    ├── lib/              # Engine integration (appProxy, EngineAdapter, sessions, colour)
    ├── store.js          # Zustand stores
    └── utils/
bench/                    # Headless-GPU regression bench (bench/README.md)
tests/                    # Vitest: unit/ and gpu/ (GPU tests run on Dawn in Node)
docs/                     # Architecture notes (see docs/CORE_AND_ADDONS.md for the engine's layers)
```

The engine has three layers: the **renderer core**, **add-ons**, and the **viewer** built on both. Viewer code never
goes into the core; see `docs/CORE_AND_ADDONS.md`.

## 📝 Code Style

The style is enforced by ESLint (`eslint-config-mdcs`, the three.js style): tabs, semicolons, and spaces inside
parentheses and brackets. Run `npm run lint-fix` rather than formatting by hand.

- **Components**: `const ComponentName = ( { prop1, prop2 } ) => { … }`, as the rest of the app does
- **React Compiler**: the app is compiled with it — avoid manual `useMemo` / `useCallback` / `React.memo`
- **Engine state from the UI**: change render parameters through the store's handlers, which reach the engine with
  `getApp()` from `@/lib/appProxy`
- **Comments**: short; explain why, not what

```jsx
import { useState, useEffect } from 'react';
import { useStore } from '@/store';

const ComponentName = ( { label } ) => {

	const [ open, setOpen ] = useState( false );
	const value = useStore( ( state ) => state.value );

	useEffect( () => {

		// …

	}, [ value ] );

	return (
		<button className="px-2 text-sm" onClick={() => setOpen( ! open )}>
			{label}
		</button>
	);

};

export default ComponentName;
```

### Naming

- **Components**: PascalCase (`PathTracerTab`, `ResultsViewport`)
- **Files**: PascalCase for components and classes, camelCase for utilities
- **Functions**: camelCase (`handleClick`, `processModel`)
- **Constants**: UPPER_SNAKE_CASE (`ENGINE_DEFAULTS`, `SUPPORTED_FORMATS`)

## 🧪 Testing

Before submitting a PR:

- `npm run lint` — no errors
- `npm test` — unit tests and the GPU tests (`tests/gpu/`, run on the real GPU through Dawn; skipped on CI, but a
  workstation without a WebGPU adapter fails them)
- **Rendering changes**: `npm run bench:quality` compares every bench scene with its reference image, and
  `npm run bench:ab -- main` is the performance gate. The bench's references are specific to one machine; run
  `npm run bench:bless` once on a new one. See `bench/README.md`
- **Engine core changes**: `npm run bench:node -- --core` renders every bench scene with the renderer core and the
  full engine and requires them to match byte for byte
- **UI changes**: load a model and an HDRI, check the controls you touched, and watch the console

Remove debug logs, and dispose every GPU resource and listener a change creates.

## 🔄 Pull Request Process

1. **Branch** from `main`, named by change type: `feat/…`, `fix/…`, `refactor/…`, `docs/…`.
2. **Make the change**, updating `CLAUDE.md`, `rayzee/README.md` or `docs/` when behaviour or API changes.
3. **Test** as above.
4. **Commit** following the conventions below, and open the PR — the template lists what to fill in.

### Commit & PR conventions

Every commit message and PR title starts with a [conventional commit](https://www.conventionalcommits.org/) type:
`feat:`, `fix:`, `refactor:` (no behaviour change), `perf:`, `docs:`, `test:`, `chore:`, `build:`, `ci:`, `style:`
or `revert:`. A scope is optional: `feat(asvgf):`, `fix(tsl):`, `refactor(pipeline):`. The release is cut from these
types, so a wrong one ships a wrong version.

```bash
git commit -m "feat: add adaptive sampling quality presets"
git commit -m "fix(tsl): resolve NaN in the clear-coat lobe"
```

**A change to default pixels is a breaking change.** Anything that changes what a render looks like when a host sets
nothing — a default setting (the core's or a viewer piece's), a mode preset, light units, a sampling or BSDF change that moves the
bench's reference images — needs a `BREAKING CHANGE:` footer saying how default renders change, so the release is a
new major version. `tests/unit/constants/pixelDefaults.test.js` and `npm run bench:bless` both flag such a change.

### Review

- No checks run automatically on a pull request: run lint and the tests yourself. The release workflow
  (`.github/workflows/release.yaml`) runs lint, the engine build and the tests on every push to `main`, then
  publishes with semantic-release — so a merge to `main` is a release.
- At least one maintainer reviews, and tests rendering changes.
- PRs are merged with a merge commit.

## 🐛 Issues

Use the issue forms on GitHub (bug report, feature request). For a rendering bug, include the browser, OS and GPU,
the model if you can share it, and any console errors. Questions go to
[Discussions](https://github.com/atul-mourya/rayzee-renderer/discussions).

## 🎯 Contribution Areas

- **Performance**: shader and memory work, measured with the bench
- **Formats**: model and texture formats, scene importers
- **Denoising and picture**: denoiser quality, tone mapping, colour
- **Add-ons**: new capabilities built on the renderer core — skies, integrators, importers
- **UI/UX and accessibility**
- **Documentation**: tutorials, examples, API reference

## 📚 Resources

- **three.js**: https://threejs.org/docs/ (and `llms.txt` in this repo for the TSL reference)
- **Path tracing**: *Physically Based Rendering* by Pharr, Jakob and Humphreys
- **WebGPU**: https://webgpufundamentals.org/
- **React**: https://react.dev/

## 🤝 Community Guidelines

Be respectful, patient and helpful, and keep discussions on topic. See the [Code of Conduct](CODE_OF_CONDUCT.md).

## 📄 License

By contributing to Rayzee, you agree that your contributions will be licensed under the MIT License.
