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

import { LinearSRGBColorSpace, SRGBColorSpace, NoToneMapping, HalfFloatType } from 'three';

import { ISSUE_CODES } from '../EngineIssues.js';
import { displayCanvasFit, hdrViewFor, isHdrDisplay, findNativeLinearSpace } from './Displays.js';

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
import {
	addOcioView, addAllOcioViews, buildBakedView, disposeOcioViewTextures, forgetOcioView, setOcioIssueLog, releaseDerivedConfig,
	buildCanvasView, buildBakedCanvasView, canvasFitOf,
} from './OcioViews.js';
import { encodeBakedView, decodeBakedView, configFingerprint } from './BakedViews.js';
import {
	resolveInputSpace, textureInputSpace, resolveTextureSpace, setInputOverride, clearInputOverrides,
	listFileRules, getInputVersion, bumpInputVersion,
} from './InputColorSpaces.js';
import { setWorkingMatrix, convertLinearTriple, convertLinearTriples } from './WorkingMatrix.js';
import { packHalf, unpackHalf } from './LutBake.js';
import { DEFAULT_WORKING_SPACE, getActiveColorManagement, setActiveColorManagement, claimActiveColorManagement } from './ActiveColor.js';

export { DEFAULT_WORKING_SPACE, getActiveColorManagement, setActiveColorManagement };

/** The canvas colour space for a display: its own when it has one, sRGB otherwise. */
export function canvasColorSpaceFor( display ) {

	return displayCanvasFit( display ) ?? 'srgb';

}

/** The canvas colour space a view's table is encoded for (`ocio.canvas`, set when it was baked). */
function canvasOf( t ) {

	return t?.source === 'ocio' ? t.ocio.canvas ?? canvasColorSpaceFor( t.ocio.display ) : 'srgb';

}

// Each is 2.2 MB on the card and 2.2 MB here.
const RECENT_CANVAS_VIEWS = 4;

const REC709_CHROMATICITIES = Object.freeze( [ 0.64, 0.33, 0.30, 0.60, 0.15, 0.06, 0.3127, 0.3290 ] );

// An environment's record of being in the engine's own linear Rec.709, whatever the config calls it; CDFCache keys an
// unrecorded one the same way.
const NATIVE = 'native';

function canvasKey( ocio, canvas ) {

	return JSON.stringify( [ ocio.configId, ocio.display, ocio.view, ocio.look ?? null, ocio.source, ocio.context ?? null, canvas ] );

}

