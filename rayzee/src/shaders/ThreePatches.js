/**
 * Rayzee patches for Three.js / TSL.
 *
 * Side-effect on import: installs `WebGPUBackend.prototype` overrides —
 * `createNodeBuilder` (restores r183 function-scoped `var` emission for compute
 * shaders, preventing a register-allocation regression in the path tracer's hot
 * loop), `createStorageAttribute` / `updateAttribute` (GPU-only storage),
 * `initTimestampQuery` (enlarges the timestamp query pool so the
 * wavefront tracer's high per-frame compute-pass count doesn't overflow it) and
 * `createProgram` (compute functions' own variables under WebKit's 8 KB).
 *
 * Exports `gpuOnlyStorageAttribute()`, a storage attribute with no CPU backing array.
 */

import { StorageInstancedBufferAttribute, WebGPUBackend } from 'three/webgpu';

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

	const bufferAttribute = this.getBufferAttribute( attribute );
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
 * GPU-only storage attributes standing for one array too large for a single binding: lane l lives in part
 * ⌊l / lanesPerPart⌋, and a part holds whole records, so no record straddles two. Read through `splitStorage`
 * (shaders/Common.js).
 */
export class StorageParts {

	/**
	 * @param {number} totalLanes
	 * @param {number} lanesPerRecord
	 * @param {number} maxPartBytes - at most maxStorageBufferBindingSize
	 * @param {Function} [LaneType]
	 * @param {number} [itemSize] - lanes an element: 4 for vec4 storage, 2 for vec2
	 */
	constructor( totalLanes, lanesPerRecord, maxPartBytes, LaneType = Float32Array, itemSize = 4 ) {

		this.LaneType = LaneType;
		this.itemSize = itemSize;
		this.lanesPerPart = Math.max( 1, Math.floor( maxPartBytes / ( lanesPerRecord * LaneType.BYTES_PER_ELEMENT ) ) ) * lanesPerRecord;
		this.totalLanes = totalLanes;
		this.attrs = [];
		for ( let at = 0; at < totalLanes || this.attrs.length === 0; at += this.lanesPerPart ) {

			const lanes = Math.max( lanesPerRecord, Math.min( this.lanesPerPart, totalLanes - at ) );
			this.attrs.push( gpuOnlyStorageAttribute( lanes / itemSize, itemSize, LaneType ) );

		}

	}

	/** Elements a full part holds. */
	get elementsPerPart() {

		return this.lanesPerPart / this.itemSize;

	}

	/** Creates every part's GPU buffer now. */
	create( backend ) {

		for ( const attr of this.attrs ) backend.createStorageAttribute( attr );

	}

	/** Writes `count` lanes of `src` from `srcOffset` to lane `lane`, across a part boundary if need be. */
	write( backend, lane, src, srcOffset, count ) {

		const bytes = this.LaneType.BYTES_PER_ELEMENT;
		while ( count > 0 ) {

			const p = Math.floor( lane / this.lanesPerPart );
			const local = lane - p * this.lanesPerPart;
			const n = Math.min( count, this.lanesPerPart - local );
			const attr = this.attrs[ p ];
			backend.createStorageAttribute( attr );
			backend.device.queue.writeBuffer( backend.get( attr ).buffer, local * bytes, src, srcOffset, n );
			lane += n;
			srcOffset += n;
			count -= n;

		}

	}

	/** Writes lanes [startLane, startLane + laneCount) of chunked `records`. */
	writeRecords( backend, records, startLane, laneCount ) {

		const lanesPerChunk = records.recordsPerChunk * records.lanesPerRecord;
		for ( let lane = startLane, end = startLane + laneCount; lane < end; ) {

			const ci = Math.floor( lane / lanesPerChunk );
			const chunk = records.chunks[ ci ];
			if ( ! chunk ) throw new Error( `chunk ${ci} is on disk and was never uploaded` );
			const local = lane - ci * lanesPerChunk;
			const n = Math.min( chunk.length - local, end - lane );
			this.write( backend, lane, chunk, local, n );
			lane += n;

		}

	}

}

const _origUpdateAttribute = WebGPUBackend.prototype.updateAttribute;

WebGPUBackend.prototype.updateAttribute = function ( attribute ) {

	if ( this.getBufferAttribute( attribute ).isGPUOnly ) return;
	return _origUpdateAttribute.call( this, attribute );

};

