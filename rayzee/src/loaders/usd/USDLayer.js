/**
 * A USD layer in one shape for both file formats: a tree of prim specs, each with its specifier, metadata,
 * composition arcs (as list ops), variant sets and properties. USDText.js fills it from .usda, parseUSDC from crate
 * (.usdc) files.
 */

/** A reference or payload: `@asset@<path>`; `asset` is empty for one inside the same layer stack. */
export class Ref {

	constructor( asset, path ) {

		this.asset = asset;
		this.path = path;

	}

}

export const listOp = () => ( { explicit: null, prepend: [], append: [], add: [], delete: [] } );

const itemKey = item => ( item instanceof Ref ? `${item.asset}\u0000${item.path}` : String( item ) );

/** List ops, given strongest first, applied weakest first; each item's `source` is its op's entry in `sources`. */
export function composeListOps( ops, sources = null ) {

	let items = [];
	for ( let k = ops.length - 1; k >= 0; k -- ) {

		const op = ops[ k ];
		if ( ! op ) continue;
		const tag = list => list.map( value => ( { value, source: sources ? sources[ k ] : null } ) );
		if ( op.explicit ) {

			items = tag( op.explicit );
			continue;

		}

		const drop = list => {

			const keys = new Set( list.map( itemKey ) );
			if ( keys.size ) items = items.filter( item => ! keys.has( itemKey( item.value ) ) );

		};

		drop( op.delete );
		const present = new Set( items.map( item => itemKey( item.value ) ) );
		for ( const item of tag( op.add ) ) if ( ! present.has( itemKey( item.value ) ) ) items.push( item );
		drop( op.prepend );
		items = [ ...tag( op.prepend ), ...items ];
		drop( op.append );
		items = [ ...items, ...tag( op.append ) ];

	}

	return items;

}

function assignOp( target, op, items ) {

	if ( op === 'explicit' ) target.explicit = items;
	else if ( op !== 'reorder' ) target[ op ].push( ...items );

}

export class PropSpec {

	constructor( name ) {

		this.name = name;
		this.rel = false;
		this.type = '';
		this._value = undefined;
		this._lazyValue = null;
		this.hasValue = false;
		this._timeSamples = null;
		this._lazySamples = null;
		this.targets = null;
		this.connections = null;
		this.meta = {};
		this.uniform = false;
		this.custom = false;

	}

	// A crate value is decoded the first time it is read: most of a production file is never asked for.
	get value() {

		if ( this._lazyValue ) {

			this._value = this._lazyValue();
			this._lazyValue = null;

		}

		return this._value;

	}

	set value( value ) {

		this._value = value;
		this._lazyValue = null;

	}

	get timeSamples() {

		if ( this._lazySamples ) {

			this._timeSamples = this._lazySamples();
			this._lazySamples = null;

		}

		return this._timeSamples;

	}

	set timeSamples( samples ) {

		this._timeSamples = samples;
		this._lazySamples = null;

	}

	setTargets( op, paths ) {

		assignOp( this.targets ??= listOp(), op, paths );

	}

	setConnections( op, paths ) {

		assignOp( this.connections ??= listOp(), op, paths );

	}

}

export class PrimSpec {

	constructor( name ) {

		this.name = name;
		this.specifier = 'over';
		this.typeName = '';
		this.meta = {};
		this.arcs = null;
		this.variantSelection = null;
		this.variantSets = null;
		this.children = null;
		this.props = null;
		this.reorder = null;

	}

	child( name, create = false ) {

		let spec = this.children?.get( name ) ?? null;
		if ( ! spec && create ) {

			this.children ??= new Map();
			this.children.set( name, spec = new PrimSpec( name ) );

		}

		return spec;

	}

	variant( set, name, create = false ) {

		let variants = this.variantSets?.get( set ) ?? null;
		if ( ! variants ) {

			if ( ! create ) return null;
			this.variantSets ??= new Map();
			this.variantSets.set( set, variants = new Map() );

		}

		let spec = variants.get( name ) ?? null;
		if ( ! spec && create && name ) variants.set( name, spec = new PrimSpec( name ) );
		return spec;

	}

