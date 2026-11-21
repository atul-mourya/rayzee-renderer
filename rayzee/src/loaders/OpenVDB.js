/**
 * OpenVDB files (.vdb), read as OpenVDB's io reads them: grids' names, types, transforms and metadata, and scalar grids
 * (float, half, double; any tree) as a dense box of their active voxels. Zip, Blosc or no compression; linear maps.
 * NanoVDB files (.nvdb, NanoVDB.js) go through the same steps: `readVDB` tells the two apart.
 */

import { Group, Matrix4 } from 'three';
import { unzlibSync } from 'three/addons/libs/fflate.module.js';
import { Volume, VolumeGrid, unifyGrids } from '../scene/Volumes.js';
import { isNanoVDB, readNanoVDB } from './NanoVDB.js';

const MAGIC = 0x56444220;
const COMPRESS_ZIP = 0x1, COMPRESS_ACTIVE_MASK = 0x2, COMPRESS_BLOSC = 0x4;
// File format versions: per-grid compression and node masks from 222; grid instancing from 216.
const NODE_MASK_COMPRESSION = 222, GRID_INSTANCING = 216, SELECTIVE_COMPRESSION = 220;
// readCompressedValues' per-node flag: which inactive values are stored, and whether a mask picks between them.
const NO_MASK_OR_INACTIVE_VALS = 0, NO_MASK_AND_ONE_INACTIVE_VAL = 2, MASK_AND_NO_INACTIVE_VALS = 3, MASK_AND_ONE_INACTIVE_VAL = 4,
	MASK_AND_TWO_INACTIVE_VALS = 5, NO_MASK_AND_ALL_VALS = 6;
const SCALAR_TYPES = { float: 4, double: 8 };

class Reader {

	constructor( bytes ) {

		this.bytes = bytes;
		this.view = new DataView( bytes.buffer, bytes.byteOffset, bytes.byteLength );
		this.pos = 0;

	}

	need( n ) {

		if ( this.pos + n > this.bytes.length ) throw new RangeError( `OpenVDB: the file ends ${this.pos + n - this.bytes.length} bytes early` );

	}

	u8() {

		this.need( 1 );
		return this.bytes[ this.pos ++ ];

	}

	u32() {

		this.need( 4 );
		const v = this.view.getUint32( this.pos, true );
		this.pos += 4;
		return v;

	}

	i32() {

		this.need( 4 );
		const v = this.view.getInt32( this.pos, true );
		this.pos += 4;
		return v;

	}

	i64() {

		this.need( 8 );
		const v = this.view.getBigInt64( this.pos, true );
		this.pos += 8;
		return Number( v );

	}

	f64() {

		this.need( 8 );
		const v = this.view.getFloat64( this.pos, true );
		this.pos += 8;
		return v;

	}

	take( n ) {

		this.need( n );
		const v = this.bytes.subarray( this.pos, this.pos + n );
		this.pos += n;
		return v;

	}

	string() {

		return new TextDecoder().decode( this.take( this.u32() ) );

	}

	// A value of `size` bytes: 4 a float, 8 a double.
	value( size ) {

		this.need( size );
		const v = size === 8 ? this.view.getFloat64( this.pos, true ) : this.view.getFloat32( this.pos, true );
		this.pos += size;
		return v;

	}

	coord() {

		return [ this.i32(), this.i32(), this.i32() ];

	}

}

/**
 * Reads an OpenVDB file's header and grid descriptors; each grid's data is read when asked for.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{ version: number, library: number[], metadata: Object, grids: OpenVDBGrid[] }}
 */
