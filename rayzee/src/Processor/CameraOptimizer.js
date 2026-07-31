/**
 * CameraOptimizer.js
 * Manages performance optimization during camera interaction by temporarily
 * reducing rendering quality while the camera is moving, then restoring
 * full quality when movement stops.
 */
export class CameraOptimizer {

	constructor( renderer, material, settings = {} ) {

		this.renderer = renderer;
		this.material = material;

		// Configuration
		this.interactionModeEnabled = settings.enabled !== undefined ? settings.enabled : true;
		this.interactionDelay = settings.delay || 100; // ms delay before exiting interaction mode

		// State
		this.interactionMode = false;
		this.interactionTimeout = null;
		this.originalValues = {};
		this.wasAccumulationEnabled = true; // Track original accumulation state

		// Enhanced interaction mode settings for reduced quality during interaction
		this.interactionQualitySettings = {
			maxBounceCount: 1,
			// pixelRatio: 0.25,
			enableAccumulation: false,
			...settings.qualitySettings
		};

		// Callbacks
		this.onEnterCallback = settings.onEnter || null;
		this.onExitCallback = settings.onExit || null;
		this.onResetCallback = settings.onReset || null;

	}

	/**
     * Enter interaction mode with reduced quality settings
     */
	enterInteractionMode() {

		// Check if interaction mode is enabled globally
		if ( ! this.interactionModeEnabled ) return;

		if ( this.interactionMode ) {

			// Already in interaction mode, just clear the timeout
			clearTimeout( this.interactionTimeout );

		} else {

			// Enter interaction mode and save original values
			this.interactionMode = true;
			this.originalValues = {}; // Reset stored values

			// Store original accumulation state before any changes
			if ( this.material.uniforms.enableAccumulation ) {

				this.wasAccumulationEnabled = this.material.uniforms.enableAccumulation.value;

			}

			// Store and apply all interaction settings
			Object.keys( this.interactionQualitySettings ).forEach( key => {

				if ( key === 'pixelRatio' ) {

					// Handle pixel ratio separately
					this.originalValues.dpr = this.renderer.getPixelRatio();
					this.renderer.setPixelRatio( this.interactionQualitySettings.pixelRatio );

				} else if ( key === 'enableAccumulation' ) {

					// Handle accumulation separately - don't store in originalValues yet
					// We'll handle this in the uniform update below

				} else if ( this.material.uniforms[ key ] ) {

					// Handle material uniforms
					this.originalValues[ key ] = this.material.uniforms[ key ].value;
					this.material.uniforms[ key ].value = this.interactionQualitySettings[ key ];

				}

			} );

			// Store original accumulation value and disable it
			if ( this.material.uniforms.enableAccumulation ) {

				this.originalValues.enableAccumulation = this.material.uniforms.enableAccumulation.value;
				this.material.uniforms.enableAccumulation.value = false;

			}

			if ( this.material.uniforms.cameraIsMoving ) {

				this.originalValues.cameraIsMoving = this.material.uniforms.cameraIsMoving.value;
				this.material.uniforms.cameraIsMoving.value = true;

			}

			// Call enter callback
			if ( this.onEnterCallback ) {

				this.onEnterCallback();

			}

		}

		// Set timeout to exit interaction mode
		this.interactionTimeout = setTimeout( () => {

			this.exitInteractionMode();

		}, this.interactionDelay );

	}

	/**
     * Exit interaction mode and restore original quality settings
     */
	exitInteractionMode() {

		if ( ! this.interactionMode ) return;

		// Restore original values in correct order
		Object.keys( this.originalValues ).forEach( key => {

			if ( key === 'dpr' ) {

				// Restore pixel ratio
				this.renderer.setPixelRatio( this.originalValues.dpr );

			} else if ( this.material.uniforms[ key ] ) {

				// Restore material uniforms
				this.material.uniforms[ key ].value = this.originalValues[ key ];

			}

		} );

		this.interactionMode = false;
		this.originalValues = {}; // Clear stored values

		// Call exit callback first (this may trigger a reset)
		if ( this.onExitCallback ) {

			this.onExitCallback();

		}

		// Reset frame counter but preserve buffers for smooth transition
		if ( this.onResetCallback ) {

			this.onResetCallback();

		}

	}

