import { describe, it, expect, vi } from 'vitest';

vi.mock( '@/core/Passes/OIDNDenoiser.js', async () => {

	const { EventDispatcher } = await import( 'three' );
	return { OIDNDenoiser: class extends EventDispatcher {} };

} );
vi.mock( '@/core/Passes/AIUpscaler.js', () => ( { AIUpscaler: class {} } ) );
vi.mock( '@/core/Passes/OIDNTemporalHistory.js', () => ( {
	OIDNTemporalHistory: class {

		constructor() {

			this.settings = {};
			this.valid = false;
			this.width = 0;
			this.height = 0;
			this.textures = { color: 'history' };
			this.accumulate = vi.fn( ( src ) => {

				this.valid = true;
				this.width = src.width;
				this.height = src.height;

			} );
			this.merge = vi.fn( ( src, samples, camera, { commit = false } = {} ) => {

				if ( commit ) this.valid = true;
				return { color: 'merged' };

			} );
			this.invalidate = vi.fn( () => {

				this.valid = false;

			} );
			this.dispose = vi.fn();

		}

	},
} ) );

const { Matrix4 } = await import( 'three' );
const { DenoisingManager } = await import( '@/core/managers/DenoisingManager.js' );

function makePathTracer() {

	const uniforms = new Map( [[ 'cameraProjection', { value: 0 } ]] );
	return {
		width: 8,
		height: 8,
		frameCount: 0,
		frame: { value: 0 },
		tracedFrames: 0,
		resetCount: 0,
		isComplete: false,
		viewIsChanging: false,
		visMode: { value: 0 },
		uniforms,
		cameraWorldMatrix: { value: new Matrix4() },
		cameraViewMatrix: { value: new Matrix4() },
		cameraProjectionMatrix: { value: new Matrix4() },
		cameraProjectionMatrixInverse: { value: new Matrix4() },
		storageTextures: {
			readTarget: {},
			getReadTextures: () => ( { color: 'rawColor', albedo: 'rawAlbedo', normalDepth: 'rawNormal' } ),
		},
		setAuxGBufferEnabled: vi.fn(),
		setCleanAuxNormal: vi.fn(),
	};

}

function makeManager() {

	const pt = makePathTracer();
	const context = new Map( [
		[ 'pathtracer:normalDepth', 'geo' ],
		[ 'pathtracer:prevNormalDepth', 'geoPrev' ],
		[ 'pathtracer:shadingNormal', 'shading' ],
		[ 'pathtracer:instanceLeaf', 'leaf' ],
	] );

	const manager = new DenoisingManager( {
		renderer: { backend: { device: {}, get: ( t ) => ( { texture: t } ) } },
		mainCanvas: { width: 8, height: 8, parentNode: null, style: { opacity: '1' } },
		stages: { pathTracer: pt, normalDepth: { enabled: false, reset: vi.fn(), setInstanceLeafOutput: vi.fn() } },
		pipeline: { context: {
			getTexture: ( k ) => context.get( k ),
			setTexture: ( k, v ) => context.set( k, v ),
			removeTexture: ( k ) => context.delete( k ),
		} },
		getExposure: () => 1,
		getSaturation: () => 1,
	} );

	manager.denoiser = {
		enabled: true,
		expectsCleanAux: () => false,
		state: { isDenoising: false, isLoading: false },
		abort: vi.fn(),
		setSize: vi.fn(),
		invalidateOutput: vi.fn(),
	};
	manager._lastRenderWidth = 8;
	manager._lastRenderHeight = 8;
	manager.setContinuousDenoise( true );
	manager._syncGBufferStages();

	// One app-announced reset, as PathTracerApp.reset() makes it.
	const reset = ( keepHistory ) => {

		manager.beforeReset( { keepHistory } );
		pt.resetCount += 2;
		pt.frameCount = 0;
		manager.afterReset();

	};

	// One render-loop tick that traced a frame.
	const trace = () => {

		pt.frame.value = pt.frameCount;
		pt.tracedFrames ++;
		if ( ! pt.viewIsChanging ) pt.frameCount ++;
		manager.afterTrace();

	};

	return { manager, pt, reset, trace };

}

