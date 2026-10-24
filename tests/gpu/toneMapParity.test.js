/**
 * `ToneMapGPU.js` is a second implementation of `toneMapToRGBA8` and must stay bug-compatible with
 * it, rounding included. Every registered curve, including a table-backed OCIO view, runs through
 * both over the same HDR spread.
 */

import { afterAll, beforeAll, expect, it } from 'vitest';
import { DataUtils } from 'three';
import { vec4, float } from 'three/tsl';
import { describeGPU, createRenderer, gpuAvailable, evaluate } from './gpu.js';
import { PackedToneMapper } from '@/core/Processor/ToneMapGPU.js';
import { toneMapToRGBA8, toneMapToRGBA16, toneMapToDisplayLinear, TONE_MAP_FNS, SRGB_GAMMA, applySaturation, effectiveExposure, isOutputEncoded } from '@/core/Processor/ToneMapCPU.js';
import { countTableTransforms, listViewTransforms, addViewTransform, getViewTransform } from '@/core/Color/ViewTransforms.js';
import { buildBakedView, DEFAULT_MIN_EV, DEFAULT_MAX_EV } from '@/core/Color/OcioViews.js';
import { packHalf, unshape, curveSlices, encodeExtended } from '@/core/Color/LutBake.js';
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

	// A view split at a lookup, as Blender's False Color bakes: the cube holds a grey value, the curve after it the colour.
	const size = 9, n = 100;
	const table = new Float32Array( ( size ** 3 + curveSlices( n, size ) * size * size ) * 4 );
	for ( let i = 0; i < size ** 3; i ++ ) {

		const lum = [ i % size, Math.floor( i / size ) % size, Math.floor( i / size / size ) ].map( k => unshape( k, size, DEFAULT_MIN_EV, DEFAULT_MAX_EV ) ).reduce( ( a, v ) => a + v ) / 3;
		const t = Math.min( 1, Math.max( 0, ( Math.log2( lum + 1e-6 ) + 12 ) / 16 ) );
		table.set( [ t, t, t, 1 ], i * 4 );

	}

	for ( let i = 0; i < n; i ++ ) table.set( [ i / ( n - 1 ), ( i % 10 ) / 9, 1 - i / ( n - 1 ), 1 ], ( size ** 3 + i ) * 4 );
	const shape = { configId: 'test', display: 'sRGB', source: 'test', size, minEv: DEFAULT_MIN_EV, maxEv: DEFAULT_MAX_EV };
	addViewTransform( buildBakedView( { ...shape, name: 'Split at a lookup', view: 'split', data: packHalf( table ), curve: { n, lo: 0, hi: 1 } } ) );

	// A table of light, encoded after the lookup (a converted display), negative light included.
	const light = new Float32Array( size ** 3 * 4 );
	for ( let i = 0; i < size ** 3; i ++ ) {

		const [ r, g, b ] = [ i % size, Math.floor( i / size ) % size, Math.floor( i / size / size ) ].map( k => unshape( k, size, DEFAULT_MIN_EV, DEFAULT_MAX_EV ) );
		light.set( [ 1.2 * r - 0.2 * g, g, 0.9 * b + 0.1 * r, 1 ], i * 4 );

	}

	addViewTransform( buildBakedView( { ...shape, name: 'Light, encoded after', view: 'light', data: packHalf( light ), linear: true } ) );

	// The same light clipped at 0 in another display's primaries after the lookup (Rec.709 canvas, Rec.2020 display),
	// stored as light and stored encoded.
	const clip = {
		toDisplay: [ 0.6274, 0.3293, 0.0433, 0.0691, 0.9195, 0.0114, 0.0164, 0.0880, 0.8956 ],
		fromDisplay: [ 1.6605, - 0.5876, - 0.0728, - 0.1246, 1.1329, - 0.0083, - 0.0182, - 0.1006, 1.1187 ],
	};
	const encoded = light.map( ( v, i ) => ( i % 4 === 3 ? v : encodeExtended( v ) ) );
	addViewTransform( buildBakedView( { ...shape, name: 'Light, clipped after', view: 'clipped', data: packHalf( light ), linear: true, clip } ) );
	addViewTransform( buildBakedView( { ...shape, name: 'Encoded, clipped after', view: 'clipped-encoded', data: packHalf( encoded ), clip } ) );

	// On another space's axes (ACEScg → Rec.709 before the shaper), negatives there clamped.
	const pre = [ 1.7049, - 0.6217, - 0.0832, - 0.1301, 1.1407, - 0.0106, - 0.0240, - 0.1290, 1.1530 ];
	addViewTransform( buildBakedView( { ...shape, name: 'Encoded, on Rec.709 axes', view: 'pre', data: packHalf( encoded ), pre } ) );
	addViewTransform( buildBakedView( { ...shape, name: 'Light, clipped, on Rec.709 axes', view: 'pre-clipped', data: packHalf( light ), linear: true, clip, pre } ) );

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

