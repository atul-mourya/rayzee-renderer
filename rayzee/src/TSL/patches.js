/**
 * Rayzee patches for Three.js / TSL.
 *
 * Side-effect on import: installs two `WebGPUBackend.prototype` overrides —
 * `createNodeBuilder` (restores r183 function-scoped `var` emission for compute
 * shaders, preventing a register-allocation regression in the path tracer's hot
 * loop) and `initTimestampQuery` (enlarges the stats-gl timestamp query pool so
 * the wavefront tracer's high per-frame compute-pass count doesn't overflow it).
 *
 * Exports: `struct()` — drop-in replacement for TSL's `struct()` returning
 * a proxy factory that supports GLSL-style dot-notation field access — and
 * `gpuOnlyStorageAttribute()`, a storage attribute with no CPU backing array.
 */

import { StorageInstancedBufferAttribute, WebGPUBackend } from 'three/webgpu';
import { struct as _struct } from 'three/tsl';

// ---------------------------------------------------------------------------
// 1. WGSL global-variable promotion patch (compute-only)
// ---------------------------------------------------------------------------
// Three.js r184 introduced `WGSLNodeBuilder.allowGlobalVariables = true`, which
// emits `.toVar()` declarations at WGSL module scope as `var<private> name : T`
// instead of function-local `var name : T` inside `fn main()` (as r183 did).
//
// For compute shaders with hundreds of `.toVar()` calls in loops (e.g. the BVH
// traversal + BRDF path tracer), `var<private>` increases GPU register pressure
// because the Dawn/Chromium WGSL compiler cannot aggressively register-allocate
// variables with a stable per-invocation memory address. We measured a ~8% fps
// regression (120 → 110) on the path tracer after upgrading r183 → r184 that
// traced entirely to GPU execution, not CPU.
//
// `allowGlobalVariables` is ONLY consumed by the compute template
// (`_getWGSLComputeCode`). The vertex/fragment templates always emit
// `shaderData.vars` at module scope and REQUIRE `allowGlobalVariables=true`
// (emitting function-local `var` at module scope is invalid WGSL and crashes
// pipeline creation with "Invalid ShaderModule"). We install a per-instance
// accessor that returns `false` only when the builder is for a compute node
// (material === null) and `true` otherwise, so render pipelines keep r184
// behavior untouched.
//
// Relevant upstream lines:
//  - `node_modules/three/src/renderers/webgpu/nodes/WGSLNodeBuilder.js:247`
//    (`this.allowGlobalVariables = true`)
//  - `...WGSLNodeBuilder.js:2458` (module-scope vars block)
//  - `...WGSLNodeBuilder.js:2467` (function-body vars block)
//
// Revisit if upstream adds an official opt-out or fixes register pressure.

const _origCreateNodeBuilder = WebGPUBackend.prototype.createNodeBuilder;

WebGPUBackend.prototype.createNodeBuilder = function ( object, renderer ) {

	const builder = _origCreateNodeBuilder.call( this, object, renderer );

	Object.defineProperty( builder, 'allowGlobalVariables', {
		get() {

			return this.material !== null;

		},
		set() { /* ignore — the value is derived from material presence */ },
		configurable: true,
	} );

	// Install the workgroup-atomic-array codegen patch (section 4) lazily off the
	// first builder, so we don't need to import WGSLNodeBuilder directly.
	_installScopedArrayAtomicPatch( builder );

	return builder;

};

// ---------------------------------------------------------------------------
// 1b. GPU-only storage attributes
// ---------------------------------------------------------------------------
// `StorageBufferAttribute( count, ... )` always allocates a CPU TypedArray, even
// for a buffer only compute shaders ever touch — three.js has no GPU-only path
// (upstream request open). The wavefront ray/hit/rng state and the per-pixel
// G-buffer are exactly that: every lane is written by a kernel before anything
// reads it, nothing is ever read back, and WebGPU zero-initialises a new buffer,
// so the CPU copy is pure overhead — 704 MB at a 4M path budget.
//
// `gpuOnlyStorageAttribute()` builds the attribute over a zero-length array and
// records the size the GPU buffer needs; `createStorageAttribute` below allocates
// that size unmapped, and `updateAttribute` becomes a no-op since there is
// nothing to upload. Everything else (binding, dispose, readback plumbing) is
// untouched — a storage binding takes the whole buffer with no size argument.

