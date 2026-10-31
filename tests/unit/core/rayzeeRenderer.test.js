import { describe, it, expect, vi, afterEach } from 'vitest';
import { BoxGeometry, Box3, Mesh, MeshBasicMaterial, Object3D, Scene, Texture, Vector3 } from 'three';
import Animation from 'three/src/renderers/common/Animation.js';
import { RayzeeRenderer, disposeRenderer, takeFrameStep } from '@/core/RayzeeRenderer.js';
import { RenderStage } from '@/core/pipeline/RenderStage.js';
import { CompletionTracker } from '@/core/pipeline/CompletionTracker.js';
import { EngineEvents, setStatusCallback } from '@/core/EngineEvents.js';
import { IssueLog, ISSUE_CODES } from '@/core/EngineIssues.js';
import { BVH_LEAF_MARKERS, BVH_MAX_INDEX } from '@/core/scene/BufferLayout.js';
import { MAX_SCENE_BYTES } from '@/core/memory/HostMemory.js';
import { setReservedRenderSize, MAX_RESERVABLE_RENDER_SIZE } from '@/core/pathtracer/StorageTexturePool.js';

const flush = () => new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
const canvas = ( width = 800, height = 400 ) => ( { clientWidth: width, clientHeight: height, width, height } );

function core( extra = {} ) {

	const events = [];
	return Object.assign( Object.create( RayzeeRenderer.prototype ), {
		events,
		_issues: new IssueLog(),
		_headless: false,
		_deviceLost: false,
		_paused: false,
		_disposed: false,
		isInitialized: true,
		animationManagerId: null,
		_trackedListeners: [],
		completion: new CompletionTracker(),
		stages: {},
		dispatchEvent: ( event ) => void events.push( event ),
		...extra,
	} );

}

const types = ( app ) => app.events.map( e => e.type );

afterEach( () => {

	setStatusCallback( null );
	setReservedRenderSize( 2048 );
	vi.unstubAllGlobals();
	vi.useRealTimers();

} );

describe( 'disposeRenderer', () => {

	it( 'removes the canvas-target resize listener three.js leaves behind, and hands back its teardown', async () => {

		const target = { removeEventListener: vi.fn() };
		const onResize = () => {};

		let seen;
		// r187's dispose() reaches the canvas target after an await.
		const renderer = { _canvasTarget: target, _onCanvasTargetResize: onResize, async dispose() {

			await null;
			seen = this._canvasTarget;
			return 'gone';

		} };

		await expect( disposeRenderer( renderer ) ).resolves.toBe( 'gone' );
		expect( seen ).toBe( target );
		expect( target.removeEventListener ).toHaveBeenCalledWith( 'resize', onResize );
		expect( renderer._canvasTarget ).toBeNull();
		expect( disposeRenderer( null ) ).toBeUndefined();

	} );

} );

describe( 'constructing a renderer', () => {

	it( 'owns its canvas alone: a second renderer on it disposes the first', () => {

		const shared = canvas();
		const first = new RayzeeRenderer( shared );
		const second = new RayzeeRenderer( shared );

		expect( first._disposed ).toBe( true );
		expect( second._disposed ).toBe( false );

		second.dispose = () => {

			throw new Error( 'teardown failed' );

		};

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		expect( () => new RayzeeRenderer( shared ) ).not.toThrow();
		expect( warn.mock.calls.some( ( [ message ] ) => message.includes( 'prior canvas owner dispose failed' ) ) ).toBe( true );
		warn.mockRestore();

	} );

	it( 'is headless without a canvas, and listens for window resizes only with one', () => {

		expect( new RayzeeRenderer( null )._autoResize ).toBe( false );
		expect( new RayzeeRenderer( canvas() )._autoResize ).toBe( true );
		expect( new RayzeeRenderer( canvas(), { autoResize: false } )._autoResize ).toBe( false );
		expect( new RayzeeRenderer( canvas(), { headless: true } )._headless ).toBe( true );

	} );

	it( 'takes the memory spill as auto, true or false', () => {

		expect( new RayzeeRenderer( null ).memorySpill ).toBe( 'auto' );
		expect( new RayzeeRenderer( null, { memorySpill: true } ).memorySpill ).toBe( true );
		expect( new RayzeeRenderer( null, { memorySpill: false } ).memorySpill ).toBe( false );
		expect( new RayzeeRenderer( null, { memorySpill: 'yes' } ).memorySpill ).toBe( 'auto' );

	} );

	it( 'starts empty: no scene, no frames, nothing loading', () => {

		const app = new RayzeeRenderer( null );
		expect( app.sceneMeshes ).toEqual( [] );
		expect( app.sceneModel ).toBeNull();
		expect( app.sceneSource ).toBeNull();
		expect( app.sceneMetadata ).toBeNull();
		expect( app.getFrameCount() ).toBe( 0 );
		expect( app.isComplete() ).toBe( false );
		expect( app.isLoading ).toBe( false );
		expect( app.getConvergenceStats() ).toBeNull();
		expect( app.vram ).toBeNull();
		expect( app.getStatistics() ).toBeNull();
		expect( app.getHostMemoryInfo() ).toBeNull();
		expect( app.getMemoryInfo() ).toEqual( { current: 0, peak: 0, byCategory: {} } );
		expect( app.sceneSpilled ).toBe( false );
		expect( app.geometryOnDisk ).toBe( false );
		expect( app.setDeterministicMode() ).toBe( false );
		expect( app.getScene() ).toBeNull();

	} );

} );

describe( 'dispose', () => {

	function built() {

		const app = new RayzeeRenderer( canvas() );
		let teardown;
		app.renderer = { dispose: vi.fn( () => new Promise( ( resolve ) => void ( teardown = resolve ) ) ) };
		app._gpuDevice = { destroy: vi.fn(), onuncapturederror: () => {} };
		app._deviceLostHolder = { app };
		return { app, finishTeardown: () => teardown() };

	}

	it( 'tears down once, and destroys its device only after three.js has finished with it', async () => {

		const { app, finishTeardown } = built();
		const device = app._gpuDevice;
		const holder = app._deviceLostHolder;
		const disposed = vi.fn();
		app.addEventListener( EngineEvents.DISPOSE, disposed );

		app.dispose();
		app.dispose();

		expect( disposed ).toHaveBeenCalledOnce();
		expect( device.onuncapturederror ).toBeNull();
		expect( holder.app ).toBeNull();
		expect( app.renderer ).toBeNull();
		expect( app.stages ).toEqual( {} );
		expect( app.isInitialized ).toBe( false );

		await flush();
		expect( device.destroy ).not.toHaveBeenCalled();
		finishTeardown();
		await flush();
		expect( device.destroy ).toHaveBeenCalledOnce();

	} );

	it( 'lets go of everything that would keep it alive', () => {

		const { app } = built();
		const target = new EventTarget();
		const handler = vi.fn();
		app._addTrackedListener( target, 'ping', handler );
		app._addTrackedListener( null, 'ping', handler );
		app._addTrackedListener( { addEventListener() {}, removeEventListener() {

			throw new Error( 'already gone' );

		} }, 'ping', handler );
		const issued = vi.fn();
		app.addEventListener( EngineEvents.ISSUE, issued );
		const release = vi.fn();
		Object.assign( app, { storage: {}, _storageRelease: release, _sceneSource: { kind: 'url' }, _sceneSourceInput: {} } );
		const mappers = [ { dispose: vi.fn() } ];
		app._readbackToneMappers = new Map( [[ 'rgba8', mappers[ 0 ] ]] );
		app._textureReadback = { dispose: vi.fn() };
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

		app.dispose();

		expect( warn.mock.calls.some( ( [ message ] ) => message.includes( 'failed to remove listener' ) ) ).toBe( true );
		warn.mockRestore();
		target.dispatchEvent( new Event( 'ping' ) );
		expect( handler ).not.toHaveBeenCalled();
		app._issues.record( ISSUE_CODES.STORAGE_UNAVAILABLE, 'late' );
		expect( issued ).not.toHaveBeenCalled();
		expect( release ).toHaveBeenCalledOnce();
		expect( app.storage ).toBeNull();
		expect( app.sceneSource ).toBeNull();
		expect( mappers[ 0 ].dispose ).toHaveBeenCalledOnce();
		expect( app._textureReadback ).toBeNull();
		expect( app.color ).toBeNull();

	} );

	it( 'frees the scene, its environment and a pending resize', () => {

		vi.useFakeTimers();
		const { app } = built();
		const environment = new Texture();
		const geometry = new BoxGeometry();
		const freed = vi.fn();
		geometry.addEventListener( 'dispose', freed );
		app.meshScene = new Scene();
		app.meshScene.environment = environment;
		app.meshScene.add( new Mesh( geometry, new MeshBasicMaterial() ) );
		const envFreed = vi.spyOn( environment, 'dispose' );
		app._applyRenderResize = vi.fn();
		app._resizeDebounceTimer = setTimeout( () => app._applyRenderResize(), 300 );

		app.dispose();
		vi.advanceTimersByTime( 1000 );

		expect( envFreed ).toHaveBeenCalledOnce();
		expect( freed ).toHaveBeenCalledOnce();
		expect( app.meshScene ).toBeNull();
		expect( app._applyRenderResize ).not.toHaveBeenCalled();

	} );

} );

