/**
 * `bench:load` — real models loaded by phase, in Node on Dawn, with a gate on load errors and engine issues, and an
 * A/B against another checkout gated per phase. See "Scene loading" in bench/README.md.
 */

import { execFile, fork } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { LOAD, PATHS } from './config.js';
import { LOAD_PHASES, compareLoads, loadFailures, parseRoots, phaseDepth, resolveModels, summarisePhases } from '../lib/load.js';

const exec = promisify( execFile );

const GREEN = '\x1b[32m', RED = '\x1b[31m', YELLOW = '\x1b[33m', DIM = '\x1b[2m', RESET = '\x1b[0m';

const ms = ( v ) => ( ! Number.isFinite( v ) ? '—' : Math.abs( v ) >= 1000 ? `${( v / 1000 ).toFixed( 2 )} s` : `${Math.round( v )} ms` );
const mb = ( v ) => ( Number.isFinite( v ) ? `${( v / 2 ** 20 ).toFixed( 1 )} MB` : '—' );
const signed = ( v, digits = 1 ) => `${v >= 0 ? '+' : ''}${v.toFixed( digits )}`;

/** Builds a checkout's engine as the npm package ships it (ES) into `outDir`, outside the checkout. */
async function buildEngine( tree, outDir ) {

	const own = path.join( tree, 'node_modules', 'vite', 'bin', 'vite.js' );
	const vite = existsSync( own ) ? own : path.join( PATHS.repoRoot, 'node_modules', 'vite', 'bin', 'vite.js' );
	await exec( process.execPath, [ vite, 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error' ], {
		cwd: path.join( tree, 'rayzee' ), maxBuffer: 64 * 2 ** 20,
	} );

}

async function describeTree( tree ) {

	const version = JSON.parse( await fs.readFile( path.join( tree, 'rayzee', 'package.json' ), 'utf8' ) ).version;
	const rev = await exec( 'git', [ 'rev-parse', '--short', 'HEAD' ], { cwd: tree } ).then( ( r ) => r.stdout.trim(), () => '?' );
	const dirty = await exec( 'git', [ 'diff', '--quiet', 'HEAD' ], { cwd: tree } ).then( () => '', () => ' + changes' );
	return `rayzee ${version}, ${rev}${dirty}`;

}

/** One checkout's engine in a Node process of its own, kept alive across loads and restarted if it dies. */
class NodeSide {

	constructor( { label, tree, dist, verbose } ) {

		Object.assign( this, { label, tree, dist, verbose } );
		this.child = null;
		this.tail = [];
		this.pending = null;
		this.nextId = 0;

	}

	async start() {

		const child = fork( path.join( PATHS.benchRoot, 'load', 'worker.js' ), [], {
			cwd: this.tree,
			execArgv: [ '--expose-gc' ],
			silent: true,
			env: { ...process.env, BENCH_LOAD_SIDE: JSON.stringify( { tree: this.tree, dist: this.dist, ...LOAD.renderSize } ) },
		} );

		const keep = ( chunk ) => {

			if ( this.verbose ) process.stdout.write( `${DIM}[${this.label}] ${chunk}${RESET}` );
			this.tail.push( ...chunk.toString().split( '\n' ).filter( Boolean ) );
			if ( this.tail.length > 60 ) this.tail.splice( 0, this.tail.length - 60 );

		};

		child.stdout.on( 'data', keep );
		child.stderr.on( 'data', keep );

		this.child = child;
		const ready = await new Promise( ( resolve, reject ) => {

			child.on( 'message', ( message ) => {

				if ( message.type === 'ready' ) resolve( message );
				else if ( message.type === 'result' && message.id === this.pending?.id ) this.pending.resolve( message.result );

			} );
			child.on( 'exit', ( code, signal ) => {

				const error = new Error( `${this.label}: worker exited (${signal ?? `code ${code}`})\n${this.tail.slice( - 20 ).join( '\n' )}` );
				this.child = null;
				reject( error );
				this.pending?.resolve( { error: error.message, phases: {}, issues: [] } );

			} );

		} );

		this.startup = ready;
		return ready;

	}

