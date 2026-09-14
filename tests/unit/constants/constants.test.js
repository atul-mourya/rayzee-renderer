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

	it( 'is 5 uvec4 lanes per triangle', () => {

		expect( TRIANGLE_DATA_LAYOUT.FLOATS_PER_TRIANGLE ).toBe( 20 );

	} );

	it( 'positions are vec4-aligned with a packed normal in each spare lane', () => {

		const L = TRIANGLE_DATA_LAYOUT;
		expect( L.POSITION_A_OFFSET ).toBe( 0 );
		expect( L.POSITION_B_OFFSET ).toBe( 4 );
		expect( L.POSITION_C_OFFSET ).toBe( 8 );
		expect( L.NORMAL_A_PACKED_OFFSET ).toBe( L.POSITION_A_OFFSET + 3 );
		expect( L.NORMAL_B_PACKED_OFFSET ).toBe( L.POSITION_B_OFFSET + 3 );
		expect( L.NORMAL_C_PACKED_OFFSET ).toBe( L.POSITION_C_OFFSET + 3 );

	} );

	it( 'UVs, material flags and mesh index fill the last two lanes', () => {

		const L = TRIANGLE_DATA_LAYOUT;
		expect( L.UV_AB_OFFSET ).toBe( 12 );
		expect( L.UV_C_OFFSET ).toBe( 16 );
		expect( L.MATERIAL_FLAGS_OFFSET ).toBe( 18 );
		expect( L.MESH_INDEX_OFFSET ).toBe( 19 );

	} );

	it( 'leaves no lane unused or double-booked', () => {

		const L = TRIANGLE_DATA_LAYOUT;
		const lanes = new Set();
		for ( const base of [ L.POSITION_A_OFFSET, L.POSITION_B_OFFSET, L.POSITION_C_OFFSET ] ) {

			for ( let i = 0; i < 3; i ++ ) lanes.add( base + i );

		}

		for ( const lane of [
			L.NORMAL_A_PACKED_OFFSET, L.NORMAL_B_PACKED_OFFSET, L.NORMAL_C_PACKED_OFFSET,
			L.UV_AB_OFFSET, L.UV_AB_OFFSET + 1, L.UV_AB_OFFSET + 2, L.UV_AB_OFFSET + 3,
			L.UV_C_OFFSET, L.UV_C_OFFSET + 1, L.MATERIAL_FLAGS_OFFSET, L.MESH_INDEX_OFFSET
		] ) {

			expect( lanes.has( lane ) ).toBe( false );
			lanes.add( lane );

		}

		expect( lanes.size ).toBe( L.FLOATS_PER_TRIANGLE );

	} );

} );