describe( 'on-disk storage', () => {

	it( 'uses a storage the host hands it, forwarding its changes and issues', async () => {

		const storage = new EventTarget();
		const app = core( { _storageOption: storage, _storageOpener: null } );
		await app._initStorage();

		expect( app.storage ).toBe( storage );
		storage.dispatchEvent( Object.assign( new Event( 'change' ), { area: 'scenes' } ) );
		storage.dispatchEvent( Object.assign( new Event( 'issue' ), { code: ISSUE_CODES.STORAGE_WRITE_FAILED, message: 'quota', detail: { area: 'cache' } } ) );
		expect( app.events ).toEqual( [ { type: EngineEvents.STORAGE_CHANGED, area: 'scenes' } ] );
		expect( app._issues.list ).toMatchObject( [ { code: ISSUE_CODES.STORAGE_WRITE_FAILED, severity: 'warning', detail: { area: 'cache' } } ] );

	} );

	it( 'says why it is off when the opener finds none', async () => {

		const app = core( { _storageOption: 'auto', storage: null, _storageOpener: async () => ( { storage: null, reason: 'private window' } ) } );
		await app._initStorage();
		expect( app.storage ).toBeNull();
		expect( app._issues.list ).toMatchObject( [ { code: ISSUE_CODES.STORAGE_UNAVAILABLE, detail: { reason: 'private window' } } ] );

	} );

	it( 'hands back storage that opened after it was disposed', async () => {

		const release = vi.fn();
		const app = core( { _storageOption: 'auto', storage: null } );
		app._storageOpener = async () => {

			app._disposed = true;
			return { storage: new EventTarget(), release };

		};

		await app._initStorage();
		expect( release ).toHaveBeenCalledOnce();
		expect( app.storage ).toBeNull();

	} );

	it( 'opens through an opener installed after init, for the asset loader too', async () => {

		const storage = new EventTarget();
		const opener = vi.fn( async () => ( { storage, release: () => {} } ) );
		const app = core( { _storageOption: 'auto', storage: null, assetLoader: {} } );

		app.isInitialized = false;
		await app.setStorageOpener( opener );
		expect( opener ).not.toHaveBeenCalled();

		app.isInitialized = true;
		await app.setStorageOpener( opener );
		expect( app.storage ).toBe( storage );
		expect( app.assetLoader.storage ).toBe( storage );

		await app.setStorageOpener( opener );
		expect( opener ).toHaveBeenCalledOnce();

	} );

} );

