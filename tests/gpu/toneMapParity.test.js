/**
 * `ToneMapGPU.js` is a second implementation of `toneMapToRGBA8` and must stay bug-compatible with
 * it, rounding included. Every registered curve, including a table-backed OCIO view, runs through
 * both over the same HDR spread.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataUtils } from 'three';
import { describeGPU, createRenderer, gpuAvailable } from './gpu.js';
import { PackedToneMapper } from '@/core/Processor/ToneMapGPU.js';
import { toneMapToRGBA8, TONE_MAP_FNS, SRGB_GAMMA, applySaturation, effectiveExposure, isOutputEncoded } from '@/core/Processor/ToneMapCPU.js';
import { countTableTransforms, listViewTransforms } from '@/core/Color/ViewTransforms.js';
import { ColorManagement } from '@/core/Color/ColorManagement.js';
import { configureAssets } from '@/core/AssetConfig.js';
import { UPSCALE_GATES } from '../../bench/runner/config.js';

let ocio = true;
try {

	await import( '@bb-studio/ocio' );

} catch {

	ocio = false;

}

// Before the curves are listed, so the baked view is one of them.
if ( ocio && gpuAvailable ) {

	configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } );
	const cm = new ColorManagement();
	const config = await cm.loadConfig( { builtin: 'ocio://cg-config-v4.0.0_aces-v2.0_ocio-v2.5', registerViews: false } );
	cm.setView( { display: config.defaultDisplay, view: config.defaultViews[ config.defaultDisplay ] } );

}

const CURVES = listViewTransforms().map( t => [ t.name, t.id ] );

const VALUES = [
	0, 1e-5, 0.0012, 0.0031308, 0.004, 0.01, 0.05, 0.08, 0.18, 0.3, 0.5, 0.76, 0.9,
	1, 1.5, 2, 4, 8, 16, 64, 1000,
];

// Colours, not just greys: AgX and Neutral mix channels. The negative entry exercises the max(0)
// three.js applies before the curve.
const PIXELS = VALUES.flatMap( v => [
	[ v, v, v ], [ v, v * 0.25, 0 ], [ 0, v * 0.5, v ], [ v, - v * 0.1, v * 0.7 ],
] );

const GRADES = [[ 1, 1 ], [ 2, 1 ], [ 0.5, 1.2 ], [ 1.5, 0.6 ]];

const MAX_DIFFERING = 0.02;

// Once every group has run: the OCIO view has to stay registered for each of them.
afterAll( () => ColorManagement.resetAll() );

// A tenth of an 8-bit level.
const MAX_PLANAR_DELTA = 0.1 / 255;

describeGPU( 'GPU tone map against ToneMapCPU', () => {

	let renderer, mapper, src;
	const linear = new Float32Array( PIXELS.length * 4 );

	beforeAll( async () => {

		renderer = await createRenderer();
		const device = renderer.backend.device;

		// The GPU reads half floats, so the CPU side gets the same rounded values.
		const halves = new Uint16Array( PIXELS.length * 4 );
		PIXELS.forEach( ( rgb, i ) => {

			for ( let c = 0; c < 3; c ++ ) {

				halves[ i * 4 + c ] = DataUtils.toHalfFloat( rgb[ c ] );
				linear[ i * 4 + c ] = DataUtils.fromHalfFloat( halves[ i * 4 + c ] );

			}

			halves[ i * 4 + 3 ] = 0x3c00;
			linear[ i * 4 + 3 ] = 1;

		} );

		src = device.createBuffer( { size: halves.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST } );
		device.queue.writeBuffer( src, 0, halves );

		mapper = new PackedToneMapper( device );
		mapper.ensureSize( PIXELS.length, 1 );

	} );

	afterAll( () => {

		mapper?.dispose();
		src?.destroy();
		renderer?.dispose();

	} );

	it.runIf( ocio )( 'covers a table-backed view', () => {

		expect( countTableTransforms() ).toBeGreaterThan( 0 );

	} );

	it.each( CURVES )( '%s', async ( name, toneMapping ) => {

		for ( const [ exposure, saturation ] of GRADES ) {

			const gpu = await mapper.toRGBA8( src, { exposure, toneMapping, saturation } );
			const cpu = toneMapToRGBA8( linear, { exposure, toneMapping, saturation } );

			let worst = 0, at = 0, differing = 0;
			for ( let i = 0; i < gpu.length; i ++ ) {

				const d = Math.abs( gpu[ i ] - cpu[ i ] );
				if ( d ) differing ++;
				if ( d > worst ) [ worst, at ] = [ d, i ];

			}

			const grade = `exposure ${exposure}, saturation ${saturation}`;
			expect( worst, `${grade}, pixel ${PIXELS[ at >> 2 ]}` ).toBeLessThanOrEqual( UPSCALE_GATES.maxToneMapDelta );

			// Float noise flips the odd byte (1 in 252 measured); a rounding shift moves most of them,
			// all within one level.
			expect( differing / gpu.length, grade ).toBeLessThanOrEqual( MAX_DIFFERING );

		}

	} );

} );

// renderToBuffer's readback: full float input from a texture, alpha kept.
describeGPU( 'GPU tone map from a float texture against ToneMapCPU', () => {

	let renderer, mapper, texture;
	const linear = new Float32Array( PIXELS.length * 4 );

	beforeAll( async () => {

		renderer = await createRenderer();
		const device = renderer.backend.device;

		PIXELS.forEach( ( rgb, i ) => {

			linear.set( rgb, i * 4 );
			linear[ i * 4 + 3 ] = [ 0, 0.25, 0.5, 0.998, 1 ][ i % 5 ];

		} );

		texture = device.createTexture( { size: [ PIXELS.length, 1 ], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST } );
		device.queue.writeTexture( { texture }, linear, { bytesPerRow: PIXELS.length * 16 }, [ PIXELS.length, 1 ] );

		mapper = new PackedToneMapper( device, 'test:texture-tonemap', { input: 'texture' } );
		mapper.ensureSize( PIXELS.length, 1 );

	} );

	afterAll( () => {

		mapper?.dispose();
		texture?.destroy();
		renderer?.dispose();

	} );

	it.each( CURVES )( '%s, alpha kept', async ( name, toneMapping ) => {

		for ( const [ exposure, saturation ] of GRADES ) {

			const tone = { exposure, toneMapping, saturation, preserveAlpha: true };
			const gpu = await mapper.toRGBA8( texture, tone );
			const cpu = toneMapToRGBA8( linear, tone );

			let worst = 0, differing = 0;
			for ( let i = 0; i < gpu.length; i ++ ) {

				const d = Math.abs( gpu[ i ] - cpu[ i ] );
				if ( d ) differing ++;
				worst = Math.max( worst, d );

			}

			expect( worst, `exposure ${exposure}, saturation ${saturation}` ).toBeLessThanOrEqual( UPSCALE_GATES.maxToneMapDelta );
			expect( differing / gpu.length ).toBeLessThanOrEqual( MAX_DIFFERING );
			for ( let i = 3; i < gpu.length; i += 4 ) expect( gpu[ i ] ).toBe( cpu[ i ] );

		}

	} );

} );

// The AI upscaler's network input, as AIUpscaler computed it in JavaScript before the planes moved
// to the card: a 2.2 power, not the sRGB curve, and no 8-bit step.
function upscalerInput( linear, { exposure, toneMapping, saturation } ) {

	const curve = TONE_MAP_FNS.get( toneMapping );
	const gain = effectiveExposure( exposure, toneMapping );
	const encode = isOutputEncoded( toneMapping ) ? c => Math.min( Math.max( c, 0 ), 1 ) : c => Math.pow( c, SRGB_GAMMA );
	const n = linear.length / 4, out = new Float32Array( n * 4 ), rgb = [ 0, 0, 0 ];

	for ( let i = 0; i < n; i ++ ) {

		rgb[ 0 ] = linear[ i * 4 ] * gain; rgb[ 1 ] = linear[ i * 4 + 1 ] * gain; rgb[ 2 ] = linear[ i * 4 + 2 ] * gain;
		applySaturation( rgb, saturation );
		curve( rgb[ 0 ], rgb[ 1 ], rgb[ 2 ], 1.0, rgb );
		for ( let c = 0; c < 3; c ++ ) out[ c * n + i ] = encode( rgb[ c ] );
		out[ 3 * n + i ] = linear[ i * 4 + 3 ];

	}

	return out;

}

describeGPU( 'GPU planar tone map against the upscaler\'s old JavaScript', () => {

	let renderer, mapper, texture;
	const linear = new Float32Array( PIXELS.length * 4 );

	beforeAll( async () => {

		renderer = await createRenderer();
		const device = renderer.backend.device;
		PIXELS.forEach( ( rgb, i ) => {

			linear.set( rgb, i * 4 );
			linear[ i * 4 + 3 ] = [ 0, 0.25, 0.5, 0.998, 1 ][ i % 5 ];

		} );

		texture = device.createTexture( { size: [ PIXELS.length, 1 ], format: 'rgba32float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST } );
		device.queue.writeTexture( { texture }, linear, { bytesPerRow: PIXELS.length * 16 }, [ PIXELS.length, 1 ] );
		mapper = new PackedToneMapper( device, 'test:planar-tonemap', { input: 'texture', output: 'planar' } );
		mapper.ensureSize( PIXELS.length, 1 );

	} );

	afterAll( () => {

		mapper?.dispose();
		texture?.destroy();
		renderer?.dispose();

	} );

	it.each( CURVES )( '%s', async ( name, toneMapping ) => {

		for ( const [ exposure, saturation ] of GRADES ) {

			const tone = { exposure, toneMapping, saturation };
			const gpu = await mapper.toPlanar( texture, tone );
			const cpu = upscalerInput( linear, tone );

			let worst = 0;
			for ( let i = 0; i < gpu.length; i ++ ) worst = Math.max( worst, Math.abs( gpu[ i ] - cpu[ i ] ) );
			expect( worst, `exposure ${exposure}, saturation ${saturation}` ).toBeLessThan( MAX_PLANAR_DELTA );

		}

	} );

} );
