/**
 * NanoVDB files (.nvdb), as nanovdb's `io::readGrids` reads them: segments of grids, each stored raw, Zip or Blosc, or
 * a raw grid buffer (`GridHandle::write`). Any ABI 32 file: pbrt-v4's 32.3 ("NanoVDB0" files and grids) to OpenVDB 12
 * and later ("NanoVDB2" files, "NanoVDB1" grids). Scalar grids — float, double, half and the quantised Fp4, Fp8, Fp16
 * and FpN — are read dense over their active box, as OpenVDB.js reads its grids.
 */

import { DataUtils, Matrix4 } from 'three';
import { unzlibSync } from 'three/addons/libs/fflate.module.js';
import { VolumeGrid } from '../scene/Volumes.js';

const MAGIC = 'NanoVDB';
const ABI = 32;
const CODEC_NONE = 0, CODEC_ZIP = 1, CODEC_BLOSC = 2;
const GRID_TYPES = [ 'unknown', 'float', 'double', 'int16', 'int32', 'int64', 'vec3f', 'vec3d', 'mask', 'half', 'uint32',
	'boolean', 'rgba8', 'fp4', 'fp8', 'fp16', 'fpN', 'vec4f', 'vec4d', 'index', 'on index', 'unknown', 'unknown',
	'point index', 'vec3u8', 'vec3u16', 'uint8' ];
const GRID_CLASSES = [ 'unknown', 'level set', 'fog volume', 'staggered', 'point index', 'point data', 'topology',
	'voxel volume', 'index', 'tensor', 'voxel bvh' ];
const META_BYTES = 176;
const BLOSC_CHUNK = 2 ** 30;

// Byte layouts of NanoVDB.h's GridData, TreeData, RootData (+ Tile), InternalData and LeafData.
const GRID_BYTES = 672, GRID_MAP_D = 296 + 88, GRID_VEC_D = 296 + 232, GRID_CLASS = 632, GRID_TYPE = 636;
const ROOT_TABLE_SIZE = 24, TILE_BYTES = 32;
const UPPER = { log2: 5, childShift: 7, values: 32, children: 32 + 4096, table: 8256 };
const LOWER = { log2: 4, childShift: 3, values: 32, children: 32 + 512, table: 1088 };
// Per scalar type: the root's background, a root tile's value and the root's size; a leaf's values, or for a quantised
// grid its codes of `bits` (0: the leaf says, FpN) after a minimum and a step. Internal tiles hold the value (quantised
// grids: a float) in their 8 bytes.
const SCALAR = {
	float: { background: 28, tile: 20, root: 64, leaf: 96 },
	double: { background: 32, tile: 24, root: 96, leaf: 128 },
	half: { background: 28, tile: 20, root: 64, leaf: 96 },
	fp4: { background: 28, tile: 20, root: 64, bits: 4 },
	fp8: { background: 28, tile: 20, root: 64, bits: 8 },
	fp16: { background: 28, tile: 20, root: 64, bits: 16 },
	fpN: { background: 28, tile: 20, root: 64, bits: 0 },
};
const LEAF_MINIMUM = 80, LEAF_STEP = 84, LEAF_FLAGS = 15, LEAF_CODES = 96;

/** Whether these bytes start as a NanoVDB file or grid buffer does. */
export const isNanoVDB = ( bytes ) => bytes.length >= 8 && ascii( bytes, 0, 7 ) === MAGIC && bytes[ 7 ] >= 0x30 && bytes[ 7 ] <= 0x32;

/**
 * Every grid of a NanoVDB file: what its metadata says, and its values on demand. A Blosc segment needs `blosc`
 * (OpenVDB.js's `bloscDecompress`; `readVDB` there passes it). `up` is 'y': a NanoVDB file names no creator, and those
 * in circulation are Houdini's, Y-up.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{ blosc?: (src: Uint8Array) => Uint8Array }} [options]
 * @returns {{ grids: NanoGrid[], metadata: Object, up: string }}
 */
