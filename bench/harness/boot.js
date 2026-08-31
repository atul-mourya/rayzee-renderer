/**
 * Bench harness entry — a React-free boot of the engine that exposes `window.__bench`
 * for the Node runner to drive over CDP.
 *
 * Why this exists instead of driving the real app: `app/index.html` boots the whole React
 * UI and immediately downloads a ~3.6 MB default model from a remote host. Neither is
 * wanted in a regression run.
 *
 * Setup and readback go through `openHeadless()` / `renderToBuffer()` — the same entry point
 * a render farm uses, so a bug in either is visible to both. Everything else here is
 * bench-only measurement.
 */

import {
	clearBindingAuditFindings, configureAssets, ENGINE_DEFAULTS, getBindingAuditFindings,
	openHeadless, setBindingAudit,
} from 'rayzee';
import { getScene, RENDER_SIZE, SCENES } from './scenes.js';

import stbnScalarAtlas from '../assets/noise/stbn_scalar_atlas.png?url';
import stbnVec2Atlas from '../assets/noise/stbn_vec2_atlas.png?url';

// The engine defaults these to assets.rayzee.atulmourya.com. Point them at the byte-identical
// copies committed under bench/assets/ instead: a reproducibility gate whose reference inputs
// live on a mutable CDN is not reproducible — a re-encode there would silently invalidate every
// golden in the repo, and an outage or an offline machine would stop the suite entirely.
configureAssets( { stbnScalarAtlas, stbnVec2Atlas } );

// three.js creates shader modules with no error scope, so WGSL failures reach the console only as
// `[object GPUValidationError]`. Wrap at the device to keep the source for line-accurate reporting.
const shaderModules = [];

if ( typeof GPUDevice !== 'undefined' ) {

	const create = GPUDevice.prototype.createShaderModule;

	GPUDevice.prototype.createShaderModule = function ( descriptor ) {

		const record = { label: descriptor.label ?? '(unlabelled)', code: descriptor.code ?? '', module: null };
		record.module = create.call( this, descriptor );
		shaderModules.push( record );
		return record.module;

	};

}

/** Queried lazily: Dawn returns no messages if called in the same tick as `createShaderModule`. */
async function shaderDiagnostics() {

	const entries = [];

	for ( const { label, code, module } of shaderModules ) {

		const info = await module.getCompilationInfo().catch( () => null );
		if ( ! info ) continue;

		const lines = code.split( '\n' );

		for ( const m of info.messages ) {

			if ( m.type !== 'error' ) continue;

			entries.push( {
				label, message: m.message, lineNum: m.lineNum, linePos: m.linePos,
				source: m.lineNum > 0 && m.lineNum <= lines.length ? lines[ m.lineNum - 1 ].trim().slice( 0, 300 ) : '',
			} );

		}

	}

	return { modules: shaderModules.map( ( r ) => r.label ), entries };

}

const canvas = document.getElementById( 'bench-canvas' );

/** Scene settings applied on top of the deterministic baseline, restored on the next load. */
const BASE_SETTINGS = {
	// Effectively off: the clamp suppresses converged bright pixels and would mask exactly
	// the energy regressions the bias probe exists to catch.
	fireflyThreshold: 1e9,
	visMode: 0,
};
// Denoisers are deliberately absent above — enableOIDN/enableASVGF are ENGINE_DEFAULTS
// keys with no SETTING_ROUTES entry, so writing them through settings silently does
// nothing but pollute getAll(). Both already default off.

let app = null;
let currentScene = null;
let pristineSettings = null;
let pristineEnvParams = null;

// Sticky across scene loads. loadScene() re-asserts deterministic mode, and without
// remembering the requested mode it would default back to pinDispatch:true and silently
// undo setPerfMode( true ) on the very first scene of a perf run.
let perfModeEnabled = false;

/** Union of every settings key any scene overrides, at its pristine boot value. */
function sceneSettingsFloor() {

	const floor = {};

	for ( const scene of SCENES ) {

		for ( const key of Object.keys( scene.settings ?? {} ) ) {

			floor[ key ] = pristineSettings[ key ];

		}

	}

	return floor;

}

/**
 * Environment parameters are NOT settings keys — scenes mutate `envParams` directly (the
 * furnace scenes write `solidSkyColor = white`), so `sceneSettingsFloor()` cannot restore
 * them and the mutation leaks into every later scene that calls `setMode( 'color' )`.
 * cornell-emissive's backdrop swung +16 % depending on how many scenes had loaded first.
 * Same argument as the settings floor: restore the union, not just this scene's own keys.
 */
function restoreEnvParams() {

	const env = app.stages.pathTracer.environment;

	for ( const [ key, value ] of Object.entries( pristineEnvParams ) ) {

		if ( value && typeof value.copy === 'function' ) env.envParams[ key ].copy( value );
		else env.envParams[ key ] = value;

	}

}

