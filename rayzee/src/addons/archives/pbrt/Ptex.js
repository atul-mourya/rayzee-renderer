/**
 * Ptex, Disney's per-face textures (ptex.us): every face of a mesh has texels of its own, found by its face id and
 * its own (u, v). Here they are laid onto pages, ordinary square textures holding many files' faces. Each face is a
 * rectangle of its texels inside a one-texel border taken from its neighbours, so bilinear filtering crosses a face
 * edge much as Ptex's own filters do, and a mesh's uvs are moved onto its faces' rectangles.
 *
 *   const info = await readPtexInfo( read );                    // header and face table
 *   const plan = planPtexPages( infos, { pageSize, maxTexels } ); // where each face goes, how small
 *   const blocks = await readPtexBlocks( info, read, plan.files[ i ] );
 *   writePtexFile( info, blocks, plan.files[ i ], pages, plan.pageSize, power );        // power: ptexPower( encoding )
 *   const { uv, index, copies, pages } = ptexUV( index, uv, faces, plan.files[ i ], plan.pageSize );
 */

import { unzlibSync } from 'three/addons/libs/fflate.module.js';

const MAGIC = 0x78657450; // 'Ptex'
const HEADER_BYTES = 64;
const EXT_HEADER_BYTES = 40;
const FACE_INFO_BYTES = 20;
const LEVEL_INFO_BYTES = 16;
const LARGE_FACE = 0x3fffffff;
const DATA_BYTES = [ 1, 2, 2, 4 ]; // uint8, uint16, half, float
const ENC_CONSTANT = 0, ENC_DIFFZIPPED = 2, ENC_TILED = 3;
const FLAG_CONSTANT = 1;
const BORDER_BLACK = 1, BORDER_PERIODIC = 2;

// Share of a page the shelves are planned to fill.
const PAGE_FILL = 0.85;
// Reads of one level's blocks closer than this are one read.
const READ_GAP = 1 << 20;

function inflate( bytes, size ) {

	const out = unzlibSync( bytes, { out: new Uint8Array( size ) } );
	if ( out.length !== size ) throw new Error( `Ptex: a block inflated to ${out.length} bytes, not ${size}` );
	return out;

}

const isConstant = ( info, f ) => ( info.flags[ f ] & FLAG_CONSTANT ) !== 0;

/**
 * A Ptex file's header, face table, each face's mean and where its levels are, read through `read( start, end )` (a
 * promise of those bytes).
 */
export async function readPtexInfo( read ) {

	const head = await read( 0, HEADER_BYTES + EXT_HEADER_BYTES );
	const view = new DataView( head.buffer, head.byteOffset, head.byteLength );
	if ( head.length < HEADER_BYTES || view.getUint32( 0, true ) !== MAGIC ) throw new Error( 'not a Ptex file' );
	const version = view.getUint32( 4, true );
	if ( version !== 1 ) throw new Error( `Ptex version ${version} is not read` );
	const meshType = view.getUint32( 8, true );
	const dataType = view.getUint32( 12, true );
	if ( meshType > 1 || dataType > 3 ) throw new Error( `Ptex mesh type ${meshType} or data type ${dataType} unknown` );
	const alphaChannel = view.getInt32( 16, true );
	const channels = view.getUint16( 20, true );
	const levelCount = view.getUint16( 22, true );
	const faceCount = view.getUint32( 24, true );
	const extHeaderBytes = view.getUint32( 28, true );
	const faceInfoBytes = view.getUint32( 32, true );
	const constBytes = view.getUint32( 36, true );
	const levelInfoBytes = view.getUint32( 40, true );
	if ( ! channels || ! faceCount || ! levelCount || levelInfoBytes !== levelCount * LEVEL_INFO_BYTES ) throw new Error( 'Ptex header is inconsistent' );
	const ext = extHeaderBytes >= 8 && head.length >= HEADER_BYTES + 8;
	const uBorder = ext ? view.getUint16( HEADER_BYTES, true ) : 0;
	const vBorder = ext ? view.getUint16( HEADER_BYTES + 4, true ) : 0;

	const tablesAt = HEADER_BYTES + extHeaderBytes;
	const tables = await read( tablesAt, tablesAt + faceInfoBytes + constBytes + levelInfoBytes );
	const faces = inflate( tables.subarray( 0, faceInfoBytes ), faceCount * FACE_INFO_BYTES );
	const fv = new DataView( faces.buffer, faces.byteOffset, faces.byteLength );
	const ulog2 = new Uint8Array( faceCount ), vlog2 = new Uint8Array( faceCount ), flags = new Uint8Array( faceCount );
	const adjEdges = new Uint8Array( faceCount ), adjFaces = new Int32Array( faceCount * 4 );
	for ( let f = 0; f < faceCount; f ++ ) {

		const o = f * FACE_INFO_BYTES;
		ulog2[ f ] = faces[ o ];
		vlog2[ f ] = faces[ o + 1 ];
		adjEdges[ f ] = faces[ o + 2 ];
		flags[ f ] = faces[ o + 3 ];
		for ( let e = 0; e < 4; e ++ ) adjFaces[ f * 4 + e ] = fv.getInt32( o + 4 + e * 4, true );

	}

	const constant = toFloat( inflate( tables.subarray( faceInfoBytes, faceInfoBytes + constBytes ), faceCount * channels * DATA_BYTES[ dataType ] ), dataType );
	const levels = [];
	const lv = new DataView( tables.buffer, tables.byteOffset + faceInfoBytes + constBytes, levelInfoBytes );
	let at = tablesAt + faceInfoBytes + constBytes + levelInfoBytes;
	for ( let r = 0; r < levelCount; r ++ ) {

		const bytes = Number( lv.getBigUint64( r * LEVEL_INFO_BYTES, true ) );
		levels.push( { at, bytes, headerBytes: lv.getUint32( r * LEVEL_INFO_BYTES + 8, true ), faces: lv.getUint32( r * LEVEL_INFO_BYTES + 12, true ) } );
		at += bytes;

	}

	// A reduced level lists faces by their smaller side, largest first, a constant face as 1 (PtexUtils genRfaceids).
	const rfaceids = new Uint32Array( faceCount );
	const key = ( f ) => ( isConstant( { flags }, f ) ? 1 : Math.min( ulog2[ f ], vlog2[ f ] ) );
	let next = 0;
	for ( let k = 31; k >= 0; k -- ) for ( let f = 0; f < faceCount; f ++ ) if ( key( f ) === k ) rfaceids[ f ] = next ++;

	// The texture's mean, each face weighed by its texels.
	const mean = new Float32Array( channels );
	let weight = 0;
	for ( let f = 0; f < faceCount; f ++ ) {

		const w = 2 ** ( ulog2[ f ] + vlog2[ f ] );
		for ( let c = 0; c < channels; c ++ ) mean[ c ] += constant[ f * channels + c ] * w;
		weight += w;

	}

	for ( let c = 0; c < channels; c ++ ) mean[ c ] /= weight;

	return {
		meshType: meshType === 0 ? 'triangle' : 'quad', dataType, channels, alphaChannel: alphaChannel < channels ? alphaChannel : - 1,
		faceCount, uBorder, vBorder, ulog2, vlog2, flags, adjEdges, adjFaces, constant, mean, levels, rfaceids,
	};

}

