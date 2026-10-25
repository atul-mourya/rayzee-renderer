/**
 * Lockstep readbacks: a readback issued at frame N is applied at exactly frame N + 4, and the frame
 * waits when it has not landed. Without that, which frame retired an adaptive render depended on
 * how fast frames were submitted.
 */
import { describe, it, expect, vi } from 'vitest';
import { PathTracer } from '@/core/pathtracer/PathTracer.js';
import { COUNTER, QueueManager } from '@/core/pathtracer/QueueManager.js';

const W = 4, H = 2, N_SNAPSHOTS = 32;

/** The curves' layout without a GPU buffer: QueueManager's own offsets over `bands` bands. */
function makeQueues( bands ) {

	return Object.assign( Object.create( QueueManager.prototype ), {
		MAX_BOUNCE_SNAPSHOTS: N_SNAPSHOTS,
		curveBands: bands,
		getBounceCountsAttribute: () => 'bounces',
		getCountersAttribute: () => 'counters',
	} );

}

/** The stage needs a GPU to construct; the readback bookkeeping only needs these fields. */
function makeStage( { chunkRows = H } = {} ) {

	const reads = [];
	const queues = makeQueues( Math.ceil( H / chunkRows ) );
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
		numPointLights: { value: 0 },
		numSpotLights: { value: 0 },
		_compiledLightRadius: false,
		transmissiveBounces: { value: 2 },
		maxSubsurfaceSteps: { value: 1 },
		_wfRenderWidth: { value: W },
		_wfRenderHeight: { value: H },
		_chunkRows: chunkRows,
		_numChunks: Math.ceil( H / chunkRows ),
		_queueManager: queues,
		renderer: {
			// Each readback resolves only when the test says so.
			getArrayBufferAsync: vi.fn( ( attr ) => new Promise( ( resolve ) => reads.push( { attr, resolve } ) ) ),
		},
		_lastBounceCounts: null,
		_lastBounceEnergy: null,
		_curveSizingValid: false,
		_convergedFraction: 0,
		_convergedGeometryFraction: 0,
		_lastActivePixelCounts: null,
	} );

	// `bounce` fills the curves' buffer, given an index; by default every word is `energy`.
	const land = ( { converged = 0, energy = 7, bounce: fill = () => energy } = {} ) => {

		const bounce = Uint32Array.from( { length: queues.pixelCountOffset( queues.curveBands ) }, ( _, i ) => fill( i ) );
		const counters = new Uint32Array( COUNTER.COUNT );
		counters[ COUNTER.CONVERGED_COUNT ] = converged;
		counters[ COUNTER.GEOMETRY_COUNT ] = W * H;
		counters[ COUNTER.CONVERGED_GEOMETRY_COUNT ] = converged;
		for ( const r of reads.splice( 0 ) ) r.resolve( ( r.attr === 'bounces' ? bounce : counters ).buffer );
		return Promise.resolve().then( () => {} ).then( () => {} );

	};

	return { stage, reads, land, queues };

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

	// A frame past the path budget is traced in row bands; each sizes and ends its bounces from its own curve.
	describe( 'row bands', () => {

		const n = N_SNAPSHOTS;

		// Band b's survivor count at bounce i reads 100·(b + 1) + i, its energy 1000·(b + 1) + i, its pixel count 10·(b + 1).
		const perBand = ( queues ) => ( word ) => {

			for ( let band = 0; band < queues.curveBands; band ++ ) {

				const at = queues.curveOffset( band );
				if ( word >= at && word < at + n ) return 100 * ( band + 1 ) + word - at;
				if ( word >= at + n && word < at + 2 * n ) return 1000 * ( band + 1 ) + word - at - n;
				if ( word === queues.pixelCountOffset( band ) ) return 10 * ( band + 1 );

			}

			return 0;

		};

		const resettable = ( stage ) => Object.assign( stage, {
			resetCount: 0, frame: { value: 0 }, hasPreviousAccumulated: { value: 0 }, storageTextures: {},
			updateCompletionThreshold: () => {}, _seedTick: 0, _pinSeedToFrame: false,
		} );

		it( 'lays the curves out band 0, the light pass, the other bands, then a pixel count a band', () => {

			const queues = makeQueues( 3 );
			expect( [ 0, 1, 2 ].map( ( band ) => queues.curveOffset( band ) ) ).toEqual( [ 0, 4 * n, 6 * n ] );
			expect( queues.pixelCountOffset( 0 ) ).toBe( 8 * n );
			expect( queues.pixelCountOffset( 3 ) ).toBe( 8 * n + 3 );

		} );

		it( 'keeps every band its own curve and pixel count', async () => {

			const { stage, land, queues } = makeStage( { chunkRows: 1 } );
			stage.setLockstepReadbacks( true );
			stage._maybeReadbackCounters();
			const issued = stage._lockstepRead;
			await land( { bounce: perBand( queues ) } );
			issued.apply();

			expect( stage._lastBounceCounts[ 3 ] ).toBe( 103 );
			expect( stage._lastBounceCounts[ n + 3 ] ).toBe( 203 );
			expect( stage._lastBounceEnergy[ n ] ).toBe( 2000 );
			expect( Array.from( stage._lastActivePixelCounts ) ).toEqual( [ 10, 20 ] );
			expect( stage.getConvergenceStats().activePixels ).toBe( 30 );

		} );

		// A reset restarts every pixel, so a pixel count measured before it would size bounce 0 too small.
		it( 'drops the pixel counts measured before a reset and keeps the curve', async () => {

			const { stage, land, queues } = makeStage();
			resettable( stage );
			stage._maybeReadbackCounters(); // free running: applied as it lands
			stage.reset();
			await land( { bounce: perBand( queues ) } );

			expect( stage._lastBounceCounts[ 0 ] ).toBe( 100 );
			expect( stage._lastActivePixelCounts ).toBeNull();

		} );

		it( 're-cuts a curve for other bands, by band size, and never sizes from it', () => {

			const { stage } = makeStage( { chunkRows: 1 } );
			const counts = new Uint32Array( 2 * n );
			counts[ 0 ] = 30;
			counts[ n ] = 10;
			Object.assign( stage, {
				_lastBounceCounts: counts, _lastBounceEnergy: counts.slice(), _curveLayout: { width: W, height: H, chunkRows: 1 },
				_curveSizingValid: true, _lastActivePixelCounts: new Uint32Array( [ 4, 4 ] ),
				_chunkRows: H, // one band now
			} );

			stage._fitCurveToBands();
			expect( stage._lastBounceCounts ).toHaveLength( n );
			expect( stage._lastBounceCounts[ 0 ] ).toBe( 40 );
			expect( stage._curveSizingValid ).toBe( false );
			expect( stage._lastActivePixelCounts ).toBeNull();

			// Twice the rows, in two bands: each its share of twice the total.
			stage._wfRenderHeight = { value: 2 * H };
			stage._fitCurveToBands();
			expect( [ stage._lastBounceCounts[ 0 ], stage._lastBounceCounts[ n ] ] ).toEqual( [ 40, 40 ] );

		} );

	} );


} );
