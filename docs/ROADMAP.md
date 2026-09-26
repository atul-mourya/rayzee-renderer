# Rayzee Path Tracer - Development Roadmap
*Making the ultimate web-based path tracing application*

## 🎯 Vision & Goals
- **Performance:** Industry-leading real-time path tracing performance
- **Quality:** Production-grade rendering capabilities 
- **Usability:** Intuitive interface for artists and developers
- **Popularity:** Community-driven features and ecosystem

---

## 🚀 High Impact Features (Priority 1)

### WebGPU Migration & Performance
- [x] **WebGPU Backend Integration (TSL)**
  - [x] Port core path tracing to WebGPU via TSL (Three Shading Language → compiles to WGSL)
  - [x] App proxy pattern (`getApp()` / `subscribeApp()`) for store/UI layer
  - [x] WebGL backend removed — WebGPU is sole renderer
  - [x] Full material system port (Disney BSDF, emissive sampling)
  - [x] InteractionManager support (click-to-select, focus picking)
  - [x] Full rendering pipeline with stages (ASVGF, edge filtering, compositor, etc.)

- [ ] **WebGPU Compute Shaders (Phase 2)**
  - [x] Wavefront compute path tracer (stream-compacted kernels via KernelManager / QueueManager)
  - [x] Material-sorted wavefront shading (global counting sort, ~8% GPU win on multi-material scenes)
  - [ ] Compute shader BVH construction for 3-5x build speedup
  - [x] GPU-accelerated denoising passes (ASVGF port to TSL)
  - [x] Compute shader bilateral filtering, variance estimation, auto-exposure
  - [ ] Support WebGPU ray tracing extensions when available

- [ ] **Advanced Hybrid Rendering Pipeline**
  - [ ] Rasterization + path tracing fusion for interactive previews
  - [ ] Temporal upsampling from low-res path tracing
  - [x] Motion vector generation for better temporal stability
  - [x] Depth-aware temporal accumulation (ASVGF spatiotemporal filtering)

### Next-Generation Rendering Features
- [ ] **Volumetric Rendering & Atmosphere**
  - [x] Basic volumetric fog and transmission (fog.js TSL module)
  - [ ] Heterogeneous volume rendering (clouds, smoke)
  - [ ] Atmospheric scattering with multiple scattering
  - [ ] Participating media with anisotropic scattering
  - [ ] Volumetric lighting and shadows

- [ ] **Advanced Material System**
  - [x] Multi-lobe BRDF (GGX specular, diffuse, clearcoat, sheen, transmission)
  - [x] Thin-film iridescence
  - [x] Nested transmission with medium stack (glass-in-glass)
  - [x] Dispersion (chromatic aberration for dielectrics)
  - [x] Exact dielectric Fresnel and a true-peak GGX — a glossy black sphere matches Cycles within 1 % at every angle
  - [x] Cycles' shadow terminator geometry offset for low-poly curved meshes
  - [ ] Disney BSDF 2.0 full implementation
  - [x] Subsurface scattering (random-walk SSS reusing the medium stack)
  - [ ] Procedural material nodes/graph
  - [ ] Fabric/cloth shading models
  - [ ] Car paint and complex layered materials

- [ ] **Caustics & Advanced Light Transport**
  - [ ] Bidirectional path tracing (BDPT)
  - [ ] Photon mapping for caustics
  - [x] Multiple importance sampling (environment + emissive triangle + direct lighting MIS)
  - [ ] Light path caching and reuse

---

## 🎨 User Experience & Interface (Priority 1)

### Professional UI/UX Overhaul
- [ ] **Modern Node-Based Material Editor**
  - [ ] Visual material graph with real-time preview
  - [ ] Procedural texture generation nodes
  - [x] Material library with PBR presets
  - [ ] Import/export material definitions

