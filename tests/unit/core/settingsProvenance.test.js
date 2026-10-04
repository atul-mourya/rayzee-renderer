import { describe, it, expect } from 'vitest';
import { RenderSettings, SETTING_SOURCE } from '@/core/RenderSettings.js';
import { ENGINE_DEFAULTS } from '@/core/EngineDefaults.js';
import { toneMapToRGBA8 } from '@/core/Processor/ToneMapCPU.js';
import { NoToneMapping, LinearToneMapping, ACESFilmicToneMapping, AgXToneMapping } from 'three';

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

describe( 'engine defaults', () => {

	it( 'ships one tuning: placeholder area lights at a tenth, the HDRI unrotated, AgX at neutral saturation', () => {

		expect( ENGINE_DEFAULTS.areaLightIntensityScale ).toBe( 0.1 );
		expect( ENGINE_DEFAULTS.environmentRotation ).toBe( 0 );
		expect( ENGINE_DEFAULTS.toneMapping ).toBe( AgXToneMapping );
		expect( ENGINE_DEFAULTS.saturation ).toBe( 1.0 );

	} );

	it( 'sets depth of field by its look', () => {

		expect( ENGINE_DEFAULTS.dofMode ).toBe( 'look' );

	} );

	it( 'keeps areaLightIntensityScale as a setting with provenance, for the loader to read', () => {

		const settings = new RenderSettings();
		settings.set( 'areaLightIntensityScale', 1, { silent: true } );

		expect( settings.get( 'areaLightIntensityScale' ) ).toBe( 1 );
		expect( settings.getEffective().areaLightIntensityScale ).toMatchObject( { value: 1, source: SETTING_SOURCE.HOST, routed: true } );
		expect( () => settings.applyAll() ).not.toThrow();

	} );

} );

describe( 'RenderSettings.define', () => {

	it( 'takes the default a layer brings', () => {

		const settings = new RenderSettings( {} );
		settings.define( 'viewerScale', { default: 0.5, apply: () => {} } );

		expect( settings.get( 'viewerScale' ) ).toBe( 0.5 );
		expect( settings.getEffective().viewerScale ).toMatchObject( { value: 0.5, source: SETTING_SOURCE.DEFAULT, routed: true } );

	} );

	it( 'falls back to the defaults the store was built with', () => {

		const settings = new RenderSettings( { viewerScale: 0.25 } );
		settings.define( 'viewerScale', { apply: () => {} } );

		expect( settings.get( 'viewerScale' ) ).toBe( 0.25 );

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