	property( name, create = false ) {

		let prop = this.props?.get( name ) ?? null;
		if ( ! prop && create ) {

			this.props ??= new Map();
			this.props.set( name, prop = new PropSpec( name ) );

		}

		return prop;

	}

	setArc( key, op, items ) {

		this.arcs ??= {};
		assignOp( this.arcs[ key ] ??= listOp(), op, items );

	}

}

export class Layer {

	constructor( path ) {

		this.path = path;
		this.meta = {};
		this.root = new PrimSpec( '' );
		this.root.specifier = 'def';

	}

}


// ── crate files ───────────────────────────────────────────────────

const T = {
	Bool: 1, UChar: 2, Int: 3, UInt: 4, Int64: 5, UInt64: 6, Half: 7, Float: 8, Double: 9, String: 10, Token: 11,
	AssetPath: 12, Matrix2d: 13, Matrix3d: 14, Matrix4d: 15, Quatd: 16, Quatf: 17, Quath: 18, Vec2d: 19, Vec2f: 20,
	Vec2h: 21, Vec2i: 22, Vec3d: 23, Vec3f: 24, Vec3h: 25, Vec3i: 26, Vec4d: 27, Vec4f: 28, Vec4h: 29, Vec4i: 30,
	Dictionary: 31, TokenListOp: 32, StringListOp: 33, PathListOp: 34, ReferenceListOp: 35, IntListOp: 36,
	Int64ListOp: 37, UIntListOp: 38, UInt64ListOp: 39, PathVector: 40, TokenVector: 41, Specifier: 42, Permission: 43,
	Variability: 44, VariantSelectionMap: 45, TimeSamples: 46, Payload: 47, DoubleVector: 48, LayerOffsetVector: 49,
	StringVector: 50, ValueBlock: 51, Value: 52, PayloadListOp: 55, TimeCode: 56,
};

// Element layout of the fixed-size types: [ components, scalar kind ].
const LAYOUT = {
	[ T.Bool ]: [ 1, 'bool' ], [ T.UChar ]: [ 1, 'u8' ], [ T.Int ]: [ 1, 'i32' ], [ T.UInt ]: [ 1, 'u32' ],
	[ T.Int64 ]: [ 1, 'i64' ], [ T.UInt64 ]: [ 1, 'u64' ], [ T.Half ]: [ 1, 'f16' ], [ T.Float ]: [ 1, 'f32' ],
	[ T.Double ]: [ 1, 'f64' ], [ T.TimeCode ]: [ 1, 'f64' ], [ T.Matrix2d ]: [ 4, 'f64' ], [ T.Matrix3d ]: [ 9, 'f64' ],
	[ T.Matrix4d ]: [ 16, 'f64' ], [ T.Quatd ]: [ 4, 'f64' ], [ T.Quatf ]: [ 4, 'f32' ], [ T.Quath ]: [ 4, 'f16' ],
	[ T.Vec2d ]: [ 2, 'f64' ], [ T.Vec2f ]: [ 2, 'f32' ], [ T.Vec2h ]: [ 2, 'f16' ], [ T.Vec2i ]: [ 2, 'i32' ],
	[ T.Vec3d ]: [ 3, 'f64' ], [ T.Vec3f ]: [ 3, 'f32' ], [ T.Vec3h ]: [ 3, 'f16' ], [ T.Vec3i ]: [ 3, 'i32' ],
	[ T.Vec4d ]: [ 4, 'f64' ], [ T.Vec4f ]: [ 4, 'f32' ], [ T.Vec4h ]: [ 4, 'f16' ], [ T.Vec4i ]: [ 4, 'i32' ],
};

const VECTOR_TYPES = new Set( [ T.Vec2d, T.Vec2f, T.Vec2i, T.Vec3d, T.Vec3f, T.Vec3h, T.Vec3i, T.Vec4d, T.Vec4f, T.Vec4h, T.Vec4i ] );
const MATRIX_SIZE = { [ T.Matrix2d ]: 2, [ T.Matrix3d ]: 3, [ T.Matrix4d ]: 4 };

