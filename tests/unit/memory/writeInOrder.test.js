import { describe, it, expect } from 'vitest';
import { ChunkedRecords } from '@/core/memory/ChunkedRecords.js';
import { SceneProcessor } from '@/core/scene/SceneProcessor.js';

const FPT = 20;

describe( 'SceneProcessor._writeInOrder', () => {

	it( 'writes a large-mesh BLAS order back into the store across chunk boundaries', () => {

		// Three records a chunk; the mesh starts mid-chunk and spans three of them.
		const store = new ChunkedRecords( 12, FPT, Uint32Array, FPT * 4 * 3 );
		// Each lane its own value: 1000 + record, plus 100 000 × lane.
		for ( let i = 0; i < 12; i ++ ) for ( let l = 0; l < FPT; l ++ ) store.chunkFor( i )[ store.baseOf( i ) + l ] = 1000 + i + 100000 * l;

		const start = 2, count = 7;
		const src = store.copyOf( start, count );
		const order = Uint32Array.from( [ 6, 0, 5, 1, 4, 2, 3 ] );
		SceneProcessor.prototype._writeInOrder.call( { triangles: store }, start, src, order );

		const lane0 = i => store.chunkFor( i )[ store.baseOf( i ) ];
		expect( Array.from( { length: 12 }, ( _, i ) => lane0( i ) ) ).toEqual( [
			1000, 1001,
			1000 + start + 6, 1000 + start + 0, 1000 + start + 5, 1000 + start + 1, 1000 + start + 4, 1000 + start + 2, 1000 + start + 3,
			1009, 1010, 1011,
		] );
		for ( let i = start; i < start + count; i ++ ) {

			const rec = store.chunkFor( i ).subarray( store.baseOf( i ), store.baseOf( i ) + FPT );
			expect( Array.from( rec ) ).toEqual( Array.from( { length: FPT }, ( _, l ) => rec[ 0 ] + 100000 * l ) );

		}

	} );

	it( 'copies records of any other width lane by lane', () => {

		const lanes = 7, store = new ChunkedRecords( 9, lanes, Float32Array, lanes * 4 * 4 );
		for ( let i = 0; i < 9; i ++ ) for ( let l = 0; l < lanes; l ++ ) store.chunkFor( i )[ store.baseOf( i ) + l ] = i + l / 10;
		const src = store.copyOf( 1, 6 ), order = Uint32Array.from( [ 5, 3, 1, 0, 2, 4 ] );
		SceneProcessor.prototype._writeInOrder.call( { triangles: store }, 1, src, order );
		for ( let j = 0; j < 6; j ++ ) {

			const rec = Array.from( store.chunkFor( 1 + j ).subarray( store.baseOf( 1 + j ), store.baseOf( 1 + j ) + lanes ) );
			expect( rec ).toEqual( Array.from( { length: lanes }, ( _, l ) => Math.fround( 1 + order[ j ] + l / 10 ) ) );

		}

	} );

} );

describe( 'SceneProcessor._permuteRange', () => {

	// Records of `lanes` lanes, each lane its own value: 1000 + record, plus 100 000 × lane.
	const filled = ( count, lanes, perChunk ) => {

		const store = new ChunkedRecords( count, lanes, Uint32Array, lanes * 4 * perChunk );
		for ( let i = 0; i < count; i ++ ) for ( let l = 0; l < lanes; l ++ ) store.chunkFor( i )[ store.baseOf( i ) + l ] = 1000 + i + 100000 * l;
		return store;

	};

	const record = ( store, i ) => Array.from( store.chunkFor( i ).subarray( store.baseOf( i ), store.baseOf( i ) + store.lanesPerRecord ) );

	it( 'puts a cached BLAS\'s records in built order, every lane, across chunks, 20 lanes or any other width', () => {

		for ( const lanes of [ FPT, 7 ] ) {

			const store = filled( 14, lanes, 4 );
			const start = 3, order = Uint32Array.from( [ 6, 0, 8, 1, 7, 2, 5, 3, 4 ] );
			SceneProcessor.prototype._permuteRange.call( { triangles: store }, start, order.length, order );
			for ( let i = 0; i < 14; i ++ ) {

				const from = i >= start && i < start + order.length ? start + order[ i - start ] : i;
				expect( record( store, i ), `${lanes} lanes, record ${i}` ).toEqual( Array.from( { length: lanes }, ( _, l ) => 1000 + from + 100000 * l ) );

			}

		}

	} );

	it( 'leaves a range in order untouched', () => {

		const store = filled( 6, FPT, 4 ), before = Array.from( { length: 6 }, ( _, i ) => record( store, i ) );
		SceneProcessor.prototype._permuteRange.call( { triangles: store }, 1, 4, Uint32Array.from( [ 0, 1, 2, 3 ] ) );
		expect( Array.from( { length: 6 }, ( _, i ) => record( store, i ) ) ).toEqual( before );

	} );

} );
