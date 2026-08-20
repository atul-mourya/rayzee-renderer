/**
 * VRAM regression suite.
 *
 * The headline test is deliberately simple: load and unload the same scene N times and
 * assert peak VRAM does not climb. That single check would have caught at least three
 * bugs already in this repo's history (disabled-stage GPUTexture retention, the
 * TextureCache use-after-free, and the per-textured-swap GPUTexture leak).
 *
 * Everything here gates on DELTAS, never absolutes, because VRAMTracker's numbers are
 * approximate by construction:
 *   - texture bytes are JS-dimension estimates (no mips, no row-pitch padding, unknown
 *     formats default to 16 B/texel), so the absolute total over-reports;
 *   - buffers are counted unconditionally and never residency-probed, so freeing a GPU
 *     buffer produces no drop;
 *   - DenoisingManager, the AI upscaler, ViewOverlayRenderer and the swapchain are not
 *     registered at all.
 * Growth over identical cycles is still meaningful even when the absolute number is not.
 */

import { MEMORY_GATES } from './config.js';

const MIB = 1024 * 1024;

export function formatBytes( bytes ) {

	return `${( bytes / MIB ).toFixed( 1 )} MiB`;

}

/**
 * Runs the load/unload leak loop plus lifecycle snapshots.
 *
 * @param {Object} bench
 * @param {Object} [options]
 * @param {string} [options.sceneId] - one scene instead of MEMORY_GATES.leakScenes
 * @param {number} [options.cycles]
 * @param {function(string): void} [options.log]
 */
export async function runMemory( bench, { sceneId, cycles = MEMORY_GATES.leakCycles, log = () => {} } = {} ) {

	// Below 3, both gates are structurally inert: peak growth needs a before and an after
	// past the lazy-allocation cycle, and the monotonic test discards cycle 1 and then
	// needs at least two more to see a trend. Reporting "no leak detected" from 1 or 2
	// cycles would be a guarantee the run never actually made.
	if ( cycles < 3 ) {

		throw new Error( `memory: needs at least 3 cycles to detect growth, got ${cycles}` );

	}

	const corpus = await bench.scenes();
	const known = new Set( corpus.map( ( s ) => s.id ) );

	if ( sceneId && ! known.has( sceneId ) ) throw new Error( `memory: unknown scene "${sceneId}"` );

	const targets = sceneId ? [ sceneId ] : MEMORY_GATES.leakScenes;

	// A renamed scene must not silently reduce coverage: dropping it here would leave the
	// texture path untested while the run still reported "no leak detected".
	const missing = targets.filter( ( id ) => ! known.has( id ) );

	if ( missing.length ) {

		throw new Error(
			`memory: MEMORY_GATES.leakScenes references scenes not in the corpus: ${missing.join( ', ' )}`
		);

	}

	const failures = [];
	const snapshots = [];

	const boot = await bench.memory();
	snapshots.push( { phase: 'boot', ...boot } );
	log( `  boot: ${formatBytes( boot.current )}` );

	const perScene = [];

	for ( const target of targets ) {

		log( `  ${target}` );
		const cycleResults = [];

		for ( let cycle = 0; cycle < cycles; cycle ++ ) {

			// VRAMTracker.peak is a session-wide monotonic max, so without this every cycle
			// reports the same saturated number and the peak-growth gate is inert — which is
			// exactly what happened before: `npm run bench` runs quality first, saturating the
			// peak, and all five cycles then read identical values.
			await bench.resetPeakMemory();

			await bench.loadScene( target );

			// A few samples so lazily-allocated per-stage resources actually exist; several
			// categories report zero until their first dispatch.
			await bench.render( 2 );

			const loaded = await bench.memory();
			await bench.unload();
			const unloaded = await bench.memory();

			cycleResults.push( {
				cycle: cycle + 1,
				loaded: loaded.current,
				unloaded: unloaded.current,
				peak: loaded.peak,
			} );

			log(
				`    cycle ${cycle + 1}: loaded ${formatBytes( loaded.current )}, ` +
				`unloaded ${formatBytes( unloaded.current )}, peak ${formatBytes( loaded.peak )}`
			);

		}

		// ── Gate 1: absolute peak growth across the run ──
		const firstPeak = cycleResults[ 0 ].peak;
		const lastPeak = cycleResults[ cycleResults.length - 1 ].peak;
		const peakGrowth = lastPeak - firstPeak;

		if ( peakGrowth > MEMORY_GATES.maxPeakGrowthBytes ) {

			failures.push(
				`LEAK [${target}]: peak VRAM grew ${formatBytes( peakGrowth )} over ${cycles} ` +
				`identical cycles (limit ${formatBytes( MEMORY_GATES.maxPeakGrowthBytes )})`
			);

		}

		// ── Gate 2: monotonic climb, however small ──
		// A steady per-cycle increase is a leak even when each step is under the byte budget;
		// lazy allocation, the benign explanation, plateaus instead.
		if ( MEMORY_GATES.forbidMonotonicGrowth && cycleResults.length >= 3 ) {

			const steadyState = cycleResults.slice( 1 ); // cycle 1 legitimately allocates
			const alwaysGrew = steadyState.every(
				( entry, index ) => index === 0 || entry.unloaded > steadyState[ index - 1 ].unloaded
			);

			if ( alwaysGrew && steadyState.length >= 2 ) {

				const climb = steadyState[ steadyState.length - 1 ].unloaded - steadyState[ 0 ].unloaded;
				failures.push(
					`LEAK [${target}]: post-unload VRAM grew on every cycle (+${formatBytes( climb )} ` +
					'total) — monotonic growth across identical cycles is a leak, not lazy allocation'
				);

			}

		}

		perScene.push( { scene: target, cycles: cycleResults, peakGrowth } );

	}

	const lifecycle = await runAppLifecycle( bench, { log } );
	failures.push( ...lifecycle.failures );

	return {
		scenes: perScene,
		snapshots,
		lifecycle,
		failures,
		passed: failures.length === 0,
	};

}

