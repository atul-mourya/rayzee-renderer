/**
 * The auto exposure meter on the GPU against the same metering written plainly in JavaScript.
 */

import { beforeAll, expect, it } from 'vitest';
import { DataTexture, RGBAFormat, FloatType } from 'three';
import { describeGPU, createRenderer } from './gpu.js';
import { AutoExposure } from '@/core/Stages/AutoExposure.js';
import { setWorkingMatrix } from '@/core/Color/WorkingMatrix.js';

const BINS = 256, LOG2_MIN = - 16, BIN_STOPS = 28 / 256, BLACK = 2 ** - 24, SCALE = 65536;
const Y709 = [ 0.2126, 0.7152, 0.0722 ];

function reference( px, width, height, { low = 0.1, high = 0.9, falloff = [ 8, 8 ], point = [ 0.5, 0.5 ], weights = Y709, stride = 1 } = {} ) {

	const gx = Math.min( 64, Math.max( 1, Math.floor( width / 8 ) ) ), gy = Math.min( 64, Math.max( 1, Math.floor( height / 8 ) ) );
	const hist = new Float64Array( BINS );
	for ( let ty = 0; ty < gy; ty ++ ) for ( let tx = 0; tx < gx; tx ++ ) {

		const x0 = Math.floor( tx * width / gx ), x1 = Math.floor( ( tx + 1 ) * width / gx );
		const y0 = Math.floor( ty * height / gy ), y1 = Math.floor( ( ty + 1 ) * height / gy );
		let sum = 0, cover = 0;
		const inBlock = ( v, origin ) => ( v - origin ) % ( 8 * stride ) < 8;
		for ( let y = y0; y < y1; y ++ ) for ( let x = x0; x < x1; x ++ ) {

			if ( ! inBlock( x, x0 ) || ! inBlock( y, y0 ) ) continue;

			const i = ( y * width + x ) * 4;
			let l = px[ i ] * weights[ 0 ] + px[ i + 1 ] * weights[ 1 ] + px[ i + 2 ] * weights[ 2 ];
			l = Number.isFinite( l ) ? Math.min( Math.max( l, 0 ), 1e6 ) : 0;
			const a = Math.min( Math.max( px[ i + 3 ], 0 ), 1 );
			sum += l * a;
			cover += a;

		}

		if ( ! ( cover > 0 && sum > cover * BLACK ) ) continue;
		const along = span => Math.floor( span / ( 8 * stride ) ) * 8 + Math.min( span % ( 8 * stride ), 8 );
		const reads = along( x1 - x0 ) * along( y1 - y0 );
		const bin = Math.min( Math.max( Math.floor( ( Math.log2( sum / cover ) - LOG2_MIN ) / BIN_STOPS ), 0 ), BINS - 1 );
		const u = ( x0 + x1 ) / width / 2 - point[ 0 ], v = ( y0 + y1 ) / height / 2 - point[ 1 ];
		const w = Math.exp( - ( u * u * falloff[ 0 ] + v * v * falloff[ 1 ] ) ) * cover / Math.max( reads, 1 );
		hist[ bin ] += Math.floor( w * SCALE + 0.5 );

	}

	const total = hist.reduce( ( a, b ) => a + b, 0 );
	let above = 0, kept = 0, level = 0;
	for ( let b = 0; b < BINS; b ++ ) {

		const below = above;
		above += hist[ b ];
		const part = Math.max( Math.min( above, total * high ) - Math.max( below, total * low ), 0 );
		kept += part;
		level += part * ( LOG2_MIN + ( b + 0.5 ) * BIN_STOPS );

	}

	return kept > 0 ? level / kept : null;

}

function image( width, height, fn ) {

	const px = new Float32Array( width * height * 4 );
	for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) px.set( fn( x, y ), ( y * width + x ) * 4 );
	return px;

}

function texture( px, width, height ) {

	const t = new DataTexture( px, width, height, RGBAFormat, FloatType );
	t.needsUpdate = true;
	return t;

}

const contextFor = ( tex ) => ( { getTexture: () => tex, getState: () => 0, setState() {} } );

