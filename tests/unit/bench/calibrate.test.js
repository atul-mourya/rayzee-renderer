import { describe, it, expect } from 'vitest';
import { appSnippet, calibrationStale, compare, formatBanner, formatComparison, SNIPPET_MARKER } from '../../../bench/runner/calibrate.js';
import { CALIBRATION } from '../../../bench/runner/config.js';

const PLAIN = { DIM: '', GREEN: '', YELLOW: '', RESET: '' };

const profile = ( scene, blas, extraction = 500, textures = 600 ) => ( {
	phases: { extraction, blas, textures, scene },
	workersBusy: 1.7,
} );

describe( 'bench calibration', () => {

	describe( 'compare', () => {

		it( 'trusts a harness that matches the app', () => {

			const result = compare( profile( 1800, 1200 ), profile( 1700, 1150 ) );
			expect( result.trusted ).toBe( true );
			expect( result.worst ).toBeLessThan( CALIBRATION.tolerance );

		} );

		it( 'reports the worst phase, not the average — one distorted phase invalidates the run', () => {

			// scene and extraction match; blas is 10x. An average would call this 3x and pass.
			const result = compare( profile( 1800, 12000 ), profile( 1700, 1200 ) );
			expect( result.trusted ).toBe( false );
			expect( result.worst ).toBeCloseTo( 10, 1 );
			expect( result.ratios.blas ).toBeCloseTo( 10, 1 );

		} );

		it( 'ignores phases the app reference does not carry', () => {

			const app = { phases: { scene: 1800 } };
			const result = compare( profile( 1800, 1200 ), app );
			expect( Object.keys( result.ratios ) ).toEqual( [ 'scene' ] );
			expect( result.trusted ).toBe( true );

		} );

	} );

	describe( 'calibrationStale', () => {

		const fingerprint = { adapter: 'Apple M5 Pro', pathBudget: 4194304 };
		const stored = { model: '/models/a.glb', fingerprint };

		it( 'treats a missing calibration as stale', () => {

			expect( calibrationStale( null, fingerprint, '/models/a.glb' ) ).toBe( true );

		} );

		it( 'accepts a matching machine and model', () => {

			expect( calibrationStale( stored, fingerprint, '/models/a.glb' ) ).toBe( false );

		} );

		it( 'rejects another machine — a verdict from a different GPU says nothing here', () => {

			expect( calibrationStale( stored, { ...fingerprint, adapter: 'other' }, '/models/a.glb' ) ).toBe( true );

		} );

		it( 'rejects another model — per-task overhead scales with task count', () => {

			expect( calibrationStale( stored, fingerprint, '/models/b.glb' ) ).toBe( true );

		} );

	} );

	describe( 'formatComparison', () => {

		const captured = ( scene, blas ) => ( {
			...profile( scene, blas ), capturedBy: SNIPPET_MARKER, counts: { triangles: 100 },
		} );

		it( 'calls a change inside the run-to-run spread noise, not a win', () => {

			const out = formatComparison( captured( 1700, 1200 ), captured( 1690, 1180 ), PLAIN );
			expect( out ).toMatch( /noise/ );
			expect( out ).not.toMatch( /faster/ );

		} );

		it( 'names a real improvement', () => {

			const out = formatComparison( captured( 1700, 1200 ), captured( 1400, 900 ), PLAIN );
			expect( out ).toMatch( /faster/ );

		} );

		it( 'warns when the two arms are not the same scene', () => {

			const before = captured( 1700, 1200 );
			const after = { ...captured( 1400, 900 ), counts: { triangles: 999 } };
			expect( formatComparison( before, after, PLAIN ) ).toMatch( /not the same scene/ );

		} );

		it( 'warns when an arm was not captured by the snippet', () => {

			const after = { ...captured( 1400, 900 ) };
			delete after.capturedBy;
			expect( formatComparison( captured( 1700, 1200 ), after, PLAIN ) ).toMatch( /not captured by the snippet/ );

		} );

	} );

	describe( 'appSnippet', () => {

		it( 'never calls copy() from inside the async block', () => {

			// DevTools injects copy()/$0 only for the synchronous part of a console command, so a
			// call after the first await throws ReferenceError and takes the result with it.
			const snippet = appSnippet( '/models/a.glb' );
			const block = snippet.slice( snippet.indexOf( 'await (async' ), snippet.indexOf( '})()' ) );
			expect( block ).not.toMatch( /copy\(/ );
			expect( block ).toMatch( /globalThis.__calib/ );

		} );

		it( 'stamps its output so a typed reference is distinguishable', () => {

			expect( appSnippet( '/models/a.glb' ) ).toContain( SNIPPET_MARKER );

		} );

	} );

	describe( 'formatBanner', () => {

		it( 'says uncalibrated when nothing is stored', () => {

			expect( formatBanner( null, PLAIN ) ).toMatch( /not calibrated/ );

		} );

		it( 'asks for the app half when only the harness was measured', () => {

			expect( formatBanner( { harness: profile( 1800, 1200 ), app: null }, PLAIN ) ).toMatch( /half-calibrated/ );

		} );

		it( 'warns, with the ratio, when the harness disagrees with the app', () => {

			const banner = formatBanner( {
				model: '/models/a.glb', harness: profile( 25000, 22000 ), app: profile( 1800, 1200 ),
			}, PLAIN );
			expect( banner ).toMatch( /NOT trustworthy/ );
			expect( banner ).toMatch( /18\.3×/ );
			expect( banner ).toMatch( /worker counts/ );

		} );

		it( 'flags an app reference that the snippet did not capture', () => {

			const typed = formatBanner( {
				model: '/models/a.glb', harness: profile( 25000, 22000 ), app: profile( 1800, 1200 ),
			}, PLAIN );
			expect( typed ).toMatch( /not captured by the snippet/ );

			const captured = formatBanner( {
				model: '/models/a.glb',
				harness: profile( 25000, 22000 ),
				app: { ...profile( 1800, 1200 ), capturedBy: SNIPPET_MARKER },
			}, PLAIN );
			expect( captured ).not.toMatch( /not captured by the snippet/ );

		} );

		it( 'confirms a calibrated harness', () => {

			const banner = formatBanner( {
				model: '/models/a.glb', harness: profile( 1900, 1300 ), app: profile( 1800, 1200 ),
			}, PLAIN );
			expect( banner ).toMatch( /calibrated/ );
			expect( banner ).not.toMatch( /NOT/ );

		} );

	} );

} );