export function readOpenVDB( buffer ) {

	const r = new Reader( buffer instanceof Uint8Array ? buffer : new Uint8Array( buffer ) );
	if ( r.u32() !== MAGIC || r.u32() !== 0 ) throw new Error( 'not an OpenVDB file' );
	const version = r.u32();
	if ( version < 213 ) throw new Error( `OpenVDB file format ${version} is too old (213 or later is read)` );
	const library = [ r.u32(), r.u32() ];
	const hasGridOffsets = r.u8() !== 0;
	if ( ! hasGridOffsets ) throw new Error( 'OpenVDB: a file written as a stream (no grid offsets) is not read' );
	let compression = COMPRESS_ZIP;
	if ( version >= SELECTIVE_COMPRESSION && version < NODE_MASK_COMPRESSION ) compression = r.u8() ? COMPRESS_ZIP : 0;
	r.take( 36 ); // the file's UUID, as text
	const metadata = readMetadata( r );
	const count = r.i32();
	const grids = [];
	for ( let i = 0; i < count; i ++ ) {

		const unique = r.string();
		let type = r.string();
		const half = type.endsWith( '_HalfFloat' );
		if ( half ) type = type.slice( 0, - '_HalfFloat'.length );
		const parent = version >= GRID_INSTANCING ? r.string() : '';
		const gridPos = r.i64(), blockPos = r.i64(), endPos = r.i64();
		grids.push( new OpenVDBGrid( r, { name: unique.split( '\x1e' )[ 0 ], type, half, parent, gridPos, blockPos, endPos, version, compression } ) );
		r.pos = endPos;

	}

	return { version, library, metadata, grids };

}

/**
 * An OpenVDB or a NanoVDB file's grids, told apart by its first bytes; their grids read alike. `up` is a NanoVDB file's
 * (see readNanoVDB); an OpenVDB file's is `upAxisOf` its metadata.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {{ metadata: Object, up?: string, grids: Array<{ name: string, scalar: boolean, toVolumeGrid: Function, maxValue: Function }> }}
 */
export function readVDB( buffer ) {

	const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array( buffer );
	return isNanoVDB( bytes ) ? readNanoVDB( bytes, { blosc: bloscDecompress } ) : readOpenVDB( bytes );

}

// Names simulators give a grid that glows: a temperature (blackbody), or a flame.
const TEMPERATURE = /^(temperature|temp)$/i, FLAME = /^(flame|flames|fire|heat|emission)$/i;

/**
 * An OpenVDB or NanoVDB file as a volume in a group named after it, its grids picked by `pickGrids`.
 * @param {ArrayBuffer|Uint8Array} buffer
 * @param {{ name?: string, maxVoxels?: number }} [options]
 * @returns {Group}
 */
export function volumeFromOpenVDB( buffer, { name = 'volume', maxVoxels } = {} ) {

	const { grids, metadata, up } = readVDB( buffer );
	const picked = pickGrids( grids, name );
	const frame = frameGrids( picked.density?.toVolumeGrid( { maxVoxels } ) ?? null, picked.glow?.toVolumeGrid( { maxVoxels } ) ?? null );
	if ( ! frame ) throw new Error( `VDB: "${name}" holds no voxel` );
	return volumeGroup( frame.grid, frame.emission, picked, name, { up: up ?? upAxisOf( metadata ), peak: picked.glow?.maxValue() ?? 0 } );

}

// A frame's density and glow on one box. A fire with no smoke (no density grid) glows from a density of nothing.
function frameGrids( density, glow ) {

	if ( ! density && ! glow ) return null;
	const grid = density ?? new VolumeGrid( { ...glow, data: new Float32Array( glow.data.length ), name: 'density' } );
	return { ...unifyGrids( grid, glow ), factor: ( density ?? glow ).factor };

}

/**
 * The grids a file's volume is made of: `density`, the grid called density (else the first fog volume), and `glow`, a
 * temperature grid (`blackbody`) or else a flame grid. Either may be null, not both: a fire alone has no density.
 */
export function pickGrids( grids, name = 'volume' ) {

	const scalar = grids.filter( ( g ) => g.scalar && ! g.parent && g.gridClass !== 'level set' );
	const density = scalar.find( ( g ) => /^density$/i.test( g.name ) ) ?? scalar.find( ( g ) => g.gridClass === 'fog volume' && ! TEMPERATURE.test( g.name ) && ! FLAME.test( g.name ) ) ?? null;
	const temperature = scalar.find( ( g ) => TEMPERATURE.test( g.name ) );
	const glow = temperature ?? scalar.find( ( g ) => FLAME.test( g.name ) ) ?? null;
	if ( ! density && ! glow ) throw new Error( `VDB: "${name}" has no density, temperature or flame grid (its grids: ${grids.map( ( g ) => `${g.name} (${g.valueType})` ).join( ', ' )})` );
	return { density, glow, blackbody: !! temperature };

}

