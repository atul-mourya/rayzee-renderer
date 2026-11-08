const BLOCK = 512;
const enc = new TextEncoder();

const octal = ( n, width ) => enc.encode( n.toString( 8 ).padStart( width - 1, '0' ) + '\0' );

function header( name, size, type, fill ) {

	const h = new Uint8Array( BLOCK );
	h.set( enc.encode( name.slice( 0, 100 ) ), 0 );
	h.set( enc.encode( '0000644\0' ), 100 );
	h.set( enc.encode( '0000000\0' ), 108 );
	h.set( enc.encode( '0000000\0' ), 116 );
	h.set( octal( size, 12 ), 124 );
	h.set( enc.encode( '00000000000\0' ), 136 );
	h[ 156 ] = type.charCodeAt( 0 );
	h.set( enc.encode( 'ustar\0' ), 257 );
	h.set( enc.encode( '00' ), 263 );
	fill?.( h );
	h.set( enc.encode( '        ' ), 148 );
	let sum = 0;
	for ( const b of h ) sum += b;
	h.set( enc.encode( sum.toString( 8 ).padStart( 6, '0' ) + '\0 ' ), 148 );
	return h;

}

const pad = bytes => {

	const out = new Uint8Array( Math.ceil( bytes.length / BLOCK ) * BLOCK );
	out.set( bytes );
	return out;

};

const join = ( parts ) => {

	const out = new Uint8Array( parts.reduce( ( n, b ) => n + b.length, 0 ) );
	let o = 0;
	for ( const b of parts ) {

		out.set( b, o );
		o += b.length;

	}

	return out;

};

// `length keyword=value\n`, the length counting itself (ASCII only).
function paxHeader( records ) {

	const body = enc.encode( records.map( ( [ key, value ] ) => {

		const record = ` ${key}=${value}\n`;
		let len = record.length + 1;
		while ( `${len}${record}`.length !== len ) len = `${len}${record}`.length;
		return `${len}${record}`;

	} ).join( '' ) );
	return [ header( 'PaxHeader', body.length, 'x' ), pad( body ) ];

}

// [ offset, length ] slots of 12 octal digits each.
const slots = ( block, at, regions ) => regions.forEach( ( [ offset, length ], i ) => {

	block.set( octal( offset, 12 ), at + 24 * i );
	block.set( octal( length, 12 ), at + 24 * i + 12 );

} );

/** A GNU sparse file in one of its four layouts: `body` the whole file, `regions` the [ offset, length ] parts stored. */
function sparseMember( path, body, regions, format ) {

	const stored = join( regions.map( ( [ offset, length ] ) => body.subarray( offset, offset + length ) ) );
	const pairs = regions.flat();

	if ( format === 'S' ) {

		const blocks = [ header( path, stored.length, 'S', ( h ) => {

			h.set( octal( 0o14374651232, 12 ), 345 ); // an atime, where ustar has its prefix
			slots( h, 386, regions.slice( 0, 4 ) );
			h[ 482 ] = regions.length > 4 ? 1 : 0;
			h.set( octal( body.length, 12 ), 483 );

		} ) ];
		for ( let i = 4; i < regions.length; i += 21 ) {

			const block = new Uint8Array( BLOCK );
			slots( block, 0, regions.slice( i, i + 21 ) );
			block[ 504 ] = i + 21 < regions.length ? 1 : 0;
			blocks.push( block );

		}

		return [ ...blocks, pad( stored ) ];

	}

	const real = [[ 'GNU.sparse.size', body.length ], [ 'GNU.sparse.numblocks', regions.length ]];
	if ( format === '0.0' ) {

		const map = regions.flatMap( ( [ offset, length ] ) => [[ 'GNU.sparse.offset', offset ], [ 'GNU.sparse.numbytes', length ]] );
		return [ ...paxHeader( [ ...real, ...map ] ), header( path, stored.length, '0' ), pad( stored ) ];

	}

	const dummy = `GNUSparseFile.0/${path.split( '/' ).pop()}`;
	if ( format === '0.1' ) {

		return [ ...paxHeader( [ ...real, [ 'GNU.sparse.map', pairs.join( ',' ) ], [ 'GNU.sparse.name', path ]] ), header( dummy, stored.length, '0' ), pad( stored ) ];

	}

	const map = pad( enc.encode( [ regions.length, ...pairs ].join( '\n' ) + '\n' ) );
	const records = [[ 'GNU.sparse.major', 1 ], [ 'GNU.sparse.minor', 0 ], [ 'GNU.sparse.name', path ], [ 'GNU.sparse.realsize', body.length ]];
	return [ ...paxHeader( records ), header( dummy, map.length + stored.length, '0' ), map, pad( stored ) ];

}

/**
 * ustar writer for tests. Entries: `{ path, body, type = '0', longname = 'L'|'pax', pax, size, sparse }`; a path past
 * 100 characters gets a GNU longname (or pax) record in front. `pax` adds records before the entry, `size` writes another
 * size in its header, and `sparse: { regions, format }` stores it as a GNU sparse file ('S', '0.0', '0.1' or '1.0').
 */
export function makeTar( files ) {

	const blocks = [];
	for ( const { path, body = new Uint8Array( 0 ), type = '0', longname = 'L', pax, size = body.length, sparse } of files ) {

		if ( sparse ) {

			blocks.push( ...sparseMember( path, body, sparse.regions, sparse.format ) );
			continue;

		}

		if ( pax ) blocks.push( ...paxHeader( pax ) );
		if ( path.length > 100 ) {

			if ( longname === 'pax' ) {

				blocks.push( ...paxHeader( [[ 'path', path ]] ) );

			} else {

				const long = enc.encode( path + '\0' );
				blocks.push( header( '././@LongLink', long.length, 'L' ), pad( long ) );

			}

		}

		blocks.push( header( path, size, type ), pad( body ) );

	}

	blocks.push( new Uint8Array( BLOCK * 2 ) );
	return join( blocks );

}

export const text = s => enc.encode( s );
