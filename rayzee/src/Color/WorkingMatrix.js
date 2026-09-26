/**
 * The primaries change from the engine's native linear Rec.709 into the adopted working space.
 *
 * A leaf module with no imports at all, deliberately. The two hottest consumers — the material
 * buffer and the light serializer — sit far from colour management and are exercised by tests that
 * mock three.js; pulling `ColorManagement` into them would drag the whole OCIO stack, and three.js
 * with it, into places that have no business knowing either exists.
 *
 * Null means "not colour-managed", which is also the identity, so every consumer's fast path is a
 * single null check.
 */

let matrix = null;
let spaceName = null;

/**
 * @param {?number[]} m - row-major 3×3, or null for no conversion
 * @param {?string} [name] - the working space it converts into, for logging
 */
export function setWorkingMatrix( m, name = null ) {

	matrix = m;
	spaceName = m ? name : null;

}

export function getWorkingMatrix() {

	return matrix;

}

export function getWorkingMatrixSpace() {

	return spaceName;

}

/**
 * Convert one linear RGB triple in place.
 * @param {Float32Array|number[]} rgb - read and written at [0..2]
 * @returns {boolean} whether anything changed
 */
export function convertLinearTriple( rgb ) {

	if ( ! matrix ) return false;

	const r = rgb[ 0 ], g = rgb[ 1 ], b = rgb[ 2 ];
	rgb[ 0 ] = matrix[ 0 ] * r + matrix[ 1 ] * g + matrix[ 2 ] * b;
	rgb[ 1 ] = matrix[ 3 ] * r + matrix[ 4 ] * g + matrix[ 5 ] * b;
	rgb[ 2 ] = matrix[ 6 ] * r + matrix[ 7 ] * g + matrix[ 8 ] * b;
	return true;

}

/**
 * Convert interleaved linear triples inside a larger buffer.
 *
 * @param {Float32Array} data
 * @param {number} stride - floats between one record and the next
 * @param {number[]} offsets - where each triple starts within one stride
 * @returns {number} how many triples were converted
 */
export function convertLinearTriples( data, stride, offsets ) {

	if ( ! matrix || offsets.length === 0 ) return 0;

	let count = 0;
	for ( let base = 0; base + stride <= data.length; base += stride ) {

		for ( const off of offsets ) {

			const i = base + off;
			const r = data[ i ], g = data[ i + 1 ], b = data[ i + 2 ];
			data[ i ] = matrix[ 0 ] * r + matrix[ 1 ] * g + matrix[ 2 ] * b;
			data[ i + 1 ] = matrix[ 3 ] * r + matrix[ 4 ] * g + matrix[ 5 ] * b;
			data[ i + 2 ] = matrix[ 6 ] * r + matrix[ 7 ] * g + matrix[ 8 ] * b;
			count ++;

		}

	}

	return count;

}