function snapshotEnvParams() {

	const snapshot = {};

	for ( const [ key, value ] of Object.entries( app.stages.pathTracer.environment.envParams ) ) {

		snapshot[ key ] = value && typeof value.clone === 'function' ? value.clone() : value;

	}

	return snapshot;

}

async function boot() {

	// Both options are load-bearing: openHeadless prefers 'physical', which would change every
	// golden; and strict would abort the run before the runner reports. loadScene() asserts
	// app.issueErrors instead.
	app = await openHeadless( {
		canvas,
		width: RENDER_SIZE.width,
		height: RENDER_SIZE.height,
		strict: false,
		profile: 'viewer',
		deterministic: true,
	} );

	app.enableGPUTiming( true );

	// Structural guard, not a metric: reports stages whose TextureNodes are bound too late to
	// be safe from binding aliasing. Costs one boolean test per stage per frame. See
	// rayzee/src/Pipeline/BindingAudit.js.
	setBindingAudit( true );

	// Vendored locally (see configureAssets above), but still asserted: if an atlas fails to
	// load the sampler silently falls back to a constant-0.5 placeholder and renders converge
	// to a different image — which would look like a regression, or worse, get blessed as one.
	const stage = app.stages.pathTracer;
	await stage.blueNoiseReady;
	if ( ! stage.stbnScalarTexture || ! stage.stbnVec2Texture ) {

		throw new Error(
			'bench: STBN atlases failed to load — renders would use the 0.5 placeholder and ' +
			'baselines would be meaningless. Check bench/assets/noise/ is present.'
		);

	}

	// Snapshot before any scene touches settings, so each load can restore the keys it
	// does not itself specify.
	pristineSettings = app.settings.getAll();
	pristineEnvParams = snapshotEnvParams();

	globalThis.app = app; // parity with the real app's dev-console handle
	return app;

}

/**
 * Adapter identity + the limits that steer machine-dependent code paths. Baselines are
 * only comparable within one fingerprint: _computePathBudget() reads device limits and
 * navigator.deviceMemory to pick the chunk count, and single- vs multi-chunk take
 * materially different paths through the wavefront.
 */
async function fingerprint() {

	const adapter = await navigator.gpu.requestAdapter( { powerPreference: 'high-performance' } );
	const limits = adapter?.limits ?? {};

	// Identity from the adapter that actually rendered; limits from here (adapterInfo lacks
	// them). Do NOT add keys: fingerprintMismatch() diffs every key, so one mismatches all
	// stored baselines until re-blessed.
	return {
		vendor: app?.adapterInfo?.vendor || adapter?.info?.vendor || 'unknown',
		architecture: app?.adapterInfo?.architecture || adapter?.info?.architecture || 'unknown',
		maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage ?? 0,
		maxStorageTexturesPerShaderStage: limits.maxStorageTexturesPerShaderStage ?? 0,
		maxBufferSize: limits.maxBufferSize ?? 0,
		deviceMemory: navigator.deviceMemory ?? null,
		renderSize: `${RENDER_SIZE.width}x${RENDER_SIZE.height}`,
	};

}

/** Fails a half-load: a scene missing its textures still renders, and the suite would bless it. */
function assertLoadedCleanly( what ) {

	const errors = app.issueErrors;
	if ( errors.length === 0 ) return;

	throw new Error(
		`bench: ${what} degraded — ${errors.length} issue(s): ` +
		errors.map( ( e ) => `${e.code} (${e.message})` ).join( '; ' )
	);

}

async function loadScene( id ) {

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
	app.settings.setMany( { ...sceneSettingsFloor(), ...BASE_SETTINGS, ...spec.settings }, { silent: true } );
	restoreEnvParams();

	const startedAt = performance.now();
	await spec.build( app );
	const loadMs = performance.now() - startedAt;

	// Denoiser strategy is sticky across loads and is NOT a settings key, so it cannot ride
	// the sceneSettingsFloor reset above. Without this a denoise run would leave ASVGF on for
	// every scene the quality suite loaded afterwards, and its goldens would silently be
	// denoised images.
	app.denoisingManager.setStrategy( 'none' );

	// build() → loadObject3D() → reset() → wake(). Re-assert determinism and park rAF so
	// nothing races the manual render loop — preserving the current dispatch mode, since a
	// hard-coded default here would cancel setPerfMode() for every scene in a perf run.
	app.setDeterministicMode( true, { pinDispatch: ! perfModeEnabled } );

	assertLoadedCleanly( `scene "${spec.id}"` );

	currentScene = spec;
	return { id: spec.id, spp: spec.spp, truthSpp: spec.truthSpp, loadMs };

}

