/**
 * Moving colour between the config's named spaces.
 *
 * Three shapes of caller, three costs:
 *   - one colour (a material tint, a light colour)  — cached, essentially free
 *   - a float buffer (an HDRI, a rendered frame)    — one OCIO call per chunk
 *   - an 8-bit texture                              — expanded to float, converted, re-encoded
 *
 * The 8-bit path re-encodes with the sRGB transfer before quantizing rather than storing linear
 * bytes. Linear 8-bit banding is visible in any dark gradient; the shader already undoes an sRGB
 * curve on these pools, so the encoding costs nothing and the precision is no worse than the
 * texture arrived with.
 */

import { getRuntime, getConfigInfo } from './OcioRuntime.js';

/** Pixels per chunk when converting a large buffer. 1M px = 16 MB of scratch. */
const CHUNK_PIXELS = 1 << 20;

const processorCache = new Map();
const colorCache = new Map();
const COLOR_CACHE_LIMIT = 4096;
const matrixCache = new Map();

function cacheKey( from, to, context ) {

	return `${from}\u0000${to}\u0000${context ? JSON.stringify( context ) : ''}`;

}

/** Drop every cached processor and result. Call when the config or context changes. */
export function clearColorCaches() {

	for ( const p of processorCache.values() ) p.dispose?.();
	processorCache.clear();
	colorCache.clear();
	matrixCache.clear();

}

/**
 * A processor for `from` → `to`, kept for reuse. Building one is the expensive part of OCIO;
 * applying it is not.
 * @returns {Object|null} null when no config is loaded
 */
export function getProcessor( from, to, { context = null } = {} ) {

	const rt = getRuntime();
	if ( ! rt ) return null;
	if ( from === to ) return null;

	const key = cacheKey( from, to, context );
	let p = processorCache.get( key );
	if ( p !== undefined ) return p;

	try {

		const config = configHandle();
		p = config.createColorSpaceProcessor( from, to, context ? { context } : undefined );
		if ( p.isNoOp ) {

			p.dispose();
			p = null;

		}

	} catch ( err ) {

		throw new Error( `no OCIO transform from "${from}" to "${to}": ${err.message}` );

	}

	processorCache.set( key, p );
	return p;

}

/**
 * The live `Config`, which is what builds processors — the runtime wrapper does not.
 *
 * The runtime exposes its own handle; that one belongs to the runtime and must never be disposed
 * here, or every later call fails. Only a handle this module built is this module's to release.
 */
let configHandleCache = null;
let configHandleId = null;
let configHandleOwned = false;

function configHandle() {

	const rt = getRuntime();
	if ( ! rt ) throw new Error( 'no OCIO config loaded' );

	if ( rt.config ) return rt.config;

	const info = getConfigInfo();
	if ( configHandleCache && configHandleId === info.id ) return configHandleCache;

	if ( configHandleOwned ) configHandleCache?.dispose?.();

	if ( ! info.id?.startsWith( 'ocio://' ) ) {

		throw new Error( 'OCIO runtime exposes no Config handle for this config' );

	}

	configHandleCache = rt.ocio.createBuiltinConfig( info.id );
	configHandleOwned = true;
	configHandleId = info.id;
	return configHandleCache;

}

/** Forget the cached Config handle and every processor built from it. */
export function resetConfigHandle() {

	if ( configHandleOwned ) configHandleCache?.dispose?.();
	configHandleCache = null;
	configHandleId = null;
	configHandleOwned = false;
	clearColorCaches();

}

/**
 * One colour, converted. Repeated calls with the same colour are free — a scene with 4,000
 * materials sharing 12 tints costs 12 conversions.
 *
 * @param {number[]|Float32Array} rgb
 * @returns {number[]} a new triple; the input is untouched
 */
