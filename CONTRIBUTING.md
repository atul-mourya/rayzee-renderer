# Contributing to Rayzee Path Tracer

Thank you for your interest in contributing to Rayzee! This document provides guidelines and information for contributors.

## 🚀 Getting Started

### Prerequisites

- **Node.js** >= 20.11.1
- **npm** or **yarn**
- Modern browser with WebGPU support (Chrome 113+, Edge 113+)
- Basic knowledge of JavaScript, React, and Three.js
- Understanding of path tracing concepts (helpful but not required)

### Development Setup

1. **Fork and Clone**
   ```bash
   git clone https://github.com/YOUR_USERNAME/rayzee-renderer.git
   cd rayzee-renderer
   ```

2. **Install Dependencies**
   ```bash
   npm install
   ```

3. **Start Development Server**
   ```bash
   npm run dev
   ```

4. **Verify Setup**
   - Open http://localhost:5173
   - Load a model and verify rendering works
   - Check browser console for errors

## 📝 Code Style and Conventions

### JavaScript/React Style

- **Indentation**: Use tabs (as per existing codebase)
- **Semicolons**: Always use semicolons
- **Quotes**: Single quotes for strings, double quotes for JSX attributes
- **Function Declarations**: Use function declarations for named functions
- **Arrow Functions**: Use for callbacks and inline functions
- **Destructuring**: Prefer destructuring for props and state

### Component Structure

```jsx
// Good component structure
import { useState, useEffect, useCallback } from 'react';
import { SomeIcon } from 'lucide-react';
import { useStore } from '@/store';

const ComponentName = ({ prop1, prop2 }) => {
	
	// Hooks first
	const [localState, setLocalState] = useState(null);
	const storeValue = useStore(state => state.value);
	
	// Callbacks and handlers
	const handleClick = useCallback(() => {
		// Handle click
	}, []);
	
	// Effects
	useEffect(() => {
		// Effect logic
	}, []);
	
	return (
		<div className="component-container">
			{/* Component JSX */}
		</div>
	);
	
};

export default ComponentName;
```

### Naming Conventions

- **Components**: PascalCase (`PathTracerTab`, `ResultsViewport`)
- **Files**: PascalCase for components, camelCase for utilities
- **Functions**: camelCase (`handleClick`, `processModel`)
- **Constants**: UPPER_SNAKE_CASE (`DEFAULT_STATE`, `SUPPORTED_FORMATS`)
- **CSS Classes**: kebab-case with Tailwind utility classes

### File Organization

```
src/
├── components/           # React components
│   ├── ui/              # Reusable UI components
│   └── layout/          # Layout-specific components
├── core/                # Core path tracing engine
│   ├── PathTracerApp.js # Main application class
│   ├── Stages/          # Rendering pipeline stages
│   ├── TSL/             # TSL shader modules
│   └── Processor/       # Asset processing
├── hooks/              # Custom React hooks
├── store/              # Zustand stores
├── utils/              # Utility functions
└── assets/             # Static assets
```

## 🧪 Testing Requirements

### Manual Testing Checklist

Before submitting a PR, ensure:

- [ ] **Basic Functionality**: App loads without errors
- [ ] **Model Loading**: Can load GLB/GLTF files via drag-drop and file picker
- [ ] **Environment Loading**: HDRI environments load correctly
- [ ] **Path Tracing**: Rendering works with progressive improvement
- [ ] **UI Interactions**: All controls respond properly
- [ ] **Results System**: Can save and view rendered images
- [ ] **Cross-browser**: Test in Chrome, Firefox, Safari, Edge
- [ ] **Performance**: No significant performance regressions

### Code Quality

- **ESLint**: Run `npm run lint` - no errors allowed
- **TypeScript**: If using TypeScript, no type errors
- **Console Logs**: Remove debug logs before submitting
- **Memory Leaks**: Ensure proper cleanup of Three.js objects

## 🔄 Pull Request Process

### Before Submitting

