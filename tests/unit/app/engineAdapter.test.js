import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const toast = vi.hoisted( () => vi.fn() );
vi.mock( '@/hooks/use-toast', () => ( { toast } ) );

// Mock rayzee engine events
vi.mock( 'rayzee', () => ( {
	EngineEvents: {
		RENDER_COMPLETE: 'RENDER_COMPLETE',
		RENDER_RESET: 'RENDER_RESET',
		DENOISING_START: 'DENOISING_START',
		DENOISING_END: 'DENOISING_END',
		DENOISER_LOADING: 'DENOISER_LOADING',
		UPSCALING_START: 'UPSCALING_START',
		UPSCALING_PROGRESS: 'UPSCALING_PROGRESS',
		UPSCALING_END: 'UPSCALING_END',
		LOADING_UPDATE: 'LOADING_UPDATE',
		LOADING_RESET: 'LOADING_RESET',
		STATS_UPDATE: 'STATS_UPDATE',
		CAMERA_UPDATED: 'CAMERA_UPDATED',
		ANIMATION_CHANGED: 'ANIMATION_CHANGED',
		OBJECT_SELECTED: 'OBJECT_SELECTED',
		OBJECT_DOUBLE_CLICKED: 'OBJECT_DOUBLE_CLICKED',
		SELECT_MODE_CHANGED: 'SELECT_MODE_CHANGED',
		OBJECT_TRANSFORM_START: 'OBJECT_TRANSFORM_START',
		OBJECT_TRANSFORM_END: 'OBJECT_TRANSFORM_END',
		TRANSFORM_MODE_CHANGED: 'TRANSFORM_MODE_CHANGED',
		AF_POINT_PLACED: 'AF_POINT_PLACED',
		AUTO_FOCUS_UPDATED: 'AUTO_FOCUS_UPDATED',
		AUTO_EXPOSURE_UPDATED: 'AUTO_EXPOSURE_UPDATED',
		ANIMATION_STARTED: 'ANIMATION_STARTED',
		ANIMATION_PAUSED: 'ANIMATION_PAUSED',
		ANIMATION_STOPPED: 'ANIMATION_STOPPED',
		ANIMATION_FINISHED: 'ANIMATION_FINISHED',
		CAMERAS_UPDATED: 'CAMERAS_UPDATED',
		CAMERA_SWITCHED: 'CAMERA_SWITCHED',
		MODEL_LOADED: 'MODEL_LOADED',
		SCENE_REBUILD: 'SCENE_REBUILD',
		RESOLUTION_CHANGED: 'RESOLUTION_CHANGED',
		SHADERS_COMPILING: 'SHADERS_COMPILING',
		ORTHO_HEIGHT_UPDATED: 'ORTHO_HEIGHT_UPDATED',
		TIMELINE_CHANGED: 'TIMELINE_CHANGED',
		SCENE_METADATA_APPLIED: 'SCENE_METADATA_APPLIED',
	}
} ) );

import { connectEngineToStore } from '@/lib/EngineAdapter.js';

// ── Helpers ──────────────────────────────────────────────────

function createMockEngine() {

	const listeners = {};

	return {
		addEventListener( type, fn ) {

			( listeners[ type ] ||= [] ).push( fn );

		},
		removeEventListener( type, fn ) {

			if ( listeners[ type ] ) {

				const i = listeners[ type ].indexOf( fn );
				if ( i > - 1 ) listeners[ type ].splice( i, 1 );

			}

		},
		_emit( type, data ) {

			( listeners[ type ] || [] ).forEach( fn => fn( data ) );

		},
		_listeners: listeners,
	};

}

