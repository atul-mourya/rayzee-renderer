/**
 * Tier-2 per-pixel freeze coverage.
 *
 * The quality suite pins deterministic mode, and that clears `usePixelFreeze` — so the freeze
 * path ships to every user and no gate has ever rendered a single pixel through it. A bug there
 * rendered at RMSE 4.49 instead of 0.03 and passed all 21 quality scenes.
 *
 * Two renders per scene, identical except for `usePixelFreeze`. Both leave deterministic mode,
 * because the readback-driven dispatch heuristics return with it and move the image on their own —
 * comparing against a DETERMINISTIC render measures those instead, and a seeded fault that turned
 * freeze off entirely passed that version of this check.
 *
 * Two assertions, and the first matters more:
 *
 *   ENGAGED — the frozen arm must differ perceptibly from the unfrozen one. Freeze barely moves a
 *             correct image, and "barely moved" is indistinguishable from "never ran" unless you
 *             measure it. Without this the rung passes forever on a freeze that silently no-ops,
 *             which is the failure mode it exists to prevent, reproduced one level up.
 *   QUALITY — RMSE vs ground truth, frozen ÷ unfrozen. A ratio, so it isolates what freezing
 *             costs rather than re-measuring the noise the quality suite already gates.
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { compare } from '../lib/metrics.js';
import { decodeDataURL, exists, readPNG } from '../lib/png.js';
import { FREEZE_GATES, PATHS } from './config.js';

async function readJSON( filePath, fallback ) {

	try {

		return JSON.parse( await fs.readFile( filePath, 'utf-8' ) );

	} catch {

		return fallback;

	}

}

/**
 * @param {Object} bench - harness wrapper from browser.js
 * @param {Object} [options]
 * @param {boolean} [options.bless] - record the ratios instead of gating on them
 * @param {string[]} [options.only] - restrict to these scene ids
 * @param {function(string): void} [options.log]
 */
export async function runFreeze( bench, { bless = false, only, log = () => {} } = {} ) {

	const all = await bench.scenes();
	const wanted = only?.length
		? FREEZE_GATES.scenes.filter( ( id ) => only.includes( id ) )
		: FREEZE_GATES.scenes;

	const stored = await readJSON( PATHS.freeze, {} );
	const next = { ...stored };
	const results = [];

	for ( const id of wanted ) {

		const scene = all.find( ( s ) => s.id === id );
		if ( ! scene ) throw new Error( `freeze: unknown scene '${id}'` );

		const truthPath = path.join( PATHS.truth, `${id}.png` );
		log( `  ${id}` );

		if ( ! await exists( truthPath ) ) {

			results.push( {
				scene: id,
				pass: false,
				failures: [ 'no ground-truth reference on disk — run `npm run bench:bless`' ],
			} );
			continue;

		}

		const truth = await readPNG( truthPath );

		const arm = {
			threshold: FREEZE_GATES.testThreshold,
			stability: FREEZE_GATES.testStability,
		};

		// Unfrozen arm from THIS build rather than the stored golden: against a stale golden the
		// ratio would also absorb every unrelated render change since the last bless.
		await bench.loadScene( id );
		await bench.renderFreezeArm( scene.spp, { ...arm, freeze: false } );
		const plain = decodeDataURL( await bench.capturePNG() );

		await bench.loadScene( id );
		const { samples } = await bench.renderFreezeArm( scene.spp, { ...arm, freeze: true } );
		const frozen = decodeDataURL( await bench.capturePNG() );

		// Leaves the engine non-deterministic; the next suite in a composite run must not
		// inherit that.
		await bench.loadScene( id );

		const diff = compare( frozen, plain, { threshold: 0.01 } );
		const engagedFraction = diff.fractionOverThreshold;
		const engaged = engagedFraction >= FREEZE_GATES.minEngagedFraction;
		const plainRmse = compare( plain, truth ).rmse;
		const frozenRmse = compare( frozen, truth ).rmse;
		const ratio = plainRmse > 0 ? frozenRmse / plainRmse : NaN;

		if ( bless ) {

			// Refuse to record a value the gate would reject anyway — a blessed-in breakage
			// becomes the permanent floor, which is how a ratchet stops being a gate.
			if ( ! engaged ) {

				throw new Error(
					`freeze: refusing to bless '${id}' — only ${( engagedFraction * 100 ).toFixed( 3 )} % ` +
					`of pixels moved (need ${( FREEZE_GATES.minEngagedFraction * 100 ).toFixed( 1 )} %), ` +
					'so the freeze path did not execute and the rung would be hollow.'
				);

			}

			if ( ! ( ratio <= FREEZE_GATES.maxAbsoluteRatio ) ) {

				throw new Error(
					`freeze: refusing to bless '${id}' at ratio ${ratio.toFixed( 4 )} — above the ` +
					`${FREEZE_GATES.maxAbsoluteRatio} sanity ceiling, so freeze is already broken here.`
				);

			}

			next[ id ] = { ratio, plainRmse, frozenRmse, samples, engagedFraction };
			results.push( { scene: id, blessed: true, ratio, samples, engaged, engagedFraction } );
			continue;

		}

		const entry = {
			scene: id, pass: true, failures: [], ratio, samples, engaged, engagedFraction, frozenRmse,
		};

		if ( ! engaged ) {

			entry.pass = false;
			entry.failures.push(
				`HOLLOW: only ${( engagedFraction * 100 ).toFixed( 3 )} % of pixels differ between the ` +
				`frozen and unfrozen arms (need ${( FREEZE_GATES.minEngagedFraction * 100 ).toFixed( 1 )} %), ` +
				'so no pixel was frozen. Either the freeze path stopped executing, or the test ' +
				'threshold no longer reaches it — this rung measures nothing until that is fixed.'
			);

		}

		if ( ! ( ratio <= FREEZE_GATES.maxAbsoluteRatio ) ) {

			entry.pass = false;
			entry.failures.push(
				`FREEZE QUALITY: RMSE vs truth is ${ratio.toFixed( 3 )}x the unfrozen arm, ` +
				`over the absolute ceiling of ${FREEZE_GATES.maxAbsoluteRatio}x`
			);

		}

		const baseline = stored[ id ]?.ratio;

		if ( typeof baseline !== 'number' ) {

			// Bootstrapping here would record whatever this run happens to measure and call it
			// the floor, so a first run on a broken build would gate future runs against the
			// breakage. Baselines move only under --bless.
			entry.pass = false;
			entry.failures.push( 'no blessed ratio for this scene — run `npm run bench:bless`' );

		} else {

			const increase = ( ratio - baseline ) / baseline;
			entry.increase = increase;

			if ( increase > FREEZE_GATES.maxRatioIncrease ) {

				entry.pass = false;
				entry.failures.push(
					`FREEZE REGRESSION: ratio worsened ${( increase * 100 ).toFixed( 2 )} % ` +
					`(${baseline.toFixed( 4 )} → ${ratio.toFixed( 4 )}); freezing pixels now costs ` +
					'more image quality than it did'
				);

			}

		}

		results.push( entry );

	}

	if ( bless ) {

		await fs.mkdir( path.dirname( PATHS.freeze ), { recursive: true } );
		await fs.writeFile( PATHS.freeze, `${JSON.stringify( next, null, '\t' )}\n` );

	}

	return { results };

}
