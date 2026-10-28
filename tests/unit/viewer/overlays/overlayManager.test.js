import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventDispatcher } from 'three';

vi.mock( '@/core/RayzeeRenderer.js', () => ( {
	createRendererOnDevice: vi.fn( async ( device, { canvas } ) => ( {
		setSize: vi.fn( ( w, h ) => Object.assign( canvas, { width: w, height: h } ) ),
		setClearColor: vi.fn(),
		setRenderTarget: vi.fn(),
		clear: vi.fn(),
		_frameBufferTargets: new Map( [[ 'output', { bytes: 7 } ]] ),
	} ) ),
	disposeRenderer: vi.fn(),
} ) );

vi.mock( '@/core/viewer/overlays/OutlineHelper.js', () => ( {
	OutlineHelper: class {

		constructor( scene, camera ) {

			Object.assign( this, { scene, camera, layer: 'scene', visible: false } );

		}

	},
} ) );

import { createRendererOnDevice, disposeRenderer } from '@/core/RayzeeRenderer.js';
import { OverlayManager } from '@/core/viewer/overlays/OverlayManager.js';
import { TileHelper } from '@/core/viewer/overlays/TileHelper.js';
import { TransformGizmoHelper } from '@/core/viewer/overlays/TransformGizmoHelper.js';
import { EngineEvents } from '@/core/EngineEvents.js';

// Minimal mocks — OverlayManager only needs a camera ref and a DOM canvas
const createMockCamera = () => ( {} );

// Stub document.createElement for the HUD canvas
const mockCtx = {
	clearRect: vi.fn(),
	strokeRect: vi.fn(),
	save: vi.fn(),
	scale: vi.fn(),
	restore: vi.fn(),
};
const mockCanvas = {
	style: { cssText: '', display: '' },
	getContext: () => mockCtx,
	getBoundingClientRect: () => ( { width: 800, height: 600 } ),
	clientWidth: 800,
	clientHeight: 600,
	width: 0,
	height: 0,
};

vi.stubGlobal( 'document', {
	createElement: () => ( { ...mockCanvas, style: { ...mockCanvas.style } } ),
} );

vi.stubGlobal( 'window', { devicePixelRatio: 1 } );

describe( 'OverlayManager', () => {

	let manager;

	beforeEach( () => {

		manager = new OverlayManager( createMockCamera() );

	} );

	// ── Registration ──

	describe( 'register / unregister', () => {

		it( 'registers a helper by name', () => {

			const helper = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), visible: false };
			manager.register( 'test', helper );
			expect( manager.getHelper( 'test' ) ).toBe( helper );

		} );

		it( 'returns null for unknown helper', () => {

			expect( manager.getHelper( 'missing' ) ).toBeNull();

		} );

		it( 'replaces existing helper and disposes the old one', () => {

			const old = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), visible: false };
			const next = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), visible: false };
			manager.register( 'x', old );
			manager.register( 'x', next );
			expect( old.dispose ).toHaveBeenCalled();
			expect( manager.getHelper( 'x' ) ).toBe( next );

		} );

		it( 'unregister disposes and removes', () => {

			const helper = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), visible: false };
			manager.register( 'x', helper );
			manager.unregister( 'x' );
			expect( helper.dispose ).toHaveBeenCalled();
			expect( manager.getHelper( 'x' ) ).toBeNull();

		} );

	} );

	// ── Visibility API ──

	describe( 'visibility', () => {

		it( 'show / hide delegates to helper', () => {

			const helper = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), visible: false };
			manager.register( 'a', helper );
			manager.show( 'a' );
			expect( helper.show ).toHaveBeenCalled();
			manager.hide( 'a' );
			expect( helper.hide ).toHaveBeenCalled();

		} );

		it( 'toggle flips visibility', () => {

			const helper = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), visible: false };
			manager.register( 'a', helper );
			manager.toggle( 'a' );
			expect( helper.show ).toHaveBeenCalled();
			helper.visible = true;
			manager.toggle( 'a' );
			expect( helper.hide ).toHaveBeenCalled();

		} );

		it( 'isVisible returns helper state', () => {

			const helper = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), visible: true };
			manager.register( 'a', helper );
			expect( manager.isVisible( 'a' ) ).toBe( true );
			helper.visible = false;
			expect( manager.isVisible( 'a' ) ).toBe( false );

		} );

		it( 'isVisible returns false for unknown', () => {

			expect( manager.isVisible( 'nope' ) ).toBe( false );

		} );

	} );

	// ── Dispose ──

	describe( 'dispose', () => {

		it( 'disposes all helpers', () => {

			const a = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), visible: false };
			const b = { show: vi.fn(), hide: vi.fn(), dispose: vi.fn(), visible: false };
			manager.register( 'a', a );
			manager.register( 'b', b );
			manager.dispose();
			expect( a.dispose ).toHaveBeenCalled();
			expect( b.dispose ).toHaveBeenCalled();

		} );

	} );

} );

