import { Box3, Vector3 } from 'three';
import { RayzeeRenderer, describeAdapter, RENDER_CHECKPOINT_VERSION } from './RayzeeRenderer.js';
import { NormalDepth } from './Stages/NormalDepth.js';
import { MotionVector } from './Stages/MotionVector.js';
import { ASVGF } from './Stages/ASVGF.js';
import { NRD } from './Stages/NRD.js';
import { Variance } from './Stages/Variance.js';
import { BilateralFilter } from './Stages/BilateralFilter.js';
import { EdgeFilter } from './Stages/EdgeFilter.js';
import { AutoExposure, AUTO_EXPOSURE_DEFAULTS } from './Stages/AutoExposure.js';
import { PRODUCTION_RENDER_CONFIG, INTERACTIVE_RENDER_CONFIG, modePresetSettings } from './EngineDefaults.js';
import { createLogger } from './utils/Logger.js';
import { EngineEvents } from './EngineEvents.js';
import { ISSUE_CODES } from './EngineIssues.js';
import { SETTING_SOURCE } from './RenderSettings.js';
import { CameraManager } from './managers/CameraManager.js';
import { TimelineManager } from './managers/timeline/TimelineManager.js';
import { InteractionManager } from './managers/InteractionManager.js';
import { GoboManager } from './managers/GoboManager.js';
import { IESManager } from './managers/IESManager.js';
import { DenoisingManager } from './managers/DenoisingManager.js';
import { OverlayManager } from './managers/OverlayManager.js';
import { AnimationManager } from './managers/AnimationManager.js';
import { TransformManager } from './managers/TransformManager.js';
import { TransformGizmoHelper } from './managers/helpers/TransformGizmoHelper.js';
import { captureSceneState, applySceneState } from './SceneState/SceneState.js';
import { ARCHIVE_FORMATS } from './Processor/archiveFormats.js';
import { allFormats } from './Processor/FileFormats.js';
import { BidirectionalIntegrator } from './integrators/BidirectionalIntegrator.js';
import { ColorManagement } from './Color/ColorManagement.js';
import { acquireSharedStorage } from './Storage/openStorage.js';

export { describeAdapter, RENDER_CHECKPOINT_VERSION };

const log = createLogger( 'engine' );

/**
 * The viewer: {@link RayzeeRenderer} plus everything a person working in a scene uses — camera controls,
 * picking, the gizmo and overlays, the timeline and animation playback, the denoisers and picture stages,
 * gobos and IES profiles, saved scene state and the preview / final presets.
 *
 * Managers are exposed as direct public properties (Three.js style):
 * - `app.cameraManager`      — {@link CameraManager} (camera, controls, auto-focus, DOF)
 * - `app.lightManager`       — {@link LightManager} (CRUD, helpers, GPU transfer)
 * - `app.denoisingManager`   — {@link DenoisingManager} (strategy, OIDN, AI upscaler)
 * - `app.animationManager`   — {@link AnimationManager} (playback, clips, speed)
 * - `app.transformManager`   — {@link TransformManager} (gizmo, drag, BVH refit)
 * - `app.interactionManager` — {@link InteractionManager} (selection, focus, context menu)
 * - `app.overlayManager`     — {@link OverlayManager} (HUD, helpers)
 * - `app.environmentManager` — EnvironmentManager (HDRI, procedural sky, mode switching)
 * - `app.settings`           — {@link RenderSettings} (all render parameters)
 * - `app.stages`             — Named pipeline stages for advanced control
 * - `app.sceneMeshes`        — meshes backing the BVH, in buffer order (see {@link refitBVH})
 * - `app.sceneModel`         — root of the rendered model (a copy, for {@link loadObject3D})
 * - `app.getSceneObject(id)` — the rendered root for an appended object's id
 *
 * Extends EventDispatcher for event-driven communication with stores/UI.
 */
export class PathTracerApp extends RayzeeRenderer {

	/**
	 * @param {HTMLCanvasElement} canvas
	 * @param {Object} [options] - as {@link RayzeeRenderer}, plus:
	 * @param {HTMLElement} [options.container] - Single DOM parent the engine mounts all auxiliary
	 *   elements into (HUD overlay, denoiser canvas). Defaults to `canvas.parentNode`.
	 *
	 * Headless (no canvas, or `headless: true`), it builds neither the overlay nor the gizmo.
	 */
	constructor( canvas, options = {} ) {

		super( canvas, options );
		this.setColorManagement( ColorManagement );
		this.setStorageOpener( acquireSharedStorage );
		// Per-axis render scale while the camera moves (0.5 = a quarter of the pixels); 1 turns it off.
		this.settings.define( 'interactionRenderScale', {
			default: 0.5,
			apply: () => {

				if ( this.stages?.pathTracer?.interactionMode ) this._requestRenderScale( this._interactionRenderScale() );

			},
			reset: false,
		} );

		this._container = options.container || null;
		this._animRefitInFlight = false;
		this._emittersMoved = false;
		this._pendingRenderScale = null;

		// ── Managers (direct public access) ──
		/** @type {CameraManager} */
		this.cameraManager = null;
		/** @type {TimelineManager} Authored animation: keyframed tracks. */
		this.timeline = null;
		/** @type {GoboManager} */
		this.goboManager = null;
		/** @type {IESManager} */
		this.iesManager = null;
		/** @type {DenoisingManager} */
		this.denoisingManager = null;
		/** @type {OverlayManager} */
		this.overlayManager = null;
		/** @type {InteractionManager} */
		this.interactionManager = null;
		/** @type {TransformManager} */
		this.transformManager = null;
		/** @type {AnimationManager} */
		this.animationManager = new AnimationManager();

	}