export function readNanoVDB( buffer, { blosc = null } = {} ) {

	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array( buffer );
	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	if ( ! isNanoVDB( bytes ) ) throw new Error( 'not a NanoVDB file' );
	const grids = [];
	if ( isGrid( bytes, view, 0 ) ) {

		// A raw buffer: grids back to back as in memory, each saying its size and which of how many it is.
		for ( let at = 0; ; ) {

			need( bytes, at + GRID_BYTES );
			if ( ! isNanoVDB( bytes.subarray( at ) ) ) throw new Error( `NanoVDB: no grid at byte ${at}` );
			version( view, at + 16 );
			const meta = gridMeta( bytes, view, at );
			need( bytes, at + meta.gridSize );
			grids.push( new NanoGrid( meta, bytes.subarray( at, at + meta.gridSize ), CODEC_NONE, blosc ) );
			const index = view.getUint32( at + 24, true ), count = view.getUint32( at + 28, true );
			at += meta.gridSize;
			if ( index + 1 >= count || at >= bytes.length ) break;

		}

		return { grids, metadata: {}, up: 'y' };

	}

	let pos = 0;
	while ( pos + 16 <= bytes.length ) {

		const magic = ascii( bytes, pos, 8 );
		if ( magic !== `${MAGIC}0` && magic !== `${MAGIC}2` ) throw new Error( `NanoVDB: no file header at byte ${pos}` );
		version( view, pos + 8 );
		const count = view.getUint16( pos + 12, true ), codec = view.getUint16( pos + 14, true );
		if ( codec > CODEC_BLOSC ) throw new Error( `NanoVDB: unknown codec ${codec}` );
		pos += 16;
		const metas = [];
		for ( let i = 0; i < count; i ++ ) {

			need( bytes, pos + META_BYTES );
			const nameSize = view.getUint32( pos + 136, true );
			need( bytes, pos + META_BYTES + nameSize );
			metas.push( {
				gridSize: u64( view, pos ),
				fileSize: u64( view, pos + 8 ),
				voxelCount: u64( view, pos + 24 ),
				valueType: GRID_TYPES[ view.getUint32( pos + 32, true ) ] ?? 'unknown',
				gridClass: GRID_CLASSES[ view.getUint32( pos + 36, true ) ] ?? 'unknown',
				indexBox: { min: i32s( view, pos + 88 ), max: i32s( view, pos + 100 ) },
				name: cString( bytes, pos + META_BYTES, nameSize )
			} );
			pos += META_BYTES + nameSize;

		}

		for ( const meta of metas ) {

			need( bytes, pos + meta.fileSize );
			grids.push( new NanoGrid( meta, bytes.subarray( pos, pos + meta.fileSize ), codec, blosc ) );
			pos += meta.fileSize;

		}

	}

	return { grids, metadata: {}, up: 'y' };

}

// nanovdb's GridData::isValid: a "NanoVDB0" buffer is a grid (else a file) when the grid's own fields say so.
function isGrid( bytes, view, at ) {

	if ( bytes[ at + 7 ] === 0x31 ) return true;
	if ( bytes[ at + 7 ] !== 0x30 || bytes.length < at + GRID_BYTES ) return false;
	if ( ascii( bytes, at + 664, 8 ) === `${MAGIC}1` ) return true;
	const index = view.getUint32( at + 24, true ), count = view.getUint32( at + 28, true );
	return view.getUint32( at + 16, true ) >>> 21 === ABI && count > 0 && index < count &&
		view.getUint32( at + GRID_CLASS, true ) < 32 && view.getUint32( at + GRID_TYPE, true ) < 64;

}

