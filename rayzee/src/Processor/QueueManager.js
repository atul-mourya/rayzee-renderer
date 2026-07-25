/**
 * QueueManager.js — wavefront ray queues: active indices (ping-pong), sorted indices, atomic counters.
 */

import { storage } from 'three/tsl';
import { StorageInstancedBufferAttribute } from 'three/webgpu';
import { freeStorageAttribute } from './PackedRayBuffer.js';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'gpu' );

/** Counter indices — must match ResetCounters kernel */
export const COUNTER = {
	ACTIVE_RAY_COUNT: 0,
	// rays entering current bounce; snapshotted before ACTIVE_RAY_COUNT reset so over-sized dispatch is safe.
	ENTERING_COUNT: 1,
	// per-frame count of pixels whose Tier-1 relative-error dropped below threshold; zeroed at frame start by
	// initActiveIndices, incremented in FinalWrite, read back async to drive the whole-frame convergence early-stop.
	CONVERGED_COUNT: 2,
	// Tier-2 per-pixel freeze: FROZEN_COUNT = pixels skipped this frame; ACTIVE_PIXEL_COUNT = bounce-0 active
	// count (maxRays − frozen), read back to size next frame's grid.
	FROZEN_COUNT: 3,
	ACTIVE_PIXEL_COUNT: 4,
	COUNT: 5,
};

/** Ray flag bits packed into rayBounceFlags (uint) */
export const RAY_FLAG = {
	BOUNCE_MASK: 0xFF, // bits 0-7: bounce count (0-255)
	ACTIVE: 1 << 8, // bit 8: ray is alive
	SPECULAR: 1 << 9, // bit 9: last bounce was specular
	INSIDE_MEDIUM: 1 << 10, // bit 10: ray is inside a transmissive medium
	// bits 11-15: ray type
	RAY_TYPE_SHIFT: 11,
	RAY_TYPE_MASK: 0x1F << 11,
	// bits 16-31: spare per-ray state carried across bounces
	HAS_HIT_OPAQUE: 1 << 16, // bit 16: ray chain has hit non-transmissive geometry (transparent-bg alpha; megakernel hasHitOpaqueSurface)
	AUX_LOCKED: 1 << 17, // bit 17: OIDN aux (normal/albedo) locked onto first non-specular hit (megakernel auxLocked)
	REDIRECTED: 1 << 18, // bit 18: ray has been redirected (refraction/reflection/SSS/opaque scatter) since the camera, so env it reaches is transported light (sharp), NOT the direct backdrop. NOT set by pure alpha/transparent passthrough (direction unchanged) → env through cutout holes is still the backdrop (blur/intensity/show/color/ground-projection). Set via bitOr only (positive mask) so it never disturbs ACTIVE/bounce bits.
};

export class QueueManager {

	/**
	 * @param {number} maxRays - Maximum number of rays (typically width * height)
	 */
	constructor( maxRays = 0, renderer = null ) {

		this._renderer = renderer;
		this.capacity = 0;
		this.counters = null;
		// A/B alternate: one read by current bounce, other written by compaction
		this.activeIndices = null;
		this.activeIndicesRO = null;
		this.sortedIndices = null;
		this.sortedIndicesRO = null;
		this.sortGlobalHistogram = null;
		this.pingPong = 0; // 0 = read A / write B, 1 = read B / write A

		if ( maxRays > 0 ) {

			this.allocate( maxRays );

		}

	}

