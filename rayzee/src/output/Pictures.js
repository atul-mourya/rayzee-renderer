import { HalfFloatType, RenderTarget, FloatType, RGBAFormat, NearestFilter, DataUtils } from 'three';
import { readPixels, TextureReadback } from './TextureReadback.js';
import { toneMapToRGBA8, toneMapToRGBA16, toneMapToDisplayLinear } from './ToneMapCPU.js';
import { PackedToneMapper } from './ToneMapGPU.js';
import { EngineIssueError, ISSUE_CODES } from '../EngineIssues.js';
import { VERSION } from '../version.js';
import { createLogger } from '../Logger.js';

const log = createLogger( 'engine' );

// A half-float target reads back as its bits.
function asFloat32( data ) {

	if ( data instanceof Float32Array ) return data;
	const out = new Float32Array( data.length );
	for ( let i = 0; i < data.length; i ++ ) out[ i ] = DataUtils.fromHalfFloat( data[ i ] );
	return out;

}

function canvasPixels( canvas ) {

	const ctx = canvas.getContext( '2d' );
	const colorSpace = ctx.getContextAttributes?.()?.colorSpace ?? 'srgb';
	const image = ctx.getImageData( 0, 0, canvas.width, canvas.height, { colorSpace } );
	return { data: image.data, width: canvas.width, height: canvas.height, displayColorSpace: image.colorSpace ?? colorSpace, source: 'upscaled' };

}

export async function renderToBuffer( app, { colorSpace = 'srgb', preserveAlpha = false, source = 'accumulation', bitDepth = 8 } = {} ) {

	const named = colorSpace !== 'linear' && colorSpace !== 'srgb';
	if ( named && ! app.color?.hasConfig ) {

		throw new Error(
			`renderToBuffer: colorSpace must be 'linear' or 'srgb' without a colour config loaded, got "${colorSpace}"`
		);

	}

	const stage = app.stages?.pathTracer;
	const target = stage?.storageTextures?.readTarget;
	if ( ! target ) throw new Error( 'renderToBuffer: no render target — call init() and render at least one sample' );

	// The pool over-allocates to the reserve, so the texture is larger than the frame.
	const { width, height } = stage;
	// The accumulation's alpha is always coverage; an opaque backdrop reads back opaque, as the Compositor draws it.
	const transparent = !! app.settings.get( 'transparentBackground' );

	if ( colorSpace === 'srgb' ) {

		// `colorSpace` stays 'srgb' — callers branch on it; the bytes are encoded for `displayColorSpace`.
		const picture = await app._readPicture( target, width, height, { source, preserveAlpha: preserveAlpha && transparent, output: bitDepth === 16 ? 'rgba16' : 'rgba8' } );
		return { ...picture, width, height, colorSpace };

	}

	const { data: linear, source: read } = source === 'display'
		? await app._readDisplaySource( target, width, height )
		: { data: await readPixels( app.renderer, target, width, height ), source: 'accumulation' };
	if ( ! transparent ) {

		const one = linear instanceof Uint16Array ? 0x3C00 : 1; // a half-float target reads back as its bits
		for ( let i = 3; i < linear.length; i += 4 ) linear[ i ] = one;

	}

	// `colorSpace` stays 'linear' — callers branch on it. `workingSpace` is the new, additive
	// answer to "linear in what primaries", which only means something once a config is loaded.
	if ( colorSpace === 'linear' ) {

		return { data: linear, width, height, colorSpace, workingSpace: app.color?.workingSpace ?? null, source: read };

	}

	// A named space is a delivery buffer, not a picture: scene-referred float in whatever the
	// config calls that space. Saving an EXR for a compositor and grading through an sRGB view
	// on screen are different questions, and this is the one that answers the first.
	const { rgba, colorSpace: got } = app.color.exportPixels( linear, colorSpace );
	return { data: rgba, width, height, colorSpace: got, source: read };

}

