/**
 * Lockstep reproducibility: the production path rendered under several submission pacings must
 * produce the same sample count and the same linear accumulation, bit for bit. Every other suite
 * pins deterministic mode, so without this nothing tests that the shipping configuration — adaptive
 * sampling on — is reproducible, which is what a render farm needs.
 */

import { LOCKSTEP_GATES } from './config.js';

/**
 * @param {Object} bench - harness wrapper from browser.js
 * @param {Object} [options]
 * @param {string[]} [options.only] - restrict to these scene ids
 * @param {function(string): void} [options.log]
 */
export async function runLockstep( bench, { only, log = () => {} } = {} ) {

	const wanted = only?.length ? LOCKSTEP_GATES.scenes.filter( ( id ) => only.includes( id ) ) : LOCKSTEP_GATES.scenes;
	const results = [];

	for ( const id of wanted ) {

		log( `  ${id}` );
		const runs = [];

		for ( const pacing of LOCKSTEP_GATES.pacings ) {

			await bench.loadScene( id );
			runs.push( { label: pacing.label, ...await bench.renderLockstep( pacing ) } );

		}

		// Back to deterministic mode for whatever runs next.
		await bench.loadScene( id );

		const [ first ] = runs;
		const failures = runs
			.filter( ( run ) => run.hash !== first.hash || run.samples !== first.samples )
			.map( ( run ) => `NOT REPRODUCIBLE: '${run.label}' gave ${run.samples} spp / ${run.hash}, ` +
				`'${first.label}' gave ${first.samples} spp / ${first.hash}` );

		results.push( { scene: id, pass: failures.length === 0, failures, samples: first.samples, retiredBy: first.retiredBy, runs: runs.length } );

	}

	return { results };

}
