# Rayzee Real-Time Path Tracer - AI Coding Instructions

## Overview
**Rayzee** is a sophisticated real-time path tracing web application built with Three.js, React, and a WebGPU renderer. The core rendering pipeline implements Monte Carlo path tracing with BVH acceleration, progressive denoising, and adaptive sampling — running in the browser via TSL (Three Shading Language) shaders compiled to WGSL.

## Architecture Overview

### Modern Event-Driven Pipeline (`rayzee/src/Pipeline/`)
**Recently refactored from pass-based to stage-based architecture**:
- **`RenderPipeline.js`**: Orchestrates stage execution order with shared context and event bus
- **`RenderStage.js`**: Base class for all rendering stages (replaces Three.js Pass pattern)
- **`PipelineContext.js`**: Shared state, textures, and uniforms between stages
- **`EventDispatcher.js`**: Loose coupling via events (e.g., `pathtracer:frameComplete`, `asvgf:reset`)

### Core Rendering Stages (`rayzee/src/Stages/`)
**Execution order matters** - stages run sequentially:
- **`PathTracer.js`** + **`PathTracerStage.js`**: Monte Carlo wavefront path tracing with MRT outputs. `PathTracer` owns the per-frame kernel dispatch; `PathTracerStage` is the shared base holding uniforms, scene buffers and lifecycle.
- **`ASVGF.js`**: Real-time spatiotemporal denoising
- **`NRD.js`**: Port of NVIDIA's ReBLUR recurrent-blur denoiser
- **`EdgeFilter.js`**: Spatial-only edge-aware à-trous filter
- **`Variance.js`** / **`MotionVector.js`** / **`NormalDepth.js`**: G-buffer and reprojection inputs the denoisers read
- **`AutoExposure.js`** / **`Compositor.js`**: Exposure, tone mapping and the final composite
- **`OverlayManager.js`** + **`helpers/TileHelper.js`** (in `managers/`): Unified overlay system — tile borders rendered on a 2D canvas overlay, never baked into saved images

### TSL Shader Modules (`rayzee/src/TSL/`)
31 TSL files using `Fn()`, `If()`, `Loop()`, `.toVar()`:
- Wavefront kernels: `GenerateKernel.js`, `ExtendKernel.js`, `ShadeKernel.js`, `CompactKernel.js`, `FinalWriteKernel.js`
- Traversal and shading: `BVHTraversal.js`, `MaterialSampling.js`, `MaterialTransmission.js`, `Environment.js`
- Lighting: `LightsDirect.js`, `LightsSampling.js`, `EmissiveSampling.js`, `LightBVHSampling.js`, etc.

### Multi-Threading Architecture (`rayzee/src/Processor/Workers/`)
Critical for maintaining 60fps during heavy computations:
- **`BVHWorker.js`**: Off-main-thread BVH construction using SAH splitting with treelet optimization
- **`TexturesWorker.js`**: Batch texture processing with memory-optimized chunking
- **`BVHSubtreeWorker.js`**: BVH subtree optimization for GPU traversal
- **`CDFWorker.js`**: CDF computation for environment importance sampling

### State Management (`app/src/store.js`)
Zustand-based stores with **automatic 3D engine synchronization**:
- `usePathTracerStore` - Rendering parameters with handlers that use `getApp()` from appProxy
- `useAssetsStore` - Model/environment loading state
- `useCameraStore` - Camera controls with DOF presets
- Pattern: `handleChange()` utility creates handlers that update both store state and 3D engine, triggering `app.reset()` for immediate visual feedback

