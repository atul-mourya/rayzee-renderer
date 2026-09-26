/**
 * Colour management for the engine: what we render in, what we show it as, and what we hand out.
 *
 * With no config loaded this is inert and the engine behaves exactly as it did before OCIO
 * existed — the working space is linear Rec.709, the view transforms are three.js's seven, and
 * nothing converts anything. Every behaviour below only switches on once a host loads a config.
 *
 * ## The working space
 *
 * A config names the space a renderer should work in through its `scene_linear` role. For an ACES
 * config that is ACEScg, whose primaries are not sRGB's — so adopting it changes what every
 * texture, every material tint and every light colour mean, and therefore changes every pixel of
 * every existing render.
 *
 * That is the correct thing to do and it is not a thing to do silently, so it is opt-in:
 * `adoptWorkingSpace: true` on load, or `setWorkingSpace()` later. Loading a config without it
 * gives you the config's *views* over the engine's existing linear Rec.709 render, which is the
 * safe half and the one most people want first.
 */

import { LinearSRGBColorSpace, SRGBColorSpace } from 'three';

import { ISSUE_CODES } from '../EngineIssues.js';
import { displayCanvasFit } from './Displays.js';

import {
	ensureRuntime, loadConfig as loadOcioConfig, unloadConfig as unloadOcioConfig,
	hasConfig, describeConfig, getConfigInfo, listBuiltinConfigs, resetOcio, getRuntime,
} from './OcioRuntime.js';
import {
	convertColor, convertPixelsF32, convertEncodedRGBA8, applyMatrixRGBA8, extractMatrix,
	clearColorCaches, resetConfigHandle, hasColorSpace,
} from './ColorSpaces.js';
import {
	VIEW_TRANSFORMS, getViewTransform, listViewTransforms, removeOcioViewTransforms,
	registerWithRenderer, onRegistryChange, getRegistryVersion, resetViewTransforms, FALLBACK_VIEW,
	countTableTransforms, MAX_TABLE_TRANSFORMS, removeViewTransform, addViewTransform,
} from './ViewTransforms.js';
import { addOcioView, addAllOcioViews, buildBakedView, disposeOcioViewTextures, forgetOcioView, setOcioIssueLog } from './OcioViews.js';
import { encodeBakedView, decodeBakedView, configFingerprint } from './BakedViews.js';
import {
	resolveInputSpace, textureInputSpace, resolveTextureSpace, setInputOverride, clearInputOverrides,
	listFileRules, getInputVersion, bumpInputVersion,
} from './InputColorSpaces.js';
import { setWorkingMatrix, convertLinearTriple, convertLinearTriples } from './WorkingMatrix.js';
import { packHalf, unpackHalf } from './LutBake.js';

/** What the engine renders in when no config has been adopted. */
export const DEFAULT_WORKING_SPACE = 'Linear Rec.709 (sRGB)';

/**
 * The instance the rest of the engine reads.
 *
 * A config, a working space and a set of view transforms are process-wide — there is one OCIO
 * runtime and one set of baked tables — so code far from the app (texture processing, the asset
 * loader) asks for the active instance rather than having one threaded through six constructors.
 */
let active = null;

/** The colour management the engine is currently using, or null. */
export function getActiveColorManagement() {

	return active;

}

/** Make an instance the one the engine reads. Normally the app's own, set on construction. */
export function setActiveColorManagement( cm ) {

	active = cm;
	// Whatever the previous instance published is not this one's working space.
	cm?._publishWorkingMatrix?.();

}

/** The canvas colour space for a display: its own when it has one, sRGB otherwise. */
export function canvasColorSpaceFor( display ) {

	return displayCanvasFit( display ) ?? 'srgb';

}

/** How configs in the wild spell linear Rec.709, most specific first. Matched against aliases too. */
const NATIVE_LINEAR_NAMES = [
	'Linear Rec.709 (sRGB)', 'lin_rec709_srgb', 'lin_rec709', 'lin_srgb', 'Linear Rec.709',
	'Utility - Linear - sRGB', 'Utility - Linear - Rec.709', 'Linear BT.709', 'linrec709',
];

const NATIVE_LINEAR_PATTERN = /^(lin(ear)?[\s_-]*(rec\.?\s*|bt\.?\s*)?709|linear[\s_-]*\(?srgb\)?$|utility - linear - (srgb|rec\.?709))/i;

/**
 * The config's own name for linear Rec.709 — the space the engine renders in until a working
 * space is adopted.
 *
 * Aliases count as much as names: Blender calls it "Linear Rec.709" and lists the ACES spelling
 * as an alias, a studio config may only carry `lin_rec709`. Data spaces are never candidates.
 *
 * @returns {?string} the canonical name, or null when the config has nothing that qualifies
 */