// Not three's DataUtils: the worker would carry all of three.
function fromHalf( h ) {

	const sign = h & 0x8000 ? - 1 : 1, e = ( h >> 10 ) & 0x1f, m = h & 0x3ff;
	if ( e === 0 ) return sign * m * 2 ** - 24;
	if ( e === 31 ) return m ? NaN : sign * Infinity;
	return sign * ( 1 + m / 1024 ) * 2 ** ( e - 15 );

}

/** Texel values in [0, 1] (half and float as stored). */
function toFloat( bytes, dataType ) {

	const n = bytes.length / DATA_BYTES[ dataType ];
	const out = new Float32Array( n );
	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	switch ( dataType ) {

		case 0: for ( let i = 0; i < n; i ++ ) out[ i ] = bytes[ i ] / 255; break;
		case 1: for ( let i = 0; i < n; i ++ ) out[ i ] = view.getUint16( i * 2, true ) / 65535; break;
		case 2: for ( let i = 0; i < n; i ++ ) out[ i ] = fromHalf( view.getUint16( i * 2, true ) ); break;
		default: for ( let i = 0; i < n; i ++ ) out[ i ] = view.getFloat32( i * 4, true );

	}

	return out;

}

/** One level's face headers and where each face's block starts and ends: its zipped headers, then large faces' sizes. */
async function levelTable( level, read ) {

	const headers = new Uint32Array( inflate( await read( level.at, level.at + level.headerBytes ), level.faces * 4 ).buffer );
	let large = 0;
	for ( let i = 0; i < level.faces; i ++ ) if ( ( headers[ i ] & LARGE_FACE ) === LARGE_FACE ) large ++;
	const sizes = large ? await read( level.at + level.headerBytes, level.at + level.headerBytes + large * 8 ) : null;
	const view = sizes && new DataView( sizes.buffer, sizes.byteOffset, sizes.byteLength );
	const start = new Float64Array( level.faces ), end = new Float64Array( level.faces );
	let at = level.headerBytes + large * 8;
	for ( let i = 0, l = 0; i < level.faces; i ++ ) {

		start[ i ] = at;
		at += ( headers[ i ] & LARGE_FACE ) === LARGE_FACE ? Number( view.getBigUint64( 8 * l ++, true ) ) : headers[ i ] & LARGE_FACE;
		end[ i ] = at;

	}

	return { headers, start, end };

}

/**
 * The stored blocks `writePtexFile` needs for `slots` (a file's plan): each face from the smallest level holding it
 * at no less than its slot, read in runs. `data` holds them; a face's block is `at[ f ]` to `end[ f ]` of it, of
 * `encoding[ f ]`, at level `level[ f ]`.
 */
