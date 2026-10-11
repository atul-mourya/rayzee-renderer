/**
 * Execution modes for pipeline stages in tile rendering
 *
 * @enum {string}
 */
export const StageExecutionMode = {
	/**
	 * ALWAYS - Execute every frame regardless of tile state
	 * Use for: Accumulator stages (PathTracer), visualization overlays
	 */
	ALWAYS: 'always',

	/**
	 * PER_CYCLE - Execute only when tile rendering cycle completes
	 * Use for: Post-processing, denoisers, filters (NRD, OIDN)
	 *
	 * Complete cycle means:
	 * - Progressive mode (renderMode=0): Every frame
	 * - Tile mode (renderMode=1): Only when all tiles have been rendered
	 */
	PER_CYCLE: 'per_cycle',

	/**
	 * PER_TILE - Execute for each tile, including intermediate tiles
	 * Use for: Per-tile analysis stages (if needed in the future)
	 */
	PER_TILE: 'per_tile',

	/**
	 * CONDITIONAL - Stage decides execution via shouldExecute() method
	 * Use for: Stages with complex execution logic
	 */
	CONDITIONAL: 'conditional'
};

/**
 * RenderStage - Base class for all pipeline stages
 *
 * Provides standard lifecycle methods and event handling capabilities.
 * All rendering passes should extend this class and implement the render() method.
 *
 * Execution Modes:
 * Stages can declare their tile rendering behavior via executionMode:
 * - ALWAYS: Run every frame (default, backward compatible)
 * - PER_CYCLE: Run only when tile cycles complete (denoisers, filters)
 * - PER_TILE: Run for every tile including intermediates
 * - CONDITIONAL: Custom logic via shouldExecute() override
 *
 * Lifecycle:
 * 1. constructor() - Create stage with name and options
 * 2. initialize() - Called by pipeline, receives context and eventBus
 * 3. setupEventListeners() - Override to register event listeners
 * 4. render() - Called every frame (MUST be implemented)
 * 5. reset() - Called when scene/camera changes (optional)
 * 6. setSize() - Called when viewport resizes (optional)
 * 7. dispose() - Called when stage is destroyed (optional)
 *
 * @example
 * class MyDenoiserStage extends RenderStage {
 *   constructor() {
 *     super('MyDenoiser', {
 *       enabled: true,
 *       executionMode: StageExecutionMode.PER_CYCLE
 *     });
 *   }
 *
 *   setupEventListeners() {
 *     this.on('camera:moved', () => this.handleCameraMove());
 *   }
 *
 *   render(context, writeBuffer) {
 *     // This will only run when tile cycles complete
 *     const inputTexture = context.getTexture('pathtracer:color');
 *     // ... denoising logic ...
 *   }
 * }
 */
export class RenderStage {

	/**
	 * Create a new pipeline stage
	 * @param {string} name - Stage name (used for debugging and logging)
	 * @param {Object} options - Stage options
	 * @param {boolean} [options.enabled=true] - Whether stage is enabled
	 * @param {string} [options.executionMode=StageExecutionMode.ALWAYS] - When to execute in tile rendering
	 */
	constructor( name, options = {} ) {

		this.name = name;
		this.enabled = options.enabled !== false;
		this.executionMode = options.executionMode || StageExecutionMode.ALWAYS;

		// Set by initialize()
		this.context = null;
		this.eventBus = null;

	}

	/**
	 * Initialize stage with pipeline context and event bus
	 * Called once during pipeline setup
	 * @param {PipelineContext} context - Shared pipeline context
	 * @param {EventDispatcher} eventBus - Event bus for stage communication
	 */
	initialize( context, eventBus ) {

		this.context = context;
		this.eventBus = eventBus;
		this.setupEventListeners();

	}

	/**
	 * Setup event listeners
	 * Override in subclasses to listen to events
	 *
	 * @example
	 * setupEventListeners() {
	 *   this.on('camera:moved', () => { ... });
	 *   this.on('tile:changed', (data) => { ... });
	 * }
	 */
	setupEventListeners() {
		// Override in subclasses
	}

	/**
	 * Check if this stage should execute this frame based on execution mode
	 * Called by pipeline before render()
	 *
	 * @param {PipelineContext} context - Shared pipeline context
	 * @returns {boolean} True if stage should execute this frame
	 */
	shouldExecuteThisFrame( context ) {

		// Check enabled state first
		if ( ! this.enabled ) {

			return false;

		}

		const renderMode = context.getState( 'renderMode' ) || 0;
		const tileRenderingComplete = context.getState( 'tileRenderingComplete' );

		switch ( this.executionMode ) {

			case StageExecutionMode.ALWAYS:
				// Always execute when enabled
				return true;

			case StageExecutionMode.PER_CYCLE:
				// Only execute when tile cycle is complete
				// In progressive mode (renderMode=0), every frame is a complete cycle
				// In tile mode (renderMode=1), only execute when all tiles are rendered
				if ( renderMode === 0 ) {

					return true; // Progressive mode: always complete

				} else {

					// Tile mode: check completion flag
					return tileRenderingComplete === true;

				}

			case StageExecutionMode.PER_TILE:
				// Execute for every tile, including intermediates
				// Only skip if not in tile mode and frame is 0
				return true;

			case StageExecutionMode.CONDITIONAL:
				// Delegate to subclass implementation
				return this.shouldExecute( context );

			default:
				this.warn( `Unknown execution mode: ${this.executionMode}` );
				return true; // Fail-safe: execute

		}

	}

