import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RenderSettings } from '@/core/RenderSettings.js';
import { EngineEvents } from '@/core/EngineEvents.js';

describe( 'RenderSettings', () => {

	let settings;

	beforeEach( () => {

		settings = new RenderSettings();

	} );

	// ── get ────────────────────────────────────────────────────

	describe( 'get', () => {

		it( 'returns default value for known keys', () => {

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
			settings.addEventListener( EngineEvents.SETTING_CHANGED, spy );
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

			const applyExposure = vi.fn();
			settings.bind( {
				stages: { pathTracer: null },
				applyExposure,
				resetCallback: vi.fn(),
			} );

			settings.set( 'exposure', 2.0 );
			expect( applyExposure ).toHaveBeenCalledWith( 2.0 );

		} );

		it( 'silent option suppresses event', () => {

			const spy = vi.fn();
			settings.addEventListener( EngineEvents.SETTING_CHANGED, spy );
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

	// ── depth of field ─────────────────────────────────────────

	describe( 'camera projection', () => {

		it( 'hands each projection its uniform id and tells the camera', () => {

			const stage = { setUniform: vi.fn() };
			const onCameraProjection = vi.fn();
			settings.bind( { stages: { pathTracer: stage }, resetCallback: vi.fn(), onCameraProjection } );

			settings.set( 'cameraProjection', 'orthographic' );
			expect( stage.setUniform ).toHaveBeenLastCalledWith( 'cameraProjection', 2 );
			expect( onCameraProjection ).toHaveBeenLastCalledWith( 'orthographic' );

			settings.set( 'cameraProjection', 'equirectangular' );
			expect( stage.setUniform ).toHaveBeenLastCalledWith( 'cameraProjection', 1 );

			settings.set( 'cameraProjection', 'perspective' );
			expect( stage.setUniform ).toHaveBeenLastCalledWith( 'cameraProjection', 0 );
			expect( onCameraProjection ).toHaveBeenCalledTimes( 3 );

		} );

	} );

	describe( 'depth of field lens', () => {

		let stage;

		beforeEach( () => {

			stage = { setUniform: vi.fn() };
			settings.bind( { stages: { pathTracer: stage }, resetCallback: vi.fn() } );

		} );

		it( 'trusts the file: one scene unit is a metre', () => {

			expect( settings.get( 'unitsPerMetre' ) ).toBe( 1 );

		} );

		it( 'scales the real-camera aperture by units per metre', () => {

			settings.set( 'unitsPerMetre', 79.5 );
			expect( stage.setUniform ).toHaveBeenCalledWith( 'unitsPerMetre', 79.5 );

		} );

		it( 'switches the lens between look and real camera', () => {

			settings.set( 'dofMode', 'physical' );
			expect( stage.setUniform ).toHaveBeenLastCalledWith( 'dofMode', 0 );
			settings.set( 'dofMode', 'look' );
			expect( stage.setUniform ).toHaveBeenLastCalledWith( 'dofMode', 1 );
			settings.set( 'dofBlur', 0.12 );
			expect( stage.setUniform ).toHaveBeenLastCalledWith( 'dofBlur', 0.12 );

		} );

	} );

	describe( 'integrator', () => {

		it( 'defaults to the path tracer', () => {

			expect( settings.get( 'integrator' ) ).toBe( 'path' );

		} );

		it( 'hands the choice to the path tracer and restarts accumulation', () => {

			const stage = { setUniform: vi.fn(), setIntegrator: vi.fn() };
			const resetCallback = vi.fn();
			settings.bind( { stages: { pathTracer: stage }, resetCallback } );

			settings.set( 'integrator', 'bidirectional' );
			expect( stage.setIntegrator ).toHaveBeenCalledWith( 'bidirectional' );
			expect( resetCallback ).toHaveBeenCalledTimes( 1 );

		} );

	} );

	// 'timeOnly' lifts the ceiling only while a deadline is armed, so the stage needs both values.
	describe( 'render limit', () => {

		it( 'hands the stage the mode with the time limit, and reconciles completion', () => {

			const stage = { setUniform: vi.fn(), setRenderLimitMode: vi.fn() };
			const reconcileCompletion = vi.fn();
			settings.bind( { stages: { pathTracer: stage }, resetCallback: vi.fn(), reconcileCompletion } );

			settings.set( 'renderLimitMode', 'timeOnly' );
			expect( stage.setRenderLimitMode ).toHaveBeenLastCalledWith( 'timeOnly', settings.get( 'renderTimeLimit' ) );

			settings.set( 'renderTimeLimit', 0 );
			expect( stage.setRenderLimitMode ).toHaveBeenLastCalledWith( 'timeOnly', 0 );
			expect( reconcileCompletion ).toHaveBeenCalledTimes( 2 );

		} );

	} );

	// ── applyAll ───────────────────────────────────────────────

	describe( 'applyAll', () => {

		it( 'pushes all values to stages', () => {

			const mockStage = { setUniform: vi.fn(), setInteractionModeEnabled: vi.fn(), updateCompletionThreshold: vi.fn(), environment: { setEnvironmentRotation: vi.fn() } };
			const mockCompositor = { setSaturation: vi.fn(), setTransparentBackground: vi.fn(), setConvergenceOverlay: vi.fn() };
			settings.bind( { stages: { pathTracer: mockStage, compositor: mockCompositor }, applyExposure: vi.fn(), resetCallback: vi.fn(), reconcileCompletion: vi.fn() } );
			settings.applyAll();

			// Should have called setUniform for each uniform-routed key
			expect( mockStage.setUniform ).toHaveBeenCalled();

		} );

	} );

	// ── define ─────────────────────────────────────────────────

	describe( 'define', () => {

		it( 'leaves keys of other layers out of the core', () => {

			expect( settings.get( 'interactionRenderScale' ) ).toBeUndefined();
			expect( settings.getEffective().interactionRenderScale ).toBeUndefined();

		} );

		it( 'gives a defined key its default, provenance, events, saving and reset', () => {

			const apply = vi.fn();
			const resetCallback = vi.fn();
			const pathTracer = { setUniform: vi.fn(), setInteractionModeEnabled: vi.fn(), updateCompletionThreshold: vi.fn(), setIntegrator: vi.fn(), environment: { setEnvironmentRotation: vi.fn() } };
			const compositor = { setSaturation: vi.fn(), setTransparentBackground: vi.fn(), setConvergenceOverlay: vi.fn() };
			settings.bind( { stages: { pathTracer, compositor }, resetCallback } );
			settings.define( 'interactionRenderScale', { default: 0.5, apply, reset: false } );

			expect( settings.getEffective().interactionRenderScale ).toEqual( { value: 0.5, source: 'default', routed: true } );

			const changed = vi.fn();
			settings.addEventListener( EngineEvents.SETTING_CHANGED, changed );
			settings.set( 'interactionRenderScale', 0.25 );
			expect( apply ).toHaveBeenCalledWith( 0.25, 0.5 );
			expect( changed ).toHaveBeenCalledTimes( 1 );
			expect( resetCallback ).not.toHaveBeenCalled();
			expect( settings.serialize().interactionRenderScale ).toBe( 0.25 );

			settings.applyAll();
			expect( apply ).toHaveBeenLastCalledWith( 0.25, undefined );

		} );

		it( 'resets accumulation by default, and refuses a key already defined', () => {

			const resetCallback = vi.fn();
			settings.bind( { stages: { pathTracer: { setUniform: vi.fn() } }, resetCallback } );
			settings.define( 'myAddonStrength', { apply: vi.fn() } );
			settings.set( 'myAddonStrength', 3 );
			expect( resetCallback ).toHaveBeenCalledTimes( 1 );

			expect( () => settings.define( 'maxBounces', { apply: vi.fn() } ) ).toThrow( /already defined/ );

		} );

	} );

} );
