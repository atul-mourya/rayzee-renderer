/**
 * KHR_animation_pointer for a glTF's lights (KHR_lights_punctual): intensity, colour, range and the spot cones, as
 * Blender's exporter writes an animated light. three.js skips every channel that names no node, so these tracks are
 * added to their animation's clip here, keyed as three.js keys its own: the light's name, three's property. A pointer
 * to anything else (a material, a camera, a node's visibility) is reported and left out.
 */

import { AnimationClip, ColorKeyframeTrack, InterpolateDiscrete, InterpolateLinear, Interpolant, NumberKeyframeTrack } from 'three';
import { createLogger } from '../Logger.js';

const log = createLogger( 'gltf' );

const LIGHT_POINTER = /^\/extensions\/KHR_lights_punctual\/lights\/(\d+)\/(intensity|color|range|spot\/innerConeAngle|spot\/outerConeAngle)$/;

/** @param {object} parser - three's GLTFParser */
export function animationPointerPlugin( parser ) {

	return {
		name: 'KHR_animation_pointer',
		async afterRoot( result ) {

			const { json } = parser;
			const pointerOf = ( channel ) => channel.target?.extensions?.KHR_animation_pointer?.pointer;
			if ( ! json.animations?.some( ( a ) => a.channels?.some( pointerOf ) ) ) return;

			const lights = lightObjects( parser, result.scenes ?? [ result.scene ] );
			const skipped = new Set();

			for ( let a = 0; a < json.animations.length; a ++ ) {

				const def = json.animations[ a ];
				const channels = [];
				for ( const channel of def.channels ?? [] ) {

					const pointer = pointerOf( channel );
					if ( ! pointer ) continue;
					const match = LIGHT_POINTER.exec( pointer );
					if ( ! match ) {

						skipped.add( pointer.replace( /\/\d+\//g, '/n/' ) );
						continue;

					}

					channels.push( { light: Number( match[ 1 ] ), property: match[ 2 ], keys: await keysOf( parser, def.samplers[ channel.sampler ] ) } );

				}

				const tracks = channels.flatMap( ( channel ) => tracksFor( channel, channels, json, lights ) );
				if ( tracks.length === 0 ) continue;
				let clip = result.animations[ a ];
				if ( ! clip ) result.animations[ a ] = clip = new AnimationClip( def.name || `animation_${a}`, - 1, [] );
				clip.tracks.push( ...tracks );
				clip.resetDuration();

			}

			if ( skipped.size ) log.warn( `KHR_animation_pointer: only lights are animated; left out ${[ ...skipped ].join( ', ' )}` );

		},
	};

}

// Each glTF light's three.js lights: one a node naming it (three clones a light used twice).
function lightObjects( parser, scenes ) {

	const { json, associations } = parser;
	const lights = new Map();
	for ( const scene of scenes ) scene?.traverse( ( object ) => {

		if ( ! object.isLight ) return;
		// A node with a light alone is the light; with a mesh too, a group holding it.
		const node = json.nodes?.[ associations.get( object )?.nodes ?? associations.get( object.parent )?.nodes ];
		const index = node?.extensions?.KHR_lights_punctual?.light;
		if ( index === undefined ) return;
		if ( ! lights.has( index ) ) lights.set( index, [] );
		lights.get( index ).push( object );

	} );

	return lights;

}

/**
 * glTF's CUBICSPLINE (a Hermite spline, keys laid out in-tangent, value, out-tangent), as three's GLTFLoader plays it
 * for nodes: that class is not exported.
 */
class CubicSplineInterpolant extends Interpolant {

	copySampleValue_( index ) {

		const result = this.resultBuffer, size = this.valueSize, offset = index * size * 3 + size;
		for ( let i = 0; i !== size; i ++ ) result[ i ] = this.sampleValues[ offset + i ];
		return result;

	}

	interpolate_( i1, t0, t, t1 ) {

		const result = this.resultBuffer, values = this.sampleValues, size = this.valueSize;
		const td = t1 - t0, p = ( t - t0 ) / td, pp = p * p, ppp = pp * p;
		const s2 = - 2 * ppp + 3 * pp, s3 = ppp - pp, s0 = 1 - s2, s1 = s3 - pp + p;
		const offset1 = i1 * size * 3, offset0 = offset1 - size * 3;
		for ( let i = 0; i !== size; i ++ ) {

			result[ i ] = s0 * values[ offset0 + size + i ] + s1 * values[ offset0 + 2 * size + i ] * td
				+ s2 * values[ offset1 + size + i ] + s3 * values[ offset1 + i ] * td;

		}

		return result;

	}

}

/** `track`, played as glTF's cubic spline over its tangent-laid values. */
function cubicSpline( track ) {

	track.createInterpolant = function createCubicSpline( result ) {

		return new CubicSplineInterpolant( this.times, this.values, this.getValueSize() / 3, result );

	};

	// As three's GLTFLoader marks one: getInterpolation() knows no custom interpolant.
	track.createInterpolant.isInterpolantFactoryMethodGLTFCubicSpline = true;
	return track;

}

// A sampler's keys: times, values and how they are joined; a cubic spline's values with their tangents.
async function keysOf( parser, sampler ) {

	const [ input, output ] = await Promise.all( [ parser.getDependency( 'accessor', sampler.input ), parser.getDependency( 'accessor', sampler.output ) ] );
	const times = Float32Array.from( input.array );
	const values = Float32Array.from( output.array );
	const cubic = sampler.interpolation === 'CUBICSPLINE';
	return { times, values, size: output.itemSize, cubic, interpolation: sampler.interpolation === 'STEP' ? InterpolateDiscrete : InterpolateLinear };

}

// A channel's three.js tracks: one for each of its light's objects. A cone sets three's angle (outer) and penumbra
// ( 1 − inner / outer ): either channel animates the penumbra, read with the other's keys or its loaded value.
function tracksFor( channel, channels, json, lights ) {

	const objects = lights.get( channel.light ) ?? [];
	const def = json.extensions?.KHR_lights_punctual?.lights?.[ channel.light ];
	const { times, values, interpolation, cubic } = channel.keys;
	const track = ( Type, property, t, v ) => objects.map( ( light ) => {

		const out = new Type( `${light.name || light.uuid}.${property}`, t, v, interpolation );
		return cubic ? cubicSpline( out ) : out;

	} );

	switch ( channel.property ) {

		case 'intensity': return track( NumberKeyframeTrack, 'intensity', times, values );
		case 'color': return track( ColorKeyframeTrack, 'color', times, values );
		// The spec gives a directional light no range.
		case 'range': return def?.type === 'directional' ? [] : track( NumberKeyframeTrack, 'distance', times, values );

	}

	if ( def?.type !== 'spot' ) return [];
	const cone = ( name ) => channels.find( ( c ) => c.light === channel.light && c.property === `spot/${name}` );
	const outer = cone( 'outerConeAngle' ), inner = cone( 'innerConeAngle' );
	const out = channel === outer ? track( NumberKeyframeTrack, 'angle', times, values ) : [];
	// The penumbra once, from whichever cone channel comes first.
	if ( channel !== ( outer && inner ? ( channels.indexOf( outer ) < channels.indexOf( inner ) ? outer : inner ) : channel ) ) return out;
	const at = ( c, dflt, t ) => ( c ? sampleKeys( c.keys, t ) : dflt );
	// 1 − inner / outer is not linear in the cones: between keys of a joined cone it is sampled 8 times, and stepped where
	// both cones step.
	const stepped = [ outer, inner ].every( ( c ) => ! c || c.keys.interpolation === InterpolateDiscrete );
	const keys = [ ...new Set( [ ...( outer?.keys.times ?? [] ), ...( inner?.keys.times ?? [] ) ] ) ].sort( ( a, b ) => a - b );
	const keyTimes = stepped ? keys : keys.flatMap( ( t, k ) => ( k === 0 ? [ t ] : Array.from( { length: 8 }, ( _, s ) => keys[ k - 1 ] + ( t - keys[ k - 1 ] ) * ( s + 1 ) / 8 ) ) );
	const penumbra = keyTimes.map( ( t ) => {

		const o = at( outer, def.spot?.outerConeAngle ?? Math.PI / 4, t ), i = at( inner, def.spot?.innerConeAngle ?? 0, t );
		return o > 0 ? 1 - i / o : 0;

	} );
	const joined = stepped ? InterpolateDiscrete : InterpolateLinear;
	return [ ...out, ...objects.map( ( light ) => new NumberKeyframeTrack( `${light.name || light.uuid}.penumbra`, Float32Array.from( keyTimes ), penumbra, joined ) ) ];

}

// A one-value track's value at t, as it plays (linear, stepped or cubic between keys), clamped to its ends.
function sampleKeys( { times, values, interpolation, cubic }, t ) {

	if ( cubic ) return new CubicSplineInterpolant( times, values, 1, new Float32Array( 1 ) ).evaluate( t )[ 0 ];
	if ( t <= times[ 0 ] ) return values[ 0 ];
	const last = times.length - 1;
	if ( t >= times[ last ] ) return values[ last ];
	let k = 0;
	while ( times[ k + 1 ] <= t ) k ++;
	if ( interpolation === InterpolateDiscrete ) return values[ k ];
	const f = ( t - times[ k ] ) / ( times[ k + 1 ] - times[ k ] );
	return values[ k ] + f * ( values[ k + 1 ] - values[ k ] );

}
