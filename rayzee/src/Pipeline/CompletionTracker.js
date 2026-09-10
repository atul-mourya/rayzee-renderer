import { createLogger } from '../utils/Logger.js';

const log = createLogger( 'engine' );

/**
 * Tracks render completion state, time limits, and sample limits.
 *
 * Owns: timeElapsed, lastResetTime, renderCompleteDispatched.
 * Called each frame by the render loop and on reset.
 */
export class CompletionTracker {

	constructor() {

		this.timeElapsed = 0;
		this.lastResetTime = performance.now();
		this.renderCompleteDispatched = false;

		/** Whether the deadline — rather than the ceiling or convergence — retired the frame. */
		this.budgetOverrun = false;
		this._budgetHeldWarned = false;

	}

	/**
	 * Updates elapsed time. Call each frame while rendering is active.
	 */
	updateTime() {

		this.timeElapsed = ( performance.now() - this.lastResetTime ) / 1000;

	}

	/**
	 * Checks whether the wall-clock render budget has expired. An additional stop condition,
	 * never a replacement — the sample ceiling and convergence still bind when they come first.
	 *
	 * Floored at one sample: frameCount does not advance while the stage compiles kernels or
	 * while the camera is in interaction mode, and retiring in that window denoises an empty
	 * buffer and captures a blank canvas.
	 *
	 * @param {Object} pathTracer - The PathTracer stage
	 * @param {string} renderLimitMode - 'time' or 'frames'
	 * @param {number} renderTimeLimit - Time limit in seconds
	 * @returns {boolean}
	 */
	isTimeLimitReached( pathTracer, renderLimitMode, renderTimeLimit ) {

		if ( renderLimitMode !== 'time' || ! ( renderTimeLimit > 0 ) ) return false;
		if ( this.timeElapsed < renderTimeLimit ) return false;

		if ( ! ( pathTracer?.frameCount > 0 ) ) {

			if ( ! this._budgetHeldWarned ) {

				this._budgetHeldWarned = true;
				log.warn(
					`render time limit (${renderTimeLimit}s) expired before the first sample landed — ` +
					'holding the deadline open to avoid capturing an empty frame'
				);

			}

			return false;

		}

		this.budgetOverrun = true;
		return true;

	}

	/**
	 * Checks whether ANY render limit is reached: sample ceiling, convergence, or time budget,
	 * whichever arrives first.
	 *
	 * @param {Object} pathTracer - The PathTracer stage
	 * @param {string} renderLimitMode
	 * @param {number} renderTimeLimit
	 * @returns {boolean}
	 */
	isLimitReached( pathTracer, renderLimitMode, renderTimeLimit ) {

		if ( ! pathTracer ) return false;

		// Arms budgetOverrun, which stopCondition reads.
		if ( this.isTimeLimitReached( pathTracer, renderLimitMode, renderTimeLimit ) ) return true;

		return this.stopCondition( pathTracer ) !== null;

	}

	/**
	 * Which stop condition is satisfied, or null to keep rendering — the one place the condition
	 * set lives, so "should we stop" and "why did we stop" cannot drift apart. The Tier-1
	 * convergence check must agree with PathTracer.render()'s own, else the app-level reconcile
	 * flips isComplete back off and keeps dispatching after the frame converged.
	 *
	 * Ceiling before convergence: a render that spent its whole budget reports the ceiling even
	 * when it also converged on that sample.
	 *
	 * @param {Object} pathTracer - The PathTracer stage
	 * @returns {'timeLimit'|'samples'|'converged'|null}
	 */
	stopCondition( pathTracer ) {

		if ( this.budgetOverrun ) return 'timeLimit';
		if ( ! pathTracer ) return null;
		if ( pathTracer.frameCount >= pathTracer.completionThreshold ) return 'samples';
		if ( pathTracer._isConvergedComplete?.() ) return 'converged';

		return null;

	}

	/**
	 * Marks render as complete and returns true if this is the first time.
	 * @returns {boolean} true if freshly completed (should trigger denoise chain)
	 */
	markComplete() {

		if ( this.renderCompleteDispatched ) return false;
		this.renderCompleteDispatched = true;
		return true;

	}

	/**
	 * Resets all tracking state. Call on accumulation reset.
	 */
	reset() {

		this.timeElapsed = 0;
		this.lastResetTime = performance.now();
		this.renderCompleteDispatched = false;
		this.budgetOverrun = false;
		this._budgetHeldWarned = false;

	}

	/**
	 * Adjusts lastResetTime to account for idle time so timeElapsed
	 * continues from where it paused rather than including idle time.
	 */
	resumeFromPause() {

		this.renderCompleteDispatched = false;
		this.lastResetTime = performance.now() - this.timeElapsed * 1000;

	}

}