export async function readPtexBlocks( info, read, slots ) {

	const { faceCount, levels, rfaceids } = info;
	const level = new Uint8Array( faceCount ), encoding = new Uint8Array( faceCount );
	const at = new Float64Array( faceCount ), end = new Float64Array( faceCount );
	const tables = [];
	const wanted = levels.map( () => [] );

	// The level each face would come from, then each of those levels' tables; a face a level lacks steps down.
	const desired = new Int8Array( faceCount ).fill( - 1 );
	for ( let f = 0; f < faceCount; f ++ ) if ( ! isConstant( info, f ) ) desired[ f ] = Math.min( info.ulog2[ f ] - slots.tu[ f ], info.vlog2[ f ] - slots.tv[ f ], levels.length - 1 );
	for ( const r of new Set( desired ) ) if ( r >= 0 ) tables[ r ] = await levelTable( levels[ r ], read );
	for ( let f = 0; f < faceCount; f ++ ) {

		let r = desired[ f ];
		if ( r < 0 ) continue;
		for ( ; r > 0; r -- ) {

			const i = rfaceids[ f ];
			tables[ r ] ??= await levelTable( levels[ r ], read );
			if ( i < levels[ r ].faces && tables[ r ].end[ i ] > tables[ r ].start[ i ] ) break;

		}

		tables[ r ] ??= await levelTable( levels[ r ], read );
		const i = r === 0 ? f : rfaceids[ f ];
		level[ f ] = r;
		encoding[ f ] = tables[ r ].headers[ i ] >>> 30;
		at[ f ] = levels[ r ].at + tables[ r ].start[ i ];
		end[ f ] = levels[ r ].at + tables[ r ].end[ i ];
		wanted[ r ].push( f );

	}

	// Runs of each level's blocks, read once each and laid end to end.
	const runs = [];
	for ( const faces of wanted ) {

		faces.sort( ( a, b ) => at[ a ] - at[ b ] );
		let run = null;
		for ( const f of faces ) {

			if ( run && at[ f ] - run.end <= READ_GAP ) {

				run.end = Math.max( run.end, end[ f ] );
				run.faces.push( f );

			} else runs.push( run = { start: at[ f ], end: end[ f ], faces: [ f ] } );

		}

	}

	const total = runs.reduce( ( sum, run ) => sum + run.end - run.start, 0 );
	const data = new Uint8Array( total );
	let offset = 0;
	for ( const run of runs ) {

		data.set( await read( run.start, run.end ), offset );
		for ( const f of run.faces ) {

			end[ f ] += offset - run.start;
			at[ f ] += offset - run.start;

		}

		offset += run.end - run.start;

	}

	return { data, at, end, encoding, level };

}

/**
 * One block's texels at ( x0, y0 ) of `out`, interleaved, rows `stride` texels long: a constant, or a zipped block
 * stored a channel at a time, uint8 and uint16 as differences.
 */
function readBlock( info, bytes, at, blockEnd, encoding, w, h, out, stride, x0, y0 ) {

	const nc = info.channels, size = DATA_BYTES[ info.dataType ];
	if ( encoding === ENC_CONSTANT ) {

		const px = toFloat( bytes.subarray( at, at + nc * size ), info.dataType );
		for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) out.set( px, ( ( y0 + y ) * stride + x0 + x ) * nc );
		return;

	}

	const raw = inflate( bytes.subarray( at, blockEnd ), w * h * nc * size );
	if ( encoding === ENC_DIFFZIPPED && size === 1 ) {

		for ( let i = 1; i < raw.length; i ++ ) raw[ i ] = ( raw[ i ] + raw[ i - 1 ] ) & 0xff;

	} else if ( encoding === ENC_DIFFZIPPED && info.dataType === 1 ) {

		let prev = 0;
		for ( let i = 0; i < raw.length; i += 2 ) {

			prev = ( prev + ( raw[ i ] | raw[ i + 1 ] << 8 ) ) & 0xffff;
			raw[ i ] = prev & 0xff;
			raw[ i + 1 ] = prev >> 8;

		}

	}

	const values = toFloat( raw, info.dataType );
	const plane = w * h;
	for ( let c = 0; c < nc; c ++ ) for ( let y = 0; y < h; y ++ ) {

		const row = ( ( y0 + y ) * stride + x0 ) * nc + c, from = c * plane + y * w;
		for ( let x = 0; x < w; x ++ ) out[ row + x * nc ] = values[ from + x ];

	}

}

/**
 * A face's stored block, `w` × `h`, handed to `visit( x0, y0, bw, bh, values )` whole or a tile at a time (rows of
 * v = 0 first, channels interleaved).
 */
function readFace( info, bytes, at, end, encoding, w, h, visit ) {

	const nc = info.channels;
	if ( encoding !== ENC_TILED ) {

		const values = new Float32Array( w * h * nc );
		readBlock( info, bytes, at, end, encoding, w, h, values, w, 0, 0 );
		visit( 0, 0, w, h, values );
		return;

	}

	// A tile size, the tiles' zipped headers, then the tiles a row at a time.
	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const tw = 1 << bytes[ at ], th = 1 << bytes[ at + 1 ];
	const headerBytes = view.getUint32( at + 2, true );
	const across = w / tw, tiles = across * ( h / th );
	const headers = new Uint32Array( inflate( bytes.subarray( at + 6, at + 6 + headerBytes ), tiles * 4 ).buffer );
	const values = new Float32Array( tw * th * nc );
	let tileAt = at + 6 + headerBytes;
	for ( let t = 0; t < tiles; t ++ ) {

		const size = headers[ t ] & LARGE_FACE;
		readBlock( info, bytes, tileAt, tileAt + size, headers[ t ] >>> 30, tw, th, values, tw, 0, 0 );
		visit( ( t % across ) * tw, Math.floor( t / across ) * th, tw, th, values );
		tileAt += size;

	}

}