- [ ] **Scene Management & Asset Pipeline**
  - [x] Dynamic scene object add / remove (runtime BVH insert, no full rebuild)
  - [x] Mesh / group visibility toggling (per-mesh BVH-level, Outliner tree)
  - [x] Interactive transform gizmo (translate/rotate/scale) with per-mesh BVH refit
  - [ ] Scene templates and presets
  - [ ] Version control integration (Git LFS)

- [ ] **Advanced Camera Controls**
  - [x] Cinema-grade camera with physical parameters
  - [ ] Camera animation and keyframing
  - [ ] Virtual camera with gamepad support

### Rendering Management
- [ ] **Render Queue & Batch Processing**
  - [x] Offline animation video export (frame-by-frame → WebCodecs VP9/VP8 → WebM)
  - [ ] Background rendering with progress tracking
  - [ ] Render queue management
  - [ ] Distributed rendering across multiple devices
  - [ ] Cloud rendering integration (optional)

- [ ] **Advanced Denoising Pipeline**
  - [x] GPU-native OIDN denoising (HDR with ACES tonemapping)
  - [x] Temporal denoising (SVGF/A-SVGF improvements)
  - [x] ASVGF quality presets (performance/balanced/quality)
  - [x] AI super-resolution upscaling (ONNX model, tiled with progress overlay)
  - [ ] Machine learning denoising models
  - [ ] Custom denoising parameter profiles

---

## 🔧 Technical Excellence (Priority 2)

### Performance Optimization
- [ ] **Next-Gen BVH & Acceleration**
  - [x] BVH with SAH splitting and treelet optimization
  - [x] Two-level BVH (TLAS/BLAS) with per-mesh refit for transforms
  - [x] O(N) bottom-up BVH refit for animated geometry (worker + SharedArrayBuffer)
  - [x] Object-space shared geometry placed by matrix, with single-use and emissive geometry baked to world space
  - [x] Scene storage past the ~2 GB array ceiling (chunked triangle and node records)
  - [ ] GPU-accelerated BVH construction (compute shader)
  - [x] Dynamic BVH updates for animated scenes
  - [ ] Ray frustum culling
  - [ ] Primitive specialization (curves, volumes)

- [ ] **Memory & Bandwidth Optimization**
  - [x] Size-bucketed material texture arrays (~40% VRAM reduction) + main-thread streaming for large sets
  - [x] VRAM usage tracking — current/peak, per-category via VRAMTracker / `app.getMemoryInfo()`
  - [ ] GPU-compressed texture arrays (blocked by TSL compute-pipeline teardown limitation)
  - [ ] Geometry level-of-detail (LOD)
  - [ ] Occlusion culling
  - [ ] Smart caching strategies

### Advanced Sampling & Convergence
- [ ] **Intelligent Sampling**
  - [ ] Adaptive sampling 2.0 with ML guidance
  - [x] Variance-guided sample distribution
  - [x] Blue noise sampling sequences
  - [x] Emissive triangle sampling with total power integration

- [ ] **Convergence Acceleration**
  - [ ] Reservoir sampling (ReSTIR) — DI/GI in progress on branch, not yet merged
  - [ ] Path guiding implementation
  - [ ] Radiance caching
  - [ ] Temporal sample reuse

---

## 🌍 Content & Ecosystem (Priority 2)

### Asset Integration
- [ ] **Comprehensive Format Support**
  - [x] glTF / GLB loading with automatic camera & animation extraction
  - [x] PBRT-v4 scene loader (MVP: geometry, materials, lights, camera)
  - [ ] USD/OpenUSD integration
  - [ ] Blender direct integration
  - [ ] Houdini/Maya plugin development
  - [ ] Standard material exchange formats

- [ ] **Built-in Asset Library**
  - [x] Online asset browsers — Sketchfab models, PolyHaven HDRIs & PBR materials
  - [ ] Curated high-quality 3D models
  - [ ] Procedural content generation

