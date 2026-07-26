/**
 * Statistics helpers for the perf bench suite.
 *
 * Pure functions, zero dependencies, no input mutation.
 */

/**
 * Absolute sanity cap on the median's relative standard error: beyond this the
 * measurement is broken rather than merely wide, and no delta should be believed.
 *
 * It is deliberately loose, because the real per-scene gating is done by the noise floor
 * in verdictFor() — a scene measured to ±0.4 % resolves a 2 % change, one measured to
 * ±6 % only resolves ~17 %. Measured range on Apple M-series at n=120 is 0.4-6.6 %.
 */
const MAX_TRUSTED_REL_SE = 0.08;

/** Median deltas smaller than this (percent) are treated as no change. */
const UNCHANGED_PCT = 2;

function clamp01( value ) {

	return Math.min( 1, Math.max( 0, value ) );

}

function sortedCopy( values ) {

	return Array.from( values ).sort( ( a, b ) => a - b );

}

function quantileOfSorted( sorted, p ) {

	const n = sorted.length;

	if ( n === 0 ) return NaN;

	if ( n === 1 ) return sorted[ 0 ];

	const rank = clamp01( p ) * ( n - 1 );
	const lo = Math.floor( rank );
	const hi = Math.ceil( rank );

	return sorted[ lo ] + ( sorted[ hi ] - sorted[ lo ] ) * ( rank - lo );

}

/**
 * Value at a given quantile, linearly interpolated between adjacent ranks.
 *
 * @param {number[]} values Sample. Not mutated.
 * @param {number} p Quantile in the range 0-1, clamped.
 * @return {number} Interpolated value, or NaN for an empty sample.
 */
export function percentile( values, p ) {

	if ( ! values || values.length === 0 ) return NaN;

	return quantileOfSorted( sortedCopy( values ), p );

}

/**
 * Median of a sample. Even-length samples average the two middle values.
 *
 * @param {number[]} values Sample. Not mutated.
 * @return {number} Median, or NaN for an empty sample.
 */
export function median( values ) {

	return percentile( values, 0.5 );

}

/**
 * Arithmetic mean of a sample.
 *
 * @param {number[]} values Sample. Not mutated.
 * @return {number} Mean, or NaN for an empty sample.
 */
export function mean( values ) {

	if ( ! values || values.length === 0 ) return NaN;

	let sum = 0;

	for ( const value of values ) sum += value;

	return sum / values.length;

}

/**
 * Sample standard deviation (n - 1 denominator).
 *
 * @param {number[]} values Sample. Not mutated.
 * @return {number} Standard deviation, or 0 for samples shorter than 2.
 */
export function stdev( values ) {

	if ( ! values || values.length < 2 ) return 0;

	const avg = mean( values );
	let sumSq = 0;

	for ( const value of values ) {

		const d = value - avg;
		sumSq += d * d;

	}

	return Math.sqrt( sumSq / ( values.length - 1 ) );

}

/**
 * Full summary of a sample, including the coefficient of variation the perf
 * suite uses to decide whether a measurement was too noisy to judge.
 *
 * @param {number[]} values Sample. Not mutated.
 * @return {{n: number, min: number, max: number, mean: number, median: number,
 *   p95: number, stdev: number, cv: number, medianSe: number, relSe: number}} Summary.
 */
export function summarise( values ) {

	const sorted = values ? sortedCopy( values ) : [];
	const n = sorted.length;
	const avg = n === 0 ? NaN : mean( sorted );
	const sd = stdev( sorted );
	const med = quantileOfSorted( sorted, 0.5 );

	// abs() keeps cv non-negative: a signed cv would sail past the noise gate.
	const cv = Number.isFinite( avg ) && avg !== 0 ? sd / Math.abs( avg ) : 0;

	// Standard error OF THE MEDIAN, ~1.2533 * sd / sqrt(n). This — not per-sample cv — is
	// the right noise floor for comparing two medians. Production dispatch sizing is
	// readback-driven, so per-frame cost is legitimately bimodal and cv runs 30-40 % even
	// when the median is rock stable; judging on cv would make every verdict inconclusive
	// and the perf gate would never fire.
	const medianSe = n > 1 ? 1.2533 * sd / Math.sqrt( n ) : 0;
	const relSe = Number.isFinite( med ) && med !== 0 ? medianSe / Math.abs( med ) : 0;

	return {
		n,
		min: n === 0 ? NaN : sorted[ 0 ],
		max: n === 0 ? NaN : sorted[ n - 1 ],
		mean: avg,
		median: med,
		p95: quantileOfSorted( sorted, 0.95 ),
		stdev: sd,
		cv,
		medianSe,
		relSe,
	};

}

