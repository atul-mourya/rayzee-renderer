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
	Fn, wgslFn, float, vec2, vec3, vec4, int, uint,
	If, instanceIndex, atomicLoad,
	localId, workgroupId, dot, max, select, sqrt,
} from 'three/tsl';

import {
	getDecorrelatedSeed,
	pcgHash,
	getStratifiedSample,
} from '../Random.js';

import { generateRayFromCamera, cameraClipDistance } from '../CameraRay.js';
import { Ray } from '../Struct.js';
import { RAY_FLAG, COUNTER } from '../../pathtracer/QueueManager.js';
import {
	writeRayOriginMeta, writeRayDirFlags, writeRayThroughputPdf,
	writeRayRadiance, writeGBuffer,
	writeMediumStack, writeFeatureThroughput, writeRngState, writeRngMis,
} from '../../pathtracer/PackedRayBuffer.js';

const WG_SIZE = 16;

/** The tent filter of radius 1 drawn from `u` in [0, 1) by its inverse CDF (pbrt's SampleTent): offsets in (-1, 1). */
export const tentOffset = /*@__PURE__*/ Fn( ( [ u ] ) => {

	return select( u.lessThan( 0.5 ), sqrt( u.mul( 2.0 ) ).sub( 1.0 ), float( 1.0 ).sub( sqrt( float( 2.0 ).sub( u.mul( 2.0 ) ) ) ) );

} );

// Abramowitz & Stegun 7.1.26, within 1.5e-7.
const erfApprox = /*@__PURE__*/ wgslFn( `
	fn erfApprox( x: f32 ) -> f32 {
		let a = abs( x );
		let t = 1.0f / ( 1.0f + 0.3275911f * a );
		let y = 1.0f - ( ( ( ( 1.061405429f * t - 1.453152027f ) * t + 1.421413741f ) * t - 0.284496736f ) * t + 0.254829592f ) * t * exp( - a * a );
		return select( - y, y, x >= 0.0f );
	}
` );

/**
 * pbrt-v4's Gaussian filter along one axis, max( 0, g( x ) - g( radius ) ) with g( x ) = exp( -x² / 2σ² ), drawn from
 * `u` by its inverse CDF, solved by bisection: offsets in (-radius, radius).
 */
export const gaussianOffset = /*@__PURE__*/ wgslFn( `
	fn gaussianOffset( u: f32, radius: f32, sigma: f32 ) -> f32 {
		let k = 0.70710678f / sigma;
		let s = 1.25331414f * sigma;
		let gr = exp( - radius * radius / ( 2.0f * sigma * sigma ) );
		let e = erfApprox( radius * k );
		let goal = u * ( 2.0f * s * e - 2.0f * radius * gr );
		var lo = - radius;
		var hi = radius;
		for ( var i = 0; i < 24; i ++ ) {
			let mid = 0.5f * ( lo + hi );
			let c = s * ( erfApprox( mid * k ) + e ) - gr * ( mid + radius );
			if ( c < goal ) { lo = mid; } else { hi = mid; }
		}
		return 0.5f * ( lo + hi );
	}
`, [ erfApprox ] );