// ---------------------------------------------------------------------------
// 2. Larger timestamp query pool (GPU timing)
// ---------------------------------------------------------------------------
// Three.js lazily creates each timestamp query pool with a hardcoded 2048
// queries (= 1024 passes) — `WebGPUBackend.initTimestampQuery` / the upstream
// `// TODO: Variable maxQueries?`. The wavefront tracer issues hundreds of
// compute passes per frame (peak right after a maxBounces change: the survivor
// curve is invalid, so the bounce loop runs the full `loopBound` at full
// dispatch with no early-exit — ~560 passes / 1124 queries at production
// settings). The app's stats strip resolves once per frame, but the resolve is async and
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

// ---------------------------------------------------------------------------
// 3. Compute functions' own variables under 8 KB
// ---------------------------------------------------------------------------
// WGSL caps the bytes of a function's `var`s at 8,192; WebKit enforces it, Dawn does not, and TSL declares every
// `.toVar()` at the top of its function. A variable written once and read only after that, in its block, becomes a
// `let`, which takes none; the rest share a slot with variables of their type whose uses never overlap. Only TSL's own
// `nodeVar` names are touched.

const VAR_DECLARATION = /^[ \t]*var (nodeVar\d+) : ([^;=\n]+);[ \t]*\n/gm;
const VAR_USE = /(?<![\w.])(&\s*)?(nodeVar\d+)\b/g;
const ASSIGNMENT = /^\s*(?:[-+*/%&|^]|<<|>>)?=(?!=)|^\s*(?:\+\+|--)/;