export function findNativeLinearSpace( info ) {

	if ( ! info ) return null;

	const spaces = info.colorSpaces.filter( c => ! c.isData );
	const names = c => [ c.name, ...( c.aliases ?? [] ) ];

	for ( const wanted of NATIVE_LINEAR_NAMES ) {

		const hit = spaces.find( c => names( c ).some( n => n.toLowerCase() === wanted.toLowerCase() ) );
		if ( hit ) return hit.name;

	}

	return spaces.find( c => names( c ).some( n => NATIVE_LINEAR_PATTERN.test( n ) ) )?.name ?? null;

}

export class ColorManagement {

	constructor( { issues = null, renderer = null } = {} ) {

		this._issues = issues;
		this._renderer = renderer;
		this._listeners = new Map();

		// null throughout means "not colour-managed": the engine default working space, a built-in
		// curve rather than an OCIO view, and saving whatever the view produced.
		this._workingSpace = null;
		this._activeView = null;
		this._exportSpace = null;
		this._context = null;

		// id → last time it was selected, for evicting tables once the binding ceiling is near.
		this._lastUsed = new Map();
		this._useClock = 0;
		this._lastBuiltin = FALLBACK_VIEW;
		this._fingerprint = null;

		setOcioIssueLog( issues );

		// Re-registering on every change, not just at attach: a view baked from a config appears
		// long after the renderer was attached, and three.js only knows the tone mappings its
		// library was told about. Without this the live canvas logs "Unsupported Tone Mapping
		// configuration" and quietly paints something else, while the readback — which reads the
		// registry directly — comes back correct. Two different images from one setting.
		this._offRegistry = onRegistryChange( () => {

			if ( this._renderer ) registerWithRenderer( this._renderer );
			this._emit( 'transforms' );

		} );

		if ( active === null ) active = this;

	}

	// ── events ──────────────────────────────────────────────────────────────────────────────

	/**
	 * @param {'config'|'view'|'workingSpace'|'transforms'|'change'} event
	 * @returns {function(): void} unsubscribe
	 */
	on( event, fn ) {

		if ( ! this._listeners.has( event ) ) this._listeners.set( event, new Set() );
		this._listeners.get( event ).add( fn );
		return () => this._listeners.get( event )?.delete( fn );

	}

	_emit( event, detail = null ) {

		for ( const fn of this._listeners.get( event ) ?? [] ) fn( detail );
		if ( event !== 'change' ) {

			for ( const fn of this._listeners.get( 'change' ) ?? [] ) fn( { event, detail } );

		}

	}

	// ── the config ──────────────────────────────────────────────────────────────────────────

	/** The OCIO module's own configs, which need no files. */
	static async listBuiltinConfigs() {

		return await listBuiltinConfigs();

	}

	/**
	 * Load a config and, optionally, start rendering in the space it names.
	 *
	 * @param {Object} options - as `OcioRuntime.loadConfig`, plus:
	 * @param {boolean} [options.adoptWorkingSpace=false] - render in the config's scene_linear
	 * @param {boolean} [options.registerViews=true] - bake the default display's views right away
	 * @param {string} [options.display] - which display to bake views for; defaults to the config's
	 * @returns {Promise<Object>} the config description
	 */
	async loadConfig( { adoptWorkingSpace = false, registerViews = true, display = null, lutSize, ...rest } = {} ) {

		await ensureRuntime();

		const fingerprint = configFingerprint( rest ).catch( () => null );
		const baked = await this._bakedViewsFrom( rest.builtin ?? rest.id ?? null, fingerprint );

		let described;
		try {

			described = await loadOcioConfig( rest );

		} catch ( error ) {

			this._issues?.warn(
				ISSUE_CODES.COLOR_CONFIG_LOAD_FAILED,
				`colour config failed to load; the previous one stays in effect: ${error.message}`,
				{ builtin: rest.builtin ?? null, configPath: rest.configPath ?? null }
			);
			throw error;

		}

		// Only after the new config is in: releasing first would leave a failed load with no views.
		// A view baked from these same files by this same OCIO stays, so it is not baked twice.
		this._releaseViews( new Set( baked.filter( t => t.ocio.baked.ocioVersion === described.ocioVersion ).map( t => t.id ) ) );
		this._fingerprint = fingerprint;
		bumpInputVersion();
		resetConfigHandle();
		this._context = null;

		const previous = this._workingSpace;
		if ( adoptWorkingSpace ) {

			this._workingSpace = described.sceneLinear;

		} else if ( previous && ! hasColorSpace( previous ) ) {

			// A space adopted from the last config that this one does not have. Keeping the name
			// would make every conversion throw; the scene is still converted into it, so the host
			// has to rebuild — `workingSpace` fires below for exactly that.
			this._workingSpace = null;

		}

		if ( ! findNativeLinearSpace( getConfigInfo() ) ) {

			this._issues?.warn(
				ISSUE_CODES.COLOR_CONFIG_LOAD_FAILED,
				`"${described.id}" names no linear Rec.709 space, so until a working space is adopted its views ` +
				`treat the render as ${described.sceneLinear} — colours will be off by that primaries change`,
				{ sceneLinear: described.sceneLinear }
			);

		}

		this._publishWorkingMatrix();
		this._emit( 'config', described );

		if ( registerViews ) {

			const target = display ?? described.defaultDisplay;
			const { added, skipped } = addAllOcioViews( {
				display: target,
				context: this._context,
				source: this.workingSpace,
				...( lutSize ? { size: lutSize } : {} ),
			} );

			if ( added.length ) {

				const preferred = described.defaultViews[ target ];
				const pick = added.find( t => t.ocio.view === preferred ) ?? added[ 0 ];
				this.setActiveView( pick.id );

			}

			this._emit( 'transforms', { added, skipped } );

		}

		if ( ( this._workingSpace ?? null ) !== ( previous ?? null ) ) this._emit( 'workingSpace', this.workingSpace );

		return described;

	}

