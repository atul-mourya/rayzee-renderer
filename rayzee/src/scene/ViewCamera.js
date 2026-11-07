import { OrthographicCamera, PerspectiveCamera, Quaternion, Vector3 } from 'three';

const _position = new Vector3();
const _quaternion = new Quaternion();
const _scale = new Vector3();

/**
 * The inverse of the matrix rays are traced from, its mirror kept: three drops scale from `matrixWorldInverse`.
 * @param {import('three').Camera} camera
 * @param {import('three').Matrix4} target
 * @returns {import('three').Matrix4} target
 */
export function viewMatrixOf( camera, target ) {

	if ( mirrorSign( camera ) > 0 ) return target.copy( camera.matrixWorldInverse );
	camera.matrixWorld.decompose( _position, _quaternion, _scale );
	return target.compose( _position, _quaternion, _scale.set( Math.sign( _scale.x ), Math.sign( _scale.y ), Math.sign( _scale.z ) ) ).invert();

}

/**
 * The inverse projection camera rays are traced through, its w at the far plane kept positive: 1 / far rounds to 0 or
 * below in f32 for a far plane ~1e7 × near or more, and a ray needs only w's sign. Any other camera's is its own.
 * @param {import('three').Camera} camera
 * @param {import('three').Matrix4} target
 * @returns {import('three').Matrix4} target
 */
export function projectionInverseOf( camera, target ) {

	const e = target.copy( camera.projectionMatrixInverse ).elements;
	if ( e[ 15 ] > 0 && Math.fround( Math.fround( e[ 11 ] ) + Math.fround( e[ 15 ] ) ) <= 0 ) e[ 11 ] = - e[ 15 ] * ( 1 - 2 ** - 20 );
	return target;

}

/**
 * −1 when the camera mirrors its picture left to right (a pbrt `LookAt` camera), else 1.
 * @param {import('three').Camera} camera
 * @returns {number}
 */
export function mirrorSign( camera ) {

	return camera.matrixWorld.determinant() < 0 ? - 1 : 1;

}

/**
 * The view's camera: a perspective camera that can also project orthographically.
 *
 * It switches in place, so everything holding it (the controls, picking, the gizmo, the overlays
 * and the path tracer) follows. three.js reads the camera's type from the two flags below, and an
 * orthographic camera's frustum from `top`, `bottom`, `left` and `right`.
 */
export class ViewCamera extends PerspectiveCamera {

	constructor( fov, aspect, near, far ) {

		// Square until the canvas has an area: a side of 0 made the aspect 0 or Infinity, and the projection NaN.
		super( fov, aspect > 0 && Number.isFinite( aspect ) ? aspect : 1, near, far );

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
