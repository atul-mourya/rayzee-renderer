import {
	EventDispatcher, DirectionalLight, PointLight, SpotLight, RectAreaLight,
	Object3D, MathUtils
} from 'three';
import { toPortable, fromPortable } from '../SceneState/portable.js';

// Set on lights a host added, which live in the light scene alone: a rebuild re-transfers the
// model's lights and keeps these.
const USER_LIGHT = '__rayzeeUserLight';

const LIGHT_TYPES = { DirectionalLight, PointLight, SpotLight, RectAreaLight };

/**
 * Manages scene lights: add, remove, transfer from mesh scene to WebGPU
 * scene, sync helpers, and update GPU uniform buffers.
 *
 * Extracted from PathTracerApp to keep the facade slim.
 */
export class LightManager extends EventDispatcher {

	/**
	 * @param {import('three').Scene}      scene          - WebGPU light scene
	 * @param {import('../SceneHelpers.js').SceneHelpers} sceneHelpers
	 * @param {import('../Stages/PathTracer.js').PathTracer} pathTracer
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
	 * Sets a traced light's intensity (watts, or W/m² for directional — see the README) and uploads it.
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

			light.updateWorldMatrix( true, false );
			light.getWorldPosition( cloned.position );
			light.getWorldQuaternion( cloned.quaternion );
			light.getWorldScale( cloned.scale );

			if ( cloned.isRectAreaLight ) {

				cloned.width *= cloned.scale.x;
				cloned.height *= cloned.scale.y;
				cloned.scale.set( 1, 1, 1 );

			}

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
			const dir = light.getWorldDirection( light.position.clone() );
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