/**
 * Create → load → render → dispose, N times in ONE page, asserting nothing survives.
 *
 * Two metrics, because they fail for different reasons:
 *  - `live` — disposed apps still strongly reachable after a forced collection. The direct
 *    statement of the bug, and machine-independent.
 *  - `reachable` — post-GC bytes for the realm from `measureUserAgentSpecificMemory()`, which
 *    unlike every heap counter INCLUDES ArrayBuffer backing stores. Needed because the retained
 *    bytes are typed arrays: the original report saw V8's heap grow 4 % while RSS grew 40 %, and
 *    concluded from that the leak was outside the object graph. It was not.
 *
 * @param {Object} bench
 * @param {Object} [options]
 * @param {number} [options.cycles]
 * @param {string} [options.sceneId]
 * @param {function(string): void} [options.log]
 */
export async function runAppLifecycle( bench, { cycles = MEMORY_GATES.lifecycleCycles, sceneId = MEMORY_GATES.lifecycleScene, log = () => {} } = {} ) {

	// Gate 2 is a slope, and cycle 1 is excluded from it, so below 4 it either cannot be
	// computed or rests on a single interval. Reporting "no leak detected" off that would be a
	// guarantee the run never made.
	if ( cycles < 4 ) {

		throw new Error( `memory: app lifecycle needs at least 4 cycles to detect growth, got ${cycles}` );

	}

	const failures = [];
	const cycleResults = [];

	log( `  app create/dispose (${sceneId})` );

	for ( let cycle = 0; cycle < cycles; cycle ++ ) {

		const timing = await bench.appLifecycleCycle( sceneId, 1 );

		// Both metrics read post-collection: WeakRefs stay populated until one runs, and freed
		// backing stores stay counted.
		await bench.collectGarbage();
		const live = await bench.appLifecycleLive();
		const reachable = await bench.measureRealmMemory();

		cycleResults.push( {
			cycle: cycle + 1,
			live: live.alive,
			disposed: live.total,
			reachable: reachable?.bytes ?? null,
			totalMs: timing.totalMs,
		} );

		log(
			`    cycle ${cycle + 1}: ${live.alive} of ${live.total} disposed apps still reachable, ` +
			`realm ${reachable ? formatBytes( reachable.bytes ) : 'unavailable'}`
		);

	}

	// ── Gate 1: nothing disposed may still be reachable ──
	const worst = cycleResults.reduce( ( a, b ) => ( b.live > a.live ? b : a ), cycleResults[ 0 ] );

	if ( worst.live > MEMORY_GATES.maxLiveDisposedApps ) {

		failures.push(
			`LEAK [app lifecycle]: ${worst.live} of ${worst.disposed} disposed PathTracerApps still ` +
			'reachable after a forced collection — a disposed app retains its triangle, BVH and ' +
			'texture buffers, so N renders in one page cost N times one'
		);

	}

	// ── Gate 2: realm bytes may not climb per cycle ──
	// Cycle 1 is excluded: module-level one-time allocations (STBN atlases, lazily imported
	// denoiser weights) legitimately land there and never repeat.
	const measured = cycleResults.filter( ( entry ) => entry.reachable !== null );

	if ( measured.length < cycles ) {

		// Silence here would read as a pass. The metric needs cross-origin isolation, and losing
		// it (a dev-server header change) would disable the only check that sees typed arrays.
		failures.push(
			'app lifecycle: measureUserAgentSpecificMemory() unavailable — the realm-bytes gate ' +
			'did not run. Requires cross-origin isolation (COOP/COEP on the dev server).'
		);

		return { cycles: cycleResults, perCycleGrowth: null, failures };

	}

	const steady = measured.slice( 1 );
	const perCycle = ( steady[ steady.length - 1 ].reachable - steady[ 0 ].reachable ) / ( steady.length - 1 );

	if ( perCycle > MEMORY_GATES.maxReachableGrowthBytesPerCycle ) {

		failures.push(
			`LEAK [app lifecycle]: reachable realm memory grew ${formatBytes( perCycle )} per ` +
			`create/dispose cycle over ${steady.length} cycles (limit ` +
			`${formatBytes( MEMORY_GATES.maxReachableGrowthBytesPerCycle )} — see MEMORY_GATES)`
		);

	}

	log( `    growth ${formatBytes( perCycle )} per cycle` );

	return { cycles: cycleResults, perCycleGrowth: perCycle, failures };

}
