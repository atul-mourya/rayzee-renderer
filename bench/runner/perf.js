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
 * 2. Gate on a same-session interleaved A/B, never on a stored number. A laptop's absolute
 *    timings move with thermal state, so a baseline from last week produces false alarms
 *    and gets ignored within a month. `commandAB` in cli.js checks the base ref out into a
 *    git worktree, serves both trees at once, and drives both from ONE browser, alternating
 *    scene by scene (see runPerfInterleaved). The absolute numbers still go to a JSONL trend
 *    log, but only as monitoring — that is what catches the every-PR-is-+2 % drift that
 *    per-run thresholds never see.
 *
 *    Same-session is not a nicety. Measured in two separate browser sessions, identical code
 *    on an idle machine disagreed by up to 10 % on one scene, while the standard error each
 *    run reported was ±1.2 % — so the verdict logic, which trusts that SE as its noise floor,
 *    produced two false verdicts out of nine and a nonzero exit. Repeat measurements INSIDE
 *    one session agreed to 0.6-1.2 %, i.e. the SE is only honest within a session. Anything
 *    that reintroduces a session boundary between the two sides silently invalidates the
 *    thresholds in lib/stats.js.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { compareReplicates, discardWarmup, summarise, trimOutliers } from '../lib/stats.js';
import { PATHS, PERF } from './config.js';

/**
 * Loads one scene and measures its steady-state GPU ms/sample.
 *
 * The first render in a session compiles the whole wavefront to WGSL (~20 s measured),
 * and a scene load recompiles, so a warmup render is always discarded.
 *
 * Assumes `setPerfMode( true )` is already in effect on this harness.
 *
 * @param {Object} bench
 * @param {string} sceneId
 * @param {number} [samples] - measurements to take; defaults to PERF.measureSamples
 * @returns {Promise<{ scene: string, loadMs: number, gpuMsPerSample: Object, raw: number[] }>}
 */
export async function measureScene( bench, sceneId, samples = PERF.measureSamples ) {

	const load = await bench.loadScene( sceneId );

	// Asserted per scene, after the load: loadScene re-asserts deterministic mode, and a
	// regression there would silently put us back in the pinned configuration this function
	// exists to avoid measuring. isDeterministic true means pinned.
	if ( await bench.isDeterministic() === true ) {

		throw new Error(
			`perf: dispatch heuristics are pinned while measuring ${sceneId} — ` +
			'this measures a configuration production never runs'
		);

	}

	// Warmup: pays the WGSL compile so it does not land inside a measured sample.
	await bench.render( PERF.warmupSamples );

	const perSample = await bench.measureGPUPerSample( samples );

	if ( ! perSample.length ) {

		throw new Error( 'perf: no GPU timings returned (timestamp-query unavailable?)' );

	}

	// Drop the first reading (the transition out of warmup still shows in it on some
	// drivers), then trim the slow tail of scheduling hiccups.
	const measured = trimOutliers( discardWarmup( perSample, 1 ), PERF.trimFraction );

	return {
		scene: sceneId,
		loadMs: load.loadMs,
		gpuMsPerSample: summarise( measured ),
		raw: measured,
	};

}

/**
 * relSe is what decides whether an A/B verdict is possible; cv is only descriptive.
 * Printing both makes an 'inconclusive' verdict diagnosable.
 */
function formatMeasurement( result ) {

	const s = result.gpuMsPerSample;

	return (
		`${s.median.toFixed( 2 )} ms/sample GPU ` +
		`(±${( s.relSe * 100 ).toFixed( 1 )} % median SE, cv ${( s.cv * 100 ).toFixed( 1 )} %, ` +
		`n ${s.n})`
	);

}

/** Resolves `only` against a harness's corpus, refusing to silently measure nothing. */
async function selectScenes( bench, only ) {

	const all = await bench.scenes();
	const scenes = only?.length ? all.filter( ( s ) => only.includes( s.id ) ) : all;

	// A typo'd --only would otherwise measure nothing and exit 0, reading as a clean run.
	if ( ! scenes.length ) throw new Error( `perf: no matching scenes (asked for: ${only?.join( ', ' )})` );

	return scenes;

}

/**
 * Measures every scene on one harness. Absolute numbers, for the trend log.
 *
 * @param {Object} bench
 * @param {Object} [options]
 * @param {string[]} [options.only]
 * @param {function(string): void} [options.log]
 */
