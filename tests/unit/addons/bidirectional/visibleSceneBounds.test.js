import { describe, it, expect, vi } from 'vitest';
import { BidirectionalIntegrator } from '@/core/addons/bidirectional/BidirectionalIntegrator.js';
import { BVH_LEAF_MARKERS, CLUSTER_COUNT_SHIFT, CLUSTER_COPY_HIDDEN } from '@/core/scene/BufferLayout.js';

// The visible scene's box, read from the TLAS as the GPU has it — called on a fake integrator over a flat tree.
function bounds( nodes, pt = { _bvhRecords: null, bvhStorageAttr: { array: nodes } } ) {

	const self = { pt, _u32Views: new WeakMap() };
	return BidirectionalIntegrator.prototype._visibleSceneBounds.call( self );

}

// Root with two leaves, boxes (-1,-2,-3)–(1,2,3) and (5,5,5)–(9,9,9).
function twoLeaves( left, right ) {

	const nodes = new Float32Array( 48 );
	const u = new Uint32Array( nodes.buffer );
	nodes.set( [ - 1, - 2, - 3 ], 0 ); u[ 3 ] = 1; nodes.set( [ 1, 2, 3 ], 4 ); u[ 7 ] = 2;
	nodes.set( [ 5, 5, 5 ], 8 ); nodes.set( [ 9, 9, 9 ], 12 );
	left( nodes, u, 16 );
	right( nodes, u, 32 );
	return nodes;

}

const blasLeaf = ( visible ) => ( nodes, u, o ) => {

	u[ o + 3 ] = BVH_LEAF_MARKERS.BLAS_POINTER_LEAF;
	nodes[ o + 2 ] = visible ? 1 : 0;

};

const cluster = ( ...hidden ) => ( nodes, u, o ) => {

	u[ o + 3 ] = BVH_LEAF_MARKERS.CLUSTER_LEAF;
	u[ o ] = 40 | ( hidden.length - 1 ) << CLUSTER_COUNT_SHIFT;
	hidden.forEach( ( h, k ) => void ( u[ o + 12 + k ] = ( 7 + k ) | ( h ? CLUSTER_COPY_HIDDEN : 0 ) ) );

};

describe( 'the visible scene bounds', () => {

	it( 'gives up on a tree whose root points at itself instead of searching forever', () => {

		expect( bounds( new Float32Array( 16 ) ) ).toBeNull();

	} );

	it( 'finds nothing in an empty scene\'s tree', () => {

		const empty = new Float32Array( 16 );
		new Uint32Array( empty.buffer )[ 3 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
		expect( bounds( empty ) ).toBeNull();

	} );

	it( 'reads the box of the visible placements', () => {

		expect( bounds( twoLeaves( blasLeaf( true ), blasLeaf( false ) ) ) ).toEqual( { min: [ - 1, - 2, - 3 ], max: [ 1, 2, 3 ] } );

	} );

	it( 'counts a copy cluster while any of its copies shows', () => {

		expect( bounds( twoLeaves( cluster( true, true ), cluster( true, false ) ) ) ).toEqual( { min: [ 5, 5, 5 ], max: [ 9, 9, 9 ] } );
		expect( bounds( twoLeaves( cluster( true, true ), cluster( true ) ) ) ).toBeNull();

	} );

	it( 'gives up on a child past the end of the tree', () => {

		const nodes = twoLeaves( blasLeaf( true ), blasLeaf( true ) );
		new Uint32Array( nodes.buffer )[ 7 ] = 9;
		expect( bounds( nodes ) ).toBeNull();
		expect( bounds( new Float32Array( 8 ) ) ).toBeNull();

	} );

	it( 'reads a TLAS held in record chunks', () => {

		const nodes = twoLeaves( blasLeaf( false ), blasLeaf( true ) );
		const chunks = [ nodes.slice( 0, 32 ), nodes.slice( 32 ) ];
		const records = {
			recordCount: 3,
			isResident: () => true,
			chunkFor: ( i ) => chunks[ i < 2 ? 0 : 1 ],
			baseOf: ( i ) => ( i < 2 ? i : i - 2 ) * 16,
		};

		expect( bounds( null, { _bvhRecords: records, _instanceTable: { blasBase: 3 } } ) ).toEqual( { min: [ 5, 5, 5 ], max: [ 9, 9, 9 ] } );

	} );

	it( 'asks for a spilled TLAS back and has no box until it is', () => {

		const isResident = vi.fn( () => false );
		const pt = { _bvhRecords: { isResident }, _instanceTable: { blasBase: 12 }, _whenTLASResident: vi.fn() };

		expect( bounds( null, pt ) ).toBeNull();
		expect( isResident ).toHaveBeenCalledWith( 0, 12 );
		expect( pt._whenTLASResident ).toHaveBeenCalledOnce();

	} );

} );
