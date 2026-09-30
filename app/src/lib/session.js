import { acquireLock, heldLockNames, fileIdentity, sameIdentity, EngineEvents } from 'rayzee';
import { APP_AREAS } from '@/lib/storage';
import { snapshotPanels, restorePanels } from '@/lib/panelState';
import { MODEL_FILES } from '@/Constants';
import { useStore, usePathTracerStore, useLightStore, useCameraStore } from '@/store';

export const SESSION_FORMAT = 1;

const STATE = 'state.json';
const THUMB = 'thumb.webp';
const KEEP_SESSIONS = 5;
const SAVE_DELAY_MS = 2000;
const THUMB_EDGE = 320;

const lockName = id => `rayzee-session:${id}`;
const entryKey = ( id, slot ) => `session:${id}:${slot}`;
const newId = () => crypto.randomUUID?.() ?? `${Date.now().toString( 36 )}${Math.random().toString( 36 ).slice( 2 )}`;

const sessionsArea = storage => storage?.area( APP_AREAS.SESSIONS ) ?? null;

/** The engine's scene source, with the catalog entry named when it is one. */
export function describeSource( source ) {

	if ( source?.kind !== 'url' ) return source ?? null;
	const catalog = MODEL_FILES.find( m => m.url === source.url );
	return catalog ? { ...source, catalog: catalog.name } : source;

}

/** Whether a session's model can be reopened: from a link, or by the user opening the same file. */
export function isRestorable( source ) {

	return ( source?.kind === 'url' && !! source.url ) || ( source?.kind === 'local-file' && !! source.file?.name );

}

