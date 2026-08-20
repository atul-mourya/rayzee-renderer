import { WebGPURenderer, RectAreaLightNode, SRGBColorSpace } from 'three/webgpu';
import { texture as _tslTexture, cubeTexture as _tslCubeTexture } from 'three/tsl';
import {
	ACESFilmicToneMapping, Scene, EventDispatcher, Box3
} from 'three';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { SceneHelpers } from './SceneHelpers.js';
import { PathTracer } from './Stages/PathTracer.js';
import { NormalDepth } from './Stages/NormalDepth.js';
import { MotionVector } from './Stages/MotionVector.js';
import { ASVGF } from './Stages/ASVGF.js';
import { Variance } from './Stages/Variance.js';
import { BilateralFilter } from './Stages/BilateralFilter.js';
import { EdgeFilter } from './Stages/EdgeFilter.js';
import { AutoExposure } from './Stages/AutoExposure.js';
import { Compositor } from './Stages/Compositor.js';
import { RenderPipeline } from './Pipeline/RenderPipeline.js';
import { CompletionTracker } from './Pipeline/CompletionTracker.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE, PRODUCTION_RENDER_CONFIG, INTERACTIVE_RENDER_CONFIG, MAX_STORAGE_TEXTURE_SIZE, MAX_RESERVABLE_RENDER_SIZE, setReservedRenderSize } from './EngineDefaults.js';
import { updateStats, updateLoading, resetLoading, setStatusCallback, getDisplaySamples, disposeObjectFromMemory, disposeRenderer } from './Processor/utils.js';
import { BuildTimer } from './Processor/BuildTimer.js';
import { createLogger, fmt } from './utils/Logger.js';
import { InteractionManager } from './managers/InteractionManager.js';
import { EngineEvents } from './EngineEvents.js';
import { AssetLoader } from './Processor/AssetLoader.js';
import { SceneProcessor } from './Processor/SceneProcessor.js';

// Managers
import { RenderSettings } from './RenderSettings.js';
import { CameraManager } from './managers/CameraManager.js';
import { LightManager } from './managers/LightManager.js';
import { GoboManager } from './managers/GoboManager.js';
import { IESManager } from './managers/IESManager.js';
import { DenoisingManager } from './managers/DenoisingManager.js';
import { OverlayManager } from './managers/OverlayManager.js';
import { AnimationManager } from './managers/AnimationManager.js';
import { TransformManager } from './managers/TransformManager.js';
import { TransformGizmoHelper } from './managers/helpers/TransformGizmoHelper.js';

// One app per canvas — auto-dispose a prior owner if the caller double-
// instantiates (StrictMode, HMR, etc.) so its rAF loop can't burn CPU.
const _appsByCanvas = new WeakMap();


/**
 * WebGPU Path Tracer Application.
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
 *
 * Extends EventDispatcher for event-driven communication with stores/UI.
 */

const log = createLogger( 'engine' );

