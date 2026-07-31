import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CameraOptimizer } from '@/core/Processor/CameraOptimizer.js';

function createMockMaterial() {

	return {
		uniforms: {
			maxBounceCount: { value: 8 },
			enableAccumulation: { value: true },
			cameraIsMoving: { value: false },
		},
	};

}

function createMockRenderer() {

	return {
		getPixelRatio: vi.fn( () => 1.0 ),
		setPixelRatio: vi.fn(),
	};

}

describe( 'CameraOptimizer', () => {

	let optimizer, material, renderer;

	beforeEach( () => {

		vi.useFakeTimers();
		renderer = createMockRenderer();
		material = createMockMaterial();
		optimizer = new CameraOptimizer( renderer, material );

	} );

	afterEach( () => {

		vi.useRealTimers();

	} );

	// ── constructor ───────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'defaults to enabled', () => {

			expect( optimizer.interactionModeEnabled ).toBe( true );

		} );

		it( 'defaults delay to 100ms', () => {

			expect( optimizer.interactionDelay ).toBe( 100 );

		} );

		it( 'starts not in interaction mode', () => {

			expect( optimizer.interactionMode ).toBe( false );
			expect( optimizer.isInInteractionMode() ).toBe( false );

		} );

		it( 'accepts custom settings', () => {

			const custom = new CameraOptimizer( renderer, material, {
				enabled: false,
				delay: 200,
			} );
			expect( custom.interactionModeEnabled ).toBe( false );
			expect( custom.interactionDelay ).toBe( 200 );

		} );

	} );

	// ── enterInteractionMode ──────────────────────────────────

	describe( 'enterInteractionMode', () => {

		it( 'enters interaction mode and reduces quality', () => {

			optimizer.enterInteractionMode();
			expect( optimizer.isInInteractionMode() ).toBe( true );
			expect( material.uniforms.maxBounceCount.value ).toBe( 1 );
			expect( material.uniforms.enableAccumulation.value ).toBe( false );

		} );

		it( 'stores original values', () => {

			optimizer.enterInteractionMode();
			expect( optimizer.originalValues.maxBounceCount ).toBe( 8 );

		} );

		it( 'does nothing if disabled', () => {

			optimizer.setInteractionModeEnabled( false );
			optimizer.enterInteractionMode();
			expect( optimizer.isInInteractionMode() ).toBe( false );

		} );

		it( 'resets timeout if already in interaction mode', () => {

			optimizer.enterInteractionMode();
			optimizer.enterInteractionMode(); // second call
			expect( optimizer.isInInteractionMode() ).toBe( true );

		} );

		it( 'calls onEnter callback', () => {

			const onEnter = vi.fn();
			optimizer.setCallbacks( { onEnter } );
			optimizer.enterInteractionMode();
			expect( onEnter ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'sets cameraIsMoving to true', () => {

			optimizer.enterInteractionMode();
			expect( material.uniforms.cameraIsMoving.value ).toBe( true );

		} );

	} );

	// ── exitInteractionMode ───────────────────────────────────

	describe( 'exitInteractionMode', () => {

		it( 'restores original values', () => {

			optimizer.enterInteractionMode();
			optimizer.exitInteractionMode();
			expect( material.uniforms.maxBounceCount.value ).toBe( 8 );
			expect( material.uniforms.enableAccumulation.value ).toBe( true );

		} );

		it( 'calls onExit and onReset callbacks', () => {

			const onExit = vi.fn();
			const onReset = vi.fn();
			optimizer.setCallbacks( { onExit, onReset } );
			optimizer.enterInteractionMode();
			optimizer.exitInteractionMode();
			expect( onExit ).toHaveBeenCalledTimes( 1 );
			expect( onReset ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'is no-op if not in interaction mode', () => {

			const onExit = vi.fn();
			optimizer.setCallbacks( { onExit } );
			optimizer.exitInteractionMode();
			expect( onExit ).not.toHaveBeenCalled();

		} );

	} );

	// ── auto-exit via timeout ─────────────────────────────────

	describe( 'auto-exit via timeout', () => {

		it( 'exits interaction mode after delay', () => {

			optimizer.enterInteractionMode();
			expect( optimizer.isInInteractionMode() ).toBe( true );

			vi.advanceTimersByTime( 100 );
			expect( optimizer.isInInteractionMode() ).toBe( false );

		} );

		it( 'restores quality after timeout', () => {

			optimizer.enterInteractionMode();
			vi.advanceTimersByTime( 100 );
			expect( material.uniforms.maxBounceCount.value ).toBe( 8 );

		} );

	} );

	// ── updateInteractionMode ─────────────────────────────────

	describe( 'updateInteractionMode', () => {

		it( 'enters when camera changed', () => {

			optimizer.updateInteractionMode( true );
			expect( optimizer.isInInteractionMode() ).toBe( true );

		} );

		it( 'does nothing when camera unchanged', () => {

			optimizer.updateInteractionMode( false );
			expect( optimizer.isInInteractionMode() ).toBe( false );

		} );

	} );

	// ── setInteractionModeEnabled ─────────────────────────────

	describe( 'setInteractionModeEnabled', () => {

		it( 'disabling exits interaction mode immediately', () => {

			optimizer.enterInteractionMode();
			optimizer.setInteractionModeEnabled( false );
			expect( optimizer.isInInteractionMode() ).toBe( false );

		} );

	} );

	// ── updateQualitySettings ─────────────────────────────────

	describe( 'updateQualitySettings', () => {

		it( 'updates settings', () => {

			optimizer.updateQualitySettings( { maxBounceCount: 3 } );
			expect( optimizer.interactionQualitySettings.maxBounceCount ).toBe( 3 );

		} );

		it( 'applies immediately if in interaction mode', () => {

			optimizer.enterInteractionMode();
			optimizer.updateQualitySettings( { maxBounceCount: 5 } );
			expect( material.uniforms.maxBounceCount.value ).toBe( 5 );

		} );

	} );

	// ── static createQualityPreset ────────────────────────────

	describe( 'createQualityPreset', () => {

		it( 'returns preset for known quality levels', () => {

			const low = CameraOptimizer.createQualityPreset( 'low' );
			expect( low.maxBounceCount ).toBe( 1 );
			expect( low.pixelRatio ).toBe( 0.25 );

			const high = CameraOptimizer.createQualityPreset( 'high' );
			expect( high.maxBounceCount ).toBe( 3 );
			expect( high.enableAccumulation ).toBe( true );

		} );

		it( 'falls back to low for unknown quality', () => {

			const preset = CameraOptimizer.createQualityPreset( 'invalid' );
			expect( preset.maxBounceCount ).toBe( 1 );

		} );

		it( 'ultra-low has lowest pixel ratio', () => {

			const preset = CameraOptimizer.createQualityPreset( 'ultra-low' );
			expect( preset.pixelRatio ).toBe( 0.125 );

		} );

	} );

	// ── getState ──────────────────────────────────────────────

	describe( 'getState', () => {

		it( 'returns current state', () => {

			const state = optimizer.getState();
			expect( state.interactionMode ).toBe( false );
			expect( state.interactionModeEnabled ).toBe( true );
			expect( state.interactionDelay ).toBe( 100 );

		} );

	} );

	// ── forceExitInteractionMode ──────────────────────────────

	describe( 'forceExitInteractionMode', () => {

		it( 'clears timeout and exits', () => {

			optimizer.enterInteractionMode();
			optimizer.forceExitInteractionMode();
			expect( optimizer.isInInteractionMode() ).toBe( false );

		} );

	} );

	// ── dispose ───────────────────────────────────────────────

	describe( 'dispose', () => {

		it( 'clears timeout and callbacks', () => {

			optimizer.setCallbacks( { onEnter: vi.fn() } );
			optimizer.enterInteractionMode();
			optimizer.dispose();
			expect( optimizer.onEnterCallback ).toBeNull();
			expect( optimizer.onExitCallback ).toBeNull();

		} );

	} );

	// ── setInteractionDelay + setCallbacks ────────────────────

	describe( 'setInteractionDelay', () => {

		it( 'updates delay', () => {

			optimizer.setInteractionDelay( 500 );
			expect( optimizer.interactionDelay ).toBe( 500 );

		} );

	} );

} );
