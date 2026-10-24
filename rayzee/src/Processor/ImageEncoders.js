/**
 * File writers for saved pictures: PNG (8 or 16 bits a channel), OpenEXR (half or float, extra layers), Radiance HDR,
 * and JPEG / WebP through the platform's canvas. Pixels in, a Blob out, top row first; nothing here touches the GPU.
 * Compression uses the platform's CompressionStream, which exists in browsers and Node alike. Published as
 * `rayzee/encoders`, never through `rayzee`'s main file: `exportImage()` loads it on first use.
 */

export const IMAGE_FORMATS = Object.freeze( {
	png: { mimeType: 'image/png', extension: 'png' },
	jpeg: { mimeType: 'image/jpeg', extension: 'jpg' },
	webp: { mimeType: 'image/webp', extension: 'webp' },
	exr: { mimeType: 'image/x-exr', extension: 'exr' },
	hdr: { mimeType: 'image/vnd.radiance', extension: 'hdr' },
	heic: { mimeType: 'image/heic', extension: 'heic' },
	avif: { mimeType: 'image/avif', extension: 'avif' },
} );

const HALF_MAX = 65504;

const CRC_TABLE = /*@__PURE__*/ ( () => {

	const table = new Uint32Array( 256 );
	for ( let n = 0; n < 256; n ++ ) {

		let c = n;
		for ( let k = 0; k < 8; k ++ ) c = c & 1 ? 0xEDB88320 ^ ( c >>> 1 ) : c >>> 1;
		table[ n ] = c >>> 0;

	}

	return table;

} )();

/** CRC-32 as PNG and zip use it; pass the previous result to continue over several pieces. */
export function crc32( bytes, crc = 0 ) {

	let c = ~ crc;
	for ( let i = 0; i < bytes.length; i ++ ) c = CRC_TABLE[ ( c ^ bytes[ i ] ) & 0xFF ] ^ ( c >>> 8 );
	return ~ c >>> 0;

}

const ZLIB_PIECE = 1 << 19;

/** The zlib format (RFC 1950), which PNG and EXR's ZIP compression both store. Fed in pieces: each is one task. */
async function zlib( bytes ) {

	const stream = new CompressionStream( 'deflate' );
	const writer = stream.writable.getWriter();
	const compressed = new Response( stream.readable ).arrayBuffer();
	const pace = pacer();
	for ( let at = 0; at < bytes.length; at += ZLIB_PIECE ) {

		await writer.write( bytes.subarray( at, at + ZLIB_PIECE ) );
		await pace();

	}

	await writer.close();
	return new Uint8Array( await compressed );

}

const utf8 = text => new TextEncoder().encode( text );

// Long loops hand the page back this often, so a saving picture never freezes it.
const YIELD_MS = 16;

function pacer() {

	let since = performance.now();
	return async () => {

		if ( performance.now() - since < YIELD_MS ) return;
		await new Promise( resolve => setTimeout( resolve, 0 ) );
		since = performance.now();

	};

}

// ─── PNG ──────────────────────────────────────────────────────────────────────────────────────────

const PNG_SIGNATURE = new Uint8Array( [ 137, 80, 78, 71, 13, 10, 26, 10 ] );
const IDAT_PIECE = 1 << 18;

function pngChunk( type, body ) {

	const out = new Uint8Array( 12 + body.length );
	const view = new DataView( out.buffer );
	view.setUint32( 0, body.length );
	for ( let i = 0; i < 4; i ++ ) out[ 4 + i ] = type.charCodeAt( i );
	out.set( body, 8 );
	view.setUint32( 8 + body.length, crc32( out.subarray( 4, 8 + body.length ) ) );
	return out;

}

// iTXt, so any text survives; keywords are Latin-1, 1–79 bytes.
function pngText( key, value ) {

	const keyword = String( key ).replace( /[^\x20-\x7E]/g, '' ).slice( 0, 79 ) || 'Comment';
	const text = utf8( String( value ) );
	const body = new Uint8Array( keyword.length + 5 + text.length );
	for ( let i = 0; i < keyword.length; i ++ ) body[ i ] = keyword.charCodeAt( i );
	body.set( text, keyword.length + 5 );
	return pngChunk( 'iTXt', body );

}

/**
 * @param {Object} image
 * @param {Uint8Array|Uint8ClampedArray|Uint16Array} image.data - RGBA, 8 or 16 bits a channel by its type
 * @param {number} image.width
 * @param {number} image.height
 * @param {boolean} [image.alpha=true] - false writes RGB
 * @param {'srgb'|'display-p3'} [image.colorSpace='srgb'] - what the values are encoded for
 * @param {Object<string, string>} [image.text] - written as iTXt chunks
 * @returns {Promise<Blob>}
 */
export async function encodePNG( { data, width, height, alpha = true, colorSpace = 'srgb', text = {} } ) {

	const wide = data instanceof Uint16Array;
	const channels = alpha ? 4 : 3;
	const bpp = channels * ( wide ? 2 : 1 );
	const rowBytes = width * bpp;
	const raw = new Uint8Array( height * ( rowBytes + 1 ) );
	const bytes = wide ? null : new Uint8Array( data.buffer, data.byteOffset, data.byteLength );
	let prev = new Uint8Array( rowBytes );
	let row = new Uint8Array( rowBytes );
	const pace = pacer();

	for ( let y = 0; y < height; y ++ ) {

		if ( ! wide && alpha ) {

			row.set( bytes.subarray( y * rowBytes, ( y + 1 ) * rowBytes ) );

		} else {

			let o = 0;
			for ( let x = 0, i = y * width * 4; x < width; x ++, i += 4 ) {

				for ( let c = 0; c < channels; c ++ ) {

					if ( wide ) {

						row[ o ++ ] = data[ i + c ] >>> 8;
						row[ o ++ ] = data[ i + c ] & 0xFF;

					} else row[ o ++ ] = bytes[ i + c ];

				}

			}

		}

		// Paeth throughout: on rendered pictures it compresses best of the five, and row 0 reduces it to Sub.
		const base = y * ( rowBytes + 1 );
		raw[ base ] = 4;
		for ( let i = 0; i < rowBytes; i ++ ) {

			const a = i >= bpp ? row[ i - bpp ] : 0;
			const b = prev[ i ];
			const c = i >= bpp ? prev[ i - bpp ] : 0;
			const pa = b > c ? b - c : c - b;
			const pb = a > c ? a - c : c - a;
			const pc = a + b > c + c ? a + b - c - c : c + c - a - b;
			raw[ base + 1 + i ] = row[ i ] - ( pa <= pb && pa <= pc ? a : pb <= pc ? b : c );

		}

		[ prev, row ] = [ row, prev ];
		await pace();

	}

	const ihdr = new Uint8Array( 13 );
	const header = new DataView( ihdr.buffer );
	header.setUint32( 0, width );
	header.setUint32( 4, height );
	ihdr[ 8 ] = wide ? 16 : 8;
	ihdr[ 9 ] = alpha ? 6 : 2;

	const parts = [ PNG_SIGNATURE, pngChunk( 'IHDR', ihdr ) ];
	if ( colorSpace === 'display-p3' ) {

		// cICP for readers that know it (P3 primaries, sRGB curve, full range), the ICC profile for the rest.
		parts.push( pngChunk( 'cICP', new Uint8Array( [ 12, 13, 0, 1 ] ) ) );
		const name = utf8( 'Display P3' );
		const profile = await zlib( displayP3Profile() );
		const iccp = new Uint8Array( name.length + 2 + profile.length );
		iccp.set( name );
		iccp.set( profile, name.length + 2 );
		parts.push( pngChunk( 'iCCP', iccp ) );

	} else {

		parts.push( pngChunk( 'sRGB', new Uint8Array( [ 0 ] ) ) );

	}

	for ( const [ key, value ] of Object.entries( text ) ) parts.push( pngText( key, value ) );

	const compressed = await zlib( raw );
	for ( let at = 0; at < compressed.length; at += IDAT_PIECE ) {

		parts.push( pngChunk( 'IDAT', compressed.subarray( at, at + IDAT_PIECE ) ) );
		await pace();

	}

	parts.push( pngChunk( 'IEND', new Uint8Array( 0 ) ) );

	return new Blob( parts, { type: IMAGE_FORMATS.png.mimeType } );

}

