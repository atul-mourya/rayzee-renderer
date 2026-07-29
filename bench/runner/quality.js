/**
 * Quality regression suite.
 *
 * Every scene is checked twice, and both checks matter for different reasons:
 *
 *   vs GOLDEN        — "did anything move?"     Reference is the last blessed render.
 *   vs GROUND TRUTH  — "did anything get worse?" Reference is a one-time high-spp render.
 *
 * The golden check alone is not enough. Goldens drift: regress 3 %, re-bless, regress 3 %,
 * re-bless — twenty PRs later the renderer is materially worse and every run was green.
 * RMSE against ground truth cannot drift, because the reference never moves.
 *
 * Bias and noise are reported separately. A missing 4π or a clamp eating light moves the
 * mean luminance while barely touching RMSE; a sampling-efficiency loss moves RMSE while
 * leaving the mean untouched. Collapsing them into one number hides both.
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { compare, ssim } from '../lib/metrics.js';
import { decodeDataURL, exists, readPNG, writeDataURL } from '../lib/png.js';
import { PATHS, QUALITY_GATES } from './config.js';

async function readJSON( filePath, fallback ) {

	try {

		return JSON.parse( await fs.readFile( filePath, 'utf-8' ) );

	} catch {

		return fallback;

	}

}

async function writeJSON( filePath, value ) {

	await fs.mkdir( path.dirname( filePath ), { recursive: true } );
	await fs.writeFile( filePath, `${JSON.stringify( value, null, '\t' )}\n` );

}

/**
 * Baselines are only comparable within one GPU fingerprint: the wavefront's path budget
 * is derived from device limits and navigator.deviceMemory, and single- vs multi-chunk
 * are materially different code paths through the renderer.
 */
export function fingerprintMismatch( stored, current ) {

	if ( ! stored ) return null;

	const keys = Object.keys( current );
	const differing = keys.filter( ( key ) => stored[ key ] !== current[ key ] );

	return differing.length
		? differing.map( ( key ) => `${key}: baseline ${stored[ key ]} vs current ${current[ key ]}` )
		: null;

}

/**
 * Renders every scene and compares against both references.
 *
 * @param {Object} bench - the harness wrapper from browser.js
 * @param {Object} [options]
 * @param {boolean} [options.bless] - overwrite goldens and probes instead of comparing
 * @param {boolean} [options.truth] - (re)generate ground-truth references; very slow
 * @param {string[]} [options.only] - scene ids to restrict the run to
 * @param {function(string): void} [options.log]
 */
