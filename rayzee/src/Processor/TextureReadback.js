/**
 * Any texture the pipeline publishes, read back as linear float RGBA.
 *
 * The denoisers publish their output as whatever they happen to own — a render target's texture,
 * or, for OIDN, an ExternalTexture wrapping a raw GPUTexture that no render target owns — and only a
 * render target can be read back. So this draws the texture into one float target of its own and
 * reads that.
 *
 * ⚠️ Drawn through `outputNode`, not `colorNode`: a colour node gets the renderer's tone mapping,
 * output transfer and a forced alpha of 1, and this has to return the light itself.
 */

import { RenderTarget, FloatType, RGBAFormat, NearestFilter } from 'three';
import { QuadMesh, NodeMaterial } from 'three/webgpu';
import { texture as tslTexture, screenCoordinate, ivec2 } from 'three/tsl';

export class TextureReadback {

	constructor( renderer ) {

		this.renderer = renderer;
		this.target = null;
		this.material = new NodeMaterial();
		this.material.name = 'rayzee:texture-readback';
		this.quad = new QuadMesh( this.material );
		this._node = null;
		this._source = null;

	}

	_ensureTarget( width, height ) {

		if ( this.target && this.target.width === width && this.target.height === height ) return;

		this.target?.dispose();
		this.target = new RenderTarget( width, height, {
			type: FloatType, format: RGBAFormat, depthBuffer: false,
			minFilter: NearestFilter, magFilter: NearestFilter,
		} );

	}

	/**
	 * @param {import('three').Texture} source
	 * @returns {Promise<Float32Array>} `width * height * 4`, top row first
	 */
	async read( source, width, height ) {

		try {

			return await this.renderer.readRenderTargetPixelsAsync( this.draw( source, width, height ), 0, 0, width, height );

		} finally {

			this.release();

		}

	}

	/**
	 * Draws `source` into this pass's float target, for a caller that reads it on the GPU. Pair with
	 * `release()`.
	 * @returns {import('three').RenderTarget}
	 */
	draw( source, width, height ) {

		this._ensureTarget( width, height );

		if ( this._source !== source ) {

			// Fetched by pixel, not sampled over 0..1: the pools are allocated larger than the frame,
			// and sampling would squash the whole allocation into it.
			this._node = tslTexture( source ).load( ivec2( screenCoordinate.xy ) );
			this.material.outputNode = this._node;
			this.material.needsUpdate = true;
			this._source = source;

		}

		const previous = this.renderer.getRenderTarget();
		this.renderer.setRenderTarget( this.target );
		this.quad.render( this.renderer );
		this.renderer.setRenderTarget( previous );
		return this.target;

	}

	// A float target the size of the frame — 132 MB at 4K — for something done once per saved file.
	// Not worth keeping between saves.
	release() {

		this.target?.dispose();
		this.target = null;

	}

	dispose() {

		this.target?.dispose();
		this.material.dispose();
		this.target = null;
		this._source = null;
		this._node = null;

	}

}
