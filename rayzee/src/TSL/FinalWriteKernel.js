/**
 * FinalWriteKernel.js — wavefront final output: temporal accumulation + MRT StorageTexture writes (16×16, 2D).
 *
 * Chunked path pool (docs/internal/specs/wavefront-chunked-pool.md): runs 2D over one row band
 * (renderWidth × chunkRows). A thread's band-local row `localGy` maps to global row `gy = chunkRowBase + localGy`.
 * Path state + the per-chunk G-buffer are read at the LOCAL slot `rayID = localGy·W + gx`; the persistent
 * per-pixel buffers (m2/streak/frozenMask) and the output texture use the GLOBAL pixel `p = gy·W + gx`.
 */

import {
	Fn, wgslFn, float, vec2, vec4, int, uint, uvec2,
	If, mix, select, texture, textureStore, length, atomicAdd,
	localId, workgroupId,
} from 'three/tsl';

import {
	readRayRadiance, readGBuffer, gbDecodeNormalDepth, gbDecodeAlbedo,
} from '../Processor/PackedRayBuffer.js';
import { luminance } from './Common.js';
import { COUNTER } from '../Processor/QueueManager.js';

const WG_SIZE = 16;

// Debug mode 11: NaN/Inf detector — red where the accumulated color is NaN/Inf, black elsewhere.
const nanInfToRed = /*@__PURE__*/ wgslFn( `
	fn nanInfToRed( c: vec3f ) -> vec3f {
		let isNan = c.x != c.x || c.y != c.y || c.z != c.z;
		let isInf = abs( c.x ) > 1e30f || abs( c.y ) > 1e30f || abs( c.z ) > 1e30f;
		if ( isNan || isInf ) { return vec3f( 1.0f, 0.0f, 0.0f ); }
		return vec3f( 0.0f );
	}
` );

