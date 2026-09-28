import { describe, it, expect } from 'vitest';
import { freeNow, resized } from '@/core/Processor/PBRT/buffers.js';

describe( 'PBRT buffers', () => {

	it( 'resizes in place, keeping the contents and zero-filling growth', () => {

		const a = Float32Array.of( 1, 2, 3 );
		const grown = resized( a, 6 );
		expect( Array.from( grown ) ).toEqual( [ 1, 2, 3, 0, 0, 0 ] );
		expect( a.byteLength ).toBe( 0 );

		const shrunk = resized( grown, 2 );
		expect( Array.from( shrunk ) ).toEqual( [ 1, 2 ] );
		expect( shrunk ).toBeInstanceOf( Float32Array );

	} );

	it( 'copies a view rather than detaching the buffer under it', () => {

		const whole = Int32Array.of( 5, 6, 7, 8 );
		const view = whole.subarray( 1, 3 );
		expect( Array.from( resized( view, 3 ) ) ).toEqual( [ 6, 7, 0 ] );
		expect( Array.from( whole ) ).toEqual( [ 5, 6, 7, 8 ] );

		freeNow( view );
		expect( whole.byteLength ).toBe( 16 );

	} );

	it( 'frees a whole buffer, and never a shared one', () => {

		const own = new Uint8Array( 64 );
		freeNow( own );
		expect( own.byteLength ).toBe( 0 );

		const shared = new Uint8Array( new SharedArrayBuffer( 64 ) );
		freeNow( shared );
		expect( shared.byteLength ).toBe( 64 );

	} );

} );
