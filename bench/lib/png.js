/**
 * PNG read/write helpers for the bench harness.
 *
 * Only dependency is `pngjs`. Images are plain `{ width, height, data }` objects with
 * `data` as RGBA bytes, which is what the compare/probe code and `canvas.toDataURL()`
 * both speak.
 */

import { constants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';

import { PNG } from 'pngjs';

const DATA_URL_PREFIX = 'data:image/png;base64,';

/**
 * Wrap a decoded pngjs image as `{ width, height, data }`.
 * The Uint8ClampedArray is a view over the pngjs Buffer, not a copy.
 *
 * @param {PNG} png Decoded pngjs image.
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
function toImage( png ) {

	// pngjs normalises palette/16-bit to 8-bit RGBA, so this should always hold; assert it
	// rather than hand callers a buffer whose stride is not 4 bytes per pixel.
	const expected = png.width * png.height * 4;

	if ( png.data.length !== expected ) {

		throw new Error( `Expected ${expected} RGBA bytes for ${png.width}x${png.height}, got ${png.data.length}.` );

	}

	return {
		width: png.width,
		height: png.height,
		data: new Uint8ClampedArray( png.data.buffer, png.data.byteOffset, png.data.byteLength ),
	};

}

/**
 * Decode the base64 payload of a PNG data URL into a Buffer.
 *
 * @param {string} dataURL A `data:image/png;base64,...` string.
 * @returns {Buffer} Raw PNG bytes.
 */
function base64Payload( dataURL ) {

	if ( typeof dataURL !== 'string' || ! dataURL.startsWith( DATA_URL_PREFIX ) ) {

		const got = typeof dataURL === 'string' ? `'${dataURL.slice( 0, 40 )}...'` : typeof dataURL;
		throw new Error(
			`Expected a '${DATA_URL_PREFIX}...' data URL as produced by ` +
			`canvas.toDataURL( 'image/png' ), got ${got}.`
		);

	}

	return Buffer.from( dataURL.slice( DATA_URL_PREFIX.length ), 'base64' );

}

/**
 * Create the parent directory of a file path, if missing.
 *
 * @param {string} filePath Destination file path.
 * @returns {Promise<void>}
 */
async function ensureParentDir( filePath ) {

	await mkdir( path.dirname( path.resolve( filePath ) ), { recursive: true } );

}

/**
 * Read and decode a PNG file.
 *
 * @param {string} filePath Path to the PNG.
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray }>} RGBA image.
 * @throws {Error} If the file is missing or is not a decodable PNG.
 */
export async function readPNG( filePath ) {

	let buffer;

	try {

		buffer = await readFile( filePath );

	} catch ( error ) {

		if ( error.code === 'ENOENT' ) {

			throw new Error(
				`PNG not found: ${filePath}\n` +
				'If this is a baseline, it has not been blessed yet — run the bench in bless ' +
				'mode to generate it, then re-run the comparison.'
			);

		}

		throw new Error( `Failed to read PNG ${filePath}: ${error.message}` );

	}

	try {

		return toImage( PNG.sync.read( buffer ) );

	} catch ( error ) {

		throw new Error( `Failed to decode PNG ${filePath}: ${error.message}` );

	}

}

/**
 * Encode an RGBA image and write it to disk, creating parent directories.
 *
 * @param {string} filePath Destination path.
 * @param {{ width: number, height: number, data: Uint8ClampedArray|Uint8Array|Buffer }} image RGBA image.
 * @returns {Promise<void>}
 * @throws {Error} If `data` is not exactly `width * height * 4` bytes.
 */
export async function writePNG( filePath, image ) {

	const { width, height, data } = image ?? {};
	const expected = width * height * 4;

	if ( ! data || data.length !== expected ) {

		throw new Error(
			`writePNG( ${filePath} ): expected ${expected} RGBA bytes for ${width}x${height}, ` +
			`got ${data ? data.length : 'no data'}.`
		);

	}

	const png = new PNG( { width, height } );
	png.data.set( data );

	await ensureParentDir( filePath );
	await writeFile( filePath, PNG.sync.write( png ) );

}

/**
 * Decode a `data:image/png;base64,...` string, as produced by `canvas.toDataURL()`.
 *
 * @param {string} dataURL The data URL.
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }} RGBA image.
 * @throws {Error} If the string is not a PNG data URL, or the payload is not a valid PNG.
 */
export function decodeDataURL( dataURL ) {

	const buffer = base64Payload( dataURL );

	try {

		return toImage( PNG.sync.read( buffer ) );

	} catch ( error ) {

		throw new Error( `Failed to decode PNG data URL: ${error.message}` );

	}

}

/**
 * Write the bytes of a PNG data URL straight to disk, creating parent directories.
 * No pngjs re-encode: the stored file is byte-identical to what the browser produced,
 * which is what the determinism check's byte-for-byte comparison relies on.
 *
 * @param {string} filePath Destination path.
 * @param {string} dataURL A `data:image/png;base64,...` string.
 * @returns {Promise<void>}
 */
export async function writeDataURL( filePath, dataURL ) {

	const bytes = base64Payload( dataURL );

	await ensureParentDir( filePath );
	await writeFile( filePath, bytes );

}

/**
 * Test whether a path exists.
 *
 * @param {string} filePath Path to test.
 * @returns {Promise<boolean>} True if the path exists.
 */
export async function exists( filePath ) {

	try {

		await access( filePath, constants.F_OK );
		return true;

	} catch {

		return false;

	}

}