export async function runPerf( bench, { only, log = () => {} } = {} ) {

	const scenes = await selectScenes( bench, only );
	const results = [];

	// Measure the dispatch configuration production actually uses (see header). Restored in
	// the finally below: a throw here would otherwise leave the heuristics active, and a
	// later image comparison in the same session would trip runQuality's reproducibility
	// assertion with a confusing error far from the real cause.
	await bench.setPerfMode( true );

	try {

		for ( const scene of scenes ) {

			log( `  ${scene.id}` );
			const result = await measureScene( bench, scene.id );
			results.push( result );
			log( `    ${formatMeasurement( result )}, load ${( result.loadMs / 1000 ).toFixed( 1 )} s` );

		}

	} finally {

		// Restore reproducibility so a later image comparison in the same session is valid.
		await bench.setPerfMode( false );

	}

	return { results };

}

/**
 * Measures two harnesses scene by scene, in several alternating rounds per scene.
 *
 * Both harnesses live in ONE browser, and each scene is measured `PERF.abRepeats` times per
 * side, with the leading side flipped each round. The replication is not thoroughness for its
 * own sake — it is where the verdict's noise floor comes from, because the within-run standard
 * error demonstrably is not a valid one across two GPU devices (see compareReplicates).
 * Flipping the order stops any "second measurement is warmer" effect from landing entirely on
 * one side, where it would read as a one-directional regression.
 *
 * @param {Object} baseBench
 * @param {Object} headBench
 * @param {Object} [options]
 * @param {string[]} [options.only]
 * @param {function(string): void} [options.log]
 * @returns {Promise<{ measurements: Array<Object>, absentFromBase: string[] }>}
 */
export async function runPerfInterleaved( baseBench, headBench, { only, log = () => {} } = {} ) {

	const headScenes = await selectScenes( headBench, only );
	const baseIds = new Set( ( await baseBench.scenes() ).map( ( s ) => s.id ) );

	// Scenes added since the base ref cannot be compared. Measuring them anyway would cost
	// minutes and still produce no verdict, so they are dropped here and reported by the caller.
	const absentFromBase = headScenes.filter( ( s ) => ! baseIds.has( s.id ) ).map( ( s ) => s.id );
	const shared = headScenes.filter( ( s ) => baseIds.has( s.id ) );

	if ( ! shared.length ) {

		throw new Error(
			'perf A/B: no scenes in common between the two refs' +
			( absentFromBase.length ? ` (head-only: ${absentFromBase.join( ', ' )})` : '' )
		);

	}

	await baseBench.setPerfMode( true );
	await headBench.setPerfMode( true );

	const measurements = [];

	try {

		for ( const scene of shared ) {

			log( `  ${scene.id}` );

			const rounds = { base: [], head: [] };

			for ( let round = 0; round < PERF.abRepeats; round ++ ) {

				const order = round % 2 === 1
					? [[ 'head', headBench ], [ 'base', baseBench ]]
					: [[ 'base', baseBench ], [ 'head', headBench ]];

				const line = [];

				for ( const [ label, bench ] of order ) {

					const result = await measureScene( bench, scene.id, PERF.abMeasureSamples );
					rounds[ label ].push( result.gpuMsPerSample.median );
					line.push( `${label} ${result.gpuMsPerSample.median.toFixed( 2 )}` );

				}

				// Printed per round so a single wild round is visible in the log rather than
				// only showing up as a widened noise floor.
				log( `    round ${round + 1}: ${line.join( '  ' )} ms/sample` );

			}

			measurements.push( { scene: scene.id, baseMedians: rounds.base, headMedians: rounds.head } );

		}

	} finally {

		await baseBench.setPerfMode( false );
		await headBench.setPerfMode( false );

	}

	return { measurements, absentFromBase };

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
 * Turns runPerfInterleaved's per-scene replicates into verdicts.
 *
 * @param {Array<{scene: string, baseMedians: number[], headMedians: number[]}>} measurements
 */
export function comparePerf( measurements ) {

	const comparisons = measurements.map( ( entry ) => {

		const result = compareReplicates( entry.baseMedians, entry.headMedians, {
			unchangedPct: PERF.abUnchangedPct,
		} );

		return {
			scene: entry.scene,
			baseMedian: result.base.median,
			headMedian: result.head.median,
			deltaPct: result.deltaPct,
			noiseFloorPct: result.noiseFloorPct,
			roundDeltasPct: result.ratios.map( ( r ) => ( r - 1 ) * 100 ),
			baseSpreadPct: result.base.spreadPct,
			headSpreadPct: result.head.spreadPct,
			verdict: result.verdict,
		};

	} );

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