const camera = {};
const sizeSource = { getBoundingClientRect: () => ( { width: 400, height: 300 } ) };

function helper( layer, visible ) {

	return {
		layer,
		visible,
		render: vi.fn(),
		show() {

			this.visible = true;

		},
		hide() {

			this.visible = false;

		},
		dispose: vi.fn(),
	};

}

afterEach( () => {

	window.devicePixelRatio = 1;
	vi.clearAllMocks();
	vi.restoreAllMocks();

} );

describe( 'OverlayManager scene layer', () => {

	async function withSurface() {

		const manager = new OverlayManager( camera );
		await manager.initViewRenderer( { device: {}, sizeSource } );
		const overlay = manager._viewOverlay;
		return { manager, overlay, renderer: overlay.renderer };

	}

	it( 'stays off without a device or a size source, or when its surface cannot be made', async () => {

		const manager = new OverlayManager( camera );
		await manager.initViewRenderer( { device: null, sizeSource } );
		await manager.initViewRenderer( { device: {}, sizeSource: null } );
		expect( createRendererOnDevice ).not.toHaveBeenCalled();

		const error = vi.spyOn( console, 'error' ).mockImplementation( () => {} );
		createRendererOnDevice.mockRejectedValueOnce( new Error( 'no surface' ) );
		await manager.initViewRenderer( { device: {}, sizeSource } );
		expect( manager._viewOverlay ).toBeNull();
		expect( error ).toHaveBeenCalled();

		const gizmo = helper( 'scene', true );
		manager.register( 'gizmo', gizmo );
		manager.render();
		expect( gizmo.render ).not.toHaveBeenCalled();
		expect( manager.gpuResources() ).toEqual( [] );

	} );

	it( 'draws the helper scene, then each shown scene helper, on a cleared surface it shows', async () => {

		const { manager, overlay, renderer } = await withSurface();
		const helperScene = { isDrawing: false, render: vi.fn() };
		manager.setHelperScene( helperScene );
		const shown = helper( 'scene', true );
		const hidden = helper( 'scene', false );
		const hud = helper( 'hud', true );
		manager.register( 'shown', shown );
		manager.register( 'hidden', hidden );
		manager.register( 'hud', hud );

		manager.render();

		expect( renderer.clear ).toHaveBeenCalledOnce();
		expect( helperScene.render ).toHaveBeenCalledWith( renderer, camera );
		expect( shown.render ).toHaveBeenCalledWith( renderer, camera );
		expect( hidden.render ).not.toHaveBeenCalled();
		expect( hud.render.mock.calls.every( ( [ target ] ) => target === mockCtx ) ).toBe( true );
		const order = [ renderer.clear, helperScene.render, shown.render ].map( fn => fn.mock.invocationCallOrder[ 0 ] );
		expect( order ).toEqual( [ ...order ].sort( ( a, b ) => a - b ) );
		expect( overlay.isVisible ).toBe( true );

	} );

	it( 'wipes and parks the surface once nothing draws on it, then leaves it alone', async () => {

		const { manager, overlay, renderer } = await withSurface();
		const helperScene = { isDrawing: false, render: vi.fn() };
		manager.setHelperScene( helperScene );
		manager.render();
		expect( renderer.clear ).not.toHaveBeenCalled();

		const gizmo = helper( 'scene', true );
		manager.register( 'gizmo', gizmo );
		manager.render();
		gizmo.hide();
		manager.render();

		expect( renderer.clear ).toHaveBeenCalledTimes( 2 );
		expect( gizmo.render ).toHaveBeenCalledOnce();
		expect( helperScene.render ).toHaveBeenCalledOnce();
		expect( overlay.isVisible ).toBe( false );
		expect( overlay.canvas.style.display ).toBe( 'none' );

		manager.render();
		expect( renderer.clear ).toHaveBeenCalledTimes( 2 );

	} );

	it( 'draws for the light gizmos alone', async () => {

		const { manager, overlay, renderer } = await withSurface();
		const helperScene = { isDrawing: true, render: vi.fn() };
		manager.setHelperScene( helperScene );

		manager.render();

		expect( helperScene.render ).toHaveBeenCalledWith( renderer, camera );
		expect( overlay.isVisible ).toBe( true );

	} );

	it( 'follows the size source on each frame it draws, and counts the surface as GPU memory only while shown', async () => {

		const { manager, renderer } = await withSurface();
		expect( manager.gpuResources() ).toEqual( [] );

		manager.register( 'gizmo', helper( 'scene', true ) );
		manager.render();
		expect( manager.gpuResources() ).toEqual( [ { bytes: 400 * 300 * 4 }, { bytes: 7 } ] );

		sizeSource.getBoundingClientRect = () => ( { width: 500, height: 300 } );
		manager.render();
		expect( renderer.setSize ).toHaveBeenLastCalledWith( 500, 300, false );
		expect( manager.gpuResources()[ 0 ] ).toEqual( { bytes: 500 * 300 * 4 } );
		sizeSource.getBoundingClientRect = () => ( { width: 400, height: 300 } );

	} );

	it( 'draws the transform gizmo only while it is attached to something and shown, and never disposes its manager', async () => {

		const { manager, overlay, renderer } = await withSurface();
		const transformManager = { attachedObject: null, render: vi.fn(), dispose: vi.fn() };
		const gizmo = new TransformGizmoHelper( transformManager );
		manager.register( 'transform', gizmo );

		manager.render();
		expect( transformManager.render ).not.toHaveBeenCalled();
		expect( overlay.isVisible ).toBe( false );

		transformManager.attachedObject = {};
		manager.render();
		expect( transformManager.render ).toHaveBeenCalledWith( renderer );
		expect( overlay.isVisible ).toBe( true );

		manager.hide( 'transform' );
		manager.render();
		expect( transformManager.render ).toHaveBeenCalledOnce();
		expect( overlay.isVisible ).toBe( false );

		manager.toggle( 'transform' );
		manager.render();
		expect( transformManager.render ).toHaveBeenCalledTimes( 2 );

		manager.dispose();
		expect( gizmo.visible ).toBe( false );
		expect( transformManager.dispose ).not.toHaveBeenCalled();

	} );

	it( 'mounts the scene layer under the HUD, once per container', async () => {

		const { manager, overlay } = await withSurface();
		const container = () => {

			const element = { appendChild: vi.fn( child => {

				child.parentElement = element;

			} ) };
			return element;

		};

		const first = container();
		manager.mount( null );
		manager.mount( first );
		manager.mount( first );
		expect( first.appendChild.mock.calls.map( ( [ child ] ) => child ) ).toEqual( [ overlay.canvas, manager.getHUDCanvas() ] );

		const second = container();
		manager.mount( second );
		expect( second.appendChild ).toHaveBeenCalledTimes( 2 );

		const bare = new OverlayManager( camera );
		const third = container();
		bare.mount( third );
		expect( third.appendChild.mock.calls.map( ( [ child ] ) => child ) ).toEqual( [ bare.getHUDCanvas() ] );

	} );

	it( 'takes both canvases off the page and disposes the surface on dispose', async () => {

		const { manager, overlay, renderer } = await withSurface();
		const parent = { appendChild: vi.fn( child => {

			child.parentElement = parent;

		} ), removeChild: vi.fn() };
		manager.mount( parent );

		manager.dispose();

		expect( disposeRenderer ).toHaveBeenCalledWith( renderer );
		expect( parent.removeChild ).toHaveBeenCalledWith( overlay.canvas );
		expect( parent.removeChild ).toHaveBeenCalledWith( manager.getHUDCanvas() );
		expect( manager._viewOverlay ).toBeNull();
		expect( () => manager.render() ).not.toThrow();

	} );

} );

