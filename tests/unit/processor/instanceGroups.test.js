import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, InstancedMesh, Matrix4, MeshStandardMaterial } from 'three';
import { GeometryExtractor } from '@/core/Processor/GeometryExtractor.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';
import { BVH_EMPTY_BOX, BVH_LEAF_MARKERS } from '@/core/Processor/BufferLayout.js';

function instanced( geometry, material, count, matrices = null ) {

	const mesh = new InstancedMesh( geometry, material, count );
	if ( matrices ) mesh.instanceMatrix = matrices;
	else for ( let i = 0; i < count; i ++ ) mesh.setMatrixAt( i, new Matrix4().makeTranslation( i * 3, 0, 0 ) );
	return mesh;

}

describe( 'instance groups', () => {

	it( 'groups instanced meshes that share a matrix list under one host transform', () => {

		const root = new Group();
		const trunk = instanced( new BoxGeometry(), new MeshStandardMaterial(), 4 );
		const leaves = instanced( new BoxGeometry( 2, 1, 2 ), new MeshStandardMaterial(), 4, trunk.instanceMatrix );
		const moved = instanced( new BoxGeometry(), new MeshStandardMaterial(), 4, trunk.instanceMatrix );
		moved.position.set( 0, 5, 0 );
		const glow = instanced( new BoxGeometry(), new MeshStandardMaterial( { emissive: 0xffffff, emissiveIntensity: 1 } ), 4, trunk.instanceMatrix );
		const alone = instanced( new BoxGeometry(), new MeshStandardMaterial(), 4 );
		root.add( trunk, leaves, moved, glow, alone );
		root.updateMatrixWorld( true );

		const data = new GeometryExtractor().extract( root );
		const index = mesh => data.meshes.indexOf( mesh );

		// Emissive instances become real triangles; the moved host and the unshared list stay apart.
		expect( data.instanceGroups ).toEqual( [ { members: [ index( trunk ), index( leaves ) ], starts: [ 0, 4 ], count: 4 } ] );

	} );

	it( 'maps every member placement of a copy to one entry', () => {

		const table = new InstanceTable();
		const source = Int32Array.from( [ 0, 0, 0, 1, 1, 1, 2 ] );
		table.allocate( 7, 3, null, source );
		table.setGroups( [ { members: [ 0, 1 ], starts: [ 0, 3 ], count: 3 } ] );

		expect( table.entryCount ).toBe( 4 );
		expect( Array.from( table.placementEntry ) ).toEqual( [ 0, 1, 2, 0, 1, 2, 3 ] );
		expect( table.repOf( 1 ) ).toBe( 1 );
		expect( table.repOf( 3 ) ).toBe( 6 );
		expect( table.groupOfEntry( 0 ) ).toBe( 0 );
		expect( table.groupOfEntry( 3 ) ).toBe( - 1 );

		table.visible[ 1 ] = 0;
		expect( table.entryVisible( 1 ) ).toBe( true ); // the other member of copy 1 still shows
		table.visible[ 4 ] = 0;
		expect( table.entryVisible( 1 ) ).toBe( false );

		table.setLeafOf( 2, 9 );
		expect( table.tlasLeafIndex[ 2 ] ).toBe( 9 );
		expect( table.tlasLeafIndex[ 5 ] ).toBe( 9 );

	} );

	it( 'writes a group tree over the members, and points a hidden one at the empty leaf', () => {

		const table = new InstanceTable();
		table.allocate( 6, 3, null, Int32Array.from( [ 0, 0, 1, 1, 2, 2 ] ) );
		for ( let t = 0; t < 3; t ++ ) {

			table.setEntry( { meshIndex: t * 2, blasNodeCount: 1, triOffset: t, triCount: 1, originalToBvhMap: null, bvhData: null, sourceMesh: t } );
			table.setAlias( t * 2 + 1, t * 2, null, null, t );
			table.tplObjectAABB.set( [ t * 10, 0, 0, t * 10 + 1, 1, 1 ], t * 6 );

		}

		table.setGroups( [ { members: [ 0, 1, 2 ], starts: [ 0, 2, 4 ], count: 2 } ] );
		table.computeGroupAABBs();
		table.assignOffsets( 3 );

		expect( table.groupNodeStart ).toBe( 3 );
		expect( table.groupNodeCount ).toBe( 3 ); // two inner nodes for three members, then the empty leaf
		expect( Array.from( table.groups[ 0 ].aabb ) ).toEqual( [ 0, 0, 0, 21, 1, 1 ] );
		expect( table.entryRoot( 0 ) ).toBe( 3 );

		table.visible[ 2 ] = table.visible[ 3 ] = 0;
		const block = table.groupNodeBlock();
		const idx = new Uint32Array( block.buffer );
		const children = [];
		for ( let n = 0; n < 2; n ++ ) children.push( idx[ n * 16 + 3 ], idx[ n * 16 + 7 ] );

		const empty = table.emptyGroupLeaf;
		expect( empty ).toBe( 5 );
		expect( idx[ 2 * 16 + 3 ] ).toBe( BVH_LEAF_MARKERS.TRIANGLE_LEAF );
		expect( idx[ 2 * 16 + 1 ] ).toBe( 0 );
		// Members 0 and 2 by their BLAS roots, member 1 by the empty leaf, and the second inner node.
		expect( children.slice().sort( ( a, b ) => a - b ) ).toEqual( [ 4, empty, table.tplBlasOffset[ 0 ], table.tplBlasOffset[ 2 ] ].sort( ( a, b ) => a - b ) );
		const slot = children.indexOf( empty );
		const n = slot >> 1, side = slot & 1;
		expect( block[ n * 16 + side * 8 ] ).toBe( Math.fround( BVH_EMPTY_BOX ) );

	} );

	it( 'moves a grouped part\'s siblings with it', () => {

		const parent = new Group();
		parent.position.set( 0, 1, 0 );
		const a = new Group(), b = new Group(), c = new Group();
		parent.add( a, b, c );
		a.position.set( 4, 0, 0 );
		parent.updateMatrixWorld( true );

		const fake = {
			instanceTable: { groups: [ { members: Int32Array.from( [ 0, 1 ] ) } ], groupOfTemplate: Int32Array.from( [ 0, 0, - 1 ] ) },
			meshes: [ a, b, c ],
		};
		const moved = SceneProcessor.prototype._withGroupSiblings.call( fake, [ 0 ] );

		expect( [ ...moved ].sort() ).toEqual( [ 0, 1 ] );
		expect( b.position.toArray() ).toEqual( [ 4, 0, 0 ] );
		expect( c.position.toArray() ).toEqual( [ 0, 0, 0 ] );

	} );

} );