	// ═══════════════════════════════════════════════════════════════
	// Setup — the core's init steps, extended
	// ═══════════════════════════════════════════════════════════════

	_createCamera() {

		this.cameraManager = new CameraManager( this.canvas );
		this.timeline = new TimelineManager( { cameraManager: this.cameraManager, onReset: () => this.reset() } );
		return this.cameraManager.camera;

	}

	_initAssetPipeline() {

		super._initAssetPipeline();
		this.assetLoader.controls = this.cameraManager.controls;
		this.assetLoader.registerFormat( ...allFormats );
		// Loaded on first use, as a chunk of its own: most sessions never open an archive.
		this.assetLoader.setArchiveImporterLoader( () => import( './Processor/ArchiveImporter.js' ).then( ( m ) => new m.ArchiveImporter( this.assetLoader ) ), ARCHIVE_FORMATS );

		const onCameraMoved = () => {

			this.needsReset = true;
			// Here rather than in render(), so the first frame of the move is already at the lower resolution.
			this.stages.pathTracer?.enterInteractionMode();
			this.wake();

		};

		this._addTrackedListener( this.cameraManager.controls, 'change', onCameraMoved );
		this._addTrackedListener( this.cameraManager.walkControls, 'change', onCameraMoved );
		// A held key moves the camera from the frame loop, which may be asleep.
		this._addTrackedListener( this.cameraManager.walkControls, 'start', () => this.wake() );

	}

	_createExtraStages() {

		const { renderer, stages } = this;
		stages.normalDepth = new NormalDepth( renderer, { pathTracer: stages.pathTracer } );
		stages.motionVector = new MotionVector( renderer, this.camera, { pathTracer: stages.pathTracer } );
		stages.asvgf = new ASVGF( renderer, { enabled: false } );
		stages.nrd = new NRD( renderer, { enabled: false, pathTracer: stages.pathTracer } );
		stages.variance = new Variance( renderer, { enabled: false } );
		stages.bilateralFilter = new BilateralFilter( renderer, { enabled: false } );
		stages.edgeFilter = new EdgeFilter( renderer, { enabled: false } );
		stages.autoExposure = new AutoExposure( renderer, { enabled: AUTO_EXPOSURE_DEFAULTS.autoExposure } );

		return [
			stages.normalDepth, stages.motionVector, stages.nrd, stages.asvgf,
			stages.variance, stages.bilateralFilter, stages.edgeFilter, stages.autoExposure,
		];

	}

	_initPipeline() {

		super._initPipeline();

		this.pipeline.eventBus.on( 'pathtracer:interactionStart', () => this._requestRenderScale( this._interactionRenderScale() ) );
		// Never fires inside a frame (a timer, or interaction mode being switched off), so it applies at once —
		// renderFrames() and the video renderer drive pipeline.render() without passing through animate().
		this.pipeline.eventBus.on( 'pathtracer:interactionEnd', () => this._applyRenderScale( 1 ) );

	}

	async _initManagers() {

		await super._initManagers();
		this.environmentManager.setProceduralSkyLoader( () => import( './Processor/PhysicalSky.js' ).then( ( m ) => m.PhysicalSky ) );
		this.stages.pathTracer.registerIntegrator( [ 'bidirectional', 'vcm' ], pt => new BidirectionalIntegrator( pt ) );
		// The denoisers read the G-buffer: compiled in from the first build, so switching one on never rebuilds kernels.
		this.stages.pathTracer.requestOutput( 'gBuffer' );

		this.interactionManager = new InteractionManager( {
			scene: this.meshScene,
			camera: this.camera,
			canvas: this.canvas,
			assetLoader: this.assetLoader,
			pathTracer: null,
			floorPlane: this.assetLoader.floorPlane,
			isGeometryOnDisk: () => this.geometryOnDisk,
		} );

		this.interactionManager.wireAppEvents( this );

		this.cameraManager.setInteractionManager( this.interactionManager );
		this.goboManager = new GoboManager( this.stages.pathTracer, {
			onReset: () => this.reset(),
			issues: this._issues,
		} );
		this.iesManager = new IESManager( this.stages.pathTracer, {
			onReset: () => this.reset(),
			issues: this._issues,
		} );
		this._setupDenoisingManager();

		// A second renderer, a 2D canvas and a gizmo, all for pixels nobody sees.
		if ( ! this._headless ) {

			await this._setupOverlayManager();

			this.transformManager = new TransformManager( {
				camera: this.camera,
				canvas: this.canvas,
				orbitControls: this.cameraManager.controls,
				app: this,
			} );

			// The gizmo is part of the scene overlay layer, so it draws on the same
			// view-resolution surface as the light helpers and the outline.
			this.overlayManager.register( 'transform', new TransformGizmoHelper( this.transformManager ) );

		}

		// Wire cross-manager dependencies
		this.interactionManager.setDependencies( {
			overlayManager: this.overlayManager,
			transformManager: this.transformManager,
			appDispatch: ( e ) => this.dispatchEvent( e ),
			orbitControls: this.cameraManager.controls,
			helperScene: this._sceneHelpers.scene,
		} );

		this.denoisingManager.setOverlayManager( this.overlayManager );
		this.denoisingManager.setResetCallback( () => this.reset() );
		this.denoisingManager.setPostProcessRefreshCallback( () => this.requestPostProcessRefresh() );
		this.denoisingManager.setDisplayRefreshCallback( () => this._presentDisplay() );
		this.denoisingManager.setSettings( this.settings );

	}

