# Materials and shading

How the path tracer's materials and shading work inside: material defaults, Fresnel, exact mirrors, diffuse
transmission and roughness, clear-coat normals, material layers, transmission maps, glass, displacement, ray spawn points,
the shadow terminator, shadow-ray picking, sized lights and fog. CLAUDE.md keeps the rules.

- **Material defaults** — `MATERIAL_DEFAULTS` (`EngineDefaults.js`) is the only fallback for a
  property a three.js material lacks (MeshPhysicalMaterial's own values), and `packMaterial()`
  (`materials/MaterialPacking.js`) is the only writer of the material block, for the scene upload
  and runtime edits alike. `app.getMaterialPropertySource( i, prop )` answers
  `material | mapped | default | host`. Weights and roughnesses (`UNIT_RANGE_PROPERTIES`) are clamped
  to [0, 1] there and in `updateMaterialProperty`: the Mercedes glTF ships chrome with
  `clearcoatFactor: 4`, `1 − clearcoat·E` went negative, and OIDN grew the negative samples into blobs.
  ⚠️ Never derive a default from another property: "metalness factor > 0.1 ⇒ IOR 2.5" made every
  ORM-textured glTF 4.6× too shiny on its non-metal parts.
- **Fresnel** — every dielectric interface (base layer, clear coat, glass, SSS boundary, glass
  shadows) uses the exact unpolarised Fresnel, `fresnelDielectric` in `shaders/Fresnel.js`, as Cycles
  does; metals and iridescence stay Schlick. The base keeps KHR_materials_specular's f0/f90 via
  `mix( f0, f90, dielectricFresnelWeight )` (`baseFresnelParams`), so specularIntensity 0 removes
  the reflection. The DFG LUT holds that weight's albedo in 17 IOR slices beside the Schlick terms —
  one texture, one extra fetch; regenerate with `npm run bench:lut` if a lobe or sampler changes.
  ⚠️ `DistributionGGX` floors its denominator at 1e-30, not `EPSILON`: at `MIN_ROUGHNESS` the peak
  is ~1e-10, and a 1e-6 floor cut D 8000× while the sampler drew the true lobe (a smooth white
  dielectric read 1.10 in the furnace). `furnace-dielectric-smooth` gates it.
- **Exact mirrors** — Shade floors roughness at `MIN_ROUGHNESS` (0.05; below it the GGX peak is
  narrower than f32 can evaluate), which rendered roughness-0 mirrors ~1 cm blurry at 2 m. A plain
  reflector authored below the floor (no anisotropy, clear coat, transmission or SSS) now gets
  roughness **0**, the delta-lobe marker: `generateSampledDirection` reflects about N and returns
  `DELTA_PDF` (1e6) with the value scaled so value·NoL/pdf is reflectance ÷ selection chance, which
  makes every MIS weight against it 1; the BSDF drops the lobe (GGX is exactly 0 at roughness 0), and
  `evaluateSpecularDeltaFromDots` gives its reflectance under the same sheen/coat attenuation.
  Glass already refracted exactly below 0.05; clear coat keeps its 0.089 floor.
  `furnace-metal-mirror` (1.00000) and `furnace-dielectric-mirror` gate it.
- **Diffuse transmission** (KHR_materials_diffuse_transmission; `material.diffuseTransmission`, `diffuseTransmissionColor`,
  engine properties three.js does not have) — a thin surface passes that share of its diffuse lobe to the other side:
  reflected (1 − dt)·baseColor/π, transmitted kD·dt·colour/π with the reflected diffuse's own budget kD (what the
  specular lobes leave, less metal and specular transmission) under the same sheen and coat attenuation
  (`evaluateDiffuseTransmission`). It enters no medium. The sampler draws it with the diffuse weight's dt share
  (`BRDFWeights.diffuseTransmission`, cosine about −N, density `diffuseTransmissionPdf`); `evaluateMaterialResponse` /
  `calculateMaterialPDF` answer a direction below N with it, so every MIS site agrees. NEE lights the surface from
  behind at every site — lamps (and their importance), the rect-light BSDF hit, environment and sun, emissive
  triangles (`throughSurface` on the samplers): the cosine below N, the shadow ray off the other side of the facet
  (`backOrigin`, no terminator lift). A transmission draw must cross the geometric surface (the leak guard's mirror
  case), is never flagged UNDER_SURFACE, and sets SUN_NEE. **Compiled in only while some material has it**
  (a material layer — see **Material layers** below). Bidirectional and VCM carry it: light subpaths cross the surface,
  NEE reaches through it, and a connection, light-tracing splat or merge may reach a vertex from behind — the BSDF and
  both densities then take the normal on the far side (`facingSide`), the cosines absolute, the shadow ray off that side;
  a light vertex records in `extra` which of its sides the camera culls (bit 0 near, bit 1 far). Packed at 39 (factor) and 129–131 (colour); slot 33
  holds the two map indices and `getMaterial` reads it only when the factor is above 0. Maps (`diffuseTransmissionMap`,
  its A channel, linear bucket; `diffuseTransmissionColorMap`, RGB, sRGB bucket) fold in through `applyExtensionMaps`
  on the albedo map's uv transform. Loaders: glTF through `GLTFDiffuseTransmission.js` (factors and both textures,
  via `parser.assignTexture`); pbrt `diffusetransmission` with dt = max(T), base R / (1 − dt), colour T / dt, exact
  while max(R) + max(T) ≤ 1. `tests/gpu/diffuseTransmission.test.js` holds energy (the split moves it, creates none),
  the lobe's draw rate and sampler/NEE agreement; `furnace-diffuse-transmission` (a closed sphere, 0.99989) and
  `translucent-panel` (lit from behind, truth with emissive NEE off: +0.017 %) gate it. Khronos'
  DiffuseTransmissionTest / Teacup / Plant render as their reference viewers show them.
