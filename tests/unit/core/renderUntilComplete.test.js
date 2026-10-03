import { describe, it, expect, vi, afterEach } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { CompletionTracker } from '@/core/Pipeline/CompletionTracker.js';
import { EngineEvents } from '@/core/EngineEvents.js';

/** Bare receiver: the stage completes at the ceiling, as PathTracer.render() retires it. */
function makeApp( { ceiling = 6, waitAtFrame = null, finalDenoise = false, settings = {} } = {} ) {

	let wait = null;
	let releaseWait = null;
	const rendered = [];

	const stage = {
		frameCount: 0,
		isComplete: false,
		isReady: true,
		completionThreshold: ceiling,
		lockstepReadbacks: false,
		setLockstepReadbacks( on ) {

			this.lockstepReadbacks = on;

		},
		readbackWait: () => wait,
		_isConvergedComplete: () => false,
	};

	const app = {
		stages: { pathTracer: stage },
		pipeline: {
			render: () => {

				if ( stage.frameCount >= stage.completionThreshold ) {

					stage.isComplete = true;
					return;

				}

				rendered.push( stage.frameCount ++ );
				if ( stage.frameCount === waitAtFrame ) {

					wait = new Promise( ( resolve ) => {

						releaseWait = () => {

							wait = null;
							resolve();

						};

					} );

				}

			},
		},
		completion: new CompletionTracker(),
		settings: {
			values: { interactionModeEnabled: true, ...settings },
			get( key ) {

				return this.values[ key ];

			},
			getEffective() {

				return { interactionModeEnabled: { value: this.values.interactionModeEnabled, source: 'default' } };

			},
			set: vi.fn( function ( key, value ) {

				this.values[ key ] = value;

			} ),
		},
		renderer: { backend: { device: { queue: { onSubmittedWorkDone: vi.fn( async () => {} ) } } } },
		camera: { updateMatrixWorld: () => {} },
		denoisingManager: { finalDenoise, afterTrace: () => {}, tickContinuousDenoise: vi.fn() },
		reset() {

			stage.frameCount = 0;
			stage.isComplete = false;
			this.completion.reset();

		},
		stopAnimation: vi.fn(),
		dispatchEvent: vi.fn(),
		runFinalDenoise: vi.fn( async () => true ),
		_ensureVRAMWiring: () => {},
		_traceFrame: PathTracerApp.prototype._traceFrame,
		_afterTrace: PathTracerApp.prototype._afterTrace,
		_finalDenoise: PathTracerApp.prototype._finalDenoise,
		_completionInfo: PathTracerApp.prototype._completionInfo,
		_awaitReadback: PathTracerApp.prototype._awaitReadback,
		renderUntilComplete: PathTracerApp.prototype.renderUntilComplete,
	};

	return { app, stage, rendered, release: () => releaseWait?.() };

}

