import {
	RGBAFormat, FloatType, LinearFilter, RepeatWrapping, ClampToEdgeWrapping,
	EquirectangularReflectionMapping, LinearSRGBColorSpace, DataTexture
} from 'three';

/**
 * SimpleSky
 *
 * CPU-based solid colour environment texture generator.
 * Produces a DataTexture directly — no render targets, no GPU readback,
 * no resource lifecycle issues with the WebGPU backend.
 *
 * Public API matches SimpleSkyRenderer:
 *   renderSolid(params)    → texture
 */

export class SimpleSky {

	constructor( width = 512, height = 256 ) {

		this.width = width;
		this.height = height;
		this.lastRenderTime = 0;

		// Pre-allocate pixel buffer and DataTexture (reused across renders)
		this._pixels = new Float32Array( width * height * 4 );
		this._texture = new DataTexture( this._pixels, width, height, RGBAFormat, FloatType );
		this._texture.mapping = EquirectangularReflectionMapping;
		this._texture.colorSpace = LinearSRGBColorSpace;
		this._texture.minFilter = LinearFilter;
		this._texture.magFilter = LinearFilter;
		this._texture.wrapS = RepeatWrapping;
		this._texture.wrapT = ClampToEdgeWrapping;
		this._texture.generateMipmaps = false;

	}

	/**
	 * Generate a uniform solid-colour sky.
	 * @param {Object} params - { color } (Three.js Color)
	 * @returns {DataTexture} Equirectangular solid-colour texture
	 */
	renderSolid( params ) {

		const startTime = performance.now();
		const { width, height } = this;
		const pixels = this._pixels;

		const r = params.color.r, g = params.color.g, b = params.color.b;

		for ( let y = 0; y < height; y ++ ) {

			for ( let x = 0; x < width; x ++ ) {

				const idx = ( y * width + x ) * 4;
				pixels[ idx ] = r;
				pixels[ idx + 1 ] = g;
				pixels[ idx + 2 ] = b;
				pixels[ idx + 3 ] = 1.0;

			}

		}

		this._texture.needsUpdate = true;
		// Fresh linear Rec.709 pixels in a reused texture. Colour management records which space a
		// texture's pixels hold so it never converts them twice; left in place, that record would
		// claim these were already converted and they never would be.
		delete this._texture.userData?.__rayzeeColorSpace;
		this.lastRenderTime = performance.now() - startTime;
		return this._texture;

	}

	setResolution( width, height ) {

		if ( this.width === width && this.height === height ) return;
		this.width = width;
		this.height = height;
		this._pixels = new Float32Array( width * height * 4 );
		this._texture.dispose();
		this._texture = new DataTexture( this._pixels, width, height, RGBAFormat, FloatType );
		this._texture.mapping = EquirectangularReflectionMapping;
		this._texture.colorSpace = LinearSRGBColorSpace;
		this._texture.minFilter = LinearFilter;
		this._texture.magFilter = LinearFilter;
		this._texture.wrapS = RepeatWrapping;
		this._texture.wrapT = ClampToEdgeWrapping;
		this._texture.generateMipmaps = false;

	}

	getLastRenderTime() {

		return this.lastRenderTime;

	}

	dispose() {

		this._texture.dispose();

	}

}
