import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Vector3 } from 'three';
import { GeometryExtractor } from '@/core/Processor/GeometryExtractor.js';

const IDENTITY = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

/** Vertex A of a mesh's first triangle, from three.js, in local or world space. */
function firstVertex( mesh, world ) {

	const g = mesh.geometry;
	const i = g.index ? g.index.array[ 0 ] : 0;
	const p = new Vector3().fromBufferAttribute( g.attributes.position, i );
	return ( world ? p.applyMatrix4( mesh.matrixWorld ) : p ).toArray();

}

/** Vertex A of the first triangle the extractor stored for a mesh. */
function firstStoredVertex( extractor, data, meshIndex ) {

	const rec = extractor.getTriangleData();
	const t = data.meshTriangleRanges[ meshIndex ].start;
	const chunk = rec.chunkFor( t );
	const f = new Float32Array( chunk.buffer, chunk.byteOffset, chunk.length );
	const b = rec.baseOf( t );
	return [ f[ b ], f[ b + 1 ], f[ b + 2 ] ];

}

const near = ( got, want ) => got.forEach( ( v, i ) => expect( v ).toBeCloseTo( want[ i ], 5 ) );

describe( 'hybrid geometry storage', () => {

	it( 'bakes single-use geometry to world space and keeps shared geometry in object space', () => {

		const group = new Group();

		const solo = new Mesh( new BoxGeometry( 1, 1, 1 ), new MeshStandardMaterial() );
		solo.position.set( 10, 0, 0 );

		const sharedGeometry = new BoxGeometry( 2, 2, 2 );
		const sharedMaterial = new MeshStandardMaterial();
		const first = new Mesh( sharedGeometry, sharedMaterial );
		first.position.set( 0, 5, 0 );
		const second = new Mesh( sharedGeometry, sharedMaterial );
		second.position.set( 0, - 5, 0 );

		group.add( solo, first, second );
		group.updateMatrixWorld( true );

		const extractor = new GeometryExtractor();
		const data = extractor.extract( group );

		// solo is mesh 0; the two sharing meshes are 1 and 2.
		expect( Array.from( data.instanceMatrices.subarray( 0, 16 ) ) ).toEqual( IDENTITY );
		expect( data.instanceMatrices[ 16 + 13 ] ).toBe( 5 );
		expect( data.instanceMatrices[ 32 + 13 ] ).toBe( - 5 );

		expect( data.bakeInverse.has( 0 ) ).toBe( true );
		expect( data.bakeInverse.has( 1 ) ).toBe( false );
		expect( data.bakeInverse.get( 0 )[ 12 ] ).toBe( - 10 );

		expect( data.meshTriangleRanges[ 2 ].sharedFrom ).toBe( 1 );

		// The baked mesh's triangles carry its world pose; the shared pair's do not.
		near( firstStoredVertex( extractor, data, 0 ), firstVertex( solo, true ) );
		near( firstStoredVertex( extractor, data, 1 ), firstVertex( first, false ) );

	} );

	it( 'bakes emissive geometry even when its geometry is reused', () => {

		const group = new Group();
		const geometry = new BoxGeometry( 1, 1, 1 );
		const glow = new MeshStandardMaterial( { emissive: 0xffffff, emissiveIntensity: 2 } );
		const a = new Mesh( geometry, glow );
		a.position.set( 3, 0, 0 );
		const b = new Mesh( geometry, glow );
		b.position.set( - 3, 0, 0 );
		group.add( a, b );
		group.updateMatrixWorld( true );

		const extractor = new GeometryExtractor();
		const data = extractor.extract( group );

		// Emitters never share a copy, so each is baked at its own pose.
		expect( data.bakeInverse.size ).toBe( 2 );
		expect( data.meshTriangleRanges[ 1 ].sharedFrom ).toBeUndefined();
		near( firstStoredVertex( extractor, data, 0 ), firstVertex( a, true ) );
		near( firstStoredVertex( extractor, data, 1 ), firstVertex( b, true ) );

	} );

} );
