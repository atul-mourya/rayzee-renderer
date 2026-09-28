/**
 * In-memory stand-in for the origin private file system: directory and file handles, sync access
 * handles with their exclusive lock, createWritable, and navigator.storage's estimate/persist.
 * `faults` injects the failures real disks produce.
 */

const domError = ( name, message = name ) => new DOMException( message, name );

class FakeState {

	constructor( quota ) {

		this.quota = quota;
		this.persistedFlag = false;
		this.faults = { quotaAfterBytes: null, failWriteOf: null };
		this.clock = 1_700_000_000_000;

	}

	used( dir ) {

		let n = 0;
		for ( const child of dir.children.values() ) n += child.kind === 'file' ? child.data.length : this.used( child );
		return n;

	}

}

class FakeSyncHandle {

	constructor( file ) {

		this._file = file;
		this._open = true;

	}

	_check() {

		if ( ! this._open ) throw domError( 'InvalidStateError', 'handle is closed' );

	}

	getSize() {

		this._check();
		return this._file.data.length;

	}

	read( buffer, { at = 0 } = {} ) {

		this._check();
		const view = buffer instanceof ArrayBuffer || ( typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer )
			? new Uint8Array( buffer )
			: new Uint8Array( buffer.buffer, buffer.byteOffset, buffer.byteLength );
		const src = this._file.data.subarray( at, at + view.length );
		view.set( src );
		return src.length;

	}

	write( buffer, { at = 0 } = {} ) {

		this._check();
		const view = buffer instanceof ArrayBuffer || ( typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer )
			? new Uint8Array( buffer )
			: new Uint8Array( buffer.buffer, buffer.byteOffset, buffer.byteLength );

		const state = this._file.state;
		if ( state.faults.failWriteOf === this._file.name ) throw domError( 'InvalidStateError', 'injected write failure' );

		const end = at + view.length;
		const grow = Math.max( 0, end - this._file.data.length );
		const total = state.used( this._file.root ) + grow;
		if ( total > state.quota || ( state.faults.quotaAfterBytes !== null && total > state.faults.quotaAfterBytes ) ) {

			throw domError( 'QuotaExceededError' );

		}

		if ( end > this._file.data.length ) {

			const next = new Uint8Array( end );
			next.set( this._file.data );
			this._file.data = next;

		}

		this._file.data.set( view, at );
		this._file.lastModified = state.clock ++;
		return view.length;

	}

	truncate( size ) {

		this._check();
		const next = new Uint8Array( size );
		next.set( this._file.data.subarray( 0, size ) );
		this._file.data = next;

	}

	flush() {

		this._check();

	}

	close() {

		if ( ! this._open ) return;
		this._open = false;
		this._file.locked = false;

	}

}

class FakeWritable {

	constructor( file ) {

		this._file = file;
		this._chunks = [];

	}

	async write( data ) {

		const bytes = typeof data === 'string' ? new TextEncoder().encode( data ) : new Uint8Array( data instanceof ArrayBuffer ? data : data.buffer ?? await data.arrayBuffer() );
		this._chunks.push( bytes.slice() );

	}

	async close() {

		const size = this._chunks.reduce( ( n, c ) => n + c.length, 0 );
		const data = new Uint8Array( size );
		let at = 0;
		for ( const c of this._chunks ) {

			data.set( c, at );
			at += c.length;

		}

		this._file.data = data;
		this._file.lastModified = this._file.state.clock ++;
		this._file.locked = false;

	}

}

class FakeFileHandle {

	constructor( name, state, root ) {

		this.kind = 'file';
		this.name = name;
		this.state = state;
		this.root = root;
		this.data = new Uint8Array( 0 );
		this.locked = false;
		this.lastModified = state.clock ++;

	}

	async getFile() {

		return new File( [ this.data.slice() ], this.name, { lastModified: this.lastModified } );

	}