/**
 * Every face's texels at full size: `visit( face, values, w, h )`, values interleaved by channel, row v = 0 first. A
 * constant face comes as 1 × 1. For checks: the pages read reduced levels.
 */
export async function decodePtexFaces( info, read, visit ) {

	const full = { tu: info.ulog2, tv: info.vlog2 };
	const blocks = await readPtexBlocks( info, read, full );
	const nc = info.channels;
	for ( let f = 0; f < info.faceCount; f ++ ) {

		if ( isConstant( info, f ) ) {

			visit( f, info.constant.subarray( f * nc, f * nc + nc ), 1, 1 );
			continue;

		}

		const w = 1 << info.ulog2[ f ], h = 1 << info.vlog2[ f ];
		const values = new Float32Array( w * h * nc );
		readFace( info, blocks.data, blocks.at[ f ], blocks.end[ f ], blocks.encoding[ f ], w, h, ( x0, y0, bw, bh, block ) => {

			for ( let y = 0; y < bh; y ++ ) values.set( block.subarray( y * bw * nc, ( y + 1 ) * bw * nc ), ( ( y0 + y ) * w + x0 ) * nc );

		} );
		visit( f, values, w, h );

	}

}

// ── pages ───────────────────────────────────────────────────────────

/** A face's slot side, log2, `k` halvings below its own: a constant face at most 2 × 2. */
const slotLog2 = ( info, f, side, k, cap ) => Math.min( cap, isConstant( info, f ) ? Math.min( side, 1 ) : Math.max( 0, side - k ) );

/** Texels a file takes at `k` halvings, borders included. */
function fileTexels( info, k, cap ) {

	let sum = 0;
	for ( let f = 0; f < info.faceCount; f ++ ) sum += ( ( 1 << slotLog2( info, f, info.ulog2[ f ], k, cap ) ) + 2 ) * ( ( 1 << slotLog2( info, f, info.vlog2[ f ], k, cap ) ) + 2 );
	return sum;

}

/** Rectangles onto `size`-square pages from `firstPage` on, in shelves, tallest first: `place( item, page, x, y )` each. Returns the pages used. */
function shelfPack( items, size, place, firstPage ) {

	items.sort( ( a, b ) => b.h - a.h || b.w - a.w );
	let page = firstPage, x = 0, y = 0, shelf = 0;
	for ( const item of items ) {

		if ( x + item.w > size ) {

			y += shelf;
			x = 0;
			shelf = 0;

		}

		if ( y + item.h > size ) {

			page ++;
			x = y = shelf = 0;

		}

		place( item, page, x, y );
		x += item.w;
		shelf = Math.max( shelf, item.h );

	}

	return page - firstPage + 1;

}

/**
 * Where every face of `infos` goes and how small: each face's sides halved `reduction` times (a constant face kept at
 * 2 × 2 or less) so all fit `maxTexels`, a file's faces on one page when they fit one. Per file: `page`, `x`, `y`
 * (its texels' corner) and `tu`, `tv` (its sides, log2) a face, and the `pages` it is on.
 */
