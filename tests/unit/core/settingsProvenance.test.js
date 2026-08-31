import { describe, it, expect } from 'vitest';
import { RenderSettings, SETTING_SOURCE } from '@/core/RenderSettings.js';
import { RENDER_PROFILES, getRenderProfile, ENGINE_DEFAULTS } from '@/core/EngineDefaults.js';
import { toneMapToRGBA8 } from '@/core/Processor/ToneMapCPU.js';
import { NoToneMapping, LinearToneMapping, ACESFilmicToneMapping } from 'three';

describe( 'settings provenance', () => {

	it( 'tags untouched values as defaults', () => {

		const settings = new RenderSettings( { maxBounces: 4 } );
		const effective = settings.getEffective();

		expect( effective.maxBounces ).toEqual( { value: 4, source: SETTING_SOURCE.DEFAULT, routed: true } );

	} );

	it( 'attributes a host write', () => {

		const settings = new RenderSettings( { maxBounces: 4 } );
		settings.set( 'maxBounces', 12 );

		expect( settings.getEffective().maxBounces ).toMatchObject( { value: 12, source: SETTING_SOURCE.HOST } );

	} );

	// The case that cost the farm two days: a value the model file changed under them.
	it( 'attributes a write from authored scene metadata', () => {

		const settings = new RenderSettings( { environmentRotation: 270 } );
		settings.setMany( { environmentRotation: 35 }, { source: SETTING_SOURCE.SCENE_METADATA } );

		const effective = settings.getEffective();
		expect( effective.environmentRotation.value ).toBe( 35 );
		expect( effective.environmentRotation.source ).toBe( 'scene-metadata' );

	} );

	it( 'attributes a mode preset', () => {

		const settings = new RenderSettings( { maxBounces: 4 } );
		settings.setMany( { maxBounces: 20 }, { source: SETTING_SOURCE.MODE_PRESET } );

		expect( settings.getEffective().maxBounces.source ).toBe( 'mode-preset' );

	} );

	// `routed` separates "in force" from "accepted and does nothing".
	it( 'marks a stored value that reaches no stage', () => {

		const settings = new RenderSettings( { maxBounces: 4 } );
		settings.set( 'maxBonces', 12 );

		expect( settings.getEffective().maxBonces ).toEqual( {
			value: 12, source: SETTING_SOURCE.HOST, routed: false,
		} );

	} );

} );

describe( 'render profiles', () => {

	it( 'keeps the viewer profile as the default', () => {

		expect( getRenderProfile() ).toBe( RENDER_PROFILES.viewer );
		expect( ENGINE_DEFAULTS.environmentRotation ).toBe( RENDER_PROFILES.viewer.environmentRotation );

	} );

	it( 'states the viewer tuning the engine ships', () => {

		expect( RENDER_PROFILES.viewer.areaLightIntensityScale ).toBe( 0.1 );
		expect( RENDER_PROFILES.viewer.environmentRotation ).toBe( 270 );

	} );

	it( 'leaves authored values alone under the physical profile', () => {

		expect( RENDER_PROFILES.physical.areaLightIntensityScale ).toBe( 1.0 );
		expect( RENDER_PROFILES.physical.environmentRotation ).toBe( 0 );

	} );

	// The grade is the half the first cut missed: saturation 1.2 and ACES are viewer choices.
	it( 'drops the viewer grade under the physical profile', () => {

		expect( RENDER_PROFILES.viewer.saturation ).toBe( 1.2 );
		expect( RENDER_PROFILES.physical.saturation ).toBe( 1.0 );
		expect( RENDER_PROFILES.physical.toneMapping ).not.toBe( RENDER_PROFILES.viewer.toneMapping );

	} );

	it( 'keeps every ENGINE_DEFAULTS grade equal to the viewer profile', () => {

		for ( const key of [ 'environmentRotation', 'saturation', 'toneMapping' ] ) {

			expect( ENGINE_DEFAULTS[ key ] ).toBe( RENDER_PROFILES.viewer[ key ] );

		}

	} );

	it( 'refuses an unknown profile rather than falling back', () => {

		expect( () => getRenderProfile( 'phyiscal' ) ).toThrow( /unknown render profile/ );

	} );

	it( 'freezes the profiles', () => {

		expect( Object.isFrozen( RENDER_PROFILES ) ).toBe( true );
		expect( Object.isFrozen( RENDER_PROFILES.viewer ) ).toBe( true );

	} );

} );

describe( 'toneMapToRGBA8', () => {

	const px = ( r, g, b, a = 1 ) => Float32Array.from( [ r, g, b, a ] );

	it( 'forces opaque unless asked to keep alpha', () => {

		const opaque = toneMapToRGBA8( px( 0, 0, 0, 0.25 ), { exposure: 1, toneMapping: NoToneMapping } );
		expect( opaque[ 3 ] ).toBe( 255 );

		const kept = toneMapToRGBA8( px( 0, 0, 0, 0.25 ), { exposure: 1, toneMapping: NoToneMapping, preserveAlpha: true } );
		expect( kept[ 3 ] ).toBe( 64 );

	} );

	// three.js returns the colour untouched for NoToneMapping; applying exposure paints bright.
	it( 'ignores exposure under NoToneMapping, matching the output pass', () => {

		const dim = toneMapToRGBA8( px( 0.5, 0.5, 0.5 ), { exposure: 1, toneMapping: NoToneMapping } );
		const bright = toneMapToRGBA8( px( 0.5, 0.5, 0.5 ), { exposure: 4, toneMapping: NoToneMapping } );

		expect( Array.from( bright ) ).toEqual( Array.from( dim ) );

	} );

	it( 'applies exposure when a curve is active', () => {

		const dim = toneMapToRGBA8( px( 0.1, 0.1, 0.1 ), { exposure: 1, toneMapping: LinearToneMapping } );
		const bright = toneMapToRGBA8( px( 0.1, 0.1, 0.1 ), { exposure: 3, toneMapping: LinearToneMapping } );

		expect( bright[ 0 ] ).toBeGreaterThan( dim[ 0 ] );

	} );

	it( 'clamps negative radiance instead of wrapping it', () => {

		const out = toneMapToRGBA8( px( - 5, 0, 0 ), { exposure: 1, toneMapping: ACESFilmicToneMapping } );
		expect( out[ 0 ] ).toBe( 0 );

	} );

	it( 'encodes sRGB, not raw linear', () => {

		// Mid-grey linear 0.5 lands near 188 through the sRGB transfer function, not 128.
		const out = toneMapToRGBA8( px( 0.5, 0.5, 0.5 ), { exposure: 1, toneMapping: NoToneMapping } );
		expect( out[ 0 ] ).toBeGreaterThan( 180 );
		expect( out[ 0 ] ).toBeLessThan( 195 );

	} );

	it( 'keeps one RGBA quad per input pixel', () => {

		const two = Float32Array.from( [ 0, 0, 0, 1, 1, 1, 1, 1 ] );
		expect( toneMapToRGBA8( two, { exposure: 1, toneMapping: NoToneMapping } ).length ).toBe( 8 );

	} );

} );
