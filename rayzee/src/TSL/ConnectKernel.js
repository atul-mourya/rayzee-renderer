/**
 * ConnectKernel.js — connects each camera vertex Shade left pending to one vertex of a random light
 * path, weighted by how many of that path's vertices fit the bounce budget (Davidovič et al. 2014).
 */

import {
	Fn, float, vec2, vec4, int, uint, If, instanceIndex, atomicLoad, Return, dot, sqrt, min, max, length, select, abs,
} from 'three/tsl';

import { getRandomSample1D, pcgHash, SAMPLER_DIMS_PER_BOUNCE } from './Random.js';
import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { calculateMaterialPDF } from './LightsSampling.js';
import { traceShadowRayRefractiveOpaque } from './LightsDirect.js';
import { traverseBVHShadow } from './BVHTraversal.js';
import { offsetRayOrigin, SHADOW_END, luminance } from './Common.js';
import { regularizePathContribution } from './PathTracerCore.js';
import {
	resolveSurfaceMaterial, lightEndCosine, misPartial, misWeight, strategyWeight, facingSide, STRATEGY, DIM_CONNECT_PATH, DIM_CONNECT_VERTEX,
} from './Bidirectional.js';
import { COUNTER } from '../Processor/QueueManager.js';
import {
	readRayRadiance, writeRayRadiance, readRngState,
	pendingVertex, cachedVertex, readVertexTag, readVertexRecord, readLightPathLength,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 256;

export function buildConnectKernel( params ) {

	const {
		rayBufferRW, hitBufferRO, activeIndicesRO, counters,
		bvhBuffer, triangleBuffer, materialBuffer,
		resolution, frame, accumFrame, currentBounce, chunkRowBase,
		lightPaths, slotsPerPath, lightTag, passTag, strategyView,
		maxBounceCount, globalIlluminationIntensity, fireflyThreshold,
		// Vertex merging's η² at a point (Bidirectional.js mergeVmAt), or null without it.
		mergeVm = null,
		// Some material passes light through diffusely: a connection may then reach either end from behind.
		diffuseTransmission = true,
	} = params;

	return Fn( () => {

		const tid = instanceIndex;
		If( tid.greaterThanEqual( atomicLoad( counters.element( uint( COUNTER.ENTERING_COUNT ) ) ) ), () => {

			Return();

		} );

		const rayID = activeIndicesRO.element( tid ).toVar();
		const pending = pendingVertex( rayID );
		If( readVertexTag( hitBufferRO, pending ).notEqual( passTag ), () => {

			Return();

		} );

		const camRecord = readVertexRecord( hitBufferRO, pending );
		const cam = { ...camRecord, vm: mergeVm?.( camRecord.position ) ?? null };
		const cameraVertices = int( cam.extra ).add( int( 1 ) ).toVar();

		const resX = int( resolution.x );
		const globalPixel = int( rayID ).add( chunkRowBase.mul( resX ) );
		const pixel = vec2( float( globalPixel.mod( resX ) ).add( 0.5 ), float( globalPixel.div( resX ) ).add( 0.5 ) ).toVar();
		const dimBase = int( currentBounce ).mul( int( SAMPLER_DIMS_PER_BOUNCE ) );
		// Only PCG reads it; hashed so the path's own stream, already saved by Shade, is not replayed.
		const rng = pcgHash( { state: readRngState( hitBufferRO, rayID ).bitXor( uint( 0x9E3779B9 ) ) } ).toVar();
		const uPath = getRandomSample1D( pixel, int( 0 ), dimBase.add( int( DIM_CONNECT_PATH ) ), rng, resolution, frame ).toVar();
		const uVertex = getRandomSample1D( pixel, int( 0 ), dimBase.add( int( DIM_CONNECT_VERTEX ) ), rng, resolution, frame ).toVar();

		const path = min( uint( float( lightPaths ).mul( uPath ) ), lightPaths.sub( uint( 1 ) ) ).toVar();
		const first = path.mul( slotsPerPath ).toVar();
		const stored = int( readLightPathLength( hitBufferRO, cachedVertex( first ), lightTag ) );
		const usable = min( stored, int( maxBounceCount ).add( int( 1 ) ).sub( cameraVertices ) ).toVar();
		If( usable.lessThan( int( 1 ) ), () => {

			Return();

		} );

		const c = min( int( float( usable ).mul( uVertex ) ), usable.sub( int( 1 ) ) ).toVar();
		const lightRecord = readVertexRecord( hitBufferRO, cachedVertex( first.add( uint( c ) ) ) );
		const light = { ...lightRecord, vm: mergeVm?.( lightRecord.position ) ?? null };

		const toLight = light.position.sub( cam.position ).toVar();
		const dist2 = max( dot( toLight, toLight ), 1e-12 ).toVar();
		const dir = toLight.div( sqrt( dist2 ) ).toVar();

		const cosCamera = dot( dir, cam.N ).toVar();
		const cosCameraFacet = dot( dir, cam.facetN ).toVar();
		const cosLightFacet = dot( dir, light.facetN ).negate().toVar();
		// The camera end tests as NEE does; at the light end the camera vertex is the viewer, which only the facet bounds.
		// Through a surface that transmits diffusely, either end may also be reached from behind (checked below).
		const inFront = cosCamera.greaterThan( 0.0 ).and( cosCameraFacet.greaterThan( 0.0 ) ).and( cosLightFacet.greaterThan( 0.0 ) );
		const cameraBehind = cosCamera.lessThan( 0.0 ).and( cosCameraFacet.lessThan( 0.0 ) );
		const lightBehind = cosLightFacet.lessThan( 0.0 );
		const possible = diffuseTransmission
			? cameraBehind.or( cosCamera.greaterThan( 0.0 ).and( cosCameraFacet.greaterThan( 0.0 ) ) )
				.and( lightBehind.or( cosLightFacet.greaterThan( 0.0 ) ) )
			: inFront;
		If( possible.not(), () => {

			Return();

		} );

		const cameraMaterial = resolveSurfaceMaterial( cam.materialIndex, cam.uv, cam.N, materialBuffer );
		const lightMaterial = resolveSurfaceMaterial( light.materialIndex, light.uv, light.N, materialBuffer );
		const toCamera = dir.negate();
		if ( diffuseTransmission ) If( cameraBehind.and( cameraMaterial.diffuseTransmission.lessThanEqual( 0.0 ) )
			.or( lightBehind.and( lightMaterial.diffuseTransmission.lessThanEqual( 0.0 ) ) ), () => {

			Return();

		} );

		// Each end's BSDF and densities read in the frame with their own first direction on top.
		const camN = ( toward ) => ( diffuseTransmission ? facingSide( cam.N, toward, cameraMaterial ) : cam.N );
		const lightN = ( toward ) => ( diffuseTransmission ? facingSide( light.N, toward, lightMaterial ) : light.N );
		const fCamera = evaluateMaterialResponse( cam.V, dir, cam.N, cameraMaterial ).toVar();
		const fLight = evaluateMaterialResponse( toCamera, light.V, lightN( toCamera ), lightMaterial ).toVar();
		const geometry = ( diffuseTransmission ? abs( cosCamera ) : cosCamera ).mul( lightEndCosine( light.V, light.N, light.facetN, toCamera ) ).div( dist2 );

		const cameraForward = calculateMaterialPDF( cam.V, dir, cam.N, cameraMaterial );
		const cameraReverse = calculateMaterialPDF( dir, cam.V, camN( dir ), cameraMaterial );
		const lightForward = calculateMaterialPDF( light.V, toCamera, light.N, lightMaterial );
		const lightReverse = calculateMaterialPDF( toCamera, light.V, lightN( toCamera ), lightMaterial );

		// Georgiev (40)-(41): each side's sum, from the other side's density of reaching it.
		const wLight = misPartial( cameraForward.mul( diffuseTransmission ? abs( cosLightFacet ) : cosLightFacet ).div( dist2 ), light, lightReverse );
		const wCamera = misPartial( lightForward.mul( diffuseTransmission ? abs( cosCameraFacet ) : cosCameraFacet ).div( dist2 ), cam, cameraReverse );

		const scattering = cameraVertices.add( c ).add( int( 1 ) );
		// Alone, a path of k scattering vertices is reached by k − 1 connections.
		const weight = strategyWeight( strategyView, STRATEGY.CONNECT, misWeight( wLight, wCamera ), float( 1.0 ).div( float( scattering.sub( int( 1 ) ) ) ) );
		const contribution = regularizePathContribution(
			cam.throughput.mul( fCamera ).mul( fLight ).mul( light.throughput )
				.mul( geometry.mul( weight ).mul( float( usable ) ).mul( globalIlluminationIntensity ) ),
			float( scattering.sub( int( 1 ) ) ), fireflyThreshold, int( accumFrame ),
		).toVar();

		If( luminance( contribution ).greaterThan( 0.0 ), () => {

			// Each end of the shadow ray leaves from the side the connection takes.
			const origin = offsetRayOrigin( cam.position, diffuseTransmission ? select( cameraBehind, cam.facetN.negate(), cam.facetN ) : cam.facetN ).toVar();
			const segment = offsetRayOrigin( light.position, diffuseTransmission ? select( lightBehind, light.facetN.negate(), light.facetN ) : light.facetN ).sub( origin ).toVar();
			const segmentLength = length( segment ).toVar();
			const visibility = traceShadowRayRefractiveOpaque(
				origin, segment.div( segmentLength ), segmentLength.mul( SHADOW_END ),
				traverseBVHShadow, bvhBuffer, triangleBuffer, materialBuffer,
			);

			If( visibility.greaterThan( 0.0 ), () => {

				const radiance = readRayRadiance( rayBufferRW, rayID ).toVar();
				writeRayRadiance( rayBufferRW, rayID, vec4( radiance.xyz.add( contribution.mul( visibility ) ), radiance.w ) );

			} );

		} );

	} );

}

export { WG_SIZE as CONNECT_WG_SIZE };