describe( 'DenoisingManager — OIDN motion history', () => {

	it( 'turns the depth/normal stage on only while OIDN owns the live view', () => {

		const { manager } = makeManager();
		const nd = manager._stages.normalDepth;
		expect( nd.enabled ).toBe( true );
		expect( nd.setInstanceLeafOutput ).toHaveBeenLastCalledWith( true );

		manager.setTemporalHistory( false );
		expect( nd.enabled ).toBe( false );
		expect( nd.setInstanceLeafOutput ).toHaveBeenLastCalledWith( false );

	} );

	it( 'lets go of the history at a size too slow to denoise while moving, until the size changes', () => {

		const { manager, pt, reset, trace } = makeManager();
		const nd = manager._stages.normalDepth;

		reset( true );
		trace();
		const history = manager._history;
		pt.viewIsChanging = true;
		manager._movingDenoiseMs.push( 2000 );

		expect( manager.holdsWhileMoving ).toBe( false );
		expect( history.dispose ).toHaveBeenCalled();
		expect( manager._history ).toBeNull();
		expect( nd.enabled ).toBe( false );

		manager.setRenderSize( 8, 8 );
		expect( nd.enabled ).toBe( true );
		expect( manager.historyWanted ).toBe( true );

	} );

	it( 'denoises the history while the view moves, and the accumulation for the final pass', () => {

		const { manager, pt, reset, trace } = makeManager();
		pt.viewIsChanging = true;

		reset( true );
		trace();
		reset( true );
		trace();

		expect( manager._history.accumulate ).toHaveBeenCalledTimes( 2 );
		expect( manager._historyTextures() ).toEqual( { color: 'history' } );

		pt.isComplete = true;
		expect( manager._historyTextures() ).toBeNull();

	} );

	it( 'throws the history away when a reset changed what the scene looks like', () => {

		const { manager, reset, trace } = makeManager();

		reset( true );
		trace();
		reset( true );
		trace();
		expect( manager._history.invalidate ).toHaveBeenCalledTimes( 1 );

		reset( false );
		trace();
		expect( manager._history.invalidate ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'throws it away when the path tracer reset itself without the app announcing it', () => {

		const { manager, pt, reset, trace } = makeManager();

		reset( true );
		trace();
		// A material edit resets the stage directly.
		pt.resetCount ++;
		pt.frameCount = 0;

		expect( manager._historyTextures() ).toBeNull();
		trace();
		expect( manager._history.invalidate ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'leaves the history still while the image accumulates, and merges it into each refresh', () => {

		const { manager, reset, trace } = makeManager();

		reset( true );
		trace();
		trace();
		trace();

		expect( manager._history.accumulate ).toHaveBeenCalledTimes( 1 );
		expect( manager._historyTextures() ).toEqual( { color: 'merged' } );
		expect( manager._history.merge ).toHaveBeenLastCalledWith(
			expect.anything(), 3, expect.anything(), { historyScale: 1 - 3 / 16 }
		);

	} );

	it( 'hands the view to the plain accumulation once it has enough samples of its own', () => {

		const { manager, reset, trace } = makeManager();

		reset( true );
		for ( let i = 0; i < 16; i ++ ) trace();

		expect( manager._historyTextures() ).toBeNull();

	} );

	it( 'starts a move from the still image instead of from one sample', () => {

		const { manager, reset, trace } = makeManager();

		reset( true );
		trace();
		trace();
		trace();
		reset( true );

		expect( manager._history.merge ).toHaveBeenLastCalledWith(
			expect.anything(), 3, expect.anything(), { commit: true, keepHistory: true, historyScale: 1 - 3 / 16 }
		);

	} );

	it( 'starts a move from the image, not the old history, after frames it never saw', () => {

		const { manager, pt, reset, trace } = makeManager();

		reset( true );
		trace();
		// A material edit, then frames rendered outside the loop (renderFrames, video export).
		pt.resetCount ++;
		pt.frameCount = 2;
		reset( true );

		expect( manager._history.merge ).toHaveBeenLastCalledWith(
			expect.anything(), 2, expect.anything(), { commit: true, keepHistory: false, historyScale: 1 - 2 / 16 }
		);

	} );

	it( 'falls back to the accumulation when the render size no longer matches the history', () => {

		const { manager, reset, trace } = makeManager();

		reset( true );
		trace();
		manager._lastRenderWidth = 16;

		expect( manager._historyTextures() ).toBeNull();

	} );

	it( 'stays out of the way under a panorama camera or a debug view', () => {

		const { manager, pt, reset, trace } = makeManager();

		pt.uniforms.get( 'cameraProjection' ).value = 1;
		reset( true );
		trace();
		expect( manager._history ).toBeNull();

		pt.uniforms.get( 'cameraProjection' ).value = 0;
		pt.visMode.value = 3;
		trace();
		expect( manager._history ).toBeNull();

	} );

	it( 'keeps a history for an orthographic camera, and tells it the rays are parallel', () => {

		const { manager, pt, reset, trace } = makeManager();
		pt.uniforms.get( 'cameraProjection' ).value = 2;
		pt.viewIsChanging = true;

		reset( true );
		trace();

		expect( manager._history.accumulate ).toHaveBeenCalledTimes( 1 );
		expect( manager._history.accumulate.mock.calls[ 0 ][ 1 ].orthographic ).toBe( true );

	} );

	it( 'hands the history each moved placement, current to previous, once', () => {

		const { manager, reset, trace } = makeManager();
		const world = new Float32Array( 32 );
		new Matrix4().toArray( world, 0 );
		new Matrix4().makeTranslation( 1, 0, 0 ).toArray( world, 16 );

		reset( true );
		trace();
		const row = ( o ) => () => world.subarray( o, o + 16 );
		manager.notePlacementMoving( 7, row( 16 ) );
		new Matrix4().makeTranslation( 3, 0, 0 ).toArray( world, 16 );
		manager.notePlacementMoving( 7, row( 16 ) );
		manager.notePlacementMoving( 2, row( 0 ) );
		reset( true );
		trace();

		const moved = manager._history.accumulate.mock.calls.at( - 1 )[ 2 ];
		expect( moved.count ).toBe( 2 );
		expect( Array.from( moved.leaves.subarray( 0, 2 ) ) ).toEqual( [ 2, 7 ] );
		// Leaf 7 went from x = 1 to x = 3, so a point now at x = 3 was at x = 1.
		const toPrev = new Matrix4().fromArray( moved.toPrev, 16 );
		expect( toPrev.elements[ 12 ] ).toBeCloseTo( - 2 );

		reset( true );
		trace();
		expect( manager._history.accumulate.mock.calls.at( - 1 )[ 2 ].count ).toBe( 0 );

	} );

	it( 'releases the history when OIDN stops owning the live view', () => {

		const { manager, reset, trace } = makeManager();

		reset( true );
		trace();
		const history = manager._history;
		manager.setDenoiserStrategy( 'nrd' );

		expect( history.dispose ).toHaveBeenCalled();
		expect( manager._history ).toBeNull();

	} );

} );
