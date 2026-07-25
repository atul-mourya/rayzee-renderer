import { TileHelper } from './helpers/TileHelper.js';
import { OutlineHelper } from './helpers/OutlineHelper.js';
import { ViewOverlayRenderer } from './helpers/ViewOverlayRenderer.js';
import { createOverlayCanvas, viewPixelSize } from './helpers/overlaySurface.js';
import { createLogger } from '../utils/Logger.js';

const log = createLogger( 'overlay' );

/** Whether a helper wants to draw into the given layer this frame. */
const drawsOn = ( helper, layer ) => helper.visible && helper.layer === layer && helper.render;

/**
 * OverlayManager — Unified overlay system for visual helpers.
 *
 * Two rendering layers, both sized to the **view** (what the user sees on
 * screen) rather than to the path tracer's render resolution:
 *   1. **Scene layer** — Three.js content (light gizmos, transform gizmo,
 *      selection outline) drawn by {@link ViewOverlayRenderer} into its own
 *      transparent canvas stacked over the main one.
 *   2. **HUDCanvas** — A 2D `<canvas>` element overlaid via CSS for screen-space
 *      elements (denoise/upscale tile progress).
 *
 * Neither layer touches the main canvas, so helpers can never be captured in a
 * saved image.
 *
 * Helpers are registered by name and implement a simple interface:
 *   { update?(), render?(ctx, w, h), show(), hide(), dispose(), visible, layer }
 *
 * @example
 *   const overlay = new OverlayManager( camera );
 *   await overlay.initViewRenderer( { device, sizeSource: canvas } );
 *   overlay.register( 'outline', new OutlineHelper() );
 *   overlay.show( 'outline' );
 *   // in animate():
 *   overlay.render();
 */
export class OverlayManager {

	/**
	 * @param {import('three').PerspectiveCamera} camera
	 */
	constructor( camera ) {

		this.camera = camera;

		/** @type {Map<string, Object>} */
		this._helpers = new Map();

		// ── HUD Canvas (2D overlay) ──
		this._hudCanvas = createOverlayCanvas();
		this._hudCtx = this._hudCanvas.getContext( '2d' );

		// ── HelperScene reference (set via setHelperScene) ──
		this._helperScene = null;

		/** @type {ViewOverlayRenderer|null} */
		this._viewOverlay = null;

	}

	/**
	 * Creates the view-resolution surface the scene layer draws into. On failure
	 * the scene layer stays off rather than degrading onto the main backbuffer —
	 * drawing there would bake helpers into saved images.
	 *
	 * @param {Object} config
	 * @param {GPUDevice} config.device - Shared with the main renderer
	 * @param {HTMLElement} config.sizeSource - Element whose on-screen box defines the size
	 */
	async initViewRenderer( { device, sizeSource } ) {

		if ( ! device || ! sizeSource ) return;

		try {

			this._viewOverlay = await new ViewOverlayRenderer().init( { device, sizeSource } );

		} catch ( err ) {

			log.error( 'overlay surface unavailable — light gizmos, transform gizmo and outlines are disabled', err );
			this._viewOverlay = null;

		}

	}

	/**
	 * Sets the SceneHelpers instance used for 3D overlay rendering.
	 * @param {import('../SceneHelpers.js').SceneHelpers} helperScene
	 */
	setHelperScene( helperScene ) {

		this._helperScene = helperScene;

	}

	/**
	 * Returns the HUD canvas element. Normally mounted automatically by
	 * {@link PathTracerApp}; exposed for advanced clients that mount it manually.
	 * @returns {HTMLCanvasElement}
	 */
	getHUDCanvas() {

		return this._hudCanvas;

	}

