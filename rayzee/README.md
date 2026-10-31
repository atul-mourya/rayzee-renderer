# Rayzee Engine

[![NPM Package][npm]][npm-url]
[![Build Size][build-size]][build-size-url]
[![NPM Downloads][npm-downloads]][npmtrends-url]
[![jsDelivr Downloads][jsdelivr-downloads]][jsdelivr-url]

A real-time WebGPU path tracing engine built on Three.js. Framework-agnostic — use it with React, Vue, vanilla JS, or any other setup.

🌐 **[Live Demo](https://atul-mourya.github.io/rayzee-renderer/)** — the same demo app linked from the root monorepo README, built on this engine.

## Documentation

- **[Getting started](https://github.com/atul-mourya/rayzee-renderer/blob/main/docs/guide/getting-started.md)** — set-ups without a bundler, with React or beside a three.js app; asset URLs; the viewer and the renderer core; add-ons; troubleshooting
- **[Scenes](https://github.com/atul-mourya/rayzee-renderer/blob/main/docs/guide/scenes.md)** — loading models, folders and archives; camera, lights, animation, timeline, materials, environment; moving objects
- **[Rendering](https://github.com/atul-mourya/rayzee-renderer/blob/main/docs/guide/rendering.md)** — settings and modes, colour management, denoising, local exposure, saving pictures, the render reserve, OIDN and the upscaler
- **[Headless rendering and Node](https://github.com/atul-mourya/rayzee-renderer/blob/main/docs/guide/headless.md)** — deterministic and production renders, batch rendering, Node, GPU timing
- **[Storage and memory](https://github.com/atul-mourya/rayzee-renderer/blob/main/docs/guide/storage.md)** — on-disk caches, scene state, render checkpoints, memory monitoring
- **[API](https://github.com/atul-mourya/rayzee-renderer/blob/main/docs/guide/api.md)** — events, the degradation contract, logging, custom pipeline stages, every export

## Installation

```bash
npm install rayzee three
```

`three` (>=0.187.0) is a required peer dependency.

## Quick start

### Vanilla JS with Vite

1. **Create a project**

   ```bash
   npm create vite@latest my-raytracer -- --template vanilla
   cd my-raytracer
   npm install rayzee three
   ```

2. **Set up the HTML**

   ```html
   <!-- index.html -->
   <body style="margin: 0; overflow: hidden;">
     <canvas id="viewport"></canvas>
     <script type="module" src="/main.js"></script>
   </body>
   ```

3. **Write the code**

   ```js
   // main.js
   import { PathTracerApp, EngineEvents } from 'rayzee';

   const canvas = document.getElementById('viewport');
   canvas.width = window.innerWidth;
   canvas.height = window.innerHeight;

   const engine = new PathTracerApp(canvas);
   await engine.init();

   // Load a 3D model (place .glb in public/ folder)
   await engine.loadModel('/scene.glb');

   // Light it: a model alone renders black. The physical sky needs no file;
   // for an HDRI, await engine.loadEnvironment('/environment.hdr') instead.
   await engine.environmentManager.setMode('procedural');

   // Start rendering
   engine.animate();

   // Listen for events
   engine.addEventListener(EngineEvents.RENDER_COMPLETE, () => {
     console.log('Frame rendered');
   });

   // Tweak settings
   engine.settings.set('maxBounces', 8);
   engine.settings.set('exposure', 1.2);

   // Use namespaced APIs and direct methods
   engine.cameraManager.switchCamera(0);
   engine.lightManager.add('PointLight');

   // Capture the current frame as a Blob (host handles save/upload)
   const blob = await engine.screenshot();
   ```

4. **Run**

   ```bash
   npm run dev
   ```

## Browser Requirements

- WebGPU support (Chrome 113+, Edge 113+, Safari 18+, Firefox 141+)
- Secure context (HTTPS or localhost)

## License

MIT

[npm]: https://img.shields.io/npm/v/rayzee
[npm-url]: https://www.npmjs.com/package/rayzee
[build-size]: https://badgen.net/bundlephobia/minzip/rayzee
[build-size-url]: https://bundlephobia.com/result?p=rayzee
[npm-downloads]: https://img.shields.io/npm/dw/rayzee
[npmtrends-url]: https://www.npmtrends.com/rayzee
[jsdelivr-downloads]: https://img.shields.io/jsdelivr/npm/hm/rayzee
[jsdelivr-url]: https://www.jsdelivr.com/package/npm/rayzee