	_wireEvents() {

		// Forward manager events → app events
		this._addTrackedListener( this.cameraManager, EngineEvents.CAMERA_SWITCHED, ( e ) => this.dispatchEvent( e ) );
		this._addTrackedListener( this.cameraManager, EngineEvents.AUTO_FOCUS_UPDATED, ( e ) => this.dispatchEvent( e ) );
		this._addTrackedListener( this.cameraManager, EngineEvents.ORTHO_HEIGHT_UPDATED, ( e ) => this.dispatchEvent( e ) );
		this._addTrackedListener( this.timeline, EngineEvents.TIMELINE_CHANGED, ( e ) => this.dispatchEvent( e ) );

		this._forwardEvents( this.denoisingManager, [
			EngineEvents.DENOISING_START, EngineEvents.DENOISING_END,
			EngineEvents.UPSCALING_START, EngineEvents.UPSCALING_PROGRESS, EngineEvents.UPSCALING_END,
			EngineEvents.RESOLUTION_CHANGED,
		] );

		this._setupAutoExposureListener();

		// Animation lifecycle → wake + refit flag
		this.animationManager.wakeCallback = () => this.wake();
		this.animationManager.applyPoseCallback = ( pose ) => this._applyAnimationPose( pose );
		this._forwardEvents( this.animationManager, [
			EngineEvents.ANIMATION_STARTED,
			EngineEvents.ANIMATION_PAUSED,
			EngineEvents.ANIMATION_STOPPED,
		] );
		this._addTrackedListener( this.animationManager, EngineEvents.ANIMATION_PAUSED, () => {

			this._animRefitInFlight = false;
			this._refreshMovedEmitters();

		} );
		this._addTrackedListener( this.animationManager, EngineEvents.ANIMATION_STOPPED, () => {

			this._animRefitInFlight = false;

		} );

		// Camera callbacks for switchCamera / focusOn
		this.cameraManager.initCallbacks( {
			onResize: () => this.onResize(),
			onReset: () => this.reset(),
			getSettings: ( k ) => this.settings.get( k ),
			// Per-camera DOF restore — silent + reset:false so switchCamera's own onReset() is the single reset.
			applySettings: ( updates ) => this.settings.setMany( updates, { silent: true, reset: false } ),
		} );

		// Auto-focus context — CameraManager stores it, reads it each frame
		this.cameraManager.initAutoFocus( {
			assetLoader: this.assetLoader,
			pathTracer: this.stages.pathTracer,
			settings: this.settings,
			softReset: () => this.reset( true ),
			hardReset: () => this.reset(),
		} );

		super._wireEvents();

		this._addTrackedListener( this.assetLoader, 'modelProcessed', ( event ) => {

			const cameras = [ this.cameraManager.camera, ...( event.cameras || [] ) ];
			this.cameraManager.setCameras( cameras );
			// Keys are poses in the scene being replaced, like the cameras saved in it.
			this.timeline.clear();

			if ( this.interactionManager ) {

				this.interactionManager.floorPlane = this.assetLoader.floorPlane;

			}

		} );

	}

	_displaySources() {

		return [ 'oidn:output', 'edgeFiltering:output', 'bilateralFiltering:output', 'asvgf:output', 'nrd:output' ];

	}

	_settingsBindings() {

		const core = super._settingsBindings();
		return {
			...core,
			// auto exposure drives the exposure while it is on, and restores this value when turned off
			applyExposure: ( value ) => {

				if ( ! this.stages.autoExposure?.enabled ) core.applyExposure( value );

			},
			onCameraProjection: ( value ) => {

				this.cameraManager.applyProjection( value );
				// MotionVector unprojects through projectionMatrixInverse, which is meaningless once every pixel is its
				// own direction: fall back to the spatial-only denoiser rather than leaving no strategy.
				if ( value === 'equirectangular' && this.denoisingManager?.requiresMotionVectors ) this.denoisingManager.setDenoiserStrategy( 'edgeaware' );

			},
		};

	}

	// ═══════════════════════════════════════════════════════════════
	// The core's hooks
	// ═══════════════════════════════════════════════════════════════

	_beginFrame() {

		this.timeline.update();
		this.cameraManager.updateControls();

		this._applyPendingRenderScale();

		// Animation playback: compute skinned positions and refit BVH.
		// Guard prevents overlapping async refits (fire-and-forget with 1-frame latency).
		if ( this.animationManager?.isPlaying && ! this._animRefitInFlight ) {

			const positions = this.animationManager.update();
			if ( positions ) {

				this._animRefitInFlight = true;
				this.refitBVH( positions )
					.catch( err => log.error( 'animation refit error:', err ) )
					.finally( () => {

						this._animRefitInFlight = false;

					} );

			}

		}

	}

