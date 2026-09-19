/**
 * CPU-timing calibration for the bench harness.
 *
 * The harness renders on a real GPU, but it runs the engine's *CPU* work — geometry extraction,
 * BLAS builds, texture creation — several times slower than the same code in the app in a
 * normally-used browser, and the error is not a constant factor: per-task overhead inflates far
 * more than per-triangle work. That shape inverts rankings, which is how "the BLAS worker pool
 * anti-scales" came out of a harness run and cost a 55 % regression in the app.
 *
 * So this file does not correct anything. It measures one real model load in the harness, compares
 * it against a reference captured from the app on the same machine, and lets every other suite
 * print whether this browser's CPU numbers mean anything.
 */

import fs from 'node:fs/promises';
import { CALIBRATION, PATHS } from './config.js';

const PHASES = [ 'extraction', 'blas', 'textures', 'scene' ];

/**
 * Stamped into the app reference by the console snippet. An app half without it was typed or
 * transcribed rather than measured, which is worth saying out loud on every banner — a calibration
 * standing on a remembered number is the failure it exists to prevent.
 */
export const SNIPPET_MARKER = 'bench-calibrate-snippet';

async function readJSON( filePath, fallback ) {

	try {

		return JSON.parse( await fs.readFile( filePath, 'utf8' ) );

	} catch {

		return fallback;

	}

}

/**
 * Times a model load in the harness. The first load is discarded: V8 tiers up across repeats
 * (the same build measured 3037 → 1049 → 340 ms), so a single cold reading is not the machine.
 *
 * @param {Object} bench - harness wrapper from openHarness()
 * @param {Object} [options]
 * @param {string} [options.model] - model URL served by the dev server
 * @param {function} [options.log]
 * @returns {Promise<Object>} the best (fastest) of the recorded loads
 */
export async function measureHarness( bench, { model = CALIBRATION.defaultModel, log = () => {} } = {} ) {

	const runs = [];

	for ( let i = 0; i < CALIBRATION.loads; i ++ ) {

		const profile = await bench.profileModelLoad( model );
		log( `    load ${i + 1}: scene ${( profile.phases.scene / 1000 ).toFixed( 2 )} s` );
		if ( i > 0 ) runs.push( profile );

	}

	// Fastest, not median: everything that distorts this makes it slower, never faster, so the
	// best reading is the closest this browser gets to the machine's real speed.
	return runs.reduce( ( best, r ) => ( r.phases.scene < best.phases.scene ? r : best ) );

}

/**
 * Per-phase harness ÷ app ratios, and whether they are close enough to believe.
 * @param {Object} harness - measureHarness() result
 * @param {Object} app - reference captured from the app (same shape)
 */
export function compare( harness, app ) {

	const ratios = {};
	for ( const phase of PHASES ) {

		const a = app.phases?.[ phase ];
		if ( ! a ) continue;
		ratios[ phase ] = harness.phases[ phase ] / a;

	}

	const worst = Math.max( ...Object.values( ratios ), 0 );
	return { ratios, worst, trusted: worst <= CALIBRATION.tolerance };

}

/** @returns {Promise<Object|null>} the stored calibration, or null when never calibrated */
export function readCalibration() {

	return readJSON( PATHS.calibration, null );

}

export async function writeCalibration( record ) {

	await fs.mkdir( PATHS.baselines, { recursive: true } );
	await fs.writeFile( PATHS.calibration, `${JSON.stringify( record, null, '\t' )}\n` );

}

/**
 * True when the stored calibration was taken on a different machine or a different model, in which
 * case its verdict says nothing about this run.
 */
export function calibrationStale( stored, fingerprint, model ) {

	if ( ! stored ) return true;
	if ( model && stored.model !== model ) return true;
	if ( ! stored.fingerprint || ! fingerprint ) return false;
	return Object.keys( fingerprint ).some( ( k ) => stored.fingerprint[ k ] !== fingerprint[ k ] );

}

