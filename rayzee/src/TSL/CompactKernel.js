/**
 * CompactKernel.js — wavefront stream compaction: active rays → dense index array for next bounce (256×1, 1D).
 */

import {
	Fn, uint, select, max, min,
	If,
	instanceIndex,
	atomicAdd, atomicLoad,
	subgroupExclusiveAdd, subgroupAdd, subgroupBroadcast,
	Return,
} from 'three/tsl';

import { readRayBounceFlags, readRayThroughput } from '../Processor/PackedRayBuffer.js';
import { RAY_FLAG, COUNTER, ENERGY_SCALE, ENERGY_RAY_CLAMP } from '../Processor/QueueManager.js';

const WG_SIZE = 256;

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

export { WG_SIZE as COMPACT_WG_SIZE };
