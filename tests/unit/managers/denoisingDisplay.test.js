import { describe, it, expect, vi } from 'vitest';

vi.mock( '@/core/Passes/OIDNDenoiser.js', () => ( { OIDNDenoiser: class {} } ) );
vi.mock( '@/core/Passes/AIUpscaler.js', () => ( { AIUpscaler: class {} } ) );

const { DenoisingManager } = await import( '@/core/managers/DenoisingManager.js' );

function makeDenoiser( { latched = true } = {} ) {

	return {
		enabled: true,
		quality: 'fast',
		lastDenoiseMs: 20,
		hasLatchedFrame: latched,
		state: { isDenoising: false, isLoading: false },
		input: { style: { opacity: '1' } },
		output: { style: { display: 'block' } },
		abort: vi.fn(),
		invalidateLatch: vi.fn( function () {

			this.hasLatchedFrame = false;

		} ),
		clearOutput: vi.fn( function () {

			this.hasLatchedFrame = false;
			this.cleared = true;

		} ),
		start: vi.fn( async () => true ),
		updateQuality: vi.fn(),
		expectsCleanAux: () => false,
		setSize: vi.fn(),
	};

}

function makeManager( denoiserOpts ) {

	const mainCanvas = { width: 8, height: 8, parentNode: null, style: { opacity: '1' } };

	const manager = new DenoisingManager( {
		renderer: {},
		mainCanvas,
		scene: {},
		camera: {},
		stages: { pathTracer: { setAuxGBufferEnabled: vi.fn(), setCleanAuxNormal: vi.fn() } },
		pipeline: { context: { removeTexture: () => {} } },
		getExposure: () => 1,
		getSaturation: () => 1,
		getTransparentBg: () => false,
	} );

	manager.denoiser = makeDenoiser( denoiserOpts );
	manager.continuousDenoise = true;

	return { manager, mainCanvas };

}

describe( 'DenoisingManager — holding the denoised frame across a reset', () => {

	it( 'keeps it on screen when the view has not moved', () => {

		const { manager, mainCanvas } = makeManager();
		manager.denoiser.input.style.opacity = '0';

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( manager.denoiser.output.style.display ).toBe( 'block' );
		expect( manager.denoiser.invalidateLatch ).not.toHaveBeenCalled();
		expect( manager.denoiser.input.style.opacity ).toBe( '0' );
		expect( mainCanvas.style.opacity ).toBe( '1' );

	} );

	// The callers that want the live render back: the post-process chain being reconfigured, and a
	// finished render being resumed.
	it( 'drops it when the caller asks for the live render back', () => {

		const { manager, mainCanvas } = makeManager();

		manager.abort( mainCanvas, { keepDisplay: false } );

		expect( manager.denoiser.output.style.display ).toBe( 'none' );
		expect( manager.denoiser.invalidateLatch ).toHaveBeenCalled();

	} );

	it( 'keeps it through a camera move a denoise can follow', () => {

		const { manager, mainCanvas } = makeManager();
		manager._stages.pathTracer.viewIsChanging = true;
		manager._movingDenoiseMs.push( 50 );

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( manager.denoiser.output.style.display ).toBe( 'block' );
		expect( manager.denoiser.abort ).not.toHaveBeenCalled();

	} );

	it( 'drops it through a camera move a denoise cannot follow', () => {

		const { manager, mainCanvas } = makeManager();
		manager._stages.pathTracer.viewIsChanging = true;
		manager._movingDenoiseMs.push( 2000 );

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( manager.denoiser.output.style.display ).toBe( 'none' );
		expect( mainCanvas.style.opacity ).toBe( '1' );

	} );

	it( 'drops it when OIDN does not own the live view — nothing would replace it', () => {

		const { manager, mainCanvas } = makeManager();
		manager.continuousDenoise = false;

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( manager.denoiser.output.style.display ).toBe( 'none' );

	} );

	it( 'drops it when the output canvas holds nothing', () => {

		const { manager, mainCanvas } = makeManager( { latched: false } );

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( manager.denoiser.output.style.display ).toBe( 'none' );

	} );

	// Reset runs every frame of a camera drag; cancelling the run in flight each time means none of
	// them ever lands, and the held frame never gets replaced.
	it( 'lets the denoise in flight finish when its frame is the one being waited on', () => {

		const { manager, mainCanvas } = makeManager();

		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( manager.denoiser.abort ).not.toHaveBeenCalled();

	} );

	it( 'cancels it when the frame is being dropped anyway', () => {

		const { manager, mainCanvas } = makeManager();

		manager.abort( mainCanvas, { keepDisplay: false } );

		expect( manager.denoiser.abort ).toHaveBeenCalled();

	} );

	// Assigning width/height clears a 2D canvas even when the value is unchanged, which would
	// throw away the very frame the hold is keeping.
	it( 'does not touch the output canvas when it is already the right size', () => {

		const { manager } = makeManager();
		manager.denoiserCanvas = { width: 0, height: 0 };
		manager.setRenderSize( 512, 512 );
		manager.denoiserCanvas.width = 512;
		manager.denoiserCanvas.height = 512;

		const wasResized = manager.restoreBaseResolution();

		expect( wasResized ).toBe( false );
		expect( manager.denoiser.invalidateLatch ).not.toHaveBeenCalled();

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

describe( 'DenoisingManager — a scene that is gone', () => {

	it( 'throws the frame away rather than holding it over a scene that no longer exists', () => {

		const { manager, mainCanvas } = makeManager();

		manager.dropDisplay();

		expect( manager.denoiser.cleared ).toBe( true );
		expect( manager.denoiser.output.style.display ).toBe( 'none' );
		expect( mainCanvas.style.opacity ).toBe( '1' );

	} );

	it( 'then has nothing to hold on the reset that follows', () => {

		const { manager, mainCanvas } = makeManager();

		manager.dropDisplay();
		manager.abort( mainCanvas, { keepDisplay: true } );

		expect( manager.denoiser.output.style.display ).toBe( 'none' );

	} );

} );