export function buildFinalWriteKernel( params ) {

	const {
		rayBufferRO, gBufferRO,
		writeColorTex, writeNDTex, writeAlbedoTex,
		resolution, frame,
		enableAccumulation, hasPreviousAccumulated, accumulationAlpha, cameraIsMoving,
		transparentBackground,
		prevAccumTexture, prevAlbedoTexture, prevNormalDepthTexture,
		renderWidth,
		chunkRowBase, chunkRows, // row band offset (global first row) + row count for this chunk
		visMode,
		// Aux MRT (normalDepth + albedo) feeds only the denoiser/OIDN. Gated by a live uniform (1 = denoiser
		// on): when off, skip the G-buffer decode, the prev-frame aux mix, and the two aux stores.
		auxGBufferEnabled,
		// Clean-aux normal (1 = temporally accumulate + renormalize the aux normal). On only for clean-aux
		// OIDN models (calb_cnrm/high, alb_nrm/balanced); off for fast/ASVGF which want the bump normal.
		cleanAuxNormalEnabled,
		// Tier-1 convergence early-stop: per-pixel Welford luminance second moment + converged-pixel counter.
		counters, m2BufferRW, useAdaptiveSampling, noiseThreshold, adaptiveMinSamples,

		// Tier-2 per-pixel freeze: streakBufferRW = per-pixel freeze-candidate streak (stamped here);
		// frozenMaskRO = dilated frozen mask from buildActivePixels (pass-through gates on it, not streak).
		usePixelFreeze, pixelFreezeThreshold, pixelFreezeStability, streakBufferRW, frozenMaskRO,
	} = params;

	const auxOn = auxGBufferEnabled.greaterThan( uint( 0 ) );
	const cleanAuxNormalOn = cleanAuxNormalEnabled.greaterThan( uint( 0 ) );
	// useAdaptiveSampling is registered via UniformManager.ub() → an int 0/1 uniform, so compare against int(0).
	const convOn = useAdaptiveSampling.greaterThan( int( 0 ) );
	const adaptiveOn = usePixelFreeze.greaterThan( int( 0 ) );

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const localGy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( renderWidth ).and( localGy.lessThan( chunkRows ) ), () => {

			const gy = localGy.add( chunkRowBase ); // GLOBAL row
			const rayID = uint( localGy.mul( renderWidth ).add( gx ) ); // LOCAL path/gBuffer slot
			const pixelId = uint( gy.mul( renderWidth ).add( gx ) ); // GLOBAL pixel (persistent buffers + texture)

			const sampleColor = readRayRadiance( rayBufferRO, rayID );
			const finalColor = sampleColor.xyz.toVar();
			const outputAlpha = select( transparentBackground, sampleColor.w, float( 1.0 ) ).toVar();

			// A pixel frozen in a prior frame was skipped by Generate, so its rayBuffer sample is stale — pass
			// the accumulated colour through unchanged (below) instead of mixing it. Inert unless adaptiveOn.
			const wasFrozen = adaptiveOn.and( frame.greaterThan( uint( 0 ) ) )
				.and( frozenMaskRO.element( pixelId ).equal( uint( 1 ) ) ).toVar();

			// MRT comes from the per-chunk G-buffer (LOCAL slot). Half-packed: decode.
			// auxOn gates the decode + stores so a no-denoiser frame does no G-buffer read and no aux writes.
			const finalNormalDepth = vec4( 0.0 ).toVar();
			const finalAlbedo = vec4( 0.0 ).xyz.toVar();
			If( auxOn, () => {

				const gbuf = readGBuffer( gBufferRO, rayID );
				finalNormalDepth.assign( gbDecodeNormalDepth( gbuf ) );
				finalAlbedo.assign( vec4( gbDecodeAlbedo( gbuf ), 0.0 ).xyz );

			} );

			const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );
			const prevUV = pixelCoord.div( resolution );

			// visMode 11 (NaN/Inf) bypasses accumulation (megakernel parity main_TSL_PathTracer.js:355) so the
			// detector runs on each frame's fresh color — else mix() propagates a transient NaN and it stays red forever.
			If( enableAccumulation.and( cameraIsMoving.not() ).and( frame.greaterThan( uint( 0 ) ) ).and( hasPreviousAccumulated ).and( visMode.notEqual( int( 11 ) ) ), () => {

				const prevAccumSample = texture( prevAccumTexture, prevUV, 0 ).toVar();

				// Frozen pixels pass prev colour through unchanged (stale sample); active pixels accumulate.
				finalColor.assign( select( wasFrozen, prevAccumSample.xyz, mix( prevAccumSample.xyz, sampleColor.xyz, accumulationAlpha ) ) );
				If( auxOn, () => {

					// Albedo averages cleanly (it's a colour).
					finalAlbedo.assign( mix( texture( prevAlbedoTexture, prevUV, 0 ).xyz, finalAlbedo, accumulationAlpha ) );

					// NORMAL: by default keep this frame's POINT-SAMPLED normal — it varies with the bump,
					// which fast/ASVGF want to preserve edge detail. But a CLEAN-AUX OIDN model (calb_cnrm/high,
					// alb_nrm/balanced) trusts the aux and is fed per-frame point-sampled NOISE → leaked noise
					// (high) / over-smoothing (balanced). When cleanAuxNormalOn, temporally accumulate it like
					// the colour. Average the RAW unit normals (decode 0.5+0.5 → [-1,1]) and RENORMALIZE — a
					// plain encoded-space mix would bias toward the flat (0.5,0.5,1) mean and collapse detail.
					// Depth (.w) stays this frame's value; guard the degenerate near-zero mean (opposing normals).
					If( cleanAuxNormalOn, () => {

						const prevN = texture( prevNormalDepthTexture, prevUV, 0 ).xyz.mul( 2.0 ).sub( 1.0 );
						const curN = finalNormalDepth.xyz.mul( 2.0 ).sub( 1.0 ).toVar();
						const mixedN = mix( prevN, curN, accumulationAlpha ).toVar();
						const len = length( mixedN );
						const avgN = select( len.greaterThan( 1e-4 ), mixedN.div( len ), curN );
						finalNormalDepth.assign( vec4( avgN.mul( 0.5 ).add( 0.5 ), finalNormalDepth.w ) );

					} );

				} );

				If( transparentBackground, () => {

					outputAlpha.assign( select( wasFrozen, prevAccumSample.w, mix( prevAccumSample.w, sampleColor.w, accumulationAlpha ) ) );

				} );

			} );

			// Tier-1 convergence: per-pixel running second moment of LUMINANCE (Welford). luminance() is linear,
			// so luminance(running-mean color) == running-mean luminance == E[L]; m2 tracks E[L²] under the SAME
			// global 1/(frame+1) alpha (NO per-pixel alpha). sampleVar = E[L²]-E[L]²; varOfMean = sampleVar/(N);
			// absSE = SE(mean); a pixel converges once frame>=minSamples AND the √-normalized error < threshold.
			// The m2 write runs every frame (incl. frame 0, where alpha==1 self-inits it → no explicit clear).
			// Sits AFTER the accumulation mix (finalColor is the mean) and BEFORE the visMode-11 mutation.
			If( convOn, () => {

				const sampleLum = luminance( sampleColor.xyz );
				const prevM2 = m2BufferRW.element( pixelId ).toVar();
				const m2 = mix( prevM2, sampleLum.mul( sampleLum ), accumulationAlpha ).toVar();
				m2BufferRW.element( pixelId ).assign( m2 );

				const meanLum = luminance( finalColor ).toVar();
				const sampleVar = m2.sub( meanLum.mul( meanLum ) ).max( float( 0 ) );
				const varOfMean = sampleVar.div( float( frame ).add( 1.0 ) );
				// absSE = absolute standard error of the mean luminance; relErr = its ratio to the mean.
				// Combined criterion: bright pixels converge on relErr<threshold; dark/dim pixels (where relErr
				// stays high forever) converge on absSE<absFloor, since their absolute noise is imperceptible.
				const absSE = varOfMean.sqrt().toVar();
				const relErr = absSE.div( meanLum.add( float( 1e-4 ) ) ); // Tier-2 freeze predicate reads this

				// Cycles-style convergence: normalize the standard error by √luminance for dim pixels (lum<1),
				// by luminance for bright ones. The √ loosens the relative bar in shadows so dark pixels converge
				// on their small absolute noise instead of stalling forever on a pure relative bar.
				const convNorm = select( meanLum.lessThan( float( 1.0 ) ), meanLum.sqrt(), meanLum );
				const converged = absSE.div( convNorm.add( float( 1e-4 ) ) ).lessThan( noiseThreshold );

				If( frame.greaterThanEqual( uint( adaptiveMinSamples ) ).and( converged ), () => {

					atomicAdd( counters.element( uint( COUNTER.CONVERGED_COUNT ) ), uint( 1 ) );

				} );

				// Maintain the freeze streak on the relErr-only predicate (NO absFloor — it bakes dim regions dark
				// when it permanently freezes a pixel). Monotonic: streak>=K freezes for the run, so global alpha stays exact.
				If( adaptiveOn, () => {

					If( frame.equal( uint( 0 ) ), () => {

						// Frame 0 (post-reset/camera-move) clears the frozen state so each run re-freezes fresh.
						streakBufferRW.element( pixelId ).assign( uint( 0 ) );

					} );

					If( wasFrozen, () => {

						// Already frozen (passed through above) — count it.
						atomicAdd( counters.element( uint( COUNTER.FROZEN_COUNT ) ), uint( 1 ) );

					} );

					If( wasFrozen.not().and( frame.greaterThan( uint( 0 ) ) ), () => {

						const freezeCandidate = frame.greaterThanEqual( uint( adaptiveMinSamples ) )
							.and( relErr.lessThan( pixelFreezeThreshold ) );
						const newStreak = select( freezeCandidate, streakBufferRW.element( pixelId ).add( uint( 1 ) ), uint( 0 ) ).toVar();
						streakBufferRW.element( pixelId ).assign( newStreak );
						// Just reached K → frozen next frame; count it now so the frozen population is current.
						If( newStreak.greaterThanEqual( uint( pixelFreezeStability ) ), () => {

							atomicAdd( counters.element( uint( COUNTER.FROZEN_COUNT ) ), uint( 1 ) );

						} );

					} );

				} );

			} );

			// Debug mode 11: flag NaN/Inf on the accumulated color (red on NaN/Inf, black elsewhere).
			If( visMode.equal( int( 11 ) ), () => {

				finalColor.assign( nanInfToRed( finalColor ) );

			} );

			const uintCoord = uvec2( uint( gx ), uint( gy ) );
			textureStore( writeColorTex, uintCoord, vec4( finalColor, outputAlpha ) ).toWriteOnly();
			If( auxOn, () => {

				textureStore( writeNDTex, uintCoord, finalNormalDepth ).toWriteOnly();
				textureStore( writeAlbedoTex, uintCoord, vec4( finalAlbedo, 1.0 ) ).toWriteOnly();

			} );

		} );

	} );

	return computeFn;

}

export { WG_SIZE as FINALWRITE_WG_SIZE };
