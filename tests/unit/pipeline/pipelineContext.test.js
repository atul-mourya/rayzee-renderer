import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PipelineContext } from '@/core/pipeline/PipelineContext.js';

describe( 'PipelineContext', () => {

	let ctx;

	beforeEach( () => {

		ctx = new PipelineContext();

	} );

	// ── Texture Registry ──────────────────────────────────────

	describe( 'textures', () => {

		it( 'set and get', () => {

			const tex = { id: 'color' };
			ctx.setTexture( 'pathtracer:color', tex );
			expect( ctx.getTexture( 'pathtracer:color' ) ).toBe( tex );

		} );

		it( 'has returns true when set', () => {

			ctx.setTexture( 'a', {} );
			expect( ctx.hasTexture( 'a' ) ).toBe( true );
			expect( ctx.hasTexture( 'b' ) ).toBe( false );

		} );

		it( 'remove deletes texture', () => {

			ctx.setTexture( 'a', {} );
			ctx.removeTexture( 'a' );
			expect( ctx.hasTexture( 'a' ) ).toBe( false );

		} );

		it( 'getTextureNames returns all keys', () => {

			ctx.setTexture( 'a', {} );
			ctx.setTexture( 'b', {} );
			expect( ctx.getTextureNames() ).toEqual( expect.arrayContaining( [ 'a', 'b' ] ) );

		} );

		it( 'clearTextures removes all', () => {

			ctx.setTexture( 'a', {} );
			ctx.setTexture( 'b', {} );
			ctx.clearTextures();
			expect( ctx.getTextureNames() ).toHaveLength( 0 );

		} );

	} );

	// ── RenderTarget Registry ─────────────────────────────────

	describe( 'renderTargets', () => {

		it( 'set and get', () => {

			const rt = { id: 'rt1' };
			ctx.setRenderTarget( 'main', rt );
			expect( ctx.getRenderTarget( 'main' ) ).toBe( rt );

		} );

		it( 'has/remove/names/clear work correctly', () => {

			ctx.setRenderTarget( 'a', {} );
			expect( ctx.hasRenderTarget( 'a' ) ).toBe( true );
			ctx.removeRenderTarget( 'a' );
			expect( ctx.hasRenderTarget( 'a' ) ).toBe( false );

			ctx.setRenderTarget( 'x', {} );
			ctx.setRenderTarget( 'y', {} );
			expect( ctx.getRenderTargetNames() ).toHaveLength( 2 );
			ctx.clearRenderTargets();
			expect( ctx.getRenderTargetNames() ).toHaveLength( 0 );

		} );

	} );

	// ── Uniform Registry ──────────────────────────────────────

	describe( 'uniforms', () => {

		it( 'set creates {value} wrapper', () => {

			ctx.setUniform( 'frame', 42 );
			expect( ctx.getUniform( 'frame' ) ).toEqual( { value: 42 } );

		} );

		it( 'set updates existing uniform in-place', () => {

			ctx.setUniform( 'frame', 0 );
			const ref = ctx.getUniform( 'frame' );
			ctx.setUniform( 'frame', 10 );
			// Same object reference, updated value
			expect( ref ).toBe( ctx.getUniform( 'frame' ) );
			expect( ref.value ).toBe( 10 );

		} );

		it( 'getUniformValue returns value directly', () => {

			ctx.setUniform( 'x', 99 );
			expect( ctx.getUniformValue( 'x' ) ).toBe( 99 );

		} );

		it( 'getUniformValue returns undefined for missing', () => {

			expect( ctx.getUniformValue( 'missing' ) ).toBeUndefined();

		} );

		it( 'has/remove/names/clear', () => {

			ctx.setUniform( 'a', 1 );
			expect( ctx.hasUniform( 'a' ) ).toBe( true );
			ctx.removeUniform( 'a' );
			expect( ctx.hasUniform( 'a' ) ).toBe( false );

			ctx.setUniform( 'x', 1 );
			ctx.setUniform( 'y', 2 );
			expect( ctx.getUniformNames() ).toHaveLength( 2 );
			ctx.clearUniforms();
			expect( ctx.getUniformNames() ).toHaveLength( 0 );

		} );

	} );

	// ── State Management ──────────────────────────────────────

	describe( 'state', () => {

		it( 'setState returns true when value changes', () => {

			expect( ctx.setState( 'frame', 1 ) ).toBe( true );

		} );

		it( 'setState returns false when value is same', () => {

			ctx.setState( 'frame', 5 );
			expect( ctx.setState( 'frame', 5 ) ).toBe( false );

		} );

		it( 'getState reads set values', () => {

			ctx.setState( 'custom', 'hello' );
			expect( ctx.getState( 'custom' ) ).toBe( 'hello' );

		} );

		it( 'getAllState returns full state object', () => {

			const state = ctx.getAllState();
			expect( state ).toHaveProperty( 'frame' );
			expect( state ).toHaveProperty( 'renderMode' );

		} );

		it( 'setStates batch-updates and returns changed keys', () => {

			const changed = ctx.setStates( { frame: 10, renderMode: 1, isComplete: true } );
			expect( changed ).toContain( 'frame' );
			expect( changed ).toContain( 'renderMode' );
			expect( changed ).toContain( 'isComplete' );

		} );

		it( 'setStates skips unchanged values', () => {

			ctx.setState( 'renderMode', 0 );
			const changed = ctx.setStates( { renderMode: 0, frame: 99 } );
			expect( changed ).not.toContain( 'renderMode' );
			expect( changed ).toContain( 'frame' );

		} );

		it( 'hasState checks existing keys', () => {

			expect( ctx.hasState( 'frame' ) ).toBe( true );
			expect( ctx.hasState( 'nonexistent_key_xyz' ) ).toBe( false );

		} );

	} );

	// ── State Watch ───────────────────────────────────────────

	describe( 'watchState', () => {

		it( 'callback fires when value changes', () => {

			const cb = vi.fn();
			ctx.watchState( 'frame', cb );
			ctx.setState( 'frame', 5 );
			expect( cb ).toHaveBeenCalledWith( 5, 0 ); // new, old

		} );

		it( 'callback does NOT fire when value is same', () => {

			const cb = vi.fn();
			ctx.setState( 'frame', 5 );
			ctx.watchState( 'frame', cb );
			ctx.setState( 'frame', 5 );
			expect( cb ).not.toHaveBeenCalled();

		} );

		it( 'unwatchState stops notifications', () => {

			const cb = vi.fn();
			ctx.watchState( 'frame', cb );
			ctx.unwatchState( 'frame', cb );
			ctx.setState( 'frame', 99 );
			expect( cb ).not.toHaveBeenCalled();

		} );

		it( 'multiple watchers on same key', () => {

			const a = vi.fn();
			const b = vi.fn();
			ctx.watchState( 'frame', a );
			ctx.watchState( 'frame', b );
			ctx.setState( 'frame', 10 );
			expect( a ).toHaveBeenCalledTimes( 1 );
			expect( b ).toHaveBeenCalledTimes( 1 );

		} );

		it( 'callback error does not break other watchers', () => {

			const errorCb = vi.fn( () => {

				throw new Error( 'boom' );

			} );
			const normalCb = vi.fn();

			vi.spyOn( console, 'error' ).mockImplementation( () => {} );

			ctx.watchState( 'frame', errorCb );
			ctx.watchState( 'frame', normalCb );

			ctx.setState( 'frame', 7 );

			expect( errorCb ).toHaveBeenCalled();
			expect( normalCb ).toHaveBeenCalled();

		} );

	} );

	// ── Lifecycle ─────────────────────────────────────────────

	describe( 'lifecycle', () => {

		it( 'incrementFrame increments and returns new value', () => {

			const newFrame = ctx.incrementFrame();
			expect( newFrame ).toBe( 1 );
			expect( ctx.getState( 'frame' ) ).toBe( 1 );
			expect( ctx.getState( 'accumulatedFrames' ) ).toBe( 1 );

		} );

		it( 'reset resets frame counters', () => {

			ctx.incrementFrame();
			ctx.incrementFrame();
			ctx.reset();
			expect( ctx.getState( 'frame' ) ).toBe( 0 );
			expect( ctx.getState( 'accumulatedFrames' ) ).toBe( 0 );
			expect( ctx.getState( 'isComplete' ) ).toBe( false );

		} );

		it( 'dispose clears everything', () => {

			ctx.setTexture( 'a', {} );
			ctx.setRenderTarget( 'b', {} );
			ctx.setUniform( 'c', 1 );
			ctx.dispose();
			expect( ctx.getTextureNames() ).toHaveLength( 0 );
			expect( ctx.getRenderTargetNames() ).toHaveLength( 0 );
			expect( ctx.getUniformNames() ).toHaveLength( 0 );

		} );

	} );

} );
