import { describe, it, expect } from 'vitest';
import { ENGINE_DEFAULTS, SKY_DEFAULTS, DENOISER_DEFAULTS, AUTO_EXPOSURE_DEFAULTS, LOCAL_EXPOSURE_DEFAULTS, AUTO_FOCUS_DEFAULTS } from 'rayzee';

globalThis.window = globalThis.window || {};
const { CAMERA_PRESETS, SKY_PRESETS, CAMERA_RANGES, DEFAULT_STATE } = await import( '@/Constants' );

describe( 'DEFAULT_STATE', () => {

	it( 'carries the engine\'s defaults and those of each viewer piece the app drives', () => {

		for ( const defaults of [ ENGINE_DEFAULTS, SKY_DEFAULTS, DENOISER_DEFAULTS, AUTO_EXPOSURE_DEFAULTS, LOCAL_EXPOSURE_DEFAULTS, AUTO_FOCUS_DEFAULTS ] ) {

			for ( const key of Object.keys( defaults ) ) expect( DEFAULT_STATE ).toHaveProperty( key );

		}

	} );

	it( 'turns the final denoise on, where the engine leaves it off', () => {

		expect( DENOISER_DEFAULTS.enableOIDN ).toBe( false );
		expect( DEFAULT_STATE.enableOIDN ).toBe( true );

	} );

} );

describe( 'CAMERA_PRESETS', () => {

	const requiredFields = [ 'name', 'dofBlur', 'aperture', 'focalLength', 'apertureScale' ];

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

		it( `${key} preset leaves the field of view to the camera`, () => {

			expect( preset ).not.toHaveProperty( 'fov' );

		} );

	}

} );

describe( 'SKY_PRESETS', () => {

	it( 'has standard presets', () => {

		expect( SKY_PRESETS ).toHaveProperty( 'clearDay' );
		expect( SKY_PRESETS ).toHaveProperty( 'clearMorning' );
		expect( SKY_PRESETS ).toHaveProperty( 'clearNoon' );
		expect( SKY_PRESETS ).toHaveProperty( 'sunset' );

	} );

	for ( const [ key, preset ] of Object.entries( SKY_PRESETS ) ) {

		it( `${key} has name and sun parameters`, () => {

			expect( preset ).toHaveProperty( 'name' );
			expect( preset ).toHaveProperty( 'sunAzimuth' );
			expect( preset ).toHaveProperty( 'sunElevation' );
			expect( preset.turbidity ).toBeGreaterThanOrEqual( 1 );

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

describe( 'SKY_PRESETS clearDay', () => {

	it( 'is the engine\'s default sun', () => {

		expect( SKY_PRESETS.clearDay.sunAzimuth ).toBe( SKY_DEFAULTS.skySunAzimuth );
		expect( SKY_PRESETS.clearDay.sunElevation ).toBe( SKY_DEFAULTS.skySunElevation );

	} );

} );