	/**
	 * Custom execution logic for CONDITIONAL mode
	 * Override in subclasses that use StageExecutionMode.CONDITIONAL
	 *
	 * @param {PipelineContext} context - Shared pipeline context
	 * @returns {boolean} True if stage should execute
	 */
	// eslint-disable-next-line no-unused-vars
	shouldExecute( context ) {

		// Default: always execute
		// Override in subclasses for custom logic
		return true;

	}

	/**
	 * Main render method - MUST be implemented in subclasses
	 *
	 * @param {PipelineContext} context - Shared context with textures, state, etc.
	 * @param {THREE.RenderTarget} [writeBuffer] - Optional output buffer
	 * @throws {Error} If not implemented
	 */
	// eslint-disable-next-line no-unused-vars
	render( context, writeBuffer ) {

		throw new Error( `render() must be implemented in ${this.name}` );

	}

	/**
	 * Reset stage state
	 * Override if stage needs to reset internal state when scene/camera changes
	 */
	reset() {
		// Override if needed
	}

	/**
	 * Resize stage resources
	 * Override if stage needs to resize render targets or update resolution-dependent state
	 * @param {number} width - New width
	 * @param {number} height - New height
	 */
	// eslint-disable-next-line no-unused-vars
	setSize( width, height ) {
		// Override if needed
	}

	/**
	 * Clean up resources
	 * Override to dispose of render targets, materials, geometries, etc.
	 */
	dispose() {
		// Override if needed
	}

	// ===== EVENT UTILITIES =====

	/**
	 * Emit an event
	 * Convenience method for this.eventBus.emit()
	 * @param {string} type - Event type
	 * @param {*} data - Event data
	 */
	emit( type, data ) {

		if ( this.eventBus ) {

			this.eventBus.emit( type, data );

		}

	}

	/**
	 * Listen to an event
	 * Convenience method for this.eventBus.on()
	 * @param {string} type - Event type
	 * @param {Function} listener - Event listener callback
	 */
	on( type, listener ) {

		if ( this.eventBus ) {

			this.eventBus.on( type, listener );

		}

	}

	/**
	 * Listen to an event once
	 * Convenience method for this.eventBus.once()
	 * @param {string} type - Event type
	 * @param {Function} listener - Event listener callback
	 */
	once( type, listener ) {

		if ( this.eventBus ) {

			this.eventBus.once( type, listener );

		}

	}

	/**
	 * Stop listening to an event
	 * Convenience method for this.eventBus.off()
	 * @param {string} type - Event type
	 * @param {Function} listener - Event listener callback
	 */
	off( type, listener ) {

		if ( this.eventBus ) {

			this.eventBus.off( type, listener );

		}

	}

	// ===== STATE UTILITIES =====

	/**
	 * Enable this stage
	 * Emits 'stage:enabled' event
	 */
	enable() {

		if ( ! this.enabled ) {

			this.enabled = true;
			this.emit( 'stage:enabled', { stage: this.name } );

		}

	}

	/**
	 * Disable this stage
	 * Emits 'stage:disabled' event
	 */
	disable() {

		if ( this.enabled ) {

			this.enabled = false;
			this.emit( 'stage:disabled', { stage: this.name } );

		}

	}

	/**
	 * Toggle stage enabled state
	 */
	toggle() {

		if ( this.enabled ) {

			this.disable();

		} else {

			this.enable();

		}

	}

	/**
	 * Check if stage is enabled
	 * @returns {boolean} True if enabled
	 */
	isEnabled() {

		return this.enabled;

	}

	// ===== DEBUG UTILITIES =====

	/**
	 * Log a message with stage name prefix
	 * @param {...*} args - Arguments to log
	 */
	log( ...args ) {

		console.log( `[${this.name}]`, ...args );

	}

	/**
	 * Log a warning with stage name prefix
	 * @param {...*} args - Arguments to log
	 */
	warn( ...args ) {

		console.warn( `[${this.name}]`, ...args );

	}

	/**
	 * Log an error with stage name prefix
	 * @param {...*} args - Arguments to log
	 */
	error( ...args ) {

		console.error( `[${this.name}]`, ...args );

	}

}
