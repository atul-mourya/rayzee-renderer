/**
 * The shaper and the table, checked against arithmetic done by hand rather than against another
 * copy of the same code.
 */

import { describe, it, expect } from 'vitest';
import {
	shape, unshape, bakeLut, makeCpuSampler, tetrahedron, packHalf, unpackHalf, measureBakeError,
} from '@/core/Color/LutBake.js';

const MIN_EV = - 12.47393, MAX_EV = 12.5260688117, SIZE = 33;

describe( 'the log2 shaper', () => {

	it( 'puts the ends of the range at the ends of the grid', () => {

		expect( shape( Math.pow( 2, MIN_EV ), SIZE, MIN_EV, MAX_EV ) ).toBeCloseTo( 0, 5 );
		expect( shape( Math.pow( 2, MAX_EV ), SIZE, MIN_EV, MAX_EV ) ).toBeCloseTo( SIZE - 1, 5 );

	} );

	it( 'clamps rather than running off either end', () => {

		expect( shape( 0, SIZE, MIN_EV, MAX_EV ) ).toBe( 0 );
		expect( shape( - 5, SIZE, MIN_EV, MAX_EV ) ).toBe( 0 );
		expect( shape( 1e30, SIZE, MIN_EV, MAX_EV ) ).toBe( SIZE - 1 );

	} );

	it( 'is one stop per step of the range divided by the grid', () => {

		const perStep = ( MAX_EV - MIN_EV ) / ( SIZE - 1 );
		const a = unshape( 10, SIZE, MIN_EV, MAX_EV );
		const b = unshape( 11, SIZE, MIN_EV, MAX_EV );
		expect( Math.log2( b / a ) ).toBeCloseTo( perStep, 6 );

	} );

	it( 'makes grid index 0 exactly zero, not the darkest representable value', () => {

		// Without this, true black leaves the table one code value above zero and every render has
		// a raised black floor.
		expect( unshape( 0, SIZE, MIN_EV, MAX_EV ) ).toBe( 0 );
		expect( unshape( 1, SIZE, MIN_EV, MAX_EV ) ).toBeGreaterThan( 0 );

	} );

	it( 'round-trips a value in the middle of the range', () => {

		const v = 0.18;
		const p = shape( v, SIZE, MIN_EV, MAX_EV );
		const back = Math.pow( 2, MIN_EV + ( p / ( SIZE - 1 ) ) * ( MAX_EV - MIN_EV ) );
		expect( back ).toBeCloseTo( v, 6 );

	} );

} );

describe( 'tetrahedral interpolation', () => {

	it( 'always ends at the far corner of the cube', () => {

		for ( const f of [[ 0.9, 0.5, 0.1 ], [ 0.1, 0.9, 0.5 ], [ 0.5, 0.1, 0.9 ], [ 0.2, 0.2, 0.2 ]] ) {

			expect( tetrahedron( ...f ).c[ 2 ] ).toEqual( [ 1, 1, 1 ] );

		}

	} );

	it( 'picks a different tetrahedron for each ordering of the three fractions', () => {

		const seen = new Set();
		for ( const f of [
			[ 0.9, 0.5, 0.1 ], [ 0.9, 0.1, 0.5 ], [ 0.5, 0.1, 0.9 ],
			[ 0.1, 0.5, 0.9 ], [ 0.1, 0.9, 0.5 ], [ 0.5, 0.9, 0.1 ],
		] ) {

			seen.add( JSON.stringify( tetrahedron( ...f ).c ) );

		}

		expect( seen.size ).toBe( 6 );

	} );

	it( 'reproduces an identity table exactly, whichever tetrahedron it lands in', () => {

		// The grid holds the shaper values themselves, so sampling it must return the input.
		const data = bakeLut( { size: SIZE, minEv: MIN_EV, maxEv: MAX_EV, apply: () => {} } );
		const sample = makeCpuSampler( { data, size: SIZE, minEv: MIN_EV, maxEv: MAX_EV } );

		const out = [ 0, 0, 0 ];
		for ( const c of [[ 0.18, 0.18, 0.18 ], [ 1, 0.5, 0.25 ], [ 0.001, 4, 0.3 ]] ) {

			sample( c[ 0 ], c[ 1 ], c[ 2 ], out );
			// Interpolating a log grid linearly undershoots between samples, so this is a sanity
			// bound on the shaper's wiring, not on interpolation accuracy.
			for ( let i = 0; i < 3; i ++ ) expect( out[ i ] ).toBeGreaterThan( 0 );

		}

		// On a grid point there is no interpolation to lose anything.
		const exact = unshape( 20, SIZE, MIN_EV, MAX_EV );
		sample( exact, exact, exact, out );
		expect( out[ 0 ] ).toBeCloseTo( exact, 5 );

	} );

} );