/**
 * One frame of a sequence: the grids named `density` and `emission` read dense (`maxVoxels`, `maxSide`, at least
 * `factor`) and put on one box; with no density, one of nothing. Both null where the frame holds no voxel.
 * @returns {{ grid: ?VolumeGrid, emission: ?VolumeGrid, factor: number }}
 */
export function readVolumeFrame( bytes, { density, emission, maxVoxels, maxSide, factor = 1 } ) {

	const { grids } = readVDB( bytes );
	const read = ( name ) => ( name ? grids.find( ( g ) => g.name === name )?.toVolumeGrid( { maxVoxels, maxSide, factor } ) ?? null : null );
	return frameGrids( read( density ), read( emission ) ) ?? { grid: null, emission: null, factor };

}

// Tools that write Y-up VDBs and say who they are. Blender and EmberGen name none and write Z-up.
const Y_UP_CREATORS = /houdini|maya|bifrost|katana|clarisse|nuke/i;

/** Which axis a file's volumes stand along: 'y' when its creator is a Y-up tool, else 'z'. */
export const upAxisOf = ( metadata ) => ( Y_UP_CREATORS.test( metadata?.creator ?? '' ) ? 'y' : 'z' );

/**
 * Kelvin a unit of a temperature grid whose hottest voxel is `peak`: Blender's 1000, raised so that voxel reaches at
 * least 2500 K (EmberGen's grids peak near 1) and lowered so it stays at 4500 K at most (a grid in hundreds of kelvin);
 * a grid already in kelvin (past 100) is read as kelvin.
 */
const kelvinPerUnit = ( peak ) => ( peak > 100 ? 1 : peak > 0 ? Math.min( Math.max( 1000, 2500 / peak ), 4500 / peak ) : 1000 );

/**
 * A volume of these grids in a group of its own, glowing as `picked` says, stood upright (`up`: the file's vertical
 * axis), a temperature grid read at `kelvinPerUnit` of its `peak`.
 */
export function volumeGroup( grid, emission, picked, name, { up = 'y', peak = emission?.max ?? 0 } = {} ) {

	const volume = new Volume( grid );
	volume.name = name;
	if ( up === 'z' ) volume.rotation.x = - Math.PI / 2;
	if ( picked.glow ) {

		// Packed even while empty: a sequence's later frames may glow.
		volume.emissionGrid = emission ?? new VolumeGrid( { ...grid, data: new Float32Array( grid.data.length ) } );
		volume.emissionStrength = 1;
		volume.blackbody = picked.blackbody;
		if ( volume.blackbody ) volume.temperature = kelvinPerUnit( peak );
		else volume.emissionColor.setRGB( 1, 0.35, 0.08 );

	}

	const group = new Group();
	group.name = name;
	return group.add( volume );

}

function readMetadata( r ) {

	const out = {};
	const count = r.i32();
	for ( let i = 0; i < count; i ++ ) {

		const name = r.string();
		const type = r.string();
		const size = r.u32();
		const end = r.pos + size;
		const view = r.view, at = r.pos;
		switch ( type ) {

			case 'string': out[ name ] = new TextDecoder().decode( r.take( size ) ); break;
			case 'bool': out[ name ] = r.bytes[ at ] !== 0; break;
			case 'int32': out[ name ] = view.getInt32( at, true ); break;
			case 'int64': out[ name ] = Number( view.getBigInt64( at, true ) ); break;
			case 'float': out[ name ] = view.getFloat32( at, true ); break;
			case 'double': out[ name ] = view.getFloat64( at, true ); break;
			case 'vec3i': out[ name ] = [ 0, 4, 8 ].map( ( o ) => view.getInt32( at + o, true ) ); break;
			case 'vec3s': out[ name ] = [ 0, 4, 8 ].map( ( o ) => view.getFloat32( at + o, true ) ); break;
			case 'vec3d': out[ name ] = [ 0, 8, 16 ].map( ( o ) => view.getFloat64( at + o, true ) ); break;
			default: break;

		}

		r.pos = end;

	}

	return out;

}

