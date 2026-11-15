import { DataTexture, HalfFloatType, LinearFilter, LinearSRGBColorSpace, NearestFilter, NoToneMapping, RGBAFormat, RenderTarget, Texture, UnsignedByteType } from 'three';
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu';
import { screenUV, texture as textureNode, vec4 } from 'three/tsl';
import { Compositor } from '../../pipeline/Compositor.js';
import { LocalExposure } from './LocalExposure.js';
import { PipelineContext } from '../../pipeline/PipelineContext.js';
import { holdCanvasColorSpace } from '../../addons/color/ColorManagement.js';
import { createRendererOnDevice, disposeRenderer, takeFrameStep } from '../../RayzeeRenderer.js';

// Enough for any header `exportImage` writes; a longer one is read whole.
const HEADER_BYTES = 1 << 18;

/**
 * A saved render shown again as an HDR screen showed it: the EXR `exportImage` wrote, through the same compositor,
 * local exposure and HDR version of the view, at the exposure the file records (`getProvenance().display`). It draws
 * on a canvas of its own with a renderer on the main one's device, so the live view is left as it is. With
 * `{ hdr: false }` the canvas is an ordinary 8-bit one, for `showImage()`.
 *
 *   const view = await app.createPictureView( canvas );
 *   const { shown, reason } = await view.show( exrBlob );
 *   view.setGrade( c => c.mul( 1.1 ) );   // a host's own edit, on the shown (encoded, extended) colour
 *   view.setFinish( ( picture, renderer ) => … );   // or the host draws the canvas from the shown picture itself
 */
export class PictureView {

	constructor( { color, device }, canvas, { hdr = true } = {} ) {

		this._color = color;
		this._device = device;
		this._hdr = hdr;
		this.canvas = canvas;
		this.renderer = null;
		this._compositor = null;
		this._local = null;
		this._gain = ( rgb, uv ) => this._local.gainNode( rgb, uv );
		this._context = new PipelineContext();
		this._texture = null;
		this._tsl = null;
		this._grade = null;
		this._applied = null;
		this._ticket = 0;
		// What is shown: null, 'exr' or 'image'; `_shown` is the picture a finish reads.
		this._source = null;
		this._size = null;
		this._shown = null;
		this._stale = false;
		this._finish = null;
		this._target = null;
		this._copy = null;

	}

	async init() {

		this.renderer = await createRendererOnDevice( this._device, { canvas: this.canvas, outputType: this._hdr ? HalfFloatType : UnsignedByteType, depth: false } );
		this._compositor = new Compositor( this.renderer );
		this._local = new LocalExposure( this.renderer );
		return this;

	}

	/**
	 * Shows a saved render's EXR. Not shown, with `reason`: 'hdr-off' (the screen shows no HDR), 'overlay' (another
	 * picture was shown over this light: an AI upscale or neural pass, which the light is not), 'not-recorded' (a file
	 * from before its exposure was recorded), 'needs-config' / 'other-config' (its colour config is not the one loaded),
	 * 'no-hdr-version', 'bake-failed', or 'superseded' by a later `show()`. Only a file it shows is decoded.
	 * @param {Blob|ArrayBuffer} file
	 * @returns {Promise<{ shown: boolean, reason?: string }>}
	 */
	async show( file ) {

		const ticket = ++ this._ticket;
		const superseded = { shown: false, reason: 'superseded' };
		if ( ! this._hdr || ! this._color?.hdrOutput ) return { shown: false, reason: 'hdr-off' };

		const bytes = async end => new Uint8Array( file instanceof Blob ? await file.slice( 0, end ).arrayBuffer() : file.slice( 0, end ) );
		let record = exrAttribute( await bytes( HEADER_BYTES ), 'rayzee' );
		if ( record === null ) record = exrAttribute( await bytes(), 'rayzee' );
		let details = null;
		try {

			details = JSON.parse( record );

		} catch { /* no record */ }

		if ( ticket !== this._ticket ) return superseded;
		if ( ! details?.display || ! details.color?.view ) return { shown: false, reason: 'not-recorded' };
		if ( details.display.overlay ) return { shown: false, reason: 'overlay' };
		const version = this._color.hdrVersionOf( details.color.view );
		if ( ! version.table ) return { shown: false, reason: version.reason };

		const [ { decodeEXR }, pixels ] = await Promise.all( [ import( '../../loaders/EXRDecode.js' ), bytes() ] );
		if ( ticket !== this._ticket ) return superseded;
		const exr = await decodeEXR( pixels.buffer, { type: HalfFloatType } );
		if ( ticket !== this._ticket ) return superseded;
		this._draw( exr, details, version.table );
		return { shown: true };

	}

