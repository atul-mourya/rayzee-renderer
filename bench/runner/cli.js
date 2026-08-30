/**
 * Bench CLI.
 *
 *   node bench/runner/cli.js run [--only a,b] [--verbose]   quality + denoise + memory + perf
 *   node bench/runner/cli.js quality [--only a,b] [--truth]
 *   node bench/runner/cli.js denoise [--only a,b] [--bless]
 *   node bench/runner/cli.js memory  [--scene id] [--cycles n]
 *   node bench/runner/cli.js perf    [--only a,b]
 *   node bench/runner/cli.js bless   [--only a,b] [--truth]
 *   node bench/runner/cli.js ab <baseRef> [--only a,b]
 *   node bench/runner/cli.js list
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { launchBrowser, openHarness } from './browser.js';
import { startDevServer } from './devserver.js';
import { PATHS } from './config.js';
import { appendTrend, comparePerf, runPerf, runPerfInterleaved } from './perf.js';
import { runDenoise } from './denoise.js';
import { runMemory } from './memory.js';
import { runQuality } from './quality.js';
import { runFreeze } from './freeze.js';
import { formatProfile, runKernelProfile } from './kernels.js';

const exec = promisify( execFile );

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function parseArgs( argv ) {

	const [ command = 'run', ...rest ] = argv;
	const flags = {};
	const positional = [];

	for ( let i = 0; i < rest.length; i ++ ) {

		const token = rest[ i ];
		if ( token.startsWith( '--' ) ) {

			const key = token.slice( 2 );
			const next = rest[ i + 1 ];
			if ( next && ! next.startsWith( '--' ) ) {

				flags[ key ] = next;
				i ++;

			} else {

				flags[ key ] = true;

			}

		} else {

			positional.push( token );

		}

	}

	return { command, flags, positional };

}

const log = ( message ) => process.stdout.write( `${message}\n` );

/** Boots dev server + harness, runs `body`, and always tears both down. */
async function withHarness( { cwd = PATHS.repoRoot, verbose }, body ) {

	log( `${DIM}starting dev server…${RESET}` );
	const server = await startDevServer( { cwd, verbose } );
	log( `${DIM}dev server at ${server.url}${RESET}` );

	// The harness must come from the SAME tree the dev server runs in. Vite's
	// `server.fs.allow` resolves to that tree's root, so serving the main repo's harness
	// to an A/B worktree's server returns 403 and the boot silently times out.
	const harnessPath = path.join( cwd, 'bench', 'harness', 'index.html' );

	let harness;
	try {

		log( `${DIM}booting harness (first boot compiles shaders, ~20 s)…${RESET}` );
		harness = await openHarness( server.url, { verbose, harnessPath } );
		return await body( harness );

	} finally {

		// Independently guarded: a throwing browser close must not skip the server stop,
		// or a failed run leaves vite holding the port.
		try {

			await harness?.close();

		} catch ( error ) {

			log( `${YELLOW}browser close failed: ${error.message}${RESET}` );

		}

		await server.stop();

	}

}

function reportFreeze( report ) {

	let failed = 0;

	for ( const entry of report.results ) {

		if ( entry.blessed ) {

			log( `  ${GREEN}blessed${RESET} ${entry.scene}${DIM} ratio ${entry.ratio.toFixed( 4 )} @ ${entry.samples} spp, moved ${( entry.engagedFraction * 100 ).toFixed( 2 )} %${RESET}` );
			continue;

		}

		const ok = entry.pass !== false;
		if ( ! ok ) failed ++;

		log( `  ${ok ? GREEN + 'pass' : RED + 'FAIL'}${RESET} ${entry.scene}` );

		if ( typeof entry.ratio === 'number' ) {

			const drift = typeof entry.increase === 'number'
				? `  ${entry.increase >= 0 ? '+' : ''}${( entry.increase * 100 ).toFixed( 2 ) } % vs blessed`
				: '';
			log( `${DIM}       ratio ${entry.ratio.toFixed( 4 )}x  moved ${( entry.engagedFraction * 100 ).toFixed( 2 )} % of pixels${drift}${RESET}` );

		}

		for ( const failure of entry.failures ?? [] ) log( `       ${RED}${failure}${RESET}` );

	}

	return failed;

}

