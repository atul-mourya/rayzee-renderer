import { ENGINE_AREAS } from './StorageManager.js';
import { sharedStorage } from './shared.js';
import { getAssetConfig } from '../AssetConfig.js';

const DAY_MS = 86_400_000;

/**
 * `immutable`: a cached copy is always right (versioned paths). `revalidate`: use the cached copy
 * at once, then check the server in the background at most once per `maxAgeMs`. `network`: skip
 * the cache.
 */
export const DOWNLOAD_POLICY = Object.freeze( { IMMUTABLE: 'immutable', REVALIDATE: 'revalidate', NETWORK: 'network' } );

const progressEvent = ( loaded, total ) => ( { loaded, total, lengthComputable: total > 0 && loaded <= total } );

const header = ( response, name ) => response.headers?.get?.( name ) ?? null;

const abortError = ( signal ) => signal.reason ?? new DOMException( 'aborted', 'AbortError' );

export function nameFromUrl( url ) {

	try {

		const path = new URL( url, globalThis.location?.href ?? 'http://localhost/' ).pathname;
		return decodeURIComponent( path.split( '/' ).pop() ) || 'download';

	} catch {

		return 'download';

	}

}

async function readBody( response, { onProgress, signal } ) {

	const total = Number( header( response, 'content-length' ) ) || 0;
	const type = header( response, 'content-type' ) ?? '';
	if ( ! response.body ) return new Blob( [ await response.arrayBuffer() ], { type } );

	const reader = response.body.getReader();
	const chunks = [];
	let loaded = 0;
	for ( ;; ) {

		if ( signal?.aborted ) {

			reader.cancel().catch( () => {} );
			throw abortError( signal );

		}

		const { done, value } = await reader.read();
		if ( done ) break;
		chunks.push( value );
		loaded += value.length;
		onProgress?.( progressEvent( loaded, total ) );

	}

	return new Blob( chunks, { type } );

}

const asFile = ( blob, name, type ) => new File( [ blob ], name, { type: type || blob.type, lastModified: blob.lastModified ?? Date.now() } );

const noop = () => {};

/**
 * Downloads that survive reloads. Without storage (or when it is full) a download lands in
 * memory exactly as before, so callers never branch on it.
 */
export class DownloadCache {

	/** @param {?import('./StorageManager.js').StorageManager} storage */
	constructor( storage ) {

		this._storage = storage;
		this._revalidating = new Set();

	}

	get _area() {

		return this._storage?.area( ENGINE_AREAS.DOWNLOADS ) ?? null;

	}

	/**
	 * Hold `release()` until done reading the File: it keeps another tab from replacing the entry.
	 * @returns {Promise<{file: File, release: function(): void, fromCache: boolean}>}
	 */
	async fetch( url, {
		key = url,
		name = nameFromUrl( url ),
		policy = DOWNLOAD_POLICY.REVALIDATE,
		maxAgeMs = DAY_MS,
		onProgress = null,
		signal = null,
		fetchOptions = {},
	} = {} ) {

		const area = this._area;

		if ( area && policy !== DOWNLOAD_POLICY.NETWORK ) {

			const entry = await area.open( key );
			if ( entry ) {

				const blob = await entry.file( 'data' );
				if ( blob ) {

					if ( policy === DOWNLOAD_POLICY.REVALIDATE && Date.now() - ( entry.extra.checkedAt ?? 0 ) >= maxAgeMs ) {

						this._revalidate( url, key, name, entry.extra, fetchOptions );

					}

					onProgress?.( progressEvent( blob.size, blob.size ) );
					return { file: asFile( blob, name, entry.extra.contentType ), release: () => entry.release(), fromCache: true };

				}

				entry.release();

			}

		}

		return this._download( url, key, name, { onProgress, signal, fetchOptions, cache: !! area } );

	}

	/** Whether a copy is stored, without opening it for reading. */
	async has( key ) {

		return ( await this._area?.has( key ) ) === true;

	}