// Index space → world: OpenVDB's linear maps. Its matrices act on row vectors (translation in the last row).
function readTransform( r ) {

	const type = r.string();
	const vec = () => [ r.f64(), r.f64(), r.f64() ];
	const m = new Matrix4();
	if ( type === 'UniformScaleMap' || type === 'ScaleMap' ) {

		const s = vec();
		for ( let i = 0; i < 4; i ++ ) vec();
		return m.makeScale( ...s );

	}

	if ( type === 'UniformScaleTranslateMap' || type === 'ScaleTranslateMap' ) {

		const t = vec(), s = vec();
		for ( let i = 0; i < 4; i ++ ) vec();
		return m.makeScale( ...s ).setPosition( ...t );

	}

	if ( type === 'TranslationMap' ) return m.makeTranslation( ...vec() );
	if ( type === 'AffineMap' || type === 'UnitaryMap' ) {

		const e = Array.from( { length: 16 }, () => r.f64() );
		return m.set( e[ 0 ], e[ 4 ], e[ 8 ], e[ 12 ], e[ 1 ], e[ 5 ], e[ 9 ], e[ 13 ], e[ 2 ], e[ 6 ], e[ 10 ], e[ 14 ], e[ 3 ], e[ 7 ], e[ 11 ], e[ 15 ] );

	}

	throw new Error( `OpenVDB: the ${type} transform is not read (linear maps only)` );

}

const ones = ( mask, i ) => ( mask[ i >> 3 ] >> ( i & 7 ) ) & 1;

function countOn( mask ) {

	let n = 0;
	for ( let i = 0; i < mask.length; i ++ ) {

		let b = mask[ i ];
		while ( b ) {

			b &= b - 1;
			n ++;

		}

	}

	return n;

}

/** One grid of a file: what the descriptor and its header say, and its values on demand. */
class OpenVDBGrid {

	constructor( r, descriptor ) {

		Object.assign( this, descriptor );
		this._reader = r;
		const m = descriptor.type.match( /^Tree_(\w+?)((?:_\d+)+)$/ );
		this.valueType = m?.[ 1 ] ?? descriptor.type;
		this.levels = m ? m[ 2 ].slice( 1 ).split( '_' ).map( Number ) : [];
		this.scalar = this.valueType in SCALAR_TYPES && this.levels.length > 0;
		r.pos = descriptor.gridPos;
		this.compression = descriptor.version >= NODE_MASK_COMPRESSION ? r.u32() : descriptor.compression;
		this.metadata = readMetadata( r );
		this.transform = descriptor.version >= GRID_INSTANCING ? readTransform( r ) : null;
		this._topology = r.pos;

	}

	/** "fog volume", "level set" or "unknown", as the grid says. */
	get gridClass() {

		return this.metadata.class ?? 'unknown';

	}

	/** The active index box ({ min, max }) the file records, else null. */
	get recordedBox() {

		const { file_bbox_min: min, file_bbox_max: max } = this.metadata;
		return min && max && min.every( ( v, k ) => v <= max[ k ] ) ? { min, max } : null;

	}

