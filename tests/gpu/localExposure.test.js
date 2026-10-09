/**
 * Local exposure: the grid built on the GPU against the same build in JavaScript, and the gain's three
 * twins (the compositor's TSL, the readback's WGSL, the CPU's JavaScript) against each other.
 */

import { beforeAll, expect, it } from 'vitest';
import { DataTexture, RGBAFormat, FloatType } from 'three';
import { vec2, vec3 } from 'three/tsl';
import { describeGPU, createRenderer, evaluate } from './gpu.js';
import { LocalExposure, localExposureGain } from '@/core/Stages/LocalExposure.js';
import { PackedToneMapper } from '@/core/Processor/ToneMapGPU.js';
import { toneMapToRGBA8 } from '@/core/Processor/ToneMapCPU.js';

const W = 384, H = 256;

function image( fn ) {

	const px = new Float32Array( W * H * 4 );
	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) px.set( [ ...fn( x, y ), 1 ], ( y * W + x ) * 4 );
	const t = new DataTexture( px, W, H, RGBAFormat, FloatType );
	t.needsUpdate = true;
	return { px, texture: t };

}

// A room: mid-grey walls, a window four stops brighter on the left, a dark corner, a little bright detail in the window.
const room = ( x, y ) => {

	const window = x < 160 && y < 160;
	const corner = x > 320 && y > 200;
	const detail = window && ( x % 16 < 2 );
	const l = detail ? 12 : window ? 3 : corner ? 0.01 : 0.18;
	return [ l, l * 0.95, l * 0.9 ];

};

const Y = ( r, g, b ) => r * 0.2126 + g * 0.7152 + b * 0.0722;

// The grid as the kernel builds it, rounding included.
function referenceGrid( px, logExposure ) {

	const cellsX = Math.ceil( W / 128 ), cellsY = Math.ceil( H / 128 );
	const grid = new Float64Array( cellsX * cellsY * 32 * 2 );
	const sums = new Float64Array( cellsX * cellsY * 32 ), weights = new Float64Array( cellsX * cellsY * 32 );
	const lumAt = ( x, y ) => {

		const i = ( y * W + x ) * 4; return Math.fround( Y( px[ i ], px[ i + 1 ], px[ i + 2 ] ) );

	};

	for ( let y = 0; y < H; y += 2 ) for ( let x = 0; x < W; x += 2 ) {

		const x1 = Math.min( x + 1, W - 1 ), y1 = Math.min( y + 1, H - 1 );
		const lum = ( lumAt( x, y ) + lumAt( x1, y ) + lumAt( x, y1 ) + lumAt( x1, y1 ) ) * 0.25;
		const logL = Math.min( Math.max( Math.log2( Math.max( lum, 2 ** - 24 ) ), - 40 ), 40 );
		const f = Math.min( Math.max( ( logL + logExposure + 16 ) / 32, 0 ), 1 ) * 31;
		const b0 = Math.min( Math.floor( f ), 31 ), b1 = Math.min( b0 + 1, 31 ), w1 = f - Math.floor( f ), w0 = 1 - w1;
		const c = ( Math.floor( y / 128 ) * cellsX + Math.floor( x / 128 ) ) * 32;
		const level = ( logL + 40 ) * 256;
		sums[ c + b0 ] += Math.floor( level * w0 + 0.5 ); weights[ c + b0 ] += Math.floor( w0 * 256 + 0.5 );
		sums[ c + b1 ] += Math.floor( level * w1 + 0.5 ); weights[ c + b1 ] += Math.floor( w1 * 256 + 0.5 );

	}

	for ( let i = 0; i < sums.length; i ++ ) {

		const w = weights[ i ] / 256;
		grid[ i * 2 ] = ( sums[ i ] / 256 - 40 * w ) / 4096;
		grid[ i * 2 + 1 ] = w / 4096;

	}

	return grid;

}

