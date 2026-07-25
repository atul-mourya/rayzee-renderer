import { outline } from 'three/addons/tsl/display/OutlineNode.js';
import { MeshBasicNodeMaterial, QuadMesh } from 'three/webgpu';
import { AddEquation, Color, CustomBlending, OneFactor } from 'three';
import { uniform, vec4 } from 'three/tsl';

/**
 * OutlineHelper — Renders selection outlines as a post-pipeline overlay.
 *
 * Uses Three.js OutlineNode internally but renders to a separate fullscreen
 * quad, composited on top of the path traced image. Drawn by OverlayManager's
 * scene layer, which runs at **view resolution** — so outlines stay a crisp
 * screen-space width regardless of the path tracer's render resolution.
 *
 * The quad is additive, but writes coverage into alpha (rather than a constant
 * 1.0) so it composites correctly onto the transparent overlay surface instead
 * of turning the whole frame opaque.
 *
 * Layer: 'scene' (rendered by OverlayManager's 3D pass, not HUD canvas).
 *
 * @example
 *   const outlineHelper = new OutlineHelper( meshScene, camera );
 *   overlayManager.register( 'outline', outlineHelper );
 *   outlineHelper.setSelectedObjects( [ mesh ] );
 */
export class OutlineHelper {

	constructor( scene, camera ) {

		this.layer = 'scene';
		this._enabled = true;

		// Outline node (handles its own multi-pass rendering via updateBefore).
		// It sizes its render targets from the drawing buffer of whatever renderer
		// draws it — the view overlay surface — so no size override is needed.
		this._outlineNode = outline( scene, camera, {
			selectedObjects: [],
			edgeThickness: uniform( 1.0 ),
			edgeGlow: uniform( 0.0 ),
		} );

		// Build the outline color from visible + hidden edges
		const edgeStrength = uniform( 3.0 );
		const visibleEdgeColor = uniform( new Color( 0xffffff ) );
		const hiddenEdgeColor = uniform( new Color( 0x190a05 ) );
		const { visibleEdge, hiddenEdge } = this._outlineNode;
		const outlineColorNode = visibleEdge.mul( visibleEdgeColor )
			.add( hiddenEdge.mul( hiddenEdgeColor ) )
			.mul( edgeStrength );

		const coverage = outlineColorNode.r.max( outlineColorNode.g ).max( outlineColorNode.b ).clamp( 0.0, 1.0 );

		// Fullscreen quad, premultiplied-additive: dst.rgb += src.rgb, dst.a += src.a.
		// Spelled out rather than AdditiveBlending + premultipliedAlpha, because the
		// latter also makes NodeMaterial multiply rgb by alpha — squaring a soft edge.
		this._material = new MeshBasicNodeMaterial();
		this._material.colorNode = vec4( outlineColorNode, coverage );
		this._material.transparent = true;
		this._material.blending = CustomBlending;
		this._material.blendEquation = AddEquation;
		this._material.blendSrc = OneFactor;
		this._material.blendDst = OneFactor;
		this._material.blendEquationAlpha = AddEquation;
		this._material.blendSrcAlpha = OneFactor;
		this._material.blendDstAlpha = OneFactor;
		this._material.toneMapped = false;
		this._material.depthTest = false;
		this._material.depthWrite = false;

		this._quad = new QuadMesh( this._material );

	}

	/**
	 * Sets the objects to outline.
	 * @param {Object3D[]} objects
	 */
	setSelectedObjects( objects ) {

		this._outlineNode.selectedObjects = objects;

	}

	/**
	 * Nothing selected means nothing to draw — reported here so the overlay
	 * surface can stay parked instead of clearing every frame.
	 */
	get visible() {

		return this._enabled && this._outlineNode.selectedObjects.length > 0;

	}

	/**
	 * Renders the outline overlay onto the current backbuffer.
	 * Called by OverlayManager after Display has rendered.
	 */
	render( renderer ) {

		if ( ! this.visible ) return;

		const prevAutoClear = renderer.autoClear;
		renderer.autoClear = false;
		renderer.setRenderTarget( null );
		this._quad.render( renderer );
		renderer.autoClear = prevAutoClear;

	}

	show() {

		this._enabled = true;

	}

	hide() {

		this._enabled = false;

	}

	dispose() {

		this._enabled = false;
		this._outlineNode?.dispose();
		this._material?.dispose();
		// QuadMesh extends Mesh — no dispose method on the mesh itself;
		// its material is already disposed above. Just drop the ref.
		this._quad = null;

	}

}
