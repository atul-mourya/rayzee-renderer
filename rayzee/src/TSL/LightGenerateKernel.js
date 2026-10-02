/**
 * LightGenerateKernel.js — starts the bidirectional light subpaths, one per pool slot, on an emissive
 * triangle or the physical sky's sun. Throughput is kept at a max channel of 1, for Russian roulette;
 * its scale rides with the emission data.
 */

import {
	Fn, float, vec3, vec4, int, uint, If, instanceIndex, atomicStore, normalize, cross, dot, max, select, Return,
	abs, sqrt, cos, sin, bool as tslBool,
} from 'three/tsl';

import { getRandomSample1D, getRandomSample2D, getDecorrelatedSeed, pcgHash } from './Random.js';
import { sampleTriangle, fetchTriangleData, binarySearchCDF, TriangleData } from './EmissiveSampling.js';
import { cosineWeightedSample } from './MaterialSampling.js';
import { offsetRayOrigin, triangleRow } from './Common.js';
import { triangleSide } from './BVHTraversal.js';
import { sampleSunDisc, sunRadianceToward } from './Sun.js';
import { lightPathPixel, mis, sunEmissionPdf, DIM_EMIT } from './Bidirectional.js';
import { RAY_FLAG, COUNTER } from '../Processor/QueueManager.js';
import {
	writeRayOriginMeta, writeRayDirFlags, writeRayThroughputPdf, writeRayRadiance, writeMediumStack,
	writeRngMis, writeLightOrigin,
} from '../Processor/PackedRayBuffer.js';

const WG_SIZE = 256;