async function render( spp, options = {} ) {

	if ( ! currentScene ) throw new Error( '__bench.render: no scene loaded' );

	const samples = spp ?? currentScene.spp;
	const startedAt = performance.now();
	const accumulated = await app.renderFrames( samples, options );

	return { samples: accumulated, wallMs: performance.now() - startedAt };

}

/**
 * GPU milliseconds for a SINGLE sample, measured one sample at a time.
 *
 * Timestamp queries report the last resolved frame, so resolving once after an N-sample
 * render yields whichever frame happened to land last — not the average, and not even
 * reliably a full frame. Rendering exactly one sample and resolving immediately makes the
 * reading unambiguous.
 *
 * @param {number} count - number of single-sample measurements
 * @returns {Promise<number[]>} per-sample GPU ms
 */
async function measureGPUPerSample( count ) {

	const samples = [];

	for ( let i = 0; i < count; i ++ ) {

		// reset:false accumulates one more sample onto the existing buffer, avoiding a
		// per-measurement reset; yieldEvery:0 keeps a setTimeout out of the measurement.
		await app.renderFrames( 1, { reset: false, yieldEvery: 0 } );
		const timings = await app.getGPUTimings();
		if ( timings ) samples.push( timings.total );

	}

	return samples;

}

/**
 * Per-kernel GPU ms, one reading per rendered sample.
 *
 * Same one-sample-then-resolve discipline as measureGPUPerSample: timestamps report the last
 * resolved frame, so anything larger makes the reading ambiguous.
 *
 * @param {number} count - number of single-sample measurements
 * @returns {Promise<Array<{kernels: Object<string, number>, total: number, unattributed: number}>>}
 */
async function measureKernelGPU( count ) {

	const readings = [];

	for ( let i = 0; i < count; i ++ ) {

		await app.renderFrames( 1, { reset: false, yieldEvery: 0 } );
		const timings = await app.getKernelGPUTimings();
		if ( timings ) readings.push( timings );

	}

	return readings;

}

/**
 * Override the path tracer's render size for timing runs.
 *
 * The corpus renders at RENDER_SIZE (256²) so goldens stay cheap, but at that size the wavefront's
 * fixed per-bounce cost dominates and traversal work is nearly invisible — a kernel profile has to
 * run where the frame is actually compute-bound. Timing-only: nothing in this mode captures pixels,
 * and probes()/capturePNG() still assume RENDER_SIZE, so do not mix this with the image suites.
 *
 * @param {number} width
 * @param {number} height
 * @returns {{width: number, height: number}} the size actually applied after engine clamping
 */
function setRenderSize( width, height ) {

	app.setCanvasSize( width, height );
	app.reset();
	app.stopAnimation();

	const stage = app.stages.pathTracer;
	return {
		width: stage._wfRenderWidth?.value ?? width,
		height: stage._wfRenderHeight?.value ?? height,
	};

}

/**
 * Re-enable the two readback-driven heuristics that deterministic mode turns off, and re-arm
 * accumulation. Also usable as a between-rounds reset.
 *
 * loadScene calls setDeterministicMode( true ), which forces useAdaptiveSampling and usePixelFreeze
 * OFF unconditionally — `pinDispatch: false` does not bring them back. Both are ON in every shipping
 * render config, and they select a DIFFERENT set of kernels: the freeze path dispatches
 * resetFrameCounters + buildActivePixels + seedEnter + generateList, while initActiveIndices never
 * runs at all. Profiling without them measures kernels production never dispatches and hides ones it
 * does — so a profile taken this way is the only one that speaks to shipping cost.
 *
 * Non-stationary by construction: frozen pixels accumulate, so per-sample cost falls through a run.
 * Read the numbers as "cost with a full active set", and reset between rounds.
 *
 * @param {boolean} enabled
 */
function setShippingHeuristics( enabled ) {

	app.settings.setMany(
		{ useAdaptiveSampling: enabled, usePixelFreeze: enabled },
		{ silent: true }
	);
	// reset() re-wakes rAF, which would race the manual render loop.
	app.reset();
	app.stopAnimation();

}

