import { describe, it, expect } from 'vitest';
import { comparePerf } from '../../../bench/runner/perf.js';
import { PERF } from '../../../bench/runner/config.js';

const cheap = PERF.abMinGatedMs * 0.8;
const dear = PERF.abMinGatedMs * 3;

describe( 'comparePerf', () => {

	it( 'reports a cheap scene\'s slower verdict without failing on it', () => {

		const result = comparePerf( [
			{ scene: 'cheap', baseMedians: [ cheap, cheap, cheap ], headMedians: [ cheap * 1.2, cheap * 1.2, cheap * 1.2 ] },
			{ scene: 'dear', baseMedians: [ dear, dear, dear ], headMedians: [ dear, dear, dear ] },
		] );

		expect( result.comparisons[ 0 ] ).toMatchObject( { verdict: 'slower', gated: false } );
		expect( result.regressions ).toHaveLength( 0 );
		expect( result.passed ).toBe( true );

	} );

	it( 'fails on a slower scene at or above the cost line', () => {

		const result = comparePerf( [
			{ scene: 'dear', baseMedians: [ dear, dear, dear ], headMedians: [ dear * 1.2, dear * 1.2, dear * 1.2 ] },
		] );

		expect( result.regressions.map( ( c ) => c.scene ) ).toEqual( [ 'dear' ] );
		expect( result.passed ).toBe( false );

	} );

	it( 'refuses to pass when every scene is too cheap to gate', () => {

		const result = comparePerf( [
			{ scene: 'cheap', baseMedians: [ cheap, cheap, cheap ], headMedians: [ cheap, cheap, cheap ] },
		] );

		expect( result.measured ).toBe( false );
		expect( result.passed ).toBe( false );
		expect( result.reason ).toMatch( /too cheap to gate/ );

	} );

} );
