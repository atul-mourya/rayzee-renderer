import { SRGBColorSpace } from 'three';
import { createRendererOnDevice, disposeRenderer, takeFrameStep } from '../../RayzeeRenderer.js';

/**
 * Shared plumbing for the overlay canvases stacked over the main WebGPU canvas
 * (the 3D scene layer and the 2D HUD). Both must agree on positioning and on
 * how an on-screen box maps to device pixels, so both come from here.
 */

/** Beyond 2× the extra pixels are invisible but the cost is not. */
const MAX_VIEW_DPR = 2;

/**
 * Creates a transparent, click-through canvas that covers its container.
 * @param {boolean} [hidden=false] - Start parked (`display:none`)
 * @returns {HTMLCanvasElement}
 */
export function createOverlayCanvas( hidden = false ) {

	const canvas = document.createElement( 'canvas' );
	canvas.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;'
		+ ( hidden ? 'display:none;' : '' );
	return canvas;

}

/**
 * Device-pixel size of an element as it actually appears on screen. Uses the
 * bounding rect (not clientWidth) so the viewport's CSS zoom is included.
 *
 * @param {HTMLElement} element
 * @param {number} [maxDim=Infinity] - Per-axis ceiling; the box is scaled down uniformly to fit
 * @returns {{ width: number, height: number }|null} null when the element has no layout box
 */
export function viewPixelSize( element, maxDim = Infinity ) {

	const rect = element?.getBoundingClientRect();
	if ( ! rect || rect.width === 0 || rect.height === 0 ) return null;

	const dpr = Math.min( window.devicePixelRatio || 1, MAX_VIEW_DPR );
	let width = Math.round( rect.width * dpr );
	let height = Math.round( rect.height * dpr );

	// Uniform scale — a per-axis clamp would skew the aspect and slide the
	// helpers out of alignment with the rendered image underneath.
	const clamp = maxDim / Math.max( width, height );
	if ( clamp < 1 ) {

		width = Math.max( 1, Math.round( width * clamp ) );
		height = Math.max( 1, Math.round( height * clamp ) );

	}

	return { width, height };

}

/** Device-pixel ceiling per axis — guards against huge surfaces at high viewport zoom. */
const MAX_OVERLAY_DIM = 4096;

/**
 * ViewOverlayRenderer — a transparent canvas sized to what the user actually
 * sees, driven by its own WebGPURenderer.
 *
 * The main canvas' backing store is the *render* resolution (512 in preview,
 * up to 4K for a final render), and CSS stretches it to fit the viewport. Any
 * helper drawn into that backbuffer inherits the render resolution and is then
 * rescaled by the browser — soft gizmos at low render scale, wasted pixels at
 * high. This surface instead matches the on-screen size (bounding rect × DPR,
 * so the viewport zoom is included), so gizmos and outlines stay crisp and
 * screen-space-correct at any render resolution.
 *
 * The renderer shares the main renderer's `GPUDevice`, so this costs a
 * swapchain, not a second WebGPU context. Helpers rendered here are also
 * physically absent from the main canvas, so they can never leak into a saved
 * image.
 *
 * @example
 *   const overlay = new ViewOverlayRenderer();
 *   await overlay.init( { device: renderer.backend.device, sizeSource: canvas } );
 *   container.appendChild( overlay.canvas );
 *   // per frame:
 *   overlay.syncSize();
 *   overlay.begin();
 *   helperScene.render( overlay.renderer, camera );
 */
export class ViewOverlayRenderer {

	constructor() {

		// Starts parked: three allocates the output-pass framebuffer (~30 MiB at
		// 1600²) on the first clear, so a session that never shows a helper never
		// pays for it.
		this.canvas = createOverlayCanvas( true );
		this._visible = false;

		/** @type {import('three/webgpu').WebGPURenderer|null} */
		this.renderer = null;

		this._sizeSource = null;

	}

	/**
	 * Creates the renderer on the shared device.
	 *
	 * @param {Object} config
	 * @param {GPUDevice} config.device - Device to share with the main renderer
	 * @param {HTMLElement} config.sizeSource - Element whose on-screen box defines the overlay size
	 * @returns {Promise<ViewOverlayRenderer>}
	 */
	async init( { device, sizeSource } ) {

		this._sizeSource = sizeSource;

		// At DPR ≥ 2 the browser's downscale already supersamples the edges, so MSAA
		// would only add a multisampled attachment for no visible gain. Below that
		// there is nothing to hide jaggies, so pay for it.
		const renderer = await createRendererOnDevice( device, {
			canvas: this.canvas,
			alpha: true,
			antialias: ( window.devicePixelRatio || 1 ) < MAX_VIEW_DPR,
		} );

		renderer.outputColorSpace = SRGBColorSpace;
		renderer.setClearColor( 0x000000, 0 );
		// Every frame starts with an explicit clear() in begin(); helpers then
		// stack on top of each other without wiping what came before.
		renderer.autoClear = false;

		this.renderer = renderer;
		this.syncSize();

		return this;

	}

	get isVisible() {

		return this._visible;

	}

	/** Matches the backing store to the size source's on-screen box. */
	syncSize() {

		if ( ! this.renderer ) return;

		const size = viewPixelSize( this._sizeSource, MAX_OVERLAY_DIM );
		if ( ! size || ( size.width === this.canvas.width && size.height === this.canvas.height ) ) return;

		this.renderer.setSize( size.width, size.height, false );

	}

	/** Clears the surface to fully transparent. Call once before drawing helpers. */
	begin() {

		if ( ! this.renderer ) return;

		takeFrameStep( this.renderer );
		this.renderer.setRenderTarget( null );
		this.renderer.clear();

	}

	setVisible( visible ) {

		if ( this._visible === visible ) return;

		this._visible = visible;
		this.canvas.style.display = visible ? '' : 'none';

	}

	dispose() {

		disposeRenderer( this.renderer );
		this.renderer = null;
		this.canvas.parentElement?.removeChild( this.canvas );

	}

}
