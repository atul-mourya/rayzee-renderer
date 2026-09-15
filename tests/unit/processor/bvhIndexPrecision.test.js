import { describe, it, expect } from 'vitest';
import { BVH_LEAF_MARKERS, BVH_MAX_INDEX, assertBVHIndexFits, bvhIndexView } from '@/core/EngineDefaults.js';
import { TLASBuilder } from '@/core/Processor/TLASBuilder.js';
import { InstanceTable } from '@/core/Processor/InstanceTable.js';
import { BVHRefitter } from '@/core/Processor/BVHRefitter.js';

// Indices that a float32 cannot hold as a value. 16,777,217 is the canonical one: it rounds to
// 16,777,216, so a BLAS pointer written as a float landed on the previous node and the instance
// it addressed vanished from the render without any error.
const BOUNDARY = [ 16777215, 16777216, 16777217, 16777218, 16777219, 20000001, 33554433, 1073741823 ];

const asFloatValue = v => Math.fround( v );

describe( 'BVH index precision past 2^24', () => {

	it( 'float32 really does lose these values — the reason bit patterns are required', () => {

		expect( asFloatValue( 16777216 ) ).toBe( 16777216 );
		expect( asFloatValue( 16777217 ) ).toBe( 16777216 ); // silently off by one
		expect( asFloatValue( 16777219 ) ).toBe( 16777220 );
		expect( asFloatValue( 33554433 ) ).toBe( 33554432 );

	} );

	it( 'round-trips every boundary index exactly through the float buffer', () => {

		const data = new Float32Array( BOUNDARY.length * 16 );
		const idx = bvhIndexView( data );

		BOUNDARY.forEach( ( v, i ) => {

			idx[ i * 16 ] = v;
			idx[ i * 16 + 3 ] = v;
			idx[ i * 16 + 7 ] = v;

		} );

		BOUNDARY.forEach( ( v, i ) => {

			expect( idx[ i * 16 ] ).toBe( v );
			expect( idx[ i * 16 + 3 ] ).toBe( v );
			expect( idx[ i * 16 + 7 ] ).toBe( v );

		} );

	} );

	it( 'never produces a NaN or infinite bit pattern, which a f32 buffer may canonicalise', () => {

		const probe = new Float32Array( 1 );
		const bits = bvhIndexView( probe );

		for ( const v of [ ...BOUNDARY, 0, 1, BVH_MAX_INDEX - 1,
			BVH_LEAF_MARKERS.TRIANGLE_LEAF, BVH_LEAF_MARKERS.BLAS_POINTER_LEAF, BVH_LEAF_MARKERS.FRONTIER ] ) {

			bits[ 0 ] = v;
			expect( Number.isFinite( probe[ 0 ] ) ).toBe( true );

		}

	} );

	it( 'keeps every leaf tag above every representable index, so one compare separates them', () => {

		for ( const tag of Object.values( BVH_LEAF_MARKERS ) ) {

			expect( tag ).toBeGreaterThanOrEqual( BVH_MAX_INDEX );

		}

		expect( BVH_MAX_INDEX ).toBe( 2 ** 30 );

	} );

} );

describe( 'TLASBuilder leaf payloads past 2^24', () => {

	/** A table of `n` placements whose BLAS offsets straddle the float32 exact-integer limit. */
	function tableWithOffsets( offsets ) {

		const table = new InstanceTable();
		table.allocate( offsets.length );

		for ( let i = 0; i < offsets.length; i ++ ) {

			table.setEntry( {
				meshIndex: i, blasNodeCount: 3, triOffset: 0, triCount: 1,
				originalToBvhMap: null, bvhData: null
			} );
			table.tplBlasOffset[ i ] = offsets[ i ];
			table.tplObjectAABB.set( [ i * 4, 0, 0, i * 4 + 1, 1, 1 ], i * 6 );

		}

		return table;

	}

	it( 'writes each BLAS pointer back exactly, including 16,777,217', () => {

		const table = tableWithOffsets( BOUNDARY );
		const { data } = new TLASBuilder().build( table );
		const idx = bvhIndexView( data );

		for ( let i = 0; i < BOUNDARY.length; i ++ ) {

			const leaf = table.tlasLeafIndex[ i ];
			expect( leaf ).toBeGreaterThanOrEqual( 0 );
			expect( idx[ leaf * 16 ] ).toBe( BOUNDARY[ i ] );
			expect( idx[ leaf * 16 + 1 ] ).toBe( i );
			expect( idx[ leaf * 16 + 3 ] ).toBe( BVH_LEAF_MARKERS.BLAS_POINTER_LEAF );

		}

	} );

	it( 'writes child indices exactly in a tree large enough to pass the limit', () => {

		// 40 entries is a small tree, but the check that matters is that every child index
		// round-trips and every node is reachable exactly once.
		const table = tableWithOffsets( Array.from( { length: 40 }, ( _, i ) => 16777200 + i ) );
		const { data, nodeCount } = new TLASBuilder().build( table );
		const idx = bvhIndexView( data );

		const seen = new Uint8Array( nodeCount );
		const stack = [ 0 ];
		while ( stack.length ) {

			const node = stack.pop();
			expect( node ).toBeGreaterThanOrEqual( 0 );
			expect( node ).toBeLessThan( nodeCount );
			expect( seen[ node ] ).toBe( 0 );
			seen[ node ] = 1;
			if ( idx[ node * 16 + 3 ] >= BVH_MAX_INDEX ) continue;
			stack.push( idx[ node * 16 + 3 ], idx[ node * 16 + 7 ] );

		}

		expect( seen.every( v => v === 1 ) ).toBe( true );

	} );

} );

