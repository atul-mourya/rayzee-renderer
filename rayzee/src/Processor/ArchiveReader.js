/**
 * Streaming reader for .tar.gz / .tgz / .tar archives.
 *
 * ZIP is random-access (see ZipReader.js), but a gzipped tar is a
 * single compressed stream: the only way to reach the last entry is to decompress
 * everything before it. Holding that in memory is not an option — the pbrt-v4 Moana
 * archive is 5.9 GB compressed and 29 GB unpacked — so entries are decoded one at a
 * time and only the ones a filter asks for are kept.
 */

import { Gunzip } from 'three/addons/libs/fflate.module.js';

const BLOCK = 512;
const SLICE_BYTES = 4 << 20;
const DEFAULT_BYTE_BUDGET = 1_500_000_000;

/** V8 caps a string at 2^29-24 chars, so a larger entry can never be decoded as text. */
export const MAX_TEXT_ENTRY_BYTES = 536_870_888;

const textDecoder = new TextDecoder();

export function isGzip( head ) {

	return head.length >= 2 && head[ 0 ] === 0x1f && head[ 1 ] === 0x8b;

}

export function isZip( head ) {

	return head.length >= 4 && head[ 0 ] === 0x50 && head[ 1 ] === 0x4b
		&& ( head[ 2 ] === 3 || head[ 2 ] === 5 || head[ 2 ] === 7 );

}

export function isTar( head ) {

	return head.length >= 263 && String.fromCharCode( ...head.subarray( 257, 262 ) ) === 'ustar';

}

export function detectArchiveKind( head ) {

	if ( isGzip( head ) ) return 'gzip';
	if ( isZip( head ) ) return 'zip';
	if ( isTar( head ) ) return 'tar';
	return null;

}

function fieldString( b, off, len ) {

	let end = off;
	const max = off + len;
	while ( end < max && b[ end ] !== 0 ) end ++;
	return textDecoder.decode( b.subarray( off, end ) );

}

function fieldNumber( b, off, len ) {

	// GNU writes sizes that do not fit in 11 octal digits as base-256 with the high bit set.
	if ( b[ off ] & 0x80 ) {

		let v = b[ off ] & 0x7f;
		for ( let i = off + 1; i < off + len; i ++ ) v = v * 256 + b[ i ];
		return v;

	}

	const s = fieldString( b, off, len ).trim();
	if ( ! s ) return 0;
	const v = parseInt( s, 8 );
	return Number.isFinite( v ) ? v : 0;

}

function normalizeTarPath( p ) {

	const out = [];
	for ( const part of p.replace( /\\/g, '/' ).split( '/' ) ) {

		if ( part === '' || part === '.' ) continue;
		if ( part === '..' ) out.pop();
		else out.push( part );

	}

	return out.join( '/' );

}

function paxPath( bytes ) {

	const text = textDecoder.decode( bytes );
	const m = text.match( /^\d+ path=(.*)$/m );
	return m ? m[ 1 ] : null;

}

const paddedSize = size => size + ( ( BLOCK - ( size % BLOCK ) ) % BLOCK );

const isSpecialType = type => type === 'L' || type === 'x' || type === 'X';

function parseHeader( h ) {

	const prefix = fieldString( h, 345, 155 );
	const raw = fieldString( h, 0, 100 );
	return {
		type: String.fromCharCode( h[ 156 ] || 0x30 ),
		size: fieldNumber( h, 124, 12 ),
		name: prefix ? `${prefix}/${raw}` : raw,
	};

}

/** Normalised path of a regular file entry, or null for directories, links and the rest. */
function regularPath( type, name ) {

	if ( type === '5' || type === 'g' || type === 'K' || name.endsWith( '/' ) ) return null;
	if ( type !== '0' && type !== ' ' ) return null;
	return normalizeTarPath( name ) || null;

}

function isZeroBlock( h ) {

	for ( let i = 0; i < BLOCK; i ++ ) if ( h[ i ] !== 0 ) return false;
	return true;

}

/**
 * Pull-free tar parser: chunks are pushed in as they decompress, and entry bodies are
 * copied straight out of them so a skipped entry never allocates.
 */
class TarStream {

