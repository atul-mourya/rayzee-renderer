import { DataArrayTexture, LinearFilter, RGBAFormat, UnsignedByteType } from 'three';
import { parseIES, resampleIESToGrid, deriveIESBeamAngle, deriveIESPenumbra } from '../Processor/IESParser.js';
import { sharedDownloads } from '../Storage/DownloadCache.js';

/**
 * Manages IES photometric profiles for spot lights.
 *
 * Pulls .ies files over HTTP, parses each into an angular candela grid,
 * resamples to a fixed-size 2D texture (U = horizontal angle, V = vertical
 * angle), and stacks all profiles into a single `DataArrayTexture` referenced
 * per-light through `light.userData.ies = { name, index, intensity }`.
 *
 * Shader sampling math lives in `LightsCore.js (sampleIESProfile)`.
 *
 * Usage:
 * ```js
 * const entries = await app.iesManager.loadLibrary([
 *     { name: 'parallel-beam', url: '/iesprofiles/parallel-beam.ies' },
 * ]);
 * app.iesManager.setSpotLightProfile(spotLight.uuid, 'parallel-beam', 1.0);
 * ```
 */
export class IESManager {

	/**
	 * @param {import('../Stages/PathTracer.js').PathTracer} pathTracer
	 * @param {Object} [options]
	 * @param {Function} [options.onReset] - reset accumulation after assignment changes
	 */
	constructor( pathTracer, options = {} ) {

		this.pathTracer = pathTracer;
		this._onReset = options.onReset || null;

		/** @type {DataArrayTexture | null} */
		this.texture = null;

		/** @type {Array<{ name: string, index: number, maxCandela: number, photometricType: number }>} */
		this.entries = [];

		this._gridWidth = 128; // horizontal samples (U axis)
		this._gridHeight = 128; // vertical samples (V axis)

	}

	/**
	 * Load a list of IES profiles. Replaces any previously loaded library.
	 *
	 * @param {Array<{ name: string, url: string }>} items
	 * @param {Object} [options]
	 * @param {number} [options.gridWidth=128]
	 * @param {number} [options.gridHeight=128]
	 * @returns {Promise<Array<{ name: string, index: number }>>}
	 */
	async loadLibrary( items, { gridWidth = 128, gridHeight = 128 } = {} ) {

		if ( ! Array.isArray( items ) || items.length === 0 ) return [];

		this._gridWidth = gridWidth;
		this._gridHeight = gridHeight;

		// Fetch + parse in parallel; tolerate individual failures.
		const results = await Promise.all( items.map( async ( it ) => {

			try {

				const { file, release } = await sharedDownloads().fetch( it.url );
				const text = await file.text().finally( release );
				const profile = parseIES( text, it.name );
				const grid = resampleIESToGrid( profile, gridWidth, gridHeight );
				return { it, profile, grid };

			} catch ( err ) {

				console.warn( `IESManager: failed to load "${it.name}": ${err.message}` );
				return null;

			}

		} ) );

		const okResults = results.filter( r => r !== null );
		if ( okResults.length === 0 ) return [];

		const depth = okResults.length;
		const pixelsPerLayer = gridWidth * gridHeight;
		// Expand single-channel grid to RGBA so the texture format matches the
		// placeholder bound at shader-compile time (DataArrayTexture rebinds
		// require matching format). R channel carries the value; G/B copy R for
		// safer linear filtering, A=255.
		const data = new Uint8Array( pixelsPerLayer * 4 * depth );

		const entries = [];
		for ( let i = 0; i < depth; i ++ ) {

			const grid = okResults[ i ].grid;
			const dst = i * pixelsPerLayer * 4;
			for ( let p = 0; p < pixelsPerLayer; p ++ ) {

				const v = grid[ p ];
				data[ dst + p * 4 + 0 ] = v;
				data[ dst + p * 4 + 1 ] = v;
				data[ dst + p * 4 + 2 ] = v;
				data[ dst + p * 4 + 3 ] = 255;

			}

			const profile = okResults[ i ].profile;
			const suggestedAngle = deriveIESBeamAngle( profile );
			entries.push( {
				name: okResults[ i ].it.name,
				index: i,
				maxCandela: profile.maxCandela,
				photometricType: profile.photometricType,
				suggestedAngle,
				suggestedPenumbra: deriveIESPenumbra( profile, suggestedAngle ),
				lumens: profile.lumens,
			} );

		}

		const tex = new DataArrayTexture( data, gridWidth, gridHeight, depth );
		tex.format = RGBAFormat;
		tex.type = UnsignedByteType;
		tex.minFilter = LinearFilter;
		tex.magFilter = LinearFilter;
		tex.generateMipmaps = false;
		tex.needsUpdate = true;

		const old = this.texture;
		this.texture = tex;
		this.entries = entries;

		// Hand the texture to the path tracer's shader graph.
		this.pathTracer.iesProfiles = tex;
		this.pathTracer.shaderBuilder?.updateIESProfiles?.( tex );

		old?.dispose?.();

		return this.entries.map( ( { name, index } ) => ( { name, index } ) );

	}

