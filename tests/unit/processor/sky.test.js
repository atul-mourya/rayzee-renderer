import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock( 'three', () => ( {
	RGBAFormat: 1023, FloatType: 1015, LinearFilter: 1006,
	RepeatWrapping: 1000, ClampToEdgeWrapping: 1001,
	EquirectangularReflectionMapping: 303, LinearSRGBColorSpace: 'srgb-linear',
	DataTexture: class {

		constructor( data, w, h ) {

			this.image = { data, width: w, height: h };
			this.needsUpdate = false;

		}

		dispose() {}

	},
} ) );

import { SimpleSky } from '@/core/Processor/SimpleSky.js';

// ── SimpleSky ─────────────────────────────────────────────────

describe( 'SimpleSky', () => {

	let sky;

	beforeEach( () => {

		sky = new SimpleSky( 64, 32 );

	} );

	// ── renderSolid ────────────────────────────────────────────

	describe( 'renderSolid', () => {

		it( 'fills all pixels with the same color', () => {

			sky.renderSolid( { color: { r: 0.5, g: 0.25, b: 0.75 } } );

			const pixels = sky._pixels;
			const w = sky.width;
			const h = sky.height;

			for ( let i = 0; i < w * h; i ++ ) {

				expect( pixels[ i * 4 ] ).toBeCloseTo( 0.5 );
				expect( pixels[ i * 4 + 1 ] ).toBeCloseTo( 0.25 );
				expect( pixels[ i * 4 + 2 ] ).toBeCloseTo( 0.75 );
				expect( pixels[ i * 4 + 3 ] ).toBeCloseTo( 1.0 );

			}

		} );

		it( 'returns a texture with needsUpdate=true', () => {

			const tex = sky.renderSolid( { color: { r: 1, g: 0, b: 0 } } );
			expect( tex.needsUpdate ).toBe( true );

		} );

	} );

	// ── setResolution ──────────────────────────────────────────

	describe( 'setResolution', () => {

		it( 'changes pixel buffer size', () => {

			sky.setResolution( 128, 64 );

			expect( sky.width ).toBe( 128 );
			expect( sky.height ).toBe( 64 );
			expect( sky._pixels.length ).toBe( 128 * 64 * 4 );

		} );

		it( 'is a no-op for the same size', () => {

			const originalPixels = sky._pixels;
			sky.setResolution( 64, 32 );

			expect( sky._pixels ).toBe( originalPixels );

		} );

	} );

	// ── getLastRenderTime ──────────────────────────────────────

	describe( 'getLastRenderTime', () => {

		it( 'returns > 0 after render', () => {

			sky.renderSolid( { color: { r: 1, g: 0, b: 0 } } );
			expect( sky.getLastRenderTime() ).toBeGreaterThanOrEqual( 0 );

		} );

	} );

	// ── dispose ────────────────────────────────────────────────

	describe( 'dispose', () => {

		it( 'is callable without error', () => {

			expect( () => sky.dispose() ).not.toThrow();

		} );

	} );

} );
