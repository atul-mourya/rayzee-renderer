import { describe, it, expect, vi, afterEach } from 'vitest';
import { HalfFloatType, NoToneMapping, DataUtils } from 'three';
import { RayzeeRenderer } from '@/core/RayzeeRenderer.js';
import { IssueLog, EngineIssueError, ISSUE_CODES } from '@/core/EngineIssues.js';
import { DISPLAY_CHROMATICITIES } from '@/core/output/ImageEncoders.js';
import { VERSION } from '@/core/Version.js';

const gpu = vi.hoisted( () => ( { mappers: [], depth: null } ) );
const encoded = vi.hoisted( () => [] );

vi.mock( '@/core/output/ToneMapGPU.js', () => ( {
	PackedToneMapper: class {

		constructor( device, label, options ) {

			Object.assign( this, { device, label, options, sizes: [], reads: [], released: 0 } );
			gpu.mappers.push( this );

		}

		ensureSize( width, height ) {

			this.sizes.push( [ width, height ] );

		}

		release() {

			this.released ++;

		}

		dispose() {}

		async toRGBA8( texture, tone ) {

			this.reads.push( { texture, tone } );
			return new Uint8ClampedArray( 8 ).fill( 9 );

		}

	},
} ) );

vi.mock( '@/core/shaders/kernels/DepthPass.js', () => ( {
	DepthPass: class {

		async read() {

			return gpu.depth;

		}

	},
} ) );

vi.mock( '@/core/output/ImageEncoders.js', async ( importOriginal ) => {

	const real = await importOriginal();
	const spy = ( name, write = async () => new Blob( [ name ] ) ) => async ( args ) => {

		encoded.push( { name, args } );
		return write( args );

	};

	return {
		...real,
		encodePNG: spy( 'png', real.encodePNG ),
		encodeEXR: spy( 'exr', real.encodeEXR ),
		encodeHDR: spy( 'hdr', real.encodeHDR ),
		encodeWithCanvas: spy( 'canvas' ),
		encodeStill: spy( 'still' ),
		encodeGainMapJPEG: spy( 'gainMapJPEG' ),
	};

} );

const last = ( name ) => encoded.filter( e => e.name === name ).at( - 1 )?.args;

function makeApp( { width = 2, height = 1, pixel = [ 0.5, 0.25, 0.125, 0.5 ], transparent = false, readback = Float32Array } = {} ) {

	const pixels = new readback( width * height * 4 );
	for ( let i = 0; i < pixels.length; i += 4 ) pixels.set( pixel, i );
	const canvas = { width, height, toBlob: vi.fn( ( done, type, quality ) => done( { type, quality } ) ), getContext: () => null };

	return Object.assign( Object.create( RayzeeRenderer.prototype ), {
		_issues: new IssueLog(),
		stages: { pathTracer: { width, height, storageTextures: { readTarget: { textures: [ {} ] } }, readAuxBuffers: vi.fn( async () => null ) } },
		settings: { get: ( key ) => ( { saturation: 1, transparentBackground: transparent } )[ key ] },
		renderer: {
			domElement: canvas,
			toneMappingExposure: 1,
			toneMapping: NoToneMapping,
			readRenderTargetPixelsAsync: vi.fn( async () => pixels.slice() ),
		},
		color: {
			workingSpace: 'Linear Rec.709',
			exportSpace: null,
			canvasColorSpace: 'srgb',
			hasConfig: false,
			chromaticities: () => null,
		},
		getProvenance: () => ( {
			engine: VERSION,
			render: { samples: 64, width, height },
			color: { view: { view: 'AgX', look: 'Punchy' } },
			settings: { exposure: { value: 1.5, source: 'host' } },
			display: { exposure: 1 },
		} ),
	} );

}

function withCanvasTransform( app, { shows = true } = {} ) {

	app.pipeline = { context: { getState: () => null } };
	app.stages.compositor = {
		showsCanvasTransform: true,
		renderShown: vi.fn( () => shows ),
		resolveLightSource: () => ( { key: 'oidn:output' } ),
		renderPicture: vi.fn(),
		render: vi.fn(),
	};
	return app;

}

afterEach( () => {

	encoded.length = 0;
	gpu.mappers.length = 0;
	gpu.depth = null;
	vi.unstubAllGlobals();

} );

