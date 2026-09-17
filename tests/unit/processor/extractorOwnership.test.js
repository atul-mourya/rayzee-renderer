import { describe, it, expect } from 'vitest';
import {
	Group, Mesh, InstancedMesh, BoxGeometry, BufferGeometry, MeshStandardMaterial,
	Matrix4, Vector3, Float32BufferAttribute
} from 'three';
import { GeometryExtractor } from '@/core/Processor/GeometryExtractor.js';
import { TRIANGLE_DATA_LAYOUT } from '@/core/EngineDefaults.js';

/** The three corners the extractor stored for one triangle, in storage order. */
function storedTriangle( extractor, index ) {

	const rec = extractor.getTriangleData();
	const chunk = rec.chunkFor( index );
	const f = new Float32Array( chunk.buffer, chunk.byteOffset, chunk.length );
	const b = rec.baseOf( index );
	const L = TRIANGLE_DATA_LAYOUT;
	const at = ( o ) => new Vector3( f[ b + o ], f[ b + o + 1 ], f[ b + o + 2 ] );
	return [ at( L.POSITION_A_OFFSET ), at( L.POSITION_B_OFFSET ), at( L.POSITION_C_OFFSET ) ];

}

/** Which way the stored corners wind, as a face normal. */
function faceNormal( extractor, index ) {

	const [ a, b, c ] = storedTriangle( extractor, index );
	return new Vector3().subVectors( b, a ).cross( new Vector3().subVectors( c, a ) ).normalize();

}

/** One triangle whose corners wind counter-clockwise seen from above, normals pointing up. */
function upwardTriangle() {

	const g = new BufferGeometry();
	g.setAttribute( 'position', new Float32BufferAttribute( [ 0, 0, 0, 0, 0, 1, 1, 0, 0 ], 3 ) );
	g.setAttribute( 'normal', new Float32BufferAttribute( [ 0, 1, 0, 0, 1, 0, 0, 1, 0 ], 3 ) );
	g.setIndex( [ 0, 1, 2 ] );
	return g;

}

describe( 'geometry the engine does not own', () => {

	it( 'leaves a host object3d\'s attributes as floats', () => {

		const group = new Group();

		const hostGeometry = new BoxGeometry( 1, 1, 1 );
		const host = new Mesh( hostGeometry, new MeshStandardMaterial() );
		host.userData.__rayzeeExternal = true;

		const ownGeometry = new BoxGeometry( 1, 1, 1 );
		const own = new Mesh( ownGeometry, new MeshStandardMaterial() );

		group.add( host, own );
		group.updateMatrixWorld( true );

		new GeometryExtractor().extract( group );

		expect( hostGeometry.getAttribute( 'normal' ).array ).toBeInstanceOf( Float32Array );
		expect( ownGeometry.getAttribute( 'normal' ).array ).toBeInstanceOf( Int16Array );

	} );

	it( 'skips the whole external subtree, not just its root', () => {

		const group = new Group();
		const adopted = new Group();
		adopted.userData.__rayzeeExternal = true;

		const geometry = new BoxGeometry( 1, 1, 1 );
		adopted.add( new Mesh( geometry, new MeshStandardMaterial() ) );
		group.add( adopted );
		group.updateMatrixWorld( true );

		new GeometryExtractor().extract( group );

		expect( geometry.getAttribute( 'normal' ).array ).toBeInstanceOf( Float32Array );

	} );

} );

describe( 'geometry that deforms', () => {

	it( 'gives each morph-target copy its own triangles', () => {

		const group = new Group();

		const geometry = new BoxGeometry( 1, 1, 1 );
		const positions = geometry.getAttribute( 'position' );
		geometry.morphAttributes.position = [
			new Float32BufferAttribute( new Float32Array( positions.count * 3 ), 3 ),
		];

		const material = new MeshStandardMaterial();
		const a = new Mesh( geometry, material );
		const b = new Mesh( geometry, material );
		b.position.set( 4, 0, 0 );
		group.add( a, b );
		group.updateMatrixWorld( true );

		const data = new GeometryExtractor().extract( group );

		// Sharing one copy would let an animation write a's pose into b as well.
		expect( data.meshTriangleRanges[ 1 ].sharedFrom ).toBeUndefined();
		expect( data.meshTriangleRanges[ 1 ].start ).not.toBe( data.meshTriangleRanges[ 0 ].start );

		// And neither is baked, so a refit can still write object-space vertices into them.
		expect( data.bakeInverse.size ).toBe( 0 );

	} );

} );

describe( 'a mirroring transform', () => {

	it( 'reverses the stored winding so the face still points outward', () => {

		const plain = new Group();
		const up = new Mesh( upwardTriangle(), new MeshStandardMaterial() );
		plain.add( up );
		plain.updateMatrixWorld( true );

		const plainExtractor = new GeometryExtractor();
		plainExtractor.extract( plain );
		const before = faceNormal( plainExtractor, 0 );
		expect( before.y ).toBeCloseTo( 1, 5 );

		// Mirrored across X: the surface still faces up, but the corners now wind the other way.
		const mirrored = new Group();
		const flipped = new Mesh( upwardTriangle(), new MeshStandardMaterial() );
		flipped.applyMatrix4( new Matrix4().makeScale( - 1, 1, 1 ) );
		mirrored.add( flipped );
		mirrored.updateMatrixWorld( true );

		const mirroredExtractor = new GeometryExtractor();
		mirroredExtractor.extract( mirrored );

		expect( faceNormal( mirroredExtractor, 0 ).y ).toBeCloseTo( 1, 5 );

	} );

} );

describe( 'an emissive instanced mesh', () => {

	it( 'becomes real triangles per instance, behind one placement', () => {

		const group = new Group();
		const glow = new MeshStandardMaterial( { emissive: 0xffffff, emissiveIntensity: 3 } );
		const lamps = new InstancedMesh( upwardTriangle(), glow, 3 );
		for ( let i = 0; i < 3; i ++ ) {

			lamps.setMatrixAt( i, new Matrix4().makeTranslation( i * 10, 0, 0 ) );

		}

		group.add( lamps );
		group.updateMatrixWorld( true );

		const extractor = new GeometryExtractor();
		const data = extractor.extract( group );

		// One triangle each, at its own instance position, so all three light the scene.
		expect( data.meshTriangleRanges[ 0 ].count ).toBe( 3 );
		expect( storedTriangle( extractor, 0 )[ 0 ].x ).toBeCloseTo( 0, 5 );
		expect( storedTriangle( extractor, 1 )[ 0 ].x ).toBeCloseTo( 10, 5 );
		expect( storedTriangle( extractor, 2 )[ 0 ].x ).toBeCloseTo( 20, 5 );

		// The instances live in the triangles now, so the mesh keeps a single placement.
		expect( data.instanceCount ).toBe( 1 );
		expect( data.bakeInverse.has( 0 ) ).toBe( true );

	} );

	it( 'keeps sharing one copy when a non-emissive mesh is instanced', () => {

		const group = new Group();
		const plainMesh = new InstancedMesh( upwardTriangle(), new MeshStandardMaterial(), 3 );
		for ( let i = 0; i < 3; i ++ ) {

			plainMesh.setMatrixAt( i, new Matrix4().makeTranslation( i * 10, 0, 0 ) );

		}

		group.add( plainMesh );
		group.updateMatrixWorld( true );

		const data = new GeometryExtractor().extract( group );

		expect( data.meshTriangleRanges[ 0 ].count ).toBe( 1 );
		expect( data.instanceCount ).toBe( 3 );

	} );

} );