### Data Layout & GPU Optimization
**Triangle Data Layout** (20 u32 lanes per triangle = 80 B, 5 vec4s). The buffer is bound as
`uvec4`, so a reader binds `'uvec4'` and floats come back through `uintBitsToFloat`:
```js
// rayzee/src/EngineDefaults.js - TRIANGLE_DATA_LAYOUT
FLOATS_PER_TRIANGLE: 20         // 5 vec4s; each position carries its own normal
POSITION_A/B/C_OFFSET: 0/4/8    // f32 xyz, normal packed in the spare .w lane
NORMAL_A/B/C_PACKED_OFFSET: 3/7/11  // octahedral snorm16, ~0.005° worst case
UV_AB_OFFSET: 12, UV_C_OFFSET: 16   // f32
MATERIAL_FLAGS_OFFSET: 18       // materialIndex | side << 24 | shadowBlockerBits << 26
MESH_INDEX_OFFSET: 19
```
⚠️ Geometry storage is hybrid. A geometry used by several objects stays in **object space** and
the ray is moved into it on entry; a geometry used once — or one that emits light — is **baked to
world space**. Any new reader of the triangle buffer must bind `uvec4` **and** take the hit's
`instanceLeaf`, or it will read object-space positions as though they were world space.

## Key Development Patterns

### Event-Driven Stage Communication
**Critical**: Stages communicate via events, not direct coupling:
```js
// PathTracer emitting events
this.eventBus.emit('pathtracer:frameComplete', { frame, samples });
this.eventBus.emit('asvgf:reset');
this.eventBus.emit('tile:changed', { tileX, tileY });

// ASVGFStage listening for events
this.eventBus.on('pathtracer:frameComplete', this.handlePathTracerComplete.bind(this));
this.eventBus.on('asvgf:reset', this.resetTemporalData.bind(this));
```

### Pipeline Context Texture Sharing
**Automatic texture passing** via context (no manual references):
```js
// Stage publishes outputs to context
context.setTexture('pathtracer:color', this.colorTarget.texture);
context.setTexture('pathtracer:normalDepth', this.normalDepthTarget.texture);

// Downstream stages read from context
const pathTracerColor = context.getTexture('pathtracer:color');
const adaptiveSampling = context.getTexture('adaptiveSampling:output');
```

### Progressive Rendering Modes
Three distinct rendering configurations:
- **Interactive** (`INTERACTIVE_STATE`): Low samples (1 SPP, 3 bounces) for real-time navigation
- **Final** (`FINAL_STATE`): High quality (1 SPP, 20 bounces, tiled rendering)
- **Results**: Paused rendering for image viewing/editing

Mode switching via `handleConfigureFor[Mode]()` methods that batch-update uniforms and reset the pipeline.

### State-Engine Synchronization Pattern
**Critical**: All UI state changes must sync with the app via `getApp()`:
```js
// app/src/store.js - handleChange pattern
import { getApp } from '@/lib/appProxy';

const handleChange = (setter, appUpdater, needsReset = true) => val => {
    setter(val);
    const app = getApp();
    if (app) {
        appUpdater(val);
        needsReset && app.reset();  // Triggers immediate re-render
    }
};
```
Always use `getApp()` from appProxy to access the app instance. Never use store setters directly for render parameters — always use provided handlers like `handleBouncesChange`, `handleSamplesChange`.

### Denoising Pipeline Coordination
**Temporal filtering coordination**:
- ASVGF (real-time) vs OIDN (final quality) - never both simultaneously
- EdgeAware filtering disabled when ASVGF enabled
- Quality presets in `ASVGF_QUALITY_PRESETS` (performance/balanced/quality)

### Asset Processing Workflow
1. **AssetLoader** loads GLB/GLTF models with automatic camera extraction
2. **GeometryExtractor** converts meshes to optimized triangle data (32-float layout)
3. **BVHBuilder** constructs acceleration structure (Web Worker)
4. **TextureCreator** generates GPU textures for materials, triangles, BVH data

## Development Commands

### Essential Development Workflow
```bash
npm run dev         # Start Vite dev server (localhost:5173)
npm run lint        # ESLint with React Compiler plugin
npm run lint-fix    # Auto-fix linting issues
npm run build       # Production build with shader bundling
```

### Debug Visualizations (visMode uniform)
Access via Path Tracer tab → Debug Mode:
- `1-2`: BVH traversal statistics (triangle/box tests)
- `3`: Ray distance visualization  
- `4`: Surface normals
- `6`: Environment map luminance heat map
- `7`: Environment importance sampling PDF

### Performance Profiling
The engine emits an `EngineEvents.FRAME` event every `animate()` tick. Hosts attach their own stats panel (e.g. `stats-gl`) — the app does this in `app/src/components/layout/Viewports/StatsPanel.jsx`. Other built-in profiling signals:
- Triangle intersection counters in shaders
- BVH construction timings with treelet optimization metrics
- Memory usage tracking for texture arrays
- Progressive rendering convergence monitoring

