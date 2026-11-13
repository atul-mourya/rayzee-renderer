import { describe, it, expect } from 'vitest';
import { BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, Group, Mesh, SphereGeometry } from 'three';
import { flattenRows, scrollToShow, ancestorsOf, layerItem, meshShape, ROW_HEIGHT } from '@/lib/outlinerRows';

const node = ( uuid, children = [], visible = true ) => ( { uuid, name: uuid, children, visible } );
const tree = [ node( 'scene', [
	node( 'a', [ node( 'a1' ), node( 'a2', [ node( 'a2x' ) ] ) ] ),
	node( 'b', [ node( 'b1' ) ], false ),
	node( 'c' ),
] ) ];

const summary = rows => rows.map( r => `${'.'.repeat( r.depth )}${r.item.uuid}${r.open ? '' : '+'}${r.visible ? '' : '!'}${r.parentHidden ? '~' : ''}` );

describe( 'the Outliner\'s rows', () => {

	it( 'lists the open tree in order, each row with its depth, and its children only while it is open', () => {

		expect( summary( flattenRows( tree, new Set(), new Map() ) ) ).toEqual( [ 'scene', '.a', '..a1', '..a2', '...a2x', '.b!', '..b1~', '.c' ] );
		expect( summary( flattenRows( tree, new Set( [ 'a2', 'b' ] ), new Map() ) ) ).toEqual( [ 'scene', '.a', '..a1', '..a2+', '.b+!', '.c' ] );

	} );

	it( 'takes a visibility heard since the layers were built over the one they carry, and dims what is under a hidden node', () => {

		const rows = flattenRows( tree, new Set(), new Map( [[ 'b', true ], [ 'a', false ]] ) );
		expect( summary( rows ) ).toEqual( [ 'scene', '.a!', '..a1~', '..a2~', '...a2x~', '.b', '..b1', '.c' ] );

	} );

	it( 'scrolls a row in by its nearest edge, and not at all when it is in view', () => {

		const height = 10 * ROW_HEIGHT;
		expect( scrollToShow( 3, 0, height ) ).toBe( 0 );
		expect( scrollToShow( 30, 0, height ) ).toBe( 31 * ROW_HEIGHT - height );
		expect( scrollToShow( 2, 5 * ROW_HEIGHT, height ) ).toBe( 2 * ROW_HEIGHT );

	} );

	it( 'finds the groups above a node, root first', () => {

		expect( ancestorsOf( tree, 'a2x' ) ).toEqual( [ 'scene', 'a', 'a2' ] );
		expect( ancestorsOf( tree, 'scene' ) ).toEqual( [] );
		expect( ancestorsOf( tree, 'missing' ) ).toBe( null );

	} );

} );

describe( 'layerItem', () => {

	it( 'names each mesh\'s geometry by three\'s type, which a minified build keeps', () => {

		const group = new Group();
		group.add( new Mesh( new BoxGeometry() ), new Mesh( new SphereGeometry() ), new Mesh( new BufferGeometry() ) );
		const item = layerItem( group );

		expect( item.geometry ).toBe( '' );
		expect( item.children.map( c => c.geometry ) ).toEqual( [ 'BoxGeometry', 'SphereGeometry', 'BufferGeometry' ] );

	} );

	it( 'takes the engine\'s name, the object\'s, or its type and id', () => {

		const named = new Group();
		named.name = 'Chair';
		named.userData.__rayzeeName = 'Chair (2)';
		const plain = new Group();
		plain.name = 'Table';
		const blank = new Group();

		expect( layerItem( named ).name ).toBe( 'Chair (2)' );
		expect( layerItem( plain ).name ).toBe( 'Table' );
		expect( layerItem( blank ).name ).toBe( `Group ${blank.id}` );

	} );

	it( 'marks only loaded models removable', () => {

		const model = new Group();
		model.userData.__rayzeeSceneObject = true;
		expect( layerItem( model ).removable ).toBe( true );
		expect( layerItem( new Group() ).removable ).toBe( false );

	} );

} );

describe( 'meshShape', () => {

	it( 'gives each primitive its own icon, anything else the mesh icon', () => {

		const shapes = [ new BoxGeometry(), new SphereGeometry(), new CylinderGeometry(), new ConeGeometry(), new BufferGeometry() ]
			.map( g => meshShape( layerItem( new Mesh( g ) ) ) );
		expect( shapes ).toEqual( [ 'box', 'sphere', 'cylinder', 'cone', 'mesh' ] );

	} );

} );