/** The picture through the view, as `output` (a PackedToneMapper output): on the card, or on the CPU if that fails. @private */
export async function readPicture( app, target, width, height, { source, preserveAlpha, output } ) {

	const shown = source === 'display' ? app._displaySource( target ) : null;
	const tone = {
		exposure: app.renderer.toneMappingExposure,
		toneMapping: app.renderer.toneMapping,
		saturation: app.settings.get( 'saturation' ) ?? 1,
		preserveAlpha,
		gain: app._displayGain(),
	};

	const gpu = await app._toneMapOnGPU( shown?.texture ?? null, target, width, height, tone, output );
	const fn = ! gpu && tone.gain?.cpu ? await tone.gain.cpu() : null;
	const backdrop = tone.gain?.backdrop ?? 0;
	const cpu = { rgba8: toneMapToRGBA8, rgba16: toneMapToRGBA16, displayLinear: toneMapToDisplayLinear }[ output ];
	const data = gpu ?? cpu( shown
		? await app._readTexture( shown.texture, width, height )
		: await readPixels( app.renderer, target, width, height ), { ...tone, pixelGain: ( fn || backdrop ) ? { fn, width, height, backdrop } : null } );
	return { data, displayColorSpace: app.color?.canvasColorSpace ?? 'srgb', source: shown?.source ?? 'accumulation', toneMappedOn: gpu ? 'gpu' : 'cpu' };

}

/**
 * Display bytes tone-mapped on the card, or null to do it on the CPU. On the CPU it took 1.4 s at
 * 4096×2160 on an M-series Mac and 10 s on a cloud L4's host; the GPU pass matches it within one
 * level (`tests/gpu/toneMapParity.test.js`).
 */
export async function toneMapOnGPU( app, shown, accumulation, width, height, tone, output = 'rgba8' ) {

	const backend = app.renderer?.backend;
	if ( ! backend?.device ) return app._toneMapFallback( 'the renderer has no WebGPU device' );

	try {

		const texture = shown ? app._readbackPass().draw( shown, width, height ).texture : accumulation.textures[ 0 ];
		const gpuTexture = backend.get( texture ).texture;
		if ( ! gpuTexture ) return app._toneMapFallback( 'the picture has no GPU texture yet' );

		app._readbackToneMappers ??= new Map();
		let mapper = app._readbackToneMappers.get( output );
		if ( ! mapper ) app._readbackToneMappers.set( output, mapper = new PackedToneMapper( backend.device, `rayzee:readback-${output}`, { input: 'texture', output } ) );
		mapper.ensureSize( width, height );
		const read = { rgba8: 'toRGBA8', rgba16: 'toRGBA16', displayLinear: 'toDisplayLinear' }[ output ];
		return await mapper[ read ]( gpuTexture, tone );

	} catch ( error ) {

		if ( error instanceof EngineIssueError ) throw error;
		return app._toneMapFallback( 'the GPU pass threw', error );

	} finally {

		app._readbackToneMappers?.get( output )?.release();
		if ( shown ) app._textureReadback?.release();

	}

}

/** A warning, so strict keeps going: the CPU bytes match within a level, only slower. @private */
export function toneMapFallback( app, reason, error = null ) {

	const cause = error ? String( error?.message ?? error ) : null;
	const message = `renderToBuffer: tone mapped on the CPU — ${reason}${cause ? `: ${cause}` : ''}`;
	log.warn( message );
	app._issues.warn( ISSUE_CODES.OUTPUT_TONEMAP_FALLBACK, message, { reason, cause } );
	return null;

}

export function getCanvas( app ) {

	if ( ! app.renderer?.domElement ) return null;
	return app._displayCanvas() ?? app._pictureCanvas();

}

