import { describe, it, expect, afterEach } from 'vitest';
import {
	MemoryLedger, estimateSceneBytes, probeAddressSpace,
	PREFLIGHT_SAFETY, PREFLIGHT_MIN_BYTES, SAFE_SCENE_BYTES, MAX_SCENE_BYTES,
} from '@/core/Processor/HostMemory.js';
import { ChunkedRecords, setChunkObserver } from '@/core/Processor/ChunkedRecords.js';

const MB = 1024 * 1024;

describe( 'estimateSceneBytes', () => {

	it( 'adds up to the sum of its parts', () => {

		const e = estimateSceneBytes( { triangles: 1e6, placements: 1e5, geometryBytes: 42 * MB } );
		const summed = e.triangles + e.bvh + e.geometry + e.placements + e.orderMaps;
		expect( e.total ).toBe( summed );

	} );

	it( 'lands within 10% of the measured 40M Moana footprint', () => {

		// Measured on a real load: 40,000,060 triangles, 3.70M placements,
		// 1,832 MB of three.js geometry → 7,289 MB resident.
		const e = estimateSceneBytes( {
			triangles: 40_000_060, placements: 3_704_712, geometryBytes: 1832 * MB,
		} );

		const actualMB = 7289;
		const predictedMB = e.total / MB;
		expect( Math.abs( predictedMB - actualMB ) / actualMB ).toBeLessThan( 0.1 );

	} );

	it( 'never under-estimates the BVH, which is the half that fails to allocate', () => {

		// 40M triangles produced 33.20M nodes; the estimate must cover that, not average it.
		const e = estimateSceneBytes( { triangles: 40_000_060, placements: 0 } );
		expect( e.bvh ).toBeGreaterThanOrEqual( 33_196_459 * 64 );

	} );

	it( 'counts an empty scene as nothing', () => {

		expect( estimateSceneBytes( { triangles: 0, placements: 0 } ).total ).toBe( 0 );

	} );

} );

describe( 'probeAddressSpace', () => {

	it( 'places what it was asked for when there is room', () => {

		const r = probeAddressSpace( 8 * MB, { chunkBytes: 2 * MB } );
		expect( r.placed ).toBe( 8 * MB );
		expect( r.exhausted ).toBe( false );

	} );

	it( 'gives the memory back, so repeated probes do not accumulate', () => {

		for ( let i = 0; i < 20; i ++ ) {

			expect( probeAddressSpace( 16 * MB, { chunkBytes: 4 * MB } ).placed ).toBe( 16 * MB );

		}

	} );

	it( 'asks for exactly the remainder rather than overshooting the last chunk', () => {

		const r = probeAddressSpace( 5 * MB, { chunkBytes: 2 * MB } );
		expect( r.placed ).toBe( 5 * MB );

	} );

	it( 'handles a zero request without allocating', () => {

		expect( probeAddressSpace( 0 ) ).toEqual( { placed: 0, want: 0, exhausted: false, capped: false } );

	} );

	it( 'reports exhaustion instead of throwing when the allocator gives up', () => {

		// The real allocator cannot be made to fail on demand, so stand in for it.
		let left = 3;
		const allocate = n => {

			if ( left -- <= 0 ) throw new RangeError( 'Array buffer allocation failed' );
			return new ArrayBuffer( n );

		};

		const r = probeAddressSpace( 10 * MB, { chunkBytes: MB, allocate } );
		expect( r.exhausted ).toBe( true );
		expect( r.placed ).toBe( 3 * MB );

	} );

	it( 'admits when the request was past its own ceiling rather than claiming it fits', () => {

		const r = probeAddressSpace( 64 * 1024 * MB, { chunkBytes: 1024 * MB } );
		expect( r.capped ).toBe( true );
		expect( r.want ).toBeLessThan( 64 * 1024 * MB );

	} );

} );

