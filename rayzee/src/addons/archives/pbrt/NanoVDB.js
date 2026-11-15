/**
 * NanoVDB files (.nvdb, ABI 32 — pbrt-v4's), as `nanovdb::io::readGrid` reads them: segments of grids, each stored
 * raw, Zip or Blosc. Float grids only (pbrt's `grid<float>()`), read dense over their active box.
 */

import { Matrix4 } from 'three';
import { unzlibSync } from 'three/addons/libs/fflate.module.js';
import { VolumeGrid } from '../../../scene/Volumes.js';

const MAGIC = 'NanoVDB0';
const ABI = 32;
const CODEC_NONE = 0, CODEC_ZIP = 1, CODEC_BLOSC = 2;
const GRID_TYPES = [ 'unknown', 'float', 'double', 'int16', 'int32', 'int64', 'vec3f', 'vec3d', 'mask', 'half', 'uint32',
	'boolean', 'rgba8', 'fp4', 'fp8', 'fp16', 'fpN', 'vec4f', 'vec4d' ];
const GRID_CLASSES = [ 'unknown', 'level set', 'fog volume', 'staggered', 'point index', 'point data', 'topology', 'voxel volume' ];
const META_BYTES = 176;
const BLOSC_CHUNK = 2 ** 30;

// Byte layouts of NanoVDB.h's GridData, TreeData, RootData (+ Tile), InternalData and LeafData<float>.
const GRID_BYTES = 672, GRID_MAP_D = 296 + 88, GRID_VEC_D = 296 + 232, GRID_TYPE = 636;
const ROOT_TABLE_SIZE = 24, ROOT_BACKGROUND = 28, ROOT_BYTES = 64, TILE_BYTES = 32;
const UPPER = { log2: 5, childShift: 7, values: 32, children: 32 + 4096, table: 8256 };
const LOWER = { log2: 4, childShift: 3, values: 32, children: 32 + 512, table: 1088 };
const LEAF_VALUES = 96;

/**
 * Every grid of a NanoVDB file: what its metadata says, and its values on demand (`read()`). A Blosc segment needs
 * `blosc` (OpenVDB.js's `bloscDecompress`, a module loaded on first use: `bloscReader()`).
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{ blosc?: (src: Uint8Array) => Uint8Array }} [options]
 * @returns {{ grids: NanoGrid[], blosc: boolean }}
 */
export function readNanoVDB( buffer, { blosc = null } = {} ) {

	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array( buffer );
	const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
	const grids = [];
	let pos = 0;
	while ( pos + 16 <= bytes.length ) {

		if ( ascii( bytes, pos, 8 ) !== MAGIC ) throw new Error( `NanoVDB: no file header at byte ${pos}` );
		const major = view.getUint32( pos + 8, true ) >>> 21;
		if ( major !== ABI ) throw new Error( `NanoVDB: version ${major} is not read (ABI ${ABI} only)` );
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
				type: GRID_TYPES[ view.getUint32( pos + 32, true ) ] ?? 'unknown',
				gridClass: GRID_CLASSES[ view.getUint32( pos + 36, true ) ] ?? 'unknown',
				indexBox: { min: i32s( view, pos + 88 ), max: i32s( view, pos + 100 ) },
				voxelSize: [ 0, 8, 16 ].map( ( o ) => view.getFloat64( pos + 112 + o, true ) ),
				name: ascii( bytes, pos + META_BYTES, nameSize ).replace( /\0[\s\S]*$/, '' )
			} );
			pos += META_BYTES + nameSize;

		}

		for ( const meta of metas ) {

			need( bytes, pos + meta.fileSize );
			grids.push( new NanoGrid( meta, bytes.subarray( pos, pos + meta.fileSize ), codec, blosc ) );
			pos += meta.fileSize;

		}

	}

	return { grids, blosc: grids.some( ( g ) => g.codec === CODEC_BLOSC ) };

}

/** OpenVDB.js's Blosc decoder, its module imported on first use. */
export const bloscReader = async () => ( await import( '../../../loaders/OpenVDB.js' ) ).bloscDecompress;

