import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RenderStage, StageExecutionMode } from '@/core/pipeline/RenderStage.js';
import { PipelineContext } from '@/core/pipeline/PipelineContext.js';
import { EventDispatcher } from '@/core/pipeline/EventDispatcher.js';

describe( 'RenderStage', () => {

	let context;
	let eventBus;

	beforeEach( () => {

		context = new PipelineContext();
		eventBus = new EventDispatcher();

	} );

	// ── Constructor ────────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'sets name', () => {

			const stage = new RenderStage( 'TestStage' );
			expect( stage.name ).toBe( 'TestStage' );

		} );

		it( 'defaults to enabled', () => {

			const stage = new RenderStage( 'Test' );
			expect( stage.enabled ).toBe( true );

		} );

		it( 'respects enabled: false', () => {

			const stage = new RenderStage( 'Test', { enabled: false } );
			expect( stage.enabled ).toBe( false );

		} );

		it( 'defaults to ALWAYS execution mode', () => {

			const stage = new RenderStage( 'Test' );
			expect( stage.executionMode ).toBe( StageExecutionMode.ALWAYS );

		} );

		it( 'accepts custom execution mode', () => {

			const stage = new RenderStage( 'Test', { executionMode: StageExecutionMode.PER_CYCLE } );
			expect( stage.executionMode ).toBe( StageExecutionMode.PER_CYCLE );

		} );

	} );

	// ── Initialize ─────────────────────────────────────────────

	describe( 'initialize', () => {

		it( 'stores context and eventBus', () => {

			const stage = new RenderStage( 'Test' );
			stage.initialize( context, eventBus );
			expect( stage.context ).toBe( context );
			expect( stage.eventBus ).toBe( eventBus );

		} );

		it( 'calls setupEventListeners', () => {

			const stage = new RenderStage( 'Test' );
			stage.setupEventListeners = vi.fn();
			stage.initialize( context, eventBus );
			expect( stage.setupEventListeners ).toHaveBeenCalledTimes( 1 );

		} );

	} );

	// ── enable / disable / toggle ──────────────────────────────

	describe( 'state control', () => {

		it( 'enable() sets enabled to true', () => {

			const stage = new RenderStage( 'Test', { enabled: false } );
			stage.initialize( context, eventBus );
			stage.enable();
			expect( stage.isEnabled() ).toBe( true );

		} );

		it( 'disable() sets enabled to false', () => {

			const stage = new RenderStage( 'Test' );
			stage.initialize( context, eventBus );
			stage.disable();
			expect( stage.isEnabled() ).toBe( false );

		} );

		it( 'toggle() flips state', () => {

			const stage = new RenderStage( 'Test' );
			stage.initialize( context, eventBus );
			stage.toggle();
			expect( stage.isEnabled() ).toBe( false );
			stage.toggle();
			expect( stage.isEnabled() ).toBe( true );

		} );

		it( 'enable emits stage:enabled event', () => {

			const listener = vi.fn();
			eventBus.on( 'stage:enabled', listener );
			const stage = new RenderStage( 'Test', { enabled: false } );
			stage.initialize( context, eventBus );
			stage.enable();
			expect( listener ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'disable emits stage:disabled event', () => {

			const listener = vi.fn();
			eventBus.on( 'stage:disabled', listener );
			const stage = new RenderStage( 'Test' );
			stage.initialize( context, eventBus );
			stage.disable();
			expect( listener ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'enable() when already enabled is a no-op', () => {

			const listener = vi.fn();
			eventBus.on( 'stage:enabled', listener );
			const stage = new RenderStage( 'Test' );
			stage.initialize( context, eventBus );
			stage.enable();
			expect( listener ).not.toHaveBeenCalled();

		} );

	} );

	// ── shouldExecuteThisFrame ─────────────────────────────────

	describe( 'shouldExecuteThisFrame', () => {

		it( 'disabled stage returns false', () => {

			const stage = new RenderStage( 'Test', { enabled: false } );
			expect( stage.shouldExecuteThisFrame( context ) ).toBe( false );

		} );

		it( 'ALWAYS mode returns true when enabled', () => {

			const stage = new RenderStage( 'Test', { executionMode: StageExecutionMode.ALWAYS } );
			expect( stage.shouldExecuteThisFrame( context ) ).toBe( true );

		} );

		it( 'PER_CYCLE in progressive mode (renderMode=0) returns true', () => {

			context.setState( 'renderMode', 0 );
			const stage = new RenderStage( 'Test', { executionMode: StageExecutionMode.PER_CYCLE } );
			expect( stage.shouldExecuteThisFrame( context ) ).toBe( true );

		} );

		it( 'PER_CYCLE in tile mode returns false when tile not complete', () => {

			context.setState( 'renderMode', 1 );
			context.setState( 'tileRenderingComplete', false );
			const stage = new RenderStage( 'Test', { executionMode: StageExecutionMode.PER_CYCLE } );
			expect( stage.shouldExecuteThisFrame( context ) ).toBe( false );

		} );

		it( 'PER_CYCLE in tile mode returns true when tile complete', () => {

			context.setState( 'renderMode', 1 );
			context.setState( 'tileRenderingComplete', true );
			const stage = new RenderStage( 'Test', { executionMode: StageExecutionMode.PER_CYCLE } );
			expect( stage.shouldExecuteThisFrame( context ) ).toBe( true );

		} );

		it( 'PER_TILE mode always returns true', () => {

			const stage = new RenderStage( 'Test', { executionMode: StageExecutionMode.PER_TILE } );
			expect( stage.shouldExecuteThisFrame( context ) ).toBe( true );

		} );

		it( 'CONDITIONAL mode delegates to shouldExecute()', () => {

			const stage = new RenderStage( 'Test', { executionMode: StageExecutionMode.CONDITIONAL } );
			stage.shouldExecute = vi.fn( () => false );
			expect( stage.shouldExecuteThisFrame( context ) ).toBe( false );
			expect( stage.shouldExecute ).toHaveBeenCalledWith( context );

		} );

	} );

	// ── render throws ──────────────────────────────────────────

	describe( 'render', () => {

		it( 'throws if not overridden', () => {

			const stage = new RenderStage( 'Test' );
			expect( () => stage.render( context ) ).toThrow( /render\(\) must be implemented/ );

		} );

	} );

	// ── Event utilities ────────────────────────────────────────

	describe( 'event utilities', () => {

		it( 'on/emit delegates to eventBus', () => {

			const stage = new RenderStage( 'Test' );
			stage.initialize( context, eventBus );

			const listener = vi.fn();
			stage.on( 'test:event', listener );
			stage.emit( 'test:event', { data: 1 } );
			expect( listener ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'emit is safe without eventBus', () => {

			const stage = new RenderStage( 'Test' );
			expect( () => stage.emit( 'test' ) ).not.toThrow();

		} );

		it( 'on is safe without eventBus', () => {

			const stage = new RenderStage( 'Test' );
			expect( () => stage.on( 'test', () => {} ) ).not.toThrow();

		} );

		it( 'once fires listener exactly once', () => {

			const stage = new RenderStage( 'Test' );
			stage.initialize( context, eventBus );

			const listener = vi.fn();
			stage.once( 'test:once', listener );
			stage.emit( 'test:once' );
			stage.emit( 'test:once' );
			expect( listener ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'once is safe without eventBus', () => {

			const stage = new RenderStage( 'Test' );
			expect( () => stage.once( 'test', () => {} ) ).not.toThrow();

		} );

		it( 'off removes listener', () => {

			const stage = new RenderStage( 'Test' );
			stage.initialize( context, eventBus );

			const listener = vi.fn();
			stage.on( 'test:off', listener );
			stage.off( 'test:off', listener );
			stage.emit( 'test:off' );
			expect( listener ).not.toHaveBeenCalled();

		} );

		it( 'off is safe without eventBus', () => {

			const stage = new RenderStage( 'Test' );
			expect( () => stage.off( 'test', () => {} ) ).not.toThrow();

		} );

	} );

	// ── shouldExecute (default) ───────────────────────────────

	describe( 'shouldExecute (default CONDITIONAL)', () => {

		it( 'default shouldExecute returns true', () => {

			const stage = new RenderStage( 'Test' );
			expect( stage.shouldExecute( context ) ).toBe( true );

		} );

	} );

	// ── Unknown execution mode ────────────────────────────────

	describe( 'unknown execution mode', () => {

		it( 'warns and returns true for unknown mode', () => {

			const spy = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
			const stage = new RenderStage( 'Test', { executionMode: 'unknown_mode' } );
			stage.initialize( context, eventBus );

			expect( stage.shouldExecuteThisFrame( context ) ).toBe( true );
			expect( spy ).toHaveBeenCalled();
			spy.mockRestore();

		} );

	} );

	// ── Debug utilities ───────────────────────────────────────

	describe( 'debug utilities', () => {

		it( 'log() prefixes with stage name', () => {

			const spy = vi.spyOn( console, 'log' ).mockImplementation( () => {} );
			const stage = new RenderStage( 'MyStage' );
			stage.log( 'hello' );
			expect( spy ).toHaveBeenCalledWith( '[MyStage]', 'hello' );
			spy.mockRestore();

		} );

		it( 'warn() prefixes with stage name', () => {

			const spy = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
			const stage = new RenderStage( 'MyStage' );
			stage.warn( 'warning' );
			expect( spy ).toHaveBeenCalledWith( '[MyStage]', 'warning' );
			spy.mockRestore();

		} );

		it( 'error() prefixes with stage name', () => {

			const spy = vi.spyOn( console, 'error' ).mockImplementation( () => {} );
			const stage = new RenderStage( 'MyStage' );
			stage.error( 'err' );
			expect( spy ).toHaveBeenCalledWith( '[MyStage]', 'err' );
			spy.mockRestore();

		} );

	} );

	// ── Lifecycle no-ops ──────────────────────────────────────

	describe( 'lifecycle no-ops', () => {

		it( 'reset is callable', () => {

			const stage = new RenderStage( 'Test' );
			expect( () => stage.reset() ).not.toThrow();

		} );

		it( 'setSize is callable', () => {

			const stage = new RenderStage( 'Test' );
			expect( () => stage.setSize( 800, 600 ) ).not.toThrow();

		} );

		it( 'dispose is callable', () => {

			const stage = new RenderStage( 'Test' );
			expect( () => stage.dispose() ).not.toThrow();

		} );

		it( 'setupEventListeners is callable', () => {

			const stage = new RenderStage( 'Test' );
			expect( () => stage.setupEventListeners() ).not.toThrow();

		} );

	} );

} );