export function buildLightGenerateKernel( params ) {

	const {
		rayBufferRW, hitBufferRW, activeIndicesRW, counters,
		lightBuffer, triangleBuffer, bvhBuffer,
		emissiveTriangleCount, emissiveVec4Offset, emissiveTotalPower, emissiveBoost,
		sunDirection, sunRadiance, sunParams, environmentIntensity,
		bidirectional, resolution, frame, transmissiveBounces,
	} = params;
	const { lightPaths } = bidirectional;

	return Fn( () => {

		const tid = instanceIndex;

		If( tid.equal( uint( 0 ) ), () => {

			atomicStore( counters.element( uint( COUNTER.ACTIVE_RAY_COUNT ) ), lightPaths );
			atomicStore( counters.element( uint( COUNTER.ENTERING_COUNT ) ), lightPaths );

		} );

		If( tid.greaterThanEqual( lightPaths ), () => {

			Return();

		} );

		activeIndicesRW.element( tid ).assign( tid );

		const pixel = lightPathPixel( tid, resolution ).toVar();
		const rng = pcgHash( { state: getDecorrelatedSeed( { pixelCoord: pixel, rayIndex: int( 3 ), frame } ) } ).toVar();

		const origin = vec3( 0.0 ).toVar();
		const direction = vec3( 0.0, 1.0, 0.0 ).toVar();
		const throughput = vec3( 0.0 ).toVar();
		const dVCM = float( 0.0 ).toVar();
		const dVC = float( 0.0 ).toVar();
		const triangle = int( - 1 ).toVar();
		const instanceLeaf = int( 0 ).toVar();
		const startCos = float( 1.0 ).toVar();
		const valid = tslBool( false ).toVar();

		If( getRandomSample1D( pixel, int( 0 ), int( DIM_EMIT + 4 ), rng, resolution, frame ).lessThan( bidirectional.sunPick ), () => {

			const toSun = sampleSunDisc( sunDirection, sunParams, getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 5 ), rng, resolution, frame ) ).toVar();
			const radiance = sunRadianceToward( toSun, sunDirection, sunRadiance, sunParams ).mul( environmentIntensity ).toVar();
			const emissionPdf = sunEmissionPdf( bidirectional, sunParams ).toVar();

			If( radiance.x.add( radiance.y ).add( radiance.z ).greaterThan( 0.0 ).and( emissionPdf.greaterThan( 0.0 ) ), () => {

				const u = normalize( cross( select( abs( toSun.x ).greaterThan( 0.9 ), vec3( 0, 1, 0 ), vec3( 1, 0, 0 ) ), toSun ) ).toVar();
				const v = cross( toSun, u );
				const disc = getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 6 ), rng, resolution, frame ).toVar();
				const r = sqrt( disc.x ).mul( bidirectional.sceneRadius );
				const phi = disc.y.mul( 2 * Math.PI );

				origin.assign( bidirectional.sceneCenter.add( toSun.mul( bidirectional.sceneRadius ) )
					.add( u.mul( cos( phi ) ).add( v.mul( sin( phi ) ) ).mul( r ) ) );
				direction.assign( toSun.negate() );
				throughput.assign( radiance.div( emissionPdf ) );
				// NEE draws this direction at 1 / solid angle, from any point; the distance is undone at the first hit.
				dVCM.assign( mis( float( 1.0 ).div( sunParams.y.mul( emissionPdf ) ) ) );
				dVC.assign( mis( float( 1.0 ).div( emissionPdf ) ) );
				valid.assign( true );

			} );

		} ).Else( () => {

			const pick = binarySearchCDF( lightBuffer, emissiveVec4Offset, emissiveTriangleCount,
				getRandomSample1D( pixel, int( 0 ), int( DIM_EMIT ), rng, resolution, frame ) ).toVar();
			const base = emissiveVec4Offset.add( pick.mul( int( 2 ) ) );
			const entry = lightBuffer.element( base ).toVar(); // triangle, power, cdf, instance leaf
			const emission = lightBuffer.element( base.add( int( 1 ) ) ).toVar(); // rgb, area
			triangle.assign( int( entry.x ) );
			instanceLeaf.assign( int( entry.w ) );

			const tri = TriangleData.wrap( fetchTriangleData( triangle, triangleBuffer, bvhBuffer, instanceLeaf ) ).toVar();
			const point = sampleTriangle( tri.v0, tri.v1, tri.v2, getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 1 ), rng, resolution, frame ) ).toVar();
			const windingN = normalize( cross( tri.v1.sub( tri.v0 ), tri.v2.sub( tri.v0 ) ) ).toVar();

			const side = triangleSide( triangleRow( triangleBuffer, triangle, 4 ).z ).toVar();
			const back = side.equal( int( 1 ) ).or( side.equal( int( 2 ) )
				.and( getRandomSample1D( pixel, int( 0 ), int( DIM_EMIT + 3 ), rng, resolution, frame ).lessThan( 0.5 ) ) ).toVar();
			const n = select( back, windingN.negate(), windingN ).toVar();
			direction.assign( cosineWeightedSample( n, getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 2 ), rng, resolution, frame ) ) );
			const cosLight = dot( direction, n ).toVar();

			const areaPdf = max( entry.y, 0.0 ).div( max( emissiveTotalPower, 1e-10 ) ).div( max( emission.w, 1e-20 ) ).mul(
				select( side.equal( int( 2 ) ), float( 0.5 ), float( 1.0 ) ) ).mul( float( 1.0 ).sub( bidirectional.sunPick ) ).toVar();
			const emissionPdf = areaPdf.mul( cosLight ).div( Math.PI ).toVar();

			If( cosLight.greaterThan( 1e-6 ).and( emissionPdf.greaterThan( 0.0 ) ), () => {

				origin.assign( offsetRayOrigin( point, n ) );
				// Le·cos / (pdfA·pdfW) = Le·π / pdfA.
				throughput.assign( emission.xyz.mul( emissiveBoost ).mul( Math.PI ).div( areaPdf ) );
				// NEE's density for this point depends on the first hit; Shade multiplies it into dVCM there.
				dVCM.assign( mis( float( 1.0 ).div( emissionPdf ) ) );
				dVC.assign( mis( cosLight.div( emissionPdf ) ) );
				// Signed: NEE samples a triangle from its winding front only, so it cannot have drawn a back start.
				startCos.assign( select( back, cosLight.negate(), cosLight ) );
				valid.assign( true );

			} );

		} );

		If( valid.not(), () => {

			writeRayDirFlags( rayBufferRW, tid, direction, uint( 0 ) );
			Return();

		} );

		const scale = max( max( max( throughput.x, throughput.y ), throughput.z ), 1e-20 ).toVar();

		writeRayOriginMeta( rayBufferRW, tid, origin, int( 0 ), int( 0 ) );
		writeRayDirFlags( rayBufferRW, tid, direction,
			uint( RAY_FLAG.ACTIVE | RAY_FLAG.REDIRECTED | RAY_FLAG.LIGHT_PATH | RAY_FLAG.LIGHT_EMITTED ) );
		writeRayThroughputPdf( rayBufferRW, tid, throughput.div( scale ), float( 0.0 ) );
		writeRayRadiance( rayBufferRW, tid, vec4( vec3( 0.0 ), float( 1.0 ) ) );
		writeMediumStack( rayBufferRW, tid, uint( 0 ), uint( transmissiveBounces ), float( 1.0 ), float( 1.0 ), float( 1.0 ) );
		writeRngMis( hitBufferRW, tid, rng, dVCM, dVC );
		// Triangle −1: the sun.
		writeLightOrigin( hitBufferRW, tid, triangle, instanceLeaf, startCos, scale );

	} );

}

export { WG_SIZE as LIGHT_GENERATE_WG_SIZE };