describe( 'OverlayManager HUD', () => {

	it( 'parks the HUD while no HUD helper is shown, without touching the context', () => {

		const manager = new OverlayManager( camera );
		manager.register( 'gizmo', helper( 'scene', true ) );
		manager.register( 'tiles', helper( 'hud', false ) );

		manager.refreshHUD();

		expect( manager.getHUDCanvas().style.display ).toBe( 'none' );
		expect( mockCtx.clearRect ).not.toHaveBeenCalled();

	} );

	it( 'draws each shown HUD helper in CSS pixels over a backing store at view resolution', () => {

		window.devicePixelRatio = 2;
		const manager = new OverlayManager( camera );
		const shown = helper( 'hud', true );
		const hidden = helper( 'hud', false );
		manager.register( 'shown', shown );
		manager.register( 'hidden', hidden );

		manager.refreshHUD();

		const canvas = manager.getHUDCanvas();
		expect( [ canvas.width, canvas.height ] ).toEqual( [ 1600, 1200 ] );
		expect( mockCtx.clearRect ).toHaveBeenCalledWith( 0, 0, 1600, 1200 );
		expect( mockCtx.scale ).toHaveBeenCalledWith( 2, 2 );
		expect( shown.render ).toHaveBeenCalledWith( mockCtx, 800, 600 );
		expect( hidden.render ).not.toHaveBeenCalled();
		expect( mockCtx.save.mock.invocationCallOrder[ 0 ] ).toBeLessThan( shown.render.mock.invocationCallOrder[ 0 ] );
		expect( mockCtx.restore.mock.invocationCallOrder[ 0 ] ).toBeGreaterThan( shown.render.mock.invocationCallOrder[ 0 ] );
		expect( canvas.style.display ).toBe( '' );

	} );

	it( 'comes back from parked, though a parked canvas measures nothing', () => {

		const manager = new OverlayManager( camera );
		const canvas = manager.getHUDCanvas();
		Object.defineProperty( canvas, 'clientWidth', { get() {

			return this.style.display === 'none' ? 0 : 800;

		} } );
		const tiles = helper( 'hud', false );
		manager.register( 'tiles', tiles );
		manager.refreshHUD();
		expect( canvas.style.display ).toBe( 'none' );

		tiles.show();
		manager.refreshHUD();

		expect( canvas.style.display ).toBe( '' );
		expect( tiles.render ).toHaveBeenCalledWith( mockCtx, 800, 600 );

	} );

	it( 'draws nothing into a canvas with no layout box', () => {

		const manager = new OverlayManager( camera );
		manager.getHUDCanvas().clientHeight = 0;
		const tiles = helper( 'hud', true );
		manager.register( 'tiles', tiles );

		manager.refreshHUD();

		expect( tiles.render ).not.toHaveBeenCalled();
		expect( mockCtx.clearRect ).not.toHaveBeenCalled();

	} );

	it( 'shows and hides every helper at once, and ignores names it does not hold', () => {

		const manager = new OverlayManager( camera );
		const a = helper( 'hud', false );
		const b = helper( 'scene', true );
		manager.register( 'a', a );
		manager.register( 'b', b );

		manager.showAll();
		expect( [ a.visible, b.visible ] ).toEqual( [ true, true ] );
		manager.hideAll();
		expect( [ a.visible, b.visible ] ).toEqual( [ false, false ] );

		expect( () => {

			manager.toggle( 'nope' );
			manager.show( 'nope' );
			manager.hide( 'nope' );
			manager.unregister( 'nope' );

		} ).not.toThrow();

	} );

} );