// A grid's metadata from its own header, for a raw buffer.
function gridMeta( bytes, view, at ) {

	const tree = at + GRID_BYTES;
	const root = tree + u64( view, tree + 24 );
	need( bytes, root + 24 );
	const gridSize = u64( view, at + 32 );
	return {
		gridSize, fileSize: gridSize,
		voxelCount: u64( view, tree + 56 ),
		valueType: GRID_TYPES[ view.getUint32( at + GRID_TYPE, true ) ] ?? 'unknown',
		gridClass: GRID_CLASSES[ view.getUint32( at + GRID_CLASS, true ) ] ?? 'unknown',
		indexBox: { min: i32s( view, root ), max: i32s( view, root + 12 ) },
		name: cString( bytes, at + 40, 256 )
	};

}

/** One grid of a file, read as OpenVDB.js's grids are (`toVolumeGrid`, `maxValue`, `recordedBox`, `transform`). */
class NanoGrid {

	constructor( meta, stored, codec, blosc ) {

		Object.assign( this, meta );
		this.scalar = this.valueType in SCALAR;
		this.parent = '';
		this.codec = codec;
		this._stored = stored;
		this._blosc = blosc;
		this._bytes = null;

	}

	/** Its in-memory grid buffer, decompressed once. */
	buffer() {

		if ( this._bytes ) return this._bytes;
		const { _stored: stored, gridSize } = this;
		if ( this.codec === CODEC_NONE ) return ( this._bytes = stored.subarray( 0, gridSize ) );
		if ( this.codec === CODEC_BLOSC && ! this._blosc ) throw new Error( `NanoVDB: "${this.name}" is Blosc-compressed and no Blosc reader was given` );
		const view = new DataView( stored.buffer, stored.byteOffset, stored.byteLength );
		const out = new Uint8Array( gridSize );
		let at = 0, written = 0;
		while ( written < gridSize ) {

			const size = u64( view, at );
			const chunk = stored.subarray( at + 8, at + 8 + size );
			at += 8 + size;
			const part = this.codec === CODEC_ZIP ? unzlibSync( chunk, { out: out.subarray( written ) } ) : this._blosc( chunk );
			const expect = this.codec === CODEC_ZIP ? gridSize - written : Math.min( BLOSC_CHUNK, gridSize - written );
			if ( part.length !== expect ) throw new Error( `NanoVDB: "${this.name}" inflates to ${part.length} bytes, ${expect} expected` );
			if ( this.codec === CODEC_BLOSC ) out.set( part, written );
			written += part.length;

		}

		return ( this._bytes = out );

	}

	/** The active index box ({ min, max }) its metadata records, null when it holds no voxel. */
	get recordedBox() {

		const { min, max } = this.indexBox;
		return min.every( ( v, k ) => v <= max[ k ] ) ? this.indexBox : null;

	}

	/** Index space → world: world = M · ijk + t, M row-major (NanoVDB's matMult). */
	get transform() {

		const view = this._view();
		const m = Array.from( { length: 9 }, ( _, i ) => view.getFloat64( GRID_MAP_D + i * 8, true ) );
		const t = [ 0, 1, 2 ].map( ( i ) => view.getFloat64( GRID_VEC_D + i * 8, true ) );
		return new Matrix4().set( m[ 0 ], m[ 1 ], m[ 2 ], t[ 0 ], m[ 3 ], m[ 4 ], m[ 5 ], t[ 1 ], m[ 6 ], m[ 7 ], m[ 8 ], t[ 2 ], 0, 0, 0, 1 );

	}