/** The render canvas's picture, readable now: the view itself, never the screen's HDR version of it. */
export function pictureCanvas( app ) {

	const canvas = app.renderer.domElement;
	const compositor = app.stages.compositor;
	const context = app.pipeline?.context;
	if ( ! compositor || ! context ) return canvas;

	// A presented WebGPU canvas only reads back what was drawn immediately before, so draw.
	// This also puts the denoised picture on it: the Compositor prefers it over the raw render.
	compositor.renderPicture( context );
	// An HDR canvas holds more than a picture can: copy what fits, 8 bits in its colour space, then redraw the screen.
	const extended = app.renderer.backend?.parameters?.outputType === HalfFloatType;
	if ( ! ( extended || compositor.showsCanvasTransform ) || app._headless || typeof document === 'undefined' ) return canvas;

	const colorSpace = canvas.getContext( 'webgpu' )?.getConfiguration?.()?.colorSpace ?? 'srgb';
	let copy = app._pictureCopy;
	if ( ! copy || copy.colorSpace !== colorSpace ) {

		copy = app._pictureCopy = { canvas: document.createElement( 'canvas' ), colorSpace };

	}

	if ( copy.canvas.width !== canvas.width || copy.canvas.height !== canvas.height ) {

		copy.canvas.width = canvas.width;
		copy.canvas.height = canvas.height;

	}

	const ctx = copy.canvas.getContext( '2d', { colorSpace } );
	ctx.clearRect( 0, 0, canvas.width, canvas.height );
	ctx.drawImage( canvas, 0, 0 );
	compositor.render( context );
	return copy.canvas;

}

export function screenshot( app, { type = 'image/png', quality } = {} ) {

	const canvas = app.getCanvas();
	if ( ! canvas ) return Promise.resolve( null );

	return new Promise( ( resolve ) => canvas.toBlob( resolve, type, quality ) );

}

export async function exportImage( app, { format = 'png', bitDepth = 8, quality = 0.92, gainMap = false, precision = 'half', asShown = false, colorSpace, passes = [], source = 'display', upscaled = true, alpha = true, metadata = true } = {} ) {

	const encoders = await import( './ImageEncoders.js' );
	const spec = encoders.IMAGE_FORMATS[ format ];
	if ( ! spec ) throw new Error( `exportImage: no format "${format}"; one of ${Object.keys( encoders.IMAGE_FORMATS ).join( ', ' )}` );

	const light = format === 'exr' || format === 'hdr';
	const text = metadata ? { ...exportDetails( app, format, light && asShown ), ...( typeof metadata === 'object' ? metadata : {} ) } : {};
	const file = async ( blob, read, rest = {} ) => ( {
		blob, mimeType: spec.mimeType, extension: spec.extension, width: read.width, height: read.height,
		colorSpace: read.displayColorSpace, source: read.source, passes: [], ...rest,
	} );

	if ( light ) return exportLight( app, encoders, file, { format, precision, asShown, colorSpace, passes, source, alpha, text } );

	const heif = format === 'heic' || format === 'avif';
	if ( heif || ( format === 'jpeg' && gainMap ) ) {

		if ( gainMap && ! app.stages.compositor?.showsCanvasTransform ) throw new Error( 'exportImage: an HDR photo needs the screen showing HDR (color.setHdrOutput)' );
		const hdr = gainMap ? asFloat32( ( await readShown( app, { source, preserveAlpha: false } ) ).data ) : null;
		const read = await app.renderToBuffer( { colorSpace: 'srgb', source } );
		const image = { sdr: read.data, hdr, width: read.width, height: read.height, colorSpace: read.displayColorSpace, quality };
		return file( heif ? await encoders.encodeStill( { ...image, format } ) : await encoders.encodeGainMapJPEG( { ...image, text } ), read );

	}

	const keepAlpha = alpha && format !== 'jpeg' && !! app.settings.get( 'transparentBackground' );
	if ( format === 'png' && bitDepth === 16 ) {

		const read = await app.renderToBuffer( { colorSpace: 'srgb', bitDepth: 16, source, preserveAlpha: keepAlpha } );
		return file( await encoders.encodePNG( { data: read.data, width: read.width, height: read.height, alpha: keepAlpha, colorSpace: read.displayColorSpace, text } ), read );

	}

	const shown = upscaled ? app._displayCanvas() : null;
	const read = shown ? canvasPixels( shown ) : await app.renderToBuffer( { colorSpace: 'srgb', source, preserveAlpha: keepAlpha } );
	const image = { data: read.data, width: read.width, height: read.height, colorSpace: read.displayColorSpace, text };
	return file( format === 'png'
		? await encoders.encodePNG( { ...image, alpha: keepAlpha } )
		: await encoders.encodeWithCanvas( { ...image, format, quality } ), read );

}