describe( 'the render loop', () => {

	function looping( { ceiling = 3, ...extra } = {} ) {

		vi.stubGlobal( 'requestAnimationFrame', vi.fn( () => 7 ) );
		vi.stubGlobal( 'cancelAnimationFrame', vi.fn() );
		const order = [];
		const stage = {
			isReady: true, isComplete: false, frameCount: 0, completionThreshold: ceiling, resetCount: 0,
			readbackWait: () => null,
			noteViewChanged: vi.fn( () => void order.push( 'viewChanged' ) ),
		};
		const app = core( {
			order,
			stage,
			_loadingInProgress: false,
			_pathTracerEnabled: true,
			pauseRendering: false,
			needsReset: false,
			_needsDisplayRefresh: false,
			_vramWired: true,
			stages: { pathTracer: stage, compositor: { render: vi.fn() } },
			pipeline: {
				context: {},
				render: vi.fn( () => {

					order.push( 'trace' );
					stage.frameCount ++;
					if ( stage.frameCount >= stage.completionThreshold ) stage.isComplete = true;

				} ),
			},
			settings: { get: () => undefined },
			camera: { updateMatrixWorld: vi.fn() },
			scene: { updateMatrixWorld: vi.fn() },
			meshScene: 'the mesh scene',
			renderer: { render: vi.fn() },
			...extra,
		} );
		return { app, stage, order };

	}

	// three's frame loop, stopped as init leaves it, asking a context that records its requests.
	function frameLoop() {

		const requested = [];
		const cancelled = [];
		const nodes = { nodeFrame: { frameId: 0, update() {

			this.frameId ++;

		} } };
		const info = { autoReset: true, frame: 0, reset: vi.fn() };
		const renderer = { render: vi.fn(), _inspector: { isRunning: false, begin() {}, finish() {} } };
		renderer._animation = new Animation( renderer, nodes, info );
		renderer._animation.setContext( { requestAnimationFrame: ( step ) => requested.push( step ), cancelAnimationFrame: ( id ) => void cancelled.push( id ) } );
		return { renderer, info, requested, cancelled };

	}

	it( 'takes three\'s frame step itself, leaving no frame of three\'s requested', () => {

		const { renderer, info, requested, cancelled } = frameLoop();
		takeFrameStep( renderer );
		takeFrameStep( renderer );
		expect( info.frame ).toBe( 2 );
		expect( info.reset ).toHaveBeenCalledTimes( 2 );
		expect( cancelled ).toEqual( [ 1, 2 ] );
		expect( renderer._animation._requestId ).toBeNull();

		// A loop someone started again takes its own steps.
		renderer._animation.start();
		takeFrameStep( renderer );
		expect( info.frame ).toBe( 3 );
		expect( requested ).toHaveLength( 3 );

	} );

	it( 'takes a frame step each loop frame', () => {

		const { renderer, info } = frameLoop();
		const { app } = looping( { renderer } );
		app.animate();
		app.animate();
		expect( info.frame ).toBe( 2 );
		expect( renderer._animation._requestId ).toBeNull();

	} );

	it( 'traces a frame and keeps the loop scheduled', () => {

		const { app, stage } = looping();
		app.animate();
		expect( stage.frameCount ).toBe( 1 );
		expect( app.animationManagerId ).toBe( 7 );
		expect( types( app ) ).toEqual( [ EngineEvents.FRAME ] );

	} );

	it( 'announces a finished render once, after its picture is finished', async () => {

		let finished;
		const { app } = looping( { ceiling: 1 } );
		app._finishImage = () => new Promise( ( resolve ) => void ( finished = resolve ) );
		app._renderCompleted = vi.fn();

		app.animate();
		expect( types( app ) ).not.toContain( EngineEvents.RENDER_COMPLETE );
		finished();
		await flush();

		const complete = app.events.filter( e => e.type === EngineEvents.RENDER_COMPLETE );
		expect( complete ).toMatchObject( [ { samples: 1, reason: 'samples' } ] );
		expect( app._renderCompleted ).toHaveBeenCalledOnce();

	} );

	it( 'does not announce a render restarted while its picture was finishing', async () => {

		let finished;
		const { app, stage } = looping( { ceiling: 1 } );
		app._finishImage = () => new Promise( ( resolve ) => void ( finished = resolve ) );

		app.animate();
		stage.resetCount ++;
		finished();
		await flush();
		expect( types( app ) ).not.toContain( EngineEvents.RENDER_COMPLETE );

	} );

	it( 'stops itself once a finished render is shown, after one requested redraw', () => {

		const { app, stage } = looping();
		Object.assign( stage, { isComplete: true } );
		app.completion.markComplete();
		app._needsDisplayRefresh = true;

		app.animate();

		expect( app.stages.compositor.render ).toHaveBeenCalledOnce();
		expect( app._needsDisplayRefresh ).toBe( false );
		expect( cancelAnimationFrame ).toHaveBeenCalledWith( 7 );
		expect( app.animationManagerId ).toBeNull();
		expect( app.pipeline.render ).not.toHaveBeenCalled();

	} );

	it( 'keeps running over a finished render while the viewer settles it', () => {

		const { app, stage } = looping();
		stage.isComplete = true;
		app.completion.markComplete();
		app._settling = () => true;

		app.animate();
		expect( cancelAnimationFrame ).not.toHaveBeenCalled();
		expect( types( app ) ).toEqual( [ EngineEvents.FRAME ] );

	} );

	it( 'applies a reset the camera asked for before tracing, telling the stage the view moved', () => {

		const { app, order } = looping();
		app.needsReset = true;
		app.reset = vi.fn( () => void order.push( 'reset' ) );
		app._holdTrace = vi.fn( () => false );

		app.animate();

		expect( order ).toEqual( [ 'viewChanged', 'reset', 'trace' ] );
		expect( app.reset ).toHaveBeenCalledWith( true );
		expect( app.needsReset ).toBe( false );
		expect( app._holdTrace ).toHaveBeenCalledWith( true );

	} );

	it.each( [
		[ 'a load runs', ( app ) => void ( app._loadingInProgress = true ), [ EngineEvents.FRAME ]],
		[ 'the scene is processing', ( app ) => void ( app._sdf = { isProcessing: true } ), [ EngineEvents.FRAME ]],
		[ 'rendering is paused', ( app ) => void ( app.pauseRendering = true ), []],
		[ 'a readback is due', ( app ) => void ( app.stage.readbackWait = () => Promise.resolve() ), [ EngineEvents.FRAME ]],
		[ 'the viewer holds the trace', ( app ) => void ( app._holdTrace = () => true ), [ EngineEvents.FRAME ]],
	] )( 'traces nothing while %s', ( _, setup, events ) => {

		const { app } = looping();
		setup( app );
		app.animate();
		expect( app.pipeline.render ).not.toHaveBeenCalled();
		expect( types( app ) ).toEqual( events );

	} );

	it( 'rasters the scene while path tracing is off', () => {

		const { app } = looping();
		app._pathTracerEnabled = false;
		app.animate();
		expect( app.renderer.render ).toHaveBeenCalledWith( 'the mesh scene', app.camera );
		expect( app.pipeline.render ).not.toHaveBeenCalled();

	} );

	it( 'marks a render that ran out of time complete', () => {

		const { app, stage } = looping( { ceiling: 100 } );
		app.settings = { get: ( key ) => ( { renderLimitMode: 'time', renderTimeLimit: 1 } )[ key ] };
		app.completion.lastResetTime = performance.now() - 5000;

		app.animate();
		expect( stage.isComplete ).toBe( true );
		expect( app.completion.stopCondition( stage ) ).toBe( 'timeLimit' );

	} );

	it( 'measures GPU memory at the start of a burst and every 30th frame, not every frame', () => {

		const { app, stage } = looping( { ceiling: 100 } );
		stage.vramTracker = { measure: vi.fn(), current: 0, peak: 0 };
		for ( let i = 0; i < 61; i ++ ) app.animate();
		expect( stage.vramTracker.measure ).toHaveBeenCalledTimes( 3 );

	} );

	it( 'never schedules on a lost device, and has no loop headless', () => {

		const { app } = looping();
		app._deviceLost = true;
		app.animate();
		expect( requestAnimationFrame ).not.toHaveBeenCalled();

		app._headless = true;
		expect( () => app.animate() ).toThrow( /renderFrames\(\) or renderUntilComplete\(\)/ );

	} );

	it( 'stops on a lost device once, and tells the host', () => {

		const { app } = looping();
		app.animationManagerId = 3;
		app._handleDeviceLost( { reason: 'unknown', message: 'TDR' } );
		app._handleDeviceLost( { reason: 'unknown', message: 'again' } );

		expect( app._deviceLost ).toBe( true );
		expect( cancelAnimationFrame ).toHaveBeenCalledWith( 3 );
		expect( app.events ).toEqual( [ { type: EngineEvents.DEVICE_LOST, reason: 'unknown', message: 'TDR' } ] );

	} );

	it( 'wakes an idle loop, but not a paused, lost or headless one', () => {

		const { app } = looping();
		app.animate = vi.fn();
		app.wake();
		expect( app.animate ).toHaveBeenCalledOnce();

		app.pause();
		app.wake();
		expect( app.animate ).toHaveBeenCalledOnce();
		app.resume();
		expect( app.animate ).toHaveBeenCalledTimes( 2 );

		app._deviceLost = true;
		app.wake();
		app._deviceLost = false;
		app._headless = true;
		app.wake();
		app.resume();
		expect( app.animate ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'asks for a redraw and wakes the loop for it', () => {

		const { app } = looping();
		app.animate = vi.fn();
		app.refreshFrame();
		expect( app._needsDisplayRefresh ).toBe( true );
		expect( app.animate ).toHaveBeenCalledOnce();

	} );

} );

describe( 'reset', () => {

	function resettable() {

		const app = core( {
			pipeline: { reset: vi.fn(), eventBus: { emit: vi.fn() } },
			stages: { pathTracer: { noteViewChanged: vi.fn() } },
			_beforeReset: vi.fn(),
			wake: vi.fn(),
		} );
		app.completion.markComplete();
		return app;

	}

	it( 'restarts accumulation, drops denoiser history and reopens a finished render', () => {

		const app = resettable();
		app.reset();

		expect( app.pipeline.reset ).toHaveBeenCalledOnce();
		expect( app.pipeline.eventBus.emit ).toHaveBeenCalledWith( 'pipeline:historyReset' );
		expect( app._beforeReset ).toHaveBeenCalledWith( false );
		expect( app.completion.renderCompleteDispatched ).toBe( false );
		expect( app.wake ).toHaveBeenCalledOnce();
		expect( types( app ) ).toEqual( [ EngineEvents.RENDER_RESET ] );

	} );

	it( 'keeps history through a soft reset, and through moving objects tells the stage the view changed', () => {

		const app = resettable();
		app.reset( true );
		expect( app.pipeline.eventBus.emit ).not.toHaveBeenCalled();
		expect( app._beforeReset ).toHaveBeenLastCalledWith( true );

		app.reset( false, { motion: true } );
		expect( app.stages.pathTracer.noteViewChanged ).toHaveBeenCalledOnce();
		expect( app._beforeReset ).toHaveBeenLastCalledWith( true );

	} );

	it( 'works before a pipeline exists', () => {

		const app = resettable();
		app.pipeline = null;
		expect( () => app.reset() ).not.toThrow();
		expect( types( app ) ).toEqual( [ EngineEvents.RENDER_RESET ] );

	} );

} );

describe( 'unloadScene', () => {

	function loaded() {

		const pathTracer = {
			setTriangleData: vi.fn(), setBVHData: vi.fn(), setEmissiveTriangleData: vi.fn(), setupMaterial: vi.fn(),
			materialData: { setMaterialData: vi.fn() },
		};
		return core( {
			_loadingInProgress: false,
			_sceneSource: { kind: 'url' },
			_sceneSourceInput: {},
			_releaseSceneState: vi.fn(),
			_dropDisplay: vi.fn(),
			reset: vi.fn(),
			assetLoader: { releaseTargetModel: vi.fn() },
			lightManager: { clearLights: vi.fn() },
			stages: { pathTracer },
		} );

	}

	it( 'leaves an empty scene whose tree is a leaf, not a node that contains itself', () => {

		const app = loaded();
		app.unloadScene();

		const nodes = app.stages.pathTracer.setBVHData.mock.calls[ 0 ][ 0 ];
		const tag = new Uint32Array( nodes.buffer )[ 3 ];
		expect( tag ).toBe( BVH_LEAF_MARKERS.TRIANGLE_LEAF );
		expect( tag ).toBeGreaterThanOrEqual( BVH_MAX_INDEX );
		expect( app.stages.pathTracer.setTriangleData.mock.calls[ 0 ][ 1 ] ).toBe( 0 );
		expect( app.stages.pathTracer.setEmissiveTriangleData ).toHaveBeenCalledWith( expect.any( Float32Array ), 0, 0 );
		expect( app.stages.pathTracer.setupMaterial ).toHaveBeenCalledOnce();
		expect( app.assetLoader.releaseTargetModel ).toHaveBeenCalledOnce();
		expect( app.lightManager.clearLights ).toHaveBeenCalledOnce();
		expect( app.sceneSource ).toBeNull();
		expect( app._dropDisplay ).toHaveBeenCalledOnce();
		expect( app.reset ).toHaveBeenCalledOnce();
		expect( types( app ) ).toEqual( [ EngineEvents.SCENE_UNLOADED ] );

	} );

	it( 'refuses mid-load, and does nothing before init or after dispose', () => {

		const app = loaded();
		app._loadingInProgress = true;
		expect( () => app.unloadScene() ).toThrow( /while a load is in progress/ );

		app._loadingInProgress = false;
		app.isInitialized = false;
		app.unloadScene();
		app.isInitialized = true;
		app._disposed = true;
		app.unloadScene();
		expect( app.assetLoader.releaseTargetModel ).not.toHaveBeenCalled();
		expect( app.events ).toEqual( [] );

	} );

} );

describe( 'the reserved render size', () => {

	const GB = 1024 * 1024 * 1024;

	function reserving( built = 2048, backing = { width: 3000, height: 1000 } ) {

		vi.stubGlobal( 'navigator', {} );
		const stage = ( name ) => ( { name, reallocateReservedStorage: vi.fn() } );
		const app = core( {
			_hostMemoryGB: 16,
			pauseRendering: false,
			reset: vi.fn(),
			renderer: {
				backend: { device: { limits: { maxStorageBufferBindingSize: 2 * GB } } },
				domElement: backing,
				setSize: vi.fn(),
			},
			stages: {
				pathTracer: { ...stage( 'pathTracer' ), builtReserve: built },
				compositor: stage( 'compositor' ),
			},
		} );
		for ( const s of Object.values( app.stages ) ) {

			s.reallocateReservedStorage.mockImplementation( () => void s.pausedDuring.push( app.pauseRendering ) );
			s.pausedDuring = [];

		}

		return app;

	}

	it( 'records a request made before the device exists, and replays it at init with the device\'s answer', () => {

		const app = core( { renderer: null, _pendingReservedRenderSize: null } );
		expect( app.setReservedRenderResolution( 100 ) ).toBe( 2048 );
		expect( app.setReservedRenderResolution( 99999 ) ).toBe( MAX_RESERVABLE_RENDER_SIZE );
		expect( app._pendingReservedRenderSize ).toEqual( { requestedPx: 99999, allowLower: false } );

		app.setReservedRenderResolution = vi.fn( () => 4096 );
		app._applyPendingReservedRenderSize();
		expect( app.setReservedRenderResolution ).toHaveBeenCalledWith( 99999, { allowLower: false } );
		expect( app.events ).toEqual( [ { type: EngineEvents.RESERVED_RENDER_SIZE_CHANGED, size: 4096 } ] );
		expect( app._pendingReservedRenderSize ).toBeNull();

		app._applyPendingReservedRenderSize();
		expect( app.setReservedRenderResolution ).toHaveBeenCalledOnce();

	} );

	it( 'reallocates every stage\'s reserve with rendering paused, after shrinking the canvas to fit', () => {

		const app = reserving( 4096 );
		setReservedRenderSize( 4096 );

		expect( app.setReservedRenderResolution( 2048, { allowLower: true } ) ).toBe( 2048 );

		expect( app.renderer.setSize ).toHaveBeenCalledWith( 2048, 1000, false );
		expect( app.stages.pathTracer.pausedDuring ).toEqual( [ true ] );
		expect( app.stages.compositor.pausedDuring ).toEqual( [ true ] );
		expect( app.pauseRendering ).toBe( false );
		expect( app.reset ).toHaveBeenCalledOnce();
		expect( app.events ).toEqual( [ { type: EngineEvents.RESERVED_RENDER_SIZE_CHANGED, size: 2048 } ] );
		expect( app.getReservedRenderResolution() ).toBe( 2048 );

	} );

	it( 'only grows unless told it may shrink, and reallocates nothing already at that size', () => {

		const app = reserving( 4096 );
		setReservedRenderSize( 4096 );

		expect( app.setReservedRenderResolution( 1024 ) ).toBe( 4096 );
		expect( app.stages.pathTracer.reallocateReservedStorage ).not.toHaveBeenCalled();
		expect( app.events ).toEqual( [] );

	} );

	it( 'reallocates once a raise lands on buffers built at the old size', () => {

		const app = reserving( 2048 );
		app.pauseRendering = true;
		expect( app.setReservedRenderResolution( 4096 ) ).toBe( 4096 );
		expect( app.stages.pathTracer.reallocateReservedStorage ).toHaveBeenCalledOnce();
		expect( app.renderer.setSize ).not.toHaveBeenCalled();
		expect( app.pauseRendering ).toBe( true );

	} );

	it( 'rebuilds nothing before the first build, and still says the reserve moved', () => {

		const app = reserving( null, { width: 800, height: 600 } );
		expect( app.setReservedRenderResolution( 4096 ) ).toBe( 4096 );
		expect( app.stages.pathTracer.reallocateReservedStorage ).not.toHaveBeenCalled();
		expect( app.reset ).not.toHaveBeenCalled();
		expect( app.events ).toEqual( [ { type: EngineEvents.RESERVED_RENDER_SIZE_CHANGED, size: 4096 } ] );

	} );

	it( 'shrinks a canvas larger than a lowered reserve even before the first build', () => {

		const app = reserving( null );
		setReservedRenderSize( 4096 );
		expect( app.setReservedRenderResolution( 2048, { allowLower: true } ) ).toBe( 2048 );
		expect( app.renderer.setSize ).toHaveBeenCalledWith( 2048, 1000, false );
		expect( app.stages.pathTracer.reallocateReservedStorage ).toHaveBeenCalledOnce();

	} );

} );

describe( 'resizing', () => {

	function sized( extra = {} ) {

		return core( {
			canvas: canvas( 800, 400 ),
			_renderScale: 1,
			_renderWidth: 800,
			_renderHeight: 400,
			renderer: { setPixelRatio: vi.fn(), setSize: vi.fn() },
			camera: { aspect: 1, updateProjectionMatrix: vi.fn() },
			pipeline: { setSize: vi.fn() },
			...extra,
		} );

	}

	it( 'applies a size at once, at the render scale, and says so at the size asked for', () => {

		const app = sized( { _renderScale: 0.5 } );
		app._renderSizeChanged = vi.fn();

		expect( app.setCanvasSize( 1000, 500 ) ).toEqual( { width: 1000, height: 500 } );

		expect( app.renderer.setSize ).toHaveBeenCalledWith( 500, 250, false );
		expect( app.camera.aspect ).toBe( 2 );
		expect( app.camera.updateProjectionMatrix ).toHaveBeenCalled();
		expect( app.pipeline.setSize ).toHaveBeenCalledWith( 500, 250 );
		expect( app._renderSizeChanged ).toHaveBeenCalledWith( 1000, 500 );
		expect( app.needsReset ).toBe( true );
		expect( app.events ).toEqual( [ { type: EngineEvents.RESOLUTION_CHANGED, width: 1000, height: 500 } ] );

	} );

	it( 'declines a size past the reserve, and says how to raise it', () => {

		const app = sized();
		expect( app.setCanvasSize( 4000, 1000 ) ).toBeNull();
		expect( app.setCanvasSize( 0, 100 ) ).toBeNull();
		expect( app.renderer.setSize ).not.toHaveBeenCalled();
		expect( app._issues.list ).toMatchObject( [ {
			code: ISSUE_CODES.RENDER_SIZE_DECLINED,
			message: expect.stringContaining( 'setReservedRenderResolution( 4000 )' ),
			detail: { width: 4000, height: 1000, reserve: 2048 },
		} ] );

	} );

	it( 'follows the canvas once the resizing stops', () => {

		vi.useFakeTimers();
		const app = sized();
		app._applyRenderResize = vi.fn();

		app.canvas.clientWidth = 900;
		app.onResize();
		vi.advanceTimersByTime( 200 );
		app.canvas.clientWidth = 1000;
		app.onResize();
		vi.advanceTimersByTime( 299 );
		expect( app._applyRenderResize ).not.toHaveBeenCalled();
		vi.advanceTimersByTime( 1 );
		expect( app._applyRenderResize.mock.calls ).toEqual( [[ 1000, 400 ]] );
		expect( app.renderer.setSize ).toHaveBeenLastCalledWith( 1000, 400, false );

	} );

	it( 'ignores a hidden canvas, an oversized one, and one already at its size', () => {

		vi.useFakeTimers();
		const app = sized();
		app._applyRenderResize = vi.fn();

		app.onResize();
		Object.assign( app.canvas, { clientWidth: 0 } );
		app.onResize();
		Object.assign( app.canvas, { clientWidth: 5000 } );
		app.onResize();
		vi.advanceTimersByTime( 1000 );

		expect( app._applyRenderResize ).not.toHaveBeenCalled();
		expect( app.renderer.setSize ).toHaveBeenCalledOnce();

	} );

	it( 'cancels a pending canvas resize when a size is set directly', () => {

		vi.useFakeTimers();
		const app = sized();
		app.canvas.clientWidth = 1200;
		app.onResize();
		app.setCanvasSize( 640, 480 );
		vi.advanceTimersByTime( 1000 );
		expect( app.pipeline.setSize.mock.calls ).toEqual( [[ 640, 480 ]] );

	} );

} );

describe( 'deterministic mode', () => {

	function deterministic() {

		const values = { useAdaptiveSampling: true, usePixelFreeze: true, interactionModeEnabled: true, renderLimitMode: 'time', renderTimeLimit: 30 };
		const stage = { _bounceEarlyExitThreshold: 0.02, _useDynamicDispatch: true, _pinSeedToFrame: false };
		const app = core( {
			values,
			_deterministic: false,
			_dispatchPinned: false,
			_deterministicRestore: null,
			settings: { get: ( key ) => values[ key ], setMany: vi.fn( ( updates ) => void Object.assign( values, updates ) ) },
			stages: { pathTracer: stage },
			reset: vi.fn(),
			stopAnimation: vi.fn(),
			_deterministicSnapshot: vi.fn( () => ( { autoFocus: true } ) ),
			_setDeterministicExtras: vi.fn(),
		} );
		return { app, stage, values };

	}

	it( 'pins every wall-clock input, and puts each back when it ends', () => {

		const { app, stage, values } = deterministic();
		const before = { ...values };

		expect( app.setDeterministicMode() ).toBe( true );
		expect( values ).toEqual( { useAdaptiveSampling: false, usePixelFreeze: false, interactionModeEnabled: false, renderLimitMode: 'frames', renderTimeLimit: 0 } );
		expect( stage ).toEqual( { _bounceEarlyExitThreshold: - 1, _useDynamicDispatch: false, _pinSeedToFrame: true } );
		expect( app.isDeterministic ).toBe( true );
		expect( app._setDeterministicExtras ).toHaveBeenLastCalledWith( true, { autoFocus: true } );
		expect( app.stopAnimation ).toHaveBeenCalled();

		expect( app.setDeterministicMode( true ) ).toBe( true );
		expect( app._deterministicSnapshot ).toHaveBeenCalledOnce();

		expect( app.setDeterministicMode( false ) ).toBe( false );
		expect( values ).toEqual( before );
		expect( stage ).toEqual( { _bounceEarlyExitThreshold: 0.02, _useDynamicDispatch: true, _pinSeedToFrame: false } );
		expect( app._setDeterministicExtras ).toHaveBeenLastCalledWith( false, { autoFocus: true } );
		expect( app.isDeterministic ).toBe( false );

	} );

	it( 'keeps the production dispatch for a perf pass, and says the output does not reproduce', () => {

		const { app, stage } = deterministic();
		app.setDeterministicMode( true );
		expect( app.setDeterministicMode( true, { pinDispatch: false } ) ).toBe( true );
		expect( stage._bounceEarlyExitThreshold ).toBe( 0.02 );
		expect( stage._useDynamicDispatch ).toBe( true );
		expect( stage._pinSeedToFrame ).toBe( true );
		expect( app.isDeterministic ).toBe( false );

	} );

	it( 'turning it off when it was never on changes nothing', () => {

		const { app, values } = deterministic();
		expect( app.setDeterministicMode( false ) ).toBe( false );
		expect( app.settings.setMany ).not.toHaveBeenCalled();
		expect( values.useAdaptiveSampling ).toBe( true );

	} );

} );

describe( 'issues', () => {

	it( 'lists what the engine survived, errors apart, and clears per render', () => {

		const app = core();
		app._issues.warn( ISSUE_CODES.STORAGE_UNAVAILABLE, 'off' );
		app._issues.record( ISSUE_CODES.RENDER_SIZE_DECLINED, 'too big' );

		expect( app.issues.map( i => i.code ) ).toEqual( [ ISSUE_CODES.STORAGE_UNAVAILABLE, ISSUE_CODES.RENDER_SIZE_DECLINED ] );
		expect( app.issueErrors.map( i => i.code ) ).toEqual( [ ISSUE_CODES.RENDER_SIZE_DECLINED ] );
		app.clearIssues();
		expect( app.issues ).toEqual( [] );

	} );

} );

describe( 'render checkpoints', () => {

	it( 'captures the accumulation with its version and sample count', async () => {

		const accumulation = { state: { frameCount: 12 }, color: 'pixels' };
		const app = core( { stages: { pathTracer: { captureAccumulation: async () => accumulation } } } );
		expect( await app.captureRenderCheckpoint() ).toMatchObject( { v: 1, samples: 12, color: 'pixels', state: { frameCount: 12 } } );

		app.stages = {};
		expect( await app.captureRenderCheckpoint() ).toBeNull();

	} );

	it( 'continues one without restarting, and refuses another version or a missing path tracer', () => {

		const restoreAccumulation = vi.fn();
		const app = core( { needsReset: true, stages: { pathTracer: { restoreAccumulation } } } );
		const checkpoint = { v: 1, samples: 40 };

		app.restoreRenderCheckpoint( checkpoint );
		expect( restoreAccumulation ).toHaveBeenCalledWith( checkpoint );
		expect( app.needsReset ).toBe( false );
		expect( app.events ).toEqual( [ { type: EngineEvents.RENDER_RESET, restored: 40 } ] );

		expect( () => app.restoreRenderCheckpoint( { v: 2 } ) ).toThrow( /version 2 is not 1/ );
		app.stages = {};
		expect( () => app.restoreRenderCheckpoint( checkpoint ) ).toThrow( /not initialized/ );

	} );

} );

describe( 'waiting on a readback', () => {

	it( 'waits for it to land, and fails if the device is lost first', async () => {

		const app = core( { renderer: { backend: { device: { lost: new Promise( () => {} ) } } } } );
		await expect( app._awaitReadback( Promise.resolve() ) ).resolves.toBeUndefined();

		app.renderer.backend.device.lost = Promise.resolve( { reason: 'destroyed', message: 'gone' } );
		await expect( app._awaitReadback( new Promise( () => {} ) ) ).rejects.toThrow( /device lost while awaiting a readback: gone/ );

		app.renderer.backend.device = null;
		await expect( app._awaitReadback( Promise.resolve() ) ).resolves.toBeUndefined();

	} );

} );

describe( 'GPU timing', () => {

	function timed( features = [ 'timestamp-query' ] ) {

		return core( { renderer: {
			backend: { hasFeature: ( name ) => features.includes( name ), trackTimestamp: false, timestampQueryPool: { compute: { timestamps: new Map() } } },
			resolveTimestampsAsync: vi.fn( async () => {} ),
			info: { compute: { timestamp: 3 }, render: { timestamp: 1.5 } },
		} } );

	}

	it( 'turns timestamps on only where the device has them', () => {

		expect( core().enableGPUTiming() ).toBe( false );
		expect( timed( [] ).enableGPUTiming() ).toBe( false );
		const app = timed();
		expect( app.enableGPUTiming() ).toBe( true );
		expect( app.renderer.backend.trackTimestamp ).toBe( true );
		expect( app.enableGPUTiming( false ) ).toBe( true );
		expect( app.renderer.backend.trackTimestamp ).toBe( false );

	} );

	it( 'reports nothing until turned on, then compute and render time', async () => {

		const app = timed();
		expect( await app.getGPUTimings() ).toBeNull();
		expect( await app.getKernelGPUTimings() ).toBeNull();
		app.enableGPUTiming();
		expect( await app.getGPUTimings() ).toEqual( { compute: 3, render: 1.5, total: 4.5 } );

	} );

	it( 'sums each kernel\'s passes in the newest frame and keeps what no kernel claims apart', async () => {

		const app = timed();
		app.enableGPUTiming();
		expect( await app.getKernelGPUTimings() ).toBeNull();

		app.stages = { pathTracer: { _kernelManager: { kernels: new Map( [[ 'extend', { id: 11 } ], [ 'shade', { id: 12 } ]] ) } } };
		const timestamps = app.renderer.backend.timestampQueryPool.compute.timestamps;
		for ( const [ key, ms ] of [
			[ 'c:1:11:f4', 1 ], [ 'c:2:11:f4', 2 ], [ 'c:3:12:f4', 4 ], [ 'c:4:99:f4', 0.5 ],
			[ 'c:1:11:f3', 100 ], [ 'malformed', 7 ], [ 'c:1:11:fx', 7 ],
		] ) timestamps.set( key, ms );

		expect( await app.getKernelGPUTimings() ).toEqual( { kernels: { extend: 3, shade: 4 }, total: 7.5, unattributed: 0.5, frame: 4 } );

	} );

} );

describe( 'the raster fallback', () => {

	it( 'compiles once per model when path tracing is turned off, and survives a failed compile', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const compileAsync = vi.fn( async () => {

			throw new Error( 'pipeline failed' );

		} );
		const app = core( { renderer: { compileAsync }, meshScene: 'scene', camera: 'camera', _rasterPrecompile: null, _pathTracerEnabled: true } );

		app.pathTracerEnabled = false;
		expect( app.pathTracerEnabled ).toBe( false );
		await expect( app.precompileRaster() ).resolves.toBeUndefined();
		expect( compileAsync ).toHaveBeenCalledOnce();
		expect( compileAsync ).toHaveBeenCalledWith( 'scene', 'camera' );
		warn.mockRestore();

		app.pathTracerEnabled = true;
		expect( compileAsync ).toHaveBeenCalledOnce();
		app.renderer = null;
		await expect( app.precompileRaster() ).resolves.toBeUndefined();

	} );

} );

describe( 'scene statistics', () => {

	it( 'gives null rather than throwing when the processor cannot say', () => {

		const app = core( { _sdf: { getStatistics: () => {

			throw new Error( 'mid-rebuild' );

		} } } );
		expect( app.getStatistics() ).toBeNull();
		app._sdf.getStatistics = () => ( { triangles: 9 } );
		expect( app.getStatistics() ).toEqual( { triangles: 9 } );

	} );

	it( 'reports host memory with the preflight beside the build\'s phases', () => {

		const app = core( { _sdf: { memoryPreflight: { estimate: 5 }, memory: { report: { allocatedBytes: 7, byPhase: {} } } } } );
		expect( app.getHostMemoryInfo() ).toEqual( { preflight: { estimate: 5 }, allocatedBytes: 7, byPhase: {} } );

	} );

} );

describe( 'GPU memory tracking', () => {

	function tracked() {

		const tracker = { register: vi.fn(), measure: vi.fn( () => ( { current: 1, peak: 2, byCategory: {} } ) ) };
		const denoised = new Texture();
		const app = new RayzeeRenderer( canvas( 4, 2 ) );
		app.renderer = { _frameBufferTargets: new Map( [[ 'a', { bytes: 9 } ]] ) };
		app.stages = {
			pathTracer: { vramTracker: tracker, own: new Texture() },
			denoiser: { output: denoised, notATexture: 3 },
			compositor: null,
		};
		app._canvasResources = () => [ { bytes: 5 } ];
		app._registerVRAM = vi.fn();
		return { app, tracker, denoised };

	}

	it( 'registers the stages\' textures and the canvas once, and measures again on allocations', () => {

		const { app, tracker, denoised } = tracked();
		expect( app.getMemoryInfo() ).toEqual( { current: 1, peak: 2, byCategory: {} } );
		app._ensureVRAMWiring();

		const [[ stages, collectStages ], [ canvasName, collectCanvas ]] = tracker.register.mock.calls;
		expect( [ stages, canvasName ] ).toEqual( [ 'stages', 'canvas' ] );
		expect( collectStages() ).toEqual( [ denoised ] );
		expect( collectCanvas() ).toEqual( [ { bytes: 4 * 2 * 4 }, { bytes: 9 }, { bytes: 5 } ] );
		expect( app._registerVRAM ).toHaveBeenCalledWith( tracker );

		tracker.measure.mockClear();
		for ( const type of [ EngineEvents.SCENE_REBUILD, EngineEvents.ENVIRONMENT_LOADED, EngineEvents.RESOLUTION_CHANGED, EngineEvents.RENDER_RESET ] ) app.dispatchEvent( { type } );
		expect( tracker.measure ).toHaveBeenCalledTimes( 3 );

	} );

	it( 'waits for a tracker before wiring', () => {

		const app = core();
		app._ensureVRAMWiring();
		expect( app._vramWired ).toBeUndefined();

	} );

} );

describe( 'scene bounds', () => {

	function boxAt( y, size = 2 ) {

		const mesh = new Mesh( new BoxGeometry( size, size, size ) );
		mesh.position.y = y;
		return mesh;

	}

	it( 'puts the floor at the lowest point of the scene, or 0 with none', () => {

		const app = core( { meshScene: new Scene().add( boxAt( 5 ), boxAt( 2 ) ) } );
		expect( app.getSceneMinY() ).toBe( 1 );
		app.meshScene = new Scene();
		expect( app.getSceneMinY() ).toBe( 0 );
		app.meshScene = null;
		expect( app.getSceneMinY() ).toBe( 0 );

	} );

	it( 'bounds the loaded models, never the ground', () => {

		const model = boxAt( 3 );
		model.userData.__rayzeeSceneObject = true;
		const ground = new Mesh( new BoxGeometry( 1000, 0.1, 1000 ) );
		const empty = Object.assign( new Object3D(), { userData: { __rayzeeSceneObject: true } } );
		const app = core( { meshScene: new Scene().add( model, ground, empty ) } );

		const box = app.getModelBounds();
		expect( box.min.toArray() ).toEqual( [ - 1, 2, - 1 ] );
		expect( box.max.toArray() ).toEqual( [ 1, 4, 1 ] );
		app.meshScene = null;
		expect( app.getModelBounds( new Box3( new Vector3(), new Vector3( 1, 1, 1 ) ) ).isEmpty() ).toBe( true );

	} );

	it( 'fills fog into the host\'s box, else the models\', and only while there is fog', () => {

		const model = boxAt( 3 );
		model.userData.__rayzeeSceneObject = true;
		const values = { fogDensity: 0, fogBounds: null, fogFloor: null };
		const setUniform = vi.fn();
		const app = core( { meshScene: new Scene().add( model ), settings: { get: ( key ) => values[ key ] }, stages: { pathTracer: { setUniform } } } );
		const sent = () => Object.fromEntries( setUniform.mock.calls.map( ( [ name, v ] ) => [ name, v?.toArray ? v.toArray() : v ] ) );

		app._applyFogBounds();
		expect( setUniform ).not.toHaveBeenCalled();

		// The falloff starts from the models' floor.
		values.fogDensity = 0.1;
		app._applyFogBounds();
		expect( sent() ).toEqual( { fogBoxMin: [ - 1, 2, - 1 ], fogBoxMax: [ 1, 4, 1 ], fogFloor: 2 } );

		// A host's box, and its floor; the models' floor stays the falloff's while the host names none.
		setUniform.mockClear();
		values.fogBounds = { min: [ 0, 0, 0 ], max: [ 10, 5, 10 ] };
		app._applyFogBounds();
		expect( sent() ).toEqual( { fogBoxMin: [ 0, 0, 0 ], fogBoxMax: [ 10, 5, 10 ], fogFloor: 2 } );
		setUniform.mockClear();
		values.fogFloor = 0.5;
		app._applyFogBounds();
		expect( sent().fogFloor ).toBe( 0.5 );

		// Nothing loaded: an empty box, its floor at the box's.
		setUniform.mockClear();
		values.fogBounds = null;
		values.fogFloor = null;
		app.meshScene = new Scene();
		app._applyFogBounds();
		expect( sent() ).toEqual( { fogBoxMin: [ 0, 0, 0 ], fogBoxMax: [ 0, 0, 0 ], fogFloor: 0 } );

	} );

} );

describe( 'colour management', () => {

	class Pipeline {

		constructor( { issues } ) {

			this.issues = issues;
			this.handlers = {};
			this.attachRenderer = vi.fn();
			this.dispose = vi.fn();

		}

		on( name, handler ) {

			this.handlers[ name ] = handler;

		}

	}

	it( 'installs a colour pipeline in place of the old one, attached to the renderer', () => {

		const app = core( { renderer: 'renderer', stages: { compositor: { setCanvasTransform: vi.fn(), showsCanvasTransform: false, render: vi.fn() } }, pipeline: { context: 'context' } } );
		const old = { dispose: vi.fn() };
		app.color = old;

		app.setColorManagement( Pipeline );

		expect( old.dispose ).toHaveBeenCalledOnce();
		expect( app.color.issues ).toBe( app._issues );
		expect( app.color.attachRenderer ).toHaveBeenCalledWith( 'renderer' );

		app.color.canvasTransform = 'hdr view';
		app.color.handlers.canvas();
		expect( app.stages.compositor.setCanvasTransform ).toHaveBeenCalledWith( 'hdr view' );
		expect( app.stages.compositor.render ).toHaveBeenCalledWith( 'context' );

	} );

	it( 'draws a new canvas transform now when idle, on the next tick when looping, never on a lost device', () => {

		const compositor = { setCanvasTransform: vi.fn(), showsCanvasTransform: false, render: vi.fn() };
		const app = core( { stages: { compositor }, pipeline: { context: 'context' }, _pictureCopy: {}, color: { canvasTransform: null } } );

		app._applyCanvasTransform();
		expect( app._pictureCopy ).toBeNull();
		expect( compositor.render ).toHaveBeenCalledOnce();

		app.animationManagerId = 4;
		app._applyCanvasTransform();
		expect( app._needsDisplayRefresh ).toBe( true );
		expect( compositor.render ).toHaveBeenCalledOnce();

		app.animationManagerId = null;
		app._deviceLost = true;
		app._applyCanvasTransform();
		expect( compositor.render ).toHaveBeenCalledOnce();

		app.stages = {};
		expect( () => app._applyCanvasTransform() ).not.toThrow();

	} );

	function colorApp( { adopted = false, hasConfig = true, scene = true } = {} ) {

		const order = [];
		const step = ( name, result ) => vi.fn( async () => {

			order.push( name );
			return result;

		} );
		const environment = new Texture();
		const app = core( {
			order,
			environment,
			reset: vi.fn( () => void order.push( 'reset' ) ),
			rebuildMaterials: step( 'materials' ),
			_uploadEmissivePayload: vi.fn(),
			_sdf: { rebuildEmissiveColors: () => 'emitters' },
			stages: { pathTracer: scene ? { sdfs: {} } : {} },
			renderer: { toneMapping: 0 },
			environmentManager: {
				getEnvironmentTexture: () => environment,
				buildEnvironmentCDF: step( 'cdf' ),
				generateProceduralSkyTexture: step( 'sky' ),
				refreshSun: vi.fn( () => void order.push( 'sun' ) ),
			},
			color: {
				hasConfig,
				workingSpaceAdopted: adopted,
				convertTexturePixels: vi.fn( () => {

					order.push( 'convert' );
					return true;

				} ),
				setWorkingSpace: vi.fn( ( space ) => void order.push( `space:${space}` ) ),
				loadConfig: step( 'load', { name: 'studio' } ),
				unloadConfig: vi.fn( () => void order.push( 'unload' ) ),
			},
		} );
		return app;

	}

	it( 'converts the environment, rebuilds materials and emitters, then the sampling table', async () => {

		const app = colorApp();
		await app.applyColorWorkingSpace();
		expect( app.color.convertTexturePixels ).toHaveBeenCalledWith( app.environment );
		expect( app._uploadEmissivePayload ).toHaveBeenCalledWith( 'emitters' );
		expect( app.order ).toEqual( [ 'convert', 'materials', 'cdf', 'sun', 'reset' ] );

	} );

	it( 'rebakes a physical sky instead of converting its table, and rebuilds nothing without a scene', async () => {

		const app = colorApp( { scene: false } );
		app.environment._isPhysicalSky = true;
		app.color.convertTexturePixels = vi.fn( () => false );
		await app.applyColorWorkingSpace();
		expect( app.order ).toEqual( [ 'sky', 'sun', 'reset' ] );

	} );

	it( 'keeps going when the environment cannot be converted', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const app = colorApp();
		app.color.convertTexturePixels = () => {

			throw new Error( 'no such space' );

		};

		await app.applyColorWorkingSpace();
		expect( app.order ).toEqual( [ 'materials', 'sun', 'reset' ] );
		expect( warn.mock.calls.some( ( [ message ] ) => message.includes( 'no such space' ) ) ).toBe( true );
		warn.mockRestore();

		const plain = colorApp( { hasConfig: false } );
		await plain.applyColorWorkingSpace();
		expect( plain.color.convertTexturePixels ).not.toHaveBeenCalled();

	} );

	it( 'leaves an adopted working space under the old config before loading the new one', async () => {

		const app = colorApp( { adopted: true } );
		app.color.loadConfig = vi.fn( async () => {

			app.order.push( 'load' );
			app.color.workingSpaceAdopted = false;
			return { name: 'studio' };

		} );

		await expect( app.loadColorConfig( { builtin: 'studio' } ) ).resolves.toEqual( { name: 'studio' } );
		expect( app.order.slice( 0, 2 ) ).toEqual( [ 'space:null', 'convert' ] );
		expect( app.order.indexOf( 'load' ) ).toBeGreaterThan( app.order.indexOf( 'space:null' ) );
		expect( app.order.at( - 1 ) ).toBe( 'reset' );

	} );

	it( 'applies the working space a new config adopts', async () => {

		const app = colorApp();
		app.color.loadConfig = vi.fn( async () => {

			app.order.push( 'load' );
			app.color.workingSpaceAdopted = true;

		} );
		await app.loadColorConfig();
		expect( app.order ).toEqual( [ 'load', 'convert', 'materials', 'cdf', 'sun', 'reset', 'reset' ] );

	} );

	it( 'unloads a config after putting the scene back in linear Rec.709', async () => {

		const app = colorApp( { adopted: true } );
		await app.unloadColorConfig();
		expect( app.order.indexOf( 'space:null' ) ).toBeLessThan( app.order.indexOf( 'unload' ) );
		expect( app.order.at( - 1 ) ).toBe( 'reset' );

		const plain = colorApp();
		await plain.unloadColorConfig();
		expect( plain.order ).toEqual( [ 'unload', 'reset' ] );

	} );

} );

