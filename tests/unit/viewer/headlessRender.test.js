import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp } from '@/core/viewer/PathTracerApp.js';
import { captureHeadless, openHeadless } from '@/core/viewer/Headless.js';
import { NoToneMapping } from 'three';
import { IssueLog } from '@/core/EngineIssues.js';

/** Bare receiver: a real app needs a GPU, and everything here is orchestration. */
function makeApp( { width = 2, height = 1, pixel = [ 0.5, 0.25, 0.125, 1 ], target = {}, transparent = false } = {} ) {

	const pixels = new Float32Array( width * height * 4 );
	for ( let i = 0; i < pixels.length; i += 4 ) pixels.set( pixel, i );

	return {
		stages: { pathTracer: { width, height, storageTextures: { readTarget: target } } },
		settings: { get: ( key ) => ( { saturation: 1, transparentBackground: transparent } )[ key ] },
		renderer: {
			toneMappingExposure: 1,
			toneMapping: NoToneMapping,
			readRenderTargetPixelsAsync: vi.fn( async () => pixels ),
		},
		renderToBuffer: PathTracerApp.prototype.renderToBuffer,
		_readPicture: PathTracerApp.prototype._readPicture,
		_readDisplaySource: PathTracerApp.prototype._readDisplaySource,
		_displaySource: PathTracerApp.prototype._displaySource,
		_readbackPass: PathTracerApp.prototype._readbackPass,
		_readTexture: PathTracerApp.prototype._readTexture,
		_toneMapOnGPU: PathTracerApp.prototype._toneMapOnGPU,
		_displayGain: () => null,
		_toneMapFallback: PathTracerApp.prototype._toneMapFallback,
		_denoiserInUse: PathTracerApp.prototype._denoiserInUse,
		_issues: new IssueLog(),
	};

}

/** A pipeline whose Compositor resolves `key`, as a denoiser that has published would. */
function withPublished( app, key, texture = {} ) {

	app.pipeline = { context: {} };
	app.stages.compositor = { resolveLightSource: () => ( key ? { key, texture } : null ) };
	app._textureReadback = { read: vi.fn( async () => new Float32Array( 8 ).fill( 0.75 ) ) };
	return app;

}

