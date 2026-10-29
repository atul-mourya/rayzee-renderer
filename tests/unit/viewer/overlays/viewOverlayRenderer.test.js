import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SRGBColorSpace } from 'three';

vi.mock( '@/core/RayzeeRenderer.js', () => ( {
	createRendererOnDevice: vi.fn( async ( device, parameters ) => ( {
		device,
		parameters,
		setSize: vi.fn( ( w, h ) => Object.assign( parameters.canvas, { width: w, height: h } ) ),
		setClearColor: vi.fn(),
		setRenderTarget: vi.fn(),
		clear: vi.fn(),
	} ) ),
	disposeRenderer: vi.fn(),
	takeFrameStep: vi.fn(),
} ) );

import { createRendererOnDevice, disposeRenderer, takeFrameStep } from '@/core/RayzeeRenderer.js';
import { ViewOverlayRenderer, createOverlayCanvas, viewPixelSize } from '@/core/viewer/overlays/ViewOverlayRenderer.js';

function style() {

	return {
		display: '',
		set cssText( css ) {

			this.css = css;
			this.display = css.includes( 'display:none' ) ? 'none' : '';

		},
		get cssText() {

			return this.css;

		},
	};

}

const box = ( width, height ) => ( { getBoundingClientRect: () => ( { width, height } ) } );

beforeEach( () => {

	vi.stubGlobal( 'window', { devicePixelRatio: 1 } );
	vi.stubGlobal( 'document', { createElement: () => ( { width: 300, height: 150, style: style(), parentElement: null } ) } );

} );

afterEach( () => {

	vi.unstubAllGlobals();
	vi.clearAllMocks();

} );

describe( 'viewPixelSize', () => {

	it( 'is the on-screen box in device pixels, rounded', () => {

		window.devicePixelRatio = 1.5;
		expect( viewPixelSize( box( 401, 300 ) ) ).toEqual( { width: 602, height: 450 } );

	} );

	it( 'counts at most two device pixels a CSS pixel, and one when the page does not say', () => {

		window.devicePixelRatio = 3;
		expect( viewPixelSize( box( 100, 50 ) ) ).toEqual( { width: 200, height: 100 } );
		window.devicePixelRatio = undefined;
		expect( viewPixelSize( box( 100, 50 ) ) ).toEqual( { width: 100, height: 50 } );

	} );

	it( 'scales both sides alike to fit a ceiling, never below a pixel', () => {

		window.devicePixelRatio = 2;
		expect( viewPixelSize( box( 3000, 1000 ), 4096 ) ).toEqual( { width: 4096, height: 1365 } );
		expect( viewPixelSize( box( 10000, 1 ), 100 ) ).toEqual( { width: 100, height: 1 } );
		expect( viewPixelSize( box( 50, 50 ), 4096 ) ).toEqual( { width: 100, height: 100 } );

	} );

	it( 'is null for no element or one with no layout box', () => {

		expect( viewPixelSize( null ) ).toBeNull();
		expect( viewPixelSize( box( 0, 300 ) ) ).toBeNull();
		expect( viewPixelSize( box( 300, 0 ) ) ).toBeNull();

	} );

} );

