/**
 * ExtendKernel.js — wavefront BVH traversal (256×1, 1D ray-parallel dispatch).
 */

import {
	Fn, uint, int,
	If,
	instanceIndex,
	atomicLoad,
	Return,
} from 'three/tsl';

import { traverseBVH } from './BVHTraversal.js';
import { Ray, HitInfo } from './Struct.js';
import {
	readRayOrigin, readRayDirection, readRayBounceFlags, readMediumStack,
	writeHitPacked, writeHitSurfaceOffset,
} from '../Processor/PackedRayBuffer.js';
import { COUNTER, RAY_FLAG } from '../Processor/QueueManager.js';
import { hitFacet, packHitFacet } from './HitFacet.js';

const WG_SIZE = 256;

export function buildExtendKernel( params ) {

	const {
		bvhBuffer, triangleBuffer,
		rayBufferRO,
		hitBufferRW,
		activeIndicesRO,
		counters,
		maxRayCount,
		shadowTerminatorOffset,
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
		const flags = readRayBounceFlags( rayBufferRO, rayID ).toVar();
		If( flags.bitAnd( uint( RAY_FLAG.ACTIVE ) ).equal( uint( 0 ) ), () => {

			Return();

		} );

		const origin = readRayOrigin( rayBufferRO, rayID ).toVar();
		const direction = readRayDirection( rayBufferRO, rayID ).toVar();

		const ray = Ray( { origin, direction } );

		// insideMedium bypasses front/back culling so the ray can hit a glass/SSS back-facing boundary.
		const insideMedium = readMediumStack( rayBufferRO, rayID ).stackDepth.greaterThan( uint( 0 ) );
		// Only the camera's own view culls back faces, and a bounce that dipped under its surface.
		const cull = flags.bitAnd( uint( RAY_FLAG.REDIRECTED ) ).equal( uint( 0 ) )
			.or( flags.bitAnd( uint( RAY_FLAG.UNDER_SURFACE ) ).notEqual( uint( 0 ) ) );
		const hitInfo = HitInfo.wrap( traverseBVH(
			ray, bvhBuffer, triangleBuffer, insideMedium, cull,
		) ).toVar();

		const facet = hitFacet( {
			triangleBuffer, bvhBuffer, triIdx: hitInfo.triangleIndex, instanceLeaf: hitInfo.instanceLeaf,
			hitPoint: hitInfo.hitPoint, smoothNormal: hitInfo.normal, viewDir: direction.negate(),
			didHit: hitInfo.didHit, liftEnabled: shadowTerminatorOffset.greaterThan( 0.0 ),
		} );

		writeHitPacked(
			hitBufferRW, rayID,
			hitInfo.dst,
			uint( hitInfo.triangleIndex ),
			hitInfo.uv.x, hitInfo.uv.y,
			hitInfo.normal,
			uint( hitInfo.materialIndex ),
			// Biased by one: leaf 0 is real, so 0 has to mean "no instance".
			uint( hitInfo.instanceLeaf.add( int( 1 ) ) ),
			packHitFacet( facet.faceN, facet.liftScale ),
		);
		writeHitSurfaceOffset( hitBufferRW, rayID, facet.surfaceOffset );

	} );

	return computeFn;

}

export { WG_SIZE as EXTEND_WG_SIZE };
