/**
 * DebugKernel.js — wavefront debug visualization (16×16, 2D screen-space dispatch).
 *
 * Single-pass primary-ray debug viz for visMode 1-10 (mode 11 = NaN/Inf is a FinalWrite
 * post-branch on the accumulated color, handled there). Generates a camera ray per pixel and
 * delegates to the renderer-agnostic TraceDebugMode for the per-mode color; mode 9 (stratified
 * sample pattern) is computed inline. Writes the color directly to the output (no accumulation).
 */

import {
	Fn, float, vec2, vec4, int, uint, uvec2,
	If, textureStore,
	localId, workgroupId,
} from 'three/tsl';

import { generateRayFromCamera } from './CameraRay.js';
import { Ray } from './Struct.js';
import { TraceDebugMode } from './Debugger.js';
import { pcgHash, getStratifiedSample } from './Random.js';

const WG_SIZE = 16;

export function buildDebugKernel( params ) {

	const {
		writeColorTex, writeNDTex, writeAlbedoTex,
		resolution, renderWidth, renderHeight,
		cameraWorldMatrix, cameraProjectionMatrixInverse, cameraProjectionMatrix, cameraViewMatrix,
		cameraProjection, panoLonRange, panoLatRange, panoLevelHorizon,
		enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio,
		bvhBuffer, triangleBuffer, materialBuffer,
		envTexture, environmentMatrix, environmentIntensity, enableEnvironmentLight,
		visMode, debugVisScale,
		frame,
	} = params;

	const computeFn = Fn( () => {

		const gx = int( workgroupId.x ).mul( WG_SIZE ).add( int( localId.x ) );
		const gy = int( workgroupId.y ).mul( WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( renderWidth ).and( gy.lessThan( renderHeight ) ), () => {

			const pixelCoord = vec2( float( gx ).add( 0.5 ), float( gy ).add( 0.5 ) );
			const pixelIndex = gy.mul( int( resolution.x ) ).add( gx );
			const seed = pcgHash( { state: uint( pixelIndex ).add( uint( 1 ) ) } ).toVar();

			// Center-pixel primary ray (no AA jitter — debug viz wants a stable, sharp image).
			const ray = Ray.wrap( generateRayFromCamera(
				pixelCoord.div( resolution ), seed,
				cameraWorldMatrix, cameraProjectionMatrixInverse,
				cameraProjection, panoLonRange, panoLatRange, panoLevelHorizon,
				enableDOF, focalLength, aperture, focusDistance, sceneScale, apertureScale, anamorphicRatio,
			) );

			const color = vec4( 1.0, 0.0, 1.0, 1.0 ).toVar();

			// Mode 9: visualize the stratified AA-jitter pattern (R,G = jitter).
			If( visMode.equal( int( 9 ) ), () => {

				// One ray per pixel — plain per-frame jitter (totalRays = 1 → random, no stratified lattice).
				const jitter = getStratifiedSample( pixelCoord, int( 0 ), int( 1 ), seed, resolution, frame );
				color.assign( vec4( jitter, 1.0, 1.0 ) );

			} ).Else( () => {

				// Modes 1-8, 10 — shared per-mode debug color (primary-ray trace + counters).
				color.assign( TraceDebugMode(
					ray.origin, ray.direction,
					bvhBuffer, triangleBuffer, materialBuffer,
					envTexture, environmentMatrix, environmentIntensity, enableEnvironmentLight,
					visMode, debugVisScale,
					pixelCoord, resolution,
					cameraProjectionMatrix, cameraViewMatrix,
					frame,
				) );

			} );

			const uintCoord = uvec2( uint( gx ), uint( gy ) );
			textureStore( writeColorTex, uintCoord, color ).toWriteOnly();
			// Benign MRT so the denoiser/display never read stale normal/albedo on a debug frame.
			textureStore( writeNDTex, uintCoord, vec4( 0.5, 0.5, 1.0, 1.0 ) ).toWriteOnly();
			textureStore( writeAlbedoTex, uintCoord, vec4( color.xyz, 1.0 ) ).toWriteOnly();

		} );

	} );

	return computeFn;

}

export { WG_SIZE as DEBUG_WG_SIZE };