describe( 'wiring', () => {

	function wired( extra = {} ) {

		const handlers = {};
		const app = core( {
			_autoResize: false,
			_loadingInProgress: false,
			_applyingSceneMetadata: false,
			pauseRendering: true,
			settings: { bind: vi.fn(), get: ( key ) => ( { exposure: 1.5 } )[ key ] },
			renderer: { toneMappingExposure: 1 },
			onResize: vi.fn(),
			reset: vi.fn(),
			assetLoader: new EventTarget(),
			meshScene: new Scene(),
			stages: { pathTracer: { environment: { setEnvironmentMap: vi.fn( async () => {} ) } } },
			pipeline: { eventBus: { on: ( name, handler ) => void ( handlers[ name ] = handler ) } },
			_clearAppendedModels: vi.fn(),
			_beginSceneMetadataEnvironment: () => 'pending',
			loadSceneData: vi.fn( async () => true ),
			...extra,
		} );
		app.assetLoader.commitPendingGraph = vi.fn();
		app._wireEvents();
		return { app, handlers };

	}

	const load = async ( app, detail ) => {

		await app._onAssetLoaded( detail );

	};

	it( 'binds the settings, takes the exposure and sizes itself', () => {

		const { app } = wired();
		expect( app.settings.bind ).toHaveBeenCalledOnce();
		expect( app.renderer.toneMappingExposure ).toBe( 1.5 );
		expect( app.onResize ).toHaveBeenCalledOnce();

	} );

	it( 'listens for window resizes only when asked', () => {

		const added = vi.fn();
		vi.stubGlobal( 'window', { addEventListener: added, removeEventListener: vi.fn() } );
		wired();
		expect( added ).not.toHaveBeenCalled();
		const { app } = wired( { _autoResize: true } );
		expect( added ).toHaveBeenCalledWith( 'resize', app.resizeHandler );

	} );

	it( 'rebuilds for a model the loader opened itself, and stores its graph only when built', async () => {

		const { app } = wired();
		const model = new Object3D();
		await load( app, { model } );
		expect( app._clearAppendedModels ).toHaveBeenCalledOnce();
		expect( app.loadSceneData ).toHaveBeenCalledWith( { pendingEnvironment: 'pending' } );
		expect( app.assetLoader.commitPendingGraph ).toHaveBeenCalledWith( model );
		expect( app.pauseRendering ).toBe( false );
		expect( app.reset ).toHaveBeenCalledOnce();

		app.loadSceneData = vi.fn( async () => false );
		await load( app, { model } );
		expect( app.assetLoader.commitPendingGraph ).toHaveBeenCalledOnce();

	} );

	it( 'installs an environment the loader opened, and ends the loading status', async () => {

		const status = [];
		setStatusCallback( ( event ) => status.push( event ) );
		const { app } = wired();
		const sky = new Texture();
		app.meshScene.environment = sky;

		await load( app, { texture: sky } );
		expect( app.stages.pathTracer.environment.setEnvironmentMap ).toHaveBeenCalledWith( sky );
		expect( status ).toEqual( [ { type: EngineEvents.LOADING_RESET } ] );
		expect( app.reset ).toHaveBeenCalledOnce();

	} );

	it( 'leaves loads it runs itself, and the authored environment, to their own code', async () => {

		const { app } = wired();
		app._loadingInProgress = true;
		await load( app, { model: new Object3D() } );
		app._loadingInProgress = false;
		app._applyingSceneMetadata = true;
		await load( app, { texture: new Texture() } );

		expect( app.loadSceneData ).not.toHaveBeenCalled();
		expect( app.stages.pathTracer.environment.setEnvironmentMap ).not.toHaveBeenCalled();
		expect( app.reset ).not.toHaveBeenCalled();

	} );

	it( 'hears the asset loader through its own listener, and tells the host when shaders compile', () => {

		const { app, handlers } = wired();
		app._onAssetLoaded = vi.fn();
		const event = Object.assign( new Event( 'load' ), { model: null } );
		app.assetLoader.dispatchEvent( event );
		expect( app._trackedListeners.some( ( l ) => l.type === 'load' ) ).toBe( true );

		handlers[ 'pathtracer:compiling' ]( { compiling: true } );
		expect( app.events ).toEqual( [ { type: EngineEvents.SHADERS_COMPILING, compiling: true } ] );

	} );

} );

