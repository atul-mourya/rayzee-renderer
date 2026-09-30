/**
 * Loads corpus scenes into an app the same way wherever the bench runs: the browser harness and
 * the Node runner share this, so a scene cannot mean one thing in Chrome and another in Node.
 */

import { getScene, SCENES } from './scenes.js';

/** Scene settings applied on top of the deterministic baseline, restored on the next load. */
export const BASE_SETTINGS = {
	// Effectively off: the clamp suppresses converged bright pixels and would mask exactly
	// the energy regressions the bias probe exists to catch.
	fireflyThreshold: 1e9,
	visMode: 0,
};
// Denoisers are deliberately absent above — enableOIDN/enableASVGF are ENGINE_DEFAULTS
// keys with no SETTING_ROUTES entry, so writing them through settings silently does
// nothing but pollute getAll(). Both already default off.

function snapshotEnvParams( app ) {

	const snapshot = {};

	for ( const [ key, value ] of Object.entries( app.stages.pathTracer.environment.envParams ) ) {

		snapshot[ key ] = value && typeof value.clone === 'function' ? value.clone() : value;

	}

	return snapshot;

}

/**
 * Snapshots the app's settings and environment now, before any scene touches them, so each load
 * can restore the keys it does not itself specify.
 */
export function createSceneSession( app ) {

	const pristineSettings = app.settings.getAll();
	const pristineEnvParams = snapshotEnvParams( app );

	const session = {

		/** Union of every settings key any scene overrides, at its pristine boot value. */
		settingsFloor() {

			const floor = {};

			for ( const scene of SCENES ) {

				for ( const key of Object.keys( scene.settings ?? {} ) ) {

					floor[ key ] = pristineSettings[ key ];

				}

			}

			return floor;

		},

		/**
		 * Environment parameters are NOT settings keys — scenes mutate `envParams` directly (the
		 * furnace scenes write `solidSkyColor = white`), so `settingsFloor()` cannot restore
		 * them and the mutation leaks into every later scene that calls `setMode( 'color' )`.
		 * cornell-emissive's backdrop swung +16 % depending on how many scenes had loaded first.
		 * Same argument as the settings floor: restore the union, not just this scene's own keys.
		 */
		restoreEnvParams() {

			const env = app.stages.pathTracer.environment;

			for ( const [ key, value ] of Object.entries( pristineEnvParams ) ) {

				if ( value && typeof value.copy === 'function' ) env.envParams[ key ].copy( value );
				else env.envParams[ key ] = value;

			}

		},

		/** Fails a half-load: a scene missing its textures still renders, and the suite would bless it. */
		assertLoadedCleanly( what ) {

			const errors = app.issueErrors;
			if ( errors.length === 0 ) return;

			throw new Error(
				`bench: ${what} degraded — ${errors.length} issue(s): ` +
				errors.map( ( e ) => `${e.code} (${e.message})` ).join( '; ' )
			);

		},

		/** @returns {Promise<{spec: Object, loadMs: number}>} */
		async loadScene( id, { pinDispatch = true } = {} ) {

			const spec = getScene( id );

			app.clearIssues(); // else the first scene's issues fail every scene after it

			// Deterministic baseline first, then the scene's own overrides. Batched so the
			// accumulation reset happens once rather than per key.
			//
			// Every key ANY scene touches is rewritten on every load, falling back to the pristine
			// boot value. Applying only this scene's own keys would let a previous scene's settings
			// leak forward (cornell-emissive enables emissive-triangle sampling; the scenes after it
			// would silently inherit that), making results depend on scene order — so `--only X`
			// would disagree with a full run and fail against its own golden.
			app.settings.setMany( { ...session.settingsFloor(), ...BASE_SETTINGS, ...spec.settings }, { silent: true } );
			session.restoreEnvParams();

			const startedAt = performance.now();
			await spec.build( app );
			const loadMs = performance.now() - startedAt;

			// Denoiser strategy is sticky across loads and is NOT a settings key, so it cannot ride
			// the settingsFloor reset above. Without this a denoise run would leave ASVGF on for
			// every scene the quality suite loaded afterwards, and its goldens would silently be
			// denoised images.
			app.denoisingManager.setStrategy( 'none' );

			// build() → loadObject3D() → reset() → wake(). Re-assert determinism and park rAF so
			// nothing races the manual render loop. The caller passes the dispatch mode, since a
			// hard-coded default here would cancel a perf run's for every scene.
			app.setDeterministicMode( true, { pinDispatch } );

			session.assertLoadedCleanly( `scene "${spec.id}"` );

			return { spec, loadMs };

		},

	};

	return session;

}