	/**
	 * Mounts the overlay canvases into the given container. Idempotent — safe to
	 * call multiple times; re-mounts only when the parent differs. The 3D surface
	 * goes in first so the HUD stacks above it.
	 * @param {HTMLElement} container
	 */
	mount( container ) {

		if ( ! container ) return;

		const viewCanvas = this._viewOverlay?.canvas;
		if ( viewCanvas && viewCanvas.parentElement !== container ) container.appendChild( viewCanvas );

		if ( this._hudCanvas.parentElement !== container ) container.appendChild( this._hudCanvas );

	}

	// ═══════════════════════════════════════════════════════════════
	// Default helpers setup
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Creates and wires the default overlay helpers (denoise/upscale progress, outline).
	 * Call once during app init after pipeline and managers are ready.
	 *
	 * @param {Object} config
	 * @param {import('../SceneHelpers.js').SceneHelpers} config.helperScene
	 * @param {import('three').Scene} config.meshScene
	 * @param {import('../Pipeline/RenderPipeline.js').RenderPipeline} config.pipeline
	 * @param {import('./DenoisingManager.js').DenoisingManager} config.denoisingManager
	 * @param {import('three').EventDispatcher} config.app - App instance for resize events
	 * @param {number} config.renderWidth
	 * @param {number} config.renderHeight
	 */
	setupDefaultHelpers( { helperScene, meshScene, pipeline, denoisingManager, app, renderWidth, renderHeight } ) {

		this.setHelperScene( helperScene );

		// ── Tile helper — shows OIDN denoise + AI upscale progress ──
		const tileHelper = new TileHelper();
		this.register( 'tiles', tileHelper );

		tileHelper.setRenderSize( renderWidth || 1, renderHeight || 1 );

		app.addEventListener( 'resolution_changed', ( e ) => {

			tileHelper.setRenderSize( e.width, e.height );

		} );

		pipeline.eventBus.on( 'pipeline:reset', () => tileHelper.hide() );

		this._wireDenoiserTileEvents( tileHelper, denoisingManager );

		// ── Outline helper ──
		const outlineHelper = new OutlineHelper( meshScene, this.camera );
		this.register( 'outline', outlineHelper );

	}

	/**
	 * Wires denoiser/upscaler tile-progress events to the tile helper.
	 * These fire while the animation loop is stopped, so we trigger manual HUD redraws.
	 */
	_wireDenoiserTileEvents( tileHelper, denoisingManager ) {

		const sources = [ denoisingManager?.denoiser, denoisingManager?.upscaler ];

		for ( const source of sources ) {

			if ( ! source ) continue;

			source.addEventListener( 'tileProgress', ( e ) => {

				if ( e.tile ) {

					tileHelper.setRenderSize( e.imageWidth, e.imageHeight );
					tileHelper.setActiveTile( e.tile );
					tileHelper.show();
					this.refreshHUD();

				}

			} );

			source.addEventListener( 'end', () => {

				tileHelper.hide();
				this.refreshHUD();

			} );

		}

	}

	// ═══════════════════════════════════════════════════════════════
	// Helper registration
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Registers a named helper.
	 * @param {string} name
	 * @param {Object} helper — must implement at least { show(), hide(), dispose() }
	 */
	register( name, helper ) {

		if ( this._helpers.has( name ) ) {

			log.warn( `helper "${name}" already registered — replacing.` );
			this._helpers.get( name ).dispose?.();

		}

		this._helpers.set( name, helper );

	}

	/**
	 * Unregisters and disposes a named helper.
	 * @param {string} name
	 */
	unregister( name ) {

		const helper = this._helpers.get( name );
		if ( ! helper ) return;

		helper.dispose?.();
		this._helpers.delete( name );

	}

	// ═══════════════════════════════════════════════════════════════
	// Visibility API
	// ═══════════════════════════════════════════════════════════════

	show( name ) {

		this._helpers.get( name )?.show();

	}

	hide( name ) {

		this._helpers.get( name )?.hide();

	}

	toggle( name ) {

		const helper = this._helpers.get( name );
		if ( ! helper ) return;

		if ( helper.visible ) {

			helper.hide();

		} else {

			helper.show();

		}

	}

