/**
 * DLSS super-resolution regression suite.
 *
 * The final-render upscaler trades traced pixels for a neural reconstruction: it renders at half
 * the output size, denoises, and reconstructs. Two things can rot independently, so both are
 * measured:
 *
 *  - **accuracy** — RMSE against the same scene traced natively at full size, in the same session
 *    on the same build. Reference-free in the golden sense, like `denoise.js`: a path-tracer change
 *    moves both sides, so the comparison cannot be re-blessed into looking fine.
 *  - **detail** — mean neighbour delta. Accuracy alone cannot catch the failure that matters here,
 *    because a blurry upscale scores *well* on RMSE against a denoised reference. The measured
 *    regression this guards is the network silently degrading to something bilinear-shaped, which
 *    shows up only as lost detail.
 *
 * ⚠️ Opt-in, and deliberately not part of `npm run bench`: it fetches a ~3.5 MB model over the
 * network. A regression suite that needs the internet to be green is a suite people stop trusting.
 */

import path from 'node:path';
import fs from 'node:fs/promises';

import { decodeDataURL } from '../lib/png.js';
import { UPSCALE_GATES, PATHS } from './config.js';

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

/** RMSE between two decoded PNGs of equal size, over RGB. */
function rmse( a, b ) {

	if ( a.width !== b.width || a.height !== b.height ) {

		throw new Error( `size mismatch: ${a.width}x${a.height} vs ${b.width}x${b.height}` );

	}

	let sum = 0;
	let n = 0;
	for ( let i = 0; i < a.width * a.height; i ++ ) {

		for ( let c = 0; c < 3; c ++ ) {

			const d = a.data[ i * 4 + c ] - b.data[ i * 4 + c ];
			sum += d * d;
			n ++;

		}

	}

	return Math.sqrt( sum / n );

}

/** Mean absolute neighbour difference on luma — a blur-sensitive detail proxy. */
function detail( img ) {

	const { data, width, height } = img;
	const luma = ( x, y ) => {

		const i = ( y * width + x ) * 4;
		return 0.2125 * data[ i ] + 0.7154 * data[ i + 1 ] + 0.0721 * data[ i + 2 ];

	};

	let total = 0;
	let n = 0;
	for ( let y = 1; y < height - 1; y += 2 ) {

		for ( let x = 1; x < width - 1; x += 2 ) {

			const c = luma( x, y );
			total += Math.abs( luma( x + 1, y ) - c ) + Math.abs( luma( x, y + 1 ) - c );
			n += 2;

		}

	}

	return total / n;

}

const key = ( sceneId, size ) => `${sceneId}/${size}`;

/**
 * @param {Object} bench harness wrapper from browser.js
 * @param {Object} [options]
 * @param {boolean} [options.bless] record current numbers as the baseline instead of comparing
 * @param {string[]} [options.only] scene ids to restrict the run to
 * @param {function(string): void} [options.log]
 */
