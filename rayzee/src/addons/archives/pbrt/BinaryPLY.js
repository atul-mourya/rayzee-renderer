import { BufferAttribute, BufferGeometry, Float32BufferAttribute, Uint16BufferAttribute, Uint32BufferAttribute } from 'three';

/**
 * Binary .ply meshes as three's PLYLoader reads them, byte for byte, without its per-value objects: what pbrt exporters
 * write (`vertex` position, normal, uv; `face` vertex_indices). Null for anything else, which PLYLoader then reads.
 */

// No prototype: a type named `toString` is unknown, not a function.
const SIZES = Object.assign( Object.create( null ), { int8: 1, char: 1, uint8: 1, uchar: 1, int16: 2, short: 2, uint16: 2, ushort: 2, int32: 4, int: 4, uint32: 4, uint: 4, float32: 4, float: 4, float64: 8, double: 8 } );
const FLOATS = new Set( [ 'float32', 'float', 'float64', 'double' ] );
const INTEGERS = new Set( [ 'int8', 'char', 'uint8', 'uchar', 'int16', 'short', 'uint16', 'ushort', 'int32', 'int', 'uint32', 'uint' ] );
// PLYLoader's names for each attribute, first found first.
const NAMES = {
	x: [ 'x', 'px', 'posx' ], y: [ 'y', 'py', 'posy' ], z: [ 'z', 'pz', 'posz' ],
	nx: [ 'nx', 'normalx' ], ny: [ 'ny', 'normaly' ], nz: [ 'nz', 'normalz' ],
	s: [ 's', 'u', 'texture_u', 'tx' ], t: [ 't', 'v', 'texture_v', 'ty' ],
	r: [ 'red', 'diffuse_red', 'r', 'diffuse_r' ], g: [ 'green', 'diffuse_green', 'g', 'diffuse_g' ], b: [ 'blue', 'diffuse_blue', 'b', 'diffuse_b' ]
};

class Float64BufferAttribute extends BufferAttribute {

	constructor( array, itemSize ) {

		super( new Float64Array( array ), itemSize );

	}

}

function reader( view, type, little ) {

	switch ( type ) {

		case 'int8': case 'char': return ( at ) => view.getInt8( at );
		case 'uint8': case 'uchar': return ( at ) => view.getUint8( at );
		case 'int16': case 'short': return ( at ) => view.getInt16( at, little );
		case 'uint16': case 'ushort': return ( at ) => view.getUint16( at, little );
		case 'int32': case 'int': return ( at ) => view.getInt32( at, little );
		case 'uint32': case 'uint': return ( at ) => view.getUint32( at, little );
		case 'float32': case 'float': return ( at ) => view.getFloat32( at, little );
		default: return ( at ) => view.getFloat64( at, little );

	}

}

// PLYLoader's extractHeaderText + parseHeader: the header's elements and where the body starts.
function readHeader( bytes ) {

	let i = 0, line = '', done = false;
	const lines = [];
	const crlf = bytes.length >= 5 && bytes[ 3 ] === 13 && bytes[ 4 ] === 10 && bytes[ 0 ] === 112 && bytes[ 1 ] === 108 && bytes[ 2 ] === 121;
	do {

		const c = String.fromCharCode( bytes[ i ++ ] );
		if ( c !== '\n' && c !== '\r' ) line += c;
		else {

			if ( line === 'end_header' ) done = true;
			if ( line !== '' ) {

				lines.push( line );
				line = '';

			}

		}

	} while ( ! done && i < bytes.length );

	if ( ! done || lines[ 0 ] !== 'ply' ) return null;
	if ( crlf ) i ++;

	const header = { format: null, elements: [], length: i };
	for ( const raw of lines.slice( 1, - 1 ) ) {

		const words = raw.trim().split( /\s+/ );
		const kind = words.shift();
		if ( kind === 'format' ) header.format = words[ 0 ];
		else if ( kind === 'element' ) header.elements.push( { name: words[ 0 ], count: parseInt( words[ 1 ] ), properties: [] } );
		else if ( kind === 'property' ) {

			const element = header.elements.at( - 1 );
			if ( ! element ) return null;
			element.properties.push( words[ 0 ] === 'list'
				? { type: 'list', countType: words[ 1 ], itemType: words[ 2 ], name: words[ 3 ] }
				: { type: words[ 0 ], name: words[ 1 ] } );

		} else if ( kind !== 'comment' && kind !== 'obj_info' && kind !== '' ) return null;

	}

	return header;

}