export function convertColor( rgb, from, to, { context = null } = {} ) {

	const rt = getRuntime();
	if ( ! rt || from === to ) return [ rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] ];

	const key = `${cacheKey( from, to, context )}\u0000${rgb[ 0 ]},${rgb[ 1 ]},${rgb[ 2 ]}`;
	const hit = colorCache.get( key );
	if ( hit ) return hit.slice();

	const out = rt.transformRgb( from, to, [ rgb[ 0 ], rgb[ 1 ], rgb[ 2 ] ], context ? { context } : undefined );
	// Bounded: a colour picker being dragged is a new colour every frame.
	if ( colorCache.size >= COLOR_CACHE_LIMIT ) colorCache.clear();
	colorCache.set( key, out );
	return out.slice();

}

/**
 * A float RGBA buffer, converted in place. Alpha is left alone.
 * @param {Float32Array} rgba - 4 floats per pixel
 */
export function convertPixelsF32( rgba, from, to, { context = null } = {} ) {

	if ( rgba.length % 4 !== 0 ) throw new Error( 'convertPixelsF32 wants 4 floats per pixel' );

	const processor = getProcessor( from, to, { context } );
	if ( ! processor ) return rgba;

	const pixels = rgba.length / 4;
	if ( pixels <= CHUNK_PIXELS ) {

		processor.applyRGBAF32( rgba );
		return rgba;

	}

	// A view over the same memory, so the chunking costs no copy.
	for ( let start = 0; start < pixels; start += CHUNK_PIXELS ) {

		const count = Math.min( CHUNK_PIXELS, pixels - start );
		processor.applyRGBAF32( rgba.subarray( start * 4, ( start + count ) * 4 ) );

	}

	return rgba;

}

const SRGB_ALPHA = 0.055;

/** sRGB electro-optical transfer function — encoded [0,1] to linear. */
export function srgbToLinear( c ) {

	return c <= 0.04045 ? c / 12.92 : Math.pow( ( c + SRGB_ALPHA ) / ( 1 + SRGB_ALPHA ), 2.4 );

}

/** sRGB opto-electronic transfer function — linear to encoded [0,1]. */
export function linearToSrgb( c ) {

	if ( c <= 0 ) return 0;
	return c <= 0.0031308 ? 12.92 * c : ( 1 + SRGB_ALPHA ) * Math.pow( c, 1 / 2.4 ) - SRGB_ALPHA;

}

const DECODE_255 = new Float32Array( 256 );
for ( let i = 0; i < 256; i ++ ) DECODE_255[ i ] = srgbToLinear( i / 255 );

const LINEAR_255 = new Float32Array( 256 );
for ( let i = 0; i < 256; i ++ ) LINEAR_255[ i ] = i / 255;

/**
 * How stored bytes relate to the values a colour space describes.
 *
 *   'raw'    — the bytes ARE the space's own values; the space's transfer is part of the
 *              transform and must not be undone first
 *   'srgb'   — the bytes are sRGB-encoded and the space is the linear one underneath
 *   'linear' — the bytes are linear
 *
 * Getting this wrong decodes a texture's transfer twice, which lifts every shadow and is easy to
 * mistake for a lighting bug.
 */
function decodeTable( encoding ) {

	if ( encoding === 'srgb' ) return DECODE_255;
	return LINEAR_255;

}


/**
 * An 8-bit RGBA texture, converted in place from `from` to `to`.
 *
 * @param {Uint8Array|Uint8ClampedArray} bytes - 4 bytes per pixel
 * @param {Object} [options]
 * @param {'raw'|'srgb'|'linear'} [options.inputEncoding='raw']
 * @param {'srgb'|'linear'} [options.outputEncoding='srgb']
 */
