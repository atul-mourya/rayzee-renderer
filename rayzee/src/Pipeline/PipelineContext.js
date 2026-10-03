/**
 * PipelineContext - Shared state and resource registry for pipeline stages
 *
 * Provides centralized management of:
 * - Textures (named registry for passing data between stages)
 * - Render targets (GPU framebuffers)
 * - Uniforms (shared shader parameters)
 * - State (frame counters, flags, render modes)
 *
 * Eliminates need for direct stage-to-stage references by providing
 * a shared context that all stages can read from and write to.
 *
 * @example
 * const context = new PipelineContext();
 * context.setTexture('pathtracer:color', colorTexture);
 * context.setState('frame', frameNumber);
 *
 * // Later, in another stage:
 * const colorTexture = context.getTexture('pathtracer:color');
 * const frame = context.getState('frame');
 */
export class PipelineContext {

	constructor() {

		// Named texture registry
		// Format: Map<string, THREE.Texture>
		this.textures = new Map();

		// Named render target registry
		// Format: Map<string, THREE.RenderTarget>
		this.renderTargets = new Map();

		// Shared uniforms registry
		// Format: Map<string, { value: any }>
		this.uniforms = new Map();

		// Pipeline state - extensible object for any shared state
		this.state = {
			// Frame tracking
			frame: 0,
			accumulatedFrames: 0,

			// Render modes
			renderMode: 0, // 0 = interactive, 1 = production (full-frame in both)
			interactionMode: false,
			isComplete: false,

			// Tile rendering
			tileInfo: null,
			currentTile: 0,
			totalTiles: 0,

			// Camera state
			cameraChanged: false,
			cameraMoving: false,

			// Resolution
			width: 0,
			height: 0,

			// Time
			time: 0,
			deltaTime: 0,
			// Can be extended by stages as needed
		};

		// Change tracking for state updates
		this._stateChangeCallbacks = new Map();

	}

	// ===== TEXTURE MANAGEMENT =====

	/**
	 * Register a texture with a name
	 * Other stages can retrieve it by name
	 * @param {string} name - Texture identifier (e.g., 'pathtracer:color')
	 * @param {THREE.Texture} texture - Three.js texture
	 */
	setTexture( name, texture ) {

		this.textures.set( name, texture );

	}

	/**
	 * Retrieve a texture by name
	 * @param {string} name - Texture identifier
	 * @returns {THREE.Texture|undefined} Texture or undefined if not found
	 */
	getTexture( name ) {

		return this.textures.get( name );

	}

	/**
	 * Check if texture exists
	 * @param {string} name - Texture identifier
	 * @returns {boolean} True if texture exists
	 */
	hasTexture( name ) {

		return this.textures.has( name );

	}

	/**
	 * Remove a texture from registry
	 * @param {string} name - Texture identifier
	 */
	removeTexture( name ) {

		this.textures.delete( name );

	}

	/**
	 * Get all registered texture names
	 * @returns {string[]} Array of texture identifiers
	 */
	getTextureNames() {

		return Array.from( this.textures.keys() );

	}

	/**
	 * Clear all textures
	 */
	clearTextures() {

		this.textures.clear();

	}

	// ===== RENDER TARGET MANAGEMENT =====

	/**
	 * Register a render target with a name
	 * @param {string} name - Render target identifier
	 * @param {THREE.RenderTarget} target - Three.js render target
	 */
	setRenderTarget( name, target ) {

		this.renderTargets.set( name, target );

	}

	/**
	 * Retrieve a render target by name
	 * @param {string} name - Render target identifier
	 * @returns {THREE.RenderTarget|undefined} Render target or undefined
	 */
	getRenderTarget( name ) {

		return this.renderTargets.get( name );

	}

	/**
	 * Check if render target exists
	 * @param {string} name - Render target identifier
	 * @returns {boolean} True if render target exists
	 */
	hasRenderTarget( name ) {

		return this.renderTargets.has( name );

	}

	/**
	 * Remove a render target
	 * @param {string} name - Render target identifier
	 */
	removeRenderTarget( name ) {

		this.renderTargets.delete( name );

	}

	/**
	 * Get all registered render target names
	 * @returns {string[]} Array of render target identifiers
	 */
	getRenderTargetNames() {

		return Array.from( this.renderTargets.keys() );

	}

	/**
	 * Clear all render targets
	 */
	clearRenderTargets() {

		this.renderTargets.clear();

	}

	// ===== UNIFORM MANAGEMENT =====

	/**
	 * Set a shared uniform value
	 * @param {string} name - Uniform name
	 * @param {*} value - Uniform value
	 */
	setUniform( name, value ) {

		if ( ! this.uniforms.has( name ) ) {

			this.uniforms.set( name, { value } );

		} else {

			this.uniforms.get( name ).value = value;

		}

	}

