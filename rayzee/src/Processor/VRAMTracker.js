/**
 * VRAMTracker.js — current/peak GPU memory accounting.
 *
 * Measures live GPU bytes: buffer attributes by backing-array byteLength, textures by
 * dims × format/type — but ONLY when the backend actually holds a GPUTexture. three.js
 * allocates a texture's GPUTexture lazily on first use, so a constructed-but-never-dispatched
 * StorageTexture (e.g. a disabled stage's render targets) costs 0 here even though its JS
 * `image` dimensions are set. Residency probing needs a renderer (constructor arg or
 * setRenderer); without one it falls back to counting by dimensions (legacy behavior).
 * Providers are thunks that read current state, so they survive reallocation (resize,
 * scene/material/env reload). A per-pass WeakSet dedupes by resource identity, so
 * overlapping registrations never double-count.
 */

import {
	RGBAFormat, RGBFormat, RGFormat, RedFormat,
	FloatType, HalfFloatType, UnsignedByteType, ByteType,
	UnsignedShortType, ShortType, UnsignedIntType, IntType,
} from 'three';

const CHANNELS = { [ RGBAFormat ]: 4, [ RGBFormat ]: 3, [ RGFormat ]: 2, [ RedFormat ]: 1 };
const TYPE_BYTES = {
	[ FloatType ]: 4, [ HalfFloatType ]: 2,
	[ UnsignedByteType ]: 1, [ ByteType ]: 1,
	[ UnsignedShortType ]: 2, [ ShortType ]: 2,
	[ UnsignedIntType ]: 4, [ IntType ]: 4,
};

function texelBytes( tex ) {

	return ( CHANNELS[ tex.format ] ?? 4 ) * ( TYPE_BYTES[ tex.type ] ?? 4 );

}

/** Exact GPU byte size of a buffer attribute. GPU-only ones carry no backing array. */
export function bufferBytes( attr ) {

	return attr?.gpuByteLength ?? attr?.array?.byteLength ?? 0;

}

/** Estimated GPU byte size of a Texture/StorageTexture/DataArrayTexture/RenderTarget. */
export function textureBytes( tex ) {

	if ( ! tex ) return 0;

	if ( tex.isRenderTarget ) {

		const list = tex.textures?.length ? tex.textures : [ tex.texture ];
		const w = tex.width || 0, h = tex.height || 0, d = tex.depth || 1;
		let sum = 0;
		for ( const t of list ) if ( t ) sum += w * h * d * texelBytes( t );
		return sum;

	}

	const img = tex.image || {};
	const w = img.width ?? tex.width ?? 0;
	const h = img.height ?? tex.height ?? 0;
	const d = img.depth ?? 1;
	return w * h * d * texelBytes( tex );

}

export class VRAMTracker {

	constructor( renderer = null ) {

		this._providers = [];
		this._renderer = renderer;
		this.current = 0;
		this.peak = 0;
		this.byCategory = {};

	}

	/** Late-bind the renderer so texture accounting can probe actual GPU residency. */
	setRenderer( renderer ) {

		this._renderer = renderer;

	}

	/**
	 * @param {string} category - grouping label in the report
	 * @param {Function} fn - returns a resource or array of resources: buffer
	 *   attributes (`.array`), textures/render targets (`.isTexture`/`.isRenderTarget`),
	 *   or synthetic `{ bytes }` for sizes with no inspectable object. Return falsy to skip.
	 */
	register( category, fn ) {

		this._providers.push( { category, fn } );

	}

	measure() {

		const seen = new WeakSet();
		const byCategory = {};
		let total = 0;

		for ( const { category, fn } of this._providers ) {

			let resources;
			try {

				resources = fn();

			} catch {

				resources = null;

			}

			if ( ! resources ) continue;

			let bytes = 0;
			for ( const r of ( Array.isArray( resources ) ? resources : [ resources ] ) ) {

				bytes += this._resourceBytes( r, seen );

			}

			byCategory[ category ] = ( byCategory[ category ] || 0 ) + bytes;
			total += bytes;

		}

		this.byCategory = byCategory;
		this.current = total;
		if ( total > this.peak ) this.peak = total;

		return { current: total, peak: this.peak, byCategory };

	}

	_resourceBytes( r, seen ) {

		if ( ! r ) return 0;

		// synthetic { bytes } (e.g. attributeArray-backed histograms)
		if ( typeof r.bytes === 'number' && ! r.isTexture && ! r.isRenderTarget ) return r.bytes;

		// buffer attribute — dedupe by backing array, or by the attribute itself when it is
		// GPU-only and has none (rw/ro nodes share one buffer either way)
		if ( r.gpuByteLength != null ) {

			if ( seen.has( r ) ) return 0;
			seen.add( r );
			return r.gpuByteLength;

		}

		if ( r.array && r.array.byteLength != null ) {

			if ( seen.has( r.array ) ) return 0;
			seen.add( r.array );
			return r.array.byteLength;

		}

		// texture / render target — dedupe by object identity; count only GPU-resident bytes
		if ( r.isRenderTarget || r.isTexture ) {

			if ( seen.has( r ) ) return 0;
			seen.add( r );
			return this._residentTextureBytes( r );

		}

		return 0;

	}

	// three.js allocates a texture's GPUTexture lazily on first dispatch; a never-used StorageTexture
	// (disabled stage) has none. Count only when the backend holds a real GPUTexture so the report is
	// resident VRAM, not JS-declared dimensions. No renderer bound → assume resident (legacy behavior).
	_isResident( tex ) {

		const backend = this._renderer?.backend;
		if ( ! backend || typeof backend.get !== 'function' ) return true;
		if ( typeof backend.has === 'function' && ! backend.has( tex ) ) return false;
		const data = backend.get( tex );
		return !! ( data && ( data.texture || data.gpuTexture ) );

	}

	// RenderTarget bytes are attributed to its underlying texture(s); count each only if resident.
	_residentTextureBytes( tex ) {

		if ( tex.isRenderTarget ) {

			const list = tex.textures?.length ? tex.textures : [ tex.texture ];
			const w = tex.width || 0, h = tex.height || 0, d = tex.depth || 1;
			let sum = 0;
			for ( const t of list ) if ( t && this._isResident( t ) ) sum += w * h * d * texelBytes( t );
			return sum;

		}

		return this._isResident( tex ) ? textureBytes( tex ) : 0;

	}

	/** Drop the high-water mark to the current value (call when a new render begins). */
	resetPeak() {

		this.peak = this.current;

	}

	getReport() {

		const mb = ( b ) => ( b / 1048576 ).toFixed( 1 );
		const parts = Object.entries( this.byCategory ).map( ( [ k, v ] ) => `${k}=${mb( v )}` );
		return `VRAM current=${mb( this.current )}MB peak=${mb( this.peak )}MB [${parts.join( ' ' )}]`;

	}

}
