import { describe, it, expect } from 'vitest';
import { TRIANGLE_DATA_LAYOUT } from '@/core/EngineDefaults.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';

const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
const FPN = 16;

// An instanced mesh takes one placement per copy, so from the second mesh on, a mesh index and
// a placement index are different numbers. Mesh 0 is four copies of a 12-triangle box; mesh 1
// is one 80-triangle sphere, which lands at placement 4.
const BOX_TRIS = 12, SPHERE_TRIS = 80;
const BOX_NODES = 5, SPHERE_NODES = 9;

function makeProcessor() {

	const table = new InstanceTable();
	table.allocate( 5, 2 );

	table.setEntry( {
		meshIndex: 0, blasNodeCount: BOX_NODES, triOffset: 0, triCount: BOX_TRIS,
		originalToBvhMap: null, bvhData: null, expandedStart: 0, sourceMesh: 0,
	} );
	for ( let i = 1; i < 4; i ++ ) table.setAlias( i, 0, null, 0, 0 );

	table.setEntry( {
		meshIndex: 4, blasNodeCount: SPHERE_NODES, triOffset: BOX_TRIS, triCount: SPHERE_TRIS,
		originalToBvhMap: null, bvhData: null, expandedStart: BOX_TRIS, sourceMesh: 1,
	} );

	table.tplBlasOffset[ 0 ] = 100;
	table.tplBlasOffset[ 1 ] = 100 + BOX_NODES;

	const sp = Object.create( SceneProcessor.prototype );
	sp.instanceTable = table;
	return sp;

}

describe( 'a mesh index is not a placement index', () => {

	it( 'places the second mesh past the instanced one', () => {

		const sp = makeProcessor();
		const table = sp.instanceTable;

		expect( table.count ).toBe( 5 );
		expect( Array.from( table.sourceMesh ) ).toEqual( [ 0, 0, 0, 0, 1 ] );
		expect( sp._placementOf( 0 ) ).toBe( 0 );
		expect( sp._placementOf( 1 ) ).toBe( 4 );

	} );

	it( 'asks the caller for the mesh it can look up, not the placement', () => {

		const sp = makeProcessor();
		const asked = [];
		const read = sp._meshSource( ( mesh, triCount ) => {

			asked.push( { mesh, triCount } );
			return new Float32Array( triCount * 9 );

		}, 'position' );

		// refitBVH walks placements and only visits the one that owns each geometry.
		for ( let p = 0; p < sp.instanceTable.count; p ++ ) {

			if ( sp.instanceTable.isOwner( p ) ) read( p );

		}

		// Placement 4 must come back as mesh 1 — a caller indexing its own meshes has no 4.
		expect( asked ).toEqual( [
			{ mesh: 0, triCount: BOX_TRIS },
			{ mesh: 1, triCount: SPHERE_TRIS },
		] );

	} );

	it( 'names the mesh, not the placement, when a slice is the wrong length', () => {

		const sp = makeProcessor();
		const read = sp._meshSource( () => new Float32Array( 3 ), 'position' );
		expect( () => read( 4 ) ).toThrow( /for mesh 1 / );

	} );

	it( 'uploads the range belonging to the mesh the caller named', () => {

		const sp = makeProcessor();
		const { triRanges, bvhRanges } = sp.computeBLASDirtyRanges( [ 1 ] );

		// The sphere's triangles sit after the box's; reading placement 1 would give the box's.
		expect( triRanges ).toEqual( [ { offset: BOX_TRIS * FPT, count: SPHERE_TRIS * FPT } ] );
		expect( bvhRanges[ 0 ] ).toEqual( { offset: ( 100 + BOX_NODES ) * FPN, count: SPHERE_NODES * FPN } );

	} );

	it( 'still resolves a mesh that placed nothing to no placement at all', () => {

		const sp = makeProcessor();
		expect( sp._placementOf( 7 ) ).toBe( - 1 );
		expect( sp.computeBLASDirtyRanges( [ 7 ] ).triRanges ).toEqual( [] );

	} );

} );