/**
 * Renders one arm of the Tier-2 freeze comparison: identical in every respect except whether
 * `usePixelFreeze` is on. The freeze path is otherwise unreachable from here — loadScene pins
 * deterministic mode, and that clears usePixelFreeze.
 *
 * Both arms leave deterministic mode, because the readback-driven dispatch heuristics come back
 * with it and they change the image on their own. Comparing a frozen render against a
 * DETERMINISTIC one therefore measures those heuristics, not freeze: a seeded fault that disabled
 * freeze entirely still "differed" from the deterministic render and passed. Freeze has to be the
 * only variable between the two arms, so both arms run non-deterministic.
 *
 * The frame-level early stop is pinned unreachable rather than left live: it retires the frame at
 * a sample count that varies run to run, which would confound "freeze broke" with "this run
 * stopped sooner".
 *
 * `threshold`/`stability` default to the SHIPPING values, at which freeze is measurably inert on
 * every corpus scene (0.00 % of pixels move). The suite deliberately loosens them — see
 * FREEZE_GATES.testThreshold. This is a code-path test, not a production-fidelity one, in the
 * same spirit as BASE_SETTINGS pinning fireflyThreshold to 1e9.
 *
 * Leaves freeze settings applied — reload a scene to restore the deterministic baseline.
 */
async function renderFreezeArm( spp, { freeze, threshold, stability } = {} ) {

	if ( ! currentScene ) throw new Error( '__bench.renderFreezeArm: no scene loaded' );

	// Deterministic mode STAYS ON. It pins the readback-driven dispatch heuristics, and leaving
	// those live moves the image by up to 12 % of pixels between two identical runs — which
	// drowns freeze's own signal completely (measured: a seeded fault that disabled freeze
	// entirely still "moved" 4-13 % of pixels and passed). It clears usePixelFreeze as a side
	// effect; re-arm it below. The dispatch pins are stage fields, not settings, so they survive.
	app.setDeterministicMode( true );
	app.settings.setMany( {
		useAdaptiveSampling: !! freeze, // the freeze streak is stamped inside the convergence block
		usePixelFreeze: !! freeze,
		pixelFreezeThreshold: threshold ?? ENGINE_DEFAULTS.pixelFreezeThreshold,
		pixelFreezeStability: stability ?? ENGINE_DEFAULTS.pixelFreezeStability,
		adaptiveStopFraction: 1.1, // > 1: no converged fraction can reach it
	}, { silent: true } );

	const samples = await app.renderFrames( spp ?? currentScene.spp );
	return { samples };

}

/** Apply arbitrary settings for an ablation, then re-arm accumulation. */
function setSettings( values ) {

	app.settings.setMany( values, { silent: true } );
	app.reset();
	app.stopAnimation();

}

/** Read at kernel-build time, so this only takes effect on the NEXT model load. */
function setSortMaterials( enabled ) {

	ENGINE_DEFAULTS.wavefrontSortMaterials = enabled;

}

/**
 * Recompile the wavefront kernels without reloading the model. TSL module-scope state is read at
 * kernel-build time, and reaching it via loadModelScene would rebuild the BVH too — orders of
 * magnitude slower per ablation config.
 */
function rebuildKernels() {

	const stage = app.stages.pathTracer;
	stage._kernelManager?.dispose();
	stage._wavefrontReady = false;
	stage._buildWavefrontKernels();
	app.reset();
	app.stopAnimation();
	return stage._wavefrontReady === true;

}

/** BVH builder config; takes effect on the next load, when the BLASes are rebuilt. */
function setSceneConfig( config ) {

	app.stages.pathTracer.sdfs?.updateConfig( config );

}

/**
 * Per-mesh triangle counts, bucketed against the treelet thresholds: skipped below 1000 triangles,
 * dropped to size 3 above `treeletComplexityThreshold`. Coverage follows the mesh-size
 * distribution, not the scene total.
 */
function meshStats() {

	const counts = ( app.sceneMeshes ?? [] ).map( ( mesh ) => {

		const geom = mesh.geometry;
		return ( geom?.index ? geom.index.count : geom?.attributes?.position?.count ?? 0 ) / 3;

	} );

	const bucket = ( lo, hi ) => {

		const inRange = counts.filter( ( c ) => c >= lo && c < hi );
		return { meshes: inRange.length, tris: inRange.reduce( ( s, c ) => s + c, 0 ) };

	};

	return {
		total: { meshes: counts.length, tris: counts.reduce( ( s, c ) => s + c, 0 ) },
		belowTreeletMin: bucket( 0, 1000 ),
		optimized: bucket( 1000, 50000 ),
		degraded: bucket( 50000, Infinity ),
		largest: counts.slice().sort( ( a, b ) => b - a ).slice( 0, 5 ),
	};

}

/**
 * Load an arbitrary GLB for timing only — no golden exists, so no image suite can reach it. Corpus
 * scenes are procedural primitives with few materials; their kernel shares do not transfer to real
 * content, so conclusions drawn only from the corpus need checking against a model.
 *
 * setCameras() selects index 0, the engine default camera, which for an interior is usually outside
 * the geometry — prefer an authored one.
 *
 * A GLB carries no environment, and the black placeholder is not a neutral default: env NEE is
 * deterministic (a shadow ray every bounce), but a black env gives envTotalSum 0 ⇒ envPdf 0, so the
 * ray never fires and a profile silently omits the whole site.
 *
 * @param {string} url - served path, e.g. /models/foo.glb
 * @param {number} [cameraIndex=1] - index into cameraManager.cameras; falls back to 0 if absent
 * @param {'procedural'|'gradient'|'color'|'hdri'|'none'} [env='procedural'] - 'none' keeps the placeholder
 */