export class PathTracerApp extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
	 * @param {Object} [options] - Engine options
	 * @param {boolean} [options.autoResize=true] - Automatically listen for window resize events
	 * @param {HTMLElement} [options.container] - Single DOM parent the engine mounts all auxiliary
	 *   elements into (HUD overlay, denoiser canvas). Defaults to `canvas.parentNode`.
	 *
	 * The engine dispatches `EngineEvents.FRAME` after each animate() iteration so hosts can
	 * tick external instrumentation (e.g. a stats panel) without coupling the engine to it.
	 */
	constructor( canvas, options = {} ) {

		super();

		try {

			_appsByCanvas.get( canvas )?.dispose();

		} catch ( err ) {

			log.warn( 'prior canvas owner dispose failed', err );

		}

		_appsByCanvas.set( canvas, this );

		this.canvas = canvas;
		this._autoResize = options.autoResize !== false;
		this._container = options.container || null;

		// ── Settings (single source of truth for all render parameters) ──
		this.settings = new RenderSettings( DEFAULT_STATE );

		// ── Core objects (populated in init) ──
		this.renderer = null;
		this.scene = null;
		this.meshScene = null;
		this._sceneHelpers = null;

		// ── Asset pipeline ──
		this.assetLoader = null;
		this._sdf = null;
		this._animRefitInFlight = false;
		// Max material-texture dimension (longest edge); applied on each scene build.
		this._maxTextureSize = DEFAULT_STATE.maxTextureSize;

		// ── Pipeline & stages ──
		this.pipeline = null;

		this._pendingReservedRenderSize = null;

		/**
		 * Named access to all pipeline stages.
		 * Advanced consumers can reach into stages for fine-grained control.
		 * @type {Object}
		 */
		this.stages = {};

		// ── Managers (direct public access) ──
		/** @type {CameraManager} */
		this.cameraManager = null;
		/** @type {LightManager} */
		this.lightManager = null;
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
		/** @type {import('./managers/EnvironmentManager.js').EnvironmentManager} */
		this.environmentManager = null;

		// ── State ──
		this.isInitialized = false;
		this.pauseRendering = false;
		this._pathTracerEnabled = true;
		this._rasterPrecompile = null;
		this.animationManagerId = null;
		this.needsReset = false;
		this._loadingInProgress = false;
		this._needsDisplayRefresh = false;
		this._paused = false;
		// Emissive-triangle NEE auto-follows the scene (on when it has emissive geometry)
		// until the user toggles it explicitly; reset on each fresh model load.
		this._emissiveSamplingUserSet = false;

		// Render completion tracking
		this.completion = new CompletionTracker();

		// Resolution state
		this._resizeDebounceTimer = null;

		// Tracked listeners for clean dispose()
		this._trackedListeners = [];
		this._disposed = false;
		this._deviceLost = false;

		// Deterministic-render mode — see setDeterministicMode()
		this._deterministic = false;
		this._dispatchPinned = false;
		this._deterministicRestore = null;

	}

	/**
	 * Registers an event listener and tracks it for automatic cleanup on dispose().
	 * @param {EventTarget|{addEventListener:Function, removeEventListener:Function}} target
	 * @param {string} type
	 * @param {Function} handler
	 */
	_addTrackedListener( target, type, handler ) {

		if ( ! target ) return;
		target.addEventListener( type, handler );
		this._trackedListeners.push( { target, type, handler } );

	}

	/** Removes all listeners registered via _addTrackedListener. */
	_removeTrackedListeners() {

		for ( const { target, type, handler } of this._trackedListeners ) {

			try {

				target.removeEventListener( type, handler );

			} catch ( err ) {

				log.warn( 'failed to remove listener', type, err );

			}

		}

		this._trackedListeners.length = 0;

	}

	// ═══════════════════════════════════════════════════════════════
	// Lifecycle
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Initializes the WebGPU renderer, pipeline stages, and managers.
	 */
	async init() {

		await this._initRenderer();
		this._applyPendingReservedRenderSize();
		this._initCameraManager();
		this._initScenes();
		this._initAssetPipeline();
		this._initPipeline();
		await this._initManagers();
		this._wireEvents();

		// Seed path tracer with minimal empty scene data
		this.stages.pathTracer.setTriangleData( new Float32Array( 32 ), 0 );
		this.stages.pathTracer.setBVHData( new Float32Array( 16 ) );
		this.stages.pathTracer.materialData.setMaterialData( new Float32Array( 16 ) );
		this.stages.pathTracer.setupMaterial();

		this.isInitialized = true;
		log.debug( 'WebGPU path tracer app initialized' );

		return this;

	}

	/**
	 * Starts the animation loop.
	 */
	animate() {

		// Device lost: stop the loop rather than rescheduling render() on a dead device.
		if ( this._deviceLost ) return;

		this.animationManagerId = requestAnimationFrame( () => this.animate() );

		if ( this._loadingInProgress || this._sdf?.isProcessing ) {

			this.dispatchEvent( { type: EngineEvents.FRAME } );
			return;

		}

		if ( this.cameraManager.controls ) this.cameraManager.controls.update();

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

		if ( this.needsReset ) {

			this.reset( true );
			this.needsReset = false;

		}

		this.cameraManager.camera.updateMatrixWorld();

		// Raster fallback when path tracer is disabled
		if ( ! this.pathTracerEnabled ) {

			this.renderer.render( this.meshScene, this.cameraManager.camera );
			this._renderHelperOverlay();
			return;

		}

		if ( this.pauseRendering ) return;

		// Auto-focus: compute focus distance before rendering
		this.cameraManager.updateAutoFocus();

		// Render path tracing
		if ( this.stages.pathTracer?.isReady ) {

			if ( this.stages.pathTracer.isComplete && this.completion.renderCompleteDispatched ) {

				if ( this._needsDisplayRefresh ) {

					this._needsDisplayRefresh = false;
					this.stages.compositor.render( this.pipeline.context );
					this._renderHelperOverlay();

				}

				// Stop the loop to avoid constant CPU usage while idle
				this.stopAnimation();
				return;

			}

			this.pipeline.render();

			if ( ! this.stages.pathTracer.isComplete ) {

				this.completion.updateTime();

			}

			this._ensureVRAMWiring();
			// VRAM is monotonic and only changes on allocation events (scene/env
			// load, resize — each re-measures via _ensureVRAMWiring). Within an
			// accumulation burst nothing reallocates, so re-walking every stage's
			// textures each frame is wasted. Measure at burst start (catches any
			// reset-triggered allocation) + a periodic backstop; read cached otherwise.
			const tracker = this.stages.pathTracer?.vramTracker;
			const frame = this.stages.pathTracer?.frameCount ?? 0;
			if ( tracker && ( frame <= 1 || frame % 30 === 0 ) ) tracker.measure();

			updateStats( {
				timeElapsed: this.completion.timeElapsed,
				samples: getDisplaySamples( this.stages.pathTracer ),
				memoryUsed: tracker?.current ?? 0,
				memoryPeak: tracker?.peak ?? 0,
			} );

			// Check time limit
			if ( this.completion.isTimeLimitReached( this.settings.get( 'renderLimitMode' ), this.settings.get( 'renderTimeLimit' ) ) ) {

				this.stages.pathTracer.isComplete = true;

			}

			// Render completion → denoise/upscale chain
			if ( this.stages.pathTracer.isComplete && this.completion.markComplete() ) {

				this.denoisingManager.onRenderComplete( {
					isStillComplete: () => this.completion.renderCompleteDispatched,
					context: this.pipeline?.context,
				} );

				this.dispatchEvent( { type: 'RenderComplete' } );
				this.dispatchEvent( { type: EngineEvents.RENDER_COMPLETE } );

			}

		}

		this._renderHelperOverlay();
		this.dispatchEvent( { type: EngineEvents.FRAME } );

	}

	/**
	 * Stops the animation loop.
	 */
	stopAnimation() {

		if ( this.animationManagerId ) {

			cancelAnimationFrame( this.animationManagerId );
			this.animationManagerId = null;

		}

	}

	/**
	 * Handle GPU device loss: halt the render loop and notify hosts so they can surface a
	 * "renderer lost — reload" prompt. Full auto-recovery would require rebuilding every GPU
	 * resource, so this deliberately stops cleanly rather than attempting to re-init.
	 */
	_handleDeviceLost( info ) {

		if ( this._deviceLost ) return;
		this._deviceLost = true;
		log.error( `WebGPU device lost (${info?.reason || 'unknown'}): ${info?.message || ''}` );
		this.stopAnimation();
		this.dispatchEvent( { type: EngineEvents.DEVICE_LOST, reason: info?.reason, message: info?.message } );

	}

	/** Wakes the animation loop if it was stopped due to idle. */
	wake() {

		if ( this._deviceLost ) return;
		if ( ! this.animationManagerId && this.isInitialized && ! this._paused ) this.animate();

	}

	/** Pauses the animation loop. */
	pause() {

		this._paused = true;
		this.stopAnimation();

	}

	/** Resumes the animation loop. */
	resume() {

		this._paused = false;
		if ( ! this.animationManagerId ) this.animate();

	}

	/**
	 * Resets the accumulation buffer.
	 * @param {boolean} soft - When true, preserves ASVGF temporal history
	 */
	reset( soft = false ) {

		if ( this.pipeline ) {

			this.pipeline.reset();
			if ( ! soft ) this.pipeline.eventBus.emit( 'asvgf:reset' );

		}

		this._abortPostProcess();

		this.completion.reset();
		this.wake();
		this.dispatchEvent( { type: 'RenderReset' } );
		this.dispatchEvent( { type: EngineEvents.RENDER_RESET } );

	}

	/**
	 * Disposes of all resources.
	 */
	dispose() {

		if ( this._disposed ) return;
		this._disposed = true;

		this.dispatchEvent( { type: EngineEvents.DISPOSE } );
		this.stopAnimation();
		clearTimeout( this._resizeDebounceTimer );
		this._resizeDebounceTimer = null;

		this._removeTrackedListeners();
		setStatusCallback( null );

		this.interactionManager?.deselect?.();
		this.transformManager?.detach?.();

		this.animationManager?.dispose();
		this.transformManager?.dispose();
		this.overlayManager?.dispose();
		this.lightManager?.dispose();
		this.goboManager?.dispose();
		this.iesManager?.dispose();
		this.denoisingManager?.dispose();
		this.interactionManager?.dispose();
		this.cameraManager?.dispose();

		this.pipeline?.dispose();

		// _sdf + assetLoader own the heaviest GPU allocations (material texture arrays,
		// BVH/triangle buffers, loaded GLTF resources, BVH refit worker, loader caches).
		// They are not referenced by the pipeline, so pipeline.dispose() does not reach them.
		this._sdf?.dispose();
		this._sdf = null;

		this.assetLoader?.dispose();
		this.assetLoader = null;

		if ( this.meshScene ) {

			this.meshScene.environment?.dispose();
			this.meshScene.environment = null;

			for ( const child of [ ...this.meshScene.children ] ) {

				disposeObjectFromMemory( child );

			}

			this.meshScene.clear();
			this.meshScene = null;

		}

		this._sceneHelpers?.clear();
		this._sceneHelpers = null;

		this.scene?.clear();
		this.scene = null;

		// Three.js 0.184 leak (confirmed via heap-snapshot retainer analysis): the
		// Textures manager (one per renderer) registers a per-texture 'dispose'
		// listener that closes over `this = Textures` — which transitively captures
		// backend → renderer. These listeners are removed only when the texture
		// itself is destroyed. For module-level singletons like EmptyTexture (new
		// Texture in TextureNode.js) and its CubeTexture counterpart, the texture is
		// never destroyed, so every renderer ever created leaks through the
		// singleton's listener array.
		//
		// Safe when only a single PathTracerApp is active at a time. If you run
		// multiple in parallel, reset listeners only on the renderer being disposed
		// (not the shared singletons). The sibling _canvasTarget leak is handled by
		// disposeRenderer().
		try {

			const emptyTex = _tslTexture().value;
			const emptyCube = _tslCubeTexture().value;
			if ( emptyTex?._listeners?.dispose ) emptyTex._listeners.dispose.length = 0;
			if ( emptyCube?._listeners?.dispose ) emptyCube._listeners.dispose.length = 0;

		} catch ( err ) {

			log.warn( 'failed to clear TSL texture singleton listeners', err );

		}

		disposeRenderer( this.renderer );
		this.renderer = null;

		this.stages = {};
		this.isInitialized = false;

	}

	// ═══════════════════════════════════════════════════════════════
	// Asset Loading
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Tears down the current scene: stops animation, deselects, disposes
	 * the loaded model + its GPU resources, clears lights, and seeds the
	 * path tracer with an empty scene. Leaves the renderer, pipeline, and
	 * managers intact so a subsequent loadModel() can reuse them.
	 *
	 * Safe to call at any point after init() (including while idle).
	 * Throws if called concurrently with a load.
	 */
	unloadScene() {

		if ( ! this.isInitialized ) return;
		if ( this._loadingInProgress ) {

			throw new Error( 'PathTracerApp.unloadScene: cannot unload while a load is in progress' );

		}

		if ( this._disposed ) return;

		// Stop animation + refit
		this.animationManager?.dispose();
		this._animRefitInFlight = false;

		// Drop selection + transform gizmo attachment
		this.interactionManager?.deselect();
		this.transformManager?.detach?.();

		// Release the loaded model. If loaded via loadObject3D(), the caller owns it —
		// we only detach it from the scene. Otherwise dispose geometries/materials/textures.
		this.assetLoader?.releaseTargetModel();

		// Clear lights in the WebGPU light scene
		this.lightManager?.clearLights?.();

		// Seed path tracer with empty data (matches the init-time seed)
		if ( this.stages.pathTracer ) {

			this.stages.pathTracer.setTriangleData( new Float32Array( 32 ), 0 );
			this.stages.pathTracer.setBVHData( new Float32Array( 16 ) );
			this.stages.pathTracer.materialData.setMaterialData( new Float32Array( 16 ) );
			this.stages.pathTracer.setEmissiveTriangleData?.( new Float32Array( 0 ), 0, 0 );
			this.stages.pathTracer.setupMaterial();

		}

		this.reset();
		this.dispatchEvent( { type: 'SceneUnloaded' } );

	}

	/**
	 * Loads a model, builds BVH, and uploads scene data.
	 * @param {string} url - Model URL
	 */
	async loadModel( url ) {

		await this._loadWithSceneRebuild(
			() => this.assetLoader.loadModel( url ),
			{ type: 'ModelLoaded', url }
		);

	}

	/**
	 * Loads a Three.js Object3D directly into the path tracer scene.
	 * Builds BVH from the object's meshes and uploads scene data.
	 * @param {import('three').Object3D} object3d - The Object3D to render
	 * @param {string} [name='object3d'] - Display name for the object
	 */
	async loadObject3D( object3d, name = 'object3d' ) {

		await this._loadWithSceneRebuild(
			() => this.assetLoader.loadObject3D( object3d, name ),
			{ type: 'Object3DLoaded', name }
		);

	}

	/**
	 * Loads an environment map and rebuilds CDF.
	 * @param {string} url - Environment URL
	 */
	async loadEnvironment( url ) {

		if ( this._loadingInProgress ) {

			throw new Error( 'PathTracerApp.loadEnvironment: another load is already in progress' );

		}

		this._loadingInProgress = true;

		try {

			await this.assetLoader.loadEnvironment( url );

			const environmentTexture = this.meshScene.environment;
			if ( environmentTexture && this.stages.pathTracer ) {

				await this.stages.pathTracer.environment.setEnvironmentMap( environmentTexture );

			}

			this.pipeline?.eventBus.emit( 'autoexposure:resetHistory' );
			this.reset();
			this.dispatchEvent( { type: 'EnvironmentLoaded', url } );

		} finally {

			this._loadingInProgress = false;

		}

	}

	/**
	 * Loads example models by index.
	 * @param {number} index
	 * @param {Array} modelFiles
	 */
	async loadExampleModels( index, modelFiles ) {

		await this._loadWithSceneRebuild(
			() => this.assetLoader.loadExampleModels( index, modelFiles ),
			{ type: 'ModelLoaded', index }
		);

	}

	/**
	 * Cancel the in-flight model/environment download, if any. The active
	 * loadAsync() rejects with a typed LOAD_CANCELLED error, which callers treat
	 * as a user cancellation (not a load failure). Only the network-download phase
	 * is cancelable — once processing (BVH/textures) has started this is a no-op.
	 * The scene is untouched: replace-loads release the old model only after the
	 * download succeeds, and appends parent nothing until then.
	 */
	cancelLoad() {

		if ( ! this._loadingInProgress ) return;
		this.assetLoader?.cancelActiveLoad();

	}

	/**
	 * Set the max material-texture dimension (longest edge) used when processing a
	 * scene's textures into GPU arrays. Clamped to the hardware ceiling. Larger =
	 * sharper textures, ~quadratic VRAM. By default reprocesses the current scene so
	 * the change is visible without a manual reload.
	 * @param {number} size
	 * @param {Object} [opts]
	 * @param {boolean} [opts.reprocess=true] - Rebuild the current scene now.
	 * @returns {Promise<void>}
	 */
	async setMaxTextureSize( size, { reprocess = true } = {} ) {

		const prev = this._maxTextureSize;
		const clamped = this._sdf?.setMaxTextureSize( size );
		this._maxTextureSize = clamped ?? size;
		if ( typeof this.stages?.pathTracer?.sdfs?.setMaxTextureSize === 'function' ) {

			this.stages.pathTracer.sdfs.setMaxTextureSize( this._maxTextureSize );

		}

		// Reprocess the loaded scene so the new cap takes effect immediately.
		if ( reprocess && this._maxTextureSize !== prev && this._sdf?.triangleData && ! this._loadingInProgress ) {

			this._loadingInProgress = true;
			try {

				await this.loadSceneData();
				this.reset();
				this.dispatchEvent( { type: 'TexturesReprocessed', maxTextureSize: this._maxTextureSize } );

			} finally {

				this._loadingInProgress = false;

			}

		}

	}

	/** Shared pipeline: load asset → sync controls → build BVH → reset → dispatch events */
	async _loadWithSceneRebuild( loadFn, eventPayload ) {

		if ( this._loadingInProgress ) {

			throw new Error( 'PathTracerApp: another load is already in progress' );

		}

		this._loadingInProgress = true;

		try {

			await loadFn();
			// A fresh model re-establishes the emissive-sampling auto-default (incremental
			// rebuilds — add/remove object, texture reprocess — preserve the user's choice).
			this._emissiveSamplingUserSet = false;
			// Replace-load clears any dynamically-appended models — but only AFTER
			// loadFn() succeeds, so a failed load leaves the current scene intact.
			// (The old primary was already released by releaseTargetModel() in loadFn.)
			this._clearAppendedModels();
			this._syncControlsAfterLoad();
			await this.loadSceneData();
			this.pipeline?.eventBus.emit( 'autoexposure:resetHistory' );
			this.reset();
			this.cameraManager.currentCameraIndex = 0;
			this.dispatchEvent( eventPayload );
			this._dispatchCamerasUpdated();

		} finally {

			this._loadingInProgress = false;

		}

	}

	/**
	 * Builds BVH from meshScene and uploads all scene data to the path tracer.
	 * @returns {boolean}
	 */
	async loadSceneData() {

		// Clear selection before rebuilding — the old object leaves the scene graph.
		// Skipped on the append path (addModel): the selected object persists, so its
		// selection + transform gizmo should survive the rebuild.
		if ( ! this._preserveSelectionOnRebuild ) this.interactionManager?.deselect();

		// Stop any running animation before rebuilding scene data
		this.animationManager.dispose();
		this._animRefitInFlight = false;

		// Tag the primary (replace-loaded) model so it appears in the scene-object list.
		this._tagPrimarySceneObject();

		const timer = new BuildTimer( '', { namespace: 'scene', level: 'info' } );
		const environmentTexture = this.meshScene.environment;

		// Environment CDF build in parallel with BVH
		let cdfPromise = null;
		if ( environmentTexture?.image?.data ) {

			timer.start( 'Environment CDF build (worker)' );
			this.stages.pathTracer.scene.environment = environmentTexture;
			cdfPromise = this.stages.pathTracer.environment.buildEnvironmentCDF()
				.then( () => timer.end( 'Environment CDF build (worker)' ) );

		}

		// Build BVH
		timer.start( 'BVH build (SceneProcessor)' );
		this._sdf.setMaxTextureSize( this._maxTextureSize );
		await this._sdf.buildBVH( this.meshScene );
		timer.end( 'BVH build (SceneProcessor)' );

		// Transfer geometry, materials, and textures to GPU
		updateLoading( { status: "Transferring data to GPU...", progress: 86 } );
		await new Promise( r => setTimeout( r, 0 ) );
		timer.start( 'GPU data transfer' );

		if ( ! this._sdf.uploadToPathTracer( this.stages.pathTracer, this.lightManager, this.meshScene, environmentTexture ) ) return false;

		// Patch per-mesh visibility into the TLAS leaves we just uploaded
		this.stages.pathTracer._meshRefs = this.stages.pathTracer._collectMeshRefs( this.meshScene );
		this.stages.pathTracer.setMeshVisibilityData( this.stages.pathTracer._meshRefs );

		// Drop authored-hidden meshes' triangles from the emissive-NEE structure
		// (runs before setupMaterial so the kernels compile against the final buffer)
		this._refreshEmissiveForVisibility();

		timer.end( 'GPU data transfer' );

		// Compile shaders
		updateLoading( { status: "Compiling shaders...", progress: 90 } );
		await new Promise( r => setTimeout( r, 0 ) );
		timer.start( 'Material setup (TSL compile)' );
		this.stages.pathTracer.setupMaterial();
		timer.end( 'Material setup (TSL compile)' );

		this._rasterPrecompile = null;

		if ( ! this._pathTracerEnabled ) {

			timer.start( 'Pipeline precompile' );
			await this.precompileRaster();
			timer.end( 'Pipeline precompile' );

		}

		// Wait for CDF
		if ( cdfPromise ) {

			updateLoading( { status: "Finalizing environment map...", progress: 95 } );
			await cdfPromise;
			this.stages.pathTracer.environment.applyCDFResults();

		}

		// Seed the ground-projection plane AND the shadow-catcher plane to the scene floor so models
		// that aren't authored at y=0 sit on the ground (not sunk) — auto-updates on every model change.
		const sceneMinY = this.getSceneMinY();
		this.settings.set( 'groundProjectionLevel', sceneMinY, { reset: false } );
		this.settings.set( 'groundCatcherHeight', sceneMinY, { reset: false } );

		// Auto-follow the scene: enable emissive-triangle NEE when the scene has emissive
		// geometry, disable it when it doesn't — unless the user set the toggle explicitly.
		// Runs before applyAll()/SceneRebuild so the uniform and UI both pick up the new value.
		if ( ! this._emissiveSamplingUserSet ) {

			// Keyed on the canonical (unfiltered) emissive set — emissiveTriangleCount
			// reflects only the visible subset, and hidden emitters can be shown later.
			const hasEmissive = ( this._sdf?.emissiveTriangleBuilder?.emissiveTriangles?.length
				?? this._sdf?.emissiveTriangleCount ?? 0 ) > 0;
			this.settings.set( 'enableEmissiveTriangleSampling', hasEmissive, { reset: false } );

		}

		// Apply all settings to stages in one shot
		timer.start( 'Apply settings' );
		this.settings.applyAll();
		this.stages.compositor.setTransparentBackground( this.settings.get( 'transparentBackground' ) );
		timer.end( 'Apply settings' );

		timer.print( this._sceneSummaryParts() );
		resetLoading();

		this._initAnimationAndTransforms();

		this.dispatchEvent( { type: 'SceneRebuild' } );
		return true;

	}

	/** Counts for the single `[scene]` summary line emitted after a scene build. */
	_sceneSummaryParts() {

		const pt = this.stages.pathTracer;
		const meshes = this._sdf?.instanceTable?.entries?.filter( Boolean ).length ?? 0;
		const maps = this._sdf?.geometryExtractor?.maps?.length ?? 0;

		return [
			fmt.count( pt.triangleCount, 'tri' ),
			meshes ? fmt.count( meshes, 'mesh', 'meshes' ) : null,
			fmt.count( pt.materialData.materialCount, 'material' ),
			maps ? fmt.count( maps, 'map' ) : null,
			fmt.count( pt.bvhNodeCount, 'BVH node' ),
		];

	}

	// ═══════════════════════════════════════════════════════════════
	// Dynamic scene objects (add / remove / list / visibility)
	//
	// Top-level objects are the auto-created "Ground" plane plus each loaded
	// model root parented into meshScene. The scene graph + per-root userData
	// tags are the single source of truth (no separate registry): ids are
	// Object3D uuids (stable across rebuilds, since the same root persists).
	// ═══════════════════════════════════════════════════════════════

	/** Tag the primary (replace-loaded) model as a removable scene object (read by the Outliner + removeSceneObject). Idempotent. */
	_tagPrimarySceneObject() {

		const m = this.assetLoader?.targetModel;
		if ( ! m ) return;
		m.userData.__rayzeeSceneObject = true;
		m.userData.__rayzeeExternal = ( m === this.assetLoader._externalModel );

	}

	/** Remove + dispose all dynamically-appended models (keeps Ground and the primary). */
	_clearAppendedModels() {

		const scene = this.meshScene;
		if ( ! scene ) return;
		const floor = this.assetLoader?.floorPlane;
		const primary = this.assetLoader?.targetModel;
		for ( const child of [ ...scene.children ] ) {

			if ( child === floor || child === primary ) continue;
			if ( ! child.userData?.__rayzeeSceneObject ) continue;
			this.assetLoader.removeModelRoot( child, { external: !! child.userData.__rayzeeExternal } );

		}

	}

	/** Reframe-free rebuild sequence. Assumes the _loadingInProgress guard is already held. */
	async _finishRebuildNoReframe( eventPayload ) {

		await this.loadSceneData(); // emits 'SceneRebuild'
		this._recalibrateControlLimits(); // scene bounds changed — retune zoom limits + near/far (no camera move)
		this.pipeline?.eventBus.emit( 'autoexposure:resetHistory' );
		this.reset();
		if ( eventPayload ) this.dispatchEvent( eventPayload );

	}

	/**
	 * Append a model by URL to the current scene (does NOT replace it), then rebuild
	 * without reframing the camera.
	 * @param {string} url
	 * @param {Object} [opts]
	 * @param {string} [opts.name] - Display name for the scene-object list.
	 * @returns {Promise<string>} the new object's id (Object3D uuid).
	 */
	async addModel( url, { name } = {} ) {

		if ( this._loadingInProgress ) {

			throw new Error( 'PathTracerApp.addModel: another load is already in progress' );

		}

		this._loadingInProgress = true;
		this._preserveSelectionOnRebuild = true;
		try {

			const { root } = await this.assetLoader.appendModel( url );
			root.userData.__rayzeeSceneObject = true;
			root.userData.__rayzeeExternal = false;
			if ( name ) root.userData.__rayzeeName = name;
			await this._finishRebuildNoReframe( { type: 'ModelAdded', url, id: root.uuid } );
			return root.uuid;

		} finally {

			this._preserveSelectionOnRebuild = false;
			this._loadingInProgress = false;

		}

	}

	/**
	 * Append a caller-owned Object3D to the current scene, then rebuild (no reframe).
	 * The caller retains ownership — removal only detaches it.
	 * @param {import('three').Object3D} object3d
	 * @param {Object} [opts]
	 * @param {string} [opts.name]
	 * @returns {Promise<string>} the new object's id (Object3D uuid).
	 */
	async addModelFromObject3D( object3d, { name } = {} ) {

		if ( this._loadingInProgress ) {

			throw new Error( 'PathTracerApp.addModelFromObject3D: another load is already in progress' );

		}

		this._loadingInProgress = true;
		this._preserveSelectionOnRebuild = true;
		try {

			const { root } = this.assetLoader.appendObject3D( object3d, name || 'object3d' );
			root.userData.__rayzeeSceneObject = true;
			root.userData.__rayzeeExternal = true;
			if ( name ) root.userData.__rayzeeName = name;
			await this._finishRebuildNoReframe( { type: 'ModelAdded', id: root.uuid } );
			return root.uuid;

		} finally {

			this._preserveSelectionOnRebuild = false;
			this._loadingInProgress = false;

		}

	}

	/**
	 * Remove a scene object by id (Object3D uuid). The Ground plane is permanent.
	 * @param {string} id
	 * @returns {Promise<boolean>} true if removed.
	 */
	async removeSceneObject( id ) {

		const scene = this.meshScene;
		if ( ! scene ) return false;

		const floor = this.assetLoader?.floorPlane;
		if ( floor && floor.uuid === id ) return false; // Ground is not deletable

		const root = scene.children.find( c => c.uuid === id && c.userData?.__rayzeeSceneObject );
		if ( ! root ) return false;

		if ( this._loadingInProgress ) {

			throw new Error( 'PathTracerApp.removeSceneObject: another load is already in progress' );

		}

		this._loadingInProgress = true;
		try {

			this.interactionManager?.deselect();
			this.transformManager?.detach?.();

			if ( root === this.assetLoader.targetModel ) {

				this.assetLoader.releaseTargetModel();

			} else {

				this.assetLoader.removeModelRoot( root, { external: !! root.userData.__rayzeeExternal } );

			}

			// Ground is permanent (removal refused above), so the scene always keeps
			// renderable geometry — a full rebuild is always valid here.
			await this._finishRebuildNoReframe( { type: 'SceneObjectRemoved', id } );

			return true;

		} finally {

			this._loadingInProgress = false;

		}

	}

	/**
	 * Toggle a scene object's visibility without rebuilding (O(1) TLAS-leaf patch).
	 * @param {string} id - Object3D uuid.
	 * @param {boolean | ((prev:boolean)=>boolean)} visible
	 * @returns {boolean|null} new visibility, or null if not found.
	 */
	setSceneObjectVisibility( id, visible ) {

		return this.setMeshVisibilityByUuid( id, visible );

	}

	// ═══════════════════════════════════════════════════════════════
	// Dynamic cameras (add / remove)
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

	/** Notify consumers that the camera list changed (names / count). */
	_dispatchCamerasUpdated() {

		this.dispatchEvent( {
			type: 'CamerasUpdated',
			cameras: this.cameraManager.cameras,
			cameraNames: this.cameraManager.getCameraNames(),
		} );

	}

	// ═══════════════════════════════════════════════════════════════
	// BVH Refit (Animation)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * The meshes backing the current acceleration structure, in the order their triangles
	 * occupy the shared buffers — which is what "original mesh order" means in
	 * {@link refitBVH} and {@link refitBLASes}, and what `meshIndex` indexes.
	 *
	 * Walking your own model instead is not equivalent: the list is a depth-first pre-order
	 * traversal of the whole mesh scene, so it also contains engine-owned meshes (the hidden
	 * ground-projection disk) and any mesh a multi-material split produced. A positions
	 * buffer built from a different set is silently misaligned.
	 *
	 * @returns {import('three').Mesh[]} Live reference — do not mutate.
	 */
	get sceneMeshes() {

		return this._sdf?.meshes ?? [];

	}

	/**
	 * Update vertex positions for animation without full BVH rebuild.
	 * O(N) bottom-up AABB refit instead of O(N log N) SAH rebuild.
	 *
	 * Topology must stay the same (same triangle count and connectivity).
	 * Call this per-frame for skeletal/morph-target animation.
	 *
	 * @param {Float32Array} newPositions - 9 floats per triangle (ax,ay,az, bx,by,bz, cx,cy,cz) for every triangle in the scene, meshes in {@link sceneMeshes} order and triangles in index order
	 * @param {Float32Array} [newNormals] - Optional 9 floats per triangle smooth normals. If omitted, face normals are computed from positions.
	 * @returns {Promise<{ refitTimeMs: number }>}
	 */
	async refitBVH( newPositions, newNormals ) {

		const result = await this._sdf.refitBVH( newPositions, newNormals );

		this.stages.pathTracer.updateTriangleData( this._sdf.triangleData );
		this.stages.pathTracer.updateBVHData( this._sdf.bvhData );
		this.reset();

		return result;

	}

	/**
	 * Refit specific mesh BLASes and rebuild TLAS after object transform.
	 * Faster than refitBVH for single-object transforms in multi-mesh scenes.
	 *
	 * @param {number[]} affectedMeshIndices - Mesh indices to refit
	 * @param {Float32Array} newPositions - 9 floats per triangle in original mesh order
	 * @param {Float32Array} [newNormals] - Optional smooth normals
	 * @returns {{ refitTimeMs: number }}
	 */
	refitBLASes( affectedMeshIndices, newPositions, newNormals ) {

		const result = this._sdf.refitBLASes( affectedMeshIndices, newPositions, newNormals );

		const { triRanges, bvhRanges } = this._sdf.computeBLASDirtyRanges( affectedMeshIndices );
		this.stages.pathTracer.updateBufferRanges( triRanges, bvhRanges );
		this.reset();

		// Kick off background rebuild for optimal SAH quality
		this._sdf.scheduleBackgroundRebuild( affectedMeshIndices, () => {

			// Swap complete — upload updated buffers and restart accumulation
			this.stages.pathTracer.updateTriangleData( this._sdf.triangleData );
			this.stages.pathTracer.updateBVHData( this._sdf.bvhData );
			this.reset();

		} );

		return result;

	}

	// ═══════════════════════════════════════════════════════════════
	// Resize
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Raise (or lower) the reserved render size — the square dimension every compute StorageTexture + aux
	 * buffer is pre-allocated at. Needed to enable resolutions above the 2048 default (e.g. 4K). The request
	 * is device-capped: 4K reservation (~1.5 GB of MRT textures) is only granted on GPUs with ample VRAM +
	 * a large storage-buffer binding limit; weaker devices clamp to 2048.
	 *
	 * Callable at any point in the lifecycle:
	 *  - before init(): recorded, then applied during init() before the stages are constructed, so they
	 *    pre-allocate at the raised size directly. The device gate cannot run until the device exists, so
	 *    the value returned here is the request, not the verdict — read getReservedRenderResolution() after
	 *    init(), or listen for `reserved_render_size_changed`.
	 *  - after init(): applied immediately, re-initialising the reserved GPU storage in place.
	 * @param {number}  requestedPx desired reserved size (longest edge)
	 * @param {Object}  [opts]
	 * @param {boolean} [opts.allowLower=false] permit lowering, paying a rebuild, to reclaim VRAM
	 * @returns {number} the applied reserved size (the pending request when called before init)
	 */
	setReservedRenderResolution( requestedPx, { allowLower = false } = {} ) {

		const prev = MAX_STORAGE_TEXTURE_SIZE;

		// Monotonic up: UI-driven callers request whatever the current view needs, so honouring decreases made
		// the reserve oscillate on every preview↔render switch and paid a full kernel rebuild each time.
		const target = allowLower ? requestedPx : Math.max( requestedPx, prev );

		// No device yet: the gate below has nothing to interrogate and would clamp a 4K-capable GPU to 2048.
		// init() replays the request once the device exists, still before the stages allocate.
		if ( ! this.renderer ) {

			this._pendingReservedRenderSize = { requestedPx, allowLower };
			return Math.max( 256, Math.min( MAX_RESERVABLE_RENDER_SIZE, Math.floor( target ) || 256 ) );

		}

		const limits = this.renderer.backend?.device?.limits;
		const maxBinding = limits?.maxStorageBufferBindingSize || ( 128 * 1024 * 1024 );
		const deviceMemGB = ( typeof navigator !== 'undefined' && navigator.deviceMemory ) || 4;
		// 4K reserve pins the accum MRT (~1.5 GB) + aux; only grant it on clearly-capable GPUs.
		const deviceSafeMax = ( deviceMemGB >= 8 && maxBinding >= 1024 * 1024 * 1024 )
			? MAX_RESERVABLE_RENDER_SIZE : 2048;
		const applied = setReservedRenderSize( Math.min( target, deviceSafeMax ) );

		// Gate the realloc on the textures that EXIST, not on how the binding moved: a raise applied while
		// nothing was allocated leaves `applied === prev` for every later call, so keying off that let the
		// first ineffective call poison every effective one after it (issue #9). The path tracer's write MRT
		// witnesses the reserve the stages were last built at.
		const allocated = this.stages?.pathTracer?.storageTextures?.writeColor?.image?.width ?? applied;

		// Re-init the reserved GPU storage in place: each stage recreates its pre-allocated StorageTextures at
		// the new size + rebuilds its compute pipelines. Stage OBJECTS, manager refs and event wiring are
		// preserved (so no re-subscription needed); scene geometry buffers are resolution-independent and
		// reused. Rendering is paused across the swap so no in-flight dispatch references a disposed texture.
		if ( allocated !== applied ) {

			const wasPaused = this.pauseRendering;
			this.pauseRendering = true;
			try {

				// Lowering below the live backing store makes copyToReadTargets read past the end of the
				// (now smaller) write textures — a GPUValidationError. Shrink the backing store first.
				// renderer.setSize, not setCanvasSize/onResize: those also rewrite camera.aspect.
				const backing = this.renderer.domElement;
				if ( backing.width > applied || backing.height > applied ) {

					this.renderer.setSize(
						Math.min( backing.width, applied ), Math.min( backing.height, applied ), false );

				}

				for ( const stage of Object.values( this.stages ) ) stage?.reallocateReservedStorage?.();

			} finally {

				this.pauseRendering = wasPaused;

			}

			this.reset();
			this.dispatchEvent( { type: 'reserved_render_size_changed', size: applied } );

		}

		return applied;

	}

	/**
	 * Replay a setReservedRenderResolution() call made before init(): after the device exists, so the gate is
	 * evaluated against the real GPU, and before _initPipeline() constructs the stages, which read the reserve
	 * in their constructors. The event carries the device's verdict — the only authoritative answer a pre-init
	 * caller can get.
	 */
	_applyPendingReservedRenderSize() {

		const pending = this._pendingReservedRenderSize;
		if ( ! pending ) return;

		this._pendingReservedRenderSize = null;

		const applied = this.setReservedRenderResolution( pending.requestedPx, { allowLower: pending.allowLower } );

		if ( applied < pending.requestedPx ) {

			log.warn( `reserved render size ${fmt.n( pending.requestedPx )}px was capped to ${fmt.n( applied )}px by this device's limits — renders above ${fmt.n( applied )}px will be declined.` );

		}

		this.dispatchEvent( { type: 'reserved_render_size_changed', size: applied } );

	}

	/**
	 * The current reserved (pre-allocated) square render size in px.
	 * @returns {number}
	 */
	getReservedRenderResolution() {

		return MAX_STORAGE_TEXTURE_SIZE;

	}

	/**
	 * Guard against render resolutions the compute pipeline can't support.
	 * Per-resolution StorageTextures are pre-allocated at MAX_STORAGE_TEXTURE_SIZE
	 * and never resized, so a larger request would overflow them. Warn and skip.
	 * @returns {boolean} true if the size is renderable
	 */
	_isRenderSizeSupported( width, height ) {

		if ( width > MAX_STORAGE_TEXTURE_SIZE || height > MAX_STORAGE_TEXTURE_SIZE ) {

			log.warn( `render resolution ${width}×${height} exceeds the ${MAX_STORAGE_TEXTURE_SIZE}px reserve (compute storage textures are pre-allocated at ${MAX_STORAGE_TEXTURE_SIZE}px). Ignoring resize — raise the reserve with setReservedRenderResolution( ${Math.max( width, height )} ) first, or use a resolution ≤ ${MAX_STORAGE_TEXTURE_SIZE}.` );
			return false;

		}

		return true;

	}

	onResize() {

		const width = this.canvas.clientWidth;
		const height = this.canvas.clientHeight;
		if ( width === 0 || height === 0 ) return;
		if ( ! this._isRenderSizeSupported( width, height ) ) return;

		this.renderer.setPixelRatio( 1.0 );
		this.renderer.setSize( width, height, false );
		this.cameraManager.camera.aspect = width / height;
		this.cameraManager.camera.updateProjectionMatrix();

		const lastW = this.denoisingManager?._lastRenderWidth ?? 0;
		const lastH = this.denoisingManager?._lastRenderHeight ?? 0;
		if ( width === lastW && height === lastH ) return;

		clearTimeout( this._resizeDebounceTimer );
		this._resizeDebounceTimer = setTimeout( () => {

			this._applyRenderResize( width, height );

		}, 300 );

	}

	_applyRenderResize( renderWidth, renderHeight ) {

		if ( ! this._isRenderSizeSupported( renderWidth, renderHeight ) ) return;

		this.pipeline?.setSize( renderWidth, renderHeight );
		this.denoisingManager?.setRenderSize( renderWidth, renderHeight );
		this.needsReset = true;

		this.dispatchEvent( { type: 'resolution_changed', width: renderWidth, height: renderHeight } );

	}

	/**
	 * Set the render resolution in pixels, applied immediately (unlike the debounced onResize()).
	 * @param {number} width
	 * @param {number} height
	 * @returns {{width: number, height: number}|null} the size now in effect, or null if the request was
	 *   declined — zero, or above the reserved render size (raise it with setReservedRenderResolution).
	 *   A declined request leaves the previous size in place, so ignoring this return renders at the
	 *   wrong resolution with nothing but a warning to show for it.
	 */
	setCanvasSize( width, height ) {

		if ( width === 0 || height === 0 ) return null;
		if ( ! this._isRenderSizeSupported( width, height ) ) return null;

		this.renderer.setPixelRatio( 1.0 );
		this.renderer.setSize( width, height, false );
		this.cameraManager.camera.aspect = width / height;
		this.cameraManager.camera.updateProjectionMatrix();

		clearTimeout( this._resizeDebounceTimer );
		this._applyRenderResize( width, height );

		return { width, height };

	}

	// ═══════════════════════════════════════════════════════════════
	// Mode Configuration
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Configures the engine for a specific rendering quality tier.
	 * @param {'interactive' | 'production'} mode
	 * @param {Object} [options]
	 */
	configureForMode( mode, options = {} ) {

		const isProduction = mode === 'production';
		const config = isProduction ? PRODUCTION_RENDER_CONFIG : INTERACTIVE_RENDER_CONFIG;

		this.cameraManager.controls.enabled = ! isProduction;

		// Anything with a SETTING_ROUTES entry must go through settings, not setUniform: set() early-returns on
		// `prev === value`, so a uniform written behind the map leaves it stale and the next set() silently no-ops.
		this.settings.setMany( {
			maxSamples: config.maxSamples,
			maxBounces: config.bounces,
			transmissiveBounces: config.transmissiveBounces,
			maxSubsurfaceSteps: config.maxSubsurfaceSteps,
			enableAlphaShadows: config.enableAlphaShadows ?? false,
			// Tier-1 convergence early-stop
			useAdaptiveSampling: config.useAdaptiveSampling ?? false,
			noiseThreshold: config.noiseThreshold ?? DEFAULT_STATE.noiseThreshold,
			adaptiveStopFraction: config.adaptiveStopFraction ?? DEFAULT_STATE.adaptiveStopFraction,
			adaptiveMinSamples: config.adaptiveMinSamples ?? DEFAULT_STATE.adaptiveMinSamples,
			// Tier-2 per-pixel freeze
			usePixelFreeze: config.usePixelFreeze ?? false,
			pixelFreezeThreshold: config.pixelFreezeThreshold ?? DEFAULT_STATE.pixelFreezeThreshold,
			pixelFreezeStability: config.pixelFreezeStability ?? DEFAULT_STATE.pixelFreezeStability,
		}, { silent: true } );

		// renderMode has no SETTING_ROUTES entry
		this.stages.pathTracer?.setUniform( 'renderMode', parseInt( config.renderMode ) );

		this.stages.pathTracer?.updateCompletionThreshold?.();

		const denoiser = this.denoisingManager?.denoiser;
		if ( denoiser ) {

			denoiser.abort();
			denoiser.enabled = config.enableOIDN;
			denoiser.updateQuality( config.oidnQuality );

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

	refreshFrame() {

		this._needsDisplayRefresh = true;
		this.wake();

	}

	// Aborts any in-flight denoise/upscale and puts the denoiser canvas back at base resolution (the
	// upscaler leaves it enlarged), so the live canvas is what's on screen again.
	_abortPostProcess() {

		this.denoisingManager?.abort( this.canvas );

		if ( this.denoisingManager?.restoreBaseResolution() ) {

			const w = this.denoisingManager._lastRenderWidth;
			const h = this.denoisingManager._lastRenderHeight;
			this.dispatchEvent( { type: 'resolution_changed', width: w, height: h } );

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

	// ═══════════════════════════════════════════════════════════════
	// Deterministic / headless control
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Pins every wall-clock- and readback-dependent input so that N samples from a
	 * fresh `reset()` reproduce bit-for-bit.
	 *
	 * The image is always a pure function of (pixel, frame, uniforms) — no shader reads
	 * a clock and there is no `Math.random()` in the render path. What varies run to run
	 * is *which* uniforms and dispatch grids are live on frame k:
	 *
	 * - `useAdaptiveSampling` retires the whole frame off an async CONVERGED_COUNT
	 *   readback, so two runs accumulate different sample totals for one `maxSamples`.
	 * - `usePixelFreeze` sizes the bounce-0 grid from a stale active-pixel readback.
	 * - `_bounceEarlyExitThreshold` / `_useDynamicDispatch` both consume the async
	 *   survivor curve. Kernels bind on ENTERING_COUNT, so an under-sized grid silently
	 *   drops rays, and the frame a readback lands on is GPU-scheduled.
	 * - `interactionModeEnabled` is a 100 ms timer that clamps bounces to 1, disables
	 *   accumulation and freezes frameCount; it engages on the very first frame.
	 * - auto-focus raycasts per frame and auto-exposure adapts off `performance.now()`.
	 *
	 * Leaves the rAF loop stopped — drive rendering with {@link PathTracerApp#renderFrames}.
	 * Idempotent; pass `false` to restore the previous configuration.
	 *
	 * `pinDispatch: false` keeps the two readback-driven dispatch heuristics
	 * (`_useDynamicDispatch` and the per-bounce early exit) ACTIVE while still pinning the
	 * render loop, sample count and timers. Output is then no longer bit-reproducible, so
	 * this is only for performance measurement — it exists because those heuristics are
	 * real shipping behaviour, and benchmarking with them disabled measures a configuration
	 * production never runs.
	 *
	 * @param {boolean} [enabled=true]
	 * @param {Object} [options]
	 * @param {boolean} [options.pinDispatch=true] - false to keep production dispatch heuristics
	 * @returns {boolean} whether deterministic mode is now active
	 */
	setDeterministicMode( enabled = true, { pinDispatch = true } = {} ) {

		const stage = this.stages.pathTracer;
		if ( ! stage ) return false;

		if ( enabled ) {

			if ( ! this._deterministicRestore ) {

				this._deterministicRestore = {
					settings: {
						useAdaptiveSampling: this.settings.get( 'useAdaptiveSampling' ),
						usePixelFreeze: this.settings.get( 'usePixelFreeze' ),
						interactionModeEnabled: this.settings.get( 'interactionModeEnabled' ),
						renderLimitMode: this.settings.get( 'renderLimitMode' ),
						renderTimeLimit: this.settings.get( 'renderTimeLimit' ),
					},
					bounceEarlyExit: stage._bounceEarlyExitThreshold,
					dynamicDispatch: stage._useDynamicDispatch,
					autoFocusMode: this.cameraManager?.autoFocusMode,
					autoExposure: this.stages.autoExposure?.enabled,
				};

			}

			// Cleared together on purpose: the freeze streak is stamped inside the
			// convergence block, so freeze-on/adaptive-off would run the freeze path
			// against a streak buffer nothing writes or clears.
			this.settings.setMany( {
				useAdaptiveSampling: false,
				usePixelFreeze: false,
				interactionModeEnabled: false,
				renderLimitMode: 'frames',
				renderTimeLimit: 0,
			}, { silent: true } );

			if ( pinDispatch ) {

				// -1 is unreachable by a uint survivor count, and both _buildWavefrontKernels()
				// and _resizeWavefrontInPlace() preserve the sentinel across rebuilds.
				stage._bounceEarlyExitThreshold = - 1;
				stage._useDynamicDispatch = false;

			} else {

				// Restore the values captured on first enable, so a perf pass measures the
				// same dispatch behaviour a real render uses.
				stage._bounceEarlyExitThreshold = this._deterministicRestore.bounceEarlyExit;
				stage._useDynamicDispatch = this._deterministicRestore.dynamicDispatch;

			}

			this.cameraManager?.setAutoFocusMode( 'manual' );
			if ( this.stages.autoExposure ) this.stages.autoExposure.enabled = false;

			// The seed axis free-runs across accumulation resets so a camera drag gets fresh
			// sequences; offline rendering needs the opposite. Pinning it makes seedFrame track
			// frameCount, so N samples reproduce bit-for-bit. reset() below zeroes the tick.
			stage._pinSeedToFrame = true;

			this._deterministic = true;
			this._dispatchPinned = pinDispatch;

		} else if ( this._deterministicRestore ) {

			const prev = this._deterministicRestore;

			this.settings.setMany( prev.settings, { silent: true } );
			stage._bounceEarlyExitThreshold = prev.bounceEarlyExit;
			stage._useDynamicDispatch = prev.dynamicDispatch;

			if ( prev.autoFocusMode !== undefined ) this.cameraManager?.setAutoFocusMode( prev.autoFocusMode );
			if ( this.stages.autoExposure && prev.autoExposure !== undefined ) {

				this.stages.autoExposure.enabled = prev.autoExposure;

			}

			stage._pinSeedToFrame = false;

			this._deterministicRestore = null;
			this._deterministic = false;
			this._dispatchPinned = false;

		}

		this.reset();
		this.stopAnimation(); // reset() calls wake(); a manual render loop must not race rAF

		return this._deterministic;

	}

	/**
	 * Whether output is currently bit-reproducible. False when the dispatch heuristics
	 * were left active via `pinDispatch: false`, since those consume async readbacks.
	 */
	get isDeterministic() {

		return this._deterministic && this._dispatchPinned;

	}

	/**
	 * Accumulates exactly `count` samples synchronously, bypassing the rAF loop.
	 *
	 * Awaits the STBN atlases first — until they land the sampler reads a constant-0.5
	 * placeholder that gets baked permanently into the accumulation buffer.
	 *
	 * @param {number} count - samples to accumulate
	 * @param {Object} [options]
	 * @param {boolean} [options.reset=true] - restart accumulation from sample 0 first
	 * @param {number} [options.yieldEvery=8] - yield to the event loop every N passes (0 disables)
	 * @param {function(number): void} [options.onProgress] - called with the running sample count
	 * @returns {Promise<number>} the final accumulated sample count
	 */
	async renderFrames( count, { reset = true, yieldEvery = 8, onProgress } = {} ) {

		const stage = this.stages.pathTracer;
		if ( ! stage ) throw new Error( 'renderFrames: app is not initialized' );
		if ( ! ( count > 0 ) ) throw new Error( `renderFrames: count must be positive, got ${count}` );

		await stage.blueNoiseReady;

		const target = ( reset ? 0 : stage.frameCount ) + count;

		// completionThreshold is a cached JS number derived from maxSamples, so this must
		// go through the settings handler — writing the uniform alone would not move it.
		if ( this.settings.get( 'maxSamples' ) < target ) {

			this.settings.set( 'maxSamples', target, { silent: true, reset: false } );

		}

		if ( reset ) this.reset();
		this.stopAnimation();

		const maxPasses = count + 64;
		let passes = 0;

		while ( stage.frameCount < target && passes < maxPasses ) {

			if ( this._deviceLost ) throw new Error( 'renderFrames: WebGPU device lost' );
			if ( ! stage.isReady ) throw new Error( 'renderFrames: path tracer stage is not ready' );

			this.pipeline.render();
			passes ++;

			onProgress?.( stage.frameCount );

			if ( yieldEvery > 0 && passes % yieldEvery === 0 ) {

				await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

			}

		}

		if ( stage.frameCount < target ) {

			throw new Error(
				`renderFrames: stalled at ${stage.frameCount}/${target} samples after ${passes} passes — ` +
				'something retired the render (maxSamples, a stray reset, or a canvas resize)'
			);

		}

		return stage.frameCount;

	}

	/**
	 * Enables WebGPU timestamp queries so {@link PathTracerApp#getGPUTimings} reports real
	 * GPU time. Off by default because the queries themselves cost time. No-ops when the
	 * device lacks the `timestamp-query` feature.
	 *
	 * @param {boolean} [enabled=true]
	 * @returns {boolean} whether timestamp tracking is now active
	 */
	enableGPUTiming( enabled = true ) {

		const backend = this.renderer?.backend;
		if ( ! backend ) return false;
		if ( enabled && backend.hasFeature?.( 'timestamp-query' ) !== true ) return false;

		backend.trackTimestamp = enabled;
		return backend.trackTimestamp === enabled;

	}

	/**
	 * Real GPU milliseconds for the last resolved frame, from WebGPU timestamp queries.
	 * Returns null unless {@link PathTracerApp#enableGPUTiming} was called.
	 *
	 * This is the only true GPU metric available: `pipeline.getStats()` times
	 * `performance.now()` around each stage's render(), which is command *encoding*
	 * time and stays flat while GPU cost doubles.
	 *
	 * @returns {Promise<{ compute: number, render: number, total: number }|null>}
	 */
	async getGPUTimings() {

		const renderer = this.renderer;
		if ( ! renderer?.backend?.trackTimestamp ) return null;

		await renderer.resolveTimestampsAsync( 'compute' );
		await renderer.resolveTimestampsAsync( 'render' );

		const compute = renderer.info.compute.timestamp || 0;
		const render = renderer.info.render.timestamp || 0;

		return { compute, render, total: compute + render };

	}

	/**
	 * Per-kernel GPU milliseconds for the last resolved frame.
	 *
	 * {@link PathTracerApp#getGPUTimings} only reports the frame aggregate, which buries a change to
	 * one kernel under everything else. The backend's timestamp query pool already retains one
	 * duration per compute pass, keyed `c:<frameCalls>:<nodeId>:f<frame>` (three.js
	 * `WebGPUTimestampQueryPool.resolveQueriesAsync` → `timestamps`); this attributes those back to
	 * kernel names through `KernelManager`'s registry.
	 *
	 * Durations are SUMMED per kernel across the frame, so `extend` reports its whole per-frame cost
	 * over every bounce iteration rather than one bounce. `unattributed` collects passes belonging to
	 * no registered kernel (other stages, denoisers) so `sum(kernels) + unattributed` reconciles with
	 * `total` — a gap there means a pass was missed, not that a kernel is free.
	 *
	 * The pool's map accumulates across frames and is never pruned, hence the newest-frame filter.
	 *
	 * Requires {@link PathTracerApp#enableGPUTiming}. Returns null when timestamps are unavailable.
	 *
	 * @returns {Promise<{kernels: Object<string, number>, total: number, unattributed: number, frame: number}|null>}
	 */
	async getKernelGPUTimings() {

		const renderer = this.renderer;
		if ( ! renderer?.backend?.trackTimestamp ) return null;

		await renderer.resolveTimestampsAsync( 'compute' );

		const timestamps = renderer.backend.timestampQueryPool?.compute?.timestamps;
		if ( ! timestamps || timestamps.size === 0 ) return null;

		const nameByNodeId = new Map();
		const kernelMap = this.stages?.pathTracer?._kernelManager?.kernels;
		if ( kernelMap ) {

			for ( const [ name, node ] of kernelMap ) nameByNodeId.set( node.id, name );

		}

		const parsed = [];
		let frame = - 1;

		for ( const [ uid, ms ] of timestamps ) {

			// 'c:<frameCalls>:<nodeId>:f<frame>'
			const parts = uid.split( ':' );
			if ( parts.length !== 4 ) continue;

			const f = Number( parts[ 3 ].slice( 1 ) );
			if ( ! Number.isFinite( f ) ) continue;

			parsed.push( { nodeId: Number( parts[ 2 ] ), f, ms } );
			if ( f > frame ) frame = f;

		}

		const kernels = {};
		let total = 0;
		let unattributed = 0;

		for ( const entry of parsed ) {

			if ( entry.f !== frame ) continue;

			total += entry.ms;
			const name = nameByNodeId.get( entry.nodeId );
			if ( name === undefined ) unattributed += entry.ms;
			else kernels[ name ] = ( kernels[ name ] ?? 0 ) + entry.ms;

		}

		return { kernels, total, unattributed, frame };

	}

	// ═══════════════════════════════════════════════════════════════
	// Output (absorbed from OutputAPI)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Returns the canvas element with the final rendered image.
	 * Chooses the post-processing canvas when denoiser/upscaler are active.
	 * @returns {HTMLCanvasElement|null}
	 */
	getCanvas() {

		if ( ! this.renderer?.domElement ) return null;

		const dm = this.denoisingManager;
		const usePostProcess = ( dm?.denoiser?.enabled || dm?.upscaler?.enabled )
			&& dm?.denoiserCanvas
			&& this.stages.pathTracer?.isComplete;

		if ( usePostProcess ) return dm.denoiserCanvas;

		// Re-render compositor stage so the WebGPU canvas has valid content
		if ( this.stages.compositor && this.pipeline?.context ) {

			this.stages.compositor.render( this.pipeline.context );

		}

		return this.renderer.domElement;

	}

	/**
	 * Captures the current render as a Blob. Returns null if no canvas is
	 * available. The host is responsible for downloading or otherwise
	 * consuming the result.
	 *
	 * @param {Object}  [options]
	 * @param {string}  [options.type='image/png']  - MIME type for the encoded image
	 * @param {number}  [options.quality]           - 0–1 quality hint for lossy formats
	 * @returns {Promise<Blob|null>}
	 */
	screenshot( { type = 'image/png', quality } = {} ) {

		const canvas = this.getCanvas();
		if ( ! canvas ) return Promise.resolve( null );

		return new Promise( ( resolve ) => canvas.toBlob( resolve, type, quality ) );

	}

	/**
	 * Returns scene statistics (triangle count, mesh count, etc.).
	 * @returns {Object|null}
	 */
	getStatistics() {

		try {

			return this._sdf?.getStatistics?.() ?? null;

		} catch {

			return null;

		}

	}

	/**
	 * When false, `animate()` rasters `meshScene` instead of path tracing. Those raster pipelines
	 * are compiled on the switch rather than at load — `compileAsync` costs seconds on a
	 * many-material model, and path tracing, the default, never uses them.
	 * @returns {boolean}
	 */
	get pathTracerEnabled() {

		return this._pathTracerEnabled;

	}

	set pathTracerEnabled( value ) {

		this._pathTracerEnabled = value;
		if ( ! value ) this.precompileRaster();

	}

	/**
	 * Warms the raster fallback's pipelines. Once per loaded model; concurrent callers await the
	 * same compile rather than racing past a flag set before it finishes.
	 * @returns {Promise<void>}
	 */
	precompileRaster() {

		if ( ! this.renderer || ! this.meshScene ) return Promise.resolve();

		this._rasterPrecompile ??= this.renderer
			.compileAsync( this.meshScene, this.cameraManager.camera )
			.catch( err => log.warn( 'raster fallback precompile failed', err ) );

		return this._rasterPrecompile;

	}

	/**
	 * Whether a model/environment load is currently in progress.
	 * @returns {boolean}
	 */
	get isLoading() {

		return this._loadingInProgress;

	}

	/**
	 * Whether the path tracer has finished converging.
	 * @returns {boolean}
	 */
	isComplete() {

		return this.stages.pathTracer?.isComplete ?? false;

	}

	/**
	 * Returns the current accumulated frame/sample count.
	 * @returns {number}
	 */
	getFrameCount() {

		return this.stages.pathTracer?.frameCount || 0;

	}

	/**
	 * Adaptive-sampling telemetry: `{ converged, activePixels, totalPixels, frame }`.
	 * Counts come from an async readback taken on settled views only, so they lag a few frames
	 * and read zero while the camera moves.
	 * @returns {?Object}
	 */
	getConvergenceStats() {

		return this.stages.pathTracer?.getConvergenceStats?.() ?? null;

	}

	/** The path tracer's VRAM tracker, or null before stages are built. */
	get vram() {

		return this.stages.pathTracer?.vramTracker ?? null;

	}

	/**
	 * On-demand current/peak GPU memory snapshot.
	 * @returns {{ current: number, peak: number, byCategory: Object }} bytes
	 */
	getMemoryInfo() {

		return this.stages.pathTracer?.vramTracker?.measure() ?? { current: 0, peak: 0, byCategory: {} };

	}

	// Idempotent: registers the cross-stage texture provider and re-measures on
	// allocation events (scene/env load, resize) so peak is caught even while idle.
	_ensureVRAMWiring() {

		if ( this._vramWired ) return;
		const tracker = this.stages.pathTracer?.vramTracker;
		if ( ! tracker ) return; // stages not ready yet

		tracker.register( 'stages', () => this._collectStageTextures() );

		const remeasure = () => tracker.measure();
		this._addTrackedListener( this, 'SceneRebuild', remeasure );
		this._addTrackedListener( this, 'EnvironmentLoaded', remeasure );
		this._addTrackedListener( this, 'resolution_changed', remeasure );

		this._vramWired = true;

	}

	// Direct StorageTexture/RenderTarget properties of every non-pathTracer stage
	// (denoiser/G-buffer/filter targets). The pathTracer's own buffers/textures are
	// registered explicitly; measure() dedupes by identity so overlaps don't double-count.
	_collectStageTextures() {

		const out = [];
		const stages = this.stages || {};
		const pt = stages.pathTracer;

		for ( const key in stages ) {

			const stage = stages[ key ];
			if ( ! stage || stage === pt || typeof stage !== 'object' ) continue;

			for ( const prop in stage ) {

				const v = stage[ prop ];
				if ( v && ( v.isTexture || v.isRenderTarget ) ) out.push( v );

			}

		}

		return out;

	}

	// ═══════════════════════════════════════════════════════════════
	// Materials (absorbed from MaterialsAPI)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Updates a single material property and triggers emissive rebuild if needed.
	 * @param {number} materialIndex
	 * @param {string} property
	 * @param {*} value
	 */
	/**
	 * World-space minimum Y of the loaded scene (the floor). Used to seed the
	 * analytic ground-plane shadow catcher height. Returns 0 if no scene is loaded.
	 * @returns {number}
	 */
	getSceneMinY() {

		if ( ! this.meshScene ) return 0;
		const box = new Box3().setFromObject( this.meshScene );
		return Number.isFinite( box.min.y ) ? box.min.y : 0;

	}

	/**
	 * Read back the scalar material property the shader is actually using.
	 * @param {number} materialIndex
	 * @param {string} property
	 * @returns {number|undefined}
	 */
	getMaterialProperty( materialIndex, property ) {

		return this.stages.pathTracer?.materialData.getMaterialProperty( materialIndex, property );

	}

	setMaterialProperty( materialIndex, property, value ) {

		this.stages.pathTracer?.materialData.updateMaterialProperty( materialIndex, property, value );

		// Keep the emissive-NEE structure in sync unconditionally (not gated on the
		// sampling toggle) so edits made while NEE is off aren't lost on re-enable.
		const emissiveAffectingProps = [ 'emissive', 'emissiveIntensity' ];
		if ( emissiveAffectingProps.includes( property ) && this._sdf ) {

			this._uploadEmissivePayload( this._sdf.updateMaterialEmissive( materialIndex, property, value ) );

		}

		this.reset();

	}

	/**
	 * Upload a rebuilt emissive-NEE payload (sorted emissive data + Light BVH +
	 * bit-trail map) to the path tracer stage. No-op for a null payload.
	 * @param {object|null} payload
	 * @private
	 */
	_uploadEmissivePayload( payload ) {

		if ( ! payload || ! this.stages.pathTracer ) return;

		this.stages.pathTracer.setEmissiveTriangleData(
			payload.rawData, payload.emissiveCount, payload.totalPower, payload.bitTrailMap,
		);
		if ( payload.lightBVHNodeData ) {

			this.stages.pathTracer.setLightBVHData( payload.lightBVHNodeData, payload.lightBVHNodeCount );

		}

	}

	/**
	 * Re-derive the emissive-NEE sampled set from current per-mesh world-visibility
	 * (InstanceTable is the source of truth — patched by the stage's visibility API).
	 * Hidden meshes' triangles are dropped from the Light BVH so they stop casting
	 * NEE light; the shadow ray can't do it (a hidden mesh no longer self-occludes).
	 * @private
	 */
	_refreshEmissiveForVisibility() {

		const entries = this._sdf?.instanceTable?.entries;
		if ( ! entries ) return;

		const hidden = new Set();
		for ( const entry of entries ) {

			if ( entry && entry.visible === false ) hidden.add( entry.meshIndex );

		}

		this._uploadEmissivePayload( this._sdf.rebuildEmissiveForVisibility( hidden ) );

	}

	/**
	 * Explicitly enable/disable emissive-triangle next-event estimation. Marks the
	 * setting as user-controlled so scene rebuilds stop auto-following the scene's
	 * emissive content; the next fresh model load re-arms the auto-default.
	 * @param {boolean} enabled
	 */
	setEmissiveTriangleSampling( enabled ) {

		this._emissiveSamplingUserSet = true;
		this.settings.set( 'enableEmissiveTriangleSampling', enabled );

	}

	/**
	 * @returns {boolean} True if the current scene contains emissive geometry
	 * (regardless of per-mesh visibility).
	 */
	hasEmissiveGeometry() {

		return ( this._sdf?.emissiveTriangleBuilder?.emissiveTriangles?.length
			?? this._sdf?.emissiveTriangleCount ?? 0 ) > 0;

	}

	/**
	 * Update per-mesh visibility without rebuilding the scene.
	 * Walks the parent chain to resolve world-space visibility.
	 * @param {number} meshIndex
	 * @param {boolean} visible
	 */
	setMeshVisibility( meshIndex, visible ) {

		this.stages.pathTracer?.updateMeshVisibility( meshIndex, visible );
		this._refreshEmissiveForVisibility();
		this.reset();

	}

	/**
	 * Recompute world-visibility for all meshes.
	 * Call after changing visibility on groups or parent objects.
	 */
	updateAllMeshVisibility() {

		this.stages.pathTracer?.updateAllMeshVisibility();
		this._refreshEmissiveForVisibility();
		this.reset();

	}

	/**
	 * The active mesh-bearing scene. Prefer this over reading `scene`/`meshScene`
	 * directly — the engine may swap the underlying scene between rebuilds.
	 * @returns {import('three').Scene}
	 */
	getScene() {

		return this.meshScene || this.scene;

	}

	// Sets when `visible` is a boolean; toggles when it's an updater (prev) => next.
	/**
	 * @param {string} uuid
	 * @param {boolean | ((prev: boolean) => boolean)} visible
	 * @returns {boolean | null} new visibility, or null if the mesh wasn't found
	 */
	setMeshVisibilityByUuid( uuid, visible ) {

		const object = this.getScene()?.getObjectByProperty( 'uuid', uuid );
		if ( ! object ) return null;
		const next = typeof visible === 'function' ? !! visible( object.visible ) : !! visible;
		object.visible = next;
		this.updateAllMeshVisibility();
		return next;

	}

	/**
	 * Updates a material's texture transform (offset, repeat, rotation).
	 * @param {number} materialIndex
	 * @param {string} textureName
	 * @param {Object} transform
	 */
	setTextureTransform( materialIndex, textureName, transform ) {

		this.stages.pathTracer?.materialData.updateTextureTransform( materialIndex, textureName, transform );
		this.reset();

	}

	/**
	 * Full material rebuild (required after texture changes).
	 * @param {import('three').Scene} [scene]
	 */
	async rebuildMaterials( scene ) {

		await this.stages.pathTracer?.rebuildMaterials( scene || this.meshScene );
		this.reset();

	}

	// ═══════════════════════════════════════════════════════════════
	// Private — Initialization
	// ═══════════════════════════════════════════════════════════════

	async _initRenderer() {

		setStatusCallback( ( event ) => this.dispatchEvent( event ) );

		if ( ! navigator.gpu ) {

			throw new Error( 'WebGPU is not supported in this browser' );

		}

		const adapter = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );
		if ( ! adapter ) {

			throw new Error( 'Failed to get WebGPU adapter' );

		}

		const adapterLimits = adapter.limits;

		this.renderer = new WebGPURenderer( {
			canvas: this.canvas,
			alpha: true,
			powerPreference: 'high-performance',
			requiredLimits: {
				maxBufferSize: adapterLimits.maxBufferSize,
				maxStorageBufferBindingSize: adapterLimits.maxStorageBufferBindingSize,
				maxColorAttachmentBytesPerSample: 128,
				maxStorageBuffersPerShaderStage: Math.min( adapterLimits.maxStorageBuffersPerShaderStage, 10 ),
			}
		} );

		await this.renderer.init();

		// Detect GPU device loss (dGPU/iGPU switch, driver reset, TDR watchdog on heavy
		// compute). Without this the rAF loop keeps calling render() on a dead device,
		// spewing errors forever. reason 'destroyed' during dispose() is intentional teardown.
		const gpuDevice = this.renderer.backend?.device;
		if ( gpuDevice?.lost ) {

			gpuDevice.lost.then( ( info ) => {

				if ( this._disposed ) return;
				this._handleDeviceLost( info );

			} );
			gpuDevice.onuncapturederror = ( event ) => log.error( 'WebGPU uncaptured error:', event.error );

		}

		RectAreaLightNode.setLTC( RectAreaLightTexturesLib.init() );

		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = ACESFilmicToneMapping;
		this.renderer.toneMappingExposure = 1.0;
		this.renderer.setPixelRatio( 1.0 );

	}

	_initCameraManager() {

		this.cameraManager = new CameraManager( this.canvas );

	}

	_initScenes() {

		this.scene = new Scene();
		this.meshScene = new Scene();
		this._sceneHelpers = new SceneHelpers();

	}

	_initAssetPipeline() {

		this._sdf = new SceneProcessor();
		this.assetLoader = new AssetLoader( this.meshScene, this.cameraManager.camera, this.cameraManager.controls );
		this.assetLoader.setRenderer( this.renderer );
		this.assetLoader.createFloorPlane();

		this._addTrackedListener( this.cameraManager.controls, 'change', () => {

			this.needsReset = true;
			this.wake();

		} );

	}

	_initPipeline() {

		this._createStages();

		const { clientWidth: w, clientHeight: h } = this.canvas;
		this.pipeline = new RenderPipeline( this.renderer, w || 1, h || 1 );

		this.pipeline.addStage( this.stages.pathTracer );
		this.pipeline.addStage( this.stages.normalDepth );
		this.pipeline.addStage( this.stages.motionVector );
		this.pipeline.addStage( this.stages.asvgf );
		this.pipeline.addStage( this.stages.variance );
		this.pipeline.addStage( this.stages.bilateralFilter );
		this.pipeline.addStage( this.stages.edgeFilter );
		this.pipeline.addStage( this.stages.autoExposure );
		this.pipeline.addStage( this.stages.compositor );

		const initRenderW = this.canvas.clientWidth || 1;
		const initRenderH = this.canvas.clientHeight || 1;
		this.pipeline.setSize( initRenderW, initRenderH );

	}

	async _initManagers() {

		this.interactionManager = new InteractionManager( {
			scene: this.meshScene,
			camera: this.cameraManager.camera,
			canvas: this.canvas,
			assetLoader: this.assetLoader,
			pathTracer: null,
			floorPlane: this.assetLoader.floorPlane
		} );

		this.interactionManager.wireAppEvents( this );

		this.cameraManager.setInteractionManager( this.interactionManager );
		this.lightManager = new LightManager( this.scene, this._sceneHelpers, this.stages.pathTracer, {
			onReset: () => this.reset(),
		} );
		this.goboManager = new GoboManager( this.stages.pathTracer, {
			onReset: () => this.reset(),
		} );
		this.iesManager = new IESManager( this.stages.pathTracer, {
			onReset: () => this.reset(),
		} );
		this._setupDenoisingManager();
		await this._setupOverlayManager();

		this.transformManager = new TransformManager( {
			camera: this.cameraManager.camera,
			canvas: this.canvas,
			orbitControls: this.cameraManager.controls,
			app: this,
		} );

		// The gizmo is part of the scene overlay layer, so it draws on the same
		// view-resolution surface as the light helpers and the outline.
		this.overlayManager.register( 'transform', new TransformGizmoHelper( this.transformManager ) );

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
		this.denoisingManager.setSettings( this.settings );

		// Expose environment manager (lives on pathTracer stage)
		this.environmentManager = this.stages.pathTracer.environment;
		this.environmentManager.callbacks.onAutoExposureReset = () => this.pipeline.eventBus.emit( 'autoexposure:resetHistory' );

	}

	_wireEvents() {

		// Forward manager events → app events
		this._addTrackedListener( this.cameraManager, 'CameraSwitched', ( e ) => this.dispatchEvent( e ) );
		this._addTrackedListener( this.cameraManager, EngineEvents.AUTO_FOCUS_UPDATED, ( e ) => this.dispatchEvent( e ) );

		this._forwardEvents( this.denoisingManager, [
			EngineEvents.DENOISING_START, EngineEvents.DENOISING_END,
			EngineEvents.UPSCALING_START, EngineEvents.UPSCALING_PROGRESS, EngineEvents.UPSCALING_END,
			'resolution_changed',
		] );

		this._setupAutoExposureListener();

		// Animation lifecycle → wake + refit flag
		this.animationManager.wakeCallback = () => this.wake();
		this._forwardEvents( this.animationManager, [
			EngineEvents.ANIMATION_STARTED,
			EngineEvents.ANIMATION_PAUSED,
			EngineEvents.ANIMATION_STOPPED,
		] );
		this._addTrackedListener( this.animationManager, EngineEvents.ANIMATION_PAUSED, () => {

			this._animRefitInFlight = false;

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
			meshScene: this.meshScene,
			assetLoader: this.assetLoader,
			floorPlane: this.assetLoader.floorPlane,
			pathTracer: this.stages.pathTracer,
			settings: this.settings,
			softReset: () => this.reset( true ),
			hardReset: () => this.reset(),
		} );

		// Bind settings to pipeline stages
		this.settings.bind( {
			stages: this.stages,
			renderer: this.renderer,
			resetCallback: () => this.reset(),
			reconcileCompletion: () => this._reconcileCompletion(),
			denoisingManager: this.denoisingManager,
			cameraManager: this.cameraManager,
		} );

		this.renderer.toneMappingExposure = this.settings.get( 'exposure' ) ?? 1.0;

		// Resize handling
		this.onResize();
		this.resizeHandler = () => this.onResize();
		if ( this._autoResize ) {

			this._addTrackedListener( window, 'resize', this.resizeHandler );

		}

		// Asset load events
		this._onAssetLoaded = async ( event ) => {

			if ( this._loadingInProgress ) return;

			if ( event.model ) {

				// Drag-drop / file load is a replace: clear any appended models first.
				this._clearAppendedModels();
				await this.loadSceneData();

			} else if ( event.texture ) {

				const envTexture = this.meshScene.environment;
				if ( envTexture && this.stages.pathTracer ) {

					await this.stages.pathTracer.environment.setEnvironmentMap( envTexture );

				}

				resetLoading();

			}

			this.pauseRendering = false;
			this.reset();

		};

		this._addTrackedListener( this.assetLoader, 'load', this._onAssetLoaded );

		this._addTrackedListener( this.assetLoader, 'modelProcessed', ( event ) => {

			const cameras = [ this.cameraManager.camera, ...( event.cameras || [] ) ];
			this.cameraManager.setCameras( cameras );

			if ( this.interactionManager ) {

				this.interactionManager.floorPlane = this.assetLoader.floorPlane;

			}

		} );

	}

	/**
	 * Initializes animation manager and transform manager after scene rebuild.
	 */
	_initAnimationAndTransforms() {

		const animations = this.assetLoader?.animations || [];
		if ( animations.length > 0 ) {

			const mixerRoot = this.assetLoader?.targetModel || this.meshScene;
			this.animationManager.init( this.meshScene, mixerRoot, this._sdf.meshes, animations );
			this.animationManager.onFinished = () => {

				this._animRefitInFlight = false;
				this.dispatchEvent( { type: EngineEvents.ANIMATION_FINISHED } );

			};

		}

		this.transformManager?.setMeshData( this._sdf.meshes );

	}

	// ═══════════════════════════════════════════════════════════════
	// Private — Stage creation & setup
	// ═══════════════════════════════════════════════════════════════

	_createStages() {

		this.stages.pathTracer = new PathTracer( this.renderer, this.scene, this.cameraManager.camera );
		this.stages.normalDepth = new NormalDepth( this.renderer, {
			pathTracer: this.stages.pathTracer
		} );
		this.stages.motionVector = new MotionVector( this.renderer, this.cameraManager.camera, {
			pathTracer: this.stages.pathTracer
		} );
		this.stages.asvgf = new ASVGF( this.renderer, { enabled: false } );
		this.stages.variance = new Variance( this.renderer, { enabled: false } );
		this.stages.bilateralFilter = new BilateralFilter( this.renderer, { enabled: false } );
		this.stages.edgeFilter = new EdgeFilter( this.renderer, { enabled: false } );
		this.stages.autoExposure = new AutoExposure( this.renderer, { enabled: DEFAULT_STATE.autoExposure ?? false } );

		this.stages.compositor = new Compositor( this.renderer, {
			saturation: this.settings.get( 'saturation' ) ?? DEFAULT_STATE.saturation,
			pathTracer: this.stages.pathTracer,
		} );

	}

	_setupDenoisingManager() {

		this.denoisingManager = new DenoisingManager( {
			renderer: this.renderer,
			mainCanvas: this.canvas,
			scene: this.scene,
			camera: this.cameraManager.camera,
			stages: {
				pathTracer: this.stages.pathTracer,
				normalDepth: this.stages.normalDepth,
				motionVector: this.stages.motionVector,
				asvgf: this.stages.asvgf,
				variance: this.stages.variance,
				bilateralFilter: this.stages.bilateralFilter,
				edgeFilter: this.stages.edgeFilter,
				autoExposure: this.stages.autoExposure,
				compositor: this.stages.compositor,
			},
			pipeline: this.pipeline,
			getExposure: () => this.settings.get( 'exposure' ) ?? 1.0,
			getSaturation: () => this.settings.get( 'saturation' ) ?? 1.0,
			getTransparentBg: () => this.settings.get( 'transparentBackground' ) ?? false,
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

	_reconcileCompletion() {

		const stage = this.stages.pathTracer;
		if ( ! stage ) return;

		const shouldBeComplete = this.completion.isLimitReached(
			stage, this.settings.get( 'renderLimitMode' ), this.settings.get( 'renderTimeLimit' )
		);

		if ( shouldBeComplete && ! stage.isComplete ) {

			stage.isComplete = true;

		} else if ( ! shouldBeComplete && stage.isComplete ) {

			stage.isComplete = false;
			this.completion.resumeFromPause();

			// Restore live preview: abort() on the denoising manager already
			// handles canvas opacity, denoiser output visibility, and upscaler reset.
			this.denoisingManager?.abort( this.canvas );

			this.dispatchEvent( { type: EngineEvents.RENDER_RESET } );
			this.wake();

		}

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

	_renderHelperOverlay() {

		this.scene.updateMatrixWorld();
		this.overlayManager?.render();

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

		this.cameraManager.controls.saveState();
		this.cameraManager.controls.update();

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

	/**
	 * Forwards events from a source EventDispatcher to this app instance.
	 */
	_forwardEvents( source, eventTypes ) {

		if ( ! source ) return;
		for ( const type of eventTypes ) {

			this._addTrackedListener( source, type, ( e ) => this.dispatchEvent( e ) );

		}

	}

}