const find = ( properties, names ) => {

	for ( const name of names ) {

		const property = properties.find( ( p ) => p.name === name );
		if ( property ) return property;

	}

	return null;

};

/**
 * @param {ArrayBuffer} data - the whole file
 * @returns {BufferGeometry|null} null where PLYLoader should read it
 */
export function parseBinaryPLY( data ) {

	if ( ! ( data instanceof ArrayBuffer ) ) return null;
	const bytes = new Uint8Array( data );
	if ( bytes[ 0 ] !== 112 || bytes[ 1 ] !== 108 || bytes[ 2 ] !== 121 ) return null; // "ply"
	const header = readHeader( bytes );
	if ( ! header || ( header.format !== 'binary_little_endian' && header.format !== 'binary_big_endian' ) || header.length > data.byteLength ) return null;
	const little = header.format === 'binary_little_endian';
	const view = new DataView( data, header.length );

	// Offsets within a vertex record; every property fixed in size and known.
	const plan = [];
	for ( const element of header.elements ) {

		if ( ! Number.isInteger( element.count ) || element.count < 0 ) return null;
		for ( const p of element.properties ) {

			if ( p.type === 'list' ? ! INTEGERS.has( p.countType ) || ! SIZES[ p.itemType ] : ! SIZES[ p.type ] ) return null;

		}

		if ( element.name === 'vertex' ) {

			const props = element.properties;
			if ( props.some( ( p ) => p.type === 'list' ) || [ NAMES.r, NAMES.g, NAMES.b ].every( ( names ) => find( props, names ) ) ) return null;
			let stride = 0;
			const last = new Map();
			for ( const p of props ) {

				// A repeated name reads as its last, as PLYLoader's element object keeps it; the class is the first's.
				last.set( p.name, { at: stride, type: p.type } );
				stride += SIZES[ p.type ];

			}

			const pick = ( keys ) => {

				const found = keys.map( ( key ) => find( props, NAMES[ key ] ) );
				if ( ! found.every( Boolean ) ) return null;
				if ( ! FLOATS.has( found[ 0 ].type ) ) return undefined;
				return { type: found[ 0 ].type, read: found.map( ( p ) => ( { at: last.get( p.name ).at, get: reader( view, last.get( p.name ).type, little ) } ) ) };

			};

			const position = pick( [ 'x', 'y', 'z' ] ), normal = pick( [ 'nx', 'ny', 'nz' ] ), uv = pick( [ 's', 't' ] );
			if ( ! position || normal === undefined || uv === undefined ) return null;
			plan.push( { kind: 'vertex', count: element.count, stride, position, normal, uv } );

		} else if ( element.name === 'face' ) {

			const props = element.properties;
			const indices = props.findLast( ( p ) => p.name === 'vertex_indices' ) ?? props.findLast( ( p ) => p.name === 'vertex_index' );
			if ( ! indices || indices.type !== 'list' || ! INTEGERS.has( indices.itemType ) ) return null;
			if ( props.some( ( p ) => p.name === 'texcoord' ) || [ NAMES.r, NAMES.g, NAMES.b ].every( ( names ) => find( props, names ) ) ) return null;
			plan.push( { kind: 'face', count: element.count, props, indices } );

		} else return null;

	}

	const Class = ( type ) => ( SIZES[ type ] === 8 ? Float64BufferAttribute : Float32BufferAttribute );
	let at = 0, vertices = null, faces = null;
	const geometryOf = { position: null, normal: null, uv: null };
	for ( const step of plan ) {

		if ( step.kind === 'vertex' ) {

			if ( vertices ) return null; // two vertex elements: PLYLoader appends, not worth it here
			vertices = step;
			const n = step.count;
			if ( at + n * step.stride > view.byteLength ) return null;
			for ( const key of [ 'position', 'normal', 'uv' ] ) {

				const attr = step[ key ];
				if ( ! attr ) continue;
				const k = attr.read.length;
				const attribute = new ( Class( attr.type ) )( n * k, k ), out = attribute.array;
				for ( let c = 0; c < k; c ++ ) {

					const { at: off, get } = attr.read[ c ];
					for ( let v = 0, base = at + off; v < n; v ++, base += step.stride ) out[ v * k + c ] = get( base );

				}

				geometryOf[ key ] = attribute;

			}

			at += n * step.stride;

		} else {

			if ( faces ) return null;
			faces = step;
			const n = step.count;
			const parts = step.props.map( ( p ) => ( p.type === 'list'
				? { list: true, count: reader( view, p.countType, little ), countSize: SIZES[ p.countType ], item: reader( view, p.itemType, little ), itemSize: SIZES[ p.itemType ], indices: p === step.indices }
				: { list: false, size: SIZES[ p.type ] } ) );
			// Room for the faces the bytes left can hold, before anything is allocated for them.
			const least = parts.reduce( ( sum, part ) => sum + ( part.list ? part.countSize : part.size ), 0 );
			if ( at + n * least > view.byteLength ) return null;
			const Raw = step.indices.itemType === 'uint32' || step.indices.itemType === 'uint' ? Uint32Array : Int32Array;
			let raw = new Raw( n * 3 ), count = 0;
			for ( let f = 0; f < n; f ++ ) {

				for ( const part of parts ) {

					if ( ! part.list ) {

						at += part.size;
						continue;

					}

					if ( at + part.countSize > view.byteLength ) return null;
					const k = Math.max( 0, part.count( at ) ); // a negative count reads no items, as PLYLoader's loop
					at += part.countSize;
					if ( at + k * part.itemSize > view.byteLength ) return null;
					if ( part.indices && ( k === 3 || k === 4 ) ) {

						if ( count + 6 > raw.length ) {

							const grown = new Raw( Math.max( raw.length * 1.5, count + 6 ) | 0 );
							grown.set( raw );
							raw = grown;

						}

						const a = part.item( at ), b = part.item( at + part.itemSize ), c = part.item( at + 2 * part.itemSize );
						raw[ count ++ ] = a; raw[ count ++ ] = b; raw[ count ++ ] = c;
						if ( k === 4 ) {

							raw[ count ++ ] = a; raw[ count ++ ] = c; raw[ count ++ ] = part.item( at + 3 * part.itemSize );

						}

					}

					at += k * part.itemSize;

				}

			}

			faces.raw = raw.subarray( 0, count );

		}

	}

	if ( at > view.byteLength ) return null;

	const geometry = new BufferGeometry();
	if ( faces?.raw.length ) {

		// three's setIndex( array ): 32-bit once any index reaches 65535.
		let wide = false;
		for ( let i = faces.raw.length - 1; i >= 0; i -- ) if ( faces.raw[ i ] >= 65535 ) {

			wide = true;
			break;

		}

		const index = new ( wide ? Uint32BufferAttribute : Uint16BufferAttribute )( faces.raw.length, 1 );
		index.array.set( faces.raw ); // wraps as the class's own constructor would
		geometry.setIndex( index );

	}

	geometry.setAttribute( 'position', geometryOf.position ?? new Float32BufferAttribute( [], 3 ) );
	if ( geometryOf.normal?.count ) geometry.setAttribute( 'normal', geometryOf.normal );
	if ( geometryOf.uv?.count ) geometry.setAttribute( 'uv', geometryOf.uv );
	geometry.computeBoundingSphere();
	return geometry;

}