async function loadModelScene( url, cameraIndex = 1, env = 'procedural' ) {

	app.clearIssues();
	app.settings.setMany( { ...sceneSettingsFloor(), ...BASE_SETTINGS }, { silent: true } );
	restoreEnvParams();

	const startedAt = performance.now();
	await app.loadModel( url );
	const loadMs = performance.now() - startedAt;

	// After the model: setMode builds the sky and its importance-sampling CDF.
	if ( env && env !== 'none' ) await app.stages.pathTracer.environment.setMode( env );

	app.denoisingManager.setStrategy( 'none' );

	const cameras = app.cameraManager?.cameras ?? [];
	const picked = cameraIndex > 0 && cameraIndex < cameras.length ? cameraIndex : 0;
	if ( picked > 0 ) app.cameraManager.switchCamera( picked );

	app.setDeterministicMode( true, { pinDispatch: ! perfModeEnabled } );

	assertLoadedCleanly( `model "${url}"` );

	// render() gates on currentScene; a minimal stand-in is enough for a timing-only run.
	currentScene = { id: `model:${url}`, spp: 1, truthSpp: 1, settings: {} };

	const stage = app.stages.pathTracer;
	return {
		id: currentScene.id,
		loadMs,
		cameraCount: cameras.length,
		camera: picked,
		env: env ?? 'none',
		envTotalSum: stage.uniforms.get( 'envTotalSum' )?.value ?? null,
		meshes: app.sceneMeshes?.length ?? null,
		materials: stage?.materialData?.materialCount ?? null,
		triangles: stage?.triangleCount ?? null,
	};

}

/** Composited, tone-mapped output as a PNG data URL — what a human would see. */
function capturePNG() {

	const out = app.getCanvas();
	if ( ! out ) throw new Error( '__bench.capturePNG: no canvas' );
	return out.toDataURL( 'image/png' );

}

/** Reference stays in-page — a full RGBA-float frame is far too big to move over CDP. */
let _referenceBuffer = null;

async function readLinear() {

	// Live stage size, so this is safe under setRenderSize() — unlike capturePNG().
	const { data } = await app.renderToBuffer( { colorSpace: 'linear' } );
	return data;

}

/** Store the current buffer as ground truth for rmseVsReference(). */
async function snapshotReference() {

	_referenceBuffer = await readLinear();
	return _referenceBuffer.length / 4;

}

/**
 * RMSE of the current buffer against the snapshot, over linear RGB. Also returns relative RMSE
 * (normalised by the reference mean) so scenes at different exposures stay comparable.
 */
async function rmseVsReference() {

	if ( ! _referenceBuffer ) throw new Error( 'bench: snapshotReference() was never called' );

	const pixels = await readLinear();
	let se = 0, refSum = 0, n = 0;

	for ( let i = 0; i < _referenceBuffer.length; i += 4 ) {

		for ( let c = 0; c < 3; c ++ ) {

			const a = pixels[ i + c ], b = _referenceBuffer[ i + c ];
			if ( ! Number.isFinite( a ) || ! Number.isFinite( b ) ) continue;
			se += ( a - b ) * ( a - b );
			refSum += b;
			n ++;

		}

	}

	const rmse = Math.sqrt( se / n );
	return { rmse, relRmse: rmse / ( refSum / n ), samples: app.getFrameCount() };

}

/**
 * Scalar probes read from the LINEAR HDR accumulation buffer, not the canvas.
 *
 * This is the bias signal. The PNG is tone-mapped and 8-bit, so a few-percent energy
 * error — a missing 4π, a clamp eating light, a broken MIS weight — is compressed away
 * by ACES before it reaches the pixels. The MRT read target is FloatType RGBA and holds
 * the untouched radiance.
 */
async function probes() {

	const pixels = await readLinear();

	let sumR = 0, sumG = 0, sumB = 0, sumLum = 0, maxLum = 0, nonFinite = 0;
	const count = pixels.length / 4;

	for ( let i = 0; i < count; i ++ ) {

		const r = pixels[ i * 4 ];
		const g = pixels[ i * 4 + 1 ];
		const b = pixels[ i * 4 + 2 ];

		if ( ! Number.isFinite( r ) || ! Number.isFinite( g ) || ! Number.isFinite( b ) ) {

			nonFinite ++;
			continue;

		}

		sumR += r;
		sumG += g;
		sumB += b;

		// Rec. 709 luminance.
		const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		sumLum += lum;
		if ( lum > maxLum ) maxLum = lum;

	}

	return {
		meanR: sumR / count,
		meanG: sumG / count,
		meanB: sumB / count,
		meanLuminance: sumLum / count,
		maxLuminance: maxLum,
		nonFinite, // NaN/Inf leaking into the buffer is always a bug
		samples: app.getFrameCount(),
	};

}

