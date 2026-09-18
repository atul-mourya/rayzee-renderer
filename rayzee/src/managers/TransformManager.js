/**
 * TransformManager — Manages TransformControls for interactive object manipulation.
 *
 * Attaches a translate/rotate/scale gizmo to the selected object,
 * disables OrbitControls during drag, and triggers BVH refit on release.
 */

import { Scene, Vector3 } from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { EngineEvents } from '../EngineEvents.js';

// Three.js "forward" convention (local -Z), used to derive a spot/directional
// light's aim direction from its quaternion. Read-only — setFromUnitVectors()
// does not mutate its arguments, so this can be a shared constant.
const FORWARD = new Vector3( 0, 0, - 1 );

export class TransformManager {

	constructor( { camera, canvas, orbitControls, app } ) {

		this._app = app;
		this._orbitControls = orbitControls;
		this._camera = camera;

		// Create TransformControls with its own scene for independent rendering
		this._controls = new TransformControls( camera, canvas );
		this._gizmoScene = new Scene();
		this._gizmoScene.add( this._controls.getHelper() );

		// State
		this._attached = null;
		this._isDragging = false;
		this._meshes = null;
		this._refitInFlight = false;
		this._baselineComputed = false;

		// Light transform state — spot/directional lights aim via a separate
		// `.target` Object3D rather than their own rotation (see attach()).
		this._tempForward = new Vector3();
		this._lightTargetDistance = null;
		this._lastLightPosition = null;

		// Bind handlers
		this._onDraggingChanged = this._onDraggingChanged.bind( this );
		this._onObjectChange = this._onObjectChange.bind( this );

		this._controls.addEventListener( 'dragging-changed', this._onDraggingChanged );
		this._controls.addEventListener( 'objectChange', this._onObjectChange );

	}

	/**
	 * Provide the scene's mesh list from SceneProcessor after load. A drag is resolved against it
	 * to find which objects moved; nothing per-vertex is kept, because a move never reads vertices.
	 */
	setMeshData( meshes ) {

		this._meshes = meshes;

	}

	/**
	 * Attach the gizmo to an object.
	 */
	attach( object ) {

		if ( this._attached === object ) return;

		this._controls.attach( object );
		this._attached = object;

		this._lightTargetDistance = null;
		this._lastLightPosition = null;

		// Spot/directional lights aim via `.target.position`, not their own
		// quaternion. Sync the quaternion to the current aim direction now so
		// rotate mode starts from the true current direction instead of identity.
		if ( object.isLight && object.target ) {

			const forward = object.target.position.clone().sub( object.position );
			const distance = forward.length();

			if ( distance > 1e-4 ) {

				object.quaternion.setFromUnitVectors( FORWARD, forward.normalize() );
				this._lightTargetDistance = distance;

			} else {

				this._lightTargetDistance = 1;

			}

			this._lastLightPosition = object.position.clone();

		}

	}

	/**
	 * Detach the gizmo from the current object.
	 */
	detach() {

		if ( ! this._attached ) return;

		this._controls.detach();
		this._attached = null;
		this._lightTargetDistance = null;
		this._lastLightPosition = null;

	}

	/**
	 * Set transform mode: 'translate' | 'rotate' | 'scale'
	 */
	setMode( mode ) {

		this._controls.setMode( mode );
		this._app?.dispatchEvent( { type: EngineEvents.TRANSFORM_MODE_CHANGED, mode } );
		// The gizmo shape changes (arrows/rings/boxes) but nothing else invalidates
		// the frame — nudge a redraw so it doesn't wait for the next camera move.
		this._app?.refreshFrame();

	}

	/**
	 * Set transform space: 'world' | 'local'
	 */
	setSpace( space ) {

		this._controls.setSpace( space );
		this._app?.refreshFrame();

	}

	/**
	 * Whether gizmo is currently being dragged.
	 */
	get isDragging() {

		return this._isDragging;

	}

	/**
	 * The currently attached object (or null).
	 */
	get attachedObject() {

		return this._attached;

	}

	/**
	 * The underlying TransformControls instance.
	 */
	get controls() {

		return this._controls;

	}

	/**
	 * Render the transform gizmo overlay.
	 * Call after the main pipeline render, with depth cleared.
	 */
	render( renderer ) {

		if ( ! this._attached ) return;

		const prevAutoClear = renderer.autoClear;
		renderer.autoClear = false;
		renderer.clearDepth();
		renderer.setRenderTarget( null );
		renderer.render( this._gizmoScene, this._camera );
		renderer.autoClear = prevAutoClear;

	}

	// ── Event Handlers ──

