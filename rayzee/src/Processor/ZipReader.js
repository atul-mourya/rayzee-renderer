/**
 * Reads a .zip in place: the central directory at the end names every entry and where it
 * starts, so one entry is read and inflated at a time and the archive is never resident.
 */

import { inflateSync } from 'three/addons/libs/fflate.module.js';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const EOCD_MAX_SEARCH = 65535 + 22;

const utf8 = new TextDecoder();

async function bytes( blob, start, end ) {

	return new Uint8Array( await blob.slice( start, end ).arrayBuffer() );

}

function u64( view, offset ) {

	return view.getUint32( offset + 4, true ) * 0x100000000 + view.getUint32( offset, true );

}

function latin1( b ) {

	let out = '';
	for ( let i = 0; i < b.length; i += 8192 ) out += String.fromCharCode( ...b.subarray( i, i + 8192 ) );
	return out;

}

/**
 * @param {Blob|File} blob
 * @returns {Promise<Array<{name:string, size:number, compSize:number, method:number, local:number, encrypted:boolean}>>}
 */
export async function readZipDirectory( blob ) {

	const size = blob.size;
	const tailStart = Math.max( 0, size - EOCD_MAX_SEARCH - 20 );
	const tail = await bytes( blob, tailStart, size );
	const tv = new DataView( tail.buffer );

	let eocd = - 1;
	for ( let i = tail.length - 22; i >= 0; i -- ) {

		if ( tv.getUint32( i, true ) === EOCD ) {

			eocd = i;
			break;

		}

	}

	if ( eocd < 0 ) throw new Error( 'zip: end of central directory not found' );

	let count = tv.getUint16( eocd + 10, true );
	let cdSize = tv.getUint32( eocd + 12, true );
	let cdOffset = tv.getUint32( eocd + 16, true );

	if ( count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff ) {

		const locator = eocd - 20;
		if ( locator < 0 || tv.getUint32( locator, true ) !== ZIP64_LOCATOR ) throw new Error( 'zip: ZIP64 locator missing' );
		const recordOffset = u64( tv, locator + 8 );
		const record = new DataView( ( await bytes( blob, recordOffset, recordOffset + 56 ) ).buffer );
		if ( record.getUint32( 0, true ) !== ZIP64_EOCD ) throw new Error( 'zip: ZIP64 end record missing' );
		count = u64( record, 32 );
		cdSize = u64( record, 40 );
		cdOffset = u64( record, 48 );

	}

	const cd = await bytes( blob, cdOffset, cdOffset + cdSize );
	const v = new DataView( cd.buffer );
	const entries = [];

	let p = 0;
	for ( let i = 0; i < count && p + 46 <= cd.length; i ++ ) {

		if ( v.getUint32( p, true ) !== CENTRAL ) throw new Error( 'zip: corrupt central directory' );

		const flags = v.getUint16( p + 8, true );
		const method = v.getUint16( p + 10, true );
		let compSize = v.getUint32( p + 20, true );
		let entrySize = v.getUint32( p + 24, true );
		const nameLen = v.getUint16( p + 28, true );
		const extraLen = v.getUint16( p + 30, true );
		const commentLen = v.getUint16( p + 32, true );
		let local = v.getUint32( p + 42, true );

		const rawName = cd.subarray( p + 46, p + 46 + nameLen );
		const name = flags & 0x800 ? utf8.decode( rawName ) : latin1( rawName );

		// ZIP64 extra field: only the saturated 32-bit fields are present, in this order.
		for ( let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end; ) {

			const id = v.getUint16( e, true );
			const len = v.getUint16( e + 2, true );
			if ( id === 0x0001 ) {

				let q = e + 4;
				if ( entrySize === 0xffffffff ) {

					entrySize = u64( v, q );
					q += 8;

				}

				if ( compSize === 0xffffffff ) {

					compSize = u64( v, q );
					q += 8;

				}

				if ( local === 0xffffffff ) local = u64( v, q );

			}

			e += 4 + len;

		}

		if ( ! name.endsWith( '/' ) ) entries.push( { name, size: entrySize, compSize, method, local, encrypted: ( flags & 1 ) !== 0 } );
		p += 46 + nameLen + extraLen + commentLen;

	}

	return entries;

}

async function dataStart( blob, entry ) {

	if ( entry.encrypted ) throw new Error( `zip: "${entry.name}" is encrypted` );

	const head = new DataView( ( await bytes( blob, entry.local, entry.local + 30 ) ).buffer );
	if ( head.getUint32( 0, true ) !== LOCAL ) throw new Error( `zip: bad local header for "${entry.name}"` );
	return entry.local + 30 + head.getUint16( 26, true ) + head.getUint16( 28, true );

}

async function readEntry( blob, entry ) {

	const start = await dataStart( blob, entry );
	const raw = await bytes( blob, start, start + entry.compSize );

	if ( entry.method === 0 ) return raw;
	if ( entry.method === 8 ) return entry.size === 0 ? new Uint8Array( 0 ) : inflateSync( raw, { out: new Uint8Array( entry.size ) } );
	throw new Error( `zip: "${entry.name}" uses compression method ${entry.method}, which is not supported` );

}

/**
 * Same shape as `openTar`: `listing` holds every entry, with an `offset` on those `filter` keeps,
 * and `read( path )` inflates one on demand; `slice( path )` gives it as a Blob. Paths are the archive's own, as fflate's unzipSync keys them.
 * @param {Blob|File} blob
 * @param {{filter?: (path:string, size:number) => boolean}} [options]
 */
export async function openZip( blob, { filter = null } = {} ) {

	const directory = await readZipDirectory( blob );
	const byPath = new Map();

	const listing = directory.map( e => {

		if ( filter && ! filter( e.name, e.size ) ) return { path: e.name, size: e.size };
		byPath.set( e.name, e );
		return { path: e.name, size: e.size, offset: e.local };

	} );

	const read = async ( path ) => {

		const entry = byPath.get( path );
		return entry ? readEntry( blob, entry ) : null;

	};

	// A stored entry is a slice of the archive itself, so a large one never passes through memory.
	const slice = async ( path ) => {

		const entry = byPath.get( path );
		if ( ! entry ) return null;
		if ( entry.method !== 0 ) return new Blob( [ await readEntry( blob, entry ) ] );
		const start = await dataStart( blob, entry );
		return blob.slice( start, start + entry.compSize );

	};

	// A stored entry's head is a slice; a deflated one is inflated whole, as a read would.
	const readHead = async ( path, bytes ) => {

		const part = await slice( path );
		return part ? new Uint8Array( await part.slice( 0, bytes ).arrayBuffer() ) : null;

	};

	return { entries: Object.create( null ), listing, read, readHead, slice, retainedBytes: 0, truncated: false, indexed: byPath.size };

}
