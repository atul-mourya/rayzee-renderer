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
 * @param {string} [options.sceneId] - defaults to the first scene in the corpus
 * @param {number} [options.cycles]
 * @param {function(string): void} [options.log]
 */
export async function runMemory( bench, { sceneId, cycles = MEMORY_GATES.leakCycles, log = () => {} } = {} ) {

	const scenes = await bench.scenes();
	const target = sceneId ?? scenes[ 0 ].id;

	const failures = [];
	const snapshots = [];

	const boot = await bench.memory();
	snapshots.push( { phase: 'boot', ...boot } );
	log( `  boot: ${formatBytes( boot.current )}` );

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
			`  cycle ${cycle + 1}: loaded ${formatBytes( loaded.current )}, ` +
			`unloaded ${formatBytes( unloaded.current )}, peak ${formatBytes( loaded.peak )}`
		);

	}

	// ── Gate 1: absolute peak growth across the run ──
	const firstPeak = cycleResults[ 0 ].peak;
	const lastPeak = cycleResults[ cycleResults.length - 1 ].peak;
	const peakGrowth = lastPeak - firstPeak;

	if ( peakGrowth > MEMORY_GATES.maxPeakGrowthBytes ) {

		failures.push(
			`LEAK: peak VRAM grew ${formatBytes( peakGrowth )} over ${cycles} identical cycles ` +
			`(limit ${formatBytes( MEMORY_GATES.maxPeakGrowthBytes )})`
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
				`LEAK: post-unload VRAM grew on every cycle (+${formatBytes( climb )} total) — ` +
				'monotonic growth across identical cycles is a leak, not lazy allocation'
			);

		}

	}

	return {
		scene: target,
		cycles: cycleResults,
		snapshots,
		peakGrowth,
		failures,
		passed: failures.length === 0,
	};

}