// ─── ICC (Display P3) ─────────────────────────────────────────────────────────────────────────────

// ICC's PCS illuminant, exactly as the spec encodes it.
const D50_S15 = [ 0xF6D6, 0x10000, 0xD32D ];
const BRADFORD = [ 0.8951, 0.2664, - 0.1614, - 0.7502, 1.7135, 0.0367, 0.0389, - 0.0685, 1.0296 ];

const mul3 = ( a, b ) => Array.from( { length: 9 }, ( _, k ) => {

	const r = Math.floor( k / 3 ), c = k % 3;
	return a[ r * 3 ] * b[ c ] + a[ r * 3 + 1 ] * b[ 3 + c ] + a[ r * 3 + 2 ] * b[ 6 + c ];

} );

function inv3( m ) {

	const [ a, b, c, d, e, f, g, h, i ] = m;
	const A = e * i - f * h, B = - ( d * i - f * g ), C = d * h - e * g;
	const det = a * A + b * B + c * C;
	return [ A, - ( b * i - c * h ), b * f - c * e, B, a * i - c * g, - ( a * f - c * d ), C, - ( a * h - b * g ), a * e - b * d ].map( v => v / det );

}

const xyToXYZ = ( x, y ) => [ x / y, 1, ( 1 - x - y ) / y ];

/** RGB → XYZ for primaries and a white point given as xy, row-major. */
export function primariesToXYZ( [ rx, ry, gx, gy, bx, by ], [ wx, wy ] ) {

	const [ r, g, b ] = [ xyToXYZ( rx, ry ), xyToXYZ( gx, gy ), xyToXYZ( bx, by ) ];
	const P = [ r[ 0 ], g[ 0 ], b[ 0 ], r[ 1 ], g[ 1 ], b[ 1 ], r[ 2 ], g[ 2 ], b[ 2 ] ];
	const w = xyToXYZ( wx, wy );
	const Pi = inv3( P );
	const S = [ 0, 1, 2 ].map( r2 => Pi[ r2 * 3 ] * w[ 0 ] + Pi[ r2 * 3 + 1 ] * w[ 1 ] + Pi[ r2 * 3 + 2 ] * w[ 2 ] );
	return P.map( ( v, k ) => v * S[ k % 3 ] );

}

function bradford( src, dst ) {

	const cone = xyz => [ 0, 1, 2 ].map( r => BRADFORD[ r * 3 ] * xyz[ 0 ] + BRADFORD[ r * 3 + 1 ] * xyz[ 1 ] + BRADFORD[ r * 3 + 2 ] * xyz[ 2 ] );
	const s = cone( src ), d = cone( dst );
	const scale = [ d[ 0 ] / s[ 0 ], 0, 0, 0, d[ 1 ] / s[ 1 ], 0, 0, 0, d[ 2 ] / s[ 2 ] ];
	return mul3( inv3( BRADFORD ), mul3( scale, BRADFORD ) );

}

const DISPLAY_P3 = { primaries: [ 0.680, 0.320, 0.265, 0.690, 0.150, 0.060 ], white: [ 0.3127, 0.3290 ] };

const D65 = [ 0.3127, 0.3290 ];

/** The canvas colour spaces' chromaticities, for light decoded from a picture shown in them. */
export const DISPLAY_CHROMATICITIES = Object.freeze( {
	srgb: [ 0.64, 0.33, 0.30, 0.60, 0.15, 0.06, ...D65 ],
	'display-p3': [ ...DISPLAY_P3.primaries, ...DISPLAY_P3.white ],
} );
const ACES_WHITE = [ 0.32168, 0.33767 ];
const GAMUTS = [
	{ primaries: [ 0.64, 0.33, 0.30, 0.60, 0.15, 0.06 ], white: D65 },
	{ primaries: [ 0.708, 0.292, 0.170, 0.797, 0.131, 0.046 ], white: D65 },
	DISPLAY_P3,
	{ primaries: [ 0.7347, 0.2653, 0.0, 1.0, 0.0001, - 0.077 ], white: ACES_WHITE },
	{ primaries: [ 0.713, 0.293, 0.165, 0.830, 0.128, 0.044 ], white: ACES_WHITE },
	{ primaries: [ 0.8, 0.3177, 0.18, 0.9, 0.065, - 0.0805 ], white: D65 },
];

/**
 * A colour space's chromaticities as files record them. Measured through a config they arrive adapted to D65 (ACES's
 * own white is lost on the way), so a known gamut — Rec.709, Rec.2020, P3, ACES AP0 and AP1, E-Gamut — is written with
 * its own primaries and white; anything else as measured.
 * @param {number[]} measured - red, green, blue and white xy, adapted to D65
 * @returns {number[]}
 */
export function standardChromaticities( measured ) {

	const toD65 = xyToXYZ( ...D65 );
	for ( const { primaries, white } of GAMUTS ) {

		const m = mul3( bradford( xyToXYZ( ...white ), toD65 ), primariesToXYZ( primaries, white ) );
		const adapted = [ 0, 1, 2 ].flatMap( c => {

			const sum = m[ c ] + m[ 3 + c ] + m[ 6 + c ];
			return [ m[ c ] / sum, m[ 3 + c ] / sum ];

		} );
		if ( adapted.every( ( v, i ) => Math.abs( v - measured[ i ] ) < 2e-3 ) ) return [ ...primaries, ...white ];

	}

	return measured;

}

let p3Profile = null;