	async load( model ) {

		if ( ! this.child ) await this.start();

		const id = ++ this.nextId;
		const result = await new Promise( ( resolve ) => {

			const timer = setTimeout( () => {

				this.child?.kill( 'SIGKILL' );
				resolve( { error: `timed out after ${LOAD.timeoutMs / 1000} s`, phases: {}, issues: [] } );

			}, LOAD.timeoutMs );
			this.pending = { id, resolve: ( r ) => {

				clearTimeout( timer );
				resolve( r );

			} };
			this.child.send( { type: 'load', id, model: { id: model.id, file: model.file, options: model.options } } );

		} );

		this.pending = null;
		if ( result.error ) result.log = this.tail.slice( - 20 );
		return result;

	}

	async close() {

		const child = this.child;
		if ( ! child ) return;
		this.child = null;
		await new Promise( ( resolve ) => {

			const timer = setTimeout( () => {

				child.kill( 'SIGKILL' );
				resolve();

			}, 10_000 );
			child.once( 'exit', () => {

				clearTimeout( timer );
				resolve();

			} );
			child.send( { type: 'exit' } );

		} );

	}

}

/**
 * Loads every model on every side: `warmup` discarded loads, then `rounds` measured ones, the sides alternating which
 * goes first. With two sides each round starts both in fresh processes: a process carries a bias of its own,
 * which the rounds can only average out if each has its own.
 */
async function runLoads( sides, models, { rounds, warmup, log } ) {

	const results = {};
	const fresh = sides.length > 1;

	for ( const model of models ) {

		log( `\n${model.id}${DIM}  ${model.covers ?? ''}${RESET}` );
		const entry = results[ model.id ] = Object.fromEntries( sides.map( ( s ) => [ s.label, { warmup: [], rounds: [] } ] ) );

		const run = async ( side, what ) => {

			const result = await side.load( model );
			const line = result.error
				? `${RED}failed${RESET} ${result.error.split( '\n' )[ 0 ]}`
				: `ready ${ms( result.phases.ready )}${DIM} (load ${ms( result.phases.load )}, first frame ${ms( result.phases.firstFrame )})${RESET}`;
			log( `${DIM}  ${side.label.padEnd( 14 )} ${what.padEnd( 8 )}${RESET} ${line}` );
			return result;

		};

		const warm = async ( side ) => {

			for ( let w = 0; w < warmup; w ++ ) entry[ side.label ].warmup.push( await run( side, 'warm-up' ) );

		};

		if ( ! fresh ) for ( const side of sides ) await warm( side );

		for ( let i = 0; i < rounds; i ++ ) {

			for ( const side of i % 2 ? [ ...sides ].reverse() : sides ) {

				const own = entry[ side.label ];
				if ( fresh ) await warm( side );
				if ( ! own.warmup.some( ( r ) => r.error ) ) own.rounds[ i ] = await run( side, `round ${i + 1}` );
				if ( fresh ) await side.close();

			}

		}

	}

	return results;

}

function reportSide( model, side, { strict, log } ) {

	const measured = side.rounds.filter( Boolean );
	const failures = [ ...side.warmup, ...measured ].flatMap( ( r ) => loadFailures( r, { strict } ) );

	const last = measured.at( - 1 ) ?? side.warmup.at( - 1 );
	if ( last?.counts?.triangles ) {

		const m = last.memory ?? {};
		log( `${DIM}  ${last.counts.triangles.toLocaleString()} triangles · ${last.counts.meshes} meshes · ${last.counts.materials} materials · ${last.counts.images} images decoded` +
			` · host peak ${mb( m.hostPeakLiveBytes )} · rss ${mb( m.rssPeakBytes )} · vram ${mb( m.vramPeakBytes )}${RESET}` );

	}

	const summary = summarisePhases( measured );
	for ( const { key } of LOAD_PHASES ) {

		const s = summary[ key ];
		if ( ! s ) continue;
		const indent = '  '.repeat( phaseDepth( key ) );
		log( `  ${( indent + key ).padEnd( 16 )} ${ms( s.median ).padStart( 9 )}${DIM}  ${s.n > 1 ? `${ms( s.min )} – ${ms( s.max )}` : ''}${RESET}` );

	}

	if ( ! strict ) for ( const text of new Set( sideWarnings( side ) ) ) log( `  ${YELLOW}warning${RESET} ${DIM}${text}${RESET}` );
	for ( const text of new Set( failures ) ) log( `  ${RED}FAIL${RESET} ${text}` );
	const failed = [ ...side.warmup, ...measured ].find( ( r ) => r.error );
	if ( failed?.log?.length ) log( `${DIM}    ${failed.log.slice( - 8 ).join( '\n    ' )}${RESET}` );

	return failures.length;

}

