/**
 * LightGenerateKernel.js — starts the bidirectional light subpaths, one per pool slot, on a source picked from
 * the source table: an emissive triangle, the physical sky's sun, the environment, or a lamp. Throughput is kept at a max channel
 * of 1, for Russian roulette; its scale rides with the emission data.
 */

import {
	Fn, float, vec3, vec4, int, uint, If, instanceIndex, atomicStore, normalize, cross, dot, max, select, Return,
	abs, sqrt, cos, sin, Loop, sampler, bool as tslBool,
} from 'three/tsl';

import { getRandomSample1D, getRandomSample2D, getDecorrelatedSeed, pcgHash } from './Random.js';
import { sampleTriangle, fetchTriangleData, binarySearchCDF, TriangleData } from './EmissiveSampling.js';
import { cosineWeightedSample } from './MaterialSampling.js';
import { offsetRayOrigin, triangleRow } from './Common.js';
import { triangleSide } from './BVHTraversal.js';
import { sampleSunDisc, sunRadianceToward } from './Sun.js';
import { sampleEnvironment, sampleEnvironmentExact } from './Environment.js';
import {
	DirectionalLight, AreaLight, PointLight, SpotLight, getDirectionalLight, getAreaLight, getPointLight, getSpotLight,
	getSpotAttenuation, sampleSpotGoboMask, sampleIESProfile, sampleCone, LIGHT_TYPE_DIRECTIONAL, LIGHT_TYPE_AREA, LIGHT_TYPE_POINT,
} from './LightsCore.js';
import { areaLightRadiance, areaLightSpreadAttenuation } from './LightsSampling.js';
import { spotConeSolidAngle, directionalConeSolidAngle } from './BidirectionalLamps.js';
import {
	lightPathPixel, mis, sunEmissionPdf, sourcePick, sourceLampType, sourceLampIndex, sceneDiscPdf, SOURCE, DIM_EMIT,
} from './Bidirectional.js';
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
		envTexture, envCDFTexture, envMatrix, envResolution,
		directionalLightsBuffer, areaLightsBuffer, pointLightsBuffer, spotLightsBuffer,
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

		const xiSource = getRandomSample1D( pixel, int( 0 ), int( DIM_EMIT + 4 ), rng, resolution, frame ).toVar();
		const source = int( 0 ).toVar();
		const hi = int( bidirectional.sourceCount - 1 ).toVar();
		Loop( source.lessThan( hi ), () => {

			const mid = source.add( hi ).div( 2 ).toVar();
			If( bidirectional.sourceCdf.element( mid ).lessThanEqual( xiSource ), () => {

				source.assign( mid.add( 1 ) );

			} ).Else( () => {

				hi.assign( mid );

			} );

		} );

		// From the scene's bounding disc facing `toLight`, for a light at infinity.
		const discOrigin = ( toLight ) => {

			const u = normalize( cross( select( abs( toLight.x ).greaterThan( 0.9 ), vec3( 0, 1, 0 ), vec3( 1, 0, 0 ) ), toLight ) ).toVar();
			const v = cross( toLight, u );
			const disc = getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 6 ), rng, resolution, frame ).toVar();
			const r = sqrt( disc.x ).mul( bidirectional.sceneRadius );
			const phi = disc.y.mul( 2 * Math.PI );
			return bidirectional.sceneCenter.add( toLight.mul( bidirectional.sceneRadius ) ).add( u.mul( cos( phi ) ).add( v.mul( sin( phi ) ) ).mul( r ) );

		};

		If( source.equal( int( SOURCE.SUN ) ), () => {

			const toSun = sampleSunDisc( sunDirection, sunParams, getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 5 ), rng, resolution, frame ) ).toVar();
			const radiance = sunRadianceToward( toSun, sunDirection, sunRadiance, sunParams ).mul( environmentIntensity ).toVar();
			const emissionPdf = sunEmissionPdf( bidirectional, sunParams ).toVar();

			If( radiance.x.add( radiance.y ).add( radiance.z ).greaterThan( 0.0 ).and( emissionPdf.greaterThan( 0.0 ) ), () => {

				origin.assign( discOrigin( toSun ) );
				direction.assign( toSun.negate() );
				throughput.assign( radiance.div( emissionPdf ) );
				// NEE draws this direction at 1 / solid angle, from any point; the distance is undone at the first hit.
				dVCM.assign( mis( float( 1.0 ).div( sunParams.y.mul( emissionPdf ) ) ) );
				dVC.assign( mis( float( 1.0 ).div( emissionPdf ) ) );
				valid.assign( true );

			} );

		} ).ElseIf( source.equal( int( SOURCE.EMITTERS ) ), () => {

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
				select( side.equal( int( 2 ) ), float( 0.5 ), float( 1.0 ) ) ).mul( bidirectional.emitterPick ).toVar();
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

		} ).ElseIf( source.equal( int( SOURCE.ENVIRONMENT ) ), () => {

			const drawn = sampleEnvironmentExact( envCDFTexture, envMatrix, envResolution,
				getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 5 ), rng, resolution, frame ) );
			const toEnvironment = drawn.direction.toVar();
			const directionPdf = drawn.pdf.toVar();
			const radiance = sampleEnvironment( {
				tex: envTexture, samp: sampler( envTexture ), direction: toEnvironment, environmentMatrix: envMatrix, environmentIntensity, enableEnvironmentLight: float( 1.0 ),
			} ).xyz.toVar();
			const emissionPdf = bidirectional.envPick.mul( directionPdf ).mul( sceneDiscPdf( bidirectional ) ).toVar();

			If( radiance.x.add( radiance.y ).add( radiance.z ).greaterThan( 0.0 ).and( emissionPdf.greaterThan( 0.0 ) ), () => {

				origin.assign( discOrigin( toEnvironment ) );
				direction.assign( toEnvironment.negate() );
				throughput.assign( radiance.div( emissionPdf ) );
				// NEE draws the direction from the same table, from any point.
				dVCM.assign( mis( directionPdf.div( emissionPdf ) ) );
				dVC.assign( mis( float( 1.0 ).div( emissionPdf ) ) );
				triangle.assign( int( - 1 - SOURCE.ENVIRONMENT ) );
				valid.assign( true );

			} );

		} ).ElseIf( source.greaterThanEqual( int( SOURCE.LAMPS ) ), () => {

			// NEE's density depends on where the light lands; Shade multiplies it into dVCM there.
			const pick = sourcePick( bidirectional, source ).toVar();
			const type = sourceLampType( bidirectional, source ).toVar();
			const index = sourceLampIndex( bidirectional, source, type ).toVar();
			triangle.assign( int( - 1 ).sub( source ) );
			const emissionPdf = float( 0.0 ).toVar();
			const radiance = vec3( 0.0 ).toVar();
			const xi = getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 2 ), rng, resolution, frame ).toVar();

			If( type.equal( int( LIGHT_TYPE_DIRECTIONAL ) ), () => {

				const light = DirectionalLight.wrap( getDirectionalLight( directionalLightsBuffer, index ) );
				const toLight = normalize( light.direction ).toVar();
				radiance.assign( light.color.mul( light.intensity ) );
				emissionPdf.assign( pick.mul( sceneDiscPdf( bidirectional ) ) );
				If( light.angle.greaterThan( 0.0 ), () => {

					const solidAngle = directionalConeSolidAngle( light ).toVar();
					toLight.assign( sampleCone( toLight, light.angle.mul( 0.5 ), getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 5 ), rng, resolution, frame ) ) );
					radiance.divAssign( solidAngle );
					emissionPdf.divAssign( solidAngle );

				} );
				origin.assign( discOrigin( toLight ) );
				direction.assign( toLight.negate() );

			} ).ElseIf( type.equal( int( LIGHT_TYPE_AREA ) ), () => {

				const light = AreaLight.wrap( getAreaLight( areaLightsBuffer, index ) );
				const disk = light.shape.greaterThan( 0.5 );
				const p = getRandomSample2D( pixel, int( 0 ), int( DIM_EMIT + 1 ), rng, resolution, frame ).toVar();
				const r = sqrt( p.x );
				const phi = p.y.mul( 2 * Math.PI );
				origin.assign( light.position.add( light.u.mul( select( disk, r.mul( cos( phi ) ), p.x.mul( 2.0 ).sub( 1.0 ) ) ) )
					.add( light.v.mul( select( disk, r.mul( sin( phi ) ), p.y.mul( 2.0 ).sub( 1.0 ) ) ) ) );
				direction.assign( cosineWeightedSample( light.normal, xi ) );
				const cosLight = dot( direction, light.normal ).toVar();
				radiance.assign( select( light.area.greaterThan( 0.0 ).and( cosLight.greaterThan( 1e-6 ) ),
					areaLightRadiance( light ).mul( areaLightSpreadAttenuation( cosLight, light.spread ) ).mul( cosLight ), vec3( 0.0 ) ) );
				emissionPdf.assign( pick.div( max( light.area, 1e-20 ) ).mul( cosLight ).div( Math.PI ) );
				dVC.assign( mis( cosLight.div( max( emissionPdf, 1e-30 ) ) ) );

			} ).ElseIf( type.equal( int( LIGHT_TYPE_POINT ) ), () => {

				const light = PointLight.wrap( getPointLight( pointLightsBuffer, index ) );
				origin.assign( light.position );
				direction.assign( sampleCone( vec3( 0.0, 1.0, 0.0 ), float( Math.PI ), xi ) );
				radiance.assign( light.color.mul( light.intensity ) );
				emissionPdf.assign( pick.div( 4 * Math.PI ) );

			} ).Else( () => {

				const light = SpotLight.wrap( getSpotLight( spotLightsBuffer, index ) );
				origin.assign( light.position );
				direction.assign( sampleCone( light.direction, light.angle, xi ) );
				const toLight = direction.negate();
				radiance.assign( light.color.mul( light.intensity )
					.mul( getSpotAttenuation( { coneCosine: cos( light.angle ), blend: light.penumbra, angleCosine: dot( direction, light.direction ) } ) )
					.mul( sampleSpotGoboMask( light, toLight ) ).mul( sampleIESProfile( light, toLight ) ) );
				emissionPdf.assign( pick.div( spotConeSolidAngle( light ) ) );

			} );

			If( radiance.x.add( radiance.y ).add( radiance.z ).greaterThan( 0.0 ).and( emissionPdf.greaterThan( 0.0 ) ), () => {

				throughput.assign( radiance.div( emissionPdf ) );
				dVCM.assign( mis( float( 1.0 ).div( emissionPdf ) ) );
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
		writeLightOrigin( hitBufferRW, tid, triangle, instanceLeaf, startCos, scale );

	} );

}

export { WG_SIZE as LIGHT_GENERATE_WG_SIZE };
