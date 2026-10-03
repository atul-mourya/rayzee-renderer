/**
 * What the engine needs from its host that a browser provides by itself. A browser host configures
 * nothing. A host without one (Node, Deno) supplies each service here rather than patching globals,
 * so a new browser dependency shows up as a missing service instead of a ReferenceError.
 *
 *   import { configurePlatform } from 'rayzee';
 *   import { nodePlatform } from 'rayzee/node';
 *   configurePlatform( nodePlatform( { decodeImage } ) );   // { Worker: NodeWorker, decodeImage }
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
};

/** @param {Partial<typeof platform>} overrides - only the keys given are replaced */
export function configurePlatform( overrides ) {

	if ( overrides ) Object.assign( platform, overrides );

}

export function getPlatform() {

	return platform;

}

/** Logical cores, as the browser reports them; 4 where nothing does. */
export function hardwareThreads() {

	return ( typeof navigator !== 'undefined' && navigator.hardwareConcurrency ) || 4;

}

/** Whether a worker can be started at all: the browser's or the host's. */
export function hasWorkers() {

	return !! platform.Worker || typeof Worker !== 'undefined';

}

/**
 * Starts one of the engine's bundled workers. Their bundled constructors call the global `Worker`
 * themselves, so the host's class stands in for it while one is constructed.
 * @param {new ( options?: Object ) => Worker} WorkerClass
 */
let lent = 0;

/**
 * Runs `task` with the host's Worker as the global `Worker`, for code outside the engine that starts its
 * own after awaiting — three's DRACOLoader and KTX2Loader, during a glTF parse. Lent only where there is
 * no global one (a browser keeps its own); overlapping tasks share one loan.
 * @template T
 * @param {() => Promise<T>} task
 * @returns {Promise<T>}
 */
export async function withHostWorker( task ) {

	if ( ! platform.Worker || ( lent === 0 && typeof globalThis.Worker !== 'undefined' ) ) return task();

	if ( lent ++ === 0 ) globalThis.Worker = platform.Worker;

	try {

		return await task();

	} finally {

		if ( -- lent === 0 && globalThis.Worker === platform.Worker ) delete globalThis.Worker;

	}

}

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