describe( 'renderToBuffer', () => {

	it( 'returns the raw accumulation in linear', async () => {

		const app = makeApp();
		const out = await app.renderToBuffer( { colorSpace: 'linear' } );

		expect( out.colorSpace ).toBe( 'linear' );
		expect( out.data ).toBeInstanceOf( Float32Array );
		expect( out.data[ 0 ] ).toBeCloseTo( 0.5 );
		expect( out ).toMatchObject( { width: 2, height: 1 } );

	} );

	it( 'returns display-ready bytes in srgb', async () => {

		const out = await makeApp().renderToBuffer();

		expect( out.colorSpace ).toBe( 'srgb' );
		expect( out.data ).toBeInstanceOf( Uint8ClampedArray );
		expect( out.data[ 0 ] ).toBeGreaterThan( 180 ); // linear 0.5 through the sRGB curve
		expect( out.data[ 3 ] ).toBe( 255 );

	} );

	it( 'takes the bytes tone-mapped on the GPU without reading the float image back', async () => {

		const app = makeApp( { transparent: true } );
		const bytes = new Uint8ClampedArray( 8 ).fill( 7 );
		app._toneMapOnGPU = vi.fn( async () => bytes );

		const out = await app.renderToBuffer( { preserveAlpha: true } );
		expect( out.data ).toBe( bytes );
		expect( out.toneMappedOn ).toBe( 'gpu' );
		expect( app._toneMapOnGPU.mock.calls[ 0 ][ 4 ] ).toMatchObject( { toneMapping: NoToneMapping, preserveAlpha: true } );
		expect( app.renderer.readRenderTargetPixelsAsync ).not.toHaveBeenCalled();
		expect( app._issues.list ).toHaveLength( 0 );

	} );

	// The accumulation's alpha is coverage: 0 where the camera saw only the backdrop, whatever the backdrop shows.
	it( 'reads an opaque backdrop back opaque, and coverage only while the background is transparent', async () => {

		const backdrop = [ 0.3, 0.3, 0.3, 0 ];
		expect( ( await makeApp( { pixel: backdrop } ).renderToBuffer( { colorSpace: 'linear' } ) ).data[ 3 ] ).toBe( 1 );
		expect( ( await makeApp( { pixel: backdrop, transparent: true } ).renderToBuffer( { colorSpace: 'linear' } ) ).data[ 3 ] ).toBe( 0 );

		expect( ( await makeApp( { pixel: backdrop } ).renderToBuffer( { preserveAlpha: true } ) ).data[ 3 ] ).toBe( 255 );
		expect( ( await makeApp( { pixel: backdrop, transparent: true } ).renderToBuffer( { preserveAlpha: true } ) ).data[ 3 ] ).toBe( 0 );

	} );

	describe( 'when the GPU tone map is not available', () => {

		const fallbacks = {
			'no device': () => {},
			'no GPU texture': ( app ) => {

				app.renderer.backend = { device: {}, get: () => ( {} ) };

			},
			'the pass throws': ( app ) => {

				app.renderer.backend = { device: {}, get: () => {

					throw new Error( 'device lost' );

				} };

			},
		};

		for ( const [ name, setup ] of Object.entries( fallbacks ) ) {

			it( `${name}: tone maps on the CPU, says so, and records a warning`, async () => {

				const app = makeApp( { target: { textures: [ {} ] } } );
				setup( app );
				const out = await app.renderToBuffer();

				expect( out.toneMappedOn ).toBe( 'cpu' );
				expect( out.data[ 0 ] ).toBeGreaterThan( 180 );
				expect( app._issues.list ).toEqual( [ expect.objectContaining( {
					code: 'output.tonemap_fallback', severity: 'warning', detail: expect.objectContaining( { reason: expect.any( String ) } ),
				} ) ] );

			} );

		}

		it( 'keeps the thrown error as the cause', async () => {

			const app = makeApp( { target: { textures: [ {} ] } } );
			fallbacks[ 'the pass throws' ]( app );
			await app.renderToBuffer();

			expect( app._issues.list[ 0 ].detail.cause ).toBe( 'device lost' );

		} );

		it( 'does not throw when strict — the picture is right, only slower', async () => {

			const app = makeApp();
			app._issues = new IssueLog( { strict: true } );

			await expect( app.renderToBuffer() ).resolves.toMatchObject( { toneMappedOn: 'cpu' } );
			expect( app._issues.list.map( ( i ) => i.code ) ).toEqual( [ 'output.tonemap_fallback' ] );

		} );

	} );

	it( 'reads the stage size, not the texture size', async () => {

		const app = makeApp( { width: 2, height: 1 } );
		await app.renderToBuffer( { colorSpace: 'linear' } );

		const [ , x, y, w, h ] = app.renderer.readRenderTargetPixelsAsync.mock.calls[ 0 ];
		expect( [ x, y, w, h ] ).toEqual( [ 0, 0, 2, 1 ] );

	} );

	it( 'rejects an unknown colour space instead of guessing', async () => {

		await expect( makeApp().renderToBuffer( { colorSpace: 'rec2020' } ) ).rejects.toThrow( /colorSpace must be/ );

	} );

	it( 'says the accumulation is what it read', async () => {

		expect( ( await makeApp().renderToBuffer( { colorSpace: 'linear' } ) ).source ).toBe( 'accumulation' );

	} );

	it( 'reads and names the denoised picture for source: display', async () => {

		const app = withPublished( makeApp(), 'oidn:output' );
		const out = await app.renderToBuffer( { colorSpace: 'linear', source: 'display' } );

		expect( out.source ).toBe( 'oidn' );
		expect( out.data[ 0 ] ).toBeCloseTo( 0.75 );
		expect( app._issues.list ).toHaveLength( 0 );

	} );

	it( 'records the fallback when a denoiser is on but has not published', async () => {

		const app = withPublished( makeApp(), 'pathtracer:color' );
		app.denoisingManager = { denoiser: { enabled: true }, denoiserStrategy: 'none' };
		const out = await app.renderToBuffer( { colorSpace: 'linear', source: 'display' } );

		expect( out.source ).toBe( 'accumulation' );
		expect( app._issues.list.map( ( i ) => i.code ) ).toEqual( [ 'output.source_fallback' ] );

	} );

	it( 'throws on that fallback when strict', async () => {

		const app = withPublished( makeApp(), null );
		app._issues = new IssueLog( { strict: true } );
		app.denoisingManager = { denoiser: null, denoiserStrategy: 'nrd' };

		await expect( app.renderToBuffer( { source: 'display' } ) ).rejects.toThrow( /output.source_fallback/ );

	} );

	it( 'records nothing when no denoiser is in use, since the accumulation is the display', async () => {

		const app = withPublished( makeApp(), 'pathtracer:color' );
		app.denoisingManager = { denoiser: { enabled: false }, denoiserStrategy: 'none' };
		app._toneMapOnGPU = vi.fn( async () => new Uint8ClampedArray( 8 ) );
		const out = await app.renderToBuffer( { source: 'display' } );

		expect( out.source ).toBe( 'accumulation' );
		expect( app._issues.list ).toHaveLength( 0 );

	} );

	it( 'explains itself when nothing has rendered yet', async () => {

		const app = makeApp();
		app.stages.pathTracer.storageTextures.readTarget = null;

		await expect( app.renderToBuffer() ).rejects.toThrow( /call init\(\) and render/ );

	} );

} );

