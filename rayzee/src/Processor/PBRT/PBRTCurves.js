/**
 * Tessellation for pbrt-v4's `Shape "curve"`.
 *
 * pbrt intersects curves analytically as swept cubic splines. The engine only traces
 * triangles, so each curve becomes a strip: one ribbon for `flat`/`ribbon`, a crossed
 * pair for `cylinder` (view-independent and a quarter the cost of a real tube), or a
 * closed tube when asked for one.
 *
 * Cost is the whole story here — Moana's isMountainB ground cover alone declares 5.18
 * million curve shapes, so `steps` and `sides` are the knobs that decide whether a
 * scene is 20 million triangles or 200 million.
 */

const DEFAULT_STEPS = 2;

/** Uniform cubic B-spline basis at t for the four control points of one span. */
function bsplineWeights( t, out ) {

	const t2 = t * t;
	const t3 = t2 * t;
	out[ 0 ] = ( 1 - 3 * t + 3 * t2 - t3 ) / 6;
	out[ 1 ] = ( 4 - 6 * t2 + 3 * t3 ) / 6;
	out[ 2 ] = ( 1 + 3 * t + 3 * t2 - 3 * t3 ) / 6;
	out[ 3 ] = t3 / 6;

}

/** Cubic Bezier basis at t. */
function bezierWeights( t, out ) {

	const u = 1 - t;
	out[ 0 ] = u * u * u;
	out[ 1 ] = 3 * u * u * t;
	out[ 2 ] = 3 * u * t * t;
	out[ 3 ] = t * t * t;

}

function normalize( v ) {

	const l = Math.hypot( v[ 0 ], v[ 1 ], v[ 2 ] );
	if ( l > 0 ) {

		v[ 0 ] /= l; v[ 1 ] /= l; v[ 2 ] /= l;

	}

	return v;

}

function cross( a, b, out ) {

	out[ 0 ] = a[ 1 ] * b[ 2 ] - a[ 2 ] * b[ 1 ];
	out[ 1 ] = a[ 2 ] * b[ 0 ] - a[ 0 ] * b[ 2 ];
	out[ 2 ] = a[ 0 ] * b[ 1 ] - a[ 1 ] * b[ 0 ];
	return out;

}

/**
 * Sample a curve's centreline.
 * @returns {{points: Float64Array, count: number}} count points, 3 floats each
 */
function sampleCenterline( P, basis, steps ) {

	const cps = P.length / 3;
	// bspline: every window of 4 control points is one span. bezier: 4 points per span,
	// sharing an endpoint between consecutive spans.
	const spans = basis === 'bspline' ? cps - 3 : Math.max( 1, ( cps - 1 ) / 3 );
	if ( spans < 1 ) return null;

	const total = Math.max( 1, Math.round( steps * spans ) );
	const points = new Float64Array( ( total + 1 ) * 3 );
	const w = [ 0, 0, 0, 0 ];

	for ( let i = 0; i <= total; i ++ ) {

		const u = ( i / total ) * spans;
		let span = Math.floor( u );
		if ( span >= spans ) span = spans - 1;
		const t = u - span;

		if ( basis === 'bspline' ) bsplineWeights( t, w );
		else bezierWeights( t, w );

		const base = basis === 'bspline' ? span : span * 3;
		let x = 0, y = 0, z = 0;
		for ( let k = 0; k < 4; k ++ ) {

			const o = ( base + k ) * 3;
			x += w[ k ] * P[ o ];
			y += w[ k ] * P[ o + 1 ];
			z += w[ k ] * P[ o + 2 ];

		}

		points[ i * 3 ] = x; points[ i * 3 + 1 ] = y; points[ i * 3 + 2 ] = z;

	}

	return { points, count: total + 1 };

}

/**
 * @param {object} spec
 * @param {ArrayLike<number>} spec.P - control points, 3 floats each
 * @param {string} [spec.basis='bezier'] - 'bezier' | 'bspline'
 * @param {number} [spec.width0=1]
 * @param {number} [spec.width1=1]
 * @param {ArrayLike<number>} [spec.N] - ribbon normals (start, end), 3 floats each
 * @param {number} [spec.steps] - samples per spline span
 * @param {number} [spec.sides=1] - 1 ribbon, 2 crossed ribbons, >=3 closed tube
 * @returns {{positions: Float32Array, indices: Uint32Array}|null}
 */
