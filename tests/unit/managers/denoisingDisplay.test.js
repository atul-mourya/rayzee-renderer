import { describe, it, expect, vi } from 'vitest';

vi.mock( '@/core/Passes/OIDNDenoiser.js', () => ( { OIDNDenoiser: class {} } ) );
vi.mock( '@/core/Passes/AIUpscaler.js', () => ( { AIUpscaler: class {} } ) );

const { DenoisingManager } = await import( '@/core/managers/DenoisingManager.js' );

const OUTPUT_KEY = 'oidn:output';

function makeDenoiser( { produced = true } = {} ) {

	return {
		enabled: true,
		quality: 'fast',
		lastDenoiseMs: 20,
		hasOutput: produced,
		outputTexture: { name: OUTPUT_KEY },
		state: { isDenoising: false, isLoading: false },
		abort: vi.fn(),
		invalidateOutput: vi.fn( function () {

			this.hasOutput = false;

		} ),
		start: vi.fn( async () => true ),
		updateQuality: vi.fn(),
		expectsCleanAux: () => false,
		setSize: vi.fn(),
	};

}

function makeManager( denoiserOpts ) {

	const mainCanvas = { width: 8, height: 8, parentNode: null, style: { opacity: '1' } };
	const textures = new Map();

	const manager = new DenoisingManager( {
		renderer: {},
		mainCanvas,
		scene: {},
		camera: {},
		stages: { pathTracer: { setAuxGBufferEnabled: vi.fn(), setCleanAuxNormal: vi.fn() } },
		pipeline: { context: {
			setTexture: ( k, v ) => textures.set( k, v ),
			removeTexture: ( k ) => textures.delete( k ),
			getTexture: ( k ) => textures.get( k ),
		} },
		getExposure: () => 1,
		getSaturation: () => 1,
		getTransparentBg: () => false,
	} );

	manager.denoiser = makeDenoiser( denoiserOpts );
	manager.continuousDenoise = true;
	manager._publishOutput();

	const shown = () => ( textures.has( OUTPUT_KEY ) ? 'denoised' : 'raw' );

	return { manager, mainCanvas, textures, shown };

}

describe( 'DenoisingManager — what the compositor is told to show', () => {

	it( 'keeps the denoised picture when the view has not moved', () => {

		const { manager, mainCanvas, shown } = makeManager();

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( shown() ).toBe( 'denoised' );
		expect( manager.denoiser.invalidateOutput ).not.toHaveBeenCalled();

	} );

	// The callers that want the live render back: the post-process chain being reconfigured, and a
	// finished render being resumed.
	it( 'takes it away when the caller asks for the live render back', () => {

		const { manager, mainCanvas, shown } = makeManager();

		manager.abort( mainCanvas, { keepDisplay: false } );

		expect( shown() ).toBe( 'raw' );
		expect( manager.denoiser.invalidateOutput ).toHaveBeenCalled();

	} );

	it( 'keeps it through a camera move a denoise can follow', () => {

		const { manager, mainCanvas, shown } = makeManager();
		manager._stages.pathTracer.viewIsChanging = true;
		manager._movingDenoiseMs.push( 50 );

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( shown() ).toBe( 'denoised' );
		expect( manager.denoiser.abort ).not.toHaveBeenCalled();

	} );

	it( 'takes it away through a camera move a denoise cannot follow', () => {

		const { manager, mainCanvas, shown } = makeManager();
		manager._stages.pathTracer.viewIsChanging = true;
		manager._movingDenoiseMs.push( 2000 );

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( shown() ).toBe( 'raw' );

	} );

	it( 'takes it away when OIDN does not own the live view — nothing would replace it', () => {

		const { manager, mainCanvas, shown } = makeManager();
		manager.continuousDenoise = false;

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( shown() ).toBe( 'raw' );

	} );

	it( 'takes it away when no denoise has produced a picture yet', () => {

		const { manager, mainCanvas, shown } = makeManager( { produced: false } );

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( shown() ).toBe( 'raw' );

	} );

	// Reset runs every frame of a camera drag; cancelling the run in flight each time means none of
	// them ever lands, and the picture on screen never gets replaced.
	it( 'lets the denoise in flight finish when its picture is the one being waited on', () => {

		const { manager, mainCanvas } = makeManager();

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( manager.denoiser.abort ).not.toHaveBeenCalled();

	} );

	it( 'cancels it when the picture is being dropped anyway', () => {

		const { manager, mainCanvas } = makeManager();

		manager.abort( mainCanvas, { keepDisplay: false } );

		expect( manager.denoiser.abort ).toHaveBeenCalled();

	} );

	it( 'hides the upscaler canvas on any reset — its enlarged result is stale too', () => {

		const { manager, mainCanvas } = makeManager();
		manager.upscalerCanvas = { style: { display: 'block' } };

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( manager.upscalerCanvas.style.display ).toBe( 'none' );

	} );

} );

describe( 'DenoisingManager — a scene that is gone', () => {

	it( 'takes the picture away rather than holding it over a scene that no longer exists', () => {

		const { manager, shown } = makeManager();

		manager.dropDisplay();

		expect( shown() ).toBe( 'raw' );
		expect( manager.denoiser.invalidateOutput ).toHaveBeenCalled();

	} );

	it( 'then has nothing to hold on the reset that follows', () => {

		const { manager, mainCanvas, shown } = makeManager();

		manager.dropDisplay();
		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( shown() ).toBe( 'raw' );

	} );

} );

describe( 'DenoisingManager — first refresh of an accumulation', () => {

	it( 'waits one denoise, where a later refresh waits two', () => {

		const { manager } = makeManager();
		manager.continuousDenoiseInterval = 0;
		manager.denoiser.lastDenoiseMs = 40;

		// 60 ms since the previous denoise: past one period, short of two.
		manager._lastCadenceAt = performance.now() - 60;
		expect( manager.tickContinuousDenoise( 1 ) ).toBe( true );

		manager._lastCadenceAt = performance.now() - 60;
		expect( manager.tickContinuousDenoise( 2 ) ).toBe( false );

	} );

} );
