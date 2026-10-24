/**
 * The Results panel's edits on a saved render's HDR picture (`pictureGrade`, for `PictureView.setGrade`) against the
 * same edits on its 8-bit picture: `ImageProcessorComposer`'s GLSL, here in JavaScript. Identical up to white, nothing
 * changed at the panel's defaults, and colours past white or outside the canvas's gamut carried through.
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { vec4 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { pictureGrade } from '@/utils/ImageProcessor.js';

// BrightnessContrastShader, then ColorAdjustmentShader, as the 8-bit picture runs them.
function edit( c, p ) {

	let v = c.map( x => x + p.brightness / 100 );
	const k = p.contrast / 100;
	v = v.map( x => ( k > 0 ? ( x - 0.5 ) / ( 1 - k ) + 0.5 : ( x - 0.5 ) * ( 1 + k ) + 0.5 ) );
	let lin = v.map( x => Math.max( x, 0 ) ** 2.2 );
	const luma = 0.2126 * lin[ 0 ] + 0.7152 * lin[ 1 ] + 0.0722 * lin[ 2 ];
	lin = lin.map( x => luma + ( x - luma ) * ( 1 + p.saturation / 100 ) );
	if ( Math.abs( p.hue ) > 0.01 ) {

		const [ r, g, b ] = lin, hi = Math.max( r, g, b ), lo = Math.min( r, g, b ), d = hi - lo, l = ( hi + lo ) / 2;
		let h = 0, s = 0;
		if ( d > 0 ) {

			s = l < 0.5 ? d / ( hi + lo ) : d / ( 2 - hi - lo );
			h = ( hi === r ? ( g - b ) / d + ( g < b ? 6 : 0 ) : hi === g ? ( b - r ) / d + 2 : ( r - g ) / d + 4 ) / 6;

		}

		h = ( ( h + p.hue / 360 ) % 1 + 1 ) % 1;
		const q = l < 0.5 ? l * ( 1 + s ) : l + s - l * s, w = 2 * l - q;
		const f = t => {

			t = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
			return t < 1 / 6 ? w + ( q - w ) * 6 * t : t < 0.5 ? q : t < 2 / 3 ? w + ( q - w ) * ( 2 / 3 - t ) * 6 : w;

		};

		lin = s === 0 ? [ l, l, l ] : [ f( h + 1 / 3 ), f( h ), f( h - 1 / 3 ) ];

	}

	return lin.map( x => Math.sign( x ) * Math.abs( x * 2 ** ( p.exposure / 100 ) ) ** ( 1 / p.gamma ) );

}

// Encoded colours from dark to white, greys and saturated, then past white and outside the gamut.
const IN_RANGE = [];
for ( const v of [ 0.15, 0.3, 0.5, 0.7, 0.85, 1 ] ) IN_RANGE.push( [ v, v, v ], [ v, v * 0.6, v * 0.2 ], [ v * 0.1, v * 0.8, v ], [ v * 0.9, v * 0.3, v * 0.7 ] );
const BEYOND = [[ 2.5, 2.5, 2.5 ], [ 3.2, 1.4, 0.6 ], [ - 0.08, 0.6, 0.3 ], [ 0.5, - 0.02, 0.9 ]];

const EDITS = [
	{ brightness: 6, contrast: 15, saturation: 30, hue: 40, exposure: 35, gamma: 2.4 },
	{ brightness: - 5, contrast: - 20, saturation: - 60, hue: - 120, exposure: - 50, gamma: 2.0 },
];

describeGPU( 'the Results edits on an HDR picture', () => {

	let renderer;
	beforeAll( async () => {

		renderer = await createRenderer();

	} );

	afterAll( () => renderer?.dispose() );

	const run = async ( colours, params ) => {

		const { grade, set } = pictureGrade();
		set( params );
		const input = new Float32Array( colours.flatMap( c => [ ...c, 1 ] ) );
		return new Float32Array( await evaluate( renderer, colours.length, { c: [ input, 'vec4' ] }, 'vec4', ( { c } ) => vec4( grade( c.xyz ), 1 ) ) );

	};

	it.each( EDITS )( 'edits a colour up to white as the 8-bit picture does (%o)', async params => {

		const out = await run( IN_RANGE, params );
		IN_RANGE.forEach( ( c, i ) => {

			const want = edit( c, params ).map( x => Math.min( 1, Math.max( 0, x ) ) );
			for ( let k = 0; k < 3; k ++ ) expect( Math.abs( Math.min( 1, Math.max( 0, out[ i * 4 + k ] ) ) - want[ k ] ) * 255, `${c} channel ${k}` ).toBeLessThan( 0.5 );

		} );

	} );

	it( 'changes nothing at the panel\'s defaults, past white and outside the gamut too', async () => {

		const colours = [ ...IN_RANGE, ...BEYOND ];
		const out = await run( colours, {} );
		colours.forEach( ( c, i ) => c.forEach( ( v, k ) => expect( out[ i * 4 + k ] ).toBeCloseTo( v, 4 ) ) );

	} );

	it( 'carries a colour past white through every edit', async () => {

		for ( const params of EDITS ) {

			const out = await run( BEYOND.slice( 0, 2 ), params );
			for ( const v of out ) expect( Number.isFinite( v ) ).toBe( true );
			// Brighter in stays brighter out: the edit does not fold highlights back below white.
			expect( out[ 0 ] ).toBeGreaterThan( edit( [ 1, 1, 1 ], params )[ 0 ] );

		}

	} );

} );
