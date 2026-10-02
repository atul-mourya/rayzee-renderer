# Path Tracer Shader Architecture

Rayzee Path Tracing Engine – Internal Shader Design (PathTracer Stage Only)

---

## Scope & Exclusions

This document covers the real-time path tracing stage shader system for the **WebGPU backend (TSL)**. The renderer is a **pure wavefront path tracer**: a sequence of compute kernels (no fragment-shader megakernel — the monolithic `Trace` integrator has been removed).

TSL (Three Shading Language) is a JavaScript-based shader authoring system that compiles to WGSL at runtime via Three.js's WebGPU backend. All shader modules live in `rayzee/src/TSL/`.

Explicitly excluded (refer to separate docs):
- Denoisers (ASVGF, EdgeFilter, BilateralFilter)
- Post-processing (Bloom, Tone mapping, AutoExposure)
- Pipeline orchestration, backend, and state management (see `PIPELINE_ARCHITECTURE.md`)

---

## High-Level Overview

The path tracer performs Monte Carlo integration of the rendering equation using multiple importance sampling (MIS) across material lobes and (optionally) an importance-sampled environment map, the physical sky's analytic sun, emissive triangles (uniform CDF or light BVH), and analytic lights for direct lighting.

It is structured as a **wavefront**: rays live in SoA storage buffers and are advanced one bounce at a time by separate compute kernels. Per frame the dispatch order is:

```
resetCounters → Generate → (initActiveIndices | setEnteringFromActive)
  → per-bounce loop: Extend → (optional Sort) → Shade → Compact (+ compactCopyback)
  → FinalWrite
```

It outputs three Multiple Render Targets (MRT) via write-only StorageTextures:

- `gColor` (rgba): RGB accumulated radiance + A = output alpha (1.0 opaque; preserved for transparent background).
- `gNormalDepth` (rgba): World-space normal (xyz, 0–1 packed) + NDC depth (a, `computeNDCDepth`).
- `gAlbedo` (rgba): Denoiser albedo buffer (RGB) + alpha.

