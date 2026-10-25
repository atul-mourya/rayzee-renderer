import { WebGPURenderer, RectAreaLightNode, SRGBColorSpace } from 'three/webgpu';
import { texture as _tslTexture, cubeTexture as _tslCubeTexture } from 'three/tsl';
import { Scene, EventDispatcher, Box3, REVISION } from 'three';
import { RectAreaLightTexturesLib } from 'three/addons/lights/RectAreaLightTexturesLib.js';
import { SceneHelpers } from './scene/SceneHelpers.js';
import { PathTracer } from './pathtracer/PathTracer.js';
import { textureLayerSink } from './pathtracer/PathTracerStage.js';
import { Compositor } from './pipeline/Compositor.js';
import { RenderPipeline } from './pipeline/RenderPipeline.js';
import { CompletionTracker, getDisplaySamples } from './pipeline/CompletionTracker.js';
import { ENGINE_DEFAULTS as DEFAULT_STATE } from './EngineDefaults.js';
import { TRIANGLE_DATA_LAYOUT, BVH_LEAF_MARKERS } from './scene/BufferLayout.js';
import { MAX_STORAGE_TEXTURE_SIZE, MAX_RESERVABLE_RENDER_SIZE, setReservedRenderSize } from './pathtracer/StorageTexturePool.js';
import { createLogger, fmt } from './Logger.js';
import { EngineEvents, LEGACY_EVENT_NAMES, updateStats, resetLoading, setStatusCallback } from './EngineEvents.js';
import { IssueLog, ISSUE_CODES } from './EngineIssues.js';
import { getAssetConfig, isAssetConfigured } from './AssetConfig.js';
import { isFolderInput } from './loaders/archives/archiveFormats.js';
import { BasicColor } from './color/BasicColor.js';
import { setActiveColorManagement } from './color/ActiveColor.js';
import { getViewTransform, DEFAULT_VIEW } from './color/ViewTransforms.js';
import { AssetLoader, disposeObjectFromMemory } from './loaders/AssetLoader.js';
import { SceneProcessor } from './scene/SceneProcessor.js';
import { deviceMemoryGB } from './memory/HostMemory.js';
import { createHeadlessCanvas } from './HeadlessCanvas.js';

// Managers
import { RenderSettings } from './RenderSettings.js';
import { ViewCamera } from './scene/ViewCamera.js';
import { LightManager } from './lights/LightManager.js';
import { VERSION } from './version.js';
import { toPortable } from './portable.js';
import * as SceneLoading from './loaders/SceneLoading.js';
import * as SceneSpill from './memory/SceneSpill.js';
import * as SceneEdits from './scene/SceneEdits.js';
import * as Pictures from './output/Pictures.js';

export const RENDER_CHECKPOINT_VERSION = 1;

// One app per canvas — auto-dispose a prior owner if the caller double-
// instantiates (StrictMode, HMR, etc.) so its rAF loop can't burn CPU.
const _appsByCanvas = new WeakMap();

const KNOWN_EVENTS = new Set( [ ...Object.values( EngineEvents ), ...Object.values( LEGACY_EVENT_NAMES ) ] );
const _warnedEvents = new Set();

// three's Animation.start() calls self.requestAnimationFrame during init() with no guard, and
// outside a browser there is no `self`. A headless app never uses that loop, so it gets an inert one.
async function initWithoutFrameLoop( renderer, headless ) {

	if ( ! headless || typeof self !== 'undefined' ) return renderer.init();

	globalThis.self = { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} };

	try {

		return await renderer.init();

	} finally {

		delete globalThis.self;

	}

}

/**
 * A second renderer on `device` — the view overlay's, a saved picture's. Its backend claims the device's single
 * uncaptured-error slot during init(); that is handed back, so the owner's handler keeps receiving errors.
 * @param {GPUDevice} device
 * @param {Object} parameters - WebGPURenderer's, `canvas` among them
 */
export async function createRendererOnDevice( device, parameters ) {

	const handler = device.onuncapturederror;
	const renderer = new WebGPURenderer( { ...parameters, device } );
	await renderer.init();
	device.onuncapturederror = handler;
	renderer.setPixelRatio( 1.0 );
	return renderer;

}

/**
 * Disposes a renderer without leaking it.
 *
 * Three.js 0.184–0.186: `Renderer.dispose()` does not remove the 'resize' listener
 * it installs on `_canvasTarget`. The bound handler closes over the renderer,
 * pinning the entire WebGPU graph (Backend, Nodes, Bindings, Pipelines, GPUDevice,
 * every TSL node) alive indefinitely — confirmed via heap-snapshot retainer
 * analysis. See `Renderer.js` (attach in the constructor, still absent from
 * `dispose()` in r186). Re-check on every upgrade; drop this when upstream fixes it.
 *
 * Renderers constructed with an external `device` do not destroy it here; three
 * only destroys a device it created itself.
 *
 * @param {import('three/webgpu').WebGPURenderer} renderer
 * @returns {?Promise<void>} Settles once the backend is torn down.
 */
export function disposeRenderer( renderer ) {

	if ( ! renderer ) return;

	if ( renderer._canvasTarget && renderer._onCanvasTargetResize ) {

		renderer._canvasTarget.removeEventListener( 'resize', renderer._onCanvasTargetResize );

	}

	// r186+ `dispose()` is async and settles once the backend is torn down; anything that
	// measures memory straight afterwards has to await the returned promise.
	const disposed = renderer.dispose();
	renderer._canvasTarget = null;
	return disposed;

}

/**
 * The renderer core: a scene and camera in, path-traced samples accumulated, the image out. It builds
 * no denoiser, camera controls, gizmo, overlay or timeline — {@link PathTracerApp} is the viewer that
 * adds them. See docs/CORE_AND_ADDONS.md.
 *
 * - `renderer.camera`             — the camera rendered from; move it, then {@link reset}
 * - `renderer.lightManager`       — {@link LightManager} (CRUD, helpers, GPU transfer)
 * - `renderer.environmentManager` — EnvironmentManager (HDRI, procedural sky, mode switching)
 * - `renderer.settings`           — {@link RenderSettings} (all render parameters)
 * - `renderer.stages`             — named pipeline stages: `pathTracer`, `compositor`
 * - `renderer.sceneMeshes`        — meshes backing the BVH, in buffer order (see {@link refitBVH})
 * - `renderer.sceneModel`         — root of the rendered model (a copy, for {@link loadObject3D})
 *
 * A layer built on the core overrides the hooks under "Hooks" at the end of the class; each runs at
 * a fixed point of the frame, reset or load sequence and does nothing here.
 */

const log = createLogger( 'engine' );