### Community Features
- [ ] **Sharing & Collaboration**
  - [ ] Cloud scene sharing platform
  - [ ] Render gallery with voting/comments
  - [ ] Scene remix and derivative works
  - [ ] Educational content and tutorials

---

## 🌐 Platform & Distribution (Priority 2)

### Multi-Platform Support
- [ ] **Desktop Applications**
  - [ ] Electron-based desktop wrapper
  - [ ] Native file system access
  - [ ] Better performance profiles
  - [ ] Offline capabilities

- [ ] **Mobile Optimization**
  - [ ] Progressive Web App (PWA)
  - [ ] Touch-optimized interface
  - [ ] Mobile-specific performance modes
  - [ ] iOS/Android app store presence

### Developer Experience
- [ ] **Plugin Architecture**
  - [ ] JavaScript plugin system
  - [ ] Custom render passes
  - [ ] Material and light plugins
  - [ ] API for third-party integrations

- [ ] **Documentation & Learning**
  - [ ] Interactive tutorials
  - [ ] API documentation
  - [ ] Video tutorial series
  - [ ] Technical blog posts

---

## 🎓 Educational & Research (Priority 3)

### Learning Tools
- [ ] **Educational Mode**
  - [ ] Step-by-step rendering visualization
  - [ ] Algorithm explanations
  - [ ] Performance profiling tools
  - [ ] Academic research integration

- [ ] **Research Features**
  - [ ] Custom BRDF implementation
  - [ ] Experimental rendering techniques
  - [ ] Performance benchmarking suite
  - [ ] Research paper reproduction

### Industry Integration
- [ ] **Production Pipeline**
  - [x] Color management — OpenColorIO pipeline: Blender 5.1 config by default, ACES and studio configs, working spaces, looks, displays, per-texture colour spaces, EXR export in a delivery space
  - [x] Multi-pass rendering / AOVs (MRT: color, normalDepth, albedo)
  - [x] GPU device-loss detection & recovery (no rendering into a dead device)
  - [ ] Batch rendering automation
  - [ ] Integration with render farms

---

## 🎯 Success Metrics & Milestones

### Performance Targets
- **Interactive:** 60 FPS at 1080p with 3 bounces
- **Progressive:** 1024 SPP convergence in <30 seconds
- **Quality:** Match offline renderers in visual quality

### User Adoption Goals
- **Community:** 10K+ users, 1K+ GitHub stars
- **Content:** 1K+ shared scenes, 500+ materials
- **Education:** Used in 50+ courses/tutorials

### Technical Milestones
- **Q2 2025:** ~~WebGPU beta release~~ ✅ WebGPU TSL backend shipped, WebGL removed
- **Q3 2025:** ~~Volumetric rendering~~ ✅ Basic volumetric fog/transmission, iridescence, dispersion, nested media
- **Q4 2025:** ~~Compute shaders & denoiser~~ ✅ ASVGF/OIDN GPU-native denoising, compute bilateral filtering, MIS pipeline
- **Q1 2026:** ~~Wavefront rewrite~~ ✅ Wavefront compute path tracer, subsurface scattering, two-level BVH (TLAS/BLAS), size-bucketed texture arrays, VRAM tracking
- **Q2 2026:** ~~Content & assets~~ ✅ Sketchfab/PolyHaven asset browsers, dynamic scene add/remove, AI super-resolution upscaling, PBRT-v4 loader, screen-space radiance cache, GPU device-loss recovery
- **Q3 2026:** ~~Large scenes~~ ✅ Instanced object-space geometry, chunked storage past the 2 GB array ceiling, partial loading of multi-gigabyte scene archives, CPU memory preflight
- **Q3 2026:** Mobile optimization (pending)

---

## 📊 Implementation Strategy

### Phase 1 (Immediate - 3 months) ✅ Complete
1. ~~WebGPU proof of concept~~ ✅ Full TSL backend with dual-canvas architecture
2. ~~UI/UX improvements~~ ✅ Interactive/Final mode switching, debug visualizations
3. ~~Critical bug fixes~~ ✅ NaN guards, Y-flip fixes, camera matrix sync
4. ~~Performance profiling setup~~ ✅ stats-gl, BVH timings, convergence monitoring