/** An ICC v4 display profile: Display P3 primaries, D65 white, the sRGB curve. */
export function displayP3Profile() {

	if ( p3Profile ) return p3Profile;

	const chad = bradford( xyToXYZ( ...DISPLAY_P3.white ), D50_S15.map( v => v / 65536 ) );
	const toD50 = mul3( chad, primariesToXYZ( DISPLAY_P3.primaries, DISPLAY_P3.white ) );
	const s15 = v => Math.round( v * 65536 );

	const mluc = text => {

		const units = [ ...text ].map( ch => ch.charCodeAt( 0 ) );
		const out = new DataView( new ArrayBuffer( 28 + units.length * 2 ) );
		[ 0x6D6C7563, 0, 1, 12, 0x656E5553, units.length * 2, 28 ].forEach( ( v, i ) => out.setUint32( i * 4, v ) );
		units.forEach( ( u, i ) => out.setUint16( 28 + i * 2, u ) );
		return out;

	};

	const xyz = values => {

		const out = new DataView( new ArrayBuffer( 20 ) );
		out.setUint32( 0, 0x58595A20 );
		values.forEach( ( v, i ) => out.setInt32( 8 + i * 4, v ) );
		return out;

	};

	const para = new DataView( new ArrayBuffer( 32 ) );
	para.setUint32( 0, 0x70617261 );
	para.setUint16( 8, 3 );
	[ 2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045 ].forEach( ( v, i ) => para.setInt32( 12 + i * 4, s15( v ) ) );

	const sf32 = new DataView( new ArrayBuffer( 44 ) );
	sf32.setUint32( 0, 0x73663332 );
	chad.forEach( ( v, i ) => sf32.setInt32( 8 + i * 4, s15( v ) ) );

	const column = c => xyz( [ toD50[ c ], toD50[ 3 + c ], toD50[ 6 + c ] ].map( s15 ) );
	const shared = para;
	const tags = [
		[ 'desc', mluc( 'Display P3' ) ], [ 'cprt', mluc( 'No copyright, use freely' ) ], [ 'wtpt', xyz( D50_S15 ) ],
		[ 'rXYZ', column( 0 ) ], [ 'gXYZ', column( 1 ) ], [ 'bXYZ', column( 2 ) ],
		[ 'rTRC', shared ], [ 'gTRC', shared ], [ 'bTRC', shared ], [ 'chad', sf32 ],
	];

	const pad4 = n => ( n + 3 ) & ~ 3;
	let at = 128 + 4 + tags.length * 12;
	const placed = new Map();
	const table = tags.map( ( [ sig, data ] ) => {

		if ( ! placed.has( data ) ) {

			placed.set( data, at );
			at += pad4( data.byteLength );

		}

		return [ sig, placed.get( data ), data.byteLength ];

	} );

	const bytes = new Uint8Array( at );
	const view = new DataView( bytes.buffer );
	const fourcc = ( offset, s ) => {

		for ( let i = 0; i < 4; i ++ ) bytes[ offset + i ] = s.charCodeAt( i );

	};

	view.setUint32( 0, at );
	view.setUint32( 8, 0x04300000 );
	fourcc( 12, 'mntr' );
	fourcc( 16, 'RGB ' );
	fourcc( 20, 'XYZ ' );
	[ 2026, 1, 1, 0, 0, 0 ].forEach( ( v, i ) => view.setUint16( 24 + i * 2, v ) );
	fourcc( 36, 'acsp' );
	D50_S15.forEach( ( v, i ) => view.setInt32( 68 + i * 4, v ) );
	view.setUint32( 128, tags.length );
	table.forEach( ( [ sig, offset, size ], i ) => {

		fourcc( 132 + i * 12, sig );
		view.setUint32( 136 + i * 12, offset );
		view.setUint32( 140 + i * 12, size );

	} );
	for ( const [ data, offset ] of placed ) bytes.set( new Uint8Array( data.buffer ), offset );

	p3Profile = bytes;
	return bytes;

}

// ─── OpenEXR ──────────────────────────────────────────────────────────────────────────────────────

const EXR_TYPES = { half: 1, float: 2 };
const EXR_COMPRESSION = { none: 0, zip: 3 };
const ZIP_LINES = 16;

// Float32 bits → half bits, rounded to nearest even. Callers clamp to ±HALF_MAX first.
function halfBits( f ) {

	const sign = ( f >>> 16 ) & 0x8000;
	const exp = ( ( f >>> 23 ) & 0xFF ) - 112;
	let mant = f & 0x7FFFFF;
	if ( exp <= 0 ) {

		if ( exp < - 10 ) return sign;
		mant |= 0x800000;
		const shift = 14 - exp;
		let h = mant >>> shift;
		const rem = mant & ( ( 1 << shift ) - 1 ), half = 1 << ( shift - 1 );
		if ( rem > half || ( rem === half && ( h & 1 ) ) ) h ++;
		return sign | h;

	}

	let h = ( exp << 10 ) | ( mant >>> 13 );
	const rem = mant & 0x1FFF;
	if ( rem > 0x1000 || ( rem === 0x1000 && ( h & 1 ) ) ) h ++;
	return sign | Math.min( h, 0x7BFF );

}

// Float16Array where the platform has it; it rounds the same way.
const HalfRow = typeof Float16Array === 'function'
	? class {

		constructor( n ) {

			this.values = new Float16Array( n );
			this.bytes = new Uint8Array( this.values.buffer );

		}

		set( x, v ) {

			this.values[ x ] = v;

		}

	}
	: class {

		constructor( n ) {

			this.bits = new Uint16Array( n );
			this.bytes = new Uint8Array( this.bits.buffer );
			this._f = new Float32Array( 1 );
			this._u = new Uint32Array( this._f.buffer );

		}

		set( x, v ) {

			this._f[ 0 ] = v;
			this.bits[ x ] = halfBits( this._u[ 0 ] );

		}

	};

class FloatRow {

	constructor( n ) {

		this.values = new Float32Array( n );
		this.bytes = new Uint8Array( this.values.buffer );

	}

	set( x, v ) {

		this.values[ x ] = v;

	}

}

function exrAttribute( name, type, value ) {

	const n = utf8( name ), t = utf8( type );
	const out = new Uint8Array( n.length + t.length + 6 + value.length );
	out.set( n );
	out.set( t, n.length + 1 );
	new DataView( out.buffer ).setUint32( n.length + t.length + 2, value.length, true );
	out.set( value, n.length + t.length + 6 );
	return out;

}

function le( build, size ) {

	const out = new Uint8Array( size );
	build( new DataView( out.buffer ) );
	return out;

}

/**
 * One part, scanlines, top line first. Channels are written in name order, as the format requires; a layer's channels
 * share a prefix (`albedo.R`), and readers show the unprefixed R, G, B, A as the picture.
 *
 * @param {Object} image
 * @param {number} image.width
 * @param {number} image.height
 * @param {Array<{name: string, data: ArrayLike<number>, stride?: number, offset?: number, type?: 'half'|'float'}>} image.channels -
 *   each reads `data[ pixel * stride + offset ]`
 * @param {'zip'|'none'} [image.compression='zip']
 * @param {?number[]} [image.chromaticities] - red, green, blue and white xy
 * @param {Object<string, string>} [image.text] - written as string attributes
 * @returns {Promise<Blob>}
 */