	/**
	 * Forget the config; the engine returns to its uncoloured-managed behaviour.
	 *
	 * ⚠️ With a working space adopted this cannot restore the scene: the environment was converted
	 * where it lies and needs this config to convert back. `app.unloadColorConfig()` does it in the
	 * right order.
	 */
	unloadConfig() {

		if ( this.workingSpaceAdopted ) {

			this._issues?.warn(
				ISSUE_CODES.COLOR_CONFIG_LOAD_FAILED,
				`unloaded while rendering in ${this._workingSpace}; the environment stays converted into it — ` +
				'use app.unloadColorConfig(), which reverts the scene first',
				{ workingSpace: this._workingSpace }
			);

		}

		this._releaseViews();
		unloadOcioConfig();
		resetConfigHandle();
		clearInputOverrides();
		bumpInputVersion();

		this._fingerprint = null;
		this._workingSpace = null;
		this._activeView = null;
		this._exportSpace = null;
		this._context = null;

		setWorkingMatrix( null );
		this._applyRendererOutputColorSpace();
		this._emit( 'config', null );
		this._emit( 'workingSpace', this.workingSpace );

	}

	_releaseViews( keep = null ) {

		disposeOcioViewTextures( keep );
		removeOcioViewTransforms( keep );
		for ( const id of this._lastUsed.keys() ) if ( ! keep?.has( id ) ) this._lastUsed.delete( id );

		if ( this._renderer && getViewTransform( this._renderer.toneMapping ) === null ) {

			// Back to the curve the host was on before a config took over — not None, which clamps
			// and looks broken — and with the output transfer switched back on to match.
			this._renderer.toneMapping = getViewTransform( this._lastBuiltin ) ? this._lastBuiltin : FALLBACK_VIEW;
			this._activeView = null;
			this._applyRendererOutputColorSpace();

		}

	}

	/** Registered baked views of config `id` whose files match `fingerprint`. */
	async _bakedViewsFrom( id, fingerprint ) {

		const candidates = [ ...VIEW_TRANSFORMS.values() ].filter( t => t.ocio?.baked && id !== null && t.ocio.configId === id );
		if ( candidates.length === 0 ) return [];
		const fp = await fingerprint;
		return fp ? candidates.filter( t => t.ocio.baked.fingerprint === fp ) : [];

	}

	/**
	 * Register a view saved by {@link saveBakedView}. Needs neither the runtime nor its config, so a
	 * host can show the view first and load the config when it is needed; loading that config later
	 * keeps this entry when its files are the ones it was baked from.
	 *
	 * @param {ArrayBuffer|Uint8Array} bytes
	 * @param {Object} [options]
	 * @param {Object} [options.expect] - header fields that must match, e.g. `{ configId, display, view, look }`
	 * @returns {Promise<Object>} the registry entry, not yet active
	 */
	async loadBakedView( bytes, { expect = null } = {} ) {

		const baked = await decodeBakedView( bytes );
		for ( const [ key, value ] of Object.entries( expect ?? {} ) ) {

			if ( ( baked[ key ] ?? null ) !== ( value ?? null ) ) throw new Error( `baked view has ${key} "${baked[ key ]}", expected "${value}"` );

		}

		const loaded = describeConfig();
		if ( loaded && ( loaded.id !== baked.configId || ( await this._fingerprint ) !== baked.fingerprint ) ) {

			throw new Error( `baked view is from "${baked.configId}", not the loaded "${loaded.id}"` );

		}

		const existing = [ ...VIEW_TRANSFORMS.values() ].find( t => t.source === 'ocio' && t.ocio.display === baked.display
			&& t.ocio.view === baked.view && ( t.ocio.look ?? null ) === ( baked.look ?? null ) );
		if ( ! existing ) this._makeRoomForTable();

		return addViewTransform( buildBakedView( baked, existing?.id ?? null ) );

	}

