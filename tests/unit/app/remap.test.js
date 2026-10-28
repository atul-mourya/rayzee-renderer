import { describe, it, expect, vi, afterEach } from 'vitest';
import { remap, cn, debounce } from '@/lib/utils.js';

describe( 'remap', () => {

	it( 'maps midpoint correctly', () => {

		expect( remap( 0.5, 0, 1, 0, 100 ) ).toBe( 50 );

	} );

	it( 'maps start of range', () => {

		expect( remap( 0, 0, 1, 0, 100 ) ).toBe( 0 );

	} );

	it( 'maps end of range', () => {

		expect( remap( 1, 0, 1, 0, 100 ) ).toBe( 100 );

	} );

	it( 'maps between arbitrary ranges', () => {

		expect( remap( 5, 0, 10, 100, 200 ) ).toBe( 150 );

	} );

	it( 'handles inverted output range', () => {

		expect( remap( 0.5, 0, 1, 100, 0 ) ).toBe( 50 );

	} );

	it( 'handles negative ranges', () => {

		expect( remap( 0, - 10, 10, 0, 100 ) ).toBe( 50 );

	} );

	it( 'extrapolates beyond input range', () => {

		expect( remap( 2, 0, 1, 0, 100 ) ).toBe( 200 );

	} );

} );

describe( 'cn', () => {

	it( 'joins truthy classes from strings, arrays and objects', () => {

		expect( cn( 'a', false, [ 'c', null ], { d: true, e: false }, undefined, 0 ) ).toBe( 'a c d' );

	} );

	it( 'lets a later Tailwind class win over a conflicting earlier one', () => {

		expect( cn( 'p-2 text-sm', 'p-4' ) ).toBe( 'text-sm p-4' );
		expect( cn( 'bg-red-500', { 'bg-blue-500': true } ) ).toBe( 'bg-blue-500' );

	} );

} );

describe( 'debounce', () => {

	afterEach( () => vi.useRealTimers() );

	it( 'runs once, with the last call\'s arguments and receiver, after the quiet period', () => {

		vi.useFakeTimers();
		const fn = vi.fn( function () {

			return this;

		} );
		const target = { run: debounce( fn, 100 ) };

		target.run( 1 );
		vi.advanceTimersByTime( 60 );
		target.run( 2 );
		vi.advanceTimersByTime( 99 );
		expect( fn ).not.toHaveBeenCalled();

		vi.advanceTimersByTime( 1 );
		expect( fn ).toHaveBeenCalledTimes( 1 );
		expect( fn ).toHaveBeenCalledWith( 2 );
		expect( fn.mock.results[ 0 ].value ).toBe( target );

	} );

	it( 'drops a pending call on cancel', () => {

		vi.useFakeTimers();
		const fn = vi.fn();
		const run = debounce( fn, 50 );

		run();
		run.cancel();
		vi.advanceTimersByTime( 100 );
		expect( fn ).not.toHaveBeenCalled();

		run( 'again' );
		vi.advanceTimersByTime( 50 );
		expect( fn ).toHaveBeenCalledWith( 'again' );

	} );

} );