export function planPtexPages( infos, { pageSize = 4096, maxTexels = 256 * 2 ** 20 } = {} ) {

	const cap = Math.log2( pageSize ) - 1;
	const pageRoom = pageSize * pageSize * PAGE_FILL;
	let reduction = 0;
	const total = ( k ) => infos.reduce( ( sum, info ) => sum + fileTexels( info, k, cap ), 0 );
	while ( reduction < 16 && total( reduction ) > maxTexels * PAGE_FILL ) reduction ++;

	const files = infos.map( ( info ) => ( {
		page: new Uint16Array( info.faceCount ), x: new Uint16Array( info.faceCount ), y: new Uint16Array( info.faceCount ),
		tu: new Uint8Array( info.faceCount ), tv: new Uint8Array( info.faceCount ), pages: [], texels: fileTexels( info, reduction, cap ),
	} ) );
	const itemsOf = ( i ) => {

		const info = infos[ i ], file = files[ i ], items = [];
		for ( let f = 0; f < info.faceCount; f ++ ) {

			file.tu[ f ] = slotLog2( info, f, info.ulog2[ f ], reduction, cap );
			file.tv[ f ] = slotLog2( info, f, info.vlog2[ f ], reduction, cap );
			items.push( { file: i, face: f, w: ( 1 << file.tu[ f ] ) + 2, h: ( 1 << file.tv[ f ] ) + 2 } );

		}

		return items;

	};

	const place = ( item, page, x, y ) => {

		const file = files[ item.file ];
		file.page[ item.face ] = page;
		file.x[ item.face ] = x + 1;
		file.y[ item.face ] = y + 1;

	};

	// Files larger than a page take pages of their own; the rest share pages, packed by size (first fit, largest
	// first), a page given up and its files moved on when its shelves overflow.
	const order = infos.map( ( _, i ) => i ).sort( ( a, b ) => files[ b ].texels - files[ a ].texels );
	let pageCount = 0;
	const bins = [];
	for ( const i of order ) {

		if ( files[ i ].texels > pageRoom ) {

			pageCount += shelfPack( itemsOf( i ), pageSize, place, pageCount );
			continue;

		}

		const bin = bins.find( ( b ) => b.texels + files[ i ].texels <= pageRoom );
		if ( bin ) {

			bin.files.push( i );
			bin.texels += files[ i ].texels;

		} else bins.push( { files: [ i ], texels: files[ i ].texels } );

	}

	while ( bins.length ) {

		const bin = bins.shift();
		for ( ;; ) {

			const items = bin.files.flatMap( itemsOf );
			const pages = shelfPack( items.slice(), pageSize, () => {}, 0 );
			if ( pages === 1 || bin.files.length === 1 ) {

				pageCount += shelfPack( items, pageSize, place, pageCount );
				break;

			}

			const moved = bin.files.pop();
			bin.texels -= files[ moved ].texels;
			const last = bins[ bins.length - 1 ];
			if ( last && last.texels + files[ moved ].texels <= pageRoom ) {

				last.files.push( moved );
				last.texels += files[ moved ].texels;

			} else bins.push( { files: [ moved ], texels: files[ moved ].texels } );

		}

	}

	for ( const file of files ) file.pages = [ ...new Set( file.page ) ].sort( ( a, b ) => a - b );
	return { pageSize, pageCount, reduction, files, texels: files.reduce( ( sum, file ) => sum + file.texels, 0 ) };

}

const SRGB_LUT_SIZE = 4096;

/**
 * Bytes for page texels: colour (`power`, an exponent a channel or 'srgb', takes the stored value to linear light;
 * stored sRGB-encoded) or data (`power` null: the value itself).
 */
function encoder( power ) {

	const luts = [ 0, 1, 2 ].map( ( c ) => {

		const lut = new Uint8Array( SRGB_LUT_SIZE + 1 );
		for ( let i = 0; i <= SRGB_LUT_SIZE; i ++ ) {

			const v = i / SRGB_LUT_SIZE;
			const linear = power === null ? null : power === 'srgb' ? ( v <= 0.04045 ? v / 12.92 : ( ( v + 0.055 ) / 1.055 ) ** 2.4 ) : v ** power[ c ];
			const out = linear === null ? v : linear <= 0.0031308 ? linear * 12.92 : 1.055 * linear ** ( 1 / 2.4 ) - 0.055;
			lut[ i ] = Math.round( out * 255 );

		}

		return lut;

	} );
	return ( value, c ) => luts[ c ][ Math.round( Math.min( Math.max( value, 0 ), 1 ) * SRGB_LUT_SIZE ) ];

}

/** A texel of a page as bytes: x, y in texels. */
const texel = ( size, x, y ) => ( y * size + x ) * 4;

/**
 * Writes a file's faces into its slots on `pages` (RGBA8, `size` square), box-filtered down to them, then every face's
 * border from its neighbours. `blocks` from readPtexBlocks; `power` as `encoder` takes it.
 */
export function writePtexFile( info, blocks, slots, pages, size, power ) {

	const nc = info.channels;
	const encode = encoder( power );
	const channel = ( c ) => ( nc >= 3 ? c : 0 );
	let sum = new Float32Array( 0 );

	for ( let f = 0; f < info.faceCount; f ++ ) {

		const tw = 1 << slots.tu[ f ], th = 1 << slots.tv[ f ];
		if ( sum.length < tw * th * nc ) sum = new Float32Array( tw * th * nc );
		const acc = sum.subarray( 0, tw * th * nc );
		if ( isConstant( info, f ) ) {

			for ( let i = 0; i < tw * th; i ++ ) acc.set( info.constant.subarray( f * nc, f * nc + nc ), i * nc );

		} else {

			acc.fill( 0 );
			const r = blocks.level[ f ];
			const w = 1 << ( info.ulog2[ f ] - r ), h = 1 << ( info.vlog2[ f ] - r );
			const sx = w / tw, sy = h / th, share = 1 / ( sx * sy );
			readFace( info, blocks.data, blocks.at[ f ], blocks.end[ f ], blocks.encoding[ f ], w, h, ( x0, y0, bw, bh, values ) => {

				if ( share === 1 ) {

					for ( let y = 0; y < bh; y ++ ) acc.set( values.subarray( y * bw * nc, ( y + 1 ) * bw * nc ), ( ( y0 + y ) * tw + x0 ) * nc );
					return;

				}

				for ( let y = 0; y < bh; y ++ ) for ( let x = 0; x < bw; x ++ ) {

					const to = ( Math.floor( ( y0 + y ) / sy ) * tw + Math.floor( ( x0 + x ) / sx ) ) * nc, from = ( y * bw + x ) * nc;
					for ( let c = 0; c < nc; c ++ ) acc[ to + c ] += values[ from + c ] * share;

				}

			} );

		}

		const page = pages[ slots.page[ f ] ];
		const square = info.meshType === 'triangle' ? triangleSquare( acc, tw, nc ) : acc;
		for ( let y = 0; y < th; y ++ ) for ( let x = 0; x < tw; x ++ ) {

			const o = texel( size, slots.x[ f ] + x, slots.y[ f ] + y ), from = ( y * tw + x ) * nc;
			page[ o ] = encode( square[ from + channel( 0 ) ], 0 );
			page[ o + 1 ] = encode( square[ from + channel( 1 ) ], 1 );
			page[ o + 2 ] = encode( square[ from + channel( 2 ) ], 2 );
			page[ o + 3 ] = 255;

		}

	}

	for ( let f = 0; f < info.faceCount; f ++ ) fillBorder( info, slots, pages, size, f );

}