export async function runQuality( bench, { bless = false, truth = false, only, log = () => {} } = {} ) {

	if ( truth && ! bless ) {

		// Regenerating the reference from the build under test would make both truth gates
		// self-comparisons: a systematic energy error appears at both sample counts and
		// cancels, so the bias ratio reads ~1.0 and the regression passes — permanently,
		// because the poisoned reference is then on disk. Ground truth moves only on bless.
		throw new Error( '--truth regenerates the reference and is only valid with `bench bless`' );

	}

	// Image comparison is meaningless unless output is reproducible. A perf pass leaves the
	// dispatch heuristics active, so assert rather than trust ordering.
	if ( await bench.isDeterministic() !== true ) {

		throw new Error(
			'engine is not in reproducible mode — image comparison would produce spurious ' +
			'diffs. A perf pass may have left dispatch heuristics active.'
		);

	}

	const fingerprint = await bench.fingerprint();
	const storedFingerprint = await readJSON( PATHS.fingerprint, null );
	const mismatch = fingerprintMismatch( storedFingerprint, fingerprint );

	if ( mismatch && ! bless ) {

		throw new Error(
			'GPU fingerprint differs from the stored baselines — results would be meaningless.\n  ' +
			`${mismatch.join( '\n  ' )}\n` +
			'Re-bless on this machine, or run on matching hardware.'
		);

	}

	// An absent fingerprint reads identically to a corrupt one (readJSON swallows both), so
	// a missing guard file must not silently license a cross-hardware comparison against
	// baselines that do exist.
	if ( ! storedFingerprint && ! bless && await exists( PATHS.golden ) ) {

		throw new Error(
			`baselines exist but ${PATHS.fingerprint} is missing or unreadable — cannot confirm ` +
			'they were recorded on this GPU. Re-bless, or restore the file.'
		);

	}

	const allScenes = await bench.scenes();
	const scenes = only?.length ? allScenes.filter( ( s ) => only.includes( s.id ) ) : allScenes;

	if ( ! scenes.length ) throw new Error( `no matching scenes (asked for: ${only?.join( ', ' )})` );

	const storedProbes = await readJSON( PATHS.probes, {} );
	const nextProbes = { ...storedProbes };
	const results = [];

	for ( const scene of scenes ) {

		log( `  ${scene.id}` );
		await bench.loadScene( scene.id );

		// ── Ground truth (one-time, expensive) ──
		//
		// Generated ONLY on bless. A comparison run that made its own reference would be
		// checking the build under test against itself: a systematic energy error appears at
		// both sample counts and cancels, so the bias ratio reads ~1.0 and the gate passes —
		// permanently, because the poisoned reference is then written to disk. That is the
		// same trap the `--truth` guard above blocks, reached through a different door (a
		// deleted file, or a scene added to the corpus and never blessed).
		const truthPath = path.join( PATHS.truth, `${scene.id}.png` );

		if ( bless && ( truth || ! await exists( truthPath ) ) ) {

			log( `    ground truth @ ${scene.truthSpp} spp…` );
			await bench.render( scene.truthSpp );
			await writeDataURL( truthPath, await bench.capturePNG() );
			nextProbes[ scene.id ] = { ...nextProbes[ scene.id ], truth: await bench.probes() };

		}

		// ── Regression render ──
		log( `    render @ ${scene.spp} spp…` );
		await bench.render( scene.spp );
		const renderedDataURL = await bench.capturePNG();
		const rendered = decodeDataURL( renderedDataURL );
		const probes = await bench.probes();

		const goldenPath = path.join( PATHS.golden, `${scene.id}.png` );

		if ( bless ) {

			await writeDataURL( goldenPath, renderedDataURL );

			// rmseVsTruth must be recomputed here, not carried over: it is the convergence
			// baseline, and a re-bless that left a stale value would compare future runs
			// against a reference image that no longer exists.
			const blessedTruth = await readPNG( path.join( PATHS.truth, `${scene.id}.png` ) );
			const rmseVsTruth = compare( decodeDataURL( renderedDataURL ), blessedTruth ).rmse;

			const furnaceRatio = scene.furnaceRadiance
				? probes.meanLuminance / scene.furnaceRadiance
				: undefined;

			nextProbes[ scene.id ] = { ...nextProbes[ scene.id ], golden: probes, rmseVsTruth, furnaceRatio };
			results.push( { scene: scene.id, blessed: true, probes, rmseVsTruth, furnaceRatio } );
			continue;

		}

		const entry = { scene: scene.id, pass: true, failures: [], probes };

		// ── vs ground truth: bias + noise ──
		if ( ! await exists( truthPath ) ) {

			// Both truth gates are structurally inert without a reference. Reporting a pass
			// on the strength of the golden check alone would claim energy and convergence
			// coverage this scene does not have.
			entry.pass = false;
			entry.failures.push(
				'no ground-truth reference on disk — the ENERGY BIAS and CONVERGENCE gates ' +
				'cannot run. Run `npm run bench:bless` to generate one.'
			);

		} else {

			const truthImage = await readPNG( truthPath );
			const vsTruth = compare( rendered, truthImage, {
				threshold: QUALITY_GATES.golden.pixelThreshold,
			} );
			entry.vsTruth = {
				rmse: vsTruth.rmse,
				ssim: ssim( rendered, truthImage ),
				meanLuminanceRatio: vsTruth.meanLuminanceRatio,
			};

			const truthProbes = nextProbes[ scene.id ]?.truth ?? storedProbes[ scene.id ]?.truth;

			if ( ! truthProbes?.meanLuminance ) {

				// Skipping the check here would silently disable the primary energy gate for
				// this scene while still reporting a pass. Fail instead.
				entry.pass = false;
				entry.failures.push(
					'no ground-truth luminance probe — the ENERGY BIAS gate cannot run. ' +
					'Re-bless this scene with --truth.'
				);

			} else {

				// The bias signal, measured in LINEAR space from the HDR buffer — the PNG is
				// tone-mapped and 8-bit, so a few-percent energy error is compressed away
				// before it reaches the pixels.
				const ratio = probes.meanLuminance / truthProbes.meanLuminance;
				entry.biasRatio = ratio;

				if ( Math.abs( ratio - 1 ) > QUALITY_GATES.truth.maxBiasRatioDelta ) {

					entry.pass = false;
					entry.failures.push(
						`ENERGY BIAS: mean luminance is ${( ( ratio - 1 ) * 100 ).toFixed( 2 )} % off ground truth ` +
						`(limit ±${( QUALITY_GATES.truth.maxBiasRatioDelta * 100 ).toFixed( 2 )} %)`
					);

				}

			}

			const baselineRmse = storedProbes[ scene.id ]?.rmseVsTruth;
			if ( typeof baselineRmse === 'number' && baselineRmse > 0 ) {

				const increase = ( vsTruth.rmse - baselineRmse ) / baselineRmse;
				entry.rmseIncrease = increase;

				if ( increase > QUALITY_GATES.truth.maxRmseIncrease ) {

					entry.pass = false;
					entry.failures.push(
						`CONVERGENCE: RMSE vs ground truth worsened ${( increase * 100 ).toFixed( 2 )} % ` +
						`(${baselineRmse.toFixed( 5 )} → ${vsTruth.rmse.toFixed( 5 )}); same spp, noisier image`
					);

				}

			}

			// Bootstrap only. Overwriting these on every run is exactly the drift this suite
			// exists to prevent: the convergence baseline would silently track each
			// regression and never fail. They move only when explicitly blessed.
			const existing = nextProbes[ scene.id ] ?? {};
			nextProbes[ scene.id ] = {
				...existing,
				golden: existing.golden ?? probes,
				rmseVsTruth: existing.rmseVsTruth ?? vsTruth.rmse,
			};

		}

		// ── vs golden: did anything move at all ──
		if ( await exists( goldenPath ) ) {

			const golden = await readPNG( goldenPath );
			const vsGolden = compare( rendered, golden, {
				threshold: QUALITY_GATES.golden.pixelThreshold,
			} );

			entry.vsGolden = {
				rmse: vsGolden.rmse,
				identical: vsGolden.identical,
				fractionOverThreshold: vsGolden.fractionOverThreshold,
				maxChannelDelta: vsGolden.maxChannelDelta,
			};

			if ( vsGolden.rmse > QUALITY_GATES.golden.maxRmse ) {

				entry.pass = false;
				entry.failures.push(
					`GOLDEN: RMSE ${vsGolden.rmse.toFixed( 5 )} exceeds ${QUALITY_GATES.golden.maxRmse}`
				);

			}

			if ( vsGolden.fractionOverThreshold > QUALITY_GATES.golden.maxFractionOverThreshold ) {

				entry.pass = false;
				entry.failures.push(
					`GOLDEN: ${( vsGolden.fractionOverThreshold * 100 ).toFixed( 2 )} % of pixels differ ` +
					`(limit ${( QUALITY_GATES.golden.maxFractionOverThreshold * 100 ).toFixed( 2 )} %)`
				);

			}

		} else {

			entry.failures.push( 'no golden on disk — run `npm run bench:bless`' );
			entry.pass = false;

		}

		// ── white furnace: energy conservation against an analytic reference ──
		if ( scene.furnaceRadiance ) {

			const ratio = probes.meanLuminance / scene.furnaceRadiance;
			const deviation = Math.abs( ratio - 1 );
			entry.furnace = { ratio, deviation };

			const blessed = storedProbes[ scene.id ]?.furnaceRatio;

			if ( typeof blessed !== 'number' ) {

				// No ratchet to compare against means this scene currently gates on nothing.
				// Reporting a pass would claim energy coverage it does not have.
				entry.pass = false;
				entry.failures.push(
					'no blessed furnace ratio — the ENERGY CONSERVATION ratchet cannot run. ' +
					'Run `npm run bench:bless`.'
				);

			} else {

				const blessedDeviation = Math.abs( blessed - 1 );

				if ( deviation > blessedDeviation + QUALITY_GATES.furnace.maxDeviationIncrease ) {

					entry.pass = false;
					entry.failures.push(
						`ENERGY CONSERVATION: furnace ratio moved further from 1.0 ` +
						`(${blessed.toFixed( 5 )} → ${ratio.toFixed( 5 )}; deviation ` +
						`${( blessedDeviation * 100 ).toFixed( 3 )} → ${( deviation * 100 ).toFixed( 3 )} pp). ` +
						'An albedo-1 surface in a uniform environment must return exactly the ' +
						'environment radiance, so this is energy created or destroyed.'
					);

				}

			}

			const existingFurnace = nextProbes[ scene.id ] ?? {};
			nextProbes[ scene.id ] = {
				...existingFurnace,
				furnaceRatio: existingFurnace.furnaceRatio ?? ratio,
			};

		}

		if ( probes.nonFinite > 0 ) {

			entry.pass = false;
			entry.failures.push( `${probes.nonFinite} non-finite pixels (NaN/Inf) in the HDR buffer` );

		}

		results.push( entry );

	}

	await writeJSON( PATHS.probes, nextProbes );
	if ( bless || ! storedFingerprint ) await writeJSON( PATHS.fingerprint, fingerprint );

	return { fingerprint, results, passed: results.every( ( r ) => r.pass !== false ) };

}
