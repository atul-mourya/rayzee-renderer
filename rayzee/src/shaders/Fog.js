/**
 * Fog: a homogeneous medium filling an axis-aligned box, by default the scene's bounds, so the environment and the sun
 * light it from outside. Extinction is grey (`density`, per scene unit) and the albedo coloured, so free-flight distance
 * sampling is exact: a path that passes through keeps its throughput, one that scatters takes the albedo.
 */

import { Fn, float, vec2, vec3, int, bool as tslBool, If, Loop, abs, dot, max, min, mix, step, exp, sqrt, select, length, atan, tan, sampler } from 'three/tsl';

import { powerHeuristic, balanceHeuristic, REC709_LUMINANCE_COEFFICIENTS, SHADOW_END } from './Common.js';
import { sampleEnvironment, sampleEnvironmentExact } from './Environment.js';
import { sunRadianceToward, sampleSunDisc } from './Sun.js';
import {
	LightSample, DirectionalLight, AreaLight, PointLight, SpotLight,
	getDirectionalLight, getAreaLight, getPointLight, getSpotLight,
} from './LightsCore.js';
import { sampleDirectionalLight, sampleRectAreaLight, samplePointLightWithAttenuation, sampleSpotLightWithRadius, lightPick } from './LightsSampling.js';
import { EmissiveSample, sampleEmissiveTriangle } from './EmissiveSampling.js';
import { sampleLightBVHTriangle } from './LightBVHSampling.js';

/** Sampler dimensions of the fog, in its bounce's block (Random.js): 1D but DIRECTION and SEGMENT_POINT (2D). */
export const FOG_DIM = Object.freeze( { DISTANCE: 18, LAMP_PICK: 19, SEGMENT_PICK: 20, SEGMENT_DISTANCE: 21, SHADOW_PICK: 22, DIRECTION: 10, SEGMENT_POINT: 11 } );

/** Where a ray from `origin` along `dir`, up to `tMax`, is inside the box: ( enter, leave ), empty when leave ≤ enter. */
export const fogSpan = /*@__PURE__*/ Fn( ( [ origin, dir, tMax, boxMin, boxMax ] ) => {

	// Per channel: a TSL select follows its condition's first channel only.
	const d = mix( dir, vec3( 1e-12 ), step( abs( dir ), vec3( 1e-12 ) ) );
	const t0 = boxMin.sub( origin ).div( d ).toVar();
	const t1 = boxMax.sub( origin ).div( d ).toVar();
	const near = min( t0, t1 );
	const far = max( t0, t1 );
	return vec2( max( max( max( near.x, near.y ), near.z ), 0.0 ), min( min( min( far.x, far.y ), far.z ), tMax ) );

} );

/** The fraction of light the fog lets through between `origin` and `origin + dir · tMax`. */
export const fogTransmittance = ( fog, origin, dir, tMax ) => {

	const span = fogSpan( origin, dir, tMax, fog.boxMin, fog.boxMax ).toVar();
	return exp( fog.density.mul( max( span.y.sub( span.x ), 0.0 ) ).negate() );

};

/** Henyey–Greenstein, `cosTheta` from the travel direction (g > 0 scatters forward), as sampleHenyeyGreenstein draws it. */
export const henyeyGreenstein = /*@__PURE__*/ Fn( ( [ cosTheta, g ] ) => {

	const denom = max( float( 1.0 ).add( g.mul( g ) ).sub( g.mul( 2.0 ).mul( cosTheta ) ), 1e-8 );
	return float( 1.0 ).sub( g.mul( g ) ).div( denom.mul( sqrt( denom ) ).mul( 4 * Math.PI ) );

} );

const luminance = ( c ) => dot( c, REC709_LUMINANCE_COEFFICIENTS );

// One light drawn ∝ `weight( kind, i )` over `lists` of [ kind, count ]: { kind, index, pdf }, kind −1 when none weighs
// anything. The weight is computed twice, identically, so the second pass finds the light the first one's total names.
const pickLight = ( lists, weight, u ) => {

	const total = float( 0.0 ).toVar();
	for ( const [ kind, count ] of lists ) {

		Loop( { start: int( 0 ), end: count, type: 'int', condition: '<' }, ( { i } ) => {

			total.addAssign( weight( kind, i ) );

		} );

	}

	const picked = { kind: int( - 1 ).toVar(), index: int( 0 ).toVar(), pdf: float( 0.0 ).toVar() };
	If( total.greaterThan( 0.0 ), () => {

		const target = u.mul( total ).toVar();
		const running = float( 0.0 ).toVar();
		for ( const [ kind, count ] of lists ) {

			Loop( { start: int( 0 ), end: count, type: 'int', condition: '<' }, ( { i } ) => {

				If( picked.kind.lessThan( int( 0 ) ), () => {

					const w = weight( kind, i ).toVar();
					running.addAssign( w );
					If( w.greaterThan( 0.0 ).and( running.greaterThan( target ) ), () => {

						picked.kind.assign( int( kind ) );
						picked.index.assign( i );
						picked.pdf.assign( w.div( total ) );

					} );

				} );

			} );

		}

	} );
	return picked;

};

