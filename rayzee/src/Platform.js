/**
 * What the engine needs from its host that a browser provides by itself. A browser host configures
 * nothing. A host without one (Node, Deno) supplies each service here rather than patching globals,
 * so a new browser dependency shows up as a missing service instead of a ReferenceError.
 *
 *   import { configurePlatform } from 'rayzee';
 *   import { nodePlatform } from 'rayzee/node';
 *   configurePlatform( nodePlatform( { decodeImage } ) );   // { Worker: NodeWorker, decodeImage, readFile, DOMParser }
 *
 * Call before constructing PathTracerApp.
 */

const platform = {
	/** A class with the Web Worker API. The engine's bundled workers start through it. */
	Worker: null,
	/**
	 * `( bytes: Uint8Array, mimeType: string ) => Promise<{ data: Uint8Array | Uint8ClampedArray, width, height }>`:
	 * an image a model carries (PNG, JPEG, WebP) to RGBA8 pixels, top row first. Where set, it decodes
	 * every glTF image in place of the browser.
	 */
	decodeImage: null,
	/** `( url: URL ) => Promise<Uint8Array>`: the bytes of a `file:` URL, which Node's `fetch` cannot open. */
	readFile: null,
	/**
	 * A class with the DOMParser API for XML, `new DOMParser().parseFromString( text, 'application/xml' )`: three.js's
	 * Collada and 3MF loaders call it themselves. A browser has its own; `nodePlatform()` gives one.
	 */
	DOMParser: null,
	/**
	 * Threads each of the engine's worker pools may use (pbrt's `--nthreads`), for hosts running several renders on one
	 * machine: a whole number from 1, or null for every core. Pools that run at once (a load builds BVHs and packs
	 * textures together) each take this many. Set before constructing the app: some pools are sized then.
	 */
	threads: null,
};

/** @param {Partial<typeof platform>} overrides - only the keys given are replaced */
export function configurePlatform( overrides ) {

	if ( ! overrides ) return;
	const { threads } = overrides;
	if ( threads != null && ! ( Number.isInteger( threads ) && threads >= 1 ) ) {

		throw new TypeError( `configurePlatform: threads is a whole number from 1, or null for every core (got ${String( threads )})` );

	}

	Object.assign( platform, overrides );

}

export function getPlatform() {

	return platform;

}

/** The host's `threads` when set, else logical cores as the browser reports them; 4 where nothing does. */
export function hardwareThreads() {

	return platform.threads ?? ( ( typeof navigator !== 'undefined' && navigator.hardwareConcurrency ) || 4 );

}

/** Whether images can be decoded: by the host's `decodeImage`, or the browser's own (a canvas or `createImageBitmap`). */
export function hasImageDecoder() {

	return !! platform.decodeImage
		|| ( typeof self !== 'undefined' && ( typeof createImageBitmap !== 'undefined' || typeof document !== 'undefined' ) );

}

/** Whether a worker can be started at all: the browser's or the host's. */
export function hasWorkers() {

	return !! platform.Worker || typeof Worker !== 'undefined';

}

// Globals lent to three's loaders where the runtime has none: name → { value, holders }.
const loans = new Map();

/**
 * Runs `task` with each of `globals` set as a global where the runtime has none, for as long as any task holding it runs.
 * @template T
 * @param {Object<string, *>} globals
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function withHostGlobals( globals, task ) {

	const taken = Object.entries( globals ).filter( ( [ name, value ] ) => value && ( loans.has( name ) || globalThis[ name ] === undefined ) ).map( ( [ name ] ) => name );
	for ( const name of taken ) {

		if ( ! loans.has( name ) ) loans.set( name, { value: globalThis[ name ] = globals[ name ], holders: 0 } );
		loans.get( name ).holders ++;

	}

	try {

		return await task();

	} finally {

		for ( const name of taken ) {

			const loan = loans.get( name );
			if ( -- loan.holders > 0 ) continue;
			loans.delete( name );
			if ( globalThis[ name ] === loan.value ) delete globalThis[ name ];

		}

	}

}

/**
 * Runs `task` (a parse whose loaders start workers themselves: three's DRACOLoader and KTX2Loader) with the host's
 * `Worker` as the global one where there is none.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export function withHostWorker( task ) {

	return withHostGlobals( { Worker: platform.Worker }, task );

}

/**
 * Starts one of the engine's bundled workers. Their bundled constructors call the global `Worker`
 * themselves, so the host's class stands in for it while one is constructed.
 * @param {new ( options?: Object ) => Worker} WorkerClass
 */
export function createWorker( WorkerClass, options ) {

	const Host = platform.Worker;
	if ( ! Host ) return new WorkerClass( options );

	const had = Object.prototype.hasOwnProperty.call( globalThis, 'Worker' );
	const previous = globalThis.Worker;
	globalThis.Worker = Host;

	try {

		return new WorkerClass( options );

	} finally {

		if ( had ) globalThis.Worker = previous;
		else delete globalThis.Worker;

	}

}

// A message: unlike a timer it is not throttled in a background tab, and unlike scheduler.yield it queues behind the
// page's own timers and posted renders instead of running ahead of them.
export function nextTask() {

	if ( typeof MessageChannel === 'undefined' ) return new Promise( resolve => setTimeout( resolve, 0 ) );
	return new Promise( resolve => {

		const { port1, port2 } = new MessageChannel();
		port1.onmessage = () => {

			port1.close();
			resolve();

		};

		port2.postMessage( null );

	} );

}

/**
 * For a long loop on the main thread: the returned function gives the page one task turn, to redraw, once `ms` have
 * passed since the last, and returns null in between.
 */
export function timeSlicer( ms = 30 ) {

	let since = performance.now();
	const resume = () => {

		since = performance.now();

	};

	return () => ( performance.now() - since < ms ? null : nextTask().then( resume ) );

}
