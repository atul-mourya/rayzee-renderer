import { ISSUE_CODES } from '../EngineIssues.js';
import { acquireLock, heldLockNames } from './locks.js';
import { entryIdFor } from './identity.js';
import { Emitter } from './events.js';
import { InlineTransport } from './inlineTransport.js';

export const STORAGE_KIND = Object.freeze( { CACHE: 'cache', USER: 'user', SCRATCH: 'scratch' } );

/** Areas the engine itself writes; hosts define their own with `defineArea`. */
export const ENGINE_AREAS = Object.freeze( { DOWNLOADS: 'downloads', ARCHIVES: 'archives', SCENES: 'scenes', CDF: 'cdf', SPILL: 'spill' } );

const META = 'meta.json';
const META_VERSION = 1;
const TOUCH_INTERVAL_MS = 3_600_000;
const BUDGET_FRACTION = 0.3;
const MAX_DEFAULT_BUDGET = 100 * 1024 ** 3;
const FREE_MARGIN = 64 * 1024 ** 2;
const STREAM_BATCH = 8 * 1024 ** 2;
const STREAM_WINDOW = 4;

const encoder = new TextEncoder();

function transferable( data, { copy, transfer } ) {

	if ( typeof data === 'string' ) data = encoder.encode( data );

	if ( data instanceof ArrayBuffer ) {

		if ( ! copy || transfer ) return { args: { buffer: data }, list: [ data ] };
		const clone = data.slice( 0 );
		return { args: { buffer: clone }, list: [ clone ] };

	}

	if ( ! ArrayBuffer.isView( data ) ) throw new TypeError( 'storage: write expects an ArrayBuffer, a typed array, a Blob or a string' );

	const { buffer, byteOffset, byteLength } = data;
	const shared = typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;

	if ( ! copy ) return { args: { buffer, byteOffset, byteLength }, list: [] };

	// A shared buffer handed over as is lives until the storage worker next collects garbage,
	// which a worker allocating almost nothing may not do for the rest of a load: 2.5 GB of spilled
	// 64 MB chunks stayed in memory after they were on disk. A copy is transferred and goes with it.
	if ( shared ) {

		const clone = new Uint8Array( byteLength );
		clone.set( new Uint8Array( buffer, byteOffset, byteLength ) );
		return { args: { buffer: clone.buffer }, list: [ clone.buffer ] };

	}

	if ( transfer && byteOffset === 0 && byteLength === buffer.byteLength ) return { args: { buffer }, list: [ buffer ] };

	const clone = buffer.slice( byteOffset, byteOffset + byteLength );
	return { args: { buffer: clone }, list: [ clone ] };

}

async function readJSONFile( dir, name ) {

	try {

		const file = await ( await dir.getFileHandle( name ) ).getFile();
		return JSON.parse( await file.text() );

	} catch {

		return null;

	}

}

async function* childDirs( dir ) {

	for await ( const [ name, handle ] of dir.entries() ) {

		if ( handle.kind === 'directory' ) yield [ name, handle ];

	}

}

export class StorageEntry {

	constructor( area, id, meta, dir, release ) {

		this.area = area;
		this.id = id;
		this.key = meta.key;
		this.meta = meta;
		this._dir = dir;
		this._release = release;

	}

	get bytes() {

		return this.meta.bytes;

	}

	get extra() {

		return this.meta.extra ?? {};

	}

	/** @returns {Promise<?File>} */
	async file( name ) {

		try {

			return await ( await this._dir.getFileHandle( name ) ).getFile();

		} catch ( error ) {

			this.area.manager._issue( ISSUE_CODES.STORAGE_READ_FAILED, `could not read ${this.area.name}/${this.id}/${name}`, { error: error.message } );
			return null;

		}

	}

	async json( name ) {

		const file = await this.file( name );
		return file ? JSON.parse( await file.text() ) : null;

	}

	release() {

		this._release?.();
		this._release = null;

	}

}

export class EntryWriter {