/** Rewrites every function of a WGSL module so its own variables take as few bytes as they can. */
function compactFunctionVariables( code ) {

	let out = '';
	let cursor = 0;
	for ( const header of code.matchAll( /\bfn\s+\w+\s*\(/g ) ) {

		const open = code.indexOf( '{', header.index );
		if ( open < cursor ) continue;
		let depth = 0;
		let close = open;
		for ( ; close < code.length; close ++ ) {

			const c = code.charCodeAt( close );
			if ( c === 123 ) depth ++;
			else if ( c === 125 && -- depth === 0 ) break;

		}

		out += code.slice( cursor, open ) + compactBody( code.slice( open, close + 1 ) );
		cursor = close + 1;

	}

	return out + code.slice( cursor );

}

function compactBody( body ) {

	// Blocks in order of opening; a loop's starts at its header, which runs on every iteration.
	const blocks = [];
	const open = [];
	for ( let i = 0; i < body.length; i ++ ) {

		const c = body.charCodeAt( i );
		if ( c === 123 ) {

			const parent = open.at( - 1 ) ?? null;
			const lineStart = Math.max( body.lastIndexOf( '\n', i ) + 1, parent ? parent.open + 1 : 0 );
			const loop = /^\s*(?:for|loop|while)\b/.test( body.slice( lineStart, i ) );
			const block = { open: i, close: body.length, from: loop ? lineStart : i, loop, parent };
			blocks.push( block );
			open.push( block );

		} else if ( c === 125 ) open.pop().close = i;

	}

	// TSL declares them before any code: a slot's name must be in scope wherever it is used.
	const vars = new Map();
	const top = blocks[ 1 ]?.open ?? body.length;
	for ( const m of body.matchAll( VAR_DECLARATION ) ) {

		if ( m.index < top ) vars.set( m[ 1 ], { name: m[ 1 ], type: m[ 2 ].trim(), start: m.index, end: m.index + m[ 0 ].length, uses: [] } );

	}

	if ( vars.size === 0 ) return body;

	const root = blocks[ 0 ];
	let next = 0;
	const active = [];
	for ( const m of body.matchAll( VAR_USE ) ) {

		const v = vars.get( m[ 2 ] );
		if ( ! v || ( m.index >= v.start && m.index < v.end ) ) continue;
		while ( next < blocks.length && blocks[ next ].from <= m.index ) {

			while ( active.length && active.at( - 1 ).close < blocks[ next ].from ) active.pop();
			active.push( blocks[ next ++ ] );

		}

		while ( active.length > 1 && active.at( - 1 ).close < m.index ) active.pop();

		const at = m.index + m[ 0 ].length - m[ 2 ].length;
		let end = m.index + m[ 0 ].length;
		const atStatement = /^\s*$/.test( body.slice( body.lastIndexOf( '\n', m.index ) + 1, m.index ) );
		const def = ! m[ 1 ] && atStatement && /^\s*=(?!=)/.test( body.slice( end, end + 3 ) );
		end = skipMembers( body, end );
		const kind = m[ 1 ] ? 'address' : def ? 'def' : ASSIGNMENT.test( body.slice( end, end + 4 ) ) ? 'write' : 'read';
		v.uses.push( { at, kind, block: active.at( - 1 ), statementEnd: def ? body.indexOf( ';', end ) : at } );

	}

	const edits = [];
	const rename = ( v, name ) => {

		for ( const u of v.uses ) edits.push( { at: u.at, length: v.name.length, text: name } );

	};

	// Read in its own definition (`x = x + 1`), a definition is a write.
	for ( const v of vars.values() ) {

		for ( const d of v.uses ) if ( d.kind === 'def' && v.uses.some( ( u ) => u !== d && u.at > d.at && u.at < d.statementEnd ) ) d.kind = 'write';

	}

	const startsBlock = ( v ) => {

		const first = v.uses[ 0 ];
		return first.kind === 'def' && v.uses.every( ( u ) => u === first || ( u.at > first.statementEnd && u.at < first.block.close ) );

	};

	const shared = [];
	for ( const v of vars.values() ) {

		if ( v.uses.length === 0 ) {

			edits.push( { at: v.start, length: v.end - v.start, text: '' } );
			continue;

		}

		if ( v.uses.some( ( u ) => u.kind === 'address' ) ) continue;

		if ( startsBlock( v ) && v.uses.filter( ( u ) => u.kind !== 'read' ).length === 1 ) {

			edits.push( { at: v.start, length: v.end - v.start, text: '' }, { at: v.uses[ 0 ].at, length: v.name.length, text: `let ${v.name} : ${v.type}` } );
			continue;

		}

		let lo;
		let scope = null;
		if ( startsBlock( v ) ) lo = v.uses[ 0 ].at;
		else {

			// Read before it is written on some path: zero it where its uses begin, unless a loop could carry it.
			scope = v.uses[ 0 ].block;
			while ( scope && ! v.uses.every( ( u ) => u.at > scope.open && u.at < scope.close ) ) scope = scope.parent;
			let looped = false;
			for ( let b = scope; b; b = b.parent ) looped ||= b.loop;
			if ( ! scope || looped ) continue;
			lo = scope.open;
			if ( scope === root ) scope = null;

		}

		let hi = v.uses.at( - 1 ).at;
		for ( const u of v.uses ) {

			for ( let b = u.block; b; b = b.parent ) if ( b.loop && ! ( lo > b.from && lo < b.close ) ) hi = Math.max( hi, b.close );

		}

		shared.push( { v, lo, hi, scope } );

	}

	shared.sort( ( a, b ) => a.lo - b.lo );
	const slots = new Map();
	for ( const s of shared ) {

		const free = slots.get( s.v.type ) ?? [];
		slots.set( s.v.type, free );
		const slot = free.find( ( f ) => f.hi < s.lo );
		if ( ! slot ) {

			free.push( { name: s.v.name, hi: s.hi } );
			continue;

		}

		slot.hi = s.hi;
		edits.push( { at: s.v.start, length: s.v.end - s.v.start, text: '' } );
		rename( s.v, slot.name );
		if ( s.scope ) edits.push( { at: s.scope.open + 1, length: 0, text: `\n${slot.name} = ${s.v.type}();` } );

	}

	// An insertion before a rename at the same place.
	edits.sort( ( a, b ) => a.at - b.at || a.length - b.length );
	let result = '';
	let cursor = 0;
	for ( const e of edits ) {

		result += body.slice( cursor, e.at ) + e.text;
		cursor = e.at + e.length;

	}

	return result + body.slice( cursor );

}

// Past `.member` and `[ index ]` accessors, to where an assignment would start.
function skipMembers( body, i ) {

	for ( ;; ) {

		while ( body.charCodeAt( i ) === 32 || body.charCodeAt( i ) === 9 ) i ++;
		if ( body[ i ] === '.' && /[A-Za-z_]/.test( body[ i + 1 ] ) ) {

			i ++;
			while ( /\w/.test( body[ i ] ) ) i ++;

		} else if ( body[ i ] === '[' ) {

			let depth = 0;
			for ( ; i < body.length; i ++ ) {

				if ( body[ i ] === '[' ) depth ++;
				else if ( body[ i ] === ']' && -- depth === 0 ) break;

			}

			i ++;

		} else return i;

	}

}

const _origCreateProgram = WebGPUBackend.prototype.createProgram;

WebGPUBackend.prototype.createProgram = function ( program ) {

	if ( program.stage !== 'compute' ) return _origCreateProgram.call( this, program );
	const code = program.code;
	program.code = compactFunctionVariables( code );
	try {

		_origCreateProgram.call( this, program );

	} finally {

		program.code = code;

	}

};

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
