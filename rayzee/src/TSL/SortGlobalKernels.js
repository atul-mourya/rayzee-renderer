/**
 * SortGlobalKernels.js — GLOBAL material counting sort of the entering rays.
 *
 * Unlike a per-workgroup sort (locally coherent only), this orders rays by material
 * ACROSS ALL workgroups, so each material's rays occupy one contiguous region of sortedIndices.
 * For materials with many rays that means whole material-PURE workgroups/subgroups → real shading
 * coherence. MEASURED −8% vs no-sort at 1024²/8b (per-WG sort was neutral).
 *
 * Four passes (counting sort): reset → histogram → exclusive prefix sum → scatter.
 *   - histogram uses a per-workgroup local histogram (workgroup-shared atomics, patches.js §4)
 *     flushed to the global histogram once per bin per workgroup, cutting global-atomic contention
 *     from O(rays) to O(workgroups × bins).
 *   - the prefix-summed histogram doubles as the per-bin running cursor in scatter.
 *
 * `bins` is chosen per-scene by the caller (= material count, capped). Materials ≥ bins clamp into
 * the last bin (graceful coherence loss). Capped at SORT_GLOBAL_MAX_BINS so a single 256-thread
 * workgroup can zero/flush exactly one bin per thread (no per-thread loop needed).
 */

import {
	Fn, uint,
	If, Loop,
	instanceIndex, localId,
	workgroupBarrier,
	atomicAdd, atomicLoad, atomicStore,
} from 'three/tsl';

import { workgroupAtomicArray } from './patches.js';
import { readHitMaterialIndex } from '../Processor/PackedRayBuffer.js';
import { COUNTER } from '../Processor/QueueManager.js';

const WG_SIZE = 256;
export const SORT_GLOBAL_MAX_BINS = 256;

// Pass 1 — zero the global histogram.
export function buildResetGlobalHistKernel( { sortGlobalHistogram, bins = SORT_GLOBAL_MAX_BINS } ) {

	return Fn( () => {

		If( instanceIndex.lessThan( uint( bins ) ), () => {

			atomicStore( sortGlobalHistogram.element( instanceIndex ), uint( 0 ) );

		} );

	} );

}

// Pass 2 — histogram: per-workgroup local count (on-chip), flushed to global once per bin/WG.
export function buildGlobalHistKernel( { hitBufferRO, activeIndicesReadRO, sortGlobalHistogram, counters, bins = SORT_GLOBAL_MAX_BINS } ) {

	return Fn( () => {

		const tid = instanceIndex;
		const lid = localId.x;
		const local = workgroupAtomicArray( 'uint', bins );

		If( lid.lessThan( uint( bins ) ), () => {

			atomicStore( local.element( lid ), uint( 0 ) );

		} );
		workgroupBarrier();

		const entering = atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) );
		If( tid.lessThan( entering ), () => {

			const rayID = activeIndicesReadRO.element( tid );
			const bin = uint( readHitMaterialIndex( hitBufferRO, rayID ) ).clamp( uint( 0 ), uint( bins - 1 ) );
			atomicAdd( local.element( bin ), uint( 1 ) );

		} );
		workgroupBarrier();

		If( lid.lessThan( uint( bins ) ), () => {

			const c = atomicLoad( local.element( lid ) );
			If( c.greaterThan( uint( 0 ) ), () => {

				atomicAdd( sortGlobalHistogram.element( lid ), c );

			} );

		} );

	} );

}

// Pass 3 — exclusive prefix sum over global bins (single thread; dispatch [1,1,1]).
export function buildGlobalPrefixKernel( { sortGlobalHistogram, bins = SORT_GLOBAL_MAX_BINS } ) {

	return Fn( () => {

		If( instanceIndex.equal( uint( 0 ) ), () => {

			const running = uint( 0 ).toVar();
			Loop( { start: uint( 0 ), end: uint( bins ), type: 'uint' }, ( { i } ) => {

				const slot = sortGlobalHistogram.element( i );
				const c = atomicLoad( slot );
				atomicStore( slot, running );
				running.addAssign( c );

			} );

		} );

	} );

}

// Pass 4 — scatter: each ray lands in a unique slot inside its material's contiguous region.
//
// Global atomics are reduced from O(rays) to O(workgroups × bins touched) by reserving one block
// per bin per workgroup, the same aggregation Pass 2 already applies to the histogram. `local`
// changes meaning across the barriers: first a per-workgroup count, then the workgroup's global
// base cursor for that bin, which the lanes then bump to claim their own slot.
//
// Slot order WITHIN a bin changes versus the per-ray version, but it was never deterministic —
// the old path raced on the same global atomicAdd. The output is still an exact permutation of the
// entering set, and Shade reads each ray independently.
export function buildGlobalScatterKernel( { hitBufferRO, activeIndicesReadRO, sortedIndicesRW, sortGlobalHistogram, counters, bins = SORT_GLOBAL_MAX_BINS } ) {

	return Fn( () => {

		const tid = instanceIndex;
		const lid = localId.x;
		const local = workgroupAtomicArray( 'uint', bins );

		If( lid.lessThan( uint( bins ) ), () => {

			atomicStore( local.element( lid ), uint( 0 ) );

		} );
		workgroupBarrier();

		// Read once and reuse: recomputing the bin after the barriers would re-fetch the hit buffer.
		const entering = atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) );
		const inRange = tid.lessThan( entering );
		const rayID = uint( 0 ).toVar();
		const bin = uint( 0 ).toVar();

		If( inRange, () => {

			rayID.assign( activeIndicesReadRO.element( tid ) );
			bin.assign( uint( readHitMaterialIndex( hitBufferRO, rayID ) ).clamp( uint( 0 ), uint( bins - 1 ) ) );
			atomicAdd( local.element( bin ), uint( 1 ) );

		} );
		workgroupBarrier();

		// One global atomic per bin per workgroup reserves that block; the returned base replaces the
		// count in place. Bins this workgroup never touched are skipped — no lane will read them.
		If( lid.lessThan( uint( bins ) ), () => {

			const slot = local.element( lid );
			const c = atomicLoad( slot );
			If( c.greaterThan( uint( 0 ) ), () => {

				atomicStore( slot, atomicAdd( sortGlobalHistogram.element( lid ), c ) );

			} );

		} );
		workgroupBarrier();

		If( inRange, () => {

			// Workgroup-local atomic: gives this lane its rank inside the block reserved above.
			sortedIndicesRW.element( atomicAdd( local.element( bin ), uint( 1 ) ) ).assign( rayID );

		} );

	} );

}

export { WG_SIZE as SORT_GLOBAL_WG_SIZE };