	_draw( exr, details, table ) {

		const { width, height } = exr;
		const renderer = this.renderer, compositor = this._compositor, local = this._local, context = this._context;

		// EXR rows run bottom up; three flips them on the GPU as it uploads. Nothing reads the pixels after that.
		this._texture?.dispose();
		const texture = this._texture = new DataTexture( exr.data, width, height, RGBAFormat, HalfFloatType );
		texture.minFilter = texture.magFilter = NearestFilter;
		texture.flipY = true;
		texture.onUpdate = () => {

			texture.image.data = null;

		};

		texture.needsUpdate = true;

		const display = details.display;
		context.setTexture( 'pathtracer:color', texture );
		context.setStates( { 'pathtracer:backdrop': display.backdrop ?? null, 'pathtracer:samples': details.render?.samples ?? 0 } );

		renderer.toneMappingExposure = display.exposure ?? 1;
		holdCanvasColorSpace( this.canvas, table.ocio.canvas );

		compositor.setSaturation( details.settings?.saturation ?? 1 );
		compositor.setWhiteBalance( details.settings?.whiteBalance ?? 0 );
		compositor.setTransparentBackground( !! details.settings?.transparentBackground );
		compositor.setBackdropExposure( display.backdropExposure ?? null );
		const shaped = details.exposure?.local;
		if ( shaped ) {

			local.updateParameters( shaped );
			local.build( context );

		}

		compositor.setDisplayGain( shaped ? this._gain : null );
		this._tsl = table.tsl;
		this._applyTransform();
		this._source = 'exr';
		this._size = { width, height };
		this._stale = true;
		this._present();

	}

	/**
	 * An 8-bit picture shown as it is (an image, bitmap or canvas, its colours already encoded for the screen), through
	 * the finish when one is set. The grade does not apply.
	 * @param {HTMLImageElement|HTMLCanvasElement|ImageBitmap|OffscreenCanvas} image
	 */
	showImage( image ) {

		this._ticket ++;
		this._texture?.dispose();
		const texture = this._texture = new Texture( image );
		texture.flipY = false;
		texture.minFilter = texture.magFilter = LinearFilter;
		texture.generateMipmaps = false;
		texture.needsUpdate = true;
		this._source = 'image';
		this._size = { width: image.width, height: image.height };
		this._shown = { texture, width: image.width, height: image.height, light: false };
		this._present();

	}

	/**
	 * The host draws the canvas: `finish( picture, renderer )`, `picture` = { texture, width, height, light }, the shown
	 * picture — `show()`'s after the view and the grade as light (1 = SDR white, the canvas's primaries, its encoding
	 * undone), or `showImage()`'s as given (`light: false`). The finish sizes the canvas and draws it with `renderer`;
	 * it is called again on every `redraw()`. Null draws the picture straight.
	 */
	setFinish( finish ) {

		if ( finish === this._finish ) return;
		this._finish = finish;
		this._stale = true;
		this._present();

	}

	/**
	 * A host's edit on the shown colour, after the view: `( rgb ) => rgb`, TSL nodes, the canvas's encoding extended
	 * past 1. Its uniforms change without a rebuild; `redraw()` then shows them. Null removes it.
	 */
	setGrade( grade ) {

		if ( grade === this._grade ) return;
		this._grade = grade;
		this._applyTransform();
		this._stale = true;
		this._present();

	}