/** One grid of a file. */
class NanoGrid {

	constructor( meta, stored, codec, blosc ) {

		Object.assign( this, meta );
		this.codec = codec;
		this._stored = stored;
		this._blosc = blosc;

	}

	/** Its in-memory grid buffer, decompressed. */
	buffer() {

		const { _stored: stored, gridSize } = this;
		if ( this.codec === CODEC_NONE ) return stored.subarray( 0, gridSize );
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

		return out;

	}

	/**
	 * Its values over its active box, x fastest, as `tree().getValue( ijk )` returns them (inactive voxels and tiles
	 * included); past `maxVoxels` or `maxSide` each value is the mean of f³ voxels (f a power of 2), as OpenVDB grids are
	 * read. The map takes index to world space.
	 * @param {{ maxVoxels?: number, maxSide?: number }} [options]
	 * @returns {{ data: Float32Array, width: number, height: number, depth: number, min: number[], factor: number, matrix: Matrix4, background: number }}
	 */
	read( { maxVoxels = 2 ** 27, maxSide = 2048 } = {} ) {

		if ( this.type !== 'float' ) throw new Error( `NanoVDB: "${this.name}" is a ${this.type} grid (float grids only)` );
		const bytes = this.buffer();
		const view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
		if ( ascii( bytes, 0, 8 ) !== MAGIC ) throw new Error( `NanoVDB: "${this.name}" has no grid header` );
		if ( view.getUint32( GRID_TYPE, true ) !== 1 ) throw new Error( `NanoVDB: "${this.name}" is not a float grid` );
		const d = ( o ) => view.getFloat64( o, true );
		const m = Array.from( { length: 9 }, ( _, i ) => d( GRID_MAP_D + i * 8 ) ), t = [ 0, 1, 2 ].map( ( i ) => d( GRID_VEC_D + i * 8 ) );
		// world = M · ijk + t, M row-major (NanoVDB's matMult).
		const matrix = new Matrix4().set( m[ 0 ], m[ 1 ], m[ 2 ], t[ 0 ], m[ 3 ], m[ 4 ], m[ 5 ], t[ 1 ], m[ 6 ], m[ 7 ], m[ 8 ], t[ 2 ], 0, 0, 0, 1 );

		const root = GRID_BYTES + u64( view, GRID_BYTES + 24 );
		const background = view.getFloat32( root + ROOT_BACKGROUND, true );
		const { min, max } = this.indexBox;
		const size = [ 0, 1, 2 ].map( ( a ) => max[ a ] - min[ a ] + 1 );
		if ( size.some( ( v ) => ! ( v > 0 ) ) ) throw new Error( `NanoVDB: "${this.name}" holds no voxel` );
		let f = 1;
		while ( size.reduce( ( n, v ) => n * Math.ceil( v / f ), 1 ) > maxVoxels || Math.max( ...size ) / f > maxSide ) f *= 2;
		const [ width, height, depth ] = size.map( ( v ) => Math.ceil( v / f ) );
		const box = { min, max, size, f, width, height, data: new Float32Array( width * height * depth ), background, weight: 1 / ( f * f * f ) };
		if ( background !== 0 ) box.data.fill( background );

		const tables = view.getUint32( root + ROOT_TABLE_SIZE, true );
		for ( let i = 0; i < tables; i ++ ) {

			const tile = root + ROOT_BYTES + i * TILE_BYTES;
			const key = view.getBigUint64( tile, true );
			const origin = [ Number( ( key >> 42n ) & 0x1fffffn ) << 12, Number( ( key >> 21n ) & 0x1fffffn ) << 12, Number( key & 0x1fffffn ) << 12 ];
			const child = Number( view.getBigInt64( tile + 8, true ) );
			if ( child === 0 ) fill( box, origin, 4096, view.getFloat32( tile + 20, true ) );
			else internal( view, root + child, origin, UPPER, box );

		}

		return { data: box.data, width, height, depth, min, factor: f, matrix, background };

	}

