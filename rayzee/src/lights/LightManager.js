import {
	EventDispatcher, DirectionalLight, PointLight, SpotLight, RectAreaLight,
	Object3D, MathUtils, Vector3
} from 'three';
import { toPortable, fromPortable } from '../Portable.js';

// Set on lights a host added, which live in the light scene alone: a rebuild re-transfers the
// model's lights and keeps these.
const USER_LIGHT = '__rayzeeUserLight';

const LIGHT_TYPES = { DirectionalLight, PointLight, SpotLight, RectAreaLight };

// A model light's copy at its source's world transform, an area light's scale taken into its size (`base`, before any
// scale). Returns the world scale applied, for the next placement's base.
function placeCopy( source, copy, base ) {

	source.updateWorldMatrix( true, false );
	source.getWorldPosition( copy.position );
	source.getWorldQuaternion( copy.quaternion );
	source.getWorldScale( copy.scale );
	const scale = [ copy.scale.x, copy.scale.y ];

	if ( copy.isRectAreaLight ) {

		copy.width = base[ 0 ] * scale[ 0 ];
		copy.height = base[ 1 ] * scale[ 1 ];
		copy.scale.set( 1, 1, 1 );

	}

	copy.updateMatrixWorld();
	return scale;

}

// What a placement can change on a copy.
const placement = ( copy ) => [ ...copy.matrixWorld.elements, copy.width, copy.height, ...( copy.target?.position.toArray() ?? [] ) ];

// What a clip can animate on a light besides its placement, each as the source last showed it.
const FOLLOWED = [ 'intensity', 'visible', 'distance', 'decay', 'angle', 'penumbra' ];
const VISIBLE = FOLLOWED.indexOf( 'visible' );
// Shown only when it and every parent are, as three.js draws it.
const shown = ( object ) => {

	for ( let o = object; o; o = o.parent ) if ( ! o.visible ) return false;
	return true;

};

const looks = ( light ) => [ ...FOLLOWED.map( ( key ) => ( key === 'visible' ? shown( light ) : light[ key ] ) ), light.color.r, light.color.g, light.color.b ];

/**
 * Manages scene lights: add, remove, transfer from mesh scene to WebGPU
 * scene, sync helpers, and update GPU uniform buffers.
 *
 * Extracted from PathTracerApp to keep the facade slim.
 */
export class LightManager extends EventDispatcher {

	/**
	 * @param {import('three').Scene}      scene          - WebGPU light scene
	 * @param {import('../scene/SceneHelpers.js').SceneHelpers} sceneHelpers
	 * @param {import('../pathtracer/PathTracer.js').PathTracer} pathTracer
	 * @param {Object} [options]
	 * @param {Function} [options.onReset] - Callback to reset accumulation after light changes
	 * @param {Function} [options.onLightRemoved] - Called with each light before it leaves the scene
	 */
	constructor( scene, sceneHelpers, pathTracer, options = {} ) {

		super();

		this.scene = scene;
		this.sceneHelpers = sceneHelpers;
		this.pathTracer = pathTracer;
		this._onReset = options.onReset || null;
		this._onLightRemoved = options.onLightRemoved || null;
		// A model light → { its copy, the source's world scale last applied to the copy's size }.
		this._copies = new Map();

	}

