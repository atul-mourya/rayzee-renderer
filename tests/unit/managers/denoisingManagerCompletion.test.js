import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventDispatcher } from 'three';
import { DenoisingManager } from '@/core/managers/DenoisingManager.js';

// A stand-in for OIDNDenoiser: three.js EventDispatcher semantics are the point of these tests.
class StubDenoiser extends EventDispatcher {

	constructor() {

		super();
		this.enabled = true;
		this.quality = 'fast';
		this.state = { isDenoising: false, isLoading: false };
		this.lastDenoiseMs = 0;
		this.setSize = vi.fn();
		this.updateQuality = vi.fn( q => {

			this.quality = q;
			return Promise.resolve();

		} );
		this.expectsCleanAux = q => q !== 'fast';
		this.start = vi.fn( () => {

			this.state.isDenoising = true;
			return Promise.resolve( true );

		} );

	}

	// Mirrors execute()'s finally: one tagged 'end' per run.
	finish( continuous = false ) {

		this.state.isDenoising = false;
		this.dispatchEvent( { type: 'end', continuous } );

	}

	endListenerCount() {

		return this._listeners?.end?.length ?? 0;

	}

}

const makeManager = () => {

	const canvas = { parentNode: null, width: 8, height: 8, style: {} };
	const manager = new DenoisingManager( {
		renderer: {}, mainCanvas: canvas, scene: {}, camera: {}, stages: {}, pipeline: {},
		getExposure: () => 1, getSaturation: () => 1, getTransparentBg: () => false,
	} );
	manager.denoiser = new StubDenoiser();
	manager.upscaler = null;
	return manager;

};

