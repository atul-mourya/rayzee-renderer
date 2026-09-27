import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';

// Stub browser APIs that Zustand/store.js may reference. localStorage is required: without
// it the store import throws and the `catch { store = null }` below silently skips every test.
globalThis.window = globalThis.window || {};
const _ls = new Map();
globalThis.localStorage = globalThis.localStorage || {
	getItem: k => _ls.get( k ) ?? null,
	setItem: ( k, v ) => _ls.set( k, String( v ) ),
	removeItem: k => _ls.delete( k ),
	clear: () => _ls.clear(),
};
globalThis.window.localStorage = globalThis.localStorage;
globalThis.matchMedia = globalThis.matchMedia
	|| ( () => ( { matches: false, addEventListener() {}, removeEventListener() {} } ) );

// Mock appProxy before store imports it (top-level only)
vi.mock( '@/lib/appProxy.js', () => {

	let _app = null;
	return {
		getApp: () => _app,
		setApp: ( app ) => {

			_app = app;

		},
		subscribeApp: vi.fn( () => () => {} ),
		__setMockApp: ( app ) => {

			_app = app;

		},
	};

} );

// We'll dynamically import the store to avoid static import issues
let store;

beforeEach( async () => {

	try {

		store = await import( '@/store.js' );

	} catch ( error ) {

		// Loud on purpose: a silent null here turns every test in this file into a no-op.
		throw new Error( `store.js failed to import — tests would silently pass: ${error.message}` );

	}

} );

describe( 'Store', () => {

	it( 'module loads without error', () => {

		// If store imported, it should be an object with exports
		// If it failed, we skip
		if ( ! store ) {

			expect( true ).toBe( true ); // skip
			return;

		}

		expect( store ).toBeDefined();

	} );

} );

describe( 'bounce-loop settings unwrap the Slider array', () => {

	// PathTracer sums these three into loopBound. A raw [n] from Slider.onValueChange makes
	// that sum string-concatenate ( [20] + 5 + 8 === '2058' ), and the bounce loop then runs
	// to 2058 on any frame the survivor curve can't early-exit — which hangs the tab.
	const CASES = [
		[ 'handleBouncesChange', 'maxBounces', 20 ],
		[ 'handleTransmissiveBouncesChange', 'transmissiveBounces', 7 ],
		[ 'handleMaxSubsurfaceStepsChange', 'maxSubsurfaceSteps', 32 ],
	];

	for ( const [ handler, key, value ] of CASES ) {

		it( `${handler} forwards a number, not an array`, async () => {

			if ( ! store ) return;

			const set = vi.fn();
			const proxy = await import( '@/lib/appProxy.js' );
			proxy.__setMockApp( { settings: { set }, reset: vi.fn() } );

			store.usePathTracerStore.getState()[ handler ]( [ value ] );

			expect( set ).toHaveBeenCalledWith( key, value );
			const forwarded = set.mock.calls.at( - 1 )[ 1 ];
			expect( typeof forwarded ).toBe( 'number' );
			// The actual failure mode: a non-number turns the loopBound sum into a string.
			expect( typeof ( forwarded + 5 + 8 ) ).toBe( 'number' );

		} );

	}

} );