	/**
	 * Its values as a volume grid, `parent` (a matrix) taking its world space to the volume's.
	 * @param {Matrix4} [parent]
	 * @param {{ maxVoxels?: number, maxSide?: number }} [options]
	 * @returns {VolumeGrid}
	 */
	toVolumeGrid( parent = new Matrix4(), options ) {

		const { data, width, height, depth, min, factor: f, matrix } = this.read( options );
		// Dense index ( i, j, k ) is the centre of its f³ voxels: min + f · index + ( f − 1 ) / 2.
		const centre = ( f - 1 ) / 2;
		const toIndex = new Matrix4().makeScale( f, f, f ).setPosition( min[ 0 ] + centre, min[ 1 ] + centre, min[ 2 ] + centre );
		const grid = new VolumeGrid( { width, height, depth, data, transform: parent.clone().multiply( matrix ).multiply( toIndex ), name: this.name } );
		grid.factor = f;
		return grid;

	}

}

// An internal node: its children (a lower node, else leaves) and its tiles over their cubes.
function internal( view, node, origin, level, box ) {

	const { log2, childShift } = level;
	const side = 1 << log2, size = 1 << childShift;
	const at = [ 0, 0, 0 ];
	for ( let n = 0; n < side ** 3; n ++ ) {

		at[ 0 ] = origin[ 0 ] + ( ( n >> ( 2 * log2 ) ) << childShift );
		at[ 1 ] = origin[ 1 ] + ( ( ( n >> log2 ) & ( side - 1 ) ) << childShift );
		at[ 2 ] = origin[ 2 ] + ( ( n & ( side - 1 ) ) << childShift );
		if ( ! overlaps( box, at, size ) ) continue;
		const entry = node + level.table + n * 8;
		if ( ( view.getUint8( node + level.children + ( n >> 3 ) ) >> ( n & 7 ) ) & 1 ) {

			const child = node + Number( view.getBigInt64( entry, true ) );
			if ( level === UPPER ) internal( view, child, at, LOWER, box );
			else leaf( view, child, at, box );

		} else {

			fill( box, at, size, view.getFloat32( entry, true ) );

		}

	}

}

function leaf( view, node, origin, box ) {

	const { min, max, f, width, height, data, background, weight } = box;
	for ( let n = 0; n < 512; n ++ ) {

		const x = origin[ 0 ] + ( n >> 6 ), y = origin[ 1 ] + ( ( n >> 3 ) & 7 ), z = origin[ 2 ] + ( n & 7 );
		if ( x < min[ 0 ] || y < min[ 1 ] || z < min[ 2 ] || x > max[ 0 ] || y > max[ 1 ] || z > max[ 2 ] ) continue;
		const value = view.getFloat32( node + LEAF_VALUES + n * 4, true );
		if ( f === 1 ) data[ x - min[ 0 ] + width * ( y - min[ 1 ] + height * ( z - min[ 2 ] ) ) ] = value;
		else data[ Math.floor( ( x - min[ 0 ] ) / f ) + width * ( Math.floor( ( y - min[ 1 ] ) / f ) + height * Math.floor( ( z - min[ 2 ] ) / f ) ) ] += ( value - background ) * weight;

	}

}

// A tile's value over its cube, clipped to the box.
function fill( box, origin, size, value ) {

	const { min, f, width, height, data, background, weight } = box;
	if ( value === background || ! overlaps( box, origin, size ) ) return;
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

function u64( view, at ) {

	const v = view.getBigUint64( at, true );
	if ( v > BigInt( Number.MAX_SAFE_INTEGER ) ) throw new Error( 'NanoVDB: a size past 2^53' );
	return Number( v );

}

const i32s = ( view, at ) => [ 0, 4, 8 ].map( ( o ) => view.getInt32( at + o, true ) );
const ascii = ( bytes, at, n ) => String.fromCharCode( ...bytes.subarray( at, at + n ) );

function need( bytes, end ) {

	if ( end > bytes.length ) throw new Error( `NanoVDB: the file ends at byte ${bytes.length}, ${end} needed` );

}