let halfTable = null;
const bits = new DataView( new ArrayBuffer( 4 ) );

function halves() {

	if ( halfTable ) return halfTable;
	halfTable = new Float32Array( 65536 );
	for ( let h = 0; h < 65536; h ++ ) {

		const sign = h & 0x8000 ? - 1 : 1;
		const exp = ( h >> 10 ) & 0x1F;
		const frac = h & 0x3FF;
		halfTable[ h ] = exp === 0 ? sign * 2 ** - 14 * ( frac / 1024 )
			: exp === 31 ? ( frac ? NaN : sign * Infinity )
				: sign * 2 ** ( exp - 15 ) * ( 1 + frac / 1024 );

	}

	return halfTable;

}

function lz4Block( src, start, end, out, at ) {

	let i = start;
	while ( i < end ) {

		const token = src[ i ++ ];
		let literals = token >> 4;
		if ( literals === 15 ) {

			let b;
			do {

				b = src[ i ++ ];
				literals += b;

			} while ( b === 255 );

		}

		out.set( src.subarray( i, i + literals ), at );
		i += literals;
		at += literals;
		if ( i >= end ) break;

		const offset = src[ i ] | ( src[ i + 1 ] << 8 );
		i += 2;
		let length = ( token & 15 ) + 4;
		if ( length === 19 ) {

			let b;
			do {

				b = src[ i ++ ];
				length += b;

			} while ( b === 255 );

		}

		let from = at - offset;
		if ( offset >= length ) {

			out.copyWithin( at, from, from + length );
			at += length;

		} else {

			for ( let k = 0; k < length; k ++ ) out[ at ++ ] = out[ from ++ ];

		}

	}

	return at;

}

/** TfFastCompression: a chunk count, then the one LZ4 block or, for large inputs, size-prefixed chunks. */
function decompress( src, maxSize ) {

	const out = new Uint8Array( maxSize );
	const chunks = src[ 0 ];
	if ( chunks === 0 ) return out.subarray( 0, lz4Block( src, 1, src.length, out, 0 ) );
	const view = new DataView( src.buffer, src.byteOffset, src.byteLength );
	let i = 1, at = 0;
	for ( let c = 0; c < chunks; c ++ ) {

		const size = view.getInt32( i, true );
		i += 4;
		at = lz4Block( src, i, i + size, out, at );
		i += size;

	}

	return out.subarray( 0, at );

}

/** USD's integer coding: a common delta, 2-bit codes, then the deltas that are not it. */
function decodeInts( data, n, wide ) {

	const view = new DataView( data.buffer, data.byteOffset, data.byteLength );
	const common = wide ? Number( view.getBigInt64( 0, true ) ) : view.getInt32( 0, true );
	let codes = wide ? 8 : 4;
	let at = codes + ( ( n * 2 + 7 ) >> 3 );
	const out = wide ? new Float64Array( n ) : new Int32Array( n );
	let value = 0;
	for ( let i = 0; i < n; ) {

		const byte = data[ codes ++ ];
		for ( let j = 0; j < 4 && i < n; j ++, i ++ ) {

			const code = ( byte >> ( j * 2 ) ) & 3;
			let delta;
			if ( code === 0 ) delta = common;
			else if ( wide ) {

				if ( code === 1 ) {

					delta = view.getInt16( at, true );
					at += 2;

				} else if ( code === 2 ) {

					delta = view.getInt32( at, true );
					at += 4;

				} else {

					delta = Number( view.getBigInt64( at, true ) );
					at += 8;

				}

			} else if ( code === 1 ) {

				delta = view.getInt8( at );
				at += 1;

			} else if ( code === 2 ) {

				delta = view.getInt16( at, true );
				at += 2;

			} else {

				delta = view.getInt32( at, true );
				at += 4;

			}

			value = wide ? value + delta : ( value + delta ) | 0;
			out[ i ] = value;

		}

	}

	return out;

}

/**
 * A crate file, read the way OpenUSD's crateFile.cpp writes it (0.4.0 onwards): the section table, then the
 * compressed token, field, field-set, path and spec tables; values are decoded on request.
 */