	/**
	 * A registered OCIO view as a file for {@link loadBakedView}.
	 * @returns {Promise<Uint8Array>}
	 */
	async saveBakedView( id ) {

		const t = getViewTransform( id );
		if ( t?.source !== 'ocio' ) throw new Error( `no OCIO view with id ${id}` );

		const config = describeConfig();
		return await encodeBakedView( t, {
			configId: config?.id ?? t.ocio.configId,
			fingerprint: ( config ? await this._fingerprint : null ) ?? t.ocio.baked?.fingerprint ?? null,
			ocioVersion: config?.ocioVersion ?? t.ocio.baked?.ocioVersion ?? null,
		} );

	}

	get hasConfig() {

		return hasConfig();

	}

	/** Everything the config offers, or null. */
	describe() {

		return describeConfig();

	}

	// ── the working space ───────────────────────────────────────────────────────────────────

	/** The space the path tracer's radiance is in. */
	get workingSpace() {

		if ( this._workingSpace ) return this._workingSpace;
		if ( ! hasConfig() ) return DEFAULT_WORKING_SPACE;

		// Not adopted means the render is still linear Rec.709 — but it has to be named the way
		// *this* config names it. Hardcoding the ACES spelling broke every view bake on a config
		// that does not happen to carry it as an alias.
		return this.nativeLinearSpace ?? describeConfig()?.sceneLinear ?? DEFAULT_WORKING_SPACE;

	}

	/** True once the render is happening in a space the config named. */
	get workingSpaceAdopted() {

		return this._workingSpace !== null;

	}

	/**
	 * Change what the engine renders in.
	 *
	 * Everything already loaded is in the old space, so the caller has to rebuild the scene after
	 * this — the `workingSpace` event is the signal. `PathTracerApp` wires that up.
	 *
	 * @param {?string} name - a config space, or null to go back to linear Rec.709
	 */
	setWorkingSpace( name ) {

		if ( name !== null ) {

			if ( ! hasConfig() ) throw new Error( 'load an OCIO config before choosing a working space' );
			if ( ! hasColorSpace( name ) ) throw new Error( `config has no colour space "${name}"` );

		}

		if ( ( this._workingSpace ?? null ) === ( name ?? null ) ) return;

		this._workingSpace = name;
		clearColorCaches();
		this._publishWorkingMatrix();
		this._rebakeViews();
		this._emit( 'workingSpace', this.workingSpace );

	}

	/**
	 * The 3×3 that takes colour from `space` into the working space, or null when the conversion
	 * is not a plain matrix. Useful to a caller that wants to do the conversion in a shader.
	 */
	matrixToWorking( space ) {

		if ( ! hasConfig() ) return null;
		return extractMatrix( space, this.workingSpace, { context: this._context } );

	}

	// ── the view ────────────────────────────────────────────────────────────────────────────

	/** Every registered view transform, for a host menu. */
	listViews() {

		return listViewTransforms();

	}

	/** `{ display, view, look, context }` of the active OCIO view, or null for a built-in curve. */
	get activeView() {

		return this._activeView;

	}

	/** Make a registered transform the one the renderer uses. */
	setActiveView( id ) {

		let t = getViewTransform( id );
		if ( ! t ) throw new Error( `no view transform with id ${id}` );

		if ( this._isStale( t ) ) t = this._rebakeView( t ) ?? t;

		this._activeView = t.source === 'ocio' ? { ...t.ocio, id: t.id, name: t.name } : null;
		this._lastUsed.set( id, ++ this._useClock );
		if ( t.source === 'builtin' ) this._lastBuiltin = id;

		if ( this._renderer ) this._renderer.toneMapping = id;
		this._applyRendererOutputColorSpace();
		this._emit( 'view', t );
		return t;

	}

	/**
	 * Bake and select one display/view/look combination in one call.
	 * @returns {Object} the registry entry
	 */
	setView( { display, view, look = null, size } = {} ) {

		if ( ! hasConfig() ) throw new Error( 'load an OCIO config first' );

		// Matched on what the artist chose, not on how it was baked: an entry baked under the
		// previous $SHOT or working space is the same view, just stale, and is refreshed in place.
		const existing = [ ...VIEW_TRANSFORMS.values() ].find( t =>
			t.source === 'ocio' && t.ocio.display === display && t.ocio.view === view
			&& ( t.ocio.look ?? null ) === ( look ?? null )
			&& ( ! size || t.ocio.size === size )
		);

		if ( ! existing ) this._makeRoomForTable();

		const entry = existing ?? addOcioView( {
			display, view, look, context: this._context,
			source: this.workingSpace,
			...( size ? { size } : {} ),
		} );

		this.setActiveView( entry.id );
		return getViewTransform( entry.id );

	}