describe( 'renderToBuffer', () => {

	it( 'hands out a delivery buffer in a config\'s colour space, opaque unless the background is transparent', async () => {

		const app = makeApp();
		app.color.hasConfig = true;
		app.color.exportPixels = vi.fn( ( linear ) => ( { rgba: linear, colorSpace: 'ACES2065-1' } ) );

		const out = await app.renderToBuffer( { colorSpace: 'ACES2065-1' } );

		expect( out.colorSpace ).toBe( 'ACES2065-1' );
		expect( out.source ).toBe( 'accumulation' );
		const [ linear, asked ] = app.color.exportPixels.mock.calls[ 0 ];
		expect( asked ).toBe( 'ACES2065-1' );
		expect( Array.from( linear ) ).toEqual( [ 0.5, 0.25, 0.125, 1, 0.5, 0.25, 0.125, 1 ] );

	} );

	it( 'makes a half-float readback opaque with half-float ones', async () => {

		const half = DataUtils.toHalfFloat( 0.5 );
		const app = makeApp( { readback: Uint16Array, pixel: [ half, half, half, 0 ] } );
		const { data, workingSpace } = await app.renderToBuffer( { colorSpace: 'linear' } );

		expect( data[ 3 ] ).toBe( 0x3C00 );
		expect( DataUtils.fromHalfFloat( data[ 3 ] ) ).toBe( 1 );
		expect( workingSpace ).toBe( 'Linear Rec.709' );

	} );

	it( 'reads 16-bit display values when asked, rounded on the CPU', async () => {

		const app = makeApp( { pixel: [ 1, 1, 1, 1 ] } );
		const { data } = await app.renderToBuffer( { bitDepth: 16 } );
		expect( data ).toBeInstanceOf( Uint16Array );
		expect( data[ 0 ] ).toBe( 65535 );

	} );

	it( 'keeps coverage in sRGB bytes only while the background is transparent', async () => {

		expect( ( await makeApp().renderToBuffer( { preserveAlpha: true } ) ).data[ 3 ] ).toBe( 255 );
		expect( ( await makeApp( { transparent: true } ).renderToBuffer( { preserveAlpha: true } ) ).data[ 3 ] ).toBe( 128 );

	} );

} );

describe( 'the readback tone map', () => {

	function onGPU( app ) {

		const texture = { gpu: 'texture' };
		app.renderer.backend = { device: { label: 'device' }, get: () => ( { texture } ) };
		return texture;

	}

	it( 'maps on the card with one mapper per output, sized to the frame and released after', async () => {

		const app = makeApp();
		const texture = onGPU( app );

		const first = await app.renderToBuffer();
		await app.renderToBuffer();

		expect( first.toneMappedOn ).toBe( 'gpu' );
		expect( first.data ).toEqual( new Uint8ClampedArray( 8 ).fill( 9 ) );
		expect( gpu.mappers ).toHaveLength( 1 );
		const [ mapper ] = gpu.mappers;
		expect( mapper.options ).toEqual( { input: 'texture', output: 'rgba8' } );
		expect( mapper.sizes ).toEqual( [[ 2, 1 ], [ 2, 1 ]] );
		expect( mapper.released ).toBe( 2 );
		expect( mapper.reads[ 0 ].texture ).toBe( texture );
		expect( app.renderer.readRenderTargetPixelsAsync ).not.toHaveBeenCalled();
		expect( app._issues.list ).toEqual( [] );

	} );

	it( 'draws a denoised picture through the readback pass and frees its target', async () => {

		const app = makeApp();
		onGPU( app );
		const published = { name: 'oidn' };
		app.pipeline = { context: {} };
		app.stages.compositor = { resolveLightSource: () => ( { key: 'oidn:output', texture: published } ) };
		app._textureReadback = { draw: vi.fn( () => ( { texture: published } ) ), release: vi.fn() };

		const out = await app.renderToBuffer( { source: 'display' } );

		expect( out ).toMatchObject( { source: 'oidn', toneMappedOn: 'gpu' } );
		expect( app._textureReadback.draw ).toHaveBeenCalledWith( published, 2, 1 );
		expect( app._textureReadback.release ).toHaveBeenCalledOnce();

	} );

	it( 'lets a strict host\'s failure through rather than falling back', async () => {

		const app = makeApp();
		const strict = new EngineIssueError( { code: ISSUE_CODES.OUTPUT_TONEMAP_FALLBACK, message: 'strict', detail: {}, severity: 'error' } );
		app.renderer.backend = { device: {}, get: () => {

			throw strict;

		} };

		await expect( app.renderToBuffer() ).rejects.toBe( strict );

	} );

	it( 'applies the viewer\'s per-pixel gain on the CPU, and holds a solid backdrop', async () => {

		const app = makeApp( { pixel: [ 0.18, 0.18, 0.18, 1 ] } );
		const plain = ( await app.renderToBuffer() ).data[ 0 ];

		app._displayGain = () => ( { cpu: async () => () => 0 } );
		expect( ( await app.renderToBuffer() ).data[ 0 ] ).toBe( 0 );

		app._displayGain = () => ( { backdrop: 4 } );
		expect( ( await app.renderToBuffer() ).data[ 0 ] ).toBe( plain );

		const uncovered = makeApp( { pixel: [ 0.18, 0.18, 0.18, 0 ] } );
		uncovered._displayGain = () => ( { backdrop: 4 } );
		expect( ( await uncovered.renderToBuffer() ).data[ 0 ] ).toBeGreaterThan( plain );

	} );

} );