	getHelper( name ) {

		return this._helpers.get( name ) ?? null;

	}

	isVisible( name ) {

		return this._helpers.get( name )?.visible ?? false;

	}

	showAll() {

		for ( const helper of this._helpers.values() ) helper.show();

	}

	hideAll() {

		for ( const helper of this._helpers.values() ) helper.hide();

	}

	// ═══════════════════════════════════════════════════════════════
	// Per-frame rendering
	// ═══════════════════════════════════════════════════════════════

	/**
	 * Renders all visible overlays. Call once per frame after the main pipeline.
	 */
	render() {

		const overlay = this._viewOverlay;

		if ( overlay ) {

			const hasSceneOverlay = this._hasVisibleSceneOverlay();

			if ( hasSceneOverlay || overlay.isVisible ) {

				overlay.syncSize();
				// Doubles as the wipe of last frame's content when parking.
				overlay.begin();
				if ( hasSceneOverlay ) this._renderSceneLayer( overlay.renderer );
				overlay.setVisible( hasSceneOverlay );

			}

		}

		this.refreshHUD();

	}

	/** Draws the helper scene + every visible scene-layer helper. */
	_renderSceneLayer( renderer ) {

		this._helperScene?.render( renderer, this.camera );

		for ( const helper of this._helpers.values() ) {

			if ( drawsOn( helper, 'scene' ) ) helper.render( renderer, this.camera );

		}

	}

	/** Whether anything at all wants to draw into the scene layer this frame. */
	_hasVisibleSceneOverlay() {

		if ( this._helperScene?.isDrawing ) return true;

		for ( const helper of this._helpers.values() ) {

			if ( drawsOn( helper, 'scene' ) ) return true;

		}

		return false;

	}

	/**
	 * Redraws the HUD canvas. Safe to call outside the animation loop
	 * (e.g. during async OIDN tile progress).
	 */
	refreshHUD() {

		const canvas = this._hudCanvas;
		const ctx = this._hudCtx;

		// Fast path: skip all canvas work when nothing is visible
		let hasVisibleHUD = false;
		for ( const helper of this._helpers.values() ) {

			if ( drawsOn( helper, 'hud' ) ) {

				hasVisibleHUD = true;
				break;

			}

		}

		if ( ! hasVisibleHUD ) {

			if ( canvas.style.display !== 'none' ) canvas.style.display = 'none';
			return;

		}

		// Helpers draw in CSS-pixel coordinates of the unscaled layout box; the
		// backing store is sized off the on-screen box, so nothing is drawn below
		// view resolution.
		const displayW = canvas.clientWidth;
		const displayH = canvas.clientHeight;
		const size = displayW > 0 && displayH > 0 ? viewPixelSize( canvas ) : null;
		if ( ! size ) return;

		if ( canvas.width !== size.width || canvas.height !== size.height ) {

			canvas.width = size.width;
			canvas.height = size.height;

		}

		ctx.clearRect( 0, 0, size.width, size.height );
		ctx.save();
		ctx.scale( size.width / displayW, size.height / displayH );

		for ( const helper of this._helpers.values() ) {

			if ( drawsOn( helper, 'hud' ) ) helper.render( ctx, displayW, displayH );

		}

		ctx.restore();
		if ( canvas.style.display !== '' ) canvas.style.display = '';

	}

	// ═══════════════════════════════════════════════════════════════
	// Lifecycle
	// ═══════════════════════════════════════════════════════════════

	dispose() {

		for ( const helper of this._helpers.values() ) {

			helper.dispose?.();

		}

		this._helpers.clear();

		this._viewOverlay?.dispose();
		this._viewOverlay = null;

		if ( this._hudCanvas.parentElement ) {

			this._hudCanvas.parentElement.removeChild( this._hudCanvas );

		}

	}

}
