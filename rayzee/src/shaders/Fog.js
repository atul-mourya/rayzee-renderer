/**
 * Fog: a medium filling an axis-aligned box, by default the scene's bounds, so the environment and the sun light it from
 * outside. Its density is `density` (per scene unit) up to the `floor` height and thins as e^(−falloff · h) above it.
 * Extinction is grey and the albedo coloured, and the optical depth along a ray has a closed form, so free-flight
 * distance sampling is exact: a path that passes through keeps its throughput, one that scatters takes the albedo.
 */

import { Fn, float, vec2, vec3, int, bool as tslBool, If, Loop, abs, dot, max, min, mix, step, exp, log, sqrt, select, length, atan, tan, clamp, sampler } from 'three/tsl';

import { powerHeuristic, balanceHeuristic, REC709_LUMINANCE_COEFFICIENTS, SHADOW_END, triangleRow } from './Common.js';
import { sampleEnvironment, sampleEnvironmentExact } from './Environment.js';
import { sunRadianceToward, sampleSunDisc } from './Sun.js';
import {
	LightSample, DirectionalLight, AreaLight, PointLight, SpotLight,
	getDirectionalLight, getAreaLight, getPointLight, getSpotLight,
} from './LightsCore.js';
import { sampleDirectionalLight, sampleRectAreaLight, samplePointLightWithAttenuation, sampleSpotLightWithRadius, lightPick } from './LightsSampling.js';
import { EmissiveSampleAnySide, sampleEmissiveTriangleAnySide } from './EmissiveSampling.js';
import { sampleLightBVHTriangleAnySide } from './LightBVHSampling.js';
import { triangleSide } from './BVHTraversal.js';

/**
 * Sampler dimensions of the fog, in its bounce's block (Random.js): 1D but DIRECTION and SEGMENT_POINT (2D).
 * EMITTER_SAMPLER is the base the emitter sampler adds its own +1 (1D) and +3 (2D) to.
 */
export const FOG_DIM = Object.freeze( {
	DISTANCE: 18, LAMP_PICK: 19, SEGMENT_PICK: 20, SEGMENT_DISTANCE: 21, SHADOW_PICK: 22, EMITTER_REFERENCE: 23, EMITTER_SAMPLER: 24,
	DIRECTION: 10, SEGMENT_POINT: 11,
} );

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

// ( 1 − e^(−x) ) / x for x ≥ 0, and −ln( 1 − z ) / z for 0 ≤ z < 1, without their cancellation near 0.
const expAverage = ( x ) => select( x.lessThan( 0.01 ),
	float( 1.0 ).sub( x.mul( float( 0.5 ).sub( x.mul( float( 1 / 6 ).sub( x.mul( float( 1 / 24 ).sub( x.div( 120 ) ) ) ) ) ) ) ),
	float( 1.0 ).sub( exp( x.negate() ) ).div( max( x, 0.01 ) ) );
const logAverage = ( z ) => select( z.lessThan( 0.01 ),
	float( 1.0 ).add( z.mul( float( 0.5 ).add( z.mul( float( 1 / 3 ).add( z.mul( float( 0.25 ).add( z.mul( 0.2 ) ) ) ) ) ) ) ),
	log( float( 1.0 ).sub( min( z, 0.9999999 ) ) ).negate().div( max( z, 0.01 ) ) );

// The span ( a, b ) of a ray at heights oy + t · dy cut where it crosses the floor, in ray order: flat below it, falling
// off above. A piece keeps its density at its denser end, so no exponent overflows however high the box reaches.
const floorPieces = ( oy, dy, a, b, density, falloff, floor ) => {

	const d = select( abs( dy ).lessThan( 1e-12 ), float( 1e-12 ), dy );
	const rising = d.greaterThan( 0.0 );
	const cut = clamp( floor.sub( oy ).div( d ), a, b ).toVar();
	const piece = ( p, q, k ) => {

		const L = max( q.sub( p ), 0.0 ).toVar();
		const low = min( oy.add( dy.mul( p ) ), oy.add( dy.mul( q ) ) ).sub( floor );
		const peak = density.mul( exp( k.mul( max( low, 0.0 ) ).negate() ) ).toVar();
		const rate = k.mul( abs( dy ) ).toVar();
		const depth = peak.mul( L ).mul( expAverage( rate.mul( L ) ) ).toVar();
		return { start: p, L, peak, rate, depth, thinning: d.greaterThan( 0.0 ).or( k.equal( 0.0 ) ) };

	};

	return [ piece( a, cut, select( rising, float( 0.0 ), falloff ) ), piece( cut, b, select( rising, falloff, float( 0.0 ) ) ) ];

};