export class Crate {

	constructor( buffer ) {

		this.buffer = buffer;
		this.bytes = new Uint8Array( buffer );
		this.view = new DataView( buffer );
		this.pos = 0;
		const magic = String.fromCharCode( ...this.bytes.subarray( 0, 8 ) );
		if ( magic !== 'PXR-USDC' ) throw new Error( 'not a usdc layer' );
		this.major = this.bytes[ 8 ];
		this.minor = this.bytes[ 9 ];
		this.patch = this.bytes[ 10 ];
		if ( this.older( 0, 4 ) ) throw new Error( `usdc ${this.major}.${this.minor}.${this.patch} predates 0.4.0 and is not read` );

		this.pos = 16;
		this.pos = this.u64();
		this.sections = {};
		for ( let n = this.u64(); n > 0; n -- ) {

			let name = '';
			for ( let k = 0; k < 16; k ++ ) {

				const c = this.bytes[ this.pos + k ];
				if ( c === 0 ) break;
				name += String.fromCharCode( c );

			}

			this.pos += 16;
			this.sections[ name ] = { start: this.u64(), size: this.u64() };

		}

		this.readTokens();
		this.readStrings();
		this.readFields();
		this.readFieldSets();
		this.readPaths();
		this.readSpecs();

	}

	older( major, minor ) {

		return this.major < major || ( this.major === major && this.minor < minor );

	}

	seek( name ) {

		const section = this.sections[ name ];
		if ( ! section ) return false;
		this.pos = section.start;
		return true;

	}

	u8() {

		return this.bytes[ this.pos ++ ];

	}

	i8() {

		const v = this.view.getInt8( this.pos );
		this.pos += 1;
		return v;

	}

	u32() {

		const v = this.view.getUint32( this.pos, true );
		this.pos += 4;
		return v;

	}

	i32() {

		const v = this.view.getInt32( this.pos, true );
		this.pos += 4;
		return v;

	}

	u64() {

		const lo = this.view.getUint32( this.pos, true );
		const hi = this.view.getUint32( this.pos + 4, true );
		this.pos += 8;
		return hi * 0x100000000 + lo;

	}

	i64() {

		const lo = this.view.getUint32( this.pos, true );
		const hi = this.view.getInt32( this.pos + 4, true );
		this.pos += 8;
		return hi * 0x100000000 + lo;

	}

	f64() {

		const v = this.view.getFloat64( this.pos, true );
		this.pos += 8;
		return v;

	}

	ints( n, wide = false ) {

		const size = this.u64();
		const src = this.bytes.subarray( this.pos, this.pos + size );
		this.pos += size;
		const encoded = ( wide ? 8 : 4 ) + ( ( n * 2 + 7 ) >> 3 ) + n * ( wide ? 8 : 4 );
		return decodeInts( decompress( src, encoded ), n, wide );

	}

	readTokens() {

		this.tokens = [];
		if ( ! this.seek( 'TOKENS' ) ) return;
		const n = this.u64();
		const size = this.u64();
		const compressed = this.u64();
		const data = decompress( this.bytes.subarray( this.pos, this.pos + compressed ), size );
		const decoder = new TextDecoder();
		let start = 0;
		for ( let i = 0; i < n; i ++ ) {

			let end = start;
			while ( end < data.length && data[ end ] !== 0 ) end ++;
			this.tokens.push( decoder.decode( data.subarray( start, end ) ) );
			start = end + 1;

		}

	}

	readStrings() {

		this.strings = [];
		if ( ! this.seek( 'STRINGS' ) ) return;
		for ( let n = this.u64(); n > 0; n -- ) this.strings.push( this.u32() );

	}

	readFields() {

		if ( ! this.seek( 'FIELDS' ) ) return;
		const n = this.u64();
		this.fieldTokens = this.ints( n );
		const size = this.u64();
		const reps = decompress( this.bytes.subarray( this.pos, this.pos + size ), n * 8 );
		this.fieldReps = new Uint32Array( reps.slice().buffer );

	}