	/**
	 * The grid dense over its active box, halved as often as `maxVoxels` / `maxSide` ask (at least `factor` times; the
	 * result's `factor` says how often).
	 * @param {{ maxVoxels?: number, maxSide?: number, factor?: number }} [options]
	 * @returns {?VolumeGrid} null when the grid holds no voxel
	 */
	toVolumeGrid( { maxVoxels = 2 ** 27, maxSide = 2048, factor = 1 } = {} ) {

		if ( ! this.scalar ) throw new Error( `OpenVDB: grid "${this.name}" holds ${this.valueType} values; scalar grids only` );
		if ( this.parent ) throw new Error( `OpenVDB: grid "${this.name}" is an instance of "${this.parent}"; instanced grids are not read` );
		const tree = this._readTopology();
		const box = this._box( tree );
		if ( ! box ) return null;
		const size = [ 0, 1, 2 ].map( ( a ) => box.max[ a ] - box.min[ a ] + 1 );
		let f = factor;
		while ( size.reduce( ( n, s ) => n * Math.ceil( s / f ), 1 ) > maxVoxels || Math.max( ...size ) / f > maxSide ) f *= 2;
		const [ W, H, D ] = size.map( ( s ) => Math.ceil( s / f ) );
		const data = new Float32Array( W * H * D );
		if ( tree.background !== 0 ) data.fill( tree.background );
		const weight = 1 / ( f * f * f );

		// Values over a box of index space [ lo, hi ] (inclusive), each dense cell taking its share.
		const fill = ( lo, hi, value ) => {

			const a = lo.map( ( v, k ) => Math.max( v, box.min[ k ] ) ), b = hi.map( ( v, k ) => Math.min( v, box.max[ k ] ) );
			if ( a.some( ( v, k ) => v > b[ k ] ) ) return;
			for ( let z = a[ 2 ]; z <= b[ 2 ]; z ++ ) for ( let y = a[ 1 ]; y <= b[ 1 ]; y ++ ) {

				const row = W * ( Math.floor( ( y - box.min[ 1 ] ) / f ) + H * Math.floor( ( z - box.min[ 2 ] ) / f ) );
				for ( let x = a[ 0 ]; x <= b[ 0 ]; x ++ ) {

					const i = row + Math.floor( ( x - box.min[ 0 ] ) / f );
					if ( f === 1 ) data[ i ] = value;
					else data[ i ] += ( value - tree.background ) * weight;

				}

			}

		};

		for ( const tile of tree.tiles ) if ( tile.value !== tree.background ) fill( tile.min, tile.max, tile.value );

		const leafSize = 1 << this.levels[ this.levels.length - 1 ];
		const L = this.levels[ this.levels.length - 1 ];
		this._eachLeaf( tree, ( origin, values ) => {

			if ( ! origin.every( ( o, k ) => o + leafSize - 1 >= box.min[ k ] && o <= box.max[ k ] ) ) return;
			for ( let n = 0; n < values.length; n ++ ) {

				const x = origin[ 0 ] + ( n >> ( 2 * L ) ), y = origin[ 1 ] + ( ( n >> L ) & ( leafSize - 1 ) ), z = origin[ 2 ] + ( n & ( leafSize - 1 ) );
				if ( x < box.min[ 0 ] || y < box.min[ 1 ] || z < box.min[ 2 ] || x > box.max[ 0 ] || y > box.max[ 1 ] || z > box.max[ 2 ] ) continue;
				const i = Math.floor( ( x - box.min[ 0 ] ) / f ) + W * ( Math.floor( ( y - box.min[ 1 ] ) / f ) + H * Math.floor( ( z - box.min[ 2 ] ) / f ) );
				if ( f === 1 ) data[ i ] = values[ n ];
				else data[ i ] += ( values[ n ] - tree.background ) * weight;

			}

		} );

		// Dense index ( i, j, k ) is the centre of its f³ voxels: box.min + f · index + ( f − 1 ) / 2.
		const centre = ( f - 1 ) / 2;
		const toIndex = new Matrix4().makeScale( f, f, f ).setPosition( box.min[ 0 ] + centre, box.min[ 1 ] + centre, box.min[ 2 ] + centre );
		const transform = ( this.transform ?? new Matrix4() ).clone().multiply( toIndex );
		const grid = new VolumeGrid( { width: W, height: H, depth: D, data, transform, name: this.name } );
		grid.factor = f;
		return grid;

	}