	/**
	 * Free a table slot by dropping the least recently selected OCIO view, if the registry is full.
	 *
	 * Every display, view and look combination is its own baked table, and the readback can only
	 * bind twelve. Without this a user browsing the menus hits an error on roughly their
	 * thirteenth choice. The active view is never the one dropped.
	 */
	_makeRoomForTable() {

		if ( countTableTransforms() < MAX_TABLE_TRANSFORMS ) return;

		const active = this._renderer?.toneMapping ?? this._activeView?.id ?? null;
		const candidates = [ ...VIEW_TRANSFORMS.values() ]
			.filter( t => t.source === 'ocio' && t.id !== active )
			.sort( ( a, b ) => ( this._lastUsed.get( a.id ) ?? 0 ) - ( this._lastUsed.get( b.id ) ?? 0 ) );

		const victim = candidates[ 0 ];
		if ( ! victim ) return;

		forgetOcioView( victim.id );
		removeViewTransform( victim.id );
		this._lastUsed.delete( victim.id );

	}

	/** Swap the look on the active view, rebaking it. */
	setLook( look ) {

		if ( ! this._activeView ) throw new Error( 'no OCIO view is active' );
		return this.setView( { ...this._activeView, look } );

	}

	/**
	 * Set the context variables a config resolves `$VAR` against — how a studio config picks a
	 * per-shot LUT. Rebakes every registered view, since their tables were built with the old ones.
	 *
	 * @param {?Object<string,string>} vars - e.g. `{ SHOT: '010', SEQ: 'abc' }`
	 */
	setContext( vars ) {

		const next = vars && Object.keys( vars ).length ? { ...vars } : null;
		if ( JSON.stringify( next ) === JSON.stringify( this._context ) ) return;

		this._context = next;

		if ( hasConfig() ) {

			// The runtime caches processors per context. Without dropping those, a rebake hands
			// back the table built from the previous $SHOT.
			if ( this._context ) getRuntime()?.invalidateContext( this._context );
			clearColorCaches();
			this._rebakeViews();

		}

		this._emit( 'context', this._context );

	}

	get context() {

		return this._context;

	}

	/** Whether an OCIO view was baked under a context or working space that is no longer current. */
	_isStale( t ) {

		// Without a config there is nothing to rebake a baked view against.
		if ( t.source !== 'ocio' || ! hasConfig() ) return false;
		return t.ocio.source !== this.workingSpace
			|| JSON.stringify( t.ocio.context ?? null ) !== JSON.stringify( this._context ?? null );

	}

	/**
	 * Rebake one OCIO view in place under the current context and working space, keeping its id.
	 * @returns {?Object} the new entry, or null when the bake failed
	 */
	_rebakeView( t ) {

		try {

			const rebaked = addOcioView( {
				id: t.id,
				display: t.ocio.display,
				view: t.ocio.view,
				look: t.ocio.look,
				context: this._context,
				source: this.workingSpace,
				size: t.ocio.size,
				minEv: t.ocio.minEv,
				maxEv: t.ocio.maxEv,
			} );

			// A rebake of the same shape writes new pixels into the texture the shader graph already
			// points at, so the old and new entries share one texture. Disposing it unconditionally
			// would free the one now in use.
			const old = t.table?.texture;
			if ( old && old !== rebaked.table?.texture ) old.dispose?.();
			return rebaked;

		} catch ( err ) {

			this._issues?.warn(
				ISSUE_CODES.VIEW_TRANSFORM_BAKE_FAILED,
				`could not rebake "${t.name}": ${err.message}`,
				{ id: t.id }
			);
			return null;

		}

	}

	/**
	 * Rebake the view on screen now; leave the rest for when they are next chosen.
	 *
	 * Every registered view was baked under the old context or working space, but only the active
	 * one is being looked at — and at ~0.1 s a view, rebaking twelve on every `$SHOT` change was
	 * over a second of frozen UI for tables nobody was using. `setActiveView` refreshes a stale
	 * one the moment it is selected, so nothing can render from an old table.
	 */
	_rebakeViews() {

		const activeId = this._renderer?.toneMapping ?? this._activeView?.id ?? null;
		const t = activeId === null ? null : getViewTransform( activeId );
		if ( ! t || ! this._isStale( t ) ) return;

		const rebaked = this._rebakeView( t );
		if ( rebaked ) this._activeView = { ...rebaked.ocio, id: rebaked.id, name: rebaked.name };

	}

