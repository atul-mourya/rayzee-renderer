import { describe, it, expect } from 'vitest';
import { BufferAttribute } from 'three';
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

describe( 'PathTracerStage BVH uploads', () => {

	const makeStage = () => ( {
		bvhStorageAttr: new BufferAttribute( new Float32Array( 16 * 8 ), 4 ),
		_dirtyBVHLeaves: new Set(),
		_flushBVHEdits: PathTracerStage.prototype._flushBVHEdits,
		_updateStorageBuffer: PathTracerStage.prototype._updateStorageBuffer,
		updateBVHData: PathTracerStage.prototype.updateBVHData,
	} );

	it( 'uploads only the TLAS leaves a visibility edit touched', () => {

		const stage = makeStage();
		stage._dirtyBVHLeaves.add( 2 ).add( 3 );
		stage._flushBVHEdits();

		expect( stage.bvhStorageAttr.updateRanges ).toEqual( [ { start: 32, count: 32 } ] );

	} );

	// Regression: the range a visibility edit left pending cut the next full upload down to it,
	// so a refit straight after a load reached the GPU as two TLAS leaves and nothing else.
	it( 'a full upload after a visibility edit still uploads everything', () => {

		const stage = makeStage();
		stage._dirtyBVHLeaves.add( 1 );
		stage._flushBVHEdits();
		const version = stage.bvhStorageAttr.version;

		stage.updateBVHData( new Float32Array( 16 * 8 ).fill( 1 ) );

		expect( stage.bvhStorageAttr.updateRanges ).toEqual( [] );
		expect( stage.bvhStorageAttr.version ).toBeGreaterThan( version );

	} );

} );
