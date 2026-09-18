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
		this.abort = vi.fn();
		this.invalidateOutput = vi.fn();
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
	// Stages the strategy setter touches, so tests can drive the real API path.
	manager._stages.pathTracer = { interactionMode: false, setCleanAuxNormal: vi.fn(), setAuxGBufferEnabled: vi.fn() };
	manager._stages.asvgf = { enabled: false, setTemporalEnabled: vi.fn(), updateParameters: vi.fn() };
	manager._stages.nrd = { enabled: false, resetHistory: vi.fn(), updateParameters: vi.fn() };
	return manager;

};

describe( 'DenoisingManager completion chain', () => {

	let manager, dn;

	beforeEach( () => {

		manager = makeManager();
		dn = manager.denoiser;

	} );

	// ── the two switches are independent ─────────────────────────────────

	it( 'lets OIDN own the live view without opting into a pass on the finished image', () => {

		manager.setDenoiserStrategy( 'oidn' );
		manager.setOIDNEnabled( false );

		expect( manager.denoiserStrategy ).toBe( 'oidn' );
		expect( manager.continuousDenoise ).toBe( true );
		expect( manager.finalDenoise ).toBe( false );
		// Still "in use", which is all the aux G-buffer wiring cares about.
		expect( dn.enabled ).toBe( true );

	} );

	it( 'lets the finished image get a pass without OIDN owning the live view', () => {

		manager.setDenoiserStrategy( 'asvgf' );
		manager.setOIDNEnabled( true );

		expect( manager.denoiserStrategy ).toBe( 'asvgf' );
		expect( manager.continuousDenoise ).toBe( false );
		expect( manager.finalDenoise ).toBe( true );

	} );

	it( 'never lets two denoisers own the live view at once', () => {

		manager.setDenoiserStrategy( 'asvgf' );
		expect( manager._stages.asvgf.enabled ).toBe( true );

		manager.setDenoiserStrategy( 'oidn' );
		expect( manager._stages.asvgf.enabled ).toBe( false );
		expect( manager._stages.nrd.enabled ).toBe( false );

		manager.setDenoiserStrategy( 'nrd' );
		expect( manager.continuousDenoise ).toBe( false );

	} );

	// `denoiser.enabled` is the union of the two, so writing it directly loses one of them —
	// which is exactly how configureForMode stopped turning the final pass on.
	it( 'keeps denoiser.enabled as the union of the two decisions', () => {

		manager.applyOIDNEnabled( false );
		manager.setDenoiserStrategy( 'none' );
		expect( dn.enabled ).toBe( false );

		manager.setDenoiserStrategy( 'oidn' );
		expect( dn.enabled ).toBe( true );

		manager.setDenoiserStrategy( 'none' );
		manager.applyOIDNEnabled( true );
		expect( dn.enabled ).toBe( true );

		manager.applyOIDNEnabled( false );
		expect( dn.enabled ).toBe( false );

	} );

	// Same trap on the other field: a host reading `denoiser.quality` mid-render saves the cheap
	// refresh model as if the user had chosen it.
	it( 'reports the chosen tier, not the model a refresh left loaded', () => {

		manager.setOIDNQuality( 'high' );
		dn.quality = 'fast-clean';

		expect( manager.oidnQuality ).toBe( 'high' );

	} );

	// ── what closes the render ───────────────────────────────────────────

	it( 'runs a full pass at the chosen quality when the switch is on', () => {

		manager.setOIDNEnabled( true );
		manager.onRenderComplete( { isStillComplete: () => true } );

		expect( dn.start ).toHaveBeenCalledTimes( 1 );
		expect( dn.start.mock.calls[ 0 ][ 0 ]?.continuous ?? false ).toBe( false );

	} );

	it( 'closes a live-OIDN render with one cheap refresh, not a full pass', () => {

		manager.setDenoiserStrategy( 'oidn' );
		manager.setOIDNEnabled( false );
		manager.onRenderComplete( { isStillComplete: () => true } );

		expect( dn.start ).toHaveBeenCalledTimes( 1 );
		expect( dn.start.mock.calls[ 0 ][ 0 ]?.continuous ).toBe( true );
		// No reload — the refreshes' own model is already loaded.
		expect( dn.updateQuality ).not.toHaveBeenCalled();

	} );

	it( 'does nothing at the end when neither job is asked for', () => {

		manager.setOIDNEnabled( false );
		manager.onRenderComplete( { isStillComplete: () => true } );

		expect( dn.start ).not.toHaveBeenCalled();

	} );

	// The bug this guards: three.js addEventListener ignores { once: true }, so a deferred
	// closing denoise re-fired on the end of the denoise it had just started — forever.
	it( 'defers past an in-flight refresh and then closes exactly once', () => {

		manager.setOIDNEnabled( true );
		dn.state.isDenoising = true;
		manager.onRenderComplete( { isStillComplete: () => true } );

		expect( dn.start ).not.toHaveBeenCalled();

		dn.finish( true ); // the refresh completes
		expect( dn.start ).toHaveBeenCalledTimes( 1 );

		dn.finish( false ); // the closing denoise completes
		dn.finish( false ); // anything later must not restart it
		expect( dn.start ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'leaves no listeners registered once the chain has run', () => {

		const before = dn.endListenerCount();

		manager.setOIDNEnabled( true );
		dn.state.isDenoising = true;
		manager.onRenderComplete( { isStillComplete: () => true } );
		dn.finish( true );
		dn.finish( false );

		expect( dn.endListenerCount() ).toBe( before );

	} );

	it( 'starts the upscaler only after the denoise that closes the render', () => {

		manager.upscaler = { enabled: true, start: vi.fn(), abort: vi.fn() };
		manager.setOIDNEnabled( true );
		dn.state.isDenoising = true;
		manager.onRenderComplete( { isStillComplete: () => true } );

		dn.finish( true );
		expect( manager.upscaler.start ).not.toHaveBeenCalled();

		dn.finish( false );
		expect( manager.upscaler.start ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'starts the upscaler after a closing refresh too', () => {

		manager.upscaler = { enabled: true, start: vi.fn(), abort: vi.fn() };
		manager.setDenoiserStrategy( 'oidn' );
		manager.setOIDNEnabled( false );
		manager.onRenderComplete( { isStillComplete: () => true } );

		dn.finish( true );
		expect( manager.upscaler.start ).toHaveBeenCalledTimes( 1 );

	} );

	// ── quality split ────────────────────────────────────────────────────

	// setCleanAuxNormal() throws away the accumulated aux, so the cheap model has to read the
	// same kind of aux the chosen one does — otherwise the final pass sees a one-sample buffer.
	it( 'picks a refresh model whose aux kind matches the chosen model', () => {

		manager.setOIDNQuality( 'fast' );
		expect( manager.previewQuality() ).toBe( 'fast' );

		for ( const q of [ 'fast-clean', 'balance', 'high' ] ) {

			manager.setOIDNQuality( q );
			expect( manager.previewQuality() ).toBe( 'fast-clean' );

		}

	} );

	it( 'puts the chosen model back for the finished image', () => {

		manager.setDenoiserStrategy( 'oidn' );
		manager.setOIDNEnabled( true );
		manager.setOIDNQuality( 'high' );
		dn.updateQuality.mockClear();

		// Refreshes drop to the cheap model once one proves too slow to be a live view.
		dn.lastDenoiseMs = 10000;
		manager.tickContinuousDenoise( 1 );
		expect( dn.quality ).toBe( 'fast-clean' );

		dn.state.isDenoising = false;
		manager.onRenderComplete( { isStillComplete: () => true } );
		expect( dn.quality ).toBe( 'high' );

	} );

	// The denoised frames are the whole picture while the camera moves — the raw render is never
	// shown — so refusing here would freeze the viewport, not save work.
	it( 'keeps refreshing while the camera is moving', () => {

		manager.setDenoiserStrategy( 'oidn' );
		manager._stages.pathTracer.viewIsChanging = true;
		manager.continuousDenoiseInterval = 0;
		dn.lastDenoiseMs = 20;

		// frameCount does not advance while moving, so the same count must still refresh.
		expect( manager.tickContinuousDenoise( 1 ) ).toBe( true );
		dn.state.isDenoising = false;
		expect( manager.tickContinuousDenoise( 1 ) ).toBe( true );
		expect( dn.start.mock.calls.at( - 1 )[ 0 ] ).toEqual( { continuous: true } );

	} );

	// The first refresh of a move is always slow — the GPU is still finishing the frame before it —
	// and a move that gives up on that reading stops refreshing, so it never measures again.
	it( 'lets one slow refresh pass as warm-up and gives up on the second', () => {

		manager.setDenoiserStrategy( 'oidn' );
		manager._stages.pathTracer.viewIsChanging = true;

		manager._movingDenoiseMs.push( 400 );
		expect( manager.holdsWhileMoving ).toBe( true );

		manager._movingDenoiseMs.push( 400 );
		expect( manager.holdsWhileMoving ).toBe( false );
		expect( manager.tickContinuousDenoise( 1 ) ).toBe( false );

	} );

	it( 'writes off a resolution far past the budget on the first reading, until it changes', () => {

		manager.setDenoiserStrategy( 'oidn' );
		manager._stages.pathTracer.viewIsChanging = true;

		manager._movingDenoiseMs.push( 2000 );
		expect( manager.holdsWhileMoving ).toBe( false );

		// A new move starts clean, but the verdict on this resolution stands.
		manager._movingDenoiseMs.length = 0;
		manager._holdWhileMoving = null;
		expect( manager.holdsWhileMoving ).toBe( false );

		manager.setRenderSize( 256, 256 );
		expect( manager.holdsWhileMoving ).toBe( true );

	} );

} );