describe( 'captureHeadless', () => {

	function fakeApp( { samples = 64, issues = [], finalDenoise = false } = {} ) {

		const order = [];
		return {
			order,
			denoisingManager: {
				finalDenoise,
				applyOIDNEnabled: vi.fn( function ( on ) {

					order.push( 'enable' );
					this.finalDenoise = on;

				} ),
				_syncGBufferStages: vi.fn(),
			},
			runFinalDenoise: vi.fn( async () => {

				order.push( 'denoise' );
				return true;

			} ),
			renderFrames: vi.fn( async () => {

				order.push( 'accumulate' );
				return samples;

			} ),
			renderToBuffer: vi.fn( async () => ( {
				data: new Uint8ClampedArray( 4 ), width: 1, height: 1, colorSpace: 'srgb',
			} ) ),
			issues,
			adapterInfo: { vendor: 'apple', isSoftware: false },
			getProvenance: () => ( { engine: 'x.y.z' } ),
		};

	}

	it( 'reports a full-count render', async () => {

		const out = await captureHeadless( fakeApp( { samples: 32 } ), { samples: 32 } );

		expect( out ).toMatchObject( { samples: 32, retiredBy: 'count', width: 1, colorSpace: 'srgb' } );

	} );

	it( 'derives retiredBy from a short count', async () => {

		const out = await captureHeadless( fakeApp( { samples: 9 } ), { samples: 64, allowEarlyRetire: true } );

		expect( out ).toMatchObject( { samples: 9, retiredBy: 'converged' } );

	} );

	it( 'hands back what the engine survived', async () => {

		const issues = [ { code: 'texture.build_failed', severity: 'error' } ];
		const out = await captureHeadless( fakeApp( { issues } ), {} );

		expect( out.issues ).toEqual( issues );
		expect( out.adapter.vendor ).toBe( 'apple' );
		expect( out.provenance.engine ).toBe( 'x.y.z' );

	} );

	it( 'passes the colour space through to the readback', async () => {

		const app = fakeApp();
		await captureHeadless( app, { colorSpace: 'linear' } );

		expect( app.renderToBuffer ).toHaveBeenCalledWith( { colorSpace: 'linear', source: 'accumulation' } );

	} );

	it( 'leaves the denoiser alone unless asked', async () => {

		const app = fakeApp();
		await captureHeadless( app, {} );

		expect( app.runFinalDenoise ).not.toHaveBeenCalled();
		expect( app.denoisingManager.applyOIDNEnabled ).not.toHaveBeenCalled();

	} );

	it( 'with denoise: turns OIDN on before accumulating, denoises once, reads the display', async () => {

		const app = fakeApp();
		await captureHeadless( app, { denoise: true } );

		expect( app.order ).toEqual( [ 'enable', 'accumulate', 'denoise' ] );
		expect( app.denoisingManager._syncGBufferStages ).toHaveBeenCalledOnce();
		expect( app.runFinalDenoise ).toHaveBeenCalledOnce();
		expect( app.renderToBuffer ).toHaveBeenCalledWith( { colorSpace: 'srgb', source: 'display' } );

	} );

	it( 'with denoise and OIDN already on, does not touch the switch', async () => {

		const app = fakeApp( { finalDenoise: true } );
		await captureHeadless( app, { denoise: true } );

		expect( app.denoisingManager.applyOIDNEnabled ).not.toHaveBeenCalled();
		expect( app.order ).toEqual( [ 'accumulate', 'denoise' ] );

	} );

	it( 'with a denoise object: sets the model and tile cap before accumulating', async () => {

		const app = fakeApp();
		const dm = app.denoisingManager;
		dm.applyOIDNQuality = vi.fn( () => app.order.push( 'quality' ) );
		dm.denoiser = {
			updateQuality: vi.fn( async () => {} ),
			updateConfiguration: vi.fn( async () => app.order.push( 'tile' ) ),
		};
		await captureHeadless( app, { denoise: { quality: 'high', tileSize: 2048 } } );

		expect( app.order ).toEqual( [ 'quality', 'tile', 'enable', 'accumulate', 'denoise' ] );
		expect( dm.denoiser.updateQuality ).toHaveBeenCalledWith( 'high' );
		expect( dm.denoiser.updateConfiguration ).toHaveBeenCalledWith( { tileSize: 2048 } );

	} );

	it( 'rejects an unknown model before rendering anything', async () => {

		const app = fakeApp();
		app.denoisingManager.applyOIDNQuality = vi.fn();
		app.denoisingManager.denoiser = { updateQuality: async ( q ) => {

			throw new Error( `Invalid quality setting: ${q}` );

		} };

		await expect( captureHeadless( app, { denoise: { quality: 'ultra' } } ) ).rejects.toThrow( /Invalid quality/ );
		expect( app.denoisingManager.applyOIDNQuality ).not.toHaveBeenCalled();
		expect( app.renderFrames ).not.toHaveBeenCalled();

	} );

} );

