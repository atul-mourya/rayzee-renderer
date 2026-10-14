/**
 * `bench:load` — the pure parts: the model list, the phases a load is split into, and the verdicts.
 */

import path from 'node:path';
import { compareReplicates, median } from './stats.js';

/**
 * A load's phases, outermost first. `parent` is the phase a phase runs inside, so a regression shows in it and in each
 * phase above it; the deepest one that moved is where it is. Textures build beside the BVH, inside `scene`.
 */
export const LOAD_PHASES = [
	{ key: 'ready', parent: null, about: 'loadFile start to the first frame finished on the GPU' },
	{ key: 'load', parent: 'ready', about: 'loadFile' },
	{ key: 'parse', parent: 'load', about: 'reading, parsing and decoding, up to the scene build' },
	{ key: 'pbrtParse', parent: 'parse', about: 'pbrt text' },
	{ key: 'pbrtBuild', parent: 'parse', about: 'pbrt scene graph, .ply and images' },
	{ key: 'decode', parent: 'parse', about: 'image decoding, busy time' },
	{ key: 'scene', parent: 'load', about: 'SceneProcessor.buildBVH' },
	{ key: 'extraction', parent: 'scene', about: 'geometry extraction' },
	{ key: 'blas', parent: 'scene', about: 'BLAS builds' },
	{ key: 'tlas', parent: 'scene', about: 'TLAS build' },
	{ key: 'assemble', parent: 'scene', about: 'combined BVH' },
	{ key: 'textures', parent: 'scene', about: 'material textures, beside the BVH' },
	{ key: 'upload', parent: 'load', about: 'scene buffers and textures to the GPU' },
	{ key: 'kernels', parent: 'load', about: 'wavefront kernels built (setupMaterial)' },
	{ key: 'finish', parent: 'load', about: 'environment table and settings' },
	{ key: 'firstFrame', parent: 'ready', about: 'kernel compile and one sample' },
];

const PARENT = new Map( LOAD_PHASES.map( ( p ) => [ p.key, p.parent ] ) );

export function phaseDepth( key ) {

	let depth = 0;
	for ( let p = PARENT.get( key ); p; p = PARENT.get( p ) ) depth ++;
	return depth;

}

function isAncestor( ancestor, key ) {

	for ( let p = PARENT.get( key ); p; p = PARENT.get( p ) ) if ( p === ancestor ) return true;
	return false;

}

/**
 * Model search roots: a `path.delimiter`-separated string or an array, each resolved against `repoRoot`, `~` expanded.
 * @returns {string[]} absolute paths
 */
export function parseRoots( value, { repoRoot, home } ) {

	const list = Array.isArray( value ) ? value : String( value ?? '' ).split( path.delimiter );
	return list
		.map( ( entry ) => String( entry ).trim() )
		.filter( Boolean )
		.map( ( entry ) => ( entry === '~' || entry.startsWith( '~/' ) ? path.join( home, entry.slice( 1 ) ) : entry ) )
		.map( ( entry ) => path.resolve( repoRoot, entry ) );

}

/**
 * The models to load. A model is found under the first root that holds its `path`; one under none is skipped, as is a
 * `heavy` one unless asked for by `heavy` or by name in `only`.
 *
 * @param {{ models: Array<{ id: string, path: string, options?: Object, heavy?: boolean, covers?: string }> }} config
 * @param {{ roots: string[], only?: string[], heavy?: boolean, exists: function(string): boolean }} options
 * @returns {{ models: Array<Object>, skipped: Array<{ id: string, reason: string }> }} `models` carry `file`, absolute
 */
export function resolveModels( config, { roots, only, heavy = false, exists } ) {

	if ( ! Array.isArray( config?.models ) ) throw new Error( 'load config: `models` must be an array' );

	const ids = new Set();
	for ( const model of config.models ) {

		if ( ! model?.id || ! model.path ) throw new Error( `load config: every model needs an id and a path (${JSON.stringify( model )})` );
		if ( ids.has( model.id ) ) throw new Error( `load config: model id "${model.id}" appears twice` );
		ids.add( model.id );

	}

	const unknown = ( only ?? [] ).filter( ( id ) => ! ids.has( id ) );
	if ( unknown.length ) throw new Error( `unknown model(s) ${unknown.join( ', ' )}; the list has ${[ ...ids ].join( ', ' )}` );

	const models = [];
	const skipped = [];

	for ( const model of config.models ) {

		if ( only?.length && ! only.includes( model.id ) ) continue;

		if ( model.heavy && ! heavy && ! only?.includes( model.id ) ) {

			skipped.push( { id: model.id, reason: 'heavy: pass --heavy, or name it in --only' } );
			continue;

		}

		const root = roots.find( ( r ) => exists( path.join( r, model.path ) ) );
		if ( ! root ) {

			skipped.push( { id: model.id, reason: `${model.path} is under none of ${roots.join( ', ' ) || '(no roots)'}` } );
			continue;

		}

		models.push( { ...model, file: path.join( root, model.path ) } );

	}

	return { models, skipped };

}

/**
 * What makes one load a failure: an error, a request to the network, or an engine issue of severity error — any issue
 * under `strict`.
 * @returns {string[]} one line each
 */
