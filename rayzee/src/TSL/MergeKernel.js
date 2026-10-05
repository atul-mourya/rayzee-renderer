/**
 * MergeKernel.js — vertex merging (Georgiev et al. 2012, "Light Transport Simulation with Vertex Connection and
 * Merging"): each camera vertex Shade left pending gathers the light vertices within the merge radius, as photon
 * mapping does, MIS-weighted against every other strategy. It is the one strategy for light no path can connect:
 * a lamp behind glass seen in a mirror, a caustic seen through water.
 *
 * The radius is a few pixels' footprint where the camera vertex is (Bidirectional.js mergeRadiusAt), so it grows
 * with the distance from the camera. The light vertex cache is filed by that radius in shells, each a hash grid of
 * cells two of its largest radii wide: one list a cell, threaded through the cached records' spare lane (`next`),
 * built after the light pass by mergeInsert. A gather searches the one or two shells its sphere reaches, 2³ cells each.
 */

import {
	Fn, float, vec3, vec4, int, uint, ivec3, If, Loop, instanceIndex, atomicLoad, atomicStore, atomicFunc, Return, dot, floor, max, min, select,
	length, log2, exp2, Break, abs,
} from 'three/tsl';

import { evaluateMaterialResponse } from './MaterialEvaluation.js';
import { calculateMaterialPDF } from './LightsSampling.js';
import { luminance } from './Common.js';
import { regularizePathContribution } from './PathTracerCore.js';
import { resolveSurfaceMaterial, misMergePartial, misWeight, strategyWeight, mergeRadiusAt, mergeEta, facingSide, STRATEGY } from './Bidirectional.js';
import { COUNTER } from '../Processor/QueueManager.js';
import {
	readRayRadiance, writeRayRadiance, pendingVertex, cachedVertex, readVertexTag, readVertexRecord, readVertexPosition,
	readVertexNext, writeVertexNext, readLightPathLength,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 256;
export const MERGE_EMPTY = 0xFFFFFFFF;
// A cell's list is walked at most this far: a bound on the work, never reached at the radius the radius scale gives.
const MAX_CELL_STEPS = 1024;

// Shells of radius ratio 1.25: a sphere whose radius changes by (1 ± slope) across it spans at most two.
export const MERGE_SHELL_RATIO = 1.25;
const LOG2_RATIO = Math.log2( MERGE_SHELL_RATIO );

const shellOf = ( bdpt, radius ) => int( max( floor( log2( radius.div( bdpt.mergeMin ) ).div( LOG2_RATIO ) ), 0.0 ) );

// Twice the largest radius whose sphere can reach the shell (its own largest, over 1 − slope).
const shellCell = ( bdpt, shell ) => bdpt.mergeMin.mul( exp2( float( shell.add( int( 1 ) ) ).mul( LOG2_RATIO ) ) ).mul( 2.0 )
	.div( max( float( 1.0 ).sub( bdpt.mergeSlope ), 0.5 ) );

const cellHash = ( shell, cell, hashMask ) => uint( cell.x ).mul( uint( 73856093 ) )
	.bitXor( uint( cell.y ).mul( uint( 19349663 ) ) )
	.bitXor( uint( cell.z ).mul( uint( 83492791 ) ) )
	.bitXor( uint( shell ).mul( uint( 2654435761 ) ) )
	.bitAnd( hashMask );

// A light vertex's shell and cell.
const filing = ( bdpt, p ) => {

	const shell = shellOf( bdpt, mergeRadiusAt( bdpt, p ) ).toVar();
	return { shell, cell: ivec3( floor( p.div( shellCell( bdpt, shell ) ) ) ).toVar() };

};

/** Empties every list head. */
export function buildMergeClearKernel( { head, hashSize } ) {

	return Fn( () => {

		If( instanceIndex.lessThan( uint( hashSize ) ), () => {

			atomicStore( head.element( instanceIndex ), uint( MERGE_EMPTY ) );

		} );

	} )().compute( Math.ceil( hashSize / WG_SIZE ) * WG_SIZE, [ WG_SIZE ] );

}

/** Files each light vertex of this frame at the head of its cell's list. */
export function buildMergeInsertKernel( { hitBufferRW, head, bidirectional: bdpt } ) {

	const { lightPaths, slotsPerPath, lightTag, hashMask } = bdpt;

	return Fn( () => {

		const slot = instanceIndex.toVar();
		If( slot.greaterThanEqual( lightPaths.mul( slotsPerPath ) ), () => {

			Return();

		} );

		const depth = slot.mod( slotsPerPath ).toVar();
		If( depth.greaterThanEqual( readLightPathLength( hitBufferRW, cachedVertex( slot.sub( depth ) ), lightTag ) ), () => {

			Return();

		} );

		const at = cachedVertex( slot );
		const { shell, cell } = filing( bdpt, readVertexPosition( hitBufferRW, at ) );
		const bucket = cellHash( shell, cell, hashMask );
		writeVertexNext( hitBufferRW, at, atomicFunc( 'atomicExchange', head.element( bucket ), slot ) );

	} );

}

export function buildMergeKernel( params ) {

	const {
		rayBufferRW, hitBufferRO, activeIndicesRO, counters, head, materialBuffer, bidirectional: bdpt,
		maxBounceCount, globalIlluminationIntensity, fireflyThreshold, accumFrame,
		// Some material passes light through diffusely: light arriving from behind its surface merges too.
		diffuseTransmission = true,
	} = params;
	const { passTag, slotsPerPath, strategyView, hashMask } = bdpt;

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

		const cam = readVertexRecord( hitBufferRO, pending );
		const cameraDepth = int( cam.extra ).toVar();
		// A merged path of k scattering vertices: the camera's cameraDepth + 1 and the light's l share one.
		const lightBudget = int( maxBounceCount ).add( int( 1 ) ).sub( cameraDepth ).toVar();
		const material = resolveSurfaceMaterial( cam.materialIndex, cam.uv, cam.N, materialBuffer );
		const gathered = vec3( 0.0 ).toVar();

		const radius = mergeRadiusAt( bdpt, cam.position ).toVar();
		const radius2 = radius.mul( radius ).toVar();
		const eta = mergeEta( bdpt, radius ).toVar();
		const trusted = eta.mul( bdpt.mergeTrust );
		const vc = float( 1.0 ).div( max( trusted.mul( trusted ), 1e-30 ) ).toVar();
		// The shells the sphere reaches: its radius at its nearest and farthest points from the camera.
		const distance = length( cam.position.sub( bdpt.cameraPosition ) ).toVar();
		const nearShell = shellOf( bdpt, max( bdpt.mergeConst.add( bdpt.mergeSlope.mul( max( distance.sub( radius ), 0.0 ) ) ), bdpt.mergeMin ) ).toVar();
		const farShell = min( shellOf( bdpt, bdpt.mergeConst.add( bdpt.mergeSlope.mul( distance.add( radius ) ) ) ), nearShell.add( int( 1 ) ) ).toVar();

		// Per shell, the 2 × 2 × 2 cells the sphere can reach, the cells being at least two radii wide.
		Loop( { start: int( 0 ), end: int( 16 ), type: 'int', condition: '<' }, ( { i } ) => {

			const shell = nearShell.add( i.shiftRight( int( 3 ) ) ).toVar();
			If( shell.greaterThan( farShell ), () => {

				Break();

			} );
			const cellSize = shellCell( bdpt, shell ).toVar();
			const corner = i.bitAnd( int( 7 ) );
			const cell = ivec3( floor( cam.position.div( cellSize ).sub( 0.5 ) ) )
				.add( ivec3( corner.bitAnd( int( 1 ) ), corner.shiftRight( int( 1 ) ).bitAnd( int( 1 ) ), corner.shiftRight( int( 2 ) ) ) ).toVar();
			const slot = atomicLoad( head.element( cellHash( shell, cell, hashMask ) ) ).toVar();
			const steps = int( 0 ).toVar();

			Loop( slot.notEqual( uint( MERGE_EMPTY ) ).and( steps.lessThan( int( MAX_CELL_STEPS ) ) ), () => {

				const at = cachedVertex( slot );
				const position = readVertexPosition( hitBufferRO, at ).toVar();
				const offset = position.sub( cam.position );
				const l = int( slot.mod( slotsPerPath ) ).add( int( 1 ) ).toVar();
				If( dot( offset, offset ).lessThan( radius2 ).and( l.lessThanEqual( lightBudget ) ), () => {

					// Its own shell and cell only: two lists sharing a bucket (a hash collision) must not count it twice.
					const own = filing( bdpt, position );
					If( own.shell.equal( shell ).and( own.cell.x.equal( cell.x ) ).and( own.cell.y.equal( cell.y ) ).and( own.cell.z.equal( cell.z ) ), () => {

						const light = readVertexRecord( hitBufferRO, at );
						const cosShading = dot( light.V, cam.N ).toVar();
						const cosFacet = dot( light.V, cam.facetN ).toVar();
						// Light arriving on this side, or from behind a surface that passes it through diffusely. A corner's
						// other wall stays in: its light vertices stand in for the part of the sphere past the corner, which
						// the density divides by too.
						const onThisSide = cosShading.greaterThan( 0.0 ).and( cosFacet.greaterThan( 0.0 ) );
						const throughSurface = material.diffuseTransmission.greaterThan( 0.0 ).and( cosShading.lessThan( 0.0 ) ).and( cosFacet.lessThan( 0.0 ) );
						If( diffuseTransmission ? onThisSide.or( throughSurface ) : onThisSide, () => {

							const f = evaluateMaterialResponse( cam.V, light.V, cam.N, material );
							const wLight = misMergePartial( light, calculateMaterialPDF( cam.V, light.V, cam.N, material ), vc );
							const reverseN = diffuseTransmission ? facingSide( cam.N, light.V, material ) : cam.N;
							const wCamera = misMergePartial( cam, calculateMaterialPDF( light.V, cam.V, reverseN, material ), vc );
							const scattering = cameraDepth.add( l );
							// Alone, a path of k scattering vertices is reached by k merges.
							const weight = strategyWeight( strategyView, STRATEGY.MERGE, misWeight( wLight, wCamera ), float( 1.0 ).div( float( scattering ) ) );
							const gi = select( scattering.greaterThan( int( 1 ) ), globalIlluminationIntensity, float( 1.0 ) );
							// The photon's flux is per unit area; the BSDF wants it per projected solid angle (Veach 5.3.2).
							const correction = diffuseTransmission ? abs( cosShading ).div( max( abs( cosFacet ), 1e-4 ) ) : cosShading.div( max( cosFacet, 1e-4 ) );
							gathered.addAssign( regularizePathContribution(
								cam.throughput.mul( f ).mul( light.throughput ).mul( weight.mul( correction ).div( eta ).mul( gi ) ),
								float( scattering.sub( int( 1 ) ) ), fireflyThreshold, int( accumFrame ),
							) );

						} );

					} );

				} );

				slot.assign( readVertexNext( hitBufferRO, at ) );
				steps.addAssign( int( 1 ) );

			} );

		} );

		If( luminance( gathered ).greaterThan( 0.0 ), () => {

			const radiance = readRayRadiance( rayBufferRW, rayID ).toVar();
			writeRayRadiance( rayBufferRW, rayID, vec4( radiance.xyz.add( gathered ), radiance.w ) );

		} );

	} );

}

export { WG_SIZE as MERGE_WG_SIZE };
