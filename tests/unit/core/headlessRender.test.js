import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { captureHeadless, openHeadless } from '@/core/Headless.js';
import { NoToneMapping } from 'three';
import { IssueLog } from '@/core/EngineIssues.js';

/** Bare receiver: a real app needs a GPU, and everything here is orchestration. */
function makeApp( { width = 2, height = 1, pixel = [ 0.5, 0.25, 0.125, 1 ], target = {} } = {} ) {

	const pixels = new Float32Array( width * height * 4 );
	for ( let i = 0; i < pixels.length; i += 4 ) pixels.set( pixel, i );

	return {
		stages: { pathTracer: { width, height, storageTextures: { readTarget: target } } },
		settings: { get: ( key ) => ( key === 'saturation' ? 1 : undefined ) },
		renderer: {
			toneMappingExposure: 1,
			toneMapping: NoToneMapping,
			readRenderTargetPixelsAsync: vi.fn( async () => pixels ),
		},
		renderToBuffer: PathTracerApp.prototype.renderToBuffer,
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

		const app = makeApp();
		const bytes = new Uint8ClampedArray( 8 ).fill( 7 );
		app._toneMapOnGPU = vi.fn( async () => bytes );

		const out = await app.renderToBuffer( { preserveAlpha: true } );
		expect( out.data ).toBe( bytes );
		expect( out.toneMappedOn ).toBe( 'gpu' );
		expect( app._toneMapOnGPU.mock.calls[ 0 ][ 4 ] ).toMatchObject( { toneMapping: NoToneMapping, preserveAlpha: true } );
		expect( app.renderer.readRenderTargetPixelsAsync ).not.toHaveBeenCalled();
		expect( app._issues.list ).toHaveLength( 0 );

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
		app.denoisingManager = { denoiser: null, denoiserStrategy: 'asvgf' };

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

} );

describe( 'openHeadless', () => {

	it( 'needs no canvas, and says how to supply WebGPU where there is none', async () => {

		await expect( openHeadless( {} ) ).rejects.toThrow( /WebGPU is not available.*navigator\.gpu/ );

	} );

} );