	/**
	 * Get a shared uniform
	 * @param {string} name - Uniform name
	 * @returns {{ value: any }|undefined} Uniform object or undefined
	 */
	getUniform( name ) {

		return this.uniforms.get( name );

	}

	/**
	 * Get a uniform value directly
	 * @param {string} name - Uniform name
	 * @returns {*} Uniform value or undefined
	 */
	getUniformValue( name ) {

		return this.uniforms.get( name )?.value;

	}

	/**
	 * Check if uniform exists
	 * @param {string} name - Uniform name
	 * @returns {boolean} True if uniform exists
	 */
	hasUniform( name ) {

		return this.uniforms.has( name );

	}

	/**
	 * Remove a uniform
	 * @param {string} name - Uniform name
	 */
	removeUniform( name ) {

		this.uniforms.delete( name );

	}

	/**
	 * Get all uniform names
	 * @returns {string[]} Array of uniform names
	 */
	getUniformNames() {

		return Array.from( this.uniforms.keys() );

	}

	/**
	 * Clear all uniforms
	 */
	clearUniforms() {

		this.uniforms.clear();

	}

	// ===== STATE MANAGEMENT =====

	/**
	 * Set a state value
	 * Returns true if value changed
	 * @param {string} key - State key
	 * @param {*} value - State value
	 * @returns {boolean} True if value changed
	 */
	setState( key, value ) {

		const oldValue = this.state[ key ];
		const changed = oldValue !== value;

		if ( changed ) {

			this.state[ key ] = value;
			this._notifyStateChange( key, value, oldValue );

		}

		return changed;

	}

	/**
	 * Get a state value
	 * @param {string} key - State key
	 * @returns {*} State value
	 */
	getState( key ) {

		return this.state[ key ];

	}

	/**
	 * Get entire state object (read-only reference)
	 * @returns {Object} State object
	 */
	getAllState() {

		return this.state;

	}

	/**
	 * Set multiple state values at once
	 * @param {Object} updates - Object with key-value pairs to update
	 * @returns {string[]} Array of keys that changed
	 */
	setStates( updates ) {

		const changedKeys = [];

		for ( const [ key, value ] of Object.entries( updates ) ) {

			if ( this.setState( key, value ) ) {

				changedKeys.push( key );

			}

		}

		return changedKeys;

	}

	/**
	 * Check if state key exists
	 * @param {string} key - State key
	 * @returns {boolean} True if key exists
	 */
	hasState( key ) {

		return key in this.state;

	}

	/**
	 * Watch for changes to a specific state key
	 * @param {string} key - State key to watch
	 * @param {Function} callback - Callback(newValue, oldValue)
	 */
	watchState( key, callback ) {

		if ( ! this._stateChangeCallbacks.has( key ) ) {

			this._stateChangeCallbacks.set( key, [] );

		}

		this._stateChangeCallbacks.get( key ).push( callback );

	}

	/**
	 * Stop watching a state key
	 * @param {string} key - State key
	 * @param {Function} callback - Callback to remove
	 */
	unwatchState( key, callback ) {

		if ( ! this._stateChangeCallbacks.has( key ) ) return;

		const callbacks = this._stateChangeCallbacks.get( key );
		const index = callbacks.indexOf( callback );

		if ( index > - 1 ) {

			callbacks.splice( index, 1 );

		}

	}

	/**
	 * Internal: Notify state change callbacks
	 * @private
	 */
	_notifyStateChange( key, newValue, oldValue ) {

		if ( ! this._stateChangeCallbacks.has( key ) ) return;

		const callbacks = this._stateChangeCallbacks.get( key );
		for ( const callback of callbacks ) {

			try {

				callback( newValue, oldValue );

			} catch ( error ) {

				console.error( `Error in state change callback for '${key}':`, error );

			}

		}

	}

	// ===== RESET & CLEANUP =====

	/**
	 * Reset pipeline state (typically called when scene/camera changes)
	 * Resets frame counters and flags, but keeps textures and render targets
	 */
	reset() {

		this.state.frame = 0;
		this.state.accumulatedFrames = 0;
		this.state.isComplete = false;
		this.state.cameraChanged = true;
		this.state.currentTile = 0;

	}

	/**
	 * Increment frame counter
	 * @returns {number} New frame number
	 */
	incrementFrame() {

		this.state.frame ++;
		this.state.accumulatedFrames ++;
		return this.state.frame;

	}

	/**
	 * Full cleanup - dispose all resources
	 * Should be called when pipeline is being destroyed
	 */
	dispose() {

		// Clear all registries
		this.textures.clear();
		this.renderTargets.clear();
		this.uniforms.clear();
		this._stateChangeCallbacks.clear();

		// Reset state
		this.state = {};

	}

}