function reportQuality( report ) {

	let failed = 0;

	for ( const entry of report.results ) {

		if ( entry.blessed ) {

			const furnace = entry.furnaceRatio !== undefined
				? `${DIM} furnace ${entry.furnaceRatio.toFixed( 5 )}${RESET}`
				: '';
			log( `  ${GREEN}blessed${RESET} ${entry.scene}${furnace}` );
			continue;

		}

		const ok = entry.pass !== false;
		if ( ! ok ) failed ++;

		log( `  ${ok ? `${GREEN}pass${RESET}` : `${RED}FAIL${RESET}`} ${entry.scene}` );

		if ( entry.vsTruth ) {

			const bias = entry.biasRatio !== undefined
				? `${( ( entry.biasRatio - 1 ) * 100 ).toFixed( 3 )} %`
				: 'n/a';
			log( `${DIM}       vs truth  rmse ${entry.vsTruth.rmse.toFixed( 5 )}  ` +
				`ssim ${entry.vsTruth.ssim.toFixed( 4 )}  bias ${bias}${RESET}` );

		}

		if ( entry.vsGolden ) {

			log( `${DIM}       vs golden rmse ${entry.vsGolden.rmse.toFixed( 5 )}  ` +
				`differing ${( entry.vsGolden.fractionOverThreshold * 100 ).toFixed( 3 )} %  ` +
				`${entry.vsGolden.identical ? 'bit-identical' : ''}${RESET}` );

		}

		if ( entry.furnace ) {

			// Deviation from 1.0 is an outstanding bug, not a regression — coloured, never fatal.
			const pp = ( entry.furnace.deviation * 100 ).toFixed( 3 );
			const tint = entry.furnace.deviation > 0.01 ? YELLOW : DIM;
			log( `${DIM}       furnace   ratio ${entry.furnace.ratio.toFixed( 5 )}  ` +
				`${tint}${pp} pp from energy conserving${RESET}` );

		}

		for ( const failure of entry.failures ?? [] ) log( `       ${RED}${failure}${RESET}` );

	}

	return failed;

}

function reportDenoise( report ) {

	let failed = 0;

	for ( const entry of report.results ) {

		const label = `${entry.scene} ${entry.strategy ?? ''} @${entry.spp ?? '?'} spp`.trim();

		if ( entry.blessed ) {

			log( `  ${GREEN}blessed${RESET} ${label.padEnd( 44 )}${DIM} ratio ${entry.ratio.toFixed( 3 )}${RESET}` );
			continue;

		}

		const ok = entry.pass !== false;
		if ( ! ok ) failed ++;

		// The absolute ratio is printed on every line, pass or fail. The ratchet only says
		// "no worse than last time"; without the number a scene sitting at 2.3x reads as clean.
		const ratio = entry.ratio !== undefined
			? `${entry.ratio < 1 ? GREEN : YELLOW}ratio ${entry.ratio.toFixed( 3 )}${RESET}` +
				`${DIM} (rmse ${entry.rawRmse.toFixed( 5 )} → ${entry.denoisedRmse.toFixed( 5 )})${RESET}`
			: '';

		log( `  ${ok ? `${GREEN}pass${RESET}` : `${RED}FAIL${RESET}`} ${label.padEnd( 44 )}${ratio}` );

		for ( const failure of entry.failures ?? [] ) log( `       ${RED}${failure}${RESET}` );

	}

	return failed;

}

/** Structural guard, not a metric — see rayzee/src/Pipeline/BindingAudit.js. */
async function reportBindingAudit( bench ) {

	const findings = await bench.bindingFindings();
	if ( ! findings.length ) return 0;

	log( `\n${RED}texture binding audit${RESET}` );
	for ( const finding of findings ) log( `  ${RED}${finding.message}${RESET}` );

	return findings.length;

}

async function reportShaderErrors( bench, label = '' ) {

	const { entries } = await bench.shaderDiagnostics();
	if ( ! entries.length ) return 0;

	// A kernel that fails to compile is absent from the dispatch, so every timing-based suite
	// reports it as free. That reads as a large performance WIN, not as a failure.
	log( `\n${RED}shader compilation errors${label ? ` (${label})` : ''}${RESET}` );
	for ( const d of entries.slice( 0, 8 ) ) {

		const at = d.lineNum > 0 ? ` at line ${d.lineNum}${d.linePos > 0 ? `:${d.linePos}` : ''}` : '';
		log( `  ${RED}[${d.label}]${at} ${d.message}${RESET}` );
		if ( d.source ) log( `${DIM}    ${d.source}${RESET}` );

	}

	return entries.length;

}

