import { PipelineContext } from './PipelineContext.js';
import { EventDispatcher } from './EventDispatcher.js';

/**
 * RenderPipeline - Orchestrates execution of pipeline stages
 *
 * Manages:
 * - Stage execution order (stages execute in the order they're added)
 * - Shared context (textures, state, uniforms)
 * - Event bus (for stage communication)
 * - Lifecycle (reset, resize, dispose)
 *
 * Benefits:
 * - Explicit execution order (no hidden dependencies)
 * - Loose coupling (stages communicate via context and events)
 * - Easy to test (can test stages in isolation)
 * - Easy to extend (just add new stages)
 *
 * @example
 * const pipeline = new RenderPipeline(renderer, 1920, 1080);
 *
 * // Add stages in execution order
 * pipeline.addStage(new PathTracer(...));
 * pipeline.addStage(new ASVGF(...));
 * pipeline.addStage(new EdgeFilter(...));
 *
 * // Render all stages
 * pipeline.render(writeBuffer);
 *
 * // Reset when camera changes
 * pipeline.reset();
 *
 * // Clean up
 * pipeline.dispose();
 */
export class RenderPipeline {

	/**
	 * Create a new pipeline
	 * @param {THREE.WebGLRenderer} renderer - Three.js renderer
	 * @param {number} width - Viewport width
	 * @param {number} height - Viewport height
	 */
	constructor( renderer, width, height ) {

		this.renderer = renderer;
		this.width = width;
		this.height = height;

		// Stage execution list (order matters!)
		this.stages = [];

		// Shared context for all stages
		this.context = new PipelineContext();

		// Event bus for stage communication
		this.eventBus = new EventDispatcher();

		// Initialize context state
		this.context.setState( 'width', width );
		this.context.setState( 'height', height );

		// Performance tracking
		this.stats = {
			enabled: false,
			logSkipped: false, // Log skipped stages for debugging tile rendering
			timings: new Map(),
			frameCount: 0,
		};

	}

	/**
	 * Add a stage to the pipeline
	 * Stages execute in the order they're added
	 * @param {RenderStage} stage - Stage to add
	 */
	addStage( stage ) {

		this.stages.push( stage );
		stage.initialize( this.context, this.eventBus );

		// Log stage addition
		if ( this.stats.enabled ) {

			console.log( `[Pipeline] Added stage: ${stage.name}` );

		}

	}

	/**
	 * Get a stage by name
	 * @param {string} name - Stage name
	 * @returns {RenderStage|undefined} Stage or undefined if not found
	 */
	getStage( name ) {

		return this.stages.find( stage => stage.name === name );

	}

	/**
	 * Remove a stage by name
	 * @param {string} name - Stage name
	 * @returns {boolean} True if stage was removed
	 */
	removeStage( name ) {

		const index = this.stages.findIndex( stage => stage.name === name );
		if ( index > - 1 ) {

			const stage = this.stages[ index ];
			this.stages.splice( index, 1 );

			// Dispose stage
			if ( stage.dispose ) {

				stage.dispose();

			}

			// Prune stale stats entry for removed stage
			this.stats.timings.delete( stage.name );

			return true;

		}

		return false;

	}

	/**
	 * Enable a stage by name
	 * @param {string} name - Stage name
	 * @param {boolean} enabled - Enable state
	 */
	setStageEnabled( name, enabled ) {

		const stage = this.getStage( name );
		if ( stage ) {

			if ( enabled ) {

				stage.enable();

			} else {

				stage.disable();

			}

		}

	}

	/**
	 * Execute all enabled stages in order
	 * @param {THREE.RenderTarget} [writeBuffer] - Optional output buffer
	 */
	render( writeBuffer = null ) {

		const startTime = this.stats.enabled ? performance.now() : 0;

		for ( const stage of this.stages ) {

			// Check if stage should execute this frame (handles enabled state + execution mode)
			if ( ! stage.shouldExecuteThisFrame( this.context ) ) {

				// Stage skipped - log in debug mode
				if ( this.stats.enabled && this.stats.logSkipped ) {

					console.log( `[Pipeline] Skipped stage '${stage.name}' (executionMode: ${stage.executionMode})` );

				}

				continue;

			}

			try {

				const stageStartTime = this.stats.enabled ? performance.now() : 0;

				// Execute stage
				stage.render( this.context, writeBuffer );

				// Track timing
				if ( this.stats.enabled ) {

					const stageEndTime = performance.now();
					const stageDuration = stageEndTime - stageStartTime;

					if ( ! this.stats.timings.has( stage.name ) ) {

						this.stats.timings.set( stage.name, [] );

					}

					const timings = this.stats.timings.get( stage.name );
					timings.push( stageDuration );

					// Keep only last 60 frames
					if ( timings.length > 60 ) {

						timings.shift();

					}

				}

			} catch ( error ) {

				console.error( `[Pipeline] Error in stage '${stage.name}':`, error );
				// Continue pipeline execution despite error

			}

		}

		// Increment frame counter
		this.context.incrementFrame();

		// Emit frame complete event
		this.eventBus.emit( 'frame:complete', {
			frame: this.context.getState( 'frame' ),
			accumulatedFrames: this.context.getState( 'accumulatedFrames' ),
		} );

		// Track total frame time
		if ( this.stats.enabled ) {

			const endTime = performance.now();
			const frameDuration = endTime - startTime;

			if ( ! this.stats.timings.has( '_total' ) ) {

				this.stats.timings.set( '_total', [] );

			}

			const totalTimings = this.stats.timings.get( '_total' );
			totalTimings.push( frameDuration );

			if ( totalTimings.length > 60 ) {

				totalTimings.shift();

			}

			this.stats.frameCount ++;

		}

	}