	constructor( area, id, key, info, release, { sizes = {}, append = false } = {} ) {

		this.area = area;
		this.id = id;
		this.key = key;
		this._info = info;
		this._release = release;
		this._writers = new Map();
		this._sizes = { ...sizes };
		this._append = append;
		this._done = false;

	}

	get _transport() {

		return this.area.manager._transport;

	}

	get _path() {

		return [ this.area.name, this.id ];

	}

	async _writer( name ) {

		let writer = this._writers.get( name );
		if ( ! writer ) {

			const keep = this._append && name in this._sizes;
			const resumeAt = keep && ( this._info.growable ?? [] ).includes( name ) ? this._sizes[ name ] : undefined;
			writer = this._transport.call( 'openWriter', { path: this._path, name, truncate: ! keep, length: resumeAt } );
			this._writers.set( name, writer );

		}

		return ( await writer ).id;

	}

	/**
	 * Appends to (or, with `at`, writes into) a file of this entry. `transfer: true` hands the
	 * caller's buffer to the storage worker instead of copying it.
	 */
	async write( name, data, { at, transfer = false } = {} ) {

		this._assertOpen();
		const isBlob = typeof Blob !== 'undefined' && data instanceof Blob;
		// Copied before any await: callers (muxers, stream readers) reuse their buffers.
		const prepared = isBlob ? null : transferable( data, { copy: true, transfer } );
		const { args, list } = prepared ?? transferable( await data.arrayBuffer(), { copy: true, transfer: true } );

		const id = await this._writer( name );
		return this._transport.call( 'write', { id, at, ...args }, list );

	}

	async writeFile( name, data ) {

		this._assertOpen();
		if ( typeof Blob !== 'undefined' && data instanceof Blob ) data = await data.arrayBuffer();
		const { args, list } = transferable( data, { copy: true, transfer: true } );
		const { size } = await this._transport.call( 'writeFile', { path: this._path, name, ...args }, list );
		this._sizes[ name ] = size;
		return size;

	}

	writeJSON( name, value ) {

		return this.writeFile( name, JSON.stringify( value ) );

	}

	/**
	 * Pipes a ReadableStream of bytes into a file, batching small chunks so the worker sees
	 * few, large writes.
	 * @returns {Promise<number>} bytes written
	 */
	async writeStream( name, stream, { onProgress = null, signal = null, batchBytes = STREAM_BATCH } = {} ) {

		const reader = stream.getReader();
		const inFlight = [];
		let staging = new Uint8Array( batchBytes );
		let filled = 0;
		let total = 0;

		const flush = async () => {

			if ( filled === 0 ) return;
			const out = filled === batchBytes ? staging : staging.slice( 0, filled );
			staging = new Uint8Array( batchBytes );
			filled = 0;
			inFlight.push( this.write( name, out, { transfer: true } ) );
			if ( inFlight.length >= STREAM_WINDOW ) await inFlight.shift();

		};

		try {

			for ( ;; ) {

				if ( signal?.aborted ) throw signal.reason ?? new DOMException( 'aborted', 'AbortError' );
				const { done, value } = await reader.read();
				if ( done ) break;

				let offset = 0;
				while ( offset < value.length ) {

					const n = Math.min( value.length - offset, batchBytes - filled );
					staging.set( value.subarray( offset, offset + n ), filled );
					filled += n;
					offset += n;
					total += n;
					if ( filled === batchBytes ) await flush();

				}

				onProgress?.( total );

			}

			await flush();
			await Promise.all( inFlight );
			return total;

		} catch ( error ) {

			reader.cancel().catch( () => {} );
			await Promise.allSettled( inFlight );
			throw error;

		}

	}

