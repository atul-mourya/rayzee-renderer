import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted( () => {

	globalThis.window ??= Object.assign( new EventTarget(), {
		devicePixelRatio: 1,
		location: { href: 'https://rayzee.test/' },
		history: { state: null, replaceState() {} },
	} );
	globalThis.document ??= Object.assign( new EventTarget(), { visibilityState: 'visible', hidden: false } );
	globalThis.CustomEvent ??= class extends Event {};
	const memory = new Map();
	globalThis.localStorage ??= {
		getItem: key => memory.get( key ) ?? null,
		setItem: ( key, value ) => memory.set( key, String( value ) ),
		removeItem: key => memory.delete( key ),
	};

} );
import { createFakeOPFS, snapshot } from '../../__mocks__/opfs.js';
import { openStorage } from '@/core/addons/storage/OpenStorage.js';
import { EngineEvents } from '@/core/EngineEvents.js';
import { ensureAppAreas } from '@/lib/storage';
import {
	STILL_CHECKPOINT_TIMING, StillCheckpointer, unfinishedStill, readStillCheckpoint, discardStill, resumeStill, startStillCheckpointer, getStillCheckpointer,
} from '@/lib/stillJob';
import { useStore, usePathTracerStore } from '@/store';

function checkpointOf( samples ) {

	return {
		samples, width: 4, height: 2, frame: 7,
		color: new Float32Array( [ 0.5, samples, 2, 3 ] ),
		normalDepth: new Float32Array( [ 1, 0, 0, 9 ] ),
		albedo: null,
		m2: new Float32Array( [ 0.25 ] ),
		streak: new Uint32Array( [ 3, 4 ] ),
		frozenMask: new Uint32Array( [ 0xffffffff ] ),
	};

}

function fakeApp( storage ) {

	const app = new EventTarget();
	return Object.assign( app, {
		storage,
		sceneSource: { kind: 'url', url: 'https://example.com/room.glb' },
		sceneModel: { name: 'Room' },
		exportSceneState: () => ( { v: 1 } ),
		getCanvas: () => null,
		stages: { pathTracer: { isComplete: false, frameCount: 0 } },
		settings: { get: key => ( key === 'maxSamples' ? 256 : undefined ), serialize: () => ( { maxSamples: 256 } ), restore: vi.fn() },
		captureRenderCheckpoint: vi.fn( async () => checkpointOf( 32 ) ),
		restoreRenderCheckpoint: vi.fn(),
		stopAnimation: vi.fn(),
		wake: vi.fn(),
	} );

}

const timing = { ...STILL_CHECKPOINT_TIMING };
const reset = ( app, restored = false ) => app.dispatchEvent( Object.assign( new Event( EngineEvents.RENDER_RESET ), { restored } ) );

