import { OrthographicCamera, PerspectiveCamera } from 'three';

/**
 * The view's camera: a perspective camera that can also project orthographically.
 *
 * It switches in place, so everything holding it (the controls, picking, the gizmo, the overlays
 * and the path tracer) follows. three.js reads the camera's type from the two flags below, and an
 * orthographic camera's frustum from `top`, `bottom`, `left` and `right`.
 */
export class ViewCamera extends PerspectiveCamera {

	constructor( fov, aspect, near, far ) {

		super( fov, aspect, near, far );

		this.orthographic = false;
		/** Half the view's height in world units while orthographic, before `zoom`. */
		this.orthoHalfHeight = 1;

	}

	get isPerspectiveCamera() {

		return ! this.orthographic;

	}

	// PerspectiveCamera's constructor assigns the flag.
	set isPerspectiveCamera( value ) {}

	get isOrthographicCamera() {

		return this.orthographic;

	}

	get top() {

		return this.orthoHalfHeight;

	}

	get bottom() {

		return - this.orthoHalfHeight;

	}

	get right() {

		return this.orthoHalfHeight * this.aspect;

	}

	get left() {

		return - this.orthoHalfHeight * this.aspect;

	}

	updateProjectionMatrix() {

		if ( this.orthographic ) OrthographicCamera.prototype.updateProjectionMatrix.call( this );
		else super.updateProjectionMatrix();

	}

	copy( source, recursive ) {

		super.copy( source, recursive );
		this.orthographic = source.orthographic === true;
		this.orthoHalfHeight = source.orthoHalfHeight ?? this.orthoHalfHeight;
		return this;

	}

}
