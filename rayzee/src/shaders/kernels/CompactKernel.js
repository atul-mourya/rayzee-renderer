/**
 * CompactKernel.js — wavefront stream compaction: active rays → dense index array for next bounce (256×1, 1D),
 * and the active list's bookkeeping around it.
 */

import {
	Fn, uint, select, max, min,
	If,
	instanceIndex,
	atomicAdd, atomicLoad, atomicStore,
	subgroupExclusiveAdd, subgroupAdd, subgroupBroadcast,
	Return,
} from 'three/tsl';

import { readRayBounceFlags, readRayThroughput } from '../../pathtracer/PackedRayBuffer.js';
import { RAY_FLAG, COUNTER, ENERGY_SCALE, ENERGY_RAY_CLAMP } from '../../pathtracer/QueueManager.js';

// Shared by the 1D index-list kernels.
export const LIST_WG_SIZE = 256;

// Compact is sized on the GPU with the other bounce kernels, so it must be a list kernel.
const WG_SIZE = LIST_WG_SIZE;

// Survivor's remaining throughput as fixed-point u32; clamped so a frame's sum cannot wrap.
const rayEnergy = ( rayBufferRO, rayID ) => {

	const t = readRayThroughput( rayBufferRO, rayID );
	const m = max( max( t.x, t.y ), t.z ).max( 0.0 );
	return min( uint( m.mul( ENERGY_SCALE ).add( 0.5 ) ), uint( ENERGY_RAY_CLAMP ) );

};

export function buildCompactKernel( params ) {

	const {
		rayBufferRO,
		activeIndicesReadRO,
		activeIndicesWriteRW,
		counters,
		currentActiveCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		// ACTIVE_RAY_COUNT is zeroed before compact, so the dense-list length comes from ENTERING_COUNT.
		const bound = counters ? atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) : currentActiveCount;
		If( threadIdx.greaterThanEqual( bound ), () => {

			Return();

		} );

		const rayID = activeIndicesReadRO.element( threadIdx );

		const flags = readRayBounceFlags( rayBufferRO, rayID );

		If( flags.bitAnd( uint( RAY_FLAG.ACTIVE ) ).notEqual( uint( 0 ) ), () => {

			const writeIdx = atomicAdd( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 1 ) );
			activeIndicesWriteRW.element( writeIdx ).assign( rayID );
			atomicAdd( counters.element( uint( COUNTER.ACTIVE_ENERGY ) ), rayEnergy( rayBufferRO, rayID ) );

		} );

	} );

	return computeFn;

}

/**
 * Subgroup prefix-sum compaction: one global atomicAdd per subgroup instead of per survivor.
 * Requires renderer.hasFeature('subgroups'); control flow must stay uniform (no divergent Return).
 */
export function buildCompactSubgroupKernel( params ) {

	const {
		rayBufferRO,
		activeIndicesReadRO,
		activeIndicesWriteRW,
		counters,
		currentActiveCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;
		const bound = counters ? atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) : currentActiveCount;

		// No early Return: all lanes must reach the subgroup ops; out-of-range lanes contribute 0 and read stale-but-in-capacity slots.
		const inRange = threadIdx.lessThan( bound );
		const rayID = activeIndicesReadRO.element( threadIdx );
		const flags = readRayBounceFlags( rayBufferRO, rayID );
		const isActive = inRange.and( flags.bitAnd( uint( RAY_FLAG.ACTIVE ) ).notEqual( uint( 0 ) ) );
		const activeU = select( isActive, uint( 1 ), uint( 0 ) );
		const energyU = select( isActive, rayEnergy( rayBufferRO, rayID ), uint( 0 ) );

		// .toVar() materializes the subgroup ops at uniform control flow; inlining into the divergent If(isActive) write is rejected by WGSL.
		const localOffset = subgroupExclusiveAdd( activeU ).toVar();
		const sgCount = subgroupAdd( activeU ).toVar();
		const sgEnergy = subgroupAdd( energyU ).toVar();

		// laneId via exclusiveAdd(1) since TSL lacks subgroup_invocation_id; lane 0 does the single per-subgroup atomicAdd.
		const laneId = subgroupExclusiveAdd( uint( 1 ) ).toVar();
		const base = uint( 0 ).toVar();
		If( laneId.equal( uint( 0 ) ), () => {

			base.assign( atomicAdd( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), sgCount ) );
			atomicAdd( counters.element( uint( COUNTER.ACTIVE_ENERGY ) ), sgEnergy );

		} );
		const sgBase = subgroupBroadcast( base, uint( 0 ) ).toVar();

		If( isActive, () => {

			activeIndicesWriteRW.element( sgBase.add( localOffset ) ).assign( rayID );

		} );

	} );

	return computeFn;

}