	async createSyncAccessHandle() {

		if ( this.locked ) throw domError( 'NoModificationAllowedError', `${this.name} is locked` );
		this.locked = true;
		return new FakeSyncHandle( this );

	}

	async createWritable() {

		if ( this.locked ) throw domError( 'NoModificationAllowedError', `${this.name} is locked` );
		this.locked = true;
		return new FakeWritable( this );

	}

}

class FakeDirectoryHandle {

	constructor( name, state, root = null ) {

		this.kind = 'directory';
		this.name = name;
		this.state = state;
		this.root = root ?? this;
		this.children = new Map();

	}

	async getDirectoryHandle( name, { create = false } = {} ) {

		const existing = this.children.get( name );
		if ( existing ) {

			if ( existing.kind !== 'directory' ) throw domError( 'TypeMismatchError' );
			return existing;

		}

		if ( ! create ) throw domError( 'NotFoundError', `${name} not found` );
		const dir = new FakeDirectoryHandle( name, this.state, this.root );
		this.children.set( name, dir );
		return dir;

	}

	async getFileHandle( name, { create = false } = {} ) {

		const existing = this.children.get( name );
		if ( existing ) {

			if ( existing.kind !== 'file' ) throw domError( 'TypeMismatchError' );
			return existing;

		}

		if ( ! create ) throw domError( 'NotFoundError', `${name} not found` );
		const file = new FakeFileHandle( name, this.state, this.root );
		this.children.set( name, file );
		return file;

	}

	async removeEntry( name, { recursive = false } = {} ) {

		const child = this.children.get( name );
		if ( ! child ) throw domError( 'NotFoundError', `${name} not found` );
		if ( child.kind === 'directory' && child.children.size > 0 && ! recursive ) throw domError( 'InvalidModificationError' );
		if ( anyLocked( child ) ) throw domError( 'NoModificationAllowedError', `${name} is in use` );
		this.children.delete( name );

	}

	async *entries() {

		for ( const entry of [ ...this.children.entries() ] ) yield entry;

	}

	async *values() {

		for ( const value of [ ...this.children.values() ] ) yield value;

	}

	async *keys() {

		for ( const key of [ ...this.children.keys() ] ) yield key;

	}

}

function anyLocked( handle ) {

	if ( handle.kind === 'file' ) return handle.locked;
	for ( const child of handle.children.values() ) if ( anyLocked( child ) ) return true;
	return false;

}

/**
 * @param {{quota?: number}} [options]
 * @returns {{root: FakeDirectoryHandle, storage: Object, state: FakeState, install: function(): function(): void}}
 */
export function createFakeOPFS( { quota = 10 * 1024 ** 3 } = {} ) {

	const state = new FakeState( quota );
	const top = new FakeDirectoryHandle( '', state );

	const storage = {
		getDirectory: async () => top,
		estimate: async () => ( { quota: state.quota, usage: state.used( top ) } ),
		persist: async () => {

			state.persistedFlag = true;
			return true;

		},
		persisted: async () => state.persistedFlag,
	};

	/** Puts `storage` on globalThis.navigator; returns the undo. */
	const install = () => {

		const had = Object.getOwnPropertyDescriptor( globalThis, 'navigator' );
		Object.defineProperty( globalThis, 'navigator', { value: { ...( globalThis.navigator ?? {} ), storage }, configurable: true, writable: true } );
		return () => {

			if ( had ) Object.defineProperty( globalThis, 'navigator', had );
			else delete globalThis.navigator;

		};

	};

	return { root: top, storage, state, install };

}

/** Recursively lists `dir` as { 'a/b/meta.json': bytes }. */
export function snapshot( dir, prefix = '' ) {

	const out = {};
	for ( const [ name, child ] of dir.children ) {

		const path = prefix ? `${prefix}/${name}` : name;
		if ( child.kind === 'file' ) out[ path ] = child.data.length;
		else Object.assign( out, snapshot( child, path ) );

	}

	return out;

}