// A light sample waiting for its shadow ray: its light unshadowed, and the ray's start, direction and length.
const lightSlot = () => ( { value: vec3( 0.0 ).toVar(), from: vec3( 0.0 ).toVar(), L: vec3( 0.0, 1.0, 0.0 ).toVar(), dist: float( 0.0 ).toVar() } );

/**
 * Point and spot lights scattered toward the camera along the fog span ( near, far ) of the ray `origin + t · dir`: one
 * light, drawn by its unshadowed single scattering, at one point drawn equiangularly toward it (Kulla & Fajardo 2012),
 * which cancels the 1 / d² that makes a lamp in fog sparkle when sampled from free-flight points. Every fog segment
 * takes it, so a scatter point leaves these lights out. Radiance before the path's throughput.
 */
export function fogSegmentLight( { enabled, origin, dir, near, far, g, fog, lamps, sample1D, sample2D } ) {

	const slot = lightSlot();
	const lists = [[ 2, lamps.numPoint ], [ 3, lamps.numSpot ]];
	const lightOf = ( kind, i ) => ( kind === 2 ? PointLight.wrap( getPointLight( lamps.point, i ) ) : SpotLight.wrap( getSpotLight( lamps.spot, i ) ) );
	const floor = far.sub( near ).mul( 1e-4 ).add( 1e-9 );
	// The light's foot on the ray and its distance from it, and the angle the span covers as seen from the light.
	const geometry = ( position ) => {

		const toLight = position.sub( origin ).toVar();
		const along = dot( toLight, dir ).toVar();
		const D = max( length( toLight.sub( dir.mul( along ) ) ), floor ).toVar();
		const thetaA = atan( near.sub( along ).div( D ) ).toVar();
		const thetaB = atan( far.sub( along ).div( D ) ).toVar();
		return { along, D, thetaA, thetaB };

	};

	If( enabled.and( lamps.numPoint.add( lamps.numSpot ).greaterThan( int( 0 ) ) ), () => {

		const picked = pickLight( lists, ( kind, i ) => {

			const light = lightOf( kind, i );
			const { D, thetaA, thetaB } = geometry( light.position );
			return max( luminance( light.color ).mul( light.intensity ).mul( thetaB.sub( thetaA ) ).div( D ), 0.0 );

		}, sample1D( FOG_DIM.SEGMENT_PICK ) );

		If( picked.kind.greaterThanEqual( int( 0 ) ), () => {

			const position = vec3( 0.0 ).toVar();
			If( picked.kind.equal( int( 2 ) ), () => {

				position.assign( PointLight.wrap( getPointLight( lamps.point, picked.index ) ).position );

			} ).Else( () => {

				position.assign( SpotLight.wrap( getSpotLight( lamps.spot, picked.index ) ).position );

			} );
			const { along, D, thetaA, thetaB } = geometry( position );
			const t = along.add( D.mul( tan( mix( thetaA, thetaB, sample1D( FOG_DIM.SEGMENT_DISTANCE ) ) ) ) ).toVar();
			const offset = t.sub( along );
			const pdf = D.div( thetaB.sub( thetaA ).mul( D.mul( D ).add( offset.mul( offset ) ) ) ).toVar();
			slot.from.assign( origin.add( dir.mul( t ) ) );

			const ruv = sample2D( FOG_DIM.SEGMENT_POINT ).toVar();
			const valid = tslBool( false ).toVar();
			const emission = vec3( 0.0 ).toVar();
			const distance = float( 0.0 ).toVar();
			const take = ( sample ) => {

				const ls = LightSample.wrap( sample );
				valid.assign( ls.valid );
				slot.L.assign( ls.direction );
				emission.assign( ls.emission );
				distance.assign( ls.distance );

			};

			If( picked.kind.equal( int( 2 ) ), () => {

				take( samplePointLightWithAttenuation( PointLight.wrap( getPointLight( lamps.point, picked.index ) ), slot.from, float( 1.0 ), ruv ) );

			} ).Else( () => {

				take( sampleSpotLightWithRadius( SpotLight.wrap( getSpotLight( lamps.spot, picked.index ) ), slot.from, float( 1.0 ), ruv ) );

			} );

			If( valid.and( pdf.greaterThan( 0.0 ) ), () => {

				const scattered = fog.color.mul( fog.density ).mul( exp( fog.density.mul( t.sub( near ) ).negate() ) );
				slot.value.assign( scattered.mul( emission ).mul( henyeyGreenstein( dot( dir, slot.L ), g ) ).div( pdf.mul( picked.pdf ) ) );
				slot.dist.assign( distance.mul( SHADOW_END ) );

			} );

		} );

	} );

	return slot;

}

