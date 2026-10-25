import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RenderPipeline } from '@/core/pipeline/RenderPipeline.js';
import { RenderStage, StageExecutionMode } from '@/core/pipeline/RenderStage.js';

/**
 * Creates a minimal mock stage for testing
 */
function createMockStage( name, options = {} ) {

	const stage = new RenderStage( name, options );
	stage.render = vi.fn();
	stage.reset = vi.fn();
	stage.setSize = vi.fn();
	stage.dispose = vi.fn();
	return stage;

}

describe( 'RenderPipeline', () => {

	let pipeline;
	const mockRenderer = {};

	beforeEach( () => {

		pipeline = new RenderPipeline( mockRenderer, 1920, 1080 );

	} );

	// ── Constructor ────────────────────────────────────────────

	describe( 'constructor', () => {

		it( 'initializes with empty stages', () => {

			expect( pipeline.stages ).toHaveLength( 0 );

		} );

		it( 'creates context with dimensions', () => {

			expect( pipeline.context.getState( 'width' ) ).toBe( 1920 );
			expect( pipeline.context.getState( 'height' ) ).toBe( 1080 );

		} );

		it( 'creates event bus', () => {

			expect( pipeline.eventBus ).toBeDefined();

		} );

	} );

	// ── addStage ───────────────────────────────────────────────

	describe( 'addStage', () => {

		it( 'adds stage to stages array', () => {

			const stage = createMockStage( 'A' );
			pipeline.addStage( stage );
			expect( pipeline.stages ).toHaveLength( 1 );

		} );

		it( 'initializes stage with context and eventBus', () => {

			const stage = createMockStage( 'A' );
			pipeline.addStage( stage );
			expect( stage.context ).toBe( pipeline.context );
			expect( stage.eventBus ).toBe( pipeline.eventBus );

		} );

		it( 'preserves insertion order', () => {

			const a = createMockStage( 'A' );
			const b = createMockStage( 'B' );
			const c = createMockStage( 'C' );
			pipeline.addStage( a );
			pipeline.addStage( b );
			pipeline.addStage( c );
			expect( pipeline.stages.map( s => s.name ) ).toEqual( [ 'A', 'B', 'C' ] );

		} );

	} );

	// ── getStage ───────────────────────────────────────────────

	describe( 'getStage', () => {

		it( 'returns stage by name', () => {

			const stage = createMockStage( 'MyStage' );
			pipeline.addStage( stage );
			expect( pipeline.getStage( 'MyStage' ) ).toBe( stage );

		} );

		it( 'returns undefined for missing name', () => {

			expect( pipeline.getStage( 'nonexistent' ) ).toBeUndefined();

		} );

	} );

	// ── removeStage ────────────────────────────────────────────

	describe( 'removeStage', () => {

		it( 'removes stage and returns true', () => {

			const stage = createMockStage( 'A' );
			pipeline.addStage( stage );
			expect( pipeline.removeStage( 'A' ) ).toBe( true );
			expect( pipeline.stages ).toHaveLength( 0 );

		} );

		it( 'calls dispose on removed stage', () => {

			const stage = createMockStage( 'A' );
			pipeline.addStage( stage );
			pipeline.removeStage( 'A' );
			expect( stage.dispose ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'returns false for missing stage', () => {

			expect( pipeline.removeStage( 'nonexistent' ) ).toBe( false );

		} );

	} );

	// ── setStageEnabled ────────────────────────────────────────

	describe( 'setStageEnabled', () => {

		it( 'disables a stage', () => {

			const stage = createMockStage( 'A' );
			pipeline.addStage( stage );
			pipeline.setStageEnabled( 'A', false );
			expect( stage.isEnabled() ).toBe( false );

		} );

		it( 'enables a stage', () => {

			const stage = createMockStage( 'A', { enabled: false } );
			pipeline.addStage( stage );
			pipeline.setStageEnabled( 'A', true );
			expect( stage.isEnabled() ).toBe( true );

		} );

	} );

	// ── render ─────────────────────────────────────────────────

	describe( 'render', () => {

		it( 'calls render on enabled stages in order', () => {

			const order = [];
			const a = createMockStage( 'A' );
			a.render = vi.fn( () => order.push( 'A' ) );
			const b = createMockStage( 'B' );
			b.render = vi.fn( () => order.push( 'B' ) );
			const c = createMockStage( 'C' );
			c.render = vi.fn( () => order.push( 'C' ) );

			pipeline.addStage( a );
			pipeline.addStage( b );
			pipeline.addStage( c );
			pipeline.render();

			expect( order ).toEqual( [ 'A', 'B', 'C' ] );

		} );

		it( 'skips disabled stages', () => {

			const a = createMockStage( 'A' );
			const b = createMockStage( 'B', { enabled: false } );
			const c = createMockStage( 'C' );

			pipeline.addStage( a );
			pipeline.addStage( b );
			pipeline.addStage( c );
			pipeline.render();

			expect( a.render ).toHaveBeenCalledTimes( 1 );
			expect( b.render ).not.toHaveBeenCalled();
			expect( c.render ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'increments frame counter', () => {

			pipeline.render();
			expect( pipeline.context.getState( 'frame' ) ).toBe( 1 );

		} );

		it( 'emits frame:complete event', () => {

			const listener = vi.fn();
			pipeline.eventBus.on( 'frame:complete', listener );
			pipeline.render();
			expect( listener ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'continues execution when a stage throws', () => {

			vi.spyOn( console, 'error' ).mockImplementation( () => {} );

			const a = createMockStage( 'A' );
			a.render = vi.fn( () => {

				throw new Error( 'fail' );

			} );
			const b = createMockStage( 'B' );

			pipeline.addStage( a );
			pipeline.addStage( b );
			pipeline.render();

			expect( b.render ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'PER_CYCLE stage skipped when tile not complete', () => {

			pipeline.context.setState( 'renderMode', 1 );
			pipeline.context.setState( 'tileRenderingComplete', false );

			const stage = createMockStage( 'Denoiser', { executionMode: StageExecutionMode.PER_CYCLE } );
			pipeline.addStage( stage );
			pipeline.render();

			expect( stage.render ).not.toHaveBeenCalled();

		} );

	} );

	// ── reset ──────────────────────────────────────────────────

	describe( 'reset', () => {

		it( 'calls reset on all stages', () => {

			const a = createMockStage( 'A' );
			const b = createMockStage( 'B' );
			pipeline.addStage( a );
			pipeline.addStage( b );
			pipeline.reset();

			expect( a.reset ).toHaveBeenCalledTimes( 1 );
			expect( b.reset ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'emits pipeline:reset event', () => {

			const listener = vi.fn();
			pipeline.eventBus.on( 'pipeline:reset', listener );
			pipeline.reset();
			expect( listener ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'resets context state', () => {

			pipeline.context.incrementFrame();
			pipeline.context.incrementFrame();
			pipeline.reset();
			expect( pipeline.context.getState( 'frame' ) ).toBe( 0 );

		} );

	} );

	// ── setSize ────────────────────────────────────────────────

	describe( 'setSize', () => {

		it( 'updates dimensions', () => {

			pipeline.setSize( 800, 600 );
			expect( pipeline.width ).toBe( 800 );
			expect( pipeline.height ).toBe( 600 );

		} );

		it( 'updates context state', () => {

			pipeline.setSize( 800, 600 );
			expect( pipeline.context.getState( 'width' ) ).toBe( 800 );
			expect( pipeline.context.getState( 'height' ) ).toBe( 600 );

		} );

		it( 'calls setSize on all stages', () => {

			const stage = createMockStage( 'A' );
			pipeline.addStage( stage );
			pipeline.setSize( 800, 600 );
			expect( stage.setSize ).toHaveBeenCalledWith( 800, 600 );

		} );

		it( 'emits pipeline:resize event', () => {

			const listener = vi.fn();
			pipeline.eventBus.on( 'pipeline:resize', listener );
			pipeline.setSize( 800, 600 );
			expect( listener ).toHaveBeenCalledTimes( 1 );

		} );

	} );

	// ── dispose ────────────────────────────────────────────────

	describe( 'dispose', () => {

		it( 'disposes all stages', () => {

			const a = createMockStage( 'A' );
			const b = createMockStage( 'B' );
			pipeline.addStage( a );
			pipeline.addStage( b );
			pipeline.dispose();

			expect( a.dispose ).toHaveBeenCalledTimes( 1 );
			expect( b.dispose ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'clears stages array', () => {

			pipeline.addStage( createMockStage( 'A' ) );
			pipeline.dispose();
			expect( pipeline.stages ).toHaveLength( 0 );

		} );

	} );

	// ── Stats ──────────────────────────────────────────────────

	describe( 'stats', () => {

		it( 'getStats returns null when disabled', () => {

			expect( pipeline.getStats() ).toBeNull();

		} );

		it( 'tracks timings when enabled', () => {

			pipeline.setStatsEnabled( true );

			const stage = createMockStage( 'A' );
			pipeline.addStage( stage );
			pipeline.render();
			pipeline.render();

			const stats = pipeline.getStats();
			expect( stats ).not.toBeNull();
			expect( stats.frameCount ).toBe( 2 );
			expect( stats.stages ).toHaveProperty( 'A' );
			expect( stats.stages.A ).toHaveProperty( 'avg' );

		} );

		it( 'setStatsEnabled(false) clears timings', () => {

			pipeline.setStatsEnabled( true );
			pipeline.addStage( createMockStage( 'A' ) );
			pipeline.render();
			pipeline.setStatsEnabled( false );
			expect( pipeline.stats.frameCount ).toBe( 0 );

		} );

	} );

	// ── getInfo ────────────────────────────────────────────────

	describe( 'getInfo', () => {

		it( 'returns pipeline information', () => {

			pipeline.addStage( createMockStage( 'A' ) );
			pipeline.addStage( createMockStage( 'B', { enabled: false } ) );

			const info = pipeline.getInfo();
			expect( info.stageCount ).toBe( 2 );
			expect( info.enabledStages ).toBe( 1 );
			expect( info.stages ).toHaveLength( 2 );

		} );

		it( 'includes context textures, renderTargets, uniforms, events', () => {

			const info = pipeline.getInfo();
			expect( info ).toHaveProperty( 'textures' );
			expect( info ).toHaveProperty( 'renderTargets' );
			expect( info ).toHaveProperty( 'uniforms' );
			expect( info ).toHaveProperty( 'events' );
			expect( info ).toHaveProperty( 'contextState' );

		} );

	} );

	// ── logStats ───────────────────────────────────────────────

	describe( 'logStats', () => {

		it( 'logs "not enabled" when stats disabled', () => {

			const spy = vi.spyOn( console, 'log' ).mockImplementation( () => {} );
			pipeline.logStats();
			expect( spy ).toHaveBeenCalledWith( expect.stringContaining( 'not enabled' ) );
			spy.mockRestore();

		} );

		it( 'logs stats when enabled and frames rendered', () => {

			const groupSpy = vi.spyOn( console, 'group' ).mockImplementation( () => {} );
			const logSpy = vi.spyOn( console, 'log' ).mockImplementation( () => {} );
			const groupEndSpy = vi.spyOn( console, 'groupEnd' ).mockImplementation( () => {} );

			pipeline.setStatsEnabled( true );
			pipeline.addStage( createMockStage( 'A' ) );
			pipeline.render();
			pipeline.logStats();

			expect( groupSpy ).toHaveBeenCalled();
			expect( groupEndSpy ).toHaveBeenCalled();

			groupSpy.mockRestore();
			logSpy.mockRestore();
			groupEndSpy.mockRestore();

		} );

	} );

	// ── logInfo ────────────────────────────────────────────────

	describe( 'logInfo', () => {

		it( 'logs pipeline info to console', () => {

			const groupSpy = vi.spyOn( console, 'group' ).mockImplementation( () => {} );
			const logSpy = vi.spyOn( console, 'log' ).mockImplementation( () => {} );
			const groupEndSpy = vi.spyOn( console, 'groupEnd' ).mockImplementation( () => {} );

			pipeline.addStage( createMockStage( 'A' ) );
			pipeline.logInfo();

			expect( groupSpy ).toHaveBeenCalled();
			expect( logSpy ).toHaveBeenCalled();
			expect( groupEndSpy ).toHaveBeenCalled();

			groupSpy.mockRestore();
			logSpy.mockRestore();
			groupEndSpy.mockRestore();

		} );

	} );

	// ── stats edge cases ──────────────────────────────────────

	describe( 'stats edge cases', () => {

		it( 'keeps only last 60 timing entries per stage', () => {

			pipeline.setStatsEnabled( true );
			pipeline.addStage( createMockStage( 'A' ) );

			for ( let i = 0; i < 70; i ++ ) {

				pipeline.render();

			}

			const timings = pipeline.stats.timings.get( 'A' );
			expect( timings.length ).toBe( 60 );

		} );

		it( 'keeps only last 60 total timing entries', () => {

			pipeline.setStatsEnabled( true );

			for ( let i = 0; i < 70; i ++ ) {

				pipeline.render();

			}

			const totalTimings = pipeline.stats.timings.get( '_total' );
			expect( totalTimings.length ).toBe( 60 );

		} );

		it( 'logs skipped stages when logSkipped is true', () => {

			const spy = vi.spyOn( console, 'log' ).mockImplementation( () => {} );

			pipeline.setStatsEnabled( true );
			pipeline.stats.logSkipped = true;

			const stage = createMockStage( 'Denoiser', { enabled: false } );
			pipeline.addStage( stage );
			pipeline.render();

			expect( spy ).toHaveBeenCalledWith( expect.stringContaining( 'Skipped' ) );
			spy.mockRestore();

		} );

		it( 'reset clears stats timings', () => {

			pipeline.setStatsEnabled( true );
			pipeline.addStage( createMockStage( 'A' ) );
			pipeline.render();
			pipeline.reset();

			expect( pipeline.stats.timings.size ).toBe( 0 );
			expect( pipeline.stats.frameCount ).toBe( 0 );

		} );

	} );

	// ── error resilience ──────────────────────────────────────

	describe( 'error resilience', () => {

		it( 'reset continues when stage reset throws', () => {

			const spy = vi.spyOn( console, 'error' ).mockImplementation( () => {} );
			const a = createMockStage( 'A' );
			a.reset = vi.fn( () => {

				throw new Error( 'reset fail' );

			} );
			const b = createMockStage( 'B' );

			pipeline.addStage( a );
			pipeline.addStage( b );
			pipeline.reset();

			expect( b.reset ).toHaveBeenCalled();
			spy.mockRestore();

		} );

		it( 'setSize continues when stage setSize throws', () => {

			const spy = vi.spyOn( console, 'error' ).mockImplementation( () => {} );
			const a = createMockStage( 'A' );
			a.setSize = vi.fn( () => {

				throw new Error( 'resize fail' );

			} );
			const b = createMockStage( 'B' );

			pipeline.addStage( a );
			pipeline.addStage( b );
			pipeline.setSize( 800, 600 );

			expect( b.setSize ).toHaveBeenCalledWith( 800, 600 );
			spy.mockRestore();

		} );

		it( 'dispose continues when stage dispose throws', () => {

			const spy = vi.spyOn( console, 'error' ).mockImplementation( () => {} );
			const a = createMockStage( 'A' );
			a.dispose = vi.fn( () => {

				throw new Error( 'dispose fail' );

			} );
			const b = createMockStage( 'B' );

			pipeline.addStage( a );
			pipeline.addStage( b );
			pipeline.dispose();

			expect( b.dispose ).toHaveBeenCalled();
			spy.mockRestore();

		} );

	} );

} );