	_beforeTrace() {

		this.cameraManager.updateAutoFocus();

	}

	// A frame traced while a denoise is in flight is never seen: only denoised frames reach
	// the canvas during a camera move, and the next denoise reads the newest frame anyway.
	// Tracing it only takes the GPU away from the denoise the viewport is waiting on —
	// inside a room that turned a 10 ms denoise into 185 ms of wall clock.
	_holdTrace( cameraMoved ) {

		if ( ! this.denoisingManager?.skipsTrace() ) return false;
		// The camera is still being dragged; without this the interaction timeout can
		// expire inside a long denoise and drop the view out of interaction mode.
		if ( cameraMoved ) this.stages.pathTracer.enterInteractionMode();
		return true;

	}

	_afterTrace( stage, live ) {

		this.denoisingManager?.afterTrace();
		if ( live && ! stage.isComplete ) this.denoisingManager?.tickContinuousDenoise( stage.frameCount );

	}

	// Render completion → denoise/upscale chain
	_renderCompleted() {

		this.denoisingManager.onRenderComplete( {
			isStillComplete: () => this.completion.renderCompleteDispatched,
			context: this.pipeline?.context,
		} );

	}

	_renderHelperOverlay() {

		super._renderHelperOverlay();
		this.overlayManager?.render();

	}

	_beforeReset( keepHistory ) {

		this.denoisingManager?.beforeReset( { keepHistory } );

	}

	_afterReset() {

		this.denoisingManager?.afterReset();

		// Whatever is on screen stays until its replacement is ready, including while the camera
		// moves: the denoising manager decides, since only it knows something is coming.
		this._abortPostProcess( { keepDisplay: true } );

	}

	_dropDisplay() {

		this.denoisingManager?.dropDisplay();

	}

	// Stops playback, and drops the selection and the gizmo unless the selected object survives.
	_releaseSceneState( { keepSelection = false } = {} ) {

		if ( ! keepSelection ) {

			this.interactionManager?.deselect();
			this.transformManager?.detach?.();

		}

		this.animationManager?.dispose();
		this._animRefitInFlight = false;
		this._emittersMoved = false;

	}

	_modelReplaced() {

		this._syncControlsAfterLoad();
		this.cameraManager.currentCameraIndex = 0;
		if ( this.cameraManager.cameras.length > 1 ) this.cameraManager.switchCamera( 1 );

	}

	_modelAnnounced() {

		this._dispatchCamerasUpdated();

	}

	_sceneRebuilt() {

		this._initAnimationAndTransforms();

	}

	_sceneBoundsChanged() {

		this._recalibrateControlLimits();

	}

	// The gizmo stays attached to a removed light and warns every frame it draws.
	_lightRemoved( light ) {

		if ( this.interactionManager?.selectedObject === light ) this.interactionManager.deselect();

	}

	// Full size: the denoiser only runs once the camera has stopped.
	_renderSizeChanged( width, height ) {

		this.denoisingManager?.setRenderSize( width, height );

	}

	// Restore live preview: abort() on the denoising manager already
	// handles canvas opacity, denoiser output visibility, and upscaler reset.
	_completionReopened() {

		this.denoisingManager?.abort( this.canvas );

	}

	async _finalDenoise() {

		return this.denoisingManager?.finalDenoise ? await this.runFinalDenoise() : false;

	}

	// Whatever is on the overlay is what the viewport shows, so it is also what a save must
	// write. Gating on `upscaler.enabled` instead missed the neural-rendering pass, which puts
	// a picture there without the ONNX upscaler being on at all — saves silently wrote the
	// un-enhanced render.
	_displayCanvas() {

		const overlay = this.denoisingManager?.upscalerCanvas;
		return overlay && overlay.style.display !== 'none' ? overlay : null;

	}

	_registerVRAM( tracker ) {

		tracker.register( 'denoiser', () => ( { bytes: this.denoisingManager?.gpuBytes() ?? 0 } ) );

	}

	_canvasResources() {

		return this.overlayManager?.gpuResources() ?? [];

	}

	_deterministicSnapshot() {

		return {
			autoFocusMode: this.cameraManager?.autoFocusMode,
			autoExposure: this.stages.autoExposure?.enabled,
			continuousDenoise: this.denoisingManager?.continuousDenoise,
		};

	}

	_setDeterministicExtras( enabled, snapshot ) {

		if ( enabled ) {

			this.cameraManager?.setAutoFocusMode( 'manual' );
			if ( this.stages.autoExposure ) this.stages.autoExposure.enabled = false;
			// Cadence denoising is wall-clock driven, so which frame it lands on is not reproducible.
			this.denoisingManager?.setContinuousDenoise( false );
			return;

		}

		if ( snapshot.autoFocusMode !== undefined ) this.cameraManager?.setAutoFocusMode( snapshot.autoFocusMode );
		if ( this.stages.autoExposure && snapshot.autoExposure !== undefined ) {

			this.stages.autoExposure.enabled = snapshot.autoExposure;

		}

		if ( snapshot.continuousDenoise !== undefined ) {

			this.denoisingManager?.setContinuousDenoise( snapshot.continuousDenoise );

		}

	}

