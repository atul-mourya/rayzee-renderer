import { describe, it, expect } from 'vitest';
import { PathTracerStage } from '@/core/Stages/PathTracerStage.js';

// The stage needs a WebGPU renderer to construct, but the completion-threshold methods only
// touch three plain fields — call them against a bare receiver.
function makeReceiver( { renderMode = 0, maxSamples = 30, renderLimitMode = 'frames' } = {} ) {

	return {
		renderMode: { value: renderMode },
		maxSamples: { value: maxSamples },
		renderLimitMode,
		completionThreshold: 0,
		updateCompletionThreshold: PathTracerStage.prototype.updateCompletionThreshold,
		setRenderLimitMode: PathTracerStage.prototype.setRenderLimitMode,
	};

}

describe( 'PathTracerStage completion threshold', () => {

	it( 'tracks maxSamples in frames mode', () => {

		const stage = makeReceiver( { maxSamples: 64 } );
		stage.updateCompletionThreshold();
		expect( stage.completionThreshold ).toBe( 64 );

	} );

	// Regression: time mode used to set the threshold to Infinity, which erased the sample
	// ceiling instead of adding a deadline to it. A generous budget then uncapped the render
	// and a disarmed one made it unbounded.
	it( 'keeps the sample ceiling in time mode', () => {

		const stage = makeReceiver( { maxSamples: 30 } );
		stage.setRenderLimitMode( 'time' );
		expect( stage.completionThreshold ).toBe( 30 );

	} );

	it( 'is independent of the limit mode', () => {

		const thresholds = [ 'frames', 'time' ].map( mode => {

			const stage = makeReceiver( { maxSamples: 128 } );
			stage.setRenderLimitMode( mode );
			return stage.completionThreshold;

		} );

		expect( thresholds[ 0 ] ).toBe( thresholds[ 1 ] );
		expect( thresholds[ 0 ] ).toBeLessThan( Infinity );

	} );

	it( 'setRenderLimitMode records the mode and refreshes the threshold', () => {

		const stage = makeReceiver( { maxSamples: 10 } );
		stage.setRenderLimitMode( 'time' );
		expect( stage.renderLimitMode ).toBe( 'time' );
		stage.maxSamples.value = 200;
		stage.setRenderLimitMode( 'frames' );
		expect( stage.completionThreshold ).toBe( 200 );

	} );

} );