describe( 'NRD denoiser handlers', () => {

	// The preset handler reads back what the engine resolved rather than restating the table.
	const mockApp = ( nrdSettings = {} ) => ( {
		denoisingManager: {
			setNRDParams: vi.fn(),
			setNRDDebugMode: vi.fn(),
			applyNRDPreset: vi.fn(),
			setStrategy: vi.fn(),
		},
		stages: { nrd: { settings: nrdSettings } },
		reset: vi.fn(),
		settings: { set: vi.fn() },
	} );

	// Slider hands its callbacks a [value]; the engine setters compare and store raw numbers, so an
	// array reaches the shader as NaN or a string.
	const SLIDERS = [
		[ 'handleNrdMaxAccumulatedFrameNumChange', 'maxAccumulatedFrameNum', 'nrdMaxAccumulatedFrameNum', 24 ],
		[ 'handleNrdMaxBlurRadiusChange', 'maxBlurRadius', 'nrdMaxBlurRadius', 12 ],
		[ 'handleNrdPrepassBlurRadiusChange', 'prepassBlurRadius', 'nrdPrepassBlurRadius', 40 ],
	];

	for ( const [ handler, engineKey, stateKey, value ] of SLIDERS ) {

		it( `${handler} forwards a number, not an array`, async () => {

			if ( ! store ) return;

			const app = mockApp();
			( await import( '@/lib/appProxy.js' ) ).__setMockApp( app );

			store.usePathTracerStore.getState()[ handler ]( [ value ] );

			expect( app.denoisingManager.setNRDParams ).toHaveBeenCalledWith( { [ engineKey ]: value } );
			expect( store.usePathTracerStore.getState()[ stateKey ] ).toBe( value );

		} );

	}

	it( 'the quality preset rewrites the slider state so the UI matches the engine', async () => {

		if ( ! store ) return;

		const { NRD_QUALITY_PRESETS, NRD_DEFAULTS } = await import( '@/Constants' );
		const resolved = { ...NRD_DEFAULTS, ...NRD_QUALITY_PRESETS.high };
		const app = mockApp( resolved );
		( await import( '@/lib/appProxy.js' ) ).__setMockApp( app );

		store.usePathTracerStore.getState().handleNrdQualityPresetChange( 'high' );

		expect( app.denoisingManager.applyNRDPreset ).toHaveBeenCalledWith( 'high' );
		const state = store.usePathTracerStore.getState();
		expect( state.nrdQualityPreset ).toBe( 'high' );
		expect( state.nrdMaxBlurRadius ).toBe( resolved.maxBlurRadius );
		expect( state.nrdMaxAccumulatedFrameNum ).toBe( resolved.maxAccumulatedFrameNum );
		// 'medium' states no deltas, so this only reads right if the engine resolved the defaults.
		expect( state.nrdAntiFirefly ).toBe( resolved.enableAntiFirefly );

	} );

	it( 'the strategy switch passes the NRD preset, not the ASVGF one', async () => {

		if ( ! store ) return;

		const app = mockApp();
		( await import( '@/lib/appProxy.js' ) ).__setMockApp( app );

		store.usePathTracerStore.setState( { nrdQualityPreset: 'low', asvgfQualityPreset: 'high' } );
		store.usePathTracerStore.getState().handleDenoiserStrategyChange( 'nrd' );

		expect( app.denoisingManager.setStrategy ).toHaveBeenCalledWith( 'nrd', 'low' );

		store.usePathTracerStore.getState().handleDenoiserStrategyChange( 'asvgf' );
		expect( app.denoisingManager.setStrategy ).toHaveBeenLastCalledWith( 'asvgf', 'high' );

	} );

	it( 'the debug mode reaches the engine as an int', async () => {

		if ( ! store ) return;

		const app = mockApp();
		( await import( '@/lib/appProxy.js' ) ).__setMockApp( app );

		store.usePathTracerStore.getState().handleNrdDebugModeChange( '3' );

		expect( app.denoisingManager.setNRDDebugMode ).toHaveBeenCalledWith( 3 );
		expect( store.usePathTracerStore.getState().nrdDebugMode ).toBe( 3 );

	} );

} );

