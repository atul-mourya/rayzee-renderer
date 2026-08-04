/**
 * Per-kernel GPU profiling.
 *
 * Why this exists, and what it is not.
 *
 * `perf`/`ab` measure ms/sample for the whole frame at 256². Both properties defeat the work this
 * renderer actually needs measured. At 256² the wavefront's fixed per-bounce cost is a large
 * fraction of the frame, so traversal — the measured bottleneck — is nearly invisible; and a frame
 * total buries a change to one kernel under every other pass. A self-A/B of HEAD against itself
 * showed per-scene deltas up to 6.2 %, which is why `abUnchangedPct` sits at 8: that gate resolves
 * ~10 % and nothing finer.
 *
 * This mode renders at KERNELS.renderSize, where the frame is compute-bound, and attributes GPU
 * milliseconds per kernel from `app.getKernelGPUTimings()`. A change to `extend` is then judged
 * against `extend`'s own spread instead of the frame's.
 *
 * It is a MEASUREMENT, not a gate. It stores no baseline and returns no verdict — `ab` remains the
 * gate. Its job is to tell you (a) where GPU time goes and (b) what the smallest change you could
 * detect on a given kernel is, before anyone spends a week on an optimisation they cannot evaluate.
 *
 * The noise floor reported per kernel is the spread BETWEEN rounds, not within-round standard error.
 * Within-round SE is not a valid noise floor here — same measured reason as compareReplicates in
 * lib/stats.js.
 */

import { discardWarmup, median, stdev, summarise, trimOutliers } from '../lib/stats.js';
import { KERNELS } from './config.js';

/**
 * Profiles one scene: R rounds of N single-sample readings, per kernel.
 *
 * @param {Object} bench - harness proxy
 * @param {string} sceneId
 * @param {Object} [options]
 * @param {number} [options.rounds]
 * @param {number} [options.samples]
 * @param {function(string): void} [options.log]
 * @returns {Promise<Object>} per-kernel stats plus frame totals
 */
export async function profileScene( bench, sceneId, options = {} ) {

	const rounds = options.rounds ?? KERNELS.rounds;
	const samples = options.samples ?? KERNELS.measureSamples;
	const log = options.log ?? ( () => {} );

	await bench.loadScene( sceneId );

	// Order matters: the size change recompiles the wavefront to WGSL, so it has to happen before
	// the warmup that exists to pay for that compile.
	const size = await bench.setRenderSize( KERNELS.renderSize.width, KERNELS.renderSize.height );
	await bench.render( KERNELS.warmupSamples );

	// roundMedians[kernel] = one median per round. The between-round spread is the noise floor.
	const roundMedians = new Map();
	const frameTotals = [];
	const unattributed = [];

	for ( let round = 0; round < rounds; round ++ ) {

		const readings = await bench.measureKernelGPU( samples );

		if ( ! readings.length ) {

			throw new Error(
				`kernels: no timings returned for ${sceneId} — timestamp-query unavailable, ` +
				'or enableGPUTiming() was not applied by the harness'
			);

		}

		const usable = discardWarmup( readings, 1 );

		// Union of names across readings: a kernel can be absent from a reading entirely (the sort
		// passes only run when _sortMaterials is on, and a bounce loop that exits early dispatches
		// fewer passes). Treating absence as 0 is correct — it did not run, so it cost nothing.
		const names = new Set();
		for ( const r of usable ) for ( const k of Object.keys( r.kernels ) ) names.add( k );

		for ( const name of names ) {

			const series = trimOutliers( usable.map( ( r ) => r.kernels[ name ] ?? 0 ), KERNELS.trimFraction );
			if ( ! roundMedians.has( name ) ) roundMedians.set( name, [] );
			roundMedians.get( name ).push( median( series ) );

		}

		frameTotals.push( median( trimOutliers( usable.map( ( r ) => r.total ), KERNELS.trimFraction ) ) );
		unattributed.push( median( trimOutliers( usable.map( ( r ) => r.unattributed ), KERNELS.trimFraction ) ) );

		log( `    round ${round + 1}: frame ${frameTotals[ frameTotals.length - 1 ].toFixed( 2 )} ms` );

	}

	const frameMs = median( frameTotals );

	const kernels = [ ...roundMedians.entries() ]
		.map( ( [ name, medians ] ) => {

			const ms = median( medians );
			// Between-round spread, expressed as the relative half-range. With 3 rounds a stdev is
			// barely meaningful, so report both and let the reader use the pessimistic one.
			const sd = stdev( medians );
			return {
				name,
				ms,
				sharePct: frameMs > 0 ? ( ms / frameMs ) * 100 : 0,
				roundMedians: medians,
				spreadPct: ms > 0 ? ( ( Math.max( ...medians ) - Math.min( ...medians ) ) / ms ) * 100 : 0,
				noiseFloorPct: ms > 0 ? ( sd / ms ) * 100 : 0,
			};

		} )
		.sort( ( a, b ) => b.ms - a.ms );

	return {
		scene: sceneId,
		renderSize: size,
		rounds,
		samples,
		frameMs,
		frameStats: summarise( frameTotals ),
		unattributedMs: median( unattributed ),
		kernels,
	};

}