export function gpuOnlyStorageAttribute( count, itemSize, typeClass = Float32Array ) {

	const attr = new StorageInstancedBufferAttribute( new typeClass( 0 ), itemSize );
	attr.count = count;
	attr.gpuByteLength = count * itemSize * typeClass.BYTES_PER_ELEMENT;
	attr.isGPUOnly = true;
	return attr;

}

const _origCreateStorageAttribute = WebGPUBackend.prototype.createStorageAttribute;

WebGPUBackend.prototype.createStorageAttribute = function ( attribute ) {

	const bufferAttribute = this.attributeUtils._getBufferAttribute( attribute );
	if ( ! bufferAttribute.isGPUOnly ) return _origCreateStorageAttribute.call( this, attribute );

	const data = this.get( bufferAttribute );
	if ( data.buffer !== undefined ) return;

	data.buffer = this.device.createBuffer( {
		label: bufferAttribute.name,
		size: bufferAttribute.gpuByteLength,
		usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
	} );

};

/**
 * Upload a storage attribute's contents from several CPU chunks.
 *
 * A GPU buffer may be up to `maxBufferSize` (4 GB here) while V8 caps a single ArrayBuffer at
 * ~2 GB, so anything larger has to be staged in pieces. The attribute must be GPU-only: it owns
 * no CPU array, and these writes are the only thing that fills it.
 *
 * @param {Object} renderer - WebGPURenderer
 * @param {Object} attr - attribute from gpuOnlyStorageAttribute()
 * @param {Array<TypedArray>} chunks - in order; total byte length must match the attribute
 */
export function uploadStorageChunks( renderer, attr, chunks ) {

	const backend = renderer.backend;
	backend.createStorageAttribute( attr );

	const buffer = backend.get( attr ).buffer;
	let byteOffset = 0;

	for ( const chunk of chunks ) {

		backend.device.queue.writeBuffer( buffer, byteOffset, chunk, 0, chunk.length );
		byteOffset += chunk.byteLength;

	}

	if ( byteOffset !== attr.gpuByteLength ) {

		throw new RangeError( `uploadStorageChunks wrote ${byteOffset} bytes into a ${attr.gpuByteLength}-byte buffer` );

	}

}

const _origUpdateAttribute = WebGPUBackend.prototype.updateAttribute;

WebGPUBackend.prototype.updateAttribute = function ( attribute ) {

	if ( this.attributeUtils._getBufferAttribute( attribute ).isGPUOnly ) return;
	return _origUpdateAttribute.call( this, attribute );

};

// ---------------------------------------------------------------------------
// 2. Larger timestamp query pool (stats-gl GPU/compute timing)
// ---------------------------------------------------------------------------
// Three.js lazily creates each timestamp query pool with a hardcoded 2048
// queries (= 1024 passes) — `WebGPUBackend.initTimestampQuery` / the upstream
// `// TODO: Variable maxQueries?`. The wavefront tracer issues hundreds of
// compute passes per frame (peak right after a maxBounces change: the survivor
// curve is invalid, so the bounce loop runs the full `loopBound` at full
// dispatch with no early-exit — ~560 passes / 1124 queries at production
// settings). stats-gl resolves once per frame, but the resolve is async and
// `mapAsync` lags several frames under that GPU load, so the counter isn't reset
// before it overflows → "Maximum number of queries exceeded" + dropped timings.
//
// Two parts:
//   a) Grow the pool to 4096 queries on first use. 4096 is the WebGPU hard cap on
//      a query set's count ("Query count exceeds the maximum query count (4096)")
//      — 2× the upstream default, the most a single pool can hold (~2048 passes).
//      That alone fully covers the interactive case (~200 passes/frame); anything
//      larger fails CreateQuerySet validation.
//   b) When even 4096 isn't enough (production spike), degrade gracefully: skip
//      tracking the overflow passes silently instead of `warnOnce` + an invalid
//      descriptor. The reported compute ms briefly undercounts during the spike;
//      rendering is never affected (timestamps don't gate compute correctness).
const TIMESTAMP_POOL_MAX_QUERIES = 4096;