	_disposeExtensions() {

		this.interactionManager?.deselect?.();
		this.transformManager?.detach?.();

		this.animationManager?.dispose();
		this.transformManager?.dispose();
		this.overlayManager?.dispose();
		this.goboManager?.dispose();
		this.iesManager?.dispose();
		this.denoisingManager?.dispose();
		this.interactionManager?.dispose();
		this.timeline?.dispose();
		this.cameraManager?.dispose();

	}

	// ═══════════════════════════════════════════════════════════════
	// Cameras, scene state, animation, presets and post-processing
	// ═══════════════════════════════════════════════════════════════

	/** The index of the currently active camera (0 = built-in default). */
	get currentCameraIndex() {

		return this.cameraManager?.currentCameraIndex ?? 0;

	}

	/**
	 * Snapshot the current view as a new named camera and switch to it.
	 * @param {Object} [opts]
	 * @param {string} [opts.name] - Display name (auto-generated otherwise).
	 * @returns {number} The index of the newly added camera.
	 */
	addCamera( { name } = {} ) {

		const index = this.cameraManager.addCameraFromView( name );
		this.cameraManager.switchCamera( index );
		this._dispatchCamerasUpdated();
		return index;

	}

	/**
	 * Remove a user-added camera by index. Built-in and model-embedded cameras
	 * are protected. Falls back to the default camera if the active one is removed.
	 * @param {number} index
	 * @returns {boolean} true if a camera was removed.
	 */
	removeCamera( index ) {

		const removed = this.cameraManager.removeCamera( index );
		if ( removed ) this._dispatchCamerasUpdated();
		return removed;

	}

	/**
	 * Everything changed since the scene loaded — render settings, environment, colour, lights,
	 * cameras, timeline keys, material edits, hidden and moved objects — as JSON-safe data. The
	 * model is not in it: {@link importSceneState} applies it once the host has loaded that again.
	 * @returns {Object}
	 */
	exportSceneState() {

		return captureSceneState( this );

	}

	/**
	 * Applies {@link exportSceneState}'s data to the scene now loaded. Objects, materials and
	 * cameras are matched by position plus name; a scene that differs keeps its own objects and
	 * materials and the rest still applies.
	 * @param {Object} state
	 * @param {Object} [options]
	 * @param {function(Object): Promise<*>} [options.resolve] - supplies what the engine cannot
	 *   reach: `{ kind: 'environment', source }` → File | URL | null, `{ kind: 'colorConfig', config }`
	 *   → true once loaded. Without it, URL environments and built-in colour configs still restore.
	 * @returns {Promise<{skipped: Array<{section: string, reason: string}>}>}
	 */
	async importSceneState( state, options ) {

		return await applySceneState( this, state, options );

	}

	/** Notify consumers that the camera list changed (names / count). */
	_dispatchCamerasUpdated() {

		this.dispatchEvent( {
			type: EngineEvents.CAMERAS_UPDATED,
			cameras: this.cameraManager.cameras,
			cameraNames: this.cameraManager.getCameraNames(),
		} );

	}

	/** Apply a pose from AnimationManager: placements, visibility, and a followed camera. @private */
	_applyAnimationPose( { meshIndices, visibilityChanged, cameras } ) {

		if ( ! this._sdf?.instanceTable ) return;
		let changed = false;

		if ( meshIndices.length > 0 ) {

			this._notePlacementsMoving( meshIndices );
			this._sdf.updateMeshTransforms( meshIndices );
			this.stages.pathTracer?.updateBufferRanges( [], this._sdf.takeMoveRanges() );
			if ( this._sdf.movesEmitters( meshIndices ) ) {

				this._emittersMoved = true;
				// Deferred while playing: the rebuild uploads a scene-sized map, and sampling
				// already reads each emitter through its placement.
				if ( ! this.animationManager.isPlaying ) this._refreshMovedEmitters();

			}

			changed = true;

		}

		if ( visibilityChanged ) {

			this.stages.pathTracer?.updateAllMeshVisibility();
			this._refreshEmissiveForVisibility();
			changed = true;

		}

		if ( cameras.length > 0 && this._followAnimatedCamera( cameras ) ) changed = true;

		if ( changed ) this.reset( false, { motion: true } );

	}

	/** @private */
	_notePlacementsMoving( meshIndices ) {

		const dm = this.denoisingManager;
		const table = this._sdf?.instanceTable;
		if ( ! dm?.historyActive || ! table ) return;

		for ( const meshIndex of meshIndices ) {

			const run = table.placementRunOf( meshIndex );
			if ( ! run ) continue;
			for ( let p = run.start; p < run.start + run.count; p ++ ) dm.notePlacementMoving( table.tlasLeafIndex[ p ], () => table.matrixWorldOf( p ) );

		}

	}

	/** @private */
	_refreshMovedEmitters() {

		if ( ! this._emittersMoved ) return;
		if ( this._sdf?.spilled ) {

			this.ensureSceneResident().then( () => this._refreshMovedEmitters() );
			return;

		}

		this._emittersMoved = false;
		this._uploadEmissivePayload( this._sdf?.refreshEmissiveTransforms() ?? null );

	}

