import { describe, it, expect } from 'vitest';
import { BidirectionalIntegrator } from '@/core/integrators/BidirectionalIntegrator.js';
import { BVH_LEAF_MARKERS } from '@/core/EngineDefaults.js';

// The visible scene's box, read from the TLAS as the GPU has it — called on a fake integrator over a flat tree.
function bounds( nodes ) {

	const self = { pt: { _bvhRecords: null, bvhStorageAttr: { array: nodes } }, _u32Views: new WeakMap() };
	return BidirectionalIntegrator.prototype._visibleSceneBounds.call( self );

}

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

		// Root with two BLAS-pointer leaves; only the first is visible (slot [2]).
		const nodes = new Float32Array( 48 );
		const u = new Uint32Array( nodes.buffer );
		nodes.set( [ - 1, - 2, - 3 ], 0 ); u[ 3 ] = 1; nodes.set( [ 1, 2, 3 ], 4 ); u[ 7 ] = 2;
		nodes.set( [ 5, 5, 5 ], 8 ); nodes.set( [ 9, 9, 9 ], 12 );
		u[ 16 + 3 ] = BVH_LEAF_MARKERS.BLAS_POINTER_LEAF; nodes[ 16 + 2 ] = 1;
		u[ 32 + 3 ] = BVH_LEAF_MARKERS.BLAS_POINTER_LEAF; nodes[ 32 + 2 ] = 0;
		expect( bounds( nodes ) ).toEqual( { min: [ - 1, - 2, - 3 ], max: [ 1, 2, 3 ] } );

	} );

} );