export async function runUpscale( bench, { bless = false, only, log = () => {} } = {} ) {

	if ( await bench.isDeterministic() !== true ) {

		throw new Error(
			'engine is not in reproducible mode — the upscaled/native comparison would be noise.'
		);

	}

	const allScenes = await bench.scenes();
	const wanted = only?.length ? only : UPSCALE_GATES.scenes;
	const scenes = allScenes.filter( ( s ) => wanted.includes( s.id ) );

	if ( ! scenes.length ) throw new Error( `no matching upscale scenes (asked for: ${wanted.join( ', ' )})` );

	const stored = await readJSON( PATHS.upscale, {} );
	const next = { ...stored };
	const results = [];

	// The upscale reads back display bytes from a WGSL copy of the engine's tone curve. Nothing in
	// the unit suite can check that copy — vitest has no GPU — so it is checked here, before any
	// image is measured. A drift would move every RMSE below and read as a model regression.
	{

		const entry = { scene: 'tone-map', size: 'gpu vs cpu', pass: true, failures: [] };
		const findings = await bench.toneMapParity();
		const worst = findings.reduce( ( a, b ) => ( b.maxDelta > a.maxDelta ? b : a ) );

		if ( worst.maxDelta > UPSCALE_GATES.maxToneMapDelta ) {

			entry.pass = false;
			entry.failures.push(
				`GPU tone curve differs from ToneMapCPU by ${worst.maxDelta} levels on ${worst.curve} ` +
				`(exposure ${worst.exposure}, saturation ${worst.saturation}) — ` +
				`allowed ${UPSCALE_GATES.maxToneMapDelta}`
			);

		}

		entry.toneMapDelta = worst.maxDelta;
		log( `  tone map  worst ${worst.maxDelta} level(s) on ${worst.curve}  ${entry.pass ? 'ok' : 'FAIL'}` );
		results.push( entry );

	}

	try {

		for ( const scene of scenes ) {

			log( `  ${scene.id}` );
			await bench.loadScene( scene.id );

			for ( const [ outW, outH ] of UPSCALE_GATES.sizes ) {

				const label = `${outW}x${outH}`;
				const spp = UPSCALE_GATES.samples;
				const entry = { scene: scene.id, size: label, spp, pass: true, failures: [] };

				// The upscaler needs a denoised source; on raw Monte-Carlo noise it measurably loses to
				// bilinear, so running this rung without OIDN would gate the wrong thing.
				await bench.setDenoiser( 'oidn', 'high' );

				let upscaled;
				try {

					upscaled = await bench.upscaleRender( { outputWidth: outW, outputHeight: outH, samples: spp } );

				} catch ( e ) {

					entry.pass = false;
					entry.failures.push( `upscale failed: ${e.message}` );
					results.push( entry );
					continue;

				}

				// Native reference at the same size, same build, same session.
				const applied = await bench.setRenderSize( outW, outH );
				if ( applied.width !== outW || applied.height !== outH ) {

					entry.pass = false;
					entry.failures.push(
						`engine clamped the reference render to ${applied.width}x${applied.height} — ` +
					'the comparison would be against a different image'
					);
					results.push( entry );
					continue;

				}

				await bench.render( spp );
				await bench.awaitDenoise();
				const native = decodeDataURL( await bench.captureDenoisedPNG( { width: outW, height: outH } ) );

				const shot = decodeDataURL( upscaled.dataURL );
				entry.rmse = rmse( shot, native );
				entry.detail = detail( shot );
				entry.nativeDetail = detail( native );
				entry.detailRatio = entry.detail / entry.nativeDetail;
				entry.upscaleMs = upscaled.timings.upscale;

				const id = key( scene.id, label );
				const baseline = stored[ id ];

				if ( bless ) {

					// Only record a rung that actually produced numbers — blessing a failure would
					// write `undefined` and make every later run compare against nothing.
					if ( Number.isFinite( entry.rmse ) && Number.isFinite( entry.detailRatio ) ) {

						next[ id ] = { rmse: entry.rmse, detailRatio: entry.detailRatio };

					}

				} else if ( ! baseline ) {

					entry.pass = false;
					entry.failures.push( `no baseline for ${id} — run with --bless` );

				} else {

					if ( entry.rmse > baseline.rmse + UPSCALE_GATES.maxRmseIncrease ) {

						entry.pass = false;
						entry.failures.push(
							`RMSE ${entry.rmse.toFixed( 3 )} exceeds baseline ${baseline.rmse.toFixed( 3 )} ` +
						`by more than ${UPSCALE_GATES.maxRmseIncrease}`
						);

					}

					// Detail may not quietly drain away. This is the direction RMSE rewards, so it
					// needs its own floor or a blur regression would read as an improvement.
					if ( entry.detailRatio < baseline.detailRatio - UPSCALE_GATES.maxDetailLoss ) {

						entry.pass = false;
						entry.failures.push(
							`detail ratio ${entry.detailRatio.toFixed( 3 )} fell below baseline ` +
						`${baseline.detailRatio.toFixed( 3 )} by more than ${UPSCALE_GATES.maxDetailLoss} — ` +
						'the reconstruction is getting blurrier'
						);

					}

				}

				log(
					`    ${label}  rmse ${entry.rmse.toFixed( 3 )}  detail ${entry.detailRatio.toFixed( 3 )}x native` +
				`  upscale ${entry.upscaleMs.toFixed( 0 )}ms  ${entry.pass ? 'ok' : 'FAIL'}`
				);
				results.push( entry );

			}

		}

	} finally {

		// The model holds its own GPUDevice. Left alive, the harness teardown at the end of the run
		// times out over CDP — after every rung has already passed, which reads as a suite failure
		// with nothing wrong.
		await bench.disposeUpscaler();

	}

	if ( bless ) await writeJSON( PATHS.upscale, next );

	return { results, pass: results.every( ( r ) => r.pass ) };

}