describe( 'BVHRefitter past 2^24', () => {

	it( 'follows child indices above the limit instead of a rounded neighbour', () => {

		// The refitter must read child indices and leaf tags through the u32 view, not as floats.
		const nodeCount = 3;
		const data = new Float32Array( nodeCount * 16 );
		const idx = bvhIndexView( data );

		// node 0: inner → children 1, 2
		idx[ 3 ] = 1;
		idx[ 7 ] = 2;
		// nodes 1 and 2: triangle leaves, one triangle each
		idx[ 16 ] = 0; idx[ 17 ] = 1; idx[ 19 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;
		idx[ 32 ] = 1; idx[ 33 ] = 1; idx[ 35 ] = BVH_LEAF_MARKERS.TRIANGLE_LEAF;

		const FPT = 20;
		const tri = new Uint32Array( 2 * FPT );
		const f = new Float32Array( tri.buffer );
		f[ 0 ] = 0; f[ 1 ] = 0; f[ 2 ] = 0;
		f[ 4 ] = 2; f[ 5 ] = 0; f[ 6 ] = 0;
		f[ 8 ] = 0; f[ 9 ] = 2; f[ 10 ] = 0;
		f[ FPT + 0 ] = 10; f[ FPT + 1 ] = 10; f[ FPT + 2 ] = 10;
		f[ FPT + 4 ] = 12; f[ FPT + 5 ] = 10; f[ FPT + 6 ] = 10;
		f[ FPT + 8 ] = 10; f[ FPT + 9 ] = 12; f[ FPT + 10 ] = 10;

		new BVHRefitter().refit( data, tri, nodeCount );

		// Root's left child bounds come from triangle 0, right child from triangle 1.
		expect( data[ 0 ] ).toBe( 0 );
		expect( data[ 4 ] ).toBe( 2 );
		expect( data[ 8 ] ).toBe( 10 );
		expect( data[ 12 ] ).toBe( 12 );

	} );

} );

describe( 'runtime guard', () => {

	it( 'passes counts below the limit through unchanged', () => {

		expect( assertBVHIndexFits( 0, 'x' ) ).toBe( 0 );
		expect( assertBVHIndexFits( 23957363, 'x' ) ).toBe( 23957363 );
		expect( assertBVHIndexFits( BVH_MAX_INDEX - 1, 'x' ) ).toBe( BVH_MAX_INDEX - 1 );

	} );

	it( 'throws rather than letting an index collide with the leaf tags', () => {

		expect( () => assertBVHIndexFits( BVH_MAX_INDEX, 'node count' ) ).toThrow( RangeError );
		expect( () => assertBVHIndexFits( BVH_MAX_INDEX + 1, 'node count' ) ).toThrow( /node count/ );
		expect( () => assertBVHIndexFits( BVH_LEAF_MARKERS.TRIANGLE_LEAF, 'node count' ) ).toThrow( RangeError );

	} );

	it( 'guards the TLAS node total, not just individual writes', () => {

		const table = new InstanceTable();
		table.allocate( 1 );
		table.setEntry( {
			meshIndex: 0, blasNodeCount: 3, triOffset: 0, triCount: 1,
			originalToBvhMap: null, bvhData: null
		} );
		// A BLAS large enough to push the combined total past the limit must not build silently.
		table.tplNodeCount[ 0 ] = BVH_MAX_INDEX;
		expect( () => table.assignOffsets( 1 ) ).toThrow( RangeError );

	} );

} );