// The distance into a piece where its optical depth reaches xi < its depth.
const pieceFlight = ( piece, xi ) => {

	const R = select( piece.thinning, xi, piece.depth.sub( xi ) );
	const ratio = R.div( piece.peak );
	const u = ratio.mul( logAverage( piece.rate.mul( ratio ) ) );
	return piece.start.add( select( piece.thinning, u, piece.L.sub( u ) ) );

};

const opticalDepth = /*@__PURE__*/ Fn( ( [ oy, dy, a, b, density, falloff, floor ] ) => {

	const [ first, second ] = floorPieces( oy, dy, a, b, density, falloff, floor );
	return select( falloff.greaterThan( 0.0 ), first.depth.add( second.depth ), density.mul( b.sub( a ) ) );

} );

const freeFlight = /*@__PURE__*/ Fn( ( [ oy, dy, a, b, xi, density, falloff, floor ] ) => {

	const [ first, second ] = floorPieces( oy, dy, a, b, density, falloff, floor );
	const rest = xi.sub( first.depth ).toVar();
	const t = select( xi.lessThan( first.depth ), pieceFlight( first, xi ), select( rest.lessThan( second.depth ), pieceFlight( second, rest ), b ) );
	return select( falloff.greaterThan( 0.0 ), t, a.add( xi.div( density ) ) );

} );

/** The fog's extinction at a point. */
export const fogDensityAt = ( fog, p ) => select( fog.falloff.greaterThan( 0.0 ), fog.density.mul( exp( fog.falloff.mul( max( p.y.sub( fog.floor ), 0.0 ) ).negate() ) ), fog.density );

/** Its optical depth along `origin + t · dir` from t = `a` to `b` ≥ `a`, both inside the box. */
export const fogOpticalDepth = ( fog, origin, dir, a, b ) => opticalDepth( origin.y, dir.y, a, b, fog.density, fog.falloff, fog.floor );

/**
 * Where a ray through the box from `a` to `b` scatters, given an exponential variate `xi` = −ln( 1 − u ): the distance
 * where its optical depth from `a` reaches xi, or one of `b` or more when the whole span holds less.
 */
export const fogFreeFlight = ( fog, origin, dir, a, b, xi ) => freeFlight( origin.y, dir.y, a, b, xi, fog.density, fog.falloff, fog.floor );

