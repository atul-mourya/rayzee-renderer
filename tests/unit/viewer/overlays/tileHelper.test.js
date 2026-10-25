import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TileHelper } from '@/core/viewer/overlays/TileHelper.js';

describe( 'TileHelper', () => {

	let helper;

	beforeEach( () => {

		helper = new TileHelper();

	} );

	// ── Defaults ──

	it( 'defaults to hud layer', () => {

		expect( helper.layer ).toBe( 'hud' );

	} );

	it( 'defaults to not visible', () => {

		expect( helper.visible ).toBe( false );

	} );

	it( 'defaults to enabled', () => {

		expect( helper.enabled ).toBe( true );

	} );

	// ── Visibility ──

	describe( 'show / hide', () => {

		it( 'show sets visible when enabled', () => {

			helper.show();
			expect( helper.visible ).toBe( true );

		} );

		it( 'show does nothing when disabled', () => {

			helper.enabled = false;
			helper.show();
			expect( helper.visible ).toBe( false );

		} );

		it( 'hide clears visible and tile bounds', () => {

			helper.setActiveTile( { x: 0, y: 0, width: 100, height: 100 } );
			helper.show();
			helper.hide();
			expect( helper.visible ).toBe( false );
			expect( helper._tileBounds ).toBeNull();

		} );

	} );

	// ── Render ──

	describe( 'render', () => {

		it( 'does nothing without tile bounds', () => {

			const ctx = { strokeStyle: '', lineWidth: 0, strokeRect: vi.fn() };
			helper.render( ctx, 800, 600 );
			expect( ctx.strokeRect ).not.toHaveBeenCalled();

		} );

		it( 'draws a rect scaled to display dimensions', () => {

			helper.setRenderSize( 1920, 1080 );
			helper.setActiveTile( { x: 0, y: 0, width: 960, height: 540 } );

			const ctx = { strokeStyle: '', lineWidth: 0, strokeRect: vi.fn() };
			helper.render( ctx, 800, 600 );

			// 960/1920 * 800 = 400, 540/1080 * 600 = 300
			expect( ctx.strokeRect ).toHaveBeenCalledWith( 0, 0, 400, 300 );

		} );

		it( 'maps tile position correctly', () => {

			helper.setRenderSize( 1000, 1000 );
			helper.setActiveTile( { x: 500, y: 250, width: 250, height: 250 } );

			const ctx = { strokeStyle: '', lineWidth: 0, strokeRect: vi.fn() };
			helper.render( ctx, 500, 500 );

			// 500/1000 * 500 = 250, 250/1000 * 500 = 125
			expect( ctx.strokeRect ).toHaveBeenCalledWith( 250, 125, 125, 125 );

		} );

	} );

	// ── setActiveTile ──

	describe( 'setActiveTile', () => {

		it( 'stores bounds', () => {

			const bounds = { x: 10, y: 20, width: 100, height: 50 };
			helper.setActiveTile( bounds );
			expect( helper._tileBounds ).toBe( bounds );

		} );

		it( 'accepts null to clear', () => {

			helper.setActiveTile( { x: 0, y: 0, width: 1, height: 1 } );
			helper.setActiveTile( null );
			expect( helper._tileBounds ).toBeNull();

		} );

	} );

	// ── setRenderSize ──

	describe( 'setRenderSize', () => {

		it( 'updates image dimensions', () => {

			helper.setRenderSize( 3840, 2160 );
			expect( helper._imageWidth ).toBe( 3840 );
			expect( helper._imageHeight ).toBe( 2160 );

		} );

	} );

} );