	constructor( { filter = null, retain = null, byteBudget = DEFAULT_BYTE_BUDGET, onEntry = null, sink = null } = {} ) {

		this.filter = filter;
		// Passed each indexed entry's bytes in order: the listing then records offsets into what the sink wrote.
		this.sink = sink;
		this._sunk = 0;
		// Entries that pass `filter` but fail `retain` are indexed, not copied: the listing
		// records where their bytes live so a caller with a seekable source can read them later.
		// An uncompressed tar over a File is seekable, which is how a 7 GB archive loads without
		// ever holding itself in memory.
		this.retain = retain;
		this.byteBudget = byteBudget;
		this.onEntry = onEntry;

		this.entries = Object.create( null );
		this.listing = [];
		this.retainedBytes = 0;
		this.truncated = false;
		this.finished = false;

		this._header = new Uint8Array( BLOCK );
		this._headerLen = 0;
		this._state = 'header';
		this._remaining = 0;
		this._size = 0;
		this._copied = 0;
		this._dst = null;
		this._special = null;
		this._pendingName = null;
		this._abs = 0; // absolute byte offset of the next byte `push` will consume

	}

	push( chunk ) {

		const base = this._abs;
		this._abs += chunk.length;

		let i = 0;
		while ( i < chunk.length && ! this.finished ) {

			if ( this._state === 'header' ) {

				const n = Math.min( BLOCK - this._headerLen, chunk.length - i );
				this._header.set( chunk.subarray( i, i + n ), this._headerLen );
				this._headerLen += n;
				i += n;
				if ( this._headerLen === BLOCK ) {

					this._headerLen = 0;
					this._bodyStart = base + i; // body begins right after the header block
					this._readHeader();

				}

			} else {

				const n = Math.min( this._remaining, chunk.length - i );
				if ( this.sink && this._indexed && this._sinkLeft > 0 ) {

					const take = Math.min( n, this._sinkLeft );
					this.sink( chunk.subarray( i, i + take ) );
					this._sinkLeft -= take;

				}

				if ( this._dst && this._copied < this._size ) {

					const take = Math.min( n, this._size - this._copied );
					this._dst.set( chunk.subarray( i, i + take ), this._copied );
					this._copied += take;

				}

				this._remaining -= n;
				i += n;
				if ( this._remaining === 0 ) this._endBody();

			}

		}

	}

	end() {

		this.finished = true;

	}

	result() {

		return {
			entries: this.entries,
			listing: this.listing,
			retainedBytes: this.retainedBytes,
			truncated: this.truncated
		};

	}

	_readHeader() {

		const h = this._header;
		let zero = true;
		for ( let i = 0; i < BLOCK; i ++ ) if ( h[ i ] !== 0 ) {

			zero = false; break;

		}

		if ( zero ) {

			this.finished = true;
			return;

		}

		const { type, size, name: headerName } = parseHeader( h );
		const name = this._pendingName ?? headerName;
		this._pendingName = null;

		this._size = size;
		this._copied = 0;
		this._remaining = paddedSize( size );
		this._dst = null;
		this._special = null;
		this._indexed = false;
		this._state = this._remaining > 0 ? 'body' : 'header';

		if ( isSpecialType( type ) ) {

			this._special = type === 'L' ? 'longname' : 'pax';
			this._dst = new Uint8Array( size );
			return;

		}

		const path = regularPath( type, name );
		if ( ! path ) return;

		this.listing.push( { path, size } );
		this._indexed = this.filter ? this.filter( path, size ) : true;
		if ( this.sink && this._indexed ) {

			this._sinkStart = this._sunk;
			this._sinkLeft = size;
			this._sunk += size;

		}

		if ( this._indexed && ! ( this.retain && ! this.retain( path, size ) ) ) {

			if ( this.retainedBytes + size > this.byteBudget ) {

				this.truncated = true;

			} else {

				this._dst = new Uint8Array( size );
				this.retainedBytes += size;

			}

		}

		// An empty file has no body block, so nothing else would finish it.
		if ( this._remaining === 0 ) this._endBody();

	}