// An empty scene's tree: one triangle leaf holding nothing. Sixteen zeros read as an inner node whose children are itself.
function emptyBVH() {

	const nodes = new Float32Array( 16 );
	new Uint32Array( nodes.buffer )[ 3 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
	return nodes;

}

/**
 * Attaches the device-lost handler at module scope so the reaction closure captures only
 * `holder` — an arrow written inside a method would share that method's context and pin
 * the app through `this`. See _initRenderer().
 */
function attachDeviceLostHandler( device, holder ) {

	device.lost.then( ( info ) => {

		if ( holder.app ) holder.app._handleDeviceLost( info );

	} );

}

// three.js's GPUFeatureName, which it does not export: what its own device request enables.
const THREE_DEVICE_FEATURES = [
	'core-features-and-limits', 'depth-clip-control', 'depth32float-stencil8', 'texture-compression-bc',
	'texture-compression-bc-sliced-3d', 'texture-compression-etc2', 'texture-compression-astc',
	'texture-compression-astc-sliced-3d', 'timestamp-query', 'indirect-first-instance', 'shader-f16',
	'rg11b10ufloat-renderable', 'bgra8unorm-storage', 'float32-filterable', 'float32-blendable', 'clip-distances',
	'dual-source-blending', 'subgroups', 'texture-formats-tier1', 'texture-formats-tier2',
];

const SOFTWARE_ADAPTER = /swiftshader|llvmpipe|lavapipe|basic render|microsoft basic|warp/i;

/**
 * Flags software rasterizers: correct output, ~100x slower, invisible in the image.
 * `isFallbackAdapter` only covers adapters we asked to be fallbacks, so the strings matter.
 *
 * @param {GPUAdapter} adapter
 * @returns {{vendor:string, architecture:string, device:string, description:string, isSoftware:boolean}}
 */
export function describeAdapter( adapter ) {

	const info = adapter.info ?? {};
	const identity = `${info.vendor ?? ''} ${info.architecture ?? ''} ${info.device ?? ''} ${info.description ?? ''}`;

	return {
		vendor: info.vendor ?? '',
		architecture: info.architecture ?? '',
		device: info.device ?? '',
		description: info.description ?? '',
		isSoftware: info.isFallbackAdapter === true
			|| adapter.isFallbackAdapter === true
			|| SOFTWARE_ADAPTER.test( identity ),
	};

}

export class RayzeeRenderer extends EventDispatcher {

	/**
	 * @param {HTMLCanvasElement} canvas - Canvas element for rendering
	 * @param {Object} [options] - Engine options
	 * @param {boolean} [options.autoResize=true] - Automatically listen for window resize events
	 * @param {boolean} [options.headless=false] - a render nobody watches, and the default when no canvas
	 *   is given: the engine supplies its own canvas (see HeadlessCanvas.js) and runs no render loop — drive it
	 *   with renderFrames() or renderUntilComplete()
	 * @param {boolean} [options.strict=false] - Throw at the point of degradation instead of
	 *   rendering a plausible wrong image. See EngineIssues.js; read `app.issues` when off.
	 * @param {number} [options.maxSceneBytes] - refuse a scene whose estimated host memory is
	 *   above this. The default refuses where the renderer process would be killed instead of
	 *   throwing; raise it deliberately, on a fresh browser. See HostMemory.js.
	 * @param {number} [options.hostMemoryGB] - the host's memory, where `navigator.deviceMemory` is
	 *   absent (anything but Chrome) or wrong; it sizes the render reserve and the path pool
	 * @param {false|'auto'|Object} [options.storage] - on-disk storage; defaults to
	 *   `configureAssets( { storage } )`, or off under `strict` unless that was set. 'auto' opens it through
	 *   {@link setStorageOpener} (rayzee/addons/storage); a host-supplied StorageManager stays the host's to dispose.
	 * @param {'auto'|boolean} [options.memorySpill='auto'] - build a static scene through disk: its triangle records,
	 *   BLAS nodes and three.js geometry leave memory as they are built (see {@link ensureSceneResident}), scene archives
	 *   load past the default budgets, and an environment wider than SPILL_ENVIRONMENT_WIDTH is box-filtered down.
	 *   'auto' does so only for a scene whose in-memory estimate passes SAFE_SCENE_BYTES; true for every scene, false
	 *   never. Needs storage; skipped for animated scenes. See {@link setMemorySpill}.
	 *
	 * The engine dispatches `EngineEvents.FRAME` after each animate() iteration so hosts can
	 * tick external instrumentation (e.g. a stats panel) without coupling the engine to it.
	 */
	constructor( canvas, options = {} ) {

		super();

		this._headless = options.headless === true || ! canvas;
		canvas ??= createHeadlessCanvas();

		try {

			_appsByCanvas.get( canvas )?.dispose();

		} catch ( err ) {

			log.warn( 'prior canvas owner dispose failed', err );

		}

		_appsByCanvas.set( canvas, this );

		this.canvas = canvas;
		this._autoResize = ! this._headless && options.autoResize !== false;
		// A scene budget the host may raise; read where SceneProcessor is built, well after this.
		this._maxSceneBytes = options.maxSceneBytes;
		this._hostMemoryGB = options.hostMemoryGB;
		this._storageOption = options.storage;
		this._storageOpener = null;
		this._memorySpill = options.memorySpill === true || options.memorySpill === false ? options.memorySpill : 'auto';
		this._spillPlan = null;
		/** @type {?Object} on-disk storage (a StorageManager), null when off or unavailable */
		this.storage = null;
		this._storageRelease = null;
		// Apply the environment authored into a model file's metadata on load. See _beginSceneMetadataEnvironment().
		this._applySceneMetadataEnabled = options.applySceneMetadata !== false;
		this._unlitRestore = null;
		this._applyingSceneMetadata = false;

		if ( options.profile !== undefined ) {

			throw new Error( 'the `profile` option was removed: the engine has one set of defaults. For the old \'physical\' '
				+ 'profile set `areaLightIntensityScale: 1` and `dofMode: \'physical\'` through `settings`.' );

		}

		// First, so no subsystem can degrade unrecorded.
		this._issues = new IssueLog( {
			strict: options.strict === true,
			onIssue: ( issue ) => this.dispatchEvent( { type: EngineEvents.ISSUE, issue } ),
		} );

		/**
		 * Colour management: what the engine renders in, shows it as, and hands out. Here linear Rec.709 and
		 * three.js's own seven view transforms; setColorManagement() installs the OCIO pipeline.
		 */
		this.color = new BasicColor( { issues: this._issues } );
		setActiveColorManagement( this.color );

		// ── Settings (single source of truth for all render parameters) ──
		this.settings = new RenderSettings( DEFAULT_STATE, { issues: this._issues } );

		// ── Core objects (populated in init) ──
		this.renderer = null;
		this.scene = null;
		this.meshScene = null;
		this._sceneHelpers = null;

		// ── Asset pipeline ──
		this.assetLoader = null;
		this._sdf = null;

		// ── Pipeline & stages ──
		this.pipeline = null;

		this._pendingReservedRenderSize = null;

		/**
		 * Named access to all pipeline stages.
		 * Advanced consumers can reach into stages for fine-grained control.
		 * @type {Object}
		 */
		this.stages = {};

		/** @type {?import('three').PerspectiveCamera} the camera rendered from (a ViewCamera) */
		this.camera = null;

		// ── Managers (direct public access) ──
		/** @type {LightManager} */
		this.lightManager = null;
		/** @type {import('./environment/EnvironmentManager.js').EnvironmentManager} */
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
		// The size the host asked for. The canvas backing store is this × _renderScale, which drops
		// below 1 only while the camera moves.
		this._displayWidth = 0;
		this._displayHeight = 0;
		this._renderScale = 1;
		// What the pipeline last rendered at, before the render scale.
		this._renderWidth = 0;
		this._renderHeight = 0;

		// Tracked listeners for clean dispose()
		this._trackedListeners = [];
		this._disposed = false;
		this._deviceLost = false;
		this._gpuDevice = null;
		this._deviceLostHolder = null;

		// Deterministic-render mode — see setDeterministicMode()
		this._deterministic = false;
		this._dispatchPinned = false;
		this._deterministicRestore = null;

		/** @type {?{vendor:string, architecture:string, device:string, description:string, isSoftware:boolean}} */
		this.adapterInfo = null;

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

		const storageReady = this._initStorage();
		await this._initRenderer();
		this._applyPendingReservedRenderSize();
		this.camera = this._createCamera();
		this._initScenes();
		this._initAssetPipeline();
		this._initPipeline();
		await this._initManagers();
		this._wireEvents();
		await storageReady;
		this._attachStorage();

		// Seed path tracer with minimal empty scene data
		this.stages.pathTracer.setTriangleData( new Uint32Array( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE ), 0 );
		this.stages.pathTracer.setBVHData( emptyBVH() );
		this.stages.pathTracer.materialData.setMaterialData( new Float32Array( 16 ) );
		this.stages.pathTracer.setupMaterial();

		this.isInitialized = true;
		log.debug( 'WebGPU path tracer app initialized' );

		return this;

	}

	/**
	 * Installs on-disk storage — `acquireSharedStorage` from rayzee/addons/storage — for the download, environment and
	 * scene caches and the memory spill. Before init(), or after it resolves; PathTracerApp installs it itself.
	 * @param {function(string): Promise<{storage: ?Object, reason?: string, release: function(): void}>} opener
	 */
	async setStorageOpener( opener ) {

		this._storageOpener = opener;
		if ( ! this.isInitialized || this.storage || this._disposed ) return;
		await this._initStorage();
		this._attachStorage();

	}

	async _initStorage() {

		// A batch render must not be answered from an earlier run's cache unless the host asked for one.
		const option = this._storageOption
			?? ( this._issues.strict && ! isAssetConfigured( 'storage' ) ? false : getAssetConfig().storage );
		if ( option === false ) return;

		if ( option && typeof option === 'object' ) {

			this.storage = option;

		} else {

			if ( ! this._storageOpener ) {

				if ( this._storageOption !== undefined || isAssetConfigured( 'storage' ) ) {

					this._issues.warn( ISSUE_CODES.CAPABILITY_MISSING, 'on-disk storage needs rayzee/addons/storage: setStorageOpener( acquireSharedStorage )' );

				}

				return;

			}

			const { storage, reason, release } = await this._storageOpener( getAssetConfig().cacheNamespace );
			if ( this._disposed ) {

				release();
				return;

			}

			if ( ! storage ) {

				this._issues.warn( ISSUE_CODES.STORAGE_UNAVAILABLE, `on-disk storage is off: ${reason}`, { reason } );
				return;

			}

			this.storage = storage;
			this._storageRelease = release;

		}

		this._addTrackedListener( this.storage, 'change', ( e ) => this.dispatchEvent( { type: EngineEvents.STORAGE_CHANGED, area: e.area } ) );
		this._addTrackedListener( this.storage, 'issue', ( e ) => this._issues.warn( e.code, e.message, e.detail ) );

	}

	_attachStorage() {

		if ( this.assetLoader ) this.assetLoader.storage = this.storage;

	}

	dispatchEvent( event ) {

		super.dispatchEvent( event );
		const legacy = LEGACY_EVENT_NAMES[ event.type ];
		if ( legacy ) super.dispatchEvent( { ...event, type: legacy } );

	}

	addEventListener( type, listener ) {

		if ( ! KNOWN_EVENTS.has( type ) && ! _warnedEvents.has( type ) ) {

			_warnedEvents.add( type );
			log.warn( `no engine event is named "${type}", so this listener will never fire — see EngineEvents` );

		}

		super.addEventListener( type, listener );

	}

	/**
	 * Starts the animation loop.
	 */
	animate() {

		if ( this._headless ) throw new Error( 'a headless app has no render loop — drive it with renderFrames() or renderUntilComplete()' );

		// Device lost: stop the loop rather than rescheduling render() on a dead device.
		if ( this._deviceLost ) return;

		this.animationManagerId = requestAnimationFrame( () => this.animate() );

		if ( this._loadingInProgress || this._sdf?.isProcessing ) {

			this.dispatchEvent( { type: EngineEvents.FRAME } );
			return;

		}

		this._beginFrame();

		const cameraMoved = this.needsReset;
		if ( this.needsReset ) {

			// Before the reset, so the denoising manager's abort sees this frame as part of a move
			// rather than deciding to hold on the first frame and dropping it on the second.
			this.stages.pathTracer?.noteViewChanged();
			this.reset( true );
			this.needsReset = false;

		}

		this.camera.updateMatrixWorld();

		// Raster fallback when path tracer is disabled
		if ( ! this.pathTracerEnabled ) {

			this.renderer.render( this.meshScene, this.camera );
			this._renderHelperOverlay();
			return;

		}

		if ( this.pauseRendering ) return;

		this._beforeTrace();

		// Render path tracing
		if ( this.stages.pathTracer?.isReady ) {

			if ( this.stages.pathTracer.isComplete && this.completion.renderCompleteDispatched ) {

				if ( this._needsDisplayRefresh ) {

					this._needsDisplayRefresh = false;
					this.stages.compositor.render( this.pipeline.context );
					this._renderHelperOverlay();

				}

				if ( this._settling() ) {

					this.dispatchEvent( { type: EngineEvents.FRAME } );
					return;

				}

				// Stop the loop to avoid constant CPU usage while idle
				this.stopAnimation();
				return;

			}

			if ( this._holdTrace( cameraMoved ) ) {

				// Gizmos and outlines are drawn against the live camera, not the traced frame, so
				// they would visibly lag the view if they only redrew on the frames that traced.
				this._renderHelperOverlay();
				this.dispatchEvent( { type: EngineEvents.FRAME } );
				return;

			}

			// A lockstep readback is due and still in flight; the frame would trace nothing.
			if ( this.stages.pathTracer.readbackWait() ) {

				this.dispatchEvent( { type: EngineEvents.FRAME } );
				return;

			}

			this._traceFrame( { liveDenoise: true } );

			if ( this.stages.pathTracer.isComplete && this.completion.markComplete() ) this._announceComplete();

		}

		this._renderHelperOverlay();
		this.dispatchEvent( { type: EngineEvents.FRAME } );

	}

	// The closing passes and RENDER_COMPLETE wait for _finishImage(), so both see the finished image's exposure.
	_announceComplete() {

		const info = this._completionInfo();
		const restarts = this.stages.pathTracer.resetCount;
		const announce = () => {

			if ( ! this.completion.renderCompleteDispatched || this.stages.pathTracer?.resetCount !== restarts ) return;
			this._renderCompleted();
			this.dispatchEvent( { type: EngineEvents.RENDER_COMPLETE, ...info } );

		};

		const finishing = this._finishImage();
		if ( finishing ) finishing.then( announce, announce );
		else announce();

	}

	// One frame of a render and its bookkeeping, shared by animate() and renderUntilComplete().
	_traceFrame( { liveDenoise = false } = {} ) {

		const stage = this.stages.pathTracer;
		this.pipeline.render();
		this._afterTrace( stage, liveDenoise );
		if ( ! stage.isComplete ) this.completion.updateTime();

		this._ensureVRAMWiring();
		// VRAM is monotonic and only changes on allocation events (scene/env
		// load, resize — each re-measures via _ensureVRAMWiring). Within an
		// accumulation burst nothing reallocates, so re-walking every stage's
		// textures each frame is wasted. Measure at burst start (catches any
		// reset-triggered allocation) + a periodic backstop; read cached otherwise.
		const tracker = stage.vramTracker;
		const frame = stage.frameCount ?? 0;
		if ( tracker && ( frame <= 1 || frame % 30 === 0 ) ) tracker.measure();

		updateStats( {
			timeElapsed: this.completion.timeElapsed,
			samples: getDisplaySamples( stage ),
			memoryUsed: tracker?.current ?? 0,
			memoryPeak: tracker?.peak ?? 0,
		} );

		// Only the wall-clock stop — PathTracer.render() retires the ceiling and convergence
		// itself, so whichever of the three arrives first wins.
		if ( this.completion.isTimeLimitReached( stage, this.settings.get( 'renderLimitMode' ), this.settings.get( 'renderTimeLimit' ) ) ) {

			stage.isComplete = true;

		}

	}

	_completionInfo() {

		return {
			samples: this.stages.pathTracer.frameCount,
			timeElapsed: this.completion.timeElapsed,
			budgetOverrun: this.completion.budgetOverrun,
			// null means isComplete was forced rather than earned (the reconcile below);
			// a forced stop is closer to the ceiling than to convergence.
			reason: this.completion.stopCondition( this.stages.pathTracer ) ?? 'samples',
		};

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

		if ( this._deviceLost || this._headless ) return;
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
		if ( ! this.animationManagerId && ! this._headless ) this.animate();

	}

	/**
	 * Resets the accumulation buffer.
	 * @param {boolean} soft - When true, denoisers keep their temporal history
	 * @param {Object} [options]
	 * @param {boolean} [options.motion] - only object placements or geometry moved; keeps the OIDN
	 *   motion history, which rejects what moved per pixel
	 */
	reset( soft = false, { motion = false } = {} ) {

		// Objects moving is the view changing, as far as the live denoiser's refresh cadence goes.
		if ( motion ) this.stages.pathTracer?.noteViewChanged();
		this._beforeReset( soft || motion );

		if ( this.pipeline ) {

			this.pipeline.reset();
			// History from before a hard restart is not comparable; a soft one keeps it.
			if ( ! soft ) this.pipeline.eventBus.emit( 'pipeline:historyReset' );

		}

		this._afterReset();

		this.completion.reset();
		this.wake();
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
		clearTimeout( this._respillTimer );
		this._respillTimer = null;

		this._removeTrackedListeners();
		setStatusCallback( null );

		this._storageRelease?.();
		this._storageRelease = null;
		this.storage = null;
		this._sceneSource = this._sceneSourceInput = null;

		this._issues.detach(); // onIssue captures `this`; see IssueLog.detach()

		// Holds the renderer and the issue log, both of which outlive it otherwise.
		this.color?.dispose();
		this.color = null;
		this._pictureCopy = null;
		this._textureReadback?.dispose();
		this._textureReadback = null;
		for ( const mapper of this._readbackToneMappers?.values() ?? [] ) mapper.dispose();
		this._readbackToneMappers = null;

		this._disposeExtensions();
		this.lightManager?.dispose();

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

		// Value of a WeakMap keyed by a canvas that outlives us: without this the whole
		// disposed graph stays reachable until another app claims the same canvas.
		if ( this.canvas && _appsByCanvas.get( this.canvas ) === this ) _appsByCanvas.delete( this.canvas );

		const device = this._gpuDevice;
		if ( device ) {

			device.onuncapturederror = null;
			this._gpuDevice = null;

		}

		if ( this._deviceLostHolder ) {

			this._deviceLostHolder.app = null;
			this._deviceLostHolder = null;

		}

		// three.js destroys only a device it requested itself.
		Promise.resolve( disposeRenderer( this.renderer ) ).finally( () => device?.destroy() );
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

		this._releaseSceneState();

		this.assetLoader?.releaseTargetModel();
		this._sceneSource = this._sceneSourceInput = null;

		// Clear lights in the WebGPU light scene
		this.lightManager?.clearLights?.();

		// Seed path tracer with empty data (matches the init-time seed)
		if ( this.stages.pathTracer ) {

			this.stages.pathTracer.setTriangleData( new Uint32Array( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE ), 0 );
			this.stages.pathTracer.setBVHData( emptyBVH() );
			this.stages.pathTracer.materialData.setMaterialData( new Float32Array( 16 ) );
			this.stages.pathTracer.setEmissiveTriangleData?.( new Float32Array( 0 ), 0, 0 );
			this.stages.pathTracer.setupMaterial();

		}

		this._dropDisplay();
		this.reset();
		this.dispatchEvent( { type: EngineEvents.SCENE_UNLOADED } );

	}

	/**
	 * Loads a model, builds BVH, and uploads scene data.
	 * @param {string} url - Model URL
	 * @param {{cacheKey?: string}} [options] - download-cache key for a URL that expires
	 */
	loadModel( url, options ) {

		return SceneLoading.loadModel( this, url, options );

	}

	/**
	 * Loads a Three.js Object3D directly into the path tracer scene.
	 * Builds BVH from the object's meshes and uploads scene data.
	 *
	 * Renders a copy: `object3d` is never reparented, rewritten or disposed, so passing a
	 * subtree of a scene the host still renders is safe. Geometry/material/texture are shared
	 * by reference, and any ancestor transform is baked in. Later edits to `object3d` do not
	 * reach the render — mutate {@link sceneModel}, then {@link refitBVH}/{@link refitBLASes}.
	 *
	 * Lights keep three.js units — `RectAreaLight.intensity` in nits, point/spot in candela — and are
	 * converted to radiant power on the copy. `areaLightIntensityScale` does not apply here.
	 *
	 * @param {import('three').Object3D} object3d - The Object3D to render; left untouched.
	 * @param {string} [name='object3d'] - Display name for the object
	 */
	loadObject3D( object3d, name ) {

		return SceneLoading.loadObject3D( this, object3d, name );

	}

	/**
	 * Loads an environment map and rebuilds CDF.
	 * @param {string} url - Environment URL
	 */
	loadEnvironment( url ) {

		return SceneLoading.loadEnvironment( this, url );

	}

	/**
	 * Lists the independently loadable parts of an archive without unpacking it, so a host
	 * can offer a choice for a scene too large to load whole.
	 * @param {File} file
	 * @returns {Promise<{kind:string, root:string|null, elements:Array, entryCount:number, totalBytes:number}>}
	 */
	inspectArchive( file ) {

		return SceneLoading.inspectArchive( this, file );

	}

	/**
	 * Loads a user-supplied File (drag-drop, file picker) — model, archive, or environment
	 * map, dispatched by extension — or a folder of files, read as the same folder zipped would be.
	 *
	 * Prefer this over driving `assetLoader.loadAssetFromFile()` directly. That bypasses the
	 * in-progress guard, and AssetLoader disposes the outgoing model before it knows whether
	 * the engine will rebuild: a file dropped mid-load would tear down the live scene, add the
	 * new one to the graph, and then be discarded by the `load` handler — leaving the path
	 * tracer rendering buffers whose geometry has been freed. Here a concurrent call throws
	 * LOAD_IN_PROGRESS before anything is touched.
	 *
	 * @param {File|string|{name?: string, files: Iterable<File|{path: string, file: Blob}>}} file - a File, a URL to
	 *   download (through the download cache), or a folder: `{ files }` — a folder picker's FileList, whose files carry
	 *   their `webkitRelativePath`, or `{ path, file }` pairs; `name` defaults to the folder they share
	 * @param {object} [options] - forwarded to the archive loader: `element` to load one
	 *   subtree of a multi-part scene, `pbrtEntry` to choose among several .pbrt scenes. For a
	 *   URL also `filename` and `cacheKey` (see AssetLoader.loadAssetFromUrl).
	 * @returns {Promise<void>}
	 */
	loadFile( file, options ) {

		return SceneLoading.loadFile( this, file, options );

	}

	/**
	 * Loads example models by index.
	 * @param {number} index
	 * @param {Array} modelFiles
	 */
	loadExampleModels( index, modelFiles ) {

		return SceneLoading.loadExampleModels( this, index, modelFiles );

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

		return SceneLoading.cancelLoad( this );

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
	setMaxTextureSize( size, options ) {

		return SceneLoading.setMaxTextureSize( this, size, options );

	}

	/**
	 * Where the model on screen came from, as plain data — what a saved session reopens:
	 * `{ kind: 'url', url, cacheKey, filename?, element?, pbrtEntry? }`,
	 * `{ kind: 'local-file', file: {name, size, lastModified, sample}, key, element?, pbrtEntry? }`,
	 * `{ kind: 'local-folder', folder: {name, size, lastModified, sample, files}, key, flat?, element?, pbrtEntry? }`
	 * (`flat` when it was loose files rather than one folder) or `{ kind: 'object3d', name }`. Null before a load and
	 * after {@link unloadScene}.
	 * @returns {?Object}
	 */
	get sceneSource() {

		return this._sceneSource ?? null;

	}

	/** The File a local load came from, so a host can save a project that carries it; null otherwise. */
	get sceneSourceFile() {

		return this._sceneSourceInput && ! isFolderInput( this._sceneSourceInput ) ? this._sceneSourceInput : null;

	}

	/** The folder a local load came from, as `{ name, files: [{ path, file }] }`; null otherwise. */
	get sceneSourceFolder() {

		return isFolderInput( this._sceneSourceInput ) ? this._sceneSourceInput : null;

	}

	_loadWithSceneRebuild( loadFn, eventPayload, source ) {

		return SceneLoading.loadWithSceneRebuild( this, loadFn, eventPayload, source );

	}

	_discardFailedLoad() {

		return SceneLoading.discardFailedLoad( this );

	}

	/**
	 * Scene-level authoring metadata carried by the current model file (glTF `extras`),
	 * or null when the file has none. See {@link module:loaders/SceneMetadata}. A pbrt scene
	 * without an infinite light carries `environment: { enabled: false }`. `render` is what the file asks
	 * the renderer for (pbrt's maxdepth, pixelsamples and film resolution); nothing applies it.
	 * @type {{ environment?: { sourceFile?: string, rotation?: number, intensity?: number, enabled?: boolean }, render?: { maxBounces?: number, samples?: number, width?: number, height?: number } }|null}
	 */
	get sceneMetadata() {

		return this.assetLoader?.sceneMetadata ?? null;

	}

	_beginSceneMetadataEnvironment() {

		return SceneLoading.beginSceneMetadataEnvironment( this );

	}

	_applySceneMetadataSettings( texture ) {

		return SceneLoading.applySceneMetadataSettings( this, texture );

	}

	/**
	 * Builds BVH from meshScene and uploads all scene data to the path tracer.
	 * @param {Object} [options]
	 * @param {Promise<import('three').Texture|null>} [options.pendingEnvironment] - An
	 *   environment still being fetched (see _beginSceneMetadataEnvironment). Installed and
	 *   CDF'd concurrently with the BVH build rather than before it.
	 * @returns {boolean}
	 */
	loadSceneData( options ) {

		return SceneLoading.loadSceneData( this, options );

	}

	_clearAppendedModels() {

		return SceneLoading.clearAppendedModels( this );

	}

	/**
	 * Append a model by URL to the current scene (does NOT replace it), then rebuild
	 * without reframing the camera.
	 * @param {string} url
	 * @param {Object} [opts]
	 * @param {string} [opts.name] - Display name for the scene-object list.
	 * @returns {Promise<string>} the new object's id (Object3D uuid).
	 */
	addModel( url, options ) {

		return SceneLoading.addModel( this, url, options );

	}

	/**
	 * Append a caller-owned Object3D to the current scene, then rebuild (no reframe).
	 * Appends a copy; the object passed in is never mutated. Same rules as {@link loadObject3D}.
	 * @param {import('three').Object3D} object3d
	 * @param {Object} [opts]
	 * @param {string} [opts.name]
	 * @returns {Promise<string>} the new object's id (Object3D uuid).
	 */
	addModelFromObject3D( object3d, options ) {

		return SceneLoading.addModelFromObject3D( this, object3d, options );

	}

	/**
	 * Remove a scene object by id (Object3D uuid). The Ground plane is permanent.
	 * @param {string} id
	 * @returns {Promise<boolean>} true if removed.
	 */
	removeSceneObject( id ) {

		return SceneLoading.removeSceneObject( this, id );

	}

	/**
	 * Toggle a scene object's visibility without rebuilding (O(1) TLAS-leaf patch).
	 * @param {string} id - Object3D uuid.
	 * @param {boolean | ((prev:boolean)=>boolean)} visible
	 * @returns {boolean|null} new visibility, or null if not found.
	 */
	setSceneObjectVisibility( id, visible ) {

		return SceneLoading.setSceneObjectVisibility( this, id, visible );

	}

	// ═══════════════════════════════════════════════════════════════
	// Dynamic cameras (add / remove)
	// ═══════════════════════════════════════════════════════════════

	/** How scenes use the disk: 'auto', true or false (see the constructor's `memorySpill`). */
	get memorySpill() {

		return this._memorySpill;

	}

	/** Sets {@link memorySpill}; the next load or rebuild follows it. */
	setMemorySpill( mode ) {

		return SceneSpill.setMemorySpill( this, mode );

	}

	/** Whether the current scene was built through disk. */
	get sceneSpilled() {

		return !! this._sdf?.spilling;

	}

	/** Whether the model's three.js geometry is on disk, so picking skips it until {@link ensureSceneResident}. */
	get geometryOnDisk() {

		return this._sdf?.geometryOnDisk === true;

	}

	_sceneBudgets( options ) {

		return SceneSpill.sceneBudgets( this, options );

	}

	_planSpill() {

		return SceneSpill.planSpill( this );

	}

	_progressiveSpill() {

		return SceneSpill.progressiveSpill( this );

	}

	_chunkUploader() {

		return SceneSpill.chunkUploader( this );

	}

	_maybeSpill() {

		return SceneSpill.maybeSpill( this );

	}

	/**
	 * Reads back what {@link options.memorySpill} moved to disk: triangle records, BLAS nodes and the three.js geometry
	 * (whose arrays are empty until then). The engine does this itself before its own readers; a host calling
	 * {@link refitBLASes}, or reading the model's geometry, on a spilled scene awaits it first.
	 */
	ensureSceneResident() {

		return SceneSpill.ensureSceneResident( this );

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
	 * Root of the model actually being rendered. For {@link loadObject3D} this is the engine's
	 * copy, not the object you passed — mutate this one, then {@link refitBVH}/{@link refitBLASes}.
	 *
	 * @returns {import('three').Object3D|null} Live reference, or null when nothing is loaded.
	 */
	get sceneModel() {

		return this.assetLoader?.targetModel ?? null;

	}

	/**
	 * Resolve an id from {@link addModel}/{@link addModelFromObject3D} to the root being
	 * rendered for it — for an appended Object3D, the engine's copy.
	 *
	 * @param {string} id
	 * @returns {import('three').Object3D|null} Live reference, or null if no such object.
	 */
	getSceneObject( id ) {

		const root = this.meshScene?.children.find( c => c.uuid === id );
		return root?.userData?.__rayzeeSceneObject ? root : null;

	}

	/**
	 * Update vertex positions for animation without full BVH rebuild.
	 * O(N) bottom-up AABB refit instead of O(N log N) SAH rebuild.
	 *
	 * Topology must stay the same (same triangle count and connectivity).
	 * Call this per-frame for skeletal/morph-target animation.
	 *
	 * Positions come in one of two shapes. A **callback** `(meshIndex, triCount) => Float32Array`
	 * is asked for one mesh at a time and may return the same scratch buffer each call — prefer it,
	 * since it never holds more than one mesh. A **scene-wide Float32Array** of 9 floats per
	 * triangle for every triangle (meshes in {@link sceneMeshes} order, triangles in index order)
	 * still works, but is 1,030 MB at 30M triangles and will not allocate at that size.
	 *
	 * @param {Float32Array|function(number, number): Float32Array} newPositions - (ax,ay,az, bx,by,bz, cx,cy,cz) per triangle, world space
	 * @param {Float32Array|function(number, number): Float32Array} [newNormals] - Optional smooth normals, same two shapes. If omitted, face normals are computed from positions.
	 * @returns {Promise<{ refitTimeMs: number }>}
	 */
	refitBVH( newPositions, newNormals ) {

		return SceneEdits.refitBVH( this, newPositions, newNormals );

	}

	/**
	 * Refit specific mesh BLASes and rebuild TLAS after object transform.
	 * Faster than refitBVH for single-object transforms in multi-mesh scenes.
	 *
	 * @param {number[]} affectedMeshIndices - Mesh indices to refit
	 * @param {Float32Array|function(number, number): Float32Array} newPositions - the same two shapes
	 *   {@link refitBVH} takes; only the affected meshes are asked for
	 * @param {Float32Array|function(number, number): Float32Array} [newNormals] - Optional smooth normals
	 * @returns {{ refitTimeMs: number }}
	 */
	refitBLASes( affectedMeshIndices, newPositions, newNormals ) {

		return SceneEdits.refitBLASes( this, affectedMeshIndices, newPositions, newNormals );

	}

	/**
	 * Apply new transforms for objects that moved, without touching their geometry.
	 *
	 * This is the right call for a gizmo drag or any other rigid move: triangles are stored in
	 * each object's own space, so only the placement matrix changes. {@link refitBLASes} is for
	 * geometry that actually deformed — on a rigid move it rewrites vertices needlessly, and
	 * drags along any other object sharing the same geometry.
	 *
	 * @param {number[]} meshIndices - indices into {@link sceneMeshes}
	 * @returns {?{ refitTimeMs: number, placements: number }} null when the move waits for a spilled scene's data
	 */
	updateMeshTransforms( meshIndices ) {

		return SceneEdits.updateMeshTransforms( this, meshIndices );

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
		const memory = deviceMemoryGB( this._hostMemoryGB );
		// 4K reserve pins the accum MRT (~1.5 GB) + aux; only grant it on clearly-capable GPUs.
		const deviceSafeMax = ( memory.gb >= 8 && maxBinding >= 1024 * 1024 * 1024 )
			? MAX_RESERVABLE_RENDER_SIZE : 2048;
		const applied = setReservedRenderSize( Math.min( target, deviceSafeMax ) );

		if ( applied < Math.floor( requestedPx ) ) {

			this._issues.warn(
				ISSUE_CODES.RENDER_RESERVE_CAPPED,
				`reserved render size ${fmt.n( requestedPx )}px was capped to ${fmt.n( applied )}px by this device's limits — ` +
				`renders above ${fmt.n( applied )}px will be declined` +
				( memory.assumed && memory.gb < 8 ? ' (host memory unknown, 4 GB assumed: pass hostMemoryGB)' : '' ),
				{ requested: requestedPx, applied, deviceMemoryGB: memory.gb, assumed: memory.assumed, maxStorageBufferBindingSize: maxBinding }
			);

		}

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
			this.dispatchEvent( { type: EngineEvents.RESERVED_RENDER_SIZE_CHANGED, size: applied } );

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
		this.dispatchEvent( { type: EngineEvents.RESERVED_RENDER_SIZE_CHANGED, size: applied } );

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

			this._issues.record(
				ISSUE_CODES.RENDER_SIZE_DECLINED,
				`render resolution ${width}×${height} exceeds the ${MAX_STORAGE_TEXTURE_SIZE}px storage reserve — resize ignored, ` +
				`so output stays at the previous size. Raise it with setReservedRenderResolution( ${Math.max( width, height )} ) before init().`,
				{ width, height, reserve: MAX_STORAGE_TEXTURE_SIZE }
			);
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
		this._setDisplaySize( width, height );

		if ( width === this._renderWidth && height === this._renderHeight ) return;

		clearTimeout( this._resizeDebounceTimer );
		this._resizeDebounceTimer = setTimeout( () => {

			this._applyRenderResize( width, height );

		}, 300 );

	}

	_applyRenderResize( renderWidth, renderHeight ) {

		if ( ! this._isRenderSizeSupported( renderWidth, renderHeight ) ) return;

		this.pipeline?.setSize( this._scaled( renderWidth ), this._scaled( renderHeight ) );
		this._renderWidth = renderWidth;
		this._renderHeight = renderHeight;
		this._renderSizeChanged( renderWidth, renderHeight );
		this.needsReset = true;

		this.dispatchEvent( { type: EngineEvents.RESOLUTION_CHANGED, width: renderWidth, height: renderHeight } );

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
		this._setDisplaySize( width, height );

		clearTimeout( this._resizeDebounceTimer );
		this._applyRenderResize( width, height );

		return { width, height };

	}

	_scaled( size ) {

		return Math.max( 1, Math.round( size * this._renderScale ) );

	}

	// The wavefront takes its resolution from the canvas backing store, so that is what has to shrink.
	// updateStyle=false keeps the CSS size, and the browser stretches the smaller frame over it.
	_setDisplaySize( width, height ) {

		this._displayWidth = width;
		this._displayHeight = height;

		this.renderer.setSize( this._scaled( width ), this._scaled( height ), false );
		this.camera.aspect = width / height;
		this.camera.updateProjectionMatrix();

	}

	// ═══════════════════════════════════════════════════════════════
	// Mode Configuration
	// ═══════════════════════════════════════════════════════════════

	refreshFrame() {

		this._needsDisplayRefresh = true;
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
	 * - `usePixelFreeze` skips the pixels it judges converged.
	 * - `_bounceEarlyExitThreshold` ends the bounce loop off the async survivor curve, and the
	 *   frame a readback lands on is GPU-scheduled. `_useDynamicDispatch` sizes each bounce on
	 *   the GPU; pinned off with the rest, a deterministic frame runs full grids.
	 * - `interactionModeEnabled` is a 100 ms timer that lowers the render resolution, disables
	 *   accumulation and freezes frameCount; it engages on the very first frame.
	 * - auto-focus raycasts per frame and auto-exposure adapts off `performance.now()`.
	 *
	 * Leaves the rAF loop stopped — drive rendering with {@link PathTracerApp#renderFrames}.
	 * Idempotent; pass `false` to restore the previous configuration.
	 *
	 * `pinDispatch: false` keeps the two dispatch heuristics (`_useDynamicDispatch`, GPU-sized,
	 * and the readback-driven per-bounce early exit) ACTIVE while still pinning the
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
					extras: this._deterministicSnapshot(),
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

			this._setDeterministicExtras( true, this._deterministicRestore.extras );

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

			this._setDeterministicExtras( false, prev.extras );

			stage._pinSeedToFrame = false;

			this._deterministicRestore = null;
			this._deterministic = false;
			this._dispatchPinned = false;

		}

		this.reset();
		this.stopAnimation(); // reset() calls wake(); a manual render loop must not race rAF

		return this._deterministic;

	}

	/** What the engine survived rather than failed on, oldest first. @returns {Object[]} copies */
	get issues() {

		return this._issues.list;

	}

	/** Non-empty means: do not publish this frame. */
	get issueErrors() {

		return this._issues.errors;

	}

	/** Scopes the log to one render on a reused app. */
	clearIssues() {

		this._issues.clear();

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
	 * A frame retired by adaptive sampling stops advancing `frameCount`, so a fixed-count loop
	 * can never reach `count`. `allowEarlyRetire` makes that an outcome instead of a throw.
	 *
	 * @param {number} count - samples to accumulate
	 * @param {Object} [options]
	 * @param {boolean} [options.reset=true] - restart accumulation from sample 0 first
	 * @param {number} [options.yieldEvery=8] - yield to the event loop every N passes (0 disables)
	 * @param {function(number): void} [options.onProgress] - called with the running sample count
	 * @param {boolean} [options.allowEarlyRetire=false]
	 * @returns {Promise<number>} samples accumulated; below `count` only when retired early
	 */
	async renderFrames( count, { reset = true, yieldEvery = 8, onProgress, allowEarlyRetire = false } = {} ) {

		const stage = this.stages.pathTracer;
		if ( ! stage ) throw new Error( 'renderFrames: app is not initialized' );
		if ( ! ( count > 0 ) ) throw new Error( `renderFrames: count must be positive, got ${count}` );

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

		let retiredEarly = false;

		while ( stage.frameCount < target && passes < maxPasses ) {

			if ( this._deviceLost ) throw new Error( 'renderFrames: WebGPU device lost' );
			if ( ! stage.isReady ) throw new Error( 'renderFrames: path tracer stage is not ready' );

			const wait = stage.readbackWait();
			if ( wait ) {

				await this._awaitReadback( wait );
				continue;

			}

			// A host moves the camera between calls, and a load frames it with lookAt(), which leaves matrixWorld stale.
			this.camera.updateMatrixWorld();
			this.pipeline.render();
			passes ++;

			// render() no-ops once complete; spinning would burn the budget for nothing.
			if ( stage.isComplete && stage.frameCount < target ) {

				retiredEarly = true;
				break;

			}

			onProgress?.( stage.frameCount );

			if ( yieldEvery > 0 && passes % yieldEvery === 0 ) {

				await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

			}

		}

		if ( stage.frameCount < target && ! ( retiredEarly && allowEarlyRetire ) ) {

			const cause = retiredEarly
				? 'adaptive sampling retired the frame at the convergence threshold — pass ' +
					'`allowEarlyRetire: true`, or disable it with setDeterministicMode()'
				: 'something retired the render (maxSamples, a stray reset, or a canvas resize)';

			throw new Error(
				`renderFrames: stopped at ${stage.frameCount}/${target} samples after ${passes} passes — ${cause}`
			);

		}

		await this._finishImage();
		return stage.frameCount;

	}

	/**
	 * Renders until the render's own stop condition — the sample ceiling, adaptive convergence or the
	 * time limit, whichever comes first — without requestAnimationFrame, then runs the closing denoise
	 * once. The production counterpart of {@link renderFrames}: adaptive sampling stays on, and its
	 * readbacks run in lockstep (see PathTracer.setLockstepReadbacks), so the same input renders the same
	 * image however fast frames are submitted — except under a time limit, which is wall-clock by nature.
	 * The upscaler does not run. `EngineEvents.RENDER_COMPLETE` fires as it does from the loop.
	 *
	 * @param {Object} [options]
	 * @param {boolean} [options.reset=true] - restart accumulation from sample 0 first
	 * @param {boolean} [options.denoise=true] - run the final OIDN pass when `finalDenoise` is on (PathTracerApp;
	 *   the core has no denoiser)
	 * @param {AbortSignal} [options.signal] - rejects with its reason once aborted
	 * @param {number} [options.drainEvery=4] - every N frames, wait for the GPU to finish the frames
	 *   before the last N, so submissions stay at most 2N frames ahead without the GPU idling
	 * @param {function(number): void} [options.onProgress] - called with the running sample count
	 * @returns {Promise<{samples: number, retiredBy: 'samples'|'converged'|'timeLimit', timeElapsed: number,
	 *   budgetOverrun: boolean, denoised: boolean}>}
	 */
	async renderUntilComplete( { reset = true, denoise = true, signal, drainEvery = 4, onProgress } = {} ) {

		const stage = this.stages.pathTracer;
		if ( ! stage ) throw new Error( 'renderUntilComplete: app is not initialized' );
		if ( this._loadingInProgress || this._sdf?.isProcessing ) throw new Error( 'renderUntilComplete: a scene is still loading' );

		const lockstepWas = stage.lockstepReadbacks;
		stage.setLockstepReadbacks( true );
		// A 100 ms wall-clock mode for camera drags; frames in it do not count, so a batch render has no use for it.
		const interaction = this.settings.getEffective().interactionModeEnabled;
		this.settings.set( 'interactionModeEnabled', false, { silent: true, reset: false } );

		try {

			if ( reset ) this.reset();
			this.stopAnimation();

			const queue = this.renderer.backend.device?.queue;
			let passes = 0;
			let previousBatch = null;

			while ( ! stage.isComplete ) {

				signal?.throwIfAborted();
				if ( this._deviceLost ) throw new Error( 'renderUntilComplete: WebGPU device lost' );
				if ( ! stage.isReady ) throw new Error( 'renderUntilComplete: path tracer stage is not ready' );

				const wait = stage.readbackWait();
				if ( wait ) {

					await this._awaitReadback( wait );
					continue;

				}

				this.camera.updateMatrixWorld();
				const counted = stage.frameCount;
				this._traceFrame();
				onProgress?.( stage.frameCount );

				// A frame that did not count, with no readback to wait on, must still give timers a turn.
				if ( stage.frameCount === counted && ! stage.isComplete ) await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

				if ( queue && drainEvery > 0 && ++ passes % drainEvery === 0 ) {

					const batch = queue.onSubmittedWorkDone();
					if ( previousBatch ) await previousBatch;
					previousBatch = batch;

				}

			}

			const info = this._completionInfo();
			// Before it is announced: a listener reading pixels sees the finished image's exposure.
			await this._finishImage();
			if ( this.completion.markComplete() ) this.dispatchEvent( { type: EngineEvents.RENDER_COMPLETE, ...info } );

			const denoised = denoise ? await this._finalDenoise() : false;
			const { reason, ...rest } = info;
			return { ...rest, retiredBy: reason, denoised };

		} finally {

			stage.setLockstepReadbacks( lockstepWas );
			if ( interaction ) this.settings.set( 'interactionModeEnabled', interaction.value, { silent: true, reset: false, source: interaction.source } );

		}

	}

	/**
	 * What produced the current image, as plain JSON, to keep beside a render: engine and three.js
	 * versions, the adapter, every live setting with its source, the colour pipeline, and the modes that decide
	 * whether the render reproduces.
	 * @returns {Object}
	 */
	getProvenance() {

		const stage = this.stages.pathTracer;
		const color = this.color?.status();

		return toPortable( {
			engine: VERSION,
			three: REVISION,
			adapter: this.adapterInfo ?? null,
			mode: {
				headless: this._headless,
				strict: this._issues.strict,
				deterministic: this.isDeterministic,
				lockstep: !! stage?.accumulationLockstep,
			},
			render: stage ? {
				width: stage.width,
				height: stage.height,
				samples: stage.frameCount,
				complete: stage.isComplete,
				retiredBy: stage.isComplete ? this.completion.stopCondition( stage ) ?? 'samples' : null,
			} : null,
			color: color ? {
				config: color.config?.id ?? null,
				workingSpace: color.workingSpace,
				view: color.activeView ?? color.activeTransform?.id ?? null,
				context: color.context,
			} : null,
			// What the picture was shown at, auto exposure included, and a solid backdrop held apart from it.
			display: {
				exposure: this.renderer?.toneMappingExposure ?? null,
				backdrop: this.pipeline?.context?.getState( 'pathtracer:backdrop' ) ?? null,
				backdropExposure: this.stages?.compositor?.backdropExposure ?? null,
			},
			scene: this.sceneSource,
			settings: this.settings.getEffective(),
			issues: this.issues.map( ( { code, severity } ) => ( { code, severity } ) ),
		} );

	}

	/**
	 * Lockstep readbacks for renders driven by the loop or by {@link renderFrames}:
	 * {@link renderUntilComplete} turns them on for its own duration. See PathTracer.setLockstepReadbacks.
	 * @param {boolean} [enabled=true]
	 */
	setLockstepReadbacks( enabled = true ) {

		this.stages.pathTracer?.setLockstepReadbacks( enabled );

	}

	// A readback that never lands would hold the render forever; a lost device is the one way it can't.
	async _awaitReadback( wait ) {

		const lost = this.renderer.backend.device?.lost;
		const outcome = await ( lost ? Promise.race( [ wait.then( () => null ), lost ] ) : wait );
		if ( outcome ) throw new Error( `WebGPU device lost while awaiting a readback: ${outcome.message ?? outcome.reason}` );

	}

	/**
	 * A render in progress as data: the accumulated colour (and the aux buffers while they hold
	 * samples), the per-pixel convergence buffers, and the counters that choose the next sample.
	 * {@link restoreRenderCheckpoint} continues it — bit-for-bit in deterministic mode, since the
	 * random sequence is a pure function of pixel, frame and seed tick. At 4K it is ~500 MB.
	 * @returns {Promise<?Object>} null before the path tracer exists
	 */
	async captureRenderCheckpoint() {

		const stage = this.stages.pathTracer;
		if ( ! stage ) return null;
		const accumulation = await stage.captureAccumulation();
		return { v: RENDER_CHECKPOINT_VERSION, engine: VERSION, savedAt: Date.now(), samples: accumulation.state.frameCount, ...accumulation };

	}

	/**
	 * Continues a {@link captureRenderCheckpoint}. The scene, settings and render size must be the
	 * ones it was taken with (restore the scene state first), and the scene must have rendered a
	 * frame at that size since it last changed. Anything that resets accumulation afterwards
	 * discards it. Rendering is not restarted: call {@link wake} or {@link renderFrames}.
	 * @param {Object} checkpoint
	 */
	restoreRenderCheckpoint( checkpoint ) {

		if ( checkpoint?.v !== RENDER_CHECKPOINT_VERSION ) throw new Error( `render checkpoint version ${checkpoint?.v} is not ${RENDER_CHECKPOINT_VERSION}` );
		const stage = this.stages.pathTracer;
		if ( ! stage ) throw new Error( 'restoreRenderCheckpoint: app is not initialized' );

		stage.restoreAccumulation( checkpoint );
		this.needsReset = false;
		this.dispatchEvent( { type: EngineEvents.RENDER_RESET, restored: checkpoint.samples } );

	}

	/**
	 * The path tracer's accumulation as pixels, read from its storage target rather than the
	 * canvas — so it works headless, works while the page is hidden, and cannot pick up a
	 * helper overlay.
	 *
	 * This is `pathtracer:color`, NOT the Compositor's resolved output: denoising and
	 * edge filtering are downstream and are absent here. Use getCanvas() when you want what
	 * the viewport shows.
	 *
	 * @param {Object} [options]
	 * @param {string} [options.colorSpace='srgb'] - `'srgb'` for display bytes through the active
	 *   view transform, `'linear'` for the raw working-space accumulation, or the name of a colour
	 *   space in the loaded OCIO config for a delivery buffer (float, e.g. `'ACES2065-1'`)
	 * @param {boolean} [options.preserveAlpha=false] - srgb only: coverage as alpha while the background is
	 *   transparent, else 255. Float readbacks carry coverage then and 1 otherwise, as the canvas shows it.
	 * @param {'accumulation'|'display'} [options.source='accumulation'] - `'display'` reads what the
	 *   viewport is showing — denoised when a denoiser has run — instead of the raw
	 *   accumulation
	 * @param {8|16} [options.bitDepth=8] - srgb only: 16 returns a Uint16Array, rounded to nearest
	 * @returns {Promise<{data: Float32Array|Uint8ClampedArray|Uint16Array, width: number, height: number, colorSpace: string,
	 *   source: string, toneMappedOn?: 'gpu'|'cpu'}>} `source` is what was read: `'accumulation'`, or the
	 *   denoiser that published it (`'oidn'`, `'nrd'`).
	 *   `toneMappedOn` and `displayColorSpace` are set for `'srgb'` only: the bytes are the picture the canvas shows,
	 *   in `'srgb'` or `'display-p3'` — a display the canvas cannot show as it is comes converted.
	 */
	renderToBuffer( options ) {

		return Pictures.renderToBuffer( this, options );

	}

	_readPicture( target, width, height, options ) {

		return Pictures.readPicture( this, target, width, height, options );

	}

	_toneMapOnGPU( shown, accumulation, width, height, tone, output ) {

		return Pictures.toneMapOnGPU( this, shown, accumulation, width, height, tone, output );

	}

	_toneMapFallback( reason, error ) {

		return Pictures.toneMapFallback( this, reason, error );

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
	 * Returns the canvas element holding the image on screen — denoised, graded and tone-mapped,
	 * whatever is currently showing. The upscaler is the one thing that paints elsewhere. While the
	 * screen shows an HDR version, this is a copy holding the view itself, as a saved picture has it.
	 * @returns {HTMLCanvasElement|null}
	 */
	getCanvas() {

		return Pictures.getCanvas( this );

	}

	_pictureCanvas() {

		return Pictures.pictureCanvas( this );

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
	screenshot( options ) {

		return Pictures.screenshot( this, options );

	}

	/**
	 * The picture as a file. PNG, JPEG and WebP hold what the canvas shows — tone-mapped, graded, denoised; a 16-bit
	 * PNG holds the same picture finer. OpenEXR and Radiance HDR hold the light itself, with no exposure or view
	 * applied, in the working space or a delivery space — or with `asShown`, the light the screen emits showing the
	 * picture, so any viewer shows it as the screen does. Works headless and in Node, where JPEG and WebP (written by
	 * the platform's canvas) are missing.
	 *
	 * @param {Object} [options]
	 * @param {'png'|'jpeg'|'webp'|'heic'|'avif'|'exr'|'hdr'} [options.format='png'] - heic and avif go through the
	 *   platform's video encoder (WebCodecs: HEVC, AV1), 8 bits 4:2:0
	 * @param {8|16} [options.bitDepth=8] - png
	 * @param {number} [options.quality=0.92] - jpeg, webp: 0–1
	 * @param {boolean} [options.gainMap=false] - jpeg, heic, avif: an HDR photo — the picture plus a gain map to the HDR
	 *   version the screen shows (ISO 21496-1; Ultra HDR in a JPEG, a 'tmap' item in HEIF), which gain-map viewers show
	 *   in HDR. Needs the screen showing HDR
	 * @param {'half'|'float'} [options.precision='half'] - exr; depth is float either way
	 * @param {boolean} [options.asShown=false] - exr, hdr: the picture as the screen shows it — exposure, view, look and
	 *   display gain applied, then decoded to linear light in the canvas's primaries (1 = SDR white); while the screen
	 *   shows an HDR version, that version, highlights above 1 kept. Extra layers stay as they are
	 * @param {?string} [options.colorSpace] - exr, hdr: a config colour space to deliver in. Omitted, the colour
	 *   management's export space; null, the working space. Not with `asShown`
	 * @param {Array<'albedo'|'normal'|'depth'>} [options.passes] - exr layers beside the picture. Albedo and normal
	 *   are the denoisers' guides, averaged over the samples, so they exist only while a denoiser is on; depth is
	 *   measured when asked for. One that cannot be written records `output.pass_unavailable`
	 * @param {'display'|'accumulation'} [options.source='display'] - the denoised picture when there is one, or the
	 *   raw samples
	 * @param {boolean} [options.upscaled=true] - png at 8 bits, jpeg, webp: the AI upscaler's picture while one shows
	 * @param {boolean} [options.alpha=true] - transparency where the background is transparent (never jpeg, hdr)
	 * @param {boolean|Object<string, string>} [options.metadata=true] - render details in the file (not webp); an
	 *   object adds keys of its own
	 * @returns {Promise<{blob: Blob, mimeType: string, extension: string, width: number, height: number,
	 *   colorSpace: string, source: string, passes: string[]}>} `colorSpace` is what the file holds: 'srgb' or
	 *   'display-p3' for a picture, the colour space's name for light, 'srgb-linear' or 'display-p3-linear' as shown
	 */
	exportImage( options ) {

		return Pictures.exportImage( this, options );

	}

	/**
	 * What {@link exportImage} can write now: the render's size, the upscaled picture's while one shows, whether the
	 * screen shows HDR (an HDR photo needs it), and which EXR layers exist.
	 * @returns {{width: number, height: number, upscaled: ?{width: number, height: number}, hdr: boolean, layers: {albedo: boolean, normal: boolean, depth: boolean}}}
	 */
	exportInfo() {

		return Pictures.exportInfo( this );

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
			.compileAsync( this.meshScene, this.camera )
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

		// Wired from the loop too, which renderFrames never enters: a headless host would miss these categories.
		this._ensureVRAMWiring();
		return this.stages.pathTracer?.vramTracker?.measure() ?? { current: 0, peak: 0, byCategory: {} };

	}

	/**
	 * CPU-side memory for the last scene build: what the preflight predicted, what each phase
	 * allocated, and what was live at each phase boundary.
	 *
	 * Note that `performance.memory.usedJSHeapSize` does NOT count SharedArrayBuffer, and the
	 * triangle and BVH stores are SAB-backed — so the browser's own heap reading under-reports
	 * a large scene by several gigabytes and this is the figure to trust.
	 *
	 * @returns {?{preflight: ?Object, allocatedBytes: number, peakLiveBytes: number,
	 *   byPhase: Object, samples: Object[]}} null before a scene is built
	 */
	getHostMemoryInfo() {

		const sp = this._sdf;
		if ( ! sp?.memory ) return null;
		return { preflight: sp.memoryPreflight, ...sp.memory.report };

	}

	// Idempotent: registers the cross-stage texture provider and re-measures on
	// allocation events (scene/env load, resize) so peak is caught even while idle.
	_ensureVRAMWiring() {

		if ( this._vramWired ) return;
		const tracker = this.stages.pathTracer?.vramTracker;
		if ( ! tracker ) return; // stages not ready yet

		tracker.register( 'stages', () => this._collectStageTextures() );
		this._registerVRAM( tracker );
		// One image per presented surface (a browser may keep one or two more), and the buffer
		// three's output pass tone-maps through.
		tracker.register( 'canvas', () => [
			{ bytes: this.canvas.width * this.canvas.height * 4 },
			...( this.renderer?._frameBufferTargets?.values() ?? [] ),
			...this._canvasResources(),
		] );

		const remeasure = () => tracker.measure();
		this._addTrackedListener( this, EngineEvents.SCENE_REBUILD, remeasure );
		this._addTrackedListener( this, EngineEvents.ENVIRONMENT_LOADED, remeasure );
		this._addTrackedListener( this, EngineEvents.RESOLUTION_CHANGED, remeasure );

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

		return SceneEdits.getMaterialProperty( this, materialIndex, property );

	}

	/**
	 * Where a material property's value came from: `'material'` (the three.js material carried
	 * it), `'mapped'` (converted from a Basic/Lambert/Phong/Toon material), `'default'` (the model
	 * never said; filled from MATERIAL_DEFAULTS) or `'host'` (set through setMaterialProperty).
	 * @param {number} materialIndex
	 * @param {string} property
	 * @returns {string|undefined}
	 */
	getMaterialPropertySource( materialIndex, property ) {

		return SceneEdits.getMaterialPropertySource( this, materialIndex, property );

	}

	setMaterialProperty( materialIndex, property, value ) {

		return SceneEdits.setMaterialProperty( this, materialIndex, property, value );

	}

	_uploadEmissivePayload( payload ) {

		return SceneEdits.uploadEmissivePayload( this, payload );

	}

	_refreshEmissiveForVisibility() {

		return SceneEdits.refreshEmissiveForVisibility( this );

	}

	/**
	 * Explicitly enable/disable emissive-triangle next-event estimation. Marks the
	 * setting as user-controlled so scene rebuilds stop auto-following the scene's
	 * emissive content; the next fresh model load re-arms the auto-default.
	 * @param {boolean} enabled
	 */
	setEmissiveTriangleSampling( enabled ) {

		return SceneEdits.setEmissiveTriangleSampling( this, enabled );

	}

	/**
	 * @returns {boolean} True if the current scene contains emissive geometry
	 * (regardless of per-mesh visibility).
	 */
	hasEmissiveGeometry() {

		return SceneEdits.hasEmissiveGeometry( this );

	}

	/**
	 * Update per-mesh visibility without rebuilding the scene.
	 * Walks the parent chain to resolve world-space visibility.
	 * @param {number} meshIndex
	 * @param {boolean} visible
	 */
	setMeshVisibility( meshIndex, visible ) {

		return SceneEdits.setMeshVisibility( this, meshIndex, visible );

	}

	/**
	 * Recompute world-visibility for all meshes.
	 * Call after changing visibility on groups or parent objects.
	 */
	updateAllMeshVisibility() {

		return SceneEdits.updateAllMeshVisibility( this );

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

		return SceneEdits.setMeshVisibilityByUuid( this, uuid, visible );

	}

	/**
	 * Updates a material's texture transform (offset, repeat, rotation).
	 * @param {number} materialIndex
	 * @param {string} textureName
	 * @param {Object} transform
	 */
	setTextureTransform( materialIndex, textureName, transform ) {

		return SceneEdits.setTextureTransform( this, materialIndex, textureName, transform );

	}

	_displaySource( accumulation ) {

		return Pictures.displaySource( this, accumulation );

	}

	_readDisplaySource( accumulation, width, height ) {

		return Pictures.readDisplaySource( this, accumulation, width, height );

	}

	_readbackPass() {

		return Pictures.readbackPass( this );

	}

	_readTexture( texture, width, height ) {

		return Pictures.readTexture( this, texture, width, height );

	}

	/**
	 * Set what colour space one texture is in, then rebuild so it takes effect.
	 *
	 * The per-image colour space every OCIO application offers. Three kinds of answer:
	 *   - `null`             — automatic: tag, override, the config's file rules, then three.js
	 *   - `'srgb'`/`'linear'` — three.js's own two, which work with no config at all
	 *   - a config space     — anything the loaded config names, including log and camera spaces
	 *
	 * A config space is carried as `userData.ocioColorSpace`, and the texture's three.js colour space
	 * is set to match the colour pool while it is, so harmonization leaves the stored bytes as the
	 * author wrote them — the named transform has to read them raw. The original is kept and put
	 * back when the choice is cleared.
	 *
	 * @param {import('three').Texture} texture
	 * @param {?string} choice
	 */
	setTextureColorSpace( texture, choice ) {

		return SceneEdits.setTextureColorSpace( this, texture, choice );

	}

	/**
	 * Installs a colour-management class in place of the core's basic one — `ColorManagement` from
	 * rayzee/addons/color, the OCIO pipeline. Before init() or after; PathTracerApp installs it itself.
	 * @param {Function} ColorClass - constructed with `{ issues }`
	 */
	setColorManagement( ColorClass ) {

		this.color?.dispose();
		this.color = new ColorClass( { issues: this._issues } );
		setActiveColorManagement( this.color );
		this.color.on?.( 'canvas', () => this._applyCanvasTransform() );
		if ( this.renderer ) this.color.attachRenderer( this.renderer );

	}

	/** The colour pipeline changed what the canvas shows (an HDR version): draw it, without waking an idle loop. */
	_applyCanvasTransform() {

		const compositor = this.stages?.compositor;
		if ( ! compositor ) return;
		compositor.setCanvasTransform( this.color?.canvasTransform ?? null );
		if ( ! compositor.showsCanvasTransform ) this._pictureCopy = null;

		if ( this.animationManagerId ) this._needsDisplayRefresh = true;
		else if ( this.pipeline?.context && ! this._deviceLost ) compositor.render( this.pipeline.context );

	}

	/**
	 * Load a colour config, keeping the scene consistent with it.
	 *
	 * Prefer this to `app.color.loadConfig()` whenever a scene is loaded. A working space adopted
	 * under the previous config is undone first, *while that config is still loaded* — the
	 * environment is converted in place, and only the config that converted it can convert it
	 * back. With `adoptWorkingSpace` the scene is rebuilt in the new space afterwards.
	 *
	 * @param {Object} options - as `ColorManagement.loadConfig`
	 * @returns {Promise<Object>} the config description
	 */
	async loadColorConfig( options = {} ) {

		await this._leaveColorWorkingSpace();
		const shown = getViewTransform( this.renderer?.toneMapping );
		const described = await this.color.loadConfig( options );
		if ( this.color.workingSpaceAdopted ) await this.applyColorWorkingSpace();
		// A baked view the config kept is still what is on screen.
		const kept = shown?.source === 'ocio' && getViewTransform( this.renderer?.toneMapping ) === shown;
		if ( ! kept || this.color.workingSpaceAdopted ) this.reset();
		return described;

	}

	/** Unload the colour config, putting the scene back into linear Rec.709 first. */
	async unloadColorConfig() {

		await this._leaveColorWorkingSpace();
		this.color.unloadConfig();
		this.reset();

	}

	/** @private */
	async _leaveColorWorkingSpace() {

		if ( ! this.color?.workingSpaceAdopted ) return;
		this.color.setWorkingSpace( null );
		await this.applyColorWorkingSpace();

	}

	/**
	 * Rebuild everything the working space touches, after it has been changed.
	 *
	 * Changing what the engine renders in is not a display setting — it changes what every texture,
	 * tint and light colour already loaded *means*. Textures and materials are re-packed from their
	 * pristine three.js sources, so they convert cleanly; the environment is converted where it
	 * lies, from whichever space it currently holds, and its importance-sampling table is rebuilt
	 * because its pixels moved.
	 *
	 * Call this after `app.color.setWorkingSpace()`. Doing nothing instead leaves a scene half in
	 * one space and half in another, which reads as a colour cast with no obvious cause.
	 */
	async applyColorWorkingSpace() {

		const env = this.environmentManager?.getEnvironmentTexture?.();
		let envChanged = false;

		if ( env && this.color?.hasConfig ) {

			try {

				envChanged = this.color.convertTexturePixels( env );

			} catch ( error ) {

				log.warn( `environment colour conversion failed: ${error.message}` );

			}

		}

		// Nothing to rebuild before a scene exists; anything loaded later converts on its way in.
		if ( this.stages.pathTracer?.sdfs ) {

			await this.rebuildMaterials();
			this._uploadEmissivePayload( this._sdf?.rebuildEmissiveColors?.() ?? null );

		}

		if ( envChanged ) await this.environmentManager?.buildEnvironmentCDF?.();
		// Its pixels never leave the GPU, so it is baked again in the new space rather than converted.
		if ( env?._isPhysicalSky ) await this.environmentManager.generateProceduralSkyTexture();
		this.environmentManager?.refreshSun?.();

		this.reset();

	}

	/**
	 * Full material rebuild (required after texture changes).
	 * @param {import('three').Scene} [scene]
	 */
	rebuildMaterials( scene ) {

		return SceneEdits.rebuildMaterials( this, scene );

	}

	// ═══════════════════════════════════════════════════════════════
	// Private — Initialization
	// ═══════════════════════════════════════════════════════════════

	async _initRenderer() {

		setStatusCallback( ( event ) => this.dispatchEvent( event ) );

		if ( typeof navigator === 'undefined' || ! navigator.gpu ) {

			this._issues.fail( ISSUE_CODES.WEBGPU_UNAVAILABLE, 'WebGPU is not available — outside a browser, install one as navigator.gpu (for Node, the `webgpu` package)' );

		}

		let adapter = null;
		let adapterError;
		try {

			adapter = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );

		} catch ( error ) {

			adapterError = error;

		}

		if ( ! adapter ) {

			this._issues.fail( ISSUE_CODES.ADAPTER_UNAVAILABLE, `no WebGPU adapter${adapterError ? ': ' + adapterError.message : ''}`, {}, adapterError );

		}

		this.adapterInfo = describeAdapter( adapter );
		if ( this.adapterInfo.isSoftware ) {

			// Warning: the image is correct, only the cost is wrong.
			this._issues.warn(
				ISSUE_CODES.ADAPTER_SOFTWARE,
				`software GPU adapter "${this.adapterInfo.description || this.adapterInfo.vendor}" — ` +
				'renders are correct but orders of magnitude slower than hardware',
				{ ...this.adapterInfo }
			);
			log.warn( `software GPU adapter — check app.adapterInfo.isSoftware. ${this.adapterInfo.description}` );

		}

		const adapterLimits = adapter.limits;

		// A limit that is NOT requested is granted at WebGPU's portable default, never at the
		// adapter's maximum — on Apple Metal-3 that is 16 sampled textures of 48, 4 storage
		// textures of 8, 256 workgroup invocations of 1024 and 256 array layers of 2048.
		// Requesting exactly what the adapter reports can never fail, so a weaker GPU simply
		// gets less and every consumer has to stay adaptive.
		const requiredLimits = { maxColorAttachmentBytesPerSample: 128 };

		for ( const key of [
			'maxBufferSize',
			'maxStorageBufferBindingSize',
			'maxSampledTexturesPerShaderStage',
			'maxStorageTexturesPerShaderStage',
			'maxTextureArrayLayers',
			'maxTextureDimension2D',
			'maxComputeInvocationsPerWorkgroup',
			'maxComputeWorkgroupStorageSize',
			'maxComputeWorkgroupSizeX',
			'maxComputeWorkgroupSizeY',
			'maxComputeWorkgroupSizeZ',
		] ) {

			const value = adapterLimits[ key ];
			if ( value !== undefined ) requiredLimits[ key ] = value;

		}

		// Shade binds exactly 10 and the kernels are written to that budget; asking for more
		// buys nothing, and 10 is already this adapter's ceiling.
		requiredLimits.maxStorageBuffersPerShaderStage = Math.min( adapterLimits.maxStorageBuffersPerShaderStage, 10 );

		// Requested here rather than by three.js, so a failure is typed where it happens.
		let device;
		try {

			device = await adapter.requestDevice( {
				requiredFeatures: THREE_DEVICE_FEATURES.filter( ( name ) => adapter.features.has( name ) ),
				requiredLimits,
			} );

		} catch ( error ) {

			this._issues.fail( ISSUE_CODES.DEVICE_UNAVAILABLE, `WebGPU device request failed: ${error.message}`, { adapter: { ...this.adapterInfo } }, error );

		}

		this.renderer = new WebGPURenderer( { canvas: this.canvas, alpha: true, device } );

		try {

			await initWithoutFrameLoop( this.renderer, this._headless );

		} catch ( error ) {

			device.destroy();
			throw error;

		}

		// WebGPURenderer swaps in WebGL2 on failure with only a warn(). The wavefront path is
		// compute-only, so every frame would fail against an empty canvas.
		if ( ! this.renderer.backend?.isWebGPUBackend ) {

			device.destroy();
			this._issues.fail(
				ISSUE_CODES.WEBGPU_UNAVAILABLE,
				'three.js fell back to WebGL2, which cannot run the path tracer\'s compute kernels. ' +
				'Check GPU process flags and driver support.'
			);

		}

		// Detect GPU device loss (dGPU/iGPU switch, driver reset, TDR watchdog on heavy
		// compute). Without this the rAF loop keeps calling render() on a dead device,
		// spewing errors forever. reason 'destroyed' during dispose() is intentional teardown.
		//
		// Neither handler may outlive dispose() still holding this app. The device itself does
		// outlive it: three's RenderObjects.dispose() drops its chain maps without disposing
		// the render objects, and its Textures manager leaves a listener on every module-level
		// texture singleton, so backend and device stay reachable for the page's lifetime. A
		// handler capturing `this` therefore pinned the whole app graph — ~120 MiB of triangle,
		// BVH and CPU-side texture data per create/dispose cycle. `lost` is a pending promise
		// whose reaction cannot be unregistered, so it reads the app out of a holder that
		// dispose() empties; `onuncapturederror` is cleared there directly.
		this._gpuDevice = device;
		if ( device.lost ) {

			this._deviceLostHolder = { app: this };
			attachDeviceLostHandler( device, this._deviceLostHolder );
			device.onuncapturederror = ( event ) => log.error( 'WebGPU uncaptured error:', event.error );

		}

		RectAreaLightNode.setLTC( RectAreaLightTexturesLib.init() );

		this.renderer.outputColorSpace = SRGBColorSpace;
		this.renderer.toneMapping = DEFAULT_VIEW;
		this.renderer.toneMappingExposure = 1.0;
		this.renderer.setPixelRatio( 1.0 );

		// Hands every registered view transform to the renderer and keeps `outputColorSpace` in
		// step with whichever is selected — an OCIO view already encoded for its display must not
		// be encoded a second time by the output pass.
		this.color.attachRenderer( this.renderer );

	}

	_initScenes() {

		this.scene = new Scene();
		this.meshScene = new Scene();
		this._sceneHelpers = new SceneHelpers();

	}

	_initAssetPipeline() {

		this._sdf = new SceneProcessor( {
			issues: this._issues,
			layerSink: textureLayerSink( this.renderer ),
			// Spread into defaults, so only pass it when the host actually set one.
			...( this._maxSceneBytes === undefined ? {} : { maxSceneBytes: this._maxSceneBytes } ),
		} );
		this.assetLoader = new AssetLoader( this.meshScene, this.camera, null, {
			issues: this._issues,
			areaLightIntensityScale: () => this.settings.get( 'areaLightIntensityScale' ),
		} );
		this.assetLoader.setRenderer( this.renderer );
		this.assetLoader.createFloorPlane();

	}

	_initPipeline() {

		this._createStages();

		const { clientWidth: w, clientHeight: h } = this.canvas;
		this.pipeline = new RenderPipeline( this.renderer, w || 1, h || 1, { issues: this._issues } );

		this.pipeline.addStage( this.stages.pathTracer );
		for ( const stage of this._extraStages ) this.pipeline.addStage( stage );
		this.pipeline.addStage( this.stages.compositor );

		const initRenderW = this.canvas.clientWidth || 1;
		const initRenderH = this.canvas.clientHeight || 1;
		this._displayWidth = initRenderW;
		this._displayHeight = initRenderH;
		this._renderWidth = initRenderW;
		this._renderHeight = initRenderH;
		this.pipeline.setSize( initRenderW, initRenderH );

	}

	async _initManagers() {

		this.lightManager = new LightManager( this.scene, this._sceneHelpers, this.stages.pathTracer, {
			onReset: () => this.reset(),
			onLightRemoved: light => this._lightRemoved( light ),
		} );

		// Expose environment manager (lives on pathTracer stage)
		this.environmentManager = this.stages.pathTracer.environment;
		this.environmentManager.issues = this._issues;
		this.stages.pathTracer.issues = this._issues;
		this.environmentManager.callbacks.onLightingChanged = () => this.pipeline.eventBus.emit( 'pipeline:lightingChanged' );
		// A whole-app reset, not the stage's: a sky bake lands after its input, often once the loop is idle.
		this.environmentManager.callbacks.onReset = () => this.reset();

	}

	_wireEvents() {

		this.settings.bind( this._settingsBindings() );

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

			// The authored-environment fetch runs through this same AssetLoader, so its 'load'
			// event lands right back here. We install that texture ourselves — without the
			// guard the texture branch below would rebuild the CDF a second time and
			// resetLoading() would tear down the overlay mid-upload. Model events still pass:
			// a user can drop another file while the environment is in flight.
			if ( this._applyingSceneMetadata && event.texture ) return;

			if ( event.model ) {

				// Drag-drop / file load is a replace: clear any appended models first.
				this._clearAppendedModels();
				const built = await this.loadSceneData( { pendingEnvironment: this._beginSceneMetadataEnvironment() } );
				if ( built ) this.assetLoader?.commitPendingGraph( event.model );

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

		this.pipeline.eventBus.on( 'pathtracer:compiling', ( { compiling } ) => this.dispatchEvent( { type: EngineEvents.SHADERS_COMPILING, compiling } ) );

	}

	// ═══════════════════════════════════════════════════════════════
	// Private — Stage creation & setup
	// ═══════════════════════════════════════════════════════════════

	_createStages() {

		this.stages.pathTracer = new PathTracer( this.renderer, this.scene, this.camera, {
			hostMemoryGB: this._hostMemoryGB,
			sortMaterials: this.settings.get( 'wavefrontSortMaterials' ),
		} );
		this._extraStages = this._createExtraStages();
		this.stages.compositor = new Compositor( this.renderer, {
			saturation: this.settings.get( 'saturation' ) ?? DEFAULT_STATE.saturation,
			pathTracer: this.stages.pathTracer,
			displaySources: this._displaySources(),
			canvasTransform: this.color?.canvasTransform ?? null,
		} );

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
			this._completionReopened();

			this.dispatchEvent( { type: EngineEvents.RENDER_RESET } );
			this.wake();

		}

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

	// ═══════════════════════════════════════════════════════════════
	// Hooks — PathTracerApp overrides these. Each runs at a fixed point and does nothing here.
	// ═══════════════════════════════════════════════════════════════

	/** The camera rendered from, made once in init(). */
	_createCamera() {

		const camera = new ViewCamera( 60, this.canvas.clientWidth / this.canvas.clientHeight || 1, 0.01, 1000 );
		camera.position.set( 0, 0, 5 );
		return camera;

	}

	/** Stages run between the path tracer and the compositor, in pipeline order. */
	_createExtraStages() {

		return [];

	}

	/** Context keys of pictures the compositor shows instead of the accumulation, first published wins. */
	_displaySources() {

		return [];

	}

	/** What RenderSettings routes to. */
	_settingsBindings() {

		return {
			stages: this.stages,
			resetCallback: () => this.reset(),
			reconcileCompletion: () => this._reconcileCompletion(),
			// three.js applies it inside the tone-mapping branch, so NoToneMapping ignores it
			applyExposure: ( value ) => {

				this.renderer.toneMappingExposure = value;

			},
		};

	}

	/** Start of a loop frame, before a pending reset applies. */
	_beginFrame() {}

	/** Just before a loop frame traces. */
	_beforeTrace() {}

	/** True skips tracing this loop frame. */
	_holdTrace( /* cameraMoved */ ) {

		return false;

	}

	/** After every traced frame; `live` from the render loop. */
	_afterTrace( /* stage, live */ ) {}

	/** Once, on the loop frame the render completes. */
	_renderCompleted() {}

	/** True keeps the loop running over a finished render, to redraw what is still changing. */
	_settling() {

		return false;

	}

	/** A render has its samples, before any closing pass or announcement: a promise to wait for, or null. */
	_finishImage() {

		return null;

	}

	/** Draws what sits over the image. Here only brings the light scene's matrices up to date. */
	_renderHelperOverlay() {

		this.scene.updateMatrixWorld();

	}

	/** Before accumulation restarts; `keepHistory` for a soft or motion reset. */
	_beforeReset( /* keepHistory */ ) {}

	/** After the pipeline restarted accumulation. */
	_afterReset() {}

	/** The picture shown no longer matches the scene. */
	_dropDisplay() {}

	/** The scene is about to be rebuilt, unloaded or lose an object. */
	_releaseSceneState( /* { keepSelection } */ ) {}

	/** A replace-load landed its model, before the rebuild. */
	_modelReplaced() {}

	/** After a replace-load's event was dispatched. */
	_modelAnnounced() {}

	/** End of a scene rebuild, before SCENE_REBUILD. */
	_sceneRebuilt() {}

	/** An append or removal changed the scene's bounds without reframing it. */
	_sceneBoundsChanged() {}

	/** Placements of these meshes are about to move. */
	_notePlacementsMoving( /* meshIndices */ ) {}

	/** A light was removed. */
	_lightRemoved( /* light */ ) {}

	/** The render size changed (before the render scale). */
	_renderSizeChanged( /* width, height */ ) {}

	/** The sample limit rose above a finished render, which resumes. */
	_completionReopened() {}

	/** renderUntilComplete()'s closing pass; resolves whether one ran. */
	async _finalDenoise() {

		return false;

	}

	/**
	 * A per-pixel gain the shown picture carries before the view (the compositor's), for tone-mapped readbacks; or null.
	 * Its `backdrop`, when set, is the gain a solid backdrop is held at (`PackedToneMapper`'s `gain`).
	 */
	_displayGain() {

		return null;

	}

	/** Whether a 'display' read should find a processed picture. */
	_denoiserInUse() {

		return false;

	}

	/** A canvas other than the renderer's that shows the image, or null. */
	_displayCanvas() {

		return null;

	}

	/** More VRAM categories, between 'stages' and 'canvas'. */
	_registerVRAM( /* tracker */ ) {}

	/** GPU resources counted with the canvas. */
	_canvasResources() {

		return [];

	}

	/** Deterministic mode: what to put back when it ends. */
	_deterministicSnapshot() {

		return null;

	}

	/** Deterministic mode: pin (enabled), or put back from the snapshot. */
	_setDeterministicExtras( /* enabled, snapshot */ ) {}

	/** Frees what a layer above built, before the core's own teardown. */
	_disposeExtensions() {}

}
