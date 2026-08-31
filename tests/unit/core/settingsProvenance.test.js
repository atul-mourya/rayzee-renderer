import { describe, it, expect } from 'vitest';
import { RenderSettings, SETTING_SOURCE } from '@/core/RenderSettings.js';
import { RENDER_PROFILES, getRenderProfile, DEFAULT_RENDER_PROFILE, ENGINE_DEFAULTS } from '@/core/EngineDefaults.js';
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

		expect( settings.sourceOf( 'maxBounces' ) ).toBe( SETTING_SOURCE.HOST );
		expect( settings.getEffective().maxBounces.value ).toBe( 12 );

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

		expect( settings.sourceOf( 'maxBounces' ) ).toBe( 'mode-preset' );

	} );

	// A stored-but-unrouted key reads back like any other. `routed` is how a caller tells
	// "this is in force" from "this was accepted and does nothing".
	it( 'marks a stored value that reaches no stage', () => {

		const settings = new RenderSettings( { maxBounces: 4 } );
		settings.set( 'maxBonces', 12 );

		expect( settings.getEffective().maxBonces ).toEqual( {
			value: 12, source: SETTING_SOURCE.HOST, routed: false,
		} );

	} );

	it( 'reports no source for a key that was never set', () => {

		expect( new RenderSettings( {} ).sourceOf( 'nothing' ) ).toBeNull();

	} );

} );

describe( 'render profiles', () => {

	it( 'keeps the viewer profile as the default', () => {

		expect( DEFAULT_RENDER_PROFILE ).toBe( 'viewer' );
		expect( getRenderProfile() ).toBe( RENDER_PROFILES.viewer );

	} );

	// Both are the constants that silently moved output against Cycles.
	it( 'states the viewer tuning the engine ships', () => {

		expect( RENDER_PROFILES.viewer.areaLightIntensityScale ).toBe( 0.1 );
		expect( RENDER_PROFILES.viewer.environmentRotation ).toBe( 270 );

	} );

	it( 'leaves authored values alone under the physical profile', () => {

		expect( RENDER_PROFILES.physical.areaLightIntensityScale ).toBe( 1.0 );
		expect( RENDER_PROFILES.physical.environmentRotation ).toBe( 0 );

	} );

	// The viewer profile has to keep matching the shipped default, or the app and the profile
	// disagree about what "no profile chosen" means.
	it( 'agrees with ENGINE_DEFAULTS', () => {

		expect( ENGINE_DEFAULTS.environmentRotation ).toBe( RENDER_PROFILES.viewer.environmentRotation );

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

	// Three.js returns the colour untouched for NoToneMapping, so applying exposure here would
	// paint brighter than the viewport this readback replaces.
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