export function loadFailures( result, { strict = false } = {} ) {

	const failures = [];
	if ( result?.error ) failures.push( `load failed: ${result.error.split( '\n' )[ 0 ]}` );
	for ( const url of new Set( result?.network ) ) failures.push( `reached for the network: ${url}` );
	for ( const issue of result?.issues ?? [] ) {

		if ( issue.severity === 'error' || strict ) failures.push( `${issue.severity} ${issue.code}: ${issue.message}` );

	}

	return failures;

}

/** Per-phase median, min and max over a side's measured loads. */
export function summarisePhases( results ) {

	const out = {};
	for ( const { key } of LOAD_PHASES ) {

		const values = results.map( ( r ) => r?.phases?.[ key ] ).filter( Number.isFinite );
		if ( values.length ) out[ key ] = { median: median( values ), min: Math.min( ...values ), max: Math.max( ...values ), n: values.length };

	}

	return out;

}

/**
 * Paired per-phase verdicts. Round i of each side was measured back to back, so the per-round ratio cancels what the
 * machine was doing that round (compareReplicates). A phase is unchanged unless its median paired delta passes both
 * the relative floor (`unchangedPct` or the rounds' own spread, whichever is wider) and `minDeltaMs`, and it moved the
 * same way in every round.
 *
 * @param {Object[]} baseRounds - measured loads, base side, in round order
 * @param {Object[]} headRounds - measured loads, head side, same rounds
 * @param {{ unchangedPct: number, minDeltaMs: number, memoryPct: number, minMemoryBytes: number }} gates
 */
export function compareLoads( baseRounds, headRounds, gates ) {

	const rounds = Math.min( baseRounds.length, headRounds.length );
	const phases = [];

	for ( const { key } of LOAD_PHASES ) {

		const base = [];
		const head = [];
		for ( let i = 0; i < rounds; i ++ ) {

			const b = baseRounds[ i ]?.phases?.[ key ];
			const h = headRounds[ i ]?.phases?.[ key ];
			if ( Number.isFinite( b ) && Number.isFinite( h ) ) {

				base.push( b );
				head.push( h );

			}

		}

		if ( ! base.length ) {

			const one = baseRounds.some( ( r ) => Number.isFinite( r?.phases?.[ key ] ) ) || headRounds.some( ( r ) => Number.isFinite( r?.phases?.[ key ] ) );
			if ( one ) phases.push( { key, verdict: 'one side only' } );
			continue;

		}

		const diffs = base.map( ( b, i ) => head[ i ] - b );
		const deltaMs = median( diffs );
		const result = compareReplicates( base, head, { unchangedPct: gates.unchangedPct } );
		let verdict = result.verdict;
		if ( Math.max( ...diffs.map( Math.abs ) ) < gates.minDeltaMs || ( verdict !== 'inconclusive' && Math.abs( deltaMs ) < gates.minDeltaMs ) ) verdict = 'unchanged';
		// A process carries a bias of its own, so a change has to show in every round.
		if ( ( verdict === 'slower' || verdict === 'faster' ) && ! diffs.every( ( d ) => Math.sign( d ) === Math.sign( deltaMs ) ) ) verdict = 'inconclusive';

		phases.push( {
			key,
			base: result.base.median,
			head: result.head.median,
			deltaPct: result.deltaPct,
			deltaMs,
			noiseFloorPct: Math.max( gates.unchangedPct, result.noiseFloorPct ),
			roundDeltasPct: result.ratios.map( ( r ) => ( r - 1 ) * 100 ),
			verdict,
		} );

	}

	const slower = phases.filter( ( p ) => p.verdict === 'slower' ).map( ( p ) => p.key );
	const culprits = slower.filter( ( key ) => ! slower.some( ( other ) => isAncestor( key, other ) ) );

	const memory = compareMemory( baseRounds, headRounds, gates );
	const counts = [ 'triangles', 'meshes', 'materials' ]
		.filter( ( k ) => baseRounds[ 0 ]?.counts?.[ k ] !== headRounds[ 0 ]?.counts?.[ k ] )
		.map( ( k ) => ( { key: k, base: baseRounds[ 0 ]?.counts?.[ k ], head: headRounds[ 0 ]?.counts?.[ k ] } ) );

	return { phases, slower, culprits, memory, counts, rounds };

}

/** The build's host peak (`getHostMemoryInfo().peakLiveBytes`) is counted, not sampled, so any growth is real. */
function compareMemory( baseRounds, headRounds, { memoryPct, minMemoryBytes } ) {

	const peak = ( rounds ) => median( rounds.map( ( r ) => r?.memory?.hostPeakLiveBytes ).filter( Number.isFinite ) );
	const base = peak( baseRounds );
	const head = peak( headRounds );
	if ( ! Number.isFinite( base ) || ! Number.isFinite( head ) || base === 0 ) return null;

	const deltaBytes = head - base;
	const deltaPct = ( head / base - 1 ) * 100;
	const moved = Math.abs( deltaPct ) >= memoryPct && Math.abs( deltaBytes ) >= minMemoryBytes;
	return { base, head, deltaBytes, deltaPct, verdict: ! moved ? 'unchanged' : deltaBytes > 0 ? 'larger' : 'smaller' };

}