describe( 'the picture canvas', () => {

	it( 'is nothing without a renderer, and the upscaler\'s canvas while one shows', () => {

		const app = makeApp();
		const upscaled = { name: 'upscaled' };
		app._displayCanvas = () => upscaled;
		expect( app.getCanvas() ).toBe( upscaled );

		app.renderer = null;
		expect( app.getCanvas() ).toBeNull();

	} );

	it( 'draws the picture on the render canvas before handing it out', () => {

		const app = withCanvasTransform( makeApp() );
		app.stages.compositor.showsCanvasTransform = false;
		expect( app.getCanvas() ).toBe( app.renderer.domElement );
		expect( app.stages.compositor.renderPicture ).toHaveBeenCalledWith( app.pipeline.context );
		expect( app.stages.compositor.render ).not.toHaveBeenCalled();

		app.pipeline = null;
		expect( app.getCanvas() ).toBe( app.renderer.domElement );
		expect( app.stages.compositor.renderPicture ).toHaveBeenCalledOnce();

	} );

	it( 'copies an HDR screen\'s picture in its colour space, then redraws the screen', () => {

		const made = [];
		vi.stubGlobal( 'document', { createElement: () => {

			const ctx = { clearRect: vi.fn(), drawImage: vi.fn() };
			const copy = { width: 0, height: 0, ctx, getContext: vi.fn( () => ctx ) };
			made.push( copy );
			return copy;

		} } );
		const app = withCanvasTransform( makeApp() );
		let space = 'display-p3';
		app.renderer.domElement.getContext = () => ( { getConfiguration: () => ( { colorSpace: space } ) } );

		const copy = app.getCanvas();
		expect( copy ).toBe( made[ 0 ] );
		expect( copy ).toMatchObject( { width: 2, height: 1 } );
		expect( copy.getContext ).toHaveBeenCalledWith( '2d', { colorSpace: 'display-p3' } );
		expect( copy.ctx.drawImage ).toHaveBeenCalledWith( app.renderer.domElement, 0, 0 );
		expect( app.stages.compositor.render ).toHaveBeenCalledOnce();

		expect( app.getCanvas() ).toBe( copy );
		space = 'srgb';
		expect( app.getCanvas() ).toBe( made[ 1 ] );

	} );

	it( 'copies an extended-range canvas too, but never headless', () => {

		vi.stubGlobal( 'document', { createElement: () => ( { width: 0, height: 0, getContext: () => ( { clearRect() {}, drawImage() {} } ) } ) } );
		const app = withCanvasTransform( makeApp() );
		app.stages.compositor.showsCanvasTransform = false;
		app.renderer.backend = { parameters: { outputType: HalfFloatType } };
		expect( app.getCanvas() ).not.toBe( app.renderer.domElement );

		app._headless = true;
		expect( app.getCanvas() ).toBe( app.renderer.domElement );

	} );

	it( 'encodes a screenshot from the canvas, or gives null', async () => {

		const app = makeApp();
		await expect( app.screenshot( { type: 'image/webp', quality: 0.8 } ) ).resolves.toEqual( { type: 'image/webp', quality: 0.8 } );
		app.renderer = null;
		await expect( app.screenshot() ).resolves.toBeNull();

	} );

} );