// A tenth of an 8-bit level, in 16-bit levels.
const MAX_DELTA_16 = 26;

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

// A 16-bit PNG's readback: the same picture, finer.
describeGPU( '16-bit GPU tone map against ToneMapCPU', () => {

	let renderer, mapper, mapper8, mapperLight, texture;
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
		mapper = new PackedToneMapper( device, 'test:tonemap16', { input: 'texture', output: 'rgba16' } );
		mapper.ensureSize( PIXELS.length, 1 );
		mapper8 = new PackedToneMapper( device, 'test:tonemap8', { input: 'texture' } );
		mapper8.ensureSize( PIXELS.length, 1 );
		mapperLight = new PackedToneMapper( device, 'test:tonemap-light', { input: 'texture', output: 'displayLinear' } );
		mapperLight.ensureSize( PIXELS.length, 1 );

	} );

	afterAll( () => {

		mapper?.dispose();
		mapper8?.dispose();
		mapperLight?.dispose();
		texture?.destroy();
		renderer?.dispose();

	} );

	it.each( CURVES )( '%s', async ( name, toneMapping ) => {

		for ( const [ exposure, saturation ] of GRADES ) {

			const tone = { exposure, toneMapping, saturation, preserveAlpha: true };
			const gpu = await mapper.toRGBA16( texture, tone );
			const cpu = toneMapToRGBA16( linear, tone );
			const bytes = await mapper8.toRGBA8( texture, tone );

			let worst = 0, coarse = 0;
			for ( let i = 0; i < gpu.length; i ++ ) {

				worst = Math.max( worst, Math.abs( gpu[ i ] - cpu[ i ] ) );
				coarse = Math.max( coarse, Math.abs( gpu[ i ] / 257 - bytes[ i ] ) );

			}

			const grade = `exposure ${exposure}, saturation ${saturation}`;
			expect( worst, grade ).toBeLessThanOrEqual( MAX_DELTA_16 );
			expect( coarse, grade ).toBeLessThanOrEqual( 1 );

		}

	} );

	// An 'As on screen' EXR: the picture's light, which a viewer's sRGB curve turns back into the picture.
	it.each( CURVES )( '%s, as display light', async ( name, toneMapping ) => {

		const encode = v => ( v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow( v, 1 / 2.4 ) - 0.055 );
		for ( const [ exposure, saturation ] of GRADES ) {

			const tone = { exposure, toneMapping, saturation, preserveAlpha: true };
			const gpu = await mapperLight.toDisplayLinear( texture, tone );
			const cpu = toneMapToDisplayLinear( linear, tone );
			const words = await mapper.toRGBA16( texture, tone );

			let worst = 0, encoded = 0;
			for ( let i = 0; i < gpu.length; i ++ ) {

				worst = Math.max( worst, Math.abs( encode( gpu[ i ] ) - encode( cpu[ i ] ) ) );
				if ( i % 4 !== 3 ) encoded = Math.max( encoded, Math.abs( encode( gpu[ i ] ) * 65535 - words[ i ] ) );

			}

			const grade = `exposure ${exposure}, saturation ${saturation}`;
			expect( worst * 65535, grade ).toBeLessThanOrEqual( MAX_DELTA_16 );
			expect( encoded, grade ).toBeLessThanOrEqual( 1 );

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

// The canvas runs a table view through its TSL node, not this WGSL: the same lookup, the third implementation.
describeGPU( 'the canvas lookup against the CPU sampler', () => {

	let renderer;
	beforeAll( async () => {

		renderer = await createRenderer();

	} );

	afterAll( () => renderer?.dispose() );

	const TABLES = CURVES.filter( ( [ , id ] ) => getViewTransform( id )?.source === 'ocio' );

	it.each( TABLES )( '%s', async ( name, id ) => {

		const view = getViewTransform( id );
		// three.js clamps a colour at 0 before the view, so the canvas never sees a negative input.
		const colours = PIXELS.map( p => p.map( v => Math.max( 0, v ) ) );
		const input = new Float32Array( colours.flatMap( c => [ ...c, 1 ] ) );
		const shown = new Float32Array( await evaluate( renderer, colours.length, { c: [ input, 'vec4' ] }, 'vec4', ( { c } ) => vec4( view.tsl( c.xyz, float( 1 ) ), 1 ) ) );

		const out = [ 0, 0, 0 ];
		let worst = 0, at = 0;
		colours.forEach( ( c, i ) => {

			view.cpu( c[ 0 ], c[ 1 ], c[ 2 ], 1, out );
			for ( let k = 0; k < 3; k ++ ) {

				const d = Math.abs( shown[ i * 4 + k ] - out[ k ] );
				if ( d > worst ) [ worst, at ] = [ d, i ];

			}

		} );
		// A tenth of an 8-bit level.
		expect( worst, `${colours[ at ]}` ).toBeLessThan( 0.1 / 255 );

	} );

} );