describe( 'depth-of-field presets and subject size', () => {

	const MODEL_SIZE = 3.18;

	const mockApp = ( { focus = 2 } = {} ) => {

		const camera = new PerspectiveCamera( 55, 1, 0.1, 100 );
		camera.position.set( 0, 0, 4 );
		const values = { focusDistance: focus, unitsPerMetre: 1 };
		return {
			cameraManager: { active: camera, controls: { target: new Vector3(), update: vi.fn() } },
			assetLoader: { getSceneSize: () => new Vector3( 1.5, MODEL_SIZE, 2.3 ) },
			settings: {
				get: k => values[ k ],
				set: vi.fn( ( k, v ) => ( values[ k ] = v ) ),
				setMany: vi.fn( u => Object.assign( values, u ) ),
			},
			reset: vi.fn(),
			values,
		};

	};

	const withApp = async ( options, state = {} ) => {

		const app = mockApp( options );
		( await import( '@/lib/appProxy.js' ) ).__setMockApp( app );
		store.useCameraStore.setState( { autoFocusMode: 'manual', fov: 55, modelDimensions: [ 1.5, MODEL_SIZE, 2.3 ], unitsPerMetre: 1, ...state } );
		return app;

	};

	const cameraStore = () => store.useCameraStore.getState();

	it( 'starts on Custom, so the first pick of any preset applies it', () => {

		expect( store.useCameraStore.getInitialState().activePreset ).toBe( 'custom' );

	} );

	it( 'changes only the lens: the camera, its field of view and a manual focus stay put', async () => {

		const app = await withApp( { focus: 2 } );
		cameraStore().handlePresetChange( 'cinematic' );

		const camera = app.cameraManager.active;
		expect( camera.fov ).toBe( 55 );
		expect( camera.position.toArray() ).toEqual( [ 0, 0, 4 ] );
		expect( app.values.focusDistance ).toBe( 2 );
		expect( cameraStore().fov ).toBe( 55 );
		expect( app.settings.setMany.mock.calls.at( - 1 )[ 0 ] ).toEqual( { dofBlur: 0.13, aperture: 1.4, focalLength: 200, apertureScale: 1.0, anamorphicRatio: 1.5 } );

	} );

	it( 'takes the blur slider as a percentage and marks the look custom', async () => {

		const app = await withApp( {}, { activePreset: 'portrait' } );
		cameraStore().handleDofBlurChange( 6 );

		expect( app.values.dofBlur ).toBeCloseTo( 0.06, 9 );
		expect( cameraStore().activePreset ).toBe( 'custom' );

	} );

	it( 'switches between Simple and Pro, and remembers the choice', async () => {

		const app = await withApp();
		cameraStore().handleDofModeChange( 'physical' );

		expect( app.values.dofMode ).toBe( 'physical' );
		expect( cameraStore().dofMode ).toBe( 'physical' );
		expect( localStorage.getItem( 'rayzee-dof-mode' ) ).toBe( 'physical' );

		cameraStore().handleDofModeChange( 'look' );
		expect( localStorage.getItem( 'rayzee-dof-mode' ) ).toBe( 'look' );

	} );

	it( 'keeps Simple or Pro when switching cameras', async () => {

		await withApp( {}, { dofMode: 'physical' } );
		cameraStore().applyCameraEffects( { dofMode: 'look', dofBlur: 0.02 } );

		expect( cameraStore().dofMode ).toBe( 'physical' );
		expect( cameraStore().dofBlur ).toBe( 0.02 );

	} );

	it( 'takes a typed real size as the scale between scene units and metres', async () => {

		const app = await withApp();
		cameraStore().handleSubjectSizeChange( 0.04 );

		expect( app.values.unitsPerMetre ).toBeCloseTo( MODEL_SIZE / 0.04, 9 );
		expect( cameraStore().unitsPerMetre ).toBeCloseTo( MODEL_SIZE / 0.04, 9 );

	} );

	it( 'ignores a size that is not positive', async () => {

		const app = await withApp();
		cameraStore().handleSubjectSizeChange( 0 );
		cameraStore().handleSubjectSizeChange( NaN );

		expect( app.values.unitsPerMetre ).toBe( 1 );

	} );

	it( 'reads the new model\'s size and goes back to its file units on load', async () => {

		const app = await withApp( {}, { modelDimensions: [ 1, 1, 1 ], unitsPerMetre: 40 } );
		cameraStore().syncModelSize( { resetUnits: true } );

		expect( cameraStore().modelDimensions ).toEqual( [ 1.5, MODEL_SIZE, 2.3 ] );
		expect( cameraStore().unitsPerMetre ).toBe( 1 );
		expect( app.values.unitsPerMetre ).toBe( 1 );

	} );

	it( 'keeps a typed size through a rebuild that is not a new model', async () => {

		const app = await withApp( {}, { unitsPerMetre: 40 } );
		cameraStore().syncModelSize();

		expect( cameraStore().unitsPerMetre ).toBe( 40 );
		expect( app.settings.set ).not.toHaveBeenCalled();

	} );

	it( 'stores an auto-focus distance only when the readout would change', async () => {

		await withApp( {}, { focusDistance: 4.5831 } );
		const before = store.useCameraStore.getState();
		cameraStore().setAutoFocusDistance( 4.5834 );
		expect( store.useCameraStore.getState() ).toBe( before );

		cameraStore().setAutoFocusDistance( 4.62 );
		expect( cameraStore().focusDistance ).toBe( 4.62 );

	} );

} );
