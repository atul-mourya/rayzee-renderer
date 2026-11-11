// A Ptex file writer for tests, laid out as PtexWriter.cpp writes one: header, extended header, zipped face info and
// constant data, level info, then each level (its zipped face headers and the faces' blocks). Levels past 0 hold the
// faces 2^r smaller, box-filtered, in Ptex's reduction order (smaller side, largest first; a constant face as 1).
import { zlibSync } from 'three/addons/libs/fflate.module.js';
import { DataUtils } from 'three';

const BYTES = [ 1, 2, 2, 4 ];

/** A face's texels in [0, 1], interleaved, row v = 0 first. */
export const texelsOf = ( w, h, nc, at ) => {

	const out = new Float32Array( w * h * nc );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) for ( let c = 0; c < nc; c ++ ) out[ ( y * w + x ) * nc + c ] = at( x, y, c );
	return out;

};

function store( values, dataType ) {

	const out = new Uint8Array( values.length * BYTES[ dataType ] );
	const view = new DataView( out.buffer );
	values.forEach( ( v, i ) => {

		if ( dataType === 0 ) out[ i ] = Math.round( v * 255 );
		else if ( dataType === 1 ) view.setUint16( i * 2, Math.round( v * 65535 ), true );
		else if ( dataType === 2 ) view.setUint16( i * 2, DataUtils.toHalfFloat( v ), true );
		else view.setFloat32( i * 4, v, true );

	} );
	return out;

}

/** Stored values back as the reader gives them, for exact comparisons. */
export function quantize( values, dataType ) {

	const bytes = store( values, dataType ), view = new DataView( bytes.buffer );
	return Float32Array.from( values, ( _, i ) => dataType === 0 ? bytes[ i ] / 255 : dataType === 1 ? view.getUint16( i * 2, true ) / 65535
		: dataType === 2 ? DataUtils.fromHalfFloat( view.getUint16( i * 2, true ) ) : view.getFloat32( i * 4, true ) );

}

function reduce( values, w, h, nc ) {

	const out = new Float32Array( ( w / 2 ) * ( h / 2 ) * nc );
	for ( let y = 0; y < h / 2; y ++ ) for ( let x = 0; x < w / 2; x ++ ) for ( let c = 0; c < nc; c ++ ) {

		const at = ( dx, dy ) => values[ ( ( 2 * y + dy ) * w + 2 * x + dx ) * nc + c ];
		out[ ( y * ( w / 2 ) + x ) * nc + c ] = ( at( 0, 0 ) + at( 1, 0 ) + at( 0, 1 ) + at( 1, 1 ) ) / 4;

	}

	return out;

}

/** A block's bytes and header: planar channels, zipped, uint8 and uint16 as differences when `diff`. */
function block( values, w, h, nc, dataType, diff ) {

	const planar = new Float32Array( values.length );
	for ( let c = 0; c < nc; c ++ ) for ( let i = 0; i < w * h; i ++ ) planar[ c * w * h + i ] = values[ i * nc + c ];
	const raw = store( planar, dataType );
	const differences = diff && dataType <= 1;
	if ( differences && dataType === 0 ) for ( let i = raw.length - 1; i > 0; i -- ) raw[ i ] = ( raw[ i ] - raw[ i - 1 ] ) & 0xff;
	if ( differences && dataType === 1 ) {

		const view = new DataView( raw.buffer );
		for ( let i = raw.length / 2 - 1; i > 0; i -- ) view.setUint16( i * 2, ( view.getUint16( i * 2, true ) - view.getUint16( i * 2 - 2, true ) ) & 0xffff, true );

	}

	const bytes = zlibSync( raw );
	return { bytes, header: ( bytes.length | ( ( differences ? 2 : 1 ) << 30 ) ) >>> 0 };

}

/**
 * `faces`: [ { ulog2, vlog2, values (interleaved, [0, 1]) | constant: [ … ], adjFaces: [ 4 ], adjEdges: [ 4 ], tile: [ ulog2, vlog2 ] } ].
 * Returns the file's bytes.
 */
