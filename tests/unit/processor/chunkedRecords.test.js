import { describe, it, expect } from 'vitest';
import { ChunkedRecords } from '@/core/Processor/ChunkedRecords.js';

// 4 lanes per record, 16 bytes, so 64 bytes per chunk = 4 records per chunk.
const LANES = 4;
const CHUNK_BYTES = 64;

function filled( recordCount, chunkBytes = CHUNK_BYTES ) {

	const c = new ChunkedRecords( recordCount, LANES, Uint32Array, chunkBytes );
	for ( let r = 0; r < recordCount; r ++ ) {

		const chunk = c.chunkFor( r ), base = c.baseOf( r );
		for ( let k = 0; k < LANES; k ++ ) chunk[ base + k ] = r * 100 + k;

	}

	return c;

}

describe( 'ChunkedRecords', () => {

	it( 'stays a single array when it fits', () => {

		const c = new ChunkedRecords( 3, LANES, Uint32Array, CHUNK_BYTES );
		expect( c.chunkCount ).toBe( 1 );
		expect( c.single ).toBeInstanceOf( Uint32Array );
		expect( c.single ).toHaveLength( 3 * LANES );

	} );

	it( 'splits on a record boundary, never mid-record', () => {

		const c = new ChunkedRecords( 10, LANES, Uint32Array, CHUNK_BYTES );
		expect( c.chunkCount ).toBe( 3 );
		expect( c.recordsPerChunk ).toBe( 4 );
		expect( c.chunks.map( x => x.length / LANES ) ).toEqual( [ 4, 4, 2 ] );
		expect( c.single ).toBeNull();

	} );

	it( 'addresses every record correctly across chunks', () => {

		const c = filled( 10 );
		for ( let r = 0; r < 10; r ++ ) {

			const chunk = c.chunkFor( r ), base = c.baseOf( r );
			expect( chunk[ base ] ).toBe( r * 100 );
			expect( chunk[ base + 3 ] ).toBe( r * 100 + 3 );

		}

	} );

	it( 'reports the same total byte length as one flat array would', () => {

		expect( new ChunkedRecords( 10, LANES, Uint32Array, CHUNK_BYTES ).byteLength )
			.toBe( 10 * LANES * 4 );

	} );

	it( 'returns a view for a range inside one chunk and a copy across chunks', () => {

		const c = filled( 10 );

		const inside = c.slice( 0, 4 );
		expect( inside.buffer ).toBe( c.chunks[ 0 ].buffer ); // view, no copy

		const across = c.slice( 2, 5 ); // records 2..6 span chunk 0 and 1
		expect( across.buffer ).not.toBe( c.chunks[ 0 ].buffer );
		expect( Array.from( across ) ).toEqual(
			[ 2, 3, 4, 5, 6 ].flatMap( r => [ 0, 1, 2, 3 ].map( k => r * 100 + k ) )
		);

	} );

	it( 'writes a run of records across a chunk boundary', () => {

		const c = filled( 10 );
		const src = new Uint32Array( 5 * LANES );
		src.fill( 7 );
		c.setRecords( 3, src ); // records 3..7, straddling

		for ( let r = 3; r < 8; r ++ ) {

			const chunk = c.chunkFor( r ), base = c.baseOf( r );
			for ( let k = 0; k < LANES; k ++ ) expect( chunk[ base + k ] ).toBe( 7 );

		}

		// neighbours untouched
		expect( c.chunkFor( 2 )[ c.baseOf( 2 ) ] ).toBe( 200 );
		expect( c.chunkFor( 8 )[ c.baseOf( 8 ) ] ).toBe( 800 );

	} );

	it( 'round-trips a straddling write through readRecords', () => {

		const c = filled( 10 );
		const out = new Uint32Array( 5 * LANES );
		c.readRecords( 2, 5, out );
		expect( Array.from( out ) ).toEqual( Array.from( c.slice( 2, 5 ) ) );

	} );

	it( 'aliases the same memory under a different lane type', () => {

		const c = new ChunkedRecords( 10, LANES, Uint32Array, CHUNK_BYTES );
		const asFloat = c.viewAs( Float32Array );
		expect( asFloat.chunkCount ).toBe( c.chunkCount );

		asFloat.chunkFor( 6 )[ asFloat.baseOf( 6 ) ] = 1.5;
		// 1.5f is 0x3FC00000
		expect( c.chunkFor( 6 )[ c.baseOf( 6 ) ] ).toBe( 0x3FC00000 );

	} );

	it( 'adopts prebuilt chunks without copying', () => {

		const chunks = [ new Uint32Array( 4 * LANES ), new Uint32Array( 2 * LANES ) ];
		chunks[ 1 ][ 0 ] = 42;
		const c = ChunkedRecords.adopt( chunks, 6, LANES, 4 );
		expect( c.chunkCount ).toBe( 2 );
		expect( c.chunkFor( 4 )[ c.baseOf( 4 ) ] ).toBe( 42 );
		expect( c.chunks[ 1 ] ).toBe( chunks[ 1 ] );

	} );


	it( 'trims to the records actually filled, dropping whole unused chunks', () => {

		const c = new ChunkedRecords( 10, LANES, Uint32Array, CHUNK_BYTES ); // 3 chunks of 4,4,2
		const t = c.trimTo( 6 );

		expect( t.chunkCount ).toBe( 2 );
		expect( t.recordCount ).toBe( 6 );
		expect( t.byteLength ).toBe( 6 * LANES * 4 );
		expect( t.chunks[ 0 ] ).toBe( c.chunks[ 0 ] ); // untouched, still a view of the same memory
		expect( t.chunks[ 1 ] ).toHaveLength( 2 * LANES );

	} );

	it( 'trims to an exact chunk boundary without an empty tail', () => {

		const t = new ChunkedRecords( 10, LANES, Uint32Array, CHUNK_BYTES ).trimTo( 8 );
		expect( t.chunkCount ).toBe( 2 );
		expect( t.byteLength ).toBe( 8 * LANES * 4 );

	} );

} );