/**
 * The one line every suite prints, so no run is read without knowing whether its CPU numbers are
 * comparable to the app.
 *
 * @param {Object|null} stored - readCalibration() result
 * @param {Object} colors - { DIM, GREEN, YELLOW, RESET }
 */
export function formatBanner( stored, { DIM, GREEN, YELLOW, RESET } ) {

	if ( ! stored ) {

		return `${DIM}CPU timing: not calibrated — run \`npm run bench:calibrate\`. ` +
			`GPU results are unaffected; CPU, per-task and worker-count numbers from this run are ` +
			`not comparable to the app.${RESET}`;

	}

	if ( ! stored.app ) {

		return `${YELLOW}CPU timing: half-calibrated${RESET}${DIM} — harness measured, no app reference yet. ` +
			`Finish with \`npm run bench:calibrate -- --app <file.json>\`.${RESET}`;

	}

	const { worst, trusted } = compare( stored.harness, stored.app );
	const unverified = stored.app.capturedBy === SNIPPET_MARKER ? '' : ` ${DIM}(app reference not captured by the snippet — re-run it to confirm)${RESET}`;

	if ( trusted ) {

		return `${GREEN}CPU timing: calibrated${RESET}${DIM} — harness within ${worst.toFixed( 2 )}× of the app on ${stored.model}.${RESET}${unverified}`;

	}

	return `${YELLOW}CPU timing: NOT trustworthy${RESET} — this harness runs the engine's CPU work up to ` +
		`${worst.toFixed( 1 )}× slower than the app on this machine.${unverified}\n` +
		`${DIM}  The error is not uniform (per-task cost inflates most), so it cannot be scaled out. ` +
		`Do not conclude anything here about CPU time, per-task cost, worker counts or concurrency — ` +
		`measure those in the app. GPU comparisons in this run are unaffected.${RESET}`;

}

/** Formats the full calibration report for `bench calibrate`. */
export function formatReport( record, { DIM, GREEN, YELLOW, RESET } ) {

	const lines = [ `  model ${record.model}  ${record.counts?.triangles?.toLocaleString() ?? '?'} tris, ${record.counts?.meshes ?? '?'} meshes` ];
	const row = ( label, h, a, ratio ) => `  ${label.padEnd( 12 )} ${h.padStart( 9 )} ${a.padStart( 11 )} ${ratio.padStart( 9 )}`;

	lines.push( row( '', 'harness', 'app', 'ratio' ) );

	const cmp = record.app ? compare( record.harness, record.app ) : null;
	for ( const phase of PHASES ) {

		const h = `${( record.harness.phases[ phase ] / 1000 ).toFixed( 2 )}s`;
		const a = record.app ? `${( record.app.phases[ phase ] / 1000 ).toFixed( 2 )}s` : '—';
		const r = cmp?.ratios[ phase ] ? `${cmp.ratios[ phase ].toFixed( 1 )}×` : '—';
		lines.push( row( phase, h, a, r ) );

	}

	lines.push( row(
		'workers busy',
		record.harness.workersBusy.toFixed( 2 ),
		record.app ? record.app.workersBusy.toFixed( 2 ) : '—',
		'',
	) );

	lines.push( '', formatBanner( record, { DIM, GREEN, YELLOW, RESET } ) );
	return lines.join( '\n' );

}

/**
 * Before/after for a CPU change, both arms measured in the app. The stored calibration's app half
 * is the "before"; `after` is a fresh capture from the same snippet on the changed tree.
 *
 * This exists because the harness cannot answer this question — it distorts per-task cost — so the
 * only honest way to judge a build-time change is two app captures, and that should be one command
 * rather than an afternoon.
 *
 * @param {Object} before - app profile from the stored calibration
 * @param {Object} after - app profile captured on the changed tree
 * @param {Object} colors - { DIM, GREEN, YELLOW, RESET }
 */
