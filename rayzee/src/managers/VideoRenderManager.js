/**
 * VideoRenderManager — Drives offline frame-by-frame animation rendering.
 *
 * Seeks the animation to each frame time, accumulates SPP until convergence,
 * optionally denoises, captures the output canvas, and delivers each frame
 * via a callback for encoding.
 */

import { EngineEvents } from '../EngineEvents.js';
import { PRODUCTION_RENDER_CONFIG } from '../EngineDefaults.js';
import { updateStats, getDisplaySamples } from '../Processor/utils.js';

export class VideoRenderManager {

	constructor( app ) {

		this._app = app;
		this._cancelled = false;
		this._rendering = false;

	}

	/**
	 * Render an animation clip frame-by-frame.
	 *
	 * @param {Object} options
	 * @param {number} [options.clipIndex=0]        - Animation clip index
	 * @param {number} [options.fps=30]             - Output frame rate
	 * @param {number} [options.samplesPerFrame]     - SPP per frame (defaults to PRODUCTION_RENDER_CONFIG.maxSamples)
	 * @param {boolean} [options.enableOIDN=true]    - Run OIDN denoiser per frame
	 * @param {number} [options.speed=1]              - Playback speed multiplier (maps video time to animation time)
	 * @param {number} [options.totalFrames]         - Override total frame count (for looped animations)
	 * @param {Function} [options.onFrame]           - async (ImageBitmap, frameIndex, totalFrames) => void
	 * @param {Function} [options.onProgress]        - ({ frame, totalFrames, percent }) => void
	 * @param {Function} [options.onComplete]        - (success: boolean) => void
	 */
	async renderAnimation( options = {} ) {

		const {
			clipIndex = 0,
			fps = 30,
			speed = 1,
			samplesPerFrame = PRODUCTION_RENDER_CONFIG.maxSamples,
			enableOIDN = true,
			onFrame,
			onProgress,
			onComplete,
		} = options;

		const app = this._app;

		if ( ! app.animationManager?.hasAnimations ) {

			console.warn( 'VideoRenderManager: No animation clips available' );
			onComplete?.( false );
			return;

		}

		const clip = app.animationManager.clips[ clipIndex ];
		if ( ! clip ) {

			console.warn( `VideoRenderManager: Invalid clip index ${clipIndex}` );
			onComplete?.( false );
			return;

		}

		const effectiveDuration = clip.duration / ( speed || 1 );
		const totalFrames = options.totalFrames || Math.ceil( effectiveDuration * fps );
		const frameDuration = 1 / fps;

		this._cancelled = false;
		this._rendering = true;

		// Save current engine state
		const savedState = this._saveState();

		// Stop the rAF loop — we drive rendering manually
		app.stopAnimation();

		// Configure for high-quality offline rendering
		app.configureForMode( 'production' );

		// Override samples per frame
		app.settings.setMany( { maxSamples: samplesPerFrame }, { silent: true } );
		app.stages.pathTracer?.updateCompletionThreshold?.();

		// Disable camera controls during render
		if ( app.cameraManager.controls ) app.cameraManager.controls.enabled = false;

		try {

			for ( let i = 0; i < totalFrames; i ++ ) {

				if ( this._cancelled ) break;

				// Map video time to animation time via speed multiplier
				const animationTime = i * frameDuration * speed;

				// 1. Seek animation to frame time
				const positions = app.animationManager.seekTo( animationTime, clipIndex );

				// 2. Refit BVH with deformed positions (also calls reset())
				if ( positions ) {

					await app.refitBVH( positions );

				} else {

					// No deformation (static frame) — just reset accumulation
					app.reset();

				}

				// reset() calls wake() which restarts the rAF loop —
				// kill it immediately so it doesn't race with our manual render loop
				app.stopAnimation();

				// 3. Accumulate samples until convergence
				await this._accumulateFrame( app );

				if ( this._cancelled ) break;

				// 4. Denoise if enabled
				if ( enableOIDN && app.denoisingManager?.finalDenoise ) {

					await this._waitForDenoise( app );

				}

				if ( this._cancelled ) break;

				// 5. Capture frame from output canvas
				const canvas = app.getCanvas();
				if ( canvas && onFrame ) {

					const bitmap = await createImageBitmap( canvas );
					await onFrame( bitmap, i, totalFrames );
					bitmap.close();

				}

				// 6. Report progress
				const progress = {
					frame: i + 1,
					totalFrames,
					percent: ( ( i + 1 ) / totalFrames ) * 100,
				};

				onProgress?.( progress );
				app.dispatchEvent( {
					type: EngineEvents.VIDEO_RENDER_PROGRESS,
					...progress,
				} );

			}

		} catch ( error ) {

			console.error( 'VideoRenderManager: Render error:', error );
			this._cancelled = true;

		} finally {

			// Restore engine state
			this._restoreState( savedState );
			this._rendering = false;

			const success = ! this._cancelled;
			onComplete?.( success );
			app.dispatchEvent( {
				type: EngineEvents.VIDEO_RENDER_COMPLETE,
				success,
			} );

		}

	}

