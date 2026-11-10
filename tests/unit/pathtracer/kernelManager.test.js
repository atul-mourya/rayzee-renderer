import { describe, it, expect, vi } from 'vitest';
import { KernelManager } from '@/core/pathtracer/KernelManager.js';

const managerWith = ( workgroupSize, limit = 65535 ) => {

	const km = new KernelManager( { backend: { device: { limits: { maxComputeWorkgroupsPerDimension: limit } } } } );
	const node = { workgroupSize };
	km.kernels.set( 'k', node );
	return { km, node };

};

describe( 'KernelManager.setDispatchForCount', () => {

	it( 'keeps a grid within the limit in one row', () => {

		const { km, node } = managerWith( [ 256, 1, 1 ] );
		km.setDispatchForCount( 'k', 2048 * 2048 );
		expect( node.dispatchSize ).toEqual( [ 16384, 1, 1 ] );

	} );

	it( 'spills a 4096² full-frame grid into rows instead of passing the per-dimension limit', () => {

		const { km, node } = managerWith( [ 256, 1, 1 ] );
		km.setDispatchForCount( 'k', 4096 * 4096 );
		const [ x, y ] = node.dispatchSize;
		expect( x ).toBeLessThanOrEqual( 65535 );
		expect( x * y * 256 ).toBeGreaterThanOrEqual( 4096 * 4096 );

	} );

	it( 'reads the limit from the device', () => {

		const { km, node } = managerWith( [ 64, 1, 1 ], 1000 );
		km.setDispatchForCount( 'k', 64 * 2500 );
		expect( node.dispatchSize ).toEqual( [ 1000, 3, 1 ] );

	} );

} );

describe( 'KernelManager.dispatch', () => {

	it( 'sizes a kernel from the GPU\'s counts on the node itself, and puts its grid back', () => {

		const calls = [];
		const km = new KernelManager( { compute: ( ...args ) => calls.push( [ args.length, args[ 0 ].dispatchSize ] ) } );
		const node = { workgroupSize: [ 64, 1, 1 ], dispatchSize: [ 8, 1, 1 ] };
		const counts = { isIndirectStorageBufferAttribute: true };
		km.register( 'k', node );
		km.setIndirect( [ 'k' ], counts );
		km.dispatch( 'k' );
		km.setIndirect( [ 'k' ], null );
		km.dispatch( 'k' );
		// r187 throws on a second argument for a node with a grid of its own.
		expect( calls ).toEqual( [[ 1, counts ], [ 1, [ 8, 1, 1 ]]] );
		expect( node.dispatchSize ).toEqual( [ 8, 1, 1 ] );

	} );

} );