export function convertEncodedRGBA8( bytes, from, to, {
	context = null, inputEncoding = 'raw', outputEncoding = 'srgb',
} = {} ) {

	if ( bytes.length % 4 !== 0 ) throw new Error( 'convertEncodedRGBA8 wants 4 bytes per pixel' );

	const processor = getProcessor( from, to, { context } );
	if ( ! processor ) return bytes;

	const pixels = bytes.length / 4;
	const decode = decodeTable( inputEncoding );
	const encode = outputEncoding === 'srgb' ? encodeSrgbByte : encodeLinearByte;
	const scratch = new Float32Array( Math.min( CHUNK_PIXELS, pixels ) * 4 );

	for ( let start = 0; start < pixels; start += CHUNK_PIXELS ) {

		const count = Math.min( CHUNK_PIXELS, pixels - start );
		const view = count * 4 === scratch.length ? scratch : scratch.subarray( 0, count * 4 );

		for ( let i = 0; i < count; i ++ ) {

			const s = ( start + i ) * 4, d = i * 4;
			view[ d ] = decode[ bytes[ s ] ];
			view[ d + 1 ] = decode[ bytes[ s + 1 ] ];
			view[ d + 2 ] = decode[ bytes[ s + 2 ] ];
			view[ d + 3 ] = 1;

		}

		processor.applyRGBAF32( view );

		for ( let i = 0; i < count; i ++ ) {

			const s = ( start + i ) * 4, d = i * 4;
			bytes[ s ] = encode( view[ d ] );
			bytes[ s + 1 ] = encode( view[ d + 1 ] );
			bytes[ s + 2 ] = encode( view[ d + 2 ] );

		}

	}

	return bytes;

}

/**
 * Linear [0,1] → sRGB byte, by table.
 *
 * Three `Math.pow` calls a pixel were most of the cost of converting a scene's textures — 3 s of
 * frozen UI on the 642-texture test model. The table is indexed by the square root of the value
 * because the sRGB curve is close to a square root, so its steps are near-even in the output. At
 * 64K entries it is ~50× faster than the exact curve and 0.09 % of values land one level off —
 * only those sitting on a rounding boundary.
 */
const ENCODE_STEPS = 65536;
const ENCODE_SRGB = new Uint8Array( ENCODE_STEPS + 1 );
for ( let i = 0; i <= ENCODE_STEPS; i ++ ) {

	const t = i / ENCODE_STEPS;
	ENCODE_SRGB[ i ] = Math.round( linearToSrgb( t * t ) * 255 );

}

function encodeSrgbByte( v ) {

	if ( ! ( v > 0 ) ) return 0;
	if ( v >= 1 ) return 255;
	return ENCODE_SRGB[ ( Math.sqrt( v ) * ENCODE_STEPS + 0.5 ) | 0 ];

}

function encodeLinearByte( v ) {

	if ( ! ( v > 0 ) ) return 0;
	return v >= 1 ? 255 : ( v * 255 + 0.5 ) | 0;

}

/**
 * A primaries change applied straight to 8-bit pixels, without a round trip through the OCIO
 * runtime per chunk.
 *
 * This is the common case by far — a texture is sRGB or linear Rec.709 and the working space only
 * differs by its primaries — and doing it here is roughly an order of magnitude faster than
 * expanding a 4K texture to float and back through WebAssembly.
 *
 * @param {Uint8Array|Uint8ClampedArray} bytes
 * @param {number[]} m - row-major 3×3, from `extractMatrix`
 * @param {'srgb'|'linear'} [encoding='srgb'] - the encoding the bytes carry, in and out
 */
export function applyMatrixRGBA8( bytes, m, encoding = 'srgb' ) {

	if ( ! m ) return bytes;

	const decode = decodeTable( encoding );
	const encode = encoding === 'srgb' ? encodeSrgbByte : encodeLinearByte;
	const [ m0, m1, m2, m3, m4, m5, m6, m7, m8 ] = m;

	for ( let i = 0; i < bytes.length; i += 4 ) {

		const r = decode[ bytes[ i ] ], g = decode[ bytes[ i + 1 ] ], b = decode[ bytes[ i + 2 ] ];

		bytes[ i ] = encode( m0 * r + m1 * g + m2 * b );
		bytes[ i + 1 ] = encode( m3 * r + m4 * g + m5 * b );
		bytes[ i + 2 ] = encode( m6 * r + m7 * g + m8 * b );

	}

	return bytes;

}

