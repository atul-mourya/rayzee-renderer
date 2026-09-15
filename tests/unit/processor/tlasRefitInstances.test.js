import { describe, it, expect } from 'vitest';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { TLASBuilder } from '@/core/Processor/TLASBuilder.js';
import { BVH_LEAF_MARKERS, bvhIndexView } from '@/core/EngineDefaults.js';

const translation = ( x ) => [ 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1 ];

/**
 * Several placements of one unit-box geometry, spread along x. They share a template, so they
 * share a BLAS offset — which is what the refit used to key its bounds lookup on.
 */
function sharedTemplateScene( positions ) {

	const n = positions.length;
	const table = new InstanceTable();
	// One template per object, as the extractor emits: the copies alias the first one's BLAS,
	// so they end up sharing its offset while keeping their own transforms.
	table.allocate( n, n );

	table.setEntry( {
		meshIndex: 0, blasNodeCount: 1, triOffset: 0, triCount: 1,
		originalToBvhMap: null, bvhData: null,
		matrixWorld: translation( positions[ 0 ] ), sourceMesh: 0,
	} );

	for ( let i = 1; i < n; i ++ ) {

		table.setAlias( i, 0, translation( positions[ i ] ), null, i );

	}

	for ( let t = 0; t < n; t ++ ) table.tplObjectAABB.set( [ - 1, - 1, - 1, 1, 1, 1 ], t * 6 );

	// Leaf payloads are written during the build, so the offsets have to be final first.
	table.assignOffsets( TLASBuilder.nodeCountFor( n ) );

	const built = new TLASBuilder().build( table );

	const sp = new SceneProcessor();
	sp.instanceTable = table;
	sp._setBVHData( built.data.slice( 0, built.nodeCount * 16 ) );
	return sp;

}

/** Every BLAS-pointer leaf as { placement, min, max } on the x axis. */
function leafBoxes( sp ) {

	const data = sp.bvhData;
	const idx = bvhIndexView( data );
	const out = [];

	for ( let node = 0; node < sp.instanceTable.tlasNodeCount; node ++ ) {

		const o = node * 16;
		if ( idx[ o + 3 ] !== BVH_LEAF_MARKERS.BLAS_POINTER_LEAF ) continue;
		// A leaf's own box lives in its parent, so read it back off the table the refit wrote.
		const b = sp._tlasBounds;
		out.push( { placement: idx[ o + 1 ], min: b[ node * 6 ], max: b[ node * 6 + 3 ] } );

	}

	return out.sort( ( a, b ) => a.placement - b.placement );

}

describe( 'TLAS refit with shared BLASes', () => {

	it( 'gives each placement of a shared geometry its own world box', () => {

		const sp = sharedTemplateScene( [ 0, 100, - 40 ] );
		sp._refitTLAS();

		expect( leafBoxes( sp ) ).toEqual( [
			{ placement: 0, min: - 1, max: 1 },
			{ placement: 1, min: 99, max: 101 },
			{ placement: 2, min: - 41, max: - 39 },
		] );

	} );

	it( 'keeps the root box around every placement, not just the last one', () => {

		const sp = sharedTemplateScene( [ 0, 100, - 40 ] );
		sp._refitTLAS();

		const data = sp.bvhData;
		// Node 0 holds its two children's boxes; the scene box is the union of both halves.
		const min = Math.min( data[ 0 ], data[ 8 ] );
		const max = Math.max( data[ 4 ], data[ 12 ] );

		expect( min ).toBe( - 41 );
		expect( max ).toBe( 101 );

	} );

	it( 'still places a single unshared mesh correctly', () => {

		const sp = sharedTemplateScene( [ 7 ] );
		sp._refitTLAS();

		expect( leafBoxes( sp ) ).toEqual( [ { placement: 0, min: 6, max: 8 } ] );

	} );

} );
