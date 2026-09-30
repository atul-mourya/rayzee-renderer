import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { IssueLog } from '@/core/EngineIssues.js';

/** Bare receiver for the two methods under test. */
function makeApp( { looping = false } = {} ) {

	return {
		animationManagerId: looping ? 1 : null,
		_needsDisplayRefresh: false,
		_deviceLost: false,
		pipeline: { context: {} },
		stages: { compositor: { render: vi.fn() } },
		_renderHelperOverlay: vi.fn(),
		wake: vi.fn(),
		_issues: new IssueLog(),
		_presentDisplay: PathTracerApp.prototype._presentDisplay,
		runFinalDenoise: PathTracerApp.prototype.runFinalDenoise,
	};

}

describe( 'the closing denoise redraws without waking the loop', () => {

	// Waking it made a finished render nothing had marked complete (renderFrames, a video
	// export) look newly finished, and it denoised the same image a second time.
	it( 'draws once when the loop is stopped', () => {

		const app = makeApp();
		app._presentDisplay();

		expect( app.stages.compositor.render ).toHaveBeenCalledOnce();
		expect( app._renderHelperOverlay ).toHaveBeenCalledOnce();
		expect( app.wake ).not.toHaveBeenCalled();

	} );

	it( 'leaves it to the next tick when the loop is running', () => {

		const app = makeApp( { looping: true } );
		app._presentDisplay();

		expect( app._needsDisplayRefresh ).toBe( true );
		expect( app.stages.compositor.render ).not.toHaveBeenCalled();

	} );

	it( 'draws nothing on a lost device', () => {

		const app = makeApp();
		app._deviceLost = true;
		app._presentDisplay();

		expect( app.stages.compositor.render ).not.toHaveBeenCalled();

	} );

} );

describe( 'runFinalDenoise', () => {

	it( 'resolves true when a picture was published', async () => {

		const app = makeApp();
		app.denoisingManager = { denoiseOnce: vi.fn( async () => true ), denoiser: { enabled: true } };

		expect( await app.runFinalDenoise() ).toBe( true );
		expect( app._issues.list ).toHaveLength( 0 );

	} );

	it.each( [
		[ 'no denoiser', null, /was not built/ ],
		[ 'OIDN off', { enabled: false }, /OIDN was off while accumulating/ ],
		[ 'a failed run', { enabled: true }, /did not complete/ ],
	] )( 'names the reason on %s', async ( _, denoiser, reason ) => {

		const app = makeApp();
		app.denoisingManager = { denoiseOnce: vi.fn( async () => false ), denoiser };

		expect( await app.runFinalDenoise() ).toBe( false );
		expect( app._issues.list[ 0 ].code ).toBe( 'denoiser.unavailable' );
		expect( app._issues.list[ 0 ].message ).toMatch( reason );

	} );

	it( 'throws when strict', async () => {

		const app = makeApp();
		app._issues = new IssueLog( { strict: true } );
		app.denoisingManager = { denoiseOnce: vi.fn( async () => false ), denoiser: null };

		await expect( app.runFinalDenoise() ).rejects.toThrow( /denoiser.unavailable/ );

	} );

} );
