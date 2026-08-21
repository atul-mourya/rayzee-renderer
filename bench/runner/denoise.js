/**
 * Real-time denoiser regression suite.
 *
 * Everything else in this bench measures the path tracer's own accumulation buffer. Nothing
 * measured what the denoisers did to it, so the entire ASVGF / EdgeAware chain was ungated —
 * and it shipped making a converged image ~4.7x further from ground truth than not denoising
 * at all, with every existing suite green.
 *
 * The gate is deliberately reference-free in the golden sense: for each scene and sample
 * count it renders TWICE, once with the denoiser off and once on, and compares each against
 * the ground truth this repo already keeps. The statistic is the ratio of the two RMSEs.
 *
 *     ratio = RMSE( denoised, truth ) / RMSE( raw, truth )
 *
 * Below 1 the denoiser helped. Above 1 it hurt. There is no image to bless, so there is no
 * way to re-bless a regression into looking fine — the raw render is re-measured every run,
 * on the same build, at the same sample count, so the comparison is self-normalising against
 * anything that changes the path tracer itself.
 *
 * Both renders go through `capturePNG`, which is the composited, tone-mapped output — what a
 * user actually sees. That costs sensitivity to pure energy shifts (tone mapping compresses
 * them), which is fine here: energy is the bias gate's job in quality.js. What survives tone
 * mapping is structure, and structure is exactly what a denoiser is accused of destroying.
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { compare } from '../lib/metrics.js';
import { decodeDataURL, exists, readPNG } from '../lib/png.js';
import { DENOISE_GATES, PATHS } from './config.js';

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

const key = ( sceneId, strategy, spp ) => `${sceneId}/${strategy}/${spp}`;

/**
 * @param {Object} bench - the harness wrapper from browser.js
 * @param {Object} [options]
 * @param {boolean} [options.bless] - record current ratios as the ratchet instead of comparing
 * @param {string[]} [options.only] - scene ids to restrict the run to
 * @param {function(string): void} [options.log]
 */