describe( 'exportImage', () => {

	it( 'names the formats it has when asked for another', async () => {

		await expect( makeApp().exportImage( { format: 'tiff' } ) ).rejects.toThrow( /no format "tiff"; one of png, jpeg/ );

	} );

	it( 'writes the picture as a PNG that says what made it', async () => {

		const file = await makeApp().exportImage();

		expect( file ).toMatchObject( { mimeType: 'image/png', extension: 'png', width: 2, height: 1, colorSpace: 'srgb', source: 'accumulation', passes: [] } );
		expect( file.blob ).toBeInstanceOf( Blob );
		const { text, alpha } = last( 'png' );
		expect( alpha ).toBe( false );
		expect( text.Software ).toBe( `Rayzee ${VERSION}` );
		expect( text.Comment ).toBe( '64 samples, 2×1, AgX, Punchy' );
		expect( JSON.parse( text.rayzee ).settings ).toEqual( { exposure: 1.5 } );

	} );

	it( 'keeps transparency only where the background is transparent, and never in a JPEG', async () => {

		const app = makeApp( { transparent: true } );
		await app.exportImage();
		expect( last( 'png' ).alpha ).toBe( true );
		expect( last( 'png' ).data[ 3 ] ).toBe( 128 );

		await app.exportImage( { alpha: false } );
		expect( last( 'png' ).alpha ).toBe( false );

		const jpeg = await app.exportImage( { format: 'jpeg', quality: 0.7 } );
		expect( jpeg ).toMatchObject( { mimeType: 'image/jpeg', extension: 'jpg' } );
		expect( last( 'canvas' ) ).toMatchObject( { format: 'jpeg', quality: 0.7, text: { Software: `Rayzee ${VERSION}` } } );
		expect( last( 'canvas' ).data[ 3 ] ).toBe( 255 );
		expect( last( 'canvas' ).text.rayzee ).toBeUndefined();

	} );

	it( 'leaves the details out, or adds the host\'s', async () => {

		const app = makeApp();
		await app.exportImage( { metadata: false } );
		expect( last( 'png' ).text ).toEqual( {} );
		await app.exportImage( { metadata: { Author: 'farm-7' } } );
		expect( last( 'png' ).text ).toMatchObject( { Author: 'farm-7', Software: `Rayzee ${VERSION}` } );

	} );

	it( 'writes a 16-bit PNG from the 16-bit readback', async () => {

		await makeApp().exportImage( { bitDepth: 16 } );
		expect( last( 'png' ).data ).toBeInstanceOf( Uint16Array );

	} );

	it( 'writes the upscaler\'s picture while one shows, unless asked for the render', async () => {

		const app = makeApp();
		const image = { data: new Uint8ClampedArray( 64 ), colorSpace: 'display-p3' };
		const ctx = { getContextAttributes: () => ( { colorSpace: 'display-p3' } ), getImageData: vi.fn( () => image ) };
		app._displayCanvas = () => ( { width: 4, height: 4, getContext: () => ctx } );

		const file = await app.exportImage( { format: 'webp' } );
		expect( file ).toMatchObject( { width: 4, height: 4, colorSpace: 'display-p3', source: 'upscaled' } );
		expect( ctx.getImageData ).toHaveBeenCalledWith( 0, 0, 4, 4, { colorSpace: 'display-p3' } );

		expect( await app.exportImage( { upscaled: false } ) ).toMatchObject( { width: 2, height: 1, source: 'accumulation' } );

	} );

	it( 'wants the screen in HDR for an HDR photo', async () => {

		const app = makeApp();
		await expect( app.exportImage( { format: 'jpeg', gainMap: true } ) ).rejects.toThrow( /needs the screen showing HDR/ );
		expect( encoded ).toEqual( [] );

	} );

	it( 'writes HEIC through the still encoder, and an HDR photo with the screen\'s light as its gain map', async () => {

		const app = makeApp();
		const heic = await app.exportImage( { format: 'heic', quality: 0.6 } );
		expect( heic ).toMatchObject( { mimeType: 'image/heic', extension: 'heic' } );
		expect( last( 'still' ) ).toMatchObject( { format: 'heic', hdr: null, quality: 0.6, width: 2, height: 1 } );

		withCanvasTransform( app );
		app.color.canvasColorSpace = 'display-p3';
		app.renderer.readRenderTargetPixelsAsync.mockResolvedValueOnce( new Float32Array( 8 ).fill( 3 ) );
		await app.exportImage( { format: 'jpeg', gainMap: true } );
		const { hdr, sdr, text } = last( 'gainMapJPEG' );
		expect( hdr ).toEqual( new Float32Array( 8 ).fill( 3 ) );
		expect( sdr ).toBeInstanceOf( Uint8ClampedArray );
		expect( text.Software ).toBe( `Rayzee ${VERSION}` );

	} );

} );

