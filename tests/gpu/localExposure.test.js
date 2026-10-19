/**
 * Local exposure: the grid built on the GPU against the same build in JavaScript, and the gain's three
 * twins (the compositor's TSL, the readback's WGSL, the CPU's JavaScript) against each other.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { DataTexture, DataUtils, RGBAFormat, FloatType, AgXToneMapping } from 'three';
import { vec2, vec3 } from 'three/tsl';
import { createRenderer, evaluate } from './gpu.js';
import { LocalExposure, localExposureGain } from '@/core/Stages/LocalExposure.js';
import { PackedToneMapper } from '@/core/Processor/ToneMapGPU.js';
import { toneMapToRGBA8 } from '@/core/Processor/ToneMapCPU.js';

const W = 384, H = 256;

function image( fn, w = W, h = H ) {

	const px = new Float32Array( w * h * 4 );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) {

		const c = fn( x, y );
		px.set( c.length === 4 ? c : [ ...c, 1 ], ( y * w + x ) * 4 );

	}

	const t = new DataTexture( px, w, h, RGBAFormat, FloatType );
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

describe( 'local exposure', () => {

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

	// Read back as the shaders see them: f32 in, f32 out.
	async function built( img, backdrop = 'environment' ) {

		const s = new LocalExposure( renderer, { enabled: true, highlightContrast: 0.5, shadowContrast: 1, detailStrength: 1 } );
		s.build( { getTexture: () => img.texture, getState: ( key ) => ( key === 'pathtracer:backdrop' ? backdrop : 0 ) } );
		return {
			stage: s,
			grid: new Float32Array( await renderer.getArrayBufferAsync( s._grid.value ) ),
			blur: new Float32Array( await renderer.getArrayBufferAsync( s._blur.value ) ),
		};

	}

	it( 'leaves NaN and infinite pixels out of the grid and the blurred picture', async () => {

		// One of each in the grey wall, the window and the dark corner.
		const bad = new Set( [ '200,40', '60,60', '340,220' ] );
		const worse = new Set( [ '201,40', '61,60', '341,220' ] );
		const dirty = await built( image( ( x, y ) => bad.has( `${x},${y}` ) ? [ NaN, NaN, NaN ]
			: worse.has( `${x},${y}` ) ? [ Infinity, Infinity, Infinity ] : room( x, y ) ) );

		expect( dirty.grid.every( Number.isFinite ) ).toBe( true );
		expect( dirty.blur.every( Number.isFinite ) ).toBe( true );
		// An infinite pixel read as 2^40 would have raised its 32×32 block by ~25 stops, and the blur would carry it.
		for ( let i = 0; i < blur.length; i ++ ) expect( Math.abs( dirty.blur[ i ] - blur[ i ] ) ).toBeLessThan( 0.01 );

	} );

	it( 'gives an infinite pixel a gain, not NaN, in JavaScript and in TSL', async () => {

		const p = stage._params;
		expect( Number.isFinite( localExposureGain( p, grid, blur, 0.3, 0.3, Infinity, 0 ) ) ).toBe( true );
		const out = new Float32Array( await evaluate( renderer, 1, { uv: [ Float32Array.of( 0.3, 0.3 ), 'vec2' ], rgb: [ Float32Array.of( Infinity, Infinity, Infinity ), 'vec3' ] },
			'float', ( { uv, rgb } ) => stage.gainNode( vec3( rgb ), vec2( uv ) ) ) );
		expect( Number.isFinite( out[ 0 ] ) ).toBe( true );

	} );

	// The room with its right third a backdrop the camera saw past (alpha 0), dark or bright.
	// A window onto it at the bottom left is partly covered and carries its colour.
	const withBackdrop = ( level ) => image( ( x, y ) => {

		if ( x >= 256 ) return [ level, level, level, 0 ];
		if ( x < 64 && y >= 192 ) return [ 0.5 * level + 0.05, 0.5 * level + 0.05, 0.5 * level + 0.05, 0.5 ];
		return room( x, y );

	} );

	it( 'builds from the scene alone while the backdrop is a solid colour', async () => {

		const dark = await built( withBackdrop( 0.01 ), 'color' ), bright = await built( withBackdrop( 2 ), 'color' );
		for ( let i = 0; i < dark.grid.length; i ++ ) expect( bright.grid[ i ] ).toBe( dark.grid[ i ] );
		for ( let i = 0; i < dark.blur.length; i ++ ) expect( bright.blur[ i ] ).toBeCloseTo( dark.blur[ i ], 5 );
		expect( dark.blur.every( Number.isFinite ) ).toBe( true );

		// The room's gain, the window included, is the one it takes with no backdrop in the picture at all.
		const gainAt = ( b, x, y ) => localExposureGain( b.stage._params, b.grid, b.blur, ( x + 0.5 ) / W, ( y + 0.5 ) / H, Y( ...room( x, y ) ), 0 );
		for ( const [ x, y ] of [[ 40, 40 ], [ 200, 100 ], [ 240, 220 ]] ) expect( gainAt( bright, x, y ) ).toBeCloseTo( gainAt( dark, x, y ), 4 );

		// The sky is part of the scene: an environment backdrop is built from as before.
		const darkSky = await built( withBackdrop( 0.01 ) ), brightSky = await built( withBackdrop( 2 ) );
		expect( Math.abs( gainAt( brightSky, 240, 220 ) / gainAt( darkSky, 240, 220 ) - 1 ) ).toBeGreaterThan( 0.01 );

	} );

	it( 'holds a solid backdrop at its own gain on the GPU as on the CPU', async () => {

		const scene = withBackdrop( 0.3 );
		const mapper = new PackedToneMapper( renderer.backend.device, 'test-tonemap', { input: 'texture' } );
		mapper.ensureSize( W, H );
		const tone = { exposure: 0.25, toneMapping: AgXToneMapping, saturation: 1 };
		const local = ( await built( scene, 'color' ) ).stage.toneGain();
		for ( const gain of [ { backdrop: 4 }, { ...local, backdrop: 4 } ] ) {

			const gpu = await mapper.toRGBA8( renderer.backend.get( scene.texture ).texture, { ...tone, gain } );
			const fn = gain.cpu ? await gain.cpu() : null;
			const cpu = toneMapToRGBA8( scene.px, { ...tone, pixelGain: { fn, width: W, height: H, backdrop: gain.backdrop } } );
			let worst = 0;
			for ( let i = 0; i < cpu.length; i ++ ) worst = Math.max( worst, Math.abs( cpu[ i ] - gpu[ i ] ) );
			expect( worst ).toBeLessThanOrEqual( 1 );

			// The backdrop shows as at exposure 1 (0.25 × 4), whatever gain the room takes.
			const held = toneMapToRGBA8( Float32Array.of( 0.3, 0.3, 0.3, 1 ), { ...tone, exposure: 1 } );
			const at = ( H / 2 * W + 300 ) * 4;
			expect( Math.abs( gpu[ at ] - held[ 0 ] ) ).toBeLessThanOrEqual( 1 );

		}

		mapper.dispose();

	} );

	it( 'blurs a strip far wider than tall without leaning on its first row', async () => {

		// 2048×64: the vertical pass reaches 32 blurred texels across two. Top half at 1, bottom at 1/16: four stops apart.
		const strip = await built( image( ( x, y ) => {

			const l = y < 32 ? 1 : 1 / 16;
			return [ l, l, l ];

		}, 2048, 64 ) );

		const blurW = 64;
		for ( const row of [ 0, 1 ] ) expect( strip.blur[ row * blurW + 32 ] ).toBeCloseTo( - 2, 1 );

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

	it( 'tone-maps on another device exactly as on its own', async () => {

		const half = Uint16Array.from( scene.px, v => DataUtils.toHalfFloat( v ) );
		const run = async device => {

			const src = device.createBuffer( { size: half.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST } );
			device.queue.writeBuffer( src, 0, half );
			const mapper = new PackedToneMapper( device, 'test-tonemap' );
			mapper.ensureSize( W, H );
			const out = await mapper.toRGBA8( src, { exposure: 1.5, toneMapping: 0, saturation: 1, gain: stage.toneGain() } );
			mapper.dispose();
			src.destroy();
			return out;

		};

		const other = await ( await navigator.gpu.requestAdapter() ).requestDevice();
		const own = await run( renderer.backend.device );
		const moved = await run( other );
		other.destroy();

		let differing = 0;
		for ( let i = 0; i < own.length; i ++ ) if ( own[ i ] !== moved[ i ] ) differing ++;
		expect( differing ).toBe( 0 );

	} );

} );