function reportComparison( model, comparison, labels, log ) {

	const colour = { slower: RED, faster: GREEN, inconclusive: YELLOW };
	log( `  ${'phase'.padEnd( 16 )} ${labels.base.padStart( 10 )}   ${labels.head.padStart( 10 )}  ${'change'.padStart( 20 )}  ${'floor'.padStart( 8 )}  verdict` );

	for ( const p of comparison.phases ) {

		const name = ( '  '.repeat( phaseDepth( p.key ) ) + p.key ).padEnd( 16 );
		if ( p.verdict === 'one side only' ) {

			log( `  ${name} ${DIM}measured on one side only${RESET}` );
			continue;

		}

		const change = `${signed( p.deltaPct )} % (${signed( p.deltaMs, 0 )} ms)`;
		const culprit = comparison.culprits.includes( p.key ) ? `${RED}  ← here${RESET}` : '';
		log( `  ${name} ${ms( p.base ).padStart( 10 )} → ${ms( p.head ).padStart( 10 )}  ${change.padStart( 20 )}  ${`±${p.noiseFloorPct.toFixed( 1 )} %`.padStart( 8 )}  ` +
			`${colour[ p.verdict ] ?? DIM}${p.verdict}${RESET}${culprit}` );
		if ( p.verdict !== 'unchanged' ) log( `${DIM}  ${''.padEnd( 16 )} per-round ${p.roundDeltasPct.map( ( d ) => `${signed( d )}` ).join( ' / ' )} %${RESET}` );

	}

	const m = comparison.memory;
	if ( m ) {

		const tint = m.verdict === 'larger' ? RED : m.verdict === 'smaller' ? GREEN : DIM;
		log( `  ${'host peak'.padEnd( 16 )} ${mb( m.base ).padStart( 10 )} → ${mb( m.head ).padStart( 10 )}  ${`${signed( m.deltaPct )} %`.padStart( 20 )}  ${''.padStart( 8 )}  ${tint}${m.verdict}${RESET}` );

	}

	for ( const c of comparison.counts ) log( `  ${YELLOW}the sides built different scenes${RESET}${DIM}: ${c.key} ${c.base} → ${c.head}${RESET}` );

}

async function addWorktree( ref, log ) {

	const dir = await fs.realpath( await fs.mkdtemp( path.join( os.tmpdir(), 'rayzee-bench-load-' ) ) );
	log( `${DIM}creating a worktree for ${ref} at ${dir}${RESET}` );
	await exec( 'git', [ 'worktree', 'add', '--detach', dir, ref ], { cwd: PATHS.repoRoot } );
	await fs.symlink( path.join( PATHS.repoRoot, 'node_modules' ), path.join( dir, 'node_modules' ), 'dir' );
	return dir;

}

/**
 * @param {Object} flags - parsed CLI flags: ab, base-dir, head-dir, only, rounds, warmup, models, config, heavy, strict, json, verbose
 * @param {{ log: function(string): void, positiveInt: function(*, string): (number|undefined) }} io
 * @returns {Promise<number>} exit code
 */
