import { vec4, vec3, uv, screenUV, uniform, select, dot, mix, step, float, int, uint, storage, Fn, If, toneMappingExposure, sign } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, TextureNode } from 'three/webgpu';
import { NoBlending, NoToneMapping, ColorManagement as ThreeColorManagement } from 'three';
import { RenderStage, StageExecutionMode } from './RenderStage.js';
import { REC709_LUMINANCE_COEFFICIENTS } from '../shaders/Common.js';
import { backdropGain } from '../output/ToneMapCPU.js';
import { getViewTransform } from '../color/ViewTransforms.js';


/**
 * Compositor — Terminal pipeline stage.
 *
 * Selects the latest upstream texture via a priority fallback chain, applies
 * a saturation grade, sets alpha, and hands the linear HDR result to the
 * renderer's output pass (tone mapping + sRGB gamma happen there) — except a
 * table view, which it draws itself (`_viewQuadFor`).
 *
 * Exposure is not applied here — `renderer.toneMappingExposure` owns it,
 * and Three.js applies it inside the tone-mapping branch of the output pass
 * (so it has no effect when `renderer.toneMapping === NoToneMapping`).
 */
// The canvas's sRGB encoding undone, extended past 1 and mirrored below 0 as the HDR canvas uses it. mix by step, not
// select: a TSL select takes one condition, so a vector one decoded every channel by the first's branch.
const decodeExtendedSRGB = c => {

	const a = c.abs();
	return mix( a.add( 0.055 ).div( 1.055 ).pow( vec3( 2.4 ) ), a.div( 12.92 ), step( a, vec3( 0.04045 ) ) ).mul( sign( c ) );

};