describe( 'exportImage as light', () => {

	const channelNames = () => last( 'exr' ).channels.map( c => c.name );

	it( 'writes the working space when no export space is set, with the EXR\'s capture date', async () => {

		const app = makeApp();
		const file = await app.exportImage( { format: 'exr' } );

		expect( file ).toMatchObject( { mimeType: 'image/x-exr', colorSpace: 'Linear Rec.709', passes: [] } );
		expect( channelNames() ).toEqual( [ 'R', 'G', 'B', 'A' ] );
		expect( last( 'exr' ).channels[ 0 ].type ).toBe( 'half' );
		expect( last( 'exr' ).text.capDate ).toMatch( /^\d{4}:\d\d:\d\d \d\d:\d\d:\d\d$/ );
		expect( last( 'exr' ).chromaticities ).toBeNull();

	} );

	it( 'delivers in the export space, with that space\'s primaries', async () => {

		const app = makeApp();
		Object.assign( app.color, {
			hasConfig: true,
			exportSpace: 'ACEScg',
			chromaticities: vi.fn( () => [ 0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290 ] ),
			exportPixels: vi.fn( ( linear, space ) => ( { rgba: linear, colorSpace: space } ) ),
		} );

		const file = await app.exportImage( { format: 'exr', precision: 'float', alpha: false } );
		expect( file.colorSpace ).toBe( 'ACEScg' );
		expect( app.color.chromaticities ).toHaveBeenCalledWith( 'ACEScg' );
		expect( last( 'exr' ).chromaticities ).toEqual( DISPLAY_CHROMATICITIES.srgb );
		expect( channelNames() ).toEqual( [ 'R', 'G', 'B' ] );
		expect( last( 'exr' ).channels[ 0 ].type ).toBe( 'float' );

		await app.exportImage( { format: 'exr', colorSpace: null } );
		expect( app.color.exportPixels ).toHaveBeenCalledOnce();

	} );

	it( 'adds the denoisers\' guides, normals back in [-1, 1] and albedo in the delivered space', async () => {

		const app = makeApp();
		app.stages.pathTracer.readAuxBuffers = vi.fn( async () => ( {
			albedo: new Float32Array( [ 0.2, 0.4, 0.6, 1, 0.2, 0.4, 0.6, 1 ] ),
			normal: new Float32Array( [ 0.5, 1, 0, 1, 0.5, 1, 0, 1 ] ),
		} ) );
		Object.assign( app.color, { hasConfig: true, exportSpace: 'ACEScg', exportPixels: vi.fn( ( linear, space ) => ( { rgba: linear, colorSpace: space } ) ) } );

		const file = await app.exportImage( { format: 'exr', passes: [ 'albedo', 'normal' ] } );

		expect( file.passes ).toEqual( [ 'albedo', 'normal' ] );
		expect( channelNames() ).toEqual( [ 'R', 'G', 'B', 'A', 'albedo.R', 'albedo.G', 'albedo.B', 'normal.X', 'normal.Y', 'normal.Z' ] );
		const normal = last( 'exr' ).channels.find( c => c.name === 'normal.X' ).data;
		expect( Array.from( normal.slice( 0, 3 ) ) ).toEqual( [ 0, 1, - 1 ] );
		expect( app.color.exportPixels.mock.calls.map( ( [ , space ] ) => space ) ).toEqual( [ 'ACEScg', 'ACEScg' ] );

	} );

	it( 'records each layer it cannot write and writes the rest', async () => {

		const app = makeApp();
		const file = await app.exportImage( { format: 'exr', passes: [ 'normal', 'depth' ] } );

		expect( file.passes ).toEqual( [] );
		expect( channelNames() ).toEqual( [ 'R', 'G', 'B', 'A' ] );
		expect( app._issues.list.map( i => [ i.code, i.detail.pass ] ) ).toEqual( [
			[ ISSUE_CODES.OUTPUT_PASS_UNAVAILABLE, 'normal' ],
			[ ISSUE_CODES.OUTPUT_PASS_UNAVAILABLE, 'depth' ],
		] );

		gpu.depth = new Float32Array( 2 ).fill( 7 );
		expect( ( await app.exportImage( { format: 'exr', passes: [ 'depth' ] } ) ).passes ).toEqual( [ 'depth' ] );
		expect( last( 'exr' ).channels.at( - 1 ) ).toMatchObject( { name: 'depth.Z', type: 'float' } );

	} );

	it( 'writes Radiance HDR without layers', async () => {

		const file = await makeApp().exportImage( { format: 'hdr', passes: [ 'depth' ] } );
		expect( file ).toMatchObject( { mimeType: 'image/vnd.radiance', extension: 'hdr', passes: [] } );
		expect( last( 'hdr' ).data ).toBeInstanceOf( Float32Array );

	} );

	it( 'writes a half-float readback as the light it holds, not its bits', async () => {

		const half = DataUtils.toHalfFloat( 2.5 );
		await makeApp( { readback: Uint16Array, pixel: [ half, half, half, half ] } ).exportImage( { format: 'hdr' } );
		expect( Array.from( last( 'hdr' ).data.slice( 0, 4 ) ) ).toEqual( [ 2.5, 2.5, 2.5, 1 ] );

	} );

	it( 'as shown: the screen\'s light in the canvas\'s primaries, guides left as they are', async () => {

		const app = withCanvasTransform( makeApp() );
		app.color.canvasColorSpace = 'display-p3';
		app.color.exportPixels = vi.fn();
		app.stages.pathTracer.readAuxBuffers = vi.fn( async () => ( { albedo: new Float32Array( 8 ), normal: new Float32Array( 8 ) } ) );

		const file = await app.exportImage( { format: 'exr', asShown: true, passes: [ 'albedo' ] } );

		expect( file ).toMatchObject( { colorSpace: 'display-p3-linear', source: 'oidn' } );
		expect( last( 'exr' ).chromaticities ).toEqual( DISPLAY_CHROMATICITIES[ 'display-p3' ] );
		expect( last( 'exr' ).text.comments ).toMatch( /as shown on screen$/ );
		expect( app.color.exportPixels ).not.toHaveBeenCalled();

	} );

	it( 'as shown without an HDR version: the view through the readback tone map', async () => {

		const app = withCanvasTransform( makeApp(), { shows: false } );
		const file = await app.exportImage( { format: 'hdr', asShown: true } );
		expect( file ).toMatchObject( { colorSpace: 'srgb-linear', source: 'accumulation' } );
		expect( last( 'hdr' ).data[ 0 ] ).toBeGreaterThan( 0 );
		expect( last( 'hdr' ).data[ 0 ] ).toBeLessThanOrEqual( 1 );

	} );

	it( 'explains itself before anything has rendered', async () => {

		const app = makeApp();
		app.stages.pathTracer.storageTextures = null;
		await expect( app.exportImage( { format: 'exr', asShown: true } ) ).rejects.toThrow( /exportImage: no render target/ );

	} );

} );