/**
 * A triangle face's texels as a square sampled at the face's own (u, v): Ptex keeps the upward triangles of its grid
 * at ( i, j ), i + j < res, the downward ones mirrored into the rest. A cell is the mean of its two, and the half
 * past the diagonal mirrors the half before it.
 */
function triangleSquare( acc, res, nc ) {

	const out = new Float32Array( res * res * nc );
	for ( let j = 0; j < res; j ++ ) for ( let i = 0; i + j < res; i ++ ) {

		const even = ( j * res + i ) * nc, odd = ( ( res - 1 - i ) * res + res - 1 - j ) * nc, to = ( j * res + i ) * nc;
		for ( let c = 0; c < nc; c ++ ) out[ to + c ] = i + j <= res - 2 ? ( acc[ even + c ] + acc[ odd + c ] ) / 2 : acc[ even + c ];

	}

	for ( let j = 0; j < res; j ++ ) for ( let i = res - j; i < res; i ++ ) out.copyWithin( ( j * res + i ) * nc, ( ( res - 1 - i ) * res + res - 1 - j ) * nc, ( ( res - 1 - i ) * res + res - j ) * nc );
	return out;

}

/** The page texel ( x, y ) of edge `e`'s k-th texel, counter-clockwise, `out` texels beyond the face (0 = on it). */
function edgeTexel( slots, f, e, k, out ) {

	const x = slots.x[ f ], y = slots.y[ f ], w = 1 << slots.tu[ f ], h = 1 << slots.tv[ f ];
	switch ( e ) {

		case 0: return [ x + k, y - out ];
		case 1: return [ x + w - 1 + out, y + k ];
		case 2: return [ x + w - 1 - k, y + h - 1 + out ];
		default: return [ x - out, y + h - 1 - k ];

	}

}

/**
 * A face's one-texel border: along each edge the neighbouring face's texels at that edge, which run the other way and
 * are resampled to this face's length; at a mesh's edge the face's own (black, or the opposite edge, as the file's
 * border mode says). Corners take the mean of the two border texels beside them.
 */
function fillBorder( info, slots, pages, size, f ) {

	const page = pages[ slots.page[ f ] ];
	const lengths = [ 1 << slots.tu[ f ], 1 << slots.tv[ f ] ];
	for ( let e = 0; e < 4; e ++ ) {

		const n = lengths[ e & 1 ];
		const g = info.meshType === 'quad' ? info.adjFaces[ f * 4 + e ] : - 1;
		const mode = e & 1 ? info.uBorder : info.vBorder;
		for ( let k = 0; k < n; k ++ ) {

			const [ gx, gy ] = edgeTexel( slots, f, e, k, 1 );
			const to = texel( size, gx, gy );
			if ( g >= 0 && g < info.faceCount ) {

				const ae = ( info.adjEdges[ f ] >> ( 2 * e ) ) & 3;
				const m = 1 << ( ae & 1 ? slots.tv[ g ] : slots.tu[ g ] );
				const from = pages[ slots.page[ g ] ];
				// Along this edge's k-th texel, the neighbour's edge runs back from its end.
				const first = Math.floor( ( n - 1 - k ) * m / n ), last = Math.max( first, Math.ceil( ( n - k ) * m / n ) - 1 );
				for ( let c = 0; c < 3; c ++ ) {

					let s = 0;
					for ( let j = first; j <= last; j ++ ) {

						const [ sx, sy ] = edgeTexel( slots, g, ae, j, 0 );
						s += from[ texel( size, sx, sy ) + c ];

					}

					page[ to + c ] = Math.round( s / ( last - first + 1 ) );

				}

			} else if ( mode === BORDER_BLACK ) {

				page[ to ] = page[ to + 1 ] = page[ to + 2 ] = 0;

			} else {

				const [ sx, sy ] = mode === BORDER_PERIODIC ? edgeTexel( slots, f, ( e + 2 ) & 3, n - 1 - k, 0 ) : edgeTexel( slots, f, e, k, 0 );
				page.copyWithin( to, texel( size, sx, sy ), texel( size, sx, sy ) + 3 );

			}

			page[ to + 3 ] = 255;

		}

	}

	const x = slots.x[ f ], y = slots.y[ f ], w = lengths[ 0 ], h = lengths[ 1 ];
	for ( const [ cx, cy, ax, ay, bx, by ] of [
		[ x - 1, y - 1, x, y - 1, x - 1, y ], [ x + w, y - 1, x + w - 1, y - 1, x + w, y ],
		[ x + w, y + h, x + w - 1, y + h, x + w, y + h - 1 ], [ x - 1, y + h, x, y + h, x - 1, y + h - 1 ],
	] ) {

		const to = texel( size, cx, cy ), a = texel( size, ax, ay ), b = texel( size, bx, by );
		for ( let c = 0; c < 3; c ++ ) page[ to + c ] = ( page[ a + c ] + page[ b + c ] + 1 ) >> 1;
		page[ to + 3 ] = 255;

	}

}