### Phase 2 (Short term - 6 months) ✅ Mostly Complete
1. ~~Volumetric rendering~~ ✅ Basic fog, volumetric transmission
2. ~~Advanced materials~~ ✅ Iridescence, dispersion, nested transmission, clearcoat, sheen
3. ~~WebGPU compute shaders~~ ✅ ASVGF denoiser, bilateral filtering, variance estimation (BVH compute still pending)
4. Community features — pending

### Phase 3 (Medium term - 12 months) — In Progress
1. ~~Full WebGPU migration~~ ✅ **Core migration done** — wavefront compute path tracer shipped; GPU BVH build still pending
2. Mobile optimization — pending
3. Desktop applications — pending
4. ~~Production tools~~ ✅ OpenColorIO color management, MRT/AOV output, OIDN GPU denoising, offline video export
5. ~~Content ecosystem~~ ✅ Sketchfab/PolyHaven browsers, dynamic scene editing, AI super-resolution upscaling, PBRT-v4 loader

---

## 📚 Research & Resources

### Technical References
- Disney BSDF: <https://schuttejoe.github.io/post/disneybsdf/>
- WASM BVH: <https://github.com/madmann91/bvh>
- BVH in compute shader (WebGPU): <https://x.com/AddisonPrairie/status/1823934213764341981>
- DDGI: Dynamic Diffuse Global Illumination: <https://blog.traverseresearch.nl/dynamic-diffuse-global-illumination-b56dc0525a0a> -- better for rasterization. does with probes
- GLSL PathTracer Reference: <https://github.com/knightcrawler25/GLSL-PathTracer/tree/master>
- Adventures in Hybrid Rendering: https://diharaw.github.io/post/adventures_in_hybrid_rendering/
- Game Development Resources: https://github.com/Caerind/AwesomeCppGameDev
- article: https://alain.xyz/blog/ray-tracing-denoising
- Kajiya renderer - https://github.com/EmbarkStudios/kajiya

### Blue Noise & Sampling
- <https://www.shadertoy.com/view/wltcRS>
- <https://github.com/knightcrawler25/GLSL-PathTracer/blob/master/src/shaders/common/globals.glsl>
- https://github.com/Calinou/free-blue-noise-textures/tree/master/256_256

### Advanced Techniques
- Sandbox for graphics paper implementation - https://github.com/shocker-0x15/GfxExp
- tessellation free displacement mapping - https://github.com/shocker-0x15/GfxExp/tree/master/tfdm
- Color Science: <https://www.youtube.com/watch?v=II_rnWU7Uq8>
- TracerBoy - <https://github.com/wallisc/TracerBoy/blob/master/TracerBoy/RaytraceCS.hlsl>
- Lumen Ray Tracing: https://www.youtube.com/watch?v=XIxKo8k81XY
- Path guiding: https://www.youtube.com/watch?v=BS1JLbNqGxI
- https://github.com/Pjbomb2/TrueTrace-Unity-Pathtracer
- OIDN Denoiser: https://blog.traverseresearch.nl/denoising-raytraced-images-using-oidn-f6566d605453

### Asset Sources
- <https://skfb.ly/oMGoU>
- <https://api.physicallybased.info/operations/get-materials>
- <https://repalash.com/archives>
- [High Poly models]<https://sketchfab.com/RaphaelDay/collections/backgrounds-e025877a5574455b8f5863da7dc6fb05>

---

*Last Updated: July 2026*
*Current Version: 7.10.0*
*Project Demo: <https://atul-mourya.github.io/RayTracing/>*

**Contributing:** See [CONTRIBUTING.md] for development guidelines
**Discussions:** Join our community discussions for feature requests and feedback