import { describe, it, expect, vi, beforeEach } from 'vitest';

// The manager constructs OIDN/AI-upscaler passes that need a GPU; stub them so the strategy logic
// under test is the only thing running.
vi.mock( '@/core/viewer/denoise/OIDNDenoiser.js', async () => {

	const { EventDispatcher } = await import( 'three' );
	return { OIDNDenoiser: class extends EventDispatcher {

		constructor() {

			super();
			this.enabled = false;
			this.state = {};
			this.hasOutput = false;
			this.outputTexture = {};
			this.abort = vi.fn();
			this.invalidateOutput = vi.fn();

		}

		expectsCleanAux() {

			return false;

		}

	} };

} );
vi.mock( '@/core/viewer/picture/AIUpscaler.js', () => ( { AIUpscaler: class {} } ) );

const { DenoisingManager } = await import( '@/core/viewer/denoise/DenoisingManager.js' );
const { NRD_QUALITY_PRESETS, NRD_DEFAULTS, NRD_PRESET_KEYS } = await import( '@/core/viewer/denoise/DenoiserSettings.js' );
const { CAMERA_PROJECTION_IDS } = await import( '@/core/EngineDefaults.js' );

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
		motionVector: makeStage( { matricesInitialized: true } ),
		nrd: makeStage( { resetHistory: vi.fn() } ),
		autoExposure: makeStage(),
		compositor: makeStage(),
	};

	const removed = [];
	const published = [];
	const pipeline = { context: { removeTexture: ( k ) => removed.push( k ), setTexture: ( k ) => published.push( k ) } };
	const issues = { record: vi.fn() };

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
		issues,
	} );

	return { manager, stages, removed, published, issues };

}

describe( 'DenoisingManager — NRD strategy', () => {

	let manager, stages, removed, issues;

	beforeEach( () => {

		( { manager, stages, removed, issues } = makeManager() );

	} );

	it( 'enables only the NRD stage plus its G-buffer producers', () => {

		manager.setDenoiserStrategy( 'nrd', 'medium' );

		expect( stages.nrd.enabled ).toBe( true );
		expect( manager.continuousDenoise ).toBe( false );
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

	it( 'OIDN and NRD are mutually exclusive', () => {

		manager.setDenoiserStrategy( 'nrd', 'medium' );
		manager.setDenoiserStrategy( 'oidn' );

		expect( stages.nrd.enabled ).toBe( false );
		expect( manager.continuousDenoise ).toBe( true );
		expect( manager.denoiserStrategy ).toBe( 'oidn' );

		manager.setDenoiserStrategy( 'nrd', 'medium' );
		expect( manager.continuousDenoise ).toBe( false );
		expect( stages.nrd.enabled ).toBe( true );

	} );

	it( 'a removed or unknown strategy is recorded and runs none', () => {

		manager.setDenoiserStrategy( 'nrd', 'medium' );

		for ( const name of [ 'asvgf', 'edgeaware' ] ) {

			manager.setDenoiserStrategy( name );
			expect( manager.denoiserStrategy ).toBe( 'none' );
			expect( issues.record ).toHaveBeenLastCalledWith( 'denoiser.unavailable', expect.stringContaining( name ), { strategy: name } );

		}

		expect( stages.nrd.enabled ).toBe( false );

	} );

	it( 'forwards parameters and debug mode to the stage', () => {

		manager.setNRDParams( { maxBlurRadius: 12 } );
		manager.setNRDDebugMode( 3 );

		expect( stages.nrd.updateParameters ).toHaveBeenCalledWith( { maxBlurRadius: 12 } );
		expect( stages.nrd.updateParameters ).toHaveBeenCalledWith( { debugMode: 3 } );

	} );

	it( 'runs OIDN when NRD is asked for in a panorama', () => {

		stages.pathTracer.uniforms = { get: ( k ) => ( k === 'cameraProjection' ? { value: CAMERA_PROJECTION_IDS.equirectangular } : undefined ) };

		manager.setDenoiserStrategy( 'nrd', 'medium' );

		expect( manager.denoiserStrategy ).toBe( 'oidn' );
		expect( stages.nrd.enabled ).toBe( false );
		expect( stages.motionVector.enabled ).toBe( false );
		expect( issues.record ).toHaveBeenLastCalledWith( 'denoiser.unavailable', expect.stringContaining( 'panorama' ), { strategy: 'nrd' } );

	} );

	it( 'survives a pipeline without an NRD stage', () => {

		delete stages.nrd;

		expect( () => manager.setDenoiserStrategy( 'nrd', 'medium' ) ).not.toThrow();
		expect( manager.denoiserStrategy ).toBe( 'none' );

	} );

} );

describe( 'DenoisingManager — leaving live OIDN', () => {

	let manager, published, dn;

	beforeEach( () => {

		( { manager, published } = makeManager() );
		manager.setupDenoiser();
		dn = manager.denoiser;

	} );

	it( 'cancels the refresh in flight while it still can', () => {

		manager.setDenoiserStrategy( 'oidn' );
		expect( dn.enabled ).toBe( true );

		dn.abort.mockImplementation( () => expect( dn.enabled ).toBe( true ) );
		manager.setDenoiserStrategy( 'nrd', 'medium' );

		expect( dn.abort ).toHaveBeenCalled();
		expect( dn.enabled ).toBe( false );

	} );

	it( 'keeps a refresh that lands afterwards off screen, but not a final pass', () => {

		manager.setDenoiserStrategy( 'oidn' );
		manager.setDenoiserStrategy( 'none' );
		dn.hasOutput = true;

		dn.dispatchEvent( { type: 'end', continuous: true } );
		expect( published ).not.toContain( 'oidn:output' );

		dn.dispatchEvent( { type: 'end', continuous: false } );
		expect( published ).toContain( 'oidn:output' );

	} );

	it( 'still shows refreshes while OIDN owns the live view', () => {

		manager.setDenoiserStrategy( 'oidn' );
		dn.hasOutput = true;

		dn.dispatchEvent( { type: 'end', continuous: true } );
		expect( published ).toContain( 'oidn:output' );

	} );

} );