export function exportInfo( app ) {

	const stage = app.stages?.pathTracer;
	const shown = app._displayCanvas();
	const aux = !! stage?.hasAuxBuffers;
	return {
		width: stage?.width ?? 0,
		height: stage?.height ?? 0,
		upscaled: shown ? { width: shown.width, height: shown.height } : null,
		hdr: !! app.stages?.compositor?.showsCanvasTransform,
		layers: { albedo: aux, normal: aux, depth: !! ( stage?.bvhStorageAttr && stage.materialData?.materialStorageAttr ) },
	};

}

/** EXR or Radiance HDR: scene-referred float, with the EXR's extra layers. @private */
async function exportLight( app, encoders, file, { format, precision, asShown, colorSpace, passes, source, alpha, text } ) {

	let read, delivered, chromaticities;
	if ( asShown ) {

		read = await readShown( app, { source, preserveAlpha: alpha && !! app.settings.get( 'transparentBackground' ) } );
		delivered = `${read.displayColorSpace}-linear`;
		chromaticities = encoders.DISPLAY_CHROMATICITIES[ read.displayColorSpace ];

	} else {

		const space = colorSpace === undefined ? app.color?.exportSpace ?? null : colorSpace;
		read = await app.renderToBuffer( { colorSpace: space ?? 'linear', source } );
		delivered = read.colorSpace === 'linear' ? read.workingSpace ?? app.color.workingSpace : read.colorSpace;
		const measured = app.color.chromaticities?.( delivered ) ?? null;
		chromaticities = measured && encoders.standardChromaticities( measured );

	}

	const data = asFloat32( read.data );
	const { width, height } = read;
	const result = { colorSpace: delivered };

	if ( format === 'hdr' ) return file( await encoders.encodeHDR( { data, width, height, chromaticities, text } ), read, result );

	const channels = [ 'R', 'G', 'B', ...( alpha ? [ 'A' ] : [] ) ].map( ( name, offset ) => ( { name, data, stride: 4, offset, type: precision } ) );
	const written = [];
	const missing = ( pass, why ) => app._issues.record( ISSUE_CODES.OUTPUT_PASS_UNAVAILABLE, `exportImage: no ${pass} layer — ${why}`, { pass } );
	const want = new Set( passes );

	if ( want.has( 'albedo' ) || want.has( 'normal' ) ) {

		const aux = await app.stages.pathTracer.readAuxBuffers();
		for ( const pass of [ 'albedo', 'normal' ] ) {

			if ( ! want.has( pass ) ) continue;
			if ( ! aux ) {

				missing( pass, 'the denoisers\' guides are written only while a denoiser is on' );
				continue;

			}

			const values = asFloat32( aux[ pass ] );
			if ( pass === 'albedo' ) {

				if ( ! asShown && delivered !== app.color.workingSpace ) app.color.exportPixels( values, delivered );

			} else {

				for ( let i = 0; i < values.length; i += 4 ) for ( let c = 0; c < 3; c ++ ) values[ i + c ] = values[ i + c ] * 2 - 1;

			}

			const names = pass === 'albedo' ? [ 'R', 'G', 'B' ] : [ 'X', 'Y', 'Z' ];
			channels.push( ...names.map( ( c, offset ) => ( { name: `${pass}.${c}`, data: values, stride: 4, offset, type: precision } ) ) );
			written.push( pass );

		}

	}

	if ( want.has( 'depth' ) ) {

		const { DepthPass } = await import( '../shaders/kernels/DepthPass.js' );
		const depth = await new DepthPass( app.renderer ).read( app.stages.pathTracer );
		if ( depth ) {

			channels.push( { name: 'depth.Z', data: depth, type: 'float' } );
			written.push( 'depth' );

		} else missing( 'depth', 'no scene is built' );

	}

	return file( await encoders.encodeEXR( { width, height, channels, chromaticities, text } ), read, { ...result, passes: written } );

}

/**
 * The picture as the screen shows it, as light: display-linear in the canvas's primaries, 1 = SDR white. The canvas's
 * own version of the view when it has one (HDR), else the view through the readback tone mapper. @private
 */
