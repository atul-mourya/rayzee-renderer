/**
 * parseBinaryPLY reads what it takes exactly as three's PLYLoader does — attributes, their classes, the index and the
 * bounding sphere — and hands everything else back (null) for PLYLoader to read.
 */
import { describe, it, expect } from 'vitest';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { parseBinaryPLY } from '@/core/addons/archives/pbrt/BinaryPLY.js';

const SET = {
	char: [ 1, 'setInt8' ], uchar: [ 1, 'setUint8' ], uint8: [ 1, 'setUint8' ], short: [ 2, 'setInt16' ], ushort: [ 2, 'setUint16' ],
	uint16: [ 2, 'setUint16' ], int: [ 4, 'setInt32' ], int32: [ 4, 'setInt32' ], uint: [ 4, 'setUint32' ], uint32: [ 4, 'setUint32' ],
	float: [ 4, 'setFloat32' ], float32: [ 4, 'setFloat32' ], double: [ 8, 'setFloat64' ]
};

/**
 * A binary .ply: `elements` = [ { name, properties: [ [ type, name ] | [ 'list', countType, itemType, name ] ], rows } ],
 * each row one value a property (an array for a list).
 */
function ply( elements, { little = true, eol = '\n', extra = [] } = {} ) {

	const lines = [ 'ply', `format binary_${little ? 'little' : 'big'}_endian 1.0`, ...extra ];
	for ( const e of elements ) {

		lines.push( `element ${e.name} ${e.rows.length}` );
		for ( const p of e.properties ) lines.push( `property ${p.join( ' ' )}` );

	}

	lines.push( 'end_header' );
	const head = new TextEncoder().encode( lines.join( eol ) + eol );
	const values = [];
	for ( const e of elements ) for ( const row of e.rows ) e.properties.forEach( ( p, k ) => {

		if ( p[ 0 ] === 'list' ) {

			values.push( [ p[ 1 ], row[ k ].length ] );
			for ( const v of row[ k ] ) values.push( [ p[ 2 ], v ] );

		} else values.push( [ p[ 0 ], row[ k ] ] );

	} );
	const size = values.reduce( ( sum, [ type ] ) => sum + SET[ type ][ 0 ], 0 );
	const out = new Uint8Array( head.length + size );
	out.set( head );
	const view = new DataView( out.buffer, head.length );
	let at = 0;
	for ( const [ type, v ] of values ) {

		view[ SET[ type ][ 1 ] ]( at, v, little );
		at += SET[ type ][ 0 ];

	}

	return out.buffer;

}

const loader = new PLYLoader();

function expectSame( data ) {

	const a = loader.parse( data.slice( 0 ) ), b = parseBinaryPLY( data.slice( 0 ) );
	expect( b ).not.toBeNull();
	const describe = ( g ) => ( {
		index: g.index && { type: g.index.constructor.name, array: Array.from( g.index.array ), arrayType: g.index.array.constructor.name },
		attributes: Object.fromEntries( Object.entries( g.attributes ).map( ( [ k, v ] ) => [ k, { type: v.constructor.name, itemSize: v.itemSize, normalized: v.normalized, arrayType: v.array.constructor.name, array: Array.from( v.array ) } ] ) ),
		sphere: [ g.boundingSphere.center.toArray(), g.boundingSphere.radius ]
	} );
	expect( describe( b ) ).toEqual( describe( a ) );
	return b;

}

const VERTEX = [[ 'float', 'x' ], [ 'float', 'y' ], [ 'float', 'z' ], [ 'float', 'nx' ], [ 'float', 'ny' ], [ 'float', 'nz' ], [ 'float', 'u' ], [ 'float', 'v' ]];
const vertexRows = ( n ) => Array.from( { length: n }, ( _, i ) => [ i * 0.1, Math.sin( i ) * 3.7, - i / 7, 0, 0.6, 0.8, i / n, 1 - i / n ] );
const FACE = [[ 'list', 'uint8', 'int', 'vertex_indices' ]];