function createMockStores() {

	const cameraState = {
		setSelectMode: vi.fn(), handleAFScreenPointChange: vi.fn(), setAutoFocusDistance: vi.fn(), syncModelSize: vi.fn(),
		setCameraNames: vi.fn(), setSelectedCameraIndex: vi.fn(), applyCameraEffects: vi.fn(), setOrthoHeight: vi.fn(),
	};
	const pathTracerState = { syncCameraProjection: vi.fn(), syncSceneEnvironment: vi.fn(), _applyFog: vi.fn(), fog: false };
	const animationState = { setIsPlaying: vi.fn(), setIsPaused: vi.fn(), setClips: vi.fn(), syncTimeline: vi.fn() };
	const state = {
		setIsRenderComplete: vi.fn(),
		setCompletionReason: vi.fn(),
		setIsRendering: vi.fn(),
		setIsDenoising: vi.fn(),
		setIsCompilingShaders: vi.fn(),
		setIsLoadingDenoiser: vi.fn(),
		setIsUpscaling: vi.fn(),
		setUpscalingProgress: vi.fn(),
		setLoading: vi.fn(),
		resetLoading: vi.fn(),
		setStats: vi.fn(),
		setSelectedObject: vi.fn(),
		setActiveTab: vi.fn(),
		setIsTransforming: vi.fn(),
		loading: {},
		stats: {},
	};

	return {
		useStore: { getState: () => state, setState: vi.fn() },
		useCameraStore: { getState: () => cameraState },
		usePathTracerStore: { getState: () => pathTracerState, setState: vi.fn() },
		useAnimationStore: { getState: () => animationState },
		_state: state,
		_cameraState: cameraState,
		_pathTracerState: pathTracerState,
		_animationState: animationState,
	};

}

// ── Tests ────────────────────────────────────────────────────

