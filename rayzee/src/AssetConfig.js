/**
 * Engine asset configuration. CDN URLs and cache namespaces are configurable so
 * downstream consumers aren't pinned to the upstream Rayzee deployment's defaults.
 *
 * Usage:
 *   import { configureAssets } from 'rayzee';
 *   configureAssets({
 *     dracoDecoderPath: '/draco/',
 *     cacheNamespace: 'my-app',
 *   });
 *
 * Call before constructing PathTracerApp. Per-key partial overrides are supported.
 */

const config = {
	// onnxruntime-web (loaded lazily by AI upscaler worker via dynamic import).
	ortRuntimeUrl: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/ort.webgpu.bundle.min.mjs',
	ortWasmPaths: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.3/dist/',

	// Draco / KTX2 decoder paths for GLTFLoader.
	dracoDecoderPath: 'https://www.gstatic.com/draco/v1/decoders/',
	ktx2TranscoderPath: 'https://cdn.jsdelivr.net/npm/three@0.183.2/examples/jsm/libs/basis/',

	// OIDN denoiser model weights (oidn-web tza files): the four tiers' models, mirrored from the
	// `denoiser` npm package 0.0.11 with their Apache-2.0 licence. Versioned so they cannot change underneath.
	oidnWeightsBaseUrl: 'https://assets.rayzee.atulmourya.com/oidn/denoiser-0.0.11/',

	// OpenColorIO WebAssembly runtime (~6 MB), needed only once a colour-managed config is
	// loaded. The engine never names the package: a bare specifier in engine source would make it
	// a hard dependency of every host, and @vite-ignore leaves the browser unable to resolve it.
	//
	//   configureAssets( { ocioRuntimeFactory: () => import( '@bb-studio/ocio' ) } )   // bundled
	//   configureAssets( { ocioRuntimeUrl: '/vendor/ocio/index.js' } )                 // served
	//
	ocioRuntimeFactory: null,
	ocioRuntimeUrl: null,
	// Only needed when a served runtime cannot find its own .wasm.
	ocioWasmUrl: null,

	// AI upscaler ONNX model base URL. Quality presets resolve relative paths against this.
	upscalerModelBaseUrl: 'https://huggingface.co/notaneimu/onnx-image-models/resolve/main/',

	// Neural post-pass runtime. A plain script the host serves, not a module: it installs
	// `globalThis.NeuralRuntime`, so it cannot be imported and the host must publish it somewhere.
	neuralRuntimeUrl: '/neural/neural-runtime.js',

	// Base for the neural weight manifests the runtime fetches (`generated/...` beneath this). No
	// default: the weights are not redistributable, so a host supplies its own copy.
	neuralAssetBaseUrl: null,

	// Prefix used when the engine writes to client-side stores (IndexedDB, etc).
	// Set to a unique value to avoid collisions when multiple apps embed the engine on the same origin.
	cacheNamespace: 'rayzee',

	// On-disk storage (origin private file system) under a directory named by cacheNamespace:
	// 'auto' uses it where the browser has one, false turns every storage feature off.
	storage: 'auto',
};

const configured = new Set();

/**
 * Override asset URLs and cache namespace. Partial — only provided keys are replaced.
 * @param {Partial<typeof config>} overrides
 */
export function configureAssets( overrides ) {

	if ( ! overrides ) return;
	Object.assign( config, overrides );
	for ( const key of Object.keys( overrides ) ) configured.add( key );

}

/** Whether a host set this key, as opposed to it being the default. */
export function isAssetConfigured( key ) {

	return configured.has( key );

}

/** Returns a snapshot of current asset config. */
export function getAssetConfig() {

	return { ...config };

}