// Drop-in for the pool's allocateQueriesForContext minus the warnOnce on overflow
// — returns null silently when full so the pass is cleanly skipped (see below).
function _allocateQueriesSilently( uid ) {

	if ( ! this.trackTimestamp || this.isDisposed ) return null;
	if ( this.currentQueryIndex + 2 > this.maxQueries ) return null; // full: skip, no warn
	const baseOffset = this.currentQueryIndex;
	this.currentQueryIndex += 2;
	this.queryOffsets.set( uid, baseOffset );
	return baseOffset;

}

const _origInitTimestampQuery = WebGPUBackend.prototype.initTimestampQuery;

WebGPUBackend.prototype.initTimestampQuery = function ( type, uid, descriptor ) {

	const poolWasMissing = this.trackTimestamp && ! this.timestampQueryPool[ type ];

	_origInitTimestampQuery.call( this, type, uid, descriptor );

	// (a) First use: replace the fresh 2048 pool with a 4096 one of the same class,
	// migrating the single allocation just made (offset 0) and re-pointing this
	// pass's descriptor. Safe — first pass of the first tracked frame, nothing in
	// flight. Swap in the silent allocator so future overflows don't warn.
	if ( poolWasMissing ) {

		const pool = this.timestampQueryPool[ type ];
		if ( pool && pool.maxQueries < TIMESTAMP_POOL_MAX_QUERIES && descriptor.timestampWrites ) {

			const Pool = pool.constructor;
			const bigPool = new Pool( this.device, type, TIMESTAMP_POOL_MAX_QUERIES );
			bigPool.allocateQueriesForContext = _allocateQueriesSilently;
			bigPool.allocateQueriesForContext( uid ); // re-take offset 0 for this pass
			this.timestampQueryPool[ type ] = bigPool;
			descriptor.timestampWrites.querySet = bigPool.querySet; // offsets 0/1 unchanged
			pool.dispose(); // nothing in flight — first pass of the first tracked frame

		}

	}

	// (b) On overflow the (silent) allocator returns null, but upstream still wrote
	// a descriptor with a null begin index — which both collides on slot 1 and is
	// invalid. Drop it so the pass is cleanly untimed.
	const tw = descriptor.timestampWrites;
	if ( tw && tw.beginningOfPassWriteIndex == null ) descriptor.timestampWrites = undefined;

};

// ---------------------------------------------------------------------------
// 3. TSL struct proxy — enables GLSL-style dot-notation field access
// ---------------------------------------------------------------------------
// TSL structs require `.get('fieldName')` for member access, but GLSL-style
// dot notation (`.fieldName`) is more natural and matches ported code.
//
// This wraps TSL's `struct()` so that:
//  - Direct construction: `MyStruct({...}).toVar('x')` → `.fieldName` works
//  - Fn return values:    `MyStruct.wrap(someFn(...))` → `.fieldName` works
//
// Property access for known struct member names is redirected to `.get('name')`.
// Swizzle properties (x, y, z, w, etc.), Node methods (.add, .assign, etc.), and
// other standard properties pass through to the underlying node unmodified.

function createStructProxy( node, memberSet ) {

	return new Proxy( node, {

		get( target, prop, receiver ) {

			// Intercept known struct member names
			if ( typeof prop === 'string' && memberSet.has( prop ) ) {

				return target.get( prop );

			}

			const val = Reflect.get( target, prop, receiver );

			// Intercept .toVar() to proxy-wrap the result
			if ( prop === 'toVar' && typeof val === 'function' ) {

				return ( ...args ) => createStructProxy( val.apply( target, args ), memberSet );

			}

			return val;

		}

	} );

}

/**
 * Drop-in replacement for TSL's `struct()` that returns a proxy-enhanced factory.
 *
 * The returned factory:
 *  - Creates struct nodes where `.toVar()` results support dot-notation field access
 *  - Has `.wrap(node)` method to proxy-wrap Fn return values for field access
 *  - Has `.layout` and `.isStruct` matching the original TSL struct API
 *
 * @param {Object} members - Struct member layout (e.g., { didHit: 'bool', dst: 'float' })
 * @param {string|null} name - Optional struct name
 * @returns {Function} Enhanced struct factory
 */
