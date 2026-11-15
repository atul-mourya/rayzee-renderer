import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp, describeAdapter } from '@/core/viewer/PathTracerApp.js';

describe( 'describeAdapter', () => {

	it( 'flags SwiftShader, which a headless host silently falls back to', () => {

		const info = describeAdapter( { info: { vendor: 'google', architecture: 'swiftshader', device: '', description: 'SwiftShader Device (LLVM 16)' } } );
		expect( info.isSoftware ).toBe( true );
		expect( info.description ).toContain( 'SwiftShader' );

	} );

	it( 'flags llvmpipe and WARP', () => {

		expect( describeAdapter( { info: { description: 'llvmpipe (LLVM 15, 256 bits)' } } ).isSoftware ).toBe( true );
		expect( describeAdapter( { info: { description: 'Microsoft Basic Render Driver' } } ).isSoftware ).toBe( true );

	} );

	it( 'honours isFallbackAdapter from either spec position', () => {

		expect( describeAdapter( { info: { isFallbackAdapter: true } } ).isSoftware ).toBe( true );
		expect( describeAdapter( { isFallbackAdapter: true, info: {} } ).isSoftware ).toBe( true );

	} );

	it( 'leaves real hardware unflagged', () => {

		const info = describeAdapter( { info: { vendor: 'apple', architecture: 'metal-3', device: '', description: 'Apple M3 Max' } } );
		expect( info.isSoftware ).toBe( false );
		expect( info.vendor ).toBe( 'apple' );

	} );

	it( 'survives an adapter with no info at all', () => {

		const info = describeAdapter( {} );
		expect( info.isSoftware ).toBe( false );
		expect( info.vendor ).toBe( '' );

	} );

} );

/** Bare receiver. `advanceBy: 0` models a stall; `retireAfter` models adaptive convergence. */
function makeApp( { advanceBy = 1, retireAfter = Infinity } = {} ) {

	const stage = {
		frameCount: 0,
		isComplete: false,
		isReady: true,
		readbackWait: () => null,
		noteFrame: vi.fn(),
	};

	const app = {
		stages: { pathTracer: stage },
		_deviceLost: false,
		settings: { get: () => 0, set: vi.fn() },
		reset: () => {

			stage.frameCount = 0;
			stage.isComplete = false;

		},
		stopAnimation: () => {},
		camera: { updateMatrixWorld: () => {} },
		pipeline: {
			compileWait: () => null,
			render: () => {

				if ( stage.isComplete ) return;

				if ( stage.frameCount >= retireAfter ) {

					stage.isComplete = true;
					return;

				}

				stage.frameCount += advanceBy;

			}
		},
		renderFrames: PathTracerApp.prototype.renderFrames,
		_finishImage: PathTracerApp.prototype._finishImage,
	};

	return { app, stage };

}