describe( 'parseBinaryPLY', () => {

	it( 'reads triangles, quads as two, and drops other polygons, as PLYLoader does', () => {

		const g = expectSame( ply( [
			{ name: 'vertex', properties: VERTEX, rows: vertexRows( 9 ) },
			{ name: 'face', properties: FACE, rows: [[[ 0, 1, 2 ]], [[ 2, 3, 4, 5 ]], [[ 0, 1, 2, 3, 4 ]], [[ 6, 7 ]], [[ 8, 7, 6 ]]] }
		] ) );
		expect( Array.from( g.index.array ) ).toEqual( [ 0, 1, 2, 2, 3, 4, 2, 4, 5, 8, 7, 6 ] );

	} );

	it( 'widens the index at 65535, wraps a negative one as three does, and reads unsigned and vertex_index lists', () => {

		const mesh = ( items, faces, name = 'vertex_indices' ) => ply( [
			{ name: 'vertex', properties: VERTEX.slice( 0, 3 ), rows: vertexRows( 3 ).map( ( r ) => r.slice( 0, 3 ) ) },
			{ name: 'face', properties: [[ 'list', 'uchar', items, name ]], rows: faces.map( ( f ) => [ f ] ) }
		] );
		expect( expectSame( mesh( 'int', [[ 0, 1, 65534 ]] ) ).index.array ).toBeInstanceOf( Uint16Array );
		expect( expectSame( mesh( 'int', [[ 0, 1, 65535 ]] ) ).index.array ).toBeInstanceOf( Uint32Array );
		expect( Array.from( expectSame( mesh( 'int', [[ 0, - 1, 2 ]] ) ).index.array ) ).toEqual( [ 0, 65535, 2 ] );
		expectSame( mesh( 'int', [[ 0, - 1, 70000 ]] ) );
		expectSame( mesh( 'uint', [[ 0, 4294967295, 2 ]] ) );
		expectSame( mesh( 'ushort', [[ 0, 1, 2 ]], 'vertex_index' ) );

	} );

	it( 'keeps each attribute\'s class from its first component, doubles included, and PLYLoader\'s choice of names', () => {

		expectSame( ply( [
			{ name: 'vertex', properties: [[ 'double', 'x' ], [ 'float', 'y' ], [ 'double', 'z' ], [ 'double', 'nx' ], [ 'double', 'ny' ], [ 'double', 'nz' ]], rows: vertexRows( 5 ).map( ( r ) => r.slice( 0, 6 ) ) },
			{ name: 'face', properties: FACE, rows: [[[ 0, 1, 2 ]], [[ 1, 3, 4 ]]] }
		] ) );
		// s before u; a repeated name reads its last value.
		const g = expectSame( ply( [
			{ name: 'vertex', properties: [[ 'float', 'x' ], [ 'float', 'y' ], [ 'float', 'z' ], [ 'float', 'u' ], [ 'float', 'v' ], [ 'float', 's' ], [ 'float', 't' ], [ 'float', 'x' ]], rows: [[ 1, 2, 3, 0.1, 0.2, 0.3, 0.4, 9 ], [ 4, 5, 6, 0.5, 0.6, 0.7, 0.8, 8 ]] }
		] ) );
		expect( Array.from( g.attributes.uv.array ) ).toEqual( [ 0.3, 0.4, 0.7, 0.8 ].map( Math.fround ) );
		expect( g.attributes.position.array[ 0 ] ).toBe( 9 );
		expect( g.index ).toBeNull();

	} );

	it( 'skips a face\'s other properties, reads big-endian and CRLF headers, comments and obj_info', () => {

		const faces = { name: 'face', properties: [[ 'int', 'face_indices' ], [ 'list', 'ushort', 'uint16', 'vertex_indices' ], [ 'list', 'uchar', 'float', 'weights' ], [ 'double', 'area' ]], rows: [[ 7, [ 0, 1, 2 ], [ 0.5 ], 1.5 ], [ 8, [ 3, 2, 1, 0 ], [], 2.5 ]] };
		for ( const options of [ {}, { little: false }, { eol: '\r\n', extra: [ 'comment made by hand', 'obj_info a test' ] }, { eol: '\r' } ] ) {

			expectSame( ply( [ { name: 'vertex', properties: VERTEX, rows: vertexRows( 4 ) }, faces ], options ) );

		}

	} );

	it( 'reads no vertices, and a vertex block with no faces', () => {

		expectSame( ply( [ { name: 'vertex', properties: VERTEX, rows: [] }, { name: 'face', properties: FACE, rows: [] } ] ) );
		expectSame( ply( [ { name: 'vertex', properties: VERTEX, rows: vertexRows( 3 ) } ] ) );

	} );

	it( 'hands back to PLYLoader what it does not read', () => {

		const vertex = { name: 'vertex', properties: VERTEX, rows: vertexRows( 3 ) };
		const face = { name: 'face', properties: FACE, rows: [[[ 0, 1, 2 ]]] };
		const cases = [
			new TextEncoder().encode( 'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 0 0\n' ).buffer,
			ply( [ { name: 'vertex', properties: [ ...VERTEX, [ 'uchar', 'red' ], [ 'uchar', 'green' ], [ 'uchar', 'blue' ]], rows: vertexRows( 3 ).map( ( r ) => [ ...r, 1, 2, 3 ] ) }, face ] ),
			ply( [ vertex, { name: 'face', properties: [ ...FACE, [ 'list', 'uchar', 'float', 'texcoord' ]], rows: [[[ 0, 1, 2 ], [ 0, 0, 1, 0, 0, 1 ]]] } ] ),
			ply( [ vertex, face, { name: 'edge', properties: [[ 'int', 'vertex1' ], [ 'int', 'vertex2' ]], rows: [[ 0, 1 ]] } ] ),
			ply( [ { name: 'vertex', properties: [ ...VERTEX, [ 'list', 'uchar', 'int', 'groups' ]], rows: vertexRows( 3 ).map( ( r ) => [ ...r, [ 1 ]] ) }, face ] ),
			ply( [ vertex, { name: 'face', properties: [[ 'list', 'uchar', 'int', 'corners' ]], rows: [[[ 0, 1, 2 ]]] } ] ),
			ply( [ { name: 'vertex', properties: [[ 'short', 'x' ], [ 'short', 'y' ], [ 'short', 'z' ]], rows: [[ 1, 2, 3 ]] } ] ),
			ply( [ vertex, face ] ).slice( 0, - 2 ),
			ply( [ vertex ] ).slice( 0, - 5 ),
			new ArrayBuffer( 0 )
		];
		for ( const data of cases ) expect( parseBinaryPLY( data ) ).toBeNull();

	} );

	it( 'reads a repeated name with its last type, a negative count as none, and a NaN\'s bits as PLYLoader keeps them', () => {

		const face = { name: 'face', properties: FACE, rows: [[[ 0, 1, 1 ]]] };
		expectSame( ply( [ { name: 'vertex', properties: [[ 'float', 'x' ], [ 'float', 'y' ], [ 'float', 'z' ], [ 'double', 'x' ]], rows: [[ 1, 2, 3, 9 ], [ 4, 5, 6, 8 ]] }, face ] ) );
		expectSame( ply( [ face, { name: 'vertex', properties: [[ 'double', 'x' ], [ 'float', 'y' ], [ 'float', 'z' ], [ 'float', 'x' ]], rows: [[ 1, 2, 3, 9 ], [ 4, 5, 6, 8 ]] } ] ) );
		expectSame( ply( [
			{ name: 'vertex', properties: VERTEX.slice( 0, 3 ), rows: vertexRows( 3 ).map( ( r ) => r.slice( 0, 3 ) ) },
			{ name: 'face', properties: [[ 'list', 'char', 'int', 'vertex_indices' ]], rows: [[[]], [[ 0, 1, 2 ]]] }
		] ).slice( 0 ) );
		// A count byte of −1 (0xFF as a char) reads no items.
		const negative = new Uint8Array( ply( [
			{ name: 'vertex', properties: VERTEX.slice( 0, 3 ), rows: vertexRows( 3 ).map( ( r ) => r.slice( 0, 3 ) ) },
			{ name: 'face', properties: [[ 'list', 'char', 'int', 'vertex_indices' ]], rows: [[[]], [[ 0, 1, 2 ]]] }
		] ) );
		negative[ negative.length - 14 ] = 0xff;
		expect( Array.from( expectSame( negative.buffer ).index.array ) ).toEqual( [ 0, 1, 2 ] );

		const nan = new Uint8Array( ply( [ { name: 'vertex', properties: VERTEX.slice( 0, 3 ), rows: [[ 0, 1, 2 ], [ 3, 4, 5 ]] } ] ) );
		new DataView( nan.buffer ).setUint32( nan.length - 24, 0xffc00001, true );
		const bits = ( g ) => Array.from( new Uint32Array( g.attributes.position.array.buffer ) );
		expect( bits( expectSame( nan.buffer ) ) ).toEqual( bits( loader.parse( nan.buffer.slice( 0 ) ) ) );

	} );

	it( 'hands back unknown types named like built-ins, a header with no body, and more faces than bytes', () => {

		const vertex = { name: 'vertex', properties: [ ...VERTEX.slice( 0, 3 ), [ 'toString', 'w' ]], rows: [] };
		expect( parseBinaryPLY( ply( [ vertex ] ) ) ).toBeNull();
		expect( parseBinaryPLY( ply( [ { name: 'face', properties: [[ 'list', 'uchar', 'constructor', 'vertex_indices' ]], rows: [] } ] ) ) ).toBeNull();
		expect( parseBinaryPLY( new TextEncoder().encode( 'ply\r\nformat binary_little_endian 1.0\r\nelement vertex 0\r\nproperty float x\r\nend_header\r' ).buffer ) ).toBeNull();
		const huge = new TextEncoder().encode( 'ply\nformat binary_little_endian 1.0\nelement face 2000000000\nproperty list uchar int vertex_indices\nend_header\n\x03' ).buffer;
		expect( parseBinaryPLY( huge ) ).toBeNull();

	} );

} );
