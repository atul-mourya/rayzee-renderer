/**
 * Bench harness entry — a React-free boot of the engine that exposes `window.__bench`
 * for the Node runner to drive over CDP.
 *
 * Why this exists instead of driving the real app: `app/index.html` boots the whole React
 * UI and immediately downloads a ~3.6 MB default model from a remote host. Neither is
 * wanted in a regression run.
 */

import { configureAssets, PathTracerApp } from 'rayzee';
import { getScene, RENDER_SIZE, SCENES } from './scenes.js';

import stbnScalarAtlas from '../assets/noise/stbn_scalar_atlas.png?url';
import stbnVec2Atlas from '../assets/noise/stbn_vec2_atlas.png?url';

// The engine defaults these to assets.rayzee.atulmourya.com. Point them at the byte-identical
// copies committed under bench/assets/ instead: a reproducibility gate whose reference inputs
// live on a mutable CDN is not reproducible — a re-encode there would silently invalidate every
// golden in the repo, and an outage or an offline machine would stop the suite entirely.
configureAssets( { stbnScalarAtlas, stbnVec2Atlas } );

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

async function boot() {

	app = new PathTracerApp( canvas, { autoResize: false } );
	await app.init();

	app.setCanvasSize( RENDER_SIZE.width, RENDER_SIZE.height );
	app.setDeterministicMode( true );
	app.enableGPUTiming( true );

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

	return {
		vendor: adapter?.info?.vendor ?? 'unknown',
		architecture: adapter?.info?.architecture ?? 'unknown',
		maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage ?? 0,
		maxStorageTexturesPerShaderStage: limits.maxStorageTexturesPerShaderStage ?? 0,
		maxBufferSize: limits.maxBufferSize ?? 0,
		deviceMemory: navigator.deviceMemory ?? null,
		renderSize: `${RENDER_SIZE.width}x${RENDER_SIZE.height}`,
	};

}

async function loadScene( id ) {

	const spec = getScene( id );

	// Deterministic baseline first, then the scene's own overrides. Batched so the
	// accumulation reset happens once rather than per key.
	//
	// Every key ANY scene touches is rewritten on every load, falling back to the pristine
	// boot value. Applying only this scene's own keys would let a previous scene's settings
	// leak forward (cornell-emissive enables emissive-triangle sampling; the scenes after it
	// would silently inherit that), making results depend on scene order — so `--only X`
	// would disagree with a full run and fail against its own golden.
	app.settings.setMany( { ...sceneSettingsFloor(), ...BASE_SETTINGS, ...spec.settings }, { silent: true } );

	const startedAt = performance.now();
	await spec.build( app );
	const loadMs = performance.now() - startedAt;

	// build() → loadObject3D() → reset() → wake(). Re-assert determinism and park rAF so
	// nothing races the manual render loop — preserving the current dispatch mode, since a
	// hard-coded default here would cancel setPerfMode() for every scene in a perf run.
	app.setDeterministicMode( true, { pinDispatch: ! perfModeEnabled } );

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

/** Composited, tone-mapped output as a PNG data URL — what a human would see. */
function capturePNG() {

	const out = app.getCanvas();
	if ( ! out ) throw new Error( '__bench.capturePNG: no canvas' );
	return out.toDataURL( 'image/png' );

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

	const pool = app.stages.pathTracer.storageTextures;
	const { width, height } = RENDER_SIZE;

	const pixels = await app.renderer.readRenderTargetPixelsAsync(
		pool.readTarget, 0, 0, width, height, 0
	);

	let sumR = 0, sumG = 0, sumB = 0, sumLum = 0, maxLum = 0, nonFinite = 0;
	const count = width * height;

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
	setPerfMode,
	isDeterministic: () => app.isDeterministic,
	capturePNG,
	probes,
	memory,
	resetPeakMemory,
	unload,
	gpuTimings: () => app.getGPUTimings(),
	frameCount: () => app.getFrameCount(),
	statistics: () => app.getStatistics(),
};

ready.catch( ( error ) => {

	globalThis.__benchBootError = String( error?.stack || error );

} );
