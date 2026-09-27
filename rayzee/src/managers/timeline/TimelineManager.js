import { EventDispatcher, MathUtils, Timer } from 'three';
import { EngineEvents } from '../../EngineEvents.js';
import { CameraTrack } from './CameraTrack.js';

/**
 * The authored animation: keyframed tracks on one time axis, in seconds, of which the camera's
 * ({@link CameraTrack}) is the first. A model's own clips stay with the AnimationManager.
 */
export class TimelineManager extends EventDispatcher {

	/**
	 * @param {Object} deps
	 * @param {import('../CameraManager.js').CameraManager} deps.cameraManager
	 * @param {Function} deps.onReset - restarts accumulation and wakes the frame loop
	 */
	constructor( { cameraManager, onReset } ) {

		super();

		this._cameraManager = cameraManager;
		this._onReset = onReset;

		this.camera = new CameraTrack( cameraManager, () => this._changed( 'camera' ) );

		this._playback = null;
		this._timer = new Timer();
		// A hidden page's time is not played.
		if ( typeof document !== 'undefined' ) this._timer.connect( document );

	}

	/** Seconds to the last key of any track. */
	get duration() {

		return this.camera.duration;

	}

	get animates() {

		return this.camera.animates;

	}

	/**
	 * Puts the scene where the timeline has it at `time`.
	 * @param {number} time - seconds
	 * @returns {boolean} whether anything moved
	 */
	seek( time ) {

		return this.camera.seek( time );

	}

	/**
	 * Runs the timeline in the viewport from the start, with the camera controls locked. Resolves when
	 * it ends or {@link stop} is called; the scene stays where it got to.
	 * @returns {Promise<void>}
	 */
	play() {

		this.stop();
		return new Promise( resolve => {

			const controls = this._cameraManager.controls;
			this._playback = { elapsed: 0, resolve, controlsEnabled: controls.enabled };
			controls.enabled = false;
			this._timer.reset();
			this._changed();
			this._onReset?.();

		} );

	}

	stop() {

		const playback = this._playback;
		if ( ! playback ) return;
		this._playback = null;
		this._cameraManager.controls.enabled = playback.controlsEnabled;
		this._changed();
		playback.resolve();

	}

	get isPlaying() {

		return !! this._playback;

	}

	/** Per frame, before the camera controls update. */
	update() {

		const playback = this._playback;
		if ( ! playback ) return;

		this._timer.update();
		playback.elapsed += this._timer.getDelta();
		const time = MathUtils.clamp( playback.elapsed, 0, this.duration );
		this.seek( time );
		if ( time >= this.duration ) this.stop();

	}

	/** Drops every key: they belonged to the scene being replaced. */
	clear() {

		this.stop();
		this.camera.clear();

	}

	dispose() {

		this.stop();
		this._timer.dispose();
		this.camera.dispose();
		this._cameraManager = this._onReset = null;

	}

	/** @param {string} [track] - whose keys changed; none for playback */
	_changed( track ) {

		this.dispatchEvent( { type: EngineEvents.TIMELINE_CHANGED, track } );

	}

}