	readFieldSets() {

		this.fieldSets = new Int32Array( 0 );
		if ( ! this.seek( 'FIELDSETS' ) ) return;
		this.fieldSets = this.ints( this.u64() );

	}

	readPaths() {

		if ( ! this.seek( 'PATHS' ) ) return;
		const total = this.u64();
		const n = this.u64();
		const index = this.ints( n ), element = this.ints( n ), jumps = this.ints( n );
		this.pathParent = new Int32Array( total ).fill( - 1 );
		this.pathElement = new Array( total ).fill( '' );
		this.pathIsProperty = new Uint8Array( total );

		const pending = [[ 0, - 1 ]];
		while ( pending.length ) {

			let [ k, parent ] = pending.pop();
			for ( ;; ) {

				const here = index[ k ];
				if ( parent >= 0 ) {

					const token = element[ k ];
					this.pathParent[ here ] = parent;
					this.pathElement[ here ] = this.tokens[ Math.abs( token ) ] ?? '';
					this.pathIsProperty[ here ] = token < 0 ? 1 : 0;

				}

				const jump = jumps[ k ];
				const child = jump > 0 || jump === - 1, sibling = jump >= 0;
				if ( child && sibling ) pending.push( [ k + jump, parent ] );
				if ( child ) parent = here;
				else if ( ! sibling ) break;
				k ++;

			}

		}

		this.pathStrings = new Array( total );

	}

	readSpecs() {

		this.specPaths = this.specFieldSets = this.specTypes = new Int32Array( 0 );
		if ( ! this.seek( 'SPECS' ) ) return;
		const n = this.u64();
		this.specPaths = this.ints( n );
		this.specFieldSets = this.ints( n );
		this.specTypes = this.ints( n );

	}

	/** A path index as USD writes it: `/a/b`, `/a/b{set=variant}`, `/a/b.prop`. */
	path( i ) {

		let s = this.pathStrings[ i ];
		if ( s !== undefined ) return s;
		const parent = this.pathParent[ i ];
		const element = this.pathElement[ i ];
		if ( parent < 0 ) s = '/';
		else {

			const base = this.path( parent );
			s = this.pathIsProperty[ i ] ? `${base}.${element}`
				: element.startsWith( '{' ) ? base + element
					: base === '/' ? `/${element}` : `${base}/${element}`;

		}

		this.pathStrings[ i ] = s;
		return s;

	}

	fieldsOf( set ) {

		const out = [];
		for ( let k = set; k < this.fieldSets.length; k ++ ) {

			const f = this.fieldSets[ k ];
			if ( f < 0 ) break;
			out.push( [ this.tokens[ this.fieldTokens[ f ] ], this.fieldReps[ f * 2 ], this.fieldReps[ f * 2 + 1 ] ] );

		}

		return out;

	}

	value( lo, hi ) {

		const type = ( hi >>> 16 ) & 0xFF;
		const payload = lo + ( hi & 0xFFFF ) * 0x100000000;
		if ( type === T.TimeSamples ) return this.timeSamples( payload );
		if ( hi & 0x40000000 ) return this.inlined( type, lo );
		const array = ( hi & 0x80000000 ) !== 0;
		if ( array && payload === 0 ) return [];
		const save = this.pos;
		this.pos = payload;
		const value = array ? this.array( type, ( hi & 0x20000000 ) !== 0 ) : this.scalar( type );
		this.pos = save;
		return value;

	}

	inlined( type, lo ) {

		switch ( type ) {

			case T.Bool: return lo !== 0;
			case T.Int: return lo | 0;
			case T.Float:
			case T.Double:
			case T.TimeCode: {

				bits.setUint32( 0, lo, true );
				return bits.getFloat32( 0, true );

			}

			case T.Half: return halves()[ lo & 0xFFFF ];
			case T.Token:
			case T.AssetPath: return this.tokens[ lo ] ?? '';
			case T.String: return this.tokens[ this.strings[ lo ] ] ?? '';
			case T.Vec2h: return [ halves()[ lo & 0xFFFF ], halves()[ lo >>> 16 ] ];
			case T.ValueBlock: return null;
			case T.Dictionary: return {};

		}

		const signed = k => ( ( lo >>> ( k * 8 ) ) << 24 ) >> 24;
		if ( VECTOR_TYPES.has( type ) ) return Array.from( { length: LAYOUT[ type ][ 0 ] }, ( _, k ) => signed( k ) );
		const size = MATRIX_SIZE[ type ];
		if ( size ) {

			const m = new Array( size * size ).fill( 0 );
			for ( let k = 0; k < size; k ++ ) m[ k * size + k ] = signed( k );
			return m;

		}

		return lo;

	}

