import { EventDispatcher, MathUtils, Matrix4, OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EngineEvents, } from '../EngineEvents.js';
import { AF_DEFAULTS, CAMERA_PROJECTION_IDS } from '../EngineDefaults.js';
import { viewDepth } from './InteractionManager.js';
import { ViewCamera } from './ViewCamera.js';
import { WalkControls } from './WalkControls.js';
import { toPortable, fromPortable } from '../SceneState/portable.js';

const DEFAULT_CAMERA_SCALE = Object.freeze( new Vector3( 1, 1, 1 ) );

/** The height of an orthographic camera's view in world units, or null for any other camera. */
const orthoHeightOf = camera => camera?.isOrthographicCamera ? ( camera.top - camera.bottom ) / camera.zoom : null;

/**
 * Manages camera creation, switching, auto-focus, and AF point placement.
 *
 * Owns the {@link ViewCamera} and OrbitControls instances.
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

		this.camera = new ViewCamera( 60, width / height || 1, 0.01, 1000 );
		this.camera.position.set( 0, 0, 5 );

		this.controls = new OrbitControls( this.camera, canvas );
		this.controls.screenSpacePanning = true;
		this.controls.zoomToCursor = true;
		this.controls.saveState();

		// The wheel zooms an orthographic view: report its height.
		this._reportedOrthoHeight = null;
		this._reportOrthoHeight = this._reportOrthoHeight.bind( this );
		this.controls.addEventListener( 'change', this._reportOrthoHeight );

		this.walkControls = new WalkControls( this.camera, canvas, this.controls );

		this.interactionManager = null;

		/** @type {import('three').Camera[]} */
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
		this._afPick = null;

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
	 * @param {import('three').Camera[]} cameras - perspective or orthographic
	 */
	setCameras( cameras ) {

		this.cameras = cameras;
		this._userCameraCounter = 0;
		this.resetAutoFocus();

	}

	/**
	 * Adds a new user camera that snapshots the current render camera's pose,
	 * FOV or orthographic size, clip planes, and orbit target. The snapshot is a standalone
	 * template appended to the list; switching to it restores this exact framing.
	 *
	 * @param {string} [name] - Optional display name (auto-generated otherwise).
	 * @returns {number} The index of the newly added camera.
	 */
	addCameraFromView( name ) {

		const src = this.camera;
		const cam = src.orthographic
			? new OrthographicCamera( src.left, src.right, src.top, src.bottom, src.near, src.far )
			: new PerspectiveCamera( src.fov, src.aspect, src.near, src.far );
		cam.zoom = src.zoom;
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
			dofBlur: get( 'dofBlur' ),
			autoFocusMode: this.autoFocusMode,
			afScreenPoint: { ...this.afScreenPoint },
			orthoHeight: this.orthoHeight,
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
			dofBlur: eff.dofBlur,
		} );

		if ( eff.autoFocusMode !== undefined ) this.setAutoFocusMode( eff.autoFocusMode );
		if ( eff.afScreenPoint ) this.setAFScreenPoint( eff.afScreenPoint.x, eff.afScreenPoint.y );

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

			this._placeAt( this.cameras[ index ], focusDistance );

		}

		this.resetAutoFocus();

		// A camera left orthographic comes back orthographic; one never visited is what it was made as.
		const incoming = this.cameras[ index ];
		const saved = incoming?.userData?.__rayzeeEffects;
		this._showOrthographic( saved ? saved.orthoHeight : orthoHeightOf( incoming ) );

		// Restore the incoming camera's own DOF/focus effects (if it has any saved;
		// otherwise it inherits the current global config).
		this._applyEffects( saved );

		onResize?.();
		onReset?.();

		this.dispatchEvent( {
			type: EngineEvents.CAMERA_SWITCHED, cameraIndex: index, effects: this._captureEffects(), fov: this.camera.fov,
			cameraProjection: this._getSettings?.( 'cameraProjection' ),
		} );

	}

	/**
	 * Puts the active camera back at the view it starts from: the default camera at the framing the
	 * model loaded with, any other at its own pose and lens. Its effects and projection stay.
	 */
	resetView() {

		const source = this.currentCameraIndex > 0 ? this.cameras[ this.currentCameraIndex ] : null;
		if ( ! source ) {

			this.controls.reset();
			return;

		}

		this._placeAt( source, this._getSettings?.( 'focusDistance' ) );
		const height = orthoHeightOf( source );
		if ( this.camera.orthographic ) this._setView( true, height ? height / 2 : this.camera.orthoHalfHeight );
		this._onReset?.();

	}

	// The view takes a camera's pose and lens, orbiting its saved target or a point ahead at the focus distance.
	_placeAt( source, focusDistance ) {

		this.camera.position.copy( source.position );
		this.camera.quaternion.copy( source.quaternion );
		// An imported camera can carry a mirror (a negative axis scale) that no
		// quaternion can express — a pbrt scene's `Scale -1 1 1`, for one. Copying
		// pose alone would silently un-mirror the view.
		this.camera.scale.copy( source.scale );
		if ( source.isPerspectiveCamera ) this.camera.fov = source.fov;
		this.camera.near = source.near;
		this.camera.far = source.far;
		this.camera.updateProjectionMatrix();
		this.camera.updateMatrixWorld( true );

		if ( ! this.controls ) return;

		const savedTarget = source.userData?.__rayzeeOrbitTarget;
		if ( savedTarget ) {

			this.controls.target.copy( savedTarget );

		} else {

			const forward = new Vector3( 0, 0, - 1 ).applyQuaternion( source.quaternion );
			this.controls.target.copy( this.camera.position ).addScaledVector( forward, focusDistance || 5.0 );

		}

		this.controls.update();

	}

	/**
	 * Makes the camera orthographic at `height`, or perspective for null, then hands the `cameraProjection`
	 * setting the outcome — after, so its handler finds the camera already there. A 360° panorama stays on
	 * across perspective cameras.
	 * @param {?number} height - in world units
	 */
	_showOrthographic( height ) {

		if ( height > 0 ) this._setView( true, height / 2 );
		else this._setView( false );

		const current = this._getSettings?.( 'cameraProjection' );
		const next = height > 0 ? 'orthographic' : current === 'orthographic' ? 'perspective' : current;
		if ( next !== current ) this._applySettings?.( { cameraProjection: next } );

	}

	/**
	 * The camera's side of the `cameraProjection` setting: set that, not this. Turning orthographic
	 * keeps what the view shows at the orbit target, and turning back moves the camera to keep it.
	 * @param {'perspective' | 'orthographic' | 'equirectangular'} projection
	 */
	applyProjection( projection ) {

		const camera = this.camera;
		const orthographic = projection === 'orthographic';
		if ( camera.orthographic === orthographic ) return;

		if ( orthographic ) {

			this._setView( true, this._fittedHalfHeight() );

		} else {

			const target = this.controls.target;
			const distance = this.orthoHeight / 2 / Math.tan( MathUtils.degToRad( camera.fov ) / 2 );
			camera.position.sub( target ).setLength( distance ).add( target );
			this._setView( false );

		}

		this.controls.update();

	}

	/** The height of the view in world units while orthographic, the wheel's zoom included; null otherwise. */
	get orthoHeight() {

		return orthoHeightOf( this.camera );

	}

	/** @param {number} height - the orthographic view's height, in world units */
	setOrthoHeight( height ) {

		if ( ! ( height > 0 ) ) return;
		this._setView( this.camera.orthographic, height / 2 );
		this._onReset?.();

	}

	/** Sizes an orthographic view to show what a perspective one would at the orbit target. */
	fitOrthographic() {

		if ( this.camera.orthographic ) this.setOrthoHeight( 2 * this._fittedHalfHeight() );

	}

	// The one writer of the camera's projection. The wheel's zoom starts over.
	_setView( orthographic, halfHeight = this.camera.orthoHalfHeight ) {

		const camera = this.camera;
		camera.orthographic = orthographic;
		camera.orthoHalfHeight = halfHeight;
		camera.zoom = 1;
		camera.updateProjectionMatrix();
		this._reportOrthoHeight();

	}

	// Half of what a perspective view shows at the orbit target.
	_fittedHalfHeight() {

		return this.camera.position.distanceTo( this.controls.target ) * Math.tan( MathUtils.degToRad( this.camera.fov ) / 2 );

	}

	_reportOrthoHeight() {

		if ( ! this.camera.orthographic ) return;
		const height = this.orthoHeight;
		if ( height === this._reportedOrthoHeight ) return;
		this._reportedOrthoHeight = height;
		this.dispatchEvent( { type: EngineEvents.ORTHO_HEIGHT_UPDATED, height } );

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

	/**
	 * Orbit around a target, or walk through the scene first-person (see {@link WalkControls}).
	 * Leaving walk mode orbits around the surface at the centre of the view.
	 * @param {'orbit' | 'walk'} mode
	 */
	setNavigationMode( mode ) {

		const walk = mode === 'walk';
		if ( this.walkControls.enabled === walk ) return;

		const controls = this.controls;
		controls.enableRotate = controls.enablePan = controls.enableZoom = ! walk;
		this.walkControls.enabled = walk;
		if ( walk ) return;

		this.walkControls.release();
		const hit = this.interactionManager?.pickSurface( 0, 0 );
		if ( ! hit ) return;

		const distance = MathUtils.clamp( hit.distance, controls.minDistance, controls.maxDistance );
		controls.target.copy( this.camera.position ).addScaledVector( this.camera.getWorldDirection( new Vector3() ), distance );
		controls.update();

	}

	/** @returns {'orbit' | 'walk'} */
	get navigationMode() {

		return this.walkControls.enabled ? 'walk' : 'orbit';

	}

	/** Per frame, before rendering. */
	updateControls() {

		this.walkControls.update();
		this.controls.update();

	}

	/**
	 * The current view as a pose: where the camera is, what it looks at, and how much it shows — the
	 * height an orthographic view covers, or what a perspective one covers at its orbit target.
	 * @returns {import('./timeline/CameraTrack.js').CameraPose}
	 */
	captureView() {

		const camera = this.camera;
		const orthoHeight = this.orthoHeight ?? 2 * this._fittedHalfHeight();
		return { position: camera.position.clone(), target: this.controls.target.clone(), fov: camera.fov, orthoHeight };

	}

	/**
	 * Puts the camera at a pose, looking at its target, sized for the projection in use.
	 * @param {import('./timeline/CameraTrack.js').CameraPose} pose
	 */
	applyPose( pose ) {

		const camera = this.camera;
		camera.position.copy( pose.position );
		camera.lookAt( pose.target );
		this.controls.target.copy( pose.target );

		if ( camera.orthographic ) {

			this._setView( true, pose.orthoHeight / 2 );

		} else {

			camera.fov = pose.fov;
			camera.updateProjectionMatrix();

		}

		camera.updateMatrixWorld();

	}

	// ── Saved sessions ────────────────────────────────────────────

	/**
	 * The live view, every camera's own effects, the cameras the user added and which one is
	 * active, as plain data. The active camera's effects are the render settings themselves.
	 * @returns {Object}
	 */
	serialize() {

		const camera = this.camera;
		const saved = this._defaultCameraState;

		return {
			current: this.currentCameraIndex,
			view: {
				position: camera.position.toArray(),
				quaternion: camera.quaternion.toArray(),
				scale: camera.scale.toArray(),
				fov: camera.fov,
				near: camera.near,
				far: camera.far,
				zoom: camera.zoom,
				orthographic: !! camera.orthographic,
				orthoHalfHeight: camera.orthoHalfHeight,
				target: this.controls.target.toArray(),
			},
			defaultView: saved ? {
				position: saved.position.toArray(),
				quaternion: saved.quaternion.toArray(),
				scale: saved.scale.toArray(),
				fov: saved.fov,
				near: saved.near,
				far: saved.far,
				target: saved.target?.toArray() ?? null,
			} : null,
			navigationMode: this.navigationMode,
			autoFocus: { mode: this.autoFocusMode, point: { ...this.afScreenPoint } },
			cameras: this.cameras.map( ( cam, index ) => {

				const entry = { index, name: cam.name ?? '', effects: toPortable( cam.userData?.__rayzeeEffects ) ?? null };
				if ( index === 0 || ! cam.userData?.__rayzeeUserCamera ) return entry;

				return {
					...entry,
					user: true,
					orthographic: !! cam.isOrthographicCamera,
					frustum: cam.isOrthographicCamera ? [ cam.left, cam.right, cam.top, cam.bottom ] : null,
					fov: cam.fov ?? null,
					aspect: cam.aspect ?? null,
					near: cam.near,
					far: cam.far,
					zoom: cam.zoom,
					position: cam.position.toArray(),
					quaternion: cam.quaternion.toArray(),
					scale: cam.scale.toArray(),
					orbitTarget: cam.userData.__rayzeeOrbitTarget?.toArray() ?? null,
				};

			} ),
		};

	}

	/**
	 * Puts back what {@link serialize} recorded, against the cameras this load produced. A model
	 * camera is matched by index and name; one that no longer matches keeps its own effects.
	 * Restore render settings first: this sets the exact view after any projection change they made.
	 * @param {Object} state
	 * @returns {{mismatched: string[]}} model cameras whose saved effects were not applied
	 */
	restore( state ) {

		const mismatched = [];
		if ( ! state ) return { mismatched };

		this.cameras = this.cameras.filter( cam => ! cam.userData?.__rayzeeUserCamera );
		const indexMap = new Map();

		for ( const entry of state.cameras ?? [] ) {

			if ( entry.user ) {

				const cam = entry.orthographic
					? new OrthographicCamera( ...entry.frustum, entry.near, entry.far )
					: new PerspectiveCamera( entry.fov, entry.aspect, entry.near, entry.far );
				cam.name = entry.name;
				cam.zoom = entry.zoom ?? 1;
				cam.position.fromArray( entry.position );
				cam.quaternion.fromArray( entry.quaternion );
				cam.scale.fromArray( entry.scale );
				cam.updateProjectionMatrix();
				cam.updateMatrixWorld( true );
				cam.userData.__rayzeeUserCamera = true;
				cam.userData.__rayzeeEffects = fromPortable( entry.effects );
				if ( entry.orbitTarget ) cam.userData.__rayzeeOrbitTarget = new Vector3().fromArray( entry.orbitTarget );
				indexMap.set( entry.index, this.cameras.length );
				this.cameras.push( cam );
				continue;

			}

			const cam = this.cameras[ entry.index ];
			if ( ! cam || ( entry.index > 0 && ( cam.name ?? '' ) !== entry.name ) ) {

				mismatched.push( entry.name );
				continue;

			}

			indexMap.set( entry.index, entry.index );
			if ( entry.effects ) cam.userData.__rayzeeEffects = fromPortable( entry.effects );

		}

		this._userCameraCounter = this.cameras.filter( cam => cam.userData?.__rayzeeUserCamera ).length;
		this.currentCameraIndex = indexMap.get( state.current ) ?? 0;

		const d = state.defaultView;
		this._defaultCameraState = d ? {
			position: new Vector3().fromArray( d.position ),
			quaternion: new Quaternion().fromArray( d.quaternion ),
			scale: new Vector3().fromArray( d.scale ),
			fov: d.fov,
			near: d.near,
			far: d.far,
			target: d.target ? new Vector3().fromArray( d.target ) : null,
		} : null;

		if ( state.navigationMode ) this.setNavigationMode( state.navigationMode );

		const v = state.view;
		if ( v ) {

			const camera = this.camera;
			camera.position.fromArray( v.position );
			camera.quaternion.fromArray( v.quaternion );
			camera.scale.fromArray( v.scale );
			camera.fov = v.fov;
			camera.near = v.near;
			camera.far = v.far;
			this._setView( v.orthographic, v.orthoHalfHeight );
			camera.zoom = v.zoom ?? 1;
			camera.updateProjectionMatrix();
			camera.updateMatrixWorld( true );
			this.controls.target.fromArray( v.target );
			this.controls.update();

		}

		if ( state.autoFocus ) {

			this.setAutoFocusMode( state.autoFocus.mode );
			this.setAFScreenPoint( state.autoFocus.point.x, state.autoFocus.point.y );

		}

		this.resetAutoFocus();
		this._reportOrthoHeight();
		this.dispatchEvent( {
			type: EngineEvents.CAMERA_SWITCHED, cameraIndex: this.currentCameraIndex, effects: this._captureEffects(), fov: this.camera.fov,
			cameraProjection: this._getSettings?.( 'cameraProjection' ),
		} );

		return { mismatched };

	}

	// ── Aliases (match Sub-API surface) ───────────────────────────

	/** The active camera, a {@link ViewCamera}. */
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

	/** Forget what auto-focus last measured: it belonged to another model or viewpoint. */
	resetAutoFocus() {

		this._lastValidFocusDistance = null;
		this._smoothedFocusDistance = null;
		this._afPointDirty = true;

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
	 * @param {Object} params.assetLoader
	 * @param {number} params.currentFocusDistance
	 * @param {import('../Stages/PathTracer.js').PathTracer} params.pathTracer
	 * @param {Function} params.setFocusDistance - Callback to update uniform + settings
	 * @param {Function} params.softReset       - Callback for soft accumulation reset
	 * @param {Function} params.hardReset       - Callback for hard accumulation reset
	 */
	updateAutoFocus( ctx ) {

		const context = ctx || this._afContext;
		if ( ! context || ! this.interactionManager ) return;
		const { assetLoader, currentFocusDistance, pathTracer, setFocusDistance, softReset, hardReset } = context;

		if ( this.autoFocusMode === 'manual' ) return;

		// Depth-of-field is the only consumer of the auto-focus distance. With DOF
		// off (the default) the per-frame scene raycast is pure waste, so skip it.
		// A panorama pauses it too: Raycaster.setFromCamera only knows a frustum.
		// Re-snap on the frame it resumes so focus is correct immediately
		// rather than racking from a stale smoothed value.
		if ( ! pathTracer?.enableDOF?.value || pathTracer.cameraProjection?.value === CAMERA_PROJECTION_IDS.equirectangular ) {

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

		const hitPoint = this._pickFocusPoint( stage.resetCount );

		let rawDistance;
		if ( hitPoint ) {

			rawDistance = viewDepth( hitPoint, this.camera );
			this._lastValidFocusDistance = rawDistance;

		} else {

			if ( this._lastValidFocusDistance !== null ) {

				rawDistance = this._lastValidFocusDistance;

			} else {

				// Nothing under the AF point on a fresh view: focus where the camera orbits.
				const depth = this.controls ? viewDepth( this.controls.target, this.camera ) : 0;
				rawDistance = depth > 0 ? depth : AF_DEFAULTS.FALLBACK_DISTANCE * ( assetLoader?.getSceneScale() || 1.0 );
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

			const scale = assetLoader?.getSceneScale() || 1.0;
			this.dispatchEvent( { type: EngineEvents.AUTO_FOCUS_UPDATED, distance: newFocus / scale, worldDistance: newFocus } );

			const changeRatio = Math.abs( newFocus - prevFocus ) / Math.max( prevFocus, 0.001 );
			if ( forceReset ) {

				hardReset?.();

			} else if ( changeRatio > AF_DEFAULTS.RESET_THRESHOLD ) {

				softReset?.();

			}

		}

	}

	/** Picks again only on a new view or AF point, or a render reset, which every scene change makes. @private */
	_pickFocusPoint( resetCount ) {

		const camera = this.camera;
		const { x, y } = this.afScreenPoint;
		const last = this._afPick ??= { point: new Vector3(), hit: false, resetCount: NaN, x: NaN, y: NaN, view: new Matrix4(), projection: new Matrix4() };

		if ( this._afPointDirty || resetCount !== last.resetCount || x !== last.x || y !== last.y
			|| ! last.view.equals( camera.matrixWorld ) || ! last.projection.equals( camera.projectionMatrix ) ) {

			// AF screen point (0 to 1, y down) to NDC.
			const hit = this.interactionManager.pickSurface( x * 2 - 1, 1 - y * 2 );
			last.hit = !! hit;
			if ( hit ) last.point.copy( hit.point );
			last.resetCount = resetCount;
			last.x = x;
			last.y = y;
			last.view.copy( camera.matrixWorld );
			last.projection.copy( camera.projectionMatrix );

		}

		return last.hit ? last.point : null;

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
	 * @param {import('../Processor/AssetLoader.js').AssetLoader} deps.assetLoader
	 * @param {import('../Stages/PathTracer.js').PathTracer} deps.pathTracer
	 * @param {import('../RenderSettings.js').RenderSettings} deps.settings
	 * @param {Function}                        deps.softReset
	 * @param {Function}                        deps.hardReset
	 */
	initAutoFocus( { assetLoader, pathTracer, settings, softReset, hardReset } ) {

		this._afContext = {
			assetLoader,
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

		this.walkControls?.dispose();
		this.controls?.removeEventListener( 'change', this._reportOrthoHeight );
		this.controls?.dispose();

	}

}