export async function commandLoad( flags, { log, positiveInt } ) {

	const startedAt = performance.now();
	const config = JSON.parse( await fs.readFile( flags.config ? path.resolve( String( flags.config ) ) : LOAD.models, 'utf8' ) );
	const roots = parseRoots( flags.models ?? ( flags.config ? config.roots : undefined ) ?? process.env[ LOAD.modelsEnv ] ?? config.roots, { repoRoot: PATHS.repoRoot, home: os.homedir() } );
	const only = flags.only ? String( flags.only ).split( ',' ) : undefined;
	const rounds = positiveInt( flags.rounds, 'rounds' ) ?? LOAD.rounds;
	const warmup = flags.warmup === '0' ? 0 : positiveInt( flags.warmup, 'warmup' ) ?? LOAD.warmup;
	const strict = !! flags.strict;
	const { models, skipped } = resolveModels( config, { roots, only, heavy: !! flags.heavy, exists: existsSync } );

	const baseRef = typeof flags.ab === 'string' ? flags.ab : null;
	if ( flags.ab === true ) throw new Error( '--ab needs a git ref, e.g. --ab main' );
	if ( baseRef && flags[ 'base-dir' ] ) throw new Error( 'pass --ab <ref> or --base-dir <path>, not both' );
	const headTree = path.resolve( String( flags[ 'head-dir' ] ?? PATHS.repoRoot ) );

	const [ load1, load5 ] = os.loadavg();
	log( `scene loading (Node, Dawn) · ${os.cpus().length} cores, load average ${load1.toFixed( 1 )} / ${load5.toFixed( 1 )}` +
		`${load1 > os.cpus().length / 2 ? `${YELLOW} — the machine is busy, so expect noisy times${RESET}` : ''}` );
	for ( const s of skipped ) log( `  ${YELLOW}skipped${RESET} ${s.id}${DIM}  ${s.reason}${RESET}` );
	if ( ! models.length ) {

		log( `${RED}no models to load${RESET}${DIM} — models are gitignored; point --models or ${LOAD.modelsEnv} at the folders that hold them${RESET}` );
		return 1;

	}

	const scratch = await fs.realpath( await fs.mkdtemp( path.join( os.tmpdir(), 'rayzee-bench-load-dist-' ) ) );
	let worktree = null;
	const sides = [];

	try {

		const trees = [];
		if ( baseRef ) trees.push( { label: baseRef, tree: worktree = await addWorktree( baseRef, log ) } );
		else if ( flags[ 'base-dir' ] ) trees.push( { label: path.basename( path.resolve( String( flags[ 'base-dir' ] ) ) ), tree: path.resolve( String( flags[ 'base-dir' ] ) ) } );
		trees.push( { label: flags[ 'head-dir' ] ? path.basename( headTree ) : 'working tree', tree: headTree } );
		if ( trees.length === 2 && trees[ 0 ].label === trees[ 1 ].label ) trees.forEach( ( t, i ) => ( t.label = `${t.label}#${i ? 'head' : 'base'}` ) );

		for ( const [ i, { label, tree } ] of trees.entries() ) {

			const dist = path.join( scratch, String( i ) );
			const t = performance.now();
			await buildEngine( tree, dist );
			log( `${DIM}  ${label}: ${tree} (${await describeTree( tree )}), engine built in ${ms( performance.now() - t )}${RESET}` );
			sides.push( new NodeSide( { label, tree, dist, verbose: !! flags.verbose } ) );

		}

		for ( const side of sides ) {

			const ready = await side.start();
			const startup = ready.startupIssues.filter( ( i ) => i.code !== 'asset.unreachable' );
			if ( startup.length ) log( `  ${YELLOW}${side.label} started with issues${RESET}${DIM}: ${startup.map( ( i ) => i.code ).join( ', ' )}${RESET}` );
			if ( ready.network.length ) throw new Error( `${side.label} reached for the network at startup: ${ready.network.join( ', ' )}` );

		}

		log( `${DIM}  ${sides[ 0 ].startup.adapter} · node ${sides[ 0 ].startup.node} · per model and side, ` +
			`${sides.length > 1 ? `${rounds} rounds of ${warmup} warm-up + 1 measured load in a fresh process` : `${warmup} warm-up + ${rounds} measured loads`}${RESET}` );
		if ( sides.length > 1 ) for ( const side of sides ) await side.close();

		const results = await runLoads( sides, models, { rounds, warmup, log } );

		const head = sides.at( - 1 );
		const base = sides.length > 1 ? sides[ 0 ] : null;
		let failures = 0;
		let regressions = 0;
		let decisive = 0;
		const comparisons = {};

		log( base ? `\nA/B (${base.label} → ${head.label}), paired by round` : '\nresults (medians of the measured loads)' );

		for ( const model of models ) {

			log( `\n${model.id}` );
			const own = results[ model.id ];
			if ( base ) {

				const baseFailures = reportSideFailures( own[ base.label ], { strict } );
				if ( baseFailures.length ) log( `  ${YELLOW}${base.label} failed${RESET}${DIM}: ${baseFailures[ 0 ]}${RESET}` );

			}

			if ( ! base ) {

				failures += reportSide( model, own[ head.label ], { strict, log } );
				continue;

			}

			const headFailures = reportSideFailures( own[ head.label ], { strict } );
			failures += headFailures.length;
			for ( const text of new Set( headFailures ) ) log( `  ${RED}FAIL${RESET} ${head.label}: ${text}` );
			if ( ! strict ) for ( const text of new Set( sideWarnings( own[ head.label ] ) ) ) log( `  ${YELLOW}warning${RESET} ${DIM}${text}${RESET}` );

			const comparison = compareLoads( own[ base.label ].rounds, own[ head.label ].rounds, LOAD.gates );
			comparisons[ model.id ] = comparison;
			if ( ! comparison.phases.length ) continue;
			reportComparison( model, comparison, { base: base.label, head: head.label }, log );
			regressions += comparison.slower.length + ( comparison.memory?.verdict === 'larger' ? 1 : 0 );
			decisive += comparison.phases.filter( ( p ) => p.verdict === 'unchanged' || p.verdict === 'slower' || p.verdict === 'faster' ).length;

		}

		if ( flags.json ) {

			await fs.writeFile( path.resolve( String( flags.json ) ), `${JSON.stringify( {
				at: new Date().toISOString(), loadAverage: os.loadavg(), cores: os.cpus().length,
				sides: sides.map( ( s ) => ( { label: s.label, tree: s.tree, adapter: s.startup?.adapter } ) ),
				gates: LOAD.gates, rounds, warmup, skipped, models, results, comparisons,
			}, null, '\t' )}\n` );

		}

		log( '' );
		const culprits = Object.entries( comparisons ).flatMap( ( [ id, c ] ) => [
			...c.culprits.map( ( key ) => `${id} ${key}` ),
			...( c.memory?.verdict === 'larger' ? [ `${id} host peak` ] : [] ),
		] );
		if ( skipped.length ) log( `${YELLOW}skipped ${skipped.map( ( m ) => m.id ).join( ', ' )}${RESET}` );
		if ( culprits.length ) log( `${RED}slower: ${culprits.join( ', ' )}${RESET}` );
		if ( failures ) log( `${RED}${failures} load failure(s) or engine issue(s)${RESET}` );
		if ( base && ! decisive ) log( `${YELLOW}no verdict: every phase was too noisy to judge${RESET}` );
		const passed = ! failures && ! regressions && ( ! base || decisive > 0 );
		if ( passed ) log( `${GREEN}${base ? 'no load regression' : 'every model loaded cleanly'}${RESET}` );
		const [ end1 ] = os.loadavg();
		log( `${DIM}${ms( performance.now() - startedAt )} · load average ${end1.toFixed( 1 )} at the end${RESET}` );
		return passed ? 0 : 1;

	} finally {

		for ( const side of sides ) await side.close().catch( () => {} );
		await fs.rm( scratch, { recursive: true, force: true } );
		if ( worktree ) {

			await exec( 'git', [ 'worktree', 'remove', '--force', worktree ], { cwd: PATHS.repoRoot } )
				.catch( ( error ) => log( `${YELLOW}worktree cleanup failed: ${error.message}${RESET}` ) );

		}

	}

}

function reportSideFailures( side, { strict } ) {

	return [ ...side.warmup, ...side.rounds.filter( Boolean ) ].flatMap( ( r ) => loadFailures( r, { strict } ) );

}

function sideWarnings( side ) {

	return [ ...side.warmup, ...side.rounds.filter( Boolean ) ].flatMap( ( r ) => r.issues ?? [] )
		.filter( ( i ) => i.severity !== 'error' ).map( ( i ) => `${i.code}: ${i.message}` );

}