describe( 'captureHeadless on the way', () => {

	/** An accumulation 1 + 1/n bright after n samples, against a reference of 1: its error falls as 1/n². */
	function steppingApp( { width = 2, height = 1, retireAt = Infinity, firstSample = null } = {} ) {

		let total = 0;
		const calls = [];
		const app = {
			calls,
			stages: { pathTracer: { width, height } },
			renderFrames: vi.fn( async ( count, options ) => {

				calls.push( [ 'render', count, options ] );
				total = Math.min( ( options.reset ? 0 : total ) + count, retireAt );
				return total;

			} ),
			renderToBuffer: vi.fn( async ( { colorSpace, source } ) => {

				calls.push( [ 'read', colorSpace, source, total ] );
				const data = colorSpace === 'linear' ? new Float32Array( width * height * 4 ).fill( 1 + 1 / total ) : new Uint8ClampedArray( width * height * 4 ).fill( total );
				return { data, width, height, colorSpace, source };

			} ),
			runFinalDenoise: vi.fn( async () => true ),
			denoisingManager: null,
			issues: [],
			adapterInfo: {},
			getProvenance: () => ( { render: { firstSample } } ),
		};
		return app;

	}

	const reference = ( width = 2, height = 1 ) => ( { data: new Float32Array( width * height * 4 ).fill( 1 ), width, height } );

	it( 'gathers one stats block on request, timing the GPU for that capture only', async () => {

		const app = steppingApp();
		let tracking = false;
		Object.assign( app, {
			renderer: { backend: { get trackTimestamp() {

				return tracking;

			} } },
			enableGPUTiming: vi.fn( ( on ) => ( tracking = on ) ),
			getStatistics: () => ( { triangles: 3 } ),
			getMemoryInfo: () => ( { current: 1, peak: 2, byCategory: {} } ),
			getHostMemoryInfo: () => null,
			getConvergenceStats: () => ( { converged: 0 } ),
			getKernelGPUTimings: vi.fn( async () => ( tracking ? { kernels: { shade: 1.5 }, total: 2, unattributed: 0.5, frame: 9 } : null ) ),
		} );

		const plain = await captureHeadless( app, { samples: 4 } );
		expect( plain.stats ).toBeUndefined();
		expect( app.enableGPUTiming ).not.toHaveBeenCalled();

		const out = await captureHeadless( app, { samples: 4, stats: true } );
		expect( out.stats ).toEqual( {
			scene: { triangles: 3 }, gpuMemory: { current: 1, peak: 2, byCategory: {} }, hostMemory: null,
			convergence: { converged: 0 }, kernels: { kernels: { shade: 1.5 }, total: 2, unattributed: 0.5, frame: 9 },
		} );
		expect( tracking ).toBe( false );

		// A host that timed already keeps its timing on.
		tracking = true;
		await captureHeadless( app, { samples: 4, stats: true } );
		expect( tracking ).toBe( true );

	} );

	it( 'renders in one go when nothing asks to look on the way', async () => {

		const app = steppingApp();
		await captureHeadless( app, { samples: 100 } );
		expect( app.renderFrames ).toHaveBeenCalledOnce();
		expect( app.renderFrames.mock.calls[ 0 ][ 0 ] ).toBe( 100 );

	} );

	// pbrt's cadence for --write-partial-images: waves of 1, 1, 2, 4 … 64, then 64 at a time.
	it( 'hands onStep the accumulation at pbrt\'s partial-image counts, continuing the one render', async () => {

		const app = steppingApp();
		const seen = [];
		const out = await captureHeadless( app, { samples: 200, onStep: ( frame, { samples } ) => void seen.push( [ samples, frame.data[ 0 ], frame.source ] ) } );

		expect( seen.map( ( [ n ] ) => n ) ).toEqual( [ 1, 2, 4, 8, 16, 32, 64, 128, 192 ] );
		expect( seen.every( ( [ n, byte, source ] ) => byte === n && source === 'accumulation' ) ).toBe( true );
		const renders = app.calls.filter( ( [ kind ] ) => kind === 'render' );
		expect( renders.map( ( [ , count ] ) => count ).reduce( ( a, b ) => a + b ) ).toBe( 200 );
		expect( renders.map( ( [ , , { reset } ] ) => reset ) ).toEqual( [ true, ...Array( 9 ).fill( false ) ] );
		expect( out.samples ).toBe( 200 );

	} );

	it( 'awaits onStep before rendering on', async () => {

		const app = steppingApp();
		let release;
		const held = new Promise( ( resolve ) => void ( release = resolve ) );
		const capture = captureHeadless( app, { samples: 4, steps: [ 2 ], onStep: () => held } );
		await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );
		expect( app.renderFrames ).toHaveBeenCalledOnce();
		release();
		await capture;
		expect( app.renderFrames ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'takes steps as every N samples or as a list', async () => {

		const every = steppingApp(), list = steppingApp();
		const at = ( app ) => app.calls.filter( ( [ kind ] ) => kind === 'read' ).map( ( call ) => call[ 3 ] );
		await captureHeadless( every, { samples: 10, steps: 4, onStep: () => {} } );
		await captureHeadless( list, { samples: 10, steps: [ 7, 3, 3, 12 ], onStep: () => {} } );

		expect( at( every ) ).toEqual( [ 4, 8, 10 ] );
		expect( at( list ) ).toEqual( [ 3, 7, 10 ] );

	} );

	it( 'refuses steps that are not sample counts', async () => {

		for ( const steps of [ 0, - 4, 2.5, [ 1, 0 ], 'often' ] ) {

			await expect( captureHeadless( steppingApp(), { steps } ) ).rejects.toThrow( /steps must be/ );

		}

	} );

	// pbrt's --mse-reference-image: the error at each step, and at the end.
	it( 'measures the accumulation against a reference at each step and at the end', async () => {

		const out = await captureHeadless( steppingApp(), { samples: 4, steps: 2, reference: reference() } );

		expect( out.errors.map( ( e ) => e.samples ) ).toEqual( [ 2, 4 ] );
		expect( out.errors[ 0 ].mse ).toBeCloseTo( 0.25 );
		expect( out.errors[ 1 ].mse ).toBeCloseTo( 0.0625 );
		expect( out.errors[ 1 ] ).toMatchObject( { relativeBias: expect.closeTo( 0.25 ), pixels: 2 } );

	} );

	it( 'reads a linear frame once when it is also what is measured', async () => {

		const app = steppingApp();
		await captureHeadless( app, { samples: 4, steps: 2, colorSpace: 'linear', reference: reference(), onStep: () => {} } );
		expect( app.renderToBuffer ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'measures the raw accumulation, then denoises and reads the display', async () => {

		const app = steppingApp();
		app.denoisingManager = { finalDenoise: true, _syncGBufferStages: () => {} };
		const out = await captureHeadless( app, { samples: 4, denoise: true, reference: reference() } );

		const reads = app.calls.filter( ( [ kind ] ) => kind === 'read' ).map( ( [ , colorSpace, source ] ) => `${colorSpace}/${source}` );
		expect( reads.at( - 2 ) ).toBe( 'linear/accumulation' );
		expect( reads.at( - 1 ) ).toBe( 'srgb/display' );
		expect( out.errors.at( - 1 ).samples ).toBe( 4 );

	} );

	it( 'stops stepping where the render retired early', async () => {

		const app = steppingApp( { retireAt: 5 } );
		const out = await captureHeadless( app, { samples: 64, steps: 4, allowEarlyRetire: true, reference: reference() } );
		expect( out.errors.map( ( e ) => e.samples ) ).toEqual( [ 4, 5 ] );
		expect( out ).toMatchObject( { samples: 5, retiredBy: 'converged' } );

	} );

	it( 'refuses a reference it could not measure against, before rendering', async () => {

		const app = steppingApp();
		await expect( captureHeadless( app, { reference: reference( 3, 1 ) } ) ).rejects.toThrow( /render's size \(2×1\)/ );
		await expect( captureHeadless( app, { reference: { data: new Uint8ClampedArray( 8 ), width: 2, height: 1 } } ) ).rejects.toThrow( /linear floats/ );
		expect( app.renderFrames ).not.toHaveBeenCalled();

	} );

	it( 'starts the render at firstSample and reports where the engine says it started', async () => {

		const app = steppingApp( { firstSample: 64 } );
		const out = await captureHeadless( app, { samples: 4, steps: 2, firstSample: 64, onStep: () => {} } );

		expect( app.renderFrames.mock.calls.map( ( [ , { firstSample } ] ) => firstSample ) ).toEqual( [ 64, 0 ] );
		expect( out.firstSample ).toBe( 64 );

	} );

	it( 'says how long each part took', async () => {

		const out = await captureHeadless( steppingApp(), { samples: 4 } );
		expect( Object.keys( out.timings ) ).toEqual( [ 'render', 'steps', 'denoise', 'readback' ] );
		expect( Object.values( out.timings ).every( ( ms ) => ms >= 0 ) ).toBe( true );

	} );

} );

describe( 'openHeadless', () => {

	it( 'needs no canvas, and says how to supply WebGPU where there is none', async () => {

		await expect( openHeadless( {} ) ).rejects.toThrow( /WebGPU is not available.*navigator\.gpu/ );

	} );

} );
