/**
 * HostMemory.js — CPU-side counterpart to VRAMTracker: what a scene will cost in JS memory,
 * whether this session can still place it, and where the peak actually went.
 *
 * The wall at this scale is not RAM, it is contiguous *address space*: a 40M-triangle Moana
 * needs ~7.3 GB of ArrayBuffer and a freshly booted renderer can place ~7.0-7.7 GB in 64 MB
 * pieces, so the same build loads after a reboot and fails after hours of uptime.
 *
 * ⚠️ A probe is only cheap when it is small. On an idle page, 8.6 GB of 64 MB buffers is placed
 * and released in 102 ms and never shows up as resident memory. Run the same probe while the
 * parse still holds 3.6 GB and the renderer goes to 9.2 GB resident and the load takes twice as
 * long — the probe's own peak is added to the build's. So the up-front check is an estimate
 * against a known ceiling, with no allocation at all, and the probe is saved for the one step
 * that actually runs out (BVH assembly), where it asks only for that step's bytes.
 */

import { TRIANGLE_DATA_LAYOUT } from '../EngineDefaults.js';
import { DEFAULT_CHUNK_BYTES } from './ChunkedRecords.js';

/** Bytes one stored triangle occupies in the triangle records. */
const TRIANGLE_BYTES = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE * 4;

/** Bytes per BVH node: 16 floats, 4 vec4s. */
const BVH_NODE_BYTES = 64;

/**
 * BVH nodes per stored triangle, measured on Moana: 35.0M triangles → 29.93M nodes (0.855),
 * 40.0M → 33.20M (0.830). Rounded up, because under-estimating is the failure that matters.
 */
const NODES_PER_TRIANGLE = 0.9;

/** Bytes per placement in the instance table: a mat4 of world transform. */
const PLACEMENT_BYTES = 64;

/** Bytes per triangle of per-template reorder map, one Uint32 each. */
const ORDER_MAP_BYTES = 4;

/** Below this a load cannot plausibly hit the wall, so it is not worth remarking on. */
export const PREFLIGHT_MIN_BYTES = 1536 * 1024 * 1024;

/**
 * What a freshly started renderer could place in 64 MB pieces, measured: 7,040 MB. A scene
 * estimated above this needs a session with its address space still unfragmented, which in
 * practice means a recently restarted browser.
 *
 * Deliberately not a hard limit — it moves with host uptime, and a scene over it still loads
 * on a clean boot. It is the line above which a warning is honest.
 */
export const SAFE_SCENE_BYTES = 7040 * 1024 * 1024;

/**
 * The line past which the build refuses rather than tries.
 *
 * Above this the failure stops being a catchable `Array buffer allocation failed` and becomes a
 * dead renderer process — measured on Moana: 40M (7.3 GB) and 45M (8.5 GB) both load, 50M
 * (~9.7 GB) takes the tab down at 9.4 GB resident with nothing thrown and nothing logged. There
 * is no degrading gracefully past that point, so the only useful behaviour is to say why in
 * advance. Raise it with `new SceneProcessor( { maxSceneBytes } )` to test a bigger rung.
 */
export const MAX_SCENE_BYTES = 9216 * 1024 * 1024;

/** Headroom a single build step wants over its own size before it is called safe. */
export const PREFLIGHT_SAFETY = 1.15;

/** Never probe beyond this, however large the estimate. */
const PROBE_CEILING_BYTES = 12 * 1024 * 1024 * 1024;

/**
 * Byte cost of the CPU structures a scene of this shape will hold once built.
 *
 * `geometryBytes` is the three.js geometry the caller already owns — it is not allocated by the
 * build, but it stays resident for picking, transforms and raster, so it counts against the same
 * address space.
 *
 * @param {{triangles: number, placements: number, geometryBytes?: number}} scene
 * @returns {{total: number, triangles: number, bvh: number, geometry: number,
 *   placements: number, orderMaps: number}} bytes
 */
export function estimateSceneBytes( { triangles, placements, geometryBytes = 0 } ) {

	const parts = {
		triangles: triangles * TRIANGLE_BYTES,
		bvh: Math.ceil( triangles * NODES_PER_TRIANGLE ) * BVH_NODE_BYTES,
		geometry: geometryBytes,
		placements: placements * PLACEMENT_BYTES,
		orderMaps: triangles * ORDER_MAP_BYTES,
	};

	parts.total = parts.triangles + parts.bvh + parts.geometry + parts.placements + parts.orderMaps;
	return parts;

}