	/**
	 * Its values over its active box, x fastest, as `tree().getValue( ijk )` returns them (inactive voxels and tiles
	 * included); past `maxVoxels` or `maxSide`, or at `factor`, each value is the mean of f³ voxels (f a power of 2), as
	 * OpenVDB grids are read. Null when it holds no voxel. The matrix takes index to world space.
	 * @param {{ maxVoxels?: number, maxSide?: number, factor?: number }} [options]
	 * @returns {?{ data: Float32Array, width: number, height: number, depth: number, min: number[], factor: number, matrix: Matrix4, background: number }}
	 */
	read( { maxVoxels = 2 ** 27, maxSide = 2048, factor = 1 } = {} ) {

		const view = this._view();
		const active = this.recordedBox;
		if ( ! active ) return null;
		const { min, max } = active;
		const size = [ 0, 1, 2 ].map( ( a ) => max[ a ] - min[ a ] + 1 );
		let f = factor;
		while ( size.reduce( ( n, v ) => n * Math.ceil( v / f ), 1 ) > maxVoxels || Math.max( ...size ) / f > maxSide ) f *= 2;
		const [ width, height, depth ] = size.map( ( v ) => Math.ceil( v / f ) );
		const background = rootValue( view, this.valueType, 'background' );
		const box = { min, max, size, f, width, height, data: new Float32Array( width * height * depth ), background, weight: 1 / ( f * f * f ) };
		if ( background !== 0 ) box.data.fill( background );
		walk( this.buffer(), view, this.valueType, box, ( origin, side, value ) => fill( box, origin, side, value ), ( origin, values ) => leaf( box, origin, values ) );
		return { data: box.data, width, height, depth, min, factor: f, matrix: this.transform, background };

	}

	/**
	 * Its values as a volume grid (see `read`), placed in its world space; null when it holds no voxel.
	 * @param {{ maxVoxels?: number, maxSide?: number, factor?: number }} [options]
	 * @returns {?VolumeGrid}
	 */
	toVolumeGrid( options ) {

		const read = this.read( options );
		if ( ! read ) return null;
		const { data, width, height, depth, min, factor: f, matrix } = read;
		// Dense index ( i, j, k ) is the centre of its f³ voxels: min + f · index + ( f − 1 ) / 2.
		const centre = ( f - 1 ) / 2;
		const toIndex = new Matrix4().makeScale( f, f, f ).setPosition( min[ 0 ] + centre, min[ 1 ] + centre, min[ 2 ] + centre );
		const grid = new VolumeGrid( { width, height, depth, data, transform: matrix.multiply( toIndex ), name: this.name } );
		grid.factor = f;
		return grid;

	}

	/** The largest value the grid holds, in its leaves and active tiles; its background where it holds none. */
	maxValue() {

		const view = this._view();
		let max = - Infinity;
		walk( this.buffer(), view, this.valueType, null, ( origin, side, value, on ) => {

			if ( on && value > max ) max = value;

		}, ( origin, values ) => {

			for ( let n = 0; n < 512; n ++ ) if ( values[ n ] > max ) max = values[ n ];

		} );
		return max === - Infinity ? rootValue( view, this.valueType, 'background' ) : max;

	}

	// Its buffer's view, checked: a grid of the type its metadata names.
	_view() {

		if ( ! this.scalar ) throw new Error( `NanoVDB: "${this.name}" holds ${this.valueType} values; scalar grids only` );
		const bytes = this.buffer();
		need( bytes, GRID_BYTES );
		if ( ! isNanoVDB( bytes ) ) throw new Error( `NanoVDB: "${this.name}" has no grid header` );
		const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
		const type = GRID_TYPES[ view.getUint32( GRID_TYPE, true ) ];
		if ( type !== this.valueType ) throw new Error( `NanoVDB: "${this.name}" is a ${type} grid where its file says ${this.valueType}` );
		return view;

	}

}

// A value of the grid's type at a byte; quantised grids keep floats above their leaves.
function valueAt( view, at, type ) {

	if ( type === 'double' ) return view.getFloat64( at, true );
	if ( type === 'half' ) return DataUtils.fromHalfFloat( view.getUint16( at, true ) );
	return view.getFloat32( at, true );

}

const rootValue = ( view, type, field ) => valueAt( view, GRID_BYTES + u64( view, GRID_BYTES + 24 ) + SCALAR[ type ][ field ], type );

