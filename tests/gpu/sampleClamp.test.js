/**
 * pbrt's Film `maxcomponentvalue` (film.h, RGBFilm::AddSample): a sample whose largest sensor component — CIE XYZ, for
 * pbrt's default cie1931 sensor — passes the limit is scaled to it, colour kept.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { float, vec3, uniform } from 'three/tsl';
import { Matrix3 } from 'three';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { sampleClampScale } from '@/core/shaders/kernels/FinalWriteKernel.js';

const XYZ = [ 0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041 ];
// Rec.709 → ACEScg (AP1), row-major: a working space other than the native one.
const TO_AP1 = [ 0.6130974, 0.3395231, 0.0473795, 0.0701937, 0.9163539, 0.0134524, 0.0206156, 0.1095698, 0.8698146 ];

const COLOURS = [[ 1, 1, 1 ], [ 30, 20, 10 ], [ 0, 0, 12 ], [ 12, 0, 0 ], [ 9.5, 9.5, 9.5 ], [ 0.5, 4, 0.2 ], [ 0, 0, 0 ]];
const LIMIT = 10;

const mul = ( m, v ) => [ 0, 3, 6 ].map( r => m[ r ] * v[ 0 ] + m[ r + 1 ] * v[ 1 ] + m[ r + 2 ] * v[ 2 ] );
const expected = ( rgb709 ) => {

	const m = Math.max( ...mul( XYZ, rgb709 ) );
	return m > LIMIT ? LIMIT / m : 1;

};

describeGPU( 'the per-sample clamp', () => {

	let renderer;
	beforeAll( async () => void ( renderer = await createRenderer() ) );
	afterAll( () => renderer?.dispose() );

	it( 'scales a sample whose largest XYZ component passes the limit down to it, in any working space', async () => {

		for ( const working of [ null, TO_AP1 ] ) {

			const toXYZ = new Matrix3().set( ...XYZ );
			if ( working ) toXYZ.multiply( new Matrix3().set( ...working ).invert() );
			const colours = COLOURS.map( c => ( working ? mul( working, c ) : c ) );
			const data = new Float32Array( colours.flat() );
			const out = new Float32Array( await evaluate( renderer, colours.length, { c: [ data, 'vec3' ] }, 'float',
				( a ) => sampleClampScale( vec3( a.c ), float( LIMIT ), uniform( toXYZ ) ) ) );
			COLOURS.forEach( ( c, i ) => expect( out[ i ], `${c} in ${working ? 'AP1' : 'Rec.709'}` ).toBeCloseTo( expected( c ), 5 ) );
			// White 9.5 is 10.3 in Z: capped though no channel reaches 10; blue 12 is 11.4 in Z.
			expect( out[ 4 ] ).toBeLessThan( 1 );
			expect( out[ 0 ] ).toBe( 1 );

		}

	} );

} );
