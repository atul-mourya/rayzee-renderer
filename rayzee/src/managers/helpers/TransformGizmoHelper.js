/**
 * TransformGizmoHelper — adapts {@link TransformManager} to the OverlayManager
 * helper interface so the translate/rotate/scale gizmo draws on the same
 * view-resolution surface as the light gizmos and the selection outline.
 *
 * An adapter rather than the interface on TransformManager itself: the manager
 * is public engine API with its own lifecycle (PathTracerApp owns dispose), and
 * the overlay must not dispose it a second time.
 *
 * Layer: 'scene'.
 *
 * @example
 *   overlayManager.register( 'transform', new TransformGizmoHelper( app.transformManager ) );
 */
export class TransformGizmoHelper {

	/**
	 * @param {import('../TransformManager.js').TransformManager} transformManager
	 */
	constructor( transformManager ) {

		this.layer = 'scene';
		this._transformManager = transformManager;
		this._enabled = true;

	}

	/** Nothing to draw unless the gizmo is attached to something. */
	get visible() {

		return this._enabled && this._transformManager.attachedObject !== null;

	}

	render( renderer ) {

		this._transformManager.render( renderer );

	}

	show() {

		this._enabled = true;

	}

	hide() {

		this._enabled = false;

	}

	dispose() {

		// Only stops drawing — TransformManager is owned by the app, which
		// disposes it separately.
		this._enabled = false;

	}

}