	// ── the renderer ────────────────────────────────────────────────────────────────────────

	/** Hand the registry's TSL nodes to a renderer, and remember it for later view changes. */
	attachRenderer( renderer ) {

		this._renderer = renderer;
		if ( getViewTransform( renderer.toneMapping )?.source === 'builtin' ) this._lastBuiltin = renderer.toneMapping;
		const n = registerWithRenderer( renderer );
		this._applyRendererOutputColorSpace();
		return n;

	}

	/**
	 * An OCIO view already produced display-encoded colour, so the output pass must not encode it
	 * a second time. A built-in curve returns linear and does want the sRGB step.
	 */
	_applyRendererOutputColorSpace() {

		if ( ! this._renderer ) return;

		const t = getViewTransform( this._renderer.toneMapping );
		this._renderer.outputColorSpace = t?.outputEncoded ? LinearSRGBColorSpace : SRGBColorSpace;
		this._applyCanvasColorSpace( t?.source === 'ocio' ? canvasColorSpaceFor( t.ocio.display ) : 'srgb' );

	}

	/**
	 * Tell the browser what the canvas holds.
	 *
	 * three.js configures the WebGPU canvas without a colour space, which means sRGB — so a Display
	 * P3 view, whose values are P3-encoded, was shown as if it were sRGB: every saturated colour in
	 * the wrong place. Reconfiguring with `display-p3` makes the browser read them right; on an sRGB
	 * screen it gamut-maps them instead of misreading them.
	 */
	_applyCanvasColorSpace( colorSpace ) {

		const canvas = this._renderer?.domElement;
		const context = canvas?.getContext?.( 'webgpu' );
		const current = context?.getConfiguration?.();
		if ( ! current ) return;

		// three.js configures the context again on every resize, without a colour space — so a
		// one-off configure here was undone by the next resize. Wrapping this one context's
		// `configure` makes every later call keep the colour space chosen here.
		if ( ! context.__rayzeeConfigure ) {

			const configure = context.configure.bind( context );
			context.__rayzeeConfigure = configure;
			context.configure = config => configure( { ...config, colorSpace: context.__rayzeeColorSpace ?? config.colorSpace } );

		}

		context.__rayzeeColorSpace = colorSpace;
		if ( current.colorSpace === colorSpace ) return;

		try {

			context.configure( { ...current, colorSpace } );

		} catch ( error ) {

			this._issues?.warn(
				ISSUE_CODES.VIEW_TRANSFORM_DISPLAY_MISMATCH,
				`the canvas could not be set to ${colorSpace}: ${error.message}`,
				{ colorSpace }
			);

		}

	}

	// ── input ───────────────────────────────────────────────────────────────────────────────

	/** What colour space a file is in, per the config's rules. Null without a config. */
	resolveInput( filePath, options ) {

		return resolveInputSpace( filePath, options );

	}

	/** What colour space a three.js texture is in. Null without a config, or for data textures. */
	textureSpace( texture, filePath ) {

		return textureInputSpace( texture, filePath );

	}

	/** As `textureSpace`, plus how it was decided — `'tag'`, `'override'`, `'rule'` or `'three'`. */
	resolveTexture( texture, filePath ) {

		return resolveTextureSpace( texture, filePath );

	}

	/**
	 * What a colour map's colour-space menu should show: the artist's own choice, and what the
	 * engine would decide without one.
	 *
	 * @returns {{ choice: ?string, auto: ?{ colorSpace: string, via: string } }}
	 *   `choice` is a config space, `'srgb'`, `'linear'`, or null for automatic
	 */
	describeTextureSpace( texture ) {

		const ud = texture?.userData ?? {};
		const choice = ud.ocioColorSpace ?? ud.__rayzeeColorSpaceChoice ?? null;

		let auto = null;
		const original = ud.__rayzeeOriginalColorSpace ?? texture?.colorSpace;
		if ( hasConfig() ) {

			const probe = { ...texture, name: texture?.name, image: texture?.image, colorSpace: original, userData: {} };
			auto = resolveTextureSpace( probe );

		}

		if ( ! auto ) auto = { colorSpace: original === SRGBColorSpace ? 'sRGB' : 'Linear', via: 'three' };
		return { choice, auto };

	}

	/**
	 * Everything a converted texture depends on, as one string, for cache keys.
	 *
	 * The working space alone is not enough: an override or a different config changes what a
	 * texture is *read as* without changing what it is converted *into*.
	 */
	get inputKey() {

		if ( ! hasConfig() ) return '-';
		return `${describeConfig()?.id}|${this.workingSpace}|${getInputVersion()}|${JSON.stringify( this._context )}`;

	}

	/** Pin a colour space for files matching a path fragment or pattern. */
	overrideInput( match, colorSpace ) {

		setInputOverride( match, colorSpace );

	}

