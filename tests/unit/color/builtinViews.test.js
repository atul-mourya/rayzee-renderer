/**
 * The seven three.js curves, pinned to what they produced before they moved into the registry.
 *
 * Moving them was a refactor with no intended change in output, and "no intended change" is worth
 * nothing without a number. These hashes were taken from the implementation in `ToneMapCPU.js`
 * immediately before the move and verified byte-identical against it; they must not be regenerated
 * to make a failure go away.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
	NoToneMapping, LinearToneMapping, ReinhardToneMapping,
	CineonToneMapping, ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping,
} from 'three';
import { TONE_MAP_FNS, toneMapToRGBA8, effectiveExposure, isOutputEncoded } from '@/core/Processor/ToneMapCPU.js';
import { BUILTIN_VIEWS } from '@/core/Color/BuiltinViews.js';

/** sha256 of the bytes each curve produces over a fixed noisy frame, at six grades. */
const GOLDEN = {
	[ NoToneMapping ]: 'de400917f2628353',
	[ LinearToneMapping ]: '1777b30c93977643',
	[ ReinhardToneMapping ]: '3d317960faa5e8bd',
	[ CineonToneMapping ]: '583562d576ae10c7',
	[ ACESFilmicToneMapping ]: 'e5623ffad6156f19',
	[ AgXToneMapping ]: 'ffd9dd4b1187f750',
	[ NeutralToneMapping ]: '4741d327deb00347',
};

function frame() {

	let rng = 999;
	const rnd = () => ( rng = ( rng * 1664525 + 1013904223 ) >>> 0 ) / 4294967296;
	const px = new Float32Array( 4096 * 4 );
	// Deliberately includes negatives: the saturation grade drives channels below zero on much of a
	// real frame, and the curves must clamp exactly where the GPU does.
	for ( let i = 0; i < px.length; i ++ ) px[ i ] = ( rnd() - 0.15 ) * 12;
	return px;

}

describe( 'built-in view transforms', () => {

	const px = frame();

	it.each( Object.keys( GOLDEN ).map( Number ) )( 'curve %i is unchanged', id => {

		const h = createHash( 'sha256' );
		for ( const saturation of [ 1.0, 1.2, 0.7 ] ) {

			for ( const exposure of [ 1.0, 2.5 ] ) {

				h.update( Buffer.from( toneMapToRGBA8( px, { exposure, toneMapping: id, saturation } ).buffer ) );

			}

		}

		expect( h.digest( 'hex' ).slice( 0, 16 ) ).toBe( GOLDEN[ id ] );

	} );

	it( 'registers exactly the seven three.js curves', () => {

		expect( BUILTIN_VIEWS ).toHaveLength( 7 );
		expect( BUILTIN_VIEWS.map( v => v.id ).sort( ( a, b ) => a - b ) )
			.toEqual( Object.keys( GOLDEN ).map( Number ).sort( ( a, b ) => a - b ) );
		expect( [ ...TONE_MAP_FNS.keys() ] ).toEqual( expect.arrayContaining( BUILTIN_VIEWS.map( v => v.id ) ) );

	} );

	it( 'returns linear colour, so the output pass still applies the transfer', () => {

		for ( const v of BUILTIN_VIEWS ) {

			expect( v.outputEncoded, v.name ).toBe( false );
			expect( isOutputEncoded( v.id ), v.name ).toBe( false );

		}

	} );

	it( 'skips exposure for None only, matching three.js ToneMappingNode', () => {

		expect( effectiveExposure( 2.5, NoToneMapping ) ).toBe( 1.0 );
		for ( const v of BUILTIN_VIEWS ) {

			if ( v.id === NoToneMapping ) continue;
			expect( effectiveExposure( 2.5, v.id ), v.name ).toBe( 2.5 );

		}

	} );

	it( 'keeps None and Linear distinct', () => {

		// They look interchangeable and are not: None ignores exposure, Linear applies it, and
		// `AIUpscaler` calls these functions directly rather than through `toneMapToRGBA8`.
		const a = [ 0, 0, 0 ], b = [ 0, 0, 0 ];
		TONE_MAP_FNS.get( NoToneMapping )( 0.2, 0.2, 0.2, 100, a );
		TONE_MAP_FNS.get( LinearToneMapping )( 0.2, 0.2, 0.2, 100, b );
		expect( a[ 0 ] ).toBeCloseTo( 0.2, 6 );
		expect( b[ 0 ] ).toBe( 1 );

	} );

} );