- **Diffuse roughness** (`material.diffuseRoughness`, an engine property until three.js r187 adds its own; packed at 33)
  — EON (Portsmouth, Kutz & Hill 2025: Fujii's Oren–Nayar plus the light lost between facets),
  OpenPBR's `base_diffuse_roughness` and Cycles' Diffuse Roughness. One site, `diffuseLobe` in `MaterialEvaluation.js`
  (`diffuseEON` in `MaterialProperties.js`), so NEE, BSDF draws and the bidirectional kernels all get it; cosine
  sampling stays (reciprocal, so no density changes). ⚠️ The paper's form is 0/0 at roughness 0 and only near Lambert
  in f32: roughness 0 branches to the old Lambert expression, bit for bit. USD reads OpenPBR, Standard Surface (which
  MaterialX renders uncompensated) and `oren_nayar_diffuse_bsdf`; a texture-driven value is not read. Diffuse
  transmission stays Lambert. `tests/gpu/diffuseRoughness.test.js` holds the paper's Listing 1 (1.3e-6), reciprocity
  and white furnaces 0.9995–1.0000; `furnace-rough-diffuse` 0.99983, `-layered` 0.99976, `rough-diffuse` its shape.
  Every material of the 1.9M-triangle test interior at 0.5: frame +0–1 %, within noise.
- **Clear coat normal** (glTF `clearcoatNormalTexture`; three.js `clearcoatNormalMap` / `clearcoatNormalScale`, packed at
  134–135) — the coat has a normal of its own, as glTF, three.js, Blender and MaterialX have it: the surface's (displaced,
  never the base's normal or bump map), or its own map's. Shade sets `material.clearcoatNormal`; `computeDotProductsAniso`
  adds the coat's `coatNoL/NoV/NoH` (`coatNormal()` turns it to N's side, zero = N), which the coat lobe, its attenuation
  of the base, its VNDF draw in both samplers and its density read. Callers apply N's cosine, so the lobe carries
  coatNoL / NoL. The map shares the base normal map's transform and tangent, or brings its own when there is none.
  Compiled in only while a coated material has a normal or bump map (`clearcoatNormals` in the build context,
  `hasClearcoatNormals()`), never for the bidirectional integrators: their vertex records hold one normal, so there the
  coat follows N as before. pbrt's coated materials hand their normal map to the coat (pbrt shades both in one frame).
  `tests/gpu/clearcoatNormal.test.js`; Khronos' ClearCoatTest (BaseNorm / CoatNorm rows) shows both cases.