export async function encodeEXR( { width, height, channels, compression = 'zip', chromaticities = null, text = {} } ) {

	const list = [ ...channels ].sort( ( a, b ) => ( a.name < b.name ? - 1 : a.name > b.name ? 1 : 0 ) );
	const bytesPer = list.map( c => ( c.type === 'float' ? 4 : 2 ) );
	const lineBytes = bytesPer.reduce( ( sum, b ) => sum + b * width, 0 );
	const linesPerBlock = compression === 'zip' ? ZIP_LINES : 1;
	const blocks = Math.ceil( height / linesPerBlock );

	const names = list.map( c => utf8( c.name ) );
	const chlist = new Uint8Array( names.reduce( ( sum, n ) => sum + n.length + 17, 1 ) );
	let at = 0;
	list.forEach( ( c, i ) => {

		chlist.set( names[ i ], at );
		at += names[ i ].length + 1;
		const view = new DataView( chlist.buffer, at, 16 );
		view.setInt32( 0, EXR_TYPES[ c.type ?? 'half' ], true );
		view.setInt32( 8, 1, true );
		view.setInt32( 12, 1, true );
		at += 16;

	} );

	const box = le( v => [ 0, 0, width - 1, height - 1 ].forEach( ( n, i ) => v.setInt32( i * 4, n, true ) ), 16 );
	const header = [
		exrAttribute( 'channels', 'chlist', chlist ),
		exrAttribute( 'compression', 'compression', new Uint8Array( [ EXR_COMPRESSION[ compression ] ] ) ),
		exrAttribute( 'dataWindow', 'box2i', box ),
		exrAttribute( 'displayWindow', 'box2i', box ),
		exrAttribute( 'lineOrder', 'lineOrder', new Uint8Array( [ 0 ] ) ),
		exrAttribute( 'pixelAspectRatio', 'float', le( v => v.setFloat32( 0, 1, true ), 4 ) ),
		exrAttribute( 'screenWindowCenter', 'v2f', new Uint8Array( 8 ) ),
		exrAttribute( 'screenWindowWidth', 'float', le( v => v.setFloat32( 0, 1, true ), 4 ) ),
	];
	if ( chromaticities ) header.push( exrAttribute( 'chromaticities', 'chromaticities', le( v => chromaticities.forEach( ( n, i ) => v.setFloat32( i * 4, n, true ) ), 32 ) ) );
	for ( const [ key, value ] of Object.entries( text ) ) header.push( exrAttribute( key, 'string', utf8( String( value ) ) ) );

	const rows = list.map( c => ( c.type === 'float' ? new FloatRow( width ) : new HalfRow( width ) ) );
	const pack = b => {

		const first = b * linesPerBlock;
		const lines = Math.min( linesPerBlock, height - first );
		const out = new Uint8Array( lines * lineBytes );
		let o = 0;
		for ( let y = first; y < first + lines; y ++ ) {

			list.forEach( ( c, k ) => {

				const stride = c.stride ?? 1, src = c.data, row = rows[ k ];
				let i = y * width * stride + ( c.offset ?? 0 );
				if ( c.type === 'float' ) {

					for ( let x = 0; x < width; x ++, i += stride ) row.set( x, src[ i ] );

				} else {

					for ( let x = 0; x < width; x ++, i += stride ) {

						const v = src[ i ];
						row.set( x, v > HALF_MAX ? HALF_MAX : v < - HALF_MAX ? - HALF_MAX : v === v ? v : 0 );

					}

				}

				out.set( row.bytes.subarray( 0, width * bytesPer[ k ] ), o );
				o += width * bytesPer[ k ];

			} );

		}

		return out;

	};

	const packed = new Array( blocks );
	const pending = [];
	const pace = pacer();
	for ( let b = 0; b < blocks; b ++ ) {

		await pace();
		const raw = pack( b );
		if ( compression !== 'zip' ) {

			packed[ b ] = raw;
			continue;

		}

		pending.push( zipBlock( raw ).then( data => {

			packed[ b ] = data.length < raw.length ? data : raw;

		} ) );
		if ( pending.length >= 16 ) await Promise.all( pending.splice( 0 ) );

	}

	await Promise.all( pending );

	const headerBytes = 8 + header.reduce( ( sum, a ) => sum + a.length, 0 ) + 1;
	const longNames = [ ...list.map( c => c.name ), ...Object.keys( text ) ].some( name => utf8( name ).length > 31 );
	const offsets = new DataView( new ArrayBuffer( blocks * 8 ) );
	const parts = [ le( v => {

		v.setUint32( 0, 20000630, true );
		v.setUint32( 4, longNames ? 0x402 : 2, true );

	}, 8 ), ...header, new Uint8Array( 1 ), offsets ];

	let position = headerBytes + blocks * 8;
	packed.forEach( ( data, b ) => {

		offsets.setBigUint64( b * 8, BigInt( position ), true );
		parts.push( le( v => {

			v.setInt32( 0, b * linesPerBlock, true );
			v.setInt32( 4, data.length, true );

		}, 8 ), data );
		position += 8 + data.length;

	} );

	return new Blob( parts, { type: IMAGE_FORMATS.exr.mimeType } );

}

// OpenEXR's ZIP: bytes split into even and odd halves, delta-coded, then zlib.
async function zipBlock( raw ) {

	const n = raw.length;
	const tmp = new Uint8Array( n );
	for ( let s = 0, t1 = 0, t2 = ( n + 1 ) >> 1; s < n; ) {

		tmp[ t1 ++ ] = raw[ s ++ ];
		if ( s < n ) tmp[ t2 ++ ] = raw[ s ++ ];

	}

	let p = tmp[ 0 ];
	for ( let t = 1; t < n; t ++ ) {

		const d = tmp[ t ] - p + 384;
		p = tmp[ t ];
		tmp[ t ] = d;

	}

	return zlib( tmp );

}

// ─── Radiance HDR ─────────────────────────────────────────────────────────────────────────────────

function rleChannel( src, out, at ) {

	const n = src.length;
	let i = 0;
	while ( i < n ) {

		let run = 1;
		while ( i + run < n && run < 127 && src[ i + run ] === src[ i ] ) run ++;
		if ( run > 2 ) {

			out[ at ++ ] = 128 + run;
			out[ at ++ ] = src[ i ];
			i += run;
			continue;

		}

		let count = 0;
		while ( i + count < n && count < 128 ) {

			const j = i + count;
			if ( j + 2 < n && src[ j ] === src[ j + 1 ] && src[ j ] === src[ j + 2 ] ) break;
			count ++;

		}

		out[ at ++ ] = count;
		for ( let k = 0; k < count; k ++ ) out[ at ++ ] = src[ i + k ];
		i += count;

	}

	return at;

}

