import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CompletionTracker } from '@/core/Pipeline/CompletionTracker.js';

// Stand-in for the PathTracer stage: only the fields CompletionTracker reads.
function makeStage( { frameCount = 1, completionThreshold = 30, converged = false } = {} ) {

	return { frameCount, completionThreshold, _isConvergedComplete: () => converged };

}

describe( 'CompletionTracker', () => {

	let tracker;
	let now;

	beforeEach( () => {

		now = 0;
		vi.spyOn( performance, 'now' ).mockImplementation( () => now );
		tracker = new CompletionTracker();

	} );

	afterEach( () => {

		vi.restoreAllMocks();

	} );

	const advance = ms => {

		now += ms;
		tracker.updateTime();

	};

	// ── updateTime ─────────────────────────────────────────────

	describe( 'updateTime', () => {

		it( 'reports elapsed seconds since the last reset', () => {

			advance( 2500 );
			expect( tracker.timeElapsed ).toBe( 2.5 );

		} );

		it( 'reset rebases the clock', () => {

			advance( 2500 );
			tracker.reset();
			expect( tracker.timeElapsed ).toBe( 0 );
			advance( 1000 );
			expect( tracker.timeElapsed ).toBe( 1 );

		} );

	} );

	// ── isTimeLimitReached ─────────────────────────────────────

	describe( 'isTimeLimitReached', () => {

		it( 'fires once the budget expires', () => {

			const stage = makeStage();
			advance( 5000 );
			expect( tracker.isTimeLimitReached( stage, 'time', 5 ) ).toBe( true );

		} );

		it( 'does not fire before the budget expires', () => {

			const stage = makeStage();
			advance( 4999 );
			expect( tracker.isTimeLimitReached( stage, 'time', 5 ) ).toBe( false );

		} );

		it( 'is inert in frames mode', () => {

			const stage = makeStage();
			advance( 60000 );
			expect( tracker.isTimeLimitReached( stage, 'frames', 5 ) ).toBe( false );

		} );

		it( 'is inert when the budget is disarmed', () => {

			const stage = makeStage();
			advance( 60000 );
			expect( tracker.isTimeLimitReached( stage, 'time', 0 ) ).toBe( false );

		} );

		// Regression: an expired budget must not retire a render that has accumulated nothing —
		// isComplete would flip, the denoise chain would run on an empty buffer and getCanvas()
		// would hand back a blank canvas.
		it( 'holds the deadline open at zero samples', () => {

			const stage = makeStage( { frameCount: 0 } );
			advance( 10000 );
			expect( tracker.isTimeLimitReached( stage, 'time', 5 ) ).toBe( false );

		} );

		it( 'fires as soon as the first sample lands', () => {

			const stage = makeStage( { frameCount: 0 } );
			advance( 10000 );
			expect( tracker.isTimeLimitReached( stage, 'time', 5 ) ).toBe( false );
			stage.frameCount = 1;
			expect( tracker.isTimeLimitReached( stage, 'time', 5 ) ).toBe( true );

		} );

		it( 'holds the deadline open when the stage is missing', () => {

			advance( 10000 );
			expect( tracker.isTimeLimitReached( undefined, 'time', 5 ) ).toBe( false );

		} );

		it( 'flags budgetOverrun only when the deadline actually retired the frame', () => {

			const stage = makeStage();
			advance( 1000 );
			expect( tracker.isTimeLimitReached( stage, 'time', 5 ) ).toBe( false );
			expect( tracker.budgetOverrun ).toBe( false );
			advance( 4000 );
			expect( tracker.isTimeLimitReached( stage, 'time', 5 ) ).toBe( true );
			expect( tracker.budgetOverrun ).toBe( true );
			tracker.reset();
			expect( tracker.budgetOverrun ).toBe( false );

		} );

	} );

	// ── isLimitReached ─────────────────────────────────────────

	describe( 'isLimitReached: sample ceiling, convergence and budget combine', () => {

		// Regression for the reported bug: arming a generous time budget used to *replace* the
		// sample ceiling rather than join it, so a non-binding deadline uncapped the render.
		it( 'honours the sample ceiling while a non-binding budget is armed', () => {

			const stage = makeStage( { frameCount: 30, completionThreshold: 30 } );
			advance( 1000 );
			expect( tracker.isLimitReached( stage, 'time', 600 ) ).toBe( true );

		} );

		it( 'keeps rendering below the ceiling with a non-binding budget', () => {

			const stage = makeStage( { frameCount: 29, completionThreshold: 30 } );
			advance( 1000 );
			expect( tracker.isLimitReached( stage, 'time', 600 ) ).toBe( false );

		} );

		it( 'the budget retires the frame below the ceiling', () => {

			const stage = makeStage( { frameCount: 4, completionThreshold: 30 } );
			advance( 600 );
			expect( tracker.isLimitReached( stage, 'time', 0.5 ) ).toBe( true );

		} );

		it( 'convergence retires the frame below both limits', () => {

			const stage = makeStage( { frameCount: 11, completionThreshold: 30, converged: true } );
			advance( 100 );
			expect( tracker.isLimitReached( stage, 'time', 600 ) ).toBe( true );

		} );

		// Regression: 'time' mode with a disarmed budget used to render forever — the ceiling was
		// Infinity and the time check requires renderTimeLimit > 0, so nothing could stop it.
		it( 'terminates in time mode with a disarmed budget', () => {

			const stage = makeStage( { frameCount: 30, completionThreshold: 30 } );
			advance( 1000 );
			expect( tracker.isLimitReached( stage, 'time', 0 ) ).toBe( true );

		} );

		it( 'frames mode is unaffected by the budget', () => {

			const stage = makeStage( { frameCount: 29, completionThreshold: 30 } );
			advance( 600000 );
			expect( tracker.isLimitReached( stage, 'frames', 5 ) ).toBe( false );
			stage.frameCount = 30;
			expect( tracker.isLimitReached( stage, 'frames', 5 ) ).toBe( true );

		} );

		it( 'returns false without a stage', () => {

			expect( tracker.isLimitReached( null, 'time', 5 ) ).toBe( false );

		} );

		it( 'tolerates a stage with no convergence hook', () => {

			const stage = { frameCount: 5, completionThreshold: 30 };
			expect( tracker.isLimitReached( stage, 'frames', 0 ) ).toBe( false );

		} );

	} );

	// ── markComplete / resumeFromPause ─────────────────────────

	describe( 'markComplete', () => {

		it( 'returns true once, then false', () => {

			expect( tracker.markComplete() ).toBe( true );
			expect( tracker.markComplete() ).toBe( false );

		} );

		it( 'rearms after reset', () => {

			tracker.markComplete();
			tracker.reset();
			expect( tracker.markComplete() ).toBe( true );

		} );

	} );

	describe( 'resumeFromPause', () => {

		it( 'excludes idle time from the elapsed clock', () => {

			advance( 3000 );
			tracker.markComplete();
			now += 60000; // idle
			tracker.resumeFromPause();
			expect( tracker.renderCompleteDispatched ).toBe( false );
			tracker.updateTime();
			expect( tracker.timeElapsed ).toBe( 3 );

		} );

	} );

} );