export async function runDenoise( bench, { bless = false, only, log = () => {} } = {} ) {

	// A denoised image compared against a golden-free ratio is still a comparison of two
	// renders, and both have to be reproducible or the ratio is noise.
	if ( await bench.isDeterministic() !== true ) {

		throw new Error(
			'engine is not in reproducible mode — the denoised/raw ratio would be noise. ' +
			'A perf pass may have left dispatch heuristics active.'
		);

	}

	const allScenes = await bench.scenes();
	const wanted = only?.length ? only : DENOISE_GATES.scenes;
	const scenes = allScenes.filter( ( s ) => wanted.includes( s.id ) );

	if ( ! scenes.length ) throw new Error( `no matching denoise scenes (asked for: ${wanted.join( ', ' )})` );

	const stored = await readJSON( PATHS.denoise, {} );
	const next = { ...stored };
	const results = [];
	const lowestSpp = Math.min( ...DENOISE_GATES.sppLadder );

	for ( const scene of scenes ) {

		const truthPath = path.join( PATHS.truth, `${scene.id}.png` );

		if ( ! await exists( truthPath ) ) {

			// Without a reference both sides of the ratio are unmeasurable. Reporting a pass
			// would claim denoiser coverage this scene does not have.
			results.push( {
				scene: scene.id, pass: false,
				failures: [ `no ground-truth reference for ${scene.id} — run \`npm run bench:bless\`` ],
			} );
			continue;

		}

		const truth = await readPNG( truthPath );

		log( `  ${scene.id}` );
		await bench.loadScene( scene.id );

		for ( const spp of DENOISE_GATES.sppLadder ) {

			// Raw baseline for this rung, measured on the SAME build in the SAME session. This
			// is what makes the ratio immune to path-tracer changes: a genuine sampling
			// improvement moves both numerator and denominator.
			const off = await bench.setDenoiser( 'none' );
			if ( off.asvgf || off.bilateral || off.edgeFilter || off.oidn ) {

				throw new Error( `setDenoiser('none') left stages enabled: ${JSON.stringify( off )}` );

			}

			await bench.render( spp );
			const rawRmse = compare( decodeDataURL( await bench.capturePNG() ), truth ).rmse;

			for ( const strategy of DENOISE_GATES.strategies ) {

				const name = strategy.label ?? strategy.id;
				const state = await bench.setDenoiser( strategy.id, strategy.preset, {
					tileCap: strategy.tileCap,
				} );

				// A typo'd strategy name hits the switch's default branch and silently leaves
				// every denoiser off — the suite would then compare raw against raw, report a
				// ratio of exactly 1.00, and pass forever.
				const anyEnabled = state.asvgf || state.bilateral || state.edgeFilter || state.oidn;
				if ( ! anyEnabled ) {

					throw new Error(
						`setDenoiser('${strategy.id}') enabled no stages — the strategy name is ` +
						`probably wrong. Got: ${JSON.stringify( state )}`
					);

				}

				// A dropped tile cap would quietly re-run the single-tile rung under a second
				// name, and the two would ratchet against each other forever.
				if ( strategy.tileCap && state.oidnTile !== strategy.tileCap ) {

					throw new Error(
						`${name}: tile cap ${strategy.tileCap} did not take effect — the live UNet ` +
						`is built for ${state.oidnTile}. The rung would measure the untiled path.`
					);

				}

				await bench.render( spp );
				// No-op unless the strategy is OIDN, which runs as a post-process and lands on its
				// own canvas rather than in the pipeline, so it is captured from there.
				const { ran } = await bench.awaitDenoise();
				const shot = ran ? await bench.captureDenoisedPNG() : await bench.capturePNG();
				const denoisedRmse = compare( decodeDataURL( shot ), truth ).rmse;
				const nonFinite = await bench.denoisedNonFinite();

				const id = key( scene.id, name, spp );
				const entry = {
					scene: scene.id, strategy: name, spp,
					rawRmse, denoisedRmse, nonFinite,
					pass: true, failures: [],
				};

				// A raw RMSE of zero means the render matched ground truth exactly, which at
				// these sample counts means something is wrong with the reference, not that the
				// renderer is perfect. Dividing by it would produce Infinity or NaN and read as
				// a spectacular regression.
				if ( ! ( rawRmse > 0 ) ) {

					entry.pass = false;
					entry.failures.push(
						`raw RMSE vs ground truth is ${rawRmse} — the ratio is undefined. The truth ` +
						'reference for this scene is probably stale or identical to the render.'
					);
					results.push( entry );
					continue;

				}

				const ratio = denoisedRmse / rawRmse;
				entry.ratio = ratio;

				if ( bless ) {

					next[ id ] = { ratio, rawRmse, denoisedRmse };
					entry.blessed = true;
					results.push( entry );
					continue;

				}

				if ( nonFinite > 0 ) {

					entry.pass = false;
					entry.failures.push(
						`${nonFinite} non-finite channels (NaN/Inf) in the denoiser output. ` +
						'probes() cannot see this — it only reads the path tracer buffer.'
					);

				}

				// ── absolute floor: must beat the raw image where it is designed to ──
				if ( spp === lowestSpp && ratio >= DENOISE_GATES.mustHelpAtLowSpp ) {

					entry.pass = false;
					entry.failures.push(
						`DENOISER INERT: at ${spp} spp the denoised image is ${( ( ratio - 1 ) * 100 ).toFixed( 1 )} % ` +
						`WORSE than not denoising (ratio ${ratio.toFixed( 3 )}, must be < ` +
						`${DENOISE_GATES.mustHelpAtLowSpp}). This is the regime the denoiser exists for; ` +
						'failing it means it is disconnected, mis-wired, or reading the wrong texture.'
					);

				}

				// ── ratchet: may only improve ──
				const blessedRatio = stored[ id ]?.ratio;

				if ( typeof blessedRatio !== 'number' ) {

					entry.pass = false;
					entry.failures.push(
						`no blessed ratio for ${id} — the denoiser ratchet cannot run. ` +
						'Run `npm run bench:bless`.'
					);

				} else if ( ratio > blessedRatio + DENOISE_GATES.maxRatioIncrease ) {

					entry.pass = false;
					entry.failures.push(
						`DENOISER REGRESSION: RMSE ratio vs ground truth worsened ` +
						`${blessedRatio.toFixed( 3 )} → ${ratio.toFixed( 3 )} ` +
						`(limit +${DENOISE_GATES.maxRatioIncrease}). The denoiser is moving the image ` +
						'further from truth than it did when this was blessed.'
					);

				}

				// Bootstrap only — never overwritten on a comparison run, or the ratchet would
				// track each regression down and never fire.
				next[ id ] = stored[ id ] ?? { ratio, rawRmse, denoisedRmse };
				results.push( entry );

			}

		}

	}

	// Leave the engine as every other suite expects to find it.
	await bench.setDenoiser( 'none' );

	await writeJSON( PATHS.denoise, next );

	return { results, passed: results.every( ( r ) => r.pass !== false ) };

}