describe( 'exportInfo', () => {

	it( 'says what can be written now', () => {

		const app = makeApp();
		app.stages.pathTracer.hasAuxBuffers = true;
		app.stages.pathTracer.bvhStorageAttr = {};
		app.stages.pathTracer.materialData = { materialStorageAttr: {} };
		app._displayCanvas = () => ( { width: 8, height: 4 } );
		app.stages.compositor = { showsCanvasTransform: true };

		expect( app.exportInfo() ).toEqual( {
			width: 2, height: 1, upscaled: { width: 8, height: 4 }, hdr: true,
			layers: { albedo: true, normal: true, depth: true },
		} );

	} );

	it( 'has no layers and no size before the path tracer exists', () => {

		const app = makeApp();
		app.stages = {};
		expect( app.exportInfo() ).toEqual( {
			width: 0, height: 0, upscaled: null, hdr: false,
			layers: { albedo: false, normal: false, depth: false },
		} );

	} );

} );

describe( 'reading what the compositor shows', () => {

	it( 'is the accumulation when the compositor resolves the accumulation itself', async () => {

		const app = makeApp();
		const accumulation = app.stages.pathTracer.storageTextures.readTarget;
		app.pipeline = { context: {} };
		app.stages.compositor = { resolveLightSource: () => ( { key: 'nrd:output', texture: accumulation.texture } ) };

		expect( app._displaySource( accumulation ) ).toBeNull();
		await expect( app._readDisplaySource( accumulation, 2, 1 ) ).resolves.toMatchObject( { source: 'accumulation' } );

	} );

	it( 'keeps one readback pass', () => {

		const app = makeApp();
		expect( app._readbackPass() ).toBe( app._readbackPass() );

	} );

} );