describe( 'managers and stages', () => {

	it( 'applies a reserve asked for before init once the device exists, before any stage is built', async () => {

		const order = [];
		const step = ( name ) => vi.fn( async () => void order.push( name ) );
		const setTriangleData = vi.fn();
		const setBVHData = vi.fn();
		const app = core( {
			isInitialized: false,
			_initStorage: step( 'storage' ),
			_initRenderer: step( 'device' ),
			_applyPendingReservedRenderSize: vi.fn( () => void order.push( 'reserve' ) ),
			_createCamera: () => 'camera',
			_initScenes: vi.fn(),
			_initAssetPipeline: vi.fn(),
			_initPipeline: vi.fn( () => {

				order.push( 'stages' );
				app.stages.pathTracer = { setTriangleData, setBVHData, setupMaterial: vi.fn(), materialData: { setMaterialData: vi.fn() } };

			} ),
			_initManagers: step( 'managers' ),
			_wireEvents: vi.fn(),
			_attachStorage: vi.fn( () => void order.push( 'attach' ) ),
		} );

		await expect( app.init() ).resolves.toBe( app );

		expect( order.indexOf( 'reserve' ) ).toBeGreaterThan( order.indexOf( 'device' ) );
		expect( order.indexOf( 'reserve' ) ).toBeLessThan( order.indexOf( 'stages' ) );
		expect( order.at( - 1 ) ).toBe( 'attach' );
		expect( app.camera ).toBe( 'camera' );
		expect( new Uint32Array( setBVHData.mock.calls[ 0 ][ 0 ].buffer )[ 3 ] ).toBe( BVH_LEAF_MARKERS.TRIANGLE_LEAF );
		expect( setTriangleData.mock.calls[ 0 ][ 1 ] ).toBe( 0 );
		expect( app.isInitialized ).toBe( true );

	} );

	it( 'builds the asset pipeline: a host\'s scene budget only when set, the area light scale read at each load', () => {

		const values = { areaLightIntensityScale: 0.1 };
		const make = ( extra ) => {

			const app = core( { renderer: { name: 'renderer' }, meshScene: new Scene(), camera: 'camera', settings: { get: ( key ) => values[ key ] }, ...extra } );
			app._initAssetPipeline();
			return app;

		};

		const app = make();
		expect( app._sdf.config.maxSceneBytes ).toBe( MAX_SCENE_BYTES );
		expect( make( { _maxSceneBytes: 12345 } )._sdf.config.maxSceneBytes ).toBe( 12345 );
		expect( app.assetLoader._areaLightIntensityScale() ).toBe( 0.1 );
		values.areaLightIntensityScale = 1;
		expect( app.assetLoader._areaLightIntensityScale() ).toBe( 1 );
		expect( app.assetLoader.renderer ).toBe( app.renderer );
		expect( app.meshScene.children ).toEqual( [ app.assetLoader.floorPlane ] );
		expect( app.assetLoader.floorPlane.visible ).toBe( false );

	} );

	it( 'resets the whole renderer from the environment, not just its stage', () => {

		const environment = { callbacks: {} };
		const emit = vi.fn();
		const app = core( {
			scene: new Scene(),
			_sceneHelpers: {},
			stages: { pathTracer: { environment } },
			pipeline: { eventBus: { emit } },
			reset: vi.fn(),
			_lightRemoved: vi.fn(),
		} );

		return app._initManagers().then( () => {

			expect( app.environmentManager ).toBe( environment );
			expect( environment.issues ).toBe( app._issues );
			expect( app.stages.pathTracer.issues ).toBe( app._issues );

			environment.callbacks.onReset();
			expect( app.reset ).toHaveBeenCalledOnce();
			environment.callbacks.onLightingChanged();
			expect( emit ).toHaveBeenCalledWith( 'pipeline:lightingChanged' );

			app.lightManager._onReset();
			expect( app.reset ).toHaveBeenCalledTimes( 2 );
			app.lightManager._onLightRemoved( 'light' );
			expect( app._lightRemoved ).toHaveBeenCalledWith( 'light' );

		} );

	} );

	it( 'runs the path tracer first, a layer\'s stages next and the compositor last, at the canvas size', () => {

		const stage = ( name ) => Object.assign( new RenderStage( name ), { setSize: vi.fn() } );
		const app = core( { canvas: canvas( 0, 0 ), renderer: {} } );
		app._createStages = function () {

			this.stages.pathTracer = stage( 'PathTracer' );
			this.stages.compositor = stage( 'Compositor' );
			this._extraStages = [ stage( 'NRD' ), stage( 'AutoExposure' ) ];

		};

		app._initPipeline();

		expect( app.pipeline.stages.map( s => s.name ) ).toEqual( [ 'PathTracer', 'NRD', 'AutoExposure', 'Compositor' ] );
		expect( app.stages.pathTracer.setSize ).toHaveBeenCalledWith( 1, 1 );
		expect( [ app._renderWidth, app._renderHeight, app._displayWidth, app._displayHeight ] ).toEqual( [ 1, 1, 1, 1 ] );

	} );

	it( 'aims a new camera at the canvas\'s shape', () => {

		expect( core( { canvas: canvas( 800, 400 ) } )._createCamera().aspect ).toBe( 2 );
		expect( core( { canvas: canvas( 0, 0 ) } )._createCamera().aspect ).toBe( 1 );
		expect( core( { canvas: canvas( 800, 0 ) } )._createCamera().aspect ).toBe( 1 );
		expect( core()._createExtraStages() ).toEqual( [] );
		expect( core()._displaySources() ).toEqual( [] );

	} );

	it( 'routes exposure to the renderer and the fog box to its bounds', () => {

		const app = core( { renderer: { toneMappingExposure: 1 }, reset: vi.fn(), _applyFogBounds: vi.fn(), _reconcileCompletion: vi.fn() } );
		const bindings = app._settingsBindings();

		bindings.applyExposure( 2.5 );
		expect( app.renderer.toneMappingExposure ).toBe( 2.5 );
		bindings.resetCallback();
		bindings.reconcileCompletion();
		bindings.onFogBounds();
		expect( app.reset ).toHaveBeenCalledOnce();
		expect( app._reconcileCompletion ).toHaveBeenCalledOnce();
		expect( app._applyFogBounds ).toHaveBeenCalledOnce();

	} );

	it( 'makes its scenes and helpers', () => {

		const app = core();
		app._initScenes();
		expect( app.scene.isScene && app.meshScene.isScene ).toBe( true );
		expect( app.scene ).not.toBe( app.meshScene );
		expect( app.getScene() ).toBe( app.meshScene );

	} );

	it( 'forwards a source\'s events as its own, until disposed', () => {

		const app = core();
		const source = new EventTarget();
		app._forwardEvents( source, [ 'a', 'b' ] );
		app._forwardEvents( null, [ 'a' ] );
		source.dispatchEvent( new Event( 'a' ) );
		source.dispatchEvent( new Event( 'c' ) );
		expect( types( app ) ).toEqual( [ 'a' ] );

		app._removeTrackedListeners();
		source.dispatchEvent( new Event( 'b' ) );
		expect( types( app ) ).toEqual( [ 'a' ] );

	} );

} );