	element( kind ) {

		switch ( kind ) {

			case 'bool': return this.u8() !== 0;
			case 'u8': return this.u8();
			case 'i32': return this.i32();
			case 'u32': return this.u32();
			case 'i64': return this.i64();
			case 'u64': return this.u64();
			case 'f16': {

				const v = halves()[ this.view.getUint16( this.pos, true ) ];
				this.pos += 2;
				return v;

			}

			case 'f32': {

				const v = this.view.getFloat32( this.pos, true );
				this.pos += 4;
				return v;

			}

			default: return this.f64();

		}

	}

	listOp( read ) {

		const bits = this.u8();
		const op = listOp();
		const list = () => {

			const out = [];
			for ( let n = this.u64(); n > 0; n -- ) out.push( read() );
			return out;

		};

		if ( bits & 1 ) op.explicit = [];
		if ( bits & 2 ) op.explicit = list();
		if ( bits & 4 ) op.add = list();
		if ( bits & 32 ) op.prepend = list();
		if ( bits & 64 ) op.append = list();
		if ( bits & 8 ) op.delete = list();
		if ( bits & 16 ) list();
		return op;

	}

	string() {

		return this.tokens[ this.strings[ this.u32() ] ] ?? '';

	}

	reference() {

		const asset = this.string();
		const path = this.path( this.u32() );
		this.f64();
		this.f64();
		this.dictionary();
		return new Ref( asset, path === '/' ? '' : path );

	}

	payload() {

		const asset = this.string();
		const path = this.path( this.u32() );
		if ( ! this.older( 0, 8 ) ) {

			this.f64();
			this.f64();

		}

		return new Ref( asset, path === '/' ? '' : path );

	}

	/** A value inside another (a dictionary's): an offset past whatever it nested, then its rep, then what follows. */
	recursive() {

		const start = this.pos;
		this.pos = start + this.i64();
		return this.value( this.u32(), this.u32() );

	}

	dictionary() {

		const out = {};
		for ( let n = this.u64(); n > 0; n -- ) {

			const key = this.string();
			out[ key ] = this.recursive();

		}

		return out;

	}

	scalar( type ) {

		const layout = LAYOUT[ type ];
		if ( layout ) {

			if ( layout[ 0 ] === 1 ) return this.element( layout[ 1 ] );
			return Array.from( { length: layout[ 0 ] }, () => this.element( layout[ 1 ] ) );

		}

		switch ( type ) {

			case T.String: return this.string();
			case T.Token:
			case T.AssetPath: return this.tokens[ this.u32() ] ?? '';
			case T.Specifier:
			case T.Permission:
			case T.Variability: return this.u32();
			case T.Dictionary: return this.dictionary();
			case T.TokenListOp: return this.listOp( () => this.tokens[ this.u32() ] ?? '' );
			case T.StringListOp: return this.listOp( () => this.string() );
			case T.PathListOp: return this.listOp( () => this.path( this.u32() ) );
			case T.ReferenceListOp: return this.listOp( () => this.reference() );
			case T.PayloadListOp: return this.listOp( () => this.payload() );
			case T.IntListOp: return this.listOp( () => this.i32() );
			case T.UIntListOp: return this.listOp( () => this.u32() );
			case T.Int64ListOp: return this.listOp( () => this.i64() );
			case T.UInt64ListOp: return this.listOp( () => this.u64() );
			case T.Payload: return this.payload();
			case T.PathVector: return Array.from( { length: this.u64() }, () => this.path( this.u32() ) );
			case T.TokenVector: return Array.from( { length: this.u64() }, () => this.tokens[ this.u32() ] ?? '' );
			case T.StringVector: return Array.from( { length: this.u64() }, () => this.string() );
			case T.DoubleVector: return Float64Array.from( { length: this.u64() }, () => this.f64() );
			case T.LayerOffsetVector: return Array.from( { length: this.u64() }, () => [ this.f64(), this.f64() ] );
			case T.VariantSelectionMap: {

				const out = {};
				for ( let n = this.u64(); n > 0; n -- ) {

					const key = this.string();
					out[ key ] = this.string();

				}

				return out;

			}

			case T.Value: return this.recursive();
			default: return null;

		}

	}