/**
 * Drop leading warmup samples, which are dominated by JIT and cache effects.
 *
 * @param {number[]} values Sample. Not mutated.
 * @param {number} [count=1] Number of leading entries to drop.
 * @return {number[]} Trimmed sample, or the original when trimming would empty it.
 */
export function discardWarmup( values, count = 1 ) {

	if ( ! values ) return values;

	const drop = Math.max( 0, count );

	if ( drop >= values.length ) return values;

	return values.slice( drop );

}

/**
 * Drop the slowest `fraction` of readings.
 *
 * GPU timestamp samples are right-skewed: an occasional driver or OS scheduling hiccup
 * produces a reading several times the median, which inflates stdev enough to push `cv`
 * past the trust threshold and make every A/B verdict 'inconclusive'. Those outliers are
 * not renderer cost, so trimming the upper tail measures what we actually care about.
 * Only the upper tail is trimmed — a genuinely fast frame is signal, not noise.
 *
 * @param {number[]} values Sample. Not mutated.
 * @param {number} [fraction=0.1] Proportion of the slowest readings to drop.
 * @return {number[]} Trimmed sample, sorted ascending. Returns the original if trimming
 *   would leave fewer than 3 readings.
 */
export function trimOutliers( values, fraction = 0.1 ) {

	if ( ! Array.isArray( values ) || values.length < 4 ) return values;

	const sorted = values.slice().sort( ( a, b ) => a - b );
	const keep = sorted.length - Math.floor( sorted.length * fraction );

	return keep < 3 ? sorted : sorted.slice( 0, keep );

}

function verdictFor( base, head, deltaPct ) {

	const magnitude = Math.abs( deltaPct );

	// Combined 2-sigma sampling error of the two medians. Judging on per-sample spread
	// instead would reject stable measurements whose underlying distribution is merely
	// wide — which is the normal shape for readback-driven dispatch.
	const noiseFloorPct = 2 * Math.hypot( base.relSe, head.relSe ) * 100;

	// 'inconclusive' means the MEASUREMENT is broken, not that the delta is small. A delta
	// inside the noise floor is a real finding — no detectable change — and must pass,
	// otherwise every clean run fails for having found nothing.
	const untrustworthy = ! Number.isFinite( deltaPct )
		|| base.n < 3
		|| head.n < 3
		|| base.relSe > MAX_TRUSTED_REL_SE
		|| head.relSe > MAX_TRUSTED_REL_SE;

	if ( untrustworthy ) return 'inconclusive';

	if ( magnitude < Math.max( UNCHANGED_PCT, noiseFloorPct ) ) return 'unchanged';

	return deltaPct > 0 ? 'slower' : 'faster';

}

/**
 * Compare two runs on their medians, refusing a confident verdict when either
 * run is noisy or the delta sits inside the combined noise floor.
 *
 * @param {number[]} baseValues Baseline sample. Not mutated.
 * @param {number[]} headValues Candidate sample. Not mutated.
 * @return {{base: object, head: object, deltaPct: number,
 *   verdict: 'faster'|'slower'|'unchanged'|'inconclusive'}} Comparison result.
 */
export function compareRuns( baseValues, headValues ) {

	const base = summarise( baseValues );
	const head = summarise( headValues );
	const deltaPct = base.median === 0 ? 0 : ( head.median - base.median ) / base.median * 100;

	return { base, head, deltaPct, verdict: verdictFor( base, head, deltaPct ) };

}