export function formatComparison( before, after, { DIM, GREEN, YELLOW, RESET } ) {

	const lines = [];

	if ( before.counts?.triangles && after.counts?.triangles && before.counts.triangles !== after.counts.triangles ) {

		lines.push( `${YELLOW}  the two captures are not the same scene ` +
			`(${before.counts.triangles.toLocaleString()} vs ${after.counts.triangles.toLocaleString()} triangles)${RESET}` );

	}

	for ( const profile of [ before, after ] ) {

		if ( profile.capturedBy !== SNIPPET_MARKER ) {

			lines.push( `${YELLOW}  one arm was not captured by the snippet — the comparison is only as good as it${RESET}` );
			break;

		}

	}

	lines.push( `  ${''.padEnd( 12 )} ${'before'.padStart( 9 )} ${'after'.padStart( 9 )} ${'change'.padStart( 10 )}` );

	for ( const phase of PHASES ) {

		const b = before.phases?.[ phase ];
		const a = after.phases?.[ phase ];
		if ( ! b || a === undefined ) continue;

		const delta = ( a / b - 1 ) * 100;
		// A change smaller than the spread between repeated loads is not a result. Measured
		// run-to-run on one machine: about 5 % on the whole scene, more on the smaller phases.
		const mark = Math.abs( delta ) < 5 ? `${DIM}(noise)${RESET}` : delta < 0 ? `${GREEN}faster${RESET}` : `${YELLOW}slower${RESET}`;
		lines.push(
			`  ${phase.padEnd( 12 )} ${`${( b / 1000 ).toFixed( 2 )}s`.padStart( 9 )} ${`${( a / 1000 ).toFixed( 2 )}s`.padStart( 9 )} ` +
			`${`${delta >= 0 ? '+' : ''}${delta.toFixed( 1 )}%`.padStart( 10 )}  ${mark}`
		);

	}

	if ( before.workersBusy && after.workersBusy ) {

		lines.push( `  ${'workers busy'.padEnd( 12 )} ${before.workersBusy.toFixed( 2 ).padStart( 9 )} ${after.workersBusy.toFixed( 2 ).padStart( 9 )}` );

	}

	lines.push( `${DIM}  Both arms are app captures, so this is the comparison the harness cannot make.${RESET}` );
	return lines.join( '\n' );

}

/**
 * The snippet to paste into the app's console to capture the other half of the calibration.
 * It is the same measurement `profileModelLoad` makes, so the two are comparable.
 */
export function appSnippet( model ) {

	return [
		'1. open the app (npm run dev), load nothing yet, then paste this in the console:',
		'',
		'   await (async () => {',
		'     const app = globalThis.app;',
		'     app.pauseRendering = true; app.stopAnimation();',
		'     const out = [];',
		'     for (let i = 0; i < 3; i++) {',
		`       const t0 = performance.now(); await app.loadModel('${model}');`,
		'       const m = app._sdf.performanceMetrics, s = app.stages.pathTracer;',
		'       out.push({ totalMs: performance.now() - t0, phases: { extraction: m.geometryExtractionTime,',
		'         blas: m.blasBuildTime, tlas: m.tlasBuildTime, assemble: m.bvhAssembleTime,',
		'         textures: m.textureCreationTime, scene: m.totalProcessingTime },',
		'         workersBusy: m.blasWorkerTime / (m.blasBuildTime || 1),',
		'         counts: { triangles: s.triangleCount, meshes: app.sceneMeshes?.length },',
		`         capturedBy: '${SNIPPET_MARKER}' });`,
		'     }',
		'     app.pauseRendering = false;',
		'     const best = out.slice(1).reduce((b, r) => r.phases.scene < b.phases.scene ? r : b);',
		'     globalThis.__calib = JSON.stringify(best, null, 1); console.log(globalThis.__calib);',
		'   })()',
		'',
		"2. when it finishes (about a minute), run this as a SEPARATE console command —",
		"   DevTools' copy() only exists during a synchronous evaluation, so it cannot be",
		'   called from inside the block above:',
		'',
		'   copy(__calib)',
		'',
		'3. paste the clipboard into a file, then:  npm run bench:calibrate -- --app that-file.json',
	].join( '\n' );

}
