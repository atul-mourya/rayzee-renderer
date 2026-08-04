/**
 * KernelManager.js
 *
 * Builds, caches, and dispatches individual compute nodes for the wavefront
 * path tracing pipeline. Each kernel is a separate `Fn().compute()` node.
 *
 * Dispatch grids are derived from each node's own `workgroupSize`, so the divisor can never
 * drift from the size the kernel was compiled with — see `setDispatchForCount`.
 */

import { createLogger, fmt } from '../utils/Logger.js';

const log = createLogger( 'wavefront' );

export class KernelManager {

	/**
	 * @param {WebGPURenderer} renderer - Three.js WebGPU renderer
	 */
	constructor( renderer ) {

		/**
		 * @type {WebGPURenderer}
		 */
		this.renderer = renderer;

		/**
		 * Map of kernel name → ComputeNode.
		 * @type {Map<string, ComputeNode>}
		 */
		this.kernels = new Map();

		/**
		 * Timing data for performance profiling.
		 * @type {Map<string, {compiledOnce: boolean, lastDispatchMs: number}>}
		 */
		this.timing = new Map();

		/**
		 * Optional per-kernel CPU-side submission timing (encode/dispatch cost only;
		 * does NOT measure GPU execution time). Toggle via enableProfiling().
		 * @type {boolean}
		 */
		this.profiling = false;

		/**
		 * Aggregated profile: kernel name → { calls, totalMs }.
		 * @type {Map<string, {calls: number, totalMs: number}>}
		 */
		this.profile = new Map();

		/**
		 * First-dispatch (shader compilation) timings, buffered so a build reports
		 * one line instead of one per kernel. See _recordFirstDispatch.
		 * @type {Array<{name: string, ms: number}>}
		 */
		this._firstDispatches = [];
		this._firstDispatchFlush = null;

	}

	/**
	 * Buffers a kernel's first-dispatch cost and flushes the batch on the next macrotask,
	 * so the kernels compiled during one frame collapse into a single summary line.
	 */
	_recordFirstDispatch( name, ms ) {

		this._firstDispatches.push( { name, ms } );

		clearTimeout( this._firstDispatchFlush );
		this._firstDispatchFlush = setTimeout( () => this._flushFirstDispatches(), 0 );

	}

	_flushFirstDispatches() {

		const batch = this._firstDispatches;
		this._firstDispatches = [];
		this._firstDispatchFlush = null;
		if ( batch.length === 0 ) return;

		const total = batch.reduce( ( sum, k ) => sum + k.ms, 0 );
		const slowest = [ ...batch ].sort( ( a, b ) => b.ms - a.ms );

		log.info( fmt.list( [
			`${batch.length} kernel${batch.length === 1 ? '' : 's'} compiled in ${fmt.ms( total )}`,
			`slowest ${slowest.slice( 0, 2 ).map( k => `${k.name} ${fmt.ms( k.ms )}` ).join( ', ' )}`,
		] ) );

		batch.forEach( k => log.debug( `kernel '${k.name}' first dispatch (incl. compilation) ${fmt.ms( k.ms )}` ) );

	}

	/**
	 * Register a pre-built compute node.
	 * @param {string} name - Kernel name (e.g. 'generate', 'extend')
	 * @param {ComputeNode} computeNode - Built via `Fn().compute([dx,dy,dz], [wgx,wgy,wgz])`
	 */
	register( name, computeNode ) {

		this.kernels.set( name, computeNode );
		this.timing.set( name, { compiledOnce: false, lastDispatchMs: 0 } );

	}

