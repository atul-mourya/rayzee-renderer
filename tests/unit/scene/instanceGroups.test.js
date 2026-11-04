import { describe, it, expect, vi } from 'vitest';

// three's FileLoader makes one per streamed chunk; Node has none (nodePlatform() defines one for hosts).
vi.hoisted( () => {

	globalThis.ProgressEvent ??= class extends Event {};

} );
import { BoxGeometry, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, MeshStandardMaterial, Scene } from 'three';
import { GeometryExtractor } from '@/core/scene/GeometryExtractor.js';
import { InstanceTable } from '@/core/scene/InstanceTable.js';
import { SceneProcessor } from '@/core/scene/SceneProcessor.js';
import { BVH_EMPTY_BOX, BVH_LEAF_MARKERS } from '@/core/scene/BufferLayout.js';

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
		alone.setMatrixAt( 2, new Matrix4().makeTranslation( 0, 9, 0 ) );
		root.add( trunk, leaves, moved, glow, alone );
		root.updateMatrixWorld( true );

		const data = new GeometryExtractor().extract( root );
		const index = mesh => data.meshes.indexOf( mesh );

		// Emissive instances become real triangles; the moved host and the list with other matrices stay apart.
		expect( data.instanceGroups ).toEqual( [ { members: [ index( trunk ), index( leaves ) ], starts: [ 0, 4 ], count: 4 } ] );

	} );

	it( 'groups siblings holding equal matrix lists of their own, as glTF\'s GPU instancing gives a node\'s primitives', () => {

		const root = new Group(), node = new Group(), elsewhere = new Group();
		const trunk = instanced( new BoxGeometry(), new MeshStandardMaterial(), 5 );
		const leaves = instanced( new BoxGeometry( 2, 1, 2 ), new MeshStandardMaterial(), 5 );
		const bark = instanced( new BoxGeometry(), new MeshStandardMaterial(), 5 );
		// Equal lists, but not siblings: another object at the same copies.
		const twin = instanced( new BoxGeometry(), new MeshStandardMaterial(), 5 );
		// Siblings, the same first and last copy, one in between moved.
		const odd = instanced( new BoxGeometry(), new MeshStandardMaterial(), 5 );
		odd.setMatrixAt( 2, new Matrix4().makeTranslation( 6, 1, 0 ) );
		node.add( trunk, leaves, bark, odd );
		elsewhere.add( twin );
		root.add( node, elsewhere );
		root.updateMatrixWorld( true );
		expect( leaves.instanceMatrix ).not.toBe( trunk.instanceMatrix );

		const data = new GeometryExtractor().extract( root );
		const index = mesh => data.meshes.indexOf( mesh );
		expect( data.instanceGroups ).toEqual( [ { members: [ trunk, leaves, bark ].map( index ), starts: [ 0, 5, 10 ], count: 5 } ] );
		// Matched, they share one list: a group is traced through one member's, so an edit must reach them all.
		expect( leaves.instanceMatrix ).toBe( trunk.instanceMatrix );
		expect( bark.instanceMatrix ).toBe( trunk.instanceMatrix );
		expect( odd.instanceMatrix ).not.toBe( trunk.instanceMatrix );

	} );

	it( 'matches lists only under a group, of two copies or more, by every lane of the copies they draw', () => {

		const material = new MeshStandardMaterial();
		const list = ( count, at = ( i ) => new Matrix4().makeTranslation( i * 3, 0, 0 ) ) => {

			const mesh = new InstancedMesh( new BoxGeometry(), material, count );
			for ( let i = 0; i < count; i ++ ) mesh.setMatrixAt( i, at( i ) );
			return mesh;

		};

		// Two objects added to the scene itself stay two: moving one must not move the other.
		const scene = new Scene();
		const a = list( 4 ), b = list( 4 );
		scene.add( a, b );

		// Under a group: a single copy, a turn in between, a longer tail past `count`, and doubles.
		const node = new Group();
		const one = list( 1 ), oneToo = list( 1 );
		const base = list( 4 ), turned = list( 4, ( i ) => new Matrix4().makeRotationY( i === 2 ? 0.5 : 0 ).setPosition( i * 3, 0, 0 ) );
		const longer = new InstancedMesh( new BoxGeometry(), material, 6 );
		for ( let i = 0; i < 6; i ++ ) longer.setMatrixAt( i, new Matrix4().makeTranslation( i < 4 ? i * 3 : 99, i < 4 ? 0 : 7, 0 ) );
		longer.count = 4;
		const doubles = list( 4 );
		doubles.instanceMatrix = new InstancedBufferAttribute( Float64Array.from( base.instanceMatrix.array ), 16 );
		node.add( one, oneToo, base, turned, longer, doubles );
		scene.add( node );
		scene.updateMatrixWorld( true );

		const data = new GeometryExtractor().extract( scene );
		const index = mesh => data.meshes.indexOf( mesh );
		expect( data.instanceGroups ).toEqual( [ { members: [ base, longer ].map( index ), starts: [ 10, 18 ], count: 4 } ] );

	} );

	it( 'puts a mesh sharing a matched list in the group its list joined', () => {

		const root = new Group(), node = new Group(), other = new Group();
		const first = instanced( new BoxGeometry(), new MeshStandardMaterial(), 3 );
		const own = instanced( new BoxGeometry(), new MeshStandardMaterial(), 3 );
		// Shares `own`'s list, found later under another parent at the same transform.
		const shares = instanced( new BoxGeometry(), new MeshStandardMaterial(), 3, own.instanceMatrix );
		const ownList = own.instanceMatrix;
		node.add( first, own );
		other.add( shares );
		root.add( node, other );
		root.updateMatrixWorld( true );

		const data = new GeometryExtractor().extract( root );
		const index = mesh => data.meshes.indexOf( mesh );
		expect( data.instanceGroups ).toEqual( [ { members: [ first, own, shares ].map( index ), starts: [ 0, 3, 6 ], count: 3 } ] );
		expect( shares.instanceMatrix ).toBe( first.instanceMatrix );
		expect( ownList ).not.toBe( first.instanceMatrix );

	} );

	it( 'groups a glTF node\'s GPU-instanced primitives', async () => {

		// One node, two primitives, three copies along x (EXT_mesh_gpu_instancing): three's loader gives an InstancedMesh a
		// primitive, each with its own matrix list.
		const bytes = new Float32Array( [ 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 4, 0, 0 ] );
		const uri = `data:application/octet-stream;base64,${ Buffer.from( bytes.buffer ).toString( 'base64' ) }`;
		const gltf = {
			asset: { version: '2.0' }, extensionsUsed: [ 'EXT_mesh_gpu_instancing' ],
			buffers: [ { uri, byteLength: 72 } ],
			bufferViews: [ { buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 36 } ],
			accessors: [
				{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [ 0, 0, 0 ], max: [ 1, 1, 0 ] },
				{ bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
			],
			materials: [ { name: 'a' }, { name: 'b' } ],
			meshes: [ { primitives: [ { attributes: { POSITION: 0 }, material: 0 }, { attributes: { POSITION: 0 }, material: 1 } ] } ],
			nodes: [ { mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } } ],
			scenes: [ { nodes: [ 0 ] } ], scene: 0,
		};
		const { GLTFLoader } = await import( 'three/addons/loaders/GLTFLoader.js' );
		const scene = ( await new GLTFLoader().parseAsync( JSON.stringify( gltf ), '' ) ).scene;
		scene.updateMatrixWorld( true );
		const parts = [];
		scene.traverse( ( o ) => o.isInstancedMesh && parts.push( o ) );
		expect( parts.length ).toBe( 2 );
		expect( parts[ 1 ].instanceMatrix ).not.toBe( parts[ 0 ].instanceMatrix );

		const data = new GeometryExtractor().extract( scene );
		expect( data.instanceGroups ).toEqual( [ { members: parts.map( ( m ) => data.meshes.indexOf( m ) ), starts: [ 0, 3 ], count: 3 } ] );

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
