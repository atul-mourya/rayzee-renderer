import { DataTexture, HalfFloatType, NearestFilter, RGBAFormat } from 'three';
import { Compositor } from '../../pipeline/Compositor.js';
import { LocalExposure } from './LocalExposure.js';
import { PipelineContext } from '../../pipeline/PipelineContext.js';
import { holdCanvasColorSpace } from '../../color/ColorManagement.js';
import { createRendererOnDevice, disposeRenderer } from '../../RayzeeRenderer.js';

// Enough for any header `exportImage` writes; a longer one is read whole.
const HEADER_BYTES = 1 << 18;

/**
 * A saved render shown again as an HDR screen showed it: the EXR `exportImage` wrote, through the same compositor,
 * local exposure and HDR version of the view, at the exposure the file records (`getProvenance().display`). It draws
 * on a canvas of its own with a renderer on the main one's device, so the live view is left as it is.
 *
 *   const view = await app.createPictureView( canvas );
 *   const { shown, reason } = await view.show( exrBlob );
 *   view.setGrade( c => c.mul( 1.1 ) );   // a host's own edit, on the shown (encoded, extended) colour
 */
export class PictureView {

	constructor( { color, device }, canvas ) {

		this._color = color;
		this._device = device;
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

	}

	async init() {

		this.renderer = await createRendererOnDevice( this._device, { canvas: this.canvas, outputType: HalfFloatType, depth: false } );
		this._compositor = new Compositor( this.renderer );
		this._local = new LocalExposure( this.renderer );
		return this;

	}

	/**
	 * Shows a saved render's EXR. Not shown, with `reason`: 'hdr-off' (the screen shows no HDR), 'not-recorded' (a file
	 * from before its exposure was recorded), 'needs-config' / 'other-config' (its colour config is not the one loaded),
	 * 'no-hdr-version', 'bake-failed', or 'superseded' by a later `show()`. Only a file it shows is decoded.
	 * @param {Blob|ArrayBuffer} file
	 * @returns {Promise<{ shown: boolean, reason?: string }>}
	 */
	async show( file ) {

		const ticket = ++ this._ticket;
		const superseded = { shown: false, reason: 'superseded' };
		if ( ! this._color?.hdrOutput ) return { shown: false, reason: 'hdr-off' };

		const bytes = async end => new Uint8Array( file instanceof Blob ? await file.slice( 0, end ).arrayBuffer() : file.slice( 0, end ) );
		let record = exrAttribute( await bytes( HEADER_BYTES ), 'rayzee' );
		if ( record === null ) record = exrAttribute( await bytes(), 'rayzee' );
		let details = null;
		try {

			details = JSON.parse( record );

		} catch { /* no record */ }

		if ( ticket !== this._ticket ) return superseded;
		if ( ! details?.display || ! details.color?.view ) return { shown: false, reason: 'not-recorded' };
		const version = this._color.hdrVersionOf( details.color.view );
		if ( ! version.table ) return { shown: false, reason: version.reason };

		const [ { EXRLoader }, pixels ] = await Promise.all( [ import( 'three/examples/jsm/loaders/EXRLoader.js' ), bytes() ] );
		if ( ticket !== this._ticket ) return superseded;
		this._draw( new EXRLoader().setDataType( HalfFloatType ).parse( pixels.buffer ), details, version.table );
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

		renderer.setSize( width, height, false );
		renderer.toneMappingExposure = display.exposure ?? 1;
		holdCanvasColorSpace( this.canvas, table.ocio.canvas );

		compositor.setSaturation( details.settings?.saturation ?? 1 );
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
		compositor.render( context );

	}

	/**
	 * A host's edit on the shown colour, after the view: `( rgb ) => rgb`, TSL nodes, the canvas's encoding extended
	 * past 1. Its uniforms change without a rebuild; `redraw()` then shows them. Null removes it.
	 */
	setGrade( grade ) {

		if ( grade === this._grade ) return;
		this._grade = grade;
		this._applyTransform();
		this.redraw();

	}

	/** Draws the shown picture again, after a grade's uniforms changed. */
	redraw() {

		if ( this._tsl ) this._compositor.render( this._context );

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
		disposeRenderer( this.renderer );
		this.renderer = this._compositor = this._local = this._texture = this._tsl = this._grade = this._applied = this._color = null;

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