describe( 'connectEngineToStore', () => {

	let engine, stores;

	beforeEach( () => {

		engine = createMockEngine();
		stores = createMockStores();

	} );

	it( 'should return a cleanup function', () => {

		const cleanup = connectEngineToStore( engine, stores );

		expect( typeof cleanup ).toBe( 'function' );

	} );

	it( 'should call setIsRenderComplete(true) and setIsRendering(false) on RENDER_COMPLETE', () => {

		connectEngineToStore( engine, stores );

		engine._emit( 'RENDER_COMPLETE', { reason: 'converged' } );

		expect( stores._state.setIsRenderComplete ).toHaveBeenCalledWith( true );
		expect( stores._state.setIsRendering ).toHaveBeenCalledWith( false );
		expect( stores._state.setCompletionReason ).toHaveBeenCalledWith( 'converged' );

	} );

	// An engine build that predates the reason must not leave the previous render's tick showing.
	it( 'clears the reason when RENDER_COMPLETE carries none', () => {

		connectEngineToStore( engine, stores );

		engine._emit( 'RENDER_COMPLETE' );

		expect( stores._state.setCompletionReason ).toHaveBeenCalledWith( null );

	} );

	it( 'should call setIsRenderComplete(false) and setIsRendering(true) on RENDER_RESET', () => {

		Object.assign( stores._state, { isRenderComplete: true, isRendering: false, completionReason: 'samples' } );
		connectEngineToStore( engine, stores );

		engine._emit( 'RENDER_RESET' );

		expect( stores._state.setIsRenderComplete ).toHaveBeenCalledWith( false );
		expect( stores._state.setIsRendering ).toHaveBeenCalledWith( true );
		expect( stores._state.setCompletionReason ).toHaveBeenCalledWith( null );

	} );

	// A reset fires every frame while anything moves, and each store write notifies every subscriber.
	it( 'writes nothing on RENDER_RESET while a render is already running', () => {

		Object.assign( stores._state, { isRenderComplete: false, isRendering: true, completionReason: null } );
		connectEngineToStore( engine, stores );

		engine._emit( 'RENDER_RESET' );

		expect( stores._state.setIsRenderComplete ).not.toHaveBeenCalled();
		expect( stores._state.setIsRendering ).not.toHaveBeenCalled();
		expect( stores._state.setCompletionReason ).not.toHaveBeenCalled();

	} );

	it( 'should call setIsDenoising(true) on DENOISING_START', () => {

		connectEngineToStore( engine, stores );

		engine._emit( 'DENOISING_START' );

		expect( stores._state.setIsDenoising ).toHaveBeenCalledWith( true );

	} );

	it( 'should call setIsDenoising(false) on DENOISING_END', () => {

		connectEngineToStore( engine, stores );

		engine._emit( 'DENOISING_END' );

		expect( stores._state.setIsDenoising ).toHaveBeenCalledWith( false );

	} );

	it( 'should ignore cadence denoises so the status badge does not flicker', () => {

		connectEngineToStore( engine, stores );

		engine._emit( 'DENOISING_START', { continuous: true } );
		engine._emit( 'DENOISING_END', { continuous: true } );

		expect( stores._state.setIsDenoising ).not.toHaveBeenCalled();

		engine._emit( 'DENOISING_START', { continuous: false } );

		expect( stores._state.setIsDenoising ).toHaveBeenCalledWith( true );

	} );

	it( 'should mirror the denoiser model load', () => {

		connectEngineToStore( engine, stores );

		engine._emit( 'DENOISER_LOADING', { loading: true } );
		expect( stores._state.setIsLoadingDenoiser ).toHaveBeenLastCalledWith( true );

		engine._emit( 'DENOISER_LOADING', { loading: false } );
		expect( stores._state.setIsLoadingDenoiser ).toHaveBeenLastCalledWith( false );

	} );

	it( 'should update animation clips on SceneRebuild', () => {

		// SceneRebuild handler also dispatches a window CustomEvent
		vi.stubGlobal( 'window', { dispatchEvent: vi.fn() } );

		const mockClips = [ { index: 0, name: 'Walk', duration: 2.0 } ];
		engine.animationManager = { clips: mockClips };

		const setClips = vi.fn();
		stores.useAnimationStore = { getState: () => ( { setClips } ) };

		connectEngineToStore( engine, stores );
		engine._emit( 'SCENE_REBUILD' );

		expect( setClips ).toHaveBeenCalledWith( mockClips );

		vi.unstubAllGlobals();

	} );

	it( 'puts a new model back in its own file units', () => {

		connectEngineToStore( engine, stores );
		engine._emit( 'MODEL_LOADED' );

		expect( stores._cameraState.syncModelSize ).toHaveBeenCalledWith( { resetUnits: true } );

	} );

	it( 'should remove all listeners when cleanup is called', () => {

		const cleanup = connectEngineToStore( engine, stores );

		// Verify some listeners were registered
		expect( Object.keys( engine._listeners ).length ).toBeGreaterThan( 0 );

		cleanup();

		// All registered event types should have empty listener arrays
		for ( const type of Object.keys( engine._listeners ) ) {

			expect( engine._listeners[ type ] ).toHaveLength( 0 );

		}

		// A compile the engine never finishes would otherwise hold the loading panel open.
		expect( stores._state.setIsCompilingShaders ).toHaveBeenCalledWith( false );
		expect( stores._state.setIsLoadingDenoiser ).toHaveBeenCalledWith( false );

	} );

} );

