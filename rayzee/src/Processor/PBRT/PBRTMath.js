/**
 * Minimal 4x4 matrix math for the pbrt CTM stack.
 *
 * Matrices are flat 16-element arrays in COLUMN-MAJOR order, identical to
 * THREE.Matrix4.elements (element index = col*4 + row). This lets the scene
 * builder do `new Matrix4().fromArray(ctm)` with no conversion.
 *
 * pbrt's `Transform [16]` directive supplies values that, after pbrt's internal
 * transpose, are exactly column-major — so they map straight onto this layout.
 *
 * Pure JS so the parser stays Three.js-free and unit-testable.
 */

export function identity() {

	return [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

}

/** Determinant of the upper-left 3x3 basis. Negative means the transform mirrors. */
export function determinant3( m ) {

	return m[ 0 ] * ( m[ 5 ] * m[ 10 ] - m[ 6 ] * m[ 9 ] )
		- m[ 4 ] * ( m[ 1 ] * m[ 10 ] - m[ 2 ] * m[ 9 ] )
		+ m[ 8 ] * ( m[ 1 ] * m[ 6 ] - m[ 2 ] * m[ 5 ] );

}

/** Matrix product a*b (applies b first, then a, to a column vector). */
export function multiply( a, b ) {

	const a11 = a[ 0 ], a21 = a[ 1 ], a31 = a[ 2 ], a41 = a[ 3 ];
	const a12 = a[ 4 ], a22 = a[ 5 ], a32 = a[ 6 ], a42 = a[ 7 ];
	const a13 = a[ 8 ], a23 = a[ 9 ], a33 = a[ 10 ], a43 = a[ 11 ];
	const a14 = a[ 12 ], a24 = a[ 13 ], a34 = a[ 14 ], a44 = a[ 15 ];

	const b11 = b[ 0 ], b21 = b[ 1 ], b31 = b[ 2 ], b41 = b[ 3 ];
	const b12 = b[ 4 ], b22 = b[ 5 ], b32 = b[ 6 ], b42 = b[ 7 ];
	const b13 = b[ 8 ], b23 = b[ 9 ], b33 = b[ 10 ], b43 = b[ 11 ];
	const b14 = b[ 12 ], b24 = b[ 13 ], b34 = b[ 14 ], b44 = b[ 15 ];

	return [
		a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41,
		a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41,
		a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41,
		a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41,

		a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42,
		a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42,
		a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42,
		a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42,

		a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43,
		a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43,
		a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43,
		a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43,

		a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44,
		a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44,
		a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44,
		a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44
	];

}

export function translate( x, y, z ) {

	return [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1 ];

}

export function scale( x, y, z ) {

	return [ x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1 ];

}

/** Axis-angle rotation. `angle` is in DEGREES (pbrt convention). */
export function rotate( angle, x, y, z ) {

	const len = Math.hypot( x, y, z ) || 1;
	x /= len; y /= len; z /= len;

	const rad = angle * Math.PI / 180;
	const c = Math.cos( rad ), s = Math.sin( rad ), t = 1 - c;

	const m00 = t * x * x + c, m01 = t * x * y - s * z, m02 = t * x * z + s * y;
	const m10 = t * x * y + s * z, m11 = t * y * y + c, m12 = t * y * z - s * x;
	const m20 = t * x * z - s * y, m21 = t * y * z + s * x, m22 = t * z * z + c;

	return [
		m00, m10, m20, 0,
		m01, m11, m21, 0,
		m02, m12, m22, 0,
		0, 0, 0, 1
	];

}

function sub( a, b ) {

	return [ a[ 0 ] - b[ 0 ], a[ 1 ] - b[ 1 ], a[ 2 ] - b[ 2 ] ];

}

function cross( a, b ) {

	return [
		a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ],
		a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ],
		a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ]
	];

}

function normalize( a ) {

	const len = Math.hypot( a[ 0 ], a[ 1 ], a[ 2 ] ) || 1;
	return [ a[ 0 ] / len, a[ 1 ] / len, a[ 2 ] / len ];

}

/**
 * Builds the camera-to-world matrix from a pbrt LookAt (eye, look, up).
 * pbrt uses a left-handed camera basis: +z is the viewing direction.
 * Columns: [ right, newUp, dir, eye ].
 */