describe( 'reconciling completion with the limits', () => {

	function reconciling( { frameCount, completionThreshold, isComplete } ) {

		const stage = { frameCount, completionThreshold, isComplete };
		return core( {
			stage,
			stages: { pathTracer: stage },
			settings: { get: ( key ) => ( { renderLimitMode: 'frames', renderTimeLimit: 0 } )[ key ] },
			_completionReopened: vi.fn(),
			wake: vi.fn(),
		} );

	}

	it( 'finishes a render the new limit has already reached', () => {

		const app = reconciling( { frameCount: 64, completionThreshold: 32, isComplete: false } );
		app._reconcileCompletion();
		expect( app.stage.isComplete ).toBe( true );
		expect( app.events ).toEqual( [] );

	} );

	it( 'reopens a finished render whose limit was raised, and wakes the loop', () => {

		const app = reconciling( { frameCount: 32, completionThreshold: 128, isComplete: true } );
		app.completion.markComplete();
		app._reconcileCompletion();

		expect( app.stage.isComplete ).toBe( false );
		expect( app.completion.renderCompleteDispatched ).toBe( false );
		expect( app._completionReopened ).toHaveBeenCalledOnce();
		expect( types( app ) ).toEqual( [ EngineEvents.RENDER_RESET ] );
		expect( app.wake ).toHaveBeenCalledOnce();

	} );

	it( 'leaves a render that agrees with its limit alone', () => {

		const app = reconciling( { frameCount: 3, completionThreshold: 32, isComplete: false } );
		app._reconcileCompletion();
		expect( app.stage.isComplete ).toBe( false );
		app.stages = {};
		expect( () => app._reconcileCompletion() ).not.toThrow();

	} );

} );