export function buildGenerateKernel( params ) {

	const {
		rayBufferRW, hitBufferRW, gBufferRW,
		resolution, frame,
		cameraWorldMatrix, cameraProjectionMatrixInverse,
		cameraProjection, panoLonRange, panoLatRange, panoLevelHorizon,
		enableDOF, focalLength, aperture, focusDistance, unitsPerMetre, apertureScale, anamorphicRatio, dofMode, dofBlur,
		cameraClipStart,
		renderWidth,
		chunkRowBase, chunkRows, // row band offset (global first row) + row count for this chunk
		transmissiveBounces, // per-ray refraction budget (megakernel parity: PathTracerCore.js:606)
		auxGBufferEnabled, // live uniform: 1 = init the per-pixel G-buffer (denoiser on), 0 = skip it
		gBuffer = true, // compiled in only when requested (PathTracer.requestOutput( 'gBuffer' ))
		// listDriven: 1D dispatch over the active-pixel list (activeIndicesRO[tid] = LOCAL slot) instead of 2D.
		listDriven = false, activeIndicesRO = null, counters = null,
		bidirectional: bdpt = null,
		// pbrt's pixel filter, compiled in only when not the box of radius 0.5 ({ type: 'box' | 'triangle' | 'gaussian',
		// radius: uniform }; the Gaussian's σ is radius / 3, pbrt's 0.5 at 1.5): each sample lands where the filter is
		// drawn, at weight 1.
		pixelFilter = null,
	} = params;

	const auxOn = auxGBufferEnabled.greaterThan( uint( 0 ) );

	// Shared ray-gen body. (gx, gy) is the GLOBAL pixel; rayID is the LOCAL path-slot (both dispatch modes).
	const emitRay = ( gx, gy, rayID ) => {

		const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );

		const baseSeed = getDecorrelatedSeed( { pixelCoord, rayIndex: int( 0 ), frame } ).toVar();
		const seed = pcgHash( { state: baseSeed } ).toVar();

		// Sample index 1, not the bounces' 0, so the sub-pixel position is independent of the first scatter.
		const stratifiedJitter = getStratifiedSample( pixelCoord, int( 1 ), seed, resolution, frame ).toVar();

		// Y is subtracted because uv.y grows downward while the NDC this used to build grew upward —
		// keeps the sub-pixel sample sequence bit-identical to the pre-panorama ray gen.
		const filterOffset = () => {

			const { type, radius } = pixelFilter;
			if ( type === 'triangle' ) return vec2( tentOffset( stratifiedJitter.x ), tentOffset( stratifiedJitter.y ) ).mul( radius );
			if ( type === 'gaussian' ) {

				const sigma = radius.div( 3.0 );
				return vec2( gaussianOffset( stratifiedJitter.x, radius, sigma ), gaussianOffset( stratifiedJitter.y, radius, sigma ) );

			}

			return stratifiedJitter.sub( 0.5 ).mul( radius.mul( 2.0 ) );

		};

		const jitterOffset = pixelFilter ? filterOffset() : stratifiedJitter.sub( 0.5 );
		const jitteredUV = vec2(
			pixelCoord.x.add( jitterOffset.x ),
			pixelCoord.y.sub( jitterOffset.y )
		).div( resolution );

		const ray = Ray.wrap( generateRayFromCamera(
			jitteredUV, seed,
			cameraWorldMatrix, cameraProjectionMatrixInverse,
			cameraProjection, panoLonRange, panoLatRange, panoLevelHorizon,
			enableDOF, focalLength, aperture, focusDistance, unitsPerMetre, apertureScale, anamorphicRatio, dofMode, dofBlur,
		) );

		// The ray starts at the clip plane. The bidirectional weights still measure the first segment from the camera:
		// the skipped length rides in the alpha-skip distance (mis_ray_t), as a cutout's would.
		const clipAlong = cameraClipDistance( ray.direction, cameraClipStart, cameraWorldMatrix, cameraProjection ).toVar();
		writeRayOriginMeta( rayBufferRW, rayID, ray.origin.add( ray.direction.mul( clipAlong ) ), int( 0 ), int( 0 ), uint( 0 ), bdpt ? clipAlong : null );
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

		if ( gBuffer ) If( auxOn, () => {

			// default: normal +Z, depth 1 (far), black albedo (background/miss). Per-CHUNK G-buffer → LOCAL slot.
			writeGBuffer( gBufferRW, rayID, vec3( 0.0, 0.0, 1.0 ), float( 1.0 ), vec3( 0.0 ), float( 0.0 ) );
			// DDFA: seed the see-through aux tint to white (no tint yet). RMW preserves slot-5 xyz (sigmaA).
			writeFeatureThroughput( rayBufferRW, rayID, vec3( 1.0 ) );

		} );

		writeMediumStack( rayBufferRW, rayID, uint( 0 ), uint( transmissiveBounces ), float( 1.0 ), float( 1.0 ), float( 1.0 ) );

		if ( bdpt ) {

			// Georgiev (31): light tracing's N_L samples over this ray's density 1 / (A_pixel cos³θ).
			const cosCamera = max( dot( ray.direction, bdpt.cameraForward ), 1e-4 );
			const dVCM = select( bdpt.lightTrace.greaterThan( uint( 0 ) ),
				bdpt.lib.mis( float( bdpt.lightPaths ).mul( bdpt.pixelArea ).mul( cosCamera ).mul( cosCamera ).mul( cosCamera ) ), float( 0.0 ) );
			writeRngMis( hitBufferRW, rayID, seed, dVCM, float( 0.0 ) );

		} else {

			writeRngState( hitBufferRW, rayID, seed );

		}

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