function titleOf( source, app ) {

	if ( source?.catalog ) return source.catalog;
	if ( source?.kind === 'local-file' ) return source.file.name;
	if ( source?.kind === 'url' ) return source.filename ?? decodeURIComponent( source.url.split( /[?#]/ )[ 0 ].split( '/' ).pop() || 'Model' );
	return app.sceneModel?.name || 'Scene';

}

async function captureThumbnail( app ) {

	if ( typeof document !== 'undefined' && document.hidden ) return null;

	try {

		const canvas = app.getCanvas();
		if ( ! canvas?.width ) return null;
		const bitmap = await createImageBitmap( canvas );
		const scale = Math.min( 1, THUMB_EDGE / Math.max( bitmap.width, bitmap.height ) );
		const out = new OffscreenCanvas( Math.max( 1, Math.round( bitmap.width * scale ) ), Math.max( 1, Math.round( bitmap.height * scale ) ) );
		out.getContext( '2d' ).drawImage( bitmap, 0, 0, out.width, out.height );
		bitmap.close();
		return await out.convertToBlob( { type: 'image/webp', quality: 0.8 } );

	} catch {

		return null;

	}

}

/**
 * The scene as a session record: where the model came from, the engine's edits and the panels.
 * @returns {Promise<{record: Object, thumb: ?Blob}>}
 */
export async function captureSession( app, { id = null, thumbnail = true } = {} ) {

	const source = describeSource( app.sceneSource );
	const record = {
		v: SESSION_FORMAT,
		id,
		savedAt: Date.now(),
		title: titleOf( source, app ),
		source,
		scene: app.exportSceneState(),
		panels: snapshotPanels(),
	};
	return { record, thumb: thumbnail ? await captureThumbnail( app ) : null };

}

/** What a save would write, minus when: equal prints need no second save. */
function fingerprint( app ) {

	return JSON.stringify( { source: app.sceneSource, scene: { ...app.exportSceneState(), savedAt: 0 }, panels: snapshotPanels() } );

}

/** Keeps the page's URL pointing at the model when a plain link reopens it, and at nothing otherwise. */
export function syncModelParam( source ) {

	if ( typeof window === 'undefined' ) return;
	const url = new URL( window.location.href );
	const link = source?.kind === 'url' && ! source.cacheKey && source.element === undefined && source.pbrtEntry === undefined ? source.url : null;
	if ( ( url.searchParams.get( 'model' ) ?? null ) === link ) return;
	if ( link ) url.searchParams.set( 'model', link );
	else url.searchParams.delete( 'model' );
	window.history.replaceState( window.history.state, '', url );

}

/**
 * Saved sessions, newest first, one per session: `{ key, id, savedAt, title, locked }`. A locked
 * one belongs to a tab that is still open.
 */
export async function listSessions( storage ) {

	const area = sessionsArea( storage );
	if ( ! area ) return [];

	const held = await heldLockNames();
	const newest = new Map();
	for ( const meta of await area.list() ) {

		const { id, savedAt, title } = meta.extra ?? {};
		if ( meta.extra?.kind !== 'session' || ! id ) continue;
		if ( ( newest.get( id )?.savedAt ?? - 1 ) < savedAt ) newest.set( id, { key: meta.key, id, savedAt, title, locked: held.has( lockName( id ) ) } );

	}

	return [ ...newest.values() ].sort( ( a, b ) => b.savedAt - a.savedAt );

}

/** @returns {Promise<?{record: Object, thumb: ?Blob}>} */
export async function readSession( storage, key ) {

	const entry = await sessionsArea( storage )?.open( key, { wait: true } );
	if ( ! entry ) return null;

	try {

		const record = await entry.json( STATE );
		if ( record?.v !== SESSION_FORMAT ) return null;
		const thumb = entry.meta.files[ THUMB ] ? await entry.file( THUMB ) : null;
		return { record, thumb: thumb ? new Blob( [ await thumb.arrayBuffer() ], { type: 'image/webp' } ) : null };

	} finally {

		entry.release();

	}

}

/**
 * The session to offer at startup (D1: ask first), or null: the newest one no open tab owns whose
 * model can be reopened. With a `?model=` link, only a session of that same model is offered.
 */
export async function sessionToOffer( storage, { modelParam = null } = {} ) {

	for ( const meta of await listSessions( storage ) ) {

		if ( meta.locked ) continue;
		const session = await readSession( storage, meta.key );
		const source = session?.record.source;
		if ( ! isRestorable( source ) ) continue;
		if ( modelParam && ( source.kind !== 'url' || source.url !== modelParam ) ) return null;
		return { ...meta, ...session };

	}

	return null;

}

function identityFromKey( key ) {

	const match = /^file:(.*)\|(\d+)\|(\d+)\|([0-9a-f]+)$/.exec( key ?? '' );
	return match ? { name: match[ 1 ], size: Number( match[ 2 ] ), lastModified: Number( match[ 3 ] ), sample: match[ 4 ] } : null;

}

/**
 * The file a session names, from the user: `pickFile( identity, role )` asks and resolves a File or
 * null. A different file is refused with the name that was expected.
 */
async function reopenFile( identity, role, pickFile ) {

	const file = await pickFile( identity, role );
	if ( ! file ) return null;
	if ( identity.sample && ! sameIdentity( await fileIdentity( file ), identity ) ) {

		const error = new Error( `That is not the file this session used — it expected "${identity.name}".` );
		error.code = 'SESSION_FILE_MISMATCH';
		throw error;

	}

	return file;

}

/** Whether the model on screen is the one a session names, loaded the same way. */
export function isSameSource( loaded, saved ) {

	if ( loaded?.kind !== 'url' || saved?.kind !== 'url' ) return false;
	const url = MODEL_FILES.find( m => m.name === saved.catalog )?.url ?? saved.url;
	return loaded.url === url && ( loaded.cacheKey ?? null ) === ( saved.cacheKey ?? null )
		&& JSON.stringify( loaded.element ?? null ) === JSON.stringify( saved.element ?? null )
		&& ( loaded.pbrtEntry ?? null ) === ( saved.pbrtEntry ?? null );

}

/** Loads a session's model. Resolves false when the user did not open the file it needs. */
export async function openSource( app, source, { pickFile } ) {

	const part = {
		...( source.element !== undefined ? { element: source.element } : {} ),
		...( source.pbrtEntry !== undefined ? { pbrtEntry: source.pbrtEntry } : {} ),
	};

	if ( source.kind === 'url' ) {

		const url = MODEL_FILES.find( m => m.name === source.catalog )?.url ?? source.url;
		if ( source.filename || Object.keys( part ).length ) await app.loadFile( url, { filename: source.filename, cacheKey: source.cacheKey ?? undefined, ...part } );
		else await app.loadModel( url, source.cacheKey ? { cacheKey: source.cacheKey } : {} );
		return true;

	}

	const file = await reopenFile( source.file, 'model', pickFile );
	if ( ! file ) return false;
	await app.loadFile( file, part );
	return true;

}

/**
 * Reopens a session: the model, then every edit, then the panels.
 * @param {Object} record - from {@link readSession} or a project file
 * @param {Object} options
 * @param {function(Object, string): Promise<?File>} options.pickFile - asks the user for a file
 * @param {boolean} [options.reuseLoaded] - keep the model on screen when it is the session's and
 *   still as it loaded (startup), rather than loading it twice
 * @returns {Promise<?{skipped: Array}>} null when the model's file was not opened
 */
export async function restoreSession( app, record, { pickFile, reuseLoaded = false } ) {

	const reuse = reuseLoaded && isSameSource( app.sceneSource, record.source );
	if ( ! reuse && ! await openSource( app, record.source, { pickFile } ) ) return null;

	const { loadDefaultConfig, DEFAULT_COLOR_CONFIG } = await import( '@/lib/colorManagement' );
	const report = await app.importSceneState( record.scene, {
		resolve: async ( request ) => {

			if ( request.kind === 'environment' ) {

				const identity = identityFromKey( request.source );
				return identity ? await reopenFile( identity, 'environment', pickFile ) : null;

			}

			if ( request.kind === 'colorConfig' && request.config.id === DEFAULT_COLOR_CONFIG.id ) {

				await loadDefaultConfig();
				return true;

			}

			return null;

		},
	} );

	restorePanels( record.panels );
	usePathTracerStore.getState()._applyCanvasDimensions();
	useLightStore.getState().setLights( app.lightManager.getAll() );
	useCameraStore.getState().setCameraNames( app.cameraManager.getCameraNames() );
	useCameraStore.getState().setSelectedCameraIndex( app.currentCameraIndex );
	window.dispatchEvent( new CustomEvent( 'SceneRebuild' ) );
	return report;

}

/**
 * Saves the scene into `sessions/` a moment after the last change, and when the page is hidden or
 * closed. Each tab owns one session through a Web Lock, so two tabs never write the same one and
 * a new tab only offers sessions no open tab owns. Writes alternate between two entries, so a
 * save cut short leaves the previous one intact.
 */
export class SessionKeeper {

	constructor( app, { delay = SAVE_DELAY_MS, stores = [] } = {} ) {

		this.app = app;
		this.id = newId();
		this._slot = 0;
		this._delay = delay;
		this._stores = stores;
		this._timer = null;
		this._dirty = false;
		this._enabled = false;
		this._saving = null;
		this._release = null;
		this._off = [];

	}

	async start() {

		this._release = await acquireLock( lockName( this.id ) );

		const touch = () => this.touch();
		for ( const type of [ EngineEvents.RENDER_RESET, EngineEvents.TIMELINE_CHANGED, EngineEvents.CAMERAS_UPDATED, EngineEvents.ENVIRONMENT_LOADED, EngineEvents.SCENE_REBUILD ] ) {

			this.app.addEventListener( type, touch );
			this._off.push( () => this.app.removeEventListener( type, touch ) );

		}

		const settings = this.app.settings;
		settings.addEventListener( EngineEvents.SETTING_CHANGED, touch );
		this._off.push( () => settings.removeEventListener( EngineEvents.SETTING_CHANGED, touch ) );

		const onModel = () => syncModelParam( this.app.sceneSource );
		this.app.addEventListener( EngineEvents.MODEL_LOADED, onModel );
		this._off.push( () => this.app.removeEventListener( EngineEvents.MODEL_LOADED, onModel ) );

		for ( const store of this._stores ) this._off.push( store.subscribe( touch ) );

		const hide = () => {

			if ( document.visibilityState === 'hidden' ) this.flush();

		};

		const leave = () => this.flush();
		document.addEventListener( 'visibilitychange', hide );
		window.addEventListener( 'pagehide', leave );
		this._off.push( () => document.removeEventListener( 'visibilitychange', hide ), () => window.removeEventListener( 'pagehide', leave ) );

	}

	/** Saving waits for this: startup, a restore and the restore question must not be saved over. */
	setEnabled( enabled ) {

		this._enabled = enabled;
		if ( ! enabled ) {

			clearTimeout( this._timer );
			return;

		}

		// What is on screen now is already saved, or not worth offering: an untouched startup scene.
		try {

			this._written = fingerprint( this.app );

		} catch {

			this._written = null;

		}

	}

	/** Takes over a restored session, so its edits keep saving into it rather than into a copy. */
	async adopt( meta ) {

		const release = await acquireLock( lockName( meta.id ), { ifAvailable: true } );
		if ( ! release ) return false;
		this._release?.();
		this._release = release;
		this.id = meta.id;
		this._slot = Number( meta.key.split( ':' ).pop() ) || 0;
		return true;

	}

	touch() {

		if ( ! this._enabled ) return;
		this._dirty = true;
		clearTimeout( this._timer );
		this._timer = setTimeout( () => this.flush(), this._delay );

	}

	async flush() {

		clearTimeout( this._timer );
		if ( ! this._dirty || ! this._enabled ) return;
		await this._saving;
		if ( this._dirty ) await ( this._saving = this._save().finally( () => {

			this._saving = null;

		} ) );

	}

	async _save() {

		const app = this.app;
		const area = sessionsArea( app.storage );
		if ( ! area || ! isRestorable( describeSource( app.sceneSource ) ) ) return;
		if ( app._loadingInProgress ) {

			this.touch();
			return;

		}

		// A session is the scene as Preview has it; Final Render's preset is not an edit. Leaving it
		// resets, which saves anything changed meanwhile.
		if ( useStore.getState().appMode !== 'preview' ) return;

		this._dirty = false;
		const print = fingerprint( app );
		if ( print === this._written ) return;
		const { record, thumb } = await captureSession( app, { id: this.id } );
		const slot = this._slot ^ 1;
		const writer = await area.create( entryKey( this.id, slot ), {
			label: `Session · ${record.title}`,
			extra: { kind: 'session', id: this.id, savedAt: record.savedAt, title: record.title },
		} );
		if ( ! writer ) return;

		try {

			await writer.writeJSON( STATE, record );
			if ( thumb ) await writer.writeFile( THUMB, thumb );
			await writer.commit();

		} catch {

			await writer.abort();
			return;

		}

		await area.remove( entryKey( this.id, this._slot ) );
		this._slot = slot;
		this._written = print;
		await this._prune( area );

	}

	async _prune( area ) {

		const sessions = await listSessions( this.app.storage );
		const old = sessions.filter( s => ! s.locked && s.id !== this.id ).slice( KEEP_SESSIONS - 1 );
		for ( const { id } of old ) {

			await area.remove( entryKey( id, 0 ) );
			await area.remove( entryKey( id, 1 ) );

		}

	}

	dispose() {

		clearTimeout( this._timer );
		for ( const off of this._off.splice( 0 ) ) off();
		this._release?.();
		this._release = null;

	}

}

let activeKeeper = null;

/** The running app's keeper, so the restore dialog can pause and adopt. */
export function getSessionKeeper() {

	return activeKeeper;

}

/** Starts saving the app's session; the previous keeper, if any, stops. */
export async function startSessionKeeper( app, stores ) {

	activeKeeper?.dispose();
	activeKeeper = new SessionKeeper( app, { stores } );
	await activeKeeper.start();
	return activeKeeper;

}

export function stopSessionKeeper() {

	activeKeeper?.dispose();
	activeKeeper = null;

}
