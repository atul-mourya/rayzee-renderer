/**
 * TileHelper — 2D canvas overlay showing the active tile border.
 *
 * Shows progress of the OIDN denoiser and AI upscaler (both process the
 * image in tiles). Callers provide pixel-space tile bounds via
 * `setActiveTile()` and control visibility via `show()` / `hide()`.
 *
 * Layer: 'hud' (rendered by OverlayManager's 2D canvas pass).
 *
 * @example
 *   const tileHelper = new TileHelper();
 *   overlayManager.register( 'tiles', tileHelper );
 *   tileHelper.setRenderSize( 1920, 1080 );
 *   tileHelper.setActiveTile( { x: 0, y: 0, width: 480, height: 270 } );
 *   tileHelper.show();
 */
export class TileHelper {

	constructor() {

		this.layer = 'hud';
		this.visible = false;

		// Active tile bounds in render/image pixels
		this._tileBounds = null; // { x, y, width, height }

		// Source image dimensions (for mapping to display coordinates)
		this._imageWidth = 1;
		this._imageHeight = 1;

		// Whether the user has enabled the tile helper via UI toggle
		this.enabled = true;

		// Style — line width derives from display size each frame so the
		// border looks the same thickness regardless of canvas resolution.
		this._borderColor = 'rgba(255, 0, 0, 0.6)';
		this._borderWidthRatio = 1 / 540; // ~2px on 1080p, ~4px on 4K
		this._borderWidthMin = 1.5;
		this._borderWidthMax = 4;

	}

	// ═══════════════════════════════════════════════════════════════
	// Data setters
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Sets the active tile to highlight.
	 * @param {{ x: number, y: number, width: number, height: number }|null} bounds
	 *   Pixel-space bounds in the source image. Pass null to clear.
	 */
	setActiveTile( bounds ) {

		this._tileBounds = bounds;

	}

	/**
	 * Sets the source image dimensions used to map tile bounds
	 * to display coordinates on the HUD canvas.
	 * @param {number} width
	 * @param {number} height
	 */
	setRenderSize( width, height ) {

		this._imageWidth = width;
		this._imageHeight = height;

	}

	// ═══════════════════════════════════════════════════════════════
	// Rendering (called by OverlayManager)
	// ═══════════════════════════════════════════════════════════════

	/**
	 * @param {CanvasRenderingContext2D} ctx
	 * @param {number} displayW - Display width in CSS pixels
	 * @param {number} displayH - Display height in CSS pixels
	 */
	render( ctx, displayW, displayH ) {

		if ( ! this._tileBounds ) return;

		const bounds = this._tileBounds;
		const scaleX = displayW / this._imageWidth;
		const scaleY = displayH / this._imageHeight;

		const x = bounds.x * scaleX;
		const y = bounds.y * scaleY;
		const w = bounds.width * scaleX;
		const h = bounds.height * scaleY;

		const lineWidth = Math.min(
			this._borderWidthMax,
			Math.max( this._borderWidthMin, Math.min( displayW, displayH ) * this._borderWidthRatio )
		);

		ctx.strokeStyle = this._borderColor;
		ctx.lineWidth = lineWidth;
		ctx.strokeRect( x, y, w, h );

	}

	// ═══════════════════════════════════════════════════════════════
	// Visibility (required by OverlayManager interface)
	// ═══════════════════════════════════════════════════════════════

	show() {

		if ( this.enabled ) this.visible = true;

	}

	hide() {

		this.visible = false;
		this._tileBounds = null;

	}

	dispose() {

		this.visible = false;

	}

}