// The tree's tiles and leaves overlapping `box` (all of them without one), root to leaves: `tile( origin, side, value,
// active )` and `leaf( origin, values )`, a leaf's 512 values decoded into one array reused for every leaf.
function walk( bytes, view, type, box, tile, leaf ) {

	const spec = SCALAR[ type ];
	const root = GRID_BYTES + u64( view, GRID_BYTES + 24 );
	const values = new Float32Array( 512 );
	const decode = leafDecoder( bytes, view, type );
	const internal = ( node, origin, level ) => {

		const { log2, childShift } = level;
		const side = 1 << log2, size = 1 << childShift;
		const at = [ 0, 0, 0 ];
		for ( let n = 0; n < side ** 3; n ++ ) {

			at[ 0 ] = origin[ 0 ] + ( ( n >> ( 2 * log2 ) ) << childShift );
			at[ 1 ] = origin[ 1 ] + ( ( ( n >> log2 ) & ( side - 1 ) ) << childShift );
			at[ 2 ] = origin[ 2 ] + ( ( n & ( side - 1 ) ) << childShift );
			if ( box && ! overlaps( box, at, size ) ) continue;
			const entry = node + level.table + n * 8;
			if ( ( bytes[ node + level.children + ( n >> 3 ) ] >> ( n & 7 ) ) & 1 ) {

				const child = node + Number( view.getBigInt64( entry, true ) );
				if ( level === UPPER ) internal( child, at, LOWER );
				else leaf( at, decode( child, values ) );

			} else {

				tile( at, size, valueAt( view, entry, type ), ( ( bytes[ node + level.values + ( n >> 3 ) ] >> ( n & 7 ) ) & 1 ) === 1 );

			}

		}

	};

	const tables = view.getUint32( root + ROOT_TABLE_SIZE, true );
	for ( let i = 0; i < tables; i ++ ) {

		const entry = root + spec.root + i * TILE_BYTES;
		const key = view.getBigUint64( entry, true );
		const origin = [ Number( ( key >> 42n ) & 0x1fffffn ) << 12, Number( ( key >> 21n ) & 0x1fffffn ) << 12, Number( key & 0x1fffffn ) << 12 ];
		if ( box && ! overlaps( box, origin, 4096 ) ) continue;
		const child = Number( view.getBigInt64( entry + 8, true ) );
		if ( child === 0 ) tile( origin, 4096, valueAt( view, entry + spec.tile, type ), view.getUint32( entry + 16, true ) !== 0 );
		else internal( root + child, origin, UPPER );

	}

}

// A leaf's 512 values into `out`. A quantised value is code × step + minimum, each step rounded to a float as
// nanovdb's getValue rounds it.
function leafDecoder( bytes, view, type ) {

	const { leaf: at, bits } = SCALAR[ type ];
	if ( type === 'double' ) return ( node, out ) => fillWith( out, ( n ) => view.getFloat64( node + at + n * 8, true ) );
	if ( type === 'half' ) return ( node, out ) => fillWith( out, ( n ) => DataUtils.fromHalfFloat( view.getUint16( node + at + n * 2, true ) ) );
	if ( bits === undefined ) return ( node, out ) => fillWith( out, ( n ) => view.getFloat32( node + at + n * 4, true ) );
	return ( node, out ) => {

		const min = view.getFloat32( node + LEAF_MINIMUM, true ), step = view.getFloat32( node + LEAF_STEP, true );
		const width = bits || 1 << ( bytes[ node + LEAF_FLAGS ] >> 5 );
		const codes = node + LEAF_CODES, mask = ( 1 << width ) - 1;
		for ( let n = 0; n < 512; n ++ ) {

			const code = width === 16 ? view.getUint16( codes + n * 2, true ) : ( bytes[ codes + ( ( n * width ) >> 3 ) ] >> ( ( n * width ) & 7 ) ) & mask;
			out[ n ] = Math.fround( code * step ) + min;

		}

		return out;

	};

}

function fillWith( out, value ) {

	for ( let n = 0; n < 512; n ++ ) out[ n ] = value( n );
	return out;

}

