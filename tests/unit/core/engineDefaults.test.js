import { describe, it, expect } from 'vitest';
import {
	ENGINE_DEFAULTS,
	ASVGF_QUALITY_PRESETS,
	NRD_DEFAULTS,
	NRD_QUALITY_PRESETS,
	NRD_PRESET_KEYS,
	NRD_HIT_DIST_A,
	NRD_HIT_DIST_B,
	CAMERA_PRESETS,
	SKY_PRESETS,
	CAMERA_RANGES,
	AUTO_FOCUS_MODES,
	AF_DEFAULTS,
	TEXTURE_CONSTANTS,
	MEMORY_CONSTANTS,
	PRODUCTION_RENDER_CONFIG,
	INTERACTIVE_RENDER_CONFIG,
} from '@/core/EngineDefaults.js';

describe( 'ENGINE_DEFAULTS', () => {

	it( 'has core rendering parameters', () => {

		expect( ENGINE_DEFAULTS ).toHaveProperty( 'resolution' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'bounces' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'exposure' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'maxSamples' );

	} );

	it( 'has environment parameters', () => {

		expect( ENGINE_DEFAULTS ).toHaveProperty( 'environmentMode' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'environmentIntensity' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'environmentRotation' );

	} );

	it( 'has DOF parameters', () => {

		expect( ENGINE_DEFAULTS ).toHaveProperty( 'enableDOF' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'focusDistance' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'aperture' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'focalLength' );

	} );

	it( 'has denoising parameters', () => {

		expect( ENGINE_DEFAULTS ).toHaveProperty( 'enableOIDN' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'enableASVGF' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'denoiserStrategy' );
		expect( ENGINE_DEFAULTS.nrdQualityPreset ).toBe( 'medium' );

	} );

	it( 'NRD presets only override declared preset keys', () => {

		for ( const name of [ 'low', 'medium', 'high' ] ) {

			expect( NRD_QUALITY_PRESETS ).toHaveProperty( name );
			// A key outside this list would be applied once and never reset on the next switch.
			for ( const key of Object.keys( NRD_QUALITY_PRESETS[ name ] ) ) expect( NRD_PRESET_KEYS ).toContain( key );

		}

		// 'medium' is the defaults, so it states no deltas at all.
		expect( NRD_QUALITY_PRESETS.medium ).toEqual( {} );
		for ( const key of NRD_PRESET_KEYS ) expect( NRD_DEFAULTS ).toHaveProperty( key );

		// nrd::ReblurSettings ranges.
		expect( NRD_DEFAULTS.maxAccumulatedFrameNum ).toBeLessThanOrEqual( 63 );
		expect( NRD_DEFAULTS.maxFastAccumulatedFrameNum ).toBeLessThan( NRD_DEFAULTS.maxAccumulatedFrameNum );
		expect( NRD_DEFAULTS.historyFixFrameNum ).toBeLessThan( NRD_DEFAULTS.maxFastAccumulatedFrameNum );

		// The Shade front-end and the NRD decode must agree on the hit-distance curve, so it is a
		// shared constant rather than a per-side setting.
		expect( NRD_HIT_DIST_A ).toBeGreaterThan( 0 );
		expect( NRD_HIT_DIST_B ).toBeGreaterThan( 0 );

	} );

	it( 'has numeric values for numeric parameters', () => {

		expect( typeof ENGINE_DEFAULTS.resolution ).toBe( 'number' );
		expect( typeof ENGINE_DEFAULTS.bounces ).toBe( 'number' );
		expect( typeof ENGINE_DEFAULTS.exposure ).toBe( 'number' );
		expect( typeof ENGINE_DEFAULTS.focusDistance ).toBe( 'number' );

	} );

} );

describe( 'ASVGF_QUALITY_PRESETS', () => {

	const requiredFields = [
		'temporalAlpha', 'atrousIterations', 'phiColor',
		'phiNormal', 'phiDepth', 'maxAccumFrames', 'varianceBoost'
	];

	it( 'has low, medium, high presets', () => {

		expect( ASVGF_QUALITY_PRESETS ).toHaveProperty( 'low' );
		expect( ASVGF_QUALITY_PRESETS ).toHaveProperty( 'medium' );
		expect( ASVGF_QUALITY_PRESETS ).toHaveProperty( 'high' );

	} );

	for ( const level of [ 'low', 'medium', 'high' ] ) {

		it( `${level} preset has all required fields`, () => {

			for ( const field of requiredFields ) {

				expect( ASVGF_QUALITY_PRESETS[ level ] ).toHaveProperty( field );
				expect( typeof ASVGF_QUALITY_PRESETS[ level ][ field ] ).toBe( 'number' );

			}

		} );

	}

	it( 'high quality has more iterations than low', () => {

		expect( ASVGF_QUALITY_PRESETS.high.atrousIterations )
			.toBeGreaterThan( ASVGF_QUALITY_PRESETS.low.atrousIterations );

	} );

} );