	/**
	 * Cancel an in-progress render.
	 */
	cancel() {

		this._cancelled = true;

	}

	get isRendering() {

		return this._rendering;

	}

	/**
	 * Drive pipeline.render() in a loop until the path tracer is complete.
	 * Yields to the browser periodically for UI responsiveness.
	 * @private
	 */
	async _accumulateFrame( app ) {

		const pathTracer = app.stages.pathTracer;
		if ( ! pathTracer?.isReady ) return;

		while ( ! pathTracer.isComplete && ! this._cancelled ) {

			app.cameraManager.camera.updateMatrixWorld();
			app.pipeline.render();

			// Yield every 4 passes to keep UI responsive and update stats
			if ( pathTracer.frameCount % 4 === 0 ) {

				updateStats( { samples: getDisplaySamples( pathTracer ) } );
				await new Promise( r => setTimeout( r, 0 ) );

			}

		}

	}

	/**
	 * Trigger OIDN denoising and wait for completion.
	 * Wraps the event-based API in a promise with a timeout to prevent hangs.
	 * @private
	 */
	_waitForDenoise( app ) {

		const DENOISE_TIMEOUT_MS = 30_000;

		return new Promise( ( resolve ) => {

			let timer;

			const cleanup = () => {

				app.removeEventListener( EngineEvents.DENOISING_END, onEnd );
				clearTimeout( timer );

			};

			const onEnd = () => {

				cleanup();
				resolve();

			};

			timer = setTimeout( () => {

				console.warn( 'VideoRenderManager: Denoise timed out, skipping' );
				cleanup();
				resolve();

			}, DENOISE_TIMEOUT_MS );

			app.addEventListener( EngineEvents.DENOISING_END, onEnd );

			app.denoisingManager.onRenderComplete( {
				isStillComplete: () => ! this._cancelled,
				context: app.pipeline?.context,
			} );

		} );

	}

	/**
	 * Save engine state that we'll modify during video render.
	 * @private
	 */
	_saveState() {

		const app = this._app;

		return {
			maxSamples: app.settings.get( 'maxSamples' ),
			maxBounces: app.settings.get( 'maxBounces' ),
			transmissiveBounces: app.settings.get( 'transmissiveBounces' ),
			renderMode: app.stages.pathTracer?.renderMode?.value,
			controlsEnabled: app.cameraManager.controls?.enabled,
			oidnEnabled: app.denoisingManager?.finalDenoise,
			oidnQuality: app.denoisingManager?.oidnQuality,
			wasPlaying: app.animationManager?.isPlaying,
			pauseRendering: app.pauseRendering,
		};

	}

	/**
	 * Restore saved engine state after video render completes.
	 * @private
	 */
	_restoreState( state ) {

		const app = this._app;

		app.settings.setMany( {
			maxSamples: state.maxSamples,
			maxBounces: state.maxBounces,
			transmissiveBounces: state.transmissiveBounces,
		}, { silent: true } );

		if ( app.stages.pathTracer && state.renderMode !== undefined ) {

			app.stages.pathTracer?.setUniform( 'renderMode', parseInt( state.renderMode ) );

		}

		app.stages.pathTracer?.updateCompletionThreshold?.();

		if ( app.cameraManager.controls ) app.cameraManager.controls.enabled = state.controlsEnabled ?? true;

		if ( app.denoisingManager?.denoiser ) {

			app.denoisingManager.applyOIDNEnabled( state.oidnEnabled ?? false );
			if ( state.oidnQuality ) app.denoisingManager.applyOIDNQuality( state.oidnQuality );

		}

		app.pauseRendering = state.pauseRendering ?? false;

		// Stop animation playback that seekTo may have started
		app.animationManager?.stop();

		// Restart the rAF loop
		app.reset();
		app.wake();

	}

}
