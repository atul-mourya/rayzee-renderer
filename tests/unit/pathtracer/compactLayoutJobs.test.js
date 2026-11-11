import { describe, it, expect, vi, afterEach } from 'vitest';
import { mapJobs } from '@/core/pathtracer/CompactLayout.js';

const OOM = () => new RangeError( 'Array buffer allocation failed' );

/** A pool of `size` lanes whose run() throws `failures[ id ]` times before it succeeds; it tracks how many run at once. */
function pool( size, failures = {}, error = OOM ) {

	const left = { ...failures };
	const seen = { inFlight: 0, most: 0, after: [] };
	return {
		size, seen,
		run: async ( job ) => {

			seen.inFlight ++;
			seen.most = Math.max( seen.most, seen.inFlight );
			await new Promise( ( resolve ) => setTimeout( resolve, 1 ) );
			seen.inFlight --;
			if ( left[ job.id ] > 0 ) {

				left[ job.id ] --;
				seen.failedOnce = true;
				throw error();

			}

			if ( seen.failedOnce ) seen.after.push( seen.inFlight + 1 );
			return { id: job.id };

		},
	};

}

const jobs = ( n ) => Array.from( { length: n }, ( _, id ) => ( { id } ) );

describe( 'compact layout jobs', () => {

	afterEach( () => vi.restoreAllMocks() );

	it( 'runs a job out of memory again, with fewer at once, and hands every result over once', async () => {

		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const p = pool( 4, { 3: 2, 7: 1 } );
		const done = [];
		await mapJobs( p, jobs( 20 ), ( r ) => void done.push( r.id ) );
		expect( done.sort( ( a, b ) => a - b ) ).toEqual( jobs( 20 ).map( ( j ) => j.id ) );
		expect( p.seen.most ).toBe( 4 );
		expect( Math.max( ...p.seen.after ) ).toBeLessThan( 4 );

	} );

	it( 'retries the last lane alone, and fails past three tries or on any other error', async () => {

		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const done = [];
		await mapJobs( pool( 1, { 0: 3 } ), jobs( 2 ), ( r ) => void done.push( r.id ) );
		expect( done ).toEqual( [ 0, 1 ] );

		await expect( mapJobs( pool( 2, { 1: 4 } ), jobs( 3 ), () => {} ) ).rejects.toThrow( /allocation failed/ );
		await expect( mapJobs( pool( 2, { 1: 1 }, () => new Error( 'bad record' ) ), jobs( 3 ), () => {} ) ).rejects.toThrow( /bad record/ );

	} );

} );