describe( 'CAMERA_PRESETS', () => {

	const requiredFields = [ 'name', 'fov', 'focusDistance', 'aperture', 'focalLength' ];

	it( 'has standard presets', () => {

		expect( CAMERA_PRESETS ).toHaveProperty( 'portrait' );
		expect( CAMERA_PRESETS ).toHaveProperty( 'landscape' );
		expect( CAMERA_PRESETS ).toHaveProperty( 'macro' );

	} );

	for ( const [ key, preset ] of Object.entries( CAMERA_PRESETS ) ) {

		it( `${key} preset has required fields`, () => {

			for ( const field of requiredFields ) {

				expect( preset ).toHaveProperty( field );

			}

		} );

		it( `${key} preset has valid fov range`, () => {

			expect( preset.fov ).toBeGreaterThan( 0 );
			expect( preset.fov ).toBeLessThanOrEqual( 180 );

		} );

	}

} );

describe( 'SKY_PRESETS', () => {

	it( 'has standard presets', () => {

		expect( SKY_PRESETS ).toHaveProperty( 'clearMorning' );
		expect( SKY_PRESETS ).toHaveProperty( 'clearNoon' );
		expect( SKY_PRESETS ).toHaveProperty( 'sunset' );

	} );

	for ( const [ key, preset ] of Object.entries( SKY_PRESETS ) ) {

		it( `${key} has name and sun parameters`, () => {

			expect( preset ).toHaveProperty( 'name' );
			expect( preset ).toHaveProperty( 'sunAzimuth' );
			expect( preset ).toHaveProperty( 'sunElevation' );
			expect( preset ).toHaveProperty( 'sunIntensity' );

		} );

	}

} );

describe( 'CAMERA_RANGES', () => {

	it( 'fov has min < max', () => {

		expect( CAMERA_RANGES.fov.min ).toBeLessThan( CAMERA_RANGES.fov.max );

	} );

	it( 'focusDistance has min < max', () => {

		expect( CAMERA_RANGES.focusDistance.min ).toBeLessThan( CAMERA_RANGES.focusDistance.max );

	} );

	it( 'aperture has options array', () => {

		expect( Array.isArray( CAMERA_RANGES.aperture.options ) ).toBe( true );
		expect( CAMERA_RANGES.aperture.options.length ).toBeGreaterThan( 0 );

	} );

} );

describe( 'Other constants', () => {

	it( 'AUTO_FOCUS_MODES has MANUAL and AUTO', () => {

		expect( AUTO_FOCUS_MODES.MANUAL ).toBe( 'manual' );
		expect( AUTO_FOCUS_MODES.AUTO ).toBe( 'auto' );

	} );

	it( 'AF_DEFAULTS has SMOOTHING_FACTOR', () => {

		expect( AF_DEFAULTS ).toHaveProperty( 'SMOOTHING_FACTOR' );
		expect( typeof AF_DEFAULTS.SMOOTHING_FACTOR ).toBe( 'number' );

	} );

	it( 'TEXTURE_CONSTANTS has expected keys', () => {

		expect( TEXTURE_CONSTANTS ).toHaveProperty( 'PIXELS_PER_MATERIAL' );
		expect( TEXTURE_CONSTANTS ).toHaveProperty( 'MAX_TEXTURE_SIZE' );
		expect( TEXTURE_CONSTANTS.PIXELS_PER_MATERIAL ).toBe( 30 );

	} );

	it( 'MEMORY_CONSTANTS has reasonable limits', () => {

		expect( MEMORY_CONSTANTS.MAX_BUFFER_MEMORY ).toBeGreaterThan( 0 );
		expect( MEMORY_CONSTANTS.CLEANUP_THRESHOLD ).toBeLessThan( 1 );
		expect( MEMORY_CONSTANTS.CLEANUP_THRESHOLD ).toBeGreaterThan( 0 );

	} );

	it( 'PRODUCTION_RENDER_CONFIG has higher bounces than INTERACTIVE', () => {

		expect( PRODUCTION_RENDER_CONFIG.bounces ).toBeGreaterThan( INTERACTIVE_RENDER_CONFIG.bounces );

	} );

} );
