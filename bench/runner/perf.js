/**
 * Performance regression suite.
 *
 * Two rules govern everything here.
 *
 * 1. Measure GPU time, not wall clock. `pipeline.getStats()` wraps stage.render() in
 *    performance.now(), which times command ENCODING and stays flat while GPU cost
 *    doubles. The numbers below come from WebGPU timestamp queries via
 *    app.getGPUTimings(), which are real GPU milliseconds.
 *
 *    Measurement runs with `setPerfMode( true )`, which keeps `_useDynamicDispatch` and
 *    the per-bounce early exit ACTIVE. Those are real shipping behaviour; benchmarking
 *    with them pinned off (as image comparison requires) would measure a configuration
 *    production never runs and hide any regression confined to them. The trade is that
 *    output is no longer bit-reproducible during a perf pass, which does not matter here
 *    because nothing compares pixels.
 *
 * 2. Gate on same-session A/B, never on a stored number. A laptop's absolute timings
 *    move with thermal state, so a baseline from last week produces false alarms and
 *    gets ignored within a month. `runPerfAB` builds the base ref in a git worktree and
 *    interleaves the two runs in one session; the absolute numbers still go to a JSONL
 *    trend log, but only as monitoring — that is what catches the every-PR-is-+2 % drift
 *    that per-run thresholds never see.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { compareRuns, discardWarmup, summarise, trimOutliers } from '../lib/stats.js';
import { PATHS, PERF } from './config.js';

/**
 * Measures steady-state GPU ms/sample for each scene.
 *
 * The first render in a session compiles the whole wavefront to WGSL (~20 s measured),
 * and a scene load recompiles, so a warmup render is always discarded.
 *
 * @param {Object} bench
 * @param {Object} [options]
 * @param {string[]} [options.only]
 * @param {function(string): void} [options.log]
 */
export async function runPerf( bench, { only, log = () => {} } = {} ) {

	const allScenes = await bench.scenes();
	const scenes = only?.length ? allScenes.filter( ( s ) => only.includes( s.id ) ) : allScenes;

	// A typo'd --only would otherwise measure nothing and exit 0, reading as a clean run.
	if ( ! scenes.length ) throw new Error( `perf: no matching scenes (asked for: ${only?.join( ', ' )})` );

	const results = [];

	// Measure the dispatch configuration production actually uses (see header). Restored in
	// the finally below: a throw here would otherwise leave the heuristics active, and a
	// later image comparison in the same session would trip runQuality's reproducibility
	// assertion with a confusing error far from the real cause.
	await bench.setPerfMode( true );

	try {

		for ( const scene of scenes ) {

			log( `  ${scene.id}` );
			const load = await bench.loadScene( scene.id );

			// Asserted per scene, after the load: loadScene re-asserts deterministic mode,
			// and a regression there would silently put us back in the pinned configuration
			// this function exists to avoid measuring. isDeterministic true means pinned.
			if ( await bench.isDeterministic() === true ) {

				throw new Error(
					`perf: dispatch heuristics are pinned while measuring ${scene.id} — ` +
					'this measures a configuration production never runs'
				);

			}

			// Warmup: pays the WGSL compile so it does not land inside a measured sample.
			await bench.render( PERF.warmupSamples );

			const perSample = await bench.measureGPUPerSample( PERF.measureSamples );

			if ( ! perSample.length ) {

				throw new Error( 'perf: no GPU timings returned (timestamp-query unavailable?)' );

			}

			// Drop the first reading (the transition out of warmup still shows in it on some
			// drivers), then trim the slow tail of scheduling hiccups.
			const measured = trimOutliers( discardWarmup( perSample, 1 ), PERF.trimFraction );
			const summary = summarise( measured );

			results.push( {
				scene: scene.id,
				loadMs: load.loadMs,
				gpuMsPerSample: summary,
				raw: measured,
			} );

			// relSe is what decides whether an A/B verdict is possible; cv is only
			// descriptive. Printing both makes an 'inconclusive' verdict diagnosable.
			log(
				`    ${summary.median.toFixed( 2 )} ms/sample GPU ` +
				`(±${( summary.relSe * 100 ).toFixed( 1 )} % median SE, cv ${( summary.cv * 100 ).toFixed( 1 )} %, ` +
				`n ${summary.n}), load ${( load.loadMs / 1000 ).toFixed( 1 )} s`
			);

		}

	} finally {

		// Restore reproducibility so a later image comparison in the same session is valid.
		await bench.setPerfMode( false );

	}

	return { results };

}

/**
 * Appends a run to the trend log. Monitoring only — never a gate.
 *
 * @param {Object} entry
 */
export async function appendTrend( entry ) {

	await fs.mkdir( path.dirname( PATHS.perfLog ), { recursive: true } );
	await fs.appendFile( PATHS.perfLog, `${JSON.stringify( entry )}\n` );

}

/**
 * Compares two perf runs measured in the same session.
 *
 * @param {Object} baseRun - result of runPerf() against the base ref
 * @param {Object} headRun - result of runPerf() against the working tree
 */
export function comparePerf( baseRun, headRun ) {

	const byScene = new Map( baseRun.results.map( ( r ) => [ r.scene, r ] ) );
	const comparisons = [];

	for ( const head of headRun.results ) {

		const base = byScene.get( head.scene );
		if ( ! base ) continue;

		const verdict = compareRuns( base.raw, head.raw );
		comparisons.push( {
			scene: head.scene,
			baseMedian: verdict.base.median,
			headMedian: verdict.head.median,
			deltaPct: verdict.deltaPct,
			verdict: verdict.verdict,
		} );

	}

	const regressions = comparisons.filter( ( c ) => c.verdict === 'slower' );
	const decisive = comparisons.filter( ( c ) => c.verdict !== 'inconclusive' );

	// "No regressions" is only meaningful if something was actually compared decisively.
	// Zero overlapping scenes, or every scene too noisy to judge, is a failed measurement —
	// reporting it as a pass would wave through exactly the regression it could not see.
	const measured = comparisons.length > 0 && decisive.length > 0;

	return {
		comparisons,
		regressions,
		measured,
		passed: measured && regressions.length === 0,
		reason: measured
			? undefined
			: comparisons.length === 0
				? 'no scenes in common between the two runs'
				: 'every scene was too noisy to judge (machine under load?)',
	};

}
