import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock engine dependencies
vi.mock( 'three', () => ( {} ) );

vi.mock( '@/core/EngineEvents.js', () => ( {
	EngineEvents: {
		DENOISING_END: 'engine:denoisingEnd',
		VIDEO_RENDER_PROGRESS: 'engine:videoRenderProgress',
		VIDEO_RENDER_COMPLETE: 'engine:videoRenderComplete',
	},
} ) );

vi.mock( '@/core/EngineDefaults.js', () => ( {
	PRODUCTION_RENDER_CONFIG: { maxSamples: 30 },
} ) );

vi.mock( '@/core/Processor/utils.js', () => ( {
	updateStats: vi.fn(),
	getDisplaySamples: vi.fn( () => 1 ),
} ) );

const { VideoRenderManager } = await import( '@/core/managers/VideoRenderManager.js' );

function createMockApp( { clipDuration = 2.0, framesTillComplete = 3 } = {} ) {

	let frameCount = 0;

	return {
		cameraManager: {
			camera: { updateMatrixWorld: vi.fn() },
			controls: { enabled: true },
		},
		animationManager: {
			hasAnimations: true,
			clips: [ { index: 0, name: 'Walk', duration: clipDuration } ],
			seekTo: vi.fn( () => new Float32Array( 9 ) ),
			stop: vi.fn(),
		},
		stages: {
			pathTracer: {
				isReady: true,
				get isComplete() {

					return frameCount >= framesTillComplete;

				},
				set isComplete( v ) {},
				get frameCount() {

					return frameCount;

				},
				renderMode: { value: 0 },
				updateCompletionThreshold: vi.fn(),
				setUniform: vi.fn(),
			},
			display: { render: vi.fn() },
		},
		pipeline: {
			context: {},
			render: vi.fn( () => {

				frameCount ++;

			} ),
			reset: vi.fn(),
		},
		settings: {
			get: vi.fn( ( key ) => {

				const defaults = { maxSamples: 60, maxBounces: 3, transmissiveBounces: 8 };
				return defaults[ key ];

			} ),
			setMany: vi.fn(),
		},
		denoisingManager: {
			denoiser: { enabled: false, quality: 'fast', updateQuality: vi.fn() },
			// The two decisions the manager owns; `denoiser.enabled` is only their union.
			finalDenoise: false,
			oidnQuality: 'fast',
			applyOIDNEnabled: vi.fn(),
			applyOIDNQuality: vi.fn(),
			abort: vi.fn(),
			upscaler: { abort: vi.fn() },
		},
		renderer: { domElement: { style: {} } },
		pauseRendering: false,
		needsReset: false,
		configureForMode: vi.fn(),
		stopAnimation: vi.fn(),
		wake: vi.fn(),
		reset: vi.fn( () => {

			frameCount = 0;

		} ),
		refitBVH: vi.fn( async () => {

			frameCount = 0;

		} ),
		setRenderMode: vi.fn(),
		getCanvas: vi.fn( () => {

			// Return a minimal object that createImageBitmap can't actually use,
			// but we mock createImageBitmap globally
			return { width: 100, height: 100 };

		} ),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(),
	};

}

// Mock createImageBitmap globally
globalThis.createImageBitmap = vi.fn( async () => ( { close: vi.fn() } ) );