// A leaf's values into the box.
function leaf( box, origin, values ) {

	const { min, max, f, width, height, data, background, weight } = box;
	for ( let n = 0; n < 512; n ++ ) {

		const x = origin[ 0 ] + ( n >> 6 ), y = origin[ 1 ] + ( ( n >> 3 ) & 7 ), z = origin[ 2 ] + ( n & 7 );
		if ( x < min[ 0 ] || y < min[ 1 ] || z < min[ 2 ] || x > max[ 0 ] || y > max[ 1 ] || z > max[ 2 ] ) continue;
		const value = values[ n ];
		if ( f === 1 ) data[ x - min[ 0 ] + width * ( y - min[ 1 ] + height * ( z - min[ 2 ] ) ) ] = value;
		else data[ Math.floor( ( x - min[ 0 ] ) / f ) + width * ( Math.floor( ( y - min[ 1 ] ) / f ) + height * Math.floor( ( z - min[ 2 ] ) / f ) ) ] += ( value - background ) * weight;

	}

}

// A tile's value over its cube, clipped to the box.
function fill( box, origin, size, value ) {

	const { min, f, width, height, data, background, weight } = box;
	if ( value === background ) return;
	const lo = [ 0, 1, 2 ].map( ( a ) => Math.max( 0, origin[ a ] - min[ a ] ) );
	const hi = [ 0, 1, 2 ].map( ( a ) => Math.min( box.size[ a ], origin[ a ] + size - min[ a ] ) );
	if ( f === 1 ) {

		for ( let z = lo[ 2 ]; z < hi[ 2 ]; z ++ ) for ( let y = lo[ 1 ]; y < hi[ 1 ]; y ++ ) data.fill( value, width * ( y + height * z ) + lo[ 0 ], width * ( y + height * z ) + hi[ 0 ] );
		return;

	}

	// Each coarse cell takes the tile's share of its f³ voxels: as many steps as cells, not voxels.
	const [ xs, ys, zs ] = [ 0, 1, 2 ].map( ( a ) => {

		const cells = [];
		for ( let c = Math.floor( lo[ a ] / f ); c * f < hi[ a ]; c ++ ) cells.push( [ c, Math.min( hi[ a ], ( c + 1 ) * f ) - Math.max( lo[ a ], c * f ) ] );
		return cells;

	} );
	const add = ( value - background ) * weight;
	for ( const [ cz, oz ] of zs ) for ( const [ cy, oy ] of ys ) {

		const row = width * ( cy + height * cz ), share = add * oy * oz;
		for ( const [ cx, ox ] of xs ) data[ row + cx ] += share * ox;

	}

}

const overlaps = ( box, origin, size ) => origin[ 0 ] + size > box.min[ 0 ] && origin[ 0 ] <= box.max[ 0 ] &&
	origin[ 1 ] + size > box.min[ 1 ] && origin[ 1 ] <= box.max[ 1 ] &&
	origin[ 2 ] + size > box.min[ 2 ] && origin[ 2 ] <= box.max[ 2 ];

function version( view, at ) {

	const major = view.getUint32( at, true ) >>> 21;
	if ( major !== ABI ) throw new Error( `NanoVDB: version ${major} is not read (ABI ${ABI} only)` );

}

function u64( view, at ) {

	const v = view.getBigUint64( at, true );
	if ( v > BigInt( Number.MAX_SAFE_INTEGER ) ) throw new Error( 'NanoVDB: a size past 2^53' );
	return Number( v );

}

const i32s = ( view, at ) => [ 0, 4, 8 ].map( ( o ) => view.getInt32( at + o, true ) );
const ascii = ( bytes, at, n ) => String.fromCharCode( ...bytes.subarray( at, at + n ) );
const cString = ( bytes, at, n ) => ascii( bytes, at, n ).replace( /\0[\s\S]*$/, '' );

function need( bytes, end ) {

	if ( end > bytes.length ) throw new Error( `NanoVDB: the file ends at byte ${bytes.length}, ${end} needed` );

}
