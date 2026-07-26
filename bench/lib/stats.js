/**
 * Statistics helpers for the perf bench suite.
 *
 * Pure functions, zero dependencies, no input mutation.
 */

/** Runs noisier than this are not trustworthy enough to judge a regression. */
const MAX_TRUSTED_CV = 0.15;

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
 *   p95: number, stdev: number, cv: number}} Summary statistics.
 */
export function summarise( values ) {

	const sorted = values ? sortedCopy( values ) : [];
	const n = sorted.length;
	const avg = n === 0 ? NaN : mean( sorted );
	const sd = stdev( sorted );

	// abs() keeps cv non-negative: a signed cv would sail past the noise gate.
	const cv = Number.isFinite( avg ) && avg !== 0 ? sd / Math.abs( avg ) : 0;

	return {
		n,
		min: n === 0 ? NaN : sorted[ 0 ],
		max: n === 0 ? NaN : sorted[ n - 1 ],
		mean: avg,
		median: quantileOfSorted( sorted, 0.5 ),
		p95: quantileOfSorted( sorted, 0.95 ),
		stdev: sd,
		cv,
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
	const noiseFloorPct = Math.max( base.cv, head.cv ) * 100;

	const untrustworthy = ! Number.isFinite( deltaPct )
		|| base.cv > MAX_TRUSTED_CV
		|| head.cv > MAX_TRUSTED_CV
		|| magnitude < noiseFloorPct;

	if ( untrustworthy ) return 'inconclusive';

	if ( magnitude < UNCHANGED_PCT ) return 'unchanged';

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
