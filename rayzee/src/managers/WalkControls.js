import { Controls, MathUtils, Quaternion, Vector3 } from 'three';

const CROSSING_SECONDS = 8;
const FAST = 4;
const SLOW = 0.25;
const MAX_PITCH = MathUtils.degToRad( 89 );
const MAX_STEP_SECONDS = 0.25;

// Right, forward, up.
const KEY_DIRECTIONS = {
	KeyD: [ 1, 0, 0 ], ArrowRight: [ 1, 0, 0 ],
	KeyA: [ - 1, 0, 0 ], ArrowLeft: [ - 1, 0, 0 ],
	KeyW: [ 0, 1, 0 ], ArrowUp: [ 0, 1, 0 ],
	KeyS: [ 0, - 1, 0 ], ArrowDown: [ 0, - 1, 0 ],
	KeyE: [ 0, 0, 1 ],
	KeyQ: [ 0, 0, - 1 ],
};

// Focus that types, or opens a list, keeps its keys. A widget that handled a key prevents its default.
const TYPES_KEYS = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), '
	+ '[role=textbox], [role=combobox], [role=listbox], [role=menu], [role=menuitem]';

const speedFactor = event => event.shiftKey ? FAST : event.altKey ? SLOW : 1;

const _changeEvent = { type: 'change' };
const _startEvent = { type: 'start' };
const _forward = new Vector3();
const _right = new Vector3();
const _move = new Vector3();
const _axis = new Vector3();
const _q = new Quaternion();

/**
 * First-person navigation: drag to look, W A S D or the arrows to walk level, E and Q to rise
 * and sink, Shift faster, Alt slower.
 *
 * Rides on the orbit controls: moves only while they are enabled, and keeps their target ahead
 * of the camera, since they re-aim the camera at it every frame.
 */
export class WalkControls extends Controls {

	/**
	 * @param {import('three').PerspectiveCamera} camera
	 * @param {HTMLElement} domElement
	 * @param {import('three/addons/controls/OrbitControls.js').OrbitControls} orbit
	 */
	constructor( camera, domElement, orbit ) {

		super( camera, domElement );

		this.orbit = orbit;
		this.enabled = false;
		/** Scene units per second. */
		this.speed = 1 / CROSSING_SECONDS;

		this._held = new Set();
		this._factor = 1;
		this._lastTime = 0;
		this._drag = null;

		this._onKeyDown = this._onKeyDown.bind( this );
		this._onKeyUp = this._onKeyUp.bind( this );
		this.release = this.release.bind( this );
		this._onPointerDown = this._onPointerDown.bind( this );
		this._onPointerMove = this._onPointerMove.bind( this );
		this._onPointerUp = this._onPointerUp.bind( this );

		if ( domElement ) this.connect( domElement );

	}

	get active() {

		return this.enabled && this.orbit.enabled;

	}

	/** Cross a scene this long in about eight seconds. */
	fitSpeed( sceneSize ) {

		this.speed = ( sceneSize > 0 ? sceneSize : 1 ) / CROSSING_SECONDS;

	}

	connect( element ) {

		super.connect( element );
		const doc = element.ownerDocument;
		doc?.addEventListener( 'keydown', this._onKeyDown );
		doc?.addEventListener( 'keyup', this._onKeyUp );
		doc?.addEventListener( 'visibilitychange', this.release );
		doc?.defaultView?.addEventListener( 'blur', this.release );
		element.addEventListener( 'pointerdown', this._onPointerDown );
		element.addEventListener( 'pointermove', this._onPointerMove );
		element.addEventListener( 'pointerup', this._onPointerUp );
		element.addEventListener( 'pointercancel', this._onPointerUp );

	}

	disconnect() {

		const element = this.domElement;
		if ( ! element ) return;
		const doc = element.ownerDocument;
		doc?.removeEventListener( 'keydown', this._onKeyDown );
		doc?.removeEventListener( 'keyup', this._onKeyUp );
		doc?.removeEventListener( 'visibilitychange', this.release );
		doc?.defaultView?.removeEventListener( 'blur', this.release );
		element.removeEventListener( 'pointerdown', this._onPointerDown );
		element.removeEventListener( 'pointermove', this._onPointerMove );
		element.removeEventListener( 'pointerup', this._onPointerUp );
		element.removeEventListener( 'pointercancel', this._onPointerUp );

	}