	/**
	 * Reset all stages
	 * Called when scene, camera, or render settings change
	 */
	reset() {

		// Emit reset event first (stages can listen to this)
		this.eventBus.emit( 'pipeline:reset' );

		// Reset each stage
		for ( const stage of this.stages ) {

			if ( stage.reset ) {

				try {

					stage.reset();

				} catch ( error ) {

					console.error( `[Pipeline] Error resetting stage '${stage.name}':`, error );

				}

			}

		}

		// Reset context state
		this.context.reset();

		// Reset stats
		if ( this.stats.enabled ) {

			this.stats.timings.clear();
			this.stats.frameCount = 0;

		}

	}

	/**
	 * Resize all stages
	 * Called when viewport size changes
	 * @param {number} width - New width
	 * @param {number} height - New height
	 */
	setSize( width, height ) {

		this.width = width;
		this.height = height;

		// Update context state
		this.context.setState( 'width', width );
		this.context.setState( 'height', height );

		// Emit resize event first
		this.eventBus.emit( 'pipeline:resize', { width, height } );

		// Resize each stage
		for ( const stage of this.stages ) {

			if ( stage.setSize ) {

				try {

					stage.setSize( width, height );

				} catch ( error ) {

					console.error( `[Pipeline] Error resizing stage '${stage.name}':`, error );

				}

			}

		}

	}

	/**
	 * Dispose all stages and clean up
	 * Called when pipeline is being destroyed
	 */
	dispose() {

		// Dispose all stages
		for ( const stage of this.stages ) {

			if ( stage.dispose ) {

				try {

					stage.dispose();

				} catch ( error ) {

					console.error( `[Pipeline] Error disposing stage '${stage.name}':`, error );

				}

			}

		}

		// Clear stages
		this.stages = [];

		// Dispose context
		this.context.dispose();

		// Clear event bus
		this.eventBus.clear();

		// Clear stats
		this.stats.timings.clear();

	}

	// ===== PERFORMANCE TRACKING =====
	//
	// NOTE: these timings wrap stage.render() in performance.now(), which measures
	// command *encoding* on the CPU — not GPU execution. On a compute-heavy pipeline
	// they stay flat while GPU cost doubles, so they are useful for spotting CPU-side
	// stalls only. For real GPU milliseconds use PathTracerApp.enableGPUTiming() +
	// getGPUTimings(), which read WebGPU timestamp queries.

	/**
	 * Enable performance tracking
	 * @param {boolean} enabled - Enable state
	 */
	setStatsEnabled( enabled ) {

		this.stats.enabled = enabled;

		if ( ! enabled ) {

			this.stats.timings.clear();
			this.stats.frameCount = 0;

		}

	}

	/**
	 * Get performance statistics
	 * @returns {Object} Statistics object with average timings per stage
	 */
	getStats() {

		if ( ! this.stats.enabled ) {

			return null;

		}

		const stats = {
			frameCount: this.stats.frameCount,
			stages: {},
			total: 0,
		};

		for ( const [ name, timings ] of this.stats.timings.entries() ) {

			if ( timings.length === 0 ) continue;

			const avg = timings.reduce( ( a, b ) => a + b, 0 ) / timings.length;
			const min = Math.min( ...timings );
			const max = Math.max( ...timings );

			if ( name === '_total' ) {

				stats.total = avg;
				stats.totalMin = min;
				stats.totalMax = max;

			} else {

				stats.stages[ name ] = { avg, min, max };

			}

		}

		return stats;

	}

	/**
	 * Log performance statistics to console
	 */
	logStats() {

		const stats = this.getStats();
		if ( ! stats ) {

			console.log( '[Pipeline] Stats not enabled' );
			return;

		}

		console.group( '[Pipeline] Performance Stats' );
		console.log( `Frames: ${stats.frameCount}` );

		if ( stats.totalMin !== undefined ) {

			console.log( `Total: ${stats.total.toFixed( 2 )}ms (min: ${stats.totalMin.toFixed( 2 )}ms, max: ${stats.totalMax.toFixed( 2 )}ms)` );

		} else {

			console.log( 'Total: no frames recorded yet (pipeline.render() has not run since stats were enabled — the path tracer may have converged and stopped its animation loop)' );

		}

		for ( const [ name, timing ] of Object.entries( stats.stages ) ) {

			console.log( `  ${name}: ${timing.avg.toFixed( 2 )}ms (min: ${timing.min.toFixed( 2 )}ms, max: ${timing.max.toFixed( 2 )}ms)` );

		}

		console.groupEnd();

	}

	// ===== DEBUG UTILITIES =====

	/**
	 * Get pipeline info for debugging
	 * @returns {Object} Pipeline information
	 */
	getInfo() {

		return {
			stageCount: this.stages.length,
			enabledStages: this.stages.filter( s => s.enabled ).length,
			stages: this.stages.map( s => ( {
				name: s.name,
				enabled: s.enabled,
			} ) ),
			contextState: this.context.getAllState(),
			textures: this.context.getTextureNames(),
			renderTargets: this.context.getRenderTargetNames(),
			uniforms: this.context.getUniformNames(),
			events: this.eventBus.eventNames(),
		};

	}

	/**
	 * Log pipeline info to console
	 */
	logInfo() {

		const info = this.getInfo();
		console.group( '[Pipeline] Info' );
		console.log( 'Stages:', info.stages );
		console.log( 'Context Textures:', info.textures );
		console.log( 'Context Render Targets:', info.renderTargets );
		console.log( 'Context Uniforms:', info.uniforms );
		console.log( 'Event Types:', info.events );
		console.log( 'State:', info.contextState );
		console.groupEnd();

	}

}
