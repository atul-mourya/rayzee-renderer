/**
 * LightSplatKernel.js — light tracing: every stored light vertex to the pinhole, into the pixel it
 * projects to. Fixed-point u32 channels: WGSL has no float atomics, and integer sums are order-free.
 */

import {
	Fn, float, vec3, vec4, int, uint, If, instanceIndex, atomicAdd, atomicLoad, atomicStore, Return,
	dot, sqrt, max, min, floor, length, localId, workgroupId,
} from 'three/tsl';

import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { calculateMaterialPDF } from './LightsSampling.js';
import { traceShadowRayRefractiveOpaque } from './LightsDirect.js';
import { traverseBVHShadowCameraCulled } from './BVHTraversal.js';
import { offsetRayOrigin, SHADOW_END, sanitizeRGB } from './Common.js';
import { pcgHash } from './Random.js';
import { regularizePathContribution } from './PathTracerCore.js';
import { resolveSurfaceMaterial, lightEndCosine, misPartial, misWeight, strategyWeight, STRATEGY, SPLAT_SCALE, SPLAT_MAX } from './Bidirectional.js';
import {
	cachedVertex, readVertexRecord, readLightPathLength, readRayRadiance, writeRayRadiance,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 256;
const RESOLVE_WG_SIZE = 16;

export function buildLightSplatKernel( params ) {

	const {
		hitBufferRO, splatBuffer,
		bvhBuffer, triangleBuffer, materialBuffer,
		lightPaths, slotsPerPath, lightTag, strategyView,
		cameraPosition, cameraForward, cameraViewMatrix, cameraProjectionMatrix, pixelArea,
		renderWidth, renderHeight,
		globalIlluminationIntensity, fireflyThreshold, accumFrame, frame,
		mergeVm = null,
	} = params;

	return Fn( () => {

		const slot = instanceIndex.toVar();
		If( slot.greaterThanEqual( lightPaths.mul( slotsPerPath ) ), () => {

			Return();

		} );

		const c = slot.mod( slotsPerPath ).toVar();
		const stored = readLightPathLength( hitBufferRO, cachedVertex( slot.sub( c ) ), lightTag );
		If( c.greaterThanEqual( stored ), () => {

			Return();

		} );

		const record = readVertexRecord( hitBufferRO, cachedVertex( slot ) );
		const v = { ...record, vm: mergeVm?.( record.position ) ?? null };

		const toCamera = cameraPosition.sub( v.position ).toVar();
		const dist2 = max( dot( toCamera, toCamera ), 1e-12 ).toVar();
		const dir = toCamera.div( sqrt( dist2 ) ).toVar();
		const cosFacet = dot( dir, v.facetN ).toVar();
		const cosCamera = dot( dir, cameraForward ).negate().toVar();
		// The camera is this vertex's viewer: like a camera path, only the facet decides which side it is on.
		If( cosFacet.lessThanEqual( 0.0 ).or( cosCamera.lessThanEqual( 1e-6 ) ).or( v.extra.notEqual( uint( 0 ) ) ), () => {

			Return();

		} );

		const clip = cameraProjectionMatrix.mul( cameraViewMatrix.mul( vec4( v.position, 1.0 ) ) ).toVar();
		If( clip.w.lessThanEqual( 0.0 ), () => {

			Return();

		} );

		const px = floor( clip.x.div( clip.w ).mul( 0.5 ).add( 0.5 ).mul( float( renderWidth ) ) ).toVar();
		const py = floor( float( 0.5 ).sub( clip.y.div( clip.w ).mul( 0.5 ) ).mul( float( renderHeight ) ) ).toVar();
		If( px.lessThan( 0.0 ).or( py.lessThan( 0.0 ) ).or( px.greaterThanEqual( float( renderWidth ) ) ).or( py.greaterThanEqual( float( renderHeight ) ) ), () => {

			Return();

		} );

		const material = resolveSurfaceMaterial( v.materialIndex, v.uv, v.N, materialBuffer );
		const f = evaluateMaterialResponse( dir, v.V, v.N, material ).toVar();

		// The pinhole's solid-angle density for a uniform point in a pixel: 1 / (A_pixel cos³θ).
		const cameraPdfW = float( 1.0 ).div( pixelArea.mul( cosCamera ).mul( cosCamera ).mul( cosCamera ) );
		const toSurface = cameraPdfW.div( dist2 ).toVar();

		// Georgiev (46); the camera side has no sum of its own.
		const wLight = misPartial( toSurface.mul( cosFacet ).div( float( lightPaths ) ), v, calculateMaterialPDF( dir, v.V, v.N, material ) );
		const bounces = c.add( uint( 1 ) );
		const gi = float( 1.0 ).toVar();
		If( bounces.greaterThan( uint( 1 ) ), () => {

			gi.assign( globalIlluminationIntensity );

		} );

		const contribution = regularizePathContribution(
			v.throughput.mul( f ).mul( lightEndCosine( v.V, v.N, v.facetN, dir ) )
				.mul( toSurface.div( float( lightPaths ) ).mul( strategyWeight( strategyView, STRATEGY.LIGHT_TRACE, misWeight( wLight, float( 0.0 ) ) ) ).mul( gi ) ),
			float( c ), fireflyThreshold, int( accumFrame ),
		).toVar();

		const origin = offsetRayOrigin( v.position, v.facetN ).toVar();
		const segment = cameraPosition.sub( origin ).toVar();
		const segmentLength = length( segment ).toVar();
		// This segment stands in for the primary ray, which sees through the faces it culls.
		const visibility = traceShadowRayRefractiveOpaque(
			origin, segment.div( segmentLength ), segmentLength.mul( SHADOW_END ),
			traverseBVHShadowCameraCulled, bvhBuffer, triangleBuffer, materialBuffer,
		);

		If( visibility.greaterThan( 0.0 ), () => {

			const value = min( sanitizeRGB( contribution.mul( visibility ) ), vec3( SPLAT_MAX ) ).mul( SPLAT_SCALE ).toVar();
			const dither = float( pcgHash( { state: slot.bitXor( uint( frame ).mul( uint( 0x9E3779B9 ) ) ) } ).shiftRight( uint( 8 ) ) ).mul( 1.0 / 16777216.0 ).toVar();
			const base = uint( py ).mul( uint( renderWidth ) ).add( uint( px ) ).mul( uint( 3 ) ).toVar();
			atomicAdd( splatBuffer.element( base ), uint( floor( value.x.add( dither ) ) ) );
			atomicAdd( splatBuffer.element( base.add( uint( 1 ) ) ), uint( floor( value.y.add( dither ) ) ) );
			atomicAdd( splatBuffer.element( base.add( uint( 2 ) ) ), uint( floor( value.z.add( dither ) ) ) );

		} );

	} );

}

export function buildSplatResolveKernel( params ) {

	const { rayBufferRW, splatBuffer, renderWidth, chunkRowBase, chunkRows } = params;

	return Fn( () => {

		const gx = int( workgroupId.x ).mul( RESOLVE_WG_SIZE ).add( int( localId.x ) );
		const localGy = int( workgroupId.y ).mul( RESOLVE_WG_SIZE ).add( int( localId.y ) );

		If( gx.lessThan( renderWidth ).and( localGy.lessThan( chunkRows ) ), () => {

			const rayID = uint( localGy.mul( renderWidth ).add( gx ) );
			const base = uint( localGy.add( chunkRowBase ).mul( renderWidth ).add( gx ) ).mul( uint( 3 ) ).toVar();
			const r = atomicLoad( splatBuffer.element( base ) ).toVar();
			const g = atomicLoad( splatBuffer.element( base.add( uint( 1 ) ) ) ).toVar();
			const b = atomicLoad( splatBuffer.element( base.add( uint( 2 ) ) ) ).toVar();

			If( r.bitOr( g ).bitOr( b ).notEqual( uint( 0 ) ), () => {

				atomicStore( splatBuffer.element( base ), uint( 0 ) );
				atomicStore( splatBuffer.element( base.add( uint( 1 ) ) ), uint( 0 ) );
				atomicStore( splatBuffer.element( base.add( uint( 2 ) ) ), uint( 0 ) );
				const radiance = readRayRadiance( rayBufferRW, rayID ).toVar();
				writeRayRadiance( rayBufferRW, rayID, vec4( radiance.xyz.add( vec3( float( r ), float( g ), float( b ) ).div( SPLAT_SCALE ) ), radiance.w ) );

			} );

		} );

	} );

}

export { WG_SIZE as LIGHT_SPLAT_WG_SIZE, RESOLVE_WG_SIZE as SPLAT_RESOLVE_WG_SIZE };