async function commandAB( baseRef, flags ) {

	const only = flags.only ? String( flags.only ).split( ',' ) : undefined;
	const verbose = !! flags.verbose;

	// A worktree gives the base ref its own checkout, so both sides can be measured
	// without stashing the working tree.
	//
	// realpath is load-bearing on macOS: os.tmpdir() is /var/folders/… , a symlink to
	// /private/var/folders/… . Vite builds `server.fs.allow` from process.cwd(), which Node
	// reports resolved, so a /@fs URL carrying the symlinked path lands outside the allow
	// list and returns 403 — the harness module then never executes, so it sets neither
	// __bench nor __benchBootError and the runner just times out after 180 s.
	const worktree = await fs.realpath(
		await fs.mkdtemp( path.join( os.tmpdir(), 'rayzee-bench-ab-' ) )
	);
	log( `${DIM}creating worktree for ${baseRef} at ${worktree}${RESET}` );
	await exec( 'git', [ 'worktree', 'add', '--detach', worktree, baseRef ], { cwd: PATHS.repoRoot } );

	const servers = [];
	let browser;
	let baseHarness;
	let headHarness;

	try {

		// node_modules is not copied into a worktree; symlink the existing install rather
		// than paying a full npm ci.
		await fs.symlink(
			path.join( PATHS.repoRoot, 'node_modules' ),
			path.join( worktree, 'node_modules' ),
			'dir'
		);

		log( `${DIM}starting a dev server for each tree…${RESET}` );

		// Each tree serves its own harness: Vite's `server.fs.allow` resolves to the tree the
		// server runs in, so serving one tree's harness from the other's server returns 403.
		const baseServer = await startDevServer( { cwd: worktree, verbose } );
		servers.push( baseServer );
		const headServer = await startDevServer( { cwd: PATHS.repoRoot, verbose } );
		servers.push( headServer );
		log( `${DIM}base ${baseServer.url} · head ${headServer.url}${RESET}` );

		// ONE browser for both harnesses — see runPerfInterleaved for why this is not
		// incidental. Two browsers means two GPU sessions, and the between-session offset is
		// larger than the regressions this gate exists to find.
		browser = await launchBrowser();

		log( `${DIM}booting both harnesses (first boot compiles shaders, ~20 s each)…${RESET}` );
		baseHarness = await openHarness( baseServer.url, {
			verbose, browser, harnessPath: path.join( worktree, 'bench', 'harness', 'index.html' ),
		} );
		headHarness = await openHarness( headServer.url, { verbose, browser, harnessPath: PATHS.harness } );

		// Same GPU by construction, so a mismatch means the two refs disagree about something
		// that changes what a "sample" costs — render size is in the fingerprint, and
		// comparing ms/sample across resolutions is meaningless.
		const baseFingerprint = await baseHarness.bench.fingerprint();
		const headFingerprint = await headHarness.bench.fingerprint();
		const differing = Object.keys( headFingerprint )
			.filter( ( key ) => baseFingerprint[ key ] !== headFingerprint[ key ] );

		if ( differing.length ) {

			throw new Error(
				`A/B fingerprints differ between ${baseRef} and the working tree, so ms/sample ` +
				'is not comparable:\n  ' +
				differing.map( ( k ) => `${k}: ${baseFingerprint[ k ]} vs ${headFingerprint[ k ]}` ).join( '\n  ' )
			);

		}

		const { measurements, absentFromBase } = await runPerfInterleaved(
			baseHarness.bench, headHarness.bench, { only, log }
		);

		const comparison = comparePerf( measurements );

		log( '\nA/B result' );
		for ( const entry of comparison.comparisons ) {

			const colour = entry.verdict === 'slower'
				? RED
				: entry.verdict === 'faster' ? GREEN : DIM;
			log(
				`  ${colour}${entry.verdict.padEnd( 12 )}${RESET} ${entry.scene.padEnd( 26 )} ` +
				`${entry.baseMedian.toFixed( 2 )} → ${entry.headMedian.toFixed( 2 )} ms ` +
				`(${entry.deltaPct >= 0 ? '+' : ''}${entry.deltaPct.toFixed( 1 )} %)`
			);
			// The floor is what makes a verdict readable: "+3 %, floor 7 %" is a clean pass,
			// "+3 %, floor 1 %" is a real finding, and the number alone cannot tell them apart.
			// Absolute spread is shown separately because a wide spread with a stable ratio is
			// machine drift the paired comparison already cancelled, not a bad measurement.
			log(
				`${DIM}               floor ±${entry.noiseFloorPct.toFixed( 1 )} %, ` +
				`per-round delta ${entry.roundDeltasPct.map( ( d ) => `${d >= 0 ? '+' : ''}${d.toFixed( 1 )}` ).join( ' / ' )} %, ` +
				`absolute spread base ${entry.baseSpreadPct.toFixed( 1 )} % / head ${entry.headSpreadPct.toFixed( 1 )} %${RESET}`
			);

		}

		// Printed unconditionally, including on an otherwise-clean pass: a run that compared
		// 4 of 9 scenes and said nothing about the other 5 reads as full coverage.
		if ( absentFromBase.length ) {

			log( `  ${YELLOW}not compared${RESET} (absent from ${baseRef}): ${absentFromBase.join( ', ' )}` );

		}

		if ( ! comparison.measured ) {

			log( `  ${YELLOW}no verdict: ${comparison.reason}${RESET}` );

		}

		// Both sides, because a compile failure on one side only is exactly what fakes a win.
		const shaderErrors = await reportShaderErrors( baseHarness.bench, baseRef )
			+ await reportShaderErrors( headHarness.bench, 'HEAD' );

		return comparison.passed && shaderErrors === 0 ? 0 : 1;

	} finally {

		// Each teardown is independently guarded: a throwing page close must not strand a
		// dev server on its port or leave the worktree registered in git.
		for ( const harness of [ baseHarness, headHarness ] ) {

			try {

				await harness?.close();

			} catch ( error ) {

				log( `${YELLOW}harness close failed: ${error.message}${RESET}` );

			}

		}

		try {

			await browser?.close();

		} catch ( error ) {

			log( `${YELLOW}browser close failed: ${error.message}${RESET}` );

		}

		for ( const server of servers ) await server.stop();

		await exec( 'git', [ 'worktree', 'remove', '--force', worktree ], { cwd: PATHS.repoRoot } )
			.catch( ( error ) => log( `${YELLOW}worktree cleanup failed: ${error.message}${RESET}` ) );

	}

}