	/** The largest value the grid holds, in its leaves and active tiles; its background where it holds none. */
	maxValue() {

		const tree = this._readTopology();
		let max = tree.leaves.length || tree.tiles.length ? - Infinity : tree.background;
		for ( const tile of tree.tiles ) max = Math.max( max, tile.value );
		this._eachLeaf( tree, ( origin, values ) => {

			for ( let n = 0; n < values.length; n ++ ) if ( values[ n ] > max ) max = values[ n ];

		} );
		return max;

	}

	// Every leaf's origin and values, in file order.
	_eachLeaf( tree, visit ) {

		const r = this._reader;
		r.pos = tree.buffers;
		const count = ( 1 << this.levels[ this.levels.length - 1 ] ) ** 3;
		for ( const origin of tree.leaves ) {

			const mask = r.take( count / 8 );
			if ( this.version < NODE_MASK_COMPRESSION ) {

				r.coord();
				r.u8();

			}

			visit( origin, this._values( r, count, mask, tree.background ) );

		}

	}

	// The tree's shape: its leaves' origins in file order, its tiles' boxes and values, where the buffers start.
	_readTopology() {

		const r = this._reader;
		r.pos = this._topology;
		r.i32(); // buffer count, always 1
		const size = SCALAR_TYPES[ this.valueType ];
		const background = r.value( size );
		const numTiles = r.u32(), numChildren = r.u32();
		const tree = { background, tiles: [], leaves: [], buffers: 0 };
		const spans = this.levels.map( ( _, i ) => this.levels.slice( i ).reduce( ( a, b ) => a + b, 0 ) );
		const rootSpan = 1 << spans[ 0 ];
		for ( let i = 0; i < numTiles; i ++ ) {

			const min = r.coord();
			const value = r.value( size );
			const active = r.u8() !== 0;
			if ( active ) tree.tiles.push( { min, max: min.map( ( v ) => v + rootSpan - 1 ), value, active } );

		}

		const node = ( origin, level ) => {

			const L = this.levels[ level ];
			if ( level === this.levels.length - 1 ) {

				r.take( ( 1 << ( 3 * L ) ) / 8 );
				tree.leaves.push( origin );
				return;

			}

			const n = 1 << ( 3 * L );
			const childMask = r.take( n / 8 );
			const valueMask = r.take( n / 8 );
			// Before 222 only the slots without a child stored a value, in order.
			const stored = this.version < NODE_MASK_COMPRESSION ? n - countOn( childMask ) : n;
			const packed = this._values( r, stored, valueMask, background );
			const values = stored === n ? packed : new Float64Array( n );
			if ( stored !== n ) for ( let i = 0, k = 0; i < n; i ++ ) if ( ! ones( childMask, i ) ) values[ i ] = packed[ k ++ ];
			const child = spans[ level + 1 ];
			const coordOf = ( i ) => [ origin[ 0 ] + ( ( i >> ( 2 * L ) ) << child ), origin[ 1 ] + ( ( ( i >> L ) & ( ( 1 << L ) - 1 ) ) << child ), origin[ 2 ] + ( ( i & ( ( 1 << L ) - 1 ) ) << child ) ];
			for ( let i = 0; i < n; i ++ ) {

				if ( ones( childMask, i ) || ! ones( valueMask, i ) ) continue;
				const min = coordOf( i );
				tree.tiles.push( { min, max: min.map( ( v ) => v + ( 1 << child ) - 1 ), value: values[ i ], active: true } );

			}

			for ( let i = 0; i < n; i ++ ) if ( ones( childMask, i ) ) node( coordOf( i ), level + 1 );

		};

		for ( let i = 0; i < numChildren; i ++ ) node( r.coord(), 0 );
		tree.buffers = r.pos;
		return tree;

	}