/**
 * RGBE, run-length coded scanlines, top line first. Alpha is dropped and negatives clamp to 0.
 * @param {Object} image
 * @param {Float32Array} image.data - RGBA
 * @param {number} image.width
 * @param {number} image.height
 * @param {?number[]} [image.chromaticities] - red, green, blue and white xy, as the PRIMARIES line
 * @param {Object<string, string>} [image.text] - written as header comments
 * @returns {Promise<Blob>}
 */
export async function encodeHDR( { data, width, height, chromaticities = null, text = {} } ) {

	const lines = [ '#?RADIANCE' ];
	for ( const [ key, value ] of Object.entries( text ) ) lines.push( `# ${key}: ${String( value ).replace( /\s+/g, ' ' )}` );
	lines.push( 'FORMAT=32-bit_rle_rgbe' );
	if ( chromaticities ) lines.push( `PRIMARIES= ${chromaticities.map( v => v.toFixed( 4 ) ).join( ' ' )}` );
	const header = utf8( `${lines.join( '\n' )}\n\n-Y ${height} +X ${width}\n` );

	const planes = [ 0, 1, 2, 3 ].map( () => new Uint8Array( width ) );
	const flat = width < 8 || width > 0x7FFF;
	const body = new Uint8Array( height * ( flat ? width * 4 : 4 + width * 5 ) );
	const pace = pacer();
	let at = 0;

	for ( let y = 0; y < height; y ++ ) {

		await pace();

		for ( let x = 0, i = y * width * 4; x < width; x ++, i += 4 ) {

			const r = Math.max( 0, data[ i ] || 0 ), g = Math.max( 0, data[ i + 1 ] || 0 ), b = Math.max( 0, data[ i + 2 ] || 0 );
			const v = Math.max( r, g, b );
			if ( v < 1e-32 ) {

				planes[ 0 ][ x ] = planes[ 1 ][ x ] = planes[ 2 ][ x ] = planes[ 3 ][ x ] = 0;
				continue;

			}

			const e = Math.ceil( Math.log2( v ) + 1e-9 );
			const scale = 256 / 2 ** e;
			planes[ 0 ][ x ] = Math.min( 255, r * scale );
			planes[ 1 ][ x ] = Math.min( 255, g * scale );
			planes[ 2 ][ x ] = Math.min( 255, b * scale );
			planes[ 3 ][ x ] = e + 128;

		}

		if ( flat ) {

			for ( let x = 0; x < width; x ++ ) for ( let c = 0; c < 4; c ++ ) body[ at ++ ] = planes[ c ][ x ];
			continue;

		}

		body.set( [ 2, 2, width >> 8, width & 0xFF ], at );
		at += 4;
		for ( const plane of planes ) at = rleChannel( plane, body, at );

	}

	return new Blob( [ header, body.subarray( 0, at ) ], { type: IMAGE_FORMATS.hdr.mimeType } );

}

// ─── JPEG and WebP ────────────────────────────────────────────────────────────────────────────────

/** Whether this platform can write `type` through a canvas (JPEG and WebP have no writer here). */
export function canEncodeWithCanvas() {

	return typeof OffscreenCanvas === 'function' && typeof ImageData === 'function';

}

/**
 * @param {Object} image
 * @param {Uint8ClampedArray} image.data - RGBA
 * @param {number} image.width
 * @param {number} image.height
 * @param {'srgb'|'display-p3'} [image.colorSpace='srgb']
 * @param {'jpeg'|'webp'} image.format
 * @param {number} [image.quality=0.92] - 0–1
 * @param {Object<string, string>} [image.text] - JPEG: a comment segment
 * @returns {Promise<Blob>}
 */
export async function encodeWithCanvas( { data, width, height, colorSpace = 'srgb', format, quality = 0.92, text = {} } ) {

	if ( ! canEncodeWithCanvas() ) throw new Error( `${format} needs OffscreenCanvas, which this platform lacks; save as png, exr or hdr` );

	const canvas = new OffscreenCanvas( width, height );
	const pixels = data instanceof Uint8ClampedArray ? data : new Uint8ClampedArray( data.buffer, data.byteOffset, data.byteLength );
	canvas.getContext( '2d', { colorSpace } ).putImageData( new ImageData( pixels, width, height, { colorSpace } ), 0, 0 );
	const blob = await canvas.convertToBlob( { type: IMAGE_FORMATS[ format ].mimeType, quality } );
	if ( format !== 'jpeg' || ! Object.keys( text ).length ) return blob;

	// A COM segment right after the start marker.
	const comment = utf8( Object.entries( text ).map( ( [ k, v ] ) => `${k}: ${v}` ).join( '\n' ) ).subarray( 0, 65533 );
	const segment = new Uint8Array( 4 + comment.length );
	segment.set( [ 0xFF, 0xFE, ( comment.length + 2 ) >> 8, ( comment.length + 2 ) & 0xFF ] );
	segment.set( comment, 4 );
	return new Blob( [ blob.slice( 0, 2 ), segment, blob.slice( 2 ) ], { type: blob.type } );

}

// ─── HDR photo: JPEG with a gain map (ISO 21496-1 and Ultra HDR) ─────────────────────────────────

const GAIN_OFFSET = 1 / 64;
const XMP_NAMESPACE = 'http://ns.adobe.com/xap/1.0/';
const ISO_NAMESPACE = 'urn:iso:std:iso:ts:21496:-1';
const ISO_DENOMINATOR = 1000000;

function jpegParts( bytes ) {

	const segments = [];
	let at = 2;
	while ( at + 4 <= bytes.length && bytes[ at ] === 0xFF && bytes[ at + 1 ] !== 0xDA ) {

		const length = ( bytes[ at + 2 ] << 8 ) | bytes[ at + 3 ];
		segments.push( bytes.subarray( at, at + 2 + length ) );
		at += 2 + length;

	}

	return { segments, scan: bytes.subarray( at ) };

}

function segment( marker, ...payload ) {

	const length = payload.reduce( ( sum, p ) => sum + p.length, 2 );
	const out = new Uint8Array( 2 + length );
	out.set( [ 0xFF, marker, length >> 8, length & 0xFF ] );
	let at = 4;
	for ( const p of payload ) {

		out.set( p, at );
		at += p.length;

	}

	return out;

}

const named = ( namespace, body ) => [ utf8( `${namespace}\0` ), body ];
const isICC = s => s[ 1 ] === 0xE2 && String.fromCharCode( ...s.subarray( 4, 15 ) ) === 'ICC_PROFILE';

function gainMapXMP( attributes, items = '' ) {

	return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.1.2"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
		+ `<rdf:Description rdf:about="" xmlns:hdrgm="http://ns.adobe.com/hdr-gain-map/1.0/"${items ? ' xmlns:Container="http://ns.google.com/photos/1.0/container/" xmlns:Item="http://ns.google.com/photos/1.0/container/item/"' : ''} hdrgm:Version="1.0"${attributes}>`
		+ `${items}</rdf:Description></rdf:RDF></x:xmpmeta>`;

}