- **Material layers** — clear coat, sheen, iridescence, anisotropy, subsurface, dispersion, diffuse transmission and
  diffuse roughness (`MATERIAL_LAYERS`, `shaders/SceneResources.js`) are compiled into the kernels only while some material has the layer's
  factor above 0 (`MaterialDataManager.materialLayers()`). The set rides in each kernel's build context
  (`resources.materialLayers`); a function body reads it with `materialLayers( builder )` and leaves the layer's code
  out with a plain JS `if` — the weight, density, sampling link, extension maps and Shade's paths (the coat sampler,
  the subsurface walk and boundary). Shade also zeroes each absent layer's factor after `getMaterial`. Outside a
  scene kernel (a GPU test) every layer is in. A scene load rebuilds the kernels for its exact set; an edit that turns
  a layer on rebuilds before the next frame (`onMaterialFeaturesChanged` → `_layersToCompile`), one that turns it off
  waits for the next build, so dragging a slider through 0 does not recompile twice. ⚠️ Removing a layer's code must
  be exact for a material without it: the iridescence weight keeps `min( 0, diffuse )` (it moves a negative diffuse
  weight to specular even at 0), and a sampling link may go only because its weight is 0 and so its cumulative bound
  equals the previous one. `tests/gpu/materialLayers.test.js` holds a layer-free material bit-identical with every
  layer compiled out; every bench golden is unchanged scene by scene. Frame time (`bench:ab`, 28 scenes, Apple
  M-series): −3.9 to −24.3 %, median −9.6 % — scenes with a layer gain too, from the others going.
- **Transmission map** — transmission = factor × the map's R (linear bucket, albedo UV transform). Shade folds it in
  `applyExtensionMaps`; shadow rays read it too (`traceShadowRay`), compiled in only while some material has one
  (`transmissionMaps` in the build context, `MaterialDataManager.hasTransmissionMaps()`).
  `tests/gpu/transmissionMapShadow.test.js`. ⚠️ `SceneProcessor` adopts every per-type texture list through
  `_adoptTextureLists` (`TEXTURE_LISTS`): a list kept from an earlier extraction drops that map type after
  `rebuildMaterials()`.
- **Glass** (`handleTransmission` → `sampleDielectric`, `shaders/MaterialTransmission.js`) — each crossing draws a facet
  from the normals V sees (VNDF), the exact Fresnel at that facet picks reflection or refraction, and either weighs
  G2 / G1(V) (height-correlated Smith), 0 where it lands on the wrong side of N, which ends the path. The weight is
  divided by the interface's albedo — reflection plus refraction's light, radiance's (n1/n2)² aside — so the light the
  facets trade among themselves comes back: `dielectricInterfaceAlbedo` reads it from the DFG LUT, B entering and A
  leaving in the block of each IOR slice, the last slice's in one block more (`npm run bench:lut`; interpolation between
  slices within 0.0014). At or below `MIN_ROUGHNESS` the facet is N and the weight 1. A dispersive glass draws (or keeps)
  the path's wavelength first, so Fresnel and refraction both use its IOR; only a crossing locks it.
  Until 11.16 a rough "reflection" was a refraction left off the medium stack, so it left the glass with an unpaired
  ×(n1/n2)², and neither masking nor the facet's Fresnel was weighed: the white furnace read 1.029 at roughness 0.1 and
  0.68 at 1 for IOR 1.5, 1.56 and 0.41 for 2.4, and rough glass showed no reflections at all. Now 0.997–1.002 at every
  roughness for IOR 1.33 and 1.5, 0.999–1.006 for 2.4 given the crossings to let trapped light out. Against Cycles 5.1
  (glass spheres under a sky lit by height alone): roughness 0.1 within 0.1 %, 0.3 within 1.4 %; rougher, Cycles is
  brighter, but its multiscatter glass reads up to 1.20 in its own white furnace (1.13 / 1.20 centre / rim at
  roughness 1). `tests/gpu/dielectricInterface.test.js` holds each crossing's energy (within 2 % over the table's grid),
  its sides, the smooth split, and where the light goes against Walter's BSDF written out, bin by bin;
  `furnace-glass-rough`, `furnace-glass-rougher` and `furnace-glass-dense-rough` gate it.
  **Part transmission**: transmission's lottery (chance T) picks the glass; when it declines, Shade sets
  `material.transmission` to 0 and the opaque base shades as itself. It used to keep T, so the diffuse lost (1 − T) a
  second time and a stand-in transmission lobe was drawn as well: T 0.5 read 0.46–0.80 in the white furnace, now
  1.00 for smooth to roughness 0.2. With its crossings spent (`transmissiveBounces`) the opaque path still stands in for
  the whole material, transmission lobe included. Not found yet: rough, dense, part-transmissive glass in a closed
  furnace still reads 0.97–0.98 at roughness 0.7–1 (IOR 1.5; at IOR 1.01, 0.999); giving the straight shadow rays
  radiance's (n1/n2)² does not explain it (1.11 smooth, 1.01 at roughness 1).