	/**
	 * Adds a light to the scene and updates the path tracer.
	 *
	 * @param {string} type - 'DirectionalLight' | 'PointLight' | 'SpotLight' | 'RectAreaLight'
	 * @returns {Object|null} Light descriptor or null if type is invalid
	 */
	addLight( type ) {

		const defaults = {
			// Power in Watts (Blender-style) for point/spot/area; Sun is W/m² strength.
			DirectionalLight: { position: [ 1, 1, 1 ], intensity: 1.0, color: '#ffffff' },
			PointLight: { position: [ 0, 2, 0 ], intensity: 1000, color: '#ffffff' },
			SpotLight: { position: [ 0, 1, 0 ], intensity: 1000, color: '#ffffff', angle: 15 },
			RectAreaLight: { position: [ 0, 2, 0 ], intensity: 100, color: '#ffffff', width: 2, height: 2 }
		};

		const props = defaults[ type ];
		if ( ! props ) return null;

		let light;

		if ( type === 'DirectionalLight' ) {

			light = new DirectionalLight( props.color, props.intensity );
			light.position.fromArray( props.position );

		} else if ( type === 'PointLight' ) {

			light = new PointLight( props.color, props.intensity );
			light.position.fromArray( props.position );

		} else if ( type === 'SpotLight' ) {

			light = new SpotLight( props.color, props.intensity );
			light.position.fromArray( props.position );
			light.angle = MathUtils.degToRad( props.angle );
			const target = new Object3D();
			this.scene.add( target );
			light.target = target;

		} else if ( type === 'RectAreaLight' ) {

			light = new RectAreaLight( props.color, props.intensity, props.width, props.height );
			light.position.fromArray( props.position );
			light.lookAt( 0, 0, 0 );
			// Blender-style emission defaults: power-normalized, full Lambertian
			// hemisphere (spread = π), rectangular shape.
			light.userData.normalize = true;
			light.userData.spread = Math.PI;
			light.userData.shape = 'rectangle';

		}

		light.userData[ USER_LIGHT ] = true;

		// Blender-style emission controls common to every light type.
		light.userData.temperature = 6500;
		light.userData.useTemperature = false;
		light.userData.exposure = 0;

		const count = this.scene.getObjectsByProperty( 'isLight', true ).length;
		light.name = `${type.replace( 'Light', '' )} ${count + 1}`;
		this.scene.add( light );
		this.updateLights();
		this._syncHelpers();
		this._onReset?.();

		return this._buildDescriptor( light );

	}

	/**
	 * The light the path tracer traces, by UUID from getAll(). A model's own lights are copied in
	 * at load, so editing those does nothing: edit this one, then call sync().
	 * @param {string} uuid
	 * @returns {?import('three').Light}
	 */
	getLight( uuid ) {

		const light = this.scene.getObjectByProperty( 'uuid', uuid );
		return light?.isLight ? light : null;

	}

	/**
	 * Sets a traced light's intensity (watts, or W/m² for directional — see docs/guide/scenes.md) and uploads it.
	 * @param {string} uuid
	 * @param {number} intensity
	 * @returns {boolean} false when no traced light has that UUID
	 */
	setIntensity( uuid, intensity ) {

		const light = this.getLight( uuid );
		if ( ! light ) return false;

		light.intensity = intensity;
		this.updateLights();
		this._onReset?.();
		return true;

	}

	/**
	 * Removes a light by UUID.
	 * @param {string} uuid
	 * @returns {boolean}
	 */
	removeLight( uuid ) {

		const light = this.scene.getObjectByProperty( 'uuid', uuid );
		if ( ! light || ! light.isLight ) return false;

		this._onLightRemoved?.( light );
		this.sceneHelpers.remove( light );
		if ( light.target ) light.target.removeFromParent();
		light.removeFromParent();
		this.updateLights();
		this._onReset?.();
		return true;

	}

	/**
	 * Removes all lights from the scene.
	 */
	clearLights() {

		this.sceneHelpers.clear();
		this._removeAllLights();
		this.updateLights();
		this._onReset?.();

	}

	/**
	 * Returns descriptors for all lights in the scene.
	 * @returns {Object[]}
	 */
	getLights() {

		return this.scene.getObjectsByProperty( 'isLight', true ).map( light => this._buildDescriptor( light ) );

	}

	/**
	 * Reprocesses all scene lights and updates the path tracer uniform buffers,
	 * and refreshes any visible helper gizmos so they reflect parameter changes
	 * (intensity, cone angle, position, target, distance) without rebuilding.
	 */
	updateLights() {

		this.pathTracer?.updateLights();
		if ( this.sceneHelpers?.visible ) this.sceneHelpers.update();

	}