describeGPU( 'local exposure', () => {

	let renderer, stage, scene, grid, blur;

	beforeAll( async () => {

		renderer = await createRenderer();
		scene = image( room );
		stage = new LocalExposure( renderer, { enabled: true, highlightContrast: 0.5, shadowContrast: 1, detailStrength: 1 } );
		stage.build( { getTexture: () => scene.texture, getState: () => 0 } );
		grid = new Float32Array( await renderer.getArrayBufferAsync( stage._grid.value ) );
		blur = new Float32Array( await renderer.getArrayBufferAsync( stage._blur.value ) );

	} );

	it( 'builds the grid the kernel is written to build', () => {

		const expected = referenceGrid( scene.px, 0 );
		for ( let i = 0; i < expected.length; i ++ ) expect( grid[ i ] ).toBeCloseTo( expected[ i ], 4 );

	} );

	it( 'darkens a bright window toward middle grey and leaves the grey walls and the detail', () => {

		const p = stage._params;
		const at = ( x, y ) => {

			const [ r, g, b ] = room( x, y ); return localExposureGain( p, grid, blur, ( x + 0.5 ) / W, ( y + 0.5 ) / H, Y( r, g, b ), 0 );

		};

		const windowGain = at( 80, 80 ), wallGain = at( 260, 100 ), detailGain = at( 80 + 16 * 3, 80 );
		expect( windowGain ).toBeLessThan( 0.5 );
		expect( Math.abs( Math.log2( wallGain ) ) ).toBeLessThan( 0.1 );
		// The detail keeps its contrast to the window around it.
		expect( Math.log2( detailGain / windowGain ) ).toBeCloseTo( 0, 0 );

	} );

	it( 'changes nothing with every contrast at 1', () => {

		const p = stage._params.slice();
		p[ 9 ] = p[ 10 ] = p[ 11 ] = 1;
		for ( const [ x, y ] of [[ 80, 80 ], [ 260, 100 ], [ 350, 230 ], [ 5, 250 ]] ) {

			const [ r, g, b ] = room( x, y );
			expect( localExposureGain( p, grid, blur, ( x + 0.5 ) / W, ( y + 0.5 ) / H, Y( r, g, b ), 0 ) ).toBeCloseTo( 1, 6 );

		}

	} );

	it( 'gives the same gain in the compositor\'s TSL as in JavaScript', async () => {

		const n = 64, uvs = new Float32Array( n * 2 ), rgbs = new Float32Array( n * 3 ), expected = [];
		for ( let i = 0; i < n; i ++ ) {

			const x = ( i * 37 ) % W, y = ( i * 53 ) % H, [ r, g, b ] = room( x, y );
			uvs.set( [ ( x + 0.5 ) / W, ( y + 0.5 ) / H ], i * 2 );
			rgbs.set( [ r, g, b ], i * 3 );
			expected.push( localExposureGain( stage._params, grid, blur, ( x + 0.5 ) / W, ( y + 0.5 ) / H, Y( r, g, b ), 0 ) );

		}

		const out = new Float32Array( await evaluate( renderer, n, { uv: [ uvs, 'vec2' ], rgb: [ rgbs, 'vec3' ] }, 'float',
			( { uv, rgb } ) => stage.gainNode( vec3( rgb ), vec2( uv ) ) ) );
		for ( let i = 0; i < n; i ++ ) expect( Math.log2( out[ i ] ) ).toBeCloseTo( Math.log2( expected[ i ] ), 3 );

	} );

	it( 'tone-maps a readback on the GPU as the CPU does', async () => {

		const mapper = new PackedToneMapper( renderer.backend.device, 'test-tonemap', { input: 'texture' } );
		mapper.ensureSize( W, H );
		const gain = stage.toneGain();
		const tone = { exposure: 1.5, toneMapping: 0, saturation: 1 };
		const gpu = await mapper.toRGBA8( renderer.backend.get( scene.texture ).texture, { ...tone, gain } );
		const fn = await gain.cpu();
		const cpu = toneMapToRGBA8( scene.px, { ...tone, pixelGain: { fn, width: W, height: H } } );
		let worst = 0;
		for ( let i = 0; i < cpu.length; i ++ ) worst = Math.max( worst, Math.abs( cpu[ i ] - gpu[ i ] ) );
		expect( worst ).toBeLessThanOrEqual( 1 );
		mapper.dispose();

	} );

} );
