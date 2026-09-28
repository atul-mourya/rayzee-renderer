const BLOCK = 512;
const enc = new TextEncoder();

function header( name, size, type ) {

	const h = new Uint8Array( BLOCK );
	h.set( enc.encode( name.slice( 0, 100 ) ), 0 );
	h.set( enc.encode( '0000644\0' ), 100 );
	h.set( enc.encode( '0000000\0' ), 108 );
	h.set( enc.encode( '0000000\0' ), 116 );
	h.set( enc.encode( size.toString( 8 ).padStart( 11, '0' ) + '\0' ), 124 );
	h.set( enc.encode( '00000000000\0' ), 136 );
	h[ 156 ] = type.charCodeAt( 0 );
	h.set( enc.encode( 'ustar\0' ), 257 );
	h.set( enc.encode( '00' ), 263 );
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

/**
 * ustar writer for tests. Entries: `{ path, body, type = '0', longname = 'L'|'pax' }`; a path
 * past 100 characters gets a GNU longname (or pax) record in front.
 */
export function makeTar( files ) {

	const blocks = [];
	for ( const { path, body = new Uint8Array( 0 ), type = '0', longname = 'L' } of files ) {

		if ( path.length > 100 ) {

			if ( longname === 'pax' ) {

				const record = ` path=${path}\n`;
				let len = record.length + 2;
				while ( `${len}${record}`.length !== len ) len = `${len}${record}`.length;
				const pax = enc.encode( `${len}${record}` );
				blocks.push( header( 'PaxHeader', pax.length, 'x' ), pad( pax ) );

			} else {

				const long = enc.encode( path + '\0' );
				blocks.push( header( '././@LongLink', long.length, 'L' ), pad( long ) );

			}

		}

		blocks.push( header( path, body.length, type ), pad( body ) );

	}

	blocks.push( new Uint8Array( BLOCK * 2 ) );

	const out = new Uint8Array( blocks.reduce( ( n, b ) => n + b.length, 0 ) );
	let o = 0;
	for ( const b of blocks ) {

		out.set( b, o );
		o += b.length;

	}

	return out;

}

export const text = s => enc.encode( s );
