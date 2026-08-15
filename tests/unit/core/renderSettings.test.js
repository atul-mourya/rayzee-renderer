import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RenderSettings } from '@/core/RenderSettings.js';

describe( 'RenderSettings', () => {

	let settings;

	beforeEach( () => {

		settings = new RenderSettings();

	} );

	// ── get ────────────────────────────────────────────────────

	describe( 'get', () => {

		it( 'returns default value for known keys', () => {

			// maxBounces is mapped from ENGINE_DEFAULTS.bounces
			expect( settings.get( 'maxBounces' ) ).toBeDefined();

		} );

		it( 'returns undefined for unknown keys', () => {

			expect( settings.get( 'nonexistent_xyz' ) ).toBeUndefined();

		} );

		it( 'returns exposure default', () => {

			expect( settings.get( 'exposure' ) ).toBe( 1 );

		} );

	} );

	// ── set ────────────────────────────────────────────────────

	describe( 'set', () => {

		it( 'updates a value', () => {

			settings.set( 'exposure', 2.5 );
			expect( settings.get( 'exposure' ) ).toBe( 2.5 );

		} );

		it( 'no-ops when value is the same', () => {

			const original = settings.get( 'exposure' );
			const spy = vi.fn();
			settings.addEventListener( 'settingChanged', spy );
			settings.set( 'exposure', original );
			expect( spy ).not.toHaveBeenCalled();

		} );

		it( 'routes uniform setting to pathTracer', () => {

			const mockStage = { setUniform: vi.fn() };
			settings.bind( { stages: { pathTracer: mockStage }, resetCallback: vi.fn() } );

			settings.set( 'maxBounces', 8 );
			expect( mockStage.setUniform ).toHaveBeenCalledWith( 'maxBounces', 8 );

		} );

		it( 'calls resetCallback when route has reset: true', () => {

			const resetCb = vi.fn();
			const mockStage = { setUniform: vi.fn() };
			settings.bind( { stages: { pathTracer: mockStage }, resetCallback: resetCb } );

			settings.set( 'maxBounces', 12 ); // maxBounces has reset: true
			expect( resetCb ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'does NOT call resetCallback when route has reset: false', () => {

			const resetCb = vi.fn();
			const mockStage = { setUniform: vi.fn() };
			settings.bind( { stages: { pathTracer: mockStage }, resetCallback: resetCb } );

			settings.set( 'focusDistance', 5.0 ); // focusDistance has reset: false
			expect( resetCb ).not.toHaveBeenCalled();

		} );

		it( 'routes handler setting to named handler', () => {

			const mockRenderer = { toneMappingExposure: 1.0 };
			settings.bind( {
				stages: { pathTracer: null },
				renderer: mockRenderer,
				resetCallback: vi.fn(),
			} );

			settings.set( 'exposure', 2.0 );
			expect( mockRenderer.toneMappingExposure ).toBe( 2.0 );

		} );

		it( 'silent option suppresses event', () => {

			const spy = vi.fn();
			settings.addEventListener( 'settingChanged', spy );
			settings.set( 'exposure', 5, { silent: true } );
			expect( spy ).not.toHaveBeenCalled();

		} );

		it( 'reset option overrides route default', () => {

			const resetCb = vi.fn();
			const mockStage = { setUniform: vi.fn() };
			settings.bind( { stages: { pathTracer: mockStage }, resetCallback: resetCb } );

			// focusDistance has reset: false, but we override to true
			settings.set( 'focusDistance', 10, { reset: true } );
			expect( resetCb ).toHaveBeenCalledTimes( 1 );

		} );

	} );

	// ── setMany ────────────────────────────────────────────────

	describe( 'setMany', () => {

		it( 'batch-updates multiple values', () => {

			settings.setMany( { exposure: 3, maxBounces: 10 } );
			expect( settings.get( 'exposure' ) ).toBe( 3 );
			expect( settings.get( 'maxBounces' ) ).toBe( 10 );

		} );

		it( 'calls resetCallback once for batch', () => {

			const resetCb = vi.fn();
			const mockStage = { setUniform: vi.fn() };
			settings.bind( { stages: { pathTracer: mockStage }, resetCallback: resetCb } );

			settings.setMany( { maxBounces: 8, transmissiveBounces: 2 } );
			expect( resetCb ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'skips unchanged values', () => {

			const mockStage = { setUniform: vi.fn() };
			settings.bind( { stages: { pathTracer: mockStage }, resetCallback: vi.fn() } );

			const original = settings.get( 'maxBounces' );
			settings.setMany( { maxBounces: original } );
			expect( mockStage.setUniform ).not.toHaveBeenCalled();

		} );

	} );

	// ── getAll ─────────────────────────────────────────────────

	describe( 'getAll', () => {

		it( 'returns object with all values', () => {

			const all = settings.getAll();
			expect( typeof all ).toBe( 'object' );
			expect( all ).toHaveProperty( 'exposure' );
			expect( all ).toHaveProperty( 'maxBounces' );

		} );

	} );

	// ── bind ───────────────────────────────────────────────────

	describe( 'bind', () => {

		it( 'wires pathTracer', () => {

			const mockStage = { setUniform: vi.fn() };
			settings.bind( { stages: { pathTracer: mockStage }, resetCallback: vi.fn() } );
			settings.set( 'maxBounces', 5 );
			expect( mockStage.setUniform ).toHaveBeenCalled();

		} );

		it( 'works without bind (no crash)', () => {

			// Setting a routed value without bind should not throw
			expect( () => settings.set( 'maxBounces', 5 ) ).not.toThrow();

		} );

	} );

	// ── applyAll ───────────────────────────────────────────────

	describe( 'applyAll', () => {

		it( 'pushes all values to stages', () => {

			const mockStage = { setUniform: vi.fn(), setInteractionModeEnabled: vi.fn(), updateCompletionThreshold: vi.fn(), environment: { setEnvironmentRotation: vi.fn() } };
			const mockCompositor = { setSaturation: vi.fn(), setTransparentBackground: vi.fn(), setConvergenceOverlay: vi.fn() };
			const mockRenderer = { toneMappingExposure: 1.0 };
			settings.bind( { stages: { pathTracer: mockStage, compositor: mockCompositor }, renderer: mockRenderer, resetCallback: vi.fn(), reconcileCompletion: vi.fn() } );
			settings.applyAll();

			// Should have called setUniform for each uniform-routed key
			expect( mockStage.setUniform ).toHaveBeenCalled();

		} );

	} );

} );
