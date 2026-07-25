import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OverlayManager } from '@/core/managers/OverlayManager.js';

// Minimal mocks — OverlayManager only needs a camera ref and a DOM canvas
const createMockCamera = () => ( {} );

// Stub document.createElement for the HUD canvas
const mockCtx = {
	clearRect: vi.fn(),
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