describe( 'still render checkpoints', () => {

	let opfs, storage, uninstall, app;
	const keys = async () => ( await storage.area( 'jobs' ).list() ).map( m => m.key ).sort();

	beforeEach( async () => {

		opfs = createFakeOPFS();
		uninstall = opfs.install();
		const root = await opfs.root.getDirectoryHandle( 'rayzee', { create: true } );
		( { storage } = await openStorage( { namespace: 'rayzee', root, transport: 'inline' } ) );
		ensureAppAreas( storage );
		app = fakeApp( storage );
		useStore.setState( { appMode: 'final-render' } );

	} );

	afterEach( () => {

		getStillCheckpointer()?.dispose();
		Object.assign( STILL_CHECKPOINT_TIMING, timing );
		storage.dispose();
		uninstall();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();

	} );

	it( 'writes a final render to disk, keeping only the newest checkpoint', async () => {

		const still = new StillCheckpointer( app );
		still.adopt( 'job-1' );

		expect( await still.checkpoint() ).toBe( true );
		expect( await keys() ).toEqual( [ 'still:job-1:1' ] );

		const found = await unfinishedStill( storage );
		expect( found.key ).toBe( 'still:job-1:1' );
		expect( found.job ).toMatchObject( {
			kind: 'still', id: 'job-1', title: 'room.glb', samples: 32, target: 256, width: 4, height: 2,
			checkpoint: { samples: 32, width: 4, height: 2, frame: 7 }, settings: { maxSamples: 256 },
		} );
		expect( found.job.session.source.url ).toBe( 'https://example.com/room.glb' );
		expect( found.job.checkpoint.color ).toBeUndefined();

		const { checkpoint } = await readStillCheckpoint( storage, found.key );
		const expected = checkpointOf( 32 );
		for ( const field of [ 'color', 'normalDepth', 'm2', 'streak', 'frozenMask' ] ) expect( checkpoint[ field ] ).toEqual( expected[ field ] );
		expect( checkpoint.albedo ).toBeNull();
		expect( checkpoint.frame ).toBe( 7 );

		app.captureRenderCheckpoint.mockResolvedValueOnce( checkpointOf( 64 ) );
		expect( await still.checkpoint() ).toBe( true );
		expect( await keys() ).toEqual( [ 'still:job-1:0' ] );
		expect( ( await unfinishedStill( storage ) ).job.samples ).toBe( 64 );

		await discardStill( storage, 'job-1' );
		expect( await keys() ).toEqual( [] );

	} );

	it( 'writes nothing without storage, a render, or a checkpoint', async () => {

		const still = new StillCheckpointer( app );
		expect( await still.checkpoint() ).toBe( false );

		still.adopt( 'job-1' );
		app.captureRenderCheckpoint.mockResolvedValueOnce( null );
		expect( await still.checkpoint() ).toBe( false );

		const bare = new StillCheckpointer( fakeApp( null ) );
		bare.adopt( 'job-2' );
		expect( await bare.checkpoint() ).toBe( false );
		expect( await keys() ).toEqual( [] );

	} );

	it( 'throws away a checkpoint of a render that was replaced meanwhile', async () => {

		const still = new StillCheckpointer( app );
		still.adopt( 'job-1' );
		app.captureRenderCheckpoint.mockImplementationOnce( async () => {

			still.id = 'job-2';
			return checkpointOf( 8 );

		} );
		expect( await still.checkpoint() ).toBe( false );

		still.adopt( 'job-3' );
		app.settings.serialize = () => {

			still.id = 'job-4';
			return {};

		};

		expect( await still.checkpoint() ).toBe( false );
		expect( await keys() ).toEqual( [] );

	} );

	it( 'writes one checkpoint at a time and recovers from a failed one', async () => {

		const warn = vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const still = new StillCheckpointer( app );
		still.adopt( 'job-1' );

		const first = still.checkpoint();
		expect( await still.checkpoint() ).toBe( false );
		expect( await first ).toBe( true );

		app.captureRenderCheckpoint.mockRejectedValueOnce( new Error( 'device lost' ) );
		expect( await still.checkpoint() ).toBe( false );
		expect( warn ).toHaveBeenCalledWith( 'Final render checkpoint not written:', expect.any( Error ) );
		expect( await still.checkpoint() ).toBe( true );
		expect( await keys() ).toEqual( [ 'still:job-1:0' ] );

	} );

	it( 'leaves no half-written checkpoint when a write fails', async () => {

		vi.spyOn( console, 'warn' ).mockImplementation( () => {} );
		const still = new StillCheckpointer( app );
		still.adopt( 'job-1' );
		await still.checkpoint();
		opfs.state.faults.failWriteOf = 'm2.f32';

		expect( await still.checkpoint() ).toBe( false );
		expect( await keys() ).toEqual( [ 'still:job-1:1' ] );
		expect( ( await unfinishedStill( storage ) ).job.samples ).toBe( 32 );
		expect( Object.keys( snapshot( opfs.root ) ).filter( p => p.endsWith( 'color.f32' ) ) ).toHaveLength( 1 );

	} );

	it( 'checkpoints a running final render on its schedule', async () => {

		vi.useFakeTimers( { toFake: [ 'setInterval', 'clearInterval', 'performance' ] } );
		Object.assign( STILL_CHECKPOINT_TIMING, { firstAfterMs: 90_000, everyMs: 30_000, checkEveryMs: 10_000 } );
		const still = startStillCheckpointer( app );
		const checkpoint = vi.spyOn( still, 'checkpoint' );
		reset( app );

		await vi.advanceTimersByTimeAsync( 80_000 );
		expect( checkpoint ).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync( 10_000 );
		expect( checkpoint ).toHaveBeenCalledTimes( 1 );
		expect( await checkpoint.mock.results[ 0 ].value ).toBe( true );

		await vi.advanceTimersByTimeAsync( 20_000 );
		expect( checkpoint ).toHaveBeenCalledTimes( 1 );
		await vi.advanceTimersByTimeAsync( 10_000 );
		expect( checkpoint ).toHaveBeenCalledTimes( 2 );
		await checkpoint.mock.results[ 1 ].value;

		app.stages.pathTracer.isComplete = true;
		await vi.advanceTimersByTimeAsync( 240_000 );
		expect( checkpoint ).toHaveBeenCalledTimes( 2 );

		app.stages.pathTracer.isComplete = false;
		useStore.setState( { appMode: 'results' } );
		expect( still.id ).toBeNull();
		still.adopt( 'kept' );
		await vi.advanceTimersByTimeAsync( 240_000 );
		expect( checkpoint ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'drops its checkpoints when the render restarts, finishes or leaves Final Render', async () => {

		const still = startStillCheckpointer( app );
		expect( getStillCheckpointer() ).toBe( still );

		reset( app );
		const first = still.id;
		expect( first ).toEqual( expect.any( String ) );
		await still.checkpoint();
		reset( app, true );
		expect( still.id ).toBe( first );
		expect( await keys() ).toEqual( [ `still:${first}:1` ] );

		reset( app );
		expect( still.id ).not.toBe( first );
		await vi.waitFor( async () => expect( await keys() ).toEqual( [] ) );

		await still.checkpoint();
		app.dispatchEvent( new Event( EngineEvents.RENDER_COMPLETE ) );
		expect( still.id ).toBeNull();
		await vi.waitFor( async () => expect( await keys() ).toEqual( [] ) );

		reset( app );
		await still.checkpoint();
		useStore.setState( { appMode: 'preview' } );
		expect( still.id ).toBeNull();
		await vi.waitFor( async () => expect( await keys() ).toEqual( [] ) );
		reset( app );
		expect( still.id ).toBeNull();

		const next = startStillCheckpointer( app );
		useStore.setState( { appMode: 'final-render' } );
		reset( app );
		expect( next.id ).toEqual( expect.any( String ) );
		expect( still.id ).toBeNull();

	} );

	it( 'finds the newest checkpoint that can be resumed', async () => {

		expect( await unfinishedStill( null ) ).toBeNull();
		expect( await unfinishedStill( storage ) ).toBeNull();
		expect( await readStillCheckpoint( storage, 'still:none:0' ) ).toBeNull();
		expect( await readStillCheckpoint( null, 'still:none:0' ) ).toBeNull();

		const write = async ( key, extra, job ) => {

			const writer = await storage.area( 'jobs' ).create( key, { extra } );
			await writer.writeJSON( 'job.json', job );
			await writer.commit();

		};

		await write( 'still:a:0', { kind: 'still', savedAt: 3 }, { id: 'a' } );
		await write( 'still:b:1', { kind: 'still', savedAt: 2 }, { id: 'b', session: { title: 'B' } } );
		await write( 'still:c:0', { kind: 'still', savedAt: 1 }, { id: 'c', session: { title: 'C' } } );
		await write( 'video:d', { kind: 'video', savedAt: 9 }, { id: 'd', session: {} } );

		expect( ( await unfinishedStill( storage ) ).key ).toBe( 'still:b:1' );
		await discardStill( storage, null );
		expect( await keys() ).toHaveLength( 4 );

	} );

	it( 'resumes a checkpointed render in Final Render with its own settings and panels', async () => {

		usePathTracerStore.setState( { bounces: 7 } );
		const writer = new StillCheckpointer( app );
		writer.adopt( 'job-9' );
		await writer.checkpoint();
		const found = await unfinishedStill( storage );

		useStore.setState( { appMode: 'preview' } );
		usePathTracerStore.setState( { bounces: 2 } );
		const still = startStillCheckpointer( app );
		let frames = 0;
		vi.stubGlobal( 'requestAnimationFrame', cb => {

			if ( ++ frames === 3 ) app.stages.pathTracer.frameCount = 1;
			queueMicrotask( cb );

		} );

		expect( await resumeStill( app, found ) ).toBe( 32 );
		expect( frames ).toBe( 3 );
		expect( useStore.getState().appMode ).toBe( 'final-render' );
		expect( usePathTracerStore.getState().isRendering ).toBe( true );
		expect( usePathTracerStore.getState().bounces ).toBe( 7 );
		expect( app.settings.restore ).toHaveBeenCalledWith( { maxSamples: 256 } );
		expect( app.stopAnimation ).toHaveBeenCalledTimes( 1 );
		const [ restored ] = app.restoreRenderCheckpoint.mock.calls[ 0 ];
		expect( restored.samples ).toBe( 32 );
		expect( restored.color ).toEqual( checkpointOf( 32 ).color );
		expect( app.wake ).toHaveBeenCalledTimes( 1 );
		expect( app.stopAnimation.mock.invocationCallOrder[ 0 ] ).toBeLessThan( app.restoreRenderCheckpoint.mock.invocationCallOrder[ 0 ] );

		expect( still.id ).toBe( 'job-9' );
		expect( await still.checkpoint() ).toBe( true );
		expect( await keys() ).toEqual( [ 'still:job-9:0' ] );

	} );

} );