	/**
	 * Clones lights from the mesh scene into the WebGPU light scene,
	 * then updates GPU uniform buffers.
	 * @param {import('three').Scene} meshScene
	 * @param {{keepUserLights?: boolean}} [options] - keep the lights a host added (an incremental rebuild)
	 */
	transferSceneLights( meshScene, { keepUserLights = false } = {} ) {

		this._removeAllLights( keepUserLights ? light => ! light.userData?.[ USER_LIGHT ] : undefined );

		const sourceLights = meshScene.getObjectsByProperty( 'isLight', true );

		if ( ! sourceLights || sourceLights.length === 0 ) {

			this.updateLights();
			return;

		}

		for ( const light of sourceLights ) {

			const cloned = light.clone();
			cloned.visible = shown( light );
			this._copies.set( light, { copy: cloned, scale: placeCopy( light, cloned, [ cloned.width, cloned.height ] ), seen: looks( light ) } );

			if ( ( light.isSpotLight || light.isDirectionalLight ) && light.target ) {

				const clonedTarget = new Object3D();
				light.target.updateWorldMatrix( true, false );
				light.target.getWorldPosition( clonedTarget.position );
				this.scene.add( clonedTarget );
				cloned.target = clonedTarget;

			}

			this.scene.add( cloned );

		}

		this.updateLights();
		this._syncHelpers();

	}

	/**
	 * Moves the copies of model lights an animation moved (`sources`: the model's own lights, their world matrices
	 * current) to where their sources now are, and aims them at their targets. A host's edit to a copy's size is kept;
	 * its place and aim follow the source. Its intensity, colour, visibility, range, falloff and cone follow the source
	 * where the source changed since: a host's edit stays until the clip changes that one.
	 * @param {import('three').Light[]} sources
	 * @returns {boolean} whether any copy changed
	 */
	followSources( sources ) {

		let moved = false;
		for ( const source of sources ) {

			const entry = this._copies.get( source );
			if ( ! entry || entry.copy.parent !== this.scene ) continue;
			const { copy } = entry;
			const before = placement( copy );
			entry.scale = placeCopy( source, copy, [ copy.width / ( entry.scale[ 0 ] || 1 ), copy.height / ( entry.scale[ 1 ] || 1 ) ] );
			if ( source.target && copy.target && copy.target !== source.target ) {

				source.target.updateWorldMatrix( true, false );
				source.target.getWorldPosition( copy.target.position );
				copy.target.updateMatrixWorld();

			}

			if ( placement( copy ).some( ( v, i ) => v !== before[ i ] ) ) moved = true;
			const now = looks( source );
			FOLLOWED.forEach( ( key, i ) => {

				if ( now[ i ] === entry.seen[ i ] ) return;
				copy[ key ] = now[ i ];
				moved = true;

			} );
			if ( now.slice( - 3 ).some( ( v, i ) => v !== entry.seen[ FOLLOWED.length + i ] ) ) {

				copy.color.copy( source.color );
				moved = true;

			}

			entry.seen = now;

		}

		if ( moved ) this.updateLights();
		return moved;

	}

	/**
	 * Shows or hides the copies of model lights whose source was shown or hidden since, itself or through a parent
	 * (the outliner hiding a group). A host's edit of a copy stays until then.
	 * @returns {boolean} whether any copy changed
	 */
	followVisibility() {

		let changed = false;
		for ( const [ source, entry ] of this._copies ) {

			const now = shown( source );
			if ( entry.copy.parent !== this.scene || now === entry.seen[ VISIBLE ] ) continue;
			entry.copy.visible = now;
			entry.seen[ VISIBLE ] = now;
			changed = true;

		}

		if ( changed ) this.updateLights();
		return changed;

	}

	/**
	 * Shows/hides light helpers.
	 * @param {boolean} show
	 */
	setShowLightHelper( show ) {

		this.sceneHelpers.visible = show;

		if ( show ) {

			this._syncHelpers();

		} else {

			this.sceneHelpers.clear();

		}

	}

