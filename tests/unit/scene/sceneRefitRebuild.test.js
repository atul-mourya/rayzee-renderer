import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// A deformed mesh's BLAS is rebuilt on a BVHWorker once refits stop; Vitest cannot bundle the worker, so a stand-in
// records each job and the test answers it.
const workers = [];
class StandInBVHWorker {

	constructor() {

		this.onmessage = null;
		this.onerror = null;
		this.terminated = false;
		this.jobs = [];
		workers.push( this );

	}

	postMessage( job ) {

		this.jobs.push( job );

	}

	terminate() {

		this.terminated = true;

	}

}

vi.mock( '@/core/bvh/BVHWorker.js?worker&inline', () => ( { default: StandInBVHWorker } ) );
vi.mock( '@/core/bvh/BVHRefitWorker.js?worker&inline', () => ( { default: class {} } ) );

const { scheduleBackgroundRebuild, REBUILD_QUIET_MS } = await import( '@/core/scene/SceneRefit.js' );
const { configurePlatform } = await import( '@/core/Platform.js' );

// Placements 0–3 own their triangles; placement 3's are shared with another mesh.
function processor() {

	return {
		instanceTable: {
			isSet: [ 1, 1, 1, 1 ], isOwner: () => true, sharesTriangles: ( p ) => p === 3,
			entryAt: ( p ) => ( { triOffset: p * 10, triCount: 10 } ),
		},
		triangles: { copyOf: ( offset, count ) => new Float32Array( count * 20 ).fill( offset ) },
		_placementOf: ( mesh ) => mesh,
		_pendingRebuilds: new Map(), _waitingRebuilds: new Map(), _triangleVersions: new Map(),
		_rebuildTimer: null,
		config: { bvhDepth: 30 },
		bvhBuilder: { maxLeafSize: 4, numBins: 32, maxBins: 64, minBins: 8, enableReinsertionOptimization: true, reinsertionBatchSizeRatio: 0.02, reinsertionMaxIterations: 2 },
		_swapBLAS: vi.fn(),
	};

}

describe( 'background BLAS rebuilds after a refit', () => {

	beforeEach( () => {

		workers.length = 0;
		vi.useFakeTimers( { toFake: [ 'setTimeout', 'clearTimeout', 'performance' ] } );
		configurePlatform( { threads: 3 } );

	} );
	afterEach( () => {

		vi.useRealTimers();
		configurePlatform( { threads: null } );

	} );

	it( 'waits until refits have stopped for the quiet time, then rebuilds each mesh once, with the scene\'s settings', () => {

		const p = processor();
		scheduleBackgroundRebuild( p, [ 0 ] );
		vi.advanceTimersByTime( REBUILD_QUIET_MS - 10 );
		// Another refit restarts the wait.
		scheduleBackgroundRebuild( p, [ 0 ] );
		vi.advanceTimersByTime( REBUILD_QUIET_MS - 10 );
		expect( workers ).toHaveLength( 0 );
		vi.advanceTimersByTime( 20 );
		expect( workers ).toHaveLength( 1 );
		const [ job ] = workers[ 0 ].jobs;
		expect( [ job.triangleCount, job.depth, job.maxLeafSize, job.numBins ] ).toEqual( [ 10, 30, 4, 32 ] );
		expect( job.triangleByteLength ).toBe( 10 * 20 * 4 );

	} );

	it( 'never rebuilds triangles another mesh shares', () => {

		const p = processor();
		scheduleBackgroundRebuild( p, [ 3 ] );
		vi.advanceTimersByTime( REBUILD_QUIET_MS * 2 );
		expect( workers ).toHaveLength( 0 );

	} );

	it( 'runs as many as there are threads less one; a due one starts as a running one ends', () => {

		const p = processor();
		scheduleBackgroundRebuild( p, [ 0, 1, 2 ] );
		vi.advanceTimersByTime( REBUILD_QUIET_MS + 1 );
		expect( workers ).toHaveLength( 2 );
		workers[ 0 ].onmessage( { data: { bvhData: new Float32Array( 16 ) } } );
		expect( workers[ 0 ].terminated ).toBe( true );
		expect( workers ).toHaveLength( 3 );

	} );

	it( 'swaps a rebuilt tree in only while the triangles are those it was built from', () => {

		const p = processor();
		const onSwap = vi.fn();
		p._triangleVersions.set( 0, 1 ).set( 1, 1 );
		scheduleBackgroundRebuild( p, [ 0, 1 ], onSwap );
		vi.advanceTimersByTime( REBUILD_QUIET_MS + 1 );
		const data = { bvhData: new Float32Array( 16 ) };
		workers[ 0 ].onmessage( { data } );
		expect( p._swapBLAS ).toHaveBeenCalledWith( 0, { triOffset: 0, triCount: 10 }, data, onSwap );
		// Written since it was sent: the old triangles would come back.
		p._triangleVersions.set( 1, 2 );
		workers[ 1 ].onmessage( { data } );
		expect( p._swapBLAS ).toHaveBeenCalledTimes( 1 );

	} );

	it( 'drops a running rebuild a newer refit makes stale, and a failed one, swapping neither', () => {

		const p = processor();
		scheduleBackgroundRebuild( p, [ 0 ] );
		vi.advanceTimersByTime( REBUILD_QUIET_MS + 1 );
		const stale = workers[ 0 ];
		scheduleBackgroundRebuild( p, [ 0 ] );
		expect( stale.terminated ).toBe( true );
		stale.onmessage( { data: { bvhData: new Float32Array( 16 ) } } );
		vi.advanceTimersByTime( REBUILD_QUIET_MS + 1 );
		expect( workers ).toHaveLength( 2 );
		workers[ 1 ].onmessage( { data: { error: 'out of memory' } } );
		expect( p._swapBLAS ).not.toHaveBeenCalled();
		expect( p._pendingRebuilds.size ).toBe( 0 );

	} );

} );
