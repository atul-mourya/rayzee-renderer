/**
 * KHR_animation_pointer for a glTF's lights (KHR_lights_punctual: intensity, colour, range and the spot cones, as
 * Blender's exporter writes an animated light), nodes' visibility (KHR_node_visibility), a perspective camera's field
 * of view and a material's base colour, metalness, roughness and emission. three.js skips every channel that names no
 * node, so these tracks are added to their animation's clip here, keyed as three.js keys its own: the object's name,
 * three's property (`mesh.material.x` for a material's). A pointer to anything else is reported and left out. Also
 * KHR_node_visibility itself, which three.js does not read: a node marked not visible is hidden, its descendants with it.
 */

import { AnimationClip, BooleanKeyframeTrack, ColorKeyframeTrack, InterpolateDiscrete, InterpolateLinear, Interpolant, NumberKeyframeTrack } from 'three';
import { createLogger } from '../Logger.js';

const log = createLogger( 'gltf' );

const LIGHT_POINTER = /^\/extensions\/KHR_lights_punctual\/lights\/(\d+)\/(intensity|color|range|spot\/innerConeAngle|spot\/outerConeAngle)$/;
const VISIBILITY_POINTER = /^\/nodes\/(\d+)\/extensions\/KHR_node_visibility\/visible$/;
const FOV_POINTER = /^\/cameras\/(\d+)\/perspective\/yfov$/;
const MATERIAL_POINTER = /^\/materials\/(\d+)\/(pbrMetallicRoughness\/baseColorFactor|pbrMetallicRoughness\/metallicFactor|pbrMetallicRoughness\/roughnessFactor|emissiveFactor|extensions\/KHR_materials_emissive_strength\/emissiveStrength)$/;
// glTF's material property → three's, and its components a key (a base colour's alpha left out).
const MATERIAL_PROPERTIES = {
	'pbrMetallicRoughness/baseColorFactor': { property: 'color', size: 4 },
	'pbrMetallicRoughness/metallicFactor': { property: 'metalness', size: 1 },
	'pbrMetallicRoughness/roughnessFactor': { property: 'roughness', size: 1 },
	emissiveFactor: { property: 'emissive', size: 3 },
	'extensions/KHR_materials_emissive_strength/emissiveStrength': { property: 'emissiveIntensity', size: 1 },
};

// The objects a glTF node became: one, or a group holding a mesh's primitives (each scene a copy of it).
function nodeObjects( parser, scenes, index ) {

	const out = [];
	for ( const scene of scenes ) scene?.traverse( ( object ) => {

		if ( parser.associations.get( object )?.nodes === index ) out.push( object );

	} );
	return out;

}

/** @param {object} parser - three's GLTFParser */
export function nodeVisibilityPlugin( parser ) {

	return {
		name: 'KHR_node_visibility',
		afterRoot( result ) {

			( parser.json.nodes ?? [] ).forEach( ( node, index ) => {

				if ( node.extensions?.KHR_node_visibility?.visible !== false ) return;
				for ( const object of nodeObjects( parser, result.scenes ?? [ result.scene ], index ) ) object.visible = false;

			} );

		},
	};

}

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
					const target = VISIBILITY_POINTER.exec( pointer ) ?? FOV_POINTER.exec( pointer ) ?? MATERIAL_POINTER.exec( pointer ) ?? LIGHT_POINTER.exec( pointer );
					const keys = target && await keysOf( parser, def.samplers[ channel.sampler ] );
					if ( target && ! keys ) {

						log.warn( `KHR_animation_pointer: ${pointer} has a cubic spline whose values are not three a key — left out` );
						continue;

					}

					const node = VISIBILITY_POINTER.exec( pointer );
					if ( node ) {

						channels.push( { node: Number( node[ 1 ] ), keys } );
						continue;

					}

					const material = MATERIAL_POINTER.exec( pointer );
					if ( material ) {

						channels.push( { material: Number( material[ 1 ] ), ...MATERIAL_PROPERTIES[ material[ 2 ] ], keys } );
						continue;

					}

					const camera = FOV_POINTER.exec( pointer );
					if ( camera ) {

						channels.push( { camera: Number( camera[ 1 ] ), keys } );
						continue;

					}

					const match = LIGHT_POINTER.exec( pointer );
					if ( ! match ) {

						skipped.add( pointer.replace( /\/\d+\//g, '/n/' ) );
						continue;

					}

					channels.push( { light: Number( match[ 1 ] ), property: match[ 2 ], keys } );

				}

				const scenes = result.scenes ?? [ result.scene ];
				const tracks = channels.flatMap( ( channel ) => {

					// A boolean a key, stepped (the only interpolation the extension allows).
					if ( channel.node !== undefined ) return nodeObjects( parser, scenes, channel.node ).map( ( object ) => new BooleanKeyframeTrack( `${object.name || object.uuid}.visible`, channel.keys.times, Array.from( keyValues( channel.keys ), ( v ) => v !== 0 ) ) );
					if ( channel.camera !== undefined ) return fovTracks( parser, scenes, channel );
					if ( channel.material !== undefined ) return materialTracks( parser, scenes, channel );
					return tracksFor( channel, channels, json, lights );

				} );
				if ( tracks.length === 0 ) continue;
				let clip = result.animations[ a ];
				if ( ! clip ) result.animations[ a ] = clip = new AnimationClip( def.name || `animation_${a}`, - 1, [] );
				clip.tracks.push( ...tracks );
				clip.resetDuration();

			}

			if ( skipped.size ) log.warn( `KHR_animation_pointer: only lights, node visibility, a camera's field of view and a material's colour, metalness, roughness and emission are animated; left out ${[ ...skipped ].join( ', ' )}` );

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

