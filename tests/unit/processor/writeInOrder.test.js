import { describe, it, expect } from 'vitest';
import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';
import { SceneProcessor } from '@/core/Processor/SceneProcessor.js';

const FPT = 20;

describe( 'SceneProcessor._writeInOrder', () => {

	it( 'writes a large-mesh BLAS order back into the store across chunk boundaries', () => {

		// Three records a chunk; the mesh starts mid-chunk and spans three of them.
		const store = new ChunkedRecords( 12, FPT, Uint32Array, FPT * 4 * 3 );
		for ( let i = 0; i < 12; i ++ ) store.chunkFor( i ).fill( 1000 + i, store.baseOf( i ), store.baseOf( i ) + FPT );

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
			expect( rec.every( v => v === rec[ 0 ] ) ).toBe( true );

		}

	} );

} );