function primaryXMP( gainMapLength ) {

	const item = ( semantic, extra = '' ) => `<rdf:li rdf:parseType="Resource"><Container:Item Item:Semantic="${semantic}" Item:Mime="image/jpeg"${extra}/></rdf:li>`;
	return gainMapXMP( '', `<Container:Directory><rdf:Seq>${item( 'Primary' )}${item( 'GainMap', ` Item:Length="${gainMapLength}"` )}</rdf:Seq></Container:Directory>` );

}

/** log2 of HDR over SDR light per channel, scaled into an 8-bit RGBA map over [ min, max ]. @private */
async function gainMapPixels( sdr, hdr, count ) {

	const decoded = Float32Array.from( { length: 256 }, ( _, v ) => {

		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + 0.055 ) / 1.055, 2.4 );

	} );

	const gains = new Float32Array( count * 3 );
	const pace = pacer();
	let min = 0, max = 0;
	for ( let p = 0; p < count; p ++ ) {

		for ( let c = 0; c < 3; c ++ ) {

			const g = Math.log2( ( Math.max( hdr[ p * 4 + c ], 0 ) + GAIN_OFFSET ) / ( decoded[ sdr[ p * 4 + c ] ] + GAIN_OFFSET ) );
			gains[ p * 3 + c ] = g;
			if ( g < min ) min = g;
			if ( g > max ) max = g;

		}

		if ( ( p & 0xFFFF ) === 0 ) await pace();

	}

	max = Math.max( max, min + 1 / 64 );
	const map = new Uint8ClampedArray( count * 4 );
	const scale = 255 / ( max - min );
	for ( let p = 0; p < count; p ++ ) {

		for ( let c = 0; c < 3; c ++ ) map[ p * 4 + c ] = ( gains[ p * 3 + c ] - min ) * scale + 0.5;
		map[ p * 4 + 3 ] = 255;

	}

	// The headroom the HDR version needs in full: past it the gain is applied whole, below it in part.
	return { map, min, max, headroom: Math.max( max, 1 / 64 ) };

}

// One set of parameters for all three channels, applied in the base picture's colour space.
export function isoMetadata( { min, max, headroom } ) {

	const view = new DataView( new ArrayBuffer( 61 ) );
	const n = v => Math.round( v * ISO_DENOMINATOR );
	view.setUint8( 4, 1 << 6 );
	[ 0, 1, n( headroom ), ISO_DENOMINATOR ].forEach( ( v, i ) => view.setUint32( 5 + i * 4, v ) );
	[ n( min ), ISO_DENOMINATOR, n( max ), ISO_DENOMINATOR, 1, 1, 1, 64, 1, 64 ].forEach( ( v, i ) => ( i % 2 ? view.setUint32( 21 + i * 4, v ) : view.setInt32( 21 + i * 4, v ) ) );
	return new Uint8Array( view.buffer );

}

function multiPicture( primarySize, gainMapSize, gainMapOffset ) {

	const view = new DataView( new ArrayBuffer( 86 ) );
	[ 0x4D504600, 0x4D4D002A, 8 ].forEach( ( v, i ) => view.setUint32( i * 4, v ) );
	view.setUint16( 12, 3 );
	const tag = ( at, id, type, count, value ) => {

		view.setUint16( at, id );
		view.setUint16( at + 2, type );
		view.setUint32( at + 4, count );
		view.setUint32( at + 8, value );

	};

	tag( 14, 0xB000, 7, 4, 0x30313030 );
	tag( 26, 0xB001, 4, 1, 2 );
	tag( 38, 0xB002, 7, 32, 50 );
	[ 0x030000, primarySize, 0, 0, gainMapSize, gainMapOffset ].forEach( ( v, i ) => view.setUint32( 54 + i * 4 + ( i >= 3 ? 4 : 0 ), v ) );
	return new Uint8Array( view.buffer );

}

/**
 * An HDR photo: the SDR picture as a JPEG every viewer shows, plus a gain map to the HDR version, which viewers that
 * know gain maps (ISO 21496-1 and Ultra HDR: macOS Preview and Photos, Chrome, Safari, Android) show on an HDR screen.
 * Both renditions are display light in the same primaries, 1 = SDR white; the SDR one arrives encoded.
 * @param {Object} image
 * @param {Uint8ClampedArray} image.sdr - RGBA, sRGB-encoded
 * @param {Float32Array} image.hdr - RGBA, linear
 * @param {number} image.width
 * @param {number} image.height
 * @param {'srgb'|'display-p3'} [image.colorSpace='srgb']
 * @param {number} [image.quality=0.92]
 * @param {Object<string, string>} [image.text]
 * @returns {Promise<Blob>}
 */
export async function encodeGainMapJPEG( { sdr, hdr, width, height, colorSpace = 'srgb', quality = 0.92, text = {} } ) {

	const gain = await gainMapPixels( sdr, hdr, width * height );
	const base = new Uint8Array( await ( await encodeWithCanvas( { data: sdr, width, height, colorSpace, format: 'jpeg', quality, text } ) ).arrayBuffer() );
	const map = new Uint8Array( await ( await encodeWithCanvas( { data: gain.map, width, height, format: 'jpeg', quality: 0.95 } ) ).arrayBuffer() );
	return jpegWithGainMap( base, map, gain );

}

/**
 * Two JPEGs as one Ultra HDR / ISO 21496-1 file, laid out as libultrahdr lays it out: the picture with its XMP item
 * directory, ISO version and a Multi-Picture Format index before its scan, then the gain map with its parameters.
 * @param {Uint8Array} baseBytes
 * @param {Uint8Array} mapBytes
 * @param {{min: number, max: number, headroom: number}} gain - log2 range of the map and the headroom it needs
 * @returns {Blob}
 */
export function jpegWithGainMap( baseBytes, mapBytes, { min, max, headroom } ) {

	const base = jpegParts( baseBytes );
	const gainMap = jpegParts( mapBytes );
	const f = v => Number( v.toFixed( 6 ) );
	const xmp = gainMapXMP( ` hdrgm:GainMapMin="${f( min )}" hdrgm:GainMapMax="${f( max )}" hdrgm:Gamma="1" hdrgm:OffsetSDR="${GAIN_OFFSET}" hdrgm:OffsetHDR="${GAIN_OFFSET}" hdrgm:HDRCapacityMin="0" hdrgm:HDRCapacityMax="${f( headroom )}" hdrgm:BaseRenditionIsHDR="False"` );
	const secondary = [
		new Uint8Array( [ 0xFF, 0xD8 ] ),
		segment( 0xE1, ...named( XMP_NAMESPACE, utf8( xmp ) ) ),
		segment( 0xE2, ...named( ISO_NAMESPACE, isoMetadata( { min, max, headroom } ) ) ),
		...gainMap.segments.filter( s => ! isICC( s ) ),
		gainMap.scan,
	];
	const secondarySize = secondary.reduce( ( sum, p ) => sum + p.length, 0 );

	const head = [
		new Uint8Array( [ 0xFF, 0xD8 ] ),
		...base.segments.filter( s => s[ 1 ] === 0xE0 ),
		segment( 0xE1, ...named( XMP_NAMESPACE, utf8( primaryXMP( secondarySize ) ) ) ),
		...base.segments.filter( isICC ),
		segment( 0xE2, ...named( ISO_NAMESPACE, new Uint8Array( 4 ) ) ),
		...base.segments.filter( s => s[ 1 ] < 0xE0 || s[ 1 ] > 0xEF ),
	];
	const mpfAt = head.reduce( ( sum, p ) => sum + p.length, 0 );
	const primarySize = mpfAt + 4 + 86 + base.scan.length;
	const mpf = segment( 0xE2, multiPicture( primarySize, secondarySize, primarySize - mpfAt - 8 ) );

	return new Blob( [ ...head, mpf, base.scan, ...secondary ], { type: IMAGE_FORMATS.jpeg.mimeType } );

}