/** The fraction of light the fog lets through between `origin` and `origin + dir · tMax`. */
export const fogTransmittance = ( fog, origin, dir, tMax ) => {

	const span = fogSpan( origin, dir, tMax, fog.boxMin, fog.boxMax ).toVar();
	return exp( fogOpticalDepth( fog, origin, dir, span.x, max( span.y, span.x ) ).negate() );

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

// A light sample waiting for its shadow ray: its light unshadowed, and the ray's start, direction and length; `emissive`
// keeps an emitter's light apart for its own firefly clamp.
const lightSlot = () => ( {
	value: vec3( 0.0 ).toVar(), from: vec3( 0.0 ).toVar(), L: vec3( 0.0, 1.0, 0.0 ).toVar(), dist: float( 0.0 ).toVar(), emissive: tslBool( false ).toVar(),
} );

// A point's foot on the ray `origin + t · dir` and its distance from it, the angle the span ( near, far ) covers as seen
// from it, and a distance drawn equiangularly toward it from `u`, with its density.
const equiangular = ( origin, dir, near, far, position ) => {

	const toLight = position.sub( origin ).toVar();
	const along = dot( toLight, dir ).toVar();
	const D = max( length( toLight.sub( dir.mul( along ) ) ), far.sub( near ).mul( 1e-4 ).add( 1e-9 ) ).toVar();
	const thetaA = atan( near.sub( along ).div( D ) ).toVar();
	const thetaB = atan( far.sub( along ).div( D ) ).toVar();
	const draw = ( u ) => {

		const t = along.add( D.mul( tan( mix( thetaA, thetaB, u ) ) ) ).toVar();
		const offset = t.sub( along );
		return { t, pdf: D.div( thetaB.sub( thetaA ).mul( D.mul( D ).add( offset.mul( offset ) ) ) ) };

	};

	return { D, thetaA, thetaB, draw };

};

// The light the fog scatters toward the ray's start from distance t, per unit of incoming radiance and phase.
const inScattering = ( fog, origin, dir, near, t ) => fog.color.mul( fogDensityAt( fog, origin.add( dir.mul( t ) ) ) ).mul( exp( fogOpticalDepth( fog, origin, dir, near, t ).negate() ) );

const EMITTERS = 4;

/**
 * Light scattered toward the ray's start along the fog span ( near, far ) of `origin + t · dir`, from the point and spot
 * lights and the emitters: one of them, drawn by its unshadowed single scattering, at one distance drawn equiangularly
 * toward it (Kulla & Fajardo 2012), which cancels the 1 / d² that makes a light in fog sparkle when sampled from
 * free-flight points. Every fog segment takes it, so a scatter point leaves these lights out. The emitters are one
 * candidate, weighed as if their power sat at the centre of their light tree (any weight above 0 is unbiased).
 * Radiance before the path's throughput. `emitters`: their uniforms and buffers, and `pdf`, or null.
 */
export function fogSegmentLight( { enabled, origin, dir, near, far, g, fog, lamps, emitters, sample1D, sample2D } ) {

	const slot = lightSlot();
	const lists = [[ 2, lamps.numPoint ], [ 3, lamps.numSpot ]];
	if ( emitters ) lists.push( [ EMITTERS, select( emitters.enabled, int( 1 ), int( 0 ) ) ] );
	const lightOf = ( kind, i ) => ( kind === 2 ? PointLight.wrap( getPointLight( lamps.point, i ) ) : SpotLight.wrap( getSpotLight( lamps.spot, i ) ) );
	const count = lists.reduce( ( sum, [ , n ] ) => sum.add( n ), int( 0 ) );

	If( enabled.and( count.greaterThan( int( 0 ) ) ), () => {

		const picked = pickLight( lists, ( kind, i ) => {

			if ( kind === EMITTERS ) {

				const root = emitters.lightBuffer.element( int( 0 ) ), rootMax = emitters.lightBuffer.element( int( 1 ) );
				const centre = select( emitters.lightBVHNodeCount.greaterThan( int( 0 ) ), root.xyz.add( rootMax.xyz ).mul( 0.5 ), origin.add( dir.mul( near.add( far ).mul( 0.5 ) ) ) );
				const { D, thetaA, thetaB } = equiangular( origin, dir, near, far, centre );
				// Power, not the quarter of it a ball sends each way: the point and spot lights' weights leave out their cones.
				return max( emitters.totalPower.mul( thetaB.sub( thetaA ) ).div( D ), 1e-20 );

			}

			const light = lightOf( kind, i );
			const { D, thetaA, thetaB } = equiangular( origin, dir, near, far, light.position );
			return max( luminance( light.color ).mul( light.intensity ).mul( thetaB.sub( thetaA ) ).div( D ), 0.0 );

		}, sample1D( FOG_DIM.SEGMENT_PICK ) );

		If( picked.kind.equal( int( EMITTERS ) ), () => {

			if ( emitters ) emitterLight( { slot, origin, dir, near, far, g, fog, emitters, sample1D, pickPdf: picked.pdf } );

		} ).ElseIf( picked.kind.greaterThanEqual( int( 0 ) ), () => {

			const position = vec3( 0.0 ).toVar();
			If( picked.kind.equal( int( 2 ) ), () => {

				position.assign( PointLight.wrap( getPointLight( lamps.point, picked.index ) ).position );

			} ).Else( () => {

				position.assign( SpotLight.wrap( getSpotLight( lamps.spot, picked.index ) ).position );

			} );
			const { t, pdf: drawn } = equiangular( origin, dir, near, far, position ).draw( sample1D( FOG_DIM.SEGMENT_DISTANCE ) );
			const pdf = drawn.toVar();
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

				slot.value.assign( inScattering( fog, origin, dir, near, t ).mul( emission ).mul( henyeyGreenstein( dot( dir, slot.L ), g ) ).div( pdf.mul( picked.pdf ) ) );
				slot.dist.assign( distance.mul( SHADOW_END ) );

			} );

		} );

	} );

	return slot;

}