	_endBody() {

		this._state = 'header';

		if ( this._special === 'longname' ) {

			this._pendingName = fieldString( this._dst, 0, this._dst.length );
			this._dst = null;
			return;

		}

		if ( this._special === 'pax' ) {

			const p = paxPath( this._dst );
			if ( p ) this._pendingName = p;
			this._dst = null;
			return;

		}

		const entry = this.listing[ this.listing.length - 1 ];

		if ( this._indexed && entry ) {

			entry.offset = this.sink ? this._sinkStart : this._bodyStart;
			this._indexed = false;

		}

		if ( this._dst ) {

			this.entries[ entry.path ] = this._dst;
			this.onEntry?.( entry.path, this._dst );
			this._dst = null;

		}

	}

}

async function streamGunzip( source, onChunk ) {

	if ( typeof DecompressionStream !== 'undefined' && typeof source?.stream === 'function' ) {

		const reader = source.stream().pipeThrough( new DecompressionStream( 'gzip' ) ).getReader();
		for ( ;; ) {

			const { done, value } = await reader.read();
			if ( done ) break;
			onChunk( value );

		}

		return;

	}

	let failure = null;
	const gunzip = new Gunzip( ( chunk, final ) => {

		if ( chunk instanceof Error ) failure = chunk;
		else if ( chunk && chunk.length ) onChunk( chunk );
		void final;

	} );

	await forEachSlice( source, ( slice, last ) => {

		gunzip.push( slice, last );
		if ( failure ) throw failure;

	} );

}

async function forEachSlice( source, fn ) {

	if ( source instanceof Uint8Array ) {

		for ( let off = 0; off < source.length; off += SLICE_BYTES ) {

			const end = Math.min( off + SLICE_BYTES, source.length );
			fn( source.subarray( off, end ), end === source.length );

		}

		if ( source.length === 0 ) fn( source, true );
		return;

	}

	const size = source.size;
	for ( let off = 0; off < size; off += SLICE_BYTES ) {

		const end = Math.min( off + SLICE_BYTES, size );
		fn( new Uint8Array( await source.slice( off, end ).arrayBuffer() ), end === size );

	}

	if ( size === 0 ) fn( new Uint8Array( 0 ), true );

}

/**
 * @param {Blob|File|Uint8Array} source
 * @param {object} [options]
 * @param {(path:string, size:number)=>boolean} [options.filter] - keep this entry's bytes
 * @param {number} [options.byteBudget] - stop retaining past this many bytes; sets `truncated`
 * @param {(progress:{entries:number, bytes:number})=>void} [options.onProgress]
 * @returns {Promise<{entries:Object<string,Uint8Array>, listing:Array<{path:string,size:number}>,
 *   retainedBytes:number, truncated:boolean}>}
 */
export async function readTarGz( source, options = {} ) {

	const { onProgress, ...rest } = options;
	const tar = new TarStream( rest );

	let bytes = 0;
	let nextReport = 0;
	const consume = chunk => {

		tar.push( chunk );
		bytes += chunk.length;
		if ( onProgress && bytes >= nextReport ) {

			nextReport = bytes + ( 64 << 20 );
			onProgress( { entries: tar.listing.length, bytes } );

		}

	};

	await streamGunzip( source, consume );
	tar.end();
	return tar.result();

}

const WINDOW_BYTES = 1 << 20;

/**
 * Lists every regular file of a seekable .tar with its body offset, reading only the headers:
 * each entry's body is skipped by seeking, so a 7 GB archive of large files costs a few
 * thousand small reads instead of a full pass.
 * @param {Blob|File} source
 * @returns {Promise<Array<{path:string, size:number, offset:number}>>}
 */