// A quad's corners in Ptex's (u, v), in its vertex order.
const CORNER_UV = [ 0, 0, 1, 0, 1, 1, 0, 1 ];

/**
 * A mesh's uvs moved onto the pages: each triangle's corners into its face's rectangle (`faces`: a face id a
 * triangle). A corner's (u, v) on its face is `uv` at its vertex, or with `corners` (a byte a corner, 0–3) that corner
 * of the face's quad. A vertex shared by triangles of different faces is copied, the copies after the mesh's own
 * vertices (`copies`: the vertex each copies). `pages`: each triangle's page.
 */
export function ptexUV( index, uv, faces, slots, size, vertexCount = uv.length / 2, corners = null ) {

	const triangles = index ? index.length / 3 : vertexCount / 3;
	if ( corners ) return quadsUV( index, faces, slots, size, triangles, corners );
	const owner = new Int32Array( vertexCount ).fill( - 1 );
	const out = index ? Uint32Array.from( index ) : Uint32Array.from( { length: triangles * 3 }, ( _, i ) => i );
	const copies = [], copyOf = new Map();
	const pages = new Uint16Array( triangles );
	const faceCount = slots.page.length;
	const valid = ( f ) => f >= 0 && f < faceCount;
	for ( let t = 0; t < triangles; t ++ ) {

		const f = faces[ t ];
		if ( ! valid( f ) ) continue;
		pages[ t ] = slots.page[ f ];
		for ( let k = 0; k < 3; k ++ ) {

			const v = out[ t * 3 + k ];
			if ( owner[ v ] === - 1 || owner[ v ] === f ) {

				owner[ v ] = f;
				continue;

			}

			const key = v * faceCount + f;
			let c = copyOf.get( key );
			if ( c === undefined ) {

				c = vertexCount + copies.length;
				copies.push( v );
				copyOf.set( key, c );

			}

			out[ t * 3 + k ] = c;

		}

	}

	// Each corner's vertex is its face's alone now: its uv set from that corner.
	const mapped = new Float32Array( ( vertexCount + copies.length ) * 2 );
	for ( let t = 0; t < triangles; t ++ ) {

		const f = faces[ t ];
		if ( ! valid( f ) ) continue;
		const w = 1 << slots.tu[ f ], h = 1 << slots.tv[ f ];
		for ( let k = 0; k < 3; k ++ ) {

			const to = out[ t * 3 + k ], i = t * 3 + k;
			const fu = corners ? CORNER_UV[ corners[ i ] * 2 ] : uv[ index ? index[ i ] * 2 : i * 2 ];
			const fv = corners ? CORNER_UV[ corners[ i ] * 2 + 1 ] : uv[ index ? index[ i ] * 2 + 1 : i * 2 + 1 ];
			mapped[ to * 2 ] = ( slots.x[ f ] + fu * w ) / size;
			mapped[ to * 2 + 1 ] = ( slots.y[ f ] + fv * h ) / size;

		}

	}

	return { uv: mapped, index: out, copies: Uint32Array.from( copies ), pages };

}

/**
 * ptexUV for a mesh of two triangles a face, in order (USD's, USDScene ptexTriangulate): each face's four corners are
 * its own vertices, `gather` the vertex each comes from, with no search for shared ones.
 */
function quadsUV( index, faces, slots, size, triangles, corners ) {

	const gather = new Uint32Array( triangles * 2 ), out = new Uint32Array( triangles * 3 );
	const mapped = new Float32Array( triangles * 4 ), pages = new Uint16Array( triangles );
	const faceCount = slots.page.length;
	for ( let t = 0; t < triangles; t ++ ) {

		const f = faces[ t ], valid = f >= 0 && f < faceCount;
		if ( valid ) pages[ t ] = slots.page[ f ];
		const w = valid ? 1 << slots.tu[ f ] : 0, h = valid ? 1 << slots.tv[ f ] : 0;
		for ( let k = 0; k < 3; k ++ ) {

			const i = t * 3 + k, c = corners[ i ], v = ( t >> 1 ) * 4 + c;
			gather[ v ] = index ? index[ i ] : i;
			out[ i ] = v;
			if ( ! valid ) continue;
			mapped[ v * 2 ] = ( slots.x[ f ] + CORNER_UV[ c * 2 ] * w ) / size;
			mapped[ v * 2 + 1 ] = ( slots.y[ f ] + CORNER_UV[ c * 2 + 1 ] * h ) / size;

		}

	}

	return { uv: mapped, index: out, gather, pages };

}

