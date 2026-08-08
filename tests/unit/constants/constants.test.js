import { describe, it, expect, beforeAll } from 'vitest';
import { TRIANGLE_DATA_LAYOUT } from '@/core/EngineDefaults.js';

// Constants.js uses window.devicePixelRatio at module scope, so we must
// provide a global `window` object before dynamic import.
let computeCanvasDimensions;
let computeOutputDimensions;
let ASPECT_RATIO_PRESETS;

beforeAll( async () => {

	globalThis.window = { devicePixelRatio: 2 };
	const mod = await import( '@/Constants.js' );
	computeCanvasDimensions = mod.computeCanvasDimensions;
	computeOutputDimensions = mod.computeOutputDimensions;
	ASPECT_RATIO_PRESETS = mod.ASPECT_RATIO_PRESETS;

} );

describe( 'computeCanvasDimensions', () => {

	it( '1:1 landscape returns square', () => {

		const { width, height } = computeCanvasDimensions( 1024, '1:1', 'landscape' );
		expect( width ).toBe( 1024 );
		expect( height ).toBe( 1024 );

	} );

	it( '16:9 landscape returns correct aspect', () => {

		const { width, height } = computeCanvasDimensions( 1920, '16:9', 'landscape' );
		expect( width ).toBe( 1920 );
		expect( height ).toBe( Math.round( 1920 * 9 / 16 ) );

	} );

	it( '16:9 portrait swaps dimensions', () => {

		const { width, height } = computeCanvasDimensions( 1920, '16:9', 'portrait' );
		const expectedShort = Math.round( 1920 * 9 / 16 );
		expect( width ).toBe( expectedShort );
		expect( height ).toBe( 1920 );

	} );

	it( '4:3 landscape returns correct dimensions', () => {

		const { width, height } = computeCanvasDimensions( 2048, '4:3', 'landscape' );
		expect( width ).toBe( 2048 );
		expect( height ).toBe( Math.round( 2048 * 3 / 4 ) );

	} );

	it( 'unknown preset returns square', () => {

		const { width, height } = computeCanvasDimensions( 512, 'unknown', 'landscape' );
		expect( width ).toBe( 512 );
		expect( height ).toBe( 512 );

	} );

	it( '1:1 portrait stays square (no flip)', () => {

		const { width, height } = computeCanvasDimensions( 512, '1:1', 'portrait' );
		expect( width ).toBe( 512 );
		expect( height ).toBe( 512 );

	} );

} );

describe( 'computeOutputDimensions', () => {

	it( 'equirectangular locks 2:1 with resolution as the width', () => {

		const state = { cameraProjection: 'equirectangular', aspectRatioPreset: '16:9', orientation: 'portrait' };
		expect( computeOutputDimensions( state, 4096 ) ).toEqual( { width: 4096, height: 2048 } );

	} );

	it( 'equirectangular ignores aspect preset and orientation', () => {

		const a = computeOutputDimensions( { cameraProjection: 'equirectangular', aspectRatioPreset: '1:1' }, 1024 );
		const b = computeOutputDimensions( { cameraProjection: 'equirectangular', aspectRatioPreset: '21:9', orientation: 'portrait' }, 1024 );
		expect( a ).toEqual( b );

	} );

	it( 'equirectangular rounds an odd resolution', () => {

		expect( computeOutputDimensions( { cameraProjection: 'equirectangular' }, 513 ) ).toEqual( { width: 513, height: 257 } );

	} );

	it( 'perspective passes through to computeCanvasDimensions', () => {

		const state = { cameraProjection: 'perspective', aspectRatioPreset: '16:9', orientation: 'landscape' };
		expect( computeOutputDimensions( state, 1920 ) ).toEqual( computeCanvasDimensions( 1920, '16:9', 'landscape' ) );

	} );

} );

describe( 'ASPECT_RATIO_PRESETS', () => {

	it( 'has standard presets', () => {

		expect( ASPECT_RATIO_PRESETS ).toHaveProperty( '1:1' );
		expect( ASPECT_RATIO_PRESETS ).toHaveProperty( '16:9' );
		expect( ASPECT_RATIO_PRESETS ).toHaveProperty( '4:3' );

	} );

	it( 'each preset has width, height, label', () => {

		for ( const [ key, preset ] of Object.entries( ASPECT_RATIO_PRESETS ) ) {

			expect( preset ).toHaveProperty( 'width' );
			expect( preset ).toHaveProperty( 'height' );
			expect( preset ).toHaveProperty( 'label' );
			expect( preset.width ).toBeGreaterThan( 0 );
			expect( preset.height ).toBeGreaterThan( 0 );

		}

	} );

} );

describe( 'TRIANGLE_DATA_LAYOUT', () => {

	it( 'has 32 floats per triangle', () => {

		expect( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE ).toBe( 32 );

	} );

	it( 'position offsets are vec4-aligned and non-overlapping', () => {

		const { POSITION_A_OFFSET, POSITION_B_OFFSET, POSITION_C_OFFSET } = TRIANGLE_DATA_LAYOUT;
		expect( POSITION_A_OFFSET ).toBe( 0 );
		expect( POSITION_B_OFFSET ).toBe( 4 );
		expect( POSITION_C_OFFSET ).toBe( 8 );

	} );

	it( 'normal offsets follow positions', () => {

		const { NORMAL_A_OFFSET, NORMAL_B_OFFSET, NORMAL_C_OFFSET } = TRIANGLE_DATA_LAYOUT;
		expect( NORMAL_A_OFFSET ).toBe( 12 );
		expect( NORMAL_B_OFFSET ).toBe( 16 );
		expect( NORMAL_C_OFFSET ).toBe( 20 );

	} );

	it( 'UV offsets are in the last 8 floats', () => {

		const { UV_AB_OFFSET, UV_C_MAT_OFFSET } = TRIANGLE_DATA_LAYOUT;
		expect( UV_AB_OFFSET ).toBe( 24 );
		expect( UV_C_MAT_OFFSET ).toBe( 28 );

	} );

	it( 'all offsets fit within FLOATS_PER_TRIANGLE', () => {

		const offsets = [
			TRIANGLE_DATA_LAYOUT.POSITION_A_OFFSET,
			TRIANGLE_DATA_LAYOUT.POSITION_B_OFFSET,
			TRIANGLE_DATA_LAYOUT.POSITION_C_OFFSET,
			TRIANGLE_DATA_LAYOUT.NORMAL_A_OFFSET,
			TRIANGLE_DATA_LAYOUT.NORMAL_B_OFFSET,
			TRIANGLE_DATA_LAYOUT.NORMAL_C_OFFSET,
			TRIANGLE_DATA_LAYOUT.UV_AB_OFFSET,
			TRIANGLE_DATA_LAYOUT.UV_C_MAT_OFFSET,
		];

		for ( const offset of offsets ) {

			expect( offset + 4 ).toBeLessThanOrEqual( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE );

		}

	} );

} );