// A sampler's keys: times, values and how they are joined; a cubic spline's values with their tangents. Null for a
// cubic spline without three values a key: its interpolant's value size would not be whole, and its loops never end.
async function keysOf( parser, sampler ) {

	const [ input, output ] = await Promise.all( [ parser.getDependency( 'accessor', sampler.input ), parser.getDependency( 'accessor', sampler.output ) ] );
	const cubic = sampler.interpolation === 'CUBICSPLINE';
	if ( cubic && output.count !== 3 * input.count ) return null;
	return { times: Float32Array.from( input.array ), values: Float32Array.from( output.array ), cubic, interpolation: sampler.interpolation === 'STEP' ? InterpolateDiscrete : InterpolateLinear };

}

// A track's values without a cubic spline's tangents.
const keyValues = ( { values, cubic, times } ) => ( cubic ? values.filter( ( _, i ) => Math.floor( i / ( values.length / times.length / 3 ) ) % 3 === 1 ) : values );

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

// A material's property on each mesh drawn with it (three.js gives a mesh of several primitives one mesh a primitive).
function materialTracks( parser, scenes, { material, property, size, keys } ) {

	const { times, interpolation, cubic } = keys;
	const values = size === 4 ? keys.values.filter( ( _, i ) => i % 4 !== 3 ) : keys.values;
	const Type = size === 1 ? NumberKeyframeTrack : ColorKeyframeTrack;
	const meshes = [];
	let lacking = false;
	for ( const scene of scenes ) scene?.traverse( ( object ) => {

		if ( ! object.isMesh || Array.isArray( object.material ) || parser.associations.get( object.material )?.materials !== material ) return;
		// An unlit material (MeshBasicMaterial) has no metalness, roughness or emission.
		if ( object.material[ property ] === undefined ) lacking = true;
		else meshes.push( object );

	} );
	if ( lacking ) log.warn( `KHR_animation_pointer: material ${material} has no ${property} (unlit?) — left out there` );
	return meshes.map( ( mesh ) => {

		const track = new Type( `${mesh.name || mesh.uuid}.material.${property}`, times, values, interpolation );
		return cubic ? cubicSpline( track ) : track;

	} );

}

// A camera's vertical field of view, radians in glTF, degrees on three's camera: on each node that shows the camera.
function fovTracks( parser, scenes, { camera, keys } ) {

	const { times, values, interpolation, cubic } = keys;
	const degrees = values.map( ( v ) => v * 180 / Math.PI );
	return ( parser.json.nodes ?? [] ).flatMap( ( node, index ) => ( node.camera === camera ? nodeObjects( parser, scenes, index ) : [] ) )
		.flatMap( ( object ) => {

			const target = object.isCamera ? object : object.children.find( ( c ) => c.isCamera );
			if ( ! target?.isPerspectiveCamera ) return [];
			const track = new NumberKeyframeTrack( `${target.name || target.uuid}.fov`, times, degrees, interpolation );
			return [ cubic ? cubicSpline( track ) : track ];

		} );

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