/** pbrt's ColorEncoding of a texture's stored values: 'srgb', or an exponent a channel ('linear' is 1); null when unknown. */
export function ptexPower( encoding = 'gamma 2.2' ) {

	const text = String( encoding ).trim().toLowerCase();
	if ( text === 'srgb' ) return 'srgb';
	if ( text === 'linear' ) return [ 1, 1, 1 ];
	const gamma = Number( /^gamma\s+(\S+)$/.exec( text )?.[ 1 ] );
	return gamma > 0 ? [ gamma, gamma, gamma ] : null;

}

/** A stored value in linear light under `power` (ptexPower's). */
export function ptexLinear( value, power, c = 0 ) {

	if ( power === 'srgb' ) return value <= 0.04045 ? value / 12.92 : ( ( value + 0.055 ) / 1.055 ) ** 2.4;
	return Math.max( value, 0 ) ** power[ c ];

}

const PLY_TYPES = {
	char: 'Int8', int8: 'Int8', uchar: 'Uint8', uint8: 'Uint8', short: 'Int16', int16: 'Int16', ushort: 'Uint16', uint16: 'Uint16',
	int: 'Int32', int32: 'Int32', uint: 'Uint32', uint32: 'Uint32', float: 'Float32', float32: 'Float32', double: 'Float64', float64: 'Float64',
};
const PLY_BYTES = { Int8: 1, Uint8: 1, Int16: 2, Uint16: 2, Int32: 4, Uint32: 4, Float32: 4, Float64: 8 };

/**
 * pbrt's Ptex face ids from a PLY's `face_indices`, one a triangle as three's PLYLoader makes them (a triangle one, a
 * quad two, any other face none); null when the file has none.
 */
export function plyFaceIndices( bytes ) {

	const head = new TextDecoder().decode( bytes.subarray( 0, Math.min( bytes.length, 64 * 1024 ) ) );
	const end = head.indexOf( 'end_header' );
	if ( end < 0 ) return null;
	const elements = [];
	let format = null;
	for ( const line of head.slice( 0, end ).split( /\r?\n/ ) ) {

		const word = line.trim().split( /\s+/ );
		if ( word[ 0 ] === 'format' ) format = word[ 1 ];
		else if ( word[ 0 ] === 'element' ) elements.push( { name: word[ 1 ], count: Number( word[ 2 ] ), props: [] } );
		else if ( word[ 0 ] === 'property' && elements.length ) elements[ elements.length - 1 ].props.push( word[ 1 ] === 'list'
			? { list: true, count: PLY_TYPES[ word[ 2 ] ], item: PLY_TYPES[ word[ 3 ] ], name: word[ 4 ] }
			: { type: PLY_TYPES[ word[ 1 ] ], name: word[ 2 ] } );

	}

	const face = elements.find( ( e ) => e.name === 'face' );
	if ( ! face?.props.some( ( p ) => p.name === 'face_indices' ) ) return null;
	let at = head.indexOf( '\n', end ) + 1;
	const out = new Int32Array( face.count * 2 );
	let n = 0;
	const take = ( count, id ) => {

		if ( count === 3 ) out[ n ++ ] = id;
		else if ( count === 4 ) out[ n ++ ] = out[ n ++ ] = id;

	};

	if ( format === 'ascii' ) {

		const words = new TextDecoder().decode( bytes.subarray( at ) ).split( /\s+/ ).filter( Boolean );
		let w = 0;
		for ( const element of elements ) for ( let i = 0; i < element.count; i ++ ) {

			let count = 0, id = 0;
			for ( const p of element.props ) {

				const value = Number( words[ w ++ ] );
				if ( p.list ) {

					w += value;
					if ( p.name === 'vertex_indices' || p.name === 'vertex_index' ) count = value;

				} else if ( p.name === 'face_indices' ) id = value;

			}

			if ( element === face ) take( count, id );

		}

		return out.slice( 0, n );

	}

	const little = format !== 'binary_big_endian';
	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const getter = ( type ) => {

		const get = view[ `get${type}` ].bind( view );
		return ( o ) => get( o, little );

	};

	for ( const element of elements ) {

		if ( element !== face && element.props.every( ( p ) => ! p.list ) ) {

			at += element.count * element.props.reduce( ( sum, p ) => sum + PLY_BYTES[ p.type ], 0 );
			continue;

		}

		const props = element.props.map( ( p ) => ( {
			list: p.list, size: PLY_BYTES[ p.list ? p.item : p.type ], count: p.list && getter( p.count ), countSize: p.list && PLY_BYTES[ p.count ],
			id: p.name === 'face_indices' && getter( p.type ), vertices: p.name === 'vertex_indices' || p.name === 'vertex_index',
		} ) );
		for ( let i = 0; i < element.count; i ++ ) {

			let count = 0, id = 0;
			for ( const p of props ) {

				if ( p.list ) {

					const k = p.count( at );
					at += p.countSize + k * p.size;
					if ( p.vertices ) count = k;

				} else {

					if ( p.id ) id = p.id( at );
					at += p.size;

				}

			}

			if ( element === face ) take( count, id );

		}

		if ( element === face ) break;

	}

	return out.slice( 0, n );

}