/**
 * Workgroup counts for `count` list threads, read by dispatchWorkgroupsIndirect: past the device's per-dimension limit
 * they spill into y, which instanceIndex folds back in; never none, so every kernel's thread 0 still does its bookkeeping.
 */
export function writeListSizes( sizes, count, maxGroups ) {

	const groups = max( uint( count ).add( uint( LIST_WG_SIZE - 1 ) ).div( uint( LIST_WG_SIZE ) ), uint( 1 ) ).toVar();
	sizes.element( uint( 0 ) ).assign( min( groups, uint( maxGroups ) ) );
	sizes.element( uint( 1 ) ).assign( groups.add( uint( maxGroups - 1 ) ).div( uint( maxGroups ) ) );
	sizes.element( uint( 2 ) ).assign( uint( 1 ) );

}

// CONVERGED and the geometry counts are per frame, summed over its chunks in FinalWrite: zeroed on its first chunk only.
function resetFrameCounts( counters, isFirstChunk ) {

	If( isFirstChunk.greaterThan( uint( 0 ) ), () => {

		atomicStore( counters.element( uint( COUNTER.CONVERGED_COUNT ) ), uint( 0 ) );
		atomicStore( counters.element( uint( COUNTER.GEOMETRY_COUNT ) ), uint( 0 ) );
		atomicStore( counters.element( uint( COUNTER.CONVERGED_GEOMETRY_COUNT ) ), uint( 0 ) );

	} );

}

/** The chunk's identity list, bounded on its ray count (the pool has no margin), and its counters seeded. */
export function buildInitActiveIndicesKernel( { activeIndicesRW, counters, maxRayCount, isFirstChunk, sizes, maxGroups } ) {

	return Fn( () => {

		const tid = instanceIndex;
		If( tid.lessThan( maxRayCount ), () => {

			activeIndicesRW.element( tid ).assign( tid );

		} );
		If( tid.equal( uint( 0 ) ), () => {

			atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), maxRayCount );
			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), maxRayCount );
			writeListSizes( sizes, maxRayCount, maxGroups );
			resetFrameCounts( counters, isFirstChunk );

		} );

	} );

}

/** Before a chunk's frozen-pixel scatter: ACTIVE is per chunk. */
export function buildResetFrameCountersKernel( { counters, isFirstChunk } ) {

	return Fn( () => {

		atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), uint( 0 ) );
		resetFrameCounts( counters, isFirstChunk );

	} );

}

/** After the scatter: its count enters the bounce loop, and is the chunk's pixel count for the sizing readback. */
export function buildSeedEnterKernel( { counters, sizes, maxGroups, bounceCounts, pixelCountSlot } ) {

	return Fn( () => {

		const active = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
		atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), active );
		writeListSizes( sizes, active, maxGroups );
		bounceCounts.element( pixelCountSlot ).assign( active );

	} );

}

/** Full-dispatch path: the bounce kernels read the identity list over the whole chunk. */
export function buildEnterFullKernel( { counters, maxRayCount } ) {

	return Fn( () => {

		atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), maxRayCount );

	} );

}

/** A bounce's survivors for the readback curve — their count and ACTIVE_ENERGY — and ENTERING_COUNT for the next. */
export function recordSurvivors( counters, bounceCounts, countSlot, energySlot, active ) {

	bounceCounts.element( countSlot ).assign( active );
	bounceCounts.element( energySlot ).assign( atomicLoad( counters.element( uint( COUNTER.ACTIVE_ENERGY ) ) ) );
	atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), active );

}

/** One thread: `record( active )` the bounce's survivors. */
export function buildSnapshotKernel( { counters, record } ) {

	return Fn( () => {

		record( atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) ) );

	} );

}

/**
 * Copies the compacted survivors back to the list the bounce kernels bind (storage nodes bind at build time). Thread 0
 * first runs `record( active )`, above the bound so it runs even when none survived.
 */
export function buildCopybackKernel( { counters, survivors, activeIndicesRW, record } ) {

	return Fn( () => {

		const tid = instanceIndex;
		const active = atomicLoad( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ) );
		If( tid.equal( uint( 0 ) ), () => {

			record( active );

		} );
		If( tid.greaterThanEqual( active ), () => {

			Return();

		} );
		activeIndicesRW.element( tid ).assign( survivors.element( tid ) );

	} );

}

export { WG_SIZE as COMPACT_WG_SIZE };
