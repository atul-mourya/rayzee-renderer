import { describe, it, expect } from 'vitest';
import { sliderKeyTarget } from '@/components/ui/slider';

describe( 'slider keys', () => {

	const at = { value: 8, step: 1, min: 0, max: 20 };

	it( 'steps with the arrows, ten at a time with Shift or Page Up / Down', () => {

		expect( [ 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'ArrowDown' ].map( k => sliderKeyTarget( k, false, at ) ) ).toEqual( [ 9, 9, 7, 7 ] );
		expect( [ 'ArrowRight', 'ArrowLeft' ].map( k => sliderKeyTarget( k, true, at ) ) ).toEqual( [ 18, - 2 ] );
		expect( [ 'PageUp', 'PageDown' ].map( k => sliderKeyTarget( k, false, at ) ) ).toEqual( [ 18, - 2 ] );
		expect( sliderKeyTarget( 'ArrowRight', false, { ...at, step: 0.01 } ) ).toBeCloseTo( 8.01, 10 );

	} );

	it( 'jumps to the ends with Home and End, types a value on Enter, and leaves other keys alone', () => {

		expect( [ 'Home', 'End', 'Enter' ].map( k => sliderKeyTarget( k, false, at ) ) ).toEqual( [ 0, 20, 'edit' ] );
		expect( [ 'w', 'Tab', ' ', 'Escape' ].map( k => sliderKeyTarget( k, false, at ) ) ).toEqual( [ null, null, null, null ] );

	} );

} );
