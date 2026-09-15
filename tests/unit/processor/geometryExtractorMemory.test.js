import { describe, it, expect } from 'vitest';
import {
	BufferAttribute, BufferGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial
} from 'three';
import { GeometryExtractor, geometryBytesOf } from '@/core/Processor/GeometryExtractor.js';

/** A single unit triangle with explicit normals and UVs. */
function triangleGeometry( normal = [ 0, 0, 1 ] ) {

	const g = new BufferGeometry();
	g.setAttribute( 'position', new BufferAttribute( new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0 ] ), 3 ) );
	g.setAttribute( 'normal', new BufferAttribute( new Float32Array( [ ...normal, ...normal, ...normal ] ), 3 ) );
	g.setAttribute( 'uv', new BufferAttribute( new Float32Array( [ 0, 0, 1, 0, 0, 1 ] ), 2 ) );
	return g;

}

function extract( root ) {

	root.updateMatrixWorld( true );
	const extractor = new GeometryExtractor();
	return { extractor, data: extractor.extract( root ) };

}

describe( 'GeometryExtractor placement storage', () => {

	it( 'records placements as typed columns, not one object each', () => {

		const group = new Group();
		const inst = new InstancedMesh( triangleGeometry(), new MeshStandardMaterial(), 3 );
		for ( let i = 0; i < 3; i ++ ) inst.setMatrixAt( i, new Matrix4().makeTranslation( i * 5, 0, 0 ) );
		group.add( inst );
		group.add( new Mesh( triangleGeometry(), new MeshStandardMaterial() ) );

		const { data } = extract( group );

		expect( data.instanceCount ).toBe( 4 );
		expect( data.instanceSource ).toBeInstanceOf( Int32Array );
		expect( data.instanceMatrices ).toBeInstanceOf( Float32Array );
		expect( data.instanceMatrices ).toHaveLength( 4 * 16 );
		// Translations survive: instance 2 sits at x = 10.
		expect( data.instanceMatrices[ 2 * 16 + 12 ] ).toBe( 10 );
		// Both placements of the InstancedMesh point at the same source mesh.
		expect( data.instanceSource[ 0 ] ).toBe( data.instanceSource[ 2 ] );
		expect( data.instanceSource[ 3 ] ).not.toBe( data.instanceSource[ 0 ] );

	} );

	it( 'points an origin-hosted InstancedMesh at the placement pool rather than a second copy', () => {

		const inst = new InstancedMesh( triangleGeometry(), new MeshStandardMaterial(), 4 );
		for ( let i = 0; i < 4; i ++ ) inst.setMatrixAt( i, new Matrix4().makeTranslation( i, 0, 0 ) );

		const { data } = extract( inst );

		expect( inst.instanceMatrix.array.buffer ).toBe( data.instanceMatrices.buffer );
		// Still readable through the three.js API, and still the right values.
		const m = new Matrix4();
		inst.getMatrixAt( 3, m );
		expect( m.elements[ 12 ] ).toBe( 3 );

	} );

	it( 'keeps its own copy when the host object is not at the origin', () => {

		const group = new Group();
		group.position.set( 100, 0, 0 );
		const inst = new InstancedMesh( triangleGeometry(), new MeshStandardMaterial(), 2 );
		inst.setMatrixAt( 0, new Matrix4().makeTranslation( 1, 0, 0 ) );
		inst.setMatrixAt( 1, new Matrix4().makeTranslation( 2, 0, 0 ) );
		group.add( inst );

		const { data } = extract( group );

		// Sharing would corrupt the renderer's matrices, since the pool holds world space.
		expect( inst.instanceMatrix.array.buffer ).not.toBe( data.instanceMatrices.buffer );
		expect( data.instanceMatrices[ 12 ] ).toBe( 101 );
		expect( data.instanceMatrices[ 16 + 12 ] ).toBe( 102 );

	} );

} );

