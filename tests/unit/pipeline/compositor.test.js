import { describe, it, expect, afterEach } from 'vitest';
import { Matrix3, Texture } from 'three';
import { Compositor } from '@/core/pipeline/Compositor.js';
import { whiteBalanceMatrix } from '@/core/color/WhiteBalance.js';
import { setWorkingMatrix } from '@/core/color/WorkingMatrix.js';

// Linear Rec.709 → ACEScg, row-major.
const ACESCG = [ 0.6130974, 0.3395231, 0.0473795, 0.0701937, 0.9163539, 0.0134524, 0.0206156, 0.1095698, 0.8698147 ];

const context = { getTexture: () => new Texture(), getState: () => null };
const uniformOf = m => new Matrix3().set( ...m ).elements;

describe( 'Compositor white balance', () => {

	afterEach( () => setWorkingMatrix( null ) );

	it( 'is off until set, then draws with the matrix for the kelvin', () => {

		const compositor = new Compositor( {} );
		compositor._prepare( context );
		expect( compositor._whiteBalanceOn.value ).toBe( 0 );

		compositor.setWhiteBalance( 9000 );
		compositor._prepare( context );
		expect( compositor._whiteBalanceOn.value ).toBe( 1 );
		expect( compositor._whiteBalance.value.elements ).toEqual( uniformOf( whiteBalanceMatrix( 9000, null ) ) );

		compositor.setWhiteBalance( 0 );
		compositor._prepare( context );
		expect( compositor._whiteBalanceOn.value ).toBe( 0 );

	} );

	it( 'starts at the kelvin it is built with, and follows a change of working space', () => {

		const compositor = new Compositor( {}, { whiteBalance: 3200 } );
		compositor._prepare( context );
		expect( compositor._whiteBalance.value.elements ).toEqual( uniformOf( whiteBalanceMatrix( 3200, null ) ) );

		setWorkingMatrix( ACESCG, 'ACEScg' );
		compositor._prepare( context );
		expect( compositor._whiteBalance.value.elements ).toEqual( uniformOf( whiteBalanceMatrix( 3200, ACESCG ) ) );

	} );

} );
