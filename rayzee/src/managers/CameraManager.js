import { EventDispatcher, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EngineEvents, } from '../EngineEvents.js';
import { AF_DEFAULTS } from '../EngineDefaults.js';

const DEFAULT_CAMERA_SCALE = Object.freeze( new Vector3( 1, 1, 1 ) );

/**
 * Manages camera creation, switching, auto-focus, and AF point placement.
 *
 * Owns the PerspectiveCamera and OrbitControls instances.
 * Dispatches events that PathTracerApp relays to external consumers.
 */
export class CameraManager extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas element for orbit controls
	 */
	constructor( canvas ) {

		super();

		const width = canvas.clientWidth;
		const height = canvas.clientHeight;

		this.camera = new PerspectiveCamera( 60, width / height || 1, 0.01, 1000 );
		this.camera.position.set( 0, 0, 5 );

		this.controls = new OrbitControls( this.camera, canvas );
		this.controls.screenSpacePanning = true;
		this.controls.zoomToCursor = true;
		this.controls.saveState();

		this.interactionManager = null;

		/** @type {import('three').PerspectiveCamera[]} */
		this.cameras = [ this.camera ];
		this.currentCameraIndex = 0;

		// Monotonic counter for naming user-added cameras (reset when the list is replaced).
		this._userCameraCounter = 0;

		// Auto-focus state
		this.autoFocusMode = AF_DEFAULTS.SMOOTHING_FACTOR ? 'auto' : 'manual';
		this.afScreenPoint = { x: 0.5, y: 0.5 };
		this.afSmoothingFactor = AF_DEFAULTS.SMOOTHING_FACTOR;
		this._lastValidFocusDistance = null;
		this._smoothedFocusDistance = null;
		this._afPointDirty = false;
		this._afSuspended = false;

		// Saved state for default camera when switching to model cameras
		this._defaultCameraState = null;

		// Callbacks injected by PathTracerApp
		this._onResize = null;
		this._onReset = null;
		this._getSettings = null;
		this._applySettings = null;

	}

	/**
	 * Sets the list of available cameras (default + extracted from model).
	 * @param {import('three').PerspectiveCamera[]} cameras
	 */
	setCameras( cameras ) {

		this.cameras = cameras;
		this._userCameraCounter = 0;

	}

	/**
	 * Adds a new user camera that snapshots the current render camera's pose,
	 * FOV, clip planes, and orbit target. The snapshot is a standalone template
	 * appended to the list; switching to it restores this exact framing.
	 *
	 * @param {string} [name] - Optional display name (auto-generated otherwise).
	 * @returns {number} The index of the newly added camera.
	 */
	addCameraFromView( name ) {

		const src = this.camera;
		const cam = new PerspectiveCamera( src.fov, src.aspect, src.near, src.far );
		cam.position.copy( src.position );
		cam.quaternion.copy( src.quaternion );
		cam.scale.copy( src.scale );
		cam.updateMatrixWorld( true );

		cam.userData.__rayzeeUserCamera = true;
		cam.userData.__rayzeeEffects = this._captureEffects();
		if ( this.controls ) cam.userData.__rayzeeOrbitTarget = this.controls.target.clone();

		this._userCameraCounter += 1;
		cam.name = name || `View Camera ${this._userCameraCounter}`;

		this.cameras.push( cam );
		return this.cameras.length - 1;

	}

	/**
	 * Removes a user-added camera by index. Built-in (index 0) and
	 * model-embedded cameras are protected and cannot be removed.
	 * If the active camera is removed, falls back to the default camera.
	 *
	 * @param {number} index
	 * @returns {boolean} true if a camera was removed.
	 */
	removeCamera( index ) {

		if ( ! Number.isInteger( index ) || index <= 0 || index >= this.cameras.length ) return false;
		if ( ! this.cameras[ index ]?.userData?.__rayzeeUserCamera ) return false;

		const wasActive = this.currentCameraIndex === index;
		this.cameras.splice( index, 1 );

		if ( wasActive ) {

			// The active camera is gone. Invalidate currentCameraIndex before falling
			// back so switchCamera(0) skips both the (deleted) outgoing-effects save and
			// the default-state save, and runs the restore path instead.
			this.currentCameraIndex = - 1;
			this.switchCamera( 0 );

		} else if ( this.currentCameraIndex > index ) {

			// Indices after the removed slot shift down by one.
			this.currentCameraIndex -= 1;

		}

		return true;

	}

	/**
	 * Returns display names for all available cameras.
	 * @returns {string[]}
	 */
	getCameraNames() {

		if ( ! this.cameras || this.cameras.length === 0 ) return [ 'Default Camera' ];

		return this.cameras.map( ( cam, index ) => {

			if ( index === 0 ) return 'Default Camera';
			return cam.name || `Camera ${index}`;

		} );

	}

	/**
	 * Stores callbacks for camera operations (resize, reset, settings access).
	 * Call once after all managers are ready.
	 *
	 * @param {Object} callbacks
	 * @param {Function} callbacks.onResize     - Trigger viewport resize
	 * @param {Function} callbacks.onReset      - Trigger accumulation reset
	 * @param {Function} callbacks.getSettings  - (key) => value
	 * @param {Function} callbacks.applySettings - (updates) => void, batch-writes render settings
	 */
	initCallbacks( { onResize, onReset, getSettings, applySettings } ) {

		this._onResize = onResize;
		this._onReset = onReset;
		this._getSettings = getSettings;
		this._applySettings = applySettings;

	}

	// ── Per-camera effects (DOF / focus) ──────────────────────────
	// Each camera keeps its own depth-of-field + focus configuration so effects
	// defined on one camera don't leak to another. State is stored on the camera
	// object's userData and swapped in/out on switchCamera().

	/**
	 * Snapshot the current global DOF/focus settings into a plain object.
	 * focusDistance is stored scaled (as held in RenderSettings).
	 * @returns {Object|null}
	 */
	_captureEffects() {

		const get = this._getSettings;
		if ( ! get ) return null;

		return {
			enableDOF: get( 'enableDOF' ),
			focusDistance: get( 'focusDistance' ),
			aperture: get( 'aperture' ),
			focalLength: get( 'focalLength' ),
			apertureScale: get( 'apertureScale' ),
			anamorphicRatio: get( 'anamorphicRatio' ),
			autoFocusMode: this.autoFocusMode,
			afScreenPoint: { ...this.afScreenPoint },
		};

	}

	/**
	 * Apply a previously-captured effects object to the global settings + focus state.
	 * @param {Object} [eff]
	 */
	_applyEffects( eff ) {

		if ( ! eff ) return;

		this._applySettings?.( {
			enableDOF: eff.enableDOF,
			focusDistance: eff.focusDistance,
			aperture: eff.aperture,
			focalLength: eff.focalLength,
			apertureScale: eff.apertureScale,
			anamorphicRatio: eff.anamorphicRatio,
		} );

		if ( eff.autoFocusMode !== undefined ) this.setAutoFocusMode( eff.autoFocusMode );
		if ( eff.afScreenPoint ) this.setAFScreenPoint( eff.afScreenPoint.x, eff.afScreenPoint.y );

	}

	/** Scene scale used to convert scaled focusDistance to UI-facing units. */
	_getSceneScale() {

		return this._afContext?.assetLoader?.getSceneScale?.() || 1;

	}

	/**
	 * Switches the active camera by index.
	 * Uses stored callbacks from initCallbacks() for resize/reset.
	 * @param {number} index
	 * @param {number} [focusDistance] - Override focus distance (falls back to settings)
	 * @param {Function} [onResize]   - Override resize callback
	 * @param {Function} [onReset]    - Override reset callback
	 */
	switchCamera( index, focusDistance, onResize, onReset ) {

		// Use stored callbacks if not provided (backward-compatible signature)
		focusDistance = focusDistance ?? this._getSettings?.( 'focusDistance' );
		onResize = onResize ?? this._onResize;
		onReset = onReset ?? this._onReset;

		if ( ! this.cameras || this.cameras.length === 0 ) return;

		if ( index < 0 || index >= this.cameras.length ) {

			console.warn( `CameraManager: Invalid camera index ${index}. Using default camera.` );
			index = 0;

		}

		// Save the outgoing camera's DOF/focus effects so they can be restored later.
		const outgoing = this.cameras[ this.currentCameraIndex ];
		if ( outgoing ) outgoing.userData.__rayzeeEffects = this._captureEffects();

		// Save default camera state before switching away from it
		if ( this.currentCameraIndex === 0 && index !== 0 ) {

			this._defaultCameraState = {
				position: this.camera.position.clone(),
				quaternion: this.camera.quaternion.clone(),
				scale: this.camera.scale.clone(),
				fov: this.camera.fov,
				near: this.camera.near,
				far: this.camera.far,
				target: this.controls ? this.controls.target.clone() : null,
			};

		}

		this.currentCameraIndex = index;

		if ( index === 0 && this._defaultCameraState ) {

			// Restore the default camera to its state before the switch
			const s = this._defaultCameraState;
			this.camera.position.copy( s.position );
			this.camera.quaternion.copy( s.quaternion );
			// Clears a mirror picked up from an imported camera; older saved states
			// predate the field and are unmirrored by definition.
			this.camera.scale.copy( s.scale ?? DEFAULT_CAMERA_SCALE );
			this.camera.fov = s.fov;
			this.camera.near = s.near;
			this.camera.far = s.far;
			this.camera.updateProjectionMatrix();
			this.camera.updateMatrixWorld( true );

			if ( this.controls && s.target ) {

				this.controls.target.copy( s.target );
				this.controls.update();

			}

		} else {

			const sourceCamera = this.cameras[ index ];

			this.camera.position.copy( sourceCamera.position );
			this.camera.quaternion.copy( sourceCamera.quaternion );
			// An imported camera can carry a mirror (a negative axis scale) that no
			// quaternion can express — a pbrt scene's `Scale -1 1 1`, for one. Copying
			// pose alone would silently un-mirror the view.
			this.camera.scale.copy( sourceCamera.scale );
			this.camera.fov = sourceCamera.fov;
			this.camera.near = sourceCamera.near;
			this.camera.far = sourceCamera.far;
			this.camera.updateProjectionMatrix();
			this.camera.updateMatrixWorld( true );

			// Restore the saved orbit target for user cameras; otherwise place it
			// along the forward direction at the focus distance.
			if ( this.controls ) {

				const savedTarget = sourceCamera.userData?.__rayzeeOrbitTarget;
				if ( savedTarget ) {

					this.controls.target.copy( savedTarget );

				} else {

					const forward = new Vector3( 0, 0, - 1 ).applyQuaternion( sourceCamera.quaternion );
					const focusDist = focusDistance || 5.0;
					this.controls.target.copy( this.camera.position ).addScaledVector( forward, focusDist );

				}

				this.controls.update();

			}

		}

		// Restore the incoming camera's own DOF/focus effects (if it has any saved;
		// otherwise it inherits the current global config).
		this._applyEffects( this.cameras[ index ]?.userData?.__rayzeeEffects );

		onResize?.();
		onReset?.();

		// Emit UI-facing effects: focusDistance unscaled (matching AUTO_FOCUS_UPDATED),
		// so the adapter is a plain passthrough with no scene-scale awareness.
		const effects = this._captureEffects();
		if ( effects ) effects.focusDistance /= this._getSceneScale();
		this.dispatchEvent( { type: 'CameraSwitched', cameraIndex: index, effects, fov: this.camera.fov } );

	}

	/**
	 * Focuses the orbit camera on a world-space point.
	 * @param {import('three').Vector3} center
	 */
	focusOn( center ) {

		if ( ! center || ! this.controls ) return;
		this.controls.target.copy( center );
		this.controls.update();
		this._onReset?.();

	}

	// ── Aliases (match Sub-API surface) ───────────────────────────

	/** The active Three.js PerspectiveCamera. */
	get active() {

		return this.camera;

	}

	/** @see getCameraNames */
	getNames() {

		return this.getCameraNames();

	}

	// ── Auto-Focus ────────────────────────────────────────────────

	setAutoFocusMode( mode ) {

		this.autoFocusMode = mode;

		if ( mode !== 'manual' ) {

			this._smoothedFocusDistance = null;
			this._afPointDirty = true;

		}

	}

	setAFScreenPoint( x, y ) {

		this.afScreenPoint = { x, y };
		this._afPointDirty = true;

	}

	enterAFPointPlacementMode() {

		if ( ! this.interactionManager ) return;
		this.interactionManager.enterAFPointPlacementMode();
		if ( this.controls ) this.controls.enabled = false;

	}

	exitAFPointPlacementMode() {

		if ( ! this.interactionManager ) return;
		this.interactionManager.exitAFPointPlacementMode();
		if ( this.controls ) this.controls.enabled = true;

	}

	/**
	 * Per-frame auto-focus update. Called in animate() before pipeline.render().
	 *
	 * @param {Object} params
	 * @param {import('three').Scene} params.meshScene
	 * @param {Object} params.assetLoader
	 * @param {import('three').Mesh} params.floorPlane
	 * @param {number} params.currentFocusDistance
	 * @param {import('../Stages/PathTracer.js').PathTracer} params.pathTracer
	 * @param {Function} params.setFocusDistance - Callback to update uniform + settings
	 * @param {Function} params.softReset       - Callback for soft accumulation reset
	 * @param {Function} params.hardReset       - Callback for hard accumulation reset
	 */
	updateAutoFocus( ctx ) {

		const { meshScene, assetLoader, floorPlane, currentFocusDistance, pathTracer, setFocusDistance, softReset, hardReset } = ctx || this._afContext || {};
		if ( ! meshScene ) return;

		if ( this.autoFocusMode === 'manual' ) return;

		// Depth-of-field is the only consumer of the auto-focus distance. With DOF
		// off (the default) the per-frame scene raycast is pure waste, so skip it.
		// Re-snap on the frame DOF turns back on so focus is correct immediately
		// rather than racking from a stale smoothed value.
		if ( ! pathTracer?.enableDOF?.value ) {

			this._afSuspended = true;
			return;

		}

		if ( this._afSuspended ) {

			this._afSuspended = false;
			this._smoothedFocusDistance = null;

		}

		// Lock focus during active tiled final rendering
		const stage = pathTracer;
		if ( stage?.isReady
			&& stage.renderMode?.value === 1
			&& stage.frameCount > 0
			&& ! stage.isComplete ) return;

		// Convert AF screen point (normalized 0-1) to NDC (-1 to 1)
		const ndcX = this.afScreenPoint.x * 2 - 1;
		const ndcY = - ( this.afScreenPoint.y * 2 - 1 );

		const raycaster = this.interactionManager?.raycaster;
		if ( ! raycaster ) return;

		raycaster.setFromCamera( { x: ndcX, y: ndcY }, this.camera );
		const intersects = raycaster.intersectObjects( meshScene.children, true );

		const validHit = intersects.find( hit =>
			hit.object !== this.interactionManager?.focusPointIndicator &&
			hit.object !== floorPlane &&
			! hit.object.name.includes( 'Helper' ) &&
			hit.object.type === 'Mesh'
		);

		let rawDistance;
		if ( validHit ) {

			rawDistance = validHit.distance;
			this._lastValidFocusDistance = rawDistance;

		} else {

			if ( this._lastValidFocusDistance !== null ) {

				rawDistance = this._lastValidFocusDistance;

			} else {

				const scale = assetLoader?.getSceneScale() || 1.0;
				rawDistance = AF_DEFAULTS.FALLBACK_DISTANCE * scale;
				this._lastValidFocusDistance = rawDistance;

			}

		}

		const forceReset = this._afPointDirty;
		this._afPointDirty = false;

		// Temporal smoothing
		if ( forceReset || this._smoothedFocusDistance === null || this._smoothedFocusDistance === 0 ) {

			this._smoothedFocusDistance = rawDistance;

		} else {

			const changeFraction = Math.abs( rawDistance - this._smoothedFocusDistance )
				/ this._smoothedFocusDistance;

			if ( changeFraction > AF_DEFAULTS.SNAP_THRESHOLD ) {

				this._smoothedFocusDistance = rawDistance;

			} else {

				this._smoothedFocusDistance += this.afSmoothingFactor
					* ( rawDistance - this._smoothedFocusDistance );

			}

		}

		const prevFocus = currentFocusDistance;
		const newFocus = this._smoothedFocusDistance;

		if ( forceReset || prevFocus === 0 || Math.abs( newFocus - prevFocus ) / Math.max( prevFocus, 0.001 ) > 0.001 ) {

			setFocusDistance( newFocus );

			// Update store for UI display (unscaled value)
			const scale = assetLoader?.getSceneScale() || 1.0;
			this.dispatchEvent( { type: EngineEvents.AUTO_FOCUS_UPDATED, distance: newFocus / scale } );

			const changeRatio = Math.abs( newFocus - prevFocus ) / Math.max( prevFocus, 0.001 );
			if ( forceReset ) {

				hardReset?.();

			} else if ( changeRatio > AF_DEFAULTS.RESET_THRESHOLD ) {

				softReset?.();

			}

		}

	}

	/**
	 * Deferred dependency injection — InteractionManager needs the camera
	 * in its constructor, so it can't be passed during CameraManager creation.
	 * @param {import('./InteractionManager.js').InteractionManager} interactionManager
	 */
	setInteractionManager( interactionManager ) {

		this.interactionManager = interactionManager;

	}

	/**
	 * Initialises the stable auto-focus context. Call once after all
	 * managers and stages are ready. CameraManager stores the context
	 * and `updateAutoFocus()` reads from it each frame — no per-frame allocation.
	 *
	 * @param {Object} deps
	 * @param {import('three').Scene}           deps.meshScene
	 * @param {import('../Processor/AssetLoader.js').AssetLoader} deps.assetLoader
	 * @param {import('three').Mesh}            deps.floorPlane
	 * @param {import('../Stages/PathTracer.js').PathTracer} deps.pathTracer
	 * @param {import('../RenderSettings.js').RenderSettings} deps.settings
	 * @param {Function}                        deps.softReset
	 * @param {Function}                        deps.hardReset
	 */
	initAutoFocus( { meshScene, assetLoader, floorPlane, pathTracer, settings, softReset, hardReset } ) {

		this._afContext = {
			meshScene,
			assetLoader,
			floorPlane,
			pathTracer,
			setFocusDistance: ( d ) => settings.set( 'focusDistance', d, { silent: true } ),
			softReset,
			hardReset,
		};

		// Live getter — reads current value without allocation
		Object.defineProperty( this._afContext, 'currentFocusDistance', {
			get: () => settings.get( 'focusDistance' ),
		} );

	}

	dispose() {

		this.controls?.dispose();

	}

}
