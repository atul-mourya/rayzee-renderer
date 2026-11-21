import { describe, it, expect } from 'vitest';
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, MeshStandardMaterial } from 'three';
import { GeometryExtractor } from '@/core/scene/GeometryExtractor.js';
import { TRIANGLE_DATA_LAYOUT as L } from '@/core/scene/BufferLayout.js';

// A 4 × 2 × 1 box's +Z, −Z and +X faces, one triangle each, no uv.
const TRIANGLES = [
	[ 0, 0, 1, 4, 0, 1, 4, 2, 1 ], // +Z
	[ 0, 0, 0, 0, 2, 0, 4, 2, 0 ], // −Z
	[ 4, 0, 0, 4, 2, 0, 4, 2, 1 ], // +X
];

function uvs( missingUV, { scale = 1 } = {} ) {

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new Float32BufferAttribute( TRIANGLES.flat(), 3 ) );
	if ( missingUV ) geometry.userData.missingUV = missingUV;
	const mesh = new Mesh( geometry, new MeshStandardMaterial() );
	mesh.scale.setScalar( scale );
	const data = new GeometryExtractor().extract( new Group().add( mesh ) ).triangleData;
	const lanes = data.single ?? data;
	const f = new Float32Array( lanes.buffer, lanes.byteOffset, lanes.length );
	return TRIANGLES.map( ( _, t ) => {

		const o = t * L.FLOATS_PER_TRIANGLE;
		return [ f[ o + L.UV_AB_OFFSET ], f[ o + L.UV_AB_OFFSET + 1 ], f[ o + L.UV_AB_OFFSET + 2 ], f[ o + L.UV_AB_OFFSET + 3 ], f[ o + L.UV_C_OFFSET ], f[ o + L.UV_C_OFFSET + 1 ] ];

	} );

}

describe( 'a mesh without uvs', () => {

	it( 'is box-projected along each face\'s main axis, over its largest extent, nothing mirrored', () => {

		const [ front, back, side ] = uvs();
		// +Z: x and y, a quarter a unit.
		expect( front ).toEqual( [ 0, 0, 1, 0, 1, 0.5 ] );
		// −Z seen from behind: x runs the other way.
		expect( back ).toEqual( [ 1, 0, 1, 0.5, 0, 0.5 ] );
		// +X seen from outside: z runs right to left.
		expect( side ).toEqual( [ 0.25, 0, 0.25, 0.5, 0, 0.5 ] );
		// Object space: the same however the mesh is placed.
		expect( uvs( undefined, { scale: 3 } ) ).toEqual( [ front, back, side ] );

	} );

	it( 'reads 0, 0 or pbrt\'s triangle uv where the mesh says so', () => {

		expect( uvs( 'zero' ) ).toEqual( TRIANGLES.map( () => [ 0, 0, 0, 0, 0, 0 ] ) );
		expect( uvs( 'triangle' ) ).toEqual( TRIANGLES.map( () => [ 0, 0, 1, 0, 1, 1 ] ) );

	} );

} );