/**
 * The emitters' part of fogSegmentLight, picked with `pickPdf`: a point drawn on an emitter from a reference point in
 * the span, then a distance drawn equiangularly toward it, weighed against the phase draw as the emitter-hit branch
 * weighs it (`emitters.pdf( triangle, dist, L, from, instance )`, NEE's solid-angle density). ⚠️ The point is drawn
 * from either side: a side facing away from the reference faces other points of the span, and left to the phase draw
 * alone at a weight below 1 its light went missing.
 */
function emitterLight( { slot, origin, dir, near, far, g, fog, emitters, sample1D, pickPdf } ) {

	// The reference: a free flight held inside the span, where the fog scatters toward the ray's start.
	const depth = fogOpticalDepth( fog, origin, dir, near, far ).toVar();
	const z = sample1D( FOG_DIM.EMITTER_REFERENCE ).mul( depth ).mul( expAverage( depth ) ).toVar();
	const reference = origin.add( dir.mul( min( fogFreeFlight( fog, origin, dir, near, far, z.mul( logAverage( z ) ) ), far ) ) ).toVar();

	const [ pixelCoord, resolution, frame, dimBase ] = emitters.samplerArgs;
	const sampleArgs = [ reference, vec3( 0.0, 1.0, 0.0 ), emitters.rngState, pixelCoord, resolution, frame, dimBase.add( int( FOG_DIM.EMITTER_SAMPLER ) ) ];
	const e = {
		position: vec3( 0.0 ).toVar(), faceNormal: vec3( 0.0 ).toVar(), emission: vec3( 0.0 ).toVar(), areaPdf: float( 0.0 ).toVar(),
		triangle: int( 0 ).toVar(), instance: int( 0 ).toVar(), valid: tslBool( false ).toVar(),
	};
	const take = ( sample ) => {

		const s = EmissiveSampleAnySide.wrap( sample );
		e.position.assign( s.position );
		e.faceNormal.assign( s.faceNormal );
		e.emission.assign( s.emission );
		e.areaPdf.assign( s.pdf );
		e.triangle.assign( s.triangleIndex );
		e.instance.assign( s.instance );
		e.valid.assign( s.valid );

	};

	If( emitters.lightBVHNodeCount.greaterThan( int( 0 ) ), () => {

		take( sampleLightBVHTriangleAnySide( ...sampleArgs, emitters.lightBuffer, emitters.lightBuffer, emitters.vec4Offset, emitters.triangleBuffer, emitters.bvhBuffer, tslBool( true ) ) );

	} ).Else( () => {

		take( sampleEmissiveTriangleAnySide( ...sampleArgs, emitters.lightBuffer, emitters.vec4Offset, emitters.count, emitters.totalPower, emitters.triangleBuffer, emitters.bvhBuffer, tslBool( true ) ) );

	} );

	// Only the part of the span on the side the point emits toward can see its light: draw the distance there.
	const side = triangleSide( triangleRow( emitters.triangleBuffer, e.triangle, 4 ).z ).toVar();
	const facing = select( side.equal( int( 1 ) ), float( - 1.0 ), float( 1.0 ) );
	const height = dot( origin.sub( e.position ), e.faceNormal ).mul( facing );
	const climb = dot( dir, e.faceNormal ).mul( facing );
	const rate = select( abs( climb ).lessThan( 1e-12 ), float( 1e-12 ), climb ).toVar();
	const crossing = height.negate().div( rate );
	const oneSided = side.notEqual( int( 2 ) );
	const lo = select( oneSided.and( rate.greaterThan( 0.0 ) ), max( near, crossing ), near ).toVar();
	const hi = select( oneSided.and( rate.lessThan( 0.0 ) ), min( far, crossing ), far ).toVar();

	If( e.valid.and( hi.greaterThan( lo ) ), () => {

		const { t, pdf: distancePdf } = equiangular( origin, dir, lo, hi, e.position ).draw( sample1D( FOG_DIM.SEGMENT_DISTANCE ) );
		slot.from.assign( origin.add( dir.mul( t ) ) );
		const toLight = e.position.sub( slot.from ).toVar();
		const dist = length( toLight ).toVar();
		slot.L.assign( toLight.div( dist ) );
		const lightPdf = emitters.pdf( e.triangle, dist, slot.L, slot.from, e.instance ).toVar();

		If( lightPdf.greaterThan( 0.0 ), () => {

			const phaseValue = henyeyGreenstein( dot( dir, slot.L ), g ).toVar();
			// dist² × the equiangular density stays near D / ( θb − θa ): the 1/d² cancels.
			const geometry = abs( dot( slot.L, e.faceNormal ) ).div( dist.mul( dist ).mul( distancePdf ).mul( e.areaPdf ).mul( pickPdf ) );
			slot.value.assign( inScattering( fog, origin, dir, near, t ).mul( e.emission ).mul( phaseValue ).mul( geometry )
				.mul( powerHeuristic( { pdf1: lightPdf, pdf2: phaseValue } ) ).mul( emitters.boost ) );
			slot.dist.assign( dist.mul( SHADOW_END ) );
			slot.emissive.assign( true );

		} );

	} );

}