describe( 'VideoRenderManager', () => {

	let manager;
	let app;

	beforeEach( () => {

		vi.clearAllMocks();
		app = createMockApp( { clipDuration: 1.0, framesTillComplete: 2 } );
		manager = new VideoRenderManager( app );

	} );

	describe( 'constructor', () => {

		it( 'initializes with idle state', () => {

			expect( manager.isRendering ).toBe( false );

		} );

	} );

	describe( 'renderAnimation', () => {

		it( 'calls onComplete with false when no animations', async () => {

			app.animationManager.hasAnimations = false;
			const onComplete = vi.fn();
			await manager.renderAnimation( { onComplete } );
			expect( onComplete ).toHaveBeenCalledWith( false );

		} );

		it( 'calls onComplete with false for invalid clip index', async () => {

			const onComplete = vi.fn();
			await manager.renderAnimation( { clipIndex: 99, onComplete } );
			expect( onComplete ).toHaveBeenCalledWith( false );

		} );

		it( 'configures engine for production render mode', async () => {

			await manager.renderAnimation( { fps: 30, totalFrames: 1 } );
			expect( app.configureForMode ).toHaveBeenCalledWith( 'production' );

		} );

		it( 'stops rAF loop before rendering', async () => {

			await manager.renderAnimation( { fps: 30, totalFrames: 1 } );
			expect( app.stopAnimation ).toHaveBeenCalled();

		} );

		it( 'disables controls during render', async () => {

			await manager.renderAnimation( { fps: 30, totalFrames: 1 } );
			// Controls are disabled during render, then restored
			expect( app.cameraManager.controls.enabled ).toBe( true ); // restored after

		} );

		it( 'seeks animation to correct time per frame', async () => {

			await manager.renderAnimation( { fps: 10, speed: 1, totalFrames: 3 } );
			expect( app.animationManager.seekTo ).toHaveBeenCalledTimes( 3 );
			expect( app.animationManager.seekTo ).toHaveBeenNthCalledWith( 1, 0, 0 );
			expect( app.animationManager.seekTo ).toHaveBeenNthCalledWith( 2, 0.1, 0 );
			expect( app.animationManager.seekTo ).toHaveBeenNthCalledWith( 3, 0.2, 0 );

		} );

		it( 'applies speed multiplier to animation time', async () => {

			await manager.renderAnimation( { fps: 10, speed: 2, totalFrames: 2 } );
			expect( app.animationManager.seekTo ).toHaveBeenNthCalledWith( 1, 0, 0 );
			expect( app.animationManager.seekTo ).toHaveBeenNthCalledWith( 2, 0.2, 0 );

		} );

		it( 'calls onFrame with bitmap for each frame', async () => {

			const onFrame = vi.fn();
			await manager.renderAnimation( { fps: 30, totalFrames: 2, onFrame } );
			expect( onFrame ).toHaveBeenCalledTimes( 2 );

		} );

		it( 'reports progress via onProgress', async () => {

			const onProgress = vi.fn();
			await manager.renderAnimation( { fps: 30, totalFrames: 2, onProgress } );
			expect( onProgress ).toHaveBeenCalledTimes( 2 );
			expect( onProgress ).toHaveBeenLastCalledWith( {
				frame: 2,
				totalFrames: 2,
				percent: 100,
			} );

		} );

		it( 'calls onComplete with true on success', async () => {

			const onComplete = vi.fn();
			await manager.renderAnimation( { fps: 30, totalFrames: 1, onComplete } );
			expect( onComplete ).toHaveBeenCalledWith( true );

		} );

		it( 'restores engine state after render', async () => {

			await manager.renderAnimation( { fps: 30, totalFrames: 1 } );
			expect( app.settings.setMany ).toHaveBeenCalled();
			expect( app.wake ).toHaveBeenCalled();

		} );

	} );

	describe( 'cancel', () => {

		it( 'stops rendering on cancel', async () => {

			const onComplete = vi.fn();

			// Make accumulation slow enough to cancel
			app = createMockApp( { clipDuration: 10, framesTillComplete: 1000 } );
			manager = new VideoRenderManager( app );

			const renderPromise = manager.renderAnimation( { fps: 30, totalFrames: 5, onComplete } );

			// Cancel after a tick
			await new Promise( r => setTimeout( r, 10 ) );
			manager.cancel();

			await renderPromise;
			expect( onComplete ).toHaveBeenCalledWith( false );

		} );

	} );

	describe( 'totalFrames calculation', () => {

		it( 'computes frames from clip duration and fps', async () => {

			const onProgress = vi.fn();
			// clip duration = 1.0s, speed = 1, fps = 10 → 10 frames
			await manager.renderAnimation( { fps: 10, speed: 1, onProgress } );
			expect( onProgress ).toHaveBeenCalledTimes( 10 );

		} );

		it( 'accounts for speed in frame count', async () => {

			const onProgress = vi.fn();
			// clip duration = 1.0s, speed = 2, fps = 10 → 5 frames
			await manager.renderAnimation( { fps: 10, speed: 2, onProgress } );
			expect( onProgress ).toHaveBeenCalledTimes( 5 );

		} );

		it( 'uses totalFrames override when provided', async () => {

			const onProgress = vi.fn();
			await manager.renderAnimation( { fps: 10, totalFrames: 3, onProgress } );
			expect( onProgress ).toHaveBeenCalledTimes( 3 );

		} );

	} );

} );