	async commit( extra = {} ) {

		this._assertOpen();
		this._done = true;

		try {

			for ( const [ name, writer ] of this._writers ) {

				const { size } = await this._transport.call( 'closeWriter', { id: ( await writer ).id } );
				this._sizes[ name ] = size;

			}

			this._writers.clear();

			const now = Date.now();
			const meta = {
				v: META_VERSION,
				key: this.key,
				label: this._info.label ?? '',
				kind: this.area.kind,
				files: { ...this._sizes },
				bytes: Object.values( this._sizes ).reduce( ( n, b ) => n + b, 0 ),
				createdAt: this._info.createdAt ?? now,
				lastUsed: now,
				pinned: this._info.pinned === true,
				extra: { ...this._info.extra, ...extra },
			};
			const growable = this._info.growable ?? [];
			if ( growable.length ) meta.growable = growable;

			const { args, list } = transferable( JSON.stringify( meta ), { copy: false } );
			await this._transport.call( 'writeFile', { path: this._path, name: META, ...args }, list );
			this.area.manager._changed( this.area.name );
			return meta;

		} catch ( error ) {

			await this._discard();
			this.area.manager._writeFailed( this.area.name, error );
			throw error;

		} finally {

			this._release?.();
			this._release = null;

		}

	}

	async abort() {

		if ( this._done ) return;
		this._done = true;
		try {

			if ( this._append ) await this._closeAll( true );
			else await this._discard();

		} finally {

			this._release?.();
			this._release = null;

		}

	}

	async _closeAll( abort ) {

		for ( const writer of this._writers.values() ) {

			try {

				await this._transport.call( 'closeWriter', { id: ( await writer ).id, abort } );

			} catch { /* already closed */ }

		}

		this._writers.clear();

	}

	async _discard() {

		await this._closeAll( true );
		await this.area._removeDir( this.id );

	}

	_assertOpen() {

		if ( this._done ) throw new Error( `storage: entry ${this.area.name}/${this.id} is already committed or aborted` );

	}

}

export class StorageArea {

	constructor( manager, name, kind ) {

		this.manager = manager;
		this.name = name;
		this.kind = kind;

	}

	_lockName( id ) {

		return `${this.manager.namespace}:store:${this.name}:${id}`;

	}

	async _dir( create = false ) {

		try {

			return await this.manager._root.getDirectoryHandle( this.name, { create } );

		} catch ( error ) {

			if ( error.name === 'NotFoundError' ) return null;
			throw error;

		}

	}

	async _entryDir( id, create = false ) {

		const dir = await this._dir( create );
		if ( ! dir ) return null;
		try {

			return await dir.getDirectoryHandle( id, { create } );

		} catch ( error ) {

			if ( error.name === 'NotFoundError' ) return null;
			throw error;

		}

	}

	async _removeDir( id ) {

		const dir = await this._dir( false );
		if ( ! dir ) return;
		try {

			await dir.removeEntry( id, { recursive: true } );

		} catch ( error ) {

			if ( error.name !== 'NotFoundError' ) throw error;

		}

	}

	async _validMeta( dir, key = null ) {

		const meta = await readJSONFile( dir, META );
		if ( ! meta || meta.v !== META_VERSION || typeof meta.key !== 'string' ) return null;
		if ( key !== null && meta.key !== key ) return null;

		const growable = meta.growable ?? [];
		for ( const [ name, size ] of Object.entries( meta.files ?? {} ) ) {

			try {

				const file = await ( await dir.getFileHandle( name ) ).getFile();
				if ( file.size !== size && ! ( growable.includes( name ) && file.size > size ) ) return null;

			} catch {

				return null;

			}

		}

		return meta;

	}

	/**
	 * Holds a shared lock until `entry.release()`, so no tab can replace or evict the entry
	 * while its files are being read. An entry being written is a miss unless `wait`.
	 * @returns {Promise<?StorageEntry>}
	 */
	async open( key, { wait = false } = {} ) {

		const id = await entryIdFor( key );
		const release = await acquireLock( this._lockName( id ), { mode: 'shared', ifAvailable: ! wait } );
		if ( ! release ) return null;

		try {

			const dir = await this._entryDir( id );
			const meta = dir ? await this._validMeta( dir, key ) : null;
			if ( ! meta ) {

				release();
				return null;

			}

			if ( Date.now() - meta.lastUsed > TOUCH_INTERVAL_MS ) this._touch( id, meta );
			return new StorageEntry( this, id, meta, dir, release );

		} catch ( error ) {

			release();
			this.manager._issue( ISSUE_CODES.STORAGE_READ_FAILED, `could not open ${this.name} entry`, { error: error.message } );
			return null;

		}

	}

