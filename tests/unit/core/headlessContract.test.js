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

/** Bare receiver. `advanceBy: 0` models a stall; `retireAfter` models adaptive convergence. */
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

} );