export class Compositor extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'Compositor', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;

		// In priority order: the first one published wins. Whoever builds the pipeline names the
		// processed pictures; the accumulation is the fallback that is always there.
		this._lightSources = [ ...( options.displaySources ?? [] ), 'pathtracer:color' ];

		// 1.0 = neutral; >1 boosts to compensate for ACES/AgX desaturation.
		this.saturation = uniform( options.saturation ?? 1.0 );

		this._transparentBackground = uniform( 0, 'int' );

		// Convergence debug overlay — reads the path tracer's per-pixel convergence buffers read-only.
		// Material is compiled on first enable, so the normal display path carries none of its bindings.
		this._pathTracer = options.pathTracer ?? null;
		this._convergenceOverlay = false;
		this._debugMaterial = null;
		this._debugQuad = null;
		this._debugTexNode = null;
		this._debugM2Attr = null;
		this._debugMaskAttr = null;
		this._debugExposureComp = uniform( 1.0 );

		// TextureNode reused across frames — only `.value` mutates, shader doesn't recompile.
		this._sourceTexNode = new TextureNode();
		this._displayGain = null;

		// A solid backdrop held at this exposure, or null: see setBackdropExposure().
		this._backdropExposure = null;
		this._holdBackdrop = uniform( 0, 'int' );
		this._backdropGain = uniform( 1.0 );

		this._canvasTransform = null;
		this._canvasMaterial = null;
		this._canvasQuad = null;
		this._viewTsl = null;
		this._viewMaterial = null;
		this._viewQuad = null;

		this.compositorMaterial = new MeshBasicNodeMaterial();
		this.compositorMaterial.blending = NoBlending;
		this._buildColorNode();

		this.compositorQuad = new QuadMesh( this.compositorMaterial );
		this.setCanvasTransform( options.canvasTransform ?? null );

	}

	_buildColorNode() {

		const texSample = this._sourceTexNode.sample( uv() );
		let gain = this._displayGain ? this._displayGain( texSample.xyz, screenUV ) : null;
		if ( this._backdropExposure !== null ) {

			// Alpha is coverage: the backdrop takes its own gain, a partly covered pixel a blend (ToneMapCPU's heldGain).
			const g = gain ?? float( 1 );
			const held = g.add( this._backdropGain.sub( g ).mul( texSample.w.clamp( 0, 1 ).oneMinus() ) );
			gain = select( this._holdBackdrop.greaterThan( int( 0 ) ), held, g );

		}

		const color = gain ? texSample.xyz.mul( gain ) : texSample.xyz;

		const luma = dot( color, REC709_LUMINANCE_COEFFICIENTS );
		const gradedColor = mix( vec3( luma ), color, this.saturation );

		const outputAlpha = select( this._transparentBackground, texSample.w, 1.0 );

		this._graded = gradedColor;
		this._alpha = outputAlpha;
		this.compositorMaterial.colorNode = vec4( gradedColor, outputAlpha );
		this.compositorMaterial.needsUpdate = true;
		this._buildCanvasNode();
		this._dropViewQuad();

	}

	_buildCanvasNode() {

		if ( ! this._canvasMaterial ) return;
		// outputNode: three.js clamps a colour node at 0, and below 0 is light outside the canvas's gamut.
		this._canvasMaterial.outputNode = vec4( this._canvasTransform( this._graded, toneMappingExposure ), this._alpha );
		this._canvasMaterial.needsUpdate = true;

	}

	/**
	 * What the canvas shows instead of the renderer's view (`ColorManagement.canvasTransform`), already encoded for it.
	 * Null shows the view itself, as `renderPicture()` always does.
	 */
	setCanvasTransform( transform ) {

		if ( transform === this._canvasTransform ) return;
		this._canvasTransform = transform;
		this._canvasMaterial?.dispose();
		this._canvasMaterial = null;
		this._canvasQuad = null;

		if ( transform ) {

			this._canvasMaterial = new MeshBasicNodeMaterial();
			this._canvasMaterial.blending = NoBlending;
			this._canvasQuad = new QuadMesh( this._canvasMaterial );
			this._buildCanvasNode();

		}

	}

	/**
	 * The active view drawn straight from the light, when it is a table: three.js's output pass first stores the frame
	 * in half floats, and a table on Rec.709's axes showed that rounding of a wider working space (a pure green in
	 * ACEScg read 51 levels of red in Filmic Log, where the readback read 1). Null for a built-in curve.
	 */
	_viewQuadFor() {

		const view = getViewTransform( this.renderer.toneMapping );
		const tsl = view?.source === 'ocio' ? view.tsl ?? null : null;
		if ( tsl === this._viewTsl && ( ! tsl || this._viewQuad ) ) return this._viewQuad;

		this._dropViewQuad();
		this._viewTsl = tsl;
		if ( tsl ) {

			this._viewMaterial = new MeshBasicNodeMaterial();
			this._viewMaterial.blending = NoBlending;
			this._viewMaterial.outputNode = vec4( tsl( this._graded, toneMappingExposure ), this._alpha );
			this._viewQuad = new QuadMesh( this._viewMaterial );

		}

		return this._viewQuad;

	}

	_dropViewQuad() {

		this._viewMaterial?.dispose();
		this._viewMaterial = null;
		this._viewQuad = null;
		this._viewTsl = null;

	}

	/** Whether the canvas shows something other than the view a readback produces. */
	get showsCanvasTransform() {

		return this._canvasQuad !== null;

	}

	/**
	 * A per-pixel gain on the shown picture, before exposure and the view: `( rgb, uv ) => float node`,
	 * `uv` the image position with y down. A readback applies the same through `_displayGain()`. Null removes it.
	 */
	setDisplayGain( gain ) {

		if ( gain === this._displayGain ) return;
		this._displayGain = gain;
		this._buildColorNode();

	}

	/**
	 * Holds a solid-colour backdrop at `exposure` (the manual one): whatever the renderer's exposure does — auto
	 * exposure — and whatever display gain the scene takes, the backdrop is shown as at that exposure. Applies while
	 * the path tracer reports a 'color' backdrop. Null removes it.
	 * @param {number|null} exposure
	 */
	setBackdropExposure( exposure ) {

		const changes = ( exposure === null ) !== ( this._backdropExposure === null );
		this._backdropExposure = exposure;
		if ( changes ) this._buildColorNode();

	}

	/** The exposure a solid backdrop is held at, or null. */
	get backdropExposure() {

		return this._backdropExposure;

	}

	/**
	 * The picture to show: the first published of the display sources, else `pathtracer:color` — the newest
	 * scene-referred image the pipeline holds, denoised when a denoiser has run.
	 */
	resolveLightTexture( context ) {

		return this.resolveLightSource( context )?.texture ?? null;

	}

	/** {@link resolveLightTexture} plus the context key it came from. */
	resolveLightSource( context ) {

		for ( const key of this._lightSources ) {

			const texture = context.getTexture( key );
			if ( texture ) return { key, texture };

		}

		return null;

	}

	/**
	 * Builds (or rebuilds) the convergence-overlay material.
	 *
	 * Re-derives FinalWrite's own convergence predicate from the accumulated colour (the running mean)
	 * and the m2 buffer (its running second moment), so what is painted IS the decision the renderer
	 * makes — nothing is recomputed differently or written back.
	 *
	 * @returns {boolean} True when a material is ready to render.
	 */
	_ensureDebugMaterial() {

		const src = this._pathTracer?.getConvergenceDebugSource?.();
		if ( ! src ) return false;

		// The buffers are only reallocated when the render reserve grows; rebind when that happens.
		if ( this._debugMaterial && this._debugM2Attr === src.m2 && this._debugMaskAttr === src.frozenMask ) return true;

		this._debugMaterial?.dispose();
		this._debugTexNode?.dispose();

		this._debugM2Attr = src.m2;
		this._debugMaskAttr = src.frozenMask;
		this._debugTexNode = new TextureNode();

		// Must stay one Fn body: as a raw node graph TSL emits a .toVar() inside the FIRST branch that demands
		// it, and sibling branches then read an unassigned var<private>.
		const overlayColor = Fn( () => {

			const texel = this._debugTexNode.sample( uv() ).toVar();
			const lum = dot( texel.xyz, REC709_LUMINANCE_COEFFICIENTS ).toVar();

			// The overlay draws at canvas size, the buffers are indexed at render size — go through the pixel index.
			const w = src.renderWidth;
			const h = src.renderHeight;
			const ix = int( uv().x.mul( float( w ) ) ).min( w.sub( int( 1 ) ) ).max( int( 0 ) );
			const iy = int( uv().y.mul( float( h ) ) ).min( h.sub( int( 1 ) ) ).max( int( 0 ) );
			const pixelId = uint( iy.mul( w ).add( ix ) ).toVar();

			const m2 = storage( src.m2, 'float' ).toReadOnly().element( pixelId ).toVar();
			const frozenFlag = storage( src.frozenMask, 'uint' ).toReadOnly().element( pixelId ).toVar();

			const sampleVar = m2.sub( lum.mul( lum ) ).max( float( 0 ) );
			const absSE = sampleVar.div( float( src.frame ).add( 1.0 ) ).sqrt().toVar();

			// Freeze bars on the raw relative error; the whole-frame stop bars on the √-normalized one.
			// Show whichever is actually steering the render.
			const freezeOn = src.usePixelFreeze.greaterThan( int( 0 ) );
			const convNorm = select( lum.lessThan( float( 1.0 ) ), lum.sqrt(), lum ).toVar();
			const err = select( freezeOn, absSE.div( lum.add( float( 1e-4 ) ) ), absSE.div( convNorm.add( float( 1e-4 ) ) ) ).toVar();
			const bar = select( freezeOn, src.pixelFreezeThreshold, src.noiseThreshold ).toVar();
			const ratio = err.div( bar.max( float( 1e-6 ) ) ).toVar();

			// Dim tone-mapped grayscale so scene structure stays readable under the overlay.
			const base = vec3( lum.div( lum.add( float( 1.0 ) ) ).sqrt().mul( 0.55 ) ).toVar();
			const out = base.toVar();

			// Below minSamples the variance is untrustworthy — at frame 0 it is identically zero, which would
			// paint a converged image over pure noise.
			const eligible = float( src.frame ).greaterThanEqual( float( src.adaptiveMinSamples ) );

			If( ratio.greaterThanEqual( float( 1.0 ) ).or( eligible.not() ), () => {

				const heat = mix( vec3( 1.0, 0.8, 0.1 ), vec3( 1.0, 0.1, 0.05 ), ratio.sub( 1.0 ).div( 3.0 ).clamp( 0.0, 1.0 ) );
				out.assign( mix( base, heat, 0.85 ) );

			} );

			// Frozen wins: these are the pixels the renderer actually skipped, dilation halo included.
			If( frozenFlag.equal( uint( 1 ) ).and( freezeOn ), () => {

				out.assign( mix( base, vec3( 0.1, 0.45, 1.0 ), 0.55 ) );

			} );

			return out;

		} );

		// Undo the output pass's exposure (tone-mapped configs only) and linear→sRGB so the palette reads the
		// same at any exposure.
		this._debugMaterial = new MeshBasicNodeMaterial();
		this._debugMaterial.colorNode = vec4( overlayColor().pow( 2.2 ).mul( this._debugExposureComp ), 1.0 );
		this._debugMaterial.blending = NoBlending;
		this._debugQuad = new QuadMesh( this._debugMaterial );

		return true;

	}

	render( context ) {

		this._draw( context, false );

	}

	/** Draws the view itself, as a readback has it, not the canvas's version of it. */
	renderPicture( context ) {

		this._draw( context, true );

	}

	/**
	 * Draws what the canvas shows into `target`, a float render target, as the light the screen emits (1 = SDR white):
	 * the canvas's own version of the view, HDR included. False when the canvas shows the view itself.
	 */
	renderShown( context, target ) {

		if ( ! this._canvasTransform || ! this._prepare( context, true ) ) return false;

		const material = new MeshBasicNodeMaterial();
		material.blending = NoBlending;
		material.outputNode = vec4( decodeExtendedSRGB( this._canvasTransform( this._graded, toneMappingExposure ) ), this._alpha );
		const { toneMapping, outputColorSpace } = this.renderer;
		const previous = this.renderer.getRenderTarget();
		this.renderer.toneMapping = NoToneMapping;
		this.renderer.outputColorSpace = ThreeColorManagement.workingColorSpace;
		try {

			this.renderer.setRenderTarget( target );
			new QuadMesh( material ).render( this.renderer );

		} finally {

			this.renderer.setRenderTarget( previous );
			this.renderer.toneMapping = toneMapping;
			this.renderer.outputColorSpace = outputColorSpace;
			material.dispose();

		}

		return true;

	}

	/**
	 * Points the picture at the newest source and holds a solid backdrop; false when there is nothing to show.
	 * `viaTransform`: drawn through the canvas transform, which applies the exposure whatever the renderer's view.
	 */
	_prepare( context, viaTransform = false ) {

		const sourceTexture = this.resolveLightTexture( context );
		if ( ! sourceTexture ) return false;

		if ( this._backdropExposure !== null ) {

			const hold = context.getState( 'pathtracer:backdrop' ) === 'color';
			this._holdBackdrop.value = hold ? 1 : 0;
			if ( hold ) this._backdropGain.value = viaTransform
				? this._backdropExposure / Math.max( this.renderer.toneMappingExposure, 1e-6 )
				: backdropGain( this._backdropExposure, this.renderer.toneMappingExposure, this.renderer.toneMapping );

		}

		this._sourceTexNode.value = sourceTexture;
		return true;

	}

	_draw( context, picture ) {

		if ( ! this.enabled ) return;

		if ( this._convergenceOverlay && this._ensureDebugMaterial() ) {

			// The error estimate is paired with the raw accumulated colour, not a denoised derivative.
			const ptColor = context.getTexture( 'pathtracer:color' );
			if ( ptColor ) {

				this._debugTexNode.value = ptColor;
				const exposed = this.renderer.toneMapping !== NoToneMapping;
				this._debugExposureComp.value = exposed ? 1 / Math.max( this.renderer.toneMappingExposure, 1e-4 ) : 1;

				this.renderer.setRenderTarget( null );
				this._debugQuad.render( this.renderer );
				return;

			}

		}

		const viaTransform = ! picture && !! this._canvasQuad;
		if ( ! this._prepare( context, viaTransform ) ) return;

		this.renderer.setRenderTarget( null );
		const quad = viaTransform ? this._canvasQuad : this._viewQuadFor();
		if ( ! quad ) {

			this.compositorQuad.render( this.renderer );
			return;

		}

		// The view or the transform has tone mapped and encoded for the canvas: the output pass must do neither again.
		const { toneMapping, outputColorSpace } = this.renderer;
		this.renderer.toneMapping = NoToneMapping;
		this.renderer.outputColorSpace = ThreeColorManagement.workingColorSpace;
		try {

			quad.render( this.renderer );

		} finally {

			this.renderer.toneMapping = toneMapping;
			this.renderer.outputColorSpace = outputColorSpace;

		}

	}

	setConvergenceOverlay( enabled ) {

		this._convergenceOverlay = !! enabled;

	}

	setSaturation( value ) {

		this.saturation.value = value;

	}

	setTransparentBackground( enabled ) {

		this._transparentBackground.value = enabled ? 1 : 0;

	}

	dispose() {

		this._sourceTexNode?.dispose();
		this.compositorMaterial?.dispose();
		this._canvasMaterial?.dispose();
		this._canvasMaterial = null;
		this._canvasQuad = null;
		this._canvasTransform = null;
		this._dropViewQuad();
		this._debugTexNode?.dispose();
		this._debugMaterial?.dispose();
		// QuadMesh extends Mesh — no dispose method; material already released above.
		this.compositorQuad = null;
		this._debugQuad = null;
		this._debugMaterial = null;
		this._debugTexNode = null;
		this._pathTracer = null;

	}

}