/**
 * The light reaching a fog scatter point `p` that travelled along `dir`, through the phase function and the albedo: one
 * sample each of the directional and rect lights, the sky and the sun. The last two are weighed against the phase draw,
 * whose density the miss branch reads as the bounce pdf. Before the path's throughput.
 * @returns {Object[]} light slots for traceFogLight
 */
export function fogScatterLight( ctx ) {

	const { enabled, p, dir, g, fog, sample1D, sample2D, lamps, env, sun } = ctx;
	const phase = ( L ) => henyeyGreenstein( dot( dir, L ), g );
	const lamp = lightSlot(), sky = lightSlot(), sunlight = lightSlot();

	If( enabled, () => {

		for ( const slot of [ lamp, sky, sunlight ] ) slot.from.assign( p );

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

		for ( const slot of [ lamp, sky, sunlight ] ) slot.value.mulAssign( fog.color );

	} );

	return [ lamp, sky, sunlight ];

}

/**
 * The light of the slots that gets through, tracing their shadow rays in one loop so the traversal is emitted once:
 * `direct`, and the emitters' apart (their firefly clamp is separate, as at a surface). With `picked` (the shadowRays
 * variant, 'one' or 'two') only the rays lightPick keeps are traced, all in `direct`; `u` draws them.
 */
export function traceFogLight( slots, shadow, picked = null, u = null ) {

	const direct = vec3( 0.0 ).toVar();
	const emitted = vec3( 0.0 ).toVar();

	if ( picked ) {

		const pick = lightPick( u, null, picked );
		for ( const slot of slots ) pick.offer( slot.value, slot.from, slot.L, slot.dist );
		direct.assign( pick.trace( shadow ) );
		return { direct, emitted };

	}

	const field = ( i, name ) => slots.slice( 1 ).reduce( ( acc, slot, k ) => select( i.equal( int( k + 1 ) ), slot[ name ], acc ), slots[ 0 ][ name ] );
	Loop( { start: int( 0 ), end: int( slots.length ), type: 'int', condition: '<' }, ( { i } ) => {

		const value = field( i, 'value' ).toVar();
		If( value.x.add( value.y ).add( value.z ).greaterThan( 0.0 ), () => {

			// As values: the shadow ray's Fn reads its arguments again after its own loop (CLAUDE.md pitfall 15).
			const from = field( i, 'from' ).toVar();
			const L = field( i, 'L' ).toVar();
			const dist = field( i, 'dist' ).toVar();
			const lit = value.mul( shadow( from, L, dist ) ).toVar();
			If( field( i, 'emissive' ), () => {

				emitted.addAssign( lit );

			} ).Else( () => {

				direct.addAssign( lit );

			} );

		} );

	} );

	return { direct, emitted };

}
