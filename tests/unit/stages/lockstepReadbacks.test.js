/**
 * Lockstep readbacks: a readback issued at frame N is applied at exactly frame N + 4, and the frame
 * waits when it has not landed. Without that, which frame retired an adaptive render depended on
 * how fast frames were submitted.
 */
import { describe, it, expect, vi } from 'vitest';
import { PathTracer } from '@/core/Stages/PathTracer.js';
import { COUNTER } from '@/core/Processor/QueueManager.js';

const W = 4, H = 2, N_SNAPSHOTS = 32;

/** The stage needs a GPU to construct; the readback bookkeeping only needs these fields. */
function makeStage() {

	const reads = [];
	const stage = Object.assign( Object.create( PathTracer.prototype ), {
		isReady: true,
		_wavefrontReady: true,
		_lightBufferRealloc: false,
		isComplete: true, // render() returns at the stop test, just after the lockstep block
		_auxSeedPending: false,
		frameCount: 0,
		_lockstep: false,
		_lockstepRead: null,
		_readbackEveryNFrames: 4,
		_readbackGeneration: 0,
		maxBounces: { value: 3 },
		transmissiveBounces: { value: 2 },
		maxSubsurfaceSteps: { value: 1 },
		_wfRenderWidth: { value: W },
		_wfRenderHeight: { value: H },
		_queueManager: {
			MAX_BOUNCE_SNAPSHOTS: N_SNAPSHOTS,
			getBounceCountsAttribute: () => 'bounces',
			getCountersAttribute: () => 'counters',
		},
		renderer: {
			// Each readback resolves only when the test says so.
			getArrayBufferAsync: vi.fn( ( attr ) => new Promise( ( resolve ) => reads.push( { attr, resolve } ) ) ),
		},
		_lastBounceCounts: null,
		_lastBounceEnergy: null,
		_curveSizingValid: false,
		_convergedFraction: 0,
		_convergedGeometryFraction: 0,
		_lastActivePixelCount: 0,
	} );

	const land = ( { converged = 0, energy = 7 } = {} ) => {

		const bounce = new Uint32Array( 2 * N_SNAPSHOTS ).fill( energy );
		const counters = new Uint32Array( COUNTER.COUNT );
		counters[ COUNTER.CONVERGED_COUNT ] = converged;
		counters[ COUNTER.GEOMETRY_COUNT ] = W * H;
		counters[ COUNTER.CONVERGED_GEOMETRY_COUNT ] = converged;
		for ( const r of reads.splice( 0 ) ) r.resolve( ( r.attr === 'bounces' ? bounce : counters ).buffer );
		return Promise.resolve().then( () => {} ).then( () => {} );

	};

	return { stage, reads, land };

}