	/**
	 * Dispatch a kernel by name.
	 * @param {string} name - Kernel name
	 */
	dispatch( name ) {

		const node = this.kernels.get( name );

		if ( ! node ) {

			throw new Error( `KernelManager: Unknown kernel '${name}'` );

		}

		const timingEntry = this.timing.get( name );

		if ( timingEntry && ! timingEntry.compiledOnce ) {

			const t0 = performance.now();
			this.renderer.compute( node );
			const t1 = performance.now();
			timingEntry.compiledOnce = true;
			timingEntry.lastDispatchMs = t1 - t0;
			this._recordFirstDispatch( name, t1 - t0 );

		} else if ( this.profiling ) {

			const t0 = performance.now();
			this.renderer.compute( node );
			const t1 = performance.now();
			let p = this.profile.get( name );
			if ( ! p ) {

				p = { calls: 0, totalMs: 0 };
				this.profile.set( name, p );

			}

			p.calls ++;
			p.totalMs += t1 - t0;

		} else {

			this.renderer.compute( node );

		}

	}

	/**
	 * Size a 1D kernel's grid to cover `count` items, deriving the divisor from the workgroup size the
	 * kernel was actually registered with. Extend/Shade bound on ENTERING_COUNT rather than on the grid,
	 * so an under-sized grid silently drops the tail of the active list — never hardcode the divisor.
	 * @param {string} name - Kernel name
	 * @param {number} count - Number of items to cover
	 */
	setDispatchForCount( name, count ) {

		const node = this.kernels.get( name );
		if ( ! node ) return;
		node.dispatchSize = [ Math.ceil( count / node.workgroupSize[ 0 ] ), 1, 1 ];

	}

	/**
	 * Size a 2D screen-space kernel's grid, deriving both divisors from the registered workgroup size.
	 * @param {string} name - Kernel name
	 * @param {number} width - Width in pixels
	 * @param {number} height - Height in pixels
	 */
	setDispatchForGrid( name, width, height ) {

		const node = this.kernels.get( name );
		if ( ! node ) return;
		const wg = node.workgroupSize;
		node.dispatchSize = [ Math.ceil( width / wg[ 0 ] ), Math.ceil( height / wg[ 1 ] ), 1 ];

	}

	/**
	 * Check if a kernel has been registered.
	 * @param {string} name
	 * @returns {boolean}
	 */
	has( name ) {

		return this.kernels.has( name );

	}

	/**
	 * Get the underlying compute node.
	 * @param {string} name
	 * @returns {ComputeNode|undefined}
	 */
	get( name ) {

		return this.kernels.get( name );

	}

	/**
	 * Get first-dispatch compilation timing for all kernels.
	 * @returns {Object} name → { compiledOnce, lastDispatchMs }
	 */
	getTimingReport() {

		const report = {};

		for ( const [ name, data ] of this.timing ) {

			report[ name ] = { ...data };

		}

		return report;

	}

	/**
	 * Toggle per-kernel CPU-submission profiling. Measures only encode/dispatch
	 * cost on CPU (GPU work is async and NOT included).
	 * @param {boolean} enabled
	 */
	enableProfiling( enabled ) {

		this.profiling = enabled;
		if ( enabled ) this.profile.clear();

	}

	/**
	 * Get accumulated profiling data.
	 * @returns {Object} name → { calls, totalMs, avgMs }
	 */
	getProfileReport() {

		const rows = [];
		let sum = 0;
		for ( const [ name, { calls, totalMs } ] of this.profile ) {

			sum += totalMs;
			rows.push( { name, calls, totalMs: + totalMs.toFixed( 2 ), avgMs: + ( totalMs / calls ).toFixed( 3 ) } );

		}

		rows.sort( ( a, b ) => b.totalMs - a.totalMs );
		rows.push( { name: 'TOTAL', calls: rows.reduce( ( s, r ) => s + r.calls, 0 ), totalMs: + sum.toFixed( 2 ), avgMs: null } );
		return rows;

	}

	dispose() {

		clearTimeout( this._firstDispatchFlush );
		this._firstDispatchFlush = null;
		this._firstDispatches = [];
		this.kernels.clear();
		this.timing.clear();
		this.profile.clear();

	}

}