	/**
	 * Returns the loaded library entries.
	 */
	getEntries() {

		return this.entries.slice();

	}

	/**
	 * Assign or clear an IES profile on a spot light.
	 *
	 * When `applyAutoCone` is true (default), the spot light's photometrically
	 * meaningful parameters are derived from the profile and applied:
	 *   - cone half-angle (snug clip outside the IES emission)
	 *   - penumbra (transition band matching the IES soft edge)
	 *   - decay (forced to 2 — physically correct inverse-square)
	 *
	 * @param {string} uuid
	 * @param {string | null} name - profile name (or null to clear)
	 * @param {number} [intensity=1.0] - blend [0,1] between flat (0) and full profile (1)
	 * @param {Object} [opts]
	 * @param {boolean} [opts.applyAutoCone=true]
	 * @returns {{ applied: boolean, suggestedAngle: number | null, suggestedPenumbra: number | null, suggestedDecay: number | null, fixtureLumens: number | null }}
	 *   host can mirror the suggested values into UI state.
	 */
	setSpotLightProfile( uuid, name, intensity = 1.0, { applyAutoCone = true } = {} ) {

		const light = this._findSpotLight( uuid );
		const empty = { applied: false, suggestedAngle: null, suggestedPenumbra: null, suggestedDecay: null, fixtureLumens: null };
		if ( ! light ) return empty;

		light.userData = light.userData || {};
		let suggestedAngle = null;
		let suggestedPenumbra = null;
		let suggestedDecay = null;
		let fixtureLumens = null;

		if ( name == null ) {

			delete light.userData.ies;

		} else {

			const entry = this.entries.find( e => e.name === name );
			if ( ! entry ) {

				console.warn( `IESManager: unknown profile "${name}"` );
				return empty;

			}

			fixtureLumens = Number.isFinite( entry.lumens ) ? entry.lumens : null;

			light.userData.ies = {
				name: entry.name,
				index: entry.index,
				intensity: clamp01( intensity ),
				fixtureLumens,
			};

			if ( applyAutoCone ) {

				if ( Number.isFinite( entry.suggestedAngle ) ) {

					light.angle = entry.suggestedAngle;
					suggestedAngle = entry.suggestedAngle;

				}

				if ( Number.isFinite( entry.suggestedPenumbra ) ) {

					light.penumbra = entry.suggestedPenumbra;
					suggestedPenumbra = entry.suggestedPenumbra;

				}

				// IES is a photometric measurement that assumes inverse-square falloff.
				light.decay = 2;
				suggestedDecay = 2;

			}

		}

		this.pathTracer.updateLights();
		this._onReset?.();
		return { applied: true, suggestedAngle, suggestedPenumbra, suggestedDecay, fixtureLumens };

	}

	/**
	 * Returns the current IES descriptor on a spot light (or null).
	 */
	getSpotLightProfile( uuid ) {

		const light = this._findSpotLight( uuid );
		return light?.userData?.ies || null;

	}

	dispose() {

		this.texture?.dispose?.();
		this.texture = null;
		this.entries = [];
		this.pathTracer = null;
		this._onReset = null;

	}

	_findSpotLight( uuid ) {

		const obj = this.pathTracer?.scene?.getObjectByProperty?.( 'uuid', uuid );
		return obj && obj.isSpotLight ? obj : null;

	}

}

function clamp01( v ) {

	return Math.max( 0, Math.min( 1, v ) );

}