describe( 'lockstep readbacks', () => {

	it( 'issues on a fixed cadence, starting with frame 0', () => {

		const { stage, reads } = makeStage();
		stage.setLockstepReadbacks( true );

		for ( const frame of [ 0, 1, 2, 3, 4 ] ) {

			stage.frameCount = frame;
			stage._lockstepRead = null;
			reads.length = 0;
			stage._maybeReadbackCounters();
			expect( reads.length > 0 ).toBe( frame % 4 === 0 );

		}

	} );

	it( 'counts converged pixels exactly on the frames it reads', () => {

		const { stage } = makeStage();
		stage.setLockstepReadbacks( true );

		stage.frameCount = 8;
		expect( stage._willReadCountersThisFrame() ).toBe( true );
		stage.frameCount = 9;
		expect( stage._willReadCountersThisFrame() ).toBe( false );

	} );

	it( 'holds the due frame until the readback lands, then applies it there', async () => {

		const { stage, land } = makeStage();
		stage.setLockstepReadbacks( true );
		stage._maybeReadbackCounters(); // issued at frame 0

		stage.frameCount = 3;
		expect( stage.readbackWait() ).toBeNull();

		stage.frameCount = 4;
		expect( stage.readbackWait() ).toBeInstanceOf( Promise );
		stage.render();
		expect( stage._lockstepRead ).not.toBeNull(); // traced nothing, applied nothing

		await land( { converged: 6 } );
		expect( stage.readbackWait() ).toBeNull();
		stage.render();

		expect( stage._lockstepRead ).toBeNull();
		expect( stage._convergedFraction ).toBe( 6 / ( W * H ) );
		expect( stage._curveSizingValid ).toBe( true );
		expect( stage._lastBounceEnergy[ 0 ] ).toBe( 7 );

	} );

	it( 'does not apply a readback early, however soon it lands', async () => {

		const { stage, land } = makeStage();
		stage.setLockstepReadbacks( true );
		stage._maybeReadbackCounters();
		await land( { converged: 8 } );

		stage.frameCount = 3;
		stage.render();
		expect( stage._convergedFraction ).toBe( 0 );

		stage.frameCount = 4;
		stage.render();
		expect( stage._convergedFraction ).toBe( 1 );

	} );

	it( 'drops a readback measured before a reset', async () => {

		const { stage, land } = makeStage();
		stage.setLockstepReadbacks( true );
		stage._maybeReadbackCounters();
		const issued = stage._lockstepRead;

		stage._readbackGeneration ++; // what reset() and a camera move do
		await land( { converged: 8 } );
		issued.apply();

		expect( stage._convergedFraction ).toBe( 0 );
		expect( stage._curveSizingValid ).toBe( false );

	} );

	it( 'issues one at a time, even when frames stop counting', () => {

		const { stage, reads } = makeStage();
		stage.setLockstepReadbacks( true );

		stage._maybeReadbackCounters();
		stage._maybeReadbackCounters(); // frameCount still 0: a frame that did not count

		expect( reads ).toHaveLength( 2 ); // one readback: its two buffers
		expect( stage._willReadCountersThisFrame() ).toBe( false );

	} );

	it( 'issues none while the camera moves', () => {

		const { stage, reads } = makeStage();
		stage.setLockstepReadbacks( true );
		stage.cameraOptimizer = { isInInteractionMode: () => true };

		stage._maybeReadbackCounters();
		expect( reads ).toHaveLength( 0 );
		expect( stage._willReadCountersThisFrame() ).toBe( false );

	} );

	// The frame after a reset sees the camera as moved whenever the frame before it traced another view (another
	// scene, a host's own camera): skipping that frame's readback made the first render after a load differ.
	it( 'issues on frame 0 when the frame before traced another view', () => {

		const { stage, reads } = makeStage();
		stage.setLockstepReadbacks( true );
		stage.cameraChanged = true;
		stage.cameraOptimizer = { isInInteractionMode: () => false };

		expect( stage._willReadCountersThisFrame() ).toBe( true );
		stage._maybeReadbackCounters();
		expect( reads ).toHaveLength( 2 );
		expect( stage._lockstepRead.due ).toBe( 4 );

	} );

	it( 'is inert when off', () => {

		const { stage } = makeStage();
		stage._readbackPending = true; // the free-running path's single-flight guard
		stage._maybeReadbackCounters();

		expect( stage._lockstepRead ).toBeNull();
		expect( stage.readbackWait() ).toBeNull();

	} );

	it( 'keeps going when a readback fails, rather than waiting forever', async () => {

		const { stage } = makeStage();
		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		stage.renderer.getArrayBufferAsync = () => Promise.reject( new Error( 'mapAsync failed' ) );
		stage.setLockstepReadbacks( true );
		stage._maybeReadbackCounters();

		stage.frameCount = 4;
		await stage.readbackWait();
		expect( stage.readbackWait() ).toBeNull();
		stage.render();
		expect( stage._lockstepRead ).toBeNull();

	} );

	it( 'starts every render from nothing the previous one measured, and from seed 0', () => {

		const { stage } = makeStage();
		Object.assign( stage, {
			resetCount: 0, frame: { value: 9 }, hasPreviousAccumulated: { value: 1 }, storageTextures: {},
			updateCompletionThreshold: () => {}, _seedTick: 41, _pinSeedToFrame: false,
			_lastBounceCounts: new Uint32Array( 4 ), _lastBounceEnergy: new Uint32Array( 4 ), _curveSizingValid: true,
		} );
		stage.setLockstepReadbacks( true );
		stage._maybeReadbackCounters();
		const generation = stage._readbackGeneration;

		stage.reset();

		expect( stage._lockstepRead ).toBeNull();
		expect( stage._readbackGeneration ).toBe( generation + 1 );
		expect( stage._lastBounceCounts ).toBeNull();
		expect( stage._curveSizingValid ).toBe( false );
		expect( stage._seedTick ).toBe( 0 );

	} );

	it( 'leaves a free-running render its curve and seed across a reset', () => {

		const { stage } = makeStage();
		const curve = new Uint32Array( 4 );
		Object.assign( stage, {
			resetCount: 0, frame: { value: 9 }, hasPreviousAccumulated: { value: 1 }, storageTextures: {},
			updateCompletionThreshold: () => {}, _seedTick: 41, _pinSeedToFrame: false, _lastBounceCounts: curve,
		} );

		stage.reset();

		expect( stage._lastBounceCounts ).toBe( curve );
		expect( stage._seedTick ).toBe( 41 );

	} );

	describe( 'accumulationLockstep', () => {

		const resettable = ( stage ) => Object.assign( stage, {
			resetCount: 0, frame: { value: 0 }, hasPreviousAccumulated: { value: 0 }, storageTextures: {},
			updateCompletionThreshold: () => {}, _seedTick: 41, _pinSeedToFrame: false,
		} );

		// renderUntilComplete turns lockstep off again as it returns; the image was still traced in it.
		it( 'says what the image was traced with, not what is set now', () => {

			const { stage } = makeStage();
			resettable( stage );
			stage.setLockstepReadbacks( true );
			stage.reset();
			stage.frameCount = 12;
			stage.setLockstepReadbacks( false );

			expect( stage.lockstepReadbacks ).toBe( false );
			expect( stage.accumulationLockstep ).toBe( true );

		} );

		it( 'is false when the reset that started the image was not in lockstep', () => {

			const { stage } = makeStage();
			resettable( stage );
			stage.reset();
			stage.setLockstepReadbacks( true );
			stage.frameCount = 4;

			expect( stage.accumulationLockstep ).toBe( false );

		} );

		it( 'is the setting before any sample', () => {

			const { stage } = makeStage();
			stage.setLockstepReadbacks( true );
			expect( stage.accumulationLockstep ).toBe( true );

		} );

	} );


} );
