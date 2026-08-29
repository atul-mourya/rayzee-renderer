import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock rayzee engine events
vi.mock( 'rayzee', () => ( {
	EngineEvents: {
		RENDER_COMPLETE: 'RENDER_COMPLETE',
		RENDER_RESET: 'RENDER_RESET',
		DENOISING_START: 'DENOISING_START',
		DENOISING_END: 'DENOISING_END',
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

	const state = {
		setIsRenderComplete: vi.fn(),
		setCompletionReason: vi.fn(),
		setIsRendering: vi.fn(),
		setIsDenoising: vi.fn(),
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
		useCameraStore: { getState: () => ( { setSelectMode: vi.fn(), handleAFScreenPointChange: vi.fn(), setAutoFocusDistance: vi.fn() } ) },
		usePathTracerStore: { getState: () => ( { setCurrentAutoExposure: vi.fn(), setCurrentAvgLuminance: vi.fn() } ) },
		useAnimationStore: { getState: () => ( { setIsPlaying: vi.fn(), setIsPaused: vi.fn(), setClips: vi.fn() } ) },
		_state: state,
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

		connectEngineToStore( engine, stores );

		engine._emit( 'RENDER_RESET' );

		expect( stores._state.setIsRenderComplete ).toHaveBeenCalledWith( false );
		expect( stores._state.setIsRendering ).toHaveBeenCalledWith( true );
		expect( stores._state.setCompletionReason ).toHaveBeenCalledWith( null );

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

	it( 'should update animation clips on SceneRebuild', () => {

		// SceneRebuild handler also dispatches a window CustomEvent
		globalThis.window = { dispatchEvent: vi.fn() };
		globalThis.CustomEvent = class CustomEvent {

			constructor( type ) {

				this.type = type;

			}

		};

		const mockClips = [ { index: 0, name: 'Walk', duration: 2.0 } ];
		engine.animationManager = { clips: mockClips };

		const setClips = vi.fn();
		stores.useAnimationStore = { getState: () => ( { setClips } ) };

		connectEngineToStore( engine, stores );
		engine._emit( 'SceneRebuild' );

		expect( setClips ).toHaveBeenCalledWith( mockClips );

		delete globalThis.window;
		delete globalThis.CustomEvent;

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

	} );

} );
