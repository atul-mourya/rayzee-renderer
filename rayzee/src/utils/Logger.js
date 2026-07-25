/**
 * Leveled, namespaced console logger shared by the engine, the app and the workers.
 *
 * The engine prints one summary line per startup phase at `info`; every per-detail
 * line sits at `debug` so a normal load stays readable and nothing is lost.
 *
 * Active level, first match wins:
 *   1. globalThis.__RAYZEE_LOG_LEVEL__   — set by Logger.setLevel(), forwarded to workers
 *   2. localStorage.rayzeeLogLevel       — survives reloads (main thread only)
 *   3. 'info'
 *
 * From the devtools console:
 *   rayzee.log.setLevel( 'debug' )    // everything, including per-mesh/per-kernel detail
 *   rayzee.log.setLevel( 'warn' )     // problems only
 *   rayzee.log.only( 'bvh', 'gpu' )   // debug, limited to these namespaces
 *   rayzee.log.only()                 // clear the namespace filter
 */

export const LOG_LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const DEFAULT_LEVEL = 'info';
const STORAGE_KEY = 'rayzeeLogLevel';
const NS_STORAGE_KEY = 'rayzeeLogNamespaces';

const PREFIX_STYLE = 'color:#7c8494';
const RESET_STYLE = 'color:inherit';

// Cached so a hot log site is a numeric compare, not a storage read.
let activeLevel = null;
let namespaceFilter = null;

function readStorage( key ) {

	try {

		return globalThis.localStorage?.getItem( key ) ?? null;

	} catch {

		return null; // private mode, or a worker without storage access

	}

}

function writeStorage( key, value ) {

	try {

		if ( value === null ) globalThis.localStorage?.removeItem( key );
		else globalThis.localStorage?.setItem( key, value );

	} catch {

		// non-fatal: the level still applies for this session

	}

}

function resolveLevel() {

	if ( activeLevel !== null ) return activeLevel;

	const fromGlobal = globalThis.__RAYZEE_LOG_LEVEL__;
	if ( fromGlobal !== undefined && fromGlobal in LOG_LEVELS ) {

		activeLevel = LOG_LEVELS[ fromGlobal ];
		return activeLevel;

	}

	const fromStorage = readStorage( STORAGE_KEY );
	activeLevel = LOG_LEVELS[ fromStorage ] ?? LOG_LEVELS[ DEFAULT_LEVEL ];
	return activeLevel;

}

function resolveNamespaceFilter() {

	if ( namespaceFilter !== null ) return namespaceFilter;

	const raw = globalThis.__RAYZEE_LOG_NS__ ?? readStorage( NS_STORAGE_KEY );
	namespaceFilter = raw ? String( raw ).split( ',' ).map( s => s.trim() ).filter( Boolean ) : [];
	return namespaceFilter;

}

// The namespace filter only narrows `debug`; warnings and errors are never hidden by it.
function namespaceAllowed( ns, level ) {

	if ( level < LOG_LEVELS.debug ) return true;
	const filter = resolveNamespaceFilter();
	return filter.length === 0 || filter.some( f => ns === f || ns.startsWith( `${f}:` ) );

}

function emit( level, ns, args ) {

	if ( level > resolveLevel() || ! namespaceAllowed( ns, level ) ) return;

	const sink = level === LOG_LEVELS.error ? console.error
		: level === LOG_LEVELS.warn ? console.warn
			: console.log;

	const prefix = `[${ns}]`;

	// Style only the prefix, and only when the first argument is a string we can splice into.
	if ( typeof args[ 0 ] === 'string' ) {

		sink( `%c${prefix}%c ${args[ 0 ]}`, PREFIX_STYLE, RESET_STYLE, ...args.slice( 1 ) );

	} else {

		sink( `%c${prefix}`, PREFIX_STYLE, ...args );

	}

}

/**
 * Formatters, so summary lines read consistently across the engine.
 */
export const fmt = {

	/** 18016 → "18,016" */
	n: value => Number( value ).toLocaleString( 'en-US' ),

	/** 481.27 → "481 ms"; sub-10ms keeps one decimal */
	ms: value => ( value < 10 ? `${Number( value ).toFixed( 1 )} ms` : `${Math.round( value )} ms` ),

	/** bytes → "592 MB"; sub-10MB keeps one decimal */
	mb: bytes => {

		const mb = bytes / ( 1024 * 1024 );
		return mb < 10 ? `${mb.toFixed( 1 )} MB` : `${Math.round( mb )} MB`;

	},

	/** 512, 512 → "512×512" */
	px: ( width, height ) => `${width}×${height}`,

	/** 1, 'map' → "1 map"; 2, 'mesh', 'meshes' → "2 meshes" */
	count: ( value, singular, plural = `${singular}s` ) =>
		`${fmt.n( value )} ${Number( value ) === 1 ? singular : plural}`,

	/** Joins the truthy parts of a summary line, so optional segments can be inlined as `cond && text`. */
	list: parts => parts.filter( Boolean ).join( ' · ' ),

};