/**
 * Switches the real-time denoiser. 'none' | 'asvgf' | 'edgeaware'.
 *
 * Returns the resulting stage enable-state so a suite can assert the strategy actually took
 * effect rather than trusting the call — a typo'd name hits the switch's default branch and
 * silently leaves every denoiser off, which would make the whole suite compare raw against
 * raw and pass forever.
 */
async function setDenoiser( strategy, preset, options = {} ) {

	const dm = app.denoisingManager;

	// setDenoiserStrategy has no 'oidn' case and does not clear it, so an earlier 'oidn' rung
	// would stay on underneath asvgf/edgeaware — both denoisers at once, which never ships.
	dm.setOIDNEnabled( false );

	if ( strategy === 'oidn' ) {

		// No in-pipeline denoiser: OIDN is a post-process on the finished accumulation buffer.
		dm.setStrategy( 'none' );
		dm.setOIDNQuality( preset || 'high' );
		dm.setOIDNEnabled( true );

		// setOIDNQuality does not await updateQuality, and _setupUNetDenoiser early-returns
		// while a load is in flight — so a tile-cap change applied straight away is dropped and
		// the rung silently measures the previous configuration.
		await settleDenoiser();

		// Applied unconditionally: nothing else resets it, so an earlier tiled rung would leak
		// its cap into every rung after it — including into other scenes — and the untiled and
		// tiled rungs would report identical ratios under two different names. Restoring the
		// shipped default rather than a constant keeps the untiled rung measuring what ships.
		await dm.denoiser.updateConfiguration( { tileSize: options.tileCap ?? defaultOIDNTileCap() } );
		await settleDenoiser();

	} else {

		dm.setStrategy( strategy, preset );

	}

	const s = app.stages;
	return {
		strategy,
		asvgf: !! s.asvgf?.enabled,
		variance: !! s.variance?.enabled,
		bilateral: !! s.bilateralFilter?.enabled,
		edgeFilter: !! s.edgeFilter?.enabled,
		normalDepth: !! s.normalDepth?.enabled,
		motionVector: !! s.motionVector?.enabled,
		oidn: !! dm.denoiser?.enabled,
		// The tile edge actually baked into the live UNet, so a rung can assert it rather than
		// trust that the cap took effect.
		oidnTile: dm.denoiser?._activeTileSize ?? null,
	};

}

// The engine's own default cap, snapshotted before any rung overrides it. Not imported: it
// lives in OIDNDenoiser's private MODEL_CONFIG, and hardcoding it here would silently drift.
let _defaultOIDNTileCap = null;

function defaultOIDNTileCap() {

	if ( _defaultOIDNTileCap === null ) {

		_defaultOIDNTileCap = app.denoisingManager?.denoiser?.maxTileSize ?? 1024;

	}

	return _defaultOIDNTileCap;

}

/** Resolves once no UNet load is in flight, so a following config change is not dropped. */
async function settleDenoiser( timeoutMs = 180000 ) {

	const dn = app.denoisingManager?.denoiser;
	if ( ! dn ) return;

	const deadline = performance.now() + timeoutMs;
	while ( ( dn.state.isLoading || ! dn.unet ) && performance.now() < deadline ) {

		await new Promise( ( r ) => setTimeout( r, 30 ) );

	}

}

/**
 * Drives the OIDN denoise to completion. No-ops when OIDN is off, so the runner can call it
 * unconditionally. Started explicitly rather than waited for: the denoise normally fires off the
 * rAF completion chain, which renderFrames() has stopped.
 *
 * @param {number} [timeoutMs]
 */
async function awaitDenoise( timeoutMs = 120000 ) {

	const dn = app.denoisingManager?.denoiser;
	if ( ! dn?.enabled ) return { ran: false };

	const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );
	const deadline = performance.now() + timeoutMs;

	// Weights are fetched lazily on first enable (the _large blob is ~7.7 MB).
	while ( ! dn.unet && performance.now() < deadline ) await sleep( 50 );
	if ( ! dn.unet ) throw new Error( '__bench.awaitDenoise: UNet weights never loaded' );

	const started = await dn.start();
	while ( dn.state.isDenoising && performance.now() < deadline ) await sleep( 10 );

	if ( dn.state.isDenoising ) throw new Error( '__bench.awaitDenoise: denoise did not finish' );

	if ( started === false ) throw new Error( '__bench.awaitDenoise: denoiser refused to start' );

	return { ran: true };

}