	// The box of index space the dense grid covers: the file's active box, else every leaf and active tile.
	_box( tree ) {

		const { file_bbox_min: min, file_bbox_max: max } = this.metadata;
		if ( min && max && min.every( ( v, k ) => v <= max[ k ] ) ) return { min, max };
		const leaf = 1 << this.levels[ this.levels.length - 1 ];
		const lo = [ Infinity, Infinity, Infinity ], hi = [ - Infinity, - Infinity, - Infinity ];
		for ( const o of tree.leaves ) for ( let k = 0; k < 3; k ++ ) {

			lo[ k ] = Math.min( lo[ k ], o[ k ] );
			hi[ k ] = Math.max( hi[ k ], o[ k ] + leaf - 1 );

		}

		for ( const t of tree.tiles ) for ( let k = 0; k < 3; k ++ ) {

			lo[ k ] = Math.min( lo[ k ], t.min[ k ] );
			hi[ k ] = Math.max( hi[ k ], t.max[ k ] );

		}

		return lo[ 0 ] <= hi[ 0 ] ? { min: lo, max: hi } : null;

	}

	// OpenVDB's readCompressedValues: `count` values of a node, inactive ones rebuilt from what the node stored.
	_values( r, count, valueMask, background ) {

		const size = SCALAR_TYPES[ this.valueType ];
		const flag = this.version >= NODE_MASK_COMPRESSION ? r.u8() : NO_MASK_AND_ALL_VALS;
		let inactive0 = flag === NO_MASK_OR_INACTIVE_VALS ? background : - background;
		let inactive1 = background;
		if ( flag === NO_MASK_AND_ONE_INACTIVE_VAL || flag === MASK_AND_ONE_INACTIVE_VAL || flag === MASK_AND_TWO_INACTIVE_VALS ) inactive0 = r.value( size );
		if ( flag === MASK_AND_TWO_INACTIVE_VALS ) inactive1 = r.value( size );
		const selection = flag === MASK_AND_NO_INACTIVE_VALS || flag === MASK_AND_ONE_INACTIVE_VAL || flag === MASK_AND_TWO_INACTIVE_VALS ? r.take( count / 8 ) : null;
		const masked = ( this.compression & COMPRESS_ACTIVE_MASK ) && flag !== NO_MASK_AND_ALL_VALS && this.version >= NODE_MASK_COMPRESSION;
		const stored = masked ? countOn( valueMask ) : count;
		const width = this.half ? 2 : size;
		// OpenVDB's HalfWriter writes nothing at all for no values; full floats still get a size.
		const raw = this.half && stored === 0 ? new Uint8Array( 0 ) : readData( r, stored * width, this.compression );
		const view = new DataView( raw.buffer, raw.byteOffset, raw.byteLength );
		const read = this.half ? ( i ) => halfToFloat( view.getUint16( i * 2, true ) ) : size === 8 ? ( i ) => view.getFloat64( i * 8, true ) : ( i ) => view.getFloat32( i * 4, true );
		const out = new Float64Array( count );
		if ( stored === count ) {

			for ( let i = 0; i < count; i ++ ) out[ i ] = read( i );
			return out;

		}

		for ( let i = 0, k = 0; i < count; i ++ ) out[ i ] = ones( valueMask, i ) ? read( k ++ ) : selection && ones( selection, i ) ? inactive1 : inactive0;
		return out;

	}

}

function readData( r, bytes, compression ) {

	if ( ! ( compression & ( COMPRESS_ZIP | COMPRESS_BLOSC ) ) ) return r.take( bytes );
	const stored = r.i64();
	if ( stored <= 0 ) {

		if ( - stored !== bytes ) throw new Error( `OpenVDB: ${- stored} bytes stored where ${bytes} were expected` );
		return r.take( - stored );

	}

	const packed = r.take( stored );
	const out = compression & COMPRESS_BLOSC ? bloscDecompress( packed ) : unzlibSync( packed, { out: new Uint8Array( bytes ) } );
	if ( out.length !== bytes ) throw new Error( `OpenVDB: ${out.length} bytes unpacked where ${bytes} were expected` );
	return out;

}

const HALF = new Float32Array( 1 << 16 );
for ( let h = 0; h < 1 << 16; h ++ ) {

	const sign = h & 0x8000 ? - 1 : 1, e = ( h >> 10 ) & 31, m = h & 1023;
	HALF[ h ] = sign * ( e === 0 ? m * 2 ** - 24 : e === 31 ? ( m ? NaN : Infinity ) : ( 1 + m / 1024 ) * 2 ** ( e - 15 ) );

}