	typed( Type, count ) {

		const bytes = count * Type.BYTES_PER_ELEMENT;
		const out = new Type( this.buffer.slice( this.pos, this.pos + bytes ) );
		this.pos += bytes;
		return out;

	}

	array( type, compressed ) {

		if ( this.older( 0, 5 ) ) this.u32();
		const n = this.older( 0, 7 ) ? this.u32() : this.u64();
		if ( compressed ) return this.compressedArray( type, n );

		const layout = LAYOUT[ type ];
		if ( layout ) {

			const [ components, kind ] = layout;
			const count = n * components;
			switch ( kind ) {

				case 'f32': return this.typed( Float32Array, count );
				case 'f64': return this.typed( Float64Array, count );
				case 'i32': return this.typed( Int32Array, count );
				case 'u32': return this.typed( Uint32Array, count );
				case 'u8': return this.typed( Uint8Array, count );
				case 'f16': {

					const raw = this.typed( Uint16Array, count );
					const table = halves();
					const out = new Float32Array( count );
					for ( let i = 0; i < count; i ++ ) out[ i ] = table[ raw[ i ] ];
					return out;

				}

				default: return Array.from( { length: count }, () => this.element( kind ) );

			}

		}

		switch ( type ) {

			case T.String: return Array.from( { length: n }, () => this.string() );
			case T.Token:
			case T.AssetPath: return Array.from( { length: n }, () => this.tokens[ this.u32() ] ?? '' );
			default: return null;

		}

	}

	compressedArray( type, n ) {

		switch ( type ) {

			case T.Int: return this.ints( n );
			case T.UInt: return new Uint32Array( this.ints( n ).buffer );
			case T.Int64:
			case T.UInt64: return this.ints( n, true );
			case T.Half:
			case T.Float:
			case T.Double: {

				const Out = type === T.Double ? Float64Array : Float32Array;
				const code = this.i8();
				if ( code === 0x69 ) return Out.from( this.ints( n ) );
				if ( code !== 0x74 ) throw new Error( `usdc: unknown float array coding ${code}` );
				const lut = Array.from( { length: this.u32() }, () => this.element( type === T.Half ? 'f16' : type === T.Float ? 'f32' : 'f64' ) );
				const indices = this.ints( n );
				const out = new Out( n );
				for ( let i = 0; i < n; i ++ ) out[ i ] = lut[ indices[ i ] ];
				return out;

			}

			default: throw new Error( `usdc: compressed array of type ${type} is not read` );

		}

	}

	// The times' value rep sits behind one relative offset; the value reps follow another just after it.
	timeSamples( payload ) {

		const save = this.pos;
		this.pos = payload;
		this.pos = payload + this.i64();
		const times = [ this.u32(), this.u32() ];
		const start = this.pos;
		this.pos = start + this.i64();
		const reps = [];
		for ( let n = this.u64(); n > 0; n -- ) reps.push( [ this.u32(), this.u32() ] );
		this.pos = save;
		const values = reps.map( ( [ lo, hi ] ) => this.value( lo, hi ) );
		return new Map( Array.from( this.value( ...times ) ?? [], ( t, i ) => [ t, values[ i ] ] ) );

	}

}

const PRIM = 6, PSEUDO_ROOT = 7, VARIANT = 10, ATTRIBUTE = 1, RELATIONSHIP = 8;
const SPECIFIER = [ 'def', 'over', 'class' ];