// ─── HEIC and AVIF: one frame from the platform's video encoder, in a HEIF container ─────────────

const pixelsAbove = ( width, height, ...limits ) => limits.findIndex( l => width * height <= l );

const STILL_CODECS = {
	heic: {
		brands: [ 'heic', 'mif1', 'heic' ], item: 'hvc1', even: true,
		codec: ( w, h ) => `hvc1.1.6.L${[ 123, 153 ][ pixelsAbove( w, h, 2228224, 8912896 ) ] ?? 183}.B0`,
		options: { hevc: { format: 'hevc' } },
		quantizer: q => ( { hevc: { quantizer: q } } ),
		maxQuantizer: 51,
	},
	avif: {
		brands: [ 'avif', 'avif', 'mif1', 'miaf', 'MA1B' ], item: 'av01', even: false,
		codec: ( w, h ) => `av01.0.${[ '08', '13' ][ pixelsAbove( w, h, 2228224, 8912896 ) ] ?? '16'}M.08`,
		options: {},
		quantizer: q => ( { av1: { quantizer: q } } ),
		maxQuantizer: 63,
	},
};

const stillSize = ( format, width, height ) => ( STILL_CODECS[ format ].even ? { width: width & ~ 1, height: height & ~ 1 } : { width, height } );

/** Whether this platform's video encoder can write `format` ('heic' or 'avif') at this size. */
export async function canEncodeStill( format, width = 1920, height = 1080 ) {

	if ( typeof VideoEncoder === 'undefined' || ! STILL_CODECS[ format ] ) return false;
	const spec = STILL_CODECS[ format ];
	try {

		return ( await VideoEncoder.isConfigSupported( { codec: spec.codec( width, height ), ...stillSize( format, width, height ), bitrateMode: 'quantizer', framerate: 1, ...spec.options } ) ).supported === true;

	} catch {

		return false;

	}

}

const prepared = {};

/**
 * Starts the platform's encoder for `format` without encoding anything, once a page. Chrome (macOS) takes ~5 s to start
 * its first hardware video encoder after a launch, HEVC or H.264 alike, and ~2 ms after; an encoder asked for meanwhile
 * waits only for what is left. Nothing on screen stalls while it starts.
 * @returns {Promise<boolean>} whether it started
 */
export function prepareStill( format ) {

	return prepared[ format ] ??= ( async () => {

		if ( ! await canEncodeStill( format, 64, 64 ) ) return false;
		const spec = STILL_CODECS[ format ];
		const encoder = new VideoEncoder( { output() {}, error() {} } );
		try {

			encoder.configure( { codec: spec.codec( 64, 64 ), width: 64, height: 64, bitrateMode: 'quantizer', framerate: 1, ...spec.options } );
			await encoder.flush();
			return true;

		} catch {

			return false;

		} finally {

			if ( encoder.state !== 'closed' ) encoder.close();

		}

	} )();

}

// AV1's record is built from the sequence header the encoder wrote: profile 0, 8-bit 4:2:0, the level asked for.
function av1Record( codec, sequenceHeader ) {

	const level = Number( codec.split( '.' )[ 2 ].slice( 0, 2 ) );
	const out = new Uint8Array( 4 + sequenceHeader.length );
	out.set( [ 0x81, level, 0x0C, 0 ] );
	out.set( sequenceHeader, 4 );
	return out;

}

// AV1 open bitstream units, without temporal delimiters (an image item holds none); the sequence header apart.
function av1Units( data ) {

	const kept = [];
	let sequenceHeader = null;
	for ( let at = 0; at < data.length; ) {

		const header = data[ at ];
		const type = ( header >> 3 ) & 15;
		let o = at + 1 + ( ( header >> 2 ) & 1 );
		let size = 0;
		for ( let shift = 0; ; shift += 7 ) {

			const b = data[ o ++ ];
			size += ( b & 0x7F ) * 2 ** shift;
			if ( ! ( b & 0x80 ) ) break;

		}

		const unit = data.subarray( at, o + size );
		if ( type === 1 ) sequenceHeader ??= unit;
		if ( type !== 2 ) kept.push( unit );
		at = o + size;

	}

	return { data: concat( kept ), sequenceHeader };

}

function concat( parts ) {

	const out = new Uint8Array( parts.reduce( ( sum, p ) => sum + p.length, 0 ) );
	let at = 0;
	for ( const p of parts ) {

		out.set( p, at );
		at += p.length;

	}

	return out;

}

async function encodeFrame( format, rgba, width, height, quality ) {

	const spec = STILL_CODECS[ format ];
	const size = stillSize( format, width, height );
	const codec = spec.codec( size.width, size.height );
	const chunks = [];
	let config = null, failure = null;
	const encoder = new VideoEncoder( {
		output: ( chunk, meta ) => {

			const data = new Uint8Array( chunk.byteLength );
			chunk.copyTo( data );
			chunks.push( data );
			config ??= meta?.decoderConfig ?? null;

		},
		error: e => {

			failure = e;

		},
	} );

	try {

		encoder.configure( { codec, ...size, bitrateMode: 'quantizer', framerate: 1, ...spec.options } );
		// Labelled Rec.709 whatever the primaries: only the RGB to YUV matrix applies, and no gamut conversion may.
		const frame = new VideoFrame( new Uint8Array( rgba.buffer, rgba.byteOffset, rgba.byteLength ), {
			format: 'RGBA', codedWidth: width, codedHeight: height, timestamp: 0, visibleRect: { x: 0, y: 0, ...size },
			colorSpace: { primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true },
		} );
		const q = Math.round( Math.min( spec.maxQuantizer, Math.max( 0, 8 + ( 1 - quality ) * 150 ) ) );
		encoder.encode( frame, { keyFrame: true, ...spec.quantizer( q ) } );
		frame.close();
		await encoder.flush();

	} finally {

		if ( encoder.state !== 'closed' ) encoder.close();

	}

	if ( failure ) throw failure;
	const bitstream = concat( chunks );
	const space = config?.colorSpace ?? {};
	const yuv = { matrix: { bt709: 1, bt470bg: 5, smpte170m: 6, bt2020: 9 }[ space.matrix ] ?? 1, fullRange: !! space.fullRange };
	if ( format === 'heic' ) {

		const d = config.description;
		return { ...size, data: bitstream, record: ArrayBuffer.isView( d ) ? new Uint8Array( d.buffer, d.byteOffset, d.byteLength ) : new Uint8Array( d ), ...yuv };

	}

	const units = av1Units( bitstream );
	return { ...size, data: units.data, record: av1Record( codec, units.sequenceHeader ), ...yuv };

}

