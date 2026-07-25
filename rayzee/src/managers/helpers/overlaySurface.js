/**
 * Shared plumbing for the overlay canvases stacked over the main WebGPU canvas
 * (the 3D scene layer and the 2D HUD). Both must agree on positioning and on
 * how an on-screen box maps to device pixels, so both come from here.
 */

/** Beyond 2× the extra pixels are invisible but the cost is not. */
export const MAX_VIEW_DPR = 2;

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