describe( 'createOverlayCanvas', () => {

	it( 'covers its container and lets clicks through, parked when asked', () => {

		const shown = createOverlayCanvas();
		expect( shown.style.cssText ).toContain( 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;' );
		expect( shown.style.display ).toBe( '' );
		expect( createOverlayCanvas( true ).style.display ).toBe( 'none' );

	} );

} );

describe( 'ViewOverlayRenderer', () => {

	it( 'starts parked, with no renderer until it is initialised', () => {

		const overlay = new ViewOverlayRenderer();
		expect( overlay.isVisible ).toBe( false );
		expect( overlay.canvas.style.display ).toBe( 'none' );
		expect( () => {

			overlay.syncSize();
			overlay.begin();

		} ).not.toThrow();

	} );

	it( 'draws on the shared device into its own transparent canvas, sized to the source box', async () => {

		const device = {};
		const overlay = await new ViewOverlayRenderer().init( { device, sizeSource: box( 640, 360 ) } );
		const { renderer } = overlay;

		expect( createRendererOnDevice ).toHaveBeenCalledWith( device, { canvas: overlay.canvas, alpha: true, antialias: true } );
		expect( renderer.outputColorSpace ).toBe( SRGBColorSpace );
		expect( renderer.setClearColor ).toHaveBeenCalledWith( 0x000000, 0 );
		expect( renderer.autoClear ).toBe( false );
		expect( renderer.setSize ).toHaveBeenCalledWith( 640, 360, false );

	} );

	it( 'leaves antialiasing to the browser\'s downscale at two device pixels a CSS pixel', async () => {

		window.devicePixelRatio = 2;
		await new ViewOverlayRenderer().init( { device: {}, sizeSource: box( 10, 10 ) } );
		expect( createRendererOnDevice.mock.calls[ 0 ][ 1 ].antialias ).toBe( false );

	} );

	it( 'resizes only when the source box changes, and keeps its size while the source has none', async () => {

		const source = box( 640, 360 );
		const overlay = await new ViewOverlayRenderer().init( { device: {}, sizeSource: source } );
		overlay.syncSize();
		expect( overlay.renderer.setSize ).toHaveBeenCalledOnce();

		source.getBoundingClientRect = () => ( { width: 800, height: 360 } );
		overlay.syncSize();
		expect( overlay.renderer.setSize ).toHaveBeenLastCalledWith( 800, 360, false );

		source.getBoundingClientRect = () => ( { width: 0, height: 0 } );
		overlay.syncSize();
		expect( overlay.renderer.setSize ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'caps the surface at 4096 device pixels a side', async () => {

		window.devicePixelRatio = 2;
		const overlay = await new ViewOverlayRenderer().init( { device: {}, sizeSource: box( 4000, 1000 ) } );
		expect( overlay.renderer.setSize ).toHaveBeenCalledWith( 4096, 1024, false );

	} );

	it( 'clears the canvas itself, not a render target left bound, on a frame step of its own', async () => {

		const overlay = await new ViewOverlayRenderer().init( { device: {}, sizeSource: box( 10, 10 ) } );
		overlay.begin();
		expect( takeFrameStep ).toHaveBeenCalledWith( overlay.renderer );
		expect( overlay.renderer.setRenderTarget ).toHaveBeenCalledWith( null );
		expect( overlay.renderer.clear ).toHaveBeenCalledOnce();
		expect( overlay.renderer.setRenderTarget.mock.invocationCallOrder[ 0 ] ).toBeLessThan( overlay.renderer.clear.mock.invocationCallOrder[ 0 ] );

	} );

	it( 'shows and parks its canvas', () => {

		const overlay = new ViewOverlayRenderer();
		overlay.setVisible( true );
		expect( overlay.isVisible ).toBe( true );
		expect( overlay.canvas.style.display ).toBe( '' );

		overlay.canvas.style.display = 'block';
		overlay.setVisible( true );
		expect( overlay.canvas.style.display ).toBe( 'block' );

		overlay.setVisible( false );
		expect( overlay.isVisible ).toBe( false );
		expect( overlay.canvas.style.display ).toBe( 'none' );

	} );

	it( 'disposes its renderer and leaves the page on dispose', async () => {

		const overlay = await new ViewOverlayRenderer().init( { device: {}, sizeSource: box( 10, 10 ) } );
		const { renderer } = overlay;
		const parent = { removeChild: vi.fn() };
		overlay.canvas.parentElement = parent;

		overlay.dispose();

		expect( disposeRenderer ).toHaveBeenCalledWith( renderer );
		expect( overlay.renderer ).toBeNull();
		expect( parent.removeChild ).toHaveBeenCalledWith( overlay.canvas );

	} );

} );