/**
 * The 3×3 matrix for `from` → `to`, row-major, or null when the transform is not a pure matrix.
 *
 * Tested rather than assumed: a transform is only a matrix if it is linear, so this checks
 * superposition and scaling on probe colours instead of trusting the space's name. A primaries
 * change passes; anything carrying a transfer curve, a tone curve or a gamut compressor does not.
 */
export function extractMatrix( from, to, { context = null, tolerance = 1e-4 } = {} ) {

	const rt = getRuntime();
	if ( ! rt ) return null;
	if ( from === to ) return [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ];

	const key = cacheKey( from, to, context );
	if ( matrixCache.has( key ) ) return matrixCache.get( key );

	const processor = getProcessor( from, to, { context } );
	if ( ! processor ) {

		matrixCache.set( key, [ 1, 0, 0, 0, 1, 0, 0, 0, 1 ] );
		return matrixCache.get( key );

	}

	const apply = rgb => {

		const buf = new Float32Array( [ rgb[ 0 ], rgb[ 1 ], rgb[ 2 ], 1 ] );
		processor.applyRGBAF32( buf );
		return [ buf[ 0 ], buf[ 1 ], buf[ 2 ] ];

	};

	const e = [ apply( [ 1, 0, 0 ] ), apply( [ 0, 1, 0 ] ), apply( [ 0, 0, 1 ] ) ];

	// Column j of the matrix is the image of basis vector j.
	const m = [
		e[ 0 ][ 0 ], e[ 1 ][ 0 ], e[ 2 ][ 0 ],
		e[ 0 ][ 1 ], e[ 1 ][ 1 ], e[ 2 ][ 1 ],
		e[ 0 ][ 2 ], e[ 1 ][ 2 ], e[ 2 ][ 2 ],
	];

	const predict = rgb => [
		m[ 0 ] * rgb[ 0 ] + m[ 1 ] * rgb[ 1 ] + m[ 2 ] * rgb[ 2 ],
		m[ 3 ] * rgb[ 0 ] + m[ 4 ] * rgb[ 1 ] + m[ 5 ] * rgb[ 2 ],
		m[ 6 ] * rgb[ 0 ] + m[ 7 ] * rgb[ 1 ] + m[ 8 ] * rgb[ 2 ],
	];

	const probes = [
		[ 0.18, 0.18, 0.18 ], [ 0.5, 0.25, 0.75 ], [ 2.0, 0.1, 0.4 ],
		[ 0.02, 0.9, 0.3 ], [ 8.0, 4.0, 1.0 ], [ 0.001, 0.002, 0.004 ],
	];

	let linear = true;
	for ( const probe of probes ) {

		const got = apply( probe ), want = predict( probe );
		const scale = Math.max( 1e-3, Math.abs( want[ 0 ] ), Math.abs( want[ 1 ] ), Math.abs( want[ 2 ] ) );
		for ( let c = 0; c < 3; c ++ ) {

			if ( Math.abs( got[ c ] - want[ c ] ) > tolerance * scale ) linear = false;

		}

		if ( ! linear ) break;

	}

	const result = linear ? m : null;
	matrixCache.set( key, result );
	return result;

}

/** True when the config marks this space as data (a normal map, a mask) — never colour-managed. */
export function isDataSpace( name ) {

	const info = getConfigInfo();
	if ( ! info ) return false;
	const cs = info.colorSpaces.find( c => c.name === name || c.aliases?.includes( name ) );
	return cs ? cs.isData : false;

}

/** True when the config knows this name (or an alias of it). */
export function hasColorSpace( name ) {

	const info = getConfigInfo();
	if ( ! info || ! name ) return false;
	return info.colorSpaces.some( c => c.name === name || c.aliases?.includes( name ) );

}