	async has( key ) {

		const entry = await this.open( key );
		entry?.release();
		return !! entry;

	}

	_touch( id, meta ) {

		const next = { ...meta, lastUsed: Date.now() };
		const { args, list } = transferable( JSON.stringify( next ), { copy: false } );
		this.manager._transport.call( 'writeFile', { path: [ this.name, id ], name: META, ...args }, list ).catch( () => {} );
		meta.lastUsed = next.lastUsed;

	}

	/**
	 * Starts writing an entry, replacing any existing one under the same key once this commits.
	 * Resolves null when `expectedBytes` cannot be made to fit.
	 * @returns {Promise<?EntryWriter>}
	 */
	async create( key, { label = '', pinned = false, expectedBytes = 0, extra = {}, growable = [] } = {} ) {

		const id = await entryIdFor( key );
		const release = await acquireLock( this._lockName( id ), { mode: 'exclusive' } );

		try {

			if ( expectedBytes > 0 && ! await this.manager.ensureSpace( expectedBytes, this.kind ) ) {

				release();
				this.manager._issue( ISSUE_CODES.STORAGE_QUOTA_EXCEEDED, `no room for ${( expectedBytes / 1048576 ).toFixed( 0 )} MB in ${this.name}`, { area: this.name, expectedBytes } );
				return null;

			}

			await this._removeDir( id );
			await this._entryDir( id, true );
			return new EntryWriter( this, id, key, { label, pinned, extra, growable }, release );

		} catch ( error ) {

			release();
			this.manager._writeFailed( this.name, error );
			return null;

		}

	}

	/** Merges into a committed entry's metadata. Resolves false when there is no such entry. */
	async patchMeta( key, patch ) {

		const id = await entryIdFor( key );
		const release = await acquireLock( this._lockName( id ), { mode: 'shared', ifAvailable: true } );
		if ( ! release ) return false;

		try {

			const dir = await this._entryDir( id );
			const meta = dir ? await this._validMeta( dir, key ) : null;
			if ( ! meta ) return false;

			const { args, list } = transferable( JSON.stringify( { ...meta, ...patch, v: META_VERSION, key } ), { copy: false } );
			await this.manager._transport.call( 'writeFile', { path: [ this.name, id ], name: META, ...args }, list );
			return true;

		} finally {

			release();

		}

	}

	/**
	 * Reopens a committed entry for writing: `writeFile` replaces a file, `write` appends to it, and
	 * files left alone are kept. Resolves null when there is no such entry. Aborting keeps the entry
	 * as it was committed, minus any bytes already appended.
	 * @returns {Promise<?EntryWriter>}
	 */
	async edit( key ) {

		const id = await entryIdFor( key );
		const release = await acquireLock( this._lockName( id ), { mode: 'exclusive' } );

		try {

			const dir = await this._entryDir( id );
			const meta = dir ? await this._validMeta( dir, key ) : null;
			if ( ! meta ) {

				release();
				return null;

			}

			const info = { label: meta.label, pinned: meta.pinned, extra: meta.extra, createdAt: meta.createdAt, growable: meta.growable };
			return new EntryWriter( this, id, key, info, release, { sizes: meta.files, append: true } );

		} catch ( error ) {

			release();
			this.manager._writeFailed( this.name, error );
			return null;

		}

	}

	/** @returns {Promise<boolean>} false while another tab holds the entry */
	async remove( key ) {

		return this.removeById( await entryIdFor( key ) );

	}