export function lookAtCameraToWorld( eye, look, up ) {

	const dir = normalize( sub( look, eye ) );
	const right = normalize( cross( normalize( up ), dir ) );
	const newUp = cross( dir, right );

	return [
		right[ 0 ], right[ 1 ], right[ 2 ], 0,
		newUp[ 0 ], newUp[ 1 ], newUp[ 2 ], 0,
		dir[ 0 ], dir[ 1 ], dir[ 2 ], 0,
		eye[ 0 ], eye[ 1 ], eye[ 2 ], 1
	];

}

/** General 4x4 inverse (column-major in/out). Returns identity if singular. */
export function invert( m ) {

	const n11 = m[ 0 ], n21 = m[ 1 ], n31 = m[ 2 ], n41 = m[ 3 ];
	const n12 = m[ 4 ], n22 = m[ 5 ], n32 = m[ 6 ], n42 = m[ 7 ];
	const n13 = m[ 8 ], n23 = m[ 9 ], n33 = m[ 10 ], n43 = m[ 11 ];
	const n14 = m[ 12 ], n24 = m[ 13 ], n34 = m[ 14 ], n44 = m[ 15 ];

	const t11 = n23 * n34 * n42 - n24 * n33 * n42 + n24 * n32 * n43 - n22 * n34 * n43 - n23 * n32 * n44 + n22 * n33 * n44;
	const t12 = n14 * n33 * n42 - n13 * n34 * n42 - n14 * n32 * n43 + n12 * n34 * n43 + n13 * n32 * n44 - n12 * n33 * n44;
	const t13 = n13 * n24 * n42 - n14 * n23 * n42 + n14 * n22 * n43 - n12 * n24 * n43 - n13 * n22 * n44 + n12 * n23 * n44;
	const t14 = n14 * n23 * n32 - n13 * n24 * n32 - n14 * n22 * n33 + n12 * n24 * n33 + n13 * n22 * n34 - n12 * n23 * n34;

	const det = n11 * t11 + n21 * t12 + n31 * t13 + n41 * t14;
	if ( det === 0 ) return identity();
	const idet = 1 / det;

	return [
		t11 * idet,
		( n24 * n33 * n41 - n23 * n34 * n41 - n24 * n31 * n43 + n21 * n34 * n43 + n23 * n31 * n44 - n21 * n33 * n44 ) * idet,
		( n22 * n34 * n41 - n24 * n32 * n41 + n24 * n31 * n42 - n21 * n34 * n42 - n22 * n31 * n44 + n21 * n32 * n44 ) * idet,
		( n23 * n32 * n41 - n22 * n33 * n41 - n23 * n31 * n42 + n21 * n33 * n42 + n22 * n31 * n43 - n21 * n32 * n43 ) * idet,

		t12 * idet,
		( n13 * n34 * n41 - n14 * n33 * n41 + n14 * n31 * n43 - n11 * n34 * n43 - n13 * n31 * n44 + n11 * n33 * n44 ) * idet,
		( n14 * n32 * n41 - n12 * n34 * n41 - n14 * n31 * n42 + n11 * n34 * n42 + n12 * n31 * n44 - n11 * n32 * n44 ) * idet,
		( n12 * n33 * n41 - n13 * n32 * n41 + n13 * n31 * n42 - n11 * n33 * n42 - n12 * n31 * n43 + n11 * n32 * n43 ) * idet,

		t13 * idet,
		( n14 * n23 * n41 - n13 * n24 * n41 - n14 * n21 * n43 + n11 * n24 * n43 + n13 * n21 * n44 - n11 * n23 * n44 ) * idet,
		( n12 * n24 * n41 - n14 * n22 * n41 + n14 * n21 * n42 - n11 * n24 * n42 - n12 * n21 * n44 + n11 * n22 * n44 ) * idet,
		( n13 * n22 * n41 - n12 * n23 * n41 - n13 * n21 * n42 + n11 * n23 * n42 + n12 * n21 * n43 - n11 * n22 * n43 ) * idet,

		t14 * idet,
		( n13 * n24 * n31 - n14 * n23 * n31 + n14 * n21 * n33 - n11 * n24 * n33 - n13 * n21 * n34 + n11 * n23 * n34 ) * idet,
		( n14 * n22 * n31 - n12 * n24 * n31 - n14 * n21 * n32 + n11 * n24 * n32 + n12 * n21 * n34 - n11 * n22 * n34 ) * idet,
		( n12 * n23 * n31 - n13 * n22 * n31 + n13 * n21 * n32 - n11 * n23 * n32 - n12 * n21 * n33 + n11 * n22 * n33 ) * idet
	];

}
