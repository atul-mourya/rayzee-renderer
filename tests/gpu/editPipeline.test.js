/**
 * The Results page's edit stack on the GPU (`EditPipeline`), drawn into a target and read back: the Adjust sliders as
 * the WebGL editor before it had them, the CPU twins in `edits.js` (`adjustColor`, `lookColor`, `sourceTransform`),
 * nothing changed at the defaults, and the detail and effect passes doing what they say.
 */

import { it, expect, beforeAll, afterAll } from 'vitest';
import { DataTexture, DataUtils, FloatType, HalfFloatType, LinearFilter, NearestFilter, RGBAFormat, RenderTarget } from 'three';
import { describeGPU, createRenderer } from './gpu.js';
import { readPixels } from '@/core/output/TextureReadback.js';
import { EditPipeline } from '@/lib/ImageProcessor.js';
import { adjustColor, flipGeometry, lookColor, lookTable, normaliseEdits, outputSize, sourceTransform, turnQuarter } from '@/lib/edits.js';

// BrightnessContrastShader, then ColorAdjustmentShader: the WebGL editor's GLSL, which saved renders were edited with.
function legacyEdit( c, p ) {

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

const half = v => DataUtils.fromHalfFloat( DataUtils.toHalfFloat( v ) );

// Colours from dark to white, greys and saturated, then past white and outside the gamut; held at half precision, as
// the picture is.
const IN_RANGE = [];
for ( const v of [ 0.15, 0.3, 0.5, 0.7, 0.85, 1 ] ) IN_RANGE.push( [ v, v, v ], [ v, v * 0.6, v * 0.2 ], [ v * 0.1, v * 0.8, v ], [ v * 0.9, v * 0.3, v * 0.7 ] );
const BEYOND = [[ 2.5, 2.5, 2.5 ], [ 3.2, 1.4, 0.6 ], [ - 0.08, 0.6, 0.3 ], [ 0.5, - 0.02, 0.9 ]];
const quantise = colours => colours.map( c => c.map( half ) );

const ADJUSTS = [
	{ brightness: 6, contrast: 15, saturation: 30, hue: 40, exposure: 35, gamma: 2.4 },
	{ brightness: - 5, contrast: - 20, saturation: - 60, hue: - 120, exposure: - 50, gamma: 2.0 },
];

describeGPU( 'the Results edits', () => {

	let renderer;
	beforeAll( async () => {

		renderer = await createRenderer();

	} );

	afterAll( () => renderer?.dispose() );

	// A picture `width` wide from rows of colours (top row first), drawn through `edits`; the result's pixels, top row first.
	const run = async ( width, colours, edits, { light = false, alpha = 1, pipeline = new EditPipeline() } = {} ) => {

		const height = colours.length / width;
		const data = new Uint16Array( colours.length * 4 );
		colours.forEach( ( c, i ) => [ ...c, alpha ].forEach( ( v, k ) => ( data[ i * 4 + k ] = DataUtils.toHalfFloat( v ) ) ) );
		const source = new DataTexture( data, width, height, RGBAFormat, HalfFloatType );
		source.minFilter = source.magFilter = LinearFilter;
		source.needsUpdate = true;

		pipeline.set( edits );
		const size = outputSize( normaliseEdits( edits ).geometry, width, height );
		const into = new RenderTarget( size.width, size.height, { type: FloatType, format: RGBAFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter } );
		pipeline.draw( renderer, { texture: source, width, height, light }, into );
		const pixels = await readPixels( renderer, into, size.width, size.height );
		into.dispose();
		source.dispose();
		return { pixels, ...size };

	};

	const colourAt = ( pixels, i ) => [ pixels[ i * 4 ], pixels[ i * 4 + 1 ], pixels[ i * 4 + 2 ] ];

	it.each( ADJUSTS )( 'adjusts a colour up to white as the WebGL editor did (%o)', async adjust => {

		const colours = quantise( IN_RANGE );
		const { pixels } = await run( colours.length, colours, { adjust } );
		colours.forEach( ( c, i ) => {

			const want = legacyEdit( c, adjust ).map( x => Math.min( 1, Math.max( 0, x ) ) );
			const got = colourAt( pixels, i ).map( x => Math.min( 1, Math.max( 0, x ) ) );
			for ( let k = 0; k < 3; k ++ ) expect( Math.abs( got[ k ] - want[ k ] ) * 255, `${c} channel ${k}` ).toBeLessThan( 0.5 );

		} );

	} );

	it.each( ADJUSTS )( 'adjusts every colour as its CPU twin does, past white too (%o)', async adjust => {

		const colours = quantise( [ ...IN_RANGE, ...BEYOND ] );
		const { pixels } = await run( colours.length, colours, { adjust } );
		colours.forEach( ( c, i ) => {

			const want = adjustColor( c, adjust );
			colourAt( pixels, i ).forEach( ( v, k ) => expect( Math.abs( v - want[ k ] ), `${c} channel ${k}` ).toBeLessThan( 2e-3 * Math.max( 1, Math.abs( want[ k ] ) ) ) );

		} );

	} );

	it( 'changes nothing at the defaults, past white and outside the gamut too', async () => {

		const colours = quantise( [ ...IN_RANGE, ...BEYOND ] );
		const { pixels } = await run( colours.length, colours, {} );
		colours.forEach( ( c, i ) => colourAt( pixels, i ).forEach( ( v, k ) => expect( v ).toBeCloseTo( c[ k ], 3 ) ) );

	} );

	it( 'encodes light handed over decoded, as the canvas showed it', async () => {

		const colours = quantise( [[ 0.002, 0.18, 1 ], [ 2.2, 0.5, - 0.01 ]] );
		const { pixels } = await run( 2, colours, {}, { light: true } );
		const encode = x => Math.sign( x ) * ( Math.abs( x ) <= 0.0031308 ? Math.abs( x ) * 12.92 : 1.055 * Math.abs( x ) ** ( 1 / 2.4 ) - 0.055 );
		colours.forEach( ( c, i ) => colourAt( pixels, i ).forEach( ( v, k ) => expect( Math.abs( v - encode( c[ k ] ) ) ).toBeLessThan( 1e-3 * Math.max( 1, Math.abs( v ) ) ) ) );

	} );

	// A picture whose every pixel is its own: red the column, green the row.
	const grid = ( w, h ) => Array.from( { length: w * h }, ( _, i ) => [ ( i % w ) / ( w - 1 ), Math.floor( i / w ) / ( h - 1 ), 0.5 ] );

	it.each( [
		[ 'turned right', g => turnQuarter( g, 1 ) ],
		[ 'turned left twice', g => turnQuarter( turnQuarter( g, - 1 ), - 1 ) ],
		[ 'flipped left to right', g => flipGeometry( g, 'x' ) ],
		[ 'flipped, then turned right', g => turnQuarter( flipGeometry( g, 'x' ), 1 ) ],
		[ 'cropped', g => ( { ...g, crop: { x: 0.25, y: 1 / 3, w: 0.5, h: 2 / 3 } } ) ],
	] )( 'moves each pixel where the geometry says when %s', async ( name, change ) => {

		const W = 8, H = 6;
		const geometry = change( normaliseEdits().geometry );
		const { pixels, width, height } = await run( W, grid( W, H ), { geometry } );
		const m = sourceTransform( geometry, W, H );
		for ( let y = 0; y < height; y ++ ) for ( let x = 0; x < width; x ++ ) {

			const u = ( x + 0.5 ) / width, v = ( y + 0.5 ) / height;
			const sx = Math.floor( ( m[ 0 ] * u + m[ 1 ] * v + m[ 2 ] ) * W ), sy = Math.floor( ( m[ 3 ] * u + m[ 4 ] * v + m[ 5 ] ) * H );
			const got = colourAt( pixels, y * width + x );
			expect( [ Math.round( got[ 0 ] * ( W - 1 ) ), Math.round( got[ 1 ] * ( H - 1 ) ) ], `${name} at ${x}, ${y}` ).toEqual( [ sx, sy ] );

		}

	} );

	it( 'shows the source the right way up', async () => {

		const { pixels } = await run( 4, grid( 4, 3 ), {} );
		expect( colourAt( pixels, 0 ).slice( 0, 2 ) ).toEqual( [ 0, 0 ] );
		expect( colourAt( pixels, 3 )[ 0 ] ).toBeCloseTo( 1, 3 );
		expect( colourAt( pixels, 8 )[ 1 ] ).toBeCloseTo( 1, 3 );

	} );

	it( 'leaves what lies outside the picture transparent while the crop is edited', async () => {

		const pipeline = new EditPipeline();
		const ones = new Uint16Array( 8 * 8 * 4 ).fill( DataUtils.toHalfFloat( 1 ) );
		const source = new DataTexture( ones, 8, 8, RGBAFormat, HalfFloatType );
		source.needsUpdate = true;
		pipeline.set( { geometry: { angle: 30 } }, { editing: true } );
		const into = new RenderTarget( 8, 8, { type: FloatType, format: RGBAFormat, depthBuffer: false } );
		pipeline.draw( renderer, { texture: source, width: 8, height: 8, light: false }, into );
		const pixels = await readPixels( renderer, into, 8, 8 );
		expect( pixels[ 3 ] ).toBe( 0 );
		expect( pixels[ ( 4 * 8 + 4 ) * 4 + 3 ] ).toBeCloseTo( 1, 3 );
		into.dispose();
		source.dispose();

	} );

	it.each( [ 'warm', 'mono', 'film' ] )( 'reads the %s look\'s table as its CPU twin does', async id => {

		const colours = quantise( [ ...IN_RANGE, [ 2.5, 1.2, 0.4 ]] );
		const { pixels } = await run( colours.length, colours, { look: { id, amount: 0.6 } } );
		const table = lookTable( id );
		colours.forEach( ( c, i ) => {

			const want = lookColor( c, table, 0.6 );
			colourAt( pixels, i ).forEach( ( v, k ) => expect( Math.abs( v - want[ k ] ) * 255, `${c} channel ${k}` ).toBeLessThan( 0.5 * Math.max( 1, want[ k ] ) ) );

		} );

	} );

	const flat = ( w, h, v ) => Array.from( { length: w * h }, () => [ v, v, v ] );

	it( 'darkens the edges with a vignette below 0, and leaves the middle', async () => {

		const { pixels, width, height } = await run( 32, flat( 32, 20, 0.6 ), { effects: { vignette: { amount: - 0.8 } } } );
		const at = ( x, y ) => pixels[ ( y * width + x ) * 4 ];
		expect( at( 16, 10 ) ).toBeCloseTo( 0.6, 3 );
		expect( at( 0, 0 ) ).toBeLessThan( 0.6 * 0.3 );
		expect( at( 0, 10 ) ).toBeLessThan( 0.6 );
		expect( at( 0, 0 ) ).toBeCloseTo( at( width - 1, height - 1 ), 3 );

	} );

	it( 'adds grain that averages out, the same every draw', async () => {

		const pipeline = new EditPipeline();
		const edits = { effects: { grain: { amount: 1, size: 0 } } };
		const first = await run( 64, flat( 64, 64, 0.5 ), edits, { pipeline } );
		const again = await run( 64, flat( 64, 64, 0.5 ), edits, { pipeline } );
		const reds = Array.from( { length: 64 * 64 }, ( _, i ) => first.pixels[ i * 4 ] );
		const mean = reds.reduce( ( s, v ) => s + v, 0 ) / reds.length;
		const spread = Math.sqrt( reds.reduce( ( s, v ) => s + ( v - mean ) ** 2, 0 ) / reds.length );
		expect( Math.abs( mean - 0.5 ) ).toBeLessThan( 0.01 );
		expect( spread ).toBeGreaterThan( 0.02 );
		expect( Array.from( again.pixels ) ).toEqual( Array.from( first.pixels ) );

	} );

	it( 'sharpens an edge and leaves flat areas alone', async () => {

		const step = Array.from( { length: 16 * 4 }, ( _, i ) => ( i % 16 < 8 ? [ 0.3, 0.3, 0.3 ] : [ 0.7, 0.7, 0.7 ] ) );
		const { pixels } = await run( 16, step, { detail: { sharpen: 1 } } );
		const at = x => pixels[ ( 16 + x ) * 4 ];
		expect( at( 2 ) ).toBeCloseTo( 0.3, 3 );
		expect( at( 13 ) ).toBeCloseTo( 0.7, 3 );
		expect( at( 7 ) ).toBeLessThan( 0.29 );
		expect( at( 8 ) ).toBeGreaterThan( 0.71 );

	} );

	it( 'raises local contrast with clarity, and leaves an even picture alone', async () => {

		const even = await run( 300, flat( 300, 200, 0.5 ), { detail: { clarity: 1 } } );
		expect( even.pixels[ ( 100 * 300 + 150 ) * 4 ] ).toBeCloseTo( 0.5, 2 );

		// A lighter square on a mid-grey ground stands out more along its edges, and the ground beside it less.
		const patch = Array.from( { length: 300 * 200 }, ( _, i ) => {

			const x = i % 300, y = Math.floor( i / 300 );
			const v = x >= 130 && x < 170 && y >= 80 && y < 120 ? 0.6 : 0.45;
			return [ v, v, v ];

		} );
		const { pixels } = await run( 300, patch, { detail: { clarity: 1 } } );
		expect( pixels[ ( 100 * 300 + 131 ) * 4 ] ).toBeGreaterThan( 0.61 );
		expect( pixels[ ( 100 * 300 + 128 ) * 4 ] ).toBeLessThan( 0.44 );
		expect( pixels[ ( 10 * 300 + 10 ) * 4 ] ).toBeCloseTo( 0.45, 2 );

	} );

} );