	async _download( url, key, name, { onProgress, signal, fetchOptions, cache } ) {

		if ( signal?.aborted ) throw abortError( signal );
		const response = await fetch( url, { ...fetchOptions, signal } );
		if ( ! response.ok ) throw new Error( `HTTP ${response.status} fetching ${url}` );

		const total = Number( header( response, 'content-length' ) ) || 0;
		const info = {
			url,
			contentType: header( response, 'content-type' ) ?? '',
			lastModified: header( response, 'last-modified' ),
			contentLength: total || null,
			checkedAt: Date.now(),
		};

		const writer = cache && response.body ? await this._area.create( key, { label: name, expectedBytes: total } ) : null;
		if ( ! writer ) {

			return { file: asFile( await readBody( response, { onProgress, signal } ), name, info.contentType ), release: noop, fromCache: false };

		}

		try {

			await writer.writeStream( 'data', response.body, { signal, onProgress: ( loaded ) => onProgress?.( progressEvent( loaded, total ) ) } );
			await writer.commit( info );

		} catch ( error ) {

			await writer.abort();
			if ( error?.name !== 'QuotaExceededError' ) throw error;
			return this._download( url, key, name, { onProgress, signal, fetchOptions, cache: false } );

		}

		const entry = await this._area.open( key, { wait: true } );
		const blob = entry && await entry.file( 'data' );
		if ( ! blob ) {

			entry?.release();
			throw new Error( `storage: ${name} vanished right after it was saved` );

		}

		return { file: asFile( blob, name, info.contentType ), release: () => entry.release(), fromCache: false };

	}

	async _revalidate( url, key, name, extra, fetchOptions ) {

		if ( this._revalidating.has( key ) ) return;
		this._revalidating.add( key );

		let changed = false;

		try {

			// One byte, not HEAD: a CORS rule that allows GET — the engine's own asset host — refuses
			// HEAD, and a single-range Range header needs no preflight.
			const headers = new Headers( fetchOptions?.headers );
			headers.set( 'Range', 'bytes=0-0' );
			const probe = await fetch( url, { ...fetchOptions, headers } );
			probe.body?.cancel().catch( () => {} );

			if ( probe.ok ) {

				const lastModified = header( probe, 'last-modified' );
				// A 206 carries the size in Content-Range, unreadable cross-origin unless exposed; a server
				// that ignores Range answers 200 with the whole length.
				const length = probe.status === 206
					? Number( header( probe, 'content-range' )?.match( /\/(\d+)$/ )?.[ 1 ] ) || null
					: Number( header( probe, 'content-length' ) ) || null;
				changed = !! ( ( lastModified && extra.lastModified && lastModified !== extra.lastModified )
					|| ( length && extra.contentLength && length !== extra.contentLength ) );

			}

		} catch {

			// Offline, or the server refuses the probe: keep serving the stored copy.

		}

		try {

			if ( changed ) {

				const { release } = await this._download( url, key, name, { fetchOptions, cache: true } );
				release();

			} else {

				// Stamped when the check failed too, or a refusing server is asked again on every load.
				await this._area.patchMeta( key, { extra: { ...extra, checkedAt: Date.now() } } );

			}

		} catch {

			// The stored copy stays.

		} finally {

			this._revalidating.delete( key );

		}

	}

}

/** One-off download into memory or storage, for code that holds no DownloadCache. */
export function fetchFile( url, storage, options ) {

	return new DownloadCache( storage ).fetch( url, options );

}

/** Downloads through whatever storage this page's apps opened; plain fetches when none. */
export function sharedDownloads() {

	return new DownloadCache( sharedStorage( getAssetConfig().cacheNamespace ) );

}

/**
 * A URL a three.js loader can take in place of `url`: an object URL of the stored copy when there
 * is storage, the network URL untouched otherwise (so the loader's own progress still works).
 * Call `release()` once the loader has read it.
 * @returns {Promise<{url: string, release: function(): void, cached: boolean}>}
 */
export async function cachedObjectURL( url, { downloads = sharedDownloads(), ...options } = {} ) {

	if ( ! downloads._storage || ! /^https?:/i.test( url ) ) return { url, release: noop, cached: false };

	const { file, release } = await downloads.fetch( url, options );
	const objectUrl = URL.createObjectURL( file );
	return {
		url: objectUrl,
		cached: true,
		release: () => {

			URL.revokeObjectURL( objectUrl );
			release();

		},
	};

}
