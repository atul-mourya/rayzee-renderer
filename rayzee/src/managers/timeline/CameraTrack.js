import { InterpolateSmooth, MathUtils, NumberKeyframeTrack, Vector3, VectorKeyframeTrack } from 'three';

/**
 * @typedef {Object} CameraPose
 * @property {Vector3} position
 * @property {Vector3} target - what the camera looks at
 * @property {number} fov - vertical, degrees
 * @property {number} orthoHeight - the view's height while orthographic, world units
 */

/** @typedef {CameraPose & { id: number, time: number }} CameraKey */

// Keys closer than this in time are spread to it: an interval of zero divides by zero.
const MIN_KEY_GAP = 1e-3;
// Where a new key lands after the last one.
const KEY_SPACING_SECONDS = 2;

const smooth = ( Track, name, times, values ) => new Track( name, times, values, InterpolateSmooth ).createInterpolant();

/**
 * The camera's keyframes: each a view at a time, in seconds. Between keys the camera glides along a
 * curve through their positions while looking along one through their targets; outside them it holds.
 * The orthographic height blends in log space, so a zoom reads as steady.
 */
export class CameraTrack {

	/**
	 * @param {import('../CameraManager.js').CameraManager} cameraManager - where views come from and go
	 * @param {Function} [onChange] - after keys are added, moved, changed or removed
	 */
	constructor( cameraManager, onChange ) {

		this._cameraManager = cameraManager;
		this._onChange = onChange;

		/** @type {CameraKey[]} sorted by time */
		this.keys = [];
		this._nextId = 1;
		this._interpolants = null;

	}

	/** Two keys or more: one is only a still view. */
	get animates() {

		return this.keys.length > 1;

	}

	/** Seconds from 0 to the last key. */
	get duration() {

		return this.keys.length ? this.keys[ this.keys.length - 1 ].time : 0;

	}

	/**
	 * Keys the current view, KEY_SPACING_SECONDS after the last key unless given a time.
	 * @param {number} [time]
	 * @returns {CameraKey}
	 */
	addKey( time = this.keys.length ? this.duration + KEY_SPACING_SECONDS : 0 ) {

		return this.add( this._cameraManager.captureView(), time );

	}

	/** Gives a key the current view, at the same time. */
	updateKey( id ) {

		this.update( id, this._cameraManager.captureView() );

	}

	/**
	 * Puts the camera where the track has it at `time`.
	 * @returns {boolean} whether there was a key to go to
	 */
	seek( time ) {

		const pose = this.sample( time );
		if ( pose ) this._cameraManager.applyPose( pose );
		return !! pose;

	}

	/**
	 * @param {CameraPose} pose - copied
	 * @param {number} time
	 * @returns {CameraKey}
	 */
	add( pose, time ) {

		const key = { id: this._nextId ++, time, ...copyPose( pose ) };
		this.keys.push( key );
		this._changed();
		return key;

	}

	/** Gives the key a new pose, at the same time. */
	update( id, pose ) {

		const key = this.get( id );
		if ( ! key ) return;
		Object.assign( key, copyPose( pose ) );
		this._changed();

	}

	setTime( id, time ) {

		const key = this.get( id );
		if ( ! key || ! ( time >= 0 ) ) return;
		key.time = time;
		this._changed();

	}

	remove( id ) {

		const count = this.keys.length;
		this.keys = this.keys.filter( key => key.id !== id );
		if ( this.keys.length !== count ) this._changed();

	}

	clear() {

		if ( ! this.keys.length ) return;
		this.keys = [];
		this._changed();

	}

	dispose() {

		this._cameraManager = this._onChange = null;

	}

	get( id ) {

		return this.keys.find( key => key.id === id );

	}

	/**
	 * The pose at `time`, in seconds; null without keys.
	 * @param {number} time
	 * @param {CameraPose} [out]
	 * @returns {?CameraPose}
	 */
	sample( time, out = { position: new Vector3(), target: new Vector3(), fov: 0, orthoHeight: 0 } ) {

		if ( ! this.keys.length ) return null;

		const { position, target, fov, logHeight, start, end } = this._interpolants ??= this._build();
		const at = MathUtils.clamp( time, start, end );
		out.position.fromArray( position.evaluate( at ) );
		out.target.fromArray( target.evaluate( at ) );
		out.fov = fov.evaluate( at )[ 0 ];
		out.orthoHeight = Math.exp( logHeight.evaluate( at )[ 0 ] );
		return out;

	}

	_build() {

		const times = [];
		for ( const key of this.keys ) times.push( times.length ? Math.max( key.time, times[ times.length - 1 ] + MIN_KEY_GAP ) : key.time );
		const start = times[ 0 ];
		const end = times[ times.length - 1 ];

		// Each end gets a key mirrored past it, so the curve leaves the first key and reaches the last at
		// rest. three's ZeroSlopeEnding would flatten only the start.
		let keys = this.keys;
		if ( keys.length > 1 ) {

			const n = keys.length;
			times.unshift( 2 * start - times[ 1 ] );
			times.push( 2 * end - times[ n - 1 ] );
			keys = [ keys[ 1 ], ...keys, keys[ n - 2 ] ];

		}

		const vectors = pick => keys.flatMap( key => pick( key ).toArray() );
		return {
			start,
			end,
			position: smooth( VectorKeyframeTrack, '.position', times, vectors( key => key.position ) ),
			target: smooth( VectorKeyframeTrack, '.target', times, vectors( key => key.target ) ),
			fov: smooth( NumberKeyframeTrack, '.fov', times, keys.map( key => key.fov ) ),
			logHeight: smooth( NumberKeyframeTrack, '.orthoHeight', times, keys.map( key => Math.log( key.orthoHeight ) ) ),
		};

	}

	_changed() {

		this.keys.sort( ( a, b ) => a.time - b.time );
		this._interpolants = null;
		this._onChange?.();

	}

}

function copyPose( { position, target, fov, orthoHeight } ) {

	return { position: position.clone(), target: target.clone(), fov, orthoHeight };

}