	async removeById( id ) {

		const release = await acquireLock( this._lockName( id ), { mode: 'exclusive', ifAvailable: true } );
		if ( ! release ) return false;

		try {

			await this._removeDir( id );
			this.manager._changed( this.name );
			return true;

		} finally {

			release();

		}

	}

	/** @returns {Promise<Array<Object>>} committed entries' metadata, each with its `id` */
	async list() {

		const dir = await this._dir( false );
		if ( ! dir ) return [];

		const out = [];
		for await ( const [ id, entryDir ] of childDirs( dir ) ) {

			const meta = await readJSONFile( entryDir, META );
			if ( meta?.v === META_VERSION ) out.push( { ...meta, id } );

		}

		return out;

	}

	async clear() {

		let removed = 0;
		for ( const { id } of await this.list() ) if ( await this.removeById( id ) ) removed ++;
		return removed;

	}

	/** Deletes entries that never committed and are not being written. */
	async sweep() {

		const dir = await this._dir( false );
		if ( ! dir ) return 0;

		const held = await heldLockNames();
		let removed = 0;
		for await ( const [ id, entryDir ] of childDirs( dir ) ) {

			if ( held.has( this._lockName( id ) ) ) continue;
			if ( await this._validMeta( entryDir ) ) continue;
			if ( await this.removeById( id ) ) removed ++;

		}

		return removed;

	}

}

export class StorageManager extends Emitter {

	constructor( { root, transport, namespace } ) {

		super();
		this.namespace = namespace;
		this._root = root;
		this._transport = transport;
		this._areas = new Map();
		this._budget = null;

		for ( const name of Object.values( ENGINE_AREAS ) ) this.defineArea( name, { kind: name === ENGINE_AREAS.SPILL ? STORAGE_KIND.SCRATCH : STORAGE_KIND.CACHE } );

	}

	defineArea( name, { kind = STORAGE_KIND.CACHE } = {} ) {

		const existing = this._areas.get( name );
		if ( existing ) {

			if ( existing.kind !== kind ) throw new Error( `storage: area "${name}" is already defined as ${existing.kind}` );
			return existing;

		}

		const area = new StorageArea( this, name, kind );
		this._areas.set( name, area );
		return area;

	}

	area( name ) {

		const area = this._areas.get( name );
		if ( ! area ) throw new Error( `storage: unknown area "${name}"` );
		return area;

	}

	get areaNames() {

		return [ ...this._areas.keys() ];

	}

	async estimate() {

		const storage = typeof navigator !== 'undefined' ? navigator.storage : null;
		if ( ! storage?.estimate ) return { quota: Infinity, usage: 0 };
		const { quota = Infinity, usage = 0 } = await storage.estimate();
		return { quota, usage };

	}

	async persisted() {

		return ( await globalThis.navigator?.storage?.persisted?.() ) === true;

	}

	/** Asks the browser to exempt this site's data from eviction. Firefox shows a prompt. */
	async persist() {

		const granted = ( await globalThis.navigator?.storage?.persist?.() ) === true;
		this._changed( null );
		return granted;

	}

	async budget() {

		if ( this._budget !== null ) return this._budget;
		const { quota } = await this.estimate();
		return Math.min( quota * BUDGET_FRACTION, MAX_DEFAULT_BUDGET );

	}

	/** Caps what cache areas may hold together; null restores the default. */
	setBudget( bytes ) {

		this._budget = bytes === null ? null : Math.max( 0, bytes );
		this._changed( null );

	}

	async _cacheEntries() {

		const out = [];
		for ( const area of this._areas.values() ) {

			if ( area.kind !== STORAGE_KIND.CACHE ) continue;
			for ( const meta of await area.list() ) out.push( { area, meta } );

		}

		return out;

	}

