import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock( '@/core/viewer/picture/AIUpscalerWorker.js?worker&inline', () => ( { default: class {} } ) );

const { AIUpscaler } = await import( '@/core/viewer/picture/AIUpscaler.js' );

describe( 'AIUpscaler time left', () => {

	afterEach( () => vi.restoreAllMocks() );

	// A 4 × 2 tile image whose first tile takes 5 s (the model's warm-up) and every other tile 2 s.
	const run = async () => {

		const output = { getContext: () => ( { putImageData() {} } ) };
		const upscaler = new AIUpscaler( output, { domElement: {} }, { tileSize: 64 } );
		const step = 64 - 16 * 2;
		upscaler._capturedSource = { width: step * 4, height: step * 2 };
		upscaler.state.abortController = new AbortController();
		upscaler._cacheUpscaledAlpha = () => {};

		upscaler._extractTile = () => null;
		upscaler._tensorToImageData = () => null;

		let clock = 0;
		vi.spyOn( performance, 'now' ).mockImplementation( () => clock );
		upscaler._inferTile = async () => {

			clock += clock === 0 ? 5000 : 2000;

		};

		const events = [];
		upscaler.addEventListener( 'progress', e => events.push( { progress: e.progress, secondsLeft: e.secondsLeft } ) );
		await upscaler._runUpscale();
		return events;

	};

	it( 'leaves the first tile out and times the rest', async () => {

		const events = await run();

		expect( events ).toHaveLength( 8 );
		expect( events[ 0 ] ).toEqual( { progress: 1 / 8, secondsLeft: null } );
		// 2 s a tile once warm, for the tiles still to go: 6 left after the second, none after the last.
		expect( events.slice( 1 ).map( e => e.secondsLeft ) ).toEqual( [ 12, 10, 8, 6, 4, 2, 0 ] );

	} );

} );