	/**
	 * Move the view with the selected camera's animated original — the camera list holds copies.
	 * @returns {boolean} whether the view moved
	 * @private
	 */
	_followAnimatedCamera( cameras ) {

		const cm = this.cameraManager;
		const selected = cm.currentCameraIndex > 0 ? cm.cameras[ cm.currentCameraIndex ] : null;
		const uuid = selected?.userData?.__rayzeeSourceUuid;
		const source = uuid && cameras.find( c => c.uuid === uuid );
		if ( ! source ) return false;

		source.updateWorldMatrix( true, false );
		const worldScale = new Vector3();
		source.matrixWorld.decompose( selected.position, selected.quaternion, worldScale );
		// Only the mirror survives.
		selected.scale.set( Math.sign( worldScale.x ) || 1, Math.sign( worldScale.y ) || 1, Math.sign( worldScale.z ) || 1 );
		if ( source.isPerspectiveCamera ) selected.fov = source.fov;

		const camera = cm.camera;
		const controls = cm.controls;
		const distance = controls ? controls.target.distanceTo( camera.position ) : 0;

		camera.position.copy( selected.position );
		camera.quaternion.copy( selected.quaternion );
		camera.scale.copy( selected.scale );
		if ( camera.isPerspectiveCamera && selected.isPerspectiveCamera ) camera.fov = selected.fov;
		camera.updateProjectionMatrix();
		camera.updateMatrixWorld( true );

		// Pivot ahead at the same distance, so controls.update() keeps the pose.
		if ( controls ) {

			const forward = new Vector3( 0, 0, - 1 ).applyQuaternion( camera.quaternion );
			controls.target.copy( camera.position ).addScaledVector( forward, distance || 1 );

		}

		return true;

	}

	// OIDN as the live denoiser rebuilds its network on every size change, so it keeps full size.
	_interactionRenderScale() {

		if ( this.denoisingManager?.continuousDenoise ) return 1;
		const scale = Number( this.settings.get( 'interactionRenderScale' ) );
		return scale > 0 ? Math.min( 1, Math.max( 0.125, scale ) ) : 1;

	}

	// Interaction can start inside PathTracer.render(), where resizing would pull textures out from
	// under the frame, so the change waits for the next frame boundary. No wake(): the move that
	// started it already woke the loop, and waking from inside render() would re-enter it.
	_requestRenderScale( scale ) {

		this._pendingRenderScale = scale;

	}

	_applyPendingRenderScale() {

		if ( this._pendingRenderScale !== null ) this._applyRenderScale( this._pendingRenderScale );

	}

	_applyRenderScale( scale ) {

		this._pendingRenderScale = null;
		if ( this._disposed || scale === this._renderScale ) return;

		this._renderScale = scale;
		if ( ! this._displayWidth || ! this._displayHeight ) return;

		this._setDisplaySize( this._displayWidth, this._displayHeight );
		this.pipeline?.setSize( this._scaled( this._displayWidth ), this._scaled( this._displayHeight ) );
		// History from the other size would reproject garbage.
		this.pipeline?.eventBus.emit( 'pipeline:historyReset' );
		this.needsReset = true;

	}

	/**
	 * Configures the engine for a specific rendering quality tier.
	 * @param {'interactive' | 'production'} mode
	 * @param {Object} [options]
	 */
	configureForMode( mode, options = {} ) {

		const isProduction = mode === 'production';
		const config = isProduction ? PRODUCTION_RENDER_CONFIG : INTERACTIVE_RENDER_CONFIG;

		// First, before anything below can wake the loop or resize the renderer: a live-view
		// refresh landing in the middle of that raced the renderer's own output pass.
		this.denoisingManager?.setCadenceSuspended( isProduction );

		this.timeline.stop();
		this.cameraManager.controls.enabled = ! isProduction;

		// Anything with a SETTING_ROUTES entry must go through settings, not setUniform: set() early-returns on
		// `prev === value`, so a uniform written behind the map leaves it stale and the next set() silently no-ops.
		this.settings.setMany( modePresetSettings( config ), { silent: true, source: SETTING_SOURCE.MODE_PRESET } );

		// renderMode has no SETTING_ROUTES entry
		this.stages.pathTracer?.setUniform( 'renderMode', parseInt( config.renderMode ) );

		// A move just before this left the moving-camera drop in force or queued; a final render
		// never runs at it.
		if ( isProduction ) this._applyRenderScale( 1 );

		this.stages.pathTracer?.updateCompletionThreshold?.();

		const denoiser = this.denoisingManager?.denoiser;
		if ( denoiser ) {

			denoiser.abort();
			// Through the manager both times: `denoiser.enabled` is the union of its two jobs and
			// `denoiser.quality` dips to a cheaper model between refreshes, so neither is the
			// record of what the host asked for.
			this.denoisingManager.applyOIDNEnabled( config.enableOIDN );
			this.denoisingManager.applyOIDNQuality( config.oidnQuality );

		}

		// OIDN toggled directly above (bypassing setOIDNEnabled) — re-sync so the wavefront produces the
		// aux MRT when OIDN is on and skips it otherwise. Runs before the reset below so kernels rebuild once.
		this.denoisingManager?._syncGBufferStages?.();

		this.denoisingManager?.upscaler?.abort();

		if ( options.canvasWidth && options.canvasHeight ) {

			// Raise the reserved storage first so a > 2048 final-render resolution (4K) fits (device-capped,
			// in-place re-init). No-op when the size already fits.
			this.setReservedRenderResolution( Math.max( options.canvasWidth, options.canvasHeight ) );
			this.setCanvasSize( options.canvasWidth, options.canvasHeight );

		}

		this.needsReset = false;
		this.pauseRendering = false;

		// Entering a final render starts a fresh peak window (Blender per-render semantics).
		if ( isProduction ) {

			const tracker = this.stages.pathTracer?.vramTracker;
			if ( tracker ) {

				tracker.measure();
				tracker.resetPeak();

			}

		}

		this.reset();

	}

