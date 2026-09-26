/**
 * Vitest environment with real WebGPU in Node, through Dawn — the implementation inside Chrome.
 *
 * When no adapter can be had, or on CI, the reason is left on `globalThis.__rayzeeGPUUnavailable`
 * and `tests/gpu/gpu.js` decides what that means.
 */

// Module scope on purpose: Dawn segfaults the process if this is collected while a device lives.
let gpu = null;
let globals = null;
let unavailable;

async function acquire() {

	// Unverified on a runner with no Vulkan driver, and a native crash there would fail the release.
	if ( process.env.CI ) {

		unavailable = 'not attempted on CI';
		return;

	}

	try {

		const dawn = await import( 'webgpu' );
		globals = dawn.globals;
		gpu = dawn.create( [] );
		unavailable = await gpu.requestAdapter() ? null : 'no WebGPU adapter';

	} catch ( error ) {

		unavailable = error.message;

	}

}

export default {
	name: 'webgpu',
	viteEnvironment: 'ssr',
	async setup( global ) {

		if ( unavailable === undefined ) await acquire();

		if ( globals ) {

			for ( const [ key, value ] of Object.entries( globals ) ) if ( ! ( key in global ) ) global[ key ] = value;
			Object.defineProperty( global.navigator, 'gpu', { value: gpu, configurable: true } );

		}

		// WebGPURenderer.init() starts its animation loop on `self`.
		global.self ??= global;
		global.requestAnimationFrame ??= ( callback ) => setTimeout( () => callback( performance.now() ), 16 ).unref();
		global.cancelAnimationFrame ??= clearTimeout;

		global.__rayzeeGPUUnavailable = unavailable;
		return { teardown() {} };

	},
};