	fileRules() {

		return listFileRules();

	}

	/** Convert a float RGBA buffer into the working space, in place. */
	toWorkingPixels( rgba, from ) {

		if ( ! hasConfig() || ! from ) return rgba;
		return convertPixelsF32( rgba, from, this.workingSpace, { context: this._context } );

	}

	/**
	 * The config's name for the space the engine natively works in — linear, sRGB primaries.
	 *
	 * Needed because the engine's existing pipeline already stores textures sRGB-encoded over
	 * Rec.709 primaries. Converting one into an adopted working space is then only a primaries
	 * change, and this names the space to measure that change from.
	 */
	get nativeLinearSpace() {

		return findNativeLinearSpace( getConfigInfo() );

	}

	/**
	 * The 3×3 taking the engine's native linear Rec.709 into the working space, or null when no
	 * conversion is needed or the config cannot express it as a matrix.
	 */
	/** Recompute the published primaries matrix. Called whenever the config or space changes. */
	_publishWorkingMatrix() {

		if ( active !== null && active !== this ) return;
		setWorkingMatrix( hasConfig() ? this.primariesMatrixToWorking() : null, this.workingSpace );

	}

	primariesMatrixToWorking() {

		if ( ! hasConfig() || ! this.workingSpaceAdopted ) return null;

		const from = this.nativeLinearSpace;
		if ( ! from || from === this.workingSpace ) return null;

		const m = extractMatrix( from, this.workingSpace, { context: this._context } );
		if ( ! m ) return null;

		const isIdentity = [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ].every( ( v, i ) => Math.abs( m[ i ] - v ) < 1e-6 );
		return isIdentity ? null : m;

	}

	/**
	 * Apply the primaries change to one linear RGB triple, in place.
	 *
	 * Delegates to `WorkingMatrix`, which is where the hot consumers read it from — this is the
	 * same conversion, reachable from the façade.
	 *
	 * @param {Float32Array|number[]} rgb
	 * @returns {boolean} whether anything changed
	 */
	convertLinearTriple( rgb ) {

		return convertLinearTriple( rgb );

	}

	/** Apply the primaries change to interleaved linear triples inside a larger buffer. */
	convertLinearTriples( data, stride, offsets ) {

		return convertLinearTriples( data, stride, offsets );

	}

	/**
	 * Move a whole texture's pixels into the working space, in place.
	 *
	 * Handles the three shapes an environment or HDR texture arrives in — float32, float16 and
	 * bytes — because an HDRI is usually half-float, and silently skipping it would leave the
	 * dominant light source in the wrong space while every surface moved.
	 *
	 * ⚠️ Unlike textures and materials, this cannot be rebuilt from a pristine source: the engine
	 * holds one copy and converts it where it lies. So the space it currently holds is recorded on
	 * the texture, and a later change converts *from that*, rather than refusing because it has
	 * been touched once. That is what lets the working space be turned back off.
	 *
	 * @param {import('three').Texture} texture
	 * @param {Object} [options]
	 * @param {?string} [options.space] - the space it arrived in; omitted means linear Rec.709
	 * @returns {boolean} whether anything was changed
	 */
	convertTexturePixels( texture, { space = null } = {} ) {

		if ( ! hasConfig() ) return false;

		const image = texture?.image;
		const data = image?.data;
		if ( ! data ) return false;

		const native = this.nativeLinearSpace;
		const from = texture.userData?.__rayzeeColorSpace ?? space ?? native;
		const to = this.workingSpaceAdopted ? this.workingSpace : native;

		if ( ! from || ! to || from === to ) return false;

		let changed = false;

		if ( data instanceof Float32Array ) {

			convertPixelsF32( data, from, to, { context: this._context } );
			changed = true;

		} else if ( data instanceof Uint16Array ) {

			const f32 = unpackHalf( data );
			convertPixelsF32( f32, from, to, { context: this._context } );
			data.set( packHalf( f32 ) );
			changed = true;

		} else if ( data instanceof Uint8Array || data instanceof Uint8ClampedArray ) {

			convertEncodedRGBA8( data, from, to, {
				context: this._context, inputEncoding: 'srgb', outputEncoding: 'srgb',
			} );
			changed = true;

		} else {

			this._issues?.warn(
				ISSUE_CODES.VIEW_TRANSFORM_BAKE_FAILED,
				`texture data is ${data.constructor?.name ?? typeof data}, which cannot be colour-converted`,
				{ from, to }
			);
			return false;

		}

		texture.userData = texture.userData ?? {};
		texture.userData.__rayzeeColorSpace = to;
		texture.needsUpdate = true;
		return changed;

	}

