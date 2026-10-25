import { describe, it, expect } from 'vitest';
import { remap } from '@/lib/utils.js';

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
