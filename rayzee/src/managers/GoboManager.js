import { DataArrayTexture, LinearFilter, RGBAFormat, UnsignedByteType } from 'three';
import { cachedObjectURL } from '../Storage/DownloadCache.js';
import { ISSUE_CODES } from '../EngineIssues.js';

/**
 * Manages projection masks ("gobos" / "cookies") for spot lights.
 *
 * Loads a library of grayscale images into a single GPU `DataArrayTexture`;
 * spot lights reference layers by index via `light.userData.gobo`. The TSL
 * shader projects the surface direction onto the light's local plane and
 * multiplies emission by the mask, producing classic "light through a window"
 * or dappled-foliage shadows without any extra geometry.
 *
 * Library layers must all share the same square resolution (default 256×256).
 * Images are rasterised through a 2D canvas so non-square sources scale to fit.
 *
 * Usage:
 * ```js
 * const entries = await app.goboManager.loadLibrary( [
 *     { name: 'window', url: '/lightmasks/window_a.png' },
 *     { name: 'leaves', url: '/lightmasks/foliage_canopy_a.png' },
 * ] );
 * app.goboManager.setSpotLightGobo( spotLight.uuid, 'window', 1.0 );
 * ```
 */
export class GoboManager {

	/**
	 * @param {import('../Stages/PathTracer.js').PathTracer} pathTracer
	 * @param {Object} [options]
	 * @param {Function} [options.onReset] - Called after gobo state changes so the host can reset accumulation
	 */
	constructor( pathTracer, options = {} ) {

		this.pathTracer = pathTracer;
		this._onReset = options.onReset || null;
		this._issues = options.issues ?? null;

		/** @type {DataArrayTexture | null} */
		this.texture = null;

		/** @type {Array<{ name: string, index: number }>} */
		this.entries = [];

		this._size = 256;

	}

	/**
	 * Load a list of gobo images into a single DataArrayTexture.
	 * Replaces any previously loaded library.
	 *
	 * @param {Array<{ name: string, url: string }>} items
	 * @param {Object} [options]
	 * @param {number} [options.size=256] - Per-layer square resolution
	 * @returns {Promise<Array<{ name: string, index: number }>>}
	 */
	async loadLibrary( items, { size = 256 } = {} ) {

		if ( ! Array.isArray( items ) || items.length === 0 ) return [];

		this._size = size;
		const images = await Promise.all( items.map( it => loadImage( it.url ) ) );

		const width = size;
		const height = size;
		const depth = images.length;
		const data = new Uint8Array( width * height * depth * 4 );

		const cnv = document.createElement( 'canvas' );
		cnv.width = width;
		cnv.height = height;
		const ctx = cnv.getContext( '2d', { willReadFrequently: true } );

		for ( let i = 0; i < depth; i ++ ) {

			ctx.clearRect( 0, 0, width, height );
			ctx.drawImage( images[ i ], 0, 0, width, height );
			const img = ctx.getImageData( 0, 0, width, height );
			data.set( img.data, i * width * height * 4 );

		}

		const tex = new DataArrayTexture( data, width, height, depth );
		tex.minFilter = LinearFilter;
		tex.magFilter = LinearFilter;
		tex.format = RGBAFormat;
		tex.type = UnsignedByteType;
		tex.generateMipmaps = false;
		tex.needsUpdate = true;

		const old = this.texture;
		this.texture = tex;
		this.entries = items.map( ( it, i ) => ( { name: it.name, index: i } ) );

		// Hand the new texture to the shader graph and refresh light data.
		this.pathTracer.goboMaps = tex;
		this.pathTracer.shaderBuilder?.updateGoboMaps?.( tex );

		// Free old GPU memory after the new one is bound.
		old?.dispose?.();

		return this.entries;

	}

	/**
	 * Returns the loaded library entries (name → index lookup).
	 * @returns {Array<{ name: string, index: number }>}
	 */
	getEntries() {

		return this.entries.slice();

	}