describe( 'KernelManager bookkeeping', () => {

	const renderer = () => {

		const r = { computed: [], compiled: [] };
		r.compute = node => r.computed.push( node );
		r.compileComputeAsync = async node => void r.compiled.push( node );
		return r;

	};

	it( 'refuses an unknown kernel, and puts the grid back when a dispatch throws', () => {

		const r = renderer();
		const km = new KernelManager( r );
		expect( () => km.dispatch( 'nope' ) ).toThrow( /Unknown kernel 'nope'/ );

		const node = { workgroupSize: [ 64, 1, 1 ], dispatchSize: [ 4, 1, 1 ] };
		km.register( 'k', node );
		km.setIndirect( [ 'k' ], { isIndirectStorageBufferAttribute: true } );
		r.compute = () => {

			throw new Error( 'device lost' );

		};

		expect( () => km.dispatch( 'k' ) ).toThrow( 'device lost' );
		expect( node.dispatchSize ).toEqual( [ 4, 1, 1 ] );

	} );

	it( 'compiles the eager kernels ahead, so their first dispatch is not timed as a compile', async () => {

		const r = renderer();
		const km = new KernelManager( r );
		const [ a, b, lazy ] = [ { name: 'a' }, { name: 'b' }, { name: 'lazy' } ];
		km.register( 'a', a );
		km.register( 'b', b );
		km.register( 'lazy', lazy, { eager: false } );
		await km.compile();
		expect( r.compiled ).toEqual( [ a, b ] );
		expect( Object.fromEntries( Object.entries( km.getTimingReport() ).map( ( [ k, v ] ) => [ k, v.compiledOnce ] ) ) ).toEqual( { a: true, b: true, lazy: false } );

		km.dispatch( 'a' );
		km.dispatch( 'lazy' );
		expect( km._firstDispatches.map( d => d.name ) ).toEqual( [ 'lazy' ] );
		expect( km.getTimingReport().lazy.compiledOnce ).toBe( true );
		km.dispose();

	} );

	it( 'gathers one frame\'s first dispatches into one report on the next task', async () => {

		vi.useFakeTimers();
		try {

			const km = new KernelManager( renderer() );
			for ( const name of [ 'x', 'y', 'z' ] ) km.register( name, { name } );
			for ( const name of [ 'x', 'y', 'z' ] ) km.dispatch( name );
			expect( km._firstDispatches ).toHaveLength( 3 );
			const flush = vi.spyOn( km, '_flushFirstDispatches' );
			vi.runAllTimers();
			expect( flush ).toHaveBeenCalledTimes( 1 );
			expect( km._firstDispatches ).toEqual( [] );

			// A second dispatch of each is no compile.
			for ( const name of [ 'x', 'y', 'z' ] ) km.dispatch( name );
			expect( km._firstDispatches ).toEqual( [] );

		} finally {

			vi.useRealTimers();

		}

	} );

	it( 'profiles CPU submission per kernel while asked, slowest first, with a total', () => {

		const r = renderer();
		const km = new KernelManager( r );
		km.register( 'fast', { name: 'fast' } );
		km.register( 'slow', { name: 'slow' } );
		km.dispatch( 'fast' );
		km.dispatch( 'slow' );

		let clock = 0;
		const now = vi.spyOn( performance, 'now' ).mockImplementation( () => clock );
		r.compute = node => void ( clock += node.name === 'slow' ? 3 : 1 );
		km.enableProfiling( true );
		km.dispatch( 'fast' );
		km.dispatch( 'slow' );
		km.dispatch( 'slow' );
		expect( km.getProfileReport() ).toEqual( [
			{ name: 'slow', calls: 2, totalMs: 6, avgMs: 3 },
			{ name: 'fast', calls: 1, totalMs: 1, avgMs: 1 },
			{ name: 'TOTAL', calls: 3, totalMs: 7, avgMs: null },
		] );

		// Turning it on again starts afresh; off, nothing is counted.
		km.enableProfiling( true );
		expect( km.getProfileReport() ).toEqual( [ { name: 'TOTAL', calls: 0, totalMs: 0, avgMs: null } ] );
		km.enableProfiling( false );
		km.dispatch( 'fast' );
		expect( km.profile.size ).toBe( 0 );
		now.mockRestore();

	} );

	it( 'sizes a 2D kernel from its own workgroup, and leaves unknown names alone', () => {

		const km = new KernelManager( renderer() );
		const node = { workgroupSize: [ 16, 8, 1 ] };
		km.register( 'grid', node );
		km.setDispatchForGrid( 'grid', 1920, 1081 );
		expect( node.dispatchSize ).toEqual( [ 120, 136, 1 ] );
		expect( () => km.setDispatchForGrid( 'nope', 1, 1 ) ).not.toThrow();
		expect( () => km.setDispatchForCount( 'nope', 1 ) ).not.toThrow();
		expect( [ km.has( 'grid' ), km.has( 'nope' ), km.get( 'grid' ) ] ).toEqual( [ true, false, node ] );

	} );

	it( 'hands out copies of its timing, and forgets everything on dispose, the pending report too', () => {

		vi.useFakeTimers();
		try {

			const km = new KernelManager( renderer() );
			km.register( 'k', { name: 'k' } );
			km.setIndirect( [ 'k' ], { isIndirectStorageBufferAttribute: true } );
			km.dispatch( 'k' );
			const report = km.getTimingReport();
			report.k.compiledOnce = false;
			expect( km.getTimingReport().k.compiledOnce ).toBe( true );

			const flush = vi.spyOn( km, '_flushFirstDispatches' );
			km.dispose();
			vi.runAllTimers();
			expect( flush ).not.toHaveBeenCalled();
			expect( [ km.kernels.size, km.timing.size, km.profile.size, km._indirect.size, km._firstDispatches.length ] ).toEqual( [ 0, 0, 0, 0, 0 ] );

		} finally {

			vi.useRealTimers();

		}

	} );

} );
