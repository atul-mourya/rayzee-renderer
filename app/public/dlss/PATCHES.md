# Local changes to `dlss-runtime.js`

`dlss-runtime.js` is the DLSS-5-WebGPU demo bundle, deobfuscated with `webcrack` and then edited.
It is vendored rather than imported: it installs `globalThis.DLSSRuntime` as a side effect and is not
a module. If it is ever re-vendored from upstream, these edits have to be re-applied. Every one is
marked in the file with `rayzee-patch`, so `grep -n rayzee-patch` finds them all.

## 1. Expose the two entry points (end of file)

The bundle reaches its models only through its own demo UI. Two factories are published instead:

```js
globalThis.DLSSRuntime = {
  getSrNrChain() { ... return _0x16d1e6.SrNrChain; },   // the detail pass (DLSS-NR)
  getNativeSR()  { ... return _0x2901e0; }              // super resolution (DLSS-SR)
};
```

(Not marked — it is an added block at the very end rather than an edit in place.)

## 2. A scene-referred output for the detail pass — 5 edits

The detail pass writes only `rgba8unorm`, so its result was display-referred 8-bit and nothing could
work with it in linear light. That forced it to run **last**, i.e. on the upscaled image — which at
4096² takes 65-108 s and loses every GPU device in the page.

The HDR value exists one statement earlier. In the "GPU display composition" kernel:

```wgsl
let result = (luminance_only + (upgraded - luminance_only) * params.color_strength) * paper;
textureStore(output_texture, ..., vec4<f32>(webgi_display(result), 1.0));
```

`result` is scene-referred; `webgi_display` is a hardcoded ACES fit plus sRGB encode. So the patch
stores `result` to a second, `rgba16float` texture and leaves the original store untouched:

1. `@group(0) @binding(9) var rayzee_hdr: texture_storage_2d<rgba16float, write>;`
2. `textureStore(rayzee_hdr, vec2<i32>(id.xy), vec4<f32>(result, 1.0));` before the 8-bit store
3. a matching `rgba16float` texture per slot, beside `"DLSS-NR production output"`
4. `hdrOutput` on the slot object
5. `{ binding: 9, ... }` on the composite bind group

The composite pipeline is `layout: "auto"`, so the bind-group layout picks up binding 9 on its own —
no layout object to keep in step.

**Two things this buys.** The detail pass can run *before* super resolution, at render size, where it
is ~10x cheaper and inside the size it survives. And its result is no longer forced through the
model's own ACES curve, so the engine's tone mapping applies instead — which is where the ~10 %
desaturation came from.

`webgi_display` is left in place: the bundle's own demo still presents through it.
