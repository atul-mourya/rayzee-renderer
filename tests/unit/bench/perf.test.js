import { describe, it, expect } from 'vitest';
import { runPerfInterleaved } from '../../../bench/runner/perf.js';

function fakeBench( label, calls ) {

	return {
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

} );
