import { describe, it, expect } from 'vitest';
import { BoxGeometry, Color, Group, InstancedMesh, Matrix4, Mesh, MeshStandardMaterial, SphereGeometry } from 'three';
import { GeometryExtractor } from '@/core/Processor/GeometryExtractor.js';

function scene() {

	const group = new Group();
	const shared = new BoxGeometry( 1, 1, 1 );
	const plain = new MeshStandardMaterial( { color: 0x808080 } );
	const lamp = new MeshStandardMaterial( { emissive: new Color( 1, 1, 1 ), emissiveIntensity: 2 } );

	const a = new Mesh( shared, plain );
	a.position.set( 1, 0, 0 );
	const b = new Mesh( shared, plain );
	b.position.set( 3, 0, 0 );
	const nested = new Group();
	nested.add( new Mesh( new SphereGeometry( 1, 16, 8 ), plain ) );
	nested.add( b );

	const trees = new InstancedMesh( new SphereGeometry( 0.5, 8, 4 ), plain, 3 );
	const lamps = new InstancedMesh( new BoxGeometry(), lamp, 2 );
	for ( let i = 0; i < 3; i ++ ) trees.setMatrixAt( i, new Matrix4().makeTranslation( i, 5, 0 ) );
	for ( let i = 0; i < 2; i ++ ) lamps.setMatrixAt( i, new Matrix4().makeTranslation( 0, 10, i * 2 ) );

	group.add( a, nested, trees, lamps );
	group.updateMatrixWorld( true );
	return group;

}

describe( 'GeometryExtractor.extractStreaming', () => {

	it( 'stores exactly what extract() stores, handing each range over as it lands', async () => {

		const plain = new GeometryExtractor().extract( scene() );

		const handed = [];
		let pauses = 0;
		const streamed = await new GeometryExtractor().extractStreaming( scene(), {
			onRange: ( m, range ) => handed.push( [ m, range.start, range.count ] ),
			pause: async () => void pauses ++,
			yieldEvery: 50,
		} );

		expect( streamed.triangleCount ).toBe( plain.triangleCount );
		expect( streamed.triangleData.recordCount ).toBe( plain.triangleCount );
		expect( Array.from( streamed.triangleData.copyOf( 0, streamed.triangleCount ) ) )
			.toEqual( Array.from( plain.triangleData.copyOf( 0, plain.triangleCount ) ) );
		expect( streamed.meshTriangleRanges ).toEqual( plain.meshTriangleRanges );
		expect( Array.from( streamed.instanceSource ) ).toEqual( Array.from( plain.instanceSource ) );

		// Every stored range once, in storage order; the shared box's second mesh is not one.
		const owners = plain.meshTriangleRanges.map( ( r, m ) => [ m, r.start, r.count ] ).filter( ( [ , , count ], m ) => count > 0 && plain.meshTriangleRanges[ m ].sharedFrom === undefined );
		expect( handed ).toEqual( owners );
		expect( pauses ).toBeGreaterThan( 0 );

	} );

	it( 'sizes its store exactly, counting a shared geometry once and an emissive instance each', () => {

		const extractor = new GeometryExtractor();
		const data = extractor.extract( scene() );
		expect( extractor._countStoredTriangles( scene() ) ).toBe( data.triangleCount );

	} );

} );