## Critical Implementation Details

### Pipeline Architecture 
**Event-driven stages** replace legacy pass system - stages run in explicit order with loose coupling via events and shared context. See `docs/PIPELINE_ARCHITECTURE.md` for details.

### Memory Management
Web Workers handle large data processing with chunked allocation:
```js
// TexturesWorker.js pattern
const MEMORY_LIMITS = {
    MAX_BYTES_PER_TEXTURE: 256 * 1024 * 1024,  // 256MB chunks
    ADAPTIVE_CHUNK_SIZE: true                   // Dynamic based on texture dimensions
}
```

### Shader Data Access Pattern
Materials and BVH data accessed via texture lookups in TSL:
```js
// Standard pattern in TSL shaders
const getDatafromDataTexture = Fn(([tex, texSize, stride, sampleIndex, dataOffset]) => { ... })
```

### Camera & DOF System
Photography-inspired presets (`CAMERA_PRESETS`) for portrait/landscape/macro with proper focal length calculations. Focus picking via click-to-focus interaction mode.

## Common Pitfalls & Solutions

1. **Store Updates**: Always use provided handlers (e.g., `handleBouncesChange`) rather than direct setters — they sync with the app via `getApp()`
2. **App Access**: Always use `getApp()` from `@/lib/appProxy` to access the app instance
3. **TSL Hot Reload**: TSL shader changes hot-reload normally via Vite
4. **Worker Data Transfer**: Use transferable objects for large arrays to avoid main thread blocking
5. **BVH Memory**: Large models may require treelet optimization (`treeletOptimization: true`) for performance
6. **Resolution Scaling**: Path tracer resolution independent of UI — use `updateResolution(scale, index)` (2-arg signature)
7. **React Compiler**: Uses React Compiler plugin — avoid manual memoization patterns that conflict with automatic optimization

## Testing & Validation
- Visual testing via built-in debug modes and example scenes
- Performance monitoring through stats display and console timings  
- Memory validation via browser dev tools during large asset loading
- Convergence verification using progressive rendering sample counts

The codebase prioritizes real-time interactivity while maintaining path tracing quality through intelligent LOD systems, progressive refinement, and GPU-optimized data structures.


---
description: 'ReactJS development standards and best practices'
applyTo: '**/*.jsx, **/*.tsx, **/*.js, **/*.ts, **/*.css, **/*.scss'
---

# ReactJS Development Instructions

Instructions for building high-quality ReactJS applications with modern patterns, hooks, and best practices following the official React documentation at https://react.dev.

## Project Context
- Latest React version (React 19+)
- TypeScript for type safety (when applicable)
- Functional components with hooks as default
- Follow React's official style guide and best practices
- Use modern build tools (Vite, Create React App, or custom Webpack setup)
- Implement proper component composition and reusability patterns

## Development Standards

### Architecture
- Use functional components with hooks as the primary pattern
- Implement component composition over inheritance
- Organize components by feature or domain for scalability
- Separate presentational and container components clearly
- Use custom hooks for reusable stateful logic
- Implement proper component hierarchies with clear data flow

### TypeScript Integration
- Use TypeScript interfaces for props, state, and component definitions
- Define proper types for event handlers and refs
- Implement generic components where appropriate
- Use strict mode in `tsconfig.json` for type safety
- Leverage React's built-in types (`React.FC`, `React.ComponentProps`, etc.)
- Create union types for component variants and states

### Component Design
- Follow the single responsibility principle for components
- Use descriptive and consistent naming conventions
- Implement proper prop validation with TypeScript or PropTypes
- Design components to be testable and reusable
- Keep components small and focused on a single concern
- Use composition patterns (render props, children as functions)

### State Management
- Use `useState` for local component state
- Implement `useReducer` for complex state logic
- Leverage `useContext` for sharing state across component trees
- Consider external state management (Redux Toolkit, Zustand) for complex applications
- Implement proper state normalization and data structures
- Use React Query or SWR for server state management

