import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp, describeAdapter } from '@/core/PathTracerApp.js';

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

/**
 * renderFrames() only touches the stage, the pipeline and the settings, so drive it against
 * a bare receiver. `advanceBy` is how many samples a render() call lands before the stage
 * retires itself — 0 models adaptive convergence, which stops frameCount dead.
 */
function makeApp( { advanceBy = 1, retireAfter = Infinity } = {} ) {

	const stage = {
		frameCount: 0,
		isComplete: false,
		isReady: true,
		blueNoiseReady: Promise.resolve(),
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
		pipeline: {
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
	};

	return { app, stage };

}

describe( 'renderFrames', () => {

	it( 'accumulates the requested count', async () => {

		const { app } = makeApp();
		await expect( app.renderFrames( 8, { yieldEvery: 0 } ) ).resolves.toBe( 8 );

	} );

	// The bug the render farm hit: adaptive sampling retires the frame, render() stops
	// advancing frameCount, and the fixed-count loop can never reach its target.
	it( 'throws when adaptive convergence retires the frame early', async () => {

		const { app } = makeApp( { retireAfter: 3 } );
		await expect( app.renderFrames( 10, { yieldEvery: 0 } ) ).rejects.toThrow( /adaptive sampling retired the frame/ );

	} );

	it( 'names allowEarlyRetire in that error, not maxSamples', async () => {

		const { app } = makeApp( { retireAfter: 3 } );
		await expect( app.renderFrames( 10, { yieldEvery: 0 } ) ).rejects.toThrow( /allowEarlyRetire/ );

	} );

	it( 'reports the retirement instead of throwing when allowed', async () => {

		const { app } = makeApp( { retireAfter: 3 } );
		await expect( app.renderFrames( 10, { yieldEvery: 0, allowEarlyRetire: true } ) )
			.resolves.toEqual( { samples: 3, target: 10, retiredBy: 'converged' } );

	} );

	it( 'reports retiredBy count when it reaches the target', async () => {

		const { app } = makeApp();
		await expect( app.renderFrames( 4, { yieldEvery: 0, allowEarlyRetire: true } ) )
			.resolves.toEqual( { samples: 4, target: 4, retiredBy: 'count' } );

	} );

	// Without the break, a retired frame burns every remaining pass to land on the same
	// frameCount — count + 64 no-op dispatches before the throw.
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

} );
