import { describe, it, expect, vi } from 'vitest';
import { createHeadlessCanvas } from '@/core/HeadlessCanvas.js';

function fakeDevice() {

	return {
		createTexture: vi.fn( ( { size: [ width, height ], format, usage } ) => ( { width, height, format, usage, destroy: vi.fn() } ) ),
	};

}

describe( 'createHeadlessCanvas', () => {

	it( 'presents into a texture of the canvas size, in the configured format', () => {

		const canvas = createHeadlessCanvas( 64, 32 );
		const context = canvas.getContext( 'webgpu' );
		const device = fakeDevice();
		context.configure( { device, format: 'bgra8unorm', usage: 17 } );

		const texture = context.getCurrentTexture();
		expect( texture ).toMatchObject( { width: 64, height: 32, format: 'bgra8unorm', usage: 17 } );
		expect( context.getCurrentTexture() ).toBe( texture );
		expect( context.getConfiguration().format ).toBe( 'bgra8unorm' );

	} );

	it( 'follows a resize, releasing the old texture', () => {

		const canvas = createHeadlessCanvas( 8, 8 );
		const context = canvas.getContext( 'webgpu' );
		context.configure( { device: fakeDevice(), format: 'rgba8unorm', usage: 1 } );
		const first = context.getCurrentTexture();

		canvas.width = 16;
		const second = context.getCurrentTexture();

		expect( second.width ).toBe( 16 );
		expect( first.destroy ).toHaveBeenCalledOnce();

	} );

	it( 'refuses to present before it is configured', () => {

		expect( () => createHeadlessCanvas().getContext( 'webgpu' ).getCurrentTexture() ).toThrow( /before configure/ );

	} );

	it( 'takes the listeners camera controls attach, and hands out no 2D context', () => {

		const canvas = createHeadlessCanvas();
		expect( () => {

			canvas.addEventListener( 'pointerdown', () => {} );
			canvas.getRootNode().addEventListener( 'keydown', () => {} );
			canvas.ownerDocument.addEventListener( 'keyup', () => {} );

		} ).not.toThrow();
		expect( canvas.getContext( '2d' ) ).toBeNull();
		expect( canvas.parentNode ).toBeNull();

	} );

} );