/**
 * The denoiser's own output canvas as a PNG data URL. Deliberately NOT app.getCanvas(): that
 * returns the denoiser canvas only while the path tracer reports complete, and renderFrames()
 * leaves isComplete false — so it falls back to the un-denoised compositor and the suite compares
 * raw against raw for a flat ratio of 1.000.
 */
function captureDenoisedPNG() {

	const out = app.denoisingManager?.denoiser?.output;
	if ( ! out ) throw new Error( '__bench.captureDenoisedPNG: no denoiser output canvas' );

	if ( out.width !== RENDER_SIZE.width || out.height !== RENDER_SIZE.height ) {

		throw new Error(
			`__bench.captureDenoisedPNG: canvas is ${out.width}x${out.height}, ` +
			`expected ${RENDER_SIZE.width}x${RENDER_SIZE.height}`
		);

	}

	// A never-painted canvas is transparent and reads as black, scoring a plausible RMSE
	// against a dark reference instead of failing.
	const px = out.getContext( '2d' ).getImageData( 0, 0, out.width, out.height ).data;
	let opaque = 0;
	for ( let i = 3; i < px.length; i += 4 ) if ( px[ i ] > 0 ) opaque ++;
	if ( opaque === 0 ) throw new Error( '__bench.captureDenoisedPNG: canvas is blank' );

	return out.toDataURL( 'image/png' );

}

/**
 * Non-finite pixel count in whatever the compositor is about to display.
 *
 * `probes()` only sees the path tracer's accumulation buffer, so a denoiser emitting NaN is
 * invisible to it — a `pow(0.0, 0.0)` in the bilateral weight produced NaN on ~12 % of pixels
 * with nothing in the suite reacting. HalfFloat targets read back as raw Uint16 bit patterns,
 * so the exponent is tested directly rather than decoding to Number first.
 */
async function denoisedNonFinite() {

	const s = app.stages;
	const target = ( s.bilateralFilter?.enabled && s.bilateralFilter._outputTarget )
		|| ( s.edgeFilter?.enabled && s.edgeFilter._outputTarget )
		|| ( s.asvgf?.enabled && s.asvgf._outputRT )
		|| app.stages.pathTracer.storageTextures.readTarget;

	const { width, height } = RENDER_SIZE;
	const pixels = await app.renderer.readRenderTargetPixelsAsync( target, 0, 0, width, height, 0 );

	let nonFinite = 0;

	if ( pixels instanceof Uint16Array ) {

		// Half-float: exponent all-ones is Inf (mantissa 0) or NaN (mantissa nonzero).
		for ( let i = 0; i < pixels.length; i ++ ) {

			if ( ( pixels[ i ] & 0x7C00 ) === 0x7C00 ) nonFinite ++;

		}

	} else {

		for ( let i = 0; i < pixels.length; i ++ ) {

			if ( ! Number.isFinite( pixels[ i ] ) ) nonFinite ++;

		}

	}

	return nonFinite;

}

function memory() {

	const info = app.getMemoryInfo();
	return { current: info.current, peak: info.peak, byCategory: { ...info.byCategory } };

}

function resetPeakMemory() {

	const tracker = app.vram;
	if ( ! tracker ) return false;

	tracker.measure(); // resetPeak() drops peak to the LAST measured value, so measure first
	tracker.resetPeak();
	return true;

}

/**
 * Switches between reproducible mode (image comparison) and production-dispatch mode
 * (performance measurement).
 *
 * Perf must NOT run with the dispatch heuristics pinned: `_useDynamicDispatch` and the
 * per-bounce early exit are real shipping behaviour, and measuring with them disabled
 * hides any regression confined to them. Image comparison must run with them pinned,
 * because they consume async readbacks and destroy reproducibility.
 *
 * @param {boolean} enabled - true for perf measurement, false for image comparison
 * @returns {boolean} whether output is currently bit-reproducible
 */
function setPerfMode( enabled ) {

	perfModeEnabled = !! enabled;
	app.setDeterministicMode( true, { pinDispatch: ! perfModeEnabled } );
	return app.isDeterministic;

}

async function unload() {

	app.unloadScene();
	app.stopAnimation();
	currentScene = null;

}

// ── App lifecycle (create/dispose retention) ──────────────────────

/**
 * One throwaway PathTracerApp per cycle, on its own canvas, kept only as a WeakRef.
 *
 * Deliberately NOT the booted app's canvas: the constructor disposes whatever app already owns
 * the canvas it is handed, so reusing it would tear down the harness on the first cycle.
 */
const lifecycleRefs = [];
let lifecycleCanvas = null;

