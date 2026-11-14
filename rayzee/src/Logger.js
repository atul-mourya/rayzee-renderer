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
 * A host takes the lines instead of the console with `Logger.setSink( fn )` (main thread; workers print to their own).
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
let sink = null;
let inSink = false;
let sinkFailed = false;
const LEVEL_NAMES = Object.keys( LOG_LEVELS );

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

const isPlain = value => Array.isArray( value ) || Object.getPrototypeOf( value ) === Object.prototype || Object.getPrototypeOf( value ) === null;
const className = value => {

	const name = value.constructor?.name ?? 'Object';
	return ArrayBuffer.isView( value ) ? `[${name} ${value.length ?? value.byteLength}]`
		: typeof value.name === 'string' && value.name ? `[${name} ${value.name}]` : `[${name}]`;

};

// Plain data copied for JSON, anything else (at any depth) by its class: JSON.stringify calls a nested object's toJSON
// before any replacer runs, and a mesh's toJSON is a whole scene.
function plainCopy( value, seen ) {

	if ( value === null || typeof value !== 'object' ) return typeof value === 'bigint' ? String( value ) : value;
	if ( ! isPlain( value ) ) return className( value );
	if ( seen.has( value ) ) return '[circular]';
	seen.add( value );
	const out = Array.isArray( value ) ? value.map( v => plainCopy( v, seen ) )
		: Object.fromEntries( Object.entries( value ).map( ( [ k, v ] ) => [ k, plainCopy( v, seen ) ] ) );
	seen.delete( value );
	return out;

}

// One argument as text: an error as `name: message` with the stack beneath (Firefox's and Safari's stacks leave the
// message out; a GPUError is no Error but has one), plain data as JSON, anything else by its class.
function argText( value ) {

	if ( value === null || typeof value !== 'object' ) return String( value );
	if ( typeof value.message === 'string' && ( value instanceof Error || ! isPlain( value ) ) ) {

		const head = `${value.name || value.constructor?.name || 'Error'}: ${value.message}`;
		const stack = typeof value.stack === 'string' ? value.stack : '';
		return stack.startsWith( head ) ? stack : stack ? `${head}\n${stack}` : head;

	}

	return isPlain( value ) ? JSON.stringify( plainCopy( value, new Set() ) ) : className( value );

}

function emit( level, ns, args ) {

	if ( level > resolveLevel() || ! namespaceAllowed( ns, level ) ) return;

	// A line logged from inside the sink goes to the console: handed back, it would never end.
	if ( sink && ! inSink ) {

		inSink = true;
		try {

			sink( { level: LEVEL_NAMES[ level ], namespace: ns, message: args.map( argText ).join( ' ' ), args } );
			return;

		} catch ( error ) {

			if ( ! sinkFailed ) console.error( '[log] the host\'s sink threw; printing its lines here', error );
			sinkFailed = true;

		} finally {

			inSink = false;

		}

	}

	const out = level === LOG_LEVELS.error ? console.error
		: level === LOG_LEVELS.warn ? console.warn
			: console.log;

	const prefix = `[${ns}]`;

	// Style only the prefix, and only when the first argument is a string we can splice into.
	if ( typeof args[ 0 ] === 'string' ) {

		out( `%c${prefix}%c ${args[ 0 ]}`, PREFIX_STYLE, RESET_STYLE, ...args.slice( 1 ) );

	} else {

		out( `%c${prefix}`, PREFIX_STYLE, ...args );

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

	/**
	 * Hands every line that passes the level and namespace filters to `fn` instead of the console: `{ level, namespace,
	 * message, args }`, `level` one of 'error' | 'warn' | 'info' | 'debug', `message` the arguments as one string.
	 * `null` gives the console back. Main thread only: a worker prints to its own console. A sink that throws has the
	 * line printed instead (the error once); a line the sink itself logs goes to the console.
	 * @param {?function({level: string, namespace: string, message: string, args: Array}): void} fn
	 */
	setSink( fn ) {

		if ( fn !== null && typeof fn !== 'function' ) throw new TypeError( 'Logger.setSink: a function or null' );
		sink = fn;
		sinkFailed = false;

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

			if ( lines.length === 0 || ! console.groupCollapsed || sink ) {

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

/** Runs `fn` with console.warn dropping lines that contain `text`: a library's warning about something expected. */
export function withoutWarning( text, fn ) {

	const warn = console.warn;
	console.warn = ( first, ...rest ) => {

		if ( ! String( first ).includes( text ) ) warn( first, ...rest );

	};

	try {

		return fn();

	} finally {

		console.warn = warn;

	}

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