const halfToFloat = ( h ) => HALF[ h ];

/**
 * A Blosc 1 frame: its blocks, each in one stream or one a byte of the type, LZ4 (or zlib) or stored, then byte-unshuffled.
 * @param {Uint8Array} src
 * @returns {Uint8Array}
 */
export function bloscDecompress( src ) {

	const view = new DataView( src.buffer, src.byteOffset, src.byteLength );
	const flags = src[ 2 ], typesize = src[ 3 ];
	const nbytes = view.getUint32( 4, true ), blocksize = view.getUint32( 8, true );
	const out = new Uint8Array( nbytes );
	if ( flags & 0x2 ) {

		out.set( src.subarray( 16, 16 + nbytes ) );
		return out;

	}

	if ( flags & 0x4 ) throw new Error( 'Blosc: bit shuffle is not read' );
	const codec = flags >> 5;
	if ( codec !== 1 && codec !== 3 ) throw new Error( `Blosc: compressor ${[ 'blosclz', 'lz4', 'snappy', 'zlib', 'zstd' ][ codec ] ?? codec} is not read` );
	const nblocks = Math.ceil( nbytes / blocksize );
	const leftover = nbytes % blocksize;
	const shuffled = ( flags & 0x1 ) && typesize > 1;
	const tmp = shuffled ? new Uint8Array( blocksize ) : null;
	for ( let b = 0; b < nblocks; b ++ ) {

		const last = b === nblocks - 1 && leftover > 0;
		const bsize = last ? leftover : blocksize;
		const split = ! ( flags & 0x10 ) && ! last && typesize <= 16 && bsize / typesize >= 128;
		const streams = split ? typesize : 1;
		const neblock = bsize / streams;
		const dest = shuffled ? tmp : out.subarray( b * blocksize, b * blocksize + bsize );
		let pos = view.getInt32( 16 + 4 * b, true );
		for ( let s = 0; s < streams; s ++ ) {

			const cbytes = view.getInt32( pos, true );
			pos += 4;
			const target = dest.subarray( s * neblock, ( s + 1 ) * neblock );
			if ( cbytes === neblock ) target.set( src.subarray( pos, pos + cbytes ) );
			else if ( codec === 1 ) lz4Block( src, pos, pos + cbytes, target );
			else target.set( unzlibSync( src.subarray( pos, pos + cbytes ), { out: new Uint8Array( neblock ) } ) );
			pos += cbytes;

		}

		if ( shuffled ) {

			const into = out.subarray( b * blocksize, b * blocksize + bsize );
			const n = Math.floor( bsize / typesize );
			for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < typesize; i ++ ) into[ j * typesize + i ] = tmp[ i * n + j ];
			for ( let k = n * typesize; k < bsize; k ++ ) into[ k ] = tmp[ k ];

		}

	}

	return out;

}

// An LZ4 block (no frame) from src[ start, end ) into dst, which it fills exactly.
function lz4Block( src, start, end, dst ) {

	let s = start, d = 0;
	while ( s < end ) {

		const token = src[ s ++ ];
		let literals = token >> 4;
		if ( literals === 15 ) for ( let b = 255; b === 255; ) literals += b = src[ s ++ ];
		for ( let k = 0; k < literals; k ++ ) dst[ d ++ ] = src[ s ++ ];
		if ( s >= end ) break;
		const offset = src[ s ] | ( src[ s + 1 ] << 8 );
		s += 2;
		let length = ( token & 15 ) + 4;
		if ( ( token & 15 ) === 15 ) for ( let b = 255; b === 255; ) length += b = src[ s ++ ];
		for ( let m = d - offset, k = 0; k < length; k ++ ) dst[ d ++ ] = dst[ m ++ ];

	}

	if ( d !== dst.length ) throw new Error( `LZ4: ${d} bytes unpacked where ${dst.length} were expected` );

}