export { findNativeLinearSpace };

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

		// What the canvas shows in place of the active view (`{ key, table, hdr }`), and why HDR is not on screen.
		this._hdrOutput = false;
		this._canvasView = null;
		this._canvasReason = null;
		// canvasKey → canvas view, from saved files: an HDR version shown before the config loads.
		this._bakedCanvasViews = new Map();
		// canvasKey → the last few HDR versions baked, least recent first, so switching back needs no bake.
		this._recentCanvasViews = new Map();

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

		claimActiveColorManagement( this );

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
		this._updateCanvasView();

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
		this._updateCanvasView();
		this._emit( 'config', null );
		this._emit( 'workingSpace', this.workingSpace );

	}

	_releaseViews( keep = null ) {

		disposeOcioViewTextures( keep );
		releaseDerivedConfig();
		removeOcioViewTransforms( keep );
		for ( const id of this._lastUsed.keys() ) if ( ! keep?.has( id ) ) this._lastUsed.delete( id );

		if ( this._renderer && getViewTransform( this._renderer.toneMapping ) === null ) {

			// Back to the curve the host was on before a config took over — not None, which clamps
			// and looks broken — and with the output transfer switched back on to match.
			this._renderer.toneMapping = getViewTransform( this._lastBuiltin ) ? this._lastBuiltin : FALLBACK_VIEW;
			this._activeView = null;
			this._applyRendererOutputColorSpace();
			this._updateCanvasView();

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
	 * A file saved with `{ hdr: true }` is a view's HDR version instead: it is kept for that view and shown while
	 * {@link setHdrOutput} is on, and the view's own entry is returned.
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

		if ( baked.for ) {

			const key = canvasKey( { ...baked, ...baked.for }, baked.canvas ?? 'srgb' );
			const old = this._bakedCanvasViews.get( key );
			this._bakedCanvasViews.set( key, buildBakedCanvasView( baked ) );
			if ( old && old !== this._canvasView?.table ) old.dispose();
			this._updateCanvasView();
			return [ ...VIEW_TRANSFORMS.values() ].find( t => t.source === 'ocio' && t.ocio.display === baked.for.display
				&& t.ocio.view === baked.for.view && ( t.ocio.look ?? null ) === ( baked.look ?? null ) ) ?? null;

		}

		const existing = [ ...VIEW_TRANSFORMS.values() ].find( t => t.source === 'ocio' && t.ocio.display === baked.display
			&& t.ocio.view === baked.view && ( t.ocio.look ?? null ) === ( baked.look ?? null ) );
		if ( ! existing ) this._makeRoomForTable();

		return addViewTransform( buildBakedView( baked, existing?.id ?? null ) );

	}

	/**
	 * A registered OCIO view as a file for {@link loadBakedView}; with `hdr`, its HDR version.
	 * @param {number} id
	 * @param {Object} [options]
	 * @param {boolean} [options.hdr=false]
	 * @returns {Promise<Uint8Array>}
	 */
	async saveBakedView( id, { hdr = false } = {} ) {

		const t = getViewTransform( id );
		if ( t?.source !== 'ocio' ) throw new Error( `no OCIO view with id ${id}` );

		const config = describeConfig();
		const extra = {
			configId: config?.id ?? t.ocio.configId,
			fingerprint: ( config ? await this._fingerprint : null ) ?? t.ocio.baked?.fingerprint ?? null,
			ocioVersion: config?.ocioVersion ?? t.ocio.baked?.ocioVersion ?? null,
		};
		if ( ! hdr ) return await encodeBakedView( t, extra );

		const canvas = canvasOf( t );
		const key = canvasKey( t.ocio, canvas );
		const held = this._canvasView?.key === key ? this._canvasView.table : this._bakedCanvasViews.get( key ) ?? this._recentCanvasViews.get( key );
		const target = held ? null : config && hdrViewFor( config, t.ocio.display, t.ocio.view );
		if ( ! held && ! target ) throw new Error( `"${t.name}" has no HDR version${config ? ' in this config' : ' without its config loaded'}` );

		const table = held ?? this._buildCanvasView( t, target, canvas );
		try {

			return await encodeBakedView( table, extra );

		} finally {

			if ( table !== held ) table.dispose();

		}

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
		this._updateCanvasView();
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
				// The size the host asked for; one the bake chose is chosen again.
				size: t.ocio.requestedSize ?? null,
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
		this._updateCanvasView();

	}

	// ── the renderer ────────────────────────────────────────────────────────────────────────

	/** Hand the registry's TSL nodes to a renderer, and remember it for later view changes. */
	attachRenderer( renderer ) {

		this._renderer = renderer;
		if ( getViewTransform( renderer.toneMapping )?.source === 'builtin' ) this._lastBuiltin = renderer.toneMapping;
		const n = registerWithRenderer( renderer );
		this._applyRendererOutputColorSpace();
		this._updateCanvasView();
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
		this._applyCanvasColorSpace( canvasOf( t ) );

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

		this._canvasColorSpace = colorSpace;
		const canvas = this._renderer?.domElement;
		const context = canvas?.getContext?.( 'webgpu' );
		if ( ! context?.configure ) return;

		// three.js configures the context again on every resize, without a colour space — so a
		// one-off configure here was undone by the next resize. Wrapping this one context's
		// `configure` makes every later call keep the colour space chosen here.
		if ( ! context.__rayzeeConfigure ) {

			// Chrome keeps the colour space and format a canvas had when first copied (drawImage, createImageBitmap) for
			// every later copy, so thumbnails and video frames read a switched canvas wrongly, or an old picture; setting
			// its size again, even unchanged, resets that. toBlob is unaffected.
			const page = ( typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement )
				|| ( typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas );
			const configure = context.configure.bind( context );
			context.__rayzeeConfigure = configure;
			context.configure = config => {

				const before = context.getConfiguration?.();
				const next = { ...config, colorSpace: context.__rayzeeColorSpace ?? config.colorSpace };
				configure( next );
				if ( page && before && ( before.format !== next.format || ( before.colorSpace ?? 'srgb' ) !== ( next.colorSpace ?? 'srgb' ) ) ) {

					const { width } = canvas;
					canvas.width = width;

				}

			};

		}

		context.__rayzeeColorSpace = colorSpace;
		const current = context.getConfiguration?.();
		if ( ! current || current.colorSpace === colorSpace ) return;

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

	// ── HDR on screen ───────────────────────────────────────────────────────────────────────

	/**
	 * Show the active view's HDR version (`hdrViewFor`) on a half-float, extended-range canvas, 1.0 at 100 nits. Only the
	 * canvas: readbacks and saved pictures keep the view itself. `status().hdr` says what is shown, or why not.
	 * @param {boolean} enabled
	 */
	setHdrOutput( enabled ) {

		if ( !! enabled === this._hdrOutput ) return;
		this._hdrOutput = !! enabled;
		this._updateCanvasView();

	}

	get hdrOutput() {

		return this._hdrOutput;

	}

	/** The colour space the canvas, and so every picture read from it, is in: 'srgb' or 'display-p3'. */
	get canvasColorSpace() {

		return this._canvasColorSpace ?? 'srgb';

	}

	/**
	 * Whether the canvas shows a display as it is ('srgb', 'display-p3') or converted (null), measured through the config.
	 * Without one, by its name.
	 */
	displayFit( display ) {

		return hasConfig() ? canvasFitOf( display ).fit : displayCanvasFit( display );

	}

	/** What the canvas shows the active view through, `( color, exposure ) => node`; null for the view itself. */
	get canvasTransform() {

		return this._canvasView?.table?.tsl ?? null;

	}

	_canvasOnScreen() {

		const canvas = this._renderer?.domElement;
		return ( typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement )
			|| ( typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas );

	}

	/** What the canvas shows for the active view: `{ key, table, hdr }`, a `target` to bake, or a `reason` for nothing. */
	_canvasPlan() {

		const t = this._renderer ? getViewTransform( this._renderer.toneMapping ) : null;
		if ( ! t || ! this._hdrOutput ) return { reason: null };

		if ( t.source !== 'ocio' ) {

			// None is unclamped, so on an HDR canvas whatever is brighter than white shows brighter.
			return t.id === NoToneMapping ? { key: 'none', table: null, hdr: true } : { reason: 'no-hdr-version' };

		}

		// A view for an HDR display is baked with its range: the canvas only has to hold it.
		const config = describeConfig();
		if ( isHdrDisplay( config, t.ocio.display ) ) return { key: 'own', table: null, hdr: true };

		const canvas = canvasOf( t );
		const key = canvasKey( t.ocio, canvas );
		const baked = this._bakedCanvasViews.get( key );
		if ( baked ) return { key, table: baked, hdr: true };
		const target = config && hdrViewFor( config, t.ocio.display, t.ocio.view );
		if ( target ) return { key, target, canvas, view: t, hdr: true };
		return { reason: config ? 'no-hdr-version' : 'needs-config' };

	}

	_buildCanvasView( t, target, canvas ) {

		const { look, context, source, requestedSize, display, view } = t.ocio;
		return buildCanvasView( { ...target, look, context, source, size: requestedSize ?? null, canvas, for: { display, view } } );

	}

	/** Bring the canvas in step with the active view and the HDR setting. */
	_updateCanvasView() {

		const plan = this._canvasPlan();
		const current = this._canvasView;
		let table = plan.table ?? ( plan.key && plan.key === current?.key ? current.table : null ) ?? this._recentCanvasViews.get( plan.key ) ?? null;

		if ( plan.target && ! table ) {

			try {

				table = this._buildCanvasView( plan.view, plan.target, plan.canvas );

			} catch ( error ) {

				this._issues?.warn(
					ISSUE_CODES.VIEW_TRANSFORM_BAKE_FAILED,
					`could not bake how the screen shows "${plan.view.name}": ${error.message}`,
					{ ...plan.target }
				);
				this._setCanvasView( null, 'bake-failed' );
				return;

			}

		}

		if ( plan.target ) this._rememberCanvasView( plan.key, table );
		this._setCanvasView( plan.key ? { key: plan.key, table, hdr: plan.hdr } : null, plan.reason ?? null );

	}

	_rememberCanvasView( key, table ) {

		const recent = this._recentCanvasViews;
		recent.delete( key );
		recent.set( key, table );
		while ( recent.size > RECENT_CANVAS_VIEWS ) {

			const [ oldest, old ] = recent.entries().next().value;
			recent.delete( oldest );
			if ( old !== this._canvasView?.table && old !== table ) old.dispose();

		}

	}

	_setCanvasView( next, reason ) {

		const old = this._canvasView;
		const kept = new Set( [ ...this._bakedCanvasViews.values(), ...this._recentCanvasViews.values() ] );
		if ( old?.table && old.table !== next?.table && ! kept.has( old.table ) ) old.table.dispose();

		const hdr = !! next?.hdr && this._canvasOnScreen();
		const why = reason ?? ( next?.hdr && ! hdr ? 'no-screen' : null );
		const changed = ( old?.table ?? null ) !== ( next?.table ?? null ) || !! old?.hdr !== !! next?.hdr || this._canvasReason !== why;
		this._canvasView = next;
		this._canvasReason = why;

		// three.js reads the canvas format, and from it the tone mapping mode, when it next configures the canvas.
		const backend = this._renderer?.backend;
		const outputType = hdr ? HalfFloatType : undefined;
		if ( backend?.parameters && backend.parameters.outputType !== outputType ) {

			backend.parameters.outputType = outputType;
			backend.updateSize?.();

		}

		if ( changed ) this._emit( 'canvas', this.canvasTransform );

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

		const active = getActiveColorManagement();
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

		// Back in the native space it is recorded as NATIVE, not by name: configs name that space differently, and one
		// recorded under Blender's name ("Linear Rec.709") was never converted under ACES's.
		const native = this.nativeLinearSpace;
		const recorded = texture.userData?.__rayzeeColorSpace;
		const from = recorded === NATIVE ? native : recorded ?? space ?? native;
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
		texture.userData.__rayzeeColorSpace = to === native ? NATIVE : to;
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

	/**
	 * Red, green, blue and white xy of a linear colour space, measured through the config's CIE XYZ D65 interchange
	 * space, for files that record them (OpenEXR, Radiance HDR). Null without that role.
	 * @param {string} [space] - defaults to the working space
	 * @returns {?number[]}
	 */
	chromaticities( space = this.workingSpace ) {

		const xyz = hasConfig() ? describeConfig()?.roles?.cie_xyz_d65_interchange : null;
		if ( ! xyz || ! hasColorSpace( xyz ) || ! hasColorSpace( space ) ) return space === DEFAULT_WORKING_SPACE ? REC709_CHROMATICITIES : null;

		const probe = new Float32Array( [ 1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 1, 1 ] );
		convertPixelsF32( probe, space, xyz, { context: this._context } );
		const out = [];
		for ( let i = 0; i < 16; i += 4 ) {

			const sum = probe[ i ] + probe[ i + 1 ] + probe[ i + 2 ];
			if ( ! ( sum > 0 ) ) return null;
			out.push( probe[ i ] / sum, probe[ i + 1 ] / sum );

		}

		return out;

	}

	// ── lifecycle ───────────────────────────────────────────────────────────────────────────

	/** A snapshot a host can render a panel from without calling six getters. */
	status() {

		const config = describeConfig();
		const active = this._renderer ? getViewTransform( this._renderer.toneMapping ) : null;
		const showing = !! this._canvasView?.hdr && this._canvasOnScreen();

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
			canvasColorSpace: this.canvasColorSpace,
			// `reason` when HDR is on but not shown: 'no-hdr-version' | 'needs-config' | 'bake-failed' | 'no-screen'.
			hdr: {
				on: this._hdrOutput,
				showing,
				view: showing ? this._canvasView.table?.name ?? active?.name ?? null : null,
				reason: this._canvasReason,
			},
		};

	}

	dispose() {

		this._offRegistry?.();
		this._listeners.clear();
		this._releaseViews();
		for ( const table of new Set( [ this._canvasView?.table, ...this._bakedCanvasViews.values(), ...this._recentCanvasViews.values() ] ) ) table?.dispose();
		this._canvasView = null;
		this._bakedCanvasViews.clear();
		this._recentCanvasViews.clear();
		setOcioIssueLog( null );
		this._renderer = null;
		this._issues = null;
		if ( getActiveColorManagement() === this ) {

			// The matrix is module state that materials and lights read with no idea whose it is.
			// Left behind, the next app would convert every colour into a space it never adopted.
			setWorkingMatrix( null );
			setActiveColorManagement( null );

		}

	}

	/** Tear down the shared runtime as well. Tests use this; an app normally should not. */
	static resetAll() {

		setActiveColorManagement( null );
		setWorkingMatrix( null );
		disposeOcioViewTextures();
		releaseDerivedConfig();
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
