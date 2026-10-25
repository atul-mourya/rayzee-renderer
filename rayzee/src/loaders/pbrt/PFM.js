import { DataTexture, FloatType, LinearFilter, RGBAFormat } from 'three';

/**
 * Portable float map: "PF" (RGB) or "Pf" (grey), width and height, then a scale whose sign is the byte
 * order, then rows bottom first — the order three's EXR and HDR loaders fill a DataTexture in.
 * A scale other than ±1 multiplies the pixels, as pbrt reads it.
 * @param {Uint8Array} bytes
 * @returns {{ data: Float32Array, width: number, height: number }} RGBA, row 0 the bottom
 */
export function decodePFM( bytes ) {

	let pos = 0;
	const token = () => {

		while ( pos < bytes.length && bytes[ pos ] <= 32 ) pos ++;
		const start = pos;
		while ( pos < bytes.length && bytes[ pos ] > 32 ) pos ++;
		return String.fromCharCode( ...bytes.subarray( start, pos ) );

	};

	const magic = token();
	if ( magic !== 'PF' && magic !== 'Pf' ) throw new Error( 'not a PFM image' );
	const width = parseInt( token(), 10 );
	const height = parseInt( token(), 10 );
	const scale = parseFloat( token() );
	pos ++;

	const channels = magic === 'PF' ? 3 : 1;
	const count = width * height;
	if ( ! ( width > 0 && height > 0 ) || ! Number.isFinite( scale ) || scale === 0 ) throw new Error( 'bad PFM header' );
	if ( bytes.length - pos < count * channels * 4 ) throw new Error( 'PFM image is truncated' );

	const view = new DataView( bytes.buffer, bytes.byteOffset + pos, count * channels * 4 );
	const little = scale < 0;
	const gain = Math.abs( scale );
	const data = new Float32Array( count * 4 );
	for ( let i = 0; i < count; i ++ ) {

		for ( let c = 0; c < 3; c ++ ) data[ i * 4 + c ] = view.getFloat32( ( i * channels + ( channels === 3 ? c : 0 ) ) * 4, little ) * gain;
		data[ i * 4 + 3 ] = 1;

	}

	return { data, width, height };

}

/** @param {Uint8Array} bytes */
export function pfmTexture( bytes ) {

	const { data, width, height } = decodePFM( bytes );
	const texture = new DataTexture( data, width, height, RGBAFormat, FloatType );
	texture.minFilter = LinearFilter;
	texture.magFilter = LinearFilter;
	texture.needsUpdate = true;
	return texture;

}