export function struct( members, name = null ) {

	const factory = _struct( members, name );
	const memberSet = new Set( Object.keys( members ) );

	const wrappedFactory = ( ...args ) => {

		const node = factory( ...args );
		return createStructProxy( node, memberSet );

	};

	wrappedFactory.layout = factory.layout;
	wrappedFactory.isStruct = true;

	/**
	 * Wrap an existing node (e.g., Fn return value) with struct field access proxy.
	 * Usage: `const hit = HitInfo.wrap(traverseBVH(...).toVar('hit'));`
	 */
	wrappedFactory.wrap = ( node ) => createStructProxy( node, memberSet );

	return wrappedFactory;

}

// ---------------------------------------------------------------------------
// 4. Workgroup-scoped atomic arrays — var<workgroup> array<atomic<T>, N>
// ---------------------------------------------------------------------------
// TSL's `workgroupArray(type, count)` emits `var<workgroup> name: array<T, N>`
// (`WGSLNodeBuilder.getScopedArrays`, r185 ~line 1773) with a NON-atomic element
// type, so `atomicAdd(arr.element(i), v)` fails WGSL validation. AtomicFunctionNode
// is itself address-space-agnostic — it emits `atomicAdd(&name[i], v)`, valid for
// BOTH storage and workgroup pointers — so the ONLY missing piece is the
// declaration. This patch adds `workgroupAtomicArray()` (a `workgroupArray` tagged
// atomic) and overrides `getScopedArrays` to wrap the element type in `atomic<…>`
// for tagged arrays, enabling true on-chip workgroup-shared atomics (e.g. fast
// per-workgroup histograms) instead of the slow global-storage-atomic fallback.
// Access tagged arrays ONLY via atomic ops (atomicAdd/atomicLoad/atomicStore).

import { workgroupArray } from 'three/tsl';

const _WorkgroupInfoNode = workgroupArray( 'uint', 1 ).constructor;

// Tag the node so the patched getScopedArrays emits an atomic element type. The
// array's WGSL name is only known after generate() runs, so we mark the builder's
// scopedArrays entry there (idempotent across analyze/generate passes).
const _origWorkgroupGenerate = _WorkgroupInfoNode.prototype.generate;

_WorkgroupInfoNode.prototype.generate = function ( builder ) {

	const name = _origWorkgroupGenerate.call( this, builder );
	if ( this.isAtomicArray === true ) {

		const entry = builder.scopedArrays && builder.scopedArrays.get( name );
		if ( entry ) entry.isAtomic = true;

	}

	return name;

};

/**
 * Like `workgroupArray(type, count)` but declares the workgroup buffer with an
 * atomic element type: `var<workgroup> name: array<atomic<type>, count>`.
 * Elements MUST be accessed only via atomic ops (atomicAdd/atomicLoad/atomicStore).
 *
 * @param {string} type - Element type (e.g. 'uint').
 * @param {number} count - Number of elements.
 * @returns {WorkgroupInfoNode} The tagged workgroup array node.
 */
export function workgroupAtomicArray( type, count ) {

	const node = workgroupArray( type, count );
	node.isAtomicArray = true;
	return node;

}

let _scopedArraysPatched = false;

// Override getScopedArrays on the builder's prototype (compute-stage WGSL
// assembly) to emit `atomic<T>` element types for tagged workgroup arrays.
// Installed once, lazily, off the first node builder created.
function _installScopedArrayAtomicPatch( builder ) {

	if ( _scopedArraysPatched ) return;
	const proto = Object.getPrototypeOf( builder );
	if ( ! proto || typeof proto.getScopedArrays !== 'function' ) return;

	proto.getScopedArrays = function ( shaderStage ) {

		if ( shaderStage !== 'compute' ) return;

		const snippets = [];
		for ( const { name, scope, bufferType, bufferCount, isAtomic } of this.scopedArrays.values() ) {

			const type = this.getType( bufferType );
			const elementType = ( isAtomic === true ) ? `atomic< ${ type } >` : type;
			snippets.push( `var<${ scope }> ${ name }: array< ${ elementType }, ${ bufferCount } >;` );

		}

		return snippets.join( '\n' );

	};

	_scopedArraysPatched = true;

}
