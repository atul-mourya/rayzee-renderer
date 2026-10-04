import { describe, it, expect } from 'vitest';
import { ENGINE_DEFAULTS, PRODUCTION_RENDER_CONFIG, INTERACTIVE_RENDER_CONFIG } from '@/core/EngineDefaults.js';
import { TEXTURE_CONSTANTS } from '@/core/Processor/TextureBuckets.js';
import { MEMORY_CONSTANTS } from '@/core/Processor/TextureCreator.js';
import {
	DENOISER_DEFAULTS, ASVGF_QUALITY_PRESETS, NRD_DEFAULTS, NRD_QUALITY_PRESETS, NRD_PRESET_KEYS, NRD_HIT_DIST_A,
	NRD_HIT_DIST_B,
} from '@/core/Stages/DenoiserSettings.js';
import { AUTO_FOCUS_DEFAULTS } from '@/core/managers/CameraManager.js';

describe( 'ENGINE_DEFAULTS', () => {

	it( 'has core rendering parameters', () => {

		expect( ENGINE_DEFAULTS ).toHaveProperty( 'resolution' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'bounces' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'exposure' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'maxSamples' );

	} );

	it( 'has environment parameters', () => {

		expect( ENGINE_DEFAULTS ).toHaveProperty( 'environmentIntensity' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'environmentRotation' );

	} );

	it( 'has DOF parameters', () => {

		expect( ENGINE_DEFAULTS ).toHaveProperty( 'enableDOF' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'focusDistance' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'aperture' );
		expect( ENGINE_DEFAULTS ).toHaveProperty( 'focalLength' );

	} );

	it( 'holds the core\'s settings only: the viewer pieces and the app keep their own', () => {

		for ( const key of [ 'enableOIDN', 'denoiserStrategy', 'asvgfQualityPreset', 'autoExposure', 'afSmoothingFactor', 'interactionRenderScale', 'canvasWidth', 'debugModel' ] ) {

			expect( ENGINE_DEFAULTS ).not.toHaveProperty( key );

		}

	} );

	it( 'has denoising parameters in DENOISER_DEFAULTS', () => {

		expect( DENOISER_DEFAULTS.enableOIDN ).toBe( false );
		expect( DENOISER_DEFAULTS.enableASVGF ).toBe( false );
		expect( DENOISER_DEFAULTS.denoiserStrategy ).toBe( 'none' );
		expect( DENOISER_DEFAULTS.nrdQualityPreset ).toBe( 'medium' );

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

describe( 'Other constants', () => {

	it( 'AUTO_FOCUS_DEFAULTS starts in auto mode at the centre', () => {

		expect( AUTO_FOCUS_DEFAULTS.autoFocusMode ).toBe( 'auto' );
		expect( AUTO_FOCUS_DEFAULTS.afScreenPoint ).toEqual( { x: 0.5, y: 0.5 } );
		expect( typeof AUTO_FOCUS_DEFAULTS.afSmoothingFactor ).toBe( 'number' );

	} );

	it( 'TEXTURE_CONSTANTS has expected keys', () => {

		expect( TEXTURE_CONSTANTS ).toHaveProperty( 'MAX_TEXTURE_SIZE' );
		expect( TEXTURE_CONSTANTS ).toHaveProperty( 'BUCKET_LAYER_STRIDE' );

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