export async function indexTarHeaders( source, { onProgress = null } = {} ) {

	const size = source.size;
	const listing = [];
	let window = null;
	let windowStart = 0;
	let pendingName = null;
	let pos = 0;
	let nextReport = 0;

	const bytesAt = async ( at, n ) => {

		if ( window && at >= windowStart && at + n <= windowStart + window.length ) {

			return window.subarray( at - windowStart, at - windowStart + n );

		}

		const end = Math.min( size, at + Math.max( n, WINDOW_BYTES ) );
		window = new Uint8Array( await source.slice( at, end ).arrayBuffer() );
		windowStart = at;
		return window.subarray( 0, n );

	};

	while ( pos + BLOCK <= size ) {

		const h = await bytesAt( pos, BLOCK );
		if ( isZeroBlock( h ) ) break;

		const { type, size: bodySize, name: headerName } = parseHeader( h );
		const name = pendingName ?? headerName;
		pendingName = null;
		const bodyStart = pos + BLOCK;

		if ( isSpecialType( type ) ) {

			const body = await bytesAt( bodyStart, bodySize );
			pendingName = type === 'L' ? fieldString( body, 0, body.length ) : paxPath( body );

		} else {

			const path = regularPath( type, name );
			if ( path ) listing.push( { path, size: bodySize, offset: bodyStart } );

		}

		pos = bodyStart + paddedSize( bodySize );

		if ( onProgress && pos >= nextReport ) {

			nextReport = pos + ( 256 << 20 );
			onProgress( { entries: listing.length, bytes: pos } );

		}

	}

	return listing;

}

/**
 * Indexes a tar stream as it goes by — for writing a decompressing archive to disk and knowing
 * where every entry landed without a second pass.
 */
export function createTarIndexer( { filter = null, sink = null } = {} ) {

	const tar = new TarStream( { retain: () => false, filter, sink } );
	return {
		push: chunk => tar.push( chunk ),
		finish: () => {

			tar.end();
			return tar.listing.filter( e => e.offset !== undefined );

		},
	};

}

/**
 * A seekable view over an uncompressed .tar: entries are indexed and read back on demand from
 * the source, so the archive is never resident.
 *
 * Only for `.tar` over a Blob/File — a gzip stream cannot be seeked.
 *
 * @param {Blob|File} source
 * @param {object} [options] - `filter` and `retain` as in readTar
 * @param {{listing: Array}} [options.index] - a saved index (`result.index`): skips the walk
 * @param {boolean} [options.headersOnly] - index by seeking between headers; nothing is retained
 * @returns {Promise<{entries, listing, read: (path:string)=>Promise<Uint8Array|null>,
 *   slice: (path:string)=>Promise<Blob|null>, truncated, index: ?{v:number, listing:Array}}>}
 */
export async function openTar( source, options = {} ) {

	const { index = null, headersOnly = false, onProgress = null, ...streamOptions } = options;

	let entries, listing, retainedBytes, truncated, full = null;

	if ( index || headersOnly ) {

		full = index?.listing ?? await indexTarHeaders( source, { onProgress } );
		const { filter } = streamOptions;
		listing = full.map( e => ( ! filter || filter( e.path, e.size ) ? { ...e } : { path: e.path, size: e.size } ) );
		entries = Object.create( null );
		retainedBytes = 0;
		truncated = false;

	} else {

		const tar = new TarStream( { ...streamOptions } );
		await forEachSlice( source, slice => tar.push( slice ) );
		tar.end();
		( { entries, listing, retainedBytes, truncated } = tar.result() );

	}

	const byPath = new Map();
	for ( const e of listing ) if ( e.offset !== undefined ) byPath.set( e.path, e );

	const read = async ( path ) => {

		if ( entries[ path ] ) return entries[ path ];
		const e = byPath.get( path );
		if ( ! e ) return null;
		return new Uint8Array( await source.slice( e.offset, e.offset + e.size ).arrayBuffer() );

	};

	const readHead = async ( path, bytes ) => {

		if ( entries[ path ] ) return entries[ path ].subarray( 0, bytes );
		const e = byPath.get( path );
		if ( ! e ) return null;
		return new Uint8Array( await source.slice( e.offset, e.offset + Math.min( e.size, bytes ) ).arrayBuffer() );

	};

	const slice = async ( path ) => {

		if ( entries[ path ] ) return new Blob( [ entries[ path ] ] );
		const e = byPath.get( path );
		return e ? source.slice( e.offset, e.offset + e.size ) : null;

	};

	return { entries, listing, read, readHead, slice, retainedBytes, truncated, indexed: byPath.size, index: full ? { v: 1, listing: full } : null };

}

/**
 * A folder on disk with the shape of `openTar` and `openZip`: every file is listed, and read only when asked for.
 * @param {{files: Array<{path: string, file: Blob}>}} folder - from `localFolder`
 * @param {{filter?: (path:string, size:number) => boolean}} [options]
 */
