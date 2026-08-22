import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventDispatcher } from 'three';
import { DenoisingManager } from '@/core/managers/DenoisingManager.js';

// A stand-in for OIDNDenoiser: three.js EventDispatcher semantics are the point of these tests.
class StubDenoiser extends EventDispatcher {

	constructor() {

		super();
		this.enabled = true;
		this.state = { isDenoising: false, isLoading: false };
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

	it( 'skips the cadence while the camera is moving', () => {

		manager._stages.pathTracer = { interactionMode: true };
		expect( manager.tickContinuousDenoise( 1 ) ).toBe( false );

		manager._stages.pathTracer.interactionMode = false;
		expect( manager.tickContinuousDenoise( 1 ) ).toBe( true );
		expect( dn.start.mock.calls[ 0 ][ 0 ] ).toEqual( { continuous: true } );

	} );

} );