/**
 * The light reaching a fog scatter point `p` that travelled along `dir`, through the phase function and the albedo: one
 * sample each of the directional and rect lamps, the sky, the sun and the emitters. The last three are weighed against
 * the phase draw, whose density the miss and emitter-hit branches read as the bounce pdf. Before the path's throughput.
 * @returns {{ direct: Object[], emitter: ?Object }} light slots for traceFogLight
 */
export function fogScatterLight( ctx ) {

	const { enabled, p, dir, g, fog, sample1D, sample2D, lamps, env, sun, emitters } = ctx;
	const phase = ( L ) => henyeyGreenstein( dot( dir, L ), g );
	const lamp = lightSlot(), sky = lightSlot(), sunlight = lightSlot(), emitter = emitters ? lightSlot() : null;

	If( enabled, () => {

		for ( const slot of [ lamp, sky, sunlight, emitter ].filter( Boolean ) ) slot.from.assign( p );

		const picked = pickLight( [[ 0, lamps.numDirectional ], [ 1, lamps.numArea ]], ( kind, i ) => {

			if ( kind === 0 ) {

				const light = DirectionalLight.wrap( getDirectionalLight( lamps.directional, i ) );
				return max( luminance( light.color ).mul( light.intensity ), 0.0 );

			}

			const light = AreaLight.wrap( getAreaLight( lamps.area, i ) );
			const toLight = light.position.sub( p );
			const power = select( light.normalize.greaterThan( 0.5 ), float( 1.0 ), light.area );
			return max( luminance( light.color ).mul( light.intensity ).mul( power ).div( max( dot( toLight, toLight ), light.area ) ), 0.0 );

		}, sample1D( FOG_DIM.LAMP_PICK ) );

		If( picked.kind.greaterThanEqual( int( 0 ) ), () => {

			const xi = sample2D( 2 ).toVar();
			const valid = tslBool( false ).toVar();
			const emission = vec3( 0.0 ).toVar();
			const distance = float( 0.0 ).toVar();
			const lightPdf = float( 0.0 ).toVar();
			const take = ( sample ) => {

				const ls = LightSample.wrap( sample );
				valid.assign( ls.valid );
				lamp.L.assign( ls.direction );
				emission.assign( ls.emission );
				distance.assign( ls.distance );
				lightPdf.assign( ls.pdf );

			};

			If( picked.kind.equal( int( 0 ) ), () => {

				take( sampleDirectionalLight( DirectionalLight.wrap( getDirectionalLight( lamps.directional, picked.index ) ), p, picked.pdf, xi.x, sample1D( 14 ) ) );

			} ).Else( () => {

				take( sampleRectAreaLight( AreaLight.wrap( getAreaLight( lamps.area, picked.index ) ), p, vec2( xi.y, sample1D( 15 ) ), picked.pdf ) );

			} );

			If( valid.and( lightPdf.greaterThan( 0.0 ) ), () => {

				lamp.value.assign( emission.mul( phase( lamp.L ) ).div( lightPdf ) );
				lamp.dist.assign( select( picked.kind.equal( int( 0 ) ), float( 1e20 ), distance.mul( SHADOW_END ) ) );

			} );

		} );

		If( env.enabled, () => {

			If( env.totalSum.greaterThan( 0.0 ), () => {

				const drawn = sampleEnvironmentExact( env.cdf, env.matrix, env.resolution, sample2D( 1 ) );
				sky.L.assign( drawn.direction );
				const lightPdf = drawn.pdf.toVar();
				If( lightPdf.greaterThan( 0.0 ), () => {

					const radiance = sampleEnvironment( {
						tex: env.texture, samp: sampler( env.texture ), direction: sky.L, environmentMatrix: env.matrix, environmentIntensity: env.intensity, enableEnvironmentLight: float( 1.0 ),
					} ).xyz;
					const phaseValue = phase( sky.L ).toVar();
					sky.value.assign( radiance.mul( phaseValue ).mul( balanceHeuristic( { pdf1: lightPdf, pdf2: phaseValue } ) ).div( lightPdf ) );
					sky.dist.assign( 1e20 );

				} );

			} );

			If( sun.hasSun.greaterThan( int( 0 ) ), () => {

				sunlight.L.assign( sampleSunDisc( sun.direction, sun.params, sample2D( 9 ) ) );
				const radiance = sunRadianceToward( sunlight.L, sun.direction, sun.radiance, sun.params ).mul( env.intensity ).toVar();
				If( radiance.x.add( radiance.y ).add( radiance.z ).greaterThan( 0.0 ), () => {

					const lightPdf = float( 1.0 ).div( sun.params.y );
					const phaseValue = phase( sunlight.L ).toVar();
					sunlight.value.assign( radiance.mul( phaseValue ).mul( powerHeuristic( { pdf1: lightPdf, pdf2: phaseValue } ) ).div( lightPdf ) );
					sunlight.dist.assign( 1e20 );

				} );

			} );

		} );

		if ( emitter ) If( emitters.enabled, () => {

			const sampleArgs = [ p, vec3( 0.0, 1.0, 0.0 ), emitters.rngState, ...emitters.samplerArgs ];
			const e = { position: vec3( 0.0 ).toVar(), emission: vec3( 0.0 ).toVar(), pdf: float( 0.0 ).toVar(), valid: tslBool( false ).toVar() };
			const take = ( sample ) => {

				const s = EmissiveSample.wrap( sample );
				e.position.assign( s.position );
				e.emission.assign( s.emission );
				e.pdf.assign( s.pdf );
				e.valid.assign( s.valid );

			};

			If( emitters.lightBVHNodeCount.greaterThan( int( 0 ) ), () => {

				take( sampleLightBVHTriangle( ...sampleArgs, emitters.lightBuffer, emitters.lightBuffer, emitters.vec4Offset, emitters.triangleBuffer, emitters.bvhBuffer, tslBool( true ) ) );

			} ).Else( () => {

				take( sampleEmissiveTriangle( ...sampleArgs, emitters.lightBuffer, emitters.vec4Offset, emitters.count, emitters.totalPower, emitters.triangleBuffer, emitters.bvhBuffer, tslBool( true ) ) );

			} );

			If( e.valid.and( e.pdf.greaterThan( 0.0 ) ), () => {

				const toSample = e.position.sub( p ).toVar();
				const span = length( toSample ).toVar();
				emitter.L.assign( toSample.div( span ) );
				const phaseValue = phase( emitter.L ).toVar();
				emitter.value.assign( e.emission.mul( phaseValue ).mul( powerHeuristic( { pdf1: e.pdf, pdf2: phaseValue } ) ).mul( emitters.boost ).div( e.pdf ) );
				emitter.dist.assign( span.mul( SHADOW_END ) );

			} );

		} );

		for ( const slot of [ lamp, sky, sunlight, emitter ].filter( Boolean ) ) slot.value.mulAssign( fog.color );

	} );

	return { direct: [ lamp, sky, sunlight ], emitter };

}