	_onDraggingChanged( event ) {

		this._isDragging = event.value;

		// Disable orbit controls during gizmo drag
		if ( this._orbitControls ) {

			this._orbitControls.enabled = ! event.value;

		}

		if ( event.value ) {

			// Drag started
			this._app.dispatchEvent( { type: EngineEvents.OBJECT_TRANSFORM_START } );

		} else {

			// Drag ended — trigger final refit (mesh) or finalize (light)
			if ( this._attached?.isLight ) {

				this._finalizeLightTransform();

			} else {

				this._recomputeAndRefit();

			}

			this._app.dispatchEvent( { type: EngineEvents.OBJECT_TRANSFORM_END } );

		}

	}

	_onObjectChange() {

		// Keep render loop alive during drag so outline updates in real-time
		this._app.needsReset = true;
		this._app.wake();

		if ( this._attached?.isLight ) {

			this._syncLightDuringDrag();

		}

	}

	// ── Light Transform Sync ──

	/**
	 * Called every gizmo move while a light is attached. Translate mode carries
	 * `.target` along by the same delta (so moving a light doesn't silently
	 * swing its aim); rotate mode recomputes `.target` from the light's
	 * quaternion at a fixed distance (so rotating actually steers the beam/sun).
	 * Also resyncs GPU light buffers + the visible SceneHelpers gizmo live.
	 */
	_syncLightDuringDrag() {

		const light = this._attached;

		if ( light.target ) {

			const mode = this._controls.mode;

			if ( mode === 'translate' && this._lastLightPosition ) {

				const delta = this._tempForward.copy( light.position ).sub( this._lastLightPosition );
				light.target.position.add( delta );
				light.target.updateMatrixWorld( true );

			} else if ( mode === 'rotate' && this._lightTargetDistance != null ) {

				const forward = this._tempForward.set( 0, 0, - 1 ).applyQuaternion( light.quaternion );
				light.target.position.copy( light.position ).addScaledVector( forward, this._lightTargetDistance );
				light.target.updateMatrixWorld( true );

			}

			this._lastLightPosition.copy( light.position );

		}

		this._app.lightManager?.updateLights();

	}

	/**
	 * Called once on drag end while a light is attached. Bakes RectAreaLight
	 * scale into width/height (the serializer also reads scale live, but the
	 * Lights panel sliders are the source of truth for size) and does a final
	 * GPU/helper resync.
	 */
	_finalizeLightTransform() {

		const light = this._attached;

		if ( light.isRectAreaLight && ( light.scale.x !== 1 || light.scale.y !== 1 ) ) {

			light.width *= light.scale.x;
			light.height *= light.scale.y;
			light.scale.set( 1, 1, 1 );

		}

		this._app.lightManager?.updateLights();

	}

	// ── Position Extraction & BVH Refit ──

	/**
	 * Recompute world-space vertex positions for affected meshes and trigger BVH refit.
	 */
	_recomputeAndRefit() {

		if ( ! this._meshes || this._refitInFlight ) return;
		if ( ! this._attached ) return;

		// Update world matrices for the moved object subtree
		this._attached.updateMatrixWorld( true );

		// Find which meshes are affected (the attached object or its descendants)
		const affectedIndices = this._findAffectedMeshIndices( this._attached );

		if ( affectedIndices.length === 0 ) return;

		this._refitInFlight = true;

		try {

			// A gizmo only changes an object's transform, so the triangles never move in their
			// own space — only the matrix that places them does. Rewriting world-space vertices
			// instead costs a pass over every vertex, and corrupts any other object sharing
			// this geometry.
			this._app.updateMeshTransforms( affectedIndices );

		} catch ( err ) {

			console.error( 'Transform refit error:', err );

		} finally {

			this._refitInFlight = false;

		}

	}

	/**
	 * Find indices in _meshes that are the attached object or descendants of it.
	 */
	_findAffectedMeshIndices( object ) {

		const indices = [];

		for ( let i = 0; i < this._meshes.length; i ++ ) {

			const mesh = this._meshes[ i ];
			if ( mesh === object || this._isDescendantOf( mesh, object ) ) {

				indices.push( i );

			}

		}

		return indices;

	}

	_isDescendantOf( child, parent ) {

		let current = child.parent;
		while ( current ) {

			if ( current === parent ) return true;
			current = current.parent;

		}

		return false;

	}

	dispose() {

		this._controls.removeEventListener( 'dragging-changed', this._onDraggingChanged );
		this._controls.removeEventListener( 'objectChange', this._onObjectChange );
		this.detach();
		this._gizmoScene.remove( this._controls.getHelper() );
		this._controls.dispose();

		this._meshes = null;
		this._baselineComputed = false;
		this._tempForward = null;
		this._lightTargetDistance = null;
		this._lastLightPosition = null;

		// Drop back-references to the owning app and shared resources so the
		// PathTracerApp graph can be GC'd. Without this, _app pinned the entire
		// engine (verified via heap snapshot retainer chain).
		this._app = null;
		this._orbitControls = null;
		this._camera = null;
		this._controls = null;
		this._gizmoScene = null;

	}

}
