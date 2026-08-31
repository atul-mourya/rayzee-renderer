import { describe, it, expect, vi } from 'vitest';
import { PathTracerApp } from '@/core/PathTracerApp.js';
import { captureHeadless, openHeadless } from '@/core/Headless.js';
import { NoToneMapping } from 'three';

/**
 * renderToBuffer() touches the stage, the renderer and the settings. Drive it against a bare
 * receiver: a real app needs a GPU, and everything under test here is orchestration.
 */
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
	};

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

	// The pool over-allocates to the reserved size, so reading the texture's own extent would
	// return a mostly-empty buffer around a small frame.
	it( 'reads the stage size, not the texture size', async () => {

		const app = makeApp( { width: 2, height: 1 } );
		await app.renderToBuffer( { colorSpace: 'linear' } );

		const [ , x, y, w, h ] = app.renderer.readRenderTargetPixelsAsync.mock.calls[ 0 ];
		expect( [ x, y, w, h ] ).toEqual( [ 0, 0, 2, 1 ] );

	} );

	it( 'rejects an unknown colour space instead of guessing', async () => {

		await expect( makeApp().renderToBuffer( { colorSpace: 'rec2020' } ) ).rejects.toThrow( /colorSpace must be/ );

	} );

	it( 'explains itself when nothing has rendered yet', async () => {

		const app = makeApp();
		app.stages.pathTracer.storageTextures.readTarget = null;

		await expect( app.renderToBuffer() ).rejects.toThrow( /call init\(\) and render/ );

	} );

} );

describe( 'captureHeadless', () => {

	function fakeApp( { samples = 64, issues = [] } = {} ) {

		return {
			renderFrames: vi.fn( async ( n, opts ) => (
				opts.allowEarlyRetire ? { samples, target: n, retiredBy: 'converged' } : samples
			) ),
			renderToBuffer: vi.fn( async () => ( {
				data: new Uint8ClampedArray( 4 ), width: 1, height: 1, colorSpace: 'srgb',
			} ) ),
			issues,
			adapterInfo: { vendor: 'apple', isSoftware: false },
		};

	}

	it( 'reports a full-count render', async () => {

		const out = await captureHeadless( fakeApp( { samples: 32 } ), { samples: 32 } );

		expect( out ).toMatchObject( { samples: 32, retiredBy: 'count', width: 1, colorSpace: 'srgb' } );

	} );

	// renderFrames changes its return type with allowEarlyRetire; unwrapping the wrong shape
	// would silently report `undefined` samples for every adaptive render.
	it( 'unwraps the early-retire shape', async () => {

		const out = await captureHeadless( fakeApp( { samples: 9 } ), { samples: 64, allowEarlyRetire: true } );

		expect( out.samples ).toBe( 9 );
		expect( out.retiredBy ).toBe( 'converged' );

	} );

	// A lenient caller's whole workflow: render, then decide whether it is publishable.
	it( 'hands back what the engine survived', async () => {

		const issues = [ { code: 'texture.build_failed', severity: 'error' } ];
		const out = await captureHeadless( fakeApp( { issues } ), {} );

		expect( out.issues ).toEqual( issues );
		expect( out.adapter.vendor ).toBe( 'apple' );

	} );

	it( 'passes the colour space through to the readback', async () => {

		const app = fakeApp();
		await captureHeadless( app, { colorSpace: 'linear' } );

		expect( app.renderToBuffer ).toHaveBeenCalledWith( { colorSpace: 'linear' } );

	} );

} );

describe( 'openHeadless', () => {

	// The batch renderer's defaults, not the viewer's — and the reason this module exists.
	it( 'requires a canvas rather than failing later inside init', async () => {

		await expect( openHeadless( {} ) ).rejects.toThrow( /canvas is required/ );

	} );

} );