/**
 * Global logger controls. Also reachable as `window.rayzee.log`.
 */
export const Logger = {

	levels: LOG_LEVELS,

	/** @param {'silent'|'error'|'warn'|'info'|'debug'} name */
	setLevel( name ) {

		if ( ! ( name in LOG_LEVELS ) ) {

			console.warn( `[log] unknown level '${name}' — expected one of ${Object.keys( LOG_LEVELS ).join( ', ' )}` );
			return this.getLevel();

		}

		globalThis.__RAYZEE_LOG_LEVEL__ = name;
		activeLevel = LOG_LEVELS[ name ];
		writeStorage( STORAGE_KEY, name === DEFAULT_LEVEL ? null : name );
		return name;

	},

	getLevel() {

		const level = resolveLevel();
		return Object.keys( LOG_LEVELS ).find( k => LOG_LEVELS[ k ] === level );

	},

	/** True when a level would actually print — use to skip expensive message construction. */
	isEnabled( name ) {

		return ( LOG_LEVELS[ name ] ?? LOG_LEVELS.debug ) <= resolveLevel();

	},

	/** Restrict `debug` to the given namespaces. No arguments clears the filter. */
	only( ...namespaces ) {

		const list = namespaces.flat().filter( Boolean );
		namespaceFilter = list;
		globalThis.__RAYZEE_LOG_NS__ = list.join( ',' );
		writeStorage( NS_STORAGE_KEY, list.length ? list.join( ',' ) : null );
		if ( list.length ) this.setLevel( 'debug' );
		return list;

	},

	/** Drops the cached level so the next log re-reads globals/storage. */
	refresh() {

		activeLevel = null;
		namespaceFilter = null;
		return this.getLevel();

	},

};

/**
 * @param {string} namespace - short lowercase channel, e.g. 'bvh', 'gpu', 'scene'
 */
export function createLogger( namespace ) {

	return {

		namespace,

		error: ( ...args ) => emit( LOG_LEVELS.error, namespace, args ),
		warn: ( ...args ) => emit( LOG_LEVELS.warn, namespace, args ),
		info: ( ...args ) => emit( LOG_LEVELS.info, namespace, args ),
		debug: ( ...args ) => emit( LOG_LEVELS.debug, namespace, args ),

		isEnabled: name => Logger.isEnabled( name ),

		/**
		 * One-line `info` summary with the detail lines folded into a collapsed group,
		 * so a normal load shows a single row per phase but the breakdown is one click away.
		 * @param {string} headline
		 * @param {string[]} [details]
		 */
		summary( headline, details = [] ) {

			const lines = details.filter( Boolean );

			if ( lines.length === 0 || ! console.groupCollapsed ) {

				emit( LOG_LEVELS.info, namespace, [ headline ] );
				lines.forEach( line => emit( LOG_LEVELS.debug, namespace, [ line ] ) );
				return;

			}

			if ( LOG_LEVELS.info > resolveLevel() ) return;

			// Expanded at debug, folded otherwise.
			const open = resolveLevel() >= LOG_LEVELS.debug && console.group;
			( open ? console.group : console.groupCollapsed )(
				`%c[${namespace}]%c ${headline}`, PREFIX_STYLE, RESET_STYLE
			);
			lines.forEach( line => console.log( line ) );
			console.groupEnd();

		},

	};

}

/** Warn once per key — for per-material/per-mesh conditions that would otherwise repeat. */
const seenOnce = new Set();

export function warnOnce( logger, key, ...args ) {

	if ( seenOnce.has( key ) ) return;
	seenOnce.add( key );
	logger.warn( ...args );

}

/** Level name to hand to a worker so its `debug` lines follow the main thread. */
export function workerLogLevel() {

	return Logger.getLevel();

}

/** Applies a level inside a worker, where globals and storage are separate. */
export function applyWorkerLogLevel( name ) {

	if ( name && name in LOG_LEVELS ) {

		globalThis.__RAYZEE_LOG_LEVEL__ = name;
		activeLevel = LOG_LEVELS[ name ];

	}

}