Key features:
- Progressive accumulation with temporal blending (in `FinalWriteKernel`).
- Selectable random sequence generation (PCG / Halton / Sobol, the default).
- High-performance stack-based two-level BVH traversal (TLAS → BLAS), per-mesh visibility free-fetched from the BVH leaf.
- Physically-based material system with multi-lobe BRDF sampling (diffuse, specular, sheen, clearcoat, transmission) plus iridescence and random-walk subsurface.
- Environment importance sampling using a marginal + conditional CDF (stored in an R32F texture).
- The physical sky's sun as a light of its own: drawn exactly on a miss, sampled by NEE, the two MIS-weighted.
- Light BVH for stochastic emissive triangle sampling via tree traversal.
- Three camera projections in one kernel (`TSL/CameraRay.js`, switched by the `cameraProjection` uniform): pinhole, orthographic (parallel rays from the camera's image plane) and 360° equirectangular.
- Depth of field (thin lens with a flat focal plane, sized either by the blur asked for or as a physical lens) and camera jitter for anti-aliasing.
- Firefly mitigation (`regularizePathContribution`).
- Optional material-index sorting (per-workgroup or global radix) for shading coherence.

---

## Module Map (`rayzee/src/TSL/`)

Kernels use `Fn()`, `.compute()`, `If()`, `Loop()`, `.toVar()`, `.assign()`, and proxy-enhanced structs. Some leaf helpers use `wgslFn()`.

### Wavefront kernels (one compute node each)

| TSL Module | Key Exports | Role |
|---|---|---|
| `GenerateKernel.js` | `buildGenerateKernel()`, `GENERATE_WG_SIZE` | Primary ray generation (camera ray + DOF + jitter), per-ray RNG seed, bounce-0 G-buffer init; optional atomic-append to dense active list |
| `ExtendKernel.js` | `buildExtendKernel()`, `EXTEND_WG_SIZE` | Closest-hit `traverseBVH` per active ray → packed hit buffer, including the hit's facet normal and shadow-terminator lift (`HitFacet.js`) |
| `ShadeKernel.js` | `buildShadeKernel()`, `SHADE_WG_SIZE` | Surface shading: direct lighting (NEE), emissive/light-BVH NEE, transmission/medium stack, indirect bounce sampling, bounce-0 MRT writes |
| `CompactKernel.js` | `buildCompactKernel()`, `buildCompactSubgroupKernel()`, `COMPACT_WG_SIZE` | Stream-compact surviving (still-active) rays into the next-bounce index list |
| `SortGlobalKernels.js` | `buildResetGlobalHistKernel()`, `buildGlobalHistKernel()`, `buildGlobalPrefixKernel()`, `buildGlobalScatterKernel()`, `SORT_GLOBAL_WG_SIZE`, `SORT_GLOBAL_MAX_BINS` | Global material counting sort (reset → histogram → prefix-sum → scatter) → material-pure workgroups for shading coherence; bins sized per-scene to material count |
| `FinalWriteKernel.js` | `buildFinalWriteKernel()`, `FINALWRITE_WG_SIZE` | Per-pixel: temporal accumulation blend, MRT StorageTexture writes; visMode 11 flags NaN/Inf red |
| `DebugKernel.js` | `buildDebugKernel()`, `DEBUG_WG_SIZE` | Single-pass primary-ray debug viz for visMode 1–10 (delegates to `TraceDebugMode`); mode 9 computed inline |
| `LightGenerateKernel.js` | `buildLightGenerateKernel()` | Bidirectional only: starts one light subpath per pool slot on a source picked by flux from the source table — an emissive triangle (power-picked, uniform point, cosine direction), a lamp (rect/disk, point, spot, directional), or a light at infinity (the sun, the environment's exact table, a directional light), whose paths start on a disc covering the visible scene |
| `ConnectKernel.js` | `buildConnectKernel()` | Bidirectional only: connects each camera vertex Shade left pending to one cached light vertex |
| `LightSplatKernel.js` | `buildLightSplatKernel()`, `buildSplatResolveKernel()` | Bidirectional only: light tracing — every cached light vertex to the pinhole, into a fixed-point splat image; the resolve adds it into each chunk before FinalWrite |

### Shared sampling / shading helpers (imported by the kernels)

| TSL Module | Key Exports | Role |
|---|---|---|
| `PathTracerCore.js` | `generateSampledDirection()`, `regularizePathContribution()`, `computeNDCDepth()`, `handleRussianRoulette()` | BRDF direction sampling (multi-lobe CDF), firefly suppression, NDC depth, adaptive Russian roulette |
| `BVHTraversal.js` | `traverseBVH()`, `traverseBVHShadow()`, `generateRayFromCamera()` | Two-level BVH closest-hit + shadow traversal, inline triangle intersection + side culling, camera ray gen |
| `MaterialSampling.js` | `ImportanceSampleGGX()`, `ImportanceSampleCosine()`, `cosineWeightedSample()`, `sampleGGXVNDF()` | Direction-sampling primitives (GGX, VNDF, cosine) |
| `MaterialEvaluation.js` | `evaluateMaterialResponse()`, `evaluateLayeredBRDF()` | Combined multi-lobe BRDF evaluation |
| `MaterialProperties.js` | `calculateBRDFWeights()`, `calculateVNDFPDF()`, `evalIridescence()`, `createMaterialCache()` | Per-lobe weights, PDFs, iridescence, cached derived factors |
| `MaterialTransmission.js` | `sampleMicrofacetTransmission()`, `handleMaterialTransparency()`, `handleTransmission()`, medium structs | Refraction, dispersion, Beer–Lambert absorption, medium stack |
| `Subsurface.js` | `handleSubsurfaceEntry()`, `sampleChromaticCollision()`, `sampleHenyeyGreenstein()` | Random-walk subsurface scattering (reuses the medium stack) |
| `Clearcoat.js` | `sampleClearcoat()`, `ClearcoatResult` | Clearcoat BRDF layer |
| `Environment.js` | `sampleEnvironment()`, `sampleEquirect()`, `sampleEquirectProbability()`, `equirectDirectionToUv()`, `equirectUvToDirection()`, `getGroundProjectedDirection()` | HDR sampling, importance sampling, direction↔UV, ground projection |
| `Sun.js` | `sunRadianceToward()`, `sampleSunDisc()` | The physical sky's sun disc: limb darkening, cut by the sky's horizon, uniform sampling of the cone |
| `EmissiveSampling.js` | `sampleEmissiveTriangle()`, `calculateEmissiveTriangleContribution()`, `sampleSphericalTriangle()` | NEE from emissive triangles (uniform CDF path) |
| `LightBVHSampling.js` | `sampleLightBVHTriangle()` | Stochastic light BVH traversal for emissive sampling |
| `LightsCore.js` | Light data structs; `setGoboMapsTexture()`, `setIESProfilesTexture()` | Light type definitions + gobo/IES texture setters |
| `LightsDirect.js` | `traceShadowRay()`, `calculateRayOffset()`, importance estimators; `setShadowAlbedoMaps()`, `setAlphaShadowsUniform()` | Shadow rays (with alpha shadows), per-light importance |
| `LightsIndirect.js` | `calculateIndirectLighting()`, `selectSamplingStrategy()`, `computeSamplingInfo()` | Material-only multi-strategy MIS for the indirect bounce |
| `LightsSampling.js` | `calculateDirectLightingUnified()`, `calculateMaterialPDF()`, `sampleLightWithImportance()` | Stochastic discrete light/BRDF selection + deterministic environment and sun NEE |
| `Fresnel.js` | `fresnelDielectric()`, `dielectricFresnelWeight()`, `fresnelSchlick()`, `iorToFresnel0()`, `dielectricF0()` | Exact unpolarised Fresnel at every dielectric interface (base layer, clear coat, glass, SSS boundary, glass shadows), as Cycles uses; Schlick for metals and iridescence; IOR↔F0 |
| `HitFacet.js` | `hitFacet()`, `packHitFacet()`, `unpackHitFacet()` | The hit triangle's facet normal (and the terminator lift), computed in Extend and packed into the hit record's spare lane |
| `ShadowTerminator.js` | `shadowTerminatorLift()`, `shadowTerminatorOrigin()` | Cycles' Shadow Terminator → Geometry Offset: the smooth-surface lift for light and environment shadow rays |
| `Random.js` | `getDecorrelatedSeed()`, `getStratifiedSample()`, `getRandomSampleND()`, `pcgHash()` | PCG, Halton, Sobol |
| `TextureSampling.js` | `sampleAllMaterialTextures()`, `computeUVCache()`, `sampleDisplacementMap()` | UV transforms, material texture arrays |
| `Displacement.js` | `refineDisplacedIntersection()`, `DisplacementResult` | Ray-marched displacement refinement |
| `Debugger.js` | `TraceDebugMode()` | Debug visualization modes (reused by `DebugKernel`) |
| `Struct.js` | `Ray`, `HitInfo`, `RayTracingMaterial`, `DirectionSample`, `MaterialCache`, etc. | GPU-side struct definitions |
| `Common.js` | `getDatafromStorageBuffer()`, `getMaterial()`, `offsetRayOrigin()`, `SHADOW_END`, constants | Shared constants, storage-buffer data accessors, ray spawn offset |

> `ShaderBuilder.js` (in `Processor/`) builds the shared scene texture nodes (env, material map arrays, prev-frame MRT, gobo/IES) consumed by the kernels. It NO LONGER builds a compute/output node — the kernels own their own compute graphs.

---

## Stage Classes (`rayzee/src/Stages/`)

- **`PathTracerStage.js`** (`class PathTracerStage`): shared base — engine/scene infrastructure. Owns the 5 sub-managers (`UniformManager`, `MaterialDataManager`, `EnvironmentManager`, `ShaderBuilder`, `StorageTexturePool`), uniforms, camera/lights, BVH/scene data, accumulation/completion state, ASVGF coordination, lifecycle, mesh visibility, and `setupMaterial()` (builds the shared scene texture nodes via `ShaderBuilder.createSceneTextureNodes`).
- **`PathTracer.js`** (`class PathTracer extends PathTracerStage`): the single renderer. Owns the wavefront resources (`PackedRayBuffer`, `QueueManager`, `KernelManager`), builds all kernels in `_buildWavefrontKernels()`, and drives the per-frame dispatch in `render()`.

### Wavefront resources (`rayzee/src/Processor/`)
- **`PackedRayBuffer.js`**: SoA ray / hit / rng storage buffers plus a per-pixel first-hit G-buffer, with read/write helpers (`RAY`, `HIT` slot tables; `RAY_STRIDE`/`HIT_STRIDE`/`GBUFFER_STRIDE`).
- **`QueueManager.js`**: ping-pong active-index queues, sorted-index queue, and atomic counters (`COUNTER`, `RAY_FLAG`).
- **`KernelManager.js`** (renamed from `WavefrontKernelManager`): registers, caches, and dispatches the compute nodes (`register()`, `dispatch()`, `setDispatchCount()`).
- **`StorageTexturePool.js`**: 3 write-only MRT StorageTextures + 1 readable MRT RenderTarget; `getWriteTextures()`, `getReadTextures()`, `copyToReadTargets()`, `ensureSize()`.

---

## Render Targets & Output Semantics

MRT layout (written by `FinalWriteKernel` / `DebugKernel` into `StorageTexturePool`'s write textures, then copied to the readable RenderTarget):

```
textures[0] = gColor       // RGB accumulated radiance + A = output alpha
textures[1] = gNormalDepth // World-space normal (xyz, 0..1) + NDC depth (a)
textures[2] = gAlbedo      // Albedo (RGB) + alpha — for denoiser input
```

`gColor.a` is `1.0` for opaque output; with `transparentBackground` it carries the path's coverage alpha (also blended through accumulation).

Depth in `gNormalDepth.a` stores **NDC depth** in `[0,1]` (`computeNDCDepth`), used for motion-vector reprojection. First-hit normal/depth/albedo are staged in a separate **per-pixel G-buffer** (not the per-ray SoA buffer): half-packed into one `uvec4`/pixel by `writeGBuffer` at bounce 0, then decoded by `FinalWriteKernel` (`gbDecodeNormalDepth`) when it writes the MRT.

First-hit MRT data (normal/depth/albedo) is written by `ShadeKernel` into the per-pixel G-buffer only on `bounceIndex == 0`.

---

## Uniform Groups (JS → GPU Data Flow)

Uniforms are owned by `UniformManager` and exposed on the stage; `PathTracer` wires them into the kernel builders. Principal categories:

1. **Camera & DOF:** `cameraWorldMatrix`, `cameraProjectionMatrixInverse`, `cameraViewMatrix`, `cameraProjectionMatrix`; `cameraProjection` (`CAMERA_PROJECTION_IDS`), `panoLonRange`, `panoLatRange`, `panoLevelHorizon`; `enableDOF`, `dofMode`, `dofBlur`, `focusDistance`, `focalLength`, `aperture`, `apertureScale`, `anamorphicRatio`, `unitsPerMetre`.
2. **Frame & Control:** `frame`, `maxBounces`, `transmissiveBounces`, `maxSubsurfaceSteps`, `renderMode`.
3. **Accumulation:** `enableAccumulation`, `accumulationAlpha`, `cameraIsMoving`, `hasPreviousAccumulated` (+ prev-frame MRT texture nodes).
4. **Sampling:** `samplingTechnique` (0=PCG, 1=Halton, 2=Sobol, the default).
5. **Environment:** `enableEnvironment`, `environmentIntensity`, `environmentMatrix`, `envTotalSum`, `envResolution`, `envCompensationDelta`, the physical sky's sun (`hasSun`, `sunDirection`, `sunRadiance`, `sunParams` = cos half-angle, solid angle, 1/sin², horizon dip), `backgroundIntensity`, `showBackground`, `transparentBackground`, `fireflyThreshold`; ground projection (`groundProjectionEnabled`, `groundProjectionRadius`, `groundProjectionHeight`).
6. **Lighting:** `numDirectionalLights`, `numPointLights`, `numSpotLights`, `numAreaLights` + the matching light storage buffer nodes; `globalIlluminationIntensity`.
7. **Emissive / Light BVH:** `enableEmissiveTriangleSampling`, `emissiveTriangleCount`, `emissiveVec4Offset`, `emissiveTotalPower`, `emissiveBoost`, `lightBVHNodeCount`.
8. **Geometry & Material Data:** `triangleStorageNode` (a `{ geo, shade }` pair, see below), `bvhStorageNode`, `materialStorageNode`, `lightStorageNode`; `totalTriangleCount`. (The environment CDF is an R32F **texture** node, not a storage buffer — see Environment Importance Sampling.)
9. **Material Sampler Arrays:** `albedoMaps`, `emissiveMaps`, `normalMaps`, `roughnessMaps`, `metalnessMaps`, `bumpMaps`, `displacementMaps` (rebound each frame via `_refreshWfTextureNodes`).
10. **Debug:** `visMode`, `debugVisScale`.

Wavefront render-size uniforms live on `PathTracer`: `_wfRenderWidth`, `_wfRenderHeight`, `_wfMaxRayCount`, `_wfCurrentBounce`.

Uniform updates that influence sampling or accumulation trigger a pipeline reset (frame counter back to 0).

---

## Data Layouts (GPU storage buffers)

### Triangle data (`triangleStorageNode`)
Compact, vec4-aligned 5-slot layout (20 u32 lanes = 80 B per triangle, from `EngineDefaults.js`).
The store is bound as `uvec4`; positions and UVs are float bit patterns read with
`uintBitsToFloat`, and each vertex normal is an oct16 pair in its position's spare `.w` lane:
1. posA.xyz, normalA (oct16)
2. posB.xyz, normalB (oct16)
3. posC.xyz, normalC (oct16)
4. uvA.xy, uvB.xy
5. uvC.xy, flags, meshIndex

`flags` packs `materialIndex | side << 24 | shadowBlockerBits << 26`. The two blocker bits say
whether a shadow ray settles on this triangle without fetching its material: bit 26 always, bit
27 only while alpha-cutout shadows are off.

On the GPU the five rows live in two buffers: rows 1–3 (positions and normals, 48 B) in
`triangleGeoAttr` and rows 4–5 (UVs, flags, mesh index) in `triangleShadeAttr`. One 80 B buffer
reached WebGPU's 4 GB buffer limit at 53.6M triangles; the geo buffer alone reaches it at 89.5M.
The CPU records stay whole and `PathTracerStage._uploadTriangles` splits them on upload. Kernels
take the pair as `triangleStorageNode = { geo, shade }` and read a row only through
`triangleRow( tris, triIndex, row )` (`TSL/Common.js`), which picks the buffer.

### Two-level BVH (`bvhStorageNode`)
Combined buffer `[ TLAS | BLAS_0 | BLAS_1 | ... ]`, 16 floats (4 × vec4) per node:
- Inner node: child AABBs + child indices in slots 0–3 (4 reads, no child fetches).
- Leaf tags live in `nodeData0.w` as u32 bit patterns (`floatBitsToUint`), above `BVH_MAX_INDEX`.
- Triangle leaf (`TRIANGLE_LEAF`, 0x40000000): `[triOffset, triCount, _, tag]`.
- BLAS-pointer leaf (`BLAS_POINTER_LEAF`, 0x40000001): `[blasRootNodeIndex, placement, visibility, tag]`
  with the world-to-object rows in slots 4–15. Visibility is free-fetched with the leaf; bit 30 of
  slot `[1]` (`TLAS_LEAF_IDENTITY`) marks a baked placement whose ray transform is skipped.

**Folded leaves** (scenes past `FOLD_LEAVES_TRIANGLES`, 40M stored triangles): every triangle leaf
of ≤ 15 triangles (`BVH_FOLDED_LEAF_MAX`) is folded into its parent (`Processor/BVHLeafFold.js`).
The parent's child slot then holds `~( first << 4 | count )`, the value traversal pushes, so a
folded reference sits at 2^31 or above and a leaf node is `tag >> 30 === 1`. BLAS nodes roughly
halve (55.7M Moana: 50.1M → 32.0M nodes, 3.1 → 2.0 GB), images bit-identical. The tree buffer
attribute carries `foldedLeaves`, and `BVHTraversal.js` emits the folded code only for such a tree:
it cost 0.5–3.7 % GPU time in every variant tried, so an unfolded tree runs the old code exactly.
Offsets are rebased through `rebaseNodes` and refits go through `BVHRefitter`, which both read
folded children.

⚠️ Triangles of a geometry shared by several placements are in **object space**: the ray is
transformed into that space on entering the leaf and the hit's `instanceLeaf` names the leaf to
transform back through. Single-use and emissive geometry is baked to world space behind an
identity leaf instead, so it needs no transform either way.

### Material data (`materialStorageNode`)
Packed per-material properties: base color/metalness/emissive/roughness/ior/transmission/thickness; volumetric attenuation + dispersion; sheen; specular + iridescence; clearcoat; alpha/side flags; normal/bump/displacement scaling; subsurface.

### Emissive triangles / Light BVH (`lightStorageNode`)
Packed emissive-triangle data + power; light BVH nodes built by `LightBVHBuilder.js`. `emissiveVec4Offset` indexes the emissive region; `lightBVHNodeCount > 0` selects the BVH fast path.

### Environment CDF (`envCDFTexture`, R32F)
Marginal + conditional CDF for importance-sampling inversion in `Environment.js`. Stored as an `(W+1)×H` R32F texture (moved off a storage buffer to free a Shade-stage binding): conditional CDF at texel `(cx, cy)`, marginal CDF at texel `(W, cy)`; sampled via integer `.load()`.

### Packed ray buffers (`PackedRayBuffer.js`)
SoA-within-a-buffer: field `slot` of ray `id` lives at `id + slot*capacity`. `RAY_STRIDE = 7`, `HIT_STRIDE = 3` (`HIT_STRIDE_BIDIRECTIONAL = 7`, plus the light vertex cache after the path regions). RAY slots (7): `ORIGIN_META`, `DIR_FLAGS`, `THROUGHPUT_PDF`, `RADIANCE_ALPHA`, `MEDIUM_STACK`, `MEDIUM_SIGMA_A`, `SSS_SIGMA_S`. HIT slots (2): `DIST_TRI_BARY` (distance, triangle, texture UV — not barycentrics), `NORMAL_MAT` (the **interpolated** normal, material, instance leaf, and in `.w` the facet normal as an 11:11 octahedral pair plus the terminator lift's top 10 half-float bits — `HitFacet.js`). First-hit MRT (normal/depth/albedo) is **not** in the ray buffer — it lives in a separate **per-pixel** G-buffer (`GBUFFER_STRIDE = 1`, one half-packed `uvec4`/pixel) written at bounce 0 and read by `FinalWrite`. Capacity uses a 1.25× headroom with no pow2 rounding.

---

## Per-Frame Execution Flow (`PathTracer.render()`)

1. Bail if `!isReady || !_wavefrontReady`, or if accumulation is already complete.
2. Resolve resize (`_handleResize`).
3. Update camera + accumulation uniforms; set wavefront dispatch sizes (`_setWfDispatch`); rebind prev-frame MRT and scene texture nodes.
4. **Debug shortcut:** if `visMode` is 1–10, dispatch the single `DebugKernel`, copy to read targets, publish to context, and return. (Mode 11 flows through the normal pipeline; FinalWrite flags NaN/Inf.)
5. `resetCounters` → `Generate` (traces every pixel).
6. Seed the active list with `initActiveIndices` (identity).
7. **Per-bounce loop** (`bounce` from 0 to `maxBounces + transmissiveBounces + maxSubsurfaceSteps`):
   - Size the per-bounce kernels: functional-compaction path sizes from last frame's survivor curve (× 1.5 + 1024 margin); full-dispatch path uses `enterFull` + full ray count.
   - `Extend` (closest hit).
   - Optional sort: global radix (`resetSortGlobalHistogram`/`sortGlobalHist`/`sortGlobalPrefix`/`sortGlobalScatter`) or per-workgroup (`resetSortHistogram`/`sort`).
   - `Shade`.
   - `resetActiveCounter` → `Compact` (+ `compactCopyback` on the functional path) → `snapshotBounceCount`.
   - Early-exit when the (stale, async-readback) survivors' summed throughput for this bounce falls below `_bounceEarlyExitThreshold` × a full frame's worth. Energy, not ray count: past Russian roulette a few survivors carry the weight of many.
8. `FinalWrite` (per-pixel temporal blend + MRT writes).

With `integrator: 'bidirectional'` the frame first runs a light pass through the same pool —
`lightGenerate`, then the bounce loop over light subpaths (`extend` / `shade` / `compact` /
`lightCopyback`), then `lightSplat` — and each camera bounce adds `connect` after `shade`, each chunk
`splatResolve` before `FinalWrite`. See [Bidirectional integrator](#bidirectional-integrator).
9. Async counter readback (`_maybeReadbackCounters`, every N frames) for the survivor curve.
10. Copy write StorageTextures → readable MRT RenderTarget; publish to context; emit events; `frameCount++`.

There is no swap of the active-index ping-pong during the loop: kernels are build-time-bound to buffer A, so `compactCopyback` copies the dense survivor list B→A for the next bounce.

### Shade kernel (per-ray work)
- Miss: environment contribution (background/MIS-weighted env light, ground projection, transparent-background guard), then the sun disc, power-heuristic weighted against sun NEE when the sending vertex could have drawn that direction (`RAY_FLAG.SUN_NEE`).
- Hit: sample material textures, write bounce-0 MRT data, accumulate emissive, run direct lighting (`calculateDirectLightingUnified` + analytic-light/environment/sun NEE), emissive-triangle NEE (light BVH when `lightBVHNodeCount > 0`, else uniform-CDF `calculateEmissiveTriangleContribution`), handle transmission / medium stack / subsurface, then sample the indirect bounce (`calculateIndirectLighting`) and write the continued ray.

### Bidirectional integrator
`TSL/Bidirectional.js` holds the shared pieces: the MIS recursion (Georgiev 2012's dVCM/dVC, power
heuristic, `calculateMaterialPDF` densities both ways), emitter side and area densities, the source table
helpers and `resolveSurfaceMaterial`, which re-reads a stored vertex's material as Shade folds it;
`TSL/BidirectionalLamps.js` holds the lamp pick NEE and a light path's landing share. Light subpaths start on
every light, and in this mode Shade samples each itself (lamps, sun, environment, emitters) rather than through
`calculateDirectLightingUnified`; the environment through the exact table in the CDF texture's lower rows
(`sampleEnvironmentExact`). Rect lights, not being geometry, are tested on each camera continuation. A light ray in Shade skips
everything camera-only (backdrop, aux, emission, NEE), stores an opaque vertex in the light vertex cache —
the hit buffer's tail, `path × (maxBounces + 1) + depth` — and scatters with the adjoint BSDF. Camera
vertices write a pending record that ConnectKernel resolves after Shade. Shadow rays of the bidirectional
strategies treat glass as opaque (`traceShadowRayRefractiveOpaque`). Full notes in `CLAUDE.md`.

---

## Light BVH Architecture (`LightBVHSampling.js`)

The Light BVH accelerates emissive triangle sampling by organizing emissive triangles into a power-weighted BVH, replacing uniform CDF sampling for scenes with many emissive objects.

### Stochastic Tree Traversal
`sampleLightBVHTriangle()` performs a single-path stochastic descent:
1. Start at root node.
2. At each internal node: compute selection probability per child from accumulated power and distance² to the shading point.
3. Sample one child proportional to its weight; track the traversal probability.
4. At leaf: sample a triangle proportional to its power.
5. Return `EmissiveSample` with position, normal, power, and composite PDF for MIS.

### Integration
Selected when `lightBVHNodeCount > 0`. The composite PDF accounts for tree-traversal probabilities and per-triangle sampling; MIS combines it with the BRDF lobe PDF (power heuristic). Falls back to the uniform-CDF emissive path otherwise.

### Builder
`LightBVHBuilder.js` (in `rayzee/src/Processor/`) constructs the BVH using SAH-like power splitting.

---

## Random Sampling Architecture (`Random.js`)

### Techniques
`samplingTechnique` selects the generator:
- `0` — PCG (general-purpose)
- `1` — Halton (Owen-scrambled)
- `2` — Sobol (Owen-scrambled direction vectors), the default

The STBN blue-noise atlases were removed in 9.2.0: only a stratified branch for more than one camera
ray per pixel read them, and no caller asks for more than one.

### Strategies
- The primary ray's jitter within the pixel is the sequence's own 2D sample (`getStratifiedSample`).
- Fast RNG (`RandomValueFast`) for non-critical jitter (e.g. DOF disk).

### Seeding
`getDecorrelatedSeed(pixelCoord, rayIndex, frame)` mixes primes + combined hashes (PCG + Wang) to avoid frame-to-frame correlation.

### Multi-Dimensional Interface
`getRandomSampleND` returns up to 4D sample vectors with technique-specific mapping.

---

## BVH Traversal (`BVHTraversal.js`)

Highlights:
- Iterative explicit stack (`MAX_STACK_DEPTH`); two-level dispatch (TLAS → BLAS).
- Inner nodes store both child AABBs + child indices (4 reads, no separate child fetches).
- Early pruning: compare child-bound min distance against the current closest hit.
- Per-mesh visibility: at a BLAS-pointer leaf the visibility flag (slot `[2]`, packed into the BVH node data) is checked before pushing the BLAS root onto the stack — an entire hidden mesh's BLAS is skipped. The flag is free-fetched with the leaf; there is no separate visibility buffer.
- Triangle intersection is inline (Möller–Trumbore); front/back/double-side culling is done inline using the per-triangle side flag (bits 24–25 of `flags`, row 5, in the shade buffer), for the camera's view only: `cullBackFaces` is on for a ray not yet `REDIRECTED` or flagged `UNDER_SURFACE` (it dipped under its own facet). Other bounces hit both sides, as shadow rays always have. `insideMedium` rays bypass culling to hit glass/SSS back faces.
- `traverseBVHShadow` is the any-hit early-exit variant for shadow rays.
- `generateRayFromCamera` builds the primary ray (used by Generate and Debug kernels).

Mesh visibility is maintained CPU-side by `PathTracerStage._patchTLASLeafVisibility()` (driven by `updateAllMeshVisibility()` / `setMeshVisibilityData()`), which writes the flag directly into the combined BVH storage buffer at the TLAS leaf and flags it `needsUpdate`. World-visibility is resolved by walking the parent chain (`_isWorldVisible`).

---

## Material Sampling & Evaluation

### BRDF Weights
`calculateBRDFWeights` computes per-lobe base weights from roughness, metalness, IOR, sheen color intensity, and cached derived factors (`MaterialCache`).

### Direction Sampling (`generateSampledDirection`, PathTracerCore.js)
Selects one lobe via a cumulative-probability chain (diffuse → specular → sheen → clearcoat → transmission), emitted as a single mutually-exclusive WGSL branch:
- Diffuse: cosine hemisphere; PDF `NoL/π`.
- Specular: GGX VNDF; PDF via `calculateVNDFPDF`.
- Sheen: GGX with below-surface rejection (falls back to diffuse).
- Clearcoat: GGX at clamped clearcoat roughness.
- Transmission: `sampleMicrofacetTransmission` (refraction, TIR fallback, dispersion).
Returns a `DirectionSample { direction, value, pdf }` with `pdf` clamped to `MIN_PDF`. Material classification (`mc`) and cached weights are resolved by the caller and passed in (a TSL `Fn` can't write back to caller variables).

### Evaluation (`evaluateMaterialResponse`)
Combines diffuse, microfacet specular (GGX D/G/F), transmission, sheen, clearcoat, and iridescence; PDFs stabilized with `MIN_PDF`.

### Where spawned rays start
Every ray leaving a surface starts at `offsetRayOrigin( p, n )` (`Common.js`, Cycles' ray_offset: 1e-5 along `n` within one unit of the origin, 32 float ULPs per axis beyond), with `n` the **facet** normal on the side the ray leaves — never the interpolated one, which on foliage cards points away from the card and left pass-through rays inside its plane. A shadow ray towards a sampled light point is re-aimed from that origin and stops `SHADOW_END` (1 − 1e-4) of the way. Light and environment shadow rays from a smooth-shaded triangle are first lifted towards the smooth surface near the terminator (`ShadowTerminator.js`, setting `shadowTerminatorOffset`, default 0.1 as in Blender). Horizon checks still use the interpolated normal.

### Transmission, medium & subsurface
`MaterialTransmission.js` handles refractive events, the medium stack, Beer–Lambert absorption, and dispersion. `Subsurface.js` implements random-walk SSS reusing the medium stack (`maxSubsurfaceSteps` caps the walk).

### Indirect lighting (`calculateIndirectLighting`, LightsIndirect.js)
Material-only multi-strategy MIS (specular, diffuse, transmission, clearcoat — environment excluded from indirect strategies). The combined PDF is carried as the next bounce's `prevBouncePdf` for NEE↔implicit-env MIS.

---

## Environment Importance Sampling (`Environment.js`)

### CDF-Based Sampling
2D sampling via inversion of marginal (row) and conditional (column) CDFs stored in the `envCDFTexture` R32F texture (`sampleEquirect`, `sampleEquirectProbability`).

### Direction Conversion
`equirectDirectionToUv` / `equirectUvToDirection` map between spherical and UV space applying `environmentMatrix` (HDRI rotation).

### Sampling & PDF
`sampleEnvironment` evaluates radiance for arbitrary directions; the importance-sampling probability is normalized by `envTotalSum` with the spherical Jacobian applied, clamped to prevent extremes. `getGroundProjectedDirection` bends the primary-ray background lookup onto a virtual ground plane when ground projection is enabled.

### The physical sky
The sky texture and its CDF texture are both written on the GPU (`Processor/PhysicalSky.js`; the table by `TSL/EnvironmentCDF.js`, the twin of `EquirectHDRInfo.computeCDF` in the same packed layout), so the samplers above read them exactly as they read an HDRI's. `envTotalSum` and `envCompensationDelta` arrive a few frames after each bake. The sun is not in the texture: environment NEE's loop runs a second pass for it (`sampleSunDisc`, 2D dimension +9).

---

## Accumulation & Temporal Blending (`FinalWriteKernel`)

- For each pixel, the current radiance is blended with the previous accumulated MRT:
  `final = mix( previous, current, accumulationAlpha )` (color, normal/depth, albedo, and alpha).
- The blend runs only when `enableAccumulation && !cameraIsMoving && frame > 0 && hasPreviousAccumulated`.
- `accumulationAlpha` is computed CPU-side (factoring frame count and interaction resets); accumulation is disabled during camera interaction (`cameraIsMoving`).

---

## TSL Authoring Patterns

### Compute kernel definition
```js
const computeFn = Fn( () => {
    const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
    // ... read SoA buffers, do work, write SoA buffers / StorageTextures
} );
// dispatched as: computeFn().compute( [ dispatchX, dispatchY, dispatchZ ], [ wgX, wgY, wgZ ] )
```

### Key Patterns

| Aspect | TSL (current) |
|---|---|
| Language | JS functions → WGSL |
| Structs | `struct()` from `patches.js` (Proxy-wrapped) |
| Uniforms | `uniform(1.0, 'float')` node objects |
| Loops | `Loop(count, ({ i }) => { ... })` |
| Branching | `If(x.greaterThan(0), () => { ... })` |
| If/Else chains | `If().ElseIf().Else()` — must chain, not separate `If()` blocks |
| Compute output | `textureStore(writeTex, coord, value).toWriteOnly()` + SoA buffer writes |
| Includes | ES module `import` |

> **Critical**: Use chained `If().ElseIf().Else()` for exclusive branches. Separate `If()` blocks generate independent WGSL `if` statements where inactive branches can contaminate results.

### Uniform Management
Uniforms are `uniform()` node objects owned by `UniformManager` and accessed via `stage.uniforms.get(name)` / dynamic getters (e.g. `this.maxBounces`). Uniforms are created once; only `.value` is mutated to preserve the compiled shader graph.

### StorageTexture writes
Kernels write MRT outputs to write-only StorageTextures (`textureStore(...).toWriteOnly()`); a separate copy step (`copyToReadTargets`) blits them into a readable RenderTarget for downstream stages (StorageTextures can't be sampled cross-dispatch).

---

## Debug Modes (`visMode`)

Modes 1–10 dispatch a single `DebugKernel` (one primary-ray hit per pixel, no bounce loop or accumulation) which delegates to `TraceDebugMode` (mode 9 computed inline). Mode 11 runs the normal pipeline; `FinalWriteKernel` flags NaN/Inf.

| Mode | Visualization |
|---|---|
| 1 | Surface normals |
| 2 | NDC depth |
| 3 | Albedo |
| 4 | Emissive |
| 5 | Indirect (one-bounce GI) |
| 6 | Environment reflection |
| 7 | Triangle-test count heat map |
| 8 | Box-test count heat map |
| 9 | Stratified jitter pattern (inline in DebugKernel) |
| 10 | Environment luminance heat map |
| 11 | NaN/Inf detector (red where the accumulated color is NaN/Inf) |

---

## Performance Optimization Strategies

| Area | Technique | Benefit |
|---|---|---|
| BVH Traversal | Inner-node child AABBs in-node (4 reads, no child fetches) | Reduced memory bandwidth |
| Mesh Visibility | Visibility flag free-fetched at BLAS-pointer leaf | Entire BLAS skipped for hidden meshes, no extra read |
| Wavefront | Stream compaction + dynamic per-bounce dispatch sizing | Dead rays dropped; dispatch tracks survivor curve |
| Wavefront | Per-bounce early exit from stale survivor counts | Skips empty tail bounces |
| Sorting | Optional material-index sort (per-WG / global radix) | Shading coherence on high material diversity |
| Light BVH | Power-weighted stochastic traversal | O(log N) emissive sampling vs O(N) CDF |
| RNG | Fast RNG for non-critical samples | Lower ALU cost |
| Material Sampling | Caller-resolved classification + cached BRDF weights | Avoid recomputation |
| Direction Sampling | Single mutually-exclusive lobe branch (cumulative CDF) | Less divergence |
| Accumulation | Disabled during camera movement | Prevents temporal instability |
| Resolution | Half resolution during camera movement (`interactionRenderScale`) | A quarter of the rays per frame; bounces kept, so no brightness pop when the camera stops |
| Data Access | Aligned vec4 SoA packing | Coalesced GPU memory reads |

---

## Error & Stability Guards

- Minimum PDF clamps (`MIN_PDF`) prevent division by zero / NaNs in MIS weight computation.
- Background pixel guard: miss rays avoid `normalize(vec3(0))` → NaN in `gNormalDepth`.
- Pole-region handling (`sinTheta` clamps, epsilon UV limits) avoids singularities in environment spherical mapping.
- Transmission fallback (TIR) uses a small PDF to maintain normalization consistency.
- Firefly suppression via `regularizePathContribution` (soft, path-length aware).

---

## Extension Points

1. **Add a new material lobe**: integrate into `calculateBRDFWeights`, the `generateSampledDirection` lobe chain (PathTracerCore.js), and `evaluateMaterialResponse`.
2. **Enhance environment sampling** (alias table / hierarchical importance map): replace the CDF inversion while keeping the `sampleEnvironment` / `sampleEquirect` interface.
3. **Add a wavefront kernel stage** (e.g. a dedicated shadow-connect kernel): build a new `Fn().compute()`, register it in `_buildWavefrontKernels`, dispatch it in `render()`'s loop.
4. **Per-triangle custom attributes**: expand the triangle layout (`EngineDefaults.js`) and the interpolation in `traverseBVH`.
5. **GPU-side adaptive heuristics**: add a guide texture sampled in `GenerateKernel` to cull or weight primary rays per pixel.

---

## Glossary

- **Wavefront**: ray-batch path tracing where each bounce is a separate compute kernel over surviving rays.
- **MIS**: Multiple Importance Sampling.
- **VNDF**: Visible Normal Distribution Function sampling for GGX.
- **CDF**: Cumulative Distribution Function used to invert distributions for sampling.
- **NEE**: Next Event Estimation (direct light sampling).
- **DOF**: Depth of Field.
- **Firefly**: bright outlier sample from a low PDF / high radiance.
- **SoA**: Structure of Arrays (the packed ray/hit buffer layout).
- **TLAS / BLAS**: top-/bottom-level acceleration structure.
- **SSS**: subsurface scattering (random walk).
- **TSL**: Three Shading Language — JS-based shaders compiled to WGSL.

---

## Diff-Friendly Summary For Refactors

| File | Critical Symbols | Purpose |
|---|---|---|
| `Stages/PathTracer.js` | `render()`, `_buildWavefrontKernels()`, `_setWfDispatch()` | Per-frame dispatch order, kernel build, resize |
| `Stages/PathTracerStage.js` | `setupMaterial()`, `updateAllMeshVisibility()`, `_patchTLASLeafVisibility()` | Shared infra, scene texture nodes, mesh visibility |
| `TSL/GenerateKernel.js` | `buildGenerateKernel()` | Primary ray generation |
| `TSL/ExtendKernel.js` | `buildExtendKernel()` | Closest-hit traversal |
| `TSL/ShadeKernel.js` | `buildShadeKernel()` | Direct/indirect lighting, transmission, bounce-0 MRT |
| `TSL/CompactKernel.js` | `buildCompactKernel()`, `buildCompactSubgroupKernel()` | Survivor stream compaction |
| `TSL/FinalWriteKernel.js` | `buildFinalWriteKernel()` | Sample averaging, accumulation, MRT writes |
| `TSL/PathTracerCore.js` | `generateSampledDirection()`, `handleRussianRoulette()`, `computeNDCDepth()` | Shared sampling helpers |
| `TSL/BVHTraversal.js` | `traverseBVH()`, `traverseBVHShadow()`, `generateRayFromCamera()` | Acceleration traversal, visibility, inline side culling |
| `TSL/Environment.js` | `sampleEnvironment()`, `sampleEquirect()` | HDR env sampling & PDF |
| `TSL/LightBVHSampling.js` | `sampleLightBVHTriangle()` | Light BVH stochastic descent |
| `TSL/Random.js` | `getDecorrelatedSeed()`, `getStratifiedSample()`, `getRandomSampleND()` | Sampling quality |
| `Processor/PackedRayBuffer.js` | `RAY`/`HIT`/`SHADOW`, read/write helpers | SoA buffer layout |
| `Processor/QueueManager.js` | `COUNTER`, `RAY_FLAG`, active/sorted queues | Ray queues + atomic counters |

Numerical constants to keep consistent:
- `MIN_PDF`, epsilon thresholds in environment & BVH.
- Prime numbers in RNG seeding (altering them affects noise stability).

---

End of document.
