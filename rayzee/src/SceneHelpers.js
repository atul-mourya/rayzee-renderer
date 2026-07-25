import { Scene, PointLightHelper, DirectionalLightHelper, SpotLightHelper } from 'three';
import { RectAreaLightHelper } from 'three/addons/helpers/RectAreaLightHelper.js';

/**
 * Manages visual helpers for scene objects (lights, cameras, etc.).
 * Renders as a transparent overlay on top of the main output.
 *
 * Usage:
 *   const helpers = new SceneHelpers();
 *   helpers.add( light );        // auto-detects type
 *   helpers.remove( light );
 *   helpers.update();            // sync transforms
 *   helpers.render( renderer, camera );
 *   helpers.dispose();
 */
export class SceneHelpers {

	constructor() {

		this.scene = new Scene();
		this._helpers = new Map(); // object.uuid → helper
		this.visible = false;

	}

	/**
	 * Adds a helper for the given object. Auto-detects the correct helper type.
	 * @param {Object3D} object - The object to visualize
	 * @returns {Object3D|null} The created helper, or null if unsupported
	 */
	add( object ) {

		if ( this._helpers.has( object.uuid ) ) return this._helpers.get( object.uuid );

		const helper = this._createHelper( object );
		if ( ! helper ) return null;

		this._helpers.set( object.uuid, helper );
		this.scene.add( helper );
		return helper;

	}

	/**
	 * Removes the helper for the given object.
	 * @param {Object3D} object
	 */
	remove( object ) {

		const helper = this._helpers.get( object.uuid );
		if ( ! helper ) return;

		helper.dispose();
		this.scene.remove( helper );
		this._helpers.delete( object.uuid );

	}

	/**
	 * Returns whether a helper exists for the given object.
	 */
	has( object ) {

		return this._helpers.has( object.uuid );

	}

	/**
	 * Whether a render() would actually put anything on screen. `visible` alone
	 * is the enable flag and can be true with no lights in the scene.
	 */
	get isDrawing() {

		return this.visible && this._helpers.size > 0;

	}

	/**
	 * Syncs all helpers with their source objects.
	 */
	update() {

		for ( const helper of this._helpers.values() ) {

			helper.update?.();

		}

	}

	/**
	 * Syncs helpers to match the given list of objects.
	 * Adds helpers for new objects, removes helpers for objects no longer present.
	 * @param {Object3D[]} objects - The current set of objects to visualize
	 */
	sync( objects ) {

		const currentUuids = new Set( objects.map( o => o.uuid ) );

		// Remove stale helpers
		for ( const [ uuid, helper ] of this._helpers ) {

			if ( ! currentUuids.has( uuid ) ) {

				helper.dispose();
				this.scene.remove( helper );
				this._helpers.delete( uuid );

			}

		}

		// Add missing helpers
		for ( const object of objects ) {

			this.add( object );

		}

	}

	/**
	 * Removes all helpers.
	 */
	clear() {

		for ( const helper of this._helpers.values() ) {

			helper.dispose();
			this.scene.remove( helper );

		}

		this._helpers.clear();

	}

	/**
	 * Renders helpers as an overlay on top of the current backbuffer.
	 * @param {WebGPURenderer} renderer
	 * @param {Camera} camera
	 */
	render( renderer, camera ) {

		if ( ! this.isDrawing ) return;

		const prevAutoClear = renderer.autoClear;
		renderer.autoClear = false;
		renderer.clearDepth();
		renderer.setRenderTarget( null );
		renderer.render( this.scene, camera );
		renderer.autoClear = prevAutoClear;

	}

	/**
	 * Disposes all helpers and cleans up.
	 */
	dispose() {

		this.clear();

	}

	// ─── internal ────────────────────────────────────────────────

	_createHelper( object ) {

		if ( object.isRectAreaLight ) return new RectAreaLightHelper( object );
		if ( object.isPointLight ) return new PointLightHelper( object, 0.5 );
		if ( object.isSpotLight ) return new SpotLightHelper( object );
		if ( object.isDirectionalLight ) return new DirectionalLightHelper( object, 0.5 );

		return null;

	}

}