### Hooks and Effects
- Use `useEffect` with proper dependency arrays to avoid infinite loops
- Implement cleanup functions in effects to prevent memory leaks
- Use `useMemo` and `useCallback` for performance optimization when needed
- Create custom hooks for reusable stateful logic
- Follow the rules of hooks (only call at the top level)
- Use `useRef` for accessing DOM elements and storing mutable values

### Styling
- Use CSS Modules, Styled Components, or modern CSS-in-JS solutions
- Implement responsive design with mobile-first approach
- Follow BEM methodology or similar naming conventions for CSS classes
- Use CSS custom properties (variables) for theming
- Implement consistent spacing, typography, and color systems
- Ensure accessibility with proper ARIA attributes and semantic HTML

### Performance Optimization
- Use `React.memo` for component memoization when appropriate
- Implement code splitting with `React.lazy` and `Suspense`
- Optimize bundle size with tree shaking and dynamic imports
- Use `useMemo` and `useCallback` judiciously to prevent unnecessary re-renders
- Implement virtual scrolling for large lists
- Profile components with React DevTools to identify performance bottlenecks

### Data Fetching
- Use modern data fetching libraries (React Query, SWR, Apollo Client)
- Implement proper loading, error, and success states
- Handle race conditions and request cancellation
- Use optimistic updates for better user experience
- Implement proper caching strategies
- Handle offline scenarios and network errors gracefully

### Error Handling
- Implement Error Boundaries for component-level error handling
- Use proper error states in data fetching
- Implement fallback UI for error scenarios
- Log errors appropriately for debugging
- Handle async errors in effects and event handlers
- Provide meaningful error messages to users

### Forms and Validation
- Use controlled components for form inputs
- Implement proper form validation with libraries like Formik, React Hook Form
- Handle form submission and error states appropriately
- Implement accessibility features for forms (labels, ARIA attributes)
- Use debounced validation for better user experience
- Handle file uploads and complex form scenarios

### Routing
- Use React Router for client-side routing
- Implement nested routes and route protection
- Handle route parameters and query strings properly
- Implement lazy loading for route-based code splitting
- Use proper navigation patterns and back button handling
- Implement breadcrumbs and navigation state management

### Testing
- Write unit tests for components using React Testing Library
- Test component behavior, not implementation details
- Use Jest for test runner and assertion library
- Implement integration tests for complex component interactions
- Mock external dependencies and API calls appropriately
- Test accessibility features and keyboard navigation

### Security
- Sanitize user inputs to prevent XSS attacks
- Validate and escape data before rendering
- Use HTTPS for all external API calls
- Implement proper authentication and authorization patterns
- Avoid storing sensitive data in localStorage or sessionStorage
- Use Content Security Policy (CSP) headers

### Accessibility
- Use semantic HTML elements appropriately
- Implement proper ARIA attributes and roles
- Ensure keyboard navigation works for all interactive elements
- Provide alt text for images and descriptive text for icons
- Implement proper color contrast ratios
- Test with screen readers and accessibility tools

## Implementation Process
1. Plan component architecture and data flow
2. Set up project structure with proper folder organization
3. Define TypeScript interfaces and types
4. Implement core components with proper styling
5. Add state management and data fetching logic
6. Implement routing and navigation
7. Add form handling and validation
8. Implement error handling and loading states
9. Add testing coverage for components and functionality
10. Optimize performance and bundle size
11. Ensure accessibility compliance
12. Add documentation and code comments

## Additional Guidelines
- Follow React's naming conventions (PascalCase for components, camelCase for functions)
- Use meaningful commit messages and maintain clean git history
- Implement proper code splitting and lazy loading strategies
- Document complex components and custom hooks with JSDoc
- Use ESLint and Prettier for consistent code formatting
- Keep dependencies up to date and audit for security vulnerabilities
- Implement proper environment configuration for different deployment stages
- Use React Developer Tools for debugging and performance analysis

## Common Patterns
- Higher-Order Components (HOCs) for cross-cutting concerns
- Render props pattern for component composition
- Compound components for related functionality
- Provider pattern for context-based state sharing
- Container/Presentational component separation
- Custom hooks for reusable logic extraction