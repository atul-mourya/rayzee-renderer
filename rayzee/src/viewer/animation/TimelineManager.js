import { EventDispatcher, MathUtils, Timer } from 'three';
import { EngineEvents } from '../../EngineEvents.js';
import { CameraTrack } from './CameraTrack.js';

/**
 * The authored animation: keyframed tracks on one time axis, in seconds, of which the camera's
 * ({@link CameraTrack}) is the first, and the scene's frame sequences (a VDB volume's) played on it
 * from 0. A model's own clips stay with the AnimationManager.
 */
export class TimelineManager extends EventDispatcher {

	/**
	 * @param {Object} deps
	 * @param {import('../camera/CameraManager.js').CameraManager} deps.cameraManager
	 * @param {Function} deps.onReset - restarts accumulation and wakes the frame loop
	 * @param {function(): Array<import('../../loaders/FrameSequence.js').FrameSequence>} [deps.sequences] - the scene's
	 * @param {function(number): Promise<boolean>} [deps.seekSequences] - puts them on a time, resolving once shown
	 */
	constructor( { cameraManager, onReset, sequences = () => [], seekSequences = async () => false } ) {

		super();

		this._cameraManager = cameraManager;
		this._onReset = onReset;
		this._sequences = sequences;
		this._seekSequences = seekSequences;
		this._settling = Promise.resolve( false );

		this.camera = new CameraTrack( cameraManager, () => this._changed( 'camera' ) );

		this._playback = null;
		this._timer = new Timer();
		// A hidden page's time is not played.
		if ( typeof document !== 'undefined' ) this._timer.connect( document );

	}

	/** The scene's frame sequences, played from time 0. */
	get sequences() {

		return this._sequences();

	}

	/** Seconds to the last key of any track, or the end of the longest sequence. */
	get duration() {

		return Math.max( this.camera.duration, ...this.sequences.map( s => s.duration ) );

	}

	get animates() {

		return this.camera.animates || this.sequences.some( s => s.frameCount > 1 );

	}

	/**
	 * Puts the scene where the timeline has it at `time`. A sequence's frame may still be decoding: {@link settled}
	 * resolves once it shows.
	 * @param {number} time - seconds
	 * @returns {boolean} whether the camera moved
	 */
	seek( time ) {

		this._settling = this._seekSequences( time );
		return this.camera.seek( time );

	}

	/** Resolves once the frames the last seek asked for show: whether any changed. */
	settled() {

		return this._settling;

	}

	/** Frames a second of a sequence (all of them by default). */
	setFrameRate( fps, sequence = null ) {

		for ( const s of sequence ? [ sequence ] : this.sequences ) s.fps = fps;
		this._changed( 'sequences' );

	}

	/** After the scene's sequences come or go. */
	sequencesChanged() {

		this._changed( 'sequences' );

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
			// Locked only while the camera moves: a sequence alone leaves the view free.
			if ( this.camera.animates ) controls.enabled = false;
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

	/** Every track's keys as plain data, for a saved session. */
	serialize() {

		return { camera: this.camera.serialize() };

	}

	restore( state ) {

		this.stop();
		this.camera.restore( state?.camera );

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
		this._sequences = () => [];
		this._seekSequences = async () => false;

	}

	/** @param {string} [track] - whose keys changed; none for playback */
	_changed( track ) {

		this.dispatchEvent( { type: EngineEvents.TIMELINE_CHANGED, track } );

	}

}