const u8 = ( ...v ) => new Uint8Array( v );
const u16 = v => u8( v >> 8, v & 0xFF );
const u32 = v => u8( ( v >>> 24 ) & 0xFF, ( v >> 16 ) & 0xFF, ( v >> 8 ) & 0xFF, v & 0xFF );
const fourcc = t => utf8( t );

function box( type, ...parts ) {

	const body = concat( parts );
	return concat( [ u32( body.length + 8 ), fourcc( type ), body ] );

}

const fullBox = ( type, version, flags, ...parts ) => box( type, u8( version, ( flags >> 16 ) & 0xFF, ( flags >> 8 ) & 0xFF, flags & 0xFF ), ...parts );
const nclx = ( primaries, transfer, matrix, fullRange ) => box( 'colr', fourcc( 'nclx' ), u16( primaries ), u16( transfer ), u16( matrix ), u8( fullRange ? 0x80 : 0 ) );

/**
 * A HEIF file of one picture, and with a gain map a 'tmap' item to its HDR version (ISO/IEC 23008-12 and ISO 21496-1,
 * laid out as libavif lays it out): the picture is the primary item, the tone-mapped item its preferred alternative.
 */
export function heifFile( format, { base, primaries, gainMap = null, toneMap = null } ) {

	const spec = STILL_CODECS[ format ];
	const items = [ { id: 1, type: spec.item, data: base.data } ];
	if ( gainMap ) items.push( { id: 2, type: 'tmap', data: toneMap }, { id: 3, type: spec.item, data: gainMap.data, hidden: true } );

	const properties = [
		fullBox( 'ispe', 0, 0, u32( base.width ), u32( base.height ) ),
		fullBox( 'pixi', 0, 0, u8( 3, 8, 8, 8 ) ),
		box( format === 'heic' ? 'hvcC' : 'av1C', base.record ),
		nclx( primaries, 13, base.matrix, base.fullRange ),
	];
	const associations = [[ 1, [ 1, 2, 3 | 0x80, 4 ]]];
	if ( gainMap ) {

		properties.push(
			nclx( primaries, 8, 0, true ),
			box( format === 'heic' ? 'hvcC' : 'av1C', gainMap.record ),
			nclx( 2, 2, gainMap.matrix, gainMap.fullRange ),
		);
		associations.push( [ 2, [ 1, 5 ]], [ 3, [ 1, 2, 6 | 0x80, 7 ]] );

	}

	const meta = offsets => fullBox( 'meta', 0, 0,
		fullBox( 'hdlr', 0, 0, u32( 0 ), fourcc( 'pict' ), u32( 0 ), u32( 0 ), u32( 0 ), u8( 0 ) ),
		fullBox( 'pitm', 0, 0, u16( 1 ) ),
		fullBox( 'iloc', 0, 0, u8( 0x44, 0 ), u16( items.length ), ...items.map( ( item, i ) => concat( [ u16( item.id ), u16( 0 ), u16( 1 ), u32( offsets[ i ] ), u32( item.data.length ) ] ) ) ),
		fullBox( 'iinf', 0, 0, u16( items.length ), ...items.map( item => fullBox( 'infe', 2, item.hidden ? 1 : 0, u16( item.id ), u16( 0 ), fourcc( item.type ), u8( 0 ) ) ) ),
		...( gainMap ? [ fullBox( 'iref', 0, 0, box( 'dimg', u16( 2 ), u16( 2 ), u16( 1 ), u16( 3 ) ) ) ] : [] ),
		box( 'iprp',
			box( 'ipco', ...properties ),
			fullBox( 'ipma', 0, 0, u32( associations.length ), ...associations.map( ( [ id, list ] ) => concat( [ u16( id ), u8( list.length ), u8( ...list ) ] ) ) ),
		),
		...( gainMap ? [ box( 'grpl', fullBox( 'altr', 0, 0, u32( 4 ), u32( 2 ), u32( 2 ), u32( 1 ) ) ) ] : [] ),
	);

	const [ major, ...compatible ] = spec.brands;
	const ftyp = box( 'ftyp', fourcc( major ), u32( 0 ), ...compatible.map( fourcc ), ...( gainMap ? [ fourcc( 'tmap' ) ] : [] ) );
	const metaLength = meta( items.map( () => 0 ) ).length;
	let at = ftyp.length + metaLength + 8;
	const offsets = items.map( item => {

		const offset = at;
		at += item.data.length;
		return offset;

	} );

	const mdat = items.map( item => item.data );
	return new Blob( [ ftyp, meta( offsets ), u32( 8 + mdat.reduce( ( sum, d ) => sum + d.length, 0 ) ), fourcc( 'mdat' ), ...mdat ], { type: IMAGE_FORMATS[ format ].mimeType } );

}

/**
 * HEIC (HEVC) or AVIF (AV1) through the platform's video encoder, 8 bits 4:2:0. With `hdr`, an HDR photo as the gain-map
 * JPEG is one: the SDR picture plus a gain map to the HDR version, which HEIF viewers that know 'tmap' items show in HDR.
 * HEVC needs even sides, so an odd last column or row is dropped.
 * @param {Object} image
 * @param {'heic'|'avif'} image.format
 * @param {Uint8ClampedArray} image.sdr - RGBA, sRGB-encoded
 * @param {?Float32Array} [image.hdr] - RGBA, linear, 1 = SDR white
 * @param {number} image.width
 * @param {number} image.height
 * @param {'srgb'|'display-p3'} [image.colorSpace='srgb']
 * @param {number} [image.quality=0.92]
 * @returns {Promise<Blob>}
 */
export async function encodeStill( { format, sdr, hdr = null, width, height, colorSpace = 'srgb', quality = 0.92 } ) {

	if ( ! await canEncodeStill( format, width, height ) ) throw new Error( `${format} needs a video encoder this platform lacks; save as png, jpeg or exr` );
	const primaries = colorSpace === 'display-p3' ? 12 : 1;
	const base = await encodeFrame( format, sdr, width, height, quality );
	if ( ! hdr ) return heifFile( format, { base, primaries } );

	const gain = await gainMapPixels( sdr, hdr, width * height );
	const gainMap = await encodeFrame( format, gain.map, width, height, Math.max( quality, 0.95 ) );
	return heifFile( format, { base, primaries, gainMap, toneMap: concat( [ u8( 0 ), isoMetadata( gain ) ] ) } );

}