describe( 'GeometryExtractor attribute compression', () => {

	it( 'stores normals as normalized 16-bit integers that read back unchanged', () => {

		const mesh = new Mesh( triangleGeometry( [ 0, 1, 0 ] ), new MeshStandardMaterial() );
		extract( mesh );

		const normal = mesh.geometry.getAttribute( 'normal' );
		expect( normal.array ).toBeInstanceOf( Int16Array );
		expect( normal.normalized ).toBe( true );
		expect( normal.getX( 0 ) ).toBeCloseTo( 0, 4 );
		expect( normal.getY( 0 ) ).toBeCloseTo( 1, 4 );
		expect( normal.getZ( 0 ) ).toBeCloseTo( 0, 4 );

	} );

	it( 'leaves positions and UVs as floats', () => {

		const mesh = new Mesh( triangleGeometry(), new MeshStandardMaterial() );
		extract( mesh );

		expect( mesh.geometry.getAttribute( 'position' ).array ).toBeInstanceOf( Float32Array );
		expect( mesh.geometry.getAttribute( 'uv' ).array ).toBeInstanceOf( Float32Array );

	} );

	it( 'leaves out-of-range normals alone rather than clamping them', () => {

		const mesh = new Mesh( triangleGeometry( [ 0, 3, 0 ] ), new MeshStandardMaterial() );
		extract( mesh );

		expect( mesh.geometry.getAttribute( 'normal' ).array ).toBeInstanceOf( Float32Array );

	} );

	it( 'does not change the triangle data the path tracer reads', () => {

		const a = new Mesh( triangleGeometry( [ 0, 1, 0 ] ), new MeshStandardMaterial() );
		const b = new Mesh( triangleGeometry( [ 0, 1, 0 ] ), new MeshStandardMaterial() );

		// `a` is extracted from float normals; `b` from normals a previous extract compressed.
		const first = extract( a ).data.triangleData.slice();
		extract( b );
		const second = extract( b ).data.triangleData.slice();

		expect( Array.from( second ) ).toEqual( Array.from( first ) );

	} );

} );

describe( 'GeometryExtractor.surveyScene', () => {

	it( 'agrees with what extract() actually stores', () => {

		const group = new Group();
		const inst = new InstancedMesh( triangleGeometry(), new MeshStandardMaterial(), 3 );
		for ( let i = 0; i < 3; i ++ ) inst.setMatrixAt( i, new Matrix4().makeTranslation( i * 5, 0, 0 ) );
		group.add( inst );
		group.add( new Mesh( triangleGeometry(), new MeshStandardMaterial() ) );
		group.updateMatrixWorld( true );

		const survey = new GeometryExtractor().surveyScene( group );
		const { data } = extract( group );

		expect( survey.placements ).toBe( data.instanceCount );
		expect( survey.triangles ).toBe( data.triangleCount );
		expect( survey.meshes ).toBe( 2 );

	} );

	it( 'counts shared geometry once, not once per instance', () => {

		// Two meshes over one geometry: counting per placement would double the figure, and on a
		// scene with millions of placements that is the difference between a sane estimate and a
		// nonsensical one.
		const shared = triangleGeometry();
		const group = new Group();
		group.add( new Mesh( shared, new MeshStandardMaterial() ) );
		group.add( new Mesh( shared, new MeshStandardMaterial() ) );
		group.updateMatrixWorld( true );

		const both = new GeometryExtractor().surveyScene( group );

		const one = new Group();
		one.add( new Mesh( shared, new MeshStandardMaterial() ) );
		one.updateMatrixWorld( true );

		expect( both.geometryBytes ).toBe( new GeometryExtractor().surveyScene( one ).geometryBytes );
		expect( both.meshes ).toBe( 2 );

	} );

	it( 'counts index and attribute arrays, so an indexed mesh is not under-reported', () => {

		const g = triangleGeometry();
		g.setIndex( new BufferAttribute( new Uint16Array( [ 0, 1, 2 ] ), 1 ) );
		const mesh = new Mesh( g, new MeshStandardMaterial() );
		mesh.updateMatrixWorld( true );

		const survey = new GeometryExtractor().surveyScene( mesh );
		const attrs = 9 * 4 + 9 * 4 + 6 * 4; // position + normal + uv
		expect( survey.geometryBytes ).toBe( attrs + 3 * 2 );

	} );

	it( 'reports an empty scene as empty rather than throwing', () => {

		const survey = new GeometryExtractor().surveyScene( new Group() );
		expect( survey ).toEqual( { triangles: 0, placements: 0, meshes: 0, geometryBytes: 0 } );

	} );

} );

describe( 'geometryBytesOf', () => {

	it( 'shrinks when attributes are compressed, which is why it is re-read after extraction', () => {

		// _compressAttributes halves normals to int16; a figure taken before the build would
		// over-report the resident mirror by that difference.
		const mesh = new Mesh( triangleGeometry(), new MeshStandardMaterial() );
		mesh.updateMatrixWorld( true );

		const before = geometryBytesOf( mesh );
		extract( mesh );
		const after = geometryBytesOf( mesh );

		expect( after ).toBeLessThan( before );

	} );

	it( 'ignores a mesh with no material, matching what extract() skips', () => {

		const group = new Group();
		const orphan = new Mesh( triangleGeometry() );
		orphan.material = null;
		group.add( orphan );
		group.updateMatrixWorld( true );

		expect( geometryBytesOf( group ) ).toBe( 0 );

	} );

} );