	/**
	 * Convert an 8-bit RGBA texture into the working space, in place.
	 *
	 * Two routes, and which one runs matters:
	 *   - `space` given  — the texture is in some named space (ACEScct, LogC, sRGB), and the full
	 *                      OCIO transform runs on the raw bytes. Its own transfer is part of that
	 *                      transform, so nothing is decoded first.
	 *   - `space` omitted — the texture is already what the engine assumes, and only the primaries
	 *                      change, done directly on the bytes.
	 *
	 * @param {Uint8Array|Uint8ClampedArray} bytes
	 * @param {Object} [options]
	 * @param {?string} [options.space] - the texture's own colour space
	 * @param {'srgb'|'linear'} [options.encoding='srgb'] - how the bytes are stored, in and out
	 * @returns {boolean} whether anything was changed
	 */
	convertTextureBytes( bytes, { space = null, encoding = 'srgb' } = {} ) {

		if ( ! hasConfig() ) return false;

		if ( space ) {

			if ( space === this.workingSpace ) return false;
			convertEncodedRGBA8( bytes, space, this.workingSpace, {
				context: this._context,
				inputEncoding: 'raw',
				outputEncoding: encoding,
			} );
			return true;

		}

		const m = this.primariesMatrixToWorking();
		if ( ! m ) return false;

		applyMatrixRGBA8( bytes, m, encoding );
		return true;

	}

	/** Convert one colour into the working space. Cached, so repeated tints are free. */
	toWorkingColor( rgb, from ) {

		if ( ! hasConfig() || ! from ) return [ rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] ];
		return convertColor( rgb, from, this.workingSpace, { context: this._context } );

	}

	/** Convert one colour between any two named spaces. */
	convert( rgb, from, to ) {

		return convertColor( rgb, from, to, { context: this._context } );

	}

	// ── export ──────────────────────────────────────────────────────────────────────────────

	/**
	 * The space a saved render should be written in, or null to save what the view produced.
	 *
	 * Setting this is how you deliver an EXR in ACES2065-1 while still grading through an sRGB
	 * view on screen — the two are different questions and a colour-managed pipeline keeps them
	 * apart.
	 */
	get exportSpace() {

		return this._exportSpace;

	}

	setExportSpace( name ) {

		if ( name !== null && name !== undefined ) {

			if ( ! hasConfig() ) throw new Error( 'load an OCIO config before choosing an export space' );
			if ( ! hasColorSpace( name ) ) throw new Error( `config has no colour space "${name}"` );

		}

		this._exportSpace = name ?? null;
		this._emit( 'export', this._exportSpace );

	}

	/**
	 * Convert a scene-referred float buffer for delivery, in place.
	 *
	 * @param {Float32Array} rgba - working-space linear, 4 floats per pixel
	 * @param {?string} [space] - overrides `exportSpace` for this call
	 * @returns {{ rgba: Float32Array, colorSpace: string }}
	 */
	exportPixels( rgba, space = undefined ) {

		const target = space === undefined ? this._exportSpace : space;
		if ( ! target || ! hasConfig() ) return { rgba, colorSpace: this.workingSpace };

		convertPixelsF32( rgba, this.workingSpace, target, { context: this._context } );
		return { rgba, colorSpace: target };

	}

	// ── lifecycle ───────────────────────────────────────────────────────────────────────────

	/** A snapshot a host can render a panel from without calling six getters. */
	status() {

		const config = describeConfig();
		const active = this._renderer ? getViewTransform( this._renderer.toneMapping ) : null;

		return {
			config,
			workingSpace: this.workingSpace,
			workingSpaceAdopted: this.workingSpaceAdopted,
			activeTransform: active ? { id: active.id, name: active.name, source: active.source } : null,
			activeView: this._activeView,
			context: this._context,
			exportSpace: this._exportSpace,
			views: listViewTransforms(),
			registryVersion: getRegistryVersion(),
			bakeError: active?.error ?? null,
		};

	}

	dispose() {

		this._offRegistry?.();
		this._listeners.clear();
		this._releaseViews();
		setOcioIssueLog( null );
		this._renderer = null;
		this._issues = null;
		if ( active === this ) {

			// The matrix is module state that materials and lights read with no idea whose it is.
			// Left behind, the next app would convert every colour into a space it never adopted.
			setWorkingMatrix( null );
			active = null;

		}

	}

	/** Tear down the shared runtime as well. Tests use this; an app normally should not. */
	static resetAll() {

		active = null;
		setWorkingMatrix( null );
		disposeOcioViewTextures();
		resetViewTransforms();
		resetConfigHandle();
		clearInputOverrides();
		resetOcio();

	}

}

/** Convenience for callers that only want to know whether anything is colour-managed. */
export function isColorManaged() {

	return hasConfig();

}

export { getConfigInfo };