describe( 'DenoisingManager completion chain', () => {

	let manager, dn;

	beforeEach( () => {

		manager = makeManager();
		dn = manager.denoiser;

	} );

	it( 'denoises once when nothing is in flight', () => {

		manager.onRenderComplete( { isStillComplete: () => true } );

		expect( dn.start ).toHaveBeenCalledTimes( 1 );
		expect( dn.start.mock.calls[ 0 ][ 0 ]?.continuous ?? false ).toBe( false );

	} );

	// The bug this guards: three.js addEventListener ignores { once: true }, so a deferred
	// final-denoise listener re-fired on the 'end' of the denoise it had just started — forever.
	it( 'defers past an in-flight cadence run and then denoises exactly once', () => {

		dn.state.isDenoising = true;
		manager.onRenderComplete( { isStillComplete: () => true } );

		expect( dn.start ).not.toHaveBeenCalled();

		dn.finish( true ); // the cadence run completes
		expect( dn.start ).toHaveBeenCalledTimes( 1 );

		dn.finish( false ); // the final denoise completes
		expect( dn.start ).toHaveBeenCalledTimes( 1 );

		dn.finish( false ); // any later end must not restart anything
		expect( dn.start ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'leaves no listeners registered once the chain has run', () => {

		const before = dn.endListenerCount();

		dn.state.isDenoising = true;
		manager.onRenderComplete( { isStillComplete: () => true } );
		dn.finish( true );
		dn.finish( false );

		expect( dn.endListenerCount() ).toBe( before );

	} );

	it( 'does not start the upscaler on a cadence end', () => {

		manager.upscaler = { enabled: true, start: vi.fn(), abort: vi.fn() };
		manager.onRenderComplete( { isStillComplete: () => true } );

		dn.finish( true );
		expect( manager.upscaler.start ).not.toHaveBeenCalled();

		dn.finish( false );
		expect( manager.upscaler.start ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'runs refreshes on a cheap model and the finished image on the chosen one', () => {

		manager.setOIDNQuality( 'high' );
		dn.updateQuality.mockClear();

		manager._stages.pathTracer = { interactionMode: false, setCleanAuxNormal: vi.fn(), setAuxGBufferEnabled: vi.fn() };
		// Live refreshes are the 'oidn' entry in the real-time denoiser list, not a flag of their own.
		manager.setDenoiserStrategy( 'oidn' );
		dn.updateQuality.mockClear();

		// A model fast enough to be a live view is kept.
		dn.lastDenoiseMs = 10;
		manager.tickContinuousDenoise( 1 );
		expect( dn.quality ).toBe( 'high' );

		// Once one measures too slow for a live view, refreshes drop to the cheap model.
		dn.lastDenoiseMs = 500;
		manager._lastCadenceAt = - Infinity;
		manager._lastCadenceSamples = 0;
		dn.state.isDenoising = false;
		manager.tickContinuousDenoise( 1 );
		expect( dn.quality ).toBe( 'fast-clean' );

		// The refresh is still in flight, so the final denoise waits for it — and only then
		// puts the chosen model back.
		manager.onRenderComplete( { isStillComplete: () => true } );
		expect( dn.quality ).toBe( 'fast-clean' );

		dn.finish( true );
		expect( dn.quality ).toBe( 'high' );

	} );

	// Re-deciding per accumulation cost one slow denoise every time the camera stopped: the
	// device does not get faster between camera moves.
	it( 'keeps the downgrade across a reset, and drops it when the tier or size changes', () => {

		manager._stages.pathTracer = { interactionMode: false, setCleanAuxNormal: vi.fn(), setAuxGBufferEnabled: vi.fn() };
		manager.setOIDNQuality( 'high' );
		manager.setDenoiserStrategy( 'oidn' );

		dn.lastDenoiseMs = 500;
		manager.tickContinuousDenoise( 1 );
		expect( dn.quality ).toBe( 'fast-clean' );

		// A camera move restarts the accumulation but not the verdict.
		manager._resetCadence();
		expect( manager._cadenceDowngraded ).toBe( true );

		// A different tier, or a different resolution, is a different question.
		manager.applyOIDNQuality( 'balance' );
		expect( manager._cadenceDowngraded ).toBe( false );

		manager._cadenceDowngraded = true;
		manager.setRenderSize( 256, 256 );
		expect( manager._cadenceDowngraded ).toBe( false );

	} );

	// setCleanAuxNormal() throws away the accumulated aux, so the cheap model has to read the
	// same kind of aux the chosen one does — otherwise the final denoise sees a one-sample buffer.
	it( 'picks a refresh model whose aux kind matches the chosen model', () => {

		manager.setOIDNQuality( 'fast' );
		expect( manager.previewQuality() ).toBe( 'fast' );

		for ( const q of [ 'fast-clean', 'balance', 'high' ] ) {

			manager.setOIDNQuality( q );
			expect( manager.previewQuality() ).toBe( 'fast-clean' );

		}

	} );

	// Selecting OIDN for the live view must take the per-frame denoisers off it: two of them would
	// mean paying for one whose result the OIDN overlay then covers.
	it( 'makes OIDN one of the live-view denoisers, never a second one', () => {

		manager._stages.pathTracer = { setCleanAuxNormal: vi.fn(), setAuxGBufferEnabled: vi.fn() };
		manager._stages.asvgf = { enabled: false, setTemporalEnabled: vi.fn(), updateParameters: vi.fn() };
		manager._stages.nrd = { enabled: false, resetHistory: vi.fn(), updateParameters: vi.fn() };

		manager.setDenoiserStrategy( 'asvgf' );
		expect( manager.denoiserStrategy ).toBe( 'asvgf' );
		expect( manager.continuousDenoise ).toBe( false );

		manager.setDenoiserStrategy( 'oidn' );
		expect( manager.denoiserStrategy ).toBe( 'oidn' );
		expect( manager._stages.asvgf.enabled ).toBe( false );
		expect( dn.enabled ).toBe( true );

		manager.setDenoiserStrategy( 'nrd' );
		expect( manager.continuousDenoise ).toBe( false );

		// Turning OIDN off cannot leave the list claiming OIDN.
		manager.setDenoiserStrategy( 'oidn' );
		manager.setOIDNEnabled( false );
		expect( manager.denoiserStrategy ).not.toBe( 'oidn' );

	} );

	it( 'maps the three-way mode onto the two flags', () => {

		manager._stages.pathTracer = { setCleanAuxNormal: vi.fn(), setAuxGBufferEnabled: vi.fn() };
		manager._stages.asvgf = { enabled: false, setTemporalEnabled: vi.fn(), updateParameters: vi.fn() };
		manager._stages.nrd = { enabled: false, resetHistory: vi.fn(), updateParameters: vi.fn() };

		manager.setOIDNMode( 'off' );
		expect( manager.getOIDNMode() ).toBe( 'off' );
		expect( dn.enabled ).toBe( false );

		manager.setOIDNMode( 'final' );
		expect( manager.getOIDNMode() ).toBe( 'final' );
		expect( dn.enabled ).toBe( true );
		expect( manager.continuousDenoise ).toBe( false );

		manager.setOIDNMode( 'continuous' );
		expect( manager.getOIDNMode() ).toBe( 'continuous' );
		expect( dn.enabled ).toBe( true );
		expect( manager.continuousDenoise ).toBe( true );

	} );

	it( 'skips the cadence while the camera is moving', () => {

		manager._stages.pathTracer = { interactionMode: true, setCleanAuxNormal: vi.fn(), setAuxGBufferEnabled: vi.fn() };
		manager.setDenoiserStrategy( 'oidn' );
		dn.start.mockClear();
		expect( manager.tickContinuousDenoise( 1 ) ).toBe( false );

		manager._stages.pathTracer.interactionMode = false;
		expect( manager.tickContinuousDenoise( 1 ) ).toBe( true );
		expect( dn.start.mock.calls[ 0 ][ 0 ] ).toEqual( { continuous: true } );

	} );

} );