	dispose() {

		this.disconnect();

	}

	update( delta = this._elapsed() ) {

		if ( ! this._held.size || ! this.active ) return false;

		let right = 0, forward = 0, up = 0;
		for ( const code of this._held ) {

			const [ r, f, u ] = KEY_DIRECTIONS[ code ];
			right += r;
			forward += f;
			up += u;

		}

		if ( ! right && ! forward && ! up ) return false;

		const camera = this.object;
		// Level axes from the camera's right, which stays level however far it looks down.
		_right.set( 1, 0, 0 ).applyQuaternion( camera.quaternion );
		_forward.crossVectors( camera.up, _right ).normalize();
		_right.crossVectors( _forward, camera.up );

		_move.set( 0, 0, 0 )
			.addScaledVector( _right, right )
			.addScaledVector( _forward, forward )
			.addScaledVector( camera.up, up )
			.normalize()
			.multiplyScalar( this.speed * this._factor * delta );
		camera.position.add( _move );
		this.orbit.target.add( _move );
		camera.updateMatrixWorld();

		this.dispatchEvent( _changeEvent );
		return true;

	}

	_elapsed() {

		const now = performance.now();
		const delta = Math.min( ( now - this._lastTime ) / 1000, MAX_STEP_SECONDS );
		this._lastTime = now;
		return delta;

	}

	/** Turn by a drag of dx, dy pixels, so the scene follows the pointer. */
	_look( dx, dy ) {

		const camera = this.object;
		const target = this.orbit.target;
		const distance = camera.position.distanceTo( target ) || 1;
		const radiansPerPixel = MathUtils.degToRad( camera.fov ) / ( this.domElement.clientHeight || 1 );

		camera.quaternion.premultiply( _q.setFromAxisAngle( camera.up, dx * radiansPerPixel ) );

		camera.getWorldDirection( _forward );
		const pitch = Math.asin( MathUtils.clamp( _forward.dot( camera.up ), - 1, 1 ) );
		const nextPitch = MathUtils.clamp( pitch + dy * radiansPerPixel, - MAX_PITCH, MAX_PITCH );
		camera.quaternion.multiply( _q.setFromAxisAngle( _axis.set( 1, 0, 0 ), nextPitch - pitch ) );
		camera.updateMatrixWorld();

		target.copy( camera.position ).addScaledVector( camera.getWorldDirection( _forward ), distance );
		this.dispatchEvent( _changeEvent );

	}

	_onKeyDown( event ) {

		if ( ! this.active || event.defaultPrevented || event.target?.closest?.( TYPES_KEYS ) ) return;

		// Browser shortcuts pass through, and macOS drops the key-up of a key pressed while Cmd is down.
		if ( event.metaKey || event.ctrlKey ) {

			this.release();
			return;

		}

		this._factor = speedFactor( event );
		if ( ! KEY_DIRECTIONS[ event.code ] ) return;

		event.preventDefault();
		if ( this._held.has( event.code ) ) return;
		this._held.add( event.code );

		// After the key is held: a woken loop runs its first frame inside this dispatch.
		if ( this._held.size === 1 ) {

			this._lastTime = performance.now();
			this.dispatchEvent( _startEvent );

		}

	}

	_onKeyUp( event ) {

		this._factor = speedFactor( event );
		this._held.delete( event.code );

	}

	/** Let go of every held key. */
	release() {

		this._held.clear();
		this._factor = 1;

	}

	_onPointerDown( event ) {

		if ( ! this.active || event.button !== 0 || ! event.isPrimary ) return;
		this._drag = { id: event.pointerId, x: event.clientX, y: event.clientY };
		this.domElement.setPointerCapture?.( event.pointerId );

	}

	_onPointerMove( event ) {

		const drag = this._drag;
		if ( ! drag || event.pointerId !== drag.id ) return;

		const dx = event.clientX - drag.x;
		const dy = event.clientY - drag.y;
		drag.x = event.clientX;
		drag.y = event.clientY;
		if ( this.active && ( dx || dy ) ) this._look( dx, dy );

	}

	_onPointerUp( event ) {

		if ( this._drag?.id !== event.pointerId ) return;
		this._drag = null;
		this.domElement.releasePointerCapture?.( event.pointerId );

	}

}