	/**
     * Update interaction mode based on camera movement
     * @param {boolean} cameraChanged - Whether camera has changed this frame
     */
	updateInteractionMode( cameraChanged ) {

		if ( cameraChanged ) {

			this.enterInteractionMode();

		}

	}

	/**
     * Set whether interaction mode is enabled
     * @param {boolean} enabled - Whether to enable interaction mode
     */
	setInteractionModeEnabled( enabled ) {

		this.interactionModeEnabled = enabled;

		// If turning off while in interaction mode, exit immediately
		if ( ! enabled && this.interactionMode ) {

			clearTimeout( this.interactionTimeout );
			this.exitInteractionMode();

		}

	}

	/**
     * Update interaction quality settings
     * @param {Object} settings - New quality settings
     */
	updateQualitySettings( settings ) {

		Object.assign( this.interactionQualitySettings, settings );

		// If currently in interaction mode, apply new settings
		if ( this.interactionMode ) {

			Object.keys( settings ).forEach( key => {

				if ( key === 'pixelRatio' ) {

					this.renderer.setPixelRatio( settings.pixelRatio );

				} else if ( this.material.uniforms[ key ] ) {

					this.material.uniforms[ key ].value = settings[ key ];

				}

			} );

		}

	}

	/**
     * Set the interaction delay
     * @param {number} delay - Delay in milliseconds
     */
	setInteractionDelay( delay ) {

		this.interactionDelay = delay;

	}

	/**
     * Get current interaction state
     * @returns {Object} - Current state information
     */
	getState() {

		return {
			interactionMode: this.interactionMode,
			interactionModeEnabled: this.interactionModeEnabled,
			interactionDelay: this.interactionDelay,
			hasTimeout: this.interactionTimeout !== null,
			qualitySettings: { ...this.interactionQualitySettings },
			originalValues: { ...this.originalValues },
			wasAccumulationEnabled: this.wasAccumulationEnabled
		};

	}

	/**
     * Force exit interaction mode immediately
     */
	forceExitInteractionMode() {

		if ( this.interactionTimeout ) {

			clearTimeout( this.interactionTimeout );
			this.interactionTimeout = null;

		}

		this.exitInteractionMode();

	}

	/**
     * Check if currently in interaction mode
     * @returns {boolean} - True if in interaction mode
     */
	isInInteractionMode() {

		return this.interactionMode;

	}

	/**
     * Set callbacks for interaction events
     * @param {Object} callbacks - Object containing callback functions
     * @param {Function} callbacks.onEnter - Called when entering interaction mode
     * @param {Function} callbacks.onExit - Called when exiting interaction mode
     * @param {Function} callbacks.onReset - Called when reset is needed
     */
	setCallbacks( callbacks ) {

		if ( callbacks.onEnter ) this.onEnterCallback = callbacks.onEnter;
		if ( callbacks.onExit ) this.onExitCallback = callbacks.onExit;
		if ( callbacks.onReset ) this.onResetCallback = callbacks.onReset;

	}

	/**
     * Create interaction mode settings for different quality levels
     * @param {string} quality - Quality level: 'ultra-low', 'low', 'medium', 'high'
     * @returns {Object} - Quality settings object
     */
	static createQualityPreset( quality ) {

		const presets = {
			'ultra-low': {
				maxBounceCount: 1,
				pixelRatio: 0.125,
				enableAccumulation: false
			},
			'low': {
				maxBounceCount: 1,
				pixelRatio: 0.25,
				enableAccumulation: false
			},
			'medium': {
				maxBounceCount: 2,
				pixelRatio: 0.5,
				enableAccumulation: false
			},
			'high': {
				maxBounceCount: 3,
				pixelRatio: 0.75,
				enableAccumulation: true
			}
		};

		return presets[ quality ] || presets[ 'low' ];

	}

	/**
     * Clean up resources and clear timeouts
     */
	dispose() {

		if ( this.interactionTimeout ) {

			clearTimeout( this.interactionTimeout );
			this.interactionTimeout = null;

		}

		// Exit interaction mode if active
		if ( this.interactionMode ) {

			this.forceExitInteractionMode();

		}

		// Clear callbacks
		this.onEnterCallback = null;
		this.onExitCallback = null;
		this.onResetCallback = null;

	}

}