- **Displacement** (`shaders/Displacement.js`) — three.js's meaning: height = map × `displacementScale` + `displacementBias`,
  scene units, along the normal (packed at 49 and 51). No tessellation: Shade marches the height field from the base hit
  (a step per 4 texels crossed, 8–64 for camera rays, 16 for bounces) and shades with the marched UV and the field's slope
  (central differences over 1.5 texels: an 8-bit map's one-texel slopes flicker). ⚠️ A point the march finds behind the
  base triangle is moved onto its plane: rays spawned below it all hit that triangle, and everything under the mid-level
  rendered black. No self-shadowing or silhouettes; otherwise a tessellated twin matches it (`tests/gpu/displacement.test.js`).
  The app's Poly Haven loader sets the height to 2 % of the texture's width on the object, mid-grey on the surface.
  ⚠️ Glass and subsurface: the relief is not geometry, so the triangle decides entering vs leaving (winding against the
  vertex normal), whatever is not reflected crosses it (a direction the leaning normal sent the wrong way is mirrored in
  its plane), and only a reflection leaves from the relief, where that lies on the incoming ray — a crossing from the
  relief hit its own triangle again, or a neighbour past the edge, and each extra crossing stacked the glass's IOR
  (`furnace-displaced-glass` read 1.72). The relief traps light by total internal reflection, whose chance stays 1:
  clamped to 0.95 like a Fresnel pick, each one gained 5 % (the furnace read 1.0015).
- **Ray spawn points** — every ray leaving a surface starts at `offsetRayOrigin( p, n )`
  (`shaders/Common.js`, Cycles' classic ray_offset: 1e-5 along n within 1 unit of the origin, 32 float ULPs
  per axis beyond), with n the **facet** normal on the side the new ray leaves. ⚠️ The hit record's
  `normal` is the interpolated one; the facet normal rides in its spare lane (`shaders/HitFacet.js`, packed
  by Extend). Offsetting along the interpolated normal broke foliage: cards whose vertex normals all
  point up had pass-through rays moved within the card's own plane, re-hit it until the transparent
  guard ended the path, and drew black (`furnace-foliage-cards` gates it). ⚠️ Never a fixed
  distance: the old 1 mm let rays out of sub-millimetre grooves, and a 14 cm camera read up to 14 %
  bright in its crevices against Cycles — the same model scaled 100× matched. A shadow ray towards a
  sampled light point (area lights and emissive NEE alike) is re-aimed from that origin and stops
  `SHADOW_END` (1 − 1e-4) of the way, never a fixed distance short. ⚠️ The hit point Shade rebuilds,
  origin + t · direction, sits off a large triangle by t's own error, which grows with the triangle's size:
  points on a 400-unit two-triangle floor fell under it and read up to 4 % dark in bands. Extend moves the stored
  distance along the ray onto the triangle's plane (`HitFacet.js` `surfaceOffset`, not where the ray grazes it), and
  the closest-hit triangle test rejects t within its rounding error (pbrt-v4's bound). ⚠️ Storing the correction in a
  slot of its own cost Extend 10–15 % (one more scattered write a ray: it is memory-bound), and the bound in the
  shadow test cost Shade ~4 % in registers alone; shadow rays start lifted off their surface and skip it
  (`RayTriangleGeometryShadow`). Every band reads 1.0000 against the floor split 64 × 64, both integrators.
- **Shadow terminator** — Cycles' Shadow Terminator → Geometry Offset (`shaders/ShadowTerminator.js`,
  setting `shadowTerminatorOffset`, 0.1 as in Blender, 0 off), ported from Cycles 5.1's
  `kernel/light/sample.h`: near the terminator, light and environment shadow rays from a smooth-shaded
  triangle start on the smooth surface its vertex normals describe. Bounce rays and the BSDF-hit
  area-light ray are not lifted, as in Cycles. The low-poly white furnaces read 0.99650 → 0.99879
  (16 segments) and 0.99815 → 0.99879 (32), the same as the smooth sphere. Extend computes the lift
  and packs it beside the facet normal (11:11 octahedral, then the lift's top 10 half-float bits).
  Cost on the 1.7M-triangle test interior at 1024²: +1.2 % GPU per sample, 0.26 ms of it the work.
  ⚠️ `bench:ab` read +7–9 % on identical code for two scenes that day: net any A/B of a self-run.
  ⚠️ Shade's `Ngeo`/`NgeoFF` are the interpolated normal, not the facet (`facetN` is), and the hit
  keeps texture UVs, not barycentrics.
- **Fewer shadow rays** (`shadowRays`: `'two'` default, `'all'`, `'one'`; path integrator only) — `'all'` is a shadow ray
  per kind of light (the lamp pick, environment, sun, emissive triangles). Otherwise each kind offers its sample
  unshadowed to `lightPick` (`shaders/LightsSampling.js`): `'one'` keeps one with chance ∝ its luminance × √(the share of its
  kind's rays that got through here) and traces only it, divided by that chance; `'two'` always traces the strongest as
  well. MIS weights are unchanged, so both stay unbiased; the rect-light BSDF-hit ray is kept. A scene with no more
  light kinds than the mode traces rays compiles as `'all'` (`_pickedShadowRays`, checked every frame, so a kind
  that appears rebuilds the kernels): there the pick would only add its bookkeeping. The learned visibility
  (`shaders/LightVisibility.js`) sits in the counter buffer past the light guide: tries/visible per cell × kind, a cell ~1/32
  of its distance from the camera (power of two) and its facing axis. Shade reads the learned half and adds to the fresh
  half; `visibilityFold` merges them after each frame, so a render repeats bit for bit. A reset clears it unless only
  the camera moved. Equal-time error against `'all'` (Apple M-series): 24155522.glb with the physical sky `'one'` 1.63×
  samples/s, 0.66–0.76; `'two'` 1.23×, 0.82–0.84; small scenes `'one'` 0.89–0.98, `'two'` 1.00. ⚠️ `'one'` loses
  where a white sun and a blue sky are both in view — a sample carries one light's colour, not their mix:
  `shadow-catcher-ground` 1.54–1.92, `sheen-velvet` 1.18–1.33 (`'two'` 1.00 and 0.96). On ten real scenes (three Livspace
  interiors, a small room, two classrooms, kitchen, bathroom, Sponza and a product shot under the physical sky) `'two'`
  won 5–23 % on six, fell back on three and was even (1.02, within ±3 % timing noise) on the small room, where `'one'`
  lost 1.7×; under HDRIs `'two'` 0.86–0.92 where it picks. `mixed-lights` is the only bench scene with three kinds, so the
  only one where the pick runs (a dropped 1/P reads −2.9 %). Time them in rounds paired against `'all'`: the GPU here
  drifts ±7 % between rounds. Rejected: a control variate (add
  every light × its learned visibility, trace one to correct it) — no better than `'one'`, and 7.7 % of a single sample's
  channels negative on the interior, which the denoisers are fed.
- **Light radius** — a point or spot light with `userData.radius` (USD `SphereLight` radius unless `treatAsPoint`) is lit
  as Cycles' Soft Falloff: NEE samples a disc of that radius facing the shaded point and scales the emission by the disc's
  cosine, so on its axis it gives I / (d² + r²); a spot's cone, gobo and IES are read from the centre. Packed as the
  point's 10th float and the spot's slot 18 (`LightSerializer`). Compiled in only while some light has a radius
  (`lightRadius` in the build context, `usesLightRadius( builder )`, `PathTracer._lightRadiusNeeded()` each frame);
  otherwise the old code, at no measurable cost (`bench:ab`, every scene). NEE only: these lights stay unseen by camera
  and mirror rays. The bidirectional integrators keep them as points (their light paths leave the centre), and glTF has
  no field for a radius. Barbershop in clay against Cycles: 0.885 → 0.978 overall, its left side (lit by sized lights)
  0.52–0.63 → 0.93–0.97. `tests/gpu/lightRadius.test.js`.

- **Fog** (`shaders/Fog.js`; settings `fogDensity`, `fogColor`, `fogAnisotropy`, `fogBounds`, `fogHeightFalloff`,
  `fogFloor`). A medium in an axis-aligned box: grey extinction (per scene unit) and a coloured albedo, Henyey–Greenstein
  phase function. Its density is `fogDensity` up to `fogFloor` (default the models' floor) and falls as e^(−falloff · h)
  at h above it. The box defaults to the loaded models' bounds (`getModelBounds()`, the ground plane left out), so the
  sky and the sun light it from outside — an infinite medium would absorb the environment entirely.
  - *Compiled in only while it has a density* (`PathTracer._fogNeeded()`, rebuilt from `render()` like the light radius):
    off, every WGSL module is that of a build without fog (checked by hashing every `createShaderModule` with node ids
    renumbered; with the height falloff and the segment emitters added, again on nine corpus scenes of 12–23 modules,
    bidirectional ones included), and the corpus renders exactly as before. Path integrator only; the bidirectional ones record
    `setting.ignored` and render without it. The falloff is not a compile switch: at 0 every fog expression selects its
    homogeneous form, so changing it never rebuilds and even fog renders bit for bit as before (`fog-furnace`).
  - *Height, in closed form.* The span is cut where the ray crosses the floor into at most two pieces, flat below and
    exponential above (`floorPieces`). A piece's optical depth is peak · L · (1 − e^(−x)) / x, with peak its density at
    its denser end and x = falloff · |dy| · L, so no exponent overflows however high the box reaches; the free flight
    inverts it from that end, u = (R / peak) · (−ln(1 − z) / z) with z = rate · R / peak, and both averages go to their
    series below 0.01. `tests/gpu/fog.test.js` holds the depth to a 20,000-step Simpson integral (2 · 10⁻⁴) over random
    rays, horizontal and vertical ones included, the flight to a round trip through it, and falloff 0 to the
    homogeneous expressions bit for bit. Ground mist in the app keeps the haze over each spot of the floor and gathers
    it lower (Height: Low / Ground halve the density at 25 % / 6 % of the models' height).
  - *Free flight in Shade*, before the miss branch, outside any glass or subsurface medium (medium stack depth 0): a
    distance drawn exactly from the density inside the ray's span of the box (`fogFreeFlight`). Extinction is grey, so
    a ray that passes keeps its throughput, one that scatters takes the albedo; no spectral MIS.
  - *A scatter* is a vertex of its own: it takes the directional and rect lights, the environment and the sun through
    the phase function (`fogScatterLight`), then draws its next direction from the phase function
    (`sampleHenyeyGreenstein`, the subsurface walk's) and stores its density as the bounce pdf. The environment is
    weighed with the balance heuristic and the sun with the power heuristic, as at a surface, so the miss and emitter-hit
    branches pair with them unchanged; the scatter sets `SUN_NEE` (its sun NEE draws any direction), `REDIRECTED` and
    `HAS_HIT_OPAQUE` (alpha coverage), uses a bounce of the budget, and commits the aux guide as the fog's albedo facing
    the camera. Russian roulette from bounce 3 on the throughput alone.
  - *Point and spot lights and the emitters* light the fog along every segment instead (`fogSegmentLight`): one of them
    picked by its unshadowed single scattering over the span, ∝ intensity × (θb − θa) / D, then one distance drawn
    equiangularly toward it (Kulla & Fajardo 2012), which cancels the 1/d² a free-flight point sees. The emitters are
    one candidate, weighed by their total power as if it sat at their light tree's centre: power, not the quarter of it a
    ball sends each way, since the point and spot weights leave out their cones (at a half or a quarter `fog-shafts` was
    1–4 % noisier, 16 independent 64-spp images each). From free-flight points alone a spot in fog sparkled across the
    whole room, and a small bright emitter's halo; point and spot lights are delta lights with no BSDF partner.
  - *An emitter along a segment* (`emitterLight`): a point drawn from a reference point in the span (a free flight held
    inside it) by power over distance², from either side (`sampleLightBVHTriangleAnySide`, `sampleEmissiveTriangleAnySide`:
    area density, orientation cones left out), then a distance drawn equiangularly toward it on the part of the span
    the point emits toward. It is weighed with the power heuristic against the phase draw using NEE's solid-angle
    density at that distance (`emissiveNEEPdf`), exactly as the emitter-hit branch weighs a phase draw that lands on
    it: any weights summing to 1 are unbiased, whatever drew the point. ⚠️ Drawn as surface NEE draws, from the
    reference's side, it left the sides facing away from the reference to the phase draw at a weight below 1: −1.0 % on
    `fog-shafts`. The scatter-point emitter NEE it replaces was itself 0.8 % dark beside a one-sided panel (against
    emitter NEE off; without fog the two agree to 0.006 %), most likely its spherical-triangle draw from points close to
    a large triangle; the segment draw agrees with emitter NEE off to 0.025 %, with height falloff too (0.002 %).
  - *One shadow ray a segment*, as before: drawing both a lamp and the emitters each segment and keeping one by its light
    was no less noisy but cost 13 % a sample on `fog-shafts` — the emitter draw itself, not the shadow ray (a flat power
    list instead of the tree saved nothing; the MIS pdf walk was a third of it).
  - *Shadow rays* take the fog's transmittance in `traceShadowRay` (`SceneResources.fog`), so every surface NEE sees it
    too. The fog's own light is traced in one loop (`traceFogLight`): each `traceShadowRay` call inlines the whole BVH
    walk, and five call sites took a cold Shade compile from 3.1 s to 4.7 s. Under `shadowRays` `'two'`/`'one'` it
    goes through `lightPick` like a surface's; under `'all'` an emitter's light keeps its own firefly clamp (the slot's
    `emissive` flag).
  - ⚠️ Pass values into the shadow-ray Fn (CLAUDE.md pitfall 15): the select-chain expressions it was first given read
    as zero after its loop and the forward-scattering furnace lost 3.7 %. `traceShadowRay` now also captures its
    arguments at the top when fog is compiled in, since it reads them again after the loop.
  - Checks: black fog dims the sky by exactly e^(−σd) (0.01 %); a white fog in a uniform sky, alone or around a white
    Lambert sphere, renders the sky's radiance for g = −0.5…0.7 (≤ 0.03 %), and with the density thinning with height
    across a floor inside the box at four settings (≤ 0.09 %); a point light's single scattering matches a CPU quadrature
    (0.00 % at g = 0, 0.10 % at 0.6); `shadowRays` `'all'`, `'two'` and `'one'` agree on `fog-shafts` (to 0.002 %).
    Bench: `fog-furnace` (analytic gate; 1.909 with fog left out of shadow rays), `fog-height-furnace` (the same with
    falloff 1.5 above a floor at −0.5), `fog-shafts` (sun and sky through a window, a spot, an emitter; 5 % energy bias
    without the segment light), `fog-height` (ground mist, a low sun) and `fog-glow` (a small bright ball and a one-sided
    panel alone; drawing emitter points from the reference's side fails both emitter scenes' energy gates, −1.8 % and
    +17 %).
  - Cost (Chrome, M-series, 256², `bench:ab` against the build before): `fog-furnace` +0.2 % (the height expressions),
    `fog-shafts` +3.9 % for 1.4 % lower squared error (within its ±3 %: about even); `fog-glow` (Node) +7 % for 13 %
    lower. Shade compiles ~50 ms
    (7 %) slower warm. Before this, fog itself: 10.6 → 16.1 ms a sample on `fog-shafts` at 512² (Dawn), Shade compiling
    in ~4.2 s cold against 3.1–4.1 s without fog, once, when the density first leaves 0.
  - Not yet: density varying other than with height (noise, VDB), fog inside glass, the shadow catcher in fog. A bright
    speckle remains where a bounced ray passes close to a small bright emitter: the light from one point of it goes as
    1 / (the ray's distance from that point).
