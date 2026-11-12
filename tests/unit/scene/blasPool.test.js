import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SceneProcessor } from '@/core/scene/SceneProcessor.js';
import { BVHBuilder } from '@/core/bvh/BVHBuilder.js';

// Workers answer from `plan`: `fail[ m ]` out-of-memory replies for mesh m before it builds.
const { state, FakeWorker } = vi.hoisted( () => {

	const state = { plan: null, seen: null };
	class FakeWorker {

		constructor() {

			state.seen.spawned ++;

		}

		postMessage( message, transfer ) {

			const { seen, plan } = state;
			seen.inPlace.push( message.inPlace && transfer.length === 0 );
			seen.inFlight ++;
			seen.most = Math.max( seen.most, seen.inFlight );
			if ( seen.failed ) seen.mostAfter = Math.max( seen.mostAfter, seen.inFlight );
			const { m } = this._currentTask;
			setTimeout( () => {

				seen.inFlight --;
				if ( this.stopped ) return;
				if ( plan.fail[ m ] > 0 ) {

					plan.fail[ m ] --;
					seen.failed = true;
					this.onmessage( { data: { error: plan.error, recordsMoved: plan.moved } } );
					return;

				}

				this.onmessage( { data: { bvhData: new Float32Array( 16 ), originalToBvh: null } } );

			}, 2 );

		}

		terminate() {

			this.stopped = true;
			state.seen.terminated ++;

		}

	}

	return { state, FakeWorker };

} );

vi.mock( '@/core/Platform.js', async ( importOriginal ) => ( { ...await importOriginal(), createWorker: () => new FakeWorker() } ) );

function build( size, meshes, plan, opts = {} ) {

	state.plan = { error: 'Array buffer allocation failed', moved: false, ...plan };
	state.seen = { spawned: 0, terminated: 0, inFlight: 0, most: 0, mostAfter: 0, failed: false, inPlace: [] };
	const sp = new SceneProcessor();
	const records = ( _start, count ) => new Uint32Array( count * 20 );
	sp.triangles = { shared: true, isContiguous: () => true, slice: records, copyOf: records, setRecords: () => {} };
	const pool = sp._blasPool( { depth: 30, ...opts }, null, null, size );
	for ( let m = 0; m < meshes; m ++ ) pool.submit( { m, range: { start: m * 4, count: 4 } } );
	return pool.close();

}

describe( 'BLAS pool — a build that runs out of memory', () => {

	beforeEach( () => vi.spyOn( console, 'warn' ).mockImplementation( () => {} ) );

	it( 'runs again with one fewer worker at once, and every mesh is built', async () => {

		const results = await build( 4, 12, { fail: { 2: 1 } } );

		expect( results.map( ( r ) => r.m ).sort( ( a, b ) => a - b ) ).toEqual( [ ...Array( 12 ).keys() ] );
		expect( state.seen.most ).toBe( 4 );
		expect( state.seen.mostAfter ).toBeLessThanOrEqual( 3 );
		expect( state.seen.terminated ).toBeGreaterThanOrEqual( 1 );

	} );

	it( 'on the last worker, runs again alone after a pause', async () => {

		const results = await build( 1, 3, { fail: { 1: 2 } } );

		expect( results ).toHaveLength( 3 );
		expect( state.seen.spawned ).toBe( 1 );

	} );

	it( 'fails the load past three tries', async () => {

		await expect( build( 2, 4, { fail: { 0: 4 } } ) ).rejects.toThrow( 'Array buffer allocation failed' );

	} );

	it( 'fails it at once when the build had moved records in place, or on any other error', async () => {

		await expect( build( 2, 4, { fail: { 0: 1 }, moved: true } ) ).rejects.toThrow( 'allocation failed' );
		expect( state.seen.spawned ).toBe( 2 );
		await expect( build( 2, 4, { fail: { 0: 1 }, error: 'bad records' } ) ).rejects.toThrow( 'bad records' );

	} );

} );

describe( 'BLAS pool — in place', () => {

	it( 'builds a range in one shared chunk where it sits, unless told to copy (chunks spilled during the build)', async () => {

		await build( 2, 4, { fail: {} } );
		expect( state.seen.inPlace ).toEqual( [ true, true, true, true ] );

		await build( 2, 4, { fail: {} }, { inPlace: false } );
		expect( state.seen.inPlace ).toEqual( [ false, false, false, false ] );

	} );

} );

describe( 'BVHBuilder — recordsMoved', () => {

	it( 'is set only once records were reordered where they sit', () => {

		const records = () => {

			// 64 triangles, corners at lanes 0, 4 and 8, scattered so the order changes.
			const data = new Float32Array( 64 * 20 );
			for ( let i = 0; i < 64; i ++ ) for ( let c = 0; c < 3; c ++ ) data.set( [ ( i * 37 ) % 64 + c, i % 7, c ], i * 20 + c * 4 );
			return new Uint32Array( data.buffer );

		};

		const apart = new BVHBuilder();
		apart.buildFlat( records(), 30 );
		expect( apart.recordsMoved ).toBe( false );

		const inPlace = new BVHBuilder();
		const store = records();
		inPlace.buildFlat( store, 30, null, store );
		expect( inPlace.recordsMoved ).toBe( true );

	} );

} );
