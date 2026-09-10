import { describe, it, expect, vi, beforeEach } from 'vitest';

// The manager constructs OIDN/AI-upscaler passes that need a GPU; stub them so the strategy logic
// under test is the only thing running.
vi.mock( '@/core/Passes/OIDNDenoiser.js', () => ( { OIDNDenoiser: class {} } ) );
vi.mock( '@/core/Passes/AIUpscaler.js', () => ( { AIUpscaler: class {} } ) );

const { DenoisingManager } = await import( '@/core/managers/DenoisingManager.js' );
const { NRD_QUALITY_PRESETS, NRD_DEFAULTS, NRD_PRESET_KEYS } = await import( '@/core/EngineDefaults.js' );

function makeStage( extra = {} ) {

	return {
		enabled: false,
		releaseGPUMemory: vi.fn(),
		updateParameters: vi.fn(),
		reset: vi.fn(),
		...extra,
	};

}

function makeManager() {

	const stages = {
		pathTracer: { setAuxGBufferEnabled: vi.fn(), setCleanAuxNormal: vi.fn() },
		normalDepth: makeStage(),
		motionVector: makeStage( { matricesInitialized: true, isFirstFrame: false, frameCount: 5 } ),
		asvgf: makeStage( { setTemporalEnabled: vi.fn() } ),
		nrd: makeStage( { resetHistory: vi.fn() } ),
		variance: makeStage( { varianceBoost: { value: 1 } } ),
		bilateralFilter: makeStage(),
		edgeFilter: makeStage( { setFilteringEnabled( v ) {

			this.enabled = v;

		} } ),
		autoExposure: makeStage(),
		compositor: makeStage(),
	};

	const removed = [];
	const pipeline = { context: { removeTexture: ( k ) => removed.push( k ) } };

	// No parentNode on the canvas → no denoiser canvas → OIDN/upscaler setup is skipped.
	const manager = new DenoisingManager( {
		renderer: {},
		mainCanvas: { width: 8, height: 8, parentNode: null },
		scene: {},
		camera: {},
		stages,
		pipeline,
		getExposure: () => 1,
		getSaturation: () => 1,
		getTransparentBg: () => false,
	} );

	return { manager, stages, removed };

}

describe( 'DenoisingManager — NRD strategy', () => {

	let manager, stages, removed;

	beforeEach( () => {

		( { manager, stages, removed } = makeManager() );

	} );

	it( 'enables only the NRD stage plus its G-buffer producers', () => {

		manager.setDenoiserStrategy( 'nrd', 'medium' );

		expect( stages.nrd.enabled ).toBe( true );
		expect( stages.asvgf.enabled ).toBe( false );
		expect( stages.edgeFilter.enabled ).toBe( false );
		expect( stages.variance.enabled ).toBe( false );
		expect( stages.bilateralFilter.enabled ).toBe( false );
		// Reprojection needs both motion vectors and the deterministic normal/depth G-buffer.
		expect( stages.normalDepth.enabled ).toBe( true );
		expect( stages.motionVector.enabled ).toBe( true );
		// The wavefront must write the aux MRT (albedo.w carries the hit distance).
		expect( stages.pathTracer.setAuxGBufferEnabled ).toHaveBeenLastCalledWith( true );
		expect( manager.denoiserStrategy ).toBe( 'nrd' );

	} );

	it( 'applies the named preset and drops stale history on activation', () => {

		manager.setDenoiserStrategy( 'nrd', 'high' );

		expect( stages.nrd.resetHistory ).toHaveBeenCalled();
		// Defaults first, then the preset's deltas — otherwise a low→high switch keeps low's values.
		const applied = stages.nrd.updateParameters.mock.calls.at( - 1 )[ 0 ];
		expect( applied ).toMatchObject( NRD_QUALITY_PRESETS.high );
		expect( Object.keys( applied ).sort() ).toEqual( [ ...NRD_PRESET_KEYS ].sort() );
		expect( applied.maxStabilizedFrameNum ).toBe( NRD_DEFAULTS.maxStabilizedFrameNum );

	} );

	it( 'falls back to medium for an unknown preset name without throwing', () => {

		manager.setDenoiserStrategy( 'nrd', 'nope' );

		expect( stages.nrd.enabled ).toBe( true );
		expect( stages.nrd.updateParameters ).not.toHaveBeenCalled();

	} );

	it( 'switching away releases NRD memory, clears its texture and idles the G-buffer', () => {

		manager.setDenoiserStrategy( 'nrd', 'medium' );
		stages.nrd.releaseGPUMemory.mockClear();

		manager.setDenoiserStrategy( 'none' );

		expect( stages.nrd.enabled ).toBe( false );
		expect( stages.nrd.releaseGPUMemory ).toHaveBeenCalled();
		expect( removed ).toContain( 'nrd:output' );
		expect( stages.normalDepth.enabled ).toBe( false );
		expect( stages.motionVector.enabled ).toBe( false );
		expect( manager.denoiserStrategy ).toBe( 'none' );

	} );

	it( 'ASVGF and NRD are mutually exclusive', () => {

		manager.setDenoiserStrategy( 'nrd', 'medium' );
		manager.setASVGFEnabled( true, 'medium' );

		expect( stages.asvgf.enabled ).toBe( true );
		expect( stages.nrd.enabled ).toBe( false );
		expect( manager.denoiserStrategy ).toBe( 'asvgf' );

		manager.setDenoiserStrategy( 'nrd', 'medium' );
		expect( stages.asvgf.enabled ).toBe( false );
		expect( stages.nrd.enabled ).toBe( true );

	} );

	it( 'forwards parameters and debug mode to the stage', () => {

		manager.setNRDParams( { maxBlurRadius: 12 } );
		manager.setNRDDebugMode( 3 );

		expect( stages.nrd.updateParameters ).toHaveBeenCalledWith( { maxBlurRadius: 12 } );
		expect( stages.nrd.updateParameters ).toHaveBeenCalledWith( { debugMode: 3 } );

	} );

	it( 'survives a pipeline without an NRD stage', () => {

		delete stages.nrd;

		expect( () => manager.setDenoiserStrategy( 'nrd', 'medium' ) ).not.toThrow();
		expect( manager.denoiserStrategy ).toBe( 'none' );

	} );

} );