function applyPrimField( spec, key, value ) {

	switch ( key ) {

		case 'specifier': spec.specifier = SPECIFIER[ value ] ?? 'over'; break;
		case 'typeName': spec.typeName = value || ''; break;
		case 'primChildren':
		case 'properties':
		case 'variantChildren':
		case 'variantSetChildren':
			break;
		case 'references':
		case 'specializes':
		case 'apiSchemas':
		case 'variantSetNames':
			if ( value ) ( spec.arcs ??= {} )[ key ] = value;
			break;
		case 'inheritPaths':
			if ( value ) ( spec.arcs ??= {} ).inherits = value;
			break;
		case 'payload':
			if ( value instanceof Ref ) ( spec.arcs ??= {} ).payload = { ...listOp(), explicit: [ value ] };
			else if ( value ) ( spec.arcs ??= {} ).payload = value;
			break;
		case 'variantSelection':
			if ( value ) spec.variantSelection = value;
			break;
		default:
			spec.meta[ key ] = value;

	}

}

/** The buffer stays held by the layer's undecoded values. */
export function parseUSDC( buffer, path = '' ) {

	const crate = new Crate( buffer );
	const layer = new Layer( path );
	const specs = new Map();

	const primSpec = i => {

		let spec = specs.get( i );
		if ( spec ) return spec;
		const parent = crate.pathParent[ i ];
		if ( parent < 0 ) spec = layer.root;
		else {

			const owner = primSpec( parent );
			const element = crate.pathElement[ i ];
			if ( element.startsWith( '{' ) ) {

				const [ set, name ] = element.slice( 1, - 1 ).split( '=' );
				spec = owner.variant( set, name, true ) ?? owner;

			} else {

				spec = owner.child( element, true );

			}

		}

		specs.set( i, spec );
		return spec;

	};

	const ordered = [];
	for ( let s = 0; s < crate.specTypes.length; s ++ ) {

		const type = crate.specTypes[ s ];
		const index = crate.specPaths[ s ];
		const fields = crate.fieldsOf( crate.specFieldSets[ s ] );

		if ( type === PSEUDO_ROOT ) {

			for ( const [ key, lo, hi ] of fields ) if ( key !== 'primChildren' ) layer.meta[ key ] = crate.value( lo, hi );
			continue;

		}

		if ( type === PRIM || type === VARIANT ) {

			const spec = primSpec( index );
			for ( const [ key, lo, hi ] of fields ) {

				const value = crate.value( lo, hi );
				if ( key === 'primChildren' && value?.length ) ordered.push( [ spec, value ] );
				applyPrimField( spec, key, value );

			}

			continue;

		}

		if ( ( type !== ATTRIBUTE && type !== RELATIONSHIP ) || ! crate.pathIsProperty[ index ] ) continue;
		const prop = primSpec( crate.pathParent[ index ] ).property( crate.pathElement[ index ], true );
		prop.rel = type === RELATIONSHIP;
		for ( const [ key, lo, hi ] of fields ) {

			if ( key === 'default' ) {

				prop.hasValue = true;
				prop._lazyValue = () => crate.value( lo, hi );

			} else if ( key === 'timeSamples' ) {

				prop._lazySamples = () => crate.value( lo, hi );

			} else {

				const value = crate.value( lo, hi );
				if ( key === 'typeName' ) prop.type = value;
				else if ( key === 'targetPaths' ) prop.targets = value;
				else if ( key === 'connectionPaths' ) prop.connections = value;
				else if ( key === 'variability' ) prop.uniform = value === 1;
				else if ( key === 'custom' ) prop.custom = value === true;
				else prop.meta[ key ] = value;

			}

		}

	}

	for ( const [ spec, names ] of ordered ) {

		if ( ! spec.children ) continue;
		const children = new Map();
		for ( const name of names ) if ( spec.children.has( name ) ) children.set( name, spec.children.get( name ) );
		for ( const [ name, child ] of spec.children ) if ( ! children.has( name ) ) children.set( name, child );
		spec.children = children;

	}

	return layer;

}