const COMMANDS = [ 'run', 'quality', 'denoise', 'freeze', 'memory', 'perf', 'kernels', 'bless', 'ab', 'list' ];

/** Parses `--cycles`; a bare flag or a bad value must fail rather than quietly run once. */
function positiveIntFlag( value, name ) {

	if ( value === undefined ) return undefined;

	// A bare `--cycles` parses as boolean true, and Number( true ) === 1 — which would
	// quietly collapse the leak loop to a single cycle that can never detect growth.
	const parsed = typeof value === 'string' ? Number( value ) : NaN;

	if ( ! Number.isInteger( parsed ) || parsed < 1 ) {

		throw new Error( `--${name} needs a positive integer, got "${value}"` );

	}

	return parsed;

}

async function main() {

	const { command, flags, positional } = parseArgs( process.argv.slice( 2 ) );
	const only = flags.only ? String( flags.only ).split( ',' ) : undefined;
	const verbose = !! flags.verbose;

	// Silently doing nothing and exiting 0 would read as "all checks passed" in CI.
	if ( ! COMMANDS.includes( command ) ) {

		process.stderr.write( `unknown command "${command}". Expected one of: ${COMMANDS.join( ', ' )}\n` );
		return 2;

	}

	// Validated before booting anything — a typo should not cost a 20 s harness start.
	const cycles = positiveIntFlag( flags.cycles, 'cycles' );

	if ( command === 'list' ) {

		return withHarness( { verbose }, async ( { bench } ) => {

			for ( const scene of await bench.scenes() ) {

				log( `  ${scene.id.padEnd( 26 )} ${DIM}${scene.covers}${RESET}` );

			}

			return 0;

		} );

	}

	if ( command === 'ab' ) {

		const baseRef = positional[ 0 ];
		if ( ! baseRef ) throw new Error( 'ab requires a base ref, e.g. `bench ab main`' );
		return commandAB( baseRef, flags );

	}

	return withHarness( { verbose }, async ( { bench } ) => {

		let exitCode = 0;

		if ( command === 'bless' ) {

			log( 'blessing baselines' );
			const report = await runQuality( bench, {
				bless: true, truth: !! flags.truth, only, log,
			} );
			reportQuality( report );

			// After quality, so the ground truth it depends on is guaranteed to exist on a
			// first bless of a fresh machine.
			log( '\nfreeze (Tier-2 per-pixel freeze — the path deterministic mode hides)' );
			reportFreeze( await runFreeze( bench, { bless: true, only, log } ) );

			log( '\ndenoise' );
			reportDenoise( await runDenoise( bench, { bless: true, only, log } ) );

			log( `\n${GREEN}baselines written${RESET} to ${path.relative( PATHS.repoRoot, PATHS.baselines )}` );
			return 0;

		}

		if ( command === 'run' || command === 'quality' ) {

			log( 'quality' );
			const report = await runQuality( bench, { truth: !! flags.truth, only, log } );
			if ( reportQuality( report ) > 0 ) exitCode = 1;

		}

		if ( command === 'run' || command === 'freeze' ) {

			// As with denoise: `bench freeze --bless` records this ratchet alone, so a change to
			// the freeze path does not force a re-bless of the path tracer's goldens.
			const blessFreeze = command === 'freeze' && !! flags.bless;

			log( `\nfreeze (Tier-2 per-pixel freeze — RMSE vs truth, frozen ÷ unfrozen)${blessFreeze ? ' — blessing' : ''}` );
			const report = await runFreeze( bench, { bless: blessFreeze, only, log } );
			if ( reportFreeze( report ) > 0 && ! blessFreeze ) exitCode = 1;
			if ( blessFreeze ) {

				log( `${GREEN}freeze ratchet written${RESET} to ${path.relative( PATHS.repoRoot, PATHS.freeze )}` );

			}

		}

		if ( command === 'run' || command === 'denoise' ) {

			// `bench denoise --bless` records the ratchet without touching the quality goldens,
			// so a denoiser change does not force a re-bless of the path tracer's baselines.
			const blessDenoise = command === 'denoise' && !! flags.bless;

			log( `\ndenoise (RMSE vs ground truth, denoised ÷ raw — below 1.0 is a win)${blessDenoise ? ' — blessing' : ''}` );
			const report = await runDenoise( bench, { bless: blessDenoise, only, log } );
			if ( reportDenoise( report ) > 0 && ! blessDenoise ) exitCode = 1;
			if ( blessDenoise ) {

				log( `${GREEN}denoise ratchet written${RESET} to ${path.relative( PATHS.repoRoot, PATHS.denoise )}` );

			}

		}

		if ( command === 'run' || command === 'memory' ) {

			log( '\nmemory' );
			const report = await runMemory( bench, {
				sceneId: typeof flags.scene === 'string' ? flags.scene : undefined,
				cycles,
				log,
			} );

			for ( const failure of report.failures ) log( `  ${RED}${failure}${RESET}` );
			if ( ! report.passed ) exitCode = 1;
			else log( `  ${GREEN}no leak detected${RESET}` );

		}

		if ( command === 'run' || command === 'perf' ) {

			log( '\nperf (absolute — trend only, not a gate)' );
			const report = await runPerf( bench, { only, log } );
			await appendTrend( {
				at: new Date().toISOString(),
				fingerprint: await bench.fingerprint(),
				scenes: report.results.map( ( r ) => ( {
					scene: r.scene,
					medianGpuMs: r.gpuMsPerSample.median,
					p95GpuMs: r.gpuMsPerSample.p95,
					cv: r.gpuMsPerSample.cv,
					loadMs: r.loadMs,
				} ) ),
			} );
			log( `${DIM}  appended to ${path.relative( PATHS.repoRoot, PATHS.perfLog )}${RESET}` );
			log( `${DIM}  gate on regressions with: npm run bench:ab -- main${RESET}` );

		}

		if ( command === 'kernels' ) {

			// Deliberately NOT part of `run`: setRenderSize overrides the corpus render size, which
			// probes()/capturePNG() still assume, so this must not share a harness with the image suites.
			log( `\nper-kernel GPU profile (measurement, not a gate)` );
			await bench.setPerfMode( true );

			try {

				const report = await runKernelProfile( bench, { only, log, shipping: !! flags.shipping, model: flags.model ? String( flags.model ) : undefined, env: flags.env ? String( flags.env ) : undefined } );
				for ( const result of report.results ) log( formatProfile( result ) );
				log( `${DIM}  a change smaller than a kernel's between-round spread is not observable here${RESET}` );
				log( `${DIM}  gate regressions with: npm run bench:ab -- main${RESET}` );

			} finally {

				await bench.setPerfMode( false );

			}

		}

		// Only meaningful once stages have actually rendered, so it runs after every suite.
		if ( await reportBindingAudit( bench ) > 0 ) exitCode = 1;
		if ( await reportShaderErrors( bench ) > 0 ) exitCode = 1;

		const errors = bench.consoleErrors().filter( ( e ) => ! e.includes( 'favicon' ) );
		if ( errors.length ) {

			log( `\n${YELLOW}page console errors:${RESET}` );
			for ( const error of errors.slice( 0, 10 ) ) log( `  ${error}` );

		}

		return exitCode;

	} );

}

main()
	.then( ( code ) => process.exit( code ?? 0 ) )
	.catch( ( error ) => {

		process.stderr.write( `${RED}bench failed:${RESET} ${error.stack || error}\n` );
		process.exit( 1 );

	} );
