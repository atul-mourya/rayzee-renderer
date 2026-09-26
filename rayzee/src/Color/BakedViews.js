/**
 * A baked view in a file, so a host can show a config's view before the OCIO runtime or the config
 * has loaded — the app's first frame uses one.
 *
 * gzip of: 'RZVT', a u32 header length, the JSON header, then the table's red, green and blue as
 * half floats, each delta-coded along red and stored as a high-byte plane then a low-byte plane
 * (156 KB for a 65³ table; 2.2 MB raw). Alpha is always 1 and not stored.
 */

const MAGIC = [ 0x52, 0x5a, 0x56, 0x54 ];
const FORMAT = 'rayzee-baked-view';
export const BAKED_VIEW_VERSION = 1;
const HALF_ONE = 0x3c00;

async function pipe( bytes, transform ) {

	return new Uint8Array( await new Response( new Blob( [ bytes ] ).stream().pipeThrough( transform ) ).arrayBuffer() );

}

/**
 * @param {Object} entry - an OCIO registry entry
 * @param {Object} [extra] - header fields to add, e.g. the config fingerprint
 * @returns {Promise<Uint8Array>}
 */
export async function encodeBakedView( entry, extra = {} ) {

	const data = entry?.table?.data;
	if ( entry?.source !== 'ocio' || ! ( data instanceof Uint16Array ) ) throw new Error( 'only a baked OCIO view can be saved' );

	const { size, minEv, maxEv } = entry.ocio;
	const n = size * size * size;
	if ( data.length !== n * 4 ) throw new Error( `table holds ${data.length} values, expected ${n * 4}` );

	const planes = new Uint8Array( n * 6 );
	for ( let ch = 0; ch < 3; ch ++ ) {

		for ( let i = 0; i < n; i ++ ) {

			if ( ch === 0 && data[ i * 4 + 3 ] !== HALF_ONE ) throw new Error( 'table alpha is not 1' );
			const v = data[ i * 4 + ch ];
			const d = ( v - ( i % size ? data[ ( i - 1 ) * 4 + ch ] : 0 ) ) & 0xffff;
			planes[ ch * n + i ] = d >> 8;
			planes[ 3 * n + ch * n + i ] = d & 0xff;

		}

	}

	const { display, view, look, context, source, configId } = entry.ocio;
	const header = new TextEncoder().encode( JSON.stringify( {
		format: FORMAT, version: BAKED_VIEW_VERSION,
		name: entry.name, configId, display, view, look: look ?? null, context: context ?? null, source,
		size, minEv, maxEv, error: entry.error ?? null,
		...extra,
	} ) );

	const out = new Uint8Array( 8 + header.length + planes.length );
	out.set( MAGIC, 0 );
	new DataView( out.buffer ).setUint32( 4, header.length, true );
	out.set( header, 8 );
	out.set( planes, 8 + header.length );
	return await pipe( out, new CompressionStream( 'gzip' ) );

}

/**
 * @param {ArrayBuffer|Uint8Array} bytes - from {@link encodeBakedView}
 * @returns {Promise<Object>} the header's fields, plus `data`: the RGBA half table
 */
export async function decodeBakedView( bytes ) {

	const raw = await pipe( bytes, new DecompressionStream( 'gzip' ) );
	if ( raw.length < 8 || MAGIC.some( ( b, i ) => raw[ i ] !== b ) ) throw new Error( 'not a baked view file' );

	const length = new DataView( raw.buffer, raw.byteOffset ).getUint32( 4, true );
	const header = JSON.parse( new TextDecoder().decode( raw.subarray( 8, 8 + length ) ) );
	if ( header.format !== FORMAT || header.version !== BAKED_VIEW_VERSION ) {

		throw new Error( `unsupported baked view ${header.format} v${header.version}` );

	}

	const { size, minEv, maxEv } = header;
	if ( ! Number.isInteger( size ) || size < 2 || size > 129 || ! ( minEv < maxEv ) ) throw new Error( 'baked view has a bad table shape' );

	const n = size * size * size;
	const planes = raw.subarray( 8 + length );
	if ( planes.length !== n * 6 ) throw new Error( `baked view holds ${planes.length} bytes of table, expected ${n * 6}` );

	const data = new Uint16Array( n * 4 );
	for ( let ch = 0; ch < 3; ch ++ ) {

		let prev = 0;
		for ( let i = 0; i < n; i ++ ) {

			if ( i % size === 0 ) prev = 0;
			prev = ( prev + ( ( planes[ ch * n + i ] << 8 ) | planes[ 3 * n + ch * n + i ] ) ) & 0xffff;
			data[ i * 4 + ch ] = prev;

		}

	}

	for ( let i = 0; i < n; i ++ ) data[ i * 4 + 3 ] = HALF_ONE;

	return { ...header, data };

}

/**
 * What a config package is, byte for byte: a baked view is only trusted against the files it was
 * baked from. Null when this context has no WebCrypto (plain http).
 *
 * @returns {Promise<?string>}
 */
export async function configFingerprint( { builtin, text, files = [], configPath = 'config.ocio' } = {} ) {

	if ( builtin ) return `builtin:${builtin}`;

	const subtle = globalThis.crypto?.subtle;
	if ( ! subtle ) return null;

	const hex = buffer => Array.from( new Uint8Array( buffer ), b => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );
	const digest = async data => hex( await subtle.digest( 'SHA-256', data ) );

	const lines = await Promise.all( files.map( async f => `${f.relativePath ?? f.path ?? f.name}:${await digest( f.data )}` ) );
	if ( text !== undefined ) lines.push( `text:${await digest( new TextEncoder().encode( text ) )}` );
	lines.sort();
	lines.unshift( `config:${configPath}` );

	return `sha256:${await digest( new TextEncoder().encode( lines.join( '\n' ) ) )}`;

}