	// Draws once without waking the loop: a woken loop takes a finished render nothing marked
	// complete (renderFrames, a video export) as newly finished, and denoises it again.
	_presentDisplay() {

		if ( this.animationManagerId ) {

			this._needsDisplayRefresh = true;
			return;

		}

		const context = this.pipeline?.context;
		if ( this._deviceLost || ! context ) return;
		this.stages.compositor?.render( context );
		this._renderHelperOverlay();

	}

	/**
	 * One OIDN pass over the current accumulation at the final tier, resolved once the denoised
	 * picture is published. Does not start the render loop or the upscaler; read the result with
	 * `renderToBuffer( { source: 'display' } )`.
	 * @returns {Promise<boolean>} whether a denoised picture was published
	 */
	async runFinalDenoise() {

		const dm = this.denoisingManager;
		if ( await dm?.denoiseOnce() ) return true;

		const reason = ! dm?.denoiser ? 'the denoiser was not built'
			: ! dm.denoiser.enabled ? 'OIDN was off while accumulating — call denoisingManager.setOIDNEnabled( true ) first'
				: 'the denoise did not complete';
		this._issues.record( ISSUE_CODES.DENOISER_UNAVAILABLE, `final denoise produced no picture: ${reason}`, { reason } );
		return false;

	}

	// Aborts any in-flight denoise/upscale and puts the denoiser canvas back at base resolution (the
	// upscaler leaves it enlarged), so the live canvas is what's on screen again.
	_abortPostProcess( { keepDisplay = false } = {} ) {

		this.denoisingManager?.abort( this.canvas, { keepDisplay } );

		if ( this.denoisingManager?.restoreBaseResolution() ) {

			const w = this.denoisingManager._lastRenderWidth;
			const h = this.denoisingManager._lastRenderHeight;
			this.dispatchEvent( { type: EngineEvents.RESOLUTION_CHANGED, width: w, height: h } );

		}

	}

	/**
	 * Re-runs the post-process chain (OIDN → upscaler) against the accumulated image. The chain fires once,
	 * on the frame the render completes, so a denoiser switched on afterwards would otherwise never run.
	 */
	requestPostProcessRefresh() {

		if ( ! this.stages.pathTracer?.isReady || this._deviceLost ) return;

		this._abortPostProcess();

		this.completion.renderCompleteDispatched = false;
		this.wake();

	}

	/**
	 * Arms per-layer GPU timestamping inside the OIDN denoiser for the next denoise only.
	 * Read the result with {@link PathTracerApp#getDenoiseProfile}.
	 *
	 * `getGPUTimings()` cannot see the denoise: oidn-web submits on its own command encoders,
	 * outside the stages three.js times.
	 *
	 * @returns {boolean} whether the capture was armed
	 */
	profileNextDenoise() {

		return this.denoisingManager?.denoiser?.profileNextDenoise() ?? false;

	}

	/**
	 * Per-layer GPU timings from the denoise armed by {@link PathTracerApp#profileNextDenoise},
	 * plus the live engine/precision/model/tile diagnostics.
	 *
	 * @returns {Promise<{ profile: Object|null, runtime: Object|null }|null>}
	 */
	async getDenoiseProfile() {

		const denoiser = this.denoisingManager?.denoiser;
		if ( ! denoiser ) return null;

		return {
			profile: await denoiser.getLastDenoiseProfile(),
			runtime: denoiser.getRuntimeInfo(),
		};

	}

	// With none, the raw accumulation is the display.
	_denoiserInUse() {

		const dm = this.denoisingManager;
		return !! dm?.denoiser?.enabled || ( dm?.denoiserStrategy ?? 'none' ) !== 'none';

	}

	/**
	 * Initializes animation manager and transform manager after scene rebuild.
	 */
	_initAnimationAndTransforms() {

		const animations = this.assetLoader?.animations || [];
		if ( animations.length > 0 ) {

			const mixerRoot = this.sceneModel || this.meshScene;
			this.animationManager.init( this.meshScene, mixerRoot, this._sdf.meshes, animations );
			this.animationManager.onFinished = () => {

				this._animRefitInFlight = false;
				this._refreshMovedEmitters();
				this.dispatchEvent( { type: EngineEvents.ANIMATION_FINISHED } );

			};

		}

		this.transformManager?.setMeshData( this._sdf.meshes );

	}