describe( 'OverlayManager default helpers', () => {

	function setup( { upscaler = new EventDispatcher(), renderWidth = 400, renderHeight = 300 } = {} ) {

		const manager = new OverlayManager( camera );
		const app = new EventDispatcher();
		const bus = {};
		const denoiser = new EventDispatcher();
		const meshScene = {};
		manager.setupDefaultHelpers( {
			helperScene: { isDrawing: false, render: vi.fn() },
			meshScene,
			pipeline: { eventBus: { on: ( type, fn ) => ( bus[ type ] = fn ) } },
			denoisingManager: { denoiser, upscaler },
			app,
			renderWidth,
			renderHeight,
		} );
		return { manager, app, bus, denoiser, upscaler, meshScene, tiles: manager.getHelper( 'tiles' ) };

	}

	const tile = { x: 100, y: 150, width: 100, height: 150 };

	it( 'adds the tile border and an outline over the mesh scene', () => {

		const { manager, tiles, meshScene } = setup();

		expect( tiles ).toBeInstanceOf( TileHelper );
		expect( manager.getHelper( 'outline' ) ).toMatchObject( { scene: meshScene, camera } );

	} );

	it( 'maps the tile border from the render size, which follows resolution changes', () => {

		const { manager, app, tiles } = setup();
		tiles.setActiveTile( tile );
		tiles.show();

		manager.refreshHUD();
		expect( mockCtx.strokeRect ).toHaveBeenLastCalledWith( 200, 300, 200, 300 );

		app.dispatchEvent( { type: EngineEvents.RESOLUTION_CHANGED, width: 800, height: 600 } );
		manager.refreshHUD();
		expect( mockCtx.strokeRect ).toHaveBeenLastCalledWith( 100, 150, 100, 150 );

	} );

	it( 'starts at a one-pixel render size when none is known', () => {

		const { manager, tiles } = setup( { renderWidth: 0, renderHeight: 0 } );
		tiles.setActiveTile( { x: 0, y: 0, width: 1, height: 1 } );
		tiles.show();

		manager.refreshHUD();

		expect( mockCtx.strokeRect ).toHaveBeenLastCalledWith( 0, 0, 800, 600 );

	} );

	it( 'shows the tile a denoise is working on, at that image\'s size, and hides it when the denoise ends', () => {

		const { manager, denoiser, tiles } = setup();

		denoiser.dispatchEvent( { type: 'tileProgress', tile, imageWidth: 800, imageHeight: 300 } );
		expect( tiles.visible ).toBe( true );
		expect( mockCtx.strokeRect ).toHaveBeenLastCalledWith( 100, 300, 100, 300 );
		expect( manager.getHUDCanvas().style.display ).toBe( '' );

		denoiser.dispatchEvent( { type: 'end' } );
		expect( tiles.visible ).toBe( false );
		expect( manager.getHUDCanvas().style.display ).toBe( 'none' );

	} );

	it( 'ignores a live denoise\'s single tile, and progress without a tile', () => {

		const { denoiser, tiles } = setup();

		denoiser.dispatchEvent( { type: 'tileProgress', continuous: true, tile, imageWidth: 800, imageHeight: 600 } );
		denoiser.dispatchEvent( { type: 'tileProgress', imageWidth: 800, imageHeight: 600 } );

		expect( tiles.visible ).toBe( false );
		expect( mockCtx.strokeRect ).not.toHaveBeenCalled();

	} );

	it( 'shows the upscaler\'s tiles too, and does without an upscaler', () => {

		const { upscaler, tiles } = setup();
		upscaler.dispatchEvent( { type: 'tileProgress', tile, imageWidth: 800, imageHeight: 600 } );
		expect( tiles.visible ).toBe( true );
		upscaler.dispatchEvent( { type: 'end' } );
		expect( tiles.visible ).toBe( false );

		expect( () => setup( { upscaler: null } ) ).not.toThrow();

	} );

	it( 'hides the tile border when the pipeline resets', () => {

		const { bus, denoiser, tiles } = setup();
		denoiser.dispatchEvent( { type: 'tileProgress', tile, imageWidth: 800, imageHeight: 600 } );

		bus[ 'pipeline:reset' ]();

		expect( tiles.visible ).toBe( false );

	} );

} );