describe( 'renderUntilComplete', () => {

	afterEach( () => vi.restoreAllMocks() );

	it( 'renders to the stop condition, reports it once, and never touches the rAF loop', async () => {

		const { app, rendered } = makeApp( { ceiling: 6 } );
		const out = await app.renderUntilComplete();

		expect( rendered ).toEqual( [ 0, 1, 2, 3, 4, 5 ] );
		expect( out ).toMatchObject( { samples: 6, retiredBy: 'samples', budgetOverrun: false, denoised: false } );
		const completes = app.dispatchEvent.mock.calls.filter( ( [ e ] ) => e.type === EngineEvents.RENDER_COMPLETE );
		expect( completes ).toHaveLength( 1 );
		expect( app.stopAnimation ).toHaveBeenCalled();
		expect( app.denoisingManager.tickContinuousDenoise ).not.toHaveBeenCalled();

	} );

	it( 'runs its readbacks in lockstep, and puts the previous setting back', async () => {

		const { app, stage } = makeApp();
		let during;
		app.pipeline.render = ( ( render ) => () => {

			during = stage.lockstepReadbacks;
			render();

		} )( app.pipeline.render );

		await app.renderUntilComplete();
		expect( during ).toBe( true );
		expect( stage.lockstepReadbacks ).toBe( false );

	} );

	it( 'waits on a readback that is due instead of rendering past it', async () => {

		const { app, rendered, release } = makeApp( { ceiling: 8, waitAtFrame: 4 } );
		const done = app.renderUntilComplete();

		await new Promise( ( r ) => setTimeout( r, 5 ) );
		expect( rendered ).toEqual( [ 0, 1, 2, 3 ] );

		release();
		expect( ( await done ).samples ).toBe( 8 );
		expect( rendered ).toEqual( [ 0, 1, 2, 3, 4, 5, 6, 7 ] );

	} );

	it( 'turns interaction mode off for the render, and back on after', async () => {

		const { app } = makeApp();
		let during;
		app.pipeline.render = ( ( render ) => () => {

			during = app.settings.values.interactionModeEnabled;
			render();

		} )( app.pipeline.render );

		await app.renderUntilComplete();
		expect( during ).toBe( false );
		expect( app.settings.values.interactionModeEnabled ).toBe( true );

	} );

	// The bench hung here: a frame that does not count, with nothing awaited, spun synchronously
	// and starved the very timer that would have let frames count again.
	it( 'gives timers a turn when a frame does not count', async () => {

		const { app, stage } = makeApp( { ceiling: 4 } );
		let held = true;
		setTimeout( () => {

			held = false;

		}, 0 );
		const render = app.pipeline.render;
		app.pipeline.render = () => ( held ? undefined : render() );

		const out = await app.renderUntilComplete( { drainEvery: 0 } );
		expect( out.samples ).toBe( 4 );
		expect( stage.isComplete ).toBe( true );

	} );

	it( 'runs the final denoise once when it is on', async () => {

		const { app } = makeApp( { finalDenoise: true } );
		expect( ( await app.renderUntilComplete() ).denoised ).toBe( true );
		expect( app.runFinalDenoise ).toHaveBeenCalledOnce();

	} );

	it( 'skips it when off, or when asked not to', async () => {

		const off = makeApp();
		await off.app.renderUntilComplete();
		expect( off.app.runFinalDenoise ).not.toHaveBeenCalled();

		const declined = makeApp( { finalDenoise: true } );
		await declined.app.renderUntilComplete( { denoise: false } );
		expect( declined.app.runFinalDenoise ).not.toHaveBeenCalled();

	} );

	it( 'stops at the time limit, which renderFrames never honoured', async () => {

		let now = 0;
		vi.spyOn( performance, 'now' ).mockImplementation( () => ( now += 1000 ) );
		const { app } = makeApp( { ceiling: 1000, settings: { renderLimitMode: 'time', renderTimeLimit: 3 } } );

		const out = await app.renderUntilComplete();
		expect( out.retiredBy ).toBe( 'timeLimit' );
		expect( out.budgetOverrun ).toBe( true );
		expect( out.samples ).toBeLessThan( 10 );

	} );

	it( 'keeps submissions a bounded number of frames ahead of the GPU', async () => {

		const { app } = makeApp( { ceiling: 16 } );
		await app.renderUntilComplete( { drainEvery: 4 } );
		expect( app.renderer.backend.device.queue.onSubmittedWorkDone ).toHaveBeenCalledTimes( 4 );

	} );

	it( 'rejects once aborted, and still restores lockstep', async () => {

		const { app, stage } = makeApp( { ceiling: 1000 } );
		const controller = new AbortController();
		const done = app.renderUntilComplete( { signal: controller.signal, onProgress: ( n ) => n === 5 && controller.abort( new Error( 'job cancelled' ) ) } );

		await expect( done ).rejects.toThrow( 'job cancelled' );
		expect( stage.lockstepReadbacks ).toBe( false );

	} );

	it( 'refuses before the stage is ready', async () => {

		const { app, stage } = makeApp();
		stage.isReady = false;
		await expect( app.renderUntilComplete() ).rejects.toThrow( /not ready/ );

	} );

} );
