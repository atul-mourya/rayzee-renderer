import { describe, it, expect } from 'vitest';
import { changedKeys, readTrend, runPerfInterleaved } from '../../../bench/runner/perf.js';

function fakeBench( label, calls, workload ) {

	return {
		...( workload !== undefined && { workload: async () => workload } ),
		scenes: async () => [ { id: 'scene' } ],
		setPerfMode: async () => {},
		bringToFront: async () => calls.push( `${label}:front` ),
		loadScene: async () => ( { loadMs: 0 } ),
		isDeterministic: async () => false,
		render: async () => {},
		measureGPUPerSample: async () => {

			calls.push( `${label}:measure` );
			return Array.from( { length: 10 }, () => 1 );

		},
	};

}

describe( 'runPerfInterleaved', () => {

	it( 'brings each side\'s tab to the front before measuring it', async () => {

		const calls = [];
		await runPerfInterleaved( fakeBench( 'base', calls ), fakeBench( 'head', calls ) );

		const measured = calls.flatMap( ( call, i ) => ( call.endsWith( ':measure' ) ? [ i ] : [] ) );

		expect( measured.length ).toBeGreaterThan( 0 );
		for ( const i of measured ) {

			const side = calls[ i ].split( ':' )[ 0 ];
			const lastFront = calls.slice( 0, i ).reverse().find( ( call ) => call.endsWith( ':front' ) );
			expect( lastFront ).toBe( `${side}:front` );

		}

	} );

	it( 'says which parts of a scene differ between the two sides, or nothing when one cannot tell', async () => {

		const work = { triangles: 10, sun: false, settings: { a: 1, b: 2 } };
		const changed = await runPerfInterleaved(
			fakeBench( 'base', [], work ), fakeBench( 'head', [], { ...work, sun: true, settings: { b: 2, a: 1 } } )
		);
		expect( changed.measurements[ 0 ].workloadChanges ).toEqual( [ 'sun' ] );

		const unknown = await runPerfInterleaved( fakeBench( 'base', [], null ), fakeBench( 'head', [], work ) );
		expect( unknown.measurements[ 0 ].workloadChanges ).toBeNull();

	} );

} );

describe( 'trend logs', () => {

	it( 'compares values, not key order', () => {

		expect( changedKeys( { a: { x: 1, y: [ 1, 2 ] } }, { a: { y: [ 1, 2 ], x: 1 } } ) ).toEqual( [] );
		expect( changedKeys( { a: 1 }, { a: 1, b: 2 } ) ).toEqual( [ 'b' ] );
		expect( changedKeys( null, { a: 1 } ) ).toBeNull();

	} );

	it( 'reads a missing log as empty', async () => {

		expect( await readTrend( '/nonexistent/perf.jsonl' ) ).toEqual( [] );

	} );

} );
