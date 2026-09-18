import { describe, it, expect, vi } from 'vitest';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { TLASBuilder } from '@/core/Processor/TLASBuilder.js';
import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';
import { TRIANGLE_DATA_LAYOUT, BVH_LEAF_MARKERS, bvhIndexView } from '@/core/EngineDefaults.js';

const FPT = TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE;
const IDENTITY = [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 ];

/** One mesh whose BLAS was built with RESERVED nodes over `triCount` triangles. */
function sceneWithBlas( { triCount = 4, reserved = 7 } = {} ) {

	const table = new InstanceTable();
	table.allocate( 1, 1 );
	table.setEntry( {
		meshIndex: 0, blasNodeCount: reserved, triOffset: 0, triCount,
		originalToBvhMap: null, bvhData: null, matrixWorld: IDENTITY, sourceMesh: 0,
	} );
	table.tplObjectAABB.set( [ 0, 0, 0, 1, 1, 1 ], 0 );
	table.bvhToOriginal.set( 0, Uint32Array.from( { length: triCount }, ( _, i ) => i ) );
	table.assignOffsets( TLASBuilder.nodeCountFor( 1 ) );

	const tlas = new TLASBuilder().build( table );

	const sp = new SceneProcessor();
	sp.instanceTable = table;

	const nodes = new Float32Array( ( table.tlasNodeCount + reserved ) * 16 );
	nodes.set( tlas.data.subarray( 0, table.tlasNodeCount * 16 ), 0 );
	// A BLAS root that is a plain triangle leaf keeps the fixture honest without a real build.
	const idx = bvhIndexView( nodes );
	const root = table.tplBlasOffset[ 0 ] * 16;
	idx[ root ] = 0; idx[ root + 1 ] = triCount; idx[ root + 3 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
	sp._setBVHData( nodes );
	sp._setTriangleData( new ChunkedRecords( triCount, FPT, Uint32Array ) );

	return sp;

}

/** What the rebuild worker hands back. */
function workerResult( nodeCount, triCount, order ) {

	return {
		bvhData: new Float32Array( nodeCount * 16 ),
		triangles: new Uint32Array( triCount * FPT ),
		originalToBvh: Uint32Array.from( order ),
	};

}

describe( 'background BLAS rebuild swap', () => {

	it( 'accepts a rebuild that is smaller than the range reserved for it', () => {

		const sp = sceneWithBlas( { triCount: 4, reserved: 7 } );
		const entry = sp.instanceTable.entryAt( 0 );
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

		sp._swapBLAS( 0, entry, workerResult( 5, 4, [ 0, 1, 2, 3 ] ), null );

		// The live tree is what the rebuild produced; the spare nodes are dead, not walked.
		expect( sp.instanceTable.blasNodeCountOf( 0 ) ).toBe( 5 );
		warn.mockRestore();

	} );

	it( 'refuses a rebuild that would overrun into the next BLAS', () => {

		const sp = sceneWithBlas( { triCount: 4, reserved: 7 } );
		const entry = sp.instanceTable.entryAt( 0 );
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

		sp._swapBLAS( 0, entry, workerResult( 9, 4, [ 0, 1, 2, 3 ] ), null );

		expect( sp.instanceTable.blasNodeCountOf( 0 ) ).toBe( 7 );
		warn.mockRestore();

	} );

	it( 'stores the rebuilt triangle order on the table, not on a throwaway snapshot', () => {

		const sp = sceneWithBlas( { triCount: 4, reserved: 7 } );
		const entry = sp.instanceTable.entryAt( 0 );
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

		// The rebuild reversed the triangles: stored slot i moves to slot 3-i.
		sp._swapBLAS( 0, entry, workerResult( 5, 4, [ 3, 2, 1, 0 ] ), null );

		// A later refit reads this to scatter each position into the right slot. Left stale, it
		// writes every triangle to the wrong place and the mesh shreds.
		expect( Array.from( sp.instanceTable.bvhToOriginalOf( 0 ) ) ).toEqual( [ 3, 2, 1, 0 ] );
		warn.mockRestore();

	} );

	it( 'composes the rebuild onto the order the first build already produced', () => {

		const sp = sceneWithBlas( { triCount: 4, reserved: 7 } );
		// The original build put caller triangle 2 in slot 0, 0 in slot 1, and so on.
		sp.instanceTable.setBvhToOriginal( 0, Uint32Array.from( [ 2, 0, 3, 1 ] ) );
		const entry = sp.instanceTable.entryAt( 0 );
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

		// The rebuild then reverses the slots: slot i moves to slot 3-i.
		sp._swapBLAS( 0, entry, workerResult( 5, 4, [ 3, 2, 1, 0 ] ), null );

		// Slot 0 now holds what was slot 3, which held caller triangle 1 — and so on backwards.
		// Writing the rebuild's own permutation instead would give [ 3, 2, 1, 0 ] and lose the
		// first build's shuffle entirely.
		expect( Array.from( sp.instanceTable.bvhToOriginalOf( 0 ) ) ).toEqual( [ 1, 3, 0, 2 ] );
		warn.mockRestore();

	} );

	it( 'tells the caller which mesh was swapped, so only its ranges are re-uploaded', () => {

		const sp = sceneWithBlas( { triCount: 4, reserved: 7 } );
		const entry = sp.instanceTable.entryAt( 0 );
		const onSwap = vi.fn();
		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );

		sp._swapBLAS( 0, entry, workerResult( 5, 4, [ 0, 1, 2, 3 ] ), onSwap );

		expect( onSwap ).toHaveBeenCalledWith( 0 );
		warn.mockRestore();

	} );

} );