/**
 * How many bytes this process can still place in chunk-sized pieces, right now.
 *
 * Allocates untouched buffers, so no physical page is committed and the probe costs
 * milliseconds; they are released in reverse so the address space is handed back in the same
 * shape it was taken. Stops at `wantBytes` — a probe only has to answer "is there room for
 * this scene", and probing to exhaustion on every load would be both slow and rude.
 *
 * @param {number} wantBytes
 * @param {{chunkBytes?: number, shared?: boolean, allocate?: function(number): Object}} [options]
 *   `allocate` exists so the failure path can be tested; nothing in the engine passes it.
 * @returns {{placed: number, want: number, exhausted: boolean, capped: boolean}} `exhausted`
 *   means the allocator gave up first; `capped` means the request was larger than this function
 *   will ever probe, so a non-exhausted result proves only that `want` fits, not `wantBytes`.
 */
export function probeAddressSpace( wantBytes, {
	chunkBytes = DEFAULT_CHUNK_BYTES,
	shared = false,
	allocate = null,
} = {} ) {

	const want = Math.min( wantBytes, PROBE_CEILING_BYTES );
	const alloc = allocate ?? ( shared ? n => new SharedArrayBuffer( n ) : n => new ArrayBuffer( n ) );
	const chunks = [];
	let placed = 0;

	try {

		while ( placed < want ) {

			const n = Math.min( chunkBytes, want - placed );
			chunks.push( alloc( n ) );
			placed += n;

		}

	} catch {

		// An allocation failure is the answer, not an error.

	}

	// Reverse, so the allocator unwinds the same order it filled.
	for ( let i = chunks.length - 1; i >= 0; i -- ) chunks[ i ] = null;
	chunks.length = 0;

	return { placed, want, exhausted: placed < want, capped: wantBytes > want };

}

/**
 * Phase-tagged record of what the build allocated and what stayed live.
 *
 * Chunk allocations are pushed in by {@link ChunkedRecords} through its observer hook, so the
 * ledger sees every chunk without the storage knowing anything about it. Frees are not
 * observable — a chunk goes away when the last reference does — so `live` comes from explicit
 * {@link MemoryLedger#sample} calls at phase boundaries, where the build knows what it is still
 * holding. Cumulative allocation and live peak answer different questions and both are kept.
 */
export class MemoryLedger {

	constructor() {

		this.reset();

	}

	reset() {

		this.phase = 'idle';
		this.events = [];
		this.samples = [];
		this.allocatedBytes = 0;
		this.peakLiveBytes = 0;
		this.byPhase = Object.create( null );

	}

	/** Name the phase that subsequent allocations belong to. */
	mark( phase ) {

		this.phase = phase;
		this.byPhase[ phase ] ??= { allocated: 0, chunks: 0 };
		return this;

	}

	/** Record an allocation of `bytes` attributed to the current phase. */
	alloc( bytes, what = 'chunk' ) {

		if ( ! ( bytes > 0 ) ) return;

		const bucket = ( this.byPhase[ this.phase ] ??= { allocated: 0, chunks: 0 } );
		bucket.allocated += bytes;
		bucket.chunks ++;
		this.allocatedBytes += bytes;
		this.events.push( { phase: this.phase, bytes, what, at: performance.now() } );

	}

	/**
	 * Record what is live right now. The build passes the sizes it can actually account for;
	 * anything it has already dropped is simply absent, which is the point.
	 * @param {string} label
	 * @param {Object<string, number>} parts - byte size per named structure
	 */
	sample( label, parts ) {

		let total = 0;
		for ( const k in parts ) total += parts[ k ] || 0;
		if ( total > this.peakLiveBytes ) this.peakLiveBytes = total;
		this.samples.push( { label, phase: this.phase, total, parts, at: performance.now() } );
		return total;

	}

	/** A plain object for logging or handing to a host. */
	get report() {

		return {
			allocatedBytes: this.allocatedBytes,
			peakLiveBytes: this.peakLiveBytes,
			byPhase: { ...this.byPhase },
			samples: this.samples.slice(),
		};

	}

}