export function tessellateCurve( spec ) {

	const { P, basis = 'bezier', width0 = 1, width1 = 1, N = null } = spec;
	const steps = Math.max( 1, Math.round( spec.steps ?? DEFAULT_STEPS ) );
	const sides = Math.max( 1, Math.round( spec.sides ?? 1 ) );

	if ( ! P || P.length < 12 ) return null;

	const line = sampleCenterline( P, basis, steps );
	if ( ! line ) return null;

	const { points, count } = line;
	const rings = sides >= 3 ? sides : sides * 2;
	const positions = new Float32Array( count * rings * 3 );

	const tangent = [ 0, 0, 0 ];
	const side = [ 0, 0, 0 ];
	const up = [ 0, 0, 0 ];
	const tmp = [ 0, 0, 0 ];
	let haveSide = false;

	for ( let i = 0; i < count; i ++ ) {

		const a = Math.max( 0, i - 1 ), b = Math.min( count - 1, i + 1 );
		tangent[ 0 ] = points[ b * 3 ] - points[ a * 3 ];
		tangent[ 1 ] = points[ b * 3 + 1 ] - points[ a * 3 + 1 ];
		tangent[ 2 ] = points[ b * 3 + 2 ] - points[ a * 3 + 2 ];
		normalize( tangent );

		if ( ! haveSide ) {

			// Seed from the ribbon normal when the scene gives one, else from whichever
			// axis the tangent leans on least.
			if ( N && N.length >= 3 ) {

				side[ 0 ] = N[ 0 ]; side[ 1 ] = N[ 1 ]; side[ 2 ] = N[ 2 ];
				cross( tangent, side, tmp );
				side[ 0 ] = tmp[ 0 ]; side[ 1 ] = tmp[ 1 ]; side[ 2 ] = tmp[ 2 ];

			} else {

				const ax = Math.abs( tangent[ 0 ] ), ay = Math.abs( tangent[ 1 ] ), az = Math.abs( tangent[ 2 ] );
				const ref = ax < ay && ax < az ? [ 1, 0, 0 ] : ay < az ? [ 0, 1, 0 ] : [ 0, 0, 1 ];
				cross( tangent, ref, side );

			}

			if ( Math.hypot( side[ 0 ], side[ 1 ], side[ 2 ] ) < 1e-9 ) cross( tangent, [ 0, 1, 0 ], side );
			normalize( side );
			haveSide = true;

		} else {

			// Rotation-minimising: drop the previous side back onto the new normal plane,
			// so a coiled curve does not twist its ribbon.
			const d = side[ 0 ] * tangent[ 0 ] + side[ 1 ] * tangent[ 1 ] + side[ 2 ] * tangent[ 2 ];
			side[ 0 ] -= d * tangent[ 0 ];
			side[ 1 ] -= d * tangent[ 1 ];
			side[ 2 ] -= d * tangent[ 2 ];
			if ( Math.hypot( side[ 0 ], side[ 1 ], side[ 2 ] ) < 1e-9 ) cross( tangent, [ 0, 1, 0 ], side );
			normalize( side );

		}

		cross( tangent, side, up );
		normalize( up );

		const u = i / ( count - 1 || 1 );
		const radius = ( width0 + ( width1 - width0 ) * u ) * 0.5;
		const cx = points[ i * 3 ], cy = points[ i * 3 + 1 ], cz = points[ i * 3 + 2 ];

		for ( let r = 0; r < rings; r ++ ) {

			let dx, dy, dz;
			if ( sides >= 3 ) {

				const a2 = ( r / sides ) * Math.PI * 2;
				const c = Math.cos( a2 ), s = Math.sin( a2 );
				dx = side[ 0 ] * c + up[ 0 ] * s;
				dy = side[ 1 ] * c + up[ 1 ] * s;
				dz = side[ 2 ] * c + up[ 2 ] * s;

			} else {

				// Ribbon r spans -1..+1 along its own axis: `side` first, `up` for the cross.
				const axis = r < 2 ? side : up;
				const sign = r % 2 === 0 ? - 1 : 1;
				dx = axis[ 0 ] * sign; dy = axis[ 1 ] * sign; dz = axis[ 2 ] * sign;

			}

			const o = ( i * rings + r ) * 3;
			positions[ o ] = cx + dx * radius;
			positions[ o + 1 ] = cy + dy * radius;
			positions[ o + 2 ] = cz + dz * radius;

		}

	}

	const quads = sides >= 3 ? sides : sides;
	const indices = new Uint32Array( ( count - 1 ) * quads * 6 );
	let w = 0;

	for ( let i = 0; i < count - 1; i ++ ) {

		for ( let q = 0; q < quads; q ++ ) {

			const r0 = sides >= 3 ? q : q * 2;
			const r1 = sides >= 3 ? ( q + 1 ) % sides : q * 2 + 1;
			const a = i * rings + r0, b = i * rings + r1;
			const c = ( i + 1 ) * rings + r1, d = ( i + 1 ) * rings + r0;
			indices[ w ++ ] = a; indices[ w ++ ] = b; indices[ w ++ ] = c;
			indices[ w ++ ] = a; indices[ w ++ ] = c; indices[ w ++ ] = d;

		}

	}

	return { positions, indices: w === indices.length ? indices : indices.slice( 0, w ) };

}

/** Triangles `tessellateCurve` would produce, without building anything. */
export function curveTriangleCount( controlPoints, basis, steps, sides ) {

	const cps = controlPoints / 3;
	const spans = basis === 'bspline' ? cps - 3 : Math.max( 1, ( cps - 1 ) / 3 );
	if ( spans < 1 ) return 0;
	const segments = Math.max( 1, Math.round( Math.max( 1, steps ) * spans ) );
	return segments * Math.max( 1, Math.round( sides ) ) * 2;

}