/**
 * Creates an app, builds a scene in it, renders, disposes it. The instance is retained only
 * through a WeakRef, so anything still holding it after a forced GC is a leak.
 *
 * @param {string} sceneId
 * @param {number} [spp] - samples per cycle; enough to force lazily-allocated stage resources
 * @returns {Promise<{totalMs: number}>}
 */
async function appLifecycleCycle( sceneId, spp = 1 ) {

	const spec = getScene( sceneId );

	if ( ! lifecycleCanvas ) {

		lifecycleCanvas = document.createElement( 'canvas' );
		lifecycleCanvas.style.position = 'absolute';
		lifecycleCanvas.style.left = '-9999px';
		document.body.appendChild( lifecycleCanvas );

	}

	const startedAt = performance.now();

	// Same construction path as boot(), so the leak gate covers what a farm actually runs.
	const throwaway = await openHeadless( {
		canvas: lifecycleCanvas,
		width: RENDER_SIZE.width,
		height: RENDER_SIZE.height,
		strict: false,
		profile: 'viewer',
		deterministic: true,
		settings: { ...sceneSettingsFloor(), ...BASE_SETTINGS, ...spec.settings },
	} );

	await spec.build( throwaway );
	throwaway.setDeterministicMode( true );
	await throwaway.renderFrames( spp );

	lifecycleRefs.push( new WeakRef( throwaway ) );
	throwaway.dispose();

	return { totalMs: performance.now() - startedAt };

}

/**
 * How many disposed apps are still strongly reachable. Read AFTER the runner forces a
 * collection over CDP — the page cannot trigger one itself.
 */
function appLifecycleLive() {

	return {
		total: lifecycleRefs.length,
		alive: lifecycleRefs.filter( ( ref ) => ref.deref() !== undefined ).length,
	};

}

/**
 * Post-GC reachable bytes for this realm, INCLUDING ArrayBuffer backing stores.
 *
 * The metric the create/dispose gate needs: `Runtime.getHeapUsage` excludes backing stores, and
 * the bytes a retained app holds are almost entirely typed arrays (material texture arrays,
 * triangle and BVH buffers) — so heap counters read flat while hundreds of MiB accumulate.
 * Requires cross-origin isolation, which the dev server's COOP/COEP headers provide.
 *
 * @returns {Promise<?{bytes: number}>} null if unavailable
 */
async function measureRealmMemory() {

	if ( ! globalThis.crossOriginIsolated || ! performance.measureUserAgentSpecificMemory ) return null;

	const { bytes } = await performance.measureUserAgentSpecificMemory();
	return { bytes };

}

const ready = boot();

globalThis.__bench = {
	ready,
	// Explicit field list — `build` is a function and cannot cross the CDP boundary, so the
	// whole spec cannot be returned. Any new field a runner gates on must be added here or it
	// arrives undefined and the gate silently does not run.
	scenes: () => SCENES.map( ( s ) => ( {
		id: s.id, covers: s.covers, spp: s.spp, truthSpp: s.truthSpp,
		furnaceRadiance: s.furnaceRadiance,
	} ) ),
	fingerprint,
	loadScene,
	render,
	measureGPUPerSample,
	measureKernelGPU,
	setRenderSize,
	setShippingHeuristics,
	renderFreezeArm,
	loadModelScene,
	setSettings,
	setSortMaterials,
	setSceneConfig,
	rebuildKernels,
	meshStats,
	setPerfMode,
	setDenoiser,
	awaitDenoise,
	captureDenoisedPNG,
	denoisedNonFinite,
	shaderDiagnostics,
	bindingFindings: () => getBindingAuditFindings(),
	clearBindingFindings: () => clearBindingAuditFindings(),
	isDeterministic: () => app.isDeterministic,
	capturePNG,
	probes,
	snapshotReference,
	rmseVsReference,
	memory,
	resetPeakMemory,
	issues: () => app.issues,
	adapter: () => app.adapterInfo,
	unload,
	appLifecycleCycle,
	appLifecycleLive,
	measureRealmMemory,
	gpuTimings: () => app.getGPUTimings(),
	frameCount: () => app.getFrameCount(),
	statistics: () => app.getStatistics(),
	// Adaptive-sampling telemetry: how many pixels the sparse tiers actually traced. Sourced from an
	// async counter readback, so it lags a frame or two and reads 0 until one lands — for anything
	// per-frame, read the counters buffer through __app instead.
	convergenceStats: () => app.getConvergenceStats(),
	// Escape hatch for ad-hoc diagnostics that need engine internals the typed API does not expose.
	// Suites should use the methods above; this is deliberately not part of the runner wrapper.
	__app: () => app,
};

ready.catch( ( error ) => {

	globalThis.__benchBootError = String( error?.stack || error );

} );
