/**
 * A copy cluster's boxes are bytes of their union (`encodeClusterBoxes`), which traversal turns back into boxes as
 * `base + byte × step` in f32 (`pushHitCopies`, BVHTraversal.js). Each copy's box read back that way must hold the copy:
 * a box read smaller hides the copy from rays that reach it.
 */
import { describe, it, expect } from 'vitest';
import { encodeClusterBoxes, BVH_EMPTY_BOX, CLUSTER_SIZE } from '@/core/scene/BufferLayout.js';

const BASE_SLOT = [ 2, 4, 5 ];

// As the GPU reads it: the step is 2^( e - 127 ) from the exponent byte, byte × step is exact, the sum rounds to f32.
function decode( data, idx, o, count ) {

	const boxes = [];
	for ( let k = 0; k < count; k ++ ) {

		const box = [];
		for ( const which of [ 6, 9 ] ) for ( let a = 0; a < 3; a ++ ) {

			const step = 2 ** ( ( ( idx[ o + 1 ] >>> ( a * 8 ) ) & 255 ) - 127 );
			const byte = ( idx[ o + which + a ] >>> ( k * 8 ) ) & 255;
			box.push( Math.fround( data[ o + BASE_SLOT[ a ] ] + byte * step ) );

		}

		boxes.push( box );

	}

	return boxes;

}

function random( seed ) {

	return () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647;

}

describe( 'encodeClusterBoxes', () => {

	it( 'reads back every copy\'s box no smaller than the copy, near the origin and far from it', () => {

		const rand = random( 11 );
		let worstSlack = 0;
		for ( let trial = 0; trial < 4000; trial ++ ) {

			const count = 1 + ( trial % CLUSTER_SIZE );
			// Centres from 0 to 1e7 away, sizes from 1e-4 to 1e3: byte steps finer than one f32 step out there.
			const centre = ( rand() - 0.5 ) * 10 ** ( rand() * 7 );
			const boxes = new Float64Array( count * 6 );
			for ( let k = 0; k < count; k ++ ) for ( let a = 0; a < 3; a ++ ) {

				// Doubles, as world boxes are: an f32 decode rounds past them unless padded.
				const size = 10 ** ( rand() * 7 - 4 );
				const lo = centre + ( rand() - 0.5 ) * size * 4;
				boxes[ k * 6 + a ] = lo;
				boxes[ k * 6 + 3 + a ] = lo + size;

			}

			const buffer = new ArrayBuffer( 64 );
			const data = new Float32Array( buffer ), idx = new Uint32Array( buffer );
			const union = new Float64Array( 6 );
			encodeClusterBoxes( data, idx, 0, boxes, count, union, 0 );

			decode( data, idx, 0, count ).forEach( ( box, k ) => {

				for ( let a = 0; a < 3; a ++ ) {

					const lo = boxes[ k * 6 + a ], hi = boxes[ k * 6 + 3 + a ];
					expect( box[ a ] ).toBeLessThanOrEqual( lo );
					expect( box[ 3 + a ] ).toBeGreaterThanOrEqual( hi );
					// Not much more: the outward f32 pad at this distance and one byte step, each side.
					const step = 2 ** ( ( ( idx[ 1 ] >>> ( a * 8 ) ) & 255 ) - 127 );
					const pad = Math.max( Math.abs( union[ a ] ), Math.abs( union[ 3 + a ] ), 1e-30 ) * 2 ** - 21;
					worstSlack = Math.max( worstSlack, ( lo - box[ a ] ) / ( pad + step ), ( box[ 3 + a ] - hi ) / ( pad + step ) );

				}

			} );

			for ( let a = 0; a < 3; a ++ ) {

				expect( union[ a ] ).toBe( Math.min( ...Array.from( { length: count }, ( _, k ) => boxes[ k * 6 + a ] ) ) );
				expect( union[ 3 + a ] ).toBe( Math.max( ...Array.from( { length: count }, ( _, k ) => boxes[ k * 6 + 3 + a ] ) ) );

			}

		}

		expect( worstSlack ).toBeLessThanOrEqual( 2 );

	} );

	it( 'stores a cluster whose copies are all hidden as the far point box no ray enters', () => {

		const buffer = new ArrayBuffer( 64 );
		const data = new Float32Array( buffer ), idx = new Uint32Array( buffer );
		idx.fill( 0xffffffff );
		const hidden = new Float64Array( 2 * 6 );
		for ( let k = 0; k < 2; k ++ ) hidden.set( [ Infinity, Infinity, Infinity, - Infinity, - Infinity, - Infinity ], k * 6 );
		const union = new Float64Array( 6 );
		encodeClusterBoxes( data, idx, 0, hidden, 2, union, 0 );

		expect( BASE_SLOT.map( s => data[ s ] ) ).toEqual( [ BVH_EMPTY_BOX, BVH_EMPTY_BOX, BVH_EMPTY_BOX ].map( Math.fround ) );
		expect( [ 6, 7, 8, 9, 10, 11 ].map( i => idx[ i ] ) ).toEqual( [ 0, 0, 0, 0, 0, 0 ] );
		// Its decoded boxes are points out at the far box, behind every hit.
		for ( const box of decode( data, idx, 0, 2 ) ) expect( Math.min( ...box ) ).toBeGreaterThan( 1e29 );
		expect( Array.from( union ) ).toEqual( [ Infinity, Infinity, Infinity, - Infinity, - Infinity, - Infinity ] );

	} );

} );