	// capacity must match RayBufferPool.allocatedCapacity
	allocate( capacity ) {

		this.dispose();
		this.capacity = capacity;

		// explicit attribute (not attributeArray) so it can be referenced for async readback
		this._countersAttr = new StorageInstancedBufferAttribute( new Uint32Array( COUNTER.COUNT ), 1 );
		this.counters = storage( this._countersAttr, 'uint' ).toAtomic();

		// per-bounce ACTIVE_RAY_COUNT snapshots; read back async to size/skip late bounces next frame
		this.MAX_BOUNCE_SNAPSHOTS = 32;
		this._bounceCountsAttr = new StorageInstancedBufferAttribute(
			new Uint32Array( this.MAX_BOUNCE_SNAPSHOTS ), 1,
		);
		this.bounceCounts = storage( this._bounceCountsAttr, 'uint' );

		const attrA = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		const attrB = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		this._attrA = attrA;
		this._attrB = attrB;

		this.activeIndices = {
			a: storage( attrA, 'uint' ),
			b: storage( attrB, 'uint' ),
		};

		// RO reuses the same attribute so RW/RO share one GPU buffer
		this.activeIndicesRO = {
			a: storage( attrA, 'uint' ).toReadOnly(),
			b: storage( attrB, 'uint' ).toReadOnly(),
		};

		// Material-sort output: a material-reordered permutation of the active index
		// list, written by the global material sort and read by Shade in place of activeIndices.
		const sortAttr = new StorageInstancedBufferAttribute( new Uint32Array( capacity ), 1 );
		this._sortAttr = sortAttr;
		this.sortedIndices = storage( sortAttr, 'uint' );
		this.sortedIndicesRO = storage( sortAttr, 'uint' ).toReadOnly();

		// Global material-sort histogram, sized to the bin cap (SORT_GLOBAL_MAX_BINS=256); kernels use
		// only the first `bins` entries (= per-scene material count). 256 × 4B = 1KB.
		this._sortGlobalHistAttr = new StorageInstancedBufferAttribute( new Uint32Array( 256 ), 1 );
		this.sortGlobalHistogram = storage( this._sortGlobalHistAttr, 'uint' ).toAtomic();

		this.pingPong = 0;

		// Kept for the [gpu] startup summary in PathTracer._buildWavefrontKernels.
		this.totalBytes = COUNTER.COUNT * 4 + capacity * 4 * 3;

		log.debug( `queues capacity ${fmt.n( capacity )} · ${fmt.mb( this.totalBytes )}` );

	}

	// returns true if reallocation occurred
	resize( capacity ) {

		if ( capacity <= this.capacity && this.capacity > 0 ) return false;
		this.allocate( capacity );
		return true;

	}

	getCounters() {

		return this.counters;

	}

	getActiveReadRO() {

		return this.pingPong === 0 ? this.activeIndicesRO.a : this.activeIndicesRO.b;

	}

	// RW version for compaction input
	getActiveRead() {

		return this.pingPong === 0 ? this.activeIndices.a : this.activeIndices.b;

	}

	getActiveWrite() {

		return this.pingPong === 0 ? this.activeIndices.b : this.activeIndices.a;

	}

	getSortedRW() {

		return this.sortedIndices;

	}

	getSortedRO() {

		return this.sortedIndicesRO;

	}

	getSortGlobalHistogram() {

		return this.sortGlobalHistogram;

	}

	// raw attribute for `renderer.getArrayBufferAsync(...)` readback
	getCountersAttribute() {

		return this._countersAttr;

	}

	getBounceCounts() {

		return this.bounceCounts;

	}

	getBounceCountsAttribute() {

		return this._bounceCountsAttr;

	}

	swap() {

		this.pingPong = 1 - this.pingPong;

	}

	resetPingPong() {

		this.pingPong = 0;

	}

	dispose() {

		// Free the GPU buffers before dropping the node references (nulling alone leaks them).
		freeStorageAttribute( this._renderer, this._countersAttr );
		freeStorageAttribute( this._renderer, this._bounceCountsAttr );
		freeStorageAttribute( this._renderer, this._attrA );
		freeStorageAttribute( this._renderer, this._attrB );
		freeStorageAttribute( this._renderer, this._sortAttr );
		freeStorageAttribute( this._renderer, this._sortGlobalHistAttr );
		this._countersAttr = this._bounceCountsAttr = null;
		this._attrA = this._attrB = this._sortAttr = this._sortGlobalHistAttr = null;

		this.counters = null;
		this.activeIndices = null;
		this.activeIndicesRO = null;
		this.sortedIndices = null;
		this.sortedIndicesRO = null;
		this.sortGlobalHistogram = null;
		this.capacity = 0;

	}

}