describe( 'renderFrames', () => {

	it( 'accumulates the requested count, each pass a frame interaction mode counts', async () => {

		const { app } = makeApp();
		await expect( app.renderFrames( 8, { yieldEvery: 0 } ) ).resolves.toBe( 8 );
		expect( app.stages.pathTracer.noteFrame ).toHaveBeenCalledTimes( 8 );

	} );

	// A load frames the camera with lookAt(), which leaves matrixWorld stale; nothing else refreshes it headless.
	it( 'brings the camera\'s world matrix up to date before every pass', async () => {

		const { app } = makeApp();
		let updates = 0;
		app.camera.updateMatrixWorld = () => void updates ++;
		await app.renderFrames( 5, { yieldEvery: 0 } );
		expect( updates ).toBe( 5 );

	} );

	// The bug the farm hit: a retired frame stops advancing frameCount.
	it( 'throws when adaptive convergence retires the frame early', async () => {

		const { app } = makeApp( { retireAfter: 3 } );
		await expect( app.renderFrames( 10, { yieldEvery: 0 } ) ).rejects.toThrow( /adaptive sampling retired the frame/ );

	} );

	it( 'names allowEarlyRetire in that error, not maxSamples', async () => {

		const { app } = makeApp( { retireAfter: 3 } );
		await expect( app.renderFrames( 10, { yieldEvery: 0 } ) ).rejects.toThrow( /allowEarlyRetire/ );

	} );

	it( 'returns the short count instead of throwing when allowed', async () => {

		const { app } = makeApp( { retireAfter: 3 } );
		await expect( app.renderFrames( 10, { yieldEvery: 0, allowEarlyRetire: true } ) ).resolves.toBe( 3 );

	} );

	// Without the break: count + 64 no-op dispatches before the throw.
	it( 'stops dispatching as soon as the frame retires', async () => {

		const { app, stage } = makeApp( { retireAfter: 2 } );
		const render = vi.spyOn( app.pipeline, 'render' );
		await app.renderFrames( 500, { yieldEvery: 0, allowEarlyRetire: true } );
		expect( render.mock.calls.length ).toBeLessThan( 10 );
		expect( stage.frameCount ).toBe( 2 );

	} );

	it( 'still throws on a stall with no retirement', async () => {

		const { app } = makeApp( { advanceBy: 0 } );
		await expect( app.renderFrames( 5, { yieldEvery: 0, allowEarlyRetire: true } ) )
			.rejects.toThrow( /a stray reset, or a canvas resize/ );

	} );

	it( 'rejects a non-positive count', async () => {

		const { app } = makeApp();
		await expect( app.renderFrames( 0 ) ).rejects.toThrow( /count must be positive/ );

	} );

	describe( 'firstSample', () => {

		/** As setDeterministicMode leaves the stage: the reset rewinds the sequence to `_firstSample`. */
		const pinned = () => {

			const made = makeApp();
			made.stage._pinSeedToFrame = true;
			made.stage._firstSample = 0;
			const reset = made.app.reset;
			made.app.reset = () => {

				made.atReset = made.stage._firstSample;
				reset();

			};

			return made;

		};

		it( 'is where the reset rewinds the sequence to', async () => {

			const made = pinned();
			await expect( made.app.renderFrames( 8, { yieldEvery: 0, firstSample: 64 } ) ).resolves.toBe( 8 );
			expect( made.atReset ).toBe( 64 );

		} );

		// Otherwise every later reset, a plain render's included, would start at the split render's offset.
		it( 'goes back to 0 for a render that does not ask for one', async () => {

			const made = pinned();
			await made.app.renderFrames( 8, { yieldEvery: 0, firstSample: 64 } );
			await made.app.renderFrames( 8, { yieldEvery: 0 } );
			expect( made.atReset ).toBe( 0 );

		} );

		it( 'is not kept past its render: a reset after it (app.reset, a load, a mode switch) starts at 0', async () => {

			const made = pinned();
			await made.app.renderFrames( 8, { yieldEvery: 0, firstSample: 64 } );
			expect( made.stage._firstSample ).toBe( 0 );
			made.app.reset();
			expect( made.atReset ).toBe( 0 );

		} );

		it( 'is let go of when the render throws, too', async () => {

			const made = pinned();
			made.stage.isReady = false;
			await expect( made.app.renderFrames( 8, { yieldEvery: 0, firstSample: 64 } ) ).rejects.toThrow();
			expect( made.stage._firstSample ).toBe( 0 );

		} );

		it( 'refuses lockstep without deterministic mode: interaction mode and the pixel freeze leave the range untrue', async () => {

			const made = pinned();
			made.stage._pinSeedToFrame = false;
			made.stage.lockstepReadbacks = true;
			await expect( made.app.renderFrames( 4, { yieldEvery: 0, firstSample: 4 } ) ).rejects.toThrow( /setDeterministicMode/ );

		} );

		it( 'stops below 2³¹, where Halton\'s signed index would wrap', async () => {

			const made = pinned();
			await expect( made.app.renderFrames( 8, { yieldEvery: 0, firstSample: 2 ** 31 - 4 } ) ).rejects.toThrow( /2³¹/ );

		} );

		it( 'refuses a sequence that runs free, which no reset rewinds', async () => {

			const { app } = makeApp();
			await expect( app.renderFrames( 8, { firstSample: 64 } ) ).rejects.toThrow( /setDeterministicMode/ );

		} );

		it( 'refuses to continue a render from somewhere else', async () => {

			const made = pinned();
			await expect( made.app.renderFrames( 8, { reset: false, firstSample: 64 } ) ).rejects.toThrow( /reset: true/ );

		} );

		it( 'refuses what is not a sample index', async () => {

			const made = pinned();
			for ( const firstSample of [ - 1, 1.5, NaN, 2 ** 32 ] ) {

				await expect( made.app.renderFrames( 8, { firstSample } ) ).rejects.toThrow( /firstSample must be a whole number/ );

			}

		} );

	} );

} );

describe( 'setDeterministicMode', () => {

	it( 'forgets a split render\'s first sample when it ends', () => {

		const stage = { _bounceEarlyExitThreshold: 0.02, _useDynamicDispatch: true, _pinSeedToFrame: false, _firstSample: 0 };
		const app = {
			stages: { pathTracer: stage },
			settings: { get: () => false, setMany: () => {} },
			reset: () => {},
			stopAnimation: () => {},
			_deterministicSnapshot: () => ( {} ),
			_setDeterministicExtras: () => {},
			setDeterministicMode: PathTracerApp.prototype.setDeterministicMode,
		};

		app.setDeterministicMode( true );
		stage._firstSample = 64;
		app.setDeterministicMode( false );
		expect( stage._firstSample ).toBe( 0 );

	} );

} );