describe( 'MemoryLedger', () => {

	it( 'attributes allocations to the phase that was current', () => {

		const l = new MemoryLedger();
		l.mark( 'extraction' ).alloc( 100 );
		l.mark( 'blas' ).alloc( 250 );
		l.alloc( 50 );

		expect( l.byPhase.extraction ).toEqual( { allocated: 100, chunks: 1 } );
		expect( l.byPhase.blas ).toEqual( { allocated: 300, chunks: 2 } );
		expect( l.allocatedBytes ).toBe( 400 );

	} );

	it( 'takes peak from live samples, not from the running total', () => {

		const l = new MemoryLedger();
		l.mark( 'blas' );
		l.sample( 'a', { triangles: 100, bvh: 0 } );
		l.sample( 'b', { triangles: 100, bvh: 400 } ); // peak
		l.sample( 'c', { triangles: 100, bvh: 50 } ); // released, so lower again

		expect( l.peakLiveBytes ).toBe( 500 );
		expect( l.samples ).toHaveLength( 3 );
		expect( l.samples[ 1 ].phase ).toBe( 'blas' );

	} );

	it( 'ignores zero and negative allocations', () => {

		const l = new MemoryLedger();
		l.mark( 'x' ).alloc( 0 );
		l.alloc( - 5 );
		expect( l.allocatedBytes ).toBe( 0 );
		expect( l.byPhase.x.chunks ).toBe( 0 );

	} );

	it( 'clears everything on reset', () => {

		const l = new MemoryLedger();
		l.mark( 'a' ).alloc( 10 );
		l.sample( 's', { x: 99 } );
		l.reset();

		expect( l.allocatedBytes ).toBe( 0 );
		expect( l.peakLiveBytes ).toBe( 0 );
		expect( l.samples ).toHaveLength( 0 );
		expect( Object.keys( l.byPhase ) ).toHaveLength( 0 );

	} );

} );

describe( 'chunk allocation observer', () => {

	afterEach( () => setChunkObserver( null ) );

	it( 'reports every chunk a store takes, with its real byte size', () => {

		const seen = [];
		setChunkObserver( bytes => seen.push( bytes ) );

		// 4 lanes × 4 bytes = 16 bytes a record, 64-byte chunks → 4 records each.
		new ChunkedRecords( 10, 4, Uint32Array, 64 );

		expect( seen ).toEqual( [ 64, 64, 32 ] );

	} );

	it( 'reports a lazy store only as its chunks are touched', () => {

		const seen = [];
		const c = ChunkedRecords.lazy( 10, 4, Uint32Array, 64 );
		setChunkObserver( bytes => seen.push( bytes ) );

		expect( seen ).toEqual( [] );
		c.chunkFor( 9 );
		expect( seen ).toEqual( [ 32 ] );
		c.materializeAll();
		expect( seen ).toEqual( [ 32, 64, 64 ] );

	} );

	it( 'stops reporting once detached', () => {

		const seen = [];
		setChunkObserver( bytes => seen.push( bytes ) );
		setChunkObserver( null );
		new ChunkedRecords( 10, 4, Uint32Array, 64 );
		expect( seen ).toEqual( [] );

	} );

} );

describe( 'preflight thresholds', () => {

	it( 'wants headroom above the estimate', () => {

		expect( PREFLIGHT_SAFETY ).toBeGreaterThan( 1 );

	} );

	it( 'skips scenes too small to hit the wall', () => {

		// ~5M triangles: well over any ordinary asset, still under the probe threshold.
		const e = estimateSceneBytes( { triangles: 5e6, placements: 1e4 } );
		expect( e.total ).toBeLessThan( PREFLIGHT_MIN_BYTES );

	} );

	it( 'flags a scene the size of the one that actually failed', () => {

		const e = estimateSceneBytes( { triangles: 40e6, placements: 3.7e6, geometryBytes: 1832 * MB } );
		expect( e.total ).toBeGreaterThan( PREFLIGHT_MIN_BYTES );
		expect( e.total ).toBeGreaterThan( SAFE_SCENE_BYTES );

	} );

	it( 'leaves the 30M rung, which loads on any session, under the line', () => {

		// 30,006,828 triangles measured at 6.05 GB peak — it should not be warned about.
		const e = estimateSceneBytes( { triangles: 30e6, placements: 2.8e6, geometryBytes: 1400 * MB } );
		expect( e.total ).toBeLessThan( SAFE_SCENE_BYTES );

	} );

	it( 'puts the rungs that load below the refusal line and the one that crashes above it', () => {

		// Measured: 40M and 45M both load and render; 50M killed the renderer at 9.4 GB.
		const at = ( t, p, g ) => estimateSceneBytes( { triangles: t, placements: p, geometryBytes: g * MB } ).total;

		expect( at( 40e6, 3.7e6, 1832 ) ).toBeLessThan( MAX_SCENE_BYTES );
		expect( at( 45e6, 4.1e6, 2000 ) ).toBeLessThan( MAX_SCENE_BYTES );
		expect( at( 50e6, 4.6e6, 2200 ) ).toBeGreaterThan( MAX_SCENE_BYTES );

	} );

	it( 'refuses higher than it warns, so a warned scene is still allowed to try', () => {

		expect( MAX_SCENE_BYTES ).toBeGreaterThan( SAFE_SCENE_BYTES );

	} );

} );
