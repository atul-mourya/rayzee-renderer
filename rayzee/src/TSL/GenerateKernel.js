/**
 * GenerateKernel.js — wavefront primary ray generation.
 * Two dispatch modes from one builder: 2D screen-space (default) and 1D list-driven over the active-pixel
 * list (Tier-2 per-pixel freeze).
 *
 * Chunked path pool (docs/internal/specs/wavefront-chunked-pool.md): the image is streamed through a fixed
 * device-budget pool in row bands. A kernel thread maps to a LOCAL path slot `rayID` (∈ [0,B)); the global
 * pixel is `pixelBase + rayID` where `pixelBase = chunkRowBase · renderWidth`. Path state / gBuffer are
 * written at the LOCAL slot; camera ray + RNG seed use the GLOBAL pixel coord (so a pixel's sample sequence
 * is stable across chunks and frames).
 */

import {
	Fn, float, vec2, vec3, vec4, int, uint,
	If, select, instanceIndex, atomicLoad,
	localId, workgroupId,
} from 'three/tsl';

import {
	getDecorrelatedSeed,
	pcgHash,
	getStratifiedSample,
} from './Random.js';

import { generateRayFromCamera } from './CameraRay.js';
import { Ray } from './Struct.js';
import { RAY_FLAG, COUNTER } from '../Processor/QueueManager.js';
import {
	writeRayOriginMeta, writeRayDirFlags, writeRayThroughputPdf,
	writeRayRadiance, writeGBuffer,
	writeMediumStack, writeFeatureThroughput,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 16;

export function buildGenerateKernel( params ) {

	const {
		rayBufferRW, rngBufferRW, gBufferRW,
		resolution, frame,
		cameraWorldMatrix, cameraProjectionMatrixInverse,
		cameraProjection, panoLonRange, panoLatRange, panoLevelHorizon,
		enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio,
		renderWidth,
		chunkRowBase, chunkRows, // row band offset (global first row) + row count for this chunk
		transmissiveBounces, // per-ray refraction budget (megakernel parity: PathTracerCore.js:606)
		transparentBackground, // alpha inits to 1 here (megakernel parity: PathTracerCore.js:554) — env-escape-without-opaque zeroes it in Shade
		auxGBufferEnabled, // live uniform: 1 = init the per-pixel G-buffer (denoiser on), 0 = skip it
		// listDriven: 1D dispatch over the active-pixel list (activeIndicesRO[tid] = LOCAL slot) instead of 2D.
		listDriven = false, activeIndicesRO = null, counters = null,
	} = params;

	const auxOn = auxGBufferEnabled.greaterThan( uint( 0 ) );

	// Shared ray-gen body. (gx, gy) is the GLOBAL pixel; rayID is the LOCAL path-slot (both dispatch modes).
	const emitRay = ( gx, gy, rayID ) => {

		const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );

		const baseSeed = getDecorrelatedSeed( { pixelCoord, rayIndex: int( 0 ), frame } ).toVar();
		const seed = pcgHash( { state: baseSeed } ).toVar();

		// Sample index 1 (not 0) so the AA sub-pixel jitter draws a DIFFERENT STBN cell
		// than the first-bounce BSDF sample (ShadeKernel uses sampleIndex 0). Every bounce
		// samples at index 0, so index 1 is collision-free — this decorrelates the sub-pixel
		// position from the first scatter direction (they were reading the identical cell).
		const stratifiedJitter = getStratifiedSample( pixelCoord, int( 1 ), int( 1 ), seed, resolution, frame ).toVar();

		// Y is subtracted because uv.y grows downward while the NDC this used to build grew upward —
		// keeps the sub-pixel sample sequence bit-identical to the pre-panorama ray gen.
		const jitterOffset = stratifiedJitter.sub( 0.5 );
		const jitteredUV = vec2(
			pixelCoord.x.add( jitterOffset.x ),
			pixelCoord.y.sub( jitterOffset.y )
		).div( resolution );

		const ray = Ray.wrap( generateRayFromCamera(
			jitteredUV, seed,
			cameraWorldMatrix, cameraProjectionMatrixInverse,
			cameraProjection, panoLonRange, panoLatRange, panoLevelHorizon,
			enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio,
		) );

		writeRayOriginMeta( rayBufferRW, rayID, ray.origin, int( 0 ), int( 0 ) );
		// A fresh camera ray is NOT redirected — REDIRECTED stays clear so it sees the direct backdrop;
		// ShadeKernel sets REDIRECTED on the first direction-changing interaction (see RAY_FLAG.REDIRECTED).
		writeRayDirFlags( rayBufferRW, rayID, ray.direction, uint( RAY_FLAG.ACTIVE ) );
		// pdf inits to 0 = prevBouncePdf (megakernel parity PathTracerCore.js:556). The bounce>0 env/emissive
		// MIS gate skips until an opaque scatter writes a real combinedPdf; free bounces preserve it.
		writeRayThroughputPdf( rayBufferRW, rayID, vec4( 1.0, 1.0, 1.0, 0.0 ).xyz, float( 0.0 ) );
		// Alpha inits to 1 unconditionally (megakernel parity: PathTracerCore.js:554). Shade zeroes it only on
		// env-escape-without-opaque, so the lane always carries coverage — which the convergence gate reads to
		// tell subject from background. Output is unaffected: FinalWrite forces alpha 1 when transparent-bg is off.
		writeRayRadiance( rayBufferRW, rayID, vec4( vec3( 0.0 ), float( 1.0 ) ) );

		If( auxOn, () => {

			// default: normal +Z, depth 1 (far), black albedo (background/miss). Per-CHUNK G-buffer → LOCAL slot.
			writeGBuffer( gBufferRW, rayID, vec3( 0.0, 0.0, 1.0 ), float( 1.0 ), vec3( 0.0 ) );
			// DDFA: seed the see-through aux tint to white (no tint yet). RMW preserves slot-5 xyz (sigmaA).
			writeFeatureThroughput( rayBufferRW, rayID, vec3( 1.0 ) );

		} );

		writeMediumStack( rayBufferRW, rayID, uint( 0 ), uint( transmissiveBounces ), float( 1.0 ), float( 1.0 ), float( 1.0 ) );

		rngBufferRW.element( rayID ).assign( seed );

	};

	const computeFn = Fn( () => {

		if ( listDriven ) {

			const tid = instanceIndex;
			// Grid is over-sized from a stale readback; bound on the live ENTERING_COUNT so extra threads no-op.
			If( tid.lessThan( atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) ), () => {

				// active list holds LOCAL slots; global pixel = pixelBase + local slot.
				const localSlot = int( activeIndicesRO.element( tid ) );
				const globalPixel = localSlot.add( chunkRowBase.mul( renderWidth ) );
				const gx = globalPixel.mod( renderWidth );
				const gy = globalPixel.div( renderWidth );
				emitRay( gx, gy, uint( localSlot ) );

			} );

		} else {

			// 2D grid over (renderWidth × chunkRows). local_gy is the band-local row; global gy adds chunkRowBase.
			const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
			const localGy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

			If( gx.lessThan( renderWidth ).and( localGy.lessThan( chunkRows ) ), () => {

				const gy = localGy.add( chunkRowBase );
				const localRayID = uint( localGy.mul( renderWidth ).add( gx ) );
				emitRay( gx, gy, localRayID );

			} );

		}

	} );

	return computeFn;

}

export { WG_SIZE as GENERATE_WG_SIZE };