/**
 * The light of the slots that gets through, tracing their shadow rays in one loop so the traversal is emitted once:
 * `direct`, and the emitters' apart (their firefly clamp is separate, as at a surface). With `picked` (the shadowRays
 * variant, 'one' or 'two') only the rays lightPick keeps are traced, all in `direct`; `u` draws them.
 */
export function traceFogLight( slots, emitter, shadow, picked = null, u = null ) {

	const all = emitter ? [ ...slots, emitter ] : slots;
	const direct = vec3( 0.0 ).toVar();
	const emitted = vec3( 0.0 ).toVar();

	if ( picked ) {

		const pick = lightPick( u, null, picked );
		for ( const slot of all ) pick.offer( slot.value, slot.from, slot.L, slot.dist );
		direct.assign( pick.trace( shadow ) );
		return { direct, emitted };

	}

	const field = ( i, name ) => all.slice( 1 ).reduce( ( acc, slot, k ) => select( i.equal( int( k + 1 ) ), slot[ name ], acc ), all[ 0 ][ name ] );
	Loop( { start: int( 0 ), end: int( all.length ), type: 'int', condition: '<' }, ( { i } ) => {

		const value = field( i, 'value' ).toVar();
		If( value.x.add( value.y ).add( value.z ).greaterThan( 0.0 ), () => {

			// As values: the shadow ray's Fn reads its arguments again after its own loop (CLAUDE.md pitfall 15).
			const from = field( i, 'from' ).toVar();
			const L = field( i, 'L' ).toVar();
			const dist = field( i, 'dist' ).toVar();
			const lit = value.mul( shadow( from, L, dist ) ).toVar();
			if ( emitter ) If( i.equal( int( all.length - 1 ) ), () => {

				emitted.assign( lit );

			} ).Else( () => {

				direct.addAssign( lit );

			} );
			else direct.addAssign( lit );

		} );

	} );

	return { direct, emitted };

}
