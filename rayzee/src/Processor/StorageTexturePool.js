/**
 * StorageTexturePool.js
 * Manages write-only StorageTextures + a single MRT RenderTarget for readable copies.
 *
 * "Copy approach":
 *  - 3 write-only StorageTextures used as compute shader outputs
 *  - 1 MRT RenderTarget (3 attachments) used as the readable copy
 *  - After each compute dispatch, copyTextureToTexture() transfers data
 *    from StorageTextures → RenderTarget textures
 *  - Downstream stages (ASVGF, display, OIDN) read from the RenderTarget
 *  - Previous-frame reads in the path tracer sample from RenderTarget textures
 *    via texture() (not storageTexture().toReadOnly())
 */

import { StorageTexture, RenderTarget } from 'three/webgpu';
import { RGBAFormat, FloatType, LinearFilter, NearestFilter, Box2, Vector2 } from 'three';
import { MAX_STORAGE_TEXTURE_SIZE } from '../EngineDefaults.js';
import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'gpu' );

function createWriteStorageTex() {

	const tex = new StorageTexture( MAX_STORAGE_TEXTURE_SIZE, MAX_STORAGE_TEXTURE_SIZE );
	tex.type = FloatType;
	tex.format = RGBAFormat;
	tex.minFilter = LinearFilter;
	tex.magFilter = LinearFilter;
	return tex;

}

export class StorageTexturePool {

	constructor( width, height ) {

		// Write-only StorageTextures (compute output)
		this.writeColor = null;
		this.writeNormalDepth = null;
		this.writeAlbedo = null;

		// Readable MRT RenderTarget (3 attachments)
		this.readTarget = null;

		// Ping-pong index (kept for API compat but only 0 is used in copy approach)
		this.currentTarget = 0;

		this.renderWidth = 0;
		this.renderHeight = 0;

		// Reused srcRegion for copies out of the over-allocated StorageTextures.
		this._srcRegion = new Box2( new Vector2( 0, 0 ), new Vector2( 0, 0 ) );

		if ( width > 0 && height > 0 ) {

			this.create( width, height );

		}

	}

	create( width, height ) {

		this.dispose();

		this.renderWidth = width;
		this.renderHeight = height;

		// Write-only StorageTextures allocated at max — never resized (see resize crash fix).
		this.writeColor = createWriteStorageTex();
		this.writeNormalDepth = createWriteStorageTex();
		this.writeAlbedo = createWriteStorageTex();

		// Readable MRT RenderTarget (3 color attachments, no depth/stencil)
		this.readTarget = new RenderTarget( width, height, {
			type: FloatType,
			format: RGBAFormat,
			minFilter: NearestFilter,
			magFilter: NearestFilter,
			depthBuffer: false,
			stencilBuffer: false,
			count: 3,
		} );

		this.readTarget.textures[ 0 ].name = 'gColor';
		this.readTarget.textures[ 1 ].name = 'gNormalDepth';
		this.readTarget.textures[ 2 ].name = 'gAlbedo';

		log.debug( `storage texture pool ${fmt.px( width, height )} — 3 write StorageTextures + 1 MRT RenderTarget` );

	}

	ensureSize( width, height ) {

		if ( ! this.writeColor ) {

			this.create( width, height );
			return true;

		}

		if ( this.renderWidth !== width || this.renderHeight !== height ) {

			// Resize only the readTarget — never dispose/recreate the write StorageTextures
			// (that destroys the texture the compute bind group holds → submit crash).
			this.setSize( width, height );
			return true;

		}

		return false;

	}

	/**
	 * Get readable textures from the MRT RenderTarget.
	 * @returns {{ color: Texture, normalDepth: Texture, albedo: Texture }}
	 */
	getReadTextures() {

		return {
			color: this.readTarget.textures[ 0 ],
			normalDepth: this.readTarget.textures[ 1 ],
			albedo: this.readTarget.textures[ 2 ],
		};

	}

	/**
	 * Get write-only StorageTextures.
	 * @returns {{ color: StorageTexture, normalDepth: StorageTexture, albedo: StorageTexture }}
	 */
	getWriteTextures() {

		return {
			color: this.writeColor,
			normalDepth: this.writeNormalDepth,
			albedo: this.writeAlbedo,
		};

	}

	/**
	 * Copy StorageTextures → RenderTarget textures via GPU copy.
	 * Must be called after each compute dispatch.
	 * @param {WebGPURenderer} renderer
	 * @param {boolean} [includeAux=true] Copy the normalDepth + albedo attachments too. When no
	 *   denoiser/OIDN consumes the aux MRT (default interactive), the wavefront doesn't write those
	 *   StorageTextures, so skipping their copies saves two full-res GPU copies/frame. Color is always copied.
	 */
	copyToReadTargets( renderer, includeAux = true ) {

		// Source write StorageTextures are over-allocated at the max size; the Box2 region
		// restricts the copy to the active render size so source and destination extents match.
		this._srcRegion.max.set( this.renderWidth, this.renderHeight );

		renderer.copyTextureToTexture( this.writeColor, this.readTarget.textures[ 0 ], this._srcRegion );

		if ( includeAux ) {

			renderer.copyTextureToTexture( this.writeNormalDepth, this.readTarget.textures[ 1 ], this._srcRegion );
			renderer.copyTextureToTexture( this.writeAlbedo, this.readTarget.textures[ 2 ], this._srcRegion );

		}

	}

	/**
	 * Clear the MRT RenderTarget.
	 * @param {WebGPURenderer} renderer
	 */
	clear( renderer ) {

		if ( ! this.readTarget || ! renderer ) return;

		const currentRT = renderer.getRenderTarget();
		renderer.setRenderTarget( this.readTarget );
		renderer.clear( true, false, false );
		renderer.setRenderTarget( currentRT );

	}

	swap() {

		this.currentTarget = 1 - this.currentTarget;

	}

	setSize( width, height ) {

		this.renderWidth = width;
		this.renderHeight = height;

		// Write StorageTextures stay at max allocation — never resized (see resize crash fix).
		if ( this.readTarget ) {

			this.readTarget.setSize( width, height );

			// RenderTarget.setSize() updates texture.image dimensions but does NOT
			// bump texture.version. Without this, copyTextureToTexture's internal
			// updateTexture() early-returns, leaving stale GPU textures in place.
			for ( const tex of this.readTarget.textures ) {

				tex.needsUpdate = true;

			}

		}

	}

	dispose() {

		this.writeColor?.dispose();
		this.writeNormalDepth?.dispose();
		this.writeAlbedo?.dispose();
		this.readTarget?.dispose();

		this.writeColor = null;
		this.writeNormalDepth = null;
		this.writeAlbedo = null;
		this.readTarget = null;

	}

}