	_setupDenoisingManager() {

		this.denoisingManager = new DenoisingManager( {
			renderer: this.renderer,
			mainCanvas: this.canvas,
			stages: {
				pathTracer: this.stages.pathTracer,
				normalDepth: this.stages.normalDepth,
				motionVector: this.stages.motionVector,
				asvgf: this.stages.asvgf,
				nrd: this.stages.nrd,
				variance: this.stages.variance,
				bilateralFilter: this.stages.bilateralFilter,
				edgeFilter: this.stages.edgeFilter,
				autoExposure: this.stages.autoExposure,
				compositor: this.stages.compositor,
			},
			pipeline: this.pipeline,
			getExposure: () => this.settings.get( 'exposure' ) ?? 1.0,
			getSaturation: () => this.settings.get( 'saturation' ) ?? 1.0,
			issues: this._issues,
		} );

		this.denoisingManager.setupDenoiser();
		this.denoisingManager.setupUpscaler();

		// Seed G-buffer gating: NormalDepth/MotionVector start enabled (stage default)
		// but are only needed by real-time denoisers — idle them until one is active.
		this.denoisingManager._syncGBufferStages();

		// Set initial render resolution
		const initW = this.canvas.clientWidth || 1;
		const initH = this.canvas.clientHeight || 1;
		this.denoisingManager.setRenderSize( initW, initH );

	}

	_setupAutoExposureListener() {

		if ( ! this.stages.autoExposure ) return;

		this.stages.autoExposure.on( 'autoexposure:updated', ( data ) => {

			this.dispatchEvent( {
				type: EngineEvents.AUTO_EXPOSURE_UPDATED,
				exposure: data.exposure,
				luminance: data.luminance
			} );

		} );

	}

	async _setupOverlayManager() {

		this.overlayManager = new OverlayManager( this.cameraManager.camera );
		this.overlayManager.setupDefaultHelpers( {
			helperScene: this._sceneHelpers,
			meshScene: this.meshScene,
			pipeline: this.pipeline,
			denoisingManager: this.denoisingManager,
			app: this,
			renderWidth: this.denoisingManager?._lastRenderWidth || this.canvas.clientWidth || 1,
			renderHeight: this.denoisingManager?._lastRenderHeight || this.canvas.clientHeight || 1,
		} );

		// Helpers draw at the size the canvas is displayed at, not the size it is
		// rendered at. Shares the main device, so this is a swapchain, not a context.
		await this.overlayManager.initViewRenderer( {
			device: this.renderer.backend?.device,
			sizeSource: this.canvas,
		} );

		this._container = this._container || this.canvas.parentNode || null;
		this.overlayManager.mount( this._container );

	}

	_syncControlsAfterLoad() {

		this.cameraManager.fitOrthographic();
		this.cameraManager.controls.saveState();
		this.cameraManager.controls.update();
		this.cameraManager.walkControls.fitSpeed( this.assetLoader.getSceneScale() );

	}

	/**
	 * Recompute OrbitControls zoom limits (+ default-camera near/far) from the CURRENT
	 * model bounds without moving the camera or its target. Called after a dynamic
	 * add/remove (the reframe-free path) so an enlarged scene stays reachable and
	 * unclipped, and a shrunken one re-tightens. The replace-load (reframe) path owns
	 * this via onModelLoad(). Bounds cover only the loaded model roots
	 * (__rayzeeSceneObject) so the oversized, usually-hidden Ground plane can't inflate them.
	 */
	_recalibrateControlLimits() {

		if ( ! this.meshScene || ! this.cameraManager ) return;

		const bounds = new Box3();
		const tmp = new Box3();
		for ( const child of this.meshScene.children ) {

			if ( ! child.userData?.__rayzeeSceneObject ) continue;
			tmp.setFromObject( child );
			if ( ! tmp.isEmpty() ) bounds.union( tmp );

		}

		if ( bounds.isEmpty() ) return;

		const maxDim = Math.max(
			bounds.max.x - bounds.min.x,
			bounds.max.y - bounds.min.y,
			bounds.max.z - bounds.min.z,
		);
		if ( ! Number.isFinite( maxDim ) || maxDim <= 0 ) return;

		const { camera, controls } = this.cameraManager;

		// Same framing distance onModelLoad() uses for the initial reframe.
		const fov = camera.fov * ( Math.PI / 180 );
		const cameraDistance = Math.abs( maxDim / Math.sin( fov / 2 ) / 2 );

		// Keep the (grown/shrunken) scene inside the frustum. Only touch near/far when the
		// default orbit camera is active — don't stomp an authored model camera's frustum.
		if ( this.cameraManager.currentCameraIndex === 0 ) {

			camera.near = maxDim / 100;
			camera.far = maxDim * 100;
			camera.updateProjectionMatrix();

		}

		// Reframe-free: never clamp past where the camera currently sits, so the rebuild
		// can't yank it (e.g. when the scene shrinks after a removal).
		const currentDist = camera.position.distanceTo( controls.target );
		controls.minDistance = Math.min( maxDim / 1000, currentDist );
		controls.maxDistance = Math.max( cameraDistance * 10, currentDist * 1.1 );

		controls.update();

	}

}