export function openFolder( folder, { filter = null } = {} ) {

	const byPath = new Map();
	const listing = folder.files.map( ( { path, file } ) => {

		if ( filter && ! filter( path, file.size ) ) return { path, size: file.size };
		byPath.set( path, file );
		return { path, size: file.size, offset: 0 };

	} );

	const slice = async ( path ) => byPath.get( path ) ?? null;
	const read = async ( path ) => {

		const file = byPath.get( path );
		return file ? new Uint8Array( await file.arrayBuffer() ) : null;

	};

	const readHead = async ( path, bytes ) => {

		const file = byPath.get( path );
		return file ? new Uint8Array( await file.slice( 0, bytes ).arrayBuffer() ) : null;

	};

	return { entries: Object.create( null ), listing, read, readHead, slice, retainedBytes: 0, truncated: false, indexed: byPath.size };

}

/** Same contract as readTarGz for an uncompressed .tar. */
export async function readTar( source, options = {} ) {

	const { onProgress, ...rest } = options;
	const tar = new TarStream( rest );
	await forEachSlice( source, slice => tar.push( slice ) );
	tar.end();
	void onProgress;
	return tar.result();

}

/**
 * Retain-predicate for one or several subtrees of a scene archive.
 *
 * Keeps each chosen element plus everything above it — the top-level scene file, the shared
 * material library, and any `textures` folder hanging off an ancestor — so the entry .pbrt
 * still parses with its siblings absent. An Include pointing at a subtree that was left out
 * only warns, which is what makes a partial load work at all.
 *
 * @param {string|string[]} prefixes - one element path, or several to load together
 */
export function elementFilter( prefixes ) {

	const wanted = ( Array.isArray( prefixes ) ? prefixes : [ prefixes ] )
		.filter( Boolean )
		.map( prefix => {

			const p = normalizeTarPath( prefix );
			return { p, inside: p + '/' };

		} );

	if ( wanted.length === 0 ) return () => true;

	return path => {

		const cut = path.lastIndexOf( '/' );
		const dir = cut < 0 ? '' : path.slice( 0, cut );
		if ( dir === '' ) return true;

		const tex = dir.lastIndexOf( '/textures' );
		const texRoot = tex >= 0 && tex === dir.length - 9 ? dir.slice( 0, tex ) + '/' : null;

		for ( const { p, inside } of wanted ) {

			if ( path === p || path.startsWith( inside ) ) return true;
			if ( inside.startsWith( dir + '/' ) ) return true;
			if ( texRoot !== null && inside.startsWith( texRoot ) ) return true;

		}

		return false;

	};

}

/**
 * Group a listing into loadable subtrees.
 *
 * The scene root is the directory of the shallowest .pbrt; each of its child directories
 * that holds a .pbrt of its own is an element the caller can load on its own.
 */
export function listArchiveElements( listing ) {

	const scenes = listing
		.filter( e => e.path.toLowerCase().endsWith( '.pbrt' ) )
		.sort( ( a, b ) => a.path.split( '/' ).length - b.path.split( '/' ).length
			|| a.path.length - b.path.length
			|| ( a.path < b.path ? - 1 : 1 ) );

	if ( ! scenes.length ) return { root: null, elements: [] };

	const top = scenes[ 0 ].path;
	const cut = top.lastIndexOf( '/' );
	const root = cut < 0 ? '' : top.slice( 0, cut );
	const under = root ? root + '/' : '';

	const byName = new Map();
	for ( const entry of listing ) {

		if ( ! entry.path.startsWith( under ) ) continue;
		const rest = entry.path.slice( under.length );
		const slash = rest.indexOf( '/' );
		if ( slash < 0 ) continue;

		const name = rest.slice( 0, slash );
		let el = byName.get( name );
		if ( ! el ) byName.set( name, el = { name, prefix: under + name, files: 0, bytes: 0, scenes: 0 } );
		el.files ++;
		el.bytes += entry.size;
		if ( entry.path.toLowerCase().endsWith( '.pbrt' ) ) el.scenes ++;

	}

	const elements = [ ...byName.values() ]
		.filter( el => el.scenes > 0 )
		.sort( ( a, b ) => a.bytes - b.bytes );

	return { root, elements };

}