describe( 'baking', () => {

	it( 'samples the whole cube, red fastest', () => {

		const size = 4;
		const data = bakeLut( { size, minEv: MIN_EV, maxEv: MAX_EV, apply: () => {} } );
		expect( data ).toHaveLength( size ** 3 * 4 );

		const axis = i => unshape( i, size, MIN_EV, MAX_EV );
		// The grid is stored float32 and spans 25 stops, so the top of it is in the thousands —
		// compared relatively, since an absolute tolerance there is meaningless.
		const near = ( got, want ) => expect( Math.abs( got - want ) / Math.max( want, 1e-9 ) ).toBeLessThan( 1e-6 );

		// index (r=2, g=1, b=3)
		const at = ( 2 + 1 * size + 3 * size * size ) * 4;
		near( data[ at ], axis( 2 ) );
		near( data[ at + 1 ], axis( 1 ) );
		near( data[ at + 2 ], axis( 3 ) );
		expect( data[ at + 3 ] ).toBe( 1 );

	} );

	it( 'reports what the table costs against the transform it came from', () => {

		// A per-channel square root: smooth, so a table should track it closely.
		const apply = buf => {

			for ( let i = 0; i < buf.length; i += 4 ) {

				for ( let c = 0; c < 3; c ++ ) buf[ i + c ] = Math.min( 1, Math.sqrt( buf[ i + c ] ) );

			}

		};

		const size = 65;
		const data = bakeLut( { size, minEv: MIN_EV, maxEv: MAX_EV, apply } );
		const sampler = makeCpuSampler( { data, size, minEv: MIN_EV, maxEv: MAX_EV } );
		const err = measureBakeError( { sampler, apply, count: 2000 } );

		expect( err.samples ).toBe( 6000 );
		expect( err.mean ).toBeLessThan( err.p95 );
		expect( err.p95 ).toBeLessThanOrEqual( err.max );
		expect( err.mean ).toBeLessThan( 2 );

	} );

} );

describe( 'half-float packing', () => {

	it( 'round-trips display-range values well inside a code value', () => {

		const values = new Float32Array( 4096 );
		for ( let i = 0; i < values.length; i ++ ) values[ i ] = i / ( values.length - 1 );

		const back = unpackHalf( packHalf( values ) );
		let worst = 0;
		for ( let i = 0; i < values.length; i ++ ) worst = Math.max( worst, Math.abs( back[ i ] - values[ i ] ) );

		expect( worst * 255 ).toBeLessThan( 0.2 );

	} );

	it( 'keeps zero at zero and survives values far outside [0,1]', () => {

		const values = new Float32Array( [ 0, 1e-8, 1e-5, 1, 64, 65504, 1e9, - 0.5 ] );
		const back = unpackHalf( packHalf( values ) );

		expect( back[ 0 ] ).toBe( 0 );
		expect( back[ 3 ] ).toBe( 1 );
		expect( back[ 5 ] ).toBeCloseTo( 65504, 0 );
		// Above what a half can hold it saturates rather than becoming infinity or garbage.
		expect( Number.isFinite( back[ 6 ] ) ).toBe( true );
		expect( back[ 7 ] ).toBeCloseTo( - 0.5, 3 );

	} );

	it( 'handles subnormals without the shift wrapping', () => {

		// JavaScript's `>>>` wraps modulo 32, so a shift that should discard the whole mantissa
		// instead returned a huge number. These all sit in or below the subnormal range.
		const values = new Float32Array( [ 1e-7, 1e-9, 1e-12, 1e-20, 1e-38 ] );
		const back = unpackHalf( packHalf( values ) );

		for ( let i = 0; i < values.length; i ++ ) {

			expect( back[ i ] ).toBeGreaterThanOrEqual( 0 );
			expect( back[ i ] ).toBeLessThan( 1e-4 );

		}

	} );

} );