/** Formats one scene's profile as an aligned table. */
export function formatProfile( result ) {

	const lines = [];
	const { width, height } = result.renderSize;

	lines.push(
		`  ${result.scene}  ${width}x${height}  ` +
		`frame ${result.frameMs.toFixed( 2 )} ms  ` +
		`(${result.rounds} rounds x ${result.samples} samples)`
	);
	lines.push( '    kernel                   ms     share    between-round     detectable' );

	let folded = 0;
	let foldedCount = 0;

	for ( const k of result.kernels ) {

		if ( k.sharePct < KERNELS.reportThresholdPct ) {

			folded += k.ms;
			foldedCount ++;
			continue;

		}

		// The honest headline: a change smaller than the between-round spread is not observable
		// here, however many samples you take, because the spread is bias between rounds not
		// variance within them.
		lines.push(
			`    ${k.name.padEnd( 22 )}${k.ms.toFixed( 3 ).padStart( 7 )}` +
			`${k.sharePct.toFixed( 1 ).padStart( 8 )}%` +
			`${k.spreadPct.toFixed( 1 ).padStart( 13 )}%` +
			`${( '>' + k.spreadPct.toFixed( 1 ) + '%' ).padStart( 15 )}`
		);

	}

	if ( foldedCount > 0 ) {

		lines.push( `    ${( `other (${foldedCount})` ).padEnd( 22 )}${folded.toFixed( 3 ).padStart( 7 )}` );

	}

	// Reconciliation. A large unattributed share means passes are not reaching the kernel registry
	// (another stage, or a kernel dispatched outside KernelManager) — read it before trusting shares.
	const attributed = result.kernels.reduce( ( sum, k ) => sum + k.ms, 0 );
	const gap = result.frameMs - attributed - result.unattributedMs;
	lines.push(
		`    attributed ${attributed.toFixed( 2 )} ms  ` +
		`unattributed ${result.unattributedMs.toFixed( 2 )} ms  ` +
		`residual ${gap.toFixed( 3 )} ms`
	);

	return lines.join( '\n' );

}

/**
 * Profiles a set of scenes on one harness.
 *
 * @param {Object} bench
 * @param {Object} [options]
 * @param {string[]} [options.only]
 * @param {function(string): void} [options.log]
 * @returns {Promise<{results: Object[]}>}
 */
export async function runKernelProfile( bench, options = {} ) {

	const log = options.log ?? ( () => {} );
	const all = await bench.scenes();
	const ids = all.map( ( s ) => s.id );

	let selected;

	if ( options.only?.length ) {

		selected = options.only.filter( ( id ) => ids.includes( id ) );
		const unknown = options.only.filter( ( id ) => ! ids.includes( id ) );
		// A typo'd --only would otherwise profile nothing and exit 0, reading as a clean run.
		if ( unknown.length ) throw new Error( `kernels: unknown scene(s): ${unknown.join( ', ' )}` );

	} else {

		selected = KERNELS.defaultScenes.filter( ( id ) => ids.includes( id ) );

	}

	if ( ! selected.length ) throw new Error( 'kernels: no scenes selected' );

	const results = [];

	for ( const id of selected ) {

		log( `  ${id}` );
		const result = await profileScene( bench, id, { log } );
		results.push( result );

	}

	return { results };

}
