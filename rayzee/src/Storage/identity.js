const encoder = new TextEncoder();

const HEAD_BYTES = 1 << 20;
const TAIL_BYTES = 1 << 20;
const PROBE_BYTES = 64 << 10;
const PROBES = 14;

function hex( bytes ) {

	let out = '';
	for ( const b of bytes ) out += b.toString( 16 ).padStart( 2, '0' );
	return out;

}

export async function sha256Hex( data ) {

	const bytes = typeof data === 'string' ? encoder.encode( data ) : data;
	return hex( new Uint8Array( await crypto.subtle.digest( 'SHA-256', bytes ) ) );

}

export async function entryIdFor( key ) {

	return ( await sha256Hex( key ) ).slice( 0, 32 );

}

/**
 * SHA-256 over the head, tail and 14 evenly spaced probes of a Blob — ~3 MB read whatever its
 * size. WebCrypto cannot stream, so a full hash of a multi-GB file would need it all in memory.
 */
export async function sampleHash( blob ) {

	if ( blob.size <= HEAD_BYTES + TAIL_BYTES + PROBES * PROBE_BYTES ) {

		return sha256Hex( new Uint8Array( await blob.arrayBuffer() ) );

	}

	const parts = [ blob.slice( 0, HEAD_BYTES ) ];
	const span = blob.size - HEAD_BYTES - TAIL_BYTES - PROBE_BYTES;
	for ( let i = 0; i < PROBES; i ++ ) {

		const at = HEAD_BYTES + Math.floor( span * ( i + 0.5 ) / PROBES );
		parts.push( blob.slice( at, at + PROBE_BYTES ) );

	}

	parts.push( blob.slice( blob.size - TAIL_BYTES ) );
	return sha256Hex( new Uint8Array( await new Blob( parts ).arrayBuffer() ) );

}

/** @returns {Promise<{name: string, size: number, lastModified: number, sample: string}>} */
export async function fileIdentity( file ) {

	return {
		name: file.name ?? '',
		size: file.size,
		lastModified: file.lastModified ?? 0,
		sample: await sampleHash( file ),
	};

}

/**
 * A folder's identity: its name, total size, newest change and a SHA-256 over every file's path, size and date. Reads
 * no file, and changes with any change inside the folder.
 * @param {{name: string, files: Array<{path: string, file: Blob}>}} folder - from `localFolder`
 * @returns {Promise<{name: string, size: number, lastModified: number, sample: string, files: number}>}
 */
export async function folderIdentity( folder ) {

	let size = 0;
	let lastModified = 0;
	const lines = folder.files.map( ( { path, file } ) => {

		size += file.size;
		lastModified = Math.max( lastModified, file.lastModified ?? 0 );
		return `${path}|${file.size}|${file.lastModified ?? 0}`;

	} );
	return { name: folder.name, size, lastModified, sample: await sha256Hex( lines.join( '\n' ) ), files: folder.files.length };

}

export function identityKey( identity ) {

	return `${identity.files === undefined ? 'file' : 'folder'}:${identity.name}|${identity.size}|${identity.lastModified}|${identity.sample}`;

}

export function sameIdentity( a, b ) {

	return !! a && !! b && a.size === b.size && a.sample === b.sample && a.name === b.name;

}