async function readShown( app, { source, preserveAlpha } ) {

	const stage = app.stages?.pathTracer;
	const target = stage?.storageTextures?.readTarget;
	if ( ! target ) throw new Error( 'exportImage: no render target — call init() and render at least one sample' );
	const { width, height } = stage;
	const compositor = app.stages.compositor;
	const context = app.pipeline?.context;

	if ( compositor?.showsCanvasTransform && context ) {

		const shown = new RenderTarget( width, height, { type: FloatType, format: RGBAFormat, depthBuffer: false, minFilter: NearestFilter, magFilter: NearestFilter } );
		try {

			if ( compositor.renderShown( context, shown ) ) {

				const data = await readPixels( app.renderer, shown, width, height );
				return { data, width, height, displayColorSpace: app.color.canvasColorSpace, source: compositor.resolveLightSource( context )?.key.split( ':' )[ 0 ] ?? 'accumulation' };

			}

		} finally {

			shown.dispose();

		}

	}

	return { ...await app._readPicture( target, width, height, { source, preserveAlpha, output: 'displayLinear' } ), width, height };

}

/** What a saved file says about itself, under the names its format's readers look for. @private */
function exportDetails( app, format, asShown = false ) {

	const provenance = app.getProvenance();
	const render = provenance.render;
	const view = provenance.color?.view;
	const viewName = view && typeof view === 'object' ? [ view.view, view.look ].filter( Boolean ).join( ', ' ) : view;
	const summary = [ render && `${render.samples} samples`, render && `${render.width}×${render.height}`, viewName, asShown && 'as shown on screen' ].filter( Boolean ).join( ', ' );
	const settings = Object.fromEntries( Object.entries( provenance.settings ?? {} ).map( ( [ key, entry ] ) => [ key, entry?.value ] ) );
	const details = JSON.stringify( { engine: provenance.engine, render, color: provenance.color, settings, display: provenance.display, exposure: provenance.exposure } );
	const software = `Rayzee ${VERSION}`;
	const now = new Date();
	const pad = n => String( n ).padStart( 2, '0' );

	if ( format === 'exr' ) {

		const capDate = `${now.getFullYear()}:${pad( now.getMonth() + 1 )}:${pad( now.getDate() )} ${pad( now.getHours() )}:${pad( now.getMinutes() )}:${pad( now.getSeconds() )}`;
		return { software, comments: summary, capDate, rayzee: details };

	}

	if ( format === 'png' ) return { Software: software, 'Creation Time': now.toISOString(), Comment: summary, rayzee: details };
	return { Software: software, Comment: summary };

}

/**
 * What a `'display'` read shows: the texture a denoiser published, or null for the raw
 * accumulation — recorded as a fallback when a denoiser is in use.
 * @private
 */
export function displaySource( app, accumulation ) {

	const context = app.pipeline?.context;
	const found = context && app.stages.compositor?.resolveLightSource( context );
	if ( found && found.key !== 'pathtracer:color' && found.texture !== accumulation.texture ) {

		return { texture: found.texture, source: found.key.split( ':' )[ 0 ] };

	}

	if ( app._denoiserInUse() ) {

		app._issues.record(
			ISSUE_CODES.OUTPUT_SOURCE_FALLBACK,
			'renderToBuffer: \'display\' was asked for, but no denoiser has published a picture — returned the raw accumulation',
			{ requested: 'display', read: 'accumulation' }
		);

	}

	return null;

}

/**
 * What the Compositor is drawing from, as linear float. Falls back to the accumulation when no
 * denoiser has published anything, which is also what the viewport shows then.
 * @private
 */
export async function readDisplaySource( app, accumulation, width, height ) {

	const shown = app._displaySource( accumulation );
	if ( ! shown ) return { data: await readPixels( app.renderer, accumulation, width, height ), source: 'accumulation' };
	return { data: await app._readTexture( shown.texture, width, height ), source: shown.source };

}

export function readbackPass( app ) {

	return ( app._textureReadback ??= new TextureReadback( app.renderer ) );

}

export function readTexture( app, texture, width, height ) {

	return app._readbackPass().read( texture, width, height );

}