describeGPU( 'auto exposure metering', () => {

	let renderer, stage;

	beforeAll( async () => {

		renderer = await createRenderer();
		stage = new AutoExposure( renderer, { enabled: true } );

	} );

	async function meter( px, width, height, params = {} ) {

		stage.updateParameters( { metering: 'center', ...params } );
		return stage.meter( contextFor( texture( px, width, height ) ) );

	}

	it( 'matches the reference on a lit gradient with a hot spot', async () => {

		const w = 640, h = 360;
		const px = image( w, h, ( x, y ) => {

			const l = 0.02 * 2 ** ( 6 * x / w ) * ( 1 + y / h );
			const hot = ( x - 500 ) ** 2 + ( y - 80 ) ** 2 < 400 ? 300 : 0;
			return [ l + hot, l * 0.8 + hot, l * 0.5, 1 ];

		} );
		expect( await meter( px, w, h ) ).toBeCloseTo( reference( px, w, h ), 4 );

	} );

	it( 'reads a flat grey as itself, within half a bin', async () => {

		const px = image( 256, 128, () => [ 0.18, 0.18, 0.18, 1 ] );
		expect( Math.abs( await meter( px, 256, 128 ) - Math.log2( 0.18 ) ) ).toBeLessThanOrEqual( BIN_STOPS / 2 );

	} );

	it( 'meters a one-sample image close to the converged one', async () => {

		// Each pixel finds its light with chance 1/8 and carries 8× when it does: the same mean, mostly black.
		const w = 512, h = 288;
		let seed = 7;
		const rand = () => ( ( seed = ( seed * 1664525 + 1013904223 ) >>> 0 ) / 2 ** 32 );
		const converged = image( w, h, ( x ) => {

			const l = 0.05 * 2 ** ( 4 * x / w );
			return [ l, l, l, 1 ];

		} );
		const noisy = converged.map( ( v, i ) => ( i % 4 === 3 ? 1 : v ) );
		for ( let i = 0; i < noisy.length; i += 4 ) {

			const k = rand() < 1 / 8 ? 8 : 0;
			noisy[ i ] *= k;
			noisy[ i + 1 ] *= k;
			noisy[ i + 2 ] *= k;

		}

		expect( Math.abs( await meter( noisy, w, h ) - await meter( converged, w, h ) ) ).toBeLessThan( 0.1 );

	} );

	it( 'ignores NaN and infinite pixels', async () => {

		// One bad pixel in every tile, infinite in half of them.
		const px = image( 128, 128, ( x, y ) => ( x % 8 === 3 && y % 8 === 5 ? [ ( x >> 3 ) % 2 ? Infinity : NaN, 0, 0, 1 ] : [ 0.5, 0.5, 0.5, 1 ] ) );
		const value = await meter( px, 128, 128 );
		expect( Number.isFinite( value ) ).toBe( true );
		expect( value ).toBeCloseTo( reference( px, 128, 128 ), 4 );

	} );

	it( 'leaves out a transparent background and a black one', async () => {

		const lit = image( 256, 256, () => [ 0.4, 0.4, 0.4, 1 ] );
		const transparent = image( 256, 256, ( x ) => ( x < 128 ? [ 20, 20, 20, 0 ] : [ 0.4, 0.4, 0.4, 1 ] ) );
		const black = image( 256, 256, ( x ) => ( x < 128 ? [ 0, 0, 0, 1 ] : [ 0.4, 0.4, 0.4, 1 ] ) );
		const expected = await meter( lit, 256, 256, { metering: 'average' } );
		expect( await meter( transparent, 256, 256, { metering: 'average' } ) ).toBeCloseTo( expected, 4 );
		expect( await meter( black, 256, 256, { metering: 'average' } ) ).toBeCloseTo( expected, 4 );

	} );

	it( 'clips highlights above the high percentile', async () => {

		const px = image( 256, 256, ( x, y ) => ( y < 13 ? [ 500, 500, 500, 1 ] : [ 0.1, 0.1, 0.1, 1 ] ) );
		expect( Math.abs( await meter( px, 256, 256, { metering: 'average' } ) - Math.log2( 0.1 ) ) ).toBeLessThan( BIN_STOPS );

	} );

	it( 'weighs the frame by the metering pattern', async () => {

		const w = 320, h = 180;
		const px = image( w, h, ( x ) => ( x < w / 2 ? [ 0.01, 0.01, 0.01, 1 ] : [ 1, 1, 1, 1 ] ) );
		const average = await meter( px, w, h, { metering: 'average' } );
		const spotRight = await meter( px, w, h, { metering: 'spot', meteringPoint: { x: 0.85, y: 0.5 } } );
		const spotLeft = await meter( px, w, h, { metering: 'spot', meteringPoint: { x: 0.15, y: 0.5 } } );
		expect( average ).toBeCloseTo( reference( px, w, h, { falloff: [ 0, 0 ] } ), 4 );
		expect( spotRight ).toBeCloseTo( reference( px, w, h, { falloff: [ 128 * ( w / h ) ** 2, 128 ], point: [ 0.85, 0.5 ] } ), 4 );
		expect( Math.abs( spotRight ) ).toBeLessThan( 0.2 );
		expect( Math.abs( spotLeft - Math.log2( 0.01 ) ) ).toBeLessThan( 0.2 );

	} );

	it( 'meters an image smaller than its tile grid', async () => {

		const px = image( 7, 5, ( x ) => [ 0.05 * ( x + 1 ), 0.05 * ( x + 1 ), 0.05 * ( x + 1 ), 1 ] );
		expect( await meter( px, 7, 5 ) ).toBeCloseTo( reference( px, 7, 5 ), 4 );

	} );

	it( 'strides over large tiles and still matches', async () => {

		const w = 2048, h = 2048;
		const px = image( w, h, ( x, y ) => {

			const l = 0.01 + 0.5 * ( ( x * 7 + y * 13 ) % 97 ) / 97;
			return [ l, l, l, 1 ];

		} );
		expect( await meter( px, w, h ) ).toBeCloseTo( reference( px, w, h, { stride: 2 } ), 4 );

	} );

	it( 'takes luminance in the working space', async () => {

		// Linear Rec.709 → ACEScg (AP1); AP1's luminance row is ( 0.2722, 0.6741, 0.0537 ).
		setWorkingMatrix( [ 0.6131, 0.3395, 0.0474, 0.0702, 0.9164, 0.0134, 0.0206, 0.1096, 0.8698 ], 'ACEScg' );
		try {

			const px = image( 128, 128, () => [ 0, 0.25, 0, 1 ] );
			expect( await meter( px, 128, 128 ) ).toBeCloseTo( reference( px, 128, 128, { weights: [ 0.2722, 0.6741, 0.0537 ] } ), 2 );

		} finally {

			setWorkingMatrix( null );

		}

	} );

} );
