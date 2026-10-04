# Path Tracer Shader Architecture

Rayzee Path Tracing Engine – Internal Shader Design (PathTracer Stage Only)

---

## Scope & Exclusions

This document covers the path tracing stage's shader system for the **WebGPU backend (TSL)**. The renderer is a **pure wavefront path tracer**: a sequence of compute kernels, with no fragment-shader megakernel.

TSL (Three Shading Language) is a JavaScript shader authoring system that three.js's WebGPU backend compiles to WGSL at runtime. Shader modules live in `rayzee/src/TSL/`, the stage in `rayzee/src/Stages/`.

Explicitly excluded (refer to separate docs):
- Denoisers (ASVGF, NRD, EdgeFilter, BilateralFilter; NRD in `NRD_DENOISER.md`)
- Post-processing (bloom, tone mapping, auto exposure)
- Pipeline orchestration, backend, and state management (see `PIPELINE_ARCHITECTURE.md`)
- The renderer core / add-on boundary (see `CORE_AND_ADDONS.md`)

---

## High-Level Overview

The path tracer integrates the rendering equation by Monte Carlo, with multiple importance sampling (MIS) between material lobes and the light sources: an importance-sampled environment map, the physical sky's analytic sun, emissive triangles (light BVH or uniform CDF) and the analytic lamps.

It is a **wavefront**: path state lives in SoA storage buffers and every bounce is a separate set of compute kernels. Paths come from a fixed path budget, and the image streams through it in row bands. Per frame:

```
[integrator light pass]                      bidirectional / vcm only (add-on)
for each row band:
  resetFrameCounters → buildActivePixels → seedEnter → generateList     usePixelFreeze (the default)
  | generate → initActiveIndices                                         otherwise
  per bounce: extend → [global material sort] → shade → compact → compactCopyback
  finalWrite
```

It outputs three Multiple Render Targets (MRT) through write-only StorageTextures:

- `gColor` (rgba): RGB accumulated radiance + A = output alpha (1.0 opaque; coverage with a transparent background).
- `gNormalDepth` (rgba): world-space normal (xyz, 0–1 packed) + NDC depth (a, `computeNDCDepth`).
- `gAlbedo` (rgba): denoiser albedo (RGB) + a hit distance in A, written only while a stage requests it.

