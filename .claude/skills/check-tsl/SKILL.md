---
name: check-tsl
description: >
  Validate TSL shader code against known pitfalls. Run this after writing or modifying any TSL
  shader file (rayzee/src/TSL/) to catch common bugs before they become runtime issues.
  Checks for NaN sources, If/Else chains, UV flips, outputNode usage, compute patterns,
  and redundant .toVar() materializations that inflate register pressure.
allowed-tools: Read, Glob, Grep
---

You are a TSL (Three Shading Language) validator for the Rayzee path tracer. Scan the recently modified TSL files and check for known pitfalls.

## How to Find Modified Files
1. Run `git diff --name-only` to find uncommitted changes
2. Filter for files in `rayzee/src/TSL/`, `rayzee/src/Stages/`, `rayzee/src/integrators/`, and any file importing from `three/tsl`
3. Read each modified file

## Validation Checks

### Check 1: If/Else Chain Correctness
**Search for**: Multiple `If(` calls in the same function that should be `If().ElseIf().Else()`
- Separate `If()` blocks = independent WGSL `if` statements (texture samples from "inactive" branches still execute)
- **Fix**: Chain with `.ElseIf()` and `.Else()` for mutually exclusive branches

### Check 2: NaN Sources
**Search for**: `normalize(` calls where the input could be `vec3(0)`
- Miss/background rays have `objectNormal = vec3(0)` → `normalize(vec3(0)) = NaN`
- **Fix**: Guard with `If(hitDistance.lessThan(1e9), ...)` or provide default value

### Check 3: Variable Mutability
**Search for**: Direct assignment to `Fn()` parameters without `.toVar()`
- Fn() parameters are read-only in TSL
- **Fix**: `const localVar = param.toVar()` before mutation

### Check 4: Modulo Operator
**Search for**: `.remainder(` — this method does not exist as a chain
- **Fix**: Use `.mod()` instead

### Check 5: outputNode vs colorNode
**Search for**: `material.colorNode =` in technical render passes (depth, normals, motion vectors)
- `colorNode` forces alpha=1.0 for opaque materials, destroying .w channel data
- **Fix**: Use `material.outputNode =` for technical passes

### Check 6: UV Y-Flip in Screen-Space Shaders
**Search for**: `uv()` used to compute NDC coordinates in QuadMesh stages
- QuadMesh `uv().y = 0` is at the TOP in Three.js WebGPU
- **Fix**: Negate Y: `coord.y.mul(2.0).sub(1.0).negate()`

### Check 7: Compute Shader Patterns
**Search for**: `textureStore(` without `.toWriteOnly()`
- Compute shader texture writes require `.toWriteOnly()`
**Search for**: `workgroupArray(` without corresponding `workgroupBarrier()`
- Shared memory writes must be followed by barrier before reads

### Check 8: StorageTexture Cross-Dispatch Reads
**Search for**: A StorageTexture written in one compute dispatch and read in a subsequent one
- May return zeros — must copy to RenderTarget between dispatches

### Check 9: Redundant `.toVar()` (Register Pressure)
**Search for**: `.toVar()` on values that are used exactly once and never mutated. Each `.toVar()` emits a named WGSL `var` that the compiler must keep live until its last use — redundant ones inflate register pressure for no benefit. On Apple GPUs especially, register spills tank occupancy — measure a Shade change with `npm run bench:kernels` before claiming a win.

**FLAG `.toVar()` as removable when ALL of:**
1. The binding is used **exactly once** in its enclosing `Fn()` scope. Count carefully: uses across `If`/`ElseIf`/`Else`/`Loop` branches each count as a separate use.
2. The binding is **never reassigned** — no `.assign(`, `.addAssign(`, `.mulAssign(`, `.subAssign(`, `.divAssign(` on it.
3. The right-hand expression is **trivial**: `.add`/`.sub`/`.mul`/`.div`/`.negate`, basic `dot`/`abs`/`max`/`min`/`clamp`, `select()`, or field access.

**DO NOT FLAG (keep `.toVar()`) when:**
- Used in multiple branches, even if each branch uses it once.
- Expression contains `normalize`, `sqrt`, `cos`, `sin`, `exp`, `log`, `pow`, or a `Fn()`/`wgslFn` call — these are expensive and worth materializing.
- It's a struct construction (`SomeStruct({...}).toVar()`) that will be mutated through field assigns.
- It's the result of `RandomValue(rngState)` or `pcgHash(rngState)` — RNG state ordering matters; removing `.toVar()` can let TSL reorder calls.
- It's followed anywhere in scope by an `.assign()` family mutation.
- It's a loop iteration variable or accumulator (`addAssign` in a `Loop`).
- It's a texture sample — without `.toVar()` the sample may re-execute on each access.

**Fix**: Remove the `.toVar()` decoration. The expression inlines at its single use site; the compiler is free to keep the value in a register only across the consuming op rather than the entire scope.

**Verification**: After removal, verify the variable name doesn't appear in any `.assign`/`.addAssign`/etc. — false positives from variable-name shadowing across `Fn()` scopes are common; the mutation must be in the **same** scope as the binding.

### Check 10: Module-Level Shader State
**Search for**: a module-level `let`/`const` holding a texture, node or uniform that a `Fn()` body reads, or a setter that assigns one (e.g. `setXTexture( tex ) { moduleVar = tex }`)
- A `Fn()` body runs at kernel compile, so module state is read from whichever renderer set it last (two renderers in one page, or a later stage, overwrite it)
- **Fix**: pass it in the kernel's build context — `withSceneResources( kernelCall, resources )` at the root, `sceneResources( builder )` in the body (`TSL/SceneResources.js`)

## Output Format
For each file checked, report:
```
## filename.js
- [PASS] Check 1: If/Else chains
- [WARN] Check 2: NaN risk at line 42 — normalize() without hit guard
- [PASS] Check 3: Variable mutability
...
```

If all checks pass: "All TSL validation checks passed."
If issues found: List each with file, line, and suggested fix.