describe( 'connectEngineToStore mirrors', () => {

	let engine, stores, state;

	beforeEach( () => {

		engine = createMockEngine();
		stores = createMockStores();
		state = stores._state;
		toast.mockClear();
		connectEngineToStore( engine, stores );

	} );

	afterEach( () => vi.unstubAllGlobals() );

	it( 'shader compiles', () => {

		engine._emit( 'SHADERS_COMPILING', { compiling: true } );
		expect( state.setIsCompilingShaders ).toHaveBeenLastCalledWith( true );
		engine._emit( 'SHADERS_COMPILING' );
		expect( state.setIsCompilingShaders ).toHaveBeenLastCalledWith( false );

	} );

	it( 'an upscale from start to end, its progress starting and ending at 0', () => {

		engine._emit( 'UPSCALING_START' );
		expect( state.setIsUpscaling ).toHaveBeenLastCalledWith( true );
		expect( state.setUpscalingProgress ).toHaveBeenLastCalledWith( 0 );

		engine._emit( 'UPSCALING_PROGRESS', { progress: 0.2, secondsLeft: null } );
		expect( state.setUpscalingProgress ).toHaveBeenLastCalledWith( 0.2, null );

		engine._emit( 'UPSCALING_PROGRESS', { progress: 0.4, secondsLeft: 12 } );
		expect( state.setUpscalingProgress ).toHaveBeenLastCalledWith( 0.4, 12 );

		engine._emit( 'UPSCALING_END' );
		expect( state.setIsUpscaling ).toHaveBeenLastCalledWith( false );
		expect( state.setUpscalingProgress ).toHaveBeenLastCalledWith( 0 );

	} );

	it( 'loading updates merged into the current status, without the event\'s own fields', () => {

		state.loading = { isLoading: true, status: 'Downloading', progress: 40 };
		engine._emit( 'LOADING_UPDATE', { type: 'LOADING_UPDATE', target: engine, progress: 80 } );

		expect( state.setLoading ).toHaveBeenLastCalledWith( { isLoading: true, status: 'Downloading', progress: 80 } );

		engine._emit( 'LOADING_RESET' );
		expect( state.resetLoading ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'a new load clearing the previous one\'s failure, unless it fails itself', () => {

		state.loading = { failed: true, status: 'Could not read the file' };

		engine._emit( 'LOADING_UPDATE', { isLoading: true, status: 'Parsing' } );
		expect( state.setLoading ).toHaveBeenLastCalledWith( { failed: false, isLoading: true, status: 'Parsing' } );

		engine._emit( 'LOADING_UPDATE', { isLoading: true, failed: true, status: 'Out of memory' } );
		expect( state.setLoading ).toHaveBeenLastCalledWith( { failed: true, isLoading: true, status: 'Out of memory' } );

		engine._emit( 'LOADING_UPDATE', { isLoading: false } );
		expect( state.setLoading.mock.lastCall[ 0 ].failed ).toBe( true );

	} );

	it( 'stats merged over the last ones, or over none', () => {

		state.stats = { samples: 3, timeElapsed: 1 };
		engine._emit( 'STATS_UPDATE', { type: 'STATS_UPDATE', target: engine, samples: 4 } );
		expect( state.setStats ).toHaveBeenLastCalledWith( { samples: 4, timeElapsed: 1 } );

		state.stats = null;
		engine._emit( 'STATS_UPDATE', { samples: 1 } );
		expect( state.setStats ).toHaveBeenLastCalledWith( { samples: 1 } );

	} );

	it( 'selection, double click and select mode', () => {

		const object = { name: 'chair' };
		engine._emit( 'OBJECT_SELECTED', { object } );
		expect( state.setSelectedObject ).toHaveBeenCalledWith( object );

		engine._emit( 'OBJECT_DOUBLE_CLICKED' );
		expect( state.setActiveTab ).toHaveBeenCalledWith( 'material' );

		engine._emit( 'SELECT_MODE_CHANGED', { enabled: true } );
		expect( stores._cameraState.setSelectMode ).toHaveBeenCalledWith( true );

	} );

	it( 'a gizmo drag, refreshing the lights panel only when a light was moved', () => {

		const lights = [ { uuid: 'sun' } ];
		const setLights = vi.fn();
		const withLights = { ...stores, useLightStore: { getState: () => ( { setLights } ) } };
		const lit = createMockEngine();
		lit.lightManager = { getAll: () => lights };
		connectEngineToStore( lit, withLights );

		lit._emit( 'OBJECT_TRANSFORM_START' );
		expect( state.setIsTransforming ).toHaveBeenLastCalledWith( true );

		lit.transformManager = { attachedObject: { isMesh: true } };
		lit._emit( 'OBJECT_TRANSFORM_END' );
		expect( state.setIsTransforming ).toHaveBeenLastCalledWith( false );
		expect( setLights ).not.toHaveBeenCalled();

		lit.transformManager.attachedObject = { isLight: true };
		lit._emit( 'OBJECT_TRANSFORM_END' );
		expect( setLights ).toHaveBeenCalledWith( lights );

		engine.transformManager = { attachedObject: { isLight: true } };
		expect( () => engine._emit( 'OBJECT_TRANSFORM_END' ) ).not.toThrow();

	} );

	it( 'the gizmo mode', () => {

		engine._emit( 'TRANSFORM_MODE_CHANGED', { mode: 'rotate' } );
		expect( stores.useStore.setState ).toHaveBeenCalledWith( { transformMode: 'rotate' } );

	} );

	it( 'focus: the placed point and the measured distance', () => {

		engine._emit( 'AF_POINT_PLACED', { point: { x: 0.25, y: 0.75 } } );
		expect( stores._cameraState.handleAFScreenPointChange ).toHaveBeenCalledWith( { x: 0.25, y: 0.75 } );

		engine._emit( 'AUTO_FOCUS_UPDATED', { worldDistance: 3.5 } );
		expect( stores._cameraState.setAutoFocusDistance ).toHaveBeenCalledWith( 3.5 );

	} );

	it( 'the camera list, asking the engine for names the event leaves out', () => {

		engine.cameraManager = { getCameraNames: () => [ 'Default', 'Imported' ] };

		engine._emit( 'CAMERAS_UPDATED', { cameraNames: [ 'Default' ] } );
		expect( stores._cameraState.setCameraNames ).toHaveBeenLastCalledWith( [ 'Default' ] );
		expect( stores._cameraState.setSelectedCameraIndex ).toHaveBeenLastCalledWith( 0 );

		engine.currentCameraIndex = 1;
		engine._emit( 'CAMERAS_UPDATED', {} );
		expect( stores._cameraState.setCameraNames ).toHaveBeenLastCalledWith( [ 'Default', 'Imported' ] );
		expect( stores._cameraState.setSelectedCameraIndex ).toHaveBeenLastCalledWith( 1 );

	} );

	it( 'a camera switch: selection, the camera\'s own effects with its field of view, and its projection', () => {

		engine._emit( 'CAMERA_SWITCHED', { cameraIndex: 2, fov: 40, effects: { dofBlur: 0.1 }, cameraProjection: 'orthographic' } );

		expect( stores._cameraState.setSelectedCameraIndex ).toHaveBeenCalledWith( 2 );
		expect( stores._cameraState.applyCameraEffects ).toHaveBeenCalledWith( { fov: 40, dofBlur: 0.1 } );
		expect( stores._pathTracerState.syncCameraProjection ).toHaveBeenCalledWith( 'orthographic' );

		engine._emit( 'CAMERA_SWITCHED', { cameraIndex: 0, cameraProjection: 'perspective' } );
		expect( stores._cameraState.applyCameraEffects ).toHaveBeenCalledTimes( 1 );
		expect( stores._pathTracerState.syncCameraProjection ).toHaveBeenLastCalledWith( 'perspective' );

	} );

	it( 'the orthographic view height', () => {

		engine._emit( 'ORTHO_HEIGHT_UPDATED', { height: 12 } );
		expect( stores._cameraState.setOrthoHeight ).toHaveBeenCalledWith( 12 );

	} );

	it( 'a scene built through disk with a notice', () => {

		engine._emit( 'MODEL_LOADED' );
		expect( toast ).not.toHaveBeenCalled();

		engine.sceneSpilled = true;
		engine.geometryOnDisk = true;
		engine._emit( 'MODEL_LOADED' );
		expect( toast ).toHaveBeenCalledWith( { title: 'Large scene', description: 'Built through disk to save memory; clicking to select objects is off for this scene.' } );

	} );

	it( 'the timeline, when there is an animation store', () => {

		engine.timeline = { tracks: [] };
		engine._emit( 'TIMELINE_CHANGED' );
		expect( stores._animationState.syncTimeline ).toHaveBeenCalledWith( engine.timeline );

		const bare = createMockEngine();
		connectEngineToStore( bare, { ...stores, useAnimationStore: undefined } );
		expect( () => bare._emit( 'TIMELINE_CHANGED' ) ).not.toThrow();

	} );

	it( 'playback: playing, paused, stopped and finished', () => {

		const { setIsPlaying, setIsPaused } = stores._animationState;

		engine._emit( 'ANIMATION_STARTED' );
		expect( setIsPlaying ).toHaveBeenLastCalledWith( true );

		engine._emit( 'ANIMATION_PAUSED' );
		expect( setIsPlaying ).toHaveBeenLastCalledWith( false );
		expect( setIsPaused ).toHaveBeenLastCalledWith( true );

		for ( const type of [ 'ANIMATION_STOPPED', 'ANIMATION_FINISHED' ] ) {

			setIsPaused.mockClear();
			engine._emit( type );
			expect( setIsPlaying ).toHaveBeenLastCalledWith( false );
			expect( setIsPaused ).toHaveBeenCalledWith( false );

		}

	} );

	it( 'playback without an animation store', () => {

		const bare = createMockEngine();
		connectEngineToStore( bare, { ...stores, useAnimationStore: undefined } );
		for ( const type of [ 'ANIMATION_STARTED', 'ANIMATION_PAUSED', 'ANIMATION_STOPPED', 'ANIMATION_FINISHED' ] ) {

			expect( () => bare._emit( type ) ).not.toThrow();

		}

	} );

	it( 'an environment the model file carried', () => {

		const environment = { mode: 'hdri', url: 'sky.hdr' };
		engine._emit( 'SCENE_METADATA_APPLIED', { environment } );
		expect( stores._pathTracerState.syncSceneEnvironment ).toHaveBeenCalledWith( environment );

	} );

	it( 'a rebuilt scene: floor height, fog, emissive sampling and the window event', () => {

		vi.stubGlobal( 'window', { dispatchEvent: vi.fn() } );
		engine.getSceneMinY = () => - 0.5;
		engine.settings = { get: key => ( key === 'enableEmissiveTriangleSampling' ? 1 : undefined ) };
		stores._pathTracerState.fog = true;

		engine._emit( 'SCENE_REBUILD' );

		expect( stores._cameraState.syncModelSize ).toHaveBeenCalledWith();
		expect( stores.usePathTracerStore.setState ).toHaveBeenCalledWith( { groundCatcherHeight: - 0.5 } );
		expect( stores.usePathTracerStore.setState ).toHaveBeenCalledWith( { enableEmissiveTriangleSampling: true } );
		expect( stores._pathTracerState._applyFog ).toHaveBeenCalledTimes( 1 );
		expect( window.dispatchEvent.mock.calls[ 0 ][ 0 ].type ).toBe( 'SceneRebuild' );

	} );

	it( 'a rebuilt scene leaving the floor, fog and emissive switch alone when the engine has none of them', () => {

		vi.stubGlobal( 'window', { dispatchEvent: vi.fn() } );

		engine._emit( 'SCENE_REBUILD' );

		expect( stores.usePathTracerStore.setState ).not.toHaveBeenCalled();
		expect( stores._pathTracerState._applyFog ).not.toHaveBeenCalled();
		expect( stores._animationState.setClips ).toHaveBeenCalledWith( [] );

	} );

	it( 'a resolution change as a window event', () => {

		vi.stubGlobal( 'window', { dispatchEvent: vi.fn() } );

		engine._emit( 'RESOLUTION_CHANGED', { width: 1280, height: 720 } );

		const [ event ] = window.dispatchEvent.mock.calls[ 0 ];
		expect( event.type ).toBe( 'resolution_changed' );
		expect( event.detail ).toEqual( { width: 1280, height: 720 } );

	} );

} );