	/**
	 * Every light as plain data, for a saved session: the model's (with any edits) and the host's.
	 * @returns {Object[]}
	 */
	serialize() {

		return this.scene.getObjectsByProperty( 'isLight', true ).map( light => {

			const record = {
				type: light.type,
				name: light.name,
				visible: light.visible,
				color: [ light.color.r, light.color.g, light.color.b ],
				intensity: light.intensity,
				position: light.position.toArray(),
				quaternion: light.quaternion.toArray(),
				scale: light.scale.toArray(),
				userData: toPortable( light.userData ) ?? {},
			};

			if ( light.isSpotLight ) Object.assign( record, { angle: light.angle, penumbra: light.penumbra, distance: light.distance, decay: light.decay } );
			if ( light.isPointLight ) Object.assign( record, { distance: light.distance, decay: light.decay } );
			if ( light.isRectAreaLight ) Object.assign( record, { width: light.width, height: light.height } );
			if ( light.target && ( light.isSpotLight || light.isDirectionalLight ) ) record.target = light.target.position.toArray();
			return record;

		} );

	}

	/**
	 * Replaces every light with the ones {@link serialize} described.
	 * @param {Object[]} records
	 * @returns {import('three').Light[]} the new lights, in record order (unknown types skipped)
	 */
	restore( records ) {

		this.sceneHelpers?.clear();
		// A model light's restored copy is matched to it by type and name, in order, so its animation still moves it.
		const linked = [ ...this._copies ].map( ( [ source, entry ] ) => ( { source, entry } ) );
		this._removeAllLights();

		const lights = [];
		for ( const record of records ?? [] ) {

			const Type = LIGHT_TYPES[ record.type ];
			if ( ! Type ) continue;

			const light = new Type();
			light.name = record.name ?? '';
			light.visible = record.visible !== false;
			light.color.setRGB( ...record.color );
			light.intensity = record.intensity;
			light.position.fromArray( record.position );
			light.quaternion.fromArray( record.quaternion );
			light.scale.fromArray( record.scale ?? [ 1, 1, 1 ] );
			light.userData = fromPortable( record.userData ) ?? {};

			for ( const key of [ 'angle', 'penumbra', 'distance', 'decay', 'width', 'height' ] ) {

				if ( typeof record[ key ] === 'number' ) light[ key ] = record[ key ];

			}

			if ( record.target ) {

				const target = new Object3D();
				target.position.fromArray( record.target );
				this.scene.add( target );
				light.target = target;

			}

			this.scene.add( light );
			lights.push( light );
			const at = light.userData[ USER_LIGHT ] ? - 1 : linked.findIndex( ( { entry } ) => entry.copy.type === light.type && entry.copy.name === light.name );
			if ( at >= 0 ) {

				const [ { source, entry } ] = linked.splice( at, 1 );
				this._copies.set( source, { copy: light, scale: entry.scale, seen: looks( source ) } );

			}

		}

		this.updateLights();
		this._syncHelpers();
		this._onReset?.();
		return lights;

	}

	// ── Aliases (match Sub-API surface for zero-churn migration) ──

	/** @see addLight */
	add( type ) {

		return this.addLight( type );

	}

	/** @see removeLight */
	remove( uuid ) {

		return this.removeLight( uuid );

	}

	/** @see clearLights */
	clear() {

		this.clearLights();

	}

	/** @see getLights */
	getAll() {

		return this.getLights();

	}

	/** @see updateLights */
	sync() {

		this.updateLights();

	}

	/** @see setShowLightHelper */
	showHelpers( show ) {

		this.setShowLightHelper( show );

	}

	/**
	 * Releases all scene lights, helper nodes, and callback refs.
	 * Safe to call multiple times.
	 */
	dispose() {

		if ( this._disposed ) return;
		this._disposed = true;
		this._onLightRemoved = null;

		this.sceneHelpers?.clear();
		this._removeAllLights();

		// Drop external refs so GC can collect scene/pathTracer
		this._onReset = null;
		this.pathTracer = null;
		this.sceneHelpers = null;
		this.scene = null;

	}

	// ── Private ───────────────────────────────────────────────────

