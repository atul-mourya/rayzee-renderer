import { vec4, vec3, uv, uniform, select, dot, mix, float, int, uint, storage, Fn, If } from 'three/tsl';
import { MeshBasicNodeMaterial, QuadMesh, TextureNode } from 'three/webgpu';
import { NoBlending, NoToneMapping } from 'three';
import { RenderStage, StageExecutionMode } from '../Pipeline/RenderStage.js';
import { REC709_LUMINANCE_COEFFICIENTS } from '../TSL/Common.js';

/**
 * Compositor — Terminal pipeline stage.
 *
 * Selects the latest upstream texture via a priority fallback chain, applies
 * a saturation grade, sets alpha, and hands the linear HDR result to the
 * renderer's output pass (tone mapping + sRGB gamma happen there).
 *
 * Exposure is not applied here — `renderer.toneMappingExposure` owns it,
 * and Three.js applies it inside the tone-mapping branch of the output pass
 * (so it has no effect when `renderer.toneMapping === NoToneMapping`).
 */
export class Compositor extends RenderStage {

	constructor( renderer, options = {} ) {

		super( 'Compositor', {
			...options,
			executionMode: StageExecutionMode.ALWAYS
		} );

		this.renderer = renderer;

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

		const texSample = this._sourceTexNode.sample( uv() );

		const luma = dot( texSample.xyz, REC709_LUMINANCE_COEFFICIENTS );
		const gradedColor = mix( vec3( luma ), texSample.xyz, this.saturation );

		const outputAlpha = select( this._transparentBackground, texSample.w, 1.0 );

		this.compositorMaterial = new MeshBasicNodeMaterial();
		this.compositorMaterial.colorNode = vec4( gradedColor, outputAlpha );
		this.compositorMaterial.blending = NoBlending;

		this.compositorQuad = new QuadMesh( this.compositorMaterial );

	}

	/**
	 * Later stages in the chain take priority; `pathtracer:color` is the
	 * baseline fallback that is always present.
	 */
	_resolveSourceTexture( context ) {

		return context.getTexture( 'bloom:output' )
			|| context.getTexture( 'edgeFiltering:output' )
			|| context.getTexture( 'bilateralFiltering:output' )
			|| context.getTexture( 'asvgf:output' )
			|| context.getTexture( 'pathtracer:color' );

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

		const sourceTexture = this._resolveSourceTexture( context );
		if ( ! sourceTexture ) return;

		this._sourceTexNode.value = sourceTexture;

		this.renderer.setRenderTarget( null );
		this.compositorQuad.render( this.renderer );

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