1. **Create Feature Branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make Changes**
   - Follow code style guidelines
   - Add comments for complex logic
   - Update documentation if needed

3. **Test Thoroughly**
   - Manual testing checklist
   - Cross-browser verification
   - Performance impact assessment

4. **Commit** following the conventions below.

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
nothing — a default setting, a mode preset, a render profile, light units, a sampling or BSDF change that moves the
bench's reference images — needs a `BREAKING CHANGE:` footer saying how default renders change, so the release is a
new major version. `tests/unit/constants/pixelDefaults.test.js` and `npm run bench:bless` both flag such a change.

### PR Template

When creating a PR, include:

```markdown
## Description
Brief description of changes and motivation.

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Performance improvement
- [ ] Documentation update
- [ ] Code refactoring

## Testing
- [ ] Manual testing completed
- [ ] Cross-browser testing
- [ ] Performance impact assessed

## Screenshots/Videos
If applicable, add screenshots or videos demonstrating the changes.

## Checklist
- [ ] Code follows project style guidelines
- [ ] Self-review completed
- [ ] Comments added for complex code
- [ ] Documentation updated
```

### Review Process

1. **Automated Checks**: PRs must pass ESLint and build checks
2. **Code Review**: At least one maintainer review required
3. **Testing**: Reviewer will test functionality
4. **Merge**: Squash and merge after approval

## 🐛 Issue Reporting

### Bug Reports

Use the bug report template:

```markdown
**Bug Description**
Clear description of the bug.

**Steps to Reproduce**
1. Go to '...'
2. Click on '...'
3. See error

**Expected Behavior**
What should happen.

**Actual Behavior**
What actually happens.

**Environment**
- OS: [e.g., Windows 10, macOS 13.2]
- Browser: [e.g., Chrome 120, Firefox 119]
- GPU: [e.g., NVIDIA RTX 3080, AMD RX 6800]

**Screenshots**
If applicable, add screenshots.

**Console Errors**
Include any console error messages.
```

### Feature Requests

```markdown
**Feature Description**
Clear description of the proposed feature.

**Use Case**
Why is this feature needed?

**Proposed Implementation**
If you have ideas on implementation.

**Additional Context**
Any other relevant information.
```

## 🎯 Contribution Areas

### High-Priority Areas

- **Performance Optimization**: Shader improvements, memory management
- **File Format Support**: New 3D model formats, texture formats
- **Denoising**: Algorithm improvements, parameter tuning
- **UI/UX**: Better user experience, accessibility improvements
- **Documentation**: Tutorials, API documentation, examples

### Low-Priority Areas

- **New Rendering Features**: Volumetrics, subsurface scattering
- **Platform Support**: Mobile optimization, Safari WebGPU compatibility
- **Export Features**: Animation support, batch operations
- **Advanced Materials**: Procedural materials, material editor

## 📚 Resources

### Learning Materials

- **Three.js Documentation**: https://threejs.org/docs/
- **Path Tracing Theory**: "Physically Based Rendering" by Pharr, Jakob, Humphreys
- **WebGPU**: https://webgpufundamentals.org/
- **React Best Practices**: https://react.dev/

### Useful Tools

- **Browser DevTools**: For debugging and profiling
- **Chrome DevTools GPU panel**: WebGPU debugging and profiling

## 🤝 Community Guidelines

- **Be Respectful**: Treat all contributors with respect
- **Be Patient**: Remember that everyone is learning
- **Be Helpful**: Help others learn and contribute
- **Stay On Topic**: Keep discussions focused on the project
- **Follow Code of Conduct**: Professional and inclusive behavior

## ❓ Getting Help

- **Discussions**: Use GitHub Discussions for questions
- **Issues**: Create issues for bugs and feature requests
- **Documentation**: Check existing documentation first
- **Code Examples**: Look at similar implementations in the codebase

## 📄 License

By contributing to Rayzee, you agree that your contributions will be licensed under the MIT License.

---

Thank you for contributing to Rayzee! Your efforts help make real-time path tracing accessible to everyone. 🚀