	/** Draws the shown picture again, after a grade's or a finish's uniforms changed. */
	redraw() {

		this._present();

	}

	_present() {

		const renderer = this.renderer;
		if ( ! this._source || ! renderer ) return;
		takeFrameStep( renderer );

		if ( this._source === 'exr' && ! this._finish ) {

			renderer.setSize( this._size.width, this._size.height, false );
			this._compositor.render( this._context );
			return;

		}

		if ( this._source === 'exr' && this._stale ) {

			if ( ! this._target ) {

				this._target = new RenderTarget( 1, 1, { type: HalfFloatType, depthBuffer: false } );
				this._target.texture.minFilter = this._target.texture.magFilter = LinearFilter;
				this._target.texture.generateMipmaps = false;

			}

			const { width, height } = this._size;
			this._target.setSize( width, height );
			this._compositor.renderShown( this._context, this._target );
			this._shown = { texture: this._target.texture, width, height, light: true };

		}

		this._stale = false;
		if ( this._finish ) this._finish( this._shown, renderer );
		else this._drawStraight( this._shown, renderer );

	}

	// Without a finish, an 8-bit picture as it is.
	_drawStraight( picture, renderer ) {

		if ( ! this._copy ) {

			const material = new MeshBasicNodeMaterial();
			const sample = textureNode( picture.texture, screenUV );
			material.outputNode = vec4( sample.rgb.mul( sample.a ), sample.a );
			this._copy = { material, sample, quad: new QuadMesh( material ) };

		}

		this._copy.sample.value = picture.texture;
		renderer.setSize( picture.width, picture.height, false );
		const { toneMapping, outputColorSpace } = renderer;
		renderer.toneMapping = NoToneMapping;
		renderer.outputColorSpace = LinearSRGBColorSpace;
		try {

			renderer.setRenderTarget( null );
			this._copy.quad.render( renderer );

		} finally {

			renderer.toneMapping = toneMapping;
			renderer.outputColorSpace = outputColorSpace;

		}

	}

	// The view's HDR version, then the grade: rebuilt only when either changes.
	_applyTransform() {

		const tsl = this._tsl, grade = this._grade;
		if ( ! tsl || ( this._applied?.tsl === tsl && this._applied.grade === grade ) ) return;
		this._applied = { tsl, grade };
		this._compositor.setCanvasTransform( grade ? ( color, exposure ) => grade( tsl( color, exposure ) ) : tsl );

	}

	dispose() {

		this._ticket ++;
		this._compositor?.dispose();
		this._local?.dispose();
		this._texture?.dispose();
		this._target?.dispose();
		this._copy?.material.dispose();
		disposeRenderer( this.renderer );
		this.renderer = this._compositor = this._local = this._texture = this._tsl = this._grade = this._applied = this._color = null;
		this._target = this._copy = this._finish = this._shown = this._source = null;

	}

}

/**
 * One string attribute of an EXR's header: its text, undefined when the header has none, null when `bytes` end first.
 * Read before the pixels, so a file that will not be shown is never decoded.
 */
function exrAttribute( bytes, wanted ) {

	const data = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const text = new TextDecoder();
	let at = 8;
	const string = () => {

		const end = bytes.indexOf( 0, at );
		if ( end < 0 ) return null;
		const value = text.decode( bytes.subarray( at, end ) );
		at = end + 1;
		return value;

	};

	while ( at < bytes.length ) {

		const name = string();
		if ( name === '' ) return undefined;
		if ( name === null || string() === null || at + 4 > bytes.length ) return null;
		const size = data.getUint32( at, true );
		at += 4;
		if ( at + size > bytes.length ) return null;
		if ( name === wanted ) return text.decode( bytes.subarray( at, at + size ) );
		at += size;

	}

	return null;

}