	/** @param {function(import('three').Light): boolean} [which] - all lights when omitted */
	_removeAllLights( which ) {

		this.scene.getObjectsByProperty( 'isLight', true ).filter( light => ! which || which( light ) ).forEach( light => {

			this._onLightRemoved?.( light );
			if ( light.target ) this.scene.remove( light.target );
			this.scene.remove( light );

		} );

		for ( const [ source, { copy } ] of this._copies ) if ( copy.parent !== this.scene ) this._copies.delete( source );

	}

	_syncHelpers() {

		if ( ! this.sceneHelpers.visible ) return;
		const lights = this.scene.getObjectsByProperty( 'isLight', true );
		this.sceneHelpers.sync( lights );

	}

	/**
	 * Builds a serialisable descriptor object from a Three.js light.
	 * @param {import('three').Light} light
	 * @returns {Object}
	 */
	_buildDescriptor( light ) {

		let angle = 0;

		if ( light.type === 'SpotLight' && light.angle !== undefined ) {

			angle = MathUtils.radToDeg( light.angle );

		} else if ( light.type === 'DirectionalLight' ) {

			// Sun angular diameter. Lives on userData because three.js gives DirectionalLight no
			// angle property, and an ad-hoc one would not survive the light.clone() in
			// transferSceneLights. Reported here or the panel reads back 0 and the slider snaps home.
			angle = MathUtils.radToDeg( light.userData?.angle ?? 0 );

		}

		const descriptor = {
			uuid: light.uuid,
			name: light.name,
			type: light.type,
			visible: light.visible,
			intensity: light.intensity,
			color: `#${light.color.getHexString()}`,
			position: [ light.position.x, light.position.y, light.position.z ],
			angle,
			// Emission controls common to all light types.
			temperature: light.userData?.temperature ?? 6500,
			useTemperature: light.userData?.useTemperature ?? false,
			exposure: light.userData?.exposure ?? 0
		};

		if ( light.type === 'RectAreaLight' ) {

			descriptor.width = light.width;
			descriptor.height = light.height;
			descriptor.normalize = light.userData?.normalize ?? true;
			descriptor.spread = MathUtils.radToDeg( light.userData?.spread ?? Math.PI ); // degrees for UI
			const rawShape = light.userData?.shape;
			descriptor.shape = ( rawShape === 'square' || rawShape === 'rectangle' || rawShape === 'disk' || rawShape === 'ellipse' )
				? rawShape
				: rawShape === 1 ? 'ellipse'
					: 'rectangle'; // 'rect', undefined, 0 → rectangle
			// The panel faces −Z, as lookAt() aims it; getWorldDirection() is +Z.
			const dir = light.getWorldDirection( new Vector3() ).negate();
			descriptor.target = [ light.position.x + dir.x, light.position.y + dir.y, light.position.z + dir.z ];

		} else if ( light.type === 'SpotLight' && light.target ) {

			descriptor.target = [ light.target.position.x, light.target.position.y, light.target.position.z ];
			descriptor.distance = light.distance ?? 0;
			descriptor.penumbra = light.penumbra ?? 0;
			descriptor.decay = light.decay ?? 2;

		} else if ( light.type === 'PointLight' ) {

			descriptor.distance = light.distance ?? 0;
			descriptor.decay = light.decay ?? 2;

		}

		if ( ( light.type === 'SpotLight' || light.type === 'DirectionalLight' ) && light.userData?.gobo ) {

			descriptor.gobo = light.userData.gobo.name;
			descriptor.goboIntensity = light.userData.gobo.intensity;
			descriptor.goboInverted = !! light.userData.gobo.inverted;
			if ( light.type === 'DirectionalLight' ) {

				descriptor.goboScale = light.userData.gobo.scale ?? 5.0;

			}

		}

		if ( light.type === 'SpotLight' && light.userData?.ies ) {

			descriptor.ies = light.userData.ies.name;
			descriptor.iesIntensity = light.userData.ies.intensity ?? 1.0;
			descriptor.fixtureLumens = light.userData.ies.fixtureLumens ?? null;

		}

		return descriptor;

	}

}
