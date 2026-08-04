/**
 * ExtendKernel.js — wavefront BVH traversal (256×1, 1D ray-parallel dispatch).
 */

import {
	Fn, uint,
	If,
	instanceIndex,
	atomicLoad,
	Return,
} from 'three/tsl';

import { traverseBVH } from './BVHTraversal.js';
import { Ray, HitInfo } from './Struct.js';
import {
	readRayOrigin, readRayDirection, readRayBounceFlags, readMediumStack,
	writeHitPacked,
} from '../Processor/PackedRayBuffer.js';
import { COUNTER, RAY_FLAG } from '../Processor/QueueManager.js';

const WG_SIZE = 256;

export function buildExtendKernel( params ) {

	const {
		bvhBuffer, triangleBuffer,
		rayBufferRO,
		hitBufferRW,
		activeIndicesRO,
		counters,
		maxRayCount,
	} = params;

	const computeFn = Fn( () => {

		const threadIdx = instanceIndex;

		// kernels bound on ENTERING_COUNT so an over-sized (margin) dispatch is safe.
		const bound = counters ? atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) : maxRayCount;
		If( threadIdx.greaterThanEqual( bound ), () => {

			Return();

		} );

		const rayID = activeIndicesRO.element( threadIdx );

		// Parity with Shade's guard. Free — the flags share DIR_FLAGS.w with the direction read below.
		// Only culls work on the pinned-dispatch path, whose identity list still holds dead rays.
		If( readRayBounceFlags( rayBufferRO, rayID ).bitAnd( uint( RAY_FLAG.ACTIVE ) ).equal( uint( 0 ) ), () => {

			Return();

		} );

		const origin = readRayOrigin( rayBufferRO, rayID ).toVar();
		const direction = readRayDirection( rayBufferRO, rayID ).toVar();

		const ray = Ray( { origin, direction } );

		// insideMedium bypasses front/back culling so the ray can hit a glass/SSS back-facing boundary.
		const insideMedium = readMediumStack( rayBufferRO, rayID ).stackDepth.greaterThan( uint( 0 ) );
		const hitInfo = HitInfo.wrap( traverseBVH(
			ray, bvhBuffer, triangleBuffer, insideMedium,
		) ).toVar();

		writeHitPacked(
			hitBufferRW, rayID,
			hitInfo.dst,
			uint( hitInfo.triangleIndex ),
			hitInfo.uv.x, hitInfo.uv.y,
			hitInfo.normal,
			uint( hitInfo.materialIndex ),
			uint( hitInfo.meshIndex ),
		);

	} );

	return computeFn;

}

export { WG_SIZE as EXTEND_WG_SIZE };