	/**
	 * Assign a gobo to a spot or directional light by uuid.
	 *
	 * @param {string} uuid - Light's uuid
	 * @param {string | null} name - Gobo entry name (or null to clear)
	 * @param {Object} [opts]
	 * @param {number} [opts.intensity=1.0] - Mask strength [0,1]
	 * @param {boolean} [opts.inverted=false] - If true, sample (1 - mask)
	 * @param {number} [opts.scale=5.0] - World units per gobo tile (directional only)
	 * @returns {boolean} True if the light was found and updated
	 */
	setLightGobo( uuid, name, opts = {} ) {

		const { intensity = 1.0, inverted = false, scale = 5.0 } = opts;
		const light = this._findGoboLight( uuid );
		if ( ! light ) return false;

		light.userData = light.userData || {};

		if ( name == null ) {

			delete light.userData.gobo;

		} else {

			const entry = this.entries.find( e => e.name === name );
			if ( ! entry ) {

				this._issues?.record(
					ISSUE_CODES.ASSET_UNREACHABLE,
					`no gobo named "${name}" is loaded — the light projects without one`,
					{ name, asset: 'gobo' }
				);
				return false;

			}

			light.userData.gobo = {
				name: entry.name,
				index: entry.index,
				intensity: clamp01( intensity ),
				inverted: !! inverted,
				scale: Math.max( 1e-4, scale ),
			};

		}

		this.pathTracer.updateLights();
		this._onReset?.();
		return true;

	}

	/**
	 * Toggle inversion on an existing gobo assignment without losing
	 * the chosen mask or intensity.
	 * @param {string} uuid
	 * @param {boolean} inverted
	 * @returns {boolean}
	 */
	setLightGoboInverted( uuid, inverted ) {

		const light = this._findGoboLight( uuid );
		if ( ! light?.userData?.gobo ) return false;

		light.userData.gobo.inverted = !! inverted;
		this.pathTracer.updateLights();
		this._onReset?.();
		return true;

	}

	/**
	 * Update the gobo projection scale for a directional light without
	 * touching the chosen mask, intensity, or inverted flag.
	 * @param {string} uuid
	 * @param {number} scale
	 * @returns {boolean}
	 */
	setLightGoboScale( uuid, scale ) {

		const light = this._findGoboLight( uuid );
		if ( ! light?.userData?.gobo ) return false;

		light.userData.gobo.scale = Math.max( 1e-4, scale );
		this.pathTracer.updateLights();
		this._onReset?.();
		return true;

	}

	/**
	 * Returns the gobo descriptor currently assigned to a light, or null.
	 * @param {string} uuid
	 */
	getLightGobo( uuid ) {

		const light = this._findGoboLight( uuid );
		return light?.userData?.gobo || null;

	}

	// ── Back-compat thin wrappers ─────────────────────────────────────

	setSpotLightGobo( uuid, name, intensity = 1.0, inverted = false ) {

		return this.setLightGobo( uuid, name, { intensity, inverted } );

	}

	setSpotLightGoboInverted( uuid, inverted ) {

		return this.setLightGoboInverted( uuid, inverted );

	}

	getSpotLightGobo( uuid ) {

		return this.getLightGobo( uuid );

	}

	dispose() {

		this.texture?.dispose?.();
		this.texture = null;
		this.entries = [];
		this.pathTracer = null;
		this._onReset = null;
		this._issues = null;

	}

	_findGoboLight( uuid ) {

		const obj = this.pathTracer?.scene?.getObjectByProperty?.( 'uuid', uuid );
		if ( ! obj ) return null;
		return ( obj.isSpotLight || obj.isDirectionalLight ) ? obj : null;

	}

	_findSpotLight( uuid ) {

		const obj = this.pathTracer?.scene?.getObjectByProperty?.( 'uuid', uuid );
		return obj && obj.isSpotLight ? obj : null;

	}

}

async function loadImage( url ) {

	const source = await cachedObjectURL( url );

	try {

		return await new Promise( ( resolve, reject ) => {

			const img = new Image();
			img.crossOrigin = 'anonymous';
			img.onload = () => resolve( img );
			img.onerror = () => reject( new Error( `Failed to load gobo image: ${url}` ) );
			img.src = source.url;

		} );

	} finally {

		source.release();

	}

}

function clamp01( v ) {

	return Math.max( 0, Math.min( 1, v ) );

}
