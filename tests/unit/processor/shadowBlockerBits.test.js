import { describe, it, expect } from 'vitest';
import {
	shadowBlockerBits, packTriangleFlags, TRI_BLOCKER_SHIFT, TRI_BLOCKER_ALPHA_SHIFT, TRI_MATERIAL_MASK, TRI_SIDE_SHIFT
} from '@/core/EngineDefaults.js';

const ALWAYS = 1, UNLESS_ALPHA = 2, PASSES = 0;

describe( 'shadowBlockerBits', () => {

	it( 'flags a plain opaque material as an unconditional blocker', () => {

		expect( shadowBlockerBits( { alphaMode: 0, transparent: false, transmission: 0, opacity: 1 } ) ).toBe( ALWAYS );
		expect( shadowBlockerBits( {} ) ).toBe( ALWAYS );

	} );

	it( 'treats a transparent material at full opacity as a blocker, like traceShadowRay does', () => {

		expect( shadowBlockerBits( { alphaMode: 0, transparent: true, opacity: 1 } ) ).toBe( ALWAYS );
		expect( shadowBlockerBits( { alphaMode: 2, transparent: true, opacity: 1 } ) ).toBe( UNLESS_ALPHA );

	} );

	it( 'lets light through a transparent material below full opacity or any transmissive one', () => {

		expect( shadowBlockerBits( { alphaMode: 2, transparent: true, opacity: 0.4 } ) ).toBe( PASSES );
		expect( shadowBlockerBits( { alphaMode: 0, transparent: true, opacity: 0.1 } ) ).toBe( PASSES );
		expect( shadowBlockerBits( { alphaMode: 0, transparent: false, transmission: 0.9, opacity: 1 } ) ).toBe( PASSES );

	} );

	it( 'defers MASK and BLEND cutouts to the alpha-shadow switch', () => {

		expect( shadowBlockerBits( { alphaMode: 1, transparent: false, opacity: 1 } ) ).toBe( UNLESS_ALPHA );
		expect( shadowBlockerBits( { alphaMode: 2, transparent: false, opacity: 0.5 } ) ).toBe( UNLESS_ALPHA );

	} );

	it( 'accepts the float-encoded material buffer values the runtime patcher reads back', () => {

		expect( shadowBlockerBits( { alphaMode: 2, transparent: 1, transmission: 0, opacity: 1 } ) ).toBe( UNLESS_ALPHA );
		expect( shadowBlockerBits( { alphaMode: 0, transparent: 0, transmission: 0, opacity: 1 } ) ).toBe( ALWAYS );

	} );

	it( 'returns no bits for a missing material', () => {

		expect( shadowBlockerBits( null ) ).toBe( 0 );
		expect( packTriangleFlags( 7, undefined ) ).toBe( 7 );

	} );

} );

describe( 'packTriangleFlags', () => {

	it( 'packs material index, side and both blocker bits into one lane', () => {

		const flags = packTriangleFlags( 0x123456, { side: 2, alphaMode: 2, transparent: true, opacity: 1 } );
		expect( flags & TRI_MATERIAL_MASK ).toBe( 0x123456 );
		expect( ( flags >>> TRI_SIDE_SHIFT ) & 3 ).toBe( 2 );
		expect( ( flags >>> TRI_BLOCKER_SHIFT ) & 1 ).toBe( 0 );
		expect( ( flags >>> TRI_BLOCKER_ALPHA_SHIFT ) & 1 ).toBe( 1 );

	} );

	it( 'keeps the always-blocker bit where the shader reads it', () => {

		const flags = packTriangleFlags( 3, { side: 0 } );
		expect( ( flags >>> TRI_BLOCKER_SHIFT ) & 3 ).toBe( 1 );

	} );

} );