	async usage() {

		const { quota, usage } = await this.estimate();
		const areas = {};
		let cacheBytes = 0;
		for ( const area of this._areas.values() ) {

			const entries = await area.list();
			const bytes = entries.reduce( ( n, m ) => n + ( m.bytes ?? 0 ), 0 );
			areas[ area.name ] = { kind: area.kind, bytes, entries: entries.length };
			if ( area.kind === STORAGE_KIND.CACHE ) cacheBytes += bytes;

		}

		return { quota, usage, persisted: await this.persisted(), budget: await this.budget(), cacheBytes, areas };

	}

	/**
	 * Evicts least-recently-used cache entries (never pinned, never in use) until `freeBytes`
	 * are released, or, without it, until caches fit the budget.
	 * @returns {Promise<number>} bytes released
	 */
	async collect( { freeBytes = null } = {} ) {

		const entries = await this._cacheEntries();
		const budget = await this.budget();
		let cacheBytes = entries.reduce( ( n, e ) => n + ( e.meta.bytes ?? 0 ), 0 );
		const target = freeBytes ?? Math.max( 0, cacheBytes - budget );
		if ( target <= 0 ) return 0;

		const held = await heldLockNames();
		const candidates = entries
			.filter( ( { area, meta } ) => ! meta.pinned && ! held.has( area._lockName( meta.id ) ) )
			.sort( ( a, b ) => a.meta.lastUsed - b.meta.lastUsed );

		let freed = 0;
		for ( const { area, meta } of candidates ) {

			if ( freed >= target ) break;
			if ( await area.removeById( meta.id ) ) {

				freed += meta.bytes ?? 0;
				cacheBytes -= meta.bytes ?? 0;

			}

		}

		return freed;

	}

	/**
	 * Makes room for a write of `bytes`, evicting least-recently-used caches as needed. The budget
	 * caps what caches pile up to, not one write: an entry larger than it is still allowed when the
	 * disk has room, and the rest are evicted to make way.
	 */
	async ensureSpace( bytes, kind = STORAGE_KIND.CACHE ) {

		const shortfall = async () => {

			const { quota, usage } = await this.estimate();
			const free = bytes + FREE_MARGIN - ( quota - usage );
			if ( kind !== STORAGE_KIND.CACHE ) return { free, budget: 0 };

			const cacheBytes = ( await this._cacheEntries() ).reduce( ( n, e ) => n + ( e.meta.bytes ?? 0 ), 0 );
			return { free, budget: cacheBytes + bytes - await this.budget() };

		};

		const before = await shortfall();
		if ( before.free <= 0 && before.budget <= 0 ) return true;

		await this.collect( { freeBytes: Math.max( before.free, before.budget ) } );
		return ( await shortfall() ).free <= 0;

	}

	/**
	 * Removes half-written entries left by a crash, and scratch no open page holds. Runs in the
	 * background after opening.
	 */
	async sweep() {

		let removed = 0;
		for ( const area of this._areas.values() ) {

			removed += await area.sweep();
			if ( area.kind === STORAGE_KIND.SCRATCH ) removed += await area.clear();

		}

		return removed;

	}

	_changed( area ) {

		this.dispatchEvent( { type: 'change', area } );

	}

	_issue( code, message, detail = {} ) {

		this.dispatchEvent( { type: 'issue', code, message, detail } );

	}

	_writeFailed( area, error ) {

		const quota = error?.name === 'QuotaExceededError';
		this._issue(
			quota ? ISSUE_CODES.STORAGE_QUOTA_EXCEEDED : ISSUE_CODES.STORAGE_WRITE_FAILED,
			`${area}: ${error?.message ?? error}`,
			{ area, error: error?.name }
		);

	}

	dispose() {

		this._transport?.dispose();
		this._transport = null;
		this._areas.clear();

	}

}

/**
 * Storage over a directory this thread writes itself (a worker's own, or a test's fake root).
 * @returns {StorageManager}
 */
export function openInlineStorage( { namespace, root } ) {

	const transport = new InlineTransport( root );
	transport.inline = true;
	const storage = new StorageManager( { root, transport, namespace } );
	storage.sweep().catch( () => {} );
	return storage;

}