export function writePtex( { meshType = 1, dataType = 0, channels = 3, faces, diff = true, uBorder = 0, vBorder = 0 } ) {

	const nc = channels, n = faces.length;
	const pixel = ( values ) => {

		const mean = new Float32Array( nc );
		for ( let i = 0; i < values.length; i ++ ) mean[ i % nc ] += values[ i ] / ( values.length / nc );
		return mean;

	};

	const faceInfo = new Uint8Array( n * 20 ), fv = new DataView( faceInfo.buffer );
	const constant = new Float32Array( n * nc );
	faces.forEach( ( face, f ) => {

		faceInfo[ f * 20 ] = face.ulog2;
		faceInfo[ f * 20 + 1 ] = face.vlog2;
		faceInfo[ f * 20 + 2 ] = ( face.adjEdges ?? [ 0, 0, 0, 0 ] ).reduce( ( bits, e, k ) => bits | ( e << ( 2 * k ) ), 0 );
		faceInfo[ f * 20 + 3 ] = face.constant ? 1 : 0;
		( face.adjFaces ?? [ - 1, - 1, - 1, - 1 ] ).forEach( ( a, k ) => fv.setInt32( f * 20 + 4 + k * 4, a, true ) );
		constant.set( face.constant ?? pixel( face.values ), f * nc );

	} );

	// Reduction order: the smaller side, largest first, a constant face as 1; ties by face id.
	const key = ( f ) => ( faces[ f ].constant ? 1 : Math.min( faces[ f ].ulog2, faces[ f ].vlog2 ) );
	const order = faces.map( ( _, f ) => f ).sort( ( a, b ) => key( b ) - key( a ) || a - b );
	const levels = [];
	for ( let r = 0; ; r ++ ) {

		const members = r === 0 ? faces.map( ( _, f ) => f ) : order.filter( ( f ) => ! faces[ f ].constant && Math.min( faces[ f ].ulog2, faces[ f ].vlog2 ) >= r );
		if ( r > 0 && members.length === 0 ) break;
		const headers = new Uint32Array( members.length ), blocks = [];
		members.forEach( ( f, i ) => {

			const face = faces[ f ];
			if ( face.constant ) return;
			let values = face.values, w = 1 << face.ulog2, h = 1 << face.vlog2;
			for ( let k = 0; k < r; k ++, w /= 2, h /= 2 ) values = reduce( values, w, h, nc );
			if ( r === 0 && face.tile ) {

				const tw = 1 << face.tile[ 0 ], th = 1 << face.tile[ 1 ], tiles = [];
				for ( let ty = 0; ty < h / th; ty ++ ) for ( let tx = 0; tx < w / tw; tx ++ ) {

					tiles.push( block( texelsOf( tw, th, nc, ( x, y, c ) => values[ ( ( ty * th + y ) * w + tx * tw + x ) * nc + c ] ), tw, th, nc, dataType, diff ) );

				}

				const tileHeaders = zlibSync( new Uint8Array( Uint32Array.from( tiles, ( t ) => t.header ).buffer ) );
				const head = new Uint8Array( 6 );
				head[ 0 ] = face.tile[ 0 ];
				head[ 1 ] = face.tile[ 1 ];
				new DataView( head.buffer ).setUint32( 2, tileHeaders.length, true );
				const bytes = concat( [ head, tileHeaders, ...tiles.map( ( t ) => t.bytes ) ] );
				headers[ i ] = ( bytes.length | ( 3 << 30 ) ) >>> 0;
				blocks.push( bytes );
				return;

			}

			const b = block( values, w, h, nc, dataType, diff );
			headers[ i ] = b.header;
			blocks.push( b.bytes );

		} );
		const zipped = zlibSync( new Uint8Array( headers.buffer ) );
		levels.push( { headerBytes: zipped.length, faces: members.length, bytes: concat( [ zipped, ...blocks ] ) } );

	}

	const zippedInfo = zlibSync( faceInfo ), zippedConst = zlibSync( store( constant, dataType ) );
	const header = new Uint8Array( 64 ), hv = new DataView( header.buffer );
	hv.setUint32( 0, 0x78657450, true );
	hv.setUint32( 4, 1, true );
	hv.setUint32( 8, meshType, true );
	hv.setUint32( 12, dataType, true );
	hv.setInt32( 16, - 1, true );
	hv.setUint16( 20, nc, true );
	hv.setUint16( 22, levels.length, true );
	hv.setUint32( 24, n, true );
	hv.setUint32( 28, 40, true );
	hv.setUint32( 32, zippedInfo.length, true );
	hv.setUint32( 36, zippedConst.length, true );
	hv.setUint32( 40, levels.length * 16, true );
	hv.setBigUint64( 48, BigInt( levels.reduce( ( s, l ) => s + l.bytes.length, 0 ) ), true );
	const ext = new Uint8Array( 40 ), ev = new DataView( ext.buffer );
	ev.setUint16( 0, uBorder, true );
	ev.setUint16( 4, vBorder, true );
	const levelInfo = new Uint8Array( levels.length * 16 ), lv = new DataView( levelInfo.buffer );
	levels.forEach( ( l, r ) => {

		lv.setBigUint64( r * 16, BigInt( l.bytes.length ), true );
		lv.setUint32( r * 16 + 8, l.headerBytes, true );
		lv.setUint32( r * 16 + 12, l.faces, true );

	} );
	return concat( [ header, ext, zippedInfo, zippedConst, levelInfo, ...levels.map( ( l ) => l.bytes ) ] );

}

function concat( parts ) {

	const out = new Uint8Array( parts.reduce( ( s, p ) => s + p.length, 0 ) );
	let at = 0;
	for ( const p of parts ) {

		out.set( p, at );
		at += p.length;

	}

	return out;

}

/** A reader over bytes, as the loaders hand one to readPtexInfo. */
export const reader = ( bytes ) => async ( start, end ) => bytes.subarray( start, end );