Key features:
- Progressive accumulation with temporal blending (in `FinalWriteKernel`).
- Adaptive sampling: a whole-frame convergence stop and a per-pixel freeze that skips converged pixels.
- Selectable random sequence (PCG / Halton / Sobol, the default).
- Stack-based two-level BVH traversal (TLAS → BLAS), with per-mesh visibility read from the BVH leaf.
- Physically based materials with multi-lobe sampling (diffuse, specular, sheen, clear coat, transmission), iridescence, anisotropy and random-walk subsurface scattering.
- Environment importance sampling from an exact piecewise-constant table (an RGBA32F texture).
- The physical sky's sun as a light of its own: drawn exactly on a miss, sampled by NEE, the two MIS-weighted.
- Light BVH for stochastic emissive-triangle sampling.
- Three camera projections in one kernel (`TSL/CameraRay.js`, switched by the `cameraProjection` uniform): pinhole, orthographic (parallel rays from the camera's image plane) and 360° equirectangular.
- Depth of field (thin lens with a flat focal plane, sized either by the blur asked for or as a physical lens) and per-pixel jitter for anti-aliasing.
- Firefly suppression (`regularizePathContribution`).
- Global material counting sort before Shade for shading coherence.
- Opt-in bidirectional and vertex-merging integrators, an add-on (`rayzee/addons/bidirectional`).

---

## Module Map (`rayzee/src/TSL/`)

Kernels use `Fn()`, `.compute()`, `If()`, `Loop()`, `.toVar()`, `.assign()`, and proxy-enhanced structs. Some leaf helpers use `wgslFn()`.

### Wavefront kernels (one compute node each)

| TSL Module | Key Exports | Role |
|---|---|---|
| `GenerateKernel.js` | `buildGenerateKernel()`, `GENERATE_WG_SIZE` | Primary rays (camera ray, DOF, jitter), the path's RNG seed, the default G-buffer slot. One builder, two kernels: `generate` (2D over the band) and `generateList` (1D over the active-pixel list) |
| `ExtendKernel.js` | `buildExtendKernel()`, `EXTEND_WG_SIZE` | Closest-hit `traverseBVH` per active ray → packed hit record, including the hit's facet normal and shadow-terminator lift (`HitFacet.js`) |
| `ShadeKernel.js` | `buildShadeKernel()`, `SHADE_WG_SIZE` | Misses and surface hits: emission, NEE (lamps, environment, sun, emissive triangles), transparency / transmission / medium stack / subsurface, the next bounce, aux G-buffer commits. Thread 0 zeroes `ACTIVE_RAY_COUNT` and `ACTIVE_ENERGY` for Compact |
| `CompactKernel.js` | `buildCompactKernel()`, `buildCompactSubgroupKernel()`, `COMPACT_WG_SIZE` | Stream-compacts surviving rays into the next index list and sums their throughput (`ACTIVE_ENERGY`). The subgroup variant is off (`_useSubgroupCompact`) |
| `SortGlobalKernels.js` | `buildResetGlobalHistKernel()`, `buildGlobalHistKernel()`, `buildGlobalPrefixKernel()`, `buildGlobalScatterKernel()`, `SORT_GLOBAL_WG_SIZE`, `SORT_GLOBAL_MAX_BINS` | Global material counting sort (reset → histogram → prefix sum → scatter) into material-pure workgroups; bins = material count, at most 256 |
| `FinalWriteKernel.js` | `buildFinalWriteKernel()`, `FINALWRITE_WG_SIZE` | Per pixel: temporal blend, MRT stores, the convergence statistics (m2, freeze streak); visMode 11 flags NaN/Inf red |
| `DebugKernel.js` | `buildDebugKernel()`, `DEBUG_WG_SIZE` | Single-pass primary-ray debug views for visMode 1–10 (delegates to `TraceDebugMode`); mode 9 computed inline |

`Stages/PathTracer.js` builds a few small kernels inline: `snapshotBounceCount`, `initActiveIndices`, `resetFrameCounters`, `buildActivePixels`, `countConvergedDilated`, `seedEnter`, `enterFull` and `compactCopyback`.

### Bidirectional add-on kernels

Built and dispatched by `integrators/BidirectionalIntegrator.js`, never by `PathTracer` itself (see [Bidirectional integrator](#bidirectional-integrator)).

| TSL Module | Key Exports | Role |
|---|---|---|
| `LightGenerateKernel.js` | `buildLightGenerateKernel()` | Starts one light subpath per pool slot on a source picked from the source table: an emissive triangle, a lamp, the sun or the environment |
| `ConnectKernel.js` | `buildConnectKernel()` | Connects each camera vertex Shade left pending to one cached light vertex |
| `LightSplatKernel.js` | `buildLightSplatKernel()`, `buildSplatResolveKernel()` | Light tracing: every cached light vertex to the pinhole, into a fixed-point splat image; the resolve adds it in before FinalWrite |
| `MergeKernel.js` | `buildMergeClearKernel()`, `buildMergeInsertKernel()`, `buildMergeKernel()` | Vertex merging (`'vcm'` only): files the light vertices in a hash grid, then each pending camera vertex gathers those within its radius |
| `LightGuide.js` | `buildGuideKernel()`, `buildGuideClearKernel()`, `guidedDiscPdf()`, `recordEscape()` | Learns where light from infinity enters the scene from camera-path escapes; lights at infinity start their light paths from it |
| `Bidirectional.js`, `BidirectionalLamps.js` | MIS recursion, source table, lamp pick | Shared by the kernels above; Shade and Generate receive them through the integrator's `uniforms.lib` |

### Shared sampling / shading helpers (imported by the kernels)

| TSL Module | Key Exports | Role |
|---|---|---|
| `PathTracerCore.js` | `generateSampledDirection()`, `regularizePathContribution()`, `computeNDCDepth()`, `handleRussianRoulette()`, `DELTA_PDF` | BSDF direction sampling (one lobe from a cumulative chain), firefly suppression, NDC depth, adaptive Russian roulette |
| `BVHTraversal.js` | `traverseBVH()`, `traverseBVHShadow()`, `traverseBVHShadowCameraCulled()`, `traverseBVHDebug()`, `triangleSide()`, `sideAccepts()` | Two-level BVH closest-hit and any-hit traversal, inline triangle intersection and side culling |
| `CameraRay.js` | `generateRayFromCamera()`, `cameraRayOrigin()`, `cameraRayDirection()` | Primary rays for the three projections, thin lens |
| `MaterialSampling.js` | `ImportanceSampleGGX()`, `ImportanceSampleCosine()`, `cosineWeightedSample()`, `sampleGGXVNDF()`, `sampleGGXVNDFAniso()` | Direction-sampling primitives (GGX, VNDF, cosine) |
| `MaterialEvaluation.js` | `evaluateMaterialResponse()`, `evaluateMaterialResponseFromDots()`, `evaluateSpecularDeltaFromDots()` | Combined multi-lobe BSDF evaluation; the delta lobe's reflectance |
| `MaterialProperties.js` | `calculateBRDFWeights()`, `calculateBSDFSamplingPDF()`, `calculateVNDFPDF()`, `evalIridescence()`, `DistributionGGX()`, `baseFresnelParams()` | Lobe weights, the lobe mixture's density, GGX terms, iridescence |
| `MaterialTransmission.js` | `sampleMicrofacetTransmission()`, `handleMaterialTransparency()`, `handleTransmission()`, medium structs | Refraction, dispersion, Beer–Lambert absorption, medium stack |
| `Subsurface.js` | `handleSubsurfaceEntry()`, `sampleChromaticCollision()`, `sampleHenyeyGreenstein()` | Random-walk subsurface scattering (reuses the medium stack) |
| `Clearcoat.js` | `sampleClearcoat()`, `ClearcoatResult` | Clear coat layer |
| `Environment.js` | `sampleEnvironment()`, `sampleEnvironmentExact()`, `environmentPdfExact()`, `equirectDirectionToUv()`, `equirectUvToDirection()`, `getGroundProjectedDirection()`, `groundProjectedEnvDir()` | Environment lookup, importance sampling and its density, direction↔UV, ground projection |
| `Sun.js` | `sunRadianceToward()`, `sampleSunDisc()` | The physical sky's sun disc: limb darkening, cut by the sky's horizon, uniform sampling of the cone |
| `EmissiveSampling.js` | `sampleEmissiveTriangle()`, `calculateEmissiveTriangleContribution()`, `calculateEmissiveLightPdf()`, `sampleSphericalTriangle()` | NEE from emissive triangles (uniform CDF path) |
| `LightBVHSampling.js` | `sampleLightBVHTriangle()`, `calculateLightBVHPdf()` | Stochastic light BVH descent, and the same density for a BSDF hit |
| `LightsCore.js` | Light structs and getters, `sampleSpotGoboMask()`, `sampleDirectionalGoboMask()`, `sampleIESProfile()`, `sampleSphQuad()` | Lamp definitions, gobo and IES lookups, spherical-rectangle sampling |
| `LightsDirect.js` | `traceShadowRay()`, `traceShadowRayRefractiveOpaque()`, `calculateRayOffset()`, importance estimators | Shadow rays (alpha-cutout shadows included), per-lamp importance |
| `LightsIndirect.js` | `calculateIndirectLighting()` | Turns the sampled direction into the bounce: throughput and the pdf carried to the next vertex's MIS |
| `LightsSampling.js` | `calculateDirectLightingUnified()`, `calculateMaterialPDF()`, `sampleLightWithImportance()` | Lamp NEE (one lamp by weighted reservoir over the four lists) MIS'd with BSDF hits, then environment and sun NEE |
| `Fresnel.js` | `fresnelDielectric()`, `dielectricFresnelWeight()`, `fresnelSchlick()`, `iorToFresnel0()`, `dielectricF0()` | Exact unpolarised Fresnel at every dielectric interface (base layer, clear coat, glass, SSS boundary, glass shadows), as Cycles uses; Schlick for metals and iridescence; IOR↔F0 |
| `HitFacet.js` | `hitFacet()`, `packHitFacet()`, `unpackHitFacet()`, `windingNormal()` | The hit triangle's facet normal (and the terminator lift), computed in Extend and packed into the hit record's spare lane |
| `ShadowTerminator.js` | `shadowTerminatorLift()`, `shadowTerminatorOrigin()` | Cycles' Shadow Terminator → Geometry Offset: the smooth-surface lift for light and environment shadow rays |
| `Random.js` | `getDecorrelatedSeed()`, `getStratifiedSample()`, `getRandomSampleND()`, `getRandomSample1D()`, `getRandomSample2D()`, `pcgHash()` | PCG, Halton, Sobol |
| `TextureSampling.js` | `sampleAllMaterialTextures()`, `computeUVCache()`, `sampleDisplacementMap()`, `sampleBucket()`, `buildBucketTextureNodes()` | UV transforms; material maps from the sRGB and linear bucket arrays |
| `SceneResources.js` | `withSceneResources()`, `sceneResources()` | A renderer's scene textures and switches, carried in each kernel's build context |
| `Displacement.js` | `refineDisplacedIntersection()`, `DisplacementResult` | Ray-marched displacement refinement |
| `Debugger.js` | `TraceDebugMode()` | Debug visualization modes (reused by `DebugKernel`) |
| `Struct.js` | `Ray`, `HitInfo`, `RayTracingMaterial`, `DirectionSample`, `MaterialCache`, etc. | GPU-side struct definitions |
| `Common.js` | `getDatafromStorageBuffer()`, `getMaterial()`, `triangleRow()`, `offsetRayOrigin()`, `SHADOW_END`, constants | Shared constants, storage-buffer accessors, ray spawn offset |
| `patches.js` | `struct()`, `gpuOnlyStorageAttribute()` | Proxy-wrapped structs; storage attributes with no CPU array |

### Scene textures and per-kernel resources

`Processor/ShaderBuilder.js` builds the texture nodes the stage shares: the environment texture, the previous-frame MRT nodes (`prevColorTexNode`, `prevAlbedoTexNode`, `prevNormalDepthTexNode`) and the gobo and IES array nodes (1×1 placeholders until a library loads). `updateSceneTextures()`, `updateGoboMaps()` and `updateIESProfiles()` swap their `.value` in place. It builds no compute node and sets no shader state.

Material texture buckets, the albedo maps alpha-cutout shadow rays read, the gobo and IES textures and the alpha-shadow switch ride in each kernel's build context (`SceneResources.js`). A TSL function's body runs when its kernel compiles, often at the first dispatch, so module-level state was read from whichever renderer set it last. `_buildWavefrontKernels()` assembles `{ srgbBuckets, linearBuckets, shadowAlbedoMaps, goboMaps, iesProfiles, alphaShadows }` and roots each kernel that reads them with `withSceneResources( kernelCall, resources )` (its local `own()`): `shade` and `debug`, and the integrator's `lightGenerate`, `connect`, `merge` and `lightSplat`. Function bodies read them with `sceneResources( builder )` (`TextureSampling.js`, `Displacement.js`, `LightsCore.js`, `LightsDirect.js`, `BVHTraversal.js`); a kernel built without the context throws. The `NormalDepth` stage does the same for its own kernel.

---

## Stage Classes (`rayzee/src/Stages/`)

- **`PathTracerStage.js`** (`class PathTracerStage`): shared base — engine/scene infrastructure. Owns the 5 sub-managers (`UniformManager`, `MaterialDataManager`, `EnvironmentManager`, `ShaderBuilder`, `StorageTexturePool`), uniforms, camera and lights, BVH and scene buffers, accumulation and completion state, ASVGF coordination, lifecycle, mesh visibility, and `setupMaterial()` (builds the shared scene texture nodes through `ShaderBuilder.createSceneTextureNodes`).
- **`PathTracer.js`** (`class PathTracer extends PathTracerStage`): the wavefront renderer. Owns the path pool (`PackedRayBuffer`, `QueueManager`, `KernelManager`), sizes the path budget, builds every core kernel in `_buildWavefrontKernels()` and drives the frame in `render()`. It also holds the integrator hooks (`registerIntegrator()`, `setIntegrator()`, `integrator`, `activeIntegrator`) and `requestOutput()`, through which a later stage asks Shade for an extra output.

### Wavefront resources (`rayzee/src/Processor/`)
- **`PackedRayBuffer.js`**: the SoA ray and hit buffers (`RAY`, `HIT` slot tables, `RAY_STRIDE`, `HIT_STRIDE`, `HIT_STRIDE_BIDIRECTIONAL`) with their read/write helpers, and the G-buffer helpers (`writeGBuffer`, `gbDecodeNormalDepth`, …). The G-buffer attribute itself is allocated by `PathTracer`.
- **`QueueManager.js`**: active-index lists A/B, the sorted-index list, the sort histogram, the atomic counters (`COUNTER`; the light guide's counts follow `COUNTER.GUIDE`), the per-bounce snapshot buffer, and `RAY_FLAG`.
- **`KernelManager.js`**: registers and dispatches the compute nodes (`register()`, `dispatch()`, `has()`, `get()`). `setDispatchForCount()` and `setDispatchForGrid()` size a grid from the workgroup size the node was registered with; a 1D grid past `maxComputeWorkgroupsPerDimension` spills into a second dimension.
- **`StorageTexturePool.js`**: 3 write-only MRT StorageTextures (allocated at `MAX_STORAGE_TEXTURE_SIZE`, never resized) + 1 readable MRT RenderTarget; `getWriteTextures()`, `getReadTextures()`, `copyToReadTargets()`, `ensureSize()`.

---

## Render Targets & Output Semantics

MRT layout (written by `FinalWriteKernel` / `DebugKernel` into `StorageTexturePool`'s write textures, then copied to the readable RenderTarget and published as `pathtracer:color`, `pathtracer:normalDepth`, `pathtracer:albedo`):

```
textures[0] = gColor       // RGB accumulated radiance + A = output alpha
textures[1] = gNormalDepth // World-space normal (xyz, 0..1) + NDC depth (a)
textures[2] = gAlbedo      // Albedo (RGB) + hit distance (a) — denoiser input
```

`gColor.a` is `1.0` for opaque output; with `transparentBackground` it carries the path's coverage alpha (also blended through accumulation).

`gNormalDepth` and `gAlbedo` are the aux outputs. They are written, and copied to the read target, only while a denoiser has them on (`setAuxGBufferEnabled()`, a live uniform, so toggling needs no rebuild). They accumulate on their own epoch (`auxAccumulationAlpha`, `hasPreviousAux`).

The aux data is staged in a **G-buffer** of one half-packed `uvec4` per path slot (`GBUFFER_STRIDE = 1`), separate from the ray buffer, written and read within the same band. Generate seeds each slot with normal +Z, depth 1 and black albedo. Shade writes the primary hit's NDC depth at bounce 0; normal and albedo are committed at the first surface diffuse enough to guide a denoiser, deferring through smooth mirrors and glass, and the path is then flagged `RAY_FLAG.AUX_LOCKED`. FinalWrite decodes the slot (`gbDecodeNormalDepth`, `gbDecodeAlbedo`, `gbDecodeHitDist`).

`gAlbedo.a` holds a hit distance only while a stage has asked for it: NRD calls `pathTracer.requestOutput( 'hitDistance', { encode } )`, and Shade then writes `encode( distance, viewZ )` at camera depth 1 — the first bounce's segment plus any alpha-skip run. The request is compiled into Shade (the kernels rebuild before the next frame); Shade holds no NRD code. Otherwise the lane is 0.

---

## Uniform Groups (JS → GPU Data Flow)

Uniforms are owned by `UniformManager` (`rayzee/src/managers/`) and exposed on the stage through getters; `PathTracer` wires them into the kernel builders. Principal categories:

1. **Camera & DOF:** `cameraWorldMatrix`, `cameraProjectionMatrixInverse`, `cameraViewMatrix`, `cameraProjectionMatrix`; `cameraProjection` (`CAMERA_PROJECTION_IDS`), `panoLonRange`, `panoLatRange`, `panoLevelHorizon`; `enableDOF`, `dofMode`, `dofBlur`, `focusDistance`, `focalLength`, `aperture`, `apertureScale`, `anamorphicRatio`, `unitsPerMetre`.
2. **Frame & control:** `frame` (accumulation index), `seedFrame` (the RNG's frame axis), `resolution`, `maxBounces`, `maxSamples`, `transmissiveBounces`, `maxSubsurfaceSteps`, `maxTransparentBounces`, `renderMode`.
3. **Accumulation:** `enableAccumulation`, `accumulationAlpha`, `cameraIsMoving`, `hasPreviousAccumulated`, and for the aux outputs `auxAccumulationAlpha`, `hasPreviousAux` (+ prev-frame MRT texture nodes).
4. **Adaptive sampling:** `useAdaptiveSampling`, `noiseThreshold`, `adaptiveMinSamples`, `adaptiveStopFraction`; per-pixel freeze `usePixelFreeze`, `pixelFreezeThreshold`, `pixelFreezeStability`; `convergenceOverlay`.
5. **Sampling:** `samplingTechnique` (0 = PCG, 1 = Halton, 2 = Sobol, the default) — `samplingTechniqueUniform`, a module-level node in `Random.js` that `UniformManager` registers.
6. **Environment & background:** `enableEnvironment`, `environmentIntensity`, `environmentMatrix`, `envTotalSum` (> 0 while a sampling table is bound), `envResolution`; the physical sky's sun (`hasSun`, `sunDirection`, `sunRadiance`, `sunParams` = cos half-angle, solid angle, 1/sin², horizon dip); `backgroundIntensity`, `backgroundColor`, `backgroundBlurriness`, `backgroundBlurSamples`, `showBackground`, `transparentBackground`; ground projection (`groundProjectionEnabled`, `groundProjectionRadius`, `groundProjectionHeight`, `groundProjectionLevel`); shadow catcher (`enableGroundCatcher`, `groundCatcherHeight`).
7. **Lighting:** `numDirectionalLights`, `numPointLights`, `numSpotLights`, `numAreaLights` and the four light lists, `uniformArray`s of `LIGHT_FLOATS` per light, written in place (`PathTracerStage._writeLightList`): the shader bakes a list's length, and a list that outgrows its capacity rebuilds the kernels. `globalIlluminationIntensity`, `fireflyThreshold`, `shadowTerminatorOffset`, `enableAlphaShadows`.
8. **Emissive / Light BVH:** `enableEmissiveTriangleSampling`, `emissiveTriangleCount`, `emissiveVec4Offset`, `emissiveTotalPower`, `emissiveBoost`, `lightBVHNodeCount`, `reverseMapVec4Offset`.
9. **Debug:** `visMode`, `debugVisScale`.

The scene buffers are storage nodes on the stage, not uniforms: `triangleStorageNode` (a `{ geo, shade }` pair, see below), `bvhStorageNode`, `materialData.materialStorageNode`, `lightStorageNode`. The environment's sampling table is a texture (`environment.envCDFTexture`).

Material maps are two lists of `MATERIAL_BUCKET_COUNT` (4) texture-array nodes, `srgbBuckets` and `linearBuckets`, built per kernel build by `buildBucketTextureNodes()` and repointed each frame by `_refreshWfTextureNodes()`. A map's packed index is `bucket * BUCKET_LAYER_STRIDE + layer` (stride 256); `sampleBucket()` picks the bucket with one `If`/`ElseIf` arm per bucket. The sRGB pool holds albedo, emissive, sheen colour and specular colour; the linear pool everything else (normal, bump, roughness, metalness, displacement, anisotropy, transmission, clear coat, clear coat roughness, sheen roughness, iridescence, iridescence thickness, specular intensity).

Wavefront uniforms live on `PathTracer`: `_wfRenderWidth`, `_wfRenderHeight`, `_wfMaxRayCount` (the current band's pixel count), `_wfCurrentBounce`, `_wfChunkRowBase`, `_wfChunkRows`, `_wfIsFirstChunk`; plus `_auxGBufferUniform`, `_cleanAuxNormalUniform` and `_dilateFrozenUniform`.

---

## Data Layouts (GPU storage buffers)

### Triangle data (`triangleStorageNode`)
Compact, vec4-aligned 5-slot layout (20 u32 lanes = 80 B per triangle, `TRIANGLE_DATA_LAYOUT` in `EngineDefaults.js`).
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
33 vec4 slots (132 floats) per material, laid out by `MATERIAL_DATA_LAYOUT` (`EngineDefaults.js`) and written only by `packMaterial()` (`Processor/MaterialPacking.js`): the shadow-path fields first (IOR, transmission, thickness, attenuation, opacity, side, alpha), then base colour / metalness / emissive / roughness, map indices, clear coat, dispersion, sheen, specular, iridescence, bump and displacement, the per-map UV transforms, subsurface, anisotropy and the extension-map indices.

### Emissive triangles / Light BVH (`lightStorageNode`)
One packed buffer `[ light BVH nodes | emissive entries | bit-trail map ]` (`PathTracerStage._rebuildLightBuffer`). `emissiveVec4Offset` is where the emissive entries start, `reverseMapVec4Offset` where the per-triangle bit trails start.

### Environment sampling table (`envCDFTexture`, RGBA32F)
The exact table (`Processor/EnvironmentExactTable.js`): `buildExactEnvironmentTable()` builds it (in `CDFWorker` for HDRIs and colour skies) and `packExactTable()` lays it out as a `(w + 1) × h` RGBA float texture. Texel `(x, y)` holds row `y`'s entry `x` — its running sum, the sum below it, and the guides of steps `2x` and `2x + 1`; texel `(w, y)` holds the rows' entry `y` likewise. The table is at most `EXACT_TABLE_MAX_WIDTH` (1024) cells wide; a larger map gives each cell k × k texels. Read with integer `.load()`. It is a texture because Shade has no storage-buffer binding to spare.

### Packed ray buffers (`PackedRayBuffer.js`)
SoA within a buffer: field `slot` of path `id` lives at `id + slot * capacity`.
- **RAY** (`vec4`, `RAY_STRIDE = 7`): `ORIGIN_META`, `DIR_FLAGS`, `THROUGHPUT_PDF`, `RADIANCE_ALPHA`, `MEDIUM_STACK`, `MEDIUM_SIGMA_A`, `SSS_SIGMA_S`.
- **HIT** (`uvec4`, `HIT_STRIDE = 3`): `DIST_TRI_BARY` (distance, triangle, texture UV — not barycentrics; Extend moves the distance onto the triangle's plane), `NORMAL_MAT` (the **interpolated** normal as oct16, material, instance leaf + 1, and in `.w` the facet normal as an 11:11 octahedral pair plus the terminator lift's top 10 half-float bits — `HitFacet.js`), `RNG` (the path's RNG state; the bidirectional integrator keeps its MIS partial sums in `.y` / `.z`). There is no separate RNG buffer: Shade is at the device's 10 storage buffers.
- Under the bidirectional integrator the hit stride is `HIT_STRIDE_BIDIRECTIONAL` (7: four `VERTEX` slots for a camera vertex's pending connection), and the light vertex cache follows the path regions in the same buffer.

**Path budget.** The pool holds a fixed number of paths B, independent of resolution, computed once in `_computePathBudget()`: the RAY buffer (and HIT with any light vertex cache) must fit 0.9 × `maxStorageBufferBindingSize`, the pool at most a quarter of `deviceMemoryGB()` (`navigator.deviceMemory`, or the host's `hostMemoryGB`), clamped to [512², 2048²] paths. `_updateChunkLayout()` cuts the image into bands of `floor( B / width )` rows. A resolution change updates the render-size uniforms and the band layout only — no reallocation, no kernel rebuild. The per-pixel buffers that persist across bands and frames (`m2`, freeze streak, frozen mask) are sized to `MAX_STORAGE_TEXTURE_SIZE²` pixels.

---

## Per-Frame Execution Flow (`PathTracer.render()`)

1. Bail if `!isReady || !_wavefrontReady`. Rebuild the kernels first if the packed light buffer or a light list was reallocated, or an output request changed. Apply a lockstep readback that is due.
2. Stop if the frame is complete: `isComplete`, `frameCount >= completionThreshold`, or the convergence stop (`_isConvergedComplete()`). A pending aux seed frame (denoiser switched on after completion) still runs.
3. `_handleResize()`; camera and accumulation uniforms; `_setWfDispatch()` (sizes `debug` and `countConvergedDilated` to the frame); repoint the prev-frame MRT and scene texture nodes (`_refreshWfTextureNodes()`).
4. **Debug shortcut:** if `visMode` is 1–10, dispatch `debug` over the whole frame, copy to the read targets, publish, and return. (Mode 11 runs the normal pipeline; FinalWrite flags NaN/Inf.)
5. `integrator?.beginFrame( loopBound )` — the bidirectional add-on's light pass; plain path tracing has no integrator.
6. **Band loop** — for each band of ≤ `_chunkRows` rows, `_setChunk()` sets the band uniforms and the per-band grids, then:
   - Seed the active list. With `usePixelFreeze` (on by default): `resetFrameCounters` → `buildActivePixels` (scatters the pixels not frozen, writes the frozen mask) → `seedEnter` → `generateList`. Otherwise, or on an aux seed frame: `generate` → `initActiveIndices` (identity list).
   - Band 0 only, with adaptive sampling on and a readback due this frame: `countConvergedDilated` (the 3×3-eroded converged count).
   - **Bounce loop**, `bounce` from 0 to `loopBound` = `maxBounces + transmissiveBounces + maxSubsurfaceSteps + 1` (a camera path takes one segment past its last bounce, flagged `RAY_FLAG.EMISSION_ONLY`):
     - Size the bounce kernels (`BOUNCE_KERNELS`). Dynamic dispatch (the default): `min( band pixels, 1.5 × last frame's survivors at this bounce + 1024 )` from the survivor curve, trusted only in a single band and after a readback at the settled view; bounce 0 under pixel freeze from the last active-pixel count; full otherwise. Kernels bound on `ENTERING_COUNT`, so an oversized grid is safe. Without dynamic dispatch, `enterFull` and full grids.
     - `extend`.
     - With the material sort (`wavefrontSortMaterials`, on by default, only above 8 materials): `resetGlobalHist` → `globalHist` → `globalPrefix` → `globalScatter`. Shade then reads the sorted list; Compact still reads the unsorted one.
     - `integrator?.beforeShade()` → `shade` (thread 0 zeroes `ACTIVE_RAY_COUNT` / `ACTIVE_ENERGY`) → `integrator?.afterShade()`.
     - `compact` → `compactCopyback` (thread 0 records the survivor count and energy, seeds `ENTERING_COUNT`); without dynamic dispatch, `snapshotBounceCount`.
     - Early exit when last frame's survivors at this bounce carried less than `_bounceEarlyExitThreshold` (1e-4) of a full band's throughput. Energy, not ray count: past Russian roulette a few survivors carry the weight of many. Single band only.
   - `integrator?.resolve()` → `finalWrite`.
7. `_maybeReadbackCounters()`: every 4 frames, at a settled view, read back the survivor curve and the convergence counters asynchronously (lockstep mode reads and applies on a fixed cadence instead).
8. `copyToReadTargets()` (aux attachments only while aux is on); publish to context; emit events; `frameCount++` unless in interaction mode.

There is no swap of the active-index lists: kernels are bound to list A at build time, Compact writes B, and `compactCopyback` copies the survivors B→A for the next bounce.

A multi-band frame (the image larger than the budget) runs full dispatch every bounce and no early exit: the survivor curve is one per-frame buffer.

### Shade kernel (per-ray work)
- Miss: the environment or backdrop (background blur and colour, ground projection, transparent background), MIS-weighted against environment NEE (`environmentPdfExact`), then the sun disc, power-heuristic weighted against sun NEE when the sending vertex could have drawn that direction (`RAY_FLAG.SUN_NEE`). A primary ray can also hit the analytic shadow-catcher plane (`enableGroundCatcher`).
- Hit: an `EMISSION_ONLY` segment ends at once on an opaque surface that does not glow. Otherwise: material textures (`sampleAllMaterialTextures`), aux G-buffer commits, emission (MIS-weighted against emissive NEE), transparency / transmission / medium stack / subsurface (`handleMaterialTransparency`), direct lighting (`calculateDirectLightingUnified`: lamp, environment and sun NEE), emissive-triangle NEE when `enableEmissiveTriangleSampling` is on (light BVH when `lightBVHNodeCount > 0`, else `calculateEmissiveTriangleContribution`), then the bounce (`generateSampledDirection` → `calculateIndirectLighting`), Russian roulette (`handleRussianRoulette`), and the continued ray.

### Bidirectional integrator
Opt-in (`settings.set( 'integrator', 'bidirectional' | 'vcm' )`) and an add-on: `rayzee/addons/bidirectional` exports `BidirectionalIntegrator` (`integrators/BidirectionalIntegrator.js`), installed with `pathTracer.registerIntegrator( [ 'bidirectional', 'vcm' ], pt => new BidirectionalIntegrator( pt ) )` (`PathTracerApp` does this). `setIntegrator()` picks it and rebuilds the kernels; an unregistered name records `capability.missing`. `'path'` builds exactly the unidirectional kernels.

`PathTracer` calls the integrator at fixed points: at build `beforeKernelBuild()`, `hitStride`, `cacheBytes()` and `lightVertices` (path budget and hit buffer), `allocate()`, `registerKernels()`; per frame `beginFrame()`, `beforeShade()`, `afterShade()`, `resolve()`; at readback `curveKey` and `applyLightCurve()`. The integrator owns its uniforms, buffers and kernels. Generate and Shade receive its `uniforms` as `bidirectional` and take the bidirectional shading functions from `uniforms.lib` (`Bidirectional.js`, `BidirectionalLamps.js`, `guidedDiscPdf`, `recordEscape`), so the core imports none of them. Its controls are on `pathTracer.activeIntegrator`.

Frame: `beginFrame()` updates the source table and the light guide (`guideClear`, `guideBuild`), then traces the light subpaths through the same pool — `lightGenerate`, the bounce loop (`extend` / sort / `shade` / `compact` / `lightCopyback`, sized off the light pass's own survivor curve), `lightSplat`, and for `'vcm'` `mergeClear` → `mergeInsert`. Each camera bounce then adds `connect` (and `merge`) after `shade`, and each band `splatResolve` before `finalWrite`.

A light ray in Shade skips everything camera-only, stores its vertices in the light vertex cache (the hit buffer's tail) and scatters with the adjoint BSDF. Camera vertices leave a pending record that ConnectKernel resolves after Shade. In this mode Shade samples every light itself rather than through `calculateDirectLightingUnified`, and the bidirectional strategies' shadow rays treat glass as opaque (`traceShadowRayRefractiveOpaque`). Full notes in `CLAUDE.md`.

---

## Light BVH Architecture (`LightBVHSampling.js`)

The light BVH organizes emissive triangles into a power-weighted tree so NEE picks an emitter by its likely contribution rather than from a flat CDF.

### Stochastic Tree Traversal
`sampleLightBVHTriangle()` performs a single-path stochastic descent:
1. Start at the root.
2. At each inner node, weigh each child by its power, its distance² to the shading point and its emission orientation cone (`lbvhNodeImportance`).
3. Pick one child in proportion; track the selection probability.
4. At a leaf, pick a triangle in proportion to its power.
5. Sample a point on it — spherical-triangle sampling when the triangle is near or large (`useSphericalSampling`), area sampling otherwise — and return an `EmissiveSample` with its solid-angle pdf.

### Integration
Shade uses it while `lightBVHNodeCount > 0` and falls back to the uniform-CDF path otherwise. When a BSDF ray hits an emitter, `calculateLightBVHPdf()` re-walks the same descent along the triangle's stored bit trail, so the MIS weight uses the density NEE sampled with.

### Builder
`LightBVHBuilder.js` (in `rayzee/src/Processor/`, run by `EmissiveTriangleBuilder`): median split on the longest centroid axis, at most 8 triangles a leaf, an orientation cone per node, and a root-to-leaf bit trail per triangle. A scene with no emitters gets one dummy leaf.

---

## Random Sampling Architecture (`Random.js`)

### Techniques
`samplingTechnique` selects the generator:
- `0` — PCG (general-purpose)
- `1` — Halton (per-digit additive scrambling)
- `2` — Sobol (Owen-scrambled), the default

The STBN blue-noise atlases were removed in 9.2.0; no live code path read them.

### Strategies
- The primary ray's jitter within the pixel is the sequence's own 2D sample (`getStratifiedSample`, sample index 1, so it is independent of the first scatter).
- `getRandomSample1D` / `getRandomSample2D` draw on an explicit dimension: each bounce owns `SAMPLER_DIMS_PER_BOUNCE` (32) dimensions, and per-pixel variable-count draws use the range from `SAMPLER_DIM_AUX_BASE`.
- Fast RNG (`RandomValueFast`) for non-critical samples (the DOF lens disk, `RandomPointInCircle`).

### Seeding
`getDecorrelatedSeed(pixelCoord, rayIndex, frame)` mixes primes + combined hashes (PCG + Wang) to avoid frame-to-frame correlation. Kernels pass `seedFrame` as its frame, not the accumulation index.

### Multi-Dimensional Interface
`getRandomSampleND` returns up to 4D sample vectors with technique-specific mapping.

---

## BVH Traversal (`BVHTraversal.js`)

Highlights:
- Iterative explicit stack (`MAX_STACK_DEPTH`, 32); two-level dispatch (TLAS → BLAS).
- Inner nodes store both child AABBs + child indices (4 reads, no separate child fetches).
- Early pruning: compare child-bound min distance against the current closest hit; the far child is pushed first.
- Per-mesh visibility: at a BLAS-pointer leaf the visibility flag (slot `[2]`) is checked before pushing the BLAS root — an entire hidden mesh's BLAS is skipped. There is no separate visibility buffer.
- Triangle intersection is inline; front/back/double-side culling uses the per-triangle side flag (bits 24–25 of `flags`, row 5, in the shade buffer), for the camera's view only: Extend culls a ray not yet `REDIRECTED` or flagged `UNDER_SURFACE` (it dipped under its own facet). Other bounces hit both sides, as shadow rays always have. Rays inside a medium bypass culling to hit glass/SSS back faces.
- `traverseBVHShadow` is the any-hit early-exit variant for shadow rays; `traverseBVHShadowCameraCulled` applies the camera's culling (bidirectional light tracing); `traverseBVHDebug` counts box and triangle tests for the debug views.

Mesh visibility is maintained CPU-side by `PathTracerStage._patchTLASLeafVisibility()` (driven by `updateAllMeshVisibility()`, `setMeshVisibilityData()` and `updateMeshVisibility()`), which writes the flag into the combined BVH buffer at the TLAS leaf; `_flushBVHEdits()` uploads only the touched leaves. World visibility is resolved by walking the parent chain (`_isWorldVisible`).

---

## Material Sampling & Evaluation

### BRDF Weights
`calculateBRDFWeights` computes per-lobe weights from roughness, metalness, IOR, sheen colour and cached derived factors (`MaterialCache`).

### Direction Sampling (`generateSampledDirection`, PathTracerCore.js)
Selects one lobe via a cumulative-probability chain (diffuse → specular → sheen → clear coat → transmission), emitted as a single mutually-exclusive WGSL branch:
- Diffuse: cosine hemisphere.
- Specular: GGX VNDF (anisotropic when `anisotropy > 0`); at roughness 0 an exact mirror, a delta lobe.
- Sheen: GGX at the sheen sampling roughness; draws below the surface are dropped, not redirected.
- Clear coat: VNDF at the clamped clear coat roughness.
- Transmission: `sampleMicrofacetTransmission` (refraction, TIR, dispersion); its density includes the lobe's selection weight.

Every reflection lobe reports one mixture density (`calculateBSDFSamplingPDF`), since any of them could have produced the direction; a delta lobe reports `DELTA_PDF` (1e6) with its value scaled to match. Returns a `DirectionSample { direction, value, pdf, isTransmission, colorWeight }` with `pdf` clamped to `MIN_PDF`. Material classification (`mc`) and cached weights are resolved by the caller and passed in (a TSL `Fn` can't write back to caller variables).

### Evaluation (`evaluateMaterialResponse`)
Combines diffuse, microfacet specular (GGX D/G/F), transmission, sheen, clear coat and iridescence.

### Where spawned rays start
Every ray leaving a surface starts at `offsetRayOrigin( p, n )` (`Common.js`, Cycles' ray_offset: 1e-5 along `n` within one unit of the origin, 32 float ULPs per axis beyond), with `n` the **facet** normal on the side the ray leaves — never the interpolated one, which on foliage cards points away from the card and left pass-through rays inside its plane. A shadow ray towards a sampled light point is re-aimed from that origin and stops `SHADOW_END` (1 − 1e-4) of the way. Light and environment shadow rays from a smooth-shaded triangle are first lifted towards the smooth surface near the terminator (`ShadowTerminator.js`, setting `shadowTerminatorOffset`, default 0.1 as in Blender). Horizon checks still use the interpolated normal.

### Transmission, medium & subsurface
`MaterialTransmission.js` handles refractive events, the medium stack, Beer–Lambert absorption and dispersion. `Subsurface.js` implements random-walk SSS reusing the medium stack (`maxSubsurfaceSteps` caps the walk).

### Indirect lighting (`calculateIndirectLighting`, LightsIndirect.js)
Turns the `generateSampledDirection` draw into the bounce: throughput `f · NoL / pdf`, or the sampler's own tint for refraction, and the draw's pdf, carried as the next vertex's `prevBouncePdf` for MIS against NEE. A non-positive pdf falls back to a cosine bounce. The environment is not an indirect strategy; it is reached through NEE and the miss.

---

## Environment Importance Sampling (`Environment.js`)

### Table-Based Sampling
`sampleEnvironmentExact` inverts the piecewise-constant table in `envCDFTexture` (`Processor/EnvironmentExactTable.js`): the row is found from the rows' running sums, then the cell within it. A step's guide names the entry at once in most draws; otherwise a binary search runs between the guides. The draw lands exactly at the density `environmentPdfExact` reads back from the same sums. The table is MIS-compensated (each texel weighs what it has above the mean) and keeps a floor on every cell.

### Direction Conversion
`equirectDirectionToUv` / `equirectUvToDirection` map between spherical and UV space applying `environmentMatrix` (HDRI rotation).

### Sampling & PDF
`sampleEnvironment` evaluates radiance for arbitrary directions; a cell's density is its share of the table over its uv area, divided by 2π² sin θ for solid angle. `envTotalSum` > 0 says a table is bound. `getGroundProjectedDirection` / `groundProjectedEnvDir` bend the primary-ray background lookup onto a virtual ground when ground projection is enabled.

### The physical sky
An add-on (`rayzee/addons/physical-sky`): the core bakes `'procedural'` mode only once `environmentManager.setProceduralSky( PhysicalSky )` has installed the class (`PathTracerApp` does this); without it the mode records `capability.missing`. The sky texture and its table are both written on the GPU (`Processor/PhysicalSky.js`, bake kernels in `TSL/Atmosphere.js`; the table by `TSL/EnvironmentCDF.js`, the GPU twin of `buildExactEnvironmentTable` in the same packed layout), so the samplers above read them exactly as they read an HDRI's. `envTotalSum` arrives a few frames after each bake. The sun is not in the texture: environment NEE's loop runs a second pass for it (`sampleSunDisc`, 2D dimension +9).

---

## Accumulation & Temporal Blending (`FinalWriteKernel`)

- For each pixel, the current radiance is blended with the previous accumulated MRT:
  `final = mix( previous, current, accumulationAlpha )` (colour and alpha; the aux outputs with `auxAccumulationAlpha`).
- The blend runs only when `enableAccumulation && !cameraIsMoving && frame > 0 && hasPreviousAccumulated` and `visMode != 11`.
- A pixel frozen in an earlier frame was not traced, so its accumulated colour passes through unchanged.
- `accumulationAlpha` is computed CPU-side (`calculateAccumulationAlpha`, in `_updateAccumulationUniforms`); in interaction mode it is 1 with no history.
- FinalWrite also keeps the convergence statistics: a running mean of luminance² (`m2`) for the whole-frame stop, and a per-pixel streak whose length freezes a pixel (`pixelFreezeStability` frames).

---

## TSL Authoring Patterns

### Compute kernel definition
```js
const computeFn = Fn( () => {
    const tid = instanceIndex; // 1D kernels; 2D ones derive (x, y) from workgroupId and localId
    If( tid.greaterThanEqual( atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) ), () => {
        Return();
    } );
    // ... read SoA buffers, do work, write SoA buffers / StorageTextures
} );
km.register( 'name', computeFn().compute( [ groups, 1, 1 ], [ WG_SIZE, 1, 1 ] ) );
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
| Storage RW / RO | `storage( attr, type )` and `.toReadOnly()` on one attribute share one GPU buffer |
| Scene resources | `withSceneResources()` at the kernel root, `sceneResources( builder )` in a function body |
| Includes | ES module `import` |

> **Critical**: Use chained `If().ElseIf().Else()` for exclusive branches. Separate `If()` blocks generate independent WGSL `if` statements where inactive branches can contaminate results.

### Uniform Management
Uniforms are `uniform()` node objects owned by `UniformManager` and accessed via `stage.uniforms.get(name)` / dynamic getters (e.g. `this.maxBounces`). Uniforms are created once; only `.value` is mutated to preserve the compiled shader graph.

### StorageTexture writes
Kernels write MRT outputs to write-only StorageTextures (`textureStore(...).toWriteOnly()`); `copyToReadTargets` then copies them into a readable RenderTarget for downstream stages and for the next frame's blend (StorageTextures can't be sampled cross-dispatch).

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
| Wavefront | Stream compaction + per-bounce dispatch sized from last frame's survivor curve | Dead rays dropped; dispatch tracks the survivors |
| Wavefront | Per-bounce early exit on the survivors' throughput | Skips tail bounces that carry no energy |
| Wavefront | Fixed path budget streamed in row bands | Bounded memory; a resize reallocates and recompiles nothing |
| Adaptive sampling | Per-pixel freeze (`buildActivePixels`) + whole-frame convergence stop | Converged pixels stop being traced |
| Sorting | Global material counting sort (above 8 materials) | Material-pure workgroups for Shade |
| Light BVH | Power- and orientation-weighted stochastic descent | O(log N) emissive sampling vs O(N) CDF |
| RNG | Fast RNG for non-critical samples | Lower ALU cost |
| Material Sampling | Caller-resolved classification + cached BRDF weights | Avoid recomputation |
| Direction Sampling | Single mutually-exclusive lobe branch (cumulative CDF) | Less divergence |
| Accumulation | Disabled during camera movement | Prevents temporal instability |
| Resolution | Reduced render size while the camera moves (`interactionRenderScale`, 0.5 by default; a viewer setting `PathTracerApp` defines with `settings.define`) | A quarter of the rays per frame at 0.5; bounces kept, so no brightness pop when the camera stops |
| Data Access | Aligned vec4 SoA packing | Coalesced GPU memory reads |

---

## Error & Stability Guards

- Minimum PDF clamps (`MIN_PDF`, 0.001) prevent division by zero in MIS weights; a non-positive bounce pdf falls back to a cosine bounce.
- While aux is on, Generate seeds every G-buffer slot with normal +Z, depth 1 and black albedo, so a pixel that commits nothing still decodes to a valid normal.
- Environment densities return 0 where sin θ is 0 (the poles), and a drawn offset is clamped inside its cell.
- Total internal reflection in `sampleMicrofacetTransmission` reflects about the sampled microfacet and reports that reflection's pdf.
- Firefly suppression via `regularizePathContribution`: soft, path-length aware, indirect contributions only.

---

## Extension Points

1. **Add a new material lobe**: integrate into `calculateBRDFWeights`, the `generateSampledDirection` lobe chain (PathTracerCore.js), the mixture density `calculateBSDFSamplingPDF`, and `evaluateMaterialResponse`.
2. **Change environment sampling**: keep `sampleEnvironmentExact` and `environmentPdfExact` drawing and reporting from the same table, and `TSL/EnvironmentCDF.js` in step with `buildExactEnvironmentTable`. An alias table was tried: unbiased, but it broke the samples' stratification and doubled a furnace's noise.
3. **Add a wavefront kernel**: build a new `Fn().compute()`, register it in `_buildWavefrontKernels`, dispatch it in `render()`. A new integrator plugs into the integrator hooks instead (see `BidirectionalIntegrator`); never branch on it inside `PathTracer`.
4. **Per-triangle custom attributes**: expand the triangle layout (`EngineDefaults.js`), the geo/shade split in `PathTracerStage._uploadTriangles`, and the interpolation in `traverseBVH`.
5. **Per-pixel ray policies**: `buildActivePixels` already decides which pixels are traced (the pixel freeze); `generateList` traces only the list it builds.

---

## Glossary

- **Wavefront**: ray-batch path tracing where each bounce is a separate compute kernel over surviving rays.
- **Path budget / band**: the fixed number of paths in flight, and the rows of the image processed through it at once.
- **MIS**: Multiple Importance Sampling.
- **VNDF**: Visible Normal Distribution Function sampling for GGX.
- **CDF**: Cumulative Distribution Function used to invert distributions for sampling.
- **NEE**: Next Event Estimation (direct light sampling).
- **DOF**: Depth of Field.
- **Firefly**: bright outlier sample from a low PDF / high radiance.
- **SoA**: Structure of Arrays (the packed ray/hit buffer layout).
- **TLAS / BLAS**: top-/bottom-level acceleration structure.
- **SSS**: subsurface scattering (random walk).
- **VCM**: vertex connection and merging (bidirectional path tracing plus photon-style merging).
- **TSL**: Three Shading Language — JS-based shaders compiled to WGSL.

---

## Diff-Friendly Summary For Refactors

| File | Critical Symbols | Purpose |
|---|---|---|
| `Stages/PathTracer.js` | `render()`, `_buildWavefrontKernels()`, `_computePathBudget()`, `_setChunk()`, `setIntegrator()`, `requestOutput()` | Per-frame dispatch order, kernel build, path budget, integrator hooks |
| `Stages/PathTracerStage.js` | `setupMaterial()`, `updateAllMeshVisibility()`, `_patchTLASLeafVisibility()`, `_uploadTriangles()` | Shared infra, scene texture nodes, mesh visibility |
| `integrators/BidirectionalIntegrator.js` | `registerKernels()`, `beginFrame()`, `afterShade()`, `resolve()` | Bidirectional / VCM add-on |
| `TSL/GenerateKernel.js` | `buildGenerateKernel()` | Primary ray generation |
| `TSL/ExtendKernel.js` | `buildExtendKernel()` | Closest-hit traversal |
| `TSL/ShadeKernel.js` | `buildShadeKernel()` | Direct/indirect lighting, transmission, aux G-buffer |
| `TSL/CompactKernel.js` | `buildCompactKernel()`, `buildCompactSubgroupKernel()` | Survivor stream compaction |
| `TSL/FinalWriteKernel.js` | `buildFinalWriteKernel()` | Accumulation, convergence statistics, MRT writes |
| `TSL/PathTracerCore.js` | `generateSampledDirection()`, `handleRussianRoulette()`, `computeNDCDepth()` | Shared sampling helpers |
| `TSL/BVHTraversal.js` | `traverseBVH()`, `traverseBVHShadow()` | Acceleration traversal, visibility, inline side culling |
| `TSL/Environment.js` | `sampleEnvironment()`, `sampleEnvironmentExact()`, `environmentPdfExact()` | HDR env sampling & PDF |
| `TSL/SceneResources.js` | `withSceneResources()`, `sceneResources()` | Per-kernel scene resources |
| `TSL/LightBVHSampling.js` | `sampleLightBVHTriangle()`, `calculateLightBVHPdf()` | Light BVH stochastic descent |
| `TSL/Random.js` | `getDecorrelatedSeed()`, `getStratifiedSample()`, `getRandomSampleND()` | Sampling quality |
| `Processor/PackedRayBuffer.js` | `RAY`/`HIT`, read/write helpers | SoA buffer layout |
| `Processor/QueueManager.js` | `COUNTER`, `RAY_FLAG`, active/sorted queues | Ray queues + atomic counters |
| `Processor/KernelManager.js` | `register()`, `dispatch()`, `setDispatchForCount()`, `setDispatchForGrid()` | Kernel registry and grid sizing |

Numerical constants to keep consistent:
- `MIN_PDF`, `DELTA_PDF`, `SHADOW_END`, epsilon thresholds in environment & BVH.
- Prime numbers in RNG seeding (altering them affects noise stability).

---

End of document.
