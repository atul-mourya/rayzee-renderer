/**
 * The extractor reads a plain attribute straight from its array: every triangle record the same, byte for byte, as
 * reading it through getX / getY / getZ — interleaved, normalised, half-float and one-, two- or four-component attributes included.
 */
import { describe, it, expect } from 'vitest';
import { BufferAttribute, BufferGeometry, Float16BufferAttribute, Float32BufferAttribute, Group, InterleavedBuffer, InterleavedBufferAttribute, Mesh, MeshStandardMaterial } from 'three';
import { GeometryExtractor } from '@/core/scene/GeometryExtractor.js';

let seed = 9;
const rand = () => ( seed = ( seed * 16807 ) % 2147483647 ) / 2147483647 - 0.5;
const floats = ( n ) => Float32Array.from( { length: n }, rand );

function scene() {

	seed = 9; // the same geometry for both readers
	const group = new Group();
	const add = ( geometry ) => group.add( new Mesh( geometry, new MeshStandardMaterial() ) );
	const n = 30;
	const index = Array.from( { length: 60 }, ( _, k ) => ( k * 7 ) % n );

	// Plain floats, indexed, with uv.
	const plain = new BufferGeometry();
	plain.setAttribute( 'position', new Float32BufferAttribute( floats( n * 3 ), 3 ) );
	plain.setAttribute( 'normal', new Float32BufferAttribute( floats( n * 3 ), 3 ) );
	plain.setAttribute( 'uv', new Float32BufferAttribute( floats( n * 2 ), 2 ) );
	plain.setIndex( index );
	add( plain );

	// Interleaved position + normal + uv, not indexed.
	const stride = 8, data = new InterleavedBuffer( floats( n * stride ), stride );
	const interleaved = new BufferGeometry();
	interleaved.setAttribute( 'position', new InterleavedBufferAttribute( data, 3, 0 ) );
	interleaved.setAttribute( 'normal', new InterleavedBufferAttribute( data, 3, 3 ) );
	interleaved.setAttribute( 'uv', new InterleavedBufferAttribute( data, 2, 6 ) );
	add( interleaved );

	// Quantised: normalised Int16 position and Int8 normal, a Uint16 uv.
	const quantised = new BufferGeometry();
	const ints = ( Type, n, span ) => Type.from( { length: n }, () => Math.round( rand() * span ) );
	quantised.setAttribute( 'position', new BufferAttribute( ints( Int16Array, n * 3, 60000 ), 3, true ) );
	quantised.setAttribute( 'normal', new BufferAttribute( ints( Int8Array, n * 3, 250 ), 3, true ) );
	quantised.setAttribute( 'uv', new BufferAttribute( Uint16Array.from( { length: n * 2 }, ( _, k ) => k * 997 % 65536 ), 2, true ) );
	quantised.setIndex( index );
	add( quantised );

	// Four-component normals, a two-component position.
	const odd = new BufferGeometry();
	odd.setAttribute( 'position', new Float32BufferAttribute( floats( n * 2 ), 2 ) );
	odd.setAttribute( 'normal', new Float32BufferAttribute( floats( n * 4 ), 4 ) );
	add( odd );

	// Half floats: three's attribute decodes them in getX.
	const half = new BufferGeometry();
	half.setAttribute( 'position', new Float16BufferAttribute( floats( n * 3 ), 3 ) );
	half.setAttribute( 'normal', new Float16BufferAttribute( floats( n * 3 ), 3 ) );
	half.setAttribute( 'uv', new Float16BufferAttribute( floats( n * 2 ), 2 ) );
	add( half );

	// Unnormalised integers (KHR_mesh_quantization allows them): read from the array, as getX would.
	const integers = new BufferGeometry();
	integers.setAttribute( 'position', new BufferAttribute( Int16Array.from( { length: n * 3 }, () => Math.round( rand() * 2000 ) ), 3 ) );
	integers.setAttribute( 'normal', new Float32BufferAttribute( floats( n * 3 ), 3 ) );
	add( integers );

	// A one-component uv reads nothing: the last uv stays, as getVertex leaves it.
	const single = new BufferGeometry();
	single.setAttribute( 'position', new Float32BufferAttribute( floats( n * 3 ), 3 ) );
	single.setAttribute( 'normal', new Float32BufferAttribute( floats( n * 3 ), 3 ) );
	single.setAttribute( 'uv', new Float32BufferAttribute( floats( n ), 1 ) );
	add( single );

	return group;

}

function records( direct ) {

	const extractor = new GeometryExtractor();
	if ( ! direct ) {

		extractor._vertexReader = ( attribute ) => ( index, target ) => extractor.getVertex( attribute, index, target );
		extractor._fillPlain = extractor._fillGeneral;

	}

	let calls = 0;
	const getVertex = extractor.getVertex.bind( extractor );
	extractor.getVertex = ( ...args ) => {

		calls ++;
		return getVertex( ...args );

	};

	const data = extractor.extract( scene() ).triangleData;
	const f = data.single ?? data;
	return { lanes: Array.from( new Uint32Array( f.buffer, f.byteOffset, f.byteLength / 4 ) ), calls };

}

describe( 'extractor vertex reads', () => {

	it( 'reads plain attributes from their arrays, every record as getX / getY / getZ give it', () => {

		const { lanes: direct, calls } = records( true ), { lanes: called } = records( false );
		expect( direct.length ).toBe( 90 * 20 ); // 90 triangles, 20 lanes each
		const first = direct.findIndex( ( v, k ) => v !== called[ k ] );
		expect( [ direct.length, first ] ).toEqual( [ called.length, - 1 ] );
		// Only the interleaved, quantised and half-float meshes' 40 triangles take the calls: 3 attributes × 3 corners.
		expect( calls ).toBe( 40 * 3 * 3 );
		expect( records( false ).calls ).toBe( 90 * 3 * 3 - 20 * 3 );

	} );

} );
